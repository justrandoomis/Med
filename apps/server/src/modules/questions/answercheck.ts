// Check of a question's answer against the SELECTED MATERIAL (§34 «AI-derived Answer» / «Conflicting Key»; AC-14,
// AC-15; capability `ai.answer_check`). Added by the G4 acceptance round: before it, nothing compared a printed key
// with the lecture, and a question without a key could never get an evidence-backed solution.
//
//   scope   «Lecture Only» on a lecture linked to the question (explicit «+ references» only on request)
//   solve   an INDEPENDENT model call (task validate_question) solves the item from the locked evidence only — it is
//           never shown the key — and gives 1–4 support sentences, each citing evidence aliases
//   verify  the evidence module's validateClaims (aliases handed out only, scope, critical tokens, independent
//           verify_support): a conclusion needs ≥ 1 linked medical sentence and NO unconfirmed one
//   outcome agrees      → recorded with its evidence on the checked version (nothing else changes)
//           conflicts   → source key: a NEW version `conflicting_key` «مفتاح المصدر يختار B لكن الأدلة المختارة تشير إلى C»;
//                         the printed key entries and the checked version stay as they were, past attempts keep their
//                         result (alert listing them, never re-graded); owner key: reported next to it, unchanged
//           derived     → no usable key: a NEW version `ai_derived` (labelled AI-derived, with its evidence) — the
//                         printed source state stays visible; key-vs-key conflicts are never resolved automatically
//           unresolved / abstained → recorded with the specific reason; nothing changes
// The uploaded question text and the lecture are untrusted data: they only ever travel inside delimited blocks.
import { z } from 'zod';
import {
  SUPPORT_TYPES,
  type AnswerCheckRequest,
  type AnswerCheckResponse,
  type AnswerCheckView,
  type AnswerStatus,
  type ClaimView,
  type EvidenceForModel,
  type ResolvedScope,
  type SourceScope,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError, isAppError } from '../../lib/errors';
import { parseWith } from '../../lib/http';
import { newId } from '../../lib/ids';
import type { UntrustedBlock } from '../ai/types';
import { abstainFor, getClaimViews, packFromCandidates, recordDependencies, resolveScope, retrieve, toResolvedScope, validateClaims, type SentenceResult } from '../evidence/services';
import { keyChangeImpact, refreshQuestion } from './lifecycle';
import { correctOptionKeys, currentVersion, deriveVersion, getQuestionRow, getVersionRow, isVersionLocked, optionRows, questionView, setCurrentVersion, stemText, type VersionRow } from './store';
import { richTextToPlain, type RichText } from '@medlevo/shared';

export const ANSWER_CHECK_VERSION = 'qcheck-v1';

export const answerCheckBody = z
  .object({
    lecture_source_id: z.string().min(1).max(64).optional(),
    include_references: z.boolean().optional(),
  })
  .strict();

const sentenceSchema = z.object({
  text: z.string().trim().min(1).max(1200),
  claim: z.object({ support_type: z.enum(SUPPORT_TYPES), evidence: z.array(z.string().trim().max(16)).max(8) }).nullable(),
});

/** The independent solver's output (it never sees the key). */
export const answerCheckOutputSchema = z.object({
  abstain: z.object({ reason: z.enum(['insufficient_evidence', 'not_found_in_scope']), detail: z.string().max(800) }).nullable().optional(),
  chosen_option: z.string().trim().max(3).nullable(),
  defensible_options: z.array(z.string().trim().max(3)).max(8),
  answerable_from_evidence: z.boolean(),
  support: z.array(sentenceSchema).max(8),
});
export type AnswerCheckOutput = z.infer<typeof answerCheckOutputSchema>;

export const ANSWER_CHECK_SYSTEM = [
  'You check the answer of ONE multiple-choice question for a medical student, using ONLY the evidence excerpts (E1, E2, …) taken from the student\'s own lecture.',
  'You are NOT told any answer key, and you must not use outside knowledge.',
  '- chosen_option: the letter of the single best option according to the evidence, or null when the evidence does not determine one.',
  '- defensible_options: every option letter the evidence could support as correct.',
  '- answerable_from_evidence: whether the evidence is sufficient to answer.',
  '- support: 1–4 short sentences explaining FROM THE EVIDENCE why the chosen option is the answer; every sentence carries a claim {support_type, evidence:[aliases]} citing ONLY the aliases given.',
  '- Mind negation (NOT, EXCEPT, LEAST, «ليس»، «عدا»، «إلا»): in such a question the answer is the option the evidence does NOT support.',
  '- Keep numbers, units and decimal separators exactly as written in the evidence.',
  '- If the evidence is not enough, return {"abstain":{"reason":"insufficient_evidence","detail":"…"},"chosen_option":null,"defensible_options":[],"answerable_from_evidence":false,"support":[]}.',
  'Write the support sentences in the language of the question.',
].join('\n');

