// P1-T1 step 1 — accounts and devices (/api/accounts; ARCHITECTURE_DELTA §7.2). Every route acts on the signed-in
// user's OWN account: there is no route that names another user, and another user's device is «not found».
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DevicesResponse, DeviceView, MeResponse } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, CSRF, type TestApp } from '../helpers/app';
import { addUser, type ExtraUser } from '../helpers/tenancy';

let t: TestApp;
let hA: AuthHeaders;
let b: ExtraUser;
let hB: AuthHeaders;
const key = () => randomBytes(32).toString('base64url');

beforeAll(async () => {
  t = await createTestApp();
  hA = await t.login();
  b = await addUser(t, 'student-b');
  hB = await b.login();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, h: AuthHeaders | null, payload?: unknown) =>
  t.app.inject({ method, url: `/api/accounts${url}`, headers: h ?? {}, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

describe('GET /api/accounts/me', () => {
  it('describes the signed-in user only: own vault, admin flag; memberships / roles empty until R1-c', async () => {
    const a = (await req('GET', '/me', hA)).json() as MeResponse;
    const bb = (await req('GET', '/me', hB)).json() as MeResponse;
    expect(a).toMatchObject({ username: 'owner', is_platform_admin: true, memberships: [], roles: [] });
    // P1-T1 step 2: the allowance of THIS account (user #1: no storage limit, the deployment's AI budget)
    expect(a.quota!.storage.limit_bytes).toBeNull();
    expect(a.quota!.storage.used_bytes).toBeGreaterThan(0);
    expect(bb).toMatchObject({ id: b.user.id, username: 'student-b', is_platform_admin: false, vault_id: b.vault.id, memberships: [], roles: [] });
    expect(a.vault_id).not.toBe(bb.vault_id);
    expect(JSON.stringify(a)).not.toMatch(/password|recovery|hash/i);
    expect((await req('GET', '/me', null)).statusCode).toBe(401);
  });
});

describe('devices', () => {
  it('register is idempotent per (user, device id); the server issues its own device_uid; each user has their own', async () => {
    const r1 = await req('POST', '/me/devices', hA, { device_id: 'phone-1', label: 'هاتفي', platform: 'android' });
    expect(r1.statusCode, r1.body).toBe(200);
    const d1 = r1.json() as DeviceView;
    expect(d1).toMatchObject({ device_id: 'phone-1', label: 'هاتفي', platform: 'android', has_key: false, revoked_at: null });
    expect(d1.device_uid).not.toBe('phone-1');
    expect(d1.device_uid.length).toBeGreaterThanOrEqual(16);
    const again = (await req('POST', '/me/devices', hA, { device_id: 'phone-1' })).json() as DeviceView;
    expect(again.device_uid).toBe(d1.device_uid);
    expect(again.label).toBe('هاتفي'); // an omitted label keeps the old one
    // the same client id on another account is another device
    const other = (await req('POST', '/me/devices', hB, { device_id: 'phone-1', platform: 'ios' })).json() as DeviceView;
    expect(other.device_uid).not.toBe(d1.device_uid);
    await req('POST', '/me/devices', hA, { device_id: 'tablet-a', platform: 'web' });
    const listA = (await req('GET', '/me/devices', hA)).json() as DevicesResponse;
    const listB = (await req('GET', '/me/devices', hB)).json() as DevicesResponse;
    expect(listA.devices.map((d) => d.device_id).sort()).toEqual(['phone-1', 'tablet-a']);
    expect(listB.devices.map((d) => d.device_id)).toEqual(['phone-1']);
    expect(listB.devices[0]!.platform).toBe('ios');
  });

  it('invalid device ids and bodies are refused with a reason', async () => {
    for (const body of [{ device_id: '' }, { device_id: 'a/b' }, { device_id: 'x'.repeat(65) }, { device_id: 'ok', platform: 'windows-phone' }, { device_id: 'ok', extra: 1 }]) {
      const r = await req('POST', '/me/devices', hA, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('a device key: Ed25519 only, 32 bytes; another user’s device is not found', async () => {
    const ok = await req('PUT', '/me/devices/phone-1/key', hA, { public_key: key(), alg: 'Ed25519' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as DeviceView).has_key).toBe(true);
    expect((await req('PUT', '/me/devices/phone-1/key', hA, { public_key: key().slice(1), alg: 'Ed25519' })).statusCode).toBe(400);
    expect((await req('PUT', '/me/devices/phone-1/key', hA, { public_key: key(), alg: 'RSA' })).statusCode).toBe(400);
    // B has no «tablet-a»: A's device is invisible to B (404, never 403)
    expect((await req('PUT', '/me/devices/tablet-a/key', hB, { public_key: key(), alg: 'Ed25519' })).statusCode).toBe(404);
    expect((await req('DELETE', '/me/devices/tablet-a', hB)).statusCode).toBe(404);
    expect(((await req('GET', '/me/devices', hA)).json() as DevicesResponse).devices.find((d) => d.device_id === 'tablet-a')!.revoked_at).toBeNull();
  });

  it('revoking clears the key; a revoked device is never revived by registering it again', async () => {
    expect((await req('DELETE', '/me/devices/phone-1', hA)).statusCode).toBe(200);
    const d = ((await req('GET', '/me/devices', hA)).json() as DevicesResponse).devices.find((x) => x.device_id === 'phone-1')!;
    expect(d.revoked_at).not.toBeNull();
    expect(d.has_key).toBe(false);
    const again = await req('POST', '/me/devices', hA, { device_id: 'phone-1' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toContain('أُلغي هذا الجهاز');
    expect((await req('PUT', '/me/devices/phone-1/key', hA, { public_key: key(), alg: 'Ed25519' })).statusCode).toBe(404);
    expect((await req('DELETE', '/me/devices/phone-1', hA)).statusCode).toBe(404); // already revoked
    // B's own «phone-1» is untouched
    expect(((await req('GET', '/me/devices', hB)).json() as DevicesResponse).devices[0]!.revoked_at).toBeNull();
  });

  it('security-relevant changes are recorded in the system audit of the acting user (no secrets in it)', () => {
    const rows = t.ctx.system.db.all<{ actor_user_id: string; action: string; details_json: string | null }>('SELECT actor_user_id, action, details_json FROM security_audit ORDER BY rowid');
    const ownerId = t.ctx.system.users.findForAuth('owner')!.id;
    const mine = rows.filter((r) => r.actor_user_id === ownerId).map((r) => r.action);
    expect(mine).toEqual(expect.arrayContaining(['device_register', 'device_key', 'device_revoke']));
    expect(rows.filter((r) => r.actor_user_id === b.user.id).map((r) => r.action)).not.toContain('device_revoke');
    expect(JSON.stringify(rows)).not.toMatch(/public_key|password|token/i);
  });

  it('every accounts route requires a session', async () => {
    for (const [m, u] of [
      ['GET', '/me/devices'],
      ['POST', '/me/devices'],
      ['DELETE', '/me/devices/x'],
      ['PUT', '/me/devices/x/key'],
      // P1-T1 step 2
      ['GET', '/me/quota'],
      ['POST', '/me/export'],
      ['GET', '/me/exports'],
      ['GET', '/me/exports/x/download'],
      ['POST', '/me/delete'],
    ] as const) {
      // CSRF header present, no session cookie
      const r = await t.app.inject({ method: m, url: `/api/accounts${u}`, headers: { ...CSRF }, ...(m === 'GET' || m === 'DELETE' ? {} : { payload: {} }) });
      expect(r.statusCode, `${m} ${u}`).toBe(401);
    }
  });
});

describe('device cap (P1-T1 step 2)', () => {
  it('one account cannot register more than 50 active devices; revoking one frees a place; re-registering a known device always works', async () => {
    const c = await addUser(t, 'student-c');
    const hc = await c.login();
    for (let i = 0; i < 50; i++) expect((await req('POST', '/me/devices', hc, { device_id: `dev-${i}` })).statusCode).toBe(200);
    const over = await req('POST', '/me/devices', hc, { device_id: 'dev-50' });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.message).toMatch(/الحد الأقصى/);
    expect((await req('POST', '/me/devices', hc, { device_id: 'dev-7', label: 'again' })).statusCode).toBe(200);
    expect((await req('DELETE', '/me/devices/dev-3', hc)).statusCode).toBe(200);
    expect((await req('POST', '/me/devices', hc, { device_id: 'dev-50' })).statusCode).toBe(200);
  });
});
