// Claim validation (§10, §12, ARCHITECTURE §3.6, AC-05/06/07).
//
// For each generated sentence that carries a claim:
//   evidence_exists  every alias was handed out by the server (aliasMap) AND maps to an existing evidence row;
//                    an unknown alias, a raw id or a fabricated id rejects the claim (AC-06)
//   in_scope         every evidence version ∈ scope.versionIds, source not deleted; externally supplemented
//                    claims need a scope that allows external evidence (AC-05)
//   critical_tokens  negations, numbers, units, doses, thresholds, ages, exceptions, Latin terms (critical.ts)
//   quote_containment original_quote → verbatim; directly_stated → substantially contained (same language)
//   entailment       an INDEPENDENT verifier call (ctx.ai task 'verify_support', batched) judges support
// Status: 'linked' only when every deterministic check passes AND the verifier says «supported».
//   verifier unavailable/failed → 'needs_review' (never 'linked'); partial → 'needs_review';
//   contradicted → 'conflict'; any failed check / not_supported → 'rejected' (Arabic reasons).
//   A generator that labels its own sentence «contradicted» is NOT believed: the contradiction is shown as a
//   conflict only when the independent verifier confirms it (otherwise needs_review, cited as context only).
//   An «original quote» without a claim/evidence is rejected (a quote must be checked verbatim against a source).
// Rows: claim (+ critical flags), citation (ONLY valid in-scope evidence of kept claims), verification_result
// per check. Rejected sentences are reported so generators drop them from published output (§10: never
// softened into «قد يكون»).
import { z } from 'zod';
import {
  ABSTAIN_REASON_LABELS_AR,
  SUPPORT_TYPES,
  type ClaimView,
  type EvidenceRibbonItem,
  type GeneratedSentence,
  type ResolvedScope,
  type SourceType,
  type SupportType,
  type VerificationCheck,
  type VerificationStatus,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError, isAppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { UntrustedBlock } from '../ai/types';
import { checkContainment, checkCriticalTokens, extractCriticalTokens, looksLikeUnsupportedValue } from './critical';
import { getViews } from './evidence';
import type { AliasMap } from './pack';

export const VERIFIER_VERSION = 'claims-v1';
const ENTAILMENT_BATCH = 12;

export interface ValidateClaimsInput {
  /** content_block | question_version | flashcard | message | case | artifact … */
  ownerType: string;
  ownerId: string;
  sentences: GeneratedSentence[];
  aliasMap: AliasMap;
  scope: ResolvedScope;
  /** 'ai' (default): independent verifier when available; 'off': deterministic only → never 'linked' */
  entailment?: 'ai' | 'off';
  jobId?: string;
  signal?: AbortSignal;
  /** write claim / citation / verification_result rows (default true) */
  persist?: boolean;
}

export interface CheckOutcome {
  check: VerificationCheck;
  passed: boolean;
  reason_ar?: string;
  details?: Record<string, unknown>;
}

export interface SentenceResult {
  index: number;
  text: string;
  /** carries a claim, or a value/threshold that needed one */
  medical: boolean;
  claim_id: string | null;
  status: VerificationStatus | 'not_applicable';
  support_type: SupportType | null;
  /** evidence ids that are valid AND in scope (citations are created for kept claims only) */
  evidence_ids: string[];
  /** aliases that were refused (unknown / fabricated / outside the scope) */
  rejected_aliases: string[];
  checks: CheckOutcome[];
  issues: Array<{ check: VerificationCheck; reason_ar: string }>;
  /** show it in the published output (rejected medical sentences are removed) */
  keep: boolean;
  /** why it was removed or needs review (Arabic) */
  reason_ar: string | null;
}

export interface ValidateClaimsResult {
  sentences: SentenceResult[];
  /** removed sentences with their reasons (shown on demand, never as supported) */
  removed: Array<{ text: string; reason_ar: string }>;
  counts: Record<VerificationStatus | 'not_applicable', number>;
  entailment: { used: boolean; model: string | null; reason_ar: string | null };
}

const verdictSchema = z.object({
  results: z
    .array(
      z.object({
        index: z.number().int().min(0),
        verdict: z.enum(['supported', 'partial', 'not_supported', 'contradicted']),
        reason: z.string().max(600).default(''),
      }),
    )
    .max(200),
});
type Verdict = z.infer<typeof verdictSchema>['results'][number];

const VERIFY_SYSTEM = [
  'You are an independent evidence verifier for a medical study application. You did NOT write the claims.',
  'For every numbered claim decide, using ONLY the evidence excerpts given for that claim, whether the evidence supports it.',
  '- "supported": every part of the claim is stated in or directly entailed by the evidence, including numbers, units, doses, thresholds, negations, age groups, conditions and exceptions.',
  '- "partial": the evidence supports only part of the claim.',
  '- "not_supported": the evidence does not establish the claim (topical similarity or shared keywords are NOT support).',
  '- "contradicted": the evidence states the opposite or a different value.',
  'Do not use outside knowledge. A claim may be in Arabic while the evidence is in English (or the reverse); judge the meaning.',
  'Write each reason as one short Arabic sentence.',
  'Return JSON: {"results":[{"index":<claim number>,"verdict":"…","reason":"…"}]} with one entry per claim.',
].join('\n');

const MSG = {
  noEvidence: 'جملة طبية دون أي دليل مرفق.',
  unknownAlias: (a: string[]) => `يشير إلى دليل لم يُسلَّم للمولّد (${a.join('، ')}): رُفض ولا يتحول إلى استشهاد.`,
  fabricated: (a: string[]) => `معرّف الدليل (${a.join('، ')}) غير موجود في سجل الأدلة.`,
  outOfScope: 'الدليل من مصدر/نسخة خارج النطاق المقفل (Source Lock).',
  sourceDeleted: 'مصدر الدليل محذوف.',
  regionUnusable: 'استخراج منطقة الدليل مرفوض (أو نصها مولَّد آليًا)؛ لا تُستخدم دليلًا.',
  externalNotAllowed: 'الجملة موسومة «مكمّل من مصدر خارجي» والنطاق الحالي لا يسمح بأدلة خارجية.',
  unsupportedType: 'وسم المولّد هذه الجملة بأنها غير مدعومة؛ حُذفت.',
  valueWithoutClaim: 'جملة تحمل قيمة أو حدًّا دون دليل مرفق؛ حُذفت.',
  quoteWithoutEvidence: 'نص معروض كاقتباس أصلي من المصدر دون دليل يمكن مطابقته حرفيًا؛ حُذف.',
  entailOff: 'لم يُجرَ تحقق مستقل من الدعم؛ الجملة تحتاج مراجعة قبل اعتبارها مرتبطة بدليل.',
  entailFailed: 'تعذّر إجراء التحقق المستقل من الدعم الآن؛ الجملة تحتاج مراجعة.',
  entailMissing: 'لم يُرجع المحقق المستقل حكمًا لهذه الجملة؛ تحتاج مراجعة.',
  partial: 'الدليل يدعم جزءًا فقط من الجملة.',
  notSupported: 'المحقق المستقل: الدليل لا يثبت الجملة (التشابه في الموضوع ليس دعمًا).',
  contradicted: 'المحقق المستقل: الدليل يناقض الجملة.',
  contradictedUnconfirmed: 'وسم المولّد هذه الجملة بأن المصدر يعارضها، ولم يؤكد المحقق المستقل هذا التعارض؛ تحتاج مراجعة.',
  contradictedNoVerifier: 'وسم المولّد هذه الجملة بأن المصدر يعارضها، ولم يُجرَ تحقق مستقل من ذلك؛ تحتاج مراجعة.',
};

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

interface EvidenceRowLite {
  id: string;
  version_id: string;
  source_id: string;
  quote: string;
  source_deleted: number;
  /** the region was rejected (bad extraction) after the evidence was created, or is model-written text */
  region_unusable: number;
}

function langOf(text: string): string {
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length;
  const la = (text.match(/[A-Za-z]/g) ?? []).length;
  if (ar === 0 && la === 0) return 'und';
  if (ar > 0 && la > 0 && Math.min(ar, la) / Math.max(ar, la) > 0.25) return 'mixed';
  return ar >= la ? 'ar' : 'en';
}

interface Pending {
  result: SentenceResult;
  /** the generator itself labelled the sentence «contradicted» (confirmed only by the verifier) */
  declaredContradiction: boolean;
  quotes: Array<{ alias: string; label: string; quote: string }>;
  versionIds: string[];
}

/** Validate generated sentences against the evidence they cite; persist claims/citations/results. */
export async function validateClaims(ctx: AppContext, input: ValidateClaimsInput): Promise<ValidateClaimsResult> {
  const { scope } = input;
  if (!scope || !Array.isArray(scope.versionIds)) throw new AppError('OUT_OF_SCOPE', 'التحقق يحتاج نطاق مصادر محسومًا (Source Lock).', 409);
  const allowedVersions = new Set(scope.versionIds);
  const aliasMap = input.aliasMap ?? {};

  // load every evidence row the alias map points at (one query)
  const ids = [...new Set(Object.keys(aliasMap).filter((k) => hasOwn(aliasMap, k)).map((k) => aliasMap[k]!))];
  const evRows = new Map<string, EvidenceRowLite>();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    if (part.length === 0) continue;
    for (const r of ctx.db.all<EvidenceRowLite>(
      `SELECT e.id, e.version_id, e.source_id, e.quote, CASE WHEN s.id IS NULL OR s.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS source_deleted,
              CASE WHEN r.status = 'rejected' OR r.text_origin = 'vision' THEN 1 ELSE 0 END AS region_unusable
         FROM evidence e LEFT JOIN source s ON s.id = e.source_id LEFT JOIN source_region r ON r.id = e.region_id
        WHERE e.id IN (${part.map(() => '?').join(',')})`,
      part,
    ))
      evRows.set(r.id, r);
  }
  const labels = new Map(getViews(ctx, ids, { pinnedVersionIds: scope.versionIds }).map((v) => [v.id, `${v.source_title} — ${v.locator_label_ar}`]));

  const results: SentenceResult[] = [];
  const pending: Pending[] = [];

  input.sentences.forEach((s, index) => {
    const text = String(s.text ?? '');
    const base: SentenceResult = {
      index,
      text,
      medical: false,
      claim_id: null,
      status: 'not_applicable',
      support_type: null,
      evidence_ids: [],
      rejected_aliases: [],
      checks: [],
      issues: [],
      keep: true,
      reason_ar: null,
    };
    if (!s.claim) {
      if (s.original_quote) {
        // «original text» must be matched verbatim against a cited source — impossible without evidence
        base.medical = true;
        base.status = 'rejected';
        base.keep = false;
        base.reason_ar = MSG.quoteWithoutEvidence;
        base.checks.push({ check: 'quote_containment', passed: false, reason_ar: MSG.quoteWithoutEvidence });
      } else if (looksLikeUnsupportedValue(text)) {
        base.medical = true;
        base.status = 'rejected';
        base.keep = false;
        base.reason_ar = MSG.valueWithoutClaim;
        base.checks.push({ check: 'evidence_exists', passed: false, reason_ar: MSG.valueWithoutClaim });
      }
      results.push(base);
      return;
    }
    base.medical = true;
    const supportType = (SUPPORT_TYPES as readonly string[]).includes(s.claim.support_type) ? (s.claim.support_type as SupportType) : null;
    base.support_type = supportType;
    if (!supportType) {
      base.checks.push({ check: 'schema', passed: false, reason_ar: 'نوع الاستناد غير صالح.' });
    } else if (supportType === 'unsupported') {
      base.checks.push({ check: 'schema', passed: false, reason_ar: MSG.unsupportedType });
    }

    // evidence_exists (AC-06)
    const aliases = [...new Set((Array.isArray(s.claim.evidence) ? s.claim.evidence : []).map((a) => String(a)))].slice(0, 30);
    const unknown = aliases.filter((a) => !hasOwn(aliasMap, a));
    const fabricated = aliases.filter((a) => hasOwn(aliasMap, a) && !evRows.has(aliasMap[a]!));
    const valid = aliases.filter((a) => hasOwn(aliasMap, a) && evRows.has(aliasMap[a]!));
    if (aliases.length === 0) base.checks.push({ check: 'evidence_exists', passed: false, reason_ar: MSG.noEvidence });
    else if (unknown.length || fabricated.length) {
      const reasons = [unknown.length ? MSG.unknownAlias(unknown) : null, fabricated.length ? MSG.fabricated(fabricated) : null].filter(Boolean).join(' ');
      base.checks.push({ check: 'evidence_exists', passed: false, reason_ar: reasons, details: { unknown, fabricated } });
    } else base.checks.push({ check: 'evidence_exists', passed: true });
    base.rejected_aliases.push(...unknown, ...fabricated);

    // in_scope (AC-05)
    const outside = valid.filter((a) => !allowedVersions.has(evRows.get(aliasMap[a]!)!.version_id));
    const deleted = valid.filter((a) => evRows.get(aliasMap[a]!)!.source_deleted === 1);
    const unusable = valid.filter((a) => evRows.get(aliasMap[a]!)!.region_unusable === 1);
    const scopeReasons: string[] = [];
    if (outside.length) scopeReasons.push(MSG.outOfScope);
    if (deleted.length) scopeReasons.push(MSG.sourceDeleted);
    if (unusable.length) scopeReasons.push(MSG.regionUnusable);
    if (supportType === 'externally_supplemented' && !scope.allowExternal) scopeReasons.push(MSG.externalNotAllowed);
    if (valid.length > 0 || supportType === 'externally_supplemented') {
      base.checks.push(scopeReasons.length ? { check: 'in_scope', passed: false, reason_ar: scopeReasons.join(' '), details: { outside, deleted, unusable } } : { check: 'in_scope', passed: true });
    }
    base.rejected_aliases.push(...outside.filter((a) => !base.rejected_aliases.includes(a)));
    const usable = valid.filter((a) => !outside.includes(a) && !deleted.includes(a) && !unusable.includes(a));
    base.evidence_ids = usable.map((a) => aliasMap[a]!);
    const quotes = usable.map((a) => ({ alias: a, label: labels.get(aliasMap[a]!) ?? a, quote: evRows.get(aliasMap[a]!)!.quote }));

    const structuralFail = base.checks.some((c) => !c.passed);
    if (!structuralFail && supportType !== 'contradicted') {
      // critical tokens (AC-07, §12)
      const crit = checkCriticalTokens(text, quotes.map((q) => q.quote));
      base.checks.push(
        crit.passed
          ? { check: 'critical_tokens', passed: true, details: { cross_language: crit.cross_language } }
          : { check: 'critical_tokens', passed: false, reason_ar: crit.reasons_ar.join(' '), details: { missing: crit.missing, cross_language: crit.cross_language } },
      );
      // quote containment
      if (s.original_quote || supportType === 'directly_stated') {
        const cont = checkContainment(text, quotes.map((q) => q.quote), s.original_quote ? 'original_quote' : 'directly_stated');
        base.checks.push(
          cont.passed
            ? { check: 'quote_containment', passed: true, details: { method: cont.method, coverage: cont.coverage } }
            : { check: 'quote_containment', passed: false, reason_ar: cont.reason_ar ?? '', details: { method: cont.method, coverage: cont.coverage } },
        );
      }
    }

    const failed = base.checks.filter((c) => !c.passed);
    if (failed.length > 0) {
      base.status = 'rejected';
      base.keep = false;
      base.reason_ar = failed.map((f) => f.reason_ar).filter(Boolean).join(' ');
    } else {
      pending.push({
        result: base,
        quotes,
        versionIds: [...new Set(usable.map((a) => evRows.get(aliasMap[a]!)!.version_id))],
        declaredContradiction: supportType === 'contradicted',
      });
    }
    results.push(base);
  });

  // independent entailment verification
  const entail = await runEntailment(ctx, input, pending);
  for (const p of pending) {
    const v = entail.verdicts.get(p.result.index);
    const r = p.result;
    if (!entail.used) {
      r.status = 'needs_review';
      r.reason_ar = p.declaredContradiction ? MSG.contradictedNoVerifier : (entail.reason_ar ?? MSG.entailFailed);
      r.checks.push({ check: 'entailment', passed: false, reason_ar: entail.reason_ar ?? r.reason_ar, details: { status: 'unavailable', declared_contradiction: p.declaredContradiction } });
      continue;
    }
    if (!v) {
      r.status = 'needs_review';
      r.reason_ar = entail.batchErrors.get(r.index) ?? MSG.entailMissing;
      r.checks.push({ check: 'entailment', passed: false, reason_ar: r.reason_ar, details: { status: 'missing', declared_contradiction: p.declaredContradiction } });
      continue;
    }
    const details = { verdict: v.verdict, model: entail.model, declared_contradiction: p.declaredContradiction };
    if (p.declaredContradiction && (v.verdict === 'supported' || v.verdict === 'partial')) {
      // the generator says «the source contradicts this», the verifier does not: never shown as a confirmed conflict
      r.status = 'needs_review';
      r.reason_ar = [MSG.contradictedUnconfirmed, v.reason].filter(Boolean).join(' ');
      r.checks.push({ check: 'entailment', passed: false, reason_ar: r.reason_ar, details });
    } else if (v.verdict === 'supported') {
      r.status = 'linked';
      r.checks.push({ check: 'entailment', passed: true, details });
    } else if (v.verdict === 'partial') {
      r.status = 'needs_review';
      r.reason_ar = [MSG.partial, v.reason].filter(Boolean).join(' ');
      r.checks.push({ check: 'entailment', passed: false, reason_ar: r.reason_ar, details });
    } else if (v.verdict === 'contradicted') {
      r.status = 'conflict';
      r.reason_ar = [MSG.contradicted, v.reason].filter(Boolean).join(' ');
      r.checks.push({ check: 'entailment', passed: false, reason_ar: r.reason_ar, details });
    } else {
      r.status = 'rejected';
      r.keep = false;
      r.reason_ar = [MSG.notSupported, v.reason].filter(Boolean).join(' ');
      r.checks.push({ check: 'entailment', passed: false, reason_ar: r.reason_ar, details });
    }
  }

  for (const r of results) r.issues = r.checks.filter((c) => !c.passed && c.reason_ar).map((c) => ({ check: c.check, reason_ar: c.reason_ar! }));
  if (input.persist !== false) persistResults(ctx, input, results, entail.model);

  const counts = { pending: 0, linked: 0, needs_review: 0, conflict: 0, rejected: 0, owner_reviewed: 0, not_applicable: 0 } as ValidateClaimsResult['counts'];
  for (const r of results) counts[r.status]++;
  return {
    sentences: results,
    removed: results.filter((r) => !r.keep).map((r) => ({ text: r.text, reason_ar: r.reason_ar ?? MSG.noEvidence })),
    counts,
    entailment: { used: entail.used, model: entail.model, reason_ar: entail.used ? null : entail.reason_ar },
  };
}

