// AOS-21.35 (NFR-S2, encryption in transit): the server is multi-user since release R1-b, so a session cookie that
// travels without `Secure` over an https deployment could be sent in clear by a downgraded request and taken over.
// The server therefore REFUSES TO START when any accepted origin is https and MEDLEVO_COOKIE_SECURE is set to false
// (the default for an https origin is already `Secure`). A plain-http origin (local development, the E2E server) is
// unchanged.
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config';

const base = { NODE_ENV: 'test', MEDLEVO_DATA_DIR: '/tmp/medlevo-cookie-secure-config' };

describe('AOS-21.35 — no non-Secure session cookie on an https deployment', () => {
  it('refuses to start with an https origin and MEDLEVO_COOKIE_SECURE=false, naming the setting', () => {
    for (const off of ['false', '0', 'off', 'no']) {
      expect(() => loadConfig({ ...base, MEDLEVO_ORIGIN: 'https://study.example.org', MEDLEVO_COOKIE_SECURE: off })).toThrow(ConfigError);
    }
    expect(() => loadConfig({ ...base, MEDLEVO_ORIGIN: 'https://study.example.org', MEDLEVO_COOKIE_SECURE: 'false' })).toThrow(/MEDLEVO_COOKIE_SECURE/);
  });

  it('refuses when ANY accepted origin is https (a second, https origin in the list)', () => {
    expect(() => loadConfig({ ...base, MEDLEVO_ORIGIN: 'http://localhost:5173,https://study.example.org', MEDLEVO_COOKIE_SECURE: 'false' })).toThrow(ConfigError);
  });

  it('refuses with the platform address too (Render gives https; MEDLEVO_ORIGIN unset or auto)', () => {
    expect(() => loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://medlevo-abc1.onrender.com', MEDLEVO_COOKIE_SECURE: 'false' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, MEDLEVO_ORIGIN: 'auto', RENDER_EXTERNAL_URL: 'https://medlevo-abc1.onrender.com', MEDLEVO_COOKIE_SECURE: 'false' }),
    ).toThrow(ConfigError);
  });

  it('an https origin with the default or an explicit true starts with Secure cookies', () => {
    expect(loadConfig({ ...base, MEDLEVO_ORIGIN: 'https://study.example.org' }).cookieSecure).toBe(true);
    expect(loadConfig({ ...base, MEDLEVO_ORIGIN: 'https://study.example.org', MEDLEVO_COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
  });

  it('plain http (development, the E2E server) is unchanged: false is allowed, the default is not Secure', () => {
    expect(loadConfig({ ...base, MEDLEVO_ORIGIN: 'http://127.0.0.1:4173', MEDLEVO_COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(loadConfig({ ...base }).cookieSecure).toBe(false);
  });
});
