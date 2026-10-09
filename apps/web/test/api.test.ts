import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, fieldErrors, OFFLINE_MESSAGE_AR, setFetchImpl, setUnauthenticatedHandler } from '../src/lib/api';

type Call = { url: string; init: RequestInit };

function mockFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  setFetchImpl(async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  });
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  setFetchImpl(null);
  setUnauthenticatedHandler(null);
  vi.restoreAllMocks();
});

describe('api client', () => {
  it('sends the CSRF header, JSON body and same-origin credentials on POST', async () => {
    const calls = mockFetch(() => json({ ok: true }));
    const res = await api.post<{ ok: boolean }>('/auth/login', { username: 'owner', password: 'x' });
    expect(res).toEqual({ ok: true });
    const { url, init } = calls[0]!;
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-medlevo-csrf']).toBe('1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ username: 'owner', password: 'x' });
  });

  it('adds CSRF on every mutation method but never on GET', async () => {
    const calls = mockFetch(() => json({}));
    await api.get('/settings', { query: { a: 1, b: undefined } });
    await api.patch('/settings', { theme: 'dark' });
    await api.put('/x', {});
    await api.del('/auth/sessions/abc');
    expect(calls[0]!.url).toBe('/api/settings?a=1');
    expect((calls[0]!.init.headers as Record<string, string>)['x-medlevo-csrf']).toBeUndefined();
    for (const c of calls.slice(1)) expect((c.init.headers as Record<string, string>)['x-medlevo-csrf']).toBe('1');
    expect(calls[3]!.init.method).toBe('DELETE');
    expect(calls[3]!.init.body).toBeUndefined();
  });

  it('maps ApiErrorBody to ApiError with the server Arabic message, code, status and details', async () => {
    mockFetch(() => json({ error: { code: 'CONFLICT', message: 'يوجد تعارض مع نسخة أحدث.', details: { id: 'x' } } }, 409));
    const err = await api.post('/notes', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.code).toBe('CONFLICT');
    expect(e.status).toBe(409);
    expect(e.message).toBe('يوجد تعارض مع نسخة أحدث.');
    expect(e.details).toEqual({ id: 'x' });
    expect(e.offline).toBe(false);
  });

  it('maps validation issues to per-field messages', async () => {
    mockFetch(() =>
      json({ error: { code: 'VALIDATION_FAILED', message: 'بيانات غير صالحة.', details: { where: 'body', issues: [{ path: 'password', code: 'too_small', message: 'قصيرة جدًا.' }] } } }, 400),
    );
    const err = await api.post('/auth/setup', {}).catch((e: unknown) => e);
    expect(fieldErrors(err)).toEqual({ password: 'قصيرة جدًا.' });
  });

  it('distinguishes network failures as offline (never as a server answer)', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const e1 = (await api.get('/capabilities').catch((e: unknown) => e)) as ApiError;
    expect(e1).toBeInstanceOf(ApiError);
    expect(e1.offline).toBe(true);
    expect(e1.status).toBe(0);
    expect(e1.code).toBe('NETWORK_ERROR');

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const e2 = (await api.post('/sync/push', { ops: [] }).catch((e: unknown) => e)) as ApiError;
    expect(e2.code).toBe('OFFLINE');
    expect(e2.message).toBe(OFFLINE_MESSAGE_AR);
  });

  it('gives an Arabic message for non-JSON gateway errors', async () => {
    mockFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const e = (await api.get('/capabilities').catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(502);
    expect(e.code).toBe('INTERNAL');
    expect(/[؀-ۿ]/.test(e.message)).toBe(true);
  });

  it('calls the session-expired handler on 401 unless skipped', async () => {
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    mockFetch(() => json({ error: { code: 'UNAUTHENTICATED', message: 'سجّل الدخول.' } }, 401));
    await api.get('/settings').catch(() => {});
    expect(handler).toHaveBeenCalledTimes(1);
    await api.post('/auth/login', {}, { skipAuthRedirect: true }).catch(() => {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for 204 responses', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(api.del('/x')).resolves.toBeUndefined();
  });
});
