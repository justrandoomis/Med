// Independent review of Round 7 — H3 item 2. The decision carries the revisions this device SAW; the server answers 409
// when an item changed since (another device — or this device's own unsent edits, pushed right before the call). The
// panel then said «حدّث القائمة ثم أعد الاختيار», but it never fetched the list again and offered no way to: every later
// attempt sent the same stale revisions and was refused again, until the reader was closed and reopened.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationDTO, NeedsReanchorResponse, ReanchorRequest, ReanchorResponse, SourcePageView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { api, ApiError } from '../../../lib/api';
import { getDb } from '../../../lib/localdb';
import type { SourceDocument } from '../data/useSourceDocument';
import { ReanchorSection } from './ReanchorSection';

vi.mock('../../../lib/sync', async (orig) => ({ ...(await orig<typeof import('../../../lib/sync')>()), getSyncEngine: () => ({ syncNow: async () => undefined }) }));

const page = (i: number): SourcePageView =>
  ({ id: `P${i}`, version_id: 'V1', page_index: i, printed_label: String(11 + i), printed_label_origin: 'pdf_page_labels', kind: 'page', width: 595, height: 842, unit: 'pt', rotation: 0, text_status: 'digital', ocr_confidence: null, has_images: false, processing_status: 'ready', error_code: null, error_detail_ar: null, thumbnail_file_id: null, render_file_id: null, section_key: null }) as SourcePageView;
const doc = { detail: { id: 'S1' }, version: { id: 'V1' }, pages: [page(0), page(1)], mode: 'pdf', pdf: null, pdfError: null } as unknown as SourceDocument;
const gone = { type: 'page' as const, source_id: 'S1', version_id: 'V1', page_id: 'GONE', page_index: 7, space: 'page_norm' as const };
const ann = (rev: number): AnnotationDTO => ({
  id: 'A1', kind: 'ink', tool: 'pen', anchor: gone, data: {}, layer: 'ink', z: 0, locked: false, anchor_status: 'needs_reanchor', previous_anchor: gone, input: null, device_id: 'B', rev, created_at: 1, updated_at: 2, deleted_at: null,
});
const list = (rev: number): NeedsReanchorResponse => ({ items: [{ annotation: ann(rev), source_id: 'S1', source_title: 'محاضرة', previous_location_ar: 'الصفحة 8 في الملف' }], notes: [], detached: { annotations: [], notes: [] } });

let serverRev: number;
let posted: ReanchorRequest[];
beforeEach(async () => {
  serverRev = 3;
  posted = [];
  await getDb().open();
  await Promise.all([getDb().annotations.clear(), getDb().notes.clear(), getDb().outbox.clear()]);
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/annotations/needs-reanchor') return list(serverRev);
    throw new Error(`unexpected ${path}`);
  });
  vi.spyOn(api, 'post').mockImplementation(async (_path: string, body: unknown) => {
    const req = body as ReanchorRequest;
    posted.push(req);
    if (req.items.some((i) => i.rev !== serverRev)) {
      throw new ApiError({ code: 'CONFLICT', status: 409, message: 'تغيّر أحد العناصر على جهاز آخر بعد أن فتحت هذه القائمة؛ لم يتغير شيء. حدّث القائمة ثم أعد الاختيار.' });
    }
    const res: ReanchorResponse = { annotations: [{ ...ann(serverRev + 1), detached_at: 9 }], notes: [], summary_ar: 'أُبقي العنصر دون ربط.' };
    return res;
  });
});

describe('H3 review — «تحتاج إعادة ربط» after the server refused a stale decision', () => {
  it('the list is fetched again, so the next decision carries the current revision (and is accepted)', async () => {
    render(
      <ToastProvider>
        <ReanchorSection doc={doc} local={[]} online onGoToPage={() => undefined} />
      </ToastProvider>,
    );
    const ul = await screen.findByRole('list', { name: 'تحتاج إعادة ربط' });
    // meanwhile the item was edited on another device: the server is at rev 5
    serverRev = 5;
    await act(async () => {
      fireEvent.click(within(ul).getByRole('button', { name: 'أبقِها دون ربط' }));
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(await screen.findByText('لم يُنفَّذ القرار')).toBeTruthy();
    // the owner tries again from the (refreshed) list
    await waitFor(async () => {
      const again = within(await screen.findByRole('list', { name: 'تحتاج إعادة ربط' })).getByRole('button', { name: 'أبقِها دون ربط' });
      expect((again as HTMLButtonElement).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole('list', { name: 'تحتاج إعادة ربط' })).getByRole('button', { name: 'أبقِها دون ربط' }));
    });
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]!.items).toEqual([{ kind: 'annotation', id: 'A1', rev: 5 }]);
  });
});
