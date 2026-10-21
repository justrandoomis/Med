// P1-T1 step 1 — platform-only operations (ARCHITECTURE_DELTA §5.8). Today's whole-deployment routes are guarded in
// place: every one answers a signed-in non-admin with exactly the body of a missing route (404), before any handler
// runs; the platform admin keeps them. /api/platform/* is new and admin-only. The per-user parts stay per user: the
// Control Center storage report shows a user their OWN vault and files, never deployment-wide figures.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformStatusResponse, StorageResponse } from '@medlevo/shared';
import { isPlatformRoute, PLATFORM_ROUTES } from '../../src/modules/authz/routes';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { addUser, type ExtraUser } from '../helpers/tenancy';

let t: TestApp;
let hA: AuthHeaders;
let b: ExtraUser;
let hB: AuthHeaders;
const FAKE_ID = '01JDOESNOTEXIST0000000000AA';

beforeAll(async () => {
  t = await createTestApp();
  hA = await t.login();
  b = await addUser(t, 'student-b');
  hB = await b.login();
  // A owns a file; B owns nothing
  await t.ctx.files.put(randomBytes(64 * 1024), { mime: 'application/pdf', originalName: 'a-only.pdf' });
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const call = (entry: string, h: AuthHeaders | null) => {
  const [method, path] = entry.split(' ') as ['GET' | 'POST' | 'DELETE', string];
  const url = path.replace(/:[A-Za-z]+/g, FAKE_ID);
  return t.app.inject({ method, url, headers: h ?? {}, ...(method === 'POST' ? { payload: {} } : {}) });
};

describe('platform-only routes', () => {
  it('every guarded entry is a real mounted route (no typo can leave an operation unguarded)', () => {
    expect(PLATFORM_ROUTES.length).toBeGreaterThanOrEqual(16);
    for (const entry of PLATFORM_ROUTES) {
      const [method, url] = entry.split(' ') as ['GET' | 'POST' | 'DELETE', string];
      expect(t.app.hasRoute({ method, url }), entry).toBe(true);
      expect(isPlatformRoute(method, url)).toBe(true);
    }
    expect(isPlatformRoute('HEAD', '/api/data/backups')).toBe(true); // HEAD follows its GET
    expect(isPlatformRoute('GET', '/api/platform/status')).toBe(true);
    expect(isPlatformRoute('POST', '/api/control/client-errors')).toBe(false); // a user reports their own errors
    expect(isPlatformRoute('GET', '/api/control/storage')).toBe(false); // own storage
  });

  it('a signed-in non-admin gets exactly the body of a missing route for every one of them (and for /api/platform/*)', async () => {
    const missing = await t.app.inject({ method: 'GET', url: '/api/this-route-does-not-exist', headers: hB });
    expect(missing.statusCode).toBe(404);
    for (const entry of [...PLATFORM_ROUTES, 'GET /api/platform/status']) {
      const r = await call(entry, hB);
      expect(r.statusCode, entry).toBe(404);
      expect(r.body, entry).toBe(missing.body);
    }
    // nothing was started on B's behalf
    expect(t.ctx.system.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM job_index WHERE kind LIKE 'data_%'`)!.n).toBe(0);
  });

  it('without a session they are 401 like every other private route', async () => {
    for (const entry of ['GET /api/data/backups', 'GET /api/data/export/all', 'GET /api/platform/status']) expect((await call(entry, null)).statusCode, entry).toBe(401);
  });

  it('the platform admin keeps them; /api/platform/status counts the deployment without reading any vault', async () => {
    expect((await call('GET /api/data/backups', hA)).statusCode).toBe(200);
    expect((await call('GET /api/control/health', hA)).statusCode).toBe(200);
    expect((await call('GET /api/data/offsite', hA)).statusCode).toBe(200);
    const s = await call('GET /api/platform/status', hA);
    expect(s.statusCode, s.body).toBe(200);
    const status = s.json() as PlatformStatusResponse;
    expect(status.accounts).toEqual({ total: 2, active: 2, platform_admins: 1 });
    expect(status.vaults.total).toBe(2);
    expect(status.guarded_routes).toEqual([...PLATFORM_ROUTES]);
    expect(status.pool.max).toBeGreaterThan(0);
    expect(s.body).not.toContain('a-only.pdf');
    expect(s.body).not.toContain('student-b');
  });

  it('the storage report shows each user their OWN vault and files; deployment-wide figures only to the admin', async () => {
    const a = (await t.app.inject({ method: 'GET', url: '/api/control/storage', headers: hA })).json() as StorageResponse;
    const bb = (await t.app.inject({ method: 'GET', url: '/api/control/storage', headers: hB })).json() as StorageResponse;
    expect(a.files.count).toBe(1);
    expect(bb.files.count).toBe(0);
    expect(bb.files.bytes).toBe(0);
    expect(bb.backups).toEqual({ count: 0, bytes: 0 });
    expect(bb.other).toEqual([]);
    expect(bb.database.bytes).toBeGreaterThan(0); // B's own vault file
    expect(bb.total_bytes).toBeLessThan(a.total_bytes); // A's 64 KB file is not in B's total
    expect(JSON.stringify(bb)).not.toContain('a-only.pdf');
  });
});
