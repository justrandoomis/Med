// PL-0: the client address behind a PaaS proxy chain. Render puts Cloudflare and its own load balancers in front of
// a web service; X-Forwarded-For then reads «<whatever the client sent>, <client>, <Cloudflare edge>, <Render LB>»,
// i.e. the LEFT-most entries are written by the client and can be forged. The login rate limiter and the session
// list record the client address, so a forged X-Forwarded-For must never change it. These tests drive the real app
// (fastify.inject with a socket peer address) under each supported MEDLEVO_TRUST_PROXY form.
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthModule } from '../../src/modules/auth';
import { MODULES } from '../../src/modules';
import { createTestApp, CSRF, OWNER, sessionCookie, type TestApp } from '../helpers/app';

const SETUP_TOKEN = 'paas-setup-token-for-tests-0123456789';
const CLIENT = '198.51.100.7'; // the real phone, as Cloudflare saw it
const OTHER_CLIENT = '203.0.113.50';
const CF_EDGE = '172.71.10.20'; // in Cloudflare's published 172.64.0.0/13
const LB_INNER = '10.10.0.5'; // Render's own proxy hop
const PEER = '10.201.3.4'; // the TCP peer of the app: Render's load balancer
const chain = (forged: string, client = CLIENT) => `${forged}, ${client}, ${CF_EDGE}, ${LB_INNER}`;

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

async function appWith(env: Record<string, string>): Promise<TestApp> {
  const t = await createTestApp({
    env,
    modules: MODULES.map((m) => (m.name === 'auth' ? { ...m, plugin: createAuthModule({ setupToken: SETUP_TOKEN }) } : m)),
  });
  apps.push(t);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    remoteAddress: PEER,
    headers: { ...CSRF },
    payload: { username: OWNER.username, password: OWNER.password, setup_token: SETUP_TOKEN },
  });
  expect(res.statusCode, res.body).toBe(200);
  return t;
}

const badLogin = (t: TestApp, headers: Record<string, string>, remoteAddress = PEER) =>
  t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, headers: { ...CSRF, ...headers }, payload: { username: OWNER.username, password: 'wrong-password-123' } });

const goodLogin = (t: TestApp, headers: Record<string, string>, remoteAddress = PEER) =>
  t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, headers: { ...CSRF, ...headers }, payload: { username: OWNER.username, password: OWNER.password } });

const attemptIps = (t: TestApp) => t.ctx.db.all<{ ip: string }>('SELECT ip FROM login_attempt WHERE succeeded = 0 ORDER BY created_at, id').map((r) => r.ip);

/** 5 failures from one client, each with a DIFFERENT forged X-Forwarded-For head; the 6th must still be refused */
async function expectForgedXffDoesNotEscape(t: TestApp, headersFor: (forged: string) => Record<string, string>) {
  for (let i = 0; i < 5; i++) expect((await badLogin(t, headersFor(`192.0.2.${i + 1}`))).statusCode).toBe(401);
  const sixth = await badLogin(t, headersFor('192.0.2.99'));
  expect(sixth.statusCode, sixth.body).toBe(429);
  expect(sixth.json().error.code).toBe('RATE_LIMITED');
}

