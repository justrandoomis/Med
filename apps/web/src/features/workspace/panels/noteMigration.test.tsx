// P1-T2 step 3 — «انقل ملاحظاتي إلى الإصدار الجديد» on the web: the preview changes nothing until the ONE tap; the tap
// sends the map the owner saw; the report shows moved / needs review / kept with a one-step undo; the review list copies
// through Round 7's re-anchoring route (`action: 'copy'`), keeps on the earlier version, or puts a kept item back.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteDTO, ReanchorCopyActionRequest, ReanchorCopyPreview, ReanchorCopyReport, SourcePageView, SourceVersionView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { api, ApiError } from '../../../lib/api';
import { getDb } from '../../../lib/localdb';
import type { SourceDocument } from '../data/useSourceDocument';
import { NoteMigrationBanner, VersionReview } from './NoteMigration';
import { hasPendingMigration, newestVersion, versionReviewGroups, willCopyRows } from './noteMigration';

// the order of this device's sync calls and the API posts (review: unsent writing goes before the tap)
const order = vi.hoisted(() => [] as string[]);
vi.mock('../../../lib/sync', async (orig) => ({
  ...(await orig<typeof import('../../../lib/sync')>()),
  getSyncEngine: () => ({
    syncNow: async (o?: { pull?: boolean }) => {
      order.push(o?.pull ? 'sync:pull' : 'sync:push');
    },
  }),
}));

const pageRef = (id: string, i: number, label: string) => ({ page_id: id, page_index: i, label_ar: label, thumbnail: true });
const V1 = { id: 'V1', version_no: 1 };
const V2 = { id: 'V2', version_no: 2 };
const versions = [
  { id: 'V1', version_no: 1 },
  { id: 'V2', version_no: 2 },
] as unknown as SourceVersionView[];

function makePreview(over: Partial<ReanchorCopyPreview> = {}): ReanchorCopyPreview {
  return {
    state: 'ready',
    reason_ar: null,
    source_id: 'S1',
    from_version: V1,
    to_version: V2,
    algo: 'pm2',
    map_computed_at: 777,
    total: 3,
    copy: 2,
    already_moved: 0,
    needs_review: 1,
    kept: 0,
    will_copy: [
      { page: pageRef('N5', 4, 'ص 5'), from_page_index: 4, from: pageRef('O5', 4, 'ص 5'), items: 1 },
      { page: pageRef('N14', 13, 'ص 14'), from_page_index: 11, from: pageRef('O12', 11, 'ص 12'), items: 1 },
    ],
    by_kind: { ink: 1, text_highlight: 1 },
    review: [
      {
        group_key: 'note:NOTE30',
        kind: 'note',
        id: 'NOTE30',
        rev: 1,
        item_kind: 'note',
        label_ar: 'ملاحظة',
        preview: 'ملاحظتي على الصفحة 30',
        from: pageRef('O30', 29, 'الصفحة 30 في الملف'),
        suggested: pageRef('N32', 31, 'الصفحة 32 في الملف'),
        reason: 'page_changed',
        reason_ar: 'تغيّر نص صفحتها في الإصدار الجديد؛ لا تُنسخ إليها دون قرارك.',
      },
    ],
    kept_by_reason: [],
    kept_items: [],
    earlier: [{ version: V1, items: 3, pending: 3 }],
    last_run: null,
    summary_ar: 'سيُنقل 2 · يحتاج مراجعة 1 · يبقى على الإصدار 1: 0',
    ...over,
  };
}
const REPORT: ReanchorCopyReport = {
  id: 'RUN1',
  source_id: 'S1',
  kind: 'run',
  from_version: V1,
  to_version: V2,
  total: 3,
  copied: 2,
  already_moved: 0,
  needs_review: 1,
  kept: 0,
  pages: 2,
  by_page: [],
  summary_ar: 'نُقل عنصران إلى صفحتين؛ عنصر واحد يحتاج مراجعتك؛ لا شيء بقي على الإصدار السابق',
  created_at: 1,
  undone_at: null,
  undo: null,
};