const LETTERS = 'ABCDEFGH';
const RELATION_RANK: Record<string, number> = { directly_covered: 0, strongly_related: 1, partially_covered: 2, course_related_only: 3 };

/** Both the solver and the independent support verifier must be available; otherwise nothing pretends to work. */
export function requireAnswerCheck(ctx: AppContext): void {
  if (!ctx.capabilities.isAvailable('ai.answer_check')) {
    const s = ctx.capabilities.get('ai.answer_check');
    throw new AppError('AI_NOT_CONFIGURED', s.reason_ar ?? 'التحقق من الإجابة بالأدلة يتطلب مزود ذكاء اصطناعي مضبوطًا على الخادم.', 409, { feature: 'ai.answer_check' });
  }
  const status = ctx.ai.status();
  for (const task of ['validate_question', 'verify_support'] as const) {
    const t = status.tasks[task];
    if (!t.available) throw new AppError('AI_NOT_CONFIGURED', t.reason_ar ?? 'التحقق من الإجابة بالأدلة يتطلب مزود ذكاء اصطناعي مضبوطًا على الخادم.', 409, { task });
  }
}

interface LinkRow {
  lecture_source_id: string;
  relation: string;
  status: string;
  score: number | null;
  reason_json: string | null;
}

function pickLecture(ctx: AppContext, questionId: string, wanted: string | undefined): LinkRow {
  const links = ctx.db.all<LinkRow>(
    `SELECT l.lecture_source_id, l.relation, l.status, l.score, l.reason_json FROM question_lecture_link l JOIN source s ON s.id = l.lecture_source_id
      WHERE l.question_id = ? AND l.status <> 'rejected' AND s.deleted_at IS NULL`,
    [questionId],
  );
  if (wanted) {
    const l = links.find((x) => x.lecture_source_id === wanted);
    if (!l) throw new AppError('OUT_OF_SCOPE', 'هذه المحاضرة غير مرتبطة بالسؤال؛ اربطها أولًا أو اختر محاضرة مرتبطة.', 409);
    return l;
  }
  const sorted = [...links].sort(
    (a, b) => Number(b.status === 'accepted') - Number(a.status === 'accepted') || (RELATION_RANK[a.relation] ?? 9) - (RELATION_RANK[b.relation] ?? 9) || (b.score ?? 0) - (a.score ?? 0),
  );
  const best = sorted[0];
  if (!best) {
    throw new AppError('OUT_OF_SCOPE', 'لا توجد محاضرة مرتبطة بهذا السؤال؛ لا يُشتق جواب ولا يُفحص مفتاح دون أدلة من مادتك. اربط السؤال بمحاضرة أولًا.', 409);
  }
  return best;
}

function anchorRegions(ctx: AppContext, versionId: string, pageIds: string[]): string[] {
  if (pageIds.length === 0) return [];
  return ctx.db
    .all<{ id: string }>(
      `SELECT r.id FROM source_region r JOIN source_page p ON p.id = r.page_id
        WHERE r.version_id = ? AND r.page_id IN (${pageIds.map(() => '?').join(',')})
          AND r.kind NOT IN ('header','footer','table_cell') AND r.status <> 'rejected' AND COALESCE(r.text_origin, '') <> 'vision'
          AND r.text IS NOT NULL AND trim(r.text) <> ''
        ORDER BY p.page_index, r.reading_order LIMIT 40`,
      [versionId, ...pageIds],
    )
    .map((r) => r.id);
}

function evidenceBlocks(forModel: EvidenceForModel[]): UntrustedBlock[] {
  return forModel.map((e) => ({ label: `evidence ${e.alias} — ${e.source_label}`, text: `[${e.alias}]\n${e.quote}` }));
}

const labelOf = (o: { source_label: string | null }, i: number) => o.source_label ?? LETTERS[i] ?? String(i + 1);

