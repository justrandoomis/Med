// Round 7 — H3 item 2: «تحتاج إعادة ربط» used to list items with their previous place only («إعادة الربط اليدوي تصل في
// مرحلة لاحقة»). The owner now picks the new place — a page of the source, at a paragraph of it or at the same spot — or
// keeps the item detached; ink from the same old page moves as ONE group; the decision is one server call carrying the
// revisions this device saw, and the answer is merged into this device's copy.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationDTO, NeedsReanchorResponse, NoteDTO, PageRegionsResponse, ReanchorRequest, ReanchorResponse, SourcePageView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { api } from '../../../lib/api';
import { getDb } from '../../../lib/localdb';
import type { SourceDocument } from '../data/useSourceDocument';
import { reanchorGroups, ReanchorSection } from './ReanchorSection';

vi.mock('../../../lib/sync', async (orig) => ({ ...(await orig<typeof import('../../../lib/sync')>()), getSyncEngine: () => ({ syncNow: async () => undefined }) }));

const page = (i: number): SourcePageView =>
  ({ id: `P${i}`, version_id: 'V1', page_index: i, printed_label: String(11 + i), printed_label_origin: 'pdf_page_labels', kind: 'page', width: 595, height: 842, unit: 'pt', rotation: 0, text_status: 'digital', ocr_confidence: null, has_images: false, processing_status: 'ready', error_code: null, error_detail_ar: null, thumbnail_file_id: null, render_file_id: null, section_key: null }) as SourcePageView;
const doc = { detail: { id: 'S1' }, version: { id: 'V1' }, pages: [page(0), page(1), page(2)], mode: 'pdf', pdf: null, pdfError: null } as unknown as SourceDocument;
const gone = { type: 'page' as const, source_id: 'S1', version_id: 'V1', page_id: 'GONE', page_index: 7, space: 'page_norm' as const };
const ann = (id: string, kind: AnnotationDTO['kind'], data: Record<string, unknown> = {}): AnnotationDTO => ({
  id, kind, tool: kind === 'ink' ? 'pen' : null, anchor: gone, data, layer: kind === 'ink' ? 'ink' : 'highlight', z: 0, locked: false, anchor_status: 'needs_reanchor', previous_anchor: gone, input: null, device_id: 'B', rev: 3, created_at: 1, updated_at: 2, deleted_at: null,
});
const note: NoteDTO = { id: 'N1', node_id: null, title: null, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'ليش يبدأ الألم حول السرة؟' }] }] }, anchor: gone, origin: 'owner', ai_record: null, rev: 1, conflict_of_id: null, device_id: 'B', created_at: 1, updated_at: 1, deleted_at: null };
const LIST: NeedsReanchorResponse = {
  items: [
    { annotation: ann('A1', 'ink'), source_id: 'S1', source_title: 'محاضرة', previous_location_ar: 'الصفحة 8 في الملف — الإصدار 1' },
    { annotation: ann('A2', 'ink'), source_id: 'S1', source_title: 'محاضرة', previous_location_ar: 'الصفحة 8 في الملف — الإصدار 1' },
  ],
  notes: [{ note, source_id: 'S1', source_title: 'محاضرة', previous_location_ar: 'الصفحة 8 في الملف — الإصدار 1', reason_ar: 'صفحتها لم تعد موجودة' }],
  detached: { annotations: [{ annotation: { ...ann('H1', 'text_highlight', { quote: { exact: 'نقطة McBurney' } }), detached_at: 5 }, source_id: 'S1', source_title: 'محاضرة', previous_location_ar: 'ص 12' }], notes: [] },
};
const REGIONS: PageRegionsResponse = {
  page: page(1),
  regions: [{ id: 'R1', version_id: 'V1', page_id: 'P1', parent_region_id: null, kind: 'paragraph', reading_order: 1, bbox: { x: 0.1, y: 0.5, w: 0.8, h: 0.1 }, locator: null, text: 'يبدأ الألم عادة حول السرة', text_origin: 'digital', lang: 'ar', confidence: null, structure: null, status: 'extracted' }],
};

