// P1-T4 step 3 — «إدارة القنوات» (IA §4.10; PRD AOS-18.1, 18.2, 18.5, 18.6, 18.7/18.8 Phase 1, 18.14, 2.15): reached from
// «أنا» only with a role (anyone else gets the not-found page at /admin), every screen shows its scope, the sections come
// from the registry (P1-T4's six here; P1-T5 registers its own), and every action goes to the server, which decides.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ChannelKind, ChannelNodeView, ChannelRole, MeResponse, ReportView, SecurityAuditView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { routes as adminRoutes } from '../../src/features/admin/routes';
import { adminSections } from '../../src/features/admin/sections';
import { expectDisabledSayWhy } from './sayWhy';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = (id: string, name: string) => ({ id, display_name: name, avatar_url: null });
const ME = (admin = false): MeResponse =>
  ({ id: 'me', username: 'me', display_name: 'أنا', is_platform_admin: admin, vault_id: 'v', timezone: 'Asia/Baghdad', memberships: [], roles: [], quota: null, legacy_owner: false }) as MeResponse;

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

let calls: Array<{ method: string; url: string; body: unknown }> = [];
function serve(tree: ChannelNodeView[], me: MeResponse, extra: Record<string, (method: string, body: unknown, url: string) => Response> = {}) {
  calls = [];
  setFetchImpl(async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.split('?')[0]!;
    if (path === '/api/accounts/me') return json(me);
    if (path === '/api/channels/tree') return json({ nodes: tree, truncated: false });
    const hit = extra[path];
    return hit ? hit(method, body, url) : json({ error: { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' } }, 404);
  });
}

function show(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        children: [...(adminRoutes.shell ?? []), { path: '*', element: <h1>هذه الصفحة غير موجودة</h1> }],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  return router;
}

beforeAll(async () => {
  await import('../../src/features/admin/register');
});
afterEach(() => setFetchImpl(null));

const U = n('u1', 'university', 'جامعة بغداد', null, ['admin']);
const C = n('c1', 'college', 'كلية الطب', 'u1', ['admin']);
const S3 = n('s3', 'stage', 'المرحلة الثالثة', 'c1', ['admin']);
const ANAT = n('anat', 'subject', 'Anatomy', 's3', ['admin']);

describe('the area and its registry', () => {
  it('registers P1-T4’s six sections from features/admin', () => {
    const mine = adminSections()
      .filter((s) => s.owner === 'P1-T4')
      .map((s) => s.id);
    expect(mine).toEqual(['tree', 'members', 'codes', 'roles', 'moderation', 'audit']);
  });

  it('is not there for someone without a role (the same page as a missing route)', async () => {
    serve([n('u1', 'university', 'جامعة بغداد', null)], ME(false));
    show('/admin');
    expect(await screen.findByRole('heading', { name: 'هذه الصفحة غير موجودة' })).toBeTruthy();
  });

  it('lists only the sections the viewer’s roles open (an Assistant: joins, codes, moderation, audit)', async () => {
    serve([n('u1', 'university', 'جامعة بغداد', null), n('anat', 'subject', 'Anatomy', 'u1', ['assistant'])], ME(false));
    show('/admin');
    await screen.findByRole('heading', { level: 1, name: 'إدارة القنوات' });
    const names = screen.getAllByRole('link').map((l) => l.textContent ?? '');
    expect(names.some((t) => t.includes('الأعضاء وطلبات الانضمام'))).toBe(true);
    expect(names.some((t) => t.includes('الرموز والدعوات'))).toBe(true);
    expect(names.some((t) => t.includes('الإشراف'))).toBe(true);
    expect(names.some((t) => t.includes('سجل الإجراءات'))).toBe(true);
    expect(names.some((t) => t.includes('الشجرة'))).toBe(false);
    expect(names.some((t) => t.includes('الأدوار'))).toBe(false);
  });

  it('a section the viewer may not open, or one that is not planned, is the missing page', async () => {
    serve([n('anat', 'subject', 'Anatomy', null, ['assistant'])], ME(false));
    show('/admin/tree');
    expect(await screen.findByRole('heading', { name: 'هذه الصفحة غير موجودة' })).toBeTruthy();
  });
});

describe('«الشجرة»', () => {
  it('shows the scope, the subtree, and creates a subject (with its own space) under a stage', async () => {
    serve([U, C, S3, ANAT], ME(false), {
      '/api/channels/nodes': (m, body) => (m === 'POST' ? json({ ...n('phys', 'subject', (body as { title: string }).title, 's3', ['admin']) }) : json({}, 405)),
    });
    show('/admin/tree?node=s3');
    await screen.findByRole('heading', { level: 1, name: 'الشجرة' });
    expect(screen.getByText(/نطاقك:/).textContent).toMatch(/جامعة بغداد › كلية الطب › المرحلة الثالثة/);
    const row = screen.getByText('Anatomy').closest('li')!;
    expect(within(row).getByText('مادة')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'أضف تحت المرحلة الثالثة' }));
    const dialog = await screen.findByRole('dialog', { name: 'عقدة جديدة تحت المرحلة الثالثة' });
    fireEvent.change(within(dialog).getByLabelText('النوع'), { target: { value: 'subject' } });
    fireEvent.change(within(dialog).getByLabelText('الاسم'), { target: { value: 'Physiology' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'أنشئ' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/channels/nodes')?.body).toEqual({ parent_id: 's3', kind: 'subject', title: 'Physiology', join_policy: 'approval', create_space: true }));
  });

  it('the platform admin adds a university and the section moves to it (it is shown, not hidden in another scope)', async () => {
    const tree = [n('u0', 'university', 'جامعة أخرى', null, []), U];
    serve(tree, ME(true), {
      '/api/channels/nodes': (m, body) => {
        if (m !== 'POST') return json({}, 405);
        const created = n('u_new', 'university', (body as { title: string }).title, null, []);
        tree.push(created);
        return json(created);
      },
    });
    const router = show('/admin/tree');
    await screen.findByRole('heading', { level: 1, name: 'الشجرة' });
    fireEvent.click(screen.getByRole('button', { name: 'أضف جامعة' }));
    const dialog = await screen.findByRole('dialog', { name: 'جامعة جديدة' });
    fireEvent.change(within(dialog).getByLabelText('الاسم'), { target: { value: 'جامعة الكوفة' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'أنشئ' }));
    await waitFor(() => expect(router.state.location.search).toBe('?node=u_new'));
    expect(await screen.findByRole('button', { name: 'أضف تحت جامعة الكوفة' })).toBeTruthy();
    expect(screen.getByText(/نطاقك:/).textContent).toMatch(/جامعة الكوفة/);
  });

  it('archives only after showing the impact', async () => {
    serve([U, C, S3, ANAT], ME(false), {
      '/api/channels/nodes/anat/archive': (_m, body) =>
        json({ preview: { node: { id: 'anat', kind: 'subject', title: 'Anatomy' }, descendants: 0, memberships: 37, spaces: 1, open_codes: 2 }, archived: !(body as { preview: boolean }).preview }),
    });
    show('/admin/tree?node=s3');
    const row = (await screen.findByText('Anatomy')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'أرشف Anatomy' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(await within(dialog).findByText(/37 عضوية/)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith('/archive')).map((c) => c.body)).toEqual([{ preview: true }]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'أرشف' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/archive')).map((c) => c.body)).toEqual([{ preview: true }, { preview: false }]));
  });
});

describe('controls that wait say why (AOS-23.3)', () => {
  it('«انقل» waits for a destination, «ارفض» for a reason', async () => {
    const pending = { membership_id: 'm_s1', user: user('s1', 'سارة'), status: 'pending', join_method: 'class_code', created_at: 1, decided_at: null, decided_by: null, reason_ar: null, roles: [] };
    serve([U, C, S3, ANAT, n('s4', 'stage', 'المرحلة الرابعة', 'c1', ['admin'])], ME(false), {
      '/api/channels/nodes/anat/members': () => json({ items: [pending], next_cursor: null }),
    });
    show('/admin/tree?node=c1');
    const row = (await screen.findByText('Anatomy')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'انقل Anatomy' }));
    const move = await screen.findByRole('dialog', { name: 'نقل «Anatomy»' });
    expectDisabledSayWhy(move);
    expect(within(move).getByText('اختر الوجهة أولًا.')).toBeTruthy();
    cleanup();
    show('/admin/members?node=anat');
    const sara = (await screen.findByText('سارة')).closest('li')!;
    fireEvent.click(within(sara).getByRole('button', { name: 'ارفض سارة' }));
    const ask = await screen.findByRole('dialog');
    expectDisabledSayWhy(ask);
  });
});

describe('«الأعضاء وطلبات الانضمام»', () => {
  it('approves one request and several at once', async () => {
    const pending = (id: string, name: string) => ({ membership_id: `m_${id}`, user: user(id, name), status: 'pending', join_method: 'class_code', created_at: 1, decided_at: null, decided_by: null, reason_ar: null, roles: [] });
    serve([U, n('anat', 'subject', 'Anatomy', 'u1', ['assistant'])], ME(false), {
      '/api/channels/nodes/anat/members': () => json({ items: [pending('s1', 'سارة'), pending('s2', 'علي'), pending('s3', 'زينب')], next_cursor: null }),
      '/api/channels/nodes/anat/members/s1/decision': () => json({}),
      '/api/channels/nodes/anat/members/s2/decision': () => json({}),
      '/api/channels/nodes/anat/members/s3/decision': () => json({}),
    });
    show('/admin/members?node=anat');
    const sara = (await screen.findByText('سارة')).closest('li')!;
    fireEvent.click(within(sara).getByRole('button', { name: 'وافق على سارة' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/members/s1/decision'))?.body).toEqual({ decision: 'approve' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'حدّد علي' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'حدّد زينب' }));
    fireEvent.click(screen.getByRole('button', { name: 'وافق على المحدد (2)' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/decision')).length).toBe(3));
  });
});

describe('«الرموز والدعوات»', () => {
  it('creates an invite link and shows it ONCE with its QR and the link as text', async () => {
    serve([U, n('anat', 'subject', 'Anatomy', 'u1', ['assistant'])], ME(false), {
      '/api/channels/nodes/anat/codes': (m) =>
        m === 'POST'
          ? json({
              view: { id: 'k1', node: { id: 'anat', kind: 'subject', title: 'Anatomy' }, kind: 'invite_link', hint: 'Xy', requires_approval: true, max_uses: null, use_count: 0, expires_at: Date.now() + 86_400_000, revoked_at: null, created_by: user('me', 'أنا'), created_at: Date.now() },
              link: 'https://medlevo.example/join/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456',
              qr_payload: 'https://medlevo.example/join/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456',
            })
          : json({ codes: [] }),
    });
    show('/admin/codes?node=anat');
    await screen.findByRole('heading', { level: 1, name: 'الرموز والدعوات' });
    fireEvent.click(screen.getByRole('radio', { name: 'رابط دعوة و QR' }));
    fireEvent.click(screen.getByRole('button', { name: 'أنشئ' }));
    expect(await screen.findByRole('img', { name: /رمز QR/ })).toBeTruthy();
    expect(screen.getByText('https://medlevo.example/join/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456')).toBeTruthy();
    expect(screen.getByText(/لن يظهر مرة أخرى/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ kind: 'invite_link', expires_in_hours: 168, requires_approval: true });
  });
});

describe('«الأدوار»', () => {
  it('shows inherited roles with where they come from, and grants a role to a member of the node', async () => {
    serve([U, C, S3, ANAT], ME(false), {
      '/api/channels/nodes/anat/roles': (m) =>
        m === 'POST'
          ? json({ id: 'r9', node: { id: 'anat', kind: 'subject', title: 'Anatomy' }, user: user('s1', 'سارة'), role: 'subject_moderator', granted_by: user('me', 'أنا'), created_at: 1 })
          : json({
              roles: [{ id: 'r1', node: { id: 'c1', kind: 'college', title: 'كلية الطب' }, user: user('me', 'أنا'), role: 'admin', granted_by: user('p', 'المنصة'), created_at: 1 }],
            }),
      '/api/channels/nodes/anat/members': () => json({ items: [{ membership_id: 'm1', user: user('s1', 'سارة'), status: 'approved', join_method: 'class_code', created_at: 1, decided_at: 1, decided_by: null, reason_ar: null, roles: [] }], next_cursor: null }),
    });
    show('/admin/roles?node=anat');
    const inherited = (await screen.findByText(/موروث من كلية الطب/)).closest('li')!;
    expect(within(inherited).getByText('مدير القناة')).toBeTruthy();
    expect(within(inherited).queryByRole('button')).toBeNull();
    fireEvent.change(await screen.findByLabelText('الشخص'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('الدور'), { target: { value: 'subject_moderator' } });
    fireEvent.click(screen.getByRole('button', { name: 'امنح الدور' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/channels/nodes/anat/roles')?.body).toEqual({ user_id: 's1', role: 'subject_moderator' }));
  });
});

describe('«الإشراف» (Phase 1)', () => {
  const report: ReportView = {
    id: 'rep1',
    target: { db: 'system', type: 'publication', id: 'p1', title: 'شرح حسن — المحاضرة 5' },
    scope: { id: 'anat', kind: 'subject', title: 'Anatomy' },
    reason: 'patient_identifiers',
    note: 'تظهر صورة مريض باسمه',
    status: 'open',
    created_at: Date.now(),
    resolved_at: null,
    reporter: user('s2', 'علي'),
  };
  it('hides reported content with a reason the author and the reporter will read; Phase 2 actions are not shown', async () => {
    serve([U, n('anat', 'subject', 'Anatomy', 'u1', ['subject_moderator'])], ME(false), {
      '/api/moderation/queue': () => json({ items: [report], next_cursor: null }),
      '/api/moderation/actions': (_m, body) => json({ id: 'a1', report_id: 'rep1', action: (body as { action: string }).action, target: report.target, reason_ar: 'x', moderator: user('me', 'أنا'), role: 'subject_moderator', created_at: 1 }),
    });
    show('/admin/moderation?node=anat');
    const row = (await screen.findByText('شرح حسن — المحاضرة 5')).closest('li')!;
    expect(within(row).getByText('يحتوي معرّفات مريض')).toBeTruthy();
    expect(within(row).getByText(/تظهر صورة مريض باسمه/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /اطلب تعديلًا|راجعه مشرف المادة/ })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'أخفِ مع السبب' }));
    const dialog = await screen.findByRole('dialog', { name: 'أخفِ مع السبب' });
    fireEvent.change(within(dialog).getByLabelText('السبب (يقرؤه الكاتب والمُبلِّغ)'), { target: { value: 'يحتوي بيانات مريض' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'أخفِ' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/moderation/actions')?.body).toEqual({ report_id: 'rep1', action: 'hide', reason_ar: 'يحتوي بيانات مريض' }));
    expect(calls.find((c) => c.url.startsWith('/api/moderation/queue'))?.url).toMatch(/scope_node_id=anat/);
  });

  it('says honestly when there is nothing to moderate', async () => {
    serve([n('anat', 'subject', 'Anatomy', null, ['subject_moderator'])], ME(false), { '/api/moderation/queue': () => json({ items: [], next_cursor: null }) });
    show('/admin/moderation');
    expect(await screen.findByText('لا توجد بلاغات مفتوحة في هذا النطاق')).toBeTruthy();
  });
});

describe('«سجل الإجراءات»', () => {
  it('lists the scope’s audit entries without IP addresses or private content, filterable by action', async () => {
    const row: SecurityAuditView = { id: 'e1', actor: user('a', 'د. علي'), actor_role: 'admin@c1', scope: { id: 'anat', kind: 'subject', title: 'Anatomy' }, action: 'channel_role_grant', target: null, summary_ar: 'منح دور مشرف المادة', created_at: Date.now() };
    serve([U, n('anat', 'subject', 'Anatomy', 'u1', ['admin'])], ME(false), { '/api/admin/audit': () => json({ items: [row], next_cursor: null }) });
    show('/admin/audit?node=anat');
    expect(await screen.findByText('منح دور مشرف المادة')).toBeTruthy();
    expect(screen.getByText(/د\. علي/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('نوع الإجراء'), { target: { value: 'channel_join' } });
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/admin/audit')).pop()?.url).toMatch(/action=channel_join/));
  });
});
