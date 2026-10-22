// AOS-4.7 / ADR-0003 Q26 (track C3): sign-out keeps local data by default; the option «امسح بيانات هذا الجهاز عند
// الخروج» clears this account's data on this device at sign-out; a device registered as shared («جهاز مشترك») always
// clears. «Clear» = the account's IndexedDB and its own keys — never another account's, never the device's keys — and
// never what has not reached the server: then the sign-out stops and asks.
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { DevicesResponse } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { MedLevoDB, resetSharedDb } from '../../src/lib/localdb';
import { setStorageAccount } from '../../src/lib/userStorage';

const syncNow = vi.fn(async () => undefined);
const stop = vi.fn();
vi.mock('../../src/lib/sync', async (orig) => ({ ...(await orig<typeof import('../../src/lib/sync')>()), getSyncEngine: () => ({ syncNow, stop }) }));

const { afterClear, clearAccountDeviceData, unsentOnThisDevice, CLEAR_ON_SIGN_OUT_KEY } = await import('../../src/lib/signOut');
const { LogoutGroup } = await import('../../src/features/settings/SecuritySection');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const exists = (name: string) => Dexie.exists(name);

async function seedDb(name: string, pending = 0): Promise<void> {
  const db = new MedLevoDB(name);
  await db.open();
  await db.kv.put({ key: 'probe', value: 1, updatedAt: 1 });
  for (let i = 0; i < pending; i++) {
    await db.outbox.add({ op_id: `op${i}${name}`, entity_type: 'note', entity_id: `n${i}`, op: 'upsert', payload: { body: 'نص لم يُرسل' }, client_ts: 1, status: 'pending', attempts: 0, nextAttemptAt: 0 });
  }
  db.close();
}

