import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, OWNER, sessionCookie, type TestApp } from './helpers/app';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = { ...CSRF }) =>
  t.app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> });

describe('owner setup (single owner, no registration after setup)', () => {
  it('reports setup_required until the owner exists', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ setup_required: true, authenticated: false, owner: null, password_min_length: 10 });
  });

  it('creates the owner once, returns 10 one-time recovery codes, stores only hashes', async () => {
    const res = await post('/api/auth/setup', { username: OWNER.username, password: OWNER.password });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recovery_codes).toHaveLength(10);
    expect(new Set(body.recovery_codes).size).toBe(10);
    for (const c of body.recovery_codes) expect(c).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const cookie = res.headers['set-cookie'] as string;
    expect(cookie).toMatch(/^medlevo_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');

    const row = t.ctx.db.get<{ password_hash: string; recovery_codes_json: string }>("SELECT * FROM owner WHERE id = 'owner'")!;
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain(OWNER.password);
    for (const c of body.recovery_codes) expect(row.recovery_codes_json).not.toContain(c);
    expect(JSON.parse(row.recovery_codes_json)).toHaveLength(10);
    // the session token itself is never stored, only its sha256
    const token = cookie.split(';')[0]!.split('=')[1]!;
    expect(t.ctx.db.get('SELECT 1 FROM auth_session WHERE token_hash = ?', [token])).toBeUndefined();

    const status = await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: sessionCookie(res) } });
    expect(status.json()).toMatchObject({ setup_required: false, authenticated: true, owner: { username: 'owner' }, remaining_recovery_codes: 10 });
  });

  it('rejects a second setup — even with a valid session — so no second account can exist', async () => {
    const { headers } = await t.setupOwner();
    const again = await post('/api/auth/setup', { username: 'intruder', password: 'another-password-1' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_SET_UP');
    const again2 = await post('/api/auth/setup', { username: 'intruder', password: 'another-password-1' }, headers);
    expect(again2.statusCode).toBe(409);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM owner')!.n).toBe(1);
  });

  it('validates the setup body with Arabic field messages', async () => {
    const res = await post('/api/auth/setup', { username: 'ab', password: 'short' });
    expect(res.statusCode).toBe(400);
    const err = res.json().error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toMatch(/[؀-ۿ]/);
    const paths = err.details.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['username', 'password']));
    for (const i of err.details.issues) expect(i.message).toMatch(/[؀-ۿ]/);
  });

  it('cookie is Secure when configured', async () => {
    const secure = await createTestApp({ env: { MEDLEVO_COOKIE_SECURE: 'true' } });
    try {
      const res = await secure.app.inject({ method: 'POST', url: '/api/auth/setup', headers: { ...CSRF }, payload: OWNER });
      expect(res.headers['set-cookie']).toContain('Secure');
    } finally {
      await secure.close();
    }
  });
});

