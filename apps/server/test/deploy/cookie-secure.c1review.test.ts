// AOS-21.35 — review of track C1 (2026-10-22). The builder's check refused only an EXPLICIT
// MEDLEVO_COOKIE_SECURE=false next to an https origin. The default was taken from the FIRST origin of the list only
// (`origins[0].startsWith('https://')`), so a deployment that lists its LAN / development address first and its public
// https address second — `MEDLEVO_ORIGIN=http://192.168.1.20:8787,https://study.example.org` — started with a session
// cookie WITHOUT `Secure` while serving accounts over https: exactly the start the row says must be refused.
// Now any https origin makes the default `Secure`, so no start path ends with an https origin and a non-Secure cookie.
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config';

const base = { NODE_ENV: 'test', MEDLEVO_DATA_DIR: '/tmp/medlevo-cookie-secure-review' };

describe('AOS-21.35 (review) — every start with an https origin has a Secure session cookie', () => {
  it('an https origin listed SECOND (MEDLEVO_COOKIE_SECURE unset) still gets a Secure cookie', () => {
    const c = loadConfig({ ...base, MEDLEVO_ORIGIN: 'http://192.168.1.20:8787,https://study.example.org' });
    expect(c.allowedOrigins).toEqual(['http://192.168.1.20:8787', 'https://study.example.org']);
    expect(c.cookieSecure).toBe(true);
  });

  it('whatever the order or the source of the origins, a started config never pairs https with a non-Secure cookie', () => {
    const envs: Array<Record<string, string>> = [
      { MEDLEVO_ORIGIN: 'https://study.example.org' },
      { MEDLEVO_ORIGIN: 'http://localhost:5173,https://study.example.org' },
      { MEDLEVO_ORIGIN: 'https://study.example.org, http://localhost:5173' },
      { MEDLEVO_ORIGIN: 'auto', RENDER_EXTERNAL_URL: 'https://medlevo-abc1.onrender.com' },
      { RENDER_EXTERNAL_URL: 'https://medlevo-abc1.onrender.com' },
    ];
    for (const extra of envs) {
      for (const secure of [undefined, 'true', 'false', '0', '1']) {
        const env: Record<string, string> = { ...base, ...extra, ...(secure === undefined ? {} : { MEDLEVO_COOKIE_SECURE: secure }) };
        let started: ReturnType<typeof loadConfig> | null = null;
        try {
          started = loadConfig(env);
        } catch (e) {
          expect(e, JSON.stringify(env)).toBeInstanceOf(ConfigError);
        }
        if (started && started.allowedOrigins.some((o) => o.startsWith('https://'))) expect(started.cookieSecure, JSON.stringify(env)).toBe(true);
      }
    }
  });

  it('plain http only is unchanged (the E2E server, local development)', () => {
    expect(loadConfig({ ...base, MEDLEVO_ORIGIN: 'http://127.0.0.1:4173,http://localhost:5173' }).cookieSecure).toBe(false);
  });
});
