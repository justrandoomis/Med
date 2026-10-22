// AOS-21.42 (IA §4.14) — «الخصوصية والبيانات» holds the AI-processing consent naming the provider, recorded with «أوافق»
// and withdrawn with «اسحب موافقتي»; the written data-use policy is its own page, linked from «أنا» and from the privacy
// screen. No decorative control: with no provider configured there is nothing to agree to, and the page says so.
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AI_CONSENT_TEXT_VERSION, aiConsentTextAr, DATA_POLICY_VERSION, DATA_USE_POLICY_AR, type AiConsentView, type MeResponse } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { MeScreen } from '../../src/features/me/MeScreen';
import { PrivacyScreen } from '../../src/features/me/PrivacyScreen';
import { DataPolicyScreen } from '../../src/features/me/DataPolicyScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const base = (over: Partial<AiConsentView> = {}): AiConsentView => ({
  kind: 'ai_processing',
  provider: { id: 'anthropic', label_ar: 'Anthropic (نماذج Claude)', leaves_deployment: true },
  granted: false,
  providers: [],
  granted_at: null,
  text_version: null,
  current_text_version: AI_CONSENT_TEXT_VERSION,
  text_ar: aiConsentTextAr('Anthropic (نماذج Claude)'),
  history: [],
  policy_version: DATA_POLICY_VERSION,
  ...over,
});

let calls: Array<{ method: string; url: string; body: unknown }> = [];
function serve(routes: Record<string, (method: string, body: unknown) => Response>) {
  calls = [];
  setFetchImpl(async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.split('?')[0]!;
    const hit = Object.entries(routes).find(([p]) => path === p);
    return hit ? hit[1](method, body) : json({ error: { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' } }, 404);
  });
}
function show(path: string, element: React.ReactElement) {
  const router = createMemoryRouter([{ path, element }], { initialEntries: [path] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
}
afterEach(() => setFetchImpl(null));

const exportsRoute = { '/api/accounts/me/exports': () => json({ exports: [], included_ar: ['مصادرك'], note_ar: 'ملاحظة' }) };

describe('AOS-21.42 — AI-processing consent on «الخصوصية والبيانات»', () => {
  it('names the provider, shows the exact text, records «أوافق» with the text version, then offers to withdraw', async () => {
    let state = base();
    serve({
      ...exportsRoute,
      '/api/accounts/me/ai-consent': (m, body) => {
        if (m === 'PUT') {
          const b = body as { granted: boolean };
          state = b.granted
            ? base({ granted: true, providers: ['anthropic'], granted_at: Date.UTC(2026, 9, 22, 9), text_version: AI_CONSENT_TEXT_VERSION })
            : base({ history: [{ providers: ['anthropic'], text_version: AI_CONSENT_TEXT_VERSION, granted_at: Date.UTC(2026, 9, 22, 9), revoked_at: Date.UTC(2026, 9, 22, 10) }] });
        }
        return json(state);
      },
    });
    show('/me/privacy', <PrivacyScreen />);
    const section = (await screen.findByRole('heading', { level: 2, name: 'معالجة الذكاء الاصطناعي' })).closest('section')!;
    expect(await within(section).findByText(/لم توافق بعد/)).toBeTruthy();
    expect(within(section).getAllByText(/Anthropic \(نماذج Claude\)/).length).toBeGreaterThan(0);
    for (const line of aiConsentTextAr('Anthropic (نماذج Claude)')) expect(within(section).getByText(line)).toBeTruthy();
    expect(within(section).getByRole('link', { name: /سياسة استخدام البيانات/ }).getAttribute('href')).toBe('/me/privacy/policy');

    fireEvent.click(within(section).getByRole('button', { name: /أوافق على الإرسال/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ granted: true, provider: 'anthropic', text_version: AI_CONSENT_TEXT_VERSION });
    expect(await within(section).findByText(/وافقت على إرسال محتواك/)).toBeTruthy();

    fireEvent.click(within(section).getByRole('button', { name: 'اسحب موافقتي' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'اسحب الموافقة' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toContainEqual({ granted: false }));
    expect(await within(section).findByText(/لم توافق بعد/)).toBeTruthy();
    // the record of what was agreed to stays visible
    expect(within(section).getByText(/سُحبت/)).toBeTruthy();
  });

  it('no provider on this server: says nothing is sent anywhere, and offers nothing to press', async () => {
    serve({ ...exportsRoute, '/api/accounts/me/ai-consent': () => json(base({ provider: null, text_ar: aiConsentTextAr('مزوّد الذكاء الاصطناعي') })) });
    show('/me/privacy', <PrivacyScreen />);
    const section = (await screen.findByRole('heading', { level: 2, name: 'معالجة الذكاء الاصطناعي' })).closest('section')!;
    expect(await within(section).findByText(/لا يوجد مزوّد ذكاء اصطناعي مضبوط على هذا الخادم/)).toBeTruthy();
    expect(within(section).queryByRole('button')).toBeNull();
  });

  it('a provider inside the deployment needs no consent, and the page says why', async () => {
    serve({ ...exportsRoute, '/api/accounts/me/ai-consent': () => json(base({ provider: { id: 'local', label_ar: 'local', leaves_deployment: false } })) });
    show('/me/privacy', <PrivacyScreen />);
    const section = (await screen.findByRole('heading', { level: 2, name: 'معالجة الذكاء الاصطناعي' })).closest('section')!;
    expect(await within(section).findByText(/يعمل داخل هذا الخادم/)).toBeTruthy();
    expect(within(section).queryByRole('button')).toBeNull();
  });
});

describe('AOS-21.42 — the written data-use policy page', () => {
  it('shows every section of the policy and its version', async () => {
    show('/me/privacy/policy', <DataPolicyScreen />);
    expect(await screen.findByRole('heading', { level: 1, name: 'سياسة استخدام البيانات' })).toBeTruthy();
    for (const s of DATA_USE_POLICY_AR) {
      expect(screen.getByRole('heading', { level: 2, name: s.title })).toBeTruthy();
      for (const p of s.body) expect(screen.getByText(p)).toBeTruthy();
    }
    expect(screen.getByText(new RegExp(DATA_POLICY_VERSION))).toBeTruthy();
  });

  it('is linked from «أنا»', async () => {
    const ME = { id: 'u1', username: 'sara', display_name: 'سارة', is_platform_admin: false, vault_id: 'v1', timezone: 'Asia/Baghdad', memberships: [], roles: [], legacy_owner: false } as unknown as MeResponse;
    serve({ '/api/accounts/me': () => json(ME), '/api/channels/tree': () => json({ nodes: [], truncated: false }) });
    show('/me', <MeScreen />);
    await screen.findByRole('heading', { level: 1, name: 'أنا' });
    expect(screen.getByRole('link', { name: /^سياسة استخدام البيانات/ }).getAttribute('href')).toBe('/me/privacy/policy');
  });
});