describe('login / logout / sessions', () => {
  beforeEach(async () => {
    await t.setupOwner();
  });

  it('logs in with correct credentials and rejects wrong ones with the same message', async () => {
    const ok = await post('/api/auth/login', { username: 'OWNER', password: OWNER.password });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().session.current).toBe(true);

    const badPass = await post('/api/auth/login', { username: OWNER.username, password: 'wrong-password-x' });
    const badUser = await post('/api/auth/login', { username: 'nobody', password: OWNER.password });
    expect(badPass.statusCode).toBe(401);
    expect(badUser.statusCode).toBe(401);
    expect(badPass.json().error.message).toBe(badUser.json().error.message);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM login_attempt WHERE succeeded = 0')!.n).toBe(2);
  });

  it('rate-limits failed logins per IP (5/min) and then lets the owner in after the window', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post('/api/auth/login', { username: OWNER.username, password: `wrong-${i}-xxxxxx` })).statusCode).toBe(401);
    }
    const blocked = await post('/api/auth/login', OWNER);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    t.clock.advance(61_000);
    expect((await post('/api/auth/login', OWNER)).statusCode).toBe(200);
  });

  // regression: the check ran before the async password hash and the failure was recorded after it,
  // so a burst of parallel guesses all passed the 5/min check (20 of 20 were evaluated).
  it('counts concurrent guesses: a parallel burst cannot exceed 5 password checks per minute', async () => {
    const burst = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post('/api/auth/login', { username: OWNER.username, password: `parallel-wrong-${i}-xx` })),
    );
    const statuses = burst.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    // the recovery endpoint shares the same per-IP budget
    expect((await post('/api/auth/recover', { username: OWNER.username, recovery_code: 'AAAA-BBBB-CCCC', new_password: 'whatever-password-1' })).statusCode).toBe(429);
  });

  it('applies an exponential lockout after repeated failures', async () => {
    const fail = () => post('/api/auth/login', { username: OWNER.username, password: 'definitely-wrong' });
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 5; i++) expect((await fail()).statusCode).toBe(401);
      t.clock.advance(61_000);
    }
    // 10 consecutive failures; the 1-minute lock from the 10th already elapsed → one more failure
    expect((await fail()).statusCode).toBe(401);
    t.clock.advance(61_000); // per-minute window is clear now, but the lock is 2 minutes
    const locked = await post('/api/auth/login', OWNER);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.message).toContain('رمز استرداد');
    t.clock.advance(60_000);
    expect((await post('/api/auth/login', OWNER)).statusCode).toBe(200);
  });

  it('logout revokes the session', async () => {
    const h = await t.login();
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: h })).statusCode).toBe(200);
    const out = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: h });
    expect(out.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: h })).statusCode).toBe(401);
  });

  it('lists sessions with device label, user agent, last seen and current flag; revokes another device', async () => {
    const ipad = await t.login({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
    const laptop = await t.login({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' });
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: laptop });
    const sessions = res.json().sessions as Array<{ id: string; device_label: string; user_agent: string; last_seen_at: number; current: boolean }>;
    expect(sessions.length).toBeGreaterThanOrEqual(3); // setup + 2 logins
    const current = sessions.filter((s) => s.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.device_label).toBe('Chrome على Windows');
    const ipadSession = sessions.find((s) => s.device_label === 'Safari على iPad')!;
    expect(ipadSession.user_agent).toContain('iPad');
    expect(typeof ipadSession.last_seen_at).toBe('number');

    const del = await t.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${ipadSession.id}`, headers: laptop });
    expect(del.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: ipad })).json().authenticated).toBe(false);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${ipadSession.id}`, headers: laptop })).statusCode).toBe(404);
    // audit trail for the revocation
    expect(t.ctx.audit.list({ entityType: 'auth_session', entityId: ipadSession.id }).entries).toHaveLength(1);
  });

  it('has a 30-day sliding expiry', async () => {
    const h = await t.login();
    const before = t.ctx.db.get<{ expires_at: number }>('SELECT expires_at FROM auth_session ORDER BY id DESC LIMIT 1')!;
    t.clock.advance(10 * 60_000);
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined();
    const after = t.ctx.db.get<{ expires_at: number }>('SELECT expires_at FROM auth_session ORDER BY id DESC LIMIT 1')!;
    expect(after.expires_at - before.expires_at).toBe(10 * 60_000);
    t.clock.advance(31 * 24 * 60 * 60_000);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: h })).statusCode).toBe(401);
  });
});

