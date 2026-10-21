// Paths of the multi-user layout for tests (P1-T1 step 1): the vault file of a live test app, and the database files
// a restore wrote into a data directory (system.sqlite + vaults/<file>). Read-only: they open nothing for writing.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import type { AppContext } from '../../src/context';
import { hashSecret } from '../../src/modules/auth/password';
import type { UserRow, VaultRow } from '../../src/system/repos';
import { type AuthHeaders, CSRF, createClock, sessionCookie, TEST_ORIGIN, type TestApp } from './app';
import { testBinding, type TestBindingTarget } from './binding';
import { processTemplateDir } from './template';

function contextOf(target: TestBindingTarget): AppContext {
  if ('binding' in target && 'system' in target) return target as AppContext;
  return (target as { ctx: AppContext }).ctx;
}

/** The file of the test user's vault (the database `t.ctx.db` reaches in the harness). */
export function ownerVaultPath(target: TestBindingTarget): string {
  const ctx = contextOf(target);
  const b = testBinding(target);
  if (b.kind !== 'vault') throw new Error('ownerVaultPath: the test binding is not a vault');
  const p = ctx.pool.pathOf('vault', b.vaultId);
  if (!p) throw new Error('ownerVaultPath: the test vault has no file');
  return p;
}

export interface DataDirDatabases {
  system: string;
  /** the vault of the first platform admin (the account the single-owner era maps to) */
  primaryVault: string;
  vaults: string[];
}

/** The database files of a multi-user data directory (e.g. a restore target), read from its system.sqlite. */
export function dataDirDatabases(dataDir: string): DataDirDatabases {
  const system = join(dataDir, 'system.sqlite');
  if (!existsSync(system)) throw new Error(`dataDirDatabases: ${system} does not exist`);
  const db = new DatabaseSync(system, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT v.db_file AS db_file, u.is_platform_admin AS admin FROM vault v JOIN user_account u ON u.id = v.user_id
          ORDER BY u.is_platform_admin DESC, u.created_at, u.id`,
      )
      .all() as Array<{ db_file: string; admin: number }>;
    if (rows.length === 0) throw new Error(`dataDirDatabases: no vault is registered in ${system}`);
    const vaults = rows.map((r) => join(dataDir, 'vaults', r.db_file));
    return { system, primaryVault: vaults[0]!, vaults };
  } finally {
    db.close();
  }
}

export interface BootedOnVault {
  app: FastifyInstance;
  ctx: AppContext;
  headers: { cookie: string; 'x-medlevo-csrf': '1' };
  vaultPath: string;
}

/**
 * Boot the server on a vault file written by the test (e.g. a database at an OLDER schema, to prove the shipped base
 * migrations upgrade it in place): a fresh multi-user data dir gets its first account through first-run setup, the
 * server stops, the account's vault file is replaced by `writeVault(path)`, and the server boots again and signs in.
 * The vault is migrated when the pool opens it (as every user's vault is) — the step-1 equivalent of «the server boots
 * on an upgraded owner data directory» (a single-owner data dir itself is refused until the owner migration, step 3).
 */
export async function bootOnVaultFile(
  dataDir: string,
  writeVault: (path: string) => void,
  /** nodeEnv 'development': no harness default binding at all — boot-time code runs exactly as in production */
  o: { now?: number; username?: string; password?: string; nodeEnv?: 'test' | 'development' } = {},
): Promise<BootedOnVault> {
  const username = o.username ?? 'owner';
  const password = o.password ?? 'test-password-123';
  const config = loadConfig({ NODE_ENV: o.nodeEnv ?? 'test', MEDLEVO_DATA_DIR: dataDir, MEDLEVO_ORIGIN: TEST_ORIGIN, MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12' });
  const overrides = () => ({ clock: createClock(o.now), aiProvider: null, templateDir: processTemplateDir() });

  const first = await buildApp({ config, overrides: overrides() });
  let vaultPath: string;
  try {
    await first.ready();
    const setup = await first.inject({ method: 'POST', url: '/api/auth/setup', headers: { ...CSRF, 'user-agent': 'vitest' }, payload: { username, password } });
    if (setup.statusCode !== 200) throw new Error(`bootOnVaultFile: setup failed ${setup.statusCode} ${setup.body}`);
    const b = first.ctx.tenancy.platformVaultBinding();
    if (!b) throw new Error('bootOnVaultFile: no vault after setup');
    vaultPath = first.ctx.pool.pathOf('vault', b.vaultId);
  } finally {
    await first.close();
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${vaultPath}${suffix}`, { force: true });
  writeVault(vaultPath);

  const app = await buildApp({ config, overrides: overrides() });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'user-agent': 'vitest' }, payload: { username, password } });
  if (login.statusCode !== 200) {
    await app.close();
    throw new Error(`bootOnVaultFile: login failed ${login.statusCode} ${login.body}`);
  }
  return { app, ctx: app.ctx, headers: { cookie: sessionCookie(login), ...CSRF }, vaultPath };
}

export interface ExtraUser {
  user: UserRow;
  vault: VaultRow;
  password: string;
  /** signs this user in (a fresh session each call) */
  login(userAgent?: string): Promise<AuthHeaders>;
}

/**
 * A second (third …) account in a test app, created the way the platform will create accounts (Tenancy.createAccount:
 * vault file from the template, then one system transaction). Not a platform admin unless asked.
 */
export async function addUser(t: TestApp, username: string, o: { isPlatformAdmin?: boolean; password?: string } = {}): Promise<ExtraUser> {
  const password = o.password ?? `pw-${username}-0123456789`;
  const passwordHash = await hashSecret(password, t.config.auth.scryptLogN);
  const { user, vault } = t.ctx.tenancy.createAccount({
    username,
    displayName: username,
    passwordHash,
    recoveryHashes: [],
    isPlatformAdmin: o.isPlatformAdmin ?? false,
    timezone: t.config.timezone,
  });
  return {
    user,
    vault,
    password,
    login: async (userAgent = 'vitest') => {
      const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'user-agent': userAgent }, payload: { username, password } });
      if (res.statusCode !== 200) throw new Error(`login of ${username} failed: ${res.statusCode} ${res.body}`);
      return { cookie: sessionCookie(res), ...CSRF };
    },
  };
}
