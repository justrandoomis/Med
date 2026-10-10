// Derived question versions — translations and paraphrases (track F3; §35, §37). Capability `ai.generate_questions`
// (the same generator + independent validator tasks as generated MCQs).
//
//   POST /api/questions/:id/derived            {kind, lang?} → a derivation request + job 'questions.derive_version'
//   GET  /api/questions/:id/derived            the question's derivations (with their published derived versions)
//   GET  /api/questions/derivations/:id        one derivation (status polling)
//
// The rules (enforced here, whatever the model returns):
//  * the original is never replaced: a derived version is a question_version row (kind translation | paraphrase,
//    created_by 'translation', derived_from_version_id = the original) that is NEVER made the current version, so
//    exams, attempts, keys, duplicates and the vault keep using the original;
//  * option identity and the key are unchanged: the model only receives the stem and the options under their stable
//    option keys (o1…), never the key; the derived options keep the same keys, labels, order and pinned positions, the
//    key is copied by option key, and the view exposes the ORIGINAL option ids;
//  * validated before it is shown: deterministic checks (every option kept under its own key, numbers and units kept
//    in the same option, negation kept, target language, a paraphrase that really differs) and an INDEPENDENT
//    equivalence check (task validate_question, without the key) — a failure goes to the review queue, never published;
//  * labelled «نسخة مشتقة مولدة … ليست نص السؤال الأصلي ولا تُنسب إلى امتحان سابق»; the original is always viewable.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DERIVATION_STATUS_LABELS_AR,
  DERIVED_LANG_LABELS_AR,
  DERIVED_VERSION_KINDS,
  DERIVED_VERSION_LABELS_AR,
  DERIVED_VERSION_LANGS,
  DERIVED_VERSION_NOTICE_AR,
  richTextToPlain,
  type DerivationIssue,
  type DerivationStatus,
  type DerivedVersionKind,
  type DerivedVersionView,
  type QuestionDerivationResponse,
  type QuestionDerivationView,
  type QuestionDerivationsResponse,
  type QuestionValidation,
  type ResolvedScope,
  type RichText,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError, isAppError, JobError } from '../../lib/errors';
import { parseBody, parseParams, parseWith, RATE_LIMITS } from '../../lib/http';
import { newId } from '../../lib/ids';
import type { JobRun } from '../jobs/queue';
import { correctOptionKeys, getQuestionRow, getVersionRow, insertVersion, optionRows, type OptionRow, type VersionRow } from './store';
import { negationTerms } from './text';

export const DERIVE_JOB = 'questions.derive_version';
export const DERIVER_VERSION = 'derive-2026.10-1';

const id = z.string().trim().min(1).max(64);
const deriveSchema = z.object({ kind: z.enum(DERIVED_VERSION_KINDS), lang: z.enum(DERIVED_VERSION_LANGS).optional() }).strict();

// ───────── model contracts ─────────
const derivedOutputSchema = z
  .object({
    abstain: z.object({ reason: z.string().max(200), detail: z.string().max(1000) }).nullable(),
    stem: z.string().max(8000),
    options: z.array(z.object({ option_key: z.string().max(10), text: z.string().max(2000) })).max(12),
  })
  .strict();
type DerivedOutput = z.infer<typeof derivedOutputSchema>;

const equivalenceSchema = z
  .object({
    equivalent: z.boolean(),
    /** for every option key: does it mean the same thing in both versions? */
    options_equivalent: z.boolean(),
    negation_preserved: z.boolean(),
    numbers_units_preserved: z.boolean(),
    issues: z.array(z.string().max(400)).max(10),
  })
  .strict();
type Equivalence = z.infer<typeof equivalenceSchema>;

