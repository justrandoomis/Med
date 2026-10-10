// Evidence packs for generators (ARCHITECTURE §3.6). A generator never sees real ids, pages or titles it
// could cite freely: it sees short aliases E1…En over evidence that ALREADY passed the scope filter. The
// server keeps the alias → evidence id map; validateClaims() rejects any alias it did not hand out (AC-06).
import { sourceChipLabel, type EvidenceForModel, type EvidenceView, type ResolvedScope } from '@medlevo/shared';
import { SOURCE_TYPE_LABELS_AR } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromChunk, fromRegion, getViews, type EvidenceRow } from './evidence';
import type { RetrievalCandidate } from './retrieval';

/** alias («E1») → evidence id. Plain object so it can be stored in a job checkpoint. */
export type AliasMap = Record<string, string>;

export interface EvidencePack {
  forModel: EvidenceForModel[];
  aliasMap: AliasMap;
  /** the evidence views behind the aliases (same order as forModel) */
  views: EvidenceView[];
  /** evidence refused because it is outside the scope or unavailable (never handed to the model) */
  refused: Array<{ evidence_id: string; reason_ar: string }>;
}

const MAX_QUOTE_CHARS = 2400;

/** Evidence rows for retrieval candidates (regions → whole-region excerpts; chunks → their regions). */
export function evidenceFromCandidates(ctx: AppContext, candidates: RetrievalCandidate[]): EvidenceRow[] {
  const out: EvidenceRow[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const safe = <T>(fn: () => T[]): T[] => {
      try {
        return fn();
      } catch {
        return []; // a region that cannot be cited (no text, trashed source) is simply not offered
      }
    };
    const rows = c.chunk_id ? safe(() => fromChunk(ctx, c.chunk_id!)) : c.region_ids.flatMap((id) => safe(() => [fromRegion(ctx, id)]));
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

function modelLabel(v: EvidenceView): string {
  const kind = SOURCE_TYPE_LABELS_AR[v.source_type] ?? 'مصدر';
  return `${kind}: ${v.source_title} — ${v.locator_label_ar}`.slice(0, 240);
}

/**
 * Build the model-facing pack from evidence ids. Anything outside `scope.versionIds`, from a trashed source
 * or missing is refused here (and reported) — it never reaches the model.
 */
export interface EvidencePackOptions {
  maxItems?: number;
  /**
   * G3 / AC-08: the pack feeds a FIXED answer (a scored generated question, a grading rubric). Evidence whose region
   * is an uncertain reading (diagram labels read by OCR without understanding) or flagged for review (low OCR
   * confidence, a suspected extraction defect) is refused — an unreadable region never becomes a fixed exam answer.
   */
  fixedAnswer?: boolean;
}

export const UNCERTAIN_FOR_FIXED_ANSWER_AR = 'قراءة آلية غير مؤكدة (تسميات رسم قُرئت دون فهم، أو نص ضعيف الثقة أو معلَّم للمراجعة)؛ لا تُبنى عليها إجابة امتحانية ثابتة حتى تُراجَع.';

export function buildEvidencePack(ctx: AppContext, scope: ResolvedScope, evidenceIds: string[], opts: EvidencePackOptions = {}): EvidencePack {
  const max = Math.min(Math.max(opts.maxItems ?? 40, 1), 120);
  const allowed = new Set(scope.versionIds);
  const pinned = new Set(scope.versionIds); // the scope's versions are the ones in use on purpose
  const views = getViews(ctx, evidenceIds, { pinnedVersionIds: pinned });
  const found = new Set(views.map((v) => v.id));
  const refused: EvidencePack['refused'] = [];
  for (const id of new Set(evidenceIds)) if (!found.has(id)) refused.push({ evidence_id: id, reason_ar: 'الدليل غير موجود.' });
  const kept: EvidenceView[] = [];
  for (const v of views) {
    if (!allowed.has(v.version_id)) refused.push({ evidence_id: v.id, reason_ar: 'الدليل من نسخة خارج النطاق المقفل (Source Lock).' });
    else if (v.availability === 'source_deleted') refused.push({ evidence_id: v.id, reason_ar: 'مصدر الدليل محذوف.' });
    else if (v.extraction_status === 'rejected') refused.push({ evidence_id: v.id, reason_ar: 'رُفض استخراج منطقة هذا الدليل؛ لا يُستخدم حتى يُصحَّح.' });
    else if (opts.fixedAnswer && (v.extraction_status === 'uncertain' || v.extraction_status === 'needs_review')) refused.push({ evidence_id: v.id, reason_ar: UNCERTAIN_FOR_FIXED_ANSWER_AR });
    else if (kept.length < max) kept.push(v);
  }
  const forModel: EvidenceForModel[] = [];
  const aliasMap: AliasMap = {};
  kept.forEach((v, i) => {
    const alias = `E${i + 1}`;
    aliasMap[alias] = v.id;
    forModel.push({ alias, source_label: modelLabel(v), source_type: v.source_type, quote: v.quote.length > MAX_QUOTE_CHARS ? v.quote.slice(0, MAX_QUOTE_CHARS) : v.quote });
  });
  return { forModel, aliasMap, views: kept, refused };
}

/** Convenience: retrieval candidates → evidence rows → pack. */
export function packFromCandidates(ctx: AppContext, scope: ResolvedScope, candidates: RetrievalCandidate[], opts: EvidencePackOptions = {}): EvidencePack {
  const rows = evidenceFromCandidates(ctx, candidates);
  return buildEvidencePack(ctx, scope, rows.map((r) => r.id), opts);
}

/** Chip label for a view (re-exported for server-side text such as exports). */
export function chipLabel(v: EvidenceView): string {
  return sourceChipLabel(v);
}