let posted: ReanchorRequest[];
beforeEach(async () => {
  posted = [];
  await getDb().open();
  await Promise.all([getDb().annotations.clear(), getDb().notes.clear(), getDb().outbox.clear()]);
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/annotations/needs-reanchor') return LIST;
    if (path === '/sources/pages/P1/regions') return REGIONS;
    if (path.startsWith('/sources/pages/')) return { page: page(0), regions: [] };
    throw new Error(`unexpected ${path}`);
  });
  vi.spyOn(api, 'post').mockImplementation(async (path: string, body: unknown) => {
    expect(path).toBe('/annotations/reanchor');
    const req = body as ReanchorRequest;
    posted.push(req);
    const moved = req.action === 'move';
    const res: ReanchorResponse = {
      annotations: req.items.filter((i) => i.kind === 'annotation').map((i) => ({ ...ann(i.id, 'ink'), anchor: { ...gone, page_id: 'P1', page_index: 1 }, anchor_status: moved ? 'reanchored' : 'needs_reanchor', rev: 4 })),
      notes: req.items.filter((i) => i.kind === 'note').map(() => ({ ...note, rev: 2, detached_at: moved ? null : 9 })),
      summary_ar: moved ? 'أُعيد ربط عنصران إلى «ص 12».' : 'أُبقيت الملاحظة دون ربط.',
    };
    return res;
  });
});

function show() {
  return render(
    <ToastProvider>
      <ReanchorSection doc={doc} local={[]} online onGoToPage={() => undefined} currentPageIndex={0} />
    </ToastProvider>,
  );
}

describe('H3 item 2 — choosing a new place in «تحتاج إعادة ربط»', () => {
  it('groups ink from the same old page; notes and highlights alone; detached items apart', () => {
    const groups = reanchorGroups(LIST, new Map());
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id), g.detached])).toEqual([
      ['كتابة بالقلم (عنصران)', ['A1', 'A2'], false],
      ['ملاحظة', ['N1'], false],
      ['تظليل نص', ['H1'], true],
    ]);
  });

  it('the ink group goes to a paragraph of page 12: one call with both strokes and the revisions this device saw', async () => {
    show();
    const list = await screen.findByRole('list', { name: 'تحتاج إعادة ربط' });
    const group = within(list).getByText('كتابة بالقلم (عنصران)').closest('li')!;
    expect(within(group).getByText(/مكانها السابق: الصفحة 8 في الملف/)).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: 'اختر مكانها الجديد…' }));
    const dialog = await screen.findByRole('dialog', { name: /أين تضع كتابة بالقلم/ });
    fireEvent.change(within(dialog).getByLabelText('الصفحة'), { target: { value: '1' } });
    const para = await within(dialog).findByRole('radio', { name: /عند الفقرة: «يبدأ الألم عادة حول السرة»/ });
    fireEvent.click(para);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'اربطها هنا' }));
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      action: 'move',
      target: { type: 'page', version_id: 'V1', page_id: 'P1', region_id: 'R1' },
      items: [
        { kind: 'annotation', id: 'A1', rev: 3 },
        { kind: 'annotation', id: 'A2', rev: 3 },
      ],
    });
    // the server's answer is on this device now
    await waitFor(async () => expect(await getDb().annotations.get('A1')).toMatchObject({ targetKey: 'source_page:P1', anchorStatus: 'reanchored', rev: 4 }));
    expect(await screen.findByText(/أُعيد ربط عنصران/)).toBeTruthy();
  });

  it('«أبقِها دون ربط» sends the owner\'s decision for the note — nothing is moved', async () => {
    show();
    const list = await screen.findByRole('list', { name: 'تحتاج إعادة ربط' });
    const row = within(list).getByText('ملاحظة').closest('li')!;
    expect(row.textContent).toContain('ليش يبدأ الألم حول السرة؟');
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'أبقِها دون ربط' }));
    });
    await waitFor(() => expect(posted).toEqual([{ action: 'keep_detached', items: [{ kind: 'note', id: 'N1', rev: 1 }] }]));
    // the detached highlight is listed apart, and can still be placed
    const detached = screen.getByRole('list', { name: 'محفوظة دون ربط' });
    expect(within(detached).getByText('تظليل نص')).toBeTruthy();
    expect(within(detached).getByRole('button', { name: 'اختر مكانها الجديد…' })).toBeTruthy();
  });

  it('offline: the decision is not offered (it is saved on the server and audited), the list stays', () => {
    render(
      <ToastProvider>
        <ReanchorSection doc={doc} local={[]} online={false} onGoToPage={() => undefined} />
      </ToastProvider>,
    );
    expect(screen.getAllByText(/تحتاج اتصالًا/).length).toBeGreaterThan(0);
  });
});
