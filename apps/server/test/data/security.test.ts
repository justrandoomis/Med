// Security hardening (§49): first-run setup token (loopback vs non-loopback vs proxy vs explicit token), token
// never stored, rate limits; every /api/data route requires the owner session (and CSRF for mutations).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthStatusResponse } from '@medlevo/shared';
import { isLoopbackHost } from '../../src/modules/auth';
import { createAuthModule } from '../../src/modules/auth';
import { MODULES } from '../../src/modules';
import { createTestApp, CSRF, OWNER, type TestApp } from '../helpers/app';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

async function appWith(opts: { host?: string; trustProxy?: boolean; setupToken?: string | null; origin?: string }) {
  let announced: string | null = null;
  const t = await createTestApp({
    env: {
      ...(opts.host ? { MEDLEVO_HOST: opts.host } : {}),
      ...(opts.trustProxy ? { MEDLEVO_TRUST_PROXY: 'true' } : {}),
      ...(opts.origin ? { MEDLEVO_ORIGIN: opts.origin } : {}),
    },
    modules: MODULES.map((m) =>
      m.name === 'auth' ? { ...m, plugin: createAuthModule({ setupToken: opts.setupToken === undefined ? null : opts.setupToken, announceSetupToken: (tok) => (announced = tok) }) } : m,
    ),
  });
  apps.push(t);
  return { t, token: () => announced };
}

const status = async (t: TestApp) => (await t.app.inject({ method: 'GET', url: '/api/auth/status' })).json() as AuthStatusResponse;
const setup = (t: TestApp, extra: Record<string, unknown> = {}) =>
  t.app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { username: OWNER.username, password: OWNER.password, ...extra } });

describe('first-run setup token', () => {
  it('loopback-only server (default 127.0.0.1): today\'s flow, no token, nothing announced', async () => {
    const { t, token } = await appWith({});
    expect((await status(t)).setup_token_required).toBeUndefined();
    expect(token()).toBeNull();
    expect((await setup(t)).statusCode).toBe(200);
  });

  it('non-loopback host: setup requires the one-time token printed at boot; wrong / missing → 403; right → 200; then gone', async () => {
    const { t, token } = await appWith({ host: '0.0.0.0' });
    const tok = token();
    expect(tok).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/); // 20 symbols of 32 = 100 bits
    expect((await status(t)).setup_token_required).toBe(true);
    const missing = await setup(t);
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.message).toContain('سجل تشغيل الخادم');
    expect((await setup(t, { setup_token: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH' })).statusCode).toBe(403);
    // the token is tolerant to case / spacing (copied from a log) but never stored in the database
    const ok = await setup(t, { setup_token: ` ${tok!.toLowerCase()} ` });
    expect(ok.statusCode, ok.body).toBe(200);
    const s = await status(t);
    expect(s.setup_required).toBe(false);
    expect(s.setup_token_required).toBeUndefined();
    t.ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dbBytes = readFileSync(t.config.dbPath);
    expect(dbBytes.includes(Buffer.from(tok!))).toBe(false);
    expect(dbBytes.includes(Buffer.from(tok!.replace(/-/g, '')))).toBe(false);
    // a second setup is impossible anyway
    expect((await setup(t, { setup_token: tok })).statusCode).toBe(409);
  });

  it('behind a reverse proxy (MEDLEVO_TRUST_PROXY) the token is required even on loopback', async () => {
    const { t, token } = await appWith({ trustProxy: true });
    expect(token()).not.toBeNull();
    expect((await status(t)).setup_token_required).toBe(true);
    expect((await setup(t)).statusCode).toBe(403);
  });

  it('a loopback listener whose web origin is NOT loopback (proxy / tunnel without MEDLEVO_TRUST_PROXY) also requires the token', async () => {
    const { t, token } = await appWith({ origin: 'https://medlevo.example' });
    expect(token()).not.toBeNull();
    expect((await status(t)).setup_token_required).toBe(true);
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/setup', headers: { ...CSRF, origin: 'https://medlevo.example' }, payload: { username: OWNER.username, password: OWNER.password } });
    expect(res.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: '/api/auth/setup', headers: { ...CSRF, origin: 'https://medlevo.example' }, payload: { username: OWNER.username, password: OWNER.password, setup_token: token() } });
    expect(ok.statusCode, ok.body).toBe(200);
    // a loopback origin list (the default dev origin, plus 127.0.0.1) keeps today's flow
    const local = await appWith({ origin: 'http://localhost:5173,http://127.0.0.1:8787' });
    expect(local.token()).toBeNull();
    expect((await status(local.t)).setup_token_required).toBeUndefined();
  });

  it('MEDLEVO_SETUP_TOKEN: required even on loopback, exact match, no one-time token generated', async () => {
    const { t, token } = await appWith({ setupToken: 'my-own-setup-secret-123' });
    expect(token()).toBeNull();
    expect((await status(t)).setup_token_required).toBe(true);
    expect((await setup(t, { setup_token: 'MY-OWN-SETUP-SECRET-123' })).statusCode).toBe(403);
    expect((await setup(t, { setup_token: 'my-own-setup-secret-123' })).statusCode).toBe(200);
  });

  it('guessing is rate limited (5 wrong tokens per minute per address → 429)', async () => {
    const { t } = await appWith({ host: '0.0.0.0' });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await setup(t, { setup_token: `WRONG-${i}` })).statusCode);
    expect(codes.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(codes.slice(5)).toContain(429);
  });

  it('isLoopbackHost', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.10', 'medlevo.example', '10.0.0.1']) expect(isLoopbackHost(h), h).toBe(false);
  });
});