interface EntailmentOutcome {
  used: boolean;
  model: string | null;
  reason_ar: string | null;
  verdicts: Map<number, Verdict>;
  batchErrors: Map<number, string>;
}

async function runEntailment(ctx: AppContext, input: ValidateClaimsInput, pending: Pending[]): Promise<EntailmentOutcome> {
  const out: EntailmentOutcome = { used: false, model: null, reason_ar: null, verdicts: new Map(), batchErrors: new Map() };
  if (pending.length === 0) return out; // nothing passed the deterministic checks → nothing to verify
  if (input.entailment === 'off') return { ...out, reason_ar: MSG.entailOff };
  if (!ctx.ai.isAvailable('verify_support')) {
    const why = ctx.ai.status().tasks.verify_support.reason_ar ?? ABSTAIN_REASON_LABELS_AR.ai_not_configured;
    return { ...out, reason_ar: `لم يُجرَ التحقق المستقل من الدعم: ${why}` };
  }
  let anyOk = false;
  for (let i = 0; i < pending.length; i += ENTAILMENT_BATCH) {
    const batch = pending.slice(i, i + ENTAILMENT_BATCH);
    const blocks: UntrustedBlock[] = batch.map((p) => ({
      label: `claim ${p.result.index}`,
      text: [`CLAIM [${p.result.index}]: ${p.result.text}`, ...p.quotes.map((q) => `EVIDENCE ${q.alias} (${q.label}):\n${q.quote}`)].join('\n\n'),
    }));
    try {
      const res = await ctx.ai.generateStructured({
        task: 'verify_support',
        schema: verdictSchema,
        system: VERIFY_SYSTEM,
        input: blocks,
        instruction: `Verify claims: ${batch.map((p) => p.result.index).join(', ')}. One result per claim index.`,
        scope: input.scope,
        sourceVersionIds: [...new Set(batch.flatMap((p) => p.versionIds))],
        jobId: input.jobId,
        signal: input.signal,
        maxOutputTokens: 300 + 160 * batch.length,
      });
      anyOk = true;
      out.model = res.model;
      const wanted = new Set(batch.map((p) => p.result.index));
      for (const v of res.output.results) if (wanted.has(v.index) && !out.verdicts.has(v.index)) out.verdicts.set(v.index, v);
    } catch (e) {
      if (input.signal?.aborted) throw e;
      const why = isAppError(e) ? e.messageAr : MSG.entailFailed;
      for (const p of batch) out.batchErrors.set(p.result.index, `${MSG.entailFailed} (${why})`);
    }
  }
  if (!anyOk) return { ...out, used: false, reason_ar: [...out.batchErrors.values()][0] ?? MSG.entailFailed };
  out.used = true;
  return out;
}