const DERIVE_SYSTEM = [
  'You produce a DERIVED version (translation or paraphrase) of a medical exam question for a student.',
  'Rules:',
  '- Keep the question meaning EXACTLY: same clinical facts, same ages, sexes, numbers, units, doses, laterality, time course, qualifiers (first-line, best, most likely, initial) and negation (NOT / EXCEPT / LEAST).',
  '- Keep every option under its own option_key (o1, o2, …); never merge, split, add, remove or reorder options; never change which option is correct (you are not told the key and must not guess it).',
  '- Keep numbers as digits and units, drug names, abbreviations and eponyms in Latin script.',
  '- Arabic: natural Modern Standard Arabic; keep essential English medical terms in Latin script; write the negation word clearly (e.g. «ليس»، «باستثناء»).',
  '- Do not add explanations, hints or facts. If you cannot keep the meaning exactly, abstain.',
].join('\n');

const EQUIVALENCE_SYSTEM = [
  'You are an independent reviewer. You compare an ORIGINAL medical exam question with a DERIVED version (a translation or a paraphrase).',
  'You do not know the answer key. Judge only whether the derived version asks exactly the same question:',
  'same facts, same negation, same numbers and units, and each option (by option_key) meaning the same thing, so that a student would choose the same option key in both.',
  'Report any meaning change in "issues" (short, specific).',
].join('\n');

// ───────── rows ─────────
interface DerivationRow {
  id: string;
  question_id: string;
  source_version_id: string;
  kind: DerivedVersionKind;
  lang: string;
  status: DerivationStatus;
  derived_version_id: string | null;
  candidate_json: string | null;
  issues_json: string;
  model: string | null;
  job_id: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
}

function getDerivation(ctx: AppContext, derivationId: string): DerivationRow {
  const r = ctx.db.get<DerivationRow>('SELECT * FROM question_derivation WHERE id = ?', [derivationId]);
  if (!r) throw new AppError('NOT_FOUND', 'طلب النسخة المشتقة غير موجود.', 404);
  return r;
}

type DerivationPatch = { [K in 'status' | 'derived_version_id' | 'candidate_json' | 'issues_json' | 'model' | 'job_id' | 'error_json']?: DerivationRow[K] | null };

