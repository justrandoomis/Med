import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ArtifactView, ClaimView } from '@medlevo/shared';
import { ArtifactContent } from './ArtifactContent';
import { ev } from './model.test';

function claim(id: string, status: ClaimView['verification_status'], citations: ClaimView['citations'] = []): ClaimView {
  return { id, text: id, support_type: 'derived', verification_status: status, citations, issues: status === 'needs_review' ? [{ check: 'entailment', reason_ar: 'لم يُجرَ التحقق المستقل' }] : [] };
}

function artifact(over: Partial<ArtifactView> = {}): ArtifactView {
  return {
    id: 'A1',
    lineage_id: 'A1',
    version_no: 1,
    kind: 'explanation',
    title: 'شرح الفحوصات',
    primary_source_id: 'S1',
    scope: { mode: 'lecture_only', source_ids: ['S1'], version_ids: ['V1'], describe_ar: 'المحاضرة فقط — محاضرة: Acute Appendicitis (النسخة 1)' },
    params: {},
    status: 'published',
    model: 'fake',
    rules_version: 'r1',
    coverage: null,
    is_frozen: false,
    stale_reason: null,
    created_at: 1,
    published_at: 1,
    blocks: [
      {
        id: 'B1',
        block_key: 'b1',
        section_key: null,
        ord: 0,
        kind: 'paragraph',
        content: {
          v: 1,
          paragraphs: [
            {
              dir: 'rtl',
              runs: [
                { t: 'الفحص الأول عند الأطفال هو ', claim: 'C1' },
                { t: 'Ultrasound', dir: 'ltr', kind: 'term', claim: 'C1' },
                { t: '. ' },
                { t: 'ويُفضَّل ', claim: 'C2' },
                { t: 'CT abdomen', dir: 'ltr', claim: 'C2' },
                { t: ' عند البالغين. ' },
                { t: 'العدد الطبيعي يستبعد التشخيص.', claim: 'C3' },
                { t: ' جملة بلا سجل.', claim: 'C9' },
              ],
            },
          ],
        },
        table: null,
        source_region_ids: [],
        status: 'complete',
        verification_status: 'linked',
      },
    ],
    claims: {
      C1: claim('C1', 'linked', [{ evidence: ev(), relation: 'supports' }]),
      C2: claim('C2', 'needs_review', [{ evidence: ev({ id: 'E2', locator_label_ar: 'ص 12 (الصفحة 2 في الملف)' }), relation: 'supports' }]),
      C3: claim('C3', 'conflict', [{ evidence: ev({ id: 'E3', locator_label_ar: 'ص 11 (الصفحة 1 في الملف)' }), relation: 'contradicts' }]),
    },
    removed: [
      { text: 'A white cell count above 12 ×10⁹/L is diagnostic.', reason_ar: 'القيم العددية 12 غير موجودة في الدليل المستشهد به.' },
      { text: 'جملة أخرى', reason_ar: 'لا دليل' },
    ],
    abstain: null,
    ...over,
  };
}

const renderIt = (a: ArtifactView, onWiden?: (s: unknown) => void) =>
  render(
    <MemoryRouter>
      <ArtifactContent artifact={a} onWidenScope={onWiden} />
    </MemoryRouter>,
  );

