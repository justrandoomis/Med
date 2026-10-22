// P1-T4 step 3 — «القنوات» (IA §4.1), browsing the tree, and the subject page (IA §4.2) with the tabs «المحاضرات»,
// «الملفات», «التحديثات» reading P1-T5's API (honest empty / loading states), «تابع المادة», and the offline copy of a
// channel screen (AOS-20.17).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ChannelKind, ChannelNodeDetail, ChannelNodeView, ChannelRole, MembershipStatus, OfficialLectureView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { ApiError, setFetchImpl } from '../../src/lib/api';
import { setStorageAccount } from '../../src/lib/userStorage';
import { ChannelsHome } from '../../src/features/channels/ChannelsHome';
import { BrowseScreen } from '../../src/features/channels/BrowseScreen';
import { SubjectScreen } from '../../src/features/channels/SubjectScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const missing = () => json({ error: { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' } }, 404);

function n(id: string, kind: ChannelKind, title: string, parent: string | null, o: { space?: string; roles?: ChannelRole[]; m?: [string, MembershipStatus]; follow?: boolean } = {}): ChannelNodeView {
  return {
    id,
    kind,
    title,
    parent_id: parent,
    title_en: null,
    ordinal: null,
    starts_on: null,
    ends_on: null,
    has_space: kind === 'subject',
    space_id: o.space ?? null,
    join_policy: 'approval',
    status: 'active',
    viewer: {
      membership: o.m ? { id: `m_${o.m[0]}`, node: { id: o.m[0], kind: 'subject', title: o.m[0] }, status: o.m[1], join_method: 'class_code', created_at: 1, decided_at: null, reason_ar: null } : null,
      roles: o.roles ?? [],
      inherited_from: null,
      course_follow: o.follow ? { subject: { id, kind, title }, add_new_lectures: true, library_folder_id: null, created_at: 1 } : null,
    },
  } as ChannelNodeView;
}

let calls: Array<{ method: string; url: string; body: unknown }> = [];
let offline = false;
function serve(routes: Record<string, (method: string, body: unknown) => Response>) {
  calls = [];
  setFetchImpl(async (url, init) => {
    const method = init?.method ?? 'GET';
    if (offline) throw new TypeError('Failed to fetch');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.split('?')[0]!;
    const hit = routes[path];
    return hit ? hit(method, body) : missing();
  });
}