describe('client address behind Render (MEDLEVO_TRUST_PROXY=1 + MEDLEVO_CLIENT_IP_HEADER=cf-connecting-ip)', () => {
  const env = { MEDLEVO_TRUST_PROXY: '1', MEDLEVO_CLIENT_IP_HEADER: 'cf-connecting-ip' };

  it('a forged X-Forwarded-For never changes the address the login limiter sees', async () => {
    const t = await appWith(env);
    await expectForgedXffDoesNotEscape(t, (forged) => ({ 'x-forwarded-for': chain(forged), 'cf-connecting-ip': CLIENT }));
    // every attempt was recorded under the real client, never under a forged value
    const ips = attemptIps(t);
    expect(ips.length).toBe(5); // the refused 6th attempt is not recorded
    expect(new Set(ips)).toEqual(new Set([CLIENT]));
    // another phone is not punished for the first one's failures (per-client, not global)
    expect((await badLogin(t, { 'x-forwarded-for': chain('192.0.2.1', OTHER_CLIENT), 'cf-connecting-ip': OTHER_CLIENT })).statusCode).toBe(401);
  });

  it('the session records the real client address', async () => {
    const t = await appWith(env);
    const res = await goodLogin(t, { 'x-forwarded-for': chain('6.6.6.6'), 'cf-connecting-ip': CLIENT });
    expect(res.statusCode, res.body).toBe(200);
    const list = await t.app.inject({ method: 'GET', url: '/api/auth/sessions', remoteAddress: PEER, headers: { cookie: sessionCookie(res), 'cf-connecting-ip': CLIENT } });
    const ips = (list.json().sessions as Array<{ ip: string | null; current: boolean }>).filter((s) => s.current).map((s) => s.ip);
    expect(ips).toEqual([CLIENT]);
  });

  it('without the header (or with a malformed one) the address falls back to the hop the platform wrote, never the forged head', async () => {
    const t = await appWith(env);
    const variants: Array<Record<string, string>> = [{}, { 'cf-connecting-ip': 'unknown' }, { 'cf-connecting-ip': `${CLIENT}, 192.0.2.1` }];
    for (const header of variants) {
      expect((await badLogin(t, { 'x-forwarded-for': chain('192.0.2.77'), ...header })).statusCode).toBe(401);
    }
    const ips = attemptIps(t);
    expect(ips).not.toContain('192.0.2.77');
    expect(new Set(ips)).toEqual(new Set([LB_INNER]));
  });
});

describe('other MEDLEVO_TRUST_PROXY forms', () => {
  it('hop count: the client is the entry that many places from the right; a forged head is ignored', async () => {
    const t = await appWith({ MEDLEVO_TRUST_PROXY: '3' });
    await expectForgedXffDoesNotEscape(t, (forged) => ({ 'x-forwarded-for': chain(forged) }));
    expect(new Set(attemptIps(t))).toEqual(new Set([CLIENT]));
  });

  it('address list: walk from the right over trusted proxies; the first untrusted address is the client', async () => {
    const t = await appWith({ MEDLEVO_TRUST_PROXY: '10.0.0.0/8,172.64.0.0/13' });
    await expectForgedXffDoesNotEscape(t, (forged) => ({ 'x-forwarded-for': chain(forged) }));
    expect(new Set(attemptIps(t))).toEqual(new Set([CLIENT]));
  });

  it('address list: a peer outside the list is the client itself — its X-Forwarded-For and client-IP header are ignored', async () => {
    const t = await appWith({ MEDLEVO_TRUST_PROXY: '10.0.0.0/8', MEDLEVO_CLIENT_IP_HEADER: 'cf-connecting-ip' });
    const direct = '203.0.113.99';
    for (let i = 0; i < 5; i++) {
      expect((await badLogin(t, { 'x-forwarded-for': `192.0.2.${i}`, 'cf-connecting-ip': `192.0.2.${i}` }, direct)).statusCode).toBe(401);
    }
    expect((await badLogin(t, { 'x-forwarded-for': '192.0.2.200', 'cf-connecting-ip': '192.0.2.200' }, direct)).statusCode).toBe(429);
    expect(new Set(attemptIps(t))).toEqual(new Set([direct]));
  });

  it('true (the documented nginx / Caddy setup that OVERWRITES X-Forwarded-For with one address) keeps its behaviour', async () => {
    const t = await appWith({ MEDLEVO_TRUST_PROXY: 'true' });
    expect((await badLogin(t, { 'x-forwarded-for': CLIENT }, '127.0.0.1')).statusCode).toBe(401);
    expect(attemptIps(t)).toEqual([CLIENT]);
  });

  it('no proxy trusted: X-Forwarded-For and the client-IP header are ignored entirely', async () => {
    const t = await appWith({ MEDLEVO_HOST: '0.0.0.0' });
    expect((await badLogin(t, { 'x-forwarded-for': chain('192.0.2.1'), 'cf-connecting-ip': CLIENT })).statusCode).toBe(401);
    expect(attemptIps(t)).toEqual([PEER]);
  });
});
