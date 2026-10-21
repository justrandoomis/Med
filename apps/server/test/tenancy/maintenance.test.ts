// P1-T1 step 3 — what the owner sees on the first boot after updating (system/maintenance.ts + index.ts planBoot):
// the server never runs first-run setup over single-owner data; it answers the platform health check and shows the
// Arabic page /api/maintenance; the migration starts only with the owner's CURRENT password (or an unused recovery
// code, checked without consuming it) and an explicit confirmation; an unfinished journal is resumed at once; a rollback
// asked by MEDLEVO_OWNER_MIGRATION=rollback runs at once; an R1-a client gets 503 with the page's address and keeps
// its outbox. Every refusal leaves the data directory byte for byte as it was.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { openDb } from '../../src/db/db';
import { migrate } from '../../src/db/migrate';
import { randomToken, sha256 } from '../../src/lib/hash';
import { newId } from '../../src/lib/ids';
import { generateRecoveryCode, hashSecret } from '../../src/modules/auth/password';
import { detectDataDir } from '../../src/system/layout';
import { planBoot, startMaintenance, type MaintenanceServer } from '../../src/system/maintenance';
import { dataDirPaths, journalState, readJournal, runOwnerMigration } from '../../src/system/ownerMigration';
import { CSRF, TEST_ORIGIN } from '../helpers/app';

const USER = 'owner_m';
const PASSWORD = 'maintenance-owner-pass-1';
let work: string;
let codes: string[];
let token: string;
let n = 0;