function baseView(over: Partial<AnswerCheckView> & Pick<AnswerCheckView, 'outcome' | 'reason_ar' | 'key_status'>, ctx: AppContext): AnswerCheckView {
  return {
    chosen_option_key: null,
    key_option_keys: null,
    claim_ids: [],
    evidence_ids: [],
    lecture_source_id: null,
    scope_describe_ar: '',
    model: null,
    checked_at: ctx.clock.now(),
    ...over,
  };
}

/** Store the check on the version itself (metadata only: its key and content are not touched). */
function recordOnVersion(ctx: AppContext, v: VersionRow, check: AnswerCheckView): void {
  const kd = { ...(fromJson<Record<string, unknown>>(v.key_details_json, {}) ?? {}), answer_check: check };
  ctx.db.run('UPDATE question_version SET key_details_json = ? WHERE id = ?', [toJson(kd), v.id]);
}

function insertAnswerEvidence(ctx: AppContext, versionId: string, optionId: string | null, evidenceIds: string[], role: 'supports_answer' | 'contradicts_key'): void {
  const now = ctx.clock.now();
  for (const eid of new Set(evidenceIds)) {
    ctx.db.run('INSERT INTO answer_evidence (id, question_version_id, option_id, evidence_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [newId(now), versionId, optionId, eid, role, now]);
  }
  // the answer now rests on these lecture passages: a later correction or replacement of them must reach this
  // version through the dependency service (G8, AC-26 — before, only the question's own source was recorded)
  const ids = [...new Set(evidenceIds)];
  if (ids.length === 0) return;
  const rows = ctx.db.all<{ version_id: string; region_id: string | null }>(`SELECT version_id, region_id FROM evidence WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  recordDependencies(
    ctx,
    'question_version',
    versionId,
    rows.map((r) => r.version_id),
    rows.map((r) => r.region_id).filter((x): x is string => !!x),
  );
}

/** The occurrences point at the version in force (as a key change by refreshQuestion does). */
function moveCurrent(ctx: AppContext, questionId: string, from: string, to: string): void {
  setCurrentVersion(ctx, questionId, to);
  ctx.db.run('UPDATE question_occurrence SET question_version_id = ? WHERE question_id = ? AND question_version_id = ?', [to, questionId, from]);
}

export async function checkAnswer(ctx: AppContext, questionId: string, body: unknown): Promise<AnswerCheckResponse> {
  const req: AnswerCheckRequest = parseWith(answerCheckBody, body ?? {}, 'body');
  const q = getQuestionRow(ctx, questionId);
  const cur = currentVersion(ctx, q);
  const options = optionRows(ctx, cur.id);
  if (options.length < 2) throw new AppError('VALIDATION_FAILED', 'التحقق من الإجابة متاح لأسئلة الاختيار من متعدد فقط.', 400);
  if (q.status === 'retired') throw new AppError('CONFLICT', 'هذا السؤال مستبعد؛ أعده أولًا.', 409);
  requireAnswerCheck(ctx);
  const link = pickLecture(ctx, q.id, req.lecture_source_id);

  // Source Lock: the linked lecture only (its own references only when the owner asked for them)
  const scopeReq: SourceScope = {
    mode: req.include_references ? 'lecture_plus_references' : 'lecture_only',
    lecture_source_id: link.lecture_source_id,
    reference_source_ids: [],
    version_pins: {},
    include_my_notes: false,
  };
  const report = resolveScope(ctx, scopeReq);
  const scope: ResolvedScope = toResolvedScope(report);
  const lectureVersion = report.versionBySource[link.lecture_source_id];
  if (!lectureVersion) throw new AppError('OUT_OF_SCOPE', 'لا توجد نسخة قابلة للاستخدام من هذه المحاضرة داخل النطاق.', 409);

  const keyKeys = correctOptionKeys(ctx, cur);
  const keyStatus: AnswerStatus = cur.answer_status;
  const common = { key_status: keyStatus, key_option_keys: keyKeys, lecture_source_id: link.lecture_source_id, scope_describe_ar: scope.describeAr };
  const stem = stemText(cur);
  const optTexts = options.map((o) => richTextToPlain(fromJson<RichText | null>(o.text_json, null)));
  const letterToKey = new Map(options.map((o, i) => [LETTERS[i]!, o.option_key]));
  const keyToLabel = new Map(options.map((o, i) => [o.option_key, labelOf(o, i)]));
  const labelsOf = (keys: string[] | null) => (keys ?? []).map((k) => keyToLabel.get(k) ?? k).join('، ');

  // evidence: the linked lecture pages first, then keyword retrieval over stem + options
  const linkPages = (fromJson<{ lecture_page_ids?: string[] }>(link.reason_json, {}) ?? {}).lecture_page_ids ?? [];
  const r = retrieve(ctx, {
    scope,
    query: [stem, ...optTexts].join(' ').slice(0, 1500),
    anchor: linkPages.length ? { region_ids: anchorRegions(ctx, lectureVersion, linkPages) } : null,
    k: 12,
    purpose: 'source_question_practice',
    neighbours: 1,
  });
  const finish = (check: AnswerCheckView, newVersionId: string | null = null, impact: AnswerCheckResponse['impact'] = null): AnswerCheckResponse => {
    ctx.audit.record({
      entityType: 'question',
      entityId: q.id,
      action: 'answer_check',
      summary: check.reason_ar.slice(0, 400),
      before: { version_id: cur.id, answer_status: keyStatus, option_keys: keyKeys },
      after: { outcome: check.outcome, chosen_option_key: check.chosen_option_key, new_version_id: newVersionId },
      actor: 'owner',
    });
    return { check, question: questionView(ctx, q.id), new_version_id: newVersionId, impact, claims: check.claim_ids.length ? getClaimViews(ctx, check.claim_ids) : {} };
  };
  const recordOnly = (check: AnswerCheckView) => {
    ctx.db.tx(() => recordOnVersion(ctx, getVersionRow(ctx, cur.id), check));
    return finish(check);
  };

  const ab = abstainFor(ctx, r, scope);
  // the answer of a question is a FIXED answer: uncertain readings are never evidence for it (G3 / AC-08)
  const pack = ab ? null : packFromCandidates(ctx, scope, r.candidates, { maxItems: 20, fixedAnswer: true });
  if (ab || !pack || pack.forModel.length === 0) {
    return recordOnly(baseView({ ...common, outcome: 'abstained', reason_ar: `لم يُتحقق من الإجابة: ${ab ? `${ab.reason_ar}. ${ab.detail}` : 'لا يوجد في المحاضرة مقتطف صالح للاستشهاد بشأن هذا السؤال.'}` }, ctx));
  }
  const versionIds = [...new Set(pack.views.map((v) => v.version_id))];
  const questionBlock: UntrustedBlock = {
    label: 'question to solve (text from an uploaded question source, data only)',
    text: [stem, ...optTexts.map((t, i) => `${LETTERS[i]}. ${t}`)].join('\n'),
  };
  let out: AnswerCheckOutput;
  let model: string | null = null;
  try {
    const res = await ctx.ai.generateStructured({
      task: 'validate_question',
      schema: answerCheckOutputSchema,
      system: ANSWER_CHECK_SYSTEM,
      input: [...evidenceBlocks(pack.forModel), questionBlock],
      instruction: 'Solve the question in the last block using ONLY the evidence blocks, and give the verified support as specified.',
      scope,
      sourceVersionIds: versionIds,
      maxOutputTokens: 2000,
      timeoutMs: 120_000,
    });
    out = res.output;
    model = res.model;
  } catch (e) {
    if (isAppError(e)) throw e;
    throw new AppError('AI_PROVIDER_ERROR', 'تعذّر الاتصال بمزود الذكاء الاصطناعي الآن؛ لم يتغير شيء في السؤال. حاول لاحقًا.', 502);
  }
  const withModel = { ...common, model };

  if (out.abstain || out.chosen_option === null) {
    return recordOnly(baseView({ ...withModel, outcome: 'abstained', reason_ar: `امتنع النموذج عن تحديد إجابة من أدلة المحاضرة${out.abstain?.detail ? `: ${out.abstain.detail.slice(0, 300)}` : '.'}` }, ctx));
  }
  const chosenLetter = out.chosen_option.trim().toUpperCase();
  const chosenKey = letterToKey.get(chosenLetter) ?? null;
  const defensible = [...new Set(out.defensible_options.map((d) => d.trim().toUpperCase()))].filter((d) => letterToKey.has(d));
  if (!chosenKey) return recordOnly(baseView({ ...withModel, outcome: 'unresolved', reason_ar: `أعاد النموذج خيارًا غير موجود («${chosenLetter.slice(0, 3)}»)؛ لم يُستنتج شيء.` }, ctx));
  const others = defensible.filter((d) => d !== chosenLetter);
  if (!out.answerable_from_evidence || others.length > 0) {
    const why = !out.answerable_from_evidence
      ? 'الأدلة المختارة لا تكفي لحسم الإجابة'
      : `أكثر من خيار يمكن الدفاع عنه من الأدلة (${[chosenLetter, ...others].map((l) => keyToLabel.get(letterToKey.get(l)!) ?? l).join('، ')})`;
    return recordOnly(baseView({ ...withModel, outcome: 'unresolved', chosen_option_key: null, reason_ar: `لم تُحسم الإجابة: ${why}.` }, ctx));
  }

  // every support sentence through the evidence module (independent verify_support): the conclusion needs at least
  // one LINKED medical sentence and none that failed or stayed unconfirmed
  const checkId = newId(ctx.clock.now());
  const v = await validateClaims(ctx, { ownerType: 'answer_check', ownerId: checkId, sentences: out.support, aliasMap: pack.aliasMap, scope });
  const linked: SentenceResult[] = v.sentences.filter((s) => s.medical && s.keep && s.status === 'linked');
  const unconfirmed = v.sentences.filter((s) => s.medical && !(s.keep && s.status === 'linked'));
  const claimIds = linked.map((s) => s.claim_id).filter((x): x is string => !!x);
  const evidenceIds = [...new Set(linked.flatMap((s) => s.evidence_ids))];
  const chosenLabel = keyToLabel.get(chosenKey) ?? chosenKey;
  if (!v.entailment.used || linked.length === 0 || unconfirmed.length > 0) {
    const why = !v.entailment.used
      ? 'التحقق المستقل من دعم الأدلة غير متاح الآن'
      : linked.length === 0
        ? 'لم تثبت الأدلة أي جملة من تعليل النموذج'
        : `جملة من التعليل لم تجتز التحقق من الأدلة (${(unconfirmed[0]!.reason_ar ?? 'غير مدعومة').slice(0, 160)})`;
    return recordOnly(
      baseView({ ...withModel, outcome: 'unresolved', chosen_option_key: null, claim_ids: claimIds, evidence_ids: evidenceIds, reason_ar: `اقترح النموذج الخيار ${chosenLabel} لكن ${why}؛ لا يُعتمد جواب غير مؤكد.` }, ctx),
    );
  }

  const keyKnown = (keyStatus === 'source_key' || keyStatus === 'owner_key' || keyStatus === 'ai_derived') && !!keyKeys && keyKeys.length > 0;
  const agrees = keyKnown && keyKeys!.length === 1 && keyKeys![0] === chosenKey;
  const verified = { ...withModel, chosen_option_key: chosenKey, claim_ids: claimIds, evidence_ids: evidenceIds };

  if (keyKnown && agrees) {
    const check = baseView({ ...verified, outcome: 'agrees', reason_ar: `الأدلة المختارة تؤيد ${keyStatus === 'source_key' ? 'مفتاح المصدر' : keyStatus === 'owner_key' ? 'المفتاح الذي حددته' : 'الحل المولد'} (${chosenLabel}).` }, ctx);
    ctx.db.tx(() => {
      const fresh = getVersionRow(ctx, cur.id);
      recordOnVersion(ctx, fresh, check);
      insertAnswerEvidence(ctx, cur.id, options.find((o) => o.option_key === chosenKey)?.id ?? null, evidenceIds, 'supports_answer');
    });
    return finish(check);
  }

  if (keyKnown && keyStatus === 'source_key') {
    // AC-15: show the conflict, keep the original, re-grade nothing
    const conflictAr = `مفتاح المصدر يختار ${labelsOf(keyKeys)} لكن الأدلة المختارة تشير إلى ${chosenLabel}. لم يُصحَّح المفتاح ولا نتائج محاولاتك السابقة تلقائيًا؛ راجع الأدلة ثم حدد المفتاح بنفسك إن أردت.`;
    const check = baseView({ ...verified, outcome: 'conflicts', reason_ar: conflictAr }, ctx);
    const res = ctx.db.tx(() => {
      const fresh = getVersionRow(ctx, cur.id);
      const kd = fromJson<{ key_entry_ids?: string[] }>(fresh.key_details_json, {}) ?? {};
      const d = deriveVersion(ctx, fresh, {
        kind: 'structured',
        createdBy: 'generation',
        answerStatus: 'conflicting_key',
        correctOptionKeys: null,
        keyDetails: { ...(kd.key_entry_ids ? { key_entry_ids: kd.key_entry_ids } : {}), conflict_ar: conflictAr, answer_check: check },
        model,
        note: 'تعارض بين مفتاح المصدر والأدلة المختارة؛ النسخة السابقة (بمفتاح المصدر) محفوظة كما هي.',
      });
      const impact = isVersionLocked(ctx, fresh.id) ? keyChangeImpact(ctx, q.id, fresh.id, null, 'conflicting_key', 'evidence') : null;
      moveCurrent(ctx, q.id, fresh.id, d.versionId);
      insertAnswerEvidence(ctx, d.versionId, d.optionIds.get(chosenKey) ?? null, evidenceIds, 'contradicts_key');
      refreshQuestion(ctx, q.id);
      return { versionId: d.versionId, impact };
    });
    return finish(check, res.versionId, res.impact);
  }

  if (keyKnown) {
    // the owner's own key (or an earlier derived answer) is the owner's decision: reported next to it, never changed
    const check = baseView(
      { ...verified, outcome: 'conflicts', reason_ar: `${keyStatus === 'owner_key' ? 'المفتاح الذي حددته' : 'الحل المولد'} (${labelsOf(keyKeys)}) يخالف ما تشير إليه الأدلة المختارة (${chosenLabel}). لم يُغيَّر شيء تلقائيًا.` },
      ctx,
    );
    ctx.db.tx(() => {
      recordOnVersion(ctx, getVersionRow(ctx, cur.id), check);
      insertAnswerEvidence(ctx, cur.id, options.find((o) => o.option_key === chosenKey)?.id ?? null, evidenceIds, 'contradicts_key');
    });
    return finish(check);
  }

  if (keyStatus === 'conflicting_key') {
    // printed keys disagree: the evidence is shown as help, the conflict is never resolved automatically
    const check = baseView(
      { ...verified, outcome: 'derived', reason_ar: `مفاتيح المصدر متعارضة، والأدلة المختارة تشير إلى ${chosenLabel} (حل مولد من الأدلة — AI-derived). لم يُحسم التعارض تلقائيًا؛ حدد المفتاح بنفسك.` },
      ctx,
    );
    ctx.db.tx(() => {
      recordOnVersion(ctx, getVersionRow(ctx, cur.id), check);
      insertAnswerEvidence(ctx, cur.id, options.find((o) => o.option_key === chosenKey)?.id ?? null, evidenceIds, 'supports_answer');
    });
    return finish(check);
  }

  // AC-14: no usable key → an AI-derived answer WITH its evidence, as a new version (the source state stays visible)
  const sourceState = keyStatus === 'missing_key' ? 'لا يوجد مفتاح في المصدر' : 'لم يُحدَّد مفتاح صالح من المصدر';
  const check = baseView(
    { ...verified, outcome: 'derived', reason_ar: `${sourceState}؛ الحل المولد من الأدلة (AI-derived Answer): ${chosenLabel}. ليس مفتاحًا من المصدر، وأدلته مذكورة معه.` },
    ctx,
  );
  const res = ctx.db.tx(() => {
    const fresh = getVersionRow(ctx, cur.id);
    const d = deriveVersion(ctx, fresh, {
      kind: 'structured',
      createdBy: 'generation',
      answerStatus: 'ai_derived',
      correctOptionKeys: [chosenKey],
      keyDetails: { notes_ar: `حل مولد من الأدلة (AI-derived Answer) — ${sourceState}.`, answer_check: check },
      model,
      note: 'حل مولد من أدلة المحاضرة (AI-derived) لسؤال بلا مفتاح؛ النسخة السابقة محفوظة كما هي.',
    });
    moveCurrent(ctx, q.id, fresh.id, d.versionId);
    insertAnswerEvidence(ctx, d.versionId, d.optionIds.get(chosenKey) ?? null, evidenceIds, 'supports_answer');
    refreshQuestion(ctx, q.id);
    return { versionId: d.versionId };
  });
  return finish(check, res.versionId, null);
}

/** Claims of the current version's answer check (for the detail screen). */
export function answerCheckClaims(ctx: AppContext, v: Pick<VersionRow, 'key_details_json'>): Record<string, ClaimView> {
  const check = (fromJson<{ answer_check?: AnswerCheckView }>(v.key_details_json, {}) ?? {}).answer_check;
  return check?.claim_ids.length ? getClaimViews(ctx, check.claim_ids) : {};
}