describe('every /api/data route needs the owner session (and CSRF for mutations)', () => {
  const ID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
  const routes: Array<[string, string]> = [
    ['GET', `/api/data/offline/${ID}/manifest`],
    ['GET', `/api/data/offline/${ID}/bundle`],
    ['GET', `/api/data/offline/${ID}/learning`],
    ['GET', '/api/data/epoch'],
    ['GET', '/api/data/backups'],
    ['POST', '/api/data/backups'],
    ['GET', `/api/data/backups/${ID}`],
    ['POST', `/api/data/backups/${ID}/verify`],
    ['GET', `/api/data/backups/${ID}/download`],
    ['DELETE', `/api/data/backups/${ID}`],
    ['GET', '/api/data/export/formats'],
    ['GET', `/api/data/export/source/${ID}?format=md`],
    ['GET', `/api/data/export/artifact/${ID}?format=md`],
    ['GET', '/api/data/export/notes?format=md'],
    ['GET', '/api/data/export/questions?format=md'],
    ['GET', '/api/data/export/all?format=json'],
  ];

  it('401 without a session; 403 without the CSRF header on mutations even with a session', async () => {
    const t = await createTestApp();
    apps.push(t);
    const h = await t.login();
    for (const [method, url] of routes) {
      const res = await t.app.inject({ method: method as 'GET', url, headers: method === 'GET' ? {} : CSRF, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    for (const [method, url] of routes.filter(([m]) => m !== 'GET')) {
      const res = await t.app.inject({ method: method as 'POST', url, headers: { cookie: h.cookie }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // percent-encoded path cannot bypass the guard
    expect((await t.app.inject({ method: 'GET', url: '/%61pi/data/backups' })).statusCode).toBe(401);
  });

  it('backup endpoints answer specific errors (404 unknown, 409 verify of an unfinished backup)', async () => {
    const t = await createTestApp();
    apps.push(t);
    const h = await t.login();
    expect((await t.app.inject({ method: 'GET', url: `/api/data/backups/${ID}`, headers: h })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/data/backups/${ID}/download`, headers: h })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/data/backups/${ID}`, headers: h })).statusCode).toBe(404);
    const created = await t.app.inject({ method: 'POST', url: '/api/data/backups', headers: h, payload: {} });
    const id = created.json().backup.id as string;
    expect((await t.app.inject({ method: 'POST', url: `/api/data/backups/${id}/verify`, headers: h, payload: {} })).statusCode).toBe(409);
    await t.ctx.jobs.drain();
    const verify = await t.app.inject({ method: 'POST', url: `/api/data/backups/${id}/verify`, headers: h, payload: {} });
    expect(verify.statusCode, verify.body).toBe(200);
    await t.ctx.jobs.drain();
    const after = (await t.app.inject({ method: 'GET', url: `/api/data/backups/${id}`, headers: h })).json().backup;
    expect(after.verification.status, JSON.stringify(after.verification)).toBe('passed');
    expect(after.verification.summary_ar).toContain('شُغّل الخادم');
    const del = await t.app.inject({ method: 'DELETE', url: `/api/data/backups/${id}`, headers: h });
    expect(del.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: `/api/data/backups/${id}/download`, headers: h })).statusCode).toBe(404);
    // audited
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM change_log WHERE entity_type = 'backup'")!.n).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('capabilities are honest: offline/backup/export available, DOCX not implemented with a reason', async () => {
    const t = await createTestApp();
    apps.push(t);
    const h = await t.login();
    const caps = (await t.app.inject({ method: 'GET', url: '/api/capabilities', headers: h })).json().features;
    for (const k of ['offline', 'backup', 'export.markdown', 'export.pdf']) expect(caps[k].state, k).toBe('available');
    expect(caps['export.docx'].state).toBe('not_implemented');
    expect(caps['export.docx'].reason_ar).toContain('DOCX');
  });
});
