// First-run setup token (track D1): when the server says a token is required, the setup form asks for it and
// sends it; otherwise the form is unchanged.
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { invalidateAuthStatus } from '../../lib/auth';
import { SetupScreen } from './SetupScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  setFetchImpl(null);
  invalidateAuthStatus();
});

function mount() {
  const router = createMemoryRouter([{ path: '/setup', element: <SetupScreen />, loader: () => ({ offline: false, passwordMinLength: 10 }) }], { initialEntries: ['/setup'] });
  return render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
}

function statusResponse(tokenRequired: boolean) {
  return { setup_required: true, authenticated: false, owner: null, session: null, password_min_length: 10, ...(tokenRequired ? { setup_token_required: true } : {}) };
}

describe('setup token', () => {
  it('asks for the token when required and sends it with the setup request', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    setFetchImpl(async (url, init) => {
      if (url === '/api/auth/status') return json(statusResponse(true));
      if (url === '/api/auth/setup') {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({ ok: true, recovery_codes: ['AAAA-BBBB'], session: {}, notice_ar: 'احفظ الرموز' });
      }
      return json({}, 404);
    });
    mount();
    const token = await screen.findByLabelText(/رمز الإعداد/);
    fireEvent.change(screen.getByLabelText(/^اسم المستخدم/), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText(/^كلمة المرور/), { target: { value: 'a-long-password-1' } });
    fireEvent.change(screen.getByLabelText(/^تأكيد كلمة المرور/), { target: { value: 'a-long-password-1' } });
    const submit = screen.getByRole('button', { name: 'إنشاء الحساب' });
    expect(submit.hasAttribute('disabled') || submit.getAttribute('aria-disabled') === 'true').toBe(true);
    fireEvent.change(token, { target: { value: 'ABCD-EFGH-JKLM-NPQR-STUV' } });
    fireEvent.click(submit);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ username: 'owner', setup_token: 'ABCD-EFGH-JKLM-NPQR-STUV' });
  });

  it('status unreadable but the server refuses setup for a missing token: the token field appears with the reason', async () => {
    const sent: Array<Record<string, unknown>> = [];
    setFetchImpl(async (url, init) => {
      if (url === '/api/auth/status') return json({ error: { code: 'INTERNAL', message: 'x' } }, 500);
      if (url === '/api/auth/setup') {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({ error: { code: 'FORBIDDEN', message: 'رمز الإعداد غير صحيح أو مفقود.', details: { setup_token_required: true } } }, 403);
      }
      return json({}, 404);
    });
    mount();
    fireEvent.change(await screen.findByLabelText(/^اسم المستخدم/), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText(/^كلمة المرور/), { target: { value: 'a-long-password-1' } });
    fireEvent.change(screen.getByLabelText(/^تأكيد كلمة المرور/), { target: { value: 'a-long-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء الحساب' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(await screen.findByLabelText(/رمز الإعداد/)).toBeTruthy();
    expect(screen.getByText(/رمز الإعداد غير صحيح أو مفقود/)).toBeTruthy();
  });

  it('loopback server: no token field', async () => {
    setFetchImpl(async (url) => (url === '/api/auth/status' ? json(statusResponse(false)) : json({}, 404)));
    mount();
    await screen.findByLabelText(/^اسم المستخدم/);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByLabelText(/رمز الإعداد/)).toBeNull();
  });
});
