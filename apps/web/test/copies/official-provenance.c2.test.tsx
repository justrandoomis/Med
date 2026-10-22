// Phase 1 completion, track C2 — where official content comes from, on the student's screens:
//   * AOS-2.2 / 4.5 / 19I.2: the subject's lecture list (in the server's order: number, then date) marks each published
//     lecture «رسمي» with who published it; a number read from the file says so;
//   * AOS-4.5 / 18.18 / 19I.2: the lecture page says «رسمي · <المادة>», the current version and its publisher, and every
//     published version its uploader, its publisher and the version it replaces;
//   * AOS-19I.5: a published explanation that contains machine-generated content (a saved AI answer, text read from
//     handwriting) says so on its page, with the count.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router-dom';
import type { ChannelNodeView, NoteDTO, OfficialLectureDetail, OfficialLectureView, PublicationView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { routes as lecturesRoutes } from '../../src/features/lectures/routes';
import { SubjectScreen } from '../../src/features/channels/SubjectScreen';

vi.mock('../../src/lib/capabilities', () => ({ useCapabilities: () => ({ feature: () => ({ available: false, reason: 'غير متاح' }) }) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const missing = () => json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
const SARA = { id: 'u_s', display_name: 'د. سارة', avatar_url: null };
const ALI = { id: 'u_a', display_name: 'علي (مساهم)', avatar_url: null };
const SUBJECT = { id: 'anat', kind: 'subject' as const, title: 'Anatomy' };

function serve(routes: Record<string, () => Response>) {
  setFetchImpl(async (url) => {
    const hit = routes[url.split('?')[0]!];
    return hit ? hit() : missing();
  });
}
function show(path: string, routes: RouteObject[]) {
  const router = createMemoryRouter([...routes, { path: '*', element: <p>صفحة أخرى</p> }], { initialEntries: [path] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  return router;
}
afterEach(() => setFetchImpl(null));

const listed = (id: string, no: number | null, title: string, o: Partial<OfficialLectureView> = {}): OfficialLectureView =>
  ({
    id,
    space_id: 'sp_anat',
    subject: SUBJECT,
    title,
    lecture_no: no,
    lecture_no_origin: 'moderator',
    held_on: '2026-10-14',
    status: 'published',
    head_version: { id: `v_${id}`, version_no: 1, page_count: 12, processing_status: 'ready', published_by: SARA, published_at: Date.UTC(2026, 9, 14) },
    uploaded_by: ALI,
    approved: null,
    counts: { explanations: 0 },
    updated_at: 1,
    ...o,
  }) as OfficialLectureView;

describe('AOS-2.2 / 4.5 / 19I.2 — the subject\'s lecture list on the student screen', () => {
  it('lists the lectures in the server\'s order, each «رسمي» with its publisher; a number read from the file says so', async () => {
    const node = { id: 'anat', kind: 'subject', title: 'Anatomy', parent_id: null, title_en: null, ordinal: null, starts_on: null, ends_on: null, has_space: true, space_id: 'sp_anat', join_policy: 'approval', status: 'active', viewer: { membership: { id: 'm1', node: SUBJECT, status: 'approved', join_method: 'class_code', created_at: 1, decided_at: null, reason_ar: null }, roles: [], inherited_from: null, course_follow: null } } as unknown as ChannelNodeView;
    serve({
      '/api/channels/nodes/anat': () => json({ ...node, path: [] }),
      '/api/spaces/sp_anat/lectures': () => json({ items: [listed('l21', 21, 'Cardiac cycle', { lecture_no_origin: 'detected' }), listed('l22', 22, 'Lungs'), listed('l23', 23, 'Renal')], next_cursor: null }),
      '/api/copies': () => json({ copies: [] }),
    });
    show('/subjects/anat', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    const panel = await screen.findByRole('tabpanel');
    const rows = await within(panel).findAllByRole('listitem');
    expect(rows.map((r) => within(r).getByRole('link').getAttribute('href'))).toEqual(['/subjects/sp_anat/lectures/l21', '/subjects/sp_anat/lectures/l22', '/subjects/sp_anat/lectures/l23']);
    for (const r of rows) {
      expect(within(r).getByText('رسمي')).toBeTruthy();
      expect(r.textContent).toContain('نشرها د. سارة');
    }
    expect(rows[0]!.textContent).toContain('المحاضرة 21 (مقروء من الملف)');
    expect(rows[1]!.textContent).not.toContain('مقروء من الملف');
  });
});

function detail(over: Partial<OfficialLectureDetail> = {}): OfficialLectureDetail {
  return {
    ...listed('L1', 4, 'Renal anatomy'),
    space_id: 'SPA',
    head_version: { id: 'V2', version_no: 2, page_count: 40, processing_status: 'ready', published_by: SARA, published_at: Date.UTC(2026, 9, 2) },
    versions: [
      { id: 'V2', version_no: 2, kind: 'upload', status: 'published', file_name: 'b.pdf', page_count: 40, processing_status: 'ready', published_at: Date.UTC(2026, 9, 2), published_by: SARA, change_note: 'تصحيح الشكل 3', previous_version_id: 'V1', page_map_status: 'ready', uploaded_by: ALI },
      { id: 'V1', version_no: 1, kind: 'upload', status: 'superseded', file_name: 'a.pdf', page_count: 40, processing_status: 'ready', published_at: Date.UTC(2026, 9, 1), published_by: SARA, change_note: null, previous_version_id: null, page_map_status: null, uploaded_by: SARA },
    ],
    withdrawn: null,
    ...over,
  } as OfficialLectureDetail;
}

describe('AOS-4.5 / 18.18 / 19I.2 — the lecture page says it is official, who published it, and where each version comes from', () => {
  it('«رسمي · المادة», the publisher of the current version, and each version\'s uploader, publisher and predecessor', async () => {
    serve({ '/api/spaces/SPA/lectures/L1': () => json(detail()), '/api/copies': () => json({ copies: [] }) });
    show('/subjects/SPA/lectures/L1', lecturesRoutes.shell!);
    expect(await screen.findByRole('heading', { level: 1, name: 'Renal anatomy' })).toBeTruthy();
    expect(screen.getByText('رسمي · Anatomy')).toBeTruthy();
    expect(screen.getByText('نشر الإصدار 2: د. سارة')).toBeTruthy();
    const versions = within(screen.getByRole('list', { name: 'الإصدارات المنشورة' })).getAllByRole('listitem');
    expect(versions[0]!.textContent).toContain('رفعه علي (مساهم)');
    expect(versions[0]!.textContent).toContain('نشره د. سارة');
    expect(versions[0]!.textContent).toContain('يحلّ محل الإصدار 1');
    expect(versions[1]!.textContent).toContain('رفعه د. سارة');
    expect(versions[1]!.textContent).not.toContain('يحلّ محل');
  });

  it('a version without a recorded publisher (older data) says nothing false', async () => {
    serve({
      '/api/spaces/SPA/lectures/L1': () => json(detail({ head_version: { id: 'V2', version_no: 2, page_count: 40, processing_status: 'ready' } })),
      '/api/copies': () => json({ copies: [] }),
    });
    show('/subjects/SPA/lectures/L1', lecturesRoutes.shell!);
    expect(await screen.findByText('رسمي · Anatomy')).toBeTruthy();
    expect(screen.queryByText(/نشر الإصدار 2:/)).toBeNull();
  });
});

describe('AOS-19I.5 — published content with machine-generated parts says so', () => {
  const pub: PublicationView = {
    id: 'PUB1',
    space_id: 'SPA',
    lecture: { id: 'L1', title: 'Renal anatomy' },
    subject: SUBJECT,
    author: { id: 'u_h', display_name: 'حسن', avatar_url: null },
    kind: 'explanation',
    title: 'شرح حسن',
    summary: null,
    visibility: 'course',
    status: 'active',
    hidden: null,
    head_version_no: 1,
    versions: [{ no: 1, created_at: 1, change_note: null, lecture_version_id: 'V1', lecture_version_no: 1, item_count: 3 }],
    completeness: { pages_covered: 1, pages_total: 40 },
    origin_label_ar: 'شرح طالب — ليس مصدرًا',
    viewer: { copy: null, can_edit: false, source_layer_ids: null, can_report: true },
    snapshot: null,
    published_at: 1,
    updated_at: 1,
  } as PublicationView;
  const note = (id: string, origin: NoteDTO['origin']): NoteDTO =>
    ({ id, node_id: null, title: null, body: { v: 1, paragraphs: [] }, anchor: null, origin, ai_record: null, rev: 1, conflict_of_id: null, device_id: null, created_at: 1, updated_at: 1, deleted_at: null }) as NoteDTO;

  it('two saved AI answers and one handwriting reading are counted and labelled; none → no label', async () => {
    serve({
      '/api/spaces/SPA/publications/PUB1': () => json(pub),
      '/api/copies': () => json({ copies: [] }),
      '/api/spaces/SPA/publications/PUB1/versions/1/items': () =>
        json({ publication_id: 'PUB1', version_no: 1, items: [], notes: [note('n1', 'ai_answer'), note('n2', 'ai_answer'), note('n3', 'handwriting_recognition'), note('n4', 'owner')], note_pages: [], redacted: false }),
    });
    show('/subjects/SPA/publications/PUB1', lecturesRoutes.shell!);
    const label = await screen.findByText(/فيه محتوى مولَّد آليًا/);
    expect(label.textContent).toContain('إجابتان مولَّدتان محفوظتان كملاحظات');
    expect(label.textContent).toContain('نص واحد مقروء آليًا من خط اليد');
    expect(label.textContent).toContain('ليست مصدرًا');
  });

  it('an explanation written by hand only carries no machine label', async () => {
    serve({
      '/api/spaces/SPA/publications/PUB1': () => json(pub),
      '/api/copies': () => json({ copies: [] }),
      '/api/spaces/SPA/publications/PUB1/versions/1/items': () => json({ publication_id: 'PUB1', version_no: 1, items: [], notes: [note('n4', 'owner')], note_pages: [], redacted: false }),
    });
    show('/subjects/SPA/publications/PUB1', lecturesRoutes.shell!);
    expect(await screen.findByRole('heading', { level: 1, name: 'شرح حسن' })).toBeTruthy();
    // give the items request its turn
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/مولَّد آليًا/)).toBeNull();
  });
});