function setDerivation(ctx: AppContext, derivationId: string, patch: DerivationPatch): void {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return;
  ctx.db.run(`UPDATE question_derivation SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map((k) => patch[k] ?? null), ctx.clock.now(), derivationId]);
}

// ───────── availability ─────────
/** The generator AND the independent validator must be available; otherwise nothing pretends to work. */
export function derivationAvailability(ctx: AppContext): { available: boolean; reason_ar: string | null } {
  const gate = ctx.capabilities.get('ai.generate_questions');
  if (gate.state !== 'available') return { available: false, reason_ar: gate.reason_ar ?? 'توليد النسخ المشتقة يتطلب مزود ذكاء اصطناعي مضبوطًا على الخادم.' };
  const status = ctx.ai.status();
  for (const task of ['generate_questions', 'validate_question'] as const) {
    const t = status.tasks[task];
    if (!t.available) return { available: false, reason_ar: t.reason_ar ?? 'توليد النسخ المشتقة يتطلب مزود ذكاء اصطناعي مضبوطًا على الخادم.' };
  }
  return { available: true, reason_ar: null };
}

function requireDerivation(ctx: AppContext): void {
  const a = derivationAvailability(ctx);
  if (!a.available) throw new AppError('AI_NOT_CONFIGURED', a.reason_ar ?? 'غير متاح.', 409);
}

// ───────── text helpers (deterministic checks) ─────────
const AR_DIGITS = /[٠-٩]/g;
const latinDigits = (s: string) => s.replace(AR_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[٫]/g, '.').replace(/[٬]/g, ',');

/** Numbers as they must survive (decimal separators normalized): «38.5», «120», «7». */
export function numbersOf(text: string): string[] {
  return (latinDigits(text).match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '.'));
}

const UNIT_RE = /(?:\d\s*)(%|mmHg|mg\/dL|mg\/kg|mmol\/L|g\/dL|mg|mcg|µg|μg|kg|ml|mL|L|IU|U\/L|cm|mm|°C|°F|bpm|×10\^?\d+\/L|\/min|h|hr|hours?|days?|weeks?|years?)(?![A-Za-z])/g;
export function unitsOf(text: string): string[] {
  return [...latinDigits(text).matchAll(UNIT_RE)].map((m) => m[1]!.toLowerCase().replace(/hours?|hr/, 'h'));
}

function multisetMissing(original: string[], derived: string[]): string[] {
  const pool = new Map<string, number>();
  for (const d of derived) pool.set(d, (pool.get(d) ?? 0) + 1);
  const missing: string[] = [];
  for (const o of original) {
    const n = pool.get(o) ?? 0;
    if (n > 0) pool.set(o, n - 1);
    else missing.push(o);
  }
  return missing;
}

const ARABIC = /[؀-ۿ]/;
const LATIN_WORD = /[A-Za-z]{3,}/g;
const normalize = (s: string) => latinDigits(s).toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();

export interface OriginalText {
  stem: string;
  hasNegation: boolean;
  options: Array<{ option_key: string; text: string }>;
}

/** Deterministic checks of a derived text against its original (exported for unit tests). */
export function derivedIssues(kind: DerivedVersionKind, lang: string, original: OriginalText, out: DerivedOutput): DerivationIssue[] {
  const issues: DerivationIssue[] = [];
  const fail = (check: string, reason_ar: string) => issues.push({ check, reason_ar, by: 'deterministic' });
  if (!out.stem.trim()) fail('stem_complete', 'نص السؤال المشتق فارغ.');
  const keys = original.options.map((o) => o.option_key);
  const got = out.options.map((o) => o.option_key.trim());
  const dup = got.filter((k, i) => got.indexOf(k) !== i);
  const missing = keys.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !keys.includes(k));
  if (missing.length || extra.length || dup.length || got.length !== keys.length) {
    fail(
      'options_complete',
      `الخيارات المشتقة لا تطابق خيارات الأصل (${[missing.length ? `ناقص: ${missing.join('، ')}` : '', extra.length ? `زائد: ${extra.join('، ')}` : '', dup.length ? `مكرر: ${dup.join('، ')}` : ''].filter(Boolean).join('؛ ') || 'العدد مختلف'}). لا يُغيَّر أي خيار ولا مفتاح.`,
    );
  }
  for (const o of out.options) if (!o.text.trim()) fail('options_complete', `نص الخيار ${o.option_key} فارغ في النسخة المشتقة.`);
  // numbers and units must survive — in the stem and inside the SAME option (never moved to another option)
  const stemMissing = multisetMissing(numbersOf(original.stem), numbersOf(out.stem));
  if (stemMissing.length) fail('numbers_units_preserved', `أرقام من نص السؤال الأصلي لم تبقَ في النسخة المشتقة: ${stemMissing.join('، ')}.`);
  const stemUnits = multisetMissing(unitsOf(original.stem), unitsOf(out.stem));
  if (stemUnits.length) fail('numbers_units_preserved', `وحدات من نص السؤال الأصلي لم تبقَ: ${stemUnits.join('، ')}.`);
  for (const o of original.options) {
    const d = out.options.find((x) => x.option_key.trim() === o.option_key);
    if (!d) continue;
    const m = multisetMissing(numbersOf(o.text), numbersOf(d.text));
    if (m.length) fail('numbers_units_preserved', `الخيار ${o.option_key}: الأرقام ${m.join('، ')} لم تبقَ في الخيار نفسه.`);
    const u = multisetMissing(unitsOf(o.text), unitsOf(d.text));
    if (u.length) fail('numbers_units_preserved', `الخيار ${o.option_key}: الوحدات ${u.join('، ')} لم تبقَ في الخيار نفسه.`);
  }
  if (original.hasNegation && negationTerms(out.stem).length === 0) {
    fail('negation_preserved', 'السؤال الأصلي بصيغة نفي (NOT / EXCEPT) والنسخة المشتقة لا تحمل كلمة نفي واضحة؛ هذا يقلب المعنى.');
  }
  if (!original.hasNegation && negationTerms(out.stem).length > 0 && negationTerms(original.stem).length === 0) {
    fail('negation_preserved', 'أضافت النسخة المشتقة صيغة نفي غير موجودة في الأصل.');
  }
  if (kind === 'translation') {
    if (lang === 'ar' && !ARABIC.test(out.stem)) fail('language', 'الترجمة المطلوبة إلى العربية لكن النص المشتق ليس عربيًا.');
    if (lang === 'en' && (ARABIC.test(out.stem) || (out.stem.match(LATIN_WORD) ?? []).length < 3)) fail('language', 'الترجمة المطلوبة إلى الإنجليزية لكن النص المشتق ليس إنجليزيًا.');
  }
  if (kind === 'paraphrase' && normalize(out.stem) === normalize(original.stem)) {
    fail('paraphrase_differs', 'إعادة الصياغة مطابقة للنص الأصلي؛ لا فائدة من نسخة مشتقة مطابقة.');
  }
  return issues;
}

export function equivalenceIssues(e: Equivalence): DerivationIssue[] {
  const out: DerivationIssue[] = [];
  const fail = (check: string, reason_ar: string) => out.push({ check, reason_ar, by: 'validator' });
  if (!e.negation_preserved) fail('negation_preserved', 'المدقق المستقل: صيغة النفي لم تُحفظ في النسخة المشتقة.');
  if (!e.numbers_units_preserved) fail('numbers_units_preserved', 'المدقق المستقل: رقم أو وحدة تغيّرت في النسخة المشتقة.');
  if (!e.options_equivalent) fail('options_equivalent', 'المدقق المستقل: معنى خيار واحد على الأقل تغيّر في النسخة المشتقة.');
  for (const i of e.issues.slice(0, 4)) fail('equivalent', `المدقق المستقل: ${i.slice(0, 300)}`);
  if (!e.equivalent && out.length === 0) fail('equivalent', 'المدقق المستقل: النسخة المشتقة لا تسأل السؤال نفسه.');
  return out;
}

// ───────── views ─────────
function letterOf(i: number, arabic: boolean): string {
  return arabic ? (['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح'][i] ?? String(i + 1)) : (String.fromCharCode(65 + i) ?? String(i + 1));
}

function optionText(o: OptionRow): string {
  return richTextToPlain(fromJson<RichText | null>(o.text_json, null));
}

export function derivedVersionView(ctx: AppContext, v: VersionRow, currentVersionId: string | null): DerivedVersionView {
  const source = getVersionRow(ctx, v.derived_from_version_id!);
  const srcOpts = optionRows(ctx, source.id);
  const byKey = new Map(srcOpts.map((o) => [o.option_key, o]));
  const arabicLabels = srcOpts.some((o) => o.source_label && ARABIC.test(o.source_label));
  const options = optionRows(ctx, v.id).map((o, i) => {
    const orig = byKey.get(o.option_key);
    return {
      id: orig?.id ?? o.id,
      option_key: o.option_key,
      display_label: orig?.source_label ?? o.source_label ?? letterOf(i, arabicLabels),
      text: fromJson<RichText>(o.text_json)!,
    };
  });
  const fromCurrent = currentVersionId === source.id;
  const kind = v.kind as DerivedVersionKind;
  return {
    version_id: v.id,
    kind,
    lang: v.lang ?? 'en',
    label_ar: `${DERIVED_VERSION_LABELS_AR[kind]}${v.lang && (DERIVED_LANG_LABELS_AR as Record<string, string>)[v.lang] ? ` (${(DERIVED_LANG_LABELS_AR as Record<string, string>)[v.lang]})` : ''}`,
    notice_ar: DERIVED_VERSION_NOTICE_AR,
    derived_from_version_id: source.id,
    derived_from_version_no: source.version_no,
    from_current: fromCurrent,
    stale_note_ar: fromCurrent
      ? null
      : `اشتُقت هذه النسخة من النسخة ${source.version_no} من السؤال، وللسؤال الآن نسخة أحدث؛ قد لا تطابقها. اطلب نسخة مشتقة جديدة.`,
    stem: fromJson<RichText>(v.stem_json)!,
    has_negation: source.has_negation === 1,
    options,
    // the key is ALWAYS the original's, read from it: an unattempted original can have its key changed in place (a
    // source key found later — lifecycle refresh), and a derived version must never show a different answer (F3 review)
    correct_option_keys: correctOptionKeys(ctx, source),
    answer_status: source.answer_status,
    model: v.model,
    created_at: v.created_at,
  };
}

export function derivationView(ctx: AppContext, r: DerivationRow, currentVersionId?: string | null): QuestionDerivationView {
  const cur = currentVersionId ?? ctx.db.get<{ c: string | null }>('SELECT current_version_id AS c FROM question WHERE id = ?', [r.question_id])?.c ?? null;
  const derivedRow = r.derived_version_id ? ctx.db.get<VersionRow>('SELECT * FROM question_version WHERE id = ?', [r.derived_version_id]) : undefined;
  const error = fromJson<{ message_ar?: string } | null>(r.error_json, null);
  return {
    id: r.id,
    question_id: r.question_id,
    source_version_id: r.source_version_id,
    kind: r.kind,
    lang: r.lang,
    status: r.status,
    status_label_ar: DERIVATION_STATUS_LABELS_AR[r.status],
    issues: fromJson<DerivationIssue[]>(r.issues_json, []) ?? [],
    derived: derivedRow && derivedRow.derived_from_version_id ? derivedVersionView(ctx, derivedRow, cur) : null,
    job: r.job_id ? ctx.jobs.get(r.job_id) : null,
    error_ar: error?.message_ar ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function listDerivations(ctx: AppContext, questionId: string): QuestionDerivationsResponse {
  const q = getQuestionRow(ctx, questionId);
  const rows = ctx.db.all<DerivationRow>('SELECT * FROM question_derivation WHERE question_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [q.id]);
  return {
    question_id: q.id,
    current_version_id: q.current_version_id ?? '',
    derivations: rows.map((r) => derivationView(ctx, r, q.current_version_id)),
    can_derive: derivationAvailability(ctx),
  };
}

// ───────── request ─────────
export function requestDerivation(ctx: AppContext, questionId: string, body: unknown): QuestionDerivationView {
  const req = parseWith(deriveSchema, body, 'body');
  const q = getQuestionRow(ctx, questionId);
  requireDerivation(ctx);
  if (!q.current_version_id) throw new AppError('CONFLICT', 'لا توجد نسخة حالية لهذا السؤال.', 409);
  const v = getVersionRow(ctx, q.current_version_id);
  const stem = richTextToPlain(fromJson<RichText | null>(v.stem_json, null));
  if (!stem.trim()) throw new AppError('CONFLICT', 'نص السؤال فارغ؛ صحّحه أولًا ثم اطلب نسخة مشتقة.', 409);
  const srcLang = v.lang === 'ar' ? 'ar' : 'en';
  const lang = req.lang ?? (req.kind === 'translation' ? (srcLang === 'ar' ? 'en' : 'ar') : srcLang);
  if (req.kind === 'translation' && lang === srcLang && v.lang !== 'mixed') {
    throw new AppError('VALIDATION_FAILED', `السؤال مكتوب أصلًا بـ${DERIVED_LANG_LABELS_AR[lang]}؛ اختر لغة أخرى أو «إعادة صياغة».`, 400, {
      where: 'body',
      issues: [{ path: 'lang', code: 'custom', message: 'لغة الترجمة هي لغة الأصل نفسها.' }],
    });
  }
  // one derivation per (original version, kind, language): a published / running one is returned, not regenerated
  const existing = ctx.db.get<DerivationRow>(
    `SELECT * FROM question_derivation WHERE source_version_id = ? AND kind = ? AND lang = ? AND status IN ('queued','running','published') ORDER BY created_at DESC LIMIT 1`,
    [v.id, req.kind, lang],
  );
  if (existing) return derivationView(ctx, existing, q.current_version_id);
  const now = ctx.clock.now();
  const derivationId = newId(now);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO question_derivation (id, question_id, source_version_id, kind, lang, status, derived_version_id, candidate_json, issues_json, model, job_id, error_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, '[]', NULL, NULL, NULL, ?, ?)`,
      [derivationId, q.id, v.id, req.kind, lang, now, now],
    );
    const job = ctx.jobs.enqueue(DERIVE_JOB, { derivation_id: derivationId }, { idempotencyKey: `qderive:${derivationId}` });
    setDerivation(ctx, derivationId, { job_id: job.id });
    ctx.audit.record({
      entityType: 'question',
      entityId: q.id,
      action: 'derive_request',
      summary: `طلب ${DERIVED_VERSION_LABELS_AR[req.kind]} (${DERIVED_LANG_LABELS_AR[lang]}) للنسخة ${v.version_no}`,
      after: { derivation_id: derivationId, kind: req.kind, lang },
      actor: 'owner',
    });
  });
  return derivationView(ctx, getDerivation(ctx, derivationId), q.current_version_id);
}

