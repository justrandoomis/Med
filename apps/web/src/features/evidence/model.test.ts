import { describe, expect, it } from 'vitest';
import type { ClaimView, EvidenceView } from '@medlevo/shared';
import { availabilityReason, canOpen, chipText, claimMark, linkedSentencesAr, ribbonFromClaims, segmentByClaim, sourcesCountAr } from './model';

export function ev(over: Partial<EvidenceView> = {}): EvidenceView {
  return {
    id: 'E1',
    source_id: 'S1',
    source_title: 'Acute Appendicitis',
    source_type: 'lecture',
    version_id: 'V1',
    version_no: 1,
    page_id: 'P2',
    page_index: 1,
    locator_label_ar: 'ص 12 (الصفحة 2 في الملف)',
    region_id: 'R1',
    region_kind: 'paragraph',
    quote: 'Ultrasound is the first-line imaging test in children.',
    bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 },
    extraction_status: 'extracted',
    availability: 'available',
    ...over,
  };
}

const claim = (id: string, status: ClaimView['verification_status'], evs: EvidenceView[] = []): ClaimView => ({
  id,
  text: id,
  support_type: 'derived',
  verification_status: status,
  citations: evs.map((e) => ({ evidence: e, relation: 'supports' as const })),
  issues: [],
});

describe('chip labels', () => {
  it('short page label for printed pages; both numberings stay in the peek', () => {
    expect(chipText(ev())).toBe('محاضرة ص12');
    expect(chipText(ev({ source_type: 'course_reference', locator_label_ar: 'فقرة 7' }))).toBe('مرجع فقرة 7');
    expect(chipText(ev({ source_type: 'textbook', locator_label_ar: 'شريحة 3' }))).toBe('كتاب شريحة 3');
    expect(chipText(ev({ source_type: 'question_source', locator_label_ar: 'ص 34' }))).toBe('مصدر أسئلة ص34');
    expect(chipText(ev({ source_type: 'my_notes', locator_label_ar: 'ص 1' }))).toBe('ملاحظاتي ص1');
  });
});

describe('availability', () => {
  it('says why a citation cannot be opened as-is and never offers a substitute', () => {
    expect(availabilityReason('available')).toBeNull();
    expect(availabilityReason('source_deleted')).toContain('حُذف');
    expect(availabilityReason('version_replaced', 2)).toContain('النسخة 2');
    expect(availabilityReason('not_downloaded_offline')).toContain('غير محمّلة');
    expect([canOpen('available'), canOpen('version_replaced'), canOpen('source_deleted'), canOpen('not_downloaded_offline')]).toEqual([true, true, false, false]);
  });
});

describe('claims', () => {
  it('segments paragraph runs by claim (chips go after each segment)', () => {
    const segs = segmentByClaim({
      dir: 'rtl',
      runs: [
        { t: 'الموجات ', claim: 'C1' },
        { t: 'Ultrasound', dir: 'ltr', claim: 'C1' },
        { t: ' ثم ' },
        { t: 'CT', claim: 'C2' },
      ],
    });
    expect(segs.map((s) => [s.claimId, s.runs.length])).toEqual([
      ['C1', 2],
      [null, 1],
      ['C2', 1],
    ]);
  });

  it('only linked / owner-reviewed claims count as supported', () => {
    expect(claimMark(claim('a', 'linked'))).toBe('linked');
    expect(claimMark(claim('a', 'owner_reviewed'))).toBe('linked');
    expect(claimMark(claim('a', 'needs_review'))).toBe('review');
    expect(claimMark(claim('a', 'conflict'))).toBe('conflict');
    expect(claimMark(claim('a', 'rejected'))).toBe('rejected');
    expect(claimMark(undefined)).toBe('unknown');
  });

  it('ribbon = linked claims per source (coverage counts, no percentages)', () => {
    const a = ev();
    const b = ev({ id: 'E2', source_id: 'S2', source_title: 'Reference', source_type: 'course_reference' });
    const items = ribbonFromClaims({
      C1: claim('C1', 'linked', [a, a]),
      C2: claim('C2', 'linked', [a, b]),
      C3: claim('C3', 'needs_review', [b]),
    });
    expect(items).toEqual([
      { source_id: 'S1', source_title: 'Acute Appendicitis', source_type: 'lecture', supported_claims: 2 },
      { source_id: 'S2', source_title: 'Reference', source_type: 'course_reference', supported_claims: 1 },
    ]);
  });

  it('Arabic number agreement in counts', () => {
    expect([1, 2, 3, 11].map(linkedSentencesAr)).toEqual(['جملة واحدة مرتبطة', 'جملتان مرتبطتان', '3 جمل مرتبطة', '11 جملة مرتبطة']);
    expect([1, 2, 5, 12].map(sourcesCountAr)).toEqual(['مصدر واحد', 'مصدران', '5 مصادر', '12 مصدرًا']);
  });
});
