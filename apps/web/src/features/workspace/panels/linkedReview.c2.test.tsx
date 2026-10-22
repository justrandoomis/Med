// Phase 1 completion C2 — X8 (c) / AOS-19H.3 on the web: on the OFFICIAL copy of a lecture, «إعادة ربط» lists what a
// linked private lecture could not place («من محاضرتك الخاصة «…»: تحتاج مراجعة»), copies it here through the same
// re-anchoring route (a copy across the two documents) or keeps it on the private lecture — named as the private
// lecture, never as «الإصدار 1» of the official one.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReanchorCopyActionRequest, ReanchorCopyPreview, SourcePageView, SourceVersionView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { api } from '../../../lib/api';
import { getDb } from '../../../lib/localdb';
import type { SourceDocument } from '../data/useSourceDocument';
import { LinkedReviews } from './NoteMigration';

vi.mock('../../../lib/sync', async (orig) => ({
  ...(await orig<typeof import('../../../lib/sync')>()),
  getSyncEngine: () => ({ syncNow: async () => undefined }),
}));

const pageRef = (id: string, i: number, label: string) => ({ page_id: id, page_index: i, label_ar: label, thumbnail: true });
const OFFICIAL = { id: 'OV1', version_no: 1 };
const PRIVATE = { id: 'PV1', version_no: 1 };

function base(over: Partial<ReanchorCopyPreview> = {}): ReanchorCopyPreview {
  return {
    state: 'none',
    reason_ar: 'لا توجد ملاحظات أو كتابة على إصدار سابق من هذا المصدر.',
    source_id: 'STUB',
    from_version: null,
    to_version: OFFICIAL,
    algo: null,
    map_computed_at: null,
    total: 0,
    copy: 0,
    already_moved: 0,
    needs_review: 0,
    kept: 0,
    will_copy: [],
    by_kind: {},
    review: [],
    kept_by_reason: [],
    kept_items: [],
    earlier: [],
    last_run: null,
    summary_ar: 'لا شيء لنقله.',
    linked: [{ source: { id: 'PRIV', title: 'محاضرة القلب (نسختي)' }, version: PRIVATE, to_version: OFFICIAL, items: 3, pending: 1 }],
    ...over,
  };
}

function linkedPreview(over: Partial<ReanchorCopyPreview> = {}): ReanchorCopyPreview {
  return base({
    state: 'ready',
    reason_ar: null,
    from_version: PRIVATE,
    algo: 'pm2',
    map_computed_at: 5,
    total: 3,
    already_moved: 2,
    needs_review: 1,
    linked_from: { source_id: 'PRIV', title: 'محاضرة القلب (نسختي)' },
    review: [
      {
        group_key: 'note:N6',
        kind: 'note',
        id: 'N6',
        rev: 1,
        item_kind: 'note',
        label_ar: 'ملاحظة',
        preview: 'ملخصي الخاص',
        from: pageRef('PP6', 5, 'الصفحة 6 في الملف'),
        suggested: pageRef('OP6', 5, 'الصفحة 6 في الملف'),
        reason: 'page_changed',
        reason_ar: 'تغيّر نص صفحتها في الإصدار الجديد؛ لا تُنسخ إليها دون قرارك.',
      },
    ],
    summary_ar: 'سيُنقل 0 · يحتاج مراجعة 1 · يبقى في محاضرتك الخاصة: 0',
    ...over,
  });
}