// ───────── job ─────────
/**
 * A derivation sends NO source evidence — only the question's own text — so its model calls carry an explicit, EMPTY
 * scope: the orchestrator's Source Lock check then refuses any source version (none is sent).
 */
function noEvidenceScope(): ResolvedScope {
  return {
    mode: 'references_only',
    sourceIds: [],
    versionIds: [],
    versionBySource: {},
    allowExternal: false,
    includeMyNotes: false,
    hash: 'question-text-only',
    describeAr: 'نص السؤال نفسه فقط (دون مصادر)',
  };
}

function questionBlock(label: string, stem: string, options: Array<{ option_key: string; text: string }>) {
  return { label, text: [stem, '', ...options.map((o) => `[${o.option_key}] ${o.text}`)].join('\n') };
}

function sendToReview(ctx: AppContext, r: DerivationRow, issues: DerivationIssue[]): void {
  const exists = ctx.db.get<{ id: string }>(`SELECT id FROM review_queue_item WHERE entity_type = 'question_derivation' AND entity_id = ? AND status = 'open'`, [r.id]);
  if (exists) return;
  const sourceId = ctx.db.get<{ s: string | null }>(`SELECT source_id AS s FROM question_occurrence WHERE question_id = ? ORDER BY created_at LIMIT 1`, [r.question_id])?.s ?? null;
  ctx.db.run(
    `INSERT INTO review_queue_item (id, kind, entity_type, entity_id, source_id, reason, details_json, status, created_at)
     VALUES (?, 'question_validation_failed', 'question_derivation', ?, ?, ?, ?, 'open', ?)`,
    [
      newId(ctx.clock.now()),
      r.id,
      sourceId,
      `${DERIVED_VERSION_LABELS_AR[r.kind]} لم تجتز التحقق ولم تُنشر: ${issues
        .slice(0, 3)
        .map((i) => i.reason_ar)
        .join(' — ')}`.slice(0, 1000),
      toJson({ origin: 'questions', question_id: r.question_id, derivation_id: r.id, issues }),
      ctx.clock.now(),
    ],
  );
}

