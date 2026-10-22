// P1-T4 step 3 — joining (IA §4.1, J9; PRD AOS-2.11 class code, 2.12 QR with a manual fallback, 2.13 invite link that
// shows only the title before sign-in). The client sends what the person typed or scanned; the server decides.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { invalidateAuthStatus } from '../../src/lib/auth';

vi.mock('../../src/features/channels/qr', async (orig) => ({
  ...(await orig<typeof import('../../src/features/channels/qr')>()),
  decodeQrFromFile: vi.fn(async () => 'https://medlevo.example/join/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456'),
}));
import { JoinSheet } from '../../src/features/channels/JoinSheet';
import { JoinLinkScreen } from '../../src/features/channels/JoinLinkScreen';
import { expectDisabledSayWhy } from './sayWhy';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456';
const membership = (status: 'pending' | 'approved') => ({
  membership: { id: 'm1', node: { id: 'anat', kind: 'subject', title: 'Anatomy' }, status, join_method: 'class_code', created_at: 1, decided_at: null, reason_ar: null },
  message_ar: status === 'pending' ? 'طلبك بانتظار موافقة مشرف المادة.' : 'انضممت إلى Anatomy.',
});

let calls: Array<{ method: string; url: string; body: unknown }> = [];
function serve(handler: (method: string, path: string, body: unknown) => Response | undefined) {
  calls = [];
  setFetchImpl(async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    return handler(method, url.split('?')[0]!, body) ?? json({ error: { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' } }, 404);
  });
}

function sheet(onJoined = vi.fn()) {
  const router = createMemoryRouter([{ path: '/', element: <JoinSheet open onClose={() => undefined} onJoined={onJoined} /> }], { initialEntries: ['/'] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  return onJoined;
}

afterEach(() => {
  setFetchImpl(null);
  invalidateAuthStatus();
});

describe('«انضم برمز أو QR»', () => {
  it('joins with a typed class code (normalised) and says the request waits for an approver', async () => {
    serve((m, p) => (m === 'POST' && p === '/api/channels/join' ? json(membership('pending')) : undefined));
    const onJoined = sheet();
    const dialog = await screen.findByRole('dialog', { name: 'انضم إلى مادة' });
    fireEvent.change(within(dialog).getByLabelText('رمز الانضمام أو رابط الدعوة'), { target: { value: 'ab12-cd34' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'انضم' }));
    expect(await within(dialog).findByText('طلبك قيد المراجعة')).toBeTruthy();
    expect(within(dialog).getByText('طلبك بانتظار موافقة مشرف المادة.')).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/channels/join')?.body).toEqual({ code: 'AB12CD34' });
    expect(onJoined).toHaveBeenCalled();
    // the field that had the focus is gone: the focus moves to the result, still inside the sheet (Escape, Tab work)
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.textContent).toMatch(/طلبك قيد المراجعة/);
  });

  it('shows the server’s reason for a wrong or expired code, and a local reason for an impossible one', async () => {
    serve((m, p) =>
      m === 'POST' && p === '/api/channels/join'
        ? json({ error: { code: 'JOIN_CODE_INVALID', message: 'رمز الانضمام أو رابط الدعوة غير صالح أو منتهٍ أو استُنفد.' } }, 400)
        : undefined,
    );
    sheet();
    const dialog = await screen.findByRole('dialog', { name: 'انضم إلى مادة' });
    const field = within(dialog).getByLabelText('رمز الانضمام أو رابط الدعوة');
    fireEvent.change(field, { target: { value: 'ab' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'انضم' }));
    expect(await within(dialog).findByText(/أقصر من المعتاد/)).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.change(field, { target: { value: 'ZZZZ-ZZZZ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'انضم' }));
    expect(await within(dialog).findByText(/غير صالح أو منتهٍ/)).toBeTruthy();
  });

  it('degrades to typing the code when the camera cannot be used (no camera API here)', async () => {
    serve(() => undefined);
    sheet();
    const dialog = await screen.findByRole('dialog', { name: 'انضم إلى مادة' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'امسح رمز QR' }));
    expect(await within(dialog).findByText(/الكاميرا غير متاحة/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText('رمز الانضمام أو رابط الدعوة')));
  });

  it('reads a QR from a chosen picture, shows the channel’s title from the public preview, then joins with the link', async () => {
    serve((m, p) => {
      if (p === '/api/channels/join/preview') return json({ title_ar: 'Anatomy', kind: 'subject', requires_approval: false });
      if (m === 'POST' && p === '/api/channels/join/link') return json(membership('approved'));
      return undefined;
    });
    sheet();
    const dialog = await screen.findByRole('dialog', { name: 'انضم إلى مادة' });
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(['x'], 'qr.png', { type: 'image/png' })] } });
    expect(await within(dialog).findByText(/دعوة للانضمام إلى/)).toBeTruthy();
    expect(within(dialog).getByText('Anatomy')).toBeTruthy();
    // the picture button is gone with the form: the focus moves to the channel's title, inside the sheet
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.textContent).toMatch(/دعوة للانضمام إلى/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'انضم إلى Anatomy' }));
    expect(await within(dialog).findByText('انضممت إلى Anatomy.')).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/channels/join/link')?.body).toEqual({ token: TOKEN });
    expect(within(dialog).getByRole('link', { name: 'افتح المادة' }).getAttribute('href')).toBe('/subjects/anat');
  });
});

