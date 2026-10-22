// P1-T4 step 3 — adversarial review (BUILD_PLAN §1.2): each test reproduces a defect found in review and failed before
// its fix.
//  R1 the subject page said «لم تبدأ دراستها» / «بدأت دراسة 0 من …» for lectures the viewer HAS copies of, whenever their
//     own copies could not be read (offline from the saved copy, or a failed request) — an honesty defect;
//  R2 the invite landing said «الرابط غير صالح أو انتهت صلاحيته أو أُلغي» when the preview could not be asked at all
//     (no connection, rate limit) — the student was told to ask for a new link that was fine;
//  R3 «الرموز والدعوات» kept a new code on screen after the scope changed, under ANOTHER node's name;
//  R4 «الأعضاء وطلبات الانضمام» kept the ticked requests across a scope change: «وافق على المحدد (1)» in the new scope
//     approved someone the admin had never ticked there;
//  R5 «المزيد» / «الأقدم» buttons did nothing offline or on an error (a dead control, AOS-23.3);
//  R7 a QR whose invite link was revoked showed the server's «المسار المطلوب غير موجود.» in the join sheet instead of
//     saying the invitation in the QR is not valid.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ChannelKind, ChannelNodeView, ChannelRole, MeResponse, OfficialLectureView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { setStorageAccount } from '../../src/lib/userStorage';
import { invalidateAuthStatus } from '../../src/lib/auth';
vi.mock('../../src/features/channels/qr', async (orig) => ({
  ...(await orig<typeof import('../../src/features/channels/qr')>()),
  decodeQrFromFile: vi.fn(async () => 'https://medlevo.example/join/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456'),
}));
import { SubjectScreen } from '../../src/features/channels/SubjectScreen';
import { JoinSheet } from '../../src/features/channels/JoinSheet';
import { BrowseScreen } from '../../src/features/channels/BrowseScreen';
import { JoinLinkScreen } from '../../src/features/channels/JoinLinkScreen';
import { routes as adminRoutes } from '../../src/features/admin/routes';
import { expectDisabledSayWhy } from './sayWhy';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const missing = () => json({ error: { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' } }, 404);

let calls: Array<{ method: string; url: string; body: unknown }> = [];
let offline = false;
function serve(routes: Record<string, (method: string, body: unknown, url: string) => Response>) {
  calls = [];
  setFetchImpl(async (url, init) => {
    const method = init?.method ?? 'GET';
    if (offline) throw new TypeError('Failed to fetch');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const hit = routes[url.split('?')[0]!];
    return hit ? hit(method, body, url) : missing();
  });
}

function show(path: string, routes: Array<{ path: string; element: React.ReactElement }>) {
  const router = createMemoryRouter([...routes, { path: '*', element: <h1>هذه الصفحة غير موجودة</h1> }], { initialEntries: [path] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  return router;
}

function n(id: string, kind: ChannelKind, title: string, parent: string | null, roles: ChannelRole[] = [], extra: Partial<ChannelNodeView> = {}): ChannelNodeView {
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
    space_id: kind === 'subject' ? `sp_${id}` : null,
    join_policy: 'approval',
    status: 'active',
    viewer: { membership: null, roles, inherited_from: null, course_follow: null },
    ...extra,
  } as ChannelNodeView;
}

beforeAll(async () => {
  await import('../../src/features/admin/register');
});
afterEach(() => {
  setFetchImpl(null);
  offline = false;
  setStorageAccount(null);
  invalidateAuthStatus();
});

// ───────────────────────────── R1, R5: the subject page ─────────────────────────────

const lecture = (id: string, no: number, title: string): OfficialLectureView =>
  ({
    id,
    space_id: 'sp_anat',
    subject: { id: 'anat', kind: 'subject', title: 'Anatomy' },
    title,
    lecture_no: no,
    lecture_no_origin: 'moderator',
    held_on: '2026-10-14',
    status: 'published',
    head_version: { id: `v_${id}`, version_no: 1, page_count: 40, processing_status: 'ready' },
    uploaded_by: { id: 'm', display_name: 'د. علي', avatar_url: null },
    approved: null,
    counts: { explanations: 0 },
    updated_at: 1,
  }) as OfficialLectureView;

const ANAT = n('anat', 'subject', 'Anatomy', null, [], {
  space_id: 'sp_anat',
  viewer: { membership: { id: 'm', node: { id: 'anat', kind: 'subject', title: 'Anatomy' }, status: 'approved', join_method: 'class_code', created_at: 1, decided_at: 1, reason_ar: null }, roles: [], inherited_from: null, course_follow: null },
} as Partial<ChannelNodeView>);

function subjectRoutes(o: { copies: () => Response; more?: boolean; events?: boolean }) {
  return {
    '/api/channels/nodes/anat': () => json({ ...ANAT, path: [] }),
    '/api/spaces/sp_anat/lectures': (_m: string, _b: unknown, url: string) =>
      url.includes('cursor=') ? json({ items: [lecture('l3', 3, 'Thorax')], next_cursor: null }) : json({ items: [lecture('l1', 1, 'Upper limb'), lecture('l2', 2, 'Abdomen')], next_cursor: o.more ? 'c2' : null }),
    '/api/copies': o.copies,
    '/api/spaces/sp_anat/subject/events': () => json({ items: [{ seq: 1, kind: 'lecture_published', ref: { type: 'official_lecture', id: 'l1' }, title: 'المحاضرة 1', created_at: Date.now() }], next_cursor: o.events ? 'e2' : null }),
  };
}
const COPY_OF_L2 = () => json({ copies: [{ id: 'c1', mode: 'personal', lecture: { space_id: 'sp_anat', lecture_id: 'l2', version_no: 1 }, newer_official_version: null }] });

describe('R1 — the subject page never claims «لم تبدأ دراستها» when it could not read the viewer’s copies', () => {
  it('offline (the saved copy of the page): the copy the viewer has is still «لديك نسخة», nothing says they have not started', async () => {
    setStorageAccount({ userId: 'u_r1', legacy: false });
    serve(subjectRoutes({ copies: COPY_OF_L2 }));
    show('/subjects/anat', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByText('لديك نسخة')).toBeTruthy();
    cleanup();
    offline = true;
    show('/subjects/anat', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    expect(await screen.findByText(/تعرض نسخة محفوظة على هذا الجهاز/)).toBeTruthy();
    const rows = await within(await screen.findByRole('tabpanel')).findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText('لديك نسخة')).toBeTruthy();
    expect(screen.queryByText(/بدأت دراسة 0/)).toBeNull();
  });

  it('online, when the copies cannot be read: no «لم تبدأ دراستها» and no «بدأت دراسة 0 من …» — the page says it could not check', async () => {
    serve(subjectRoutes({ copies: () => json({ error: { code: 'INTERNAL', message: 'حدث خطأ في الخادم.' } }, 500) }));
    show('/subjects/anat', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByText('Upper limb');
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/copies'))).toBe(true));
    // give the failed request its turn
    await new Promise((r) => setTimeout(r, 20));
    expect(within(panel).queryByText('لم تبدأ دراستها')).toBeNull();
    expect(within(panel).queryByText(/بدأت دراسة 0/)).toBeNull();
    expect(within(panel).getByText(/تعذّر التحقق من نسخك/)).toBeTruthy();
  });
});

describe('R5 — «المزيد» / «الأقدم» act or say why', () => {
  it('offline (saved copy): «المزيد من المحاضرات» and «الأقدم» are disabled with the reason', async () => {
    setStorageAccount({ userId: 'u_r5', legacy: false });
    serve(subjectRoutes({ copies: COPY_OF_L2, more: true, events: true }));
    show('/subjects/anat', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    expect(await screen.findByRole('button', { name: 'المزيد من المحاضرات' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'التحديثات' }));
    expect(await screen.findByRole('button', { name: 'الأقدم' })).toBeTruthy();
    cleanup();
    offline = true;
    show('/subjects/anat', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    const more = (await screen.findByRole('button', { name: 'المزيد من المحاضرات' })) as HTMLButtonElement;
    expect(more.disabled).toBe(true);
    expectDisabledSayWhy();
    fireEvent.click(screen.getByRole('tab', { name: 'التحديثات' }));
    const older = (await screen.findByRole('button', { name: 'الأقدم' })) as HTMLButtonElement;
    expect(older.disabled).toBe(true);
    expectDisabledSayWhy();
  });

  it('online, a failed «المزيد من المحاضرات» says why instead of doing nothing', async () => {
    let fail = false;
    const routes = subjectRoutes({ copies: COPY_OF_L2, more: true });
    serve({
      ...routes,
      '/api/spaces/sp_anat/lectures': (m, b, url) => (fail ? json({ error: { code: 'INTERNAL', message: 'تعذّر تحميل المزيد الآن.' } }, 500) : routes['/api/spaces/sp_anat/lectures'](m, b, url)),
    });
    show('/subjects/anat', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    const more = await screen.findByRole('button', { name: 'المزيد من المحاضرات' });
    fail = true;
    fireEvent.click(more);
    expect(await screen.findByText('تعذّر تحميل المزيد الآن.')).toBeTruthy();
  });
});

// ───────────────────────────── R2: the invite landing ─────────────────────────────

describe('R2 — the invite landing does not call a good link invalid when it could not ask', () => {
  const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456';
  const landing = () => show(`/join/${TOKEN}`, [{ path: '/join/:token', element: <JoinLinkScreen /> }]);

  it('no connection: says so and offers to try again — not «الرابط غير صالح»', async () => {
    offline = true;
    serve({});
    landing();
    expect(await screen.findByRole('button', { name: /إعادة المحاولة/ })).toBeTruthy();
    expect(screen.queryByText(/الرابط غير صالح/)).toBeNull();
    // and trying again once the network is back shows the title
    offline = false;
    serve({
      '/api/channels/join/preview': () => json({ title_ar: 'Anatomy', kind: 'subject', requires_approval: false }),
      '/api/auth/status': () => json({ setup_required: false, authenticated: false, password_min_length: 12 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /إعادة المحاولة/ }));
    expect(await screen.findByText('Anatomy')).toBeTruthy();
  });

  it('too many previews from this network (429): the server’s reason, not «الرابط غير صالح»', async () => {
    serve({
      '/api/channels/join/preview': () => json({ error: { code: 'RATE_LIMITED', message: 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.' } }, 429),
      '/api/auth/status': () => json({ setup_required: false, authenticated: false, password_min_length: 12 }),
    });
    landing();
    expect(await screen.findByText(/محاولات كثيرة/)).toBeTruthy();
    expect(screen.queryByText(/الرابط غير صالح/)).toBeNull();
  });

  it('a link the server does not know (404) still gets the one generic message', async () => {
    serve({ '/api/auth/status': () => json({ setup_required: false, authenticated: false, password_min_length: 12 }) });
    landing();
    expect(await screen.findByText(/الرابط غير صالح أو انتهت صلاحيته/)).toBeTruthy();
  });
});

// ───────────────────────────── R3, R4: «إدارة القنوات» across a scope change ─────────────────────────────

const ME = { id: 'me', username: 'me', display_name: 'أنا', is_platform_admin: false, vault_id: 'v', timezone: 'Asia/Baghdad', memberships: [], roles: [], quota: null, legacy_owner: false } as unknown as MeResponse;
const A = n('na', 'subject', 'Anatomy', null, ['admin'], { join_policy: 'open_with_code' });
const B = n('nb', 'subject', 'Biochemistry', null, ['admin'], { join_policy: 'open_with_code' });
function serveAdmin(extra: Record<string, (method: string, body: unknown, url: string) => Response>) {
  serve({ '/api/accounts/me': () => json(ME), '/api/channels/tree': () => json({ nodes: [A, B], truncated: false }), ...extra });
}
function showAdmin(path: string) {
  const router = createMemoryRouter([{ path: '/', children: [...(adminRoutes.shell ?? []), { path: '*', element: <h1>هذه الصفحة غير موجودة</h1> }] }], { initialEntries: [path] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  return router;
}

describe('R3 — a new code is shown only under the node it was made for', () => {
  it('changing the scope hides the code made for the other node', async () => {
    const view = (node: ChannelNodeView) => ({ id: `code_${node.id}`, node: { id: node.id, kind: node.kind, title: node.title }, kind: 'class_code', hint: '7Q', requires_approval: false, max_uses: null, use_count: 0, expires_at: Date.now() + 1e8, revoked_at: null, created_by: { id: 'me', display_name: 'أنا', avatar_url: null }, created_at: 1 });
    serveAdmin({
      '/api/channels/nodes/na/codes': (m) => (m === 'POST' ? json({ view: view(A), code: 'ABCD-EF7Q' }) : json({ codes: [] })),
      '/api/channels/nodes/nb/codes': () => json({ codes: [] }),
    });
    showAdmin('/admin/codes?node=na');
    await screen.findByRole('heading', { level: 1, name: 'الرموز والدعوات' });
    fireEvent.click(await screen.findByRole('button', { name: 'أنشئ' }));
    const fresh = await screen.findByRole('region', { name: /رمز الانضمام الجديد/ });
    expect(within(fresh).getByText('ABCD-EF7Q')).toBeTruthy();
    // the card names the node the code is for
    expect(fresh.textContent).toContain('Anatomy');
    fireEvent.change(screen.getByLabelText('غيّر النطاق'), { target: { value: 'nb' } });
    await waitFor(() => expect(document.querySelector('.ad-scope__line')?.textContent).toContain('Biochemistry'));
    expect(screen.queryByText('ABCD-EF7Q')).toBeNull();
  });
});

describe('R4 — ticked requests do not follow the admin into another scope', () => {
  it('a person pending in both nodes, ticked in the first, is not pre-ticked in the second', async () => {
    const member = (node: ChannelNodeView) => ({
      membership_id: `m_${node.id}`,
      user: { id: 'u_sara', display_name: 'سارة', avatar_url: null },
      node: { id: node.id, kind: node.kind, title: node.title },
      status: 'pending',
      join_method: 'class_code',
      created_at: Date.now(),
      decided_by: null,
      decided_at: null,
      reason_ar: null,
    });
    serveAdmin({
      '/api/channels/nodes/na/members': () => json({ items: [member(A)], next_cursor: null }),
      '/api/channels/nodes/nb/members': () => json({ items: [member(B)], next_cursor: null }),
    });
    showAdmin('/admin/members?node=na');
    await screen.findByRole('heading', { level: 1, name: 'الأعضاء وطلبات الانضمام' });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'حدّد سارة' }));
    expect(screen.getByRole('button', { name: 'وافق على المحدد (1)' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('غيّر النطاق'), { target: { value: 'nb' } });
    await waitFor(() => expect(document.querySelector('.ad-scope__line')?.textContent).toContain('Biochemistry'));
    await screen.findByRole('checkbox', { name: 'حدّد سارة' });
    expect((screen.getByRole('checkbox', { name: 'حدّد سارة' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: 'وافق على المحدد (0)' })).toBeTruthy();
  });
});

describe('R7 — a QR whose invitation is no longer valid says so in words a student understands', () => {
  it('the preview answers 404: «رابط الدعوة في هذا الرمز غير صالح…», not the missing-route text', async () => {
    serve({});
    show('/', [{ path: '/', element: <JoinSheet open onClose={() => undefined} /> }]);
    const dialog = await screen.findByRole('dialog', { name: 'انضم إلى مادة' });
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(['x'], 'qr.png', { type: 'image/png' })] } });
    expect(await within(dialog).findByText(/رابط الدعوة في هذا الرمز غير صالح/)).toBeTruthy();
    expect(within(dialog).queryByText('المسار المطلوب غير موجود.')).toBeNull();
  });
});

describe('R8 — a subject that takes members by invitation only does not ask for a join code', () => {
  const CLOSED = n('cls', 'subject', 'Pathology', 'st', [], { space_id: null, join_policy: 'closed' });
  it('the subject page says «بدعوة فقط» and offers no code entry', async () => {
    serve({ '/api/channels/nodes/cls': () => json({ ...CLOSED, path: [] }) });
    show('/subjects/cls', [{ path: '/subjects/:subjectId', element: <SubjectScreen /> }]);
    await screen.findByRole('heading', { level: 1, name: 'Pathology' });
    expect(screen.queryByText('يتطلب رمز انضمام')).toBeNull();
    expect(screen.getByText(/بدعوة فقط/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'انضم برمز أو QR' })).toBeNull();
  });

  it('browsing lists it as «بدعوة فقط», not «يتطلب رمز انضمام»', async () => {
    const STAGE = n('st', 'stage', 'المرحلة الرابعة', null);
    serve({
      '/api/channels/nodes/st': () => json({ ...STAGE, path: [] }),
      '/api/channels/tree': () => json({ nodes: [STAGE, CLOSED], truncated: false }),
    });
    show('/channels/st', [{ path: '/channels/:nodeId', element: <BrowseScreen /> }]);
    await screen.findByRole('heading', { level: 1, name: 'المرحلة الرابعة' });
    const row = screen.getByText('Pathology').closest('li')!;
    expect(within(row).queryByText('يتطلب رمز انضمام')).toBeNull();
    expect(within(row).getByText(/بدعوة فقط/)).toBeTruthy();
  });
});

describe('R9 — every screen IA §3.2 places under «المراجعة» marks it as the current destination', async () => {
  const { activeDestination } = await import('../../src/app/navigation');
  it('questions, exams, practice, cases, planner, weak points, concepts, knowledge map, terms and explanation rules', () => {
    for (const p of ['/questions', '/questions/q1', '/exams/new', '/practice', '/cases/c1', '/planner', '/weakness', '/concepts/x', '/knowledge', '/terms', '/explanation-rules'])
      expect(activeDestination(p)?.label, p).toBe('المراجعة');
    // outside the shell's five (IA §3.2 «Outside the shell»): no destination is marked
    for (const p of ['/search', '/notifications']) expect(activeDestination(p), p).toBeNull();
  });
});

describe('R10 — «الاستهلاك» does not call a storage allowance «شهري»', async () => {
  const { UsageScreen } = await import('../../src/features/me/UsageScreen');
  it('storage without a limit says there is no limit — not «بلا حد شهري»; the monthly allowances keep «شهري»', async () => {
    serve({ '/api/accounts/me/quota': () => json({ storage: { used_bytes: 5 * 1024 * 1024, limit_bytes: null }, ai: { month: '2026-10', used_usd_est: 0, limit_usd: null }, asr: { month: '2026-10', used_minutes: 0, limit_minutes: 120 } }) });
    show('/me/usage', [{ path: '/me/usage', element: <UsageScreen /> }]);
    await screen.findByText('التخزين');
    const storage = screen.getByText('التخزين').closest('.me-meter')!;
    expect(storage.textContent).not.toMatch(/شهري/);
    expect(storage.textContent).toMatch(/بلا حد/);
    const ai = screen.getByText(/الذكاء الاصطناعي \(2026-10\)/).closest('.me-meter')!;
    expect(ai.textContent).toMatch(/بلا حد شهري/);
  });
});