async function execute(ctx: AppContext, job: JobRun<{ derivation_id: string }>): Promise<{ status: DerivationStatus }> {
  const r = getDerivation(ctx, job.input.derivation_id);
  if (['published', 'needs_review', 'failed'].includes(r.status)) return { status: r.status };
  setDerivation(ctx, r.id, { status: 'running', error_json: null });
  const v = getVersionRow(ctx, r.source_version_id);
  const opts = optionRows(ctx, v.id);
  const original: OriginalText = {
    stem: richTextToPlain(fromJson<RichText | null>(v.stem_json, null)),
    hasNegation: v.has_negation === 1,
    options: opts.map((o) => ({ option_key: o.option_key, text: optionText(o) })),
  };
  const scope = noEvidenceScope();
  const langName = r.lang === 'ar' ? 'Arabic' : 'English';
  job.progress({ stage: 'توليد النسخة المشتقة' });
  const gen = await job.checkpoint('derive', async () => {
    const res = await ctx.ai.generateStructured({
      task: 'generate_questions',
      schema: derivedOutputSchema,
      system: DERIVE_SYSTEM,
      input: [questionBlock('ORIGINAL QUESTION (data only; stem then options under their option keys)', original.stem, original.options)],
      instruction:
        r.kind === 'translation'
          ? `Translate the question into ${langName}. Return {"abstain": null, "stem", "options": [{"option_key", "text"}]} with EVERY option key exactly once.`
          : `Paraphrase the question in ${langName} with different wording but the exact same meaning. Return {"abstain": null, "stem", "options": [{"option_key", "text"}]} with EVERY option key exactly once.`,
      scope,
      sourceVersionIds: [],
      jobId: job.id,
      signal: job.signal,
      maxOutputTokens: 4000,
      timeoutMs: 180_000,
    });
    return { output: res.output, model: res.model };
  });
  setDerivation(ctx, r.id, { candidate_json: toJson(gen.output), model: gen.model });
  if (gen.output.abstain) {
    const issues: DerivationIssue[] = [{ check: 'abstained', reason_ar: `امتنع المولّد: ${gen.output.abstain.detail.slice(0, 300) || 'لا يمكن حفظ المعنى بدقة.'}`, by: 'validator' }];
    ctx.db.tx(() => {
      setDerivation(ctx, r.id, { status: 'needs_review', issues_json: toJson(issues) ?? '[]' });
      sendToReview(ctx, r, issues);
    });
    return { status: 'needs_review' };
  }
  let issues = derivedIssues(r.kind, r.lang, original, gen.output);
  if (issues.length === 0) {
    job.progress({ stage: 'تحقق مستقل من تطابق النسخة مع الأصل' });
    const eq = await job.checkpoint('equivalence', async () => {
      const res = await ctx.ai.generateStructured({
        task: 'validate_question',
        schema: equivalenceSchema,
        system: EQUIVALENCE_SYSTEM,
        input: [
          questionBlock('ORIGINAL QUESTION (data only)', original.stem, original.options),
          questionBlock(`DERIVED VERSION — ${r.kind} (data only)`, gen.output.stem, gen.output.options.map((o) => ({ option_key: o.option_key.trim(), text: o.text }))),
        ],
        instruction: 'Compare the two blocks as specified and report {"equivalent","options_equivalent","negation_preserved","numbers_units_preserved","issues"}.',
        scope,
        sourceVersionIds: [],
        jobId: job.id,
        signal: job.signal,
        maxOutputTokens: 1500,
        timeoutMs: 120_000,
      });
      return res.output;
    });
    issues = equivalenceIssues(eq);
  }
  if (issues.length > 0) {
    ctx.db.tx(() => {
      setDerivation(ctx, r.id, { status: 'needs_review', issues_json: toJson(issues) ?? '[]' });
      sendToReview(ctx, r, issues);
    });
    return { status: 'needs_review' };
  }
  // publish: a NEW version that is never made current; same option keys / labels / order / pinned; key by option key
  const derivedByKey = new Map(gen.output.options.map((o) => [o.option_key.trim(), o.text.trim()]));
  const validation: QuestionValidation = {
    publishable: true,
    issues: [
      { check: 'options_complete', passed: true, severity: 'blocker', reason_ar: 'كل خيار بقي تحت مفتاحه الثابت.' },
      { check: 'negation_preserved', passed: true, severity: 'blocker', reason_ar: 'صيغة النفي محفوظة (أو لا نفي في الأصل).' },
      { check: 'numbers_units_preserved', passed: true, severity: 'blocker', reason_ar: 'الأرقام والوحدات بقيت في مواضعها.' },
    ],
  };
  const versionId = ctx.db.tx(() => {
    const ins = insertVersion(ctx, {
      questionId: r.question_id,
      kind: r.kind,
      derivedFrom: v.id,
      qtype: v.qtype,
      stemText: gen.output.stem.trim(),
      stemRaw: null,
      options: opts.map((o) => ({
        option_key: o.option_key,
        source_label: o.source_label,
        text: derivedByKey.get(o.option_key) ?? '',
        raw_text: null,
        region_id: null,
        pinned_position: o.pinned_position === 1,
      })),
      answerStatus: v.answer_status,
      correctOptionKeys: correctOptionKeys(ctx, v),
      keyDetails: null,
      explanation: null,
      validation,
      extractionStatus: 'not_applicable',
      createdBy: 'translation',
      model: gen.model,
      jobId: job.id,
      note: `${DERIVED_VERSION_LABELS_AR[r.kind]} (${(DERIVED_LANG_LABELS_AR as Record<string, string>)[r.lang] ?? r.lang}) للنسخة ${v.version_no} — ليست النص الأصلي`,
      lang: r.lang,
      itemType: v.item_type,
    });
    // generated text never decides a source question's identity: extraction attaches a new occurrence to an existing
    // question by the fingerprint of ANY of its versions, so a derived version carries none (F3 review)
    ctx.db.run('UPDATE question_version SET fingerprint = NULL WHERE id = ?', [ins.versionId]);
    setDerivation(ctx, r.id, { status: 'published', derived_version_id: ins.versionId, issues_json: '[]' });
    ctx.audit.record({
      entityType: 'question',
      entityId: r.question_id,
      action: 'derive_publish',
      summary: `${DERIVED_VERSION_LABELS_AR[r.kind]} اجتازت الفحوص (الأصل والمفتاح دون تغيير)`,
      after: { derivation_id: r.id, version_id: ins.versionId, derived_from: v.id },
      actor: 'job',
      jobId: job.id,
    });
    return ins.versionId;
  });
  return { status: versionId ? 'published' : 'failed' };
}

