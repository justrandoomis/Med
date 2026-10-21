// Test harness: isolated temp DATA_DIR, injectable clock and AI provider, auth helpers.
//
// P1-T1 step 1 (ARCHITECTURE_DELTA §1.1): `createTestApp()` = system DB + one user + that user's vault. Requests are
// bound by the binding hook to the session's own vault. Direct database access from test code (`t.ctx.db.*`,
// `jobs.drain()`, `jobs.enqueue` outside a request) runs in the harness's default binding — the test user's vault —
// which `withTestBinding` makes explicit. The test user («owner», the platform admin, user #1) is created by the
// first-run setup route on `setupOwner()` / `login()`, or directly (same hashes, same codes) the first time test code
// touches the database before signing in.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app';
import { type AppConfig, loadConfig } from '../../src/config';
import type { AppContext, ContextOverrides } from '../../src/context';
import type { AiProvider } from '../../src/modules/ai/types';
import type { ModuleEntry } from '../../src/modules';
import { MODULES } from '../../src/modules';
import { generateRecoveryCode, hashSecret } from '../../src/modules/auth/password';
import type { Binding, SpaceRouteGrant } from '../../src/system/binding';
import { MIN_CLIENT_VERSION, RECOVERY_CODE_COUNT } from '@medlevo/shared';
import { processTemplateDir } from './template';

export { withTestBinding, testBinding, type TestBindingTarget } from './binding';

export const TEST_ORIGIN = 'http://localhost:5173';
export const OWNER = { username: 'owner', password: 'test-password-123' };
/**
 * Headers of every write the web client sends: the CSRF header and (P1-T1 step 3) the client version — the harness
 * is a current multi-user client. A test of an R1-a client leaves `x-medlevo-client` out on purpose
 * (test/tenancy/client-gate.test.ts).
 */
export const CLIENT_VERSION = { 'x-medlevo-client': MIN_CLIENT_VERSION } as const;
export const CSRF = { 'x-medlevo-csrf': '1', ...CLIENT_VERSION } as const;

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
  /** creates the owner (first-run setup) — or signs in when the harness already created it; headers + recovery codes */
  setupOwner(): Promise<{ headers: AuthHeaders; recoveryCodes: string[] }>;
  /** the test user's vault binding (creates the test user when none exists yet) */
  ownerBinding(): Binding;
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
  /** extra entries of the space-route allow-list (tenancy tests) */
  spaceRoutes?: SpaceRouteGrant[];
  /** pool size override (tenancy tests) */
  dbPoolSize?: number;
  /** P1-T1 step 2: GC timings / test hook, R2 blob-store tuning */
  gc?: ContextOverrides['gc'];
  blobStore?: ContextOverrides['blobStore'];
}

/** The test owner's password and recovery-code hashes, computed once per worker process (scrypt is slow). */
let ownerSecrets: Promise<{ passwordHash: string; codes: string[]; codeHashes: string[] }> | null = null;
function testOwnerSecrets(logN: number) {
  ownerSecrets ??= (async () => {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const [passwordHash, ...codeHashes] = await Promise.all([hashSecret(OWNER.password, logN), ...codes.map((c) => hashSecret(c, logN))]);
    return { passwordHash: passwordHash!, codes, codeHashes };
  })();
  return ownerSecrets;
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
    overrides: {
      clock,
      aiProvider: opts.ai === undefined ? null : opts.ai,
      jobs: opts.jobs,
      templateDir: processTemplateDir(),
      dbPoolSize: opts.dbPoolSize,
      ...(opts.gc ? { gc: opts.gc } : {}),
      ...(opts.blobStore ? { blobStore: opts.blobStore } : {}),
    },
    modules: opts.modules ?? MODULES,
    spaceRoutes: opts.spaceRoutes,
  });
  await app.ready();
  const ctx = app.ctx;
  const secrets = await testOwnerSecrets(config.auth.scryptLogN);
  let createdDirectly = false;

  /** user #1 exactly as first-run setup creates it (platform admin, own vault) — without the HTTP round trip */
  const ensureOwner = () => {
    const existing = ctx.system.users.findForAuth(OWNER.username);
    if (existing) return existing;
    if (ctx.system.users.countInternal() > 0) throw new Error('test harness: another account exists but not the test owner');
    createdDirectly = true;
    return ctx.tenancy.createAccount(
      { username: OWNER.username, displayName: OWNER.username, passwordHash: secrets.passwordHash, recoveryHashes: secrets.codeHashes, isPlatformAdmin: true, timezone: config.timezone },
      { onlyIfNoUsers: true },
    ).user;
  };
  const ownerBinding = (): Binding => {
    const user = ensureOwner();
    return ctx.tenancy.vaultBindingFor(ctx.tenancy.viewerOf(user, null));
  };
  // code outside every request / job context (test bodies) runs in the test user's vault
  ctx.binding.setHarnessDefault(ownerBinding);

  const setupOwner: TestApp['setupOwner'] = async () => {
    if (ctx.system.users.countInternal() > 0) {
      // the harness already created the owner (test code touched the database first): sign in instead
      if (!createdDirectly) throw new Error('setup failed: the owner already exists');
      const headers = await login();
      return { headers, recoveryCodes: [...secrets.codes] };
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { ...CSRF, 'user-agent': 'vitest-setup' },
      payload: { username: OWNER.username, password: OWNER.password },
    });
    if (res.statusCode !== 200) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
    return { headers: { cookie: sessionCookie(res), ...CSRF }, recoveryCodes: res.json().recovery_codes as string[] };
  };

  async function login(o: { username?: string; password?: string; userAgent?: string } = {}): Promise<AuthHeaders> {
    // ARCHITECTURE §5: login() alone must give an authenticated client → create the owner on first use
    // (P1-T1: accounts live in the system DB — the check moved there, ARCHITECTURE_DELTA §1.1)
    if (ctx.system.users.countInternal() === 0) await setupOwner();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, 'user-agent': o.userAgent ?? 'vitest' },
      payload: { username: o.username ?? OWNER.username, password: o.password ?? OWNER.password },
    });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    return { cookie: sessionCookie(res), ...CSRF };
  }

  return {
    app,
    ctx,
    config,
    dataDir,
    clock,
    login,
    setupOwner,
    ownerBinding,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