let current: ReanchorCopyPreview;
let posts: Array<{ path: string; body: unknown }>;
beforeEach(async () => {
  current = makePreview();
  posts = [];
  order.length = 0;
  await getDb().open();
  await Promise.all([getDb().annotations.clear(), getDb().notes.clear()]);
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/annotations/reanchor-copy') return current;
    throw new Error(`unexpected ${path}`);
  });
  vi.spyOn(api, 'post').mockImplementation(async (path: string, body: unknown) => {
    posts.push({ path, body });
    order.push(`post:${path}`);
    if (path === '/annotations/reanchor-copy') {
      current = makePreview({ copy: 0, already_moved: 2, will_copy: [], last_run: REPORT, summary_ar: 'سيُنقل 0 · يحتاج مراجعة 1 · يبقى على الإصدار 1: 0 · نُقل سابقًا: 2' });
      return { report: REPORT };
    }
    if (path === '/annotations/reanchor-copy/undo') {
      current = makePreview();
      return { report: { ...REPORT, undone_at: 9, undo: { tombstoned: 2, kept_edited: 0 } } };
    }
    if (path === '/annotations/reanchor') {
      const req = body as ReanchorCopyActionRequest;
      if (req.action === 'copy') {
        const n: NoteDTO = { id: 'rc_copy', node_id: null, title: null, body: { v: 1, paragraphs: [] }, anchor: { type: 'page', source_id: 'S1', version_id: 'V2', page_id: 'N32', page_index: 31, space: 'page_norm' }, origin: 'owner', ai_record: null, rev: 1, conflict_of_id: null, device_id: 'server', created_at: 1, updated_at: 1, deleted_at: null, migrated_from_id: 'NOTE30' };
        current = makePreview({ needs_review: 0, review: [], already_moved: 1 });
        return { annotations: [], notes: [n], summary_ar: 'نُسخت الملاحظة إلى «الصفحة 32 في الملف» في الإصدار 2.', report: { ...REPORT, id: 'MAN1', kind: 'manual', copied: 1 } };
      }
      if (req.action === 'keep_on_previous') {
        current = makePreview({ needs_review: 0, review: [], kept: 1, kept_items: [{ kind: 'note', id: 'NOTE30', rev: 1, item_kind: 'note', label_ar: 'ملاحظة', preview: 'ملاحظتي على الصفحة 30', from: pageRef('O30', 29, 'الصفحة 30 في الملف') }] });
        return { annotations: [], notes: [], summary_ar: 'الملاحظة تبقى على الإصدار 1 كما هي.', report: null };
      }
      current = makePreview();
      return { annotations: [], notes: [], summary_ar: 'أُعيدت الملاحظة إلى قائمة «تحتاج مراجعة».', report: null };
    }
    throw new Error(`unexpected ${path}`);
  });
});

describe('the model', () => {
  it('offers the migration only when something waits; the newest version is the target', () => {
    expect(newestVersion([{ id: 'A', version_no: 1 }])).toBeNull();
    expect(newestVersion([{ id: 'B', version_no: 3 }, { id: 'A', version_no: 1 }, { id: 'C', version_no: 2 }])).toEqual({ id: 'B', version_no: 3 });
    expect(hasPendingMigration(makePreview())).toBe(true);
    expect(hasPendingMigration(makePreview({ copy: 0, needs_review: 0, already_moved: 3 }))).toBe(false);
    expect(hasPendingMigration(makePreview({ state: 'none', from_version: null }))).toBe(false);
    expect(hasPendingMigration(makePreview({ state: 'pending', copy: 0, needs_review: 0, total: 3 }))).toBe(true);
    expect(willCopyRows(makePreview())).toEqual({
      rows: [
        { key: 'N5', from: 'ص 5', to: 'ص 5', items: 'عنصر واحد' },
        { key: 'N14', from: 'ص 12', to: 'ص 14', items: 'عنصر واحد' },
      ],
      more: 0,
    });
  });

  it('pen items of one old page are one review group (copied together)', () => {
    const base = makePreview().review[0]!;
    const ink = (id: string) => ({ ...base, group_key: 'ink:O30:page_changed', kind: 'annotation' as const, id, item_kind: 'ink', label_ar: 'كتابة بالقلم', preview: null });
    const groups = versionReviewGroups([ink('A'), ink('B'), base], 1);
    expect(groups.map((g) => [g.kind, g.label, g.items.map((i) => i.id)])).toEqual([
      ['ink', 'كتابة بالقلم (عنصران)', ['A', 'B']],
      ['note', 'ملاحظة', ['NOTE30']],
    ]);
    expect(groups[1]!.where).toBe('الصفحة 30 في الملف — الإصدار 1');
  });
});