describe('/join/:token — the invite link landing (before sign-in)', () => {
  function landing() {
    const router = createMemoryRouter(
      [
        { path: '/join/:token', element: <JoinLinkScreen /> },
        { path: '/login', element: <h1>تسجيل الدخول</h1> },
      ],
      { initialEntries: [`/join/${TOKEN}`] },
    );
    render(
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>,
    );
    return router;
  }

  it('shows ONLY the channel’s title, then sign-in (with the way back) or creating an account', async () => {
    serve((_m, p) => {
      if (p === '/api/channels/join/preview') return json({ title_ar: 'Anatomy — المرحلة الثالثة', kind: 'subject', requires_approval: true });
      if (p === '/api/auth/status') return json({ setup_required: false, authenticated: false, password_min_length: 12 });
      return undefined;
    });
    landing();
    expect(await screen.findByText('Anatomy — المرحلة الثالثة')).toBeTruthy();
    expect(screen.getByText(/دعوة للانضمام إلى/)).toBeTruthy();
    expect(screen.getByText(/يوافق عليه المشرف/)).toBeTruthy();
    const login = await screen.findByRole('link', { name: 'لدي حساب — سجّل الدخول' });
    expect(login.getAttribute('href')).toBe(`/login?next=${encodeURIComponent(`/join/${TOKEN}`)}`);
    fireEvent.click(screen.getByRole('button', { name: 'أنشئ حسابًا بهذه الدعوة' }));
    expect(await screen.findByLabelText('اسم المستخدم')).toBeTruthy();
  });

  it('answers a wrong, expired or revoked link with one generic message', async () => {
    serve((_m, p) => (p === '/api/auth/status' ? json({ setup_required: false, authenticated: false, password_min_length: 12 }) : undefined));
    landing();
    expect(await screen.findByText(/الرابط غير صالح أو انتهت صلاحيته/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /أنشئ حسابًا/ })).toBeNull();
  });

  it('creates an account with the invitation, shows the recovery codes, then opens «القنوات» with a fresh page load', async () => {
    // the page was opened signed out: the new account's own local data opens on a full load (lib/auth activateAccount),
    // never by a client-side navigation that the route gate answers with a reload of THIS address
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
      serve((m, p, body) => {
        if (p === '/api/channels/join/preview') return json({ title_ar: 'Anatomy', kind: 'subject', requires_approval: false });
        if (p === '/api/auth/status') return json({ setup_required: false, authenticated: false, password_min_length: 12 });
        if (m === 'POST' && p === '/api/auth/register') {
          expect(body).toMatchObject({ username: 'sara', display_name: 'سارة', join: { invite_token: TOKEN } });
          return json({ user: { id: 'u9', username: 'sara', display_name: 'سارة', is_platform_admin: false }, recovery_codes: ['aaaa-bbbb', 'cccc-dddd'], membership: membership('approved').membership });
        }
        return undefined;
      });
      landing();
      fireEvent.click(await screen.findByRole('button', { name: 'أنشئ حسابًا بهذه الدعوة' }));
      fireEvent.change(screen.getByLabelText('الاسم الظاهر'), { target: { value: 'سارة' } });
      fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'sara' } });
      fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'night shift wards' } });
      fireEvent.change(screen.getByLabelText('تأكيد كلمة المرور'), { target: { value: 'night shift wards' } });
      fireEvent.click(screen.getByRole('button', { name: 'أنشئ الحساب وانضم' }));
      expect(await screen.findByText('aaaa-bbbb')).toBeTruthy();
      const proceed = screen.getByRole('button', { name: 'متابعة إلى القنوات' }) as HTMLButtonElement;
      expect(proceed.disabled).toBe(true);
      expectDisabledSayWhy();
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'متابعة إلى القنوات' }));
      expect(assign).toHaveBeenCalledWith('/channels');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets a signed-in person join with one tap', async () => {
    serve((m, p) => {
      if (p === '/api/channels/join/preview') return json({ title_ar: 'Anatomy', kind: 'subject', requires_approval: false });
      if (p === '/api/auth/status')
        return json({ setup_required: false, authenticated: true, password_min_length: 12, user: { id: 'u2', username: 'sara', display_name: 'سارة', is_platform_admin: false } });
      if (m === 'POST' && p === '/api/channels/join/link') return json(membership('approved'));
      return undefined;
    });
    landing();
    fireEvent.click(await screen.findByRole('button', { name: 'انضم إلى Anatomy' }));
    expect(await screen.findByText('انضممت إلى Anatomy.')).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/channels/join/link')?.body).toEqual({ token: TOKEN });
  });
});
