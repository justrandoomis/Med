import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthHeaders, createTestApp, OWNER, TEST_ORIGIN, type TestApp } from './helpers/app';

let t: TestApp;
let h: AuthHeaders;
beforeAll(async () => {
  t = await createTestApp();
  ({ headers: h } = await t.setupOwner());
});
afterAll(async () => {
  await t.close();
});

describe('CSRF protection for mutations', () => {
  it('rejects an authenticated mutation without the CSRF header', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie: h.cookie }, payload: { theme: 'dark' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_FAILED');
  });

  it('rejects a mutation whose Origin is not the configured origin', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...h, origin: 'https://evil.example' }, payload: { theme: 'dark' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_FAILED');
    const nullOrigin = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...h, origin: 'null' }, payload: { theme: 'dark' } });
    expect(nullOrigin.statusCode).toBe(403);
  });

  it('rejects cross-site fetch metadata', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...h, 'sec-fetch-site': 'cross-site' }, payload: { theme: 'dark' } });
    expect(res.statusCode).toBe(403);
  });

  it('accepts the header with the configured Origin (and without Origin)', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...h, origin: TEST_ORIGIN }, payload: { theme: 'dark' } });
    expect(res.statusCode).toBe(200);
    const res2 = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { theme: 'light' } });
    expect(res2.statusCode).toBe(200);
  });

  it('protects public credential endpoints too (login CSRF)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('does not require the header for safe methods', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: h.cookie } });
    expect(res.statusCode).toBe(200);
  });
});