function persistResults(ctx: AppContext, input: ValidateClaimsInput, results: SentenceResult[], model: string | null): void {
  const now = ctx.clock.now();
  const verifierAi = model ? `${ctx.ai.providerName ?? 'ai'}:${model}` : 'ai';
  ctx.db.tx(() => {
    for (const r of results) {
      if (!r.medical) continue;
      const id = newId(now);
      r.claim_id = id;
      const flags = extractCriticalTokens(r.text);
      ctx.db.run(
        `INSERT INTO claim (id, owner_type, owner_id, text, lang, support_type, verification_status, critical_flags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.ownerType,
          input.ownerId,
          r.text,
          langOf(r.text),
          r.support_type ?? 'unsupported',
          r.status === 'not_applicable' ? 'rejected' : r.status,
          toJson({
            negation: flags.negation,
            numbers: flags.numbers,
            units: flags.units,
            quantities: flags.quantities,
            comparators: flags.comparators,
            populations: flags.populations,
            exception: flags.exception,
          }),
          now,
          now,
        ],
      );
      for (const c of r.checks) {
        ctx.db.run(
          `INSERT INTO verification_result (id, subject_type, subject_id, check_name, passed, details_json, verifier, verifier_version, created_at)
           VALUES (?, 'claim', ?, ?, ?, ?, ?, ?, ?)`,
          [newId(now), id, c.check, c.passed ? 1 : 0, toJson({ reason_ar: c.reason_ar ?? null, ...(c.details ?? {}) }), c.check === 'entailment' && c.details?.status !== 'unavailable' && c.details?.status !== 'missing' ? verifierAi : 'deterministic', VERIFIER_VERSION, now],
        );
      }
      // citations only for kept claims and only for valid, in-scope evidence (AC-05/06)
      if (r.keep && r.status !== 'rejected') {
        const ent = r.checks.find((c) => c.check === 'entailment');
        const partial = ent?.details?.verdict === 'partial';
        // a contradiction the verifier did not confirm is cited as context only (never «supports»/«contradicts»)
        const unconfirmedContradiction = r.support_type === 'contradicted' && r.status !== 'conflict';
        const relation = r.status === 'conflict' ? 'contradicts' : unconfirmedContradiction ? 'context' : partial ? 'partially_supports' : 'supports';
        for (const evId of r.evidence_ids) {
          ctx.db.run(`INSERT INTO citation (id, claim_id, evidence_id, relation, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(claim_id, evidence_id) DO NOTHING`, [
            newId(now),
            id,
            evId,
            relation,
            now,
          ]);
        }
      }
      if (r.status === 'conflict') {
        const src = r.evidence_ids.length ? ctx.db.get<{ source_id: string }>('SELECT source_id FROM evidence WHERE id = ?', [r.evidence_ids[0]!]) : undefined;
        ctx.db.run(
          `INSERT INTO review_queue_item (id, kind, entity_type, entity_id, source_id, reason, details_json, status, created_at)
           VALUES (?, 'claim_unsupported', 'claim', ?, ?, ?, ?, 'open', ?)`,
          [newId(now), id, src?.source_id ?? null, r.reason_ar ?? MSG.contradicted, toJson({ origin: 'evidence', owner_type: input.ownerType, owner_id: input.ownerId }), now],
        );
      }
    }
  });
}

// ───────── reads ─────────
interface ClaimRow {
  id: string;
  owner_type: string;
  owner_id: string;
  text: string;
  support_type: SupportType;
  verification_status: VerificationStatus;
}

/** ClaimViews by id (citations with current evidence availability, failed checks as Arabic issues). */
export function getClaimViews(ctx: AppContext, claimIds: string[], opts: { pinnedVersionIds?: Iterable<string> } = {}): Record<string, ClaimView> {
  const unique = [...new Set(claimIds)];
  const out: Record<string, ClaimView> = {};
  if (unique.length === 0) return out;
  for (let i = 0; i < unique.length; i += 400) {
    const part = unique.slice(i, i + 400);
    const ph = part.map(() => '?').join(',');
    const claims = ctx.db.all<ClaimRow>(`SELECT id, owner_type, owner_id, text, support_type, verification_status FROM claim WHERE id IN (${ph})`, part);
    const cits = ctx.db.all<{ claim_id: string; evidence_id: string; relation: ClaimView['citations'][number]['relation'] }>(
      `SELECT claim_id, evidence_id, relation FROM citation WHERE claim_id IN (${ph}) ORDER BY created_at, id`,
      part,
    );
    const views = new Map(getViews(ctx, cits.map((c) => c.evidence_id), opts).map((v) => [v.id, v]));
    const results = ctx.db.all<{ subject_id: string; check_name: VerificationCheck; passed: number; details_json: string | null }>(
      `SELECT subject_id, check_name, passed, details_json FROM verification_result WHERE subject_type = 'claim' AND subject_id IN (${ph}) ORDER BY created_at, id`,
      part,
    );
    for (const c of claims) {
      out[c.id] = {
        id: c.id,
        text: c.text,
        support_type: c.support_type,
        verification_status: c.verification_status,
        citations: cits
          .filter((x) => x.claim_id === c.id && views.has(x.evidence_id))
          .map((x) => ({ evidence: views.get(x.evidence_id)!, relation: x.relation })),
        issues: results
          .filter((x) => x.subject_id === c.id && x.passed === 0)
          .map((x) => ({ check: x.check_name, reason_ar: fromJson<{ reason_ar?: string | null }>(x.details_json)?.reason_ar ?? 'لم يجتز هذا الفحص.' })),
      };
    }
  }
  return out;
}

export function getClaimView(ctx: AppContext, claimId: string): ClaimView {
  const v = getClaimViews(ctx, [claimId])[claimId];
  if (!v) throw new AppError('NOT_FOUND', 'الادعاء المطلوب غير موجود.', 404, { claim_id: claimId });
  return v;
}

function ownerClaimFilter(ownerType: string, ownerId: string): { sql: string; params: string[] } {
  if (ownerType === 'artifact') {
    return {
      sql: `((cl.owner_type = 'content_block' AND cl.owner_id IN (SELECT id FROM content_block WHERE artifact_id = ?)) OR (cl.owner_type = 'artifact' AND cl.owner_id = ?))`,
      params: [ownerId, ownerId],
    };
  }
  return { sql: '(cl.owner_type = ? AND cl.owner_id = ?)', params: [ownerType, ownerId] };
}

/** Claim ids of an owner (an artifact includes its content blocks). */
export function claimIdsForOwner(ctx: AppContext, ownerType: string, ownerId: string): string[] {
  const f = ownerClaimFilter(ownerType, ownerId);
  return ctx.db.all<{ id: string }>(`SELECT cl.id FROM claim cl WHERE ${f.sql} ORDER BY cl.created_at, cl.id`, f.params).map((r) => r.id);
}

/**
 * Evidence Ribbon (§11): per source, how many of the owner's claims are linked to it (verification_status
 * linked / owner_reviewed, relation supports / partially_supports). Coverage — never a correctness score.
 */
export function ribbonFor(ctx: AppContext, ownerType: string, ownerId: string): EvidenceRibbonItem[] {
  const f = ownerClaimFilter(ownerType, ownerId);
  const rows = ctx.db.all<{ source_id: string; title: string | null; source_type: SourceType | null; n: number }>(
    `SELECT e.source_id, s.title, s.source_type, COUNT(DISTINCT cl.id) AS n
       FROM claim cl JOIN citation ci ON ci.claim_id = cl.id JOIN evidence e ON e.id = ci.evidence_id LEFT JOIN source s ON s.id = e.source_id
      WHERE ${f.sql} AND cl.verification_status IN ('linked','owner_reviewed') AND ci.relation IN ('supports','partially_supports')
      GROUP BY e.source_id ORDER BY n DESC, s.title`,
    f.params,
  );
  return rows.map((r) => ({
    source_id: r.source_id,
    source_title: (r.title ?? 'مصدر محذوف').replace(/[\r\n\t]+/g, ' ').trim(),
    source_type: r.source_type ?? 'lecture',
    supported_claims: r.n,
  }));
}
