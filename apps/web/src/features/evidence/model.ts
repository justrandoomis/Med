// Pure helpers for evidence UI (unit-tested): chip labels, availability wording, claim grouping inside
// RichText paragraphs, ribbon counts from claims. No React here.
import {
  SOURCE_TYPE_LABELS_AR,
  STATUS_LABELS_AR,
  SUPPORT_TYPE_LABELS_AR,
  sourceChipLabel,
  type ClaimView,
  type EvidenceRibbonItem,
  type EvidenceView,
  type Paragraph,
  type Run,
  type VerificationStatus,
} from '@medlevo/shared';

export type Availability = EvidenceView['availability'];

/** Chip text, e.g. «محاضرة ص11», «مرجع فقرة 4», «كتاب شريحة 3». */
export function chipText(e: Pick<EvidenceView, 'source_type' | 'locator_label_ar'>): string {
  return sourceChipLabel(e);
}

/** Why a citation cannot be opened as-is (null when it can). Never offers a substitute page (§11). */
export function availabilityReason(a: Availability, versionNo?: number): string | null {
  switch (a) {
    case 'available':
      return null;
    case 'source_deleted':
      return 'حُذف هذا المصدر؛ لا يمكن فتح موضع الدليل، ولن نفتح صفحة بديلة.';
    case 'version_replaced':
      return versionNo
        ? `هذا الدليل من النسخة ${versionNo} التي استُبدلت بنسخة أحدث؛ يُفتح على نسخته الأصلية.`
        : 'هذا الدليل من نسخة استُبدلت بنسخة أحدث؛ يُفتح على نسخته الأصلية.';
    case 'not_downloaded_offline':
      return 'هذه الصفحة غير محمّلة على هذا الجهاز، وأنت غير متصل. افتحها عند عودة الاتصال.';
  }
}

/** Can «افتح المصدر» act? (a replaced version still opens — on its own version, never swapped) */
export function canOpen(a: Availability): boolean {
  return a === 'available' || a === 'version_replaced';
}

export function sourceTypeLabel(t: EvidenceView['source_type']): string {
  return SOURCE_TYPE_LABELS_AR[t] ?? 'مصدر';
}

export function supportLabel(t: ClaimView['support_type']): string {
  return SUPPORT_TYPE_LABELS_AR[t];
}

/** Precise verification wording (never «AI Verified», §12). */
export function verificationLabel(s: VerificationStatus): string {
  return STATUS_LABELS_AR[s];
}

export function extractionLabel(s: EvidenceView['extraction_status']): string {
  return STATUS_LABELS_AR[s];
}

/** A paragraph cut into pieces: runs of one claim (or no claim) in order. */
export interface ClaimSegment {
  claimId: string | null;
  runs: Run[];
}

/** Consecutive runs of the same claim form one segment; chips render after each claim segment. */
export function segmentByClaim(p: Paragraph): ClaimSegment[] {
  const out: ClaimSegment[] = [];
  for (const r of p.runs) {
    const id = r.claim ?? null;
    const last = out[out.length - 1];
    if (last && last.claimId === id) last.runs.push(r);
    else out.push({ claimId: id, runs: [r] });
  }
  return out;
}

export type ClaimMark = 'linked' | 'review' | 'conflict' | 'rejected' | 'pending' | 'unknown';

/** How a claim's text must look: anything that is not linked/owner-reviewed is visibly marked. */
export function claimMark(c: ClaimView | undefined): ClaimMark {
  if (!c) return 'unknown';
  switch (c.verification_status) {
    case 'linked':
    case 'owner_reviewed':
      return 'linked';
    case 'needs_review':
      return 'review';
    case 'conflict':
      return 'conflict';
    case 'rejected':
      return 'rejected';
    case 'pending':
      return 'pending';
  }
}

export const CLAIM_MARK_LABELS_AR: Record<Exclude<ClaimMark, 'linked'>, string> = {
  review: STATUS_LABELS_AR.needs_review,
  conflict: STATUS_LABELS_AR.conflict,
  rejected: 'مرفوض — غير مدعوم',
  pending: STATUS_LABELS_AR.pending,
  unknown: 'بلا دليل',
};

/**
 * Evidence Ribbon from claims (§11): per source, the number of linked claims citing it. A coverage count —
 * never a correctness score and never a percentage.
 */
export function ribbonFromClaims(claims: Record<string, ClaimView>): EvidenceRibbonItem[] {
  const per = new Map<string, EvidenceRibbonItem & { ids: Set<string> }>();
  for (const c of Object.values(claims)) {
    if (claimMark(c) !== 'linked') continue;
    for (const cit of c.citations) {
      if (cit.relation !== 'supports' && cit.relation !== 'partially_supports') continue;
      const e = cit.evidence;
      const cur = per.get(e.source_id) ?? { source_id: e.source_id, source_title: e.source_title, source_type: e.source_type, supported_claims: 0, ids: new Set<string>() };
      if (!cur.ids.has(c.id)) {
        cur.ids.add(c.id);
        cur.supported_claims++;
      }
      per.set(e.source_id, cur);
    }
  }
  return [...per.values()]
    .map(({ ids: _ids, ...rest }) => rest)
    .sort((a, b) => b.supported_claims - a.supported_claims || a.source_title.localeCompare(b.source_title));
}

/** Arabic count of linked sentences: «جملة واحدة», «جملتان», «3 جمل», «11 جملة». */
export function sentencesAr(n: number): string {
  if (n === 1) return 'جملة واحدة';
  if (n === 2) return 'جملتان';
  if (n >= 3 && n <= 10) return `${n} جمل`;
  return `${n} جملة`;
}

/** «جملة واحدة مرتبطة», «جملتان مرتبطتان», «3 جمل مرتبطة», «11 جملة مرتبطة» (agreement of the adjective too). */
export function linkedSentencesAr(n: number): string {
  if (n === 2) return 'جملتان مرتبطتان';
  return `${sentencesAr(n)} مرتبطة`;
}

/** «مصدر واحد», «مصدران», «3 مصادر», «11 مصدرًا». */
export function sourcesCountAr(n: number): string {
  if (n === 1) return 'مصدر واحد';
  if (n === 2) return 'مصدران';
  if (n >= 3 && n <= 10) return `${n} مصادر`;
  return `${n} مصدرًا`;
}

/** Unique evidence of a claim set (to preload views). */
export function evidenceIdsOf(claims: Record<string, ClaimView>): string[] {
  const s = new Set<string>();
  for (const c of Object.values(claims)) for (const cit of c.citations) s.add(cit.evidence.id);
  return [...s];
}