describe('ArtifactContent', () => {
  it('is labelled as generated and shows the locked scope', () => {
    renderIt(artifact());
    expect(screen.getByText('محتوى مولَّد من مصادرك')).toBeTruthy();
    expect(screen.getByText('المحاضرة فقط')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/AI Verified|%/);
  });

  it('places each claim’s chips right after that claim’s runs, in logical order', () => {
    const { container } = renderIt(artifact());
    const c1 = container.querySelector('[data-claim="C1"]')!;
    expect(c1.textContent).toBe('الفحص الأول عند الأطفال هو Ultrasound');
    const trail = c1.nextElementSibling!;
    expect(trail.getAttribute('data-claim-trail')).toBe('C1');
    expect(within(trail as HTMLElement).getByRole('button', { name: /فتح المصدر: .*محاضرة ص12/ })).toBeTruthy();
    // the LTR term is isolated inside the claim
    expect(c1.querySelector('bdi[dir="ltr"]')?.textContent).toBe('Ultrasound');
    // text after the trail continues the paragraph
    expect(trail.nextSibling?.textContent).toBe('. ');
    // DOM text order equals the stored logical order
    const p = c1.closest('p')!;
    expect(p.textContent!.startsWith('الفحص الأول عند الأطفال هو Ultrasound')).toBe(true);
  });

  it('marks claims that are not linked: needs review, conflict, unknown (never shown as supported)', () => {
    const { container } = renderIt(artifact());
    const status = (id: string) => container.querySelector(`[data-claim-trail="${id}"] .ev-claim__status`)?.textContent ?? null;
    expect(status('C1')).toBeNull();
    expect(status('C2')).toBe('يحتاج مراجعة');
    expect(status('C3')).toBe('تعارض');
    expect(status('C9')).toBe('بلا دليل');
    expect(container.querySelector('[data-claim="C2"]')!.className).toContain('ev-claim--review');
    expect(container.querySelector('[data-claim="C3"]')!.className).toContain('ev-claim--conflict');
    expect(container.querySelector('[data-claim-trail="C9"] button')).toBeNull(); // no chip without evidence
  });

  it('offers the removed sentences on demand with their reasons', () => {
    renderIt(artifact());
    const summary = screen.getByText('جمل حُذفت لأنها لم تجتز التحقق (2)');
    expect(summary.tagName).toBe('SUMMARY');
    expect(screen.getByText('القيم العددية 12 غير موجودة في الدليل المستشهد به.')).toBeTruthy();
  });

  it('shows the evidence ribbon as coverage counts', () => {
    renderIt(artifact());
    expect(screen.getByText('جملة واحدة مرتبطة')).toBeTruthy();
    expect(screen.getByText(/تغطية وليست مقياسًا للصحة الطبية/)).toBeTruthy();
  });

  it('abstention: specific reason, and «وسّع النطاق» only as an explicit owner action', () => {
    const suggest = { mode: 'lecture_plus_references' as const, lecture_source_id: 'S1', reference_source_ids: ['S2'], version_pins: {}, include_my_notes: false };
    const a = artifact({
      blocks: [],
      claims: {},
      removed: [],
      abstain: { reason: 'not_found_in_scope', reason_ar: 'لم أجد هذه المعلومة في المصادر المسموحة ضمن النطاق الحالي.', detail: 'بُحث في 4 صفحات معالَجة من مصدر واحد ضمن النطاق.', suggest_scope: suggest },
    });
    const onWiden = vi.fn();
    renderIt(a, onWiden);
    expect(screen.getByText('لم أجد هذه المعلومة في المصادر المسموحة ضمن النطاق الحالي.')).toBeTruthy();
    expect(screen.getByText(/4 صفحات/)).toBeTruthy();
    expect(onWiden).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'وسّع النطاق' }));
    expect(onWiden).toHaveBeenCalledWith(suggest);
  });

  it('a stale artifact says so; a rejected block is not rendered as content', () => {
    const a = artifact({ status: 'stale', stale_reason: 'نسخة جديدة من المصدر: Acute Appendicitis — راجع تنبيه التغيير' });
    a.blocks.push({ ...a.blocks[0]!, id: 'B2', block_key: 'b2', ord: 1, status: 'rejected' });
    renderIt(a);
    expect(screen.getByText('قد يكون قديمًا')).toBeTruthy();
    expect(screen.getByText(/راجع تنبيه التغيير/)).toBeTruthy();
    expect(screen.getByText('حُذف هذا الجزء لأنه لم يجتز التحقق من الأدلة.')).toBeTruthy();
    expect(document.querySelectorAll('[data-claim="C1"]')).toHaveLength(1);
  });
});

describe('review regressions (C1 adversarial review)', () => {
  it('only the RichText contract marks become elements (anything else in stored content is ignored)', () => {
    const a = artifact();
    const p = a.blocks[0]!.content.paragraphs[0]!;
    const blocks = [{ ...a.blocks[0]!, content: { v: 1 as const, paragraphs: [{ ...p, runs: [{ t: 'bold', marks: ['b'] }, { t: 'framed', marks: ['iframe', 'script'] }] }] } }];
    const { container } = renderIt(artifact({ blocks } as unknown as Partial<ArtifactView>));
    expect(container.querySelector('b')?.textContent).toBe('bold');
    expect(container.querySelector('iframe, script')).toBeNull();
    expect(container.textContent).toContain('framed');
  });
});

describe('review regressions: reasons without hover', () => {
  it('why a claim needs review is reachable by a button (not only a hover title)', () => {
    const { container } = renderIt(artifact());
    const trail = container.querySelector('[data-claim-trail="C2"]') as HTMLElement;
    const btn = within(trail).getByRole('button', { name: 'لماذا؟' });
    const note = trail.querySelector('.ev-claim__reason') as HTMLElement;
    expect(note.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('لم يُجرَ التحقق المستقل');
    expect(btn.getAttribute('aria-controls')).toBe(note.id);
    // a linked claim has no such control
    expect(within(container.querySelector('[data-claim-trail="C1"]') as HTMLElement).queryByRole('button', { name: 'لماذا؟' })).toBeNull();
  });
});
