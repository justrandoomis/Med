// AOS-21.42 made reachable: an AI action the server refuses with 409 CONSENT_REQUIRED (details.kind = 'ai_processing')
// no longer ends in an error. ONE dialog «تفعيل ميزات الذكاء الاصطناعي» (mounted once behind the session) shows the
// exact consent text of «الخصوصية والبيانات»; «وافق وفعّل» records the consent through the same API and the refused
// request is sent once more; «ليس الآن» closes it and nothing is sent. The home prompt opens the same dialog.
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AI_CONSENT_AR, AI_CONSENT_TEXT_VERSION, aiConsentTextAr, DATA_POLICY_VERSION, type AiConsentView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { api, ApiError, setFetchImpl } from '../../src/lib/api';
import { postStudyStream } from '../../src/features/studybook/streaming';
import { AiConsentNudge, AiConsentPrompt } from '../../src/features/me/AiConsentPrompt';

const LABEL = 'Anthropic (نماذج Claude)';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const view = (over: Partial<AiConsentView> = {}): AiConsentView => ({
  kind: 'ai_processing',
  provider: { id: 'anthropic', label_ar: LABEL, leaves_deployment: true },
  granted: false,
  providers: [],
  granted_at: null,
  text_version: null,
  current_text_version: AI_CONSENT_TEXT_VERSION,
  text_ar: aiConsentTextAr(LABEL),
  history: [],
  policy_version: DATA_POLICY_VERSION,
  ...over,
});
const consentRequired = () => json({ error: { code: 'CONSENT_REQUIRED', message: AI_CONSENT_AR.required(LABEL), details: { kind: 'ai_processing', provider: 'anthropic' } } }, 409);

let calls: Array<{ method: string; url: string; body: unknown }> = [];
/** a fake server: the AI route refuses until the consent PUT arrives */
function serve(opts: { consent?: AiConsentView } = {}) {
  calls = [];
  let state = opts.consent ?? view();
  setFetchImpl(async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.split('?')[0]!;
    if (path === '/api/accounts/me/ai-consent') {
      if (method === 'PUT') state = view({ granted: true, providers: ['anthropic'], granted_at: Date.UTC(2026, 10, 21), text_version: AI_CONSENT_TEXT_VERSION });
      return json(state);
    }
    if (path === '/api/ai/explain') return state.granted ? json({ ok: true, text: 'شرح' }) : consentRequired();
    if (path === '/api/ai/stream') {
      if (!state.granted) return consentRequired();
      return new Response('data: {"type":"final","result":{"ok":true},"removed":[]}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود.' } }, 404);
  });
}
function mount(extra: React.ReactNode = null) {
  render(
    <ToastProvider>
      <MemoryRouter>
        {extra}
        <AiConsentPrompt />
      </MemoryRouter>
    </ToastProvider>,
  );
}
afterEach(() => setFetchImpl(null));

const aiCalls = () => calls.filter((c) => c.url.startsWith('/api/ai/'));

describe('CONSENT_REQUIRED is answered by the consent dialog, centrally', () => {
  it('shows the dialog with the consent text; «وافق وفعّل» records the consent and retries the original request once', async () => {
    serve();
    mount();
    let result: unknown;
    const pending = api.post('/ai/explain', { region_id: 'r1' }).then((r) => (result = r));

    const dialog = await screen.findByRole('dialog', { name: 'تفعيل ميزات الذكاء الاصطناعي' });
    for (const line of aiConsentTextAr(LABEL)) expect(await screen.findByText(line)).toBeTruthy();
    expect(dialog.textContent).toContain(AI_CONSENT_TEXT_VERSION);

    fireEvent.click(screen.getByRole('button', { name: 'وافق وفعّل' }));
    await act(async () => {
      await pending;
    });
    expect(result).toEqual({ ok: true, text: 'شرح' });
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ granted: true, provider: 'anthropic', text_version: AI_CONSENT_TEXT_VERSION });
    // refused once, sent once more after the consent — never more
    expect(aiCalls().map((c) => c.method + ' ' + c.url)).toEqual(['POST /api/ai/explain', 'POST /api/ai/explain']);
    expect(aiCalls()[1]!.body).toEqual({ region_id: 'r1' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('«ليس الآن»: the dialog closes, no consent is sent, the request is not repeated (the caller gets the refusal)', async () => {
    serve();
    mount();
    const pending = api.post('/ai/explain', { region_id: 'r1' }).catch((e: unknown) => e);
    await screen.findByRole('dialog', { name: 'تفعيل ميزات الذكاء الاصطناعي' });
    await screen.findByText(aiConsentTextAr(LABEL)[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'ليس الآن' }));
    const err = await pending;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('CONSENT_REQUIRED');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(aiCalls()).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('two AI requests refused together share ONE dialog and are both retried after one consent', async () => {
    serve();
    mount();
    const a = api.post('/ai/explain', { n: 1 });
    const b = api.post('/ai/explain', { n: 2 });
    await screen.findByText(aiConsentTextAr(LABEL)[0]!);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'وافق وفعّل' }));
    await act(async () => {
      await Promise.all([a, b]);
    });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(aiCalls()).toHaveLength(4);
  });

  it('the streaming AI client (explain / chat) goes through the same dialog and retries once', async () => {
    serve();
    mount();
    const pending = postStudyStream<{ ok: boolean }>('/api/ai/stream', { q: 1 }, {});
    await screen.findByText(aiConsentTextAr(LABEL)[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'وافق وفعّل' }));
    let out: Awaited<typeof pending> | undefined;
    await act(async () => {
      out = await pending;
    });
    expect(out!.result).toEqual({ ok: true });
    expect(aiCalls()).toHaveLength(2);
  });

  it('other 409s are not consent: no dialog', async () => {
    calls = [];
    setFetchImpl(async () => json({ error: { code: 'CONFLICT', message: 'تعارض.' } }, 409));
    mount();
    await expect(api.post('/ai/explain', {})).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('home prompt while AI is configured and this account has not agreed', () => {
  it('«فعّلها» opens the same dialog; after agreeing the prompt goes away', async () => {
    serve();
    mount(<AiConsentNudge />);
    fireEvent.click(await screen.findByRole('button', { name: 'فعّلها' }));
    await screen.findByText(aiConsentTextAr(LABEL)[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'وافق وفعّل' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'فعّلها' })).toBeNull());
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('«إخفاء» dismisses it; nothing shows when consent is given or no provider is configured', async () => {
    serve();
    const { unmount } = render(
      <MemoryRouter>
        <AiConsentNudge />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'إخفاء' }));
    expect(screen.queryByRole('button', { name: 'فعّلها' })).toBeNull();
    unmount();
    localStorage.clear();

    serve({ consent: view({ granted: true }) });
    const granted = render(
      <MemoryRouter>
        <AiConsentNudge />
      </MemoryRouter>,
    );
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.queryByRole('button', { name: 'فعّلها' })).toBeNull();
    granted.unmount();

    serve({ consent: view({ provider: null }) });
    render(
      <MemoryRouter>
        <AiConsentNudge />
      </MemoryRouter>,
    );
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.queryByRole('button', { name: 'فعّلها' })).toBeNull();
  });
});