let linked: ReanchorCopyPreview;
let posts: Array<{ path: string; body: unknown }>;
beforeEach(async () => {
  linked = linkedPreview();
  posts = [];
  await getDb().open();
  await Promise.all([getDb().annotations.clear(), getDb().notes.clear()]);
  vi.spyOn(api, 'get').mockImplementation(async (path: string, opts?: { query?: Record<string, unknown> }) => {
    if (path !== '/annotations/reanchor-copy') throw new Error(`unexpected ${path}`);
    return opts?.query?.from_version_id === 'PV1' ? linked : base({ linked: [{ ...base().linked![0]!, pending: linked.review.length }] });
  });
  vi.spyOn(api, 'post').mockImplementation(async (path: string, body: unknown) => {
    posts.push({ path, body });
    const req = body as ReanchorCopyActionRequest;
    if (path === '/annotations/reanchor' && req.action === 'keep_on_previous') {
      linked = linkedPreview({ needs_review: 0, review: [], kept: 1, kept_items: [{ kind: 'note', id: 'N6', rev: 1, item_kind: 'note', label_ar: 'ملاحظة', preview: 'ملخصي الخاص', from: pageRef('PP6', 5, 'الصفحة 6 في الملف') }] });
      return { annotations: [], notes: [], summary_ar: 'الملاحظة تبقى في محاضرتك الخاصة كما هي، ولا تُنسخ إلى النسخة الرسمية (الإصدار 1).', report: null };
    }
    if (path === '/annotations/reanchor' && req.action === 'copy') {
      linked = linkedPreview({ needs_review: 0, review: [], already_moved: 3 });
      return { annotations: [], notes: [], summary_ar: 'نُسخت الملاحظة إلى «الصفحة 6 في الملف» في النسخة الرسمية (الإصدار 1). بقي الأصل في محاضرتك الخاصة كما هو.', report: { id: 'MAN9', kind: 'manual' } };
    }
    throw new Error(`unexpected ${path}`);
  });
});

const versions = [{ id: 'OV1', version_no: 1 }] as unknown as SourceVersionView[];
const page = (i: number, id: string): SourcePageView => ({ id, version_id: 'OV1', page_index: i, printed_label: null, kind: 'page' }) as unknown as SourcePageView;
const doc = { detail: { id: 'STUB', versions }, version: { id: 'OV1' }, pages: Array.from({ length: 6 }, (_, i) => page(i, i === 5 ? 'OP6' : `P${i}`)), mode: 'pdf', pdf: null, pdfError: null } as unknown as SourceDocument;

function renderIt() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <LinkedReviews doc={doc} online onGoToPage={() => undefined} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('the review list of a linked private lecture on the official copy (X8 c)', () => {
  it('names the private lecture, shows both pages, and copies the item across with one tap', async () => {
    renderIt();
    const list = await screen.findByRole('list', { name: 'تحتاج مراجعة من محاضرتك الخاصة «محاضرة القلب (نسختي)»' });
    expect(screen.getByRole('heading', { name: 'من محاضرتك الخاصة «محاضرة القلب (نسختي)»: تحتاج مراجعة (1)' })).toBeTruthy();
    const row = within(list).getByText('ملاحظة').closest('li')!;
    expect(row.textContent).toContain('مكانها في محاضرتك الخاصة «محاضرة القلب (نسختي)»: الصفحة 6 في الملف');
    expect(within(row).getByRole('img', { name: 'صورة الصفحة 6 في الملف من محاضرتك الخاصة' })).toBeTruthy();
    expect(within(row).getByRole('img', { name: 'صورة الصفحة 6 في الملف من الإصدار 1' })).toBeTruthy();
    // never «الإصدار 1» of this lecture, and no «compare versions» link across two different files
    expect(screen.queryByRole('link', { name: 'قارن الإصدارين صفحة بصفحة' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'انسخها إلى الصفحة 6 في الملف' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      path: '/annotations/reanchor',
      body: { action: 'copy', items: [{ kind: 'note', id: 'N6', rev: 1 }], to_version_id: 'OV1', target: { type: 'page', version_id: 'OV1', page_id: 'OP6' } },
    });
    expect(await screen.findByText(/بقي الأصل في محاضرتك الخاصة كما هو/)).toBeTruthy();
  });

  it('«اتركها في محاضرتك الخاصة» keeps it there; it can go back to review', async () => {
    renderIt();
    const list = await screen.findByRole('list', { name: 'تحتاج مراجعة من محاضرتك الخاصة «محاضرة القلب (نسختي)»' });
    fireEvent.click(within(list).getByRole('button', { name: 'اتركها في محاضرتك الخاصة' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ path: '/annotations/reanchor', body: { action: 'keep_on_previous', items: [{ kind: 'note', id: 'N6', rev: 1 }], to_version_id: 'OV1' } }));
    expect(await screen.findByText('بقيت في محاضرتك الخاصة باختيارك (1)')).toBeTruthy();
  });

  it('a source with no linked private lecture shows nothing', async () => {
    vi.mocked(api.get).mockImplementation(async () => base({ linked: [] }));
    renderIt();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole('list')).toBeNull();
  });
});
