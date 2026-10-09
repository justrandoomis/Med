import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OWNER_SETTINGS } from '@medlevo/shared';
import { setFetchImpl, setUnauthenticatedHandler } from '../src/lib/api';
import { fetchAuthStatus, logout } from '../src/lib/auth';
import { settingsStore } from '../src/lib/settings';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauth = () => json({ error: { code: 'UNAUTHENTICATED', message: 'انتهت الجلسة. سجّل الدخول مرة أخرى.' } }, 401);

const STATUS_SIGNED_IN = {
  setup_required: false,
  authenticated: true,
  owner: { username: 'owner' },
  session: null,
  remaining_recovery_codes: 10,
  password_min_length: 12,
};

afterEach(() => {
  setFetchImpl(null);
  setUnauthenticatedHandler(null);
});

describe('logout', () => {
  beforeEach(async () => {
    setFetchImpl(async () => json(STATUS_SIGNED_IN));
    await fetchAuthStatus({ force: true }); // this device is now remembered as signed in
  });

  it('keeps the device signed in (locally too) when the sign-out request fails', async () => {
    // Regression: logout() forgot the local "signed in" state in `finally`, even when the request never
    // reached the server — the session cookie stayed valid but the app could no longer open offline.
    setFetchImpl(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(logout()).rejects.toMatchObject({ offline: true });
    const r = await fetchAuthStatus({ force: true });
    expect(r.kind).toBe('offline');
    expect(r.kind === 'offline' && r.cached?.authenticated).toBe(true);
  });

  it('forgets the local state once the server confirmed (or the session was already gone)', async () => {
    setFetchImpl(async () => unauth());
    await expect(logout()).resolves.toBeUndefined();
    setFetchImpl(async () => {
      throw new TypeError('Failed to fetch');
    });
    const r = await fetchAuthStatus({ force: true });
    expect(r.kind === 'offline' && r.cached).toBeNull();
  });
});

describe('settings store', () => {
  it('a 401 keeps every pending change on the device (no redirect) and sends it after sign-in', async () => {
    // Regression: any non-offline failure (incl. an expired session) discarded ALL pending changes.
    const redirect = vi.fn();
    setUnauthenticatedHandler(redirect);
    setFetchImpl(async () => unauth());
    await settingsStore.update({ dialect: 'iraqi_teaching' });
    expect(settingsStore.get().save).toBe('pending_auth');
    expect(settingsStore.get().settings.dialect).toBe('iraqi_teaching');
    expect(JSON.parse(window.localStorage.getItem('medlevo.settings.pending.v1') ?? '{}')).toMatchObject({ dialect: 'iraqi_teaching' });
    expect(redirect).not.toHaveBeenCalled();

    // signed in again: load() → the pending patch goes out
    const sent: unknown[] = [];
    let server = { ...DEFAULT_OWNER_SETTINGS };
    setFetchImpl(async (url, init) => {
      if (init.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as Partial<typeof server>;
        sent.push(patch);
        server = { ...server, ...patch };
      }
      return json({ settings: server });
    });
    await settingsStore.load();
    await settingsStore.flush();
    expect(sent).toEqual([{ dialect: 'iraqi_teaching' }]);
    expect(settingsStore.get().save).toBe('saved');
    expect(window.localStorage.getItem('medlevo.settings.pending.v1')).toBeNull();
  });

  it('a validation error drops only what was sent; a change made meanwhile is still sent', async () => {
    let releaseFirst!: (r: Response) => void;
    const first = new Promise<Response>((r) => (releaseFirst = r));
    const patches: unknown[] = [];
    let server = { ...DEFAULT_OWNER_SETTINGS };
    setFetchImpl(async (_url, init) => {
      if (init.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as Partial<typeof server>;
        patches.push(patch);
        if (patches.length === 1) return first;
        server = { ...server, ...patch };
      }
      return json({ settings: server });
    });
    const a = settingsStore.update({ answer_style: 'literal' }); // in flight
    const b = settingsStore.update({ margin_density: 'rich' }); // made while A is in flight
    releaseFirst(json({ error: { code: 'VALIDATION_FAILED', message: 'قيمة غير مقبولة.' } }, 400));
    await a;
    await b;
    await settingsStore.flush();
    expect(patches[0]).toEqual({ answer_style: 'literal' });
    expect(patches).toContainEqual({ margin_density: 'rich' });
    expect(server.margin_density).toBe('rich');
    expect(window.localStorage.getItem('medlevo.settings.pending.v1')).toBeNull();
  });
});