function banner(props: Partial<Parameters<typeof NoteMigrationBanner>[0]> = {}) {
  const onOpenReview = vi.fn();
  const onOpenVersion = vi.fn();
  render(
    <MemoryRouter>
      <ToastProvider>
        <NoteMigrationBanner sourceId="S1" versions={versions} currentVersionId="V2" online onOpenReview={onOpenReview} onOpenVersion={onOpenVersion} {...props} />
      </ToastProvider>
    </MemoryRouter>,
  );
  return { onOpenReview, onOpenVersion };
}

describe('the reader banner: preview → one tap → report → undo', () => {
  it('nothing is posted until the tap; the tap sends the map that was previewed; the report and its undo follow', async () => {
    const { onOpenReview } = banner();
    const bar = await screen.findByText(/يوجد إصدار أحدث من المحاضرة/);
    expect(bar.textContent).toContain('سيُنقل 2 · يحتاج مراجعة 1 · يبقى على الإصدار 1: 0');
    fireEvent.click(screen.getByRole('button', { name: 'معاينة النقل…' }));
    const dialog = await screen.findByRole('dialog', { name: 'انقل ملاحظاتي إلى الإصدار 2' });
    expect(within(dialog).getByText(/نسخ، لا نقل/)).toBeTruthy();
    expect(within(dialog).getByRole('list', { name: 'الصفحات التي تُنسخ إليها' }).textContent).toContain('ص 14 في الإصدار 2');
    expect(posts).toEqual([]); // the preview changed nothing

    fireEvent.click(within(dialog).getByRole('button', { name: 'انقل ملاحظاتي إلى الإصدار 2' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['/annotations/reanchor-copy']));
    expect(posts[0]!.body).toEqual({ source_id: 'S1', from_version_id: 'V1', to_version_id: 'V2', map_computed_at: 777 });
    const report = await screen.findByRole('dialog', { name: 'تقرير نقل الملاحظات' });
    await waitFor(() => expect(within(report).getAllByText(/نُقل عنصران إلى صفحتين؛ عنصر واحد يحتاج مراجعتك/).length).toBeGreaterThan(0));
    expect(within(report).getByText(/قبل النقل: 3 = نُقل 2 \+ تحتاج مراجعة 1 \+ بقي 0/)).toBeTruthy();

    // one-step undo
    fireEvent.click(within(report).getByRole('button', { name: 'تراجع عن النقل' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain('/annotations/reanchor-copy/undo'));
    expect(posts.at(-1)!.body).toEqual({ run_id: 'RUN1' });
    await waitFor(() => expect(within(report).getByText(/تراجعت عن هذا النقل: حُذفت 2 من النسخ/)).toBeTruthy());

    // «راجع العناصر» opens the review list
    fireEvent.click(within(report).getByRole('button', { name: /راجع العناصر/ }));
    expect(onOpenReview).toHaveBeenCalled();
  });

  it('offline from the start: nothing is fetched (nothing known to show) and nothing is posted', async () => {
    banner({ online: false });
    await act(async () => undefined);
    expect(screen.queryByText(/يوجد إصدار أحدث/)).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

  it('(review) going offline keeps the banner: the button is disabled and the reason is shown, nothing is posted', async () => {
    const props = { sourceId: 'S1', versions, currentVersionId: 'V2', onOpenReview: vi.fn(), onOpenVersion: vi.fn() };
    const view = (online: boolean) => (
      <MemoryRouter>
        <ToastProvider>
          <NoteMigrationBanner {...props} online={online} />
        </ToastProvider>
      </MemoryRouter>
    );
    const { rerender } = render(view(true));
    await screen.findByText(/يوجد إصدار أحدث من المحاضرة/);
    rerender(view(false));
    expect(screen.getByText(/يوجد إصدار أحدث من المحاضرة/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'معاينة النقل…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/يحتاج اتصالًا/)).toBeTruthy();
    expect(posts).toEqual([]);
  });

  it('(review) the tap sends this device’s unsent writing first, so it is part of what is copied', async () => {
    banner();
    await screen.findByText(/يوجد إصدار أحدث من المحاضرة/);
    fireEvent.click(screen.getByRole('button', { name: 'معاينة النقل…' }));
    const dialog = await screen.findByRole('dialog', { name: 'انقل ملاحظاتي إلى الإصدار 2' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'انقل ملاحظاتي إلى الإصدار 2' }));
    await waitFor(() => expect(order).toContain('post:/annotations/reanchor-copy'));
    const tap = order.indexOf('post:/annotations/reanchor-copy');
    expect(order.slice(0, tap)).toContain('sync:push');
  });

  it('(review) a tap that copied nothing new (another device was first) still offers the undo of the last run', async () => {
    current = makePreview({ copy: 2, last_run: REPORT });
    const post = vi.mocked(api.post).getMockImplementation()!;
    vi.mocked(api.post).mockImplementation(async (path: string, body: unknown, ...rest: unknown[]) => {
      if (path === '/annotations/reanchor-copy') {
        posts.push({ path, body });
        current = makePreview({ copy: 0, already_moved: 2, will_copy: [], last_run: REPORT });
        return { report: { ...REPORT, id: null, copied: 0, already_moved: 2, pages: 0, summary_ar: 'لم يُنقل شيء جديد (عنصران نُقل من قبل)؛ عنصر واحد يحتاج مراجعتك؛ لا شيء بقي على الإصدار السابق' } };
      }
      return (post as (p: string, b: unknown, ...r: unknown[]) => Promise<unknown>)(path, body, ...rest);
    });
    banner();
    await screen.findByText(/يوجد إصدار أحدث من المحاضرة/);
    fireEvent.click(screen.getByRole('button', { name: 'معاينة النقل…' }));
    const dialog = await screen.findByRole('dialog', { name: 'انقل ملاحظاتي إلى الإصدار 2' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'انقل ملاحظاتي إلى الإصدار 2' }));
    const report = await screen.findByRole('dialog', { name: 'تقرير نقل الملاحظات' });
    await waitFor(() => expect(within(report).getAllByText(/لم يُنقل شيء جديد/).length).toBeGreaterThan(0));
    fireEvent.click(within(report).getByRole('button', { name: 'تراجع عن النقل' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ path: '/annotations/reanchor-copy/undo', body: { run_id: 'RUN1' } }));
  });

  it('(review) while the page analysis runs the banner says so and looks again by itself until the preview is ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      current = makePreview({ state: 'pending', reason_ar: 'يجري تحليل صفحات الإصدارين.', copy: 0, needs_review: 0, will_copy: [], review: [], algo: null, map_computed_at: null });
      banner();
      await screen.findByText(/يجري تحليل صفحات الإصدارين/);
      current = makePreview();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(await screen.findByText(/سيُنقل 2 · يحتاج مراجعة 1/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('on an earlier version it says so and opens the newest one', async () => {
    const { onOpenVersion } = banner({ currentVersionId: 'V1' });
    const bar = await screen.findByText(/تقرأ الإصدار 1/);
    expect(bar.textContent).toContain('يوجد الإصدار 2');
    fireEvent.click(screen.getByRole('button', { name: 'افتح الإصدار 2' }));
    expect(onOpenVersion).toHaveBeenCalledWith('V2');
  });

  it('a single-version lecture shows nothing and asks nothing', async () => {
    banner({ versions: [versions[0]!] });
    await act(async () => undefined);
    expect(api.get).not.toHaveBeenCalled();
  });
});

const page = (i: number, id: string): SourcePageView => ({ id, version_id: 'V2', page_index: i, printed_label: null, kind: 'page' }) as unknown as SourcePageView;
const doc = { detail: { id: 'S1', versions }, version: { id: 'V2' }, pages: Array.from({ length: 42 }, (_, i) => page(i, i === 31 ? 'N32' : `P${i}`)), mode: 'pdf', pdf: null, pdfError: null } as unknown as SourceDocument;

function review() {
  const onGoToPage = vi.fn();
  render(
    <MemoryRouter>
      <ToastProvider>
        <VersionReview doc={doc} online onGoToPage={onGoToPage} />
      </ToastProvider>
    </MemoryRouter>,
  );
  return { onGoToPage };
}

describe('the review list of an earlier version (Round 7 re-anchoring, as a copy)', () => {
  it('lists the item with its old place and the candidate side by side; one tap copies it to the candidate', async () => {
    review();
    const list = await screen.findByRole('list', { name: 'تحتاج مراجعة من الإصدار 1' });
    const row = within(list).getByText('ملاحظة').closest('li')!;
    expect(row.textContent).toContain('مكانها في الإصدار 1: الصفحة 30 في الملف');
    expect(within(row).getByRole('img', { name: 'صورة الصفحة 30 في الملف من الإصدار 1' })).toBeTruthy();
    expect(within(row).getByRole('img', { name: 'صورة الصفحة 32 في الملف من الإصدار 2' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'قارن الإصدارين صفحة بصفحة' }).getAttribute('href')).toBe('/sources/S1/compare?from=V1&to=V2');
    fireEvent.click(within(row).getByRole('button', { name: 'انسخها إلى الصفحة 32 في الملف' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      path: '/annotations/reanchor',
      body: { action: 'copy', items: [{ kind: 'note', id: 'NOTE30', rev: 1 }], to_version_id: 'V2', target: { type: 'page', version_id: 'V2', page_id: 'N32' } },
    });
    // the copy is on this device at once; the original was never sent anywhere to be changed
    await waitFor(async () => expect(await getDb().notes.get('rc_copy')).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole('list', { name: 'تحتاج مراجعة من الإصدار 1' })).toBeNull());
  });

  it('the copy toast’s «تراجع» undoes that copy only; a refused undo says why (never a silent failure)', async () => {
    review();
    const list = await screen.findByRole('list', { name: 'تحتاج مراجعة من الإصدار 1' });
    fireEvent.click(within(list).getByRole('button', { name: 'انسخها إلى الصفحة 32 في الملف' }));
    fireEvent.click(await screen.findByRole('button', { name: 'تراجع' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ path: '/annotations/reanchor-copy/undo', body: { run_id: 'MAN1' } }));
    expect(await screen.findByText('حُذفت النسخة؛ الأصل باقٍ على الإصدار السابق.')).toBeTruthy();

    // a second copy whose undo the server refuses (another device changed it, or the connection dropped)
    const list2 = await screen.findByRole('list', { name: 'تحتاج مراجعة من الإصدار 1' });
    const post = vi.mocked(api.post).getMockImplementation()!;
    vi.mocked(api.post).mockImplementation(async (path: string, body: unknown, ...rest: unknown[]) => {
      if (path === '/annotations/reanchor-copy/undo') throw new ApiError({ code: 'CONFLICT', message: 'تعذّر التراجع الآن؛ حاول مرة أخرى.', status: 409 });
      return (post as (p: string, b: unknown, ...r: unknown[]) => Promise<unknown>)(path, body, ...rest);
    });
    fireEvent.click(within(list2).getByRole('button', { name: 'انسخها إلى الصفحة 32 في الملف' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'تراجع' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'تراجع' }).at(-1)!);
    expect(await screen.findByText('لم يُنفَّذ التراجع')).toBeTruthy();
    expect(screen.getByText('تعذّر التراجع الآن؛ حاول مرة أخرى.')).toBeTruthy();
  });

  it('«اختر مكانها…» reuses the place dialog, worded as a copy', async () => {
    review();
    const list = await screen.findByRole('list', { name: 'تحتاج مراجعة من الإصدار 1' });
    fireEvent.click(within(list).getByRole('button', { name: 'اختر مكانها…' }));
    const dialog = await screen.findByRole('dialog', { name: 'أين تنسخ الملاحظة في الإصدار 2؟' });
    expect(within(dialog).getByText(/يبقى الأصل على الإصدار 1 كما هو/)).toBeTruthy();
    // the candidate page is preselected
    expect((within(dialog).getByLabelText('الصفحة', { exact: true }) as HTMLSelectElement).value).toBe('31');
    fireEvent.click(within(dialog).getByRole('button', { name: 'انسخها هنا' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ action: 'copy', to_version_id: 'V2', target: { type: 'page', version_id: 'V2', page_id: 'N32', region_id: null } });
  });

  it('«اتركها على الإصدار 1» keeps it (listed apart) and «أعدها إلى المراجعة» puts it back', async () => {
    review();
    const list = await screen.findByRole('list', { name: 'تحتاج مراجعة من الإصدار 1' });
    fireEvent.click(within(list).getByRole('button', { name: 'اتركها على الإصدار 1' }));
    await waitFor(() => expect(posts[0]!.body).toEqual({ action: 'keep_on_previous', items: [{ kind: 'note', id: 'NOTE30', rev: 1 }], to_version_id: 'V2' }));
    const kept = await screen.findByText('بقيت على الإصدار 1 باختيارك (1)');
    fireEvent.click(kept);
    fireEvent.click(await screen.findByRole('button', { name: 'أعدها إلى المراجعة' }));
    await waitFor(() => expect(posts[1]!.body).toEqual({ action: 'review_again', items: [{ kind: 'note', id: 'NOTE30', rev: 1 }], to_version_id: 'V2' }));
    expect(await screen.findByRole('list', { name: 'تحتاج مراجعة من الإصدار 1' })).toBeTruthy();
  });
});