let logoutCalls = 0;
function serve(shared: boolean | null) {
  logoutCalls = 0;
  setFetchImpl(async (url, init) => {
    const path = url.split('?')[0]!;
    if (path === '/api/auth/logout' && (init?.method ?? 'GET') === 'POST') {
      logoutCalls++;
      return json({ ok: true });
    }
    if (path === '/api/accounts/me/devices') {
      const devices: DevicesResponse['devices'] =
        shared === null
          ? []
          : [{ device_id: 'd1', device_uid: 'U1', label: null, platform: 'web', has_key: false, shared_device: shared, first_seen_at: 1, last_seen_at: 1, revoked_at: null, current: true }];
      return json({ devices });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
}

function show() {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/settings" element={<LogoutGroup />} />
          <Route path="/login" element={<h1>تسجيل الدخول</h1>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

let went: string[] = [];
beforeEach(async () => {
  went = [];
  afterClear.go = (p: string) => void went.push(p);
  localStorage.clear();
  sessionStorage.clear();
  resetSharedDb();
  for (const n of ['medlevo:u1', 'medlevo:u2', 'medlevo']) await Dexie.delete(n);
  setStorageAccount({ userId: 'u1', legacy: false });
  syncNow.mockClear();
  stop.mockClear();
});
afterEach(() => {
  setFetchImpl(null);
  resetSharedDb();
  setStorageAccount(null);
});

describe('clearAccountDeviceData', () => {
  it('deletes this account’s database and keys only; another account and the device keep theirs', async () => {
    await seedDb('medlevo:u1');
    await seedDb('medlevo:u2');
    localStorage.setItem('u1:medlevo.capabilities.v1', '{}');
    localStorage.setItem('u1:medlevo.note-draft.x', '{}');
    sessionStorage.setItem('u1:medlevo.back', '[]');
    localStorage.setItem('u2:medlevo.capabilities.v1', '{}');
    localStorage.setItem('medlevo.appearance.v1', '{"theme":"dark"}');
    localStorage.setItem('medlevo.lastAuth.v1', '{}');
    const r = await clearAccountDeviceData({ userId: 'u1', legacy: false });
    expect(r.database).toBe('medlevo:u1');
    expect(r.keys).toBe(3);
    expect(await exists('medlevo:u1')).toBe(false);
    expect(await exists('medlevo:u2')).toBe(true);
    expect(localStorage.getItem('u2:medlevo.capabilities.v1')).toBe('{}');
    expect(localStorage.getItem('medlevo.appearance.v1')).toBe('{"theme":"dark"}');
    expect(Object.keys(localStorage).filter((k) => k.startsWith('u1:'))).toEqual([]);
  });

  it('user #1 holding the legacy namespace: the database «medlevo» and its un-prefixed keys go; device keys stay', async () => {
    await seedDb('medlevo');
    await seedDb('medlevo:u2');
    localStorage.setItem('medlevo.library.sort', 'title');
    localStorage.setItem('medlevo.display.v1', '{"eink":true}');
    localStorage.setItem('medlevo.legacyClaim.v1', '{"userId":"u1"}');
    localStorage.setItem('u2:medlevo.library.sort', 'date');
    await clearAccountDeviceData({ userId: 'u1', legacy: true });
    expect(await exists('medlevo')).toBe(false);
    expect(await exists('medlevo:u2')).toBe(true);
    expect(localStorage.getItem('medlevo.library.sort')).toBeNull();
    expect(localStorage.getItem('medlevo.display.v1')).toBe('{"eink":true}');
    expect(localStorage.getItem('u2:medlevo.library.sort')).toBe('date');
  });

  it('counts what has not reached the server: pending ops, unacknowledged conflicts, drafts', async () => {
    await seedDb('medlevo:u1', 2);
    const db = new MedLevoDB('medlevo:u1');
    await db.outbox.add({ op_id: 'c1', entity_type: 'note', entity_id: 'n9', op: 'upsert', payload: null, client_ts: 1, status: 'conflict', attempts: 1, nextAttemptAt: 0 });
    await db.outbox.add({ op_id: 'c2', entity_type: 'note', entity_id: 'n8', op: 'upsert', payload: null, client_ts: 1, status: 'conflict', attempts: 1, nextAttemptAt: 0, acknowledgedAt: 5 });
    localStorage.setItem('u1:medlevo.note-draft.k', '{}');
    localStorage.setItem('u1:medlevo.cases.editor.new-case', '{}');
    expect(await unsentOnThisDevice(db)).toEqual({ pending: 2, unresolved: 1, drafts: 2, uploads: 0, total: 5 });
    db.close();
  });
});

describe('«تسجيل الخروج من هذا الجهاز»', () => {
  it('by default the data stays: signed out, the database and keys are still here', async () => {
    serve(false);
    await seedDb('medlevo:u1');
    localStorage.setItem('u1:medlevo.capabilities.v1', '{}');
    show();
    const box = (await screen.findByRole('checkbox', { name: /امسح بيانات هذا الجهاز عند الخروج/ })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));
    await screen.findByRole('heading', { name: 'تسجيل الدخول' });
    expect(logoutCalls).toBe(1);
    expect(await exists('medlevo:u1')).toBe(true);
    expect(localStorage.getItem('u1:medlevo.capabilities.v1')).toBe('{}');
  });

  it('with «امسح بيانات هذا الجهاز عند الخروج» ticked: signed out, then this account’s data on this device is gone', async () => {
    serve(false);
    await seedDb('medlevo:u1');
    await seedDb('medlevo:u2');
    localStorage.setItem('u1:medlevo.capabilities.v1', '{}');
    show();
    fireEvent.click(await screen.findByRole('checkbox', { name: /امسح بيانات هذا الجهاز عند الخروج/ }));
    expect(localStorage.getItem(`u1:${CLEAR_ON_SIGN_OUT_KEY}`)).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));
    await waitFor(() => expect(went).toEqual(['/login']));
    expect(logoutCalls).toBe(1);
    expect(syncNow).toHaveBeenCalled();
    expect(await exists('medlevo:u1')).toBe(false);
    expect(await exists('medlevo:u2')).toBe(true);
    expect(Object.keys(localStorage).filter((k) => k.startsWith('u1:'))).toEqual([]);
  });

  it('something has not reached the server: nothing is cleared, the person chooses — keeping it here signs out without clearing', async () => {
    serve(false);
    await seedDb('medlevo:u1', 3);
    localStorage.setItem(`u1:${CLEAR_ON_SIGN_OUT_KEY}`, 'true');
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'تسجيل الخروج' }));
    const dialog = await screen.findByRole('dialog', { name: 'لم تصل كل بياناتك إلى الخادم' });
    expect(dialog.textContent).toContain('3 تغييرات تنتظر الإرسال');
    expect(logoutCalls).toBe(0);
    expect(await exists('medlevo:u1')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'اخرج واحتفظ بها على هذا الجهاز' }));
    await screen.findByRole('heading', { name: 'تسجيل الدخول' });
    expect(logoutCalls).toBe(1);
    expect(await exists('medlevo:u1')).toBe(true);
    const db = new MedLevoDB('medlevo:u1');
    expect(await db.outbox.where('status').equals('pending').count()).toBe(3);
    db.close();
  });

  it('a device registered as shared always clears: the option is on and cannot be turned off here', async () => {
    serve(true);
    await seedDb('medlevo:u1');
    show();
    const box = (await screen.findByRole('checkbox', { name: /امسح بيانات هذا الجهاز عند الخروج/ })) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/هذا الجهاز مسجّل جهازًا مشتركًا/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));
    await waitFor(() => expect(went).toEqual(['/login']));
    expect(await exists('medlevo:u1')).toBe(false);
  });
});