export function registerDerivationJob(ctx: AppContext): void {
  ctx.jobs.register<{ derivation_id: string }, { status: DerivationStatus }>(DERIVE_JOB, {
    version: DERIVER_VERSION,
    maxAttempts: 2,
    timeoutMs: 10 * 60 * 1000,
    concurrency: 1,
    inputSchema: z.object({ derivation_id: id }).strict(),
    handler: async (job) => {
      try {
        return await execute(ctx, job);
      } catch (e) {
        const retryable = isAppError(e) && e.code === 'AI_PROVIDER_ERROR' && (e.details as { retryable?: boolean } | undefined)?.retryable === true && job.attempt < 2;
        const code = isAppError(e) ? e.code : 'INTERNAL';
        const messageAr = isAppError(e) ? e.messageAr : 'حدث خطأ غير متوقع أثناء توليد النسخة المشتقة.';
        setDerivation(ctx, job.input.derivation_id, retryable ? { error_json: toJson({ code, message_ar: messageAr }) } : { status: 'failed', error_json: toJson({ code, message_ar: messageAr }) });
        if (e instanceof JobError) throw e;
        throw new JobError(code, messageAr, { retryable });
      }
    },
  });
}

// ───────── routes (mounted under /api/questions) ─────────
export function registerDerivedRoutes(app: FastifyInstance, ctx: AppContext): void {
  const idParams = z.object({ id });
  const derivationParams = z.object({ derivationId: id });
  app.get('/:id/derived', async (req): Promise<QuestionDerivationsResponse> => listDerivations(ctx, parseParams(idParams, req).id));
  app.post('/:id/derived', { config: { rateLimit: RATE_LIMITS.ai } }, async (req): Promise<QuestionDerivationResponse> => {
    const p = parseParams(idParams, req);
    const body = parseBody(deriveSchema, req);
    return { derivation: requestDerivation(ctx, p.id, body) };
  });
  app.get('/derivations/:derivationId', async (req): Promise<QuestionDerivationResponse> => ({ derivation: derivationView(ctx, getDerivation(ctx, parseParams(derivationParams, req).derivationId)) }));
}
