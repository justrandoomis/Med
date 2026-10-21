// P1-T1 step 3 — what the web client sends so the server can refuse a stale client or another account's tab
// (ARCHITECTURE_DELTA §4.5, §8.7; server side: apps/server/test/tenancy/client-gate.test.ts):
//   * every request carries `x-medlevo-client` (this build's version) — fetch wrapper, streamed requests, uploads and
//     the error reporter; and `x-medlevo-user` (the page's account) once the page belongs to one;
//   * a 426 CLIENT_TOO_OLD calls the update handler (the waiting service worker is applied);
//   * signing in as somebody does not borrow the previous account's device id (no account → no device id sent).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, apiFetch, CLIENT_VERSION, setClientTooOldHandler, setFetchImpl } from '../../src/lib/api';
import { login } from '../../src/lib/auth';
import { resetDeviceIdCache } from '../../src/lib/deviceId';
import { postMultipart, setXhrFactory, type XhrLike } from '../../src/features/upload/uploadXhr';
import { setStorageAccount } from '../../src/lib/userStorage';

const B = '01JBBBBBBBBBBBBBBBBBBBBBBB';
type Call = { url: string; init: RequestInit };
let calls: Call[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  setStorageAccount(null);
  resetDeviceIdCache();
  setFetchImpl(async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/too-old')) return json({ error: { code: 'CLIENT_TOO_OLD', message: 'حدّث التطبيق' } }, 426);
    return json({ ok: true, session: { id: 's' } });
  });
});
afterEach(() => {
  setFetchImpl(null);
  setClientTooOldHandler(null);
  setStorageAccount(null);
  vi.restoreAllMocks();
});

const headersOf = (c: Call) => c.init.headers as Record<string, string>;

describe('client headers', () => {
  it('every request carries the client version; the account header only once the page has an account', async () => {
    await api.get('/library/tree');
    expect(headersOf(calls[0]!)['x-medlevo-client']).toBe(CLIENT_VERSION);
    expect(headersOf(calls[0]!)['x-medlevo-user']).toBeUndefined();
    setStorageAccount({ userId: B, legacy: false });
    await api.post('/sync/push', { ops: [] });
    expect(headersOf(calls[1]!)).toMatchObject({ 'x-medlevo-client': CLIENT_VERSION, 'x-medlevo-user': B, 'x-medlevo-csrf': '1' });
  });

  it('streamed requests get them too, and keep the caller’s headers as a plain object', async () => {
    setStorageAccount({ userId: B, legacy: false });
    await apiFetch('/studybook/explain/stream', { method: 'POST', headers: { 'x-medlevo-csrf': '1', accept: 'text/event-stream' } });
    expect(headersOf(calls[0]!)).toMatchObject({ 'x-medlevo-csrf': '1', accept: 'text/event-stream', 'x-medlevo-client': CLIENT_VERSION, 'x-medlevo-user': B });
  });

  it('multipart uploads (XHR) carry them', async () => {
    setStorageAccount({ userId: B, legacy: false });
    const set: Record<string, string> = {};
    const xhr = {
      upload: {} as XhrLike['upload'],
      open: () => undefined,
      setRequestHeader: (k: string, v: string) => (set[k] = v),
      send: () => undefined,
      abort: () => undefined,
    } as unknown as XhrLike;
    setXhrFactory(() => xhr);
    postMultipart('/sources/upload', new FormData(), () => undefined);
    setXhrFactory(null);
    expect(set).toMatchObject({ 'x-medlevo-client': CLIENT_VERSION, 'x-medlevo-user': B });
  });

  it('a 426 asks the app to apply its update', async () => {
    const handler = vi.fn();
    setClientTooOldHandler(handler);
    await expect(api.post('/too-old', {})).rejects.toMatchObject({ status: 426, code: 'CLIENT_TOO_OLD' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('signing in from a page without an account sends no device id (it would be another account’s)', async () => {
    await login('student_b', 'password-123456');
    const body = JSON.parse(String(calls.at(-1)!.init.body)) as { device_id?: string };
    expect(body.device_id).toBeUndefined();
  });
});