describe('password change & recovery', () => {
  let recoveryCodes: string[];
  beforeEach(async () => {
    ({ recoveryCodes } = await t.setupOwner());
  });

  it('password change requires the current password and revokes the other sessions', async () => {
    const a = await t.login();
    const b = await t.login();
    const wrong = await t.app.inject({ method: 'POST', url: '/api/auth/password', headers: a, payload: { current_password: 'nope-nope-nope', new_password: 'brand-new-password-1' } });
    expect(wrong.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: '/api/auth/password', headers: a, payload: { current_password: OWNER.password, new_password: 'brand-new-password-1' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().revoked_sessions).toBeGreaterThanOrEqual(2);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: b })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: a })).statusCode).toBe(200);
    expect((await post('/api/auth/login', OWNER)).statusCode).toBe(401);
    expect((await post('/api/auth/login', { username: OWNER.username, password: 'brand-new-password-1' })).statusCode).toBe(200);
  });

  it('a recovery code works exactly once and revokes all sessions', async () => {
    const h = await t.login();
    const code = recoveryCodes[3]!;
    const typed = code.toLowerCase().replace(/-/g, ' '); // tolerant input
    const res = await post('/api/auth/recover', { username: OWNER.username, recovery_code: typed, new_password: 'recovered-password-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().remaining_recovery_codes).toBe(9);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: h })).statusCode).toBe(401);

    const reuse = await post('/api/auth/recover', { username: OWNER.username, recovery_code: code, new_password: 'another-password-22' });
    expect(reuse.statusCode).toBe(401);
    expect((await post('/api/auth/login', { username: OWNER.username, password: 'recovered-password-1' })).statusCode).toBe(200);

    const wrongUser = await post('/api/auth/recover', { username: 'someone', recovery_code: recoveryCodes[4]!, new_password: 'another-password-22' });
    expect(wrongUser.statusCode).toBe(401);
  });

  it('regenerating recovery codes requires the password and invalidates the old ones', async () => {
    const h = await t.login();
    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/recovery-codes', headers: h, payload: { password: 'wrong-wrong-wrong' } });
    expect(bad.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: '/api/auth/recovery-codes', headers: h, payload: { password: OWNER.password } });
    expect(ok.statusCode).toBe(200);
    const fresh = ok.json().recovery_codes as string[];
    expect(fresh).toHaveLength(10);
    const old = await post('/api/auth/recover', { username: OWNER.username, recovery_code: recoveryCodes[0]!, new_password: 'recovered-password-1' });
    expect(old.statusCode).toBe(401);
    const neu = await post('/api/auth/recover', { username: OWNER.username, recovery_code: fresh[0]!, new_password: 'recovered-password-1' });
    expect(neu.statusCode).toBe(200);
  });
});

describe('unauthenticated access is denied', () => {
  it('protects every non-public API route', async () => {
    await t.setupOwner();
    const probes: Array<[string, string]> = [
      ['GET', '/api/jobs'],
      ['GET', '/api/jobs/01JXXXXXXXXXXXXXXXXXXXXXXX'],
      ['GET', '/api/settings'],
      ['GET', '/api/capabilities'],
      ['GET', '/api/audit'],
      ['GET', '/api/ai/status'],
      ['GET', '/api/auth/sessions'],
      ['GET', '/api/files/01JXXXXXXXXXXXXXXXXXXXXXXX'],
      ['GET', '/api/sync/pull'],
      ['GET', '/api/does-not-exist'],
    ];
    for (const [method, url] of probes) {
      const res = await t.app.inject({ method: method as 'GET', url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    }
    for (const url of ['/api/sync/push', '/api/jobs/x/cancel', '/api/auth/logout', '/api/auth/password']) {
      const res = await t.app.inject({ method: 'POST', url, headers: { ...CSRF }, payload: {} });
      expect(res.statusCode, url).toBe(401);
    }
    const patch = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...CSRF }, payload: { theme: 'dark' } });
    expect(patch.statusCode).toBe(401);
    // a forged/unknown cookie is not a session
    const forged = await t.app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: 'medlevo_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
    expect(forged.statusCode).toBe(401);
  });

  // regression: the router percent-decodes paths (`/%61pi/jobs` → /api/jobs) while req.url stays raw;
  // the guard used to look only at req.url, so encoded paths skipped auth AND CSRF entirely.
  it('percent-encoded paths cannot bypass the session or CSRF checks', async () => {
    await t.setupOwner();
    for (const url of ['/%61pi/jobs', '/ap%69/settings', '/%61pi/auth/sessions', '/%61pi/audit', '/%61%70%69/capabilities', '/%61pi/nope']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
      expect(res.headers['content-security-policy'], url).toContain('sandbox');
    }
    const noCsrf = await t.app.inject({ method: 'PATCH', url: '/%61pi/settings', payload: { theme: 'dark' } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('CSRF_FAILED');
    const noSession = await t.app.inject({ method: 'PATCH', url: '/%61pi/settings', headers: { ...CSRF }, payload: { theme: 'dark' } });
    expect(noSession.statusCode).toBe(401);
    expect(t.ctx.settings.get().theme).toBe('system');
  });

  it('test helper login() works on a fresh app (creates the owner first, ARCHITECTURE §5)', async () => {
    const h = await t.login();
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs', headers: h })).statusCode).toBe(200);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM owner')!.n).toBe(1);
    await t.login(); // second call does not try to set up again
  });

  it('public routes stay reachable without a session', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/status' })).statusCode).toBe(200);
  });
});