function env(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { NODE_ENV: 'test', MEDLEVO_DATA_DIR: dir, MEDLEVO_ORIGIN: TEST_ORIGIN, MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12', ...extra };
}
const configFor = (dir: string, extra: Record<string, string> = {}) => loadConfig(env(dir, extra));

let template: string;
/** a small single-owner data directory (R1-a schema, an owner, a session, one stored file referenced by the database) */
async function buildTemplate(): Promise<string> {
  const dir = join(work, 'template');
  mkdirSync(join(dir, 'files', 'ab', 'cd'), { recursive: true });
  const bytes = Buffer.from('lecture bytes of the owner');
  const sha = sha256(bytes);
  const key = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
  mkdirSync(join(dir, 'files', sha.slice(0, 2), sha.slice(2, 4)), { recursive: true });
  writeFileSync(join(dir, 'files', key), bytes);
  const db = openDb(join(dir, 'medlevo.sqlite'));
  try {
    migrate(db);
    codes = [generateRecoveryCode(), generateRecoveryCode()];
    const hashes = await Promise.all(codes.map((c) => hashSecret(c, 12)));
    const t = Date.now();
    db.run(`INSERT INTO owner (id, username, password_hash, recovery_codes_json, password_changed_at, created_at, updated_at) VALUES ('owner', ?, ?, ?, ?, ?, ?)`, [
      USER,
      await hashSecret(PASSWORD, 12),
      JSON.stringify(hashes),
      t - 1000,
      t - 5000,
      t - 1000,
    ]);
    token = randomToken(32);
    db.run(`INSERT INTO auth_session (id, token_hash, device_id, device_label, created_at, last_seen_at, expires_at) VALUES (?, ?, 'DEV_A', 'iPad', ?, ?, ?)`, [newId(), sha256(token), t, t, t + 86_400_000]);
    db.run(`INSERT INTO stored_file (id, sha256, size, mime, storage_key, original_name, created_at) VALUES (?, ?, ?, 'application/pdf', ?, 'l.pdf', ?)`, [newId(), sha, bytes.length, key, t]);
    db.run(`INSERT INTO owner_setting (key, value_json, updated_at) VALUES ('explanation_level', '"exam_focus"', ?)`, [t]);
  } finally {
    db.close();
  }
  return dir;
}

function copy(): string {
  const dir = join(work, `case-${++n}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const walk = (rel: string) => {
    for (const name of readdirSync(join(template, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(join(template, r)).isDirectory()) {
        mkdirSync(join(dir, r), { recursive: true });
        walk(r);
      } else writeFileSync(join(dir, r), readFileSync(join(template, r)));
    }
  };
  walk('');
  return dir;
}

function snapshot(dir: string, base = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(dir, base))) {
    const rel = base ? `${base}/${name}` : name;
    if (statSync(join(dir, rel)).isDirectory()) Object.assign(out, snapshot(dir, rel));
    else out[rel] = createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex');
  }
  return out;
}

const form = (fields: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_ORIGIN },
  payload: new URLSearchParams(fields).toString(),
});

async function until(m: MaintenanceServer, phase: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (m.status().phase !== phase) {
    if (Date.now() > end) throw new Error(`phase ${m.status().phase} (wanted ${phase}): ${JSON.stringify(m.status().error)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function maintenanceFor(dir: string, extra: Record<string, string> = {}) {
  const config = configFor(dir, extra);
  const plan = planBoot(config);
  if (plan.kind !== 'maintenance') throw new Error(`expected maintenance, got ${plan.kind}`);
  return startMaintenance({ config, plan, migration: { verifyBoot: false } });
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'medlevo-maintenance-'));
  template = await buildTemplate();
});
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('first boot on single-owner data: the maintenance page, never setup', () => {
  it('answers health 200 (the platform goes live), status «signed out, no setup», refuses setup and every data route', async () => {
    const dir = copy();
    const before = snapshot(dir);
    const m = await maintenanceFor(dir);
    try {
      const health = await m.app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, maintenance: true, phase: 'waiting' });
      expect((await m.app.inject({ method: 'GET', url: '/api/auth/status' })).json()).toMatchObject({ setup_required: false, authenticated: false, owner: null });
      const setup = await m.app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { username: 'intruder', password: 'intruder-password-1' } });
      expect(setup.statusCode).toBe(503);
      // an R1-a client with the owner's cookie keeps its outbox: 503 (retry later) with the page's address
      const push = await m.app.inject({ method: 'POST', url: '/api/sync/push', headers: { ...CSRF, cookie: `medlevo_session=${token}` }, payload: { ops: [] } });
      expect(push.statusCode).toBe(503);
      expect(push.json().error.message).toContain('/api/maintenance');
      // the page: Arabic, RTL, no script, a strict CSP, 44 px targets
      for (const url of ['/api/maintenance', '/', '/library']) {
        const page = await m.app.inject({ method: 'GET', url });
        expect(page.headers['content-type']).toContain('text/html');
        expect(page.body).toContain('<html lang="ar" dir="rtl">');
        expect(page.body).toContain('الترقية لم تكتمل بعد');
        expect(page.body).not.toMatch(/<script/i);
        expect(page.body).toContain('min-height: 44px');
        expect(page.headers['content-security-policy']).toContain("default-src 'none'");
      }
    } finally {
      await m.close();
    }
    expect(snapshot(dir)).toEqual(before);
  });

  it('a wrong password, a foreign origin or a missing confirmation start nothing; the data stays byte for byte', async () => {
    const dir = copy();
    const before = snapshot(dir);
    const m = await maintenanceFor(dir);
    try {
      const wrong = await m.app.inject({ method: 'POST', url: '/api/maintenance/start', ...form({ username: USER, password: 'not-the-password', confirm: 'yes' }) });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.body).toContain('غير صحيح');
      const foreign = await m.app.inject({ method: 'POST', url: '/api/maintenance/start', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, payload: `username=${USER}&password=${PASSWORD}&confirm=yes` });
      expect(foreign.statusCode).toBe(403);
      const unconfirmed = await m.app.inject({ method: 'POST', url: '/api/maintenance/start', ...form({ username: USER, password: PASSWORD }) });
      expect(unconfirmed.statusCode).toBe(400);
      expect(m.status().phase).toBe('waiting');
    } finally {
      await m.close();
    }
    expect(snapshot(dir)).toEqual(before);
  });

  it('too many wrong passwords from one address are slowed down', async () => {
    const dir = copy();
    const config = configFor(dir);
    const plan = planBoot(config);
    if (plan.kind !== 'maintenance') throw new Error('plan');
    const m = await startMaintenance({ config, plan, maxFailures: 3 });
    try {
      for (let i = 0; i < 3; i++) expect((await m.app.inject({ method: 'POST', url: '/api/maintenance/start', ...form({ username: USER, password: `bad-${i}`, confirm: 'yes' }) })).statusCode).toBe(401);
      expect((await m.app.inject({ method: 'POST', url: '/api/maintenance/start', ...form({ username: USER, password: PASSWORD, confirm: 'yes' }) })).statusCode).toBe(429);
    } finally {
      await m.close();
    }
  });

  it('the owner starts it with the current password: progress, then «finished» (the app may start on the same port)', async () => {
    const dir = copy();
    const m = await maintenanceFor(dir);
    try {
      const start = await m.app.inject({ method: 'POST', url: '/api/maintenance/start', ...form({ username: USER, password: PASSWORD, confirm: 'yes' }) });
      expect(start.statusCode, start.body).toBe(303);
      expect(start.headers.location).toBe('/api/maintenance');
      await m.finished;
      expect(m.status().phase).toBe('done');
      const page = await m.app.inject({ method: 'GET', url: '/api/maintenance' });
      expect(page.body).toContain('اكتملت الترقية');
    } finally {
      await m.close();
    }
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('multi_user');
    expect(planBoot(configFor(dir))).toEqual({ kind: 'app' });
  });

  it('an unused recovery code works instead of the password and is NOT consumed', async () => {
    const dir = copy();
    const m = await maintenanceFor(dir);
    try {
      const start = await m.app.inject({ method: 'POST', url: '/api/maintenance/start', ...form({ username: USER.toUpperCase(), password: codes[1]!.toLowerCase().replace(/-/g, ' '), confirm: 'yes' }) });
      expect(start.statusCode, start.body).toBe(303);
      await m.finished;
    } finally {
      await m.close();
    }
    const sys = openDb(join(dir, 'system.sqlite'));
    try {
      expect(JSON.parse(sys.get<{ r: string }>('SELECT recovery_codes_json AS r FROM user_account')!.r)).toHaveLength(2);
    } finally {
      sys.close();
    }
  });

  it('MEDLEVO_OWNER_MIGRATION=apply starts at boot without the page', async () => {
    const dir = copy();
    const config = configFor(dir, { MEDLEVO_OWNER_MIGRATION: 'apply' });
    const plan = planBoot(config);
    expect(plan).toMatchObject({ kind: 'maintenance', start: 'apply' });
    const m = await startMaintenance({ config, plan: plan as Extract<typeof plan, { kind: 'maintenance' }>, migration: { verifyBoot: false } });
    try {
      await m.finished;
    } finally {
      await m.close();
    }
    expect(journalState(readJournal(dir))).toBe('complete');
  });
});

