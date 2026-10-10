import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_OWNER_SETTINGS } from '@medlevo/shared';
import { ConfigError, loadConfig } from '../src/config';
import { type AuthHeaders, createTestApp, type TestApp } from './helpers/app';

let t: TestApp;
let h: AuthHeaders;
beforeAll(async () => {
  t = await createTestApp();
  ({ headers: h } = await t.setupOwner());
});
afterAll(async () => {
  await t.close();
});

describe('error envelope & HTTP hygiene', () => {
  it('health is public and minimal', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ ok: true, version: '0.1.0', time: t.clock.now() });
  });

  it('unknown API routes → 404 JSON envelope (authenticated)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope', headers: h });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' } });
  });

  it('malformed JSON → 400 BAD_REQUEST without internals', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...h, 'content-type': 'application/json' }, payload: '{"theme":' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(body)).not.toMatch(/stack|at .*\.js|node_modules/);
  });

  it('oversized JSON bodies → 413 PAYLOAD_TOO_LARGE', async () => {
    const small = await createTestApp({ env: { MEDLEVO_MAX_JSON_MB: '0.001' } });
    try {
      const { headers } = await small.setupOwner().catch(async () => ({ headers: {} as AuthHeaders }));
      const res = await small.app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { custom_instruction: 'x'.repeat(5000) } });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    } finally {
      await small.close();
    }
  });

  it('API responses carry strict security headers and are not cached', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/settings', headers: h });
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('settings', () => {
  it('returns defaults merged with stored values', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/settings', headers: h });
    expect(res.json().settings).toEqual(DEFAULT_OWNER_SETTINGS);
  });

  it('patches validated keys, rejects unknown keys / invalid values, and audits the change', async () => {
    const ok = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { theme: 'dark', text_scale: 1.2, timezone: 'Africa/Cairo' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings).toMatchObject({ theme: 'dark', text_scale: 1.2, timezone: 'Africa/Cairo', ui_language: 'ar' });
    const again = await t.app.inject({ method: 'GET', url: '/api/settings', headers: h });
    expect(again.json().settings.theme).toBe('dark');

    const bad = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { text_scale: 9 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.issues[0].path).toBe('text_scale');
    const unknown = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { is_admin: true } });
    expect(unknown.statusCode).toBe(400);
    const tz = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { timezone: 'Mars/Olympus' } });
    expect(tz.statusCode).toBe(400);

    const audit = await t.app.inject({ method: 'GET', url: '/api/audit?entity_type=owner_setting&entity_id=owner', headers: h });
    const entries = audit.json().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'update', before: { theme: 'system' }, after: { theme: 'dark' } });

    // a corrupted stored value falls back to the default for that key only
    t.ctx.db.run(`UPDATE owner_setting SET value_json = '"neon"' WHERE key = 'theme'`);
    const fallback = await t.app.inject({ method: 'GET', url: '/api/settings', headers: h });
    expect(fallback.json().settings).toMatchObject({ theme: 'system', text_scale: 1.2 });
  });

  it('a partial source_priority changes only the purposes it names (I1 #7)', async () => {
    // Regression: zod filled the omitted purposes with their defaults, so changing one purpose reset the others.
    const custom = ['textbook', 'lecture'];
    const first = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { source_priority: { clinical_expansion: custom } } });
    expect(first.statusCode).toBe(200);
    const second = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { source_priority: { lecture_explanation: ['course_reference', 'lecture'] } } });
    expect(second.statusCode).toBe(200);
    const sp = (await t.app.inject({ method: 'GET', url: '/api/settings', headers: h })).json().settings.source_priority;
    expect(sp).toEqual({
      lecture_explanation: ['course_reference', 'lecture'],
      source_question_practice: DEFAULT_OWNER_SETTINGS.source_priority.source_question_practice,
      clinical_expansion: custom,
    });
  });
});

