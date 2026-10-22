// AOS-4.7 / ADR-0003 Q26 (track C3): «devices registered as shared always clear» — a person marks one of THEIR OWN
// devices as shared (`PATCH /api/accounts/me/devices/:deviceId {shared_device}`); the web client then clears that
// device's local data at every sign-out. Own devices only (another account's device is «not found»), audited, a revoked
// device cannot be changed, the body is strict.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DevicesResponse, DeviceView } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { addUser, type ExtraUser } from '../helpers/tenancy';

let t: TestApp;
let hA: AuthHeaders;
let b: ExtraUser;
let hB: AuthHeaders;

beforeAll(async () => {
  t = await createTestApp();
  hA = await t.login();
  b = await addUser(t, 'student-shared');
  hB = await b.login();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, h: AuthHeaders | null, payload?: unknown) =>
  t.app.inject({ method, url: `/api/accounts${url}`, headers: h ?? {}, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

describe('PATCH /api/accounts/me/devices/:deviceId — «جهاز مشترك»', () => {
  it('marks one of my devices as shared and back; the list says so; audited', async () => {
    expect((await req('POST', '/me/devices', hB, { device_id: 'library-pc', platform: 'web' })).statusCode).toBe(200);
    const on = await req('PATCH', '/me/devices/library-pc', hB, { shared_device: true });
    expect(on.statusCode, on.body).toBe(200);
    expect((on.json() as DeviceView).shared_device).toBe(true);
    const list = (await req('GET', '/me/devices', hB)).json() as DevicesResponse;
    expect(list.devices.find((d) => d.device_id === 'library-pc')?.shared_device).toBe(true);
    const off = (await req('PATCH', '/me/devices/library-pc', hB, { shared_device: false })).json() as DeviceView;
    expect(off.shared_device).toBe(false);
    const audited = t.ctx.system.db.all<{ action: string; summary: string }>("SELECT action, summary FROM security_audit WHERE actor_user_id = ? AND action = 'device_shared'", [b.user.id]);
    expect(audited.length).toBe(2);
  });

  it('another account’s device is not found (nothing changes); unauthenticated is refused', async () => {
    await req('POST', '/me/devices', hA, { device_id: 'owner-ipad', platform: 'ios' });
    const r = await req('PATCH', '/me/devices/owner-ipad', hB, { shared_device: true });
    expect(r.statusCode).toBe(404);
    const mine = (await req('GET', '/me/devices', hA)).json() as DevicesResponse;
    expect(mine.devices.find((d) => d.device_id === 'owner-ipad')?.shared_device).toBe(false);
    // without a session (and so without the CSRF header of a signed-in client): refused before anything is read
    expect([401, 403]).toContain((await req('PATCH', '/me/devices/owner-ipad', null, { shared_device: true })).statusCode);
  });

  it('a revoked device cannot be changed; the body is strict', async () => {
    await req('POST', '/me/devices', hB, { device_id: 'old-phone', platform: 'android' });
    expect((await req('DELETE', '/me/devices/old-phone', hB)).statusCode).toBe(200);
    expect((await req('PATCH', '/me/devices/old-phone', hB, { shared_device: true })).statusCode).toBe(404);
    for (const bad of [{}, { shared_device: 'yes' }, { shared_device: true, label: 'x' }]) {
      expect((await req('PATCH', '/me/devices/library-pc', hB, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });
});