describe('an unfinished migration is resumed at boot; a rollback is done at boot', () => {
  it('a journal left by a crash → resumed at once → finished', async () => {
    const dir = copy();
    class Crash extends Error {}
    await expect(
      runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false, hooks: { at: (p) => { if (p === 'move_vault:renamed') throw new Crash(); } } }),
    ).rejects.toBeInstanceOf(Crash);
    expect(planBoot(configFor(dir))).toMatchObject({ kind: 'maintenance', start: 'resume' });
    const m = await maintenanceFor(dir);
    try {
      await m.finished;
    } finally {
      await m.close();
    }
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('multi_user');
  });

  it('a migration that stops for a retryable reason shows it; «retry» continues; and the owner can roll back instead', async () => {
    const dir = copy();
    class Crash extends Error {}
    await expect(
      runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false, hooks: { at: (p) => { if (p === 'system_db:done') throw new Crash(); } } }),
    ).rejects.toBeInstanceOf(Crash);
    // a running «other server» makes the resume stop with a retryable reason
    const config = configFor(dir);
    const plan = planBoot(config) as Extract<ReturnType<typeof planBoot>, { kind: 'maintenance' }>;
    writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid: 1, host: hostname(), started_at: 1, mode: 'app' }));
    const m = await startMaintenance({ config, plan, migration: { verifyBoot: false } });
    try {
      await until(m, 'failed');
      expect(m.status().error).toMatchObject({ code: 'SERVER_RUNNING', retryable: true });
      const page = await m.app.inject({ method: 'GET', url: '/api/maintenance' });
      expect(page.body).toContain('توقفت الترقية');
      expect(page.body).toContain('/api/maintenance/rollback');
      rmSync(join(dir, 'server.lock'));
      const back = await m.app.inject({ method: 'POST', url: '/api/maintenance/rollback', ...form({ username: USER, password: PASSWORD, confirm: 'yes' }) });
      expect(back.statusCode, back.body).toBe(303);
      await until(m, 'rolled_back');
    } finally {
      await m.close();
    }
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('legacy_single_owner');
    expect(readFileSync(join(dir, 'medlevo.sqlite')).equals(readFileSync(join(template, 'medlevo.sqlite')))).toBe(true);
  });

  it('MEDLEVO_OWNER_MIGRATION=rollback on a migrated directory → rolled back at boot, then «deploy the previous release»', async () => {
    const dir = copy();
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    const config = configFor(dir, { MEDLEVO_OWNER_MIGRATION: 'rollback' });
    const plan = planBoot(config);
    expect(plan).toMatchObject({ kind: 'maintenance', start: 'rollback' });
    const m = await startMaintenance({ config, plan: plan as Extract<typeof plan, { kind: 'maintenance' }> });
    try {
      await until(m, 'rolled_back');
      const page = await m.app.inject({ method: 'GET', url: '/' });
      expect(page.body).toContain('تم التراجع عن الترقية');
      expect(page.body).toContain('Rollback');
    } finally {
      await m.close();
    }
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('legacy_single_owner');
    // the variable still set on the next boot: the page keeps saying «rolled back» and offers no migration
    expect(planBoot(config)).toMatchObject({ kind: 'maintenance', start: 'rolled_back' });
  });

  it('a layout the boot guard refuses shows its reason (never setup)', async () => {
    const dir = join(work, 'orphans');
    mkdirSync(join(dir, 'vaults'), { recursive: true });
    writeFileSync(join(dir, 'vaults', 'x.sqlite'), 'x');
    const plan = planBoot(configFor(dir));
    expect(plan).toMatchObject({ kind: 'maintenance', start: 'blocked', state: 'orphan_vaults' });
    const m = await startMaintenance({ config: configFor(dir), plan: plan as Extract<typeof plan, { kind: 'maintenance' }> });
    try {
      const page = await m.app.inject({ method: 'GET', url: '/' });
      expect(page.body).toContain('system.sqlite');
      expect((await m.app.inject({ method: 'GET', url: '/api/auth/status' })).json()).toMatchObject({ setup_required: false });
    } finally {
      await m.close();
    }
  });

  it('a fresh or migrated directory boots the app', () => {
    expect(planBoot(configFor(join(work, 'brand-new')))).toEqual({ kind: 'app' });
  });
});

