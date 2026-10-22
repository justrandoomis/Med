// AOS-21.45 (ARCHITECTURE_DELTA §14 «rate limits»): limits are kept PER USER for signed-in requests — two classmates
// behind one campus NAT share an address, not a budget — and the per-address ceilings of the sign-in routes are high
// enough for a whole class signing in from one address at the start of a lecture («200 sign-ins from one address»).
// Credential guessing stays bounded by the per-account progressive delay and the per-address FAILURE ceiling.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, CSRF, sessionCookie, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const NAT = '10.20.30.40';

describe('AOS-21.45 — per-user limits, NAT-sized per-address ceilings', () => {
  it('200 successful sign-ins from one address within a minute (a class behind one NAT) are all served', async () => {
    t = await createTestApp();
    await t.login();
    const users = await Promise.all(Array.from({ length: 20 }, (_, i) => addUser(t!, `stu${String(i).padStart(2, '0')}`)));
    const statuses: number[] = [];
    for (let round = 0; round < 10; round++) {
      for (const u of users) {
        const res = await t.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          remoteAddress: NAT,
          headers: { ...CSRF, 'user-agent': `phone-${u.user.username}` },
          payload: { username: u.user.username, password: u.password },
        });
        statuses.push(res.statusCode);
      }
    }
    expect(statuses).toHaveLength(200);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  }, 120_000);

  it('a signed-in route limit is per user: one classmate exhausting it does not block another behind the same address', async () => {
    t = await createTestApp();
    await t.login();
    const a = await addUser(t, 'amal');
    const b = await addUser(t, 'basim');
    const loginAt = async (u: typeof a) => {
      const res = await t!.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: NAT, headers: { ...CSRF }, payload: { username: u.user.username, password: u.password } });
      expect(res.statusCode, res.body).toBe(200);
      return { cookie: sessionCookie(res), ...CSRF };
    };
    const ha = await loginAt(a);
    const hb = await loginAt(b);
    // RATE_LIMITS.ai = 30 per minute: the limiter counts before the handler answers (here 404: no such region)
    const hit = (h: Record<string, string>) => t!.app.inject({ method: 'POST', url: '/api/processing/figures/NOPE/analyze', remoteAddress: NAT, headers: h, payload: {} });
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await hit(ha)).statusCode);
    expect(codes.slice(0, 30).every((c) => c !== 429)).toBe(true);
    expect(codes[30]).toBe(429);
    // the other classmate, same address, still has the whole budget
    expect((await hit(hb)).statusCode).not.toBe(429);
  });
});