describe('«أجهزتي» — «هذا جهاز مشترك»', () => {
  it('marks THIS device as shared on the server (PATCH, own device only)', async () => {
    const { DevicesScreen } = await import('../../src/features/me/DevicesScreen');
    const sent: Array<{ method: string; url: string; body: unknown }> = [];
    let shared = false;
    setFetchImpl(async (url, init) => {
      const method = init?.method ?? 'GET';
      sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith('/api/accounts/me/devices/d1') && method === 'PATCH') {
        shared = (JSON.parse(String(init!.body)) as { shared_device: boolean }).shared_device;
        return json({ device_id: 'd1', device_uid: 'U1', label: 'هذا المتصفح', platform: 'web', has_key: false, shared_device: shared, first_seen_at: 1, last_seen_at: 1, revoked_at: null, current: true });
      }
      if (url.startsWith('/api/accounts/me/devices'))
        return json({ devices: [{ device_id: 'd1', device_uid: 'U1', label: 'هذا المتصفح', platform: 'web', has_key: false, shared_device: shared, first_seen_at: 1, last_seen_at: 1, revoked_at: null, current: true }] });
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    render(
      <ToastProvider>
        <MemoryRouter>
          <DevicesScreen />
        </MemoryRouter>
      </ToastProvider>,
    );
    const sw = await screen.findByRole('switch', { name: 'هذا جهاز مشترك' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(sent.some((c) => c.method === 'PATCH')).toBe(true));
    expect(sent.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/accounts/me/devices/d1', body: { shared_device: true } });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'هذا جهاز مشترك' }).getAttribute('aria-checked')).toBe('true'));
  });

  // the first sign-in on a library computer: nothing synced yet, and the session was opened before this account had a
  // local device id — the server does not know this browser. Found by e2e/aos-c3-iphone-sizes.spec.ts: «هذا جهاز
  // مشترك» was missing exactly where it matters most. The page knows its own device id: it registers it, then marks it.
  it('a device the server does not know yet (first sign-in, nothing synced): registered on the spot, then marked shared', async () => {
    const { DevicesScreen } = await import('../../src/features/me/DevicesScreen');
    const { getDeviceId } = await import('../../src/lib/deviceId');
    const mine = await getDeviceId();
    const sent: Array<{ method: string; url: string; body: unknown }> = [];
    const known: Array<Record<string, unknown>> = [];
    const view = (shared: boolean) => ({ device_id: mine, device_uid: 'U9', label: 'هذا المتصفح', platform: 'web', has_key: false, shared_device: shared, first_seen_at: 1, last_seen_at: 1, revoked_at: null, current: false });
    setFetchImpl(async (url, init) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ method, url, body });
      if (url === '/api/accounts/me/devices' && method === 'POST') {
        known.push(view(false));
        return json(view(false), 201);
      }
      if (url === `/api/accounts/me/devices/${mine}` && method === 'PATCH') {
        if (known.length === 0) return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
        known[0] = view((body as { shared_device: boolean }).shared_device);
        return json(known[0]);
      }
      if (url.startsWith('/api/accounts/me/devices')) return json({ devices: known });
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    render(
      <ToastProvider>
        <MemoryRouter>
          <DevicesScreen />
        </MemoryRouter>
      </ToastProvider>,
    );
    const sw = await screen.findByRole('switch', { name: 'هذا جهاز مشترك' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(sent.some((c) => c.method === 'PATCH')).toBe(true));
    const writes = sent.filter((c) => c.method !== 'GET');
    expect(writes[0]).toMatchObject({ method: 'POST', url: '/api/accounts/me/devices', body: { device_id: mine } });
    expect(writes[1]).toMatchObject({ method: 'PATCH', url: `/api/accounts/me/devices/${mine}`, body: { shared_device: true } });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'هذا جهاز مشترك' }).getAttribute('aria-checked')).toBe('true'));
    // and sign-out knows this browser is shared — by its own device id, not only by the session's
    const { currentDeviceIsShared } = await import('../../src/lib/signOut');
    expect(await currentDeviceIsShared()).toBe(true);
  });
});