function show(path: string, routes: Array<{ path: string; element: React.ReactElement }>) {
  const router = createMemoryRouter([...routes, { path: '*', element: <p>صفحة أخرى</p> }], { initialEntries: [path] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  return router;
}

afterEach(() => {
  setFetchImpl(null);
  offline = false;
  setStorageAccount(null);
});

const UNI = n('u1', 'university', 'جامعة بغداد', null);
const STAGE = n('s3', 'stage', 'المرحلة الثالثة', 'u1');
const ANAT = n('anat', 'subject', 'Anatomy', 's3', { space: 'sp_anat', m: ['s3', 'approved'], follow: true });
const PHYS = n('phys', 'subject', 'Physiology', 's3', { space: 'sp_phys', m: ['s3', 'approved'], roles: ['subject_moderator'] });
const BIO = n('bio', 'subject', 'Biochemistry', 's3', { m: ['bio', 'pending'] });

describe('«القنوات» home', () => {
  it('a user with no channel sees the empty state, the join action, and that the personal library works without channels', async () => {
    serve({
      '/api/channels/tree': () => json({ nodes: [UNI, STAGE, n('x', 'subject', 'Surgery', 's3')], truncated: false }),
      '/api/channels/invitations': () => json({ invitations: [] }),
      '/api/notifications': () => json({ items: [], next_cursor: null, unread_count: 0 }),
    });
    show('/channels', [{ path: '/channels', element: <ChannelsHome /> }]);
    expect(await screen.findByText('لم تنضم إلى أي مادة بعد')).toBeTruthy();
    expect(screen.getByText('مكتبتك الشخصية تعمل كما هي دون قنوات.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'انضم برمز أو QR' }).length).toBeGreaterThan(0);
    // browse starts from the universities
    expect(screen.getByRole('link', { name: /جامعة بغداد/ }).getAttribute('href')).toBe('/channels/u1');
  });

  it('lists my subjects grouped by place, my role when not a student, «تتابعها», unread updates as text, and my pending requests', async () => {
    serve({
      '/api/channels/tree': () => json({ nodes: [UNI, STAGE, ANAT, PHYS, BIO], truncated: false }),
      '/api/channels/invitations': () => json({ invitations: [] }),
      '/api/notifications': () =>
        json({
          items: [
            { id: 'a', kind: 'official_lecture_new', payload: {}, actor: null, target: null, text_ar: 'x', link: '/subjects/anat', created_at: 1, read_at: null },
            { id: 'b', kind: 'official_version', payload: {}, actor: null, target: null, text_ar: 'y', link: '/subjects/anat', created_at: 1, read_at: null },
          ],
          next_cursor: null,
          unread_count: 2,
        }),
    });
    show('/channels', [{ path: '/channels', element: <ChannelsHome /> }]);
    const mine = await screen.findByRole('region', { name: 'قنواتي' });
    expect(within(mine).getByRole('heading', { name: 'جامعة بغداد › المرحلة الثالثة' })).toBeTruthy();
    const anat = within(mine).getByRole('link', { name: /Anatomy/ });
    expect(anat.getAttribute('href')).toBe('/subjects/anat');
    expect(within(anat).getByText('تتابعها')).toBeTruthy();
    expect(within(anat).getByText('تحديثان غير مقروءين')).toBeTruthy();
    expect(within(within(mine).getByRole('link', { name: /Physiology/ })).getByText('مشرف المادة')).toBeTruthy();
    const pending = screen.getByRole('region', { name: 'طلبات معلّقة' });
    expect(within(pending).getByText('Biochemistry')).toBeTruthy();
    expect(within(pending).getByText('طلبك قيد المراجعة')).toBeTruthy();
  });

  it('accepts an invitation addressed to me', async () => {
    serve({
      '/api/channels/tree': () => json({ nodes: [UNI], truncated: false }),
      '/api/channels/invitations': () =>
        json({
          invitations: [
            { id: 'i1', node: { id: 'anat', kind: 'subject', title: 'Anatomy' }, invitee: { id: 'me', display_name: 'أنا', avatar_url: null }, invited_by: { id: 'a', display_name: 'د. علي', avatar_url: null }, status: 'pending', expires_at: Date.now() + 1e9, created_at: 1, decided_at: null },
          ],
        }),
      '/api/channels/invitations/i1/decision': () =>
        json({ invitation: {}, membership: { id: 'm', node: { id: 'anat', kind: 'subject', title: 'Anatomy' }, status: 'approved', join_method: 'invitation', created_at: 1, decided_at: 1, reason_ar: null }, message_ar: 'انضممت إلى Anatomy.' }),
      '/api/notifications': () => json({ items: [], next_cursor: null, unread_count: 0 }),
    });
    show('/channels', [{ path: '/channels', element: <ChannelsHome /> }]);
    const inv = await screen.findByRole('region', { name: 'دعوات' });
    expect(within(inv).getByText(/د\. علي/)).toBeTruthy();
    fireEvent.click(within(inv).getByRole('button', { name: 'اقبل الدعوة' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/channels/invitations/i1/decision')?.body).toEqual({ accept: true }));
  });

  it('offline: shows the copy saved on this device, read-only, with the reason on the join action', async () => {
    setStorageAccount({ userId: 'u_cache', legacy: false });
    serve({
      '/api/channels/tree': () => json({ nodes: [UNI, STAGE, ANAT], truncated: false }),
      '/api/channels/invitations': () => json({ invitations: [] }),
      '/api/notifications': () => json({ items: [], next_cursor: null, unread_count: 0 }),
    });
    show('/channels', [{ path: '/channels', element: <ChannelsHome /> }]);
    await screen.findByRole('link', { name: /Anatomy/ });
    cleanup();
    offline = true;
    show('/channels', [{ path: '/channels', element: <ChannelsHome /> }]);
    expect(await screen.findByText(/تعرض نسخة محفوظة على هذا الجهاز/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Anatomy/ })).toBeTruthy();
    const join = screen.getAllByRole('button', { name: 'انضم برمز أو QR' })[0]!;
    expect((join as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById(join.getAttribute('aria-describedby')!)?.textContent).toMatch(/يحتاج اتصالًا/);
    expect(new ApiError({ code: 'OFFLINE', message: 'x', status: 0, offline: true }).offline).toBe(true);
  });
});

describe('browsing the tree', () => {
  it('shows a node’s place, its children, which subjects the viewer may enter, and «يتطلب رمز انضمام» for the others', async () => {
    const detail: ChannelNodeDetail = { ...STAGE, path: [{ id: 'u1', kind: 'university', title: 'جامعة بغداد' }] };
    serve({
      '/api/channels/nodes/s3': () => json(detail),
      '/api/channels/tree': () => json({ nodes: [STAGE, ANAT, n('surg', 'subject', 'Surgery', 's3')], truncated: false }),
    });
    show('/channels/s3', [{ path: '/channels/:nodeId', element: <BrowseScreen /> }]);
    await screen.findByRole('heading', { level: 1, name: 'المرحلة الثالثة' });
    expect(within(screen.getByRole('navigation', { name: 'مسار التنقل' })).getByRole('link', { name: 'جامعة بغداد' }).getAttribute('href')).toBe('/channels/u1');
    expect(screen.getByRole('link', { name: /Anatomy/ }).getAttribute('href')).toBe('/subjects/anat');
    const surgery = screen.getByText('Surgery').closest('li')!;
    expect(within(surgery).getByText('يتطلب رمز انضمام')).toBeTruthy();
    expect(within(surgery).queryByRole('link')).toBeNull();
  });

  it('opens a subject at its own page', async () => {
    serve({ '/api/channels/nodes/anat': () => json({ ...ANAT, path: [] }), '/api/channels/tree': () => json({ nodes: [ANAT], truncated: false }) });
    const router = show('/channels/anat', [
      { path: '/channels/:nodeId', element: <BrowseScreen /> },
      { path: '/subjects/:subjectId', element: <h1>صفحة المادة</h1> },
    ]);
    await waitFor(() => expect(router.state.location.pathname).toBe('/subjects/anat'));
  });
});

describe('the subject page', () => {
  const lecture = (id: string, no: number, title: string, version: number): OfficialLectureView =>
    ({
      id,
      space_id: 'sp_anat',
      subject: { id: 'anat', kind: 'subject', title: 'Anatomy' },
      title,
      lecture_no: no,
      lecture_no_origin: 'moderator',
      held_on: '2026-10-14',
      status: 'published',
      head_version: { id: `v_${id}`, version_no: version, page_count: 40, processing_status: 'ready' },
      uploaded_by: { id: 'm', display_name: 'د. علي', avatar_url: null },
      approved: null,
      counts: { explanations: 0 },
      updated_at: 1,
    }) as OfficialLectureView;

  const memberRoutes = (lectures: OfficialLectureView[]) => ({
    '/api/channels/nodes/anat': () => json({ ...ANAT, path: [{ id: 'u1', kind: 'university', title: 'جامعة بغداد' }, { id: 's3', kind: 'stage', title: 'المرحلة الثالثة' }] }),
    '/api/spaces/sp_anat/lectures': () => json({ items: lectures, next_cursor: null }),
    '/api/copies': () =>
      json({ copies: lectures[1] ? [{ id: 'c1', mode: 'personal', lecture: { space_id: 'sp_anat', lecture_id: lectures[1].id, version_no: 1 }, newer_official_version: { id: 'v2', version_no: 2 } }] : [] }),
    '/api/spaces/sp_anat/subject/attachments': () =>
      json({
        attachments: [
          { id: 'a1', kind: 'previous_exam', title: 'أسئلة 2025', lecture: null, status: 'published', visibility: 'course', uploaded_by: { id: 'm', display_name: 'د. علي', avatar_url: null }, source_id: 's', file: { file_id: 'f1', name: 'q.pdf', mime: 'application/pdf', size: 1000 }, created_at: 1, updated_at: 1 },
        ],
      }),
    '/api/spaces/sp_anat/subject/events': () => json({ items: [{ seq: 1, kind: 'lecture_published', ref: { type: 'official_lecture', id: 'l1' }, title: 'المحاضرة 1', created_at: Date.now() }], next_cursor: null }),
    '/api/channels/subjects/anat/follow': (m: string) => (m === 'DELETE' ? json({ subject: { id: 'anat', kind: 'subject', title: 'Anatomy' }, course_follow: null }) : json({ subject: { id: 'anat' }, add_new_lectures: true, library_folder_id: null, created_at: 1 })),
  });

  it('a member sees the breadcrumb, «تابع المادة», and the official lectures in order with «لديك نسخة» / «إصدار جديد» badges', async () => {
    serve(memberRoutes([lecture('l1', 1, 'Upper limb', 1), lecture('l2', 2, 'Abdomen', 2)]));
    show('/subjects/anat', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    await screen.findByRole('heading', { level: 1, name: 'Anatomy' });
    expect(screen.getByRole('navigation', { name: 'مسار التنقل' }).textContent).toMatch(/جامعة بغداد.*المرحلة الثالثة/);
    const panel = await screen.findByRole('tabpanel');
    const rows = await within(panel).findAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/المحاضرة 1.*Upper limb/), expect.stringMatching(/المحاضرة 2.*Abdomen/)]);
    expect(within(rows[0]!).getByRole('link').getAttribute('href')).toBe('/subjects/sp_anat/lectures/l1');
    expect(within(rows[0]!).getByText('لم تبدأ دراستها')).toBeTruthy();
    expect(within(rows[1]!).getByText('لديك نسخة')).toBeTruthy();
    expect(within(rows[1]!).getByText('إصدار جديد')).toBeTruthy();
    // «تابع المادة» is on (the viewer follows it) and can be turned off
    const follow = screen.getByRole('switch', { name: /تابع المادة/ });
    expect(follow.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(follow);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/channels/subjects/anat/follow')).toBe(true));
  });

  it('«الملفات» groups attachments by kind with their uploader; «التحديثات» lists the subject’s events', async () => {
    serve(memberRoutes([]));
    show('/subjects/anat', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    await screen.findByRole('heading', { level: 1, name: 'Anatomy' });
    expect(await screen.findByText('لا توجد محاضرات رسمية منشورة في هذه المادة بعد.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'الملفات' }));
    expect(await screen.findByRole('heading', { name: 'أسئلة سنوات سابقة' })).toBeTruthy();
    expect(screen.getByText(/د\. علي/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /أسئلة 2025/ }).getAttribute('href')).toBe('/api/spaces/sp_anat/files/f1');
    fireEvent.click(screen.getByRole('tab', { name: 'التحديثات' }));
    expect(await screen.findByText('المحاضرة 1')).toBeTruthy();
    expect(screen.getByText('محاضرة جديدة')).toBeTruthy();
  });

  it('someone who may not enter sees only the title and how to join; a pending request says so; no tabs', async () => {
    serve({ '/api/channels/nodes/bio': () => json({ ...BIO, space_id: null, viewer: { ...BIO.viewer, membership: null }, path: [] }) });
    show('/subjects/bio', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    await screen.findByRole('heading', { level: 1, name: 'Biochemistry' });
    expect(screen.getByText('يتطلب رمز انضمام')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'انضم برمز أو QR' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/api/spaces/'))).toBe(false);
  });

  it('a pending request says «طلبك قيد المراجعة»', async () => {
    serve({ '/api/channels/nodes/bio': () => json({ ...BIO, path: [] }) });
    show('/subjects/bio', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    expect(await screen.findByText('طلبك قيد المراجعة')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('a subject that does not exist (or is hidden) shows the not-found state', async () => {
    serve({});
    show('/subjects/nope', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    expect(await screen.findByText('هذه المادة غير موجودة أو لا تملك الوصول إليها')).toBeTruthy();
  });
});