describe('the real server process (index.ts): maintenance page → migration → the app on the same port', () => {
  it('boots in maintenance on single-owner data, migrates when the owner asks, then serves the app with the old session', async () => {
    const { spawn } = await import('node:child_process');
    const { createServer } = await import('node:net');
    const { dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const dir = copy();
    const port = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(serverDir, 'src', 'index.ts')], {
      cwd: serverDir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NODE_ENV: 'production',
        MEDLEVO_DATA_DIR: dir,
        MEDLEVO_HOST: '127.0.0.1',
        MEDLEVO_PORT: String(port),
        MEDLEVO_ORIGIN: base,
        MEDLEVO_LOG_LEVEL: 'warn',
        MEDLEVO_SCRYPT_LOG_N: '12',
        MEDLEVO_SETUP_TOKEN: '',
        ANTHROPIC_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d: Buffer) => (log += d.toString()));
    child.stderr.on('data', (d: Buffer) => (log += d.toString()));
    const health = async () => {
      try {
        return (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean; maintenance?: boolean };
      } catch {
        return null;
      }
    };
    const waitFor = async (pred: (h: { ok: boolean; maintenance?: boolean } | null) => boolean, ms: number) => {
      const end = Date.now() + ms;
      for (;;) {
        const h = await health();
        if (pred(h)) return h;
        if (Date.now() > end) throw new Error(`timeout; server log:\n${log.slice(-3000)}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    try {
      expect(await waitFor((h) => h?.maintenance === true, 60_000)).toMatchObject({ ok: true, maintenance: true });
      const page = await fetch(`${base}/`);
      expect(await page.text()).toContain('الترقية لم تكتمل بعد');
      const start = await fetch(`${base}/api/maintenance/start`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
        body: new URLSearchParams({ username: USER, password: PASSWORD, confirm: 'yes' }).toString(),
      });
      expect(start.status).toBe(303);
      // the app replaces the maintenance server on the same port
      await waitFor((h) => h !== null && h.ok && h.maintenance === undefined, 120_000);
      const tree = await fetch(`${base}/api/library/tree`, { headers: { cookie: `medlevo_session=${token}` } });
      expect(tree.status, log.slice(-2000)).toBe(200);
      const settings = (await (await fetch(`${base}/api/settings`, { headers: { cookie: `medlevo_session=${token}` } })).json()) as Record<string, unknown>;
      expect(JSON.stringify(settings)).toContain('exam_focus');
      // the first boot was recorded in the journal (checksums and row counts again)
      const end = Date.now() + 20_000;
      while (!readJournal(dir).some((l) => l.step === 'first_boot') && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
      expect(readJournal(dir).some((l) => l.step === 'first_boot')).toBe(true);
      const redirect = await fetch(`${base}/api/maintenance`, { redirect: 'manual' });
      expect(redirect.status).toBe(303);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('close', r));
    }
  }, 240_000);
});
