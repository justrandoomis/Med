// Phase 1 completion, track C2 — AOS-18.5 «invite named people from the screen»: in «الرموز والدعوات» an Admin finds a
// person (the server's picker: members of channels they manage by name, anyone else by exact username), invites them,
// sees the invitations sent into the node with their state, and revokes a pending one. The server decides everything.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ChannelNodeView, InvitationView, InviteeCandidate, MeResponse } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { routes as adminRoutes } from '../../src/features/admin/routes';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = (id: string, name: string) => ({ id, display_name: name, avatar_url: null });
const ME = { id: 'me', username: 'me', display_name: 'أنا', is_platform_admin: false, vault_id: 'v', timezone: 'Asia/Baghdad', memberships: [], roles: [], quota: null, legacy_owner: false } as unknown as MeResponse;
const ANAT = { id: 'anat', kind: 'subject', title: 'Anatomy', parent_id: null, title_en: null, ordinal: null, starts_on: null, ends_on: null, has_space: true, space_id: 'sp_anat', join_policy: 'closed', status: 'active', viewer: { membership: null, roles: ['admin'], inherited_from: null, course_follow: null } } as unknown as ChannelNodeView;

const ZAINAB: InviteeCandidate = { user: user('z', 'زينب علي'), match: 'member', where_ar: 'عضو في «Physiology»', state: 'can_invite' };
const HASAN: InviteeCandidate = { user: user('h', 'حسن'), match: 'member', where_ar: 'عضو في «Anatomy»', state: 'member' };
const inv = (id: string, who: { id: string; display_name: string; avatar_url: null }, status: InvitationView['status']): InvitationView => ({
  id,
  node: { id: 'anat', kind: 'subject', title: 'Anatomy' },
  invitee: who,
  invited_by: user('me', 'أنا'),
  status,
  expires_at: Date.now() + 1e9,
  created_at: Date.now() - 60_000,
  decided_at: null,
});

let calls: Array<{ method: string; url: string; body: unknown }> = [];
function serve() {
  calls = [];
  let sent: InvitationView[] = [inv('i_old', user('o', 'نور'), 'pending'), inv('i_acc', user('a', 'علي'), 'accepted')];
  setFetchImpl(async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.split('?')[0]!;
    if (path === '/api/accounts/me') return json(ME);
    if (path === '/api/channels/tree') return json({ nodes: [ANAT], truncated: false });
    if (path === '/api/channels/nodes/anat/codes') return json({ codes: [] });
    if (path === '/api/channels/nodes/anat/invitees') {
      const q = new URL(url, 'http://x').searchParams.get('q') ?? '';
      const invited = sent.some((s) => s.invitee.id === 'z' && s.status === 'pending');
      return json({ candidates: q.startsWith('زين') ? [{ ...ZAINAB, state: invited ? 'invited' : 'can_invite' }, HASAN] : [] });
    }
    if (path === '/api/channels/nodes/anat/invitations' && method === 'GET') return json({ invitations: sent });
    if (path === '/api/channels/nodes/anat/invitations' && method === 'POST') {
      const fresh = inv('i_new', ZAINAB.user as never, 'pending');
      sent = [fresh, ...sent];
      return json({ invitations: [fresh] });
    }
    if (path === '/api/channels/invitations/i_old' && method === 'DELETE') {
      sent = sent.map((s) => (s.id === 'i_old' ? { ...s, status: 'revoked' } : s));
      return json({ ...sent.find((s) => s.id === 'i_old') });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' } }, 404);
  });
}

function show(path: string) {
  const router = createMemoryRouter([{ path: '/', children: [...(adminRoutes.shell ?? [])] }], { initialEntries: [path] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
}

beforeAll(async () => {
  await import('../../src/features/admin/register');
});
afterEach(() => setFetchImpl(null));

describe('AOS-18.5 — invite named people from «الرموز والدعوات»', () => {
  it('finds a person by name, invites her; the list shows the new pending invitation; a member cannot be invited again', async () => {
    serve();
    show('/admin/codes?node=anat');
    const box = await screen.findByRole('textbox', { name: /ابحث عن شخص/ });
    fireEvent.change(box, { target: { value: 'زين' } });
    const results = await screen.findByRole('list', { name: 'نتائج البحث' });
    const rows = within(results).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('عضو في «Physiology»');
    expect(within(rows[1]!).getByText('عضو بالفعل')).toBeTruthy();
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'ادعُ زينب علي' }));
    expect(await screen.findByText('أُرسلت الدعوة إلى زينب علي.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/channels/nodes/anat/invitations')?.body).toEqual({ user_ids: ['z'] });
    const sent = await screen.findByRole('list', { name: 'الدعوات المرسلة' });
    await waitFor(() => expect(within(sent).getAllByRole('listitem')[0]!.textContent).toContain('زينب علي'));
    expect(within(within(sent).getAllByRole('listitem')[0]!).getByText('بانتظار الرد')).toBeTruthy();
    // the picker now says she is invited (no second invitation from the screen)
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'نتائج البحث' })).getByText('مدعو وينتظر الرد')).toBeTruthy());
  });

  it('a pending invitation can be revoked; a decided one shows its state with no control', async () => {
    serve();
    show('/admin/codes?node=anat');
    const sent = await screen.findByRole('list', { name: 'الدعوات المرسلة' });
    const rows = within(sent).getAllByRole('listitem');
    expect(within(rows[1]!).getByText('قُبلت')).toBeTruthy();
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'ألغِ دعوة نور' }));
    expect(await screen.findByText('أُلغيت دعوة نور.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/channels/invitations/i_old')).toBe(true);
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'الدعوات المرسلة' })).getAllByRole('listitem')[0]!.textContent).toContain('أُلغيت'));
  });

  it('nothing is searched under two letters; an empty answer says how to find others', async () => {
    serve();
    show('/admin/codes?node=anat');
    const box = await screen.findByRole('textbox', { name: /ابحث عن شخص/ });
    fireEvent.change(box, { target: { value: 'ز' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(calls.some((c) => c.url.includes('/invitees'))).toBe(false);
    fireEvent.change(box, { target: { value: 'غريب' } });
    expect(await screen.findByText(/اكتب اسم المستخدم كاملًا لدعوة غيرهم/)).toBeTruthy();
  });
});
