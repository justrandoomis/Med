// Test harness: isolated temp DATA_DIR, migrated DB, injectable clock and AI provider, auth helpers.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app';
import { type AppConfig, loadConfig } from '../../src/config';
import type { AppContext } from '../../src/context';
import type { AiProvider } from '../../src/modules/ai/types';
import type { ModuleEntry } from '../../src/modules';
import { MODULES } from '../../src/modules';

export const TEST_ORIGIN = 'http://localhost:5173';
export const OWNER = { username: 'owner', password: 'test-password-123' };
export const CSRF = { 'x-medlevo-csrf': '1' } as const;

export interface TestClock {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
}

export function createClock(start = Date.UTC(2026, 9, 9, 12, 0, 0)): TestClock {
  let t = start;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export interface AuthHeaders {
  cookie: string;
  'x-medlevo-csrf': '1';
  [k: string]: string;
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  config: AppConfig;
  dataDir: string;
  clock: TestClock;
  /** creates the owner; returns auth headers + the one-time recovery codes */
  setupOwner(): Promise<{ headers: AuthHeaders; recoveryCodes: string[] }>;
  /** logs in and returns cookie + CSRF headers */
  login(opts?: { username?: string; password?: string; userAgent?: string }): Promise<AuthHeaders>;
  close(): Promise<void>;
}

export interface CreateTestAppOptions {
  ai?: AiProvider | null;
  now?: number;
  env?: Record<string, string>;
  modules?: ModuleEntry[];
  jobs?: { backoffBaseMs?: number; backoffMaxMs?: number };
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = list.find((s) => s.startsWith('medlevo_session='));
  if (!c) throw new Error(`no session cookie in response (status ${res.statusCode}): ${res.body}`);
  return c.split(';')[0]!;
}

export async function createTestApp(opts: CreateTestAppOptions = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-test-'));
  // isolated env: never inherit a developer's real ANTHROPIC_API_KEY or data dir
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    MEDLEVO_DATA_DIR: dataDir,
    MEDLEVO_ORIGIN: TEST_ORIGIN,
    MEDLEVO_LOG_LEVEL: 'silent',
    MEDLEVO_SCRYPT_LOG_N: '12',
    ...opts.env,
  };
  const config = loadConfig(env);
  const clock = createClock(opts.now);
  const app = await buildApp({
    config,
    overrides: { clock, aiProvider: opts.ai === undefined ? null : opts.ai, jobs: opts.jobs },
    modules: opts.modules ?? MODULES,
  });
  await app.ready();
  const ctx = app.ctx;

  const setupOwner: TestApp['setupOwner'] = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { ...CSRF, 'user-agent': 'vitest-setup' },
      payload: { username: OWNER.username, password: OWNER.password },
    });
    if (res.statusCode !== 200) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
    return { headers: { cookie: sessionCookie(res), ...CSRF }, recoveryCodes: res.json().recovery_codes as string[] };
  };

  const login: TestApp['login'] = async (o = {}) => {
    // ARCHITECTURE §5: login() alone must give an authenticated client → create the owner on first use
    if (!ctx.db.get(`SELECT 1 AS x FROM owner WHERE id = 'owner'`)) await setupOwner();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, 'user-agent': o.userAgent ?? 'vitest' },
      payload: { username: o.username ?? OWNER.username, password: o.password ?? OWNER.password },
    });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    return { cookie: sessionCookie(res), ...CSRF };
  };

  return {
    app,
    ctx,
    config,
    dataDir,
    clock,
    login,
    setupOwner,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
