// Evidence for case explanations / rubric rationales through C1 (validateClaims): every medical sentence is a claim
// whose evidence must exist, be inside the case's Source Lock, carry the critical tokens and (when a verifier is
// available) be judged supporting by an independent verifier call.
//
//  * owner-authored sentences are NEVER dropped (owner writing is never lost): a sentence whose evidence does not
//    support it is kept and marked «الدليل المرفق لا يدعمها»; a sentence without evidence is marked «بلا دليل».
//  * generated sentences that fail are REMOVED and listed (never shown as supported, never softened).
//  * an unchanged owner sentence (same text, same evidence) reuses the previous version's claim (no new verifier call).
import type { CaseSentence, CaseSentenceInput, GeneratedSentence, ResolvedScope } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { buildEvidencePack, validateClaims, type AliasMap, type SentenceResult } from '../evidence/services';

export const CLAIM_OWNER_TYPE = 'case';

export function sentenceKey(s: { text: string; medical?: boolean; evidence_ids?: string[] }): string {
  return `${s.text.trim()}\u0000${s.medical === false ? 0 : 1}\u0000${[...(s.evidence_ids ?? [])].sort().join(',')}`;
}

function statusOf(r: SentenceResult): CaseSentence['status'] {
  if (!r.medical) return 'not_medical';
  switch (r.status) {
    case 'linked':
    case 'owner_reviewed':
      return 'linked';
    case 'conflict':
      return 'conflict';
    case 'rejected':
      return 'rejected';
    case 'not_applicable':
      return 'no_evidence';
    default:
      return 'needs_review';
  }
}

const NO_SCOPE_AR = 'لا يمكن ربط دليل: لم يُحدَّد نطاق مصادر (Source Lock) لهذه الحالة.';

export interface OwnerResolution {
  byPath: Map<string, CaseSentence[]>;
  regionIds: string[];
}

/** Owner-authored sentences → stored sentences (claims validated, nothing dropped). */
export async function resolveOwnerSentences(
  ctx: AppContext,
  opts: { scope: ResolvedScope | null; ownerId: string; lists: Array<{ path: string; sentences: CaseSentenceInput[] }>; reuse: Map<string, CaseSentence> },
): Promise<OwnerResolution> {
  const byPath = new Map<string, CaseSentence[]>();
  type Pending = { path: string; index: number; input: Required<Pick<CaseSentenceInput, 'text'>> & { medical: boolean; evidence_ids: string[] } };
  const pending: Pending[] = [];
  for (const l of opts.lists) {
    const out: CaseSentence[] = [];
    l.sentences.forEach((raw, index) => {
      const s = { text: raw.text.trim(), medical: raw.medical !== false, evidence_ids: [...new Set(raw.evidence_ids ?? [])] };
      const reused = opts.reuse.get(sentenceKey(s));
      if (reused) out.push(reused);
      else if (!s.medical) out.push({ text: s.text, medical: false, claim_id: null, evidence_ids: [], status: 'not_medical', reason_ar: null });
      else if (s.evidence_ids.length === 0) out.push({ text: s.text, medical: true, claim_id: null, evidence_ids: [], status: 'no_evidence', reason_ar: 'لم يُرفق دليل من مصادرك لهذه الجملة.' });
      else if (!opts.scope) out.push({ text: s.text, medical: true, claim_id: null, evidence_ids: [], status: 'rejected', reason_ar: NO_SCOPE_AR });
      else {
        out.push(null as unknown as CaseSentence); // placeholder, filled after validation
        pending.push({ path: l.path, index, input: s });
      }
    });
    byPath.set(l.path, out);
  }
  const regionIds = new Set<string>();
  if (pending.length && opts.scope) {
    const allIds = [...new Set(pending.flatMap((p) => p.input.evidence_ids))];
    const pack = buildEvidencePack(ctx, opts.scope, allIds, { maxItems: 120 });
    const aliasOf = new Map(Object.entries(pack.aliasMap).map(([alias, id]) => [id, alias]));
    const refused = new Map(pack.refused.map((r) => [r.evidence_id, r.reason_ar]));
    for (const v of pack.views) if (v.region_id) regionIds.add(v.region_id);
    const toValidate: Array<{ p: Pending; sentence: GeneratedSentence }> = [];
    for (const p of pending) {
      const aliases = p.input.evidence_ids.map((id) => aliasOf.get(id)).filter((a): a is string => !!a);
      if (aliases.length === 0) {
        const why = p.input.evidence_ids.map((id) => refused.get(id) ?? 'الدليل غير موجود.').join(' ');
        byPath.get(p.path)![p.index] = { text: p.input.text, medical: true, claim_id: null, evidence_ids: [], status: 'rejected', reason_ar: why };
        continue;
      }
      toValidate.push({ p, sentence: { text: p.input.text, claim: { support_type: 'derived', evidence: aliases } } });
    }
    if (toValidate.length) {
      const v = await validateClaims(ctx, { ownerType: CLAIM_OWNER_TYPE, ownerId: opts.ownerId, sentences: toValidate.map((t) => t.sentence), aliasMap: pack.aliasMap, scope: opts.scope });
      toValidate.forEach((t, i) => {
        const r = v.sentences[i]!;
        const status = statusOf(r);
        byPath.get(t.p.path)![t.p.index] = {
          text: t.p.input.text,
          medical: true,
          claim_id: r.claim_id,
          evidence_ids: r.evidence_ids,
          status,
          reason_ar: status === 'linked' ? null : (r.reason_ar ?? (status === 'rejected' ? 'الدليل المرفق لا يدعم هذه الجملة.' : null)),
        };
      });
    }
  }
  return { byPath, regionIds: [...regionIds] };
}