describe('audit log', () => {
  it('records entries, redacts secret-looking fields and pages by cursor', async () => {
    for (let i = 0; i < 3; i++) {
      t.ctx.audit.record({ entityType: 'library_node', entityId: 'N1', action: 'rename', after: { title: `t${i}`, password: 'p', nested: { api_key: 'k' } } });
    }
    const p1 = await t.app.inject({ method: 'GET', url: '/api/audit?entity_type=library_node&entity_id=N1&limit=2', headers: h });
    const body = p1.json();
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].after).toEqual({ title: 't2', password: '[redacted]', nested: { api_key: '[redacted]' } });
    const p2 = await t.app.inject({ method: 'GET', url: `/api/audit?entity_type=library_node&entity_id=N1&before=${body.next_before}`, headers: h });
    expect(p2.json().entries).toHaveLength(1);
    expect(p2.json().next_before).toBeNull();
  });
});

describe('configuration', () => {
  it('never exposes the AI key value through the config object', () => {
    const cfg = loadConfig({ MEDLEVO_DATA_DIR: '/tmp/x', ANTHROPIC_API_KEY: 'sk-ant-test-not-real', NODE_ENV: 'test' });
    expect(cfg.ai.anthropicKeyPresent).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain('sk-ant-test-not-real');
    expect(Object.keys(cfg)).not.toContain('secrets');
    expect(cfg.secrets.anthropicApiKey()).toBe('sk-ant-test-not-real');
    const none = loadConfig({ MEDLEVO_DATA_DIR: '/tmp/x', ANTHROPIC_API_KEY: '' });
    expect(none.ai.anthropicKeyPresent).toBe(false);
  });

  it('resolves DATA_DIR, origins, limits and validates values', () => {
    const cfg = loadConfig({ MEDLEVO_DATA_DIR: 'rel/data', MEDLEVO_ORIGIN: 'https://study.example/, http://localhost:5173', MEDLEVO_MAX_UPLOAD_MB: '10' }, { cwd: '/srv/app' });
    expect(cfg.dataDir).toBe('/srv/app/rel/data');
    expect(cfg.dbPath).toBe('/srv/app/rel/data/medlevo.sqlite');
    expect(cfg.origin).toBe('https://study.example');
    expect(cfg.allowedOrigins).toEqual(['https://study.example', 'http://localhost:5173']);
    expect(cfg.limits.maxUploadBytes).toBe(10 * 1024 * 1024);
    expect(cfg.timezone).toBe('Asia/Baghdad');
    expect(cfg.allowExternalFetch).toBe(false);
    expect(() => loadConfig({ MEDLEVO_TIMEZONE: 'Nowhere/Land' })).toThrow(ConfigError);
    expect(() => loadConfig({ MEDLEVO_PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ MEDLEVO_ORIGIN: 'not a url' })).toThrow(ConfigError);
  });
});

describe('static SPA serving (production)', () => {
  it('serves files from dist, falls back to index.html for navigations, never for /api', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'medlevo-dist-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html lang="ar" dir="rtl"><title>MedLevo</title></html>');
    writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
    const prod = await createTestApp({ env: { MEDLEVO_WEB_DIST: dist } });
    try {
      const index = await prod.app.inject({ method: 'GET', url: '/library/123' });
      expect(index.statusCode).toBe(200);
      expect(index.headers['content-type']).toContain('text/html');
      expect(index.headers['content-security-policy']).toContain("script-src 'self'");
      const asset = await prod.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
      expect(asset.headers['cache-control']).toContain('immutable');
      expect((await prod.app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
      expect((await prod.app.inject({ method: 'GET', url: '/../../etc/passwd' })).body).not.toContain('root:');
      const api = await prod.app.inject({ method: 'GET', url: '/api/unknown' });
      expect(api.statusCode).toBe(401);
      expect(api.headers['content-type']).toContain('application/json');
    } finally {
      await prod.close();
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