export interface GeneratedResolution {
  byPath: Map<string, CaseSentence[]>;
  removed: Array<{ text: string; reason_ar: string }>;
  verifierUsed: boolean;
}

/** Generated sentences (aliases from the generation pack) → kept, verified sentences; failures removed and listed. */
export async function resolveGeneratedSentences(
  ctx: AppContext,
  opts: { scope: ResolvedScope; ownerId: string; aliasMap: AliasMap; lists: Array<{ path: string; sentences: GeneratedSentence[] }>; jobId?: string; signal?: AbortSignal },
): Promise<GeneratedResolution> {
  const flat = opts.lists.flatMap((l) => l.sentences.map((s, i) => ({ path: l.path, index: i, s })));
  const byPath = new Map<string, CaseSentence[]>(opts.lists.map((l) => [l.path, []]));
  const removed: GeneratedResolution['removed'] = [];
  if (flat.length === 0) return { byPath, removed, verifierUsed: false };
  const v = await validateClaims(ctx, {
    ownerType: CLAIM_OWNER_TYPE,
    ownerId: opts.ownerId,
    sentences: flat.map((f) => f.s),
    aliasMap: opts.aliasMap,
    scope: opts.scope,
    jobId: opts.jobId,
    signal: opts.signal,
  });
  flat.forEach((f, i) => {
    const r = v.sentences[i]!;
    if (!r.keep) {
      removed.push({ text: f.s.text, reason_ar: r.reason_ar ?? 'لم تجتز التحقق من الأدلة.' });
      return;
    }
    const status = statusOf(r);
    if (r.medical && status !== 'linked' && status !== 'needs_review') {
      removed.push({ text: f.s.text, reason_ar: r.reason_ar ?? 'لم تجتز التحقق من الأدلة.' });
      return;
    }
    byPath.get(f.path)!.push({
      text: f.s.text,
      medical: r.medical,
      claim_id: r.medical ? r.claim_id : null,
      evidence_ids: r.medical ? r.evidence_ids : [],
      status,
      reason_ar: status === 'needs_review' ? r.reason_ar : null,
    });
  });
  return { byPath, removed, verifierUsed: v.entailment.used };
}

/** All claim ids of a definition (for ClaimView maps). */
export function claimIdsOfDefinition(def: {
  stages: Array<{ teaching_points: CaseSentence[]; decisions: Array<{ explanation: CaseSentence[] }> }>;
  checklist: Array<{ rationale: CaseSentence[] }>;
  viva: null | { questions: Array<{ points: Array<{ rationale: CaseSentence[] }>; misconceptions: Array<{ correction: CaseSentence[] }> }> };
}): string[] {
  const ids: string[] = [];
  const add = (l: CaseSentence[]) => l.forEach((s) => s.claim_id && ids.push(s.claim_id));
  def.stages.forEach((s) => {
    add(s.teaching_points);
    s.decisions.forEach((d) => add(d.explanation));
  });
  def.checklist.forEach((c) => add(c.rationale));
  def.viva?.questions.forEach((q) => {
    q.points.forEach((p) => add(p.rationale));
    q.misconceptions.forEach((m) => add(m.correction));
  });
  return [...new Set(ids)];
}
