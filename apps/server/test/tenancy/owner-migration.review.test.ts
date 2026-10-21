// P1-T1 step 3 — adversarial review of the owner migration (BUILD_PLAN §1.2). Each block reproduces a defect found by
// the review (it failed before the fix) or pins a property the builder's tests did not check:
//   1. zero loss across the WHOLE data directory: every file byte for byte, and every row of every table of the vault
//      after the first boot equal to the owner's database before the migration;
//   2. a double tap on «ابدأ الترقية» (two POSTs at once) started a second run that failed with IN_PROGRESS: the page
//      said «توقفت الترقية» while the first run went on, and offered «أعد المحاولة» / «تراجع» — a second runner (or a
//      rollback) in the same process, under the same journal;
//   3. a rollback brought back, in medlevo.sqlite, the sessions revoked under the new build (password change, «sign
//      out this device»): a stolen device signed out after the upgrade was signed in again by the previous release;
//   4. «Rollback» in Render BEFORE the data rollback: the previous release found no medlevo.sqlite, created an EMPTY one
//      and offered first-run setup (and its nightly off-site backups of that empty database) — now medlevo.sqlite is a
//      tombstone the previous release refuses to open, which this build recognises (and the rollback sets aside);
//   5. an empty / torn journal (a crash between creating the journal and its first fsync'd line) left the server
//      «blocked» forever with no way out but a shell: it is now recognised as «nothing started»;
//   6. MEDLEVO_OWNER_MIGRATION=rollback refused after a COMPLETE migration (another account exists): the page said
//      «بياناتك ما زالت في مكانها القديم» (false: they are in the vault) and offered a «retry» that can only fail.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { openDb } from '../../src/db/db';
import { migrate } from '../../src/db/migrate';
import { randomToken, sha256 } from '../../src/lib/hash';
import { newId } from '../../src/lib/ids';
import { generateRecoveryCode, hashSecret } from '../../src/modules/auth/password';
import { rowCounts } from '../../src/modules/data/backup';
import { detectDataDir, JOURNAL_FILE, MARKER_FILE } from '../../src/system/layout';
import { planBoot, startMaintenance, type MaintenanceServer } from '../../src/system/maintenance';
import {
  dataDirPaths,
  idsOf,
  isLegacyTombstone,
  journalState,
  planOwnerMigration,
  readJournal,
  recordFirstBoot,
  rollbackOwnerMigration,
  runOwnerMigration,
} from '../../src/system/ownerMigration';
import { CSRF, createClock, TEST_ORIGIN } from '../helpers/app';
import { processTemplateDir } from '../helpers/template';
import { buildLegacyFixture, copyLegacy, type LegacyFixture } from './legacy-fixture';

const USER = 'owner_review';
const PASSWORD = 'review-owner-password-1';
let work: string;
let template: string;
/** the same, with the owner's password hashed at the production cost (scrypt 2^15): checking it takes real time */
let slowTemplate: string;
let tokens: { a: string; b: string };
let sessionIds: { a: string; b: string };
let n = 0;

function env(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { NODE_ENV: 'test', MEDLEVO_DATA_DIR: dir, MEDLEVO_ORIGIN: TEST_ORIGIN, MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12', ...extra };
}
const configFor = (dir: string, extra: Record<string, string> = {}) => loadConfig(env(dir, extra));

/** a small single-owner data directory (R1-a schema, an owner, two signed-in devices, one stored file) */
async function buildTemplate(name = 'template', ownerLogN = 12): Promise<string> {
  const dir = join(work, name);
  const bytes = Buffer.from('lecture bytes of the owner (review)');
  const sha = sha256(bytes);
  const key = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
  mkdirSync(join(dir, 'files', sha.slice(0, 2), sha.slice(2, 4)), { recursive: true });
  writeFileSync(join(dir, 'files', key), bytes);
  const db = openDb(join(dir, 'medlevo.sqlite'));
  try {
    migrate(db);
    const hashes = await Promise.all([generateRecoveryCode(), generateRecoveryCode()].map((c) => hashSecret(c, 12)));
    const t = Date.now();
    db.run(`INSERT INTO owner (id, username, password_hash, recovery_codes_json, password_changed_at, created_at, updated_at) VALUES ('owner', ?, ?, ?, ?, ?, ?)`, [
      USER,
      await hashSecret(PASSWORD, ownerLogN),
      JSON.stringify(hashes),
      t - 1000,
      t - 5000,
      t - 1000,
    ]);
    tokens = { a: randomToken(32), b: randomToken(32) };
    sessionIds = { a: newId(), b: newId() };
    const session = (id: string, token: string, device: string, label: string) =>
      db.run(`INSERT INTO auth_session (id, token_hash, device_id, device_label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, sha256(token), device, label, t, t, t + 20 * 86_400_000]);
    session(sessionIds.a, tokens.a, 'DEV_IPAD', 'iPad');
    session(sessionIds.b, tokens.b, 'DEV_LOST_PHONE', 'هاتف');
    db.run(`INSERT INTO stored_file (id, sha256, size, mime, storage_key, original_name, created_at) VALUES (?, ?, ?, 'application/pdf', ?, 'l.pdf', ?)`, [newId(), sha, bytes.length, key, t]);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  return dir;
}

function copyDir(from: string): string {
  const dir = join(work, `case-${++n}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const walk = (rel: string) => {
    for (const name of readdirSync(join(from, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(join(from, r)).isDirectory()) {
        mkdirSync(join(dir, r), { recursive: true });
        walk(r);
      } else writeFileSync(join(dir, r), readFileSync(join(from, r)));
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

/** every row of every table (ordered by rowid, or by all columns for WITHOUT ROWID tables), as JSON strings */
function dumpTables(path: string): Record<string, string[]> {
  const db = openDb(path);
  try {
    const out: Record<string, string[]> = {};
    const tables = db.all<{ name: string; sql: string | null }>(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    for (const t of tables) {
      if (/CREATE VIRTUAL TABLE/i.test(t.sql ?? '')) continue; // FTS content lives in its shadow tables (dumped)
      const withoutRowid = /WITHOUT ROWID/i.test(t.sql ?? '');
      const rows = db.all<Record<string, unknown>>(withoutRowid ? `SELECT * FROM "${t.name}"` : `SELECT * FROM "${t.name}" ORDER BY rowid`);
      const enc = rows.map((r) => JSON.stringify(r, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? v.toString() : v)));
      out[t.name] = withoutRowid ? enc.sort() : enc;
    }
    return out;
  } finally {
    db.close();
  }
}

const form = (fields: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_ORIGIN },
  payload: new URLSearchParams(fields).toString(),
});

async function until(m: MaintenanceServer, phase: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (m.status().phase !== phase) {
    if (Date.now() > end) throw new Error(`phase ${m.status().phase} (wanted ${phase}): ${JSON.stringify(m.status().error)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function boot(dir: string) {
  const app = await buildApp({ config: configFor(dir), overrides: { aiProvider: null, templateDir: processTemplateDir(), clock: createClock(Date.now()) } });
  await app.ready();
  return app;
}

/** What the previous release (R1-a) does at boot: open DATA_DIR/medlevo.sqlite (creating it when absent) and migrate. */
function previousReleaseBoot(dir: string): { ok: true; owner: number } | { ok: false; error: string } {
  try {
    const db = openDb(join(dir, 'medlevo.sqlite'));
    try {
      migrate(db);
      return { ok: true, owner: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM owner')!.n };
    } finally {
      db.close();
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

let fx: LegacyFixture;
beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'medlevo-owner-migration-review-'));
  // (the slow one first: `tokens` / `sessionIds` below are those of `template`)
  slowTemplate = await buildTemplate('template-slow', 15);
  template = await buildTemplate();
  fx = await buildLegacyFixture(work);
}, 300_000);
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('review 1 — zero loss across the whole data directory', () => {
  it('every file byte for byte; every row of every table of the vault after the first boot equals the owner database', async () => {
    const dir = copyLegacy(fx, join(work, `legacy-${++n}`));
    const before = snapshot(dir);
    const rowsBefore = dumpTables(join(dir, 'medlevo.sqlite'));
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    const ids = idsOf(readJournal(dir))!;
    const vault = `vaults/${ids.dbFile}`;
    const after = snapshot(dir);
    for (const [path, sha] of Object.entries(before)) {
      if (path === 'medlevo.sqlite') expect(after[vault], vault).toBe(sha);
      else expect(after[path], path).toBe(sha);
    }
    // the first boot (as index.ts does it: the app, its first-boot record, a clean stop)
    const app = await boot(dir);
    try {
      await recordFirstBoot({
        dataDir: dir,
        vaultPath: (id) => app.ctx.pool.pathOf('vault', id),
        checkpoint: (id) =>
          app.ctx.binding.run({ kind: 'vault', vaultId: id, viewer: null }, () => {
            app.ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            return rowCounts(app.ctx.db);
          }),
      });
    } finally {
      await app.close();
    }
    const afterBoot = snapshot(dir);
    for (const [path, sha] of Object.entries(before)) {
      if (path === 'medlevo.sqlite') continue;
      expect(afterBoot[path], `${path} after the first boot`).toBe(sha);
    }
    const rowsAfter = dumpTables(join(dir, vault));
    const changed = Object.keys({ ...rowsBefore, ...rowsAfter }).filter((t) => JSON.stringify(rowsBefore[t]) !== JSON.stringify(rowsAfter[t]));
    expect(changed, `tables changed by the migration + first boot: ${changed.join(', ')}`).toEqual([]);
  }, 240_000);
});

describe('review 2 — a double tap on «ابدأ الترقية» starts ONE migration and never shows a false «stopped»', () => {
  it('two POSTs at once: one run, the page keeps saying «running»; retry / rollback are refused while it runs', async () => {
    const dir = copyDir(slowTemplate);
    const config = configFor(dir);
    const plan = planBoot(config);
    if (plan.kind !== 'maintenance') throw new Error('expected maintenance');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = await startMaintenance({
      config,
      plan,
      migration: {
        verifyBoot: false,
        hooks: {
          at: async (p) => {
            if (p === 'system_db:written') await gate;
          },
        },
      },
    });
    try {
      const body = form({ username: USER, password: PASSWORD, confirm: 'yes' });
      // the second tap arrives while the first one's password is still being checked
      // (light-my-request dispatches on the first `then`: start each one explicitly)
      const first = m.app.inject({ method: 'POST', url: '/api/maintenance/start', ...body }).then((r) => r);
      await new Promise((r) => setTimeout(r, 15));
      const second = m.app.inject({ method: 'POST', url: '/api/maintenance/start', ...body }).then((r) => r);
      const [r1, r2] = await Promise.all([first, second]);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([303, 409]);
      // let the first run reach its pause, then look at what the owner sees
      const end = Date.now() + 30_000;
      while (!readJournal(dir).some((l) => l.step === 'system_db' && l.status === 'started') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
      expect(m.status().phase).toBe('running');
      expect(m.status().error).toBeNull();
      const retry = await m.app.inject({ method: 'POST', url: '/api/maintenance/retry', ...form({ username: USER, password: PASSWORD }) });
      expect(retry.statusCode).toBe(409);
      const back = await m.app.inject({ method: 'POST', url: '/api/maintenance/rollback', ...body });
      expect(back.statusCode).toBe(409);
      release();
      await m.finished;
      expect(m.status().phase).toBe('done');
    } finally {
      release();
      await m.close();
    }
    const lines = readJournal(dir);
    expect(lines.filter((l) => l.step === 'begin')).toHaveLength(1);
    expect(lines.filter((l) => l.status === 'failed')).toEqual([]);
    expect(journalState(lines)).toBe('complete');
  }, 120_000);

  it('a double tap on «أعد المحاولة» (or «أعد المحاولة» and «تراجع» at once) after a stop runs ONE thing', async () => {
    const dir = copyDir(slowTemplate);
    class Crash extends Error {}
    await expect(
      runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false, hooks: { at: (p) => { if (p === 'freeze:done') throw new Crash(); } } }),
    ).rejects.toBeInstanceOf(Crash);
    // the resume at boot stops for a retryable reason (another server holds the data directory)
    writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid: 1, host: hostname(), started_at: 1, mode: 'app' }));
    const config = configFor(dir);
    const plan = planBoot(config);
    if (plan.kind !== 'maintenance') throw new Error('expected maintenance');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = await startMaintenance({ config, plan, migration: { verifyBoot: false, hooks: { at: async (p) => { if (p === 'system_db:written') await gate; } } } });
    let rolledBack = false;
    try {
      await until(m, 'failed');
      rmSync(join(dir, 'server.lock'));
      const retry = form({ username: USER, password: PASSWORD });
      const first = m.app.inject({ method: 'POST', url: '/api/maintenance/retry', ...retry }).then((r) => r);
      await new Promise((r) => setTimeout(r, 15));
      const second = m.app.inject({ method: 'POST', url: '/api/maintenance/retry', ...retry }).then((r) => r);
      await new Promise((r) => setTimeout(r, 15));
      const third = m.app.inject({ method: 'POST', url: '/api/maintenance/rollback', ...form({ username: USER, password: PASSWORD, confirm: 'yes' }) }).then((r) => r);
      const codes = (await Promise.all([first, second, third])).map((r) => r.statusCode);
      expect(codes.filter((c) => c === 303), JSON.stringify(codes)).toHaveLength(1);
      // whichever password check finished first won (normally the first retry); the other two were refused
      rolledBack = codes[2] === 303;
      if (rolledBack) {
        await until(m, 'rolled_back');
      } else {
        const end = Date.now() + 30_000;
        while (!readJournal(dir).some((l) => l.step === 'system_db' && l.status === 'started') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
        await new Promise((r) => setTimeout(r, 100));
        expect(m.status().phase).toBe('running');
        release();
        await m.finished;
      }
    } finally {
      release();
      await m.close();
    }
    if (rolledBack) {
      expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('legacy_single_owner');
      expect(readFileSync(join(dir, 'medlevo.sqlite')).equals(readFileSync(join(slowTemplate, 'medlevo.sqlite')))).toBe(true);
      return;
    }
    const lines = readJournal(dir);
    expect(lines.filter((l) => l.step === 'safety' && l.status === 'started')).toHaveLength(1);
    expect(lines.filter((l) => l.step === 'rollback')).toEqual([]);
    expect(journalState(lines)).toBe('complete');
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('multi_user');
  }, 120_000);

  it('the migration itself refuses a second concurrent run in the same process (defence in depth)', async () => {
    const dir = copyDir(template);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false, hooks: { at: async (p) => { if (p === 'freeze:done') await gate; } } });
    await new Promise((r) => setTimeout(r, 50));
    await expect(runOwnerMigration({ config: configFor(dir), mode: 'resume', verifyBoot: false })).rejects.toMatchObject({ code: 'BUSY' });
    await expect(rollbackOwnerMigration({ config: configFor(dir) })).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await first;
    expect(journalState(readJournal(dir))).toBe('complete');
  }, 120_000);
});

describe('review 3 — a rollback keeps sessions revoked under the new build revoked', () => {
  it('a device signed out after the upgrade (password change, «sign out this device») is not signed in again by the previous release', async () => {
    const dir = copyDir(template);
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    const app = await boot(dir);
    try {
      const h = { cookie: `medlevo_session=${tokens.a}`, ...CSRF, 'user-agent': 'vitest' };
      // the owner changes the password from the iPad: every other session (the lost phone) is revoked
      const pw = await app.inject({ method: 'POST', url: '/api/auth/password', headers: h, payload: { current_password: PASSWORD, new_password: 'a-new-password-after-loss-7' } });
      expect(pw.statusCode, pw.body).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/library/tree', headers: { cookie: `medlevo_session=${tokens.b}`, ...CSRF } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
    const out = await rollbackOwnerMigration({ config: configFor(dir) });
    expect(out.movedBack).toBe(true);
    // what the previous release checks for a session cookie (R1-a modules/auth/sessions.ts findActive)
    const db = openDb(join(dir, 'medlevo.sqlite'));
    try {
      const active = (token: string) => db.get<{ id: string }>('SELECT id FROM auth_session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?', [sha256(token), Date.now()]);
      expect(active(tokens.b), 'the revoked phone session must stay revoked').toBeUndefined();
      expect(active(tokens.a)?.id, 'the iPad session (still active) keeps working').toBe(sessionIds.a);
    } finally {
      db.close();
    }
  }, 120_000);
});

describe('review 4 — «Rollback» in Render before the data rollback never shows setup over the migrated data', () => {
  it('the previous release refuses DATA_DIR/medlevo.sqlite after the migration; this build boots it; the rollback sets the tombstone aside', async () => {
    const dir = copyDir(template);
    const legacy = readFileSync(join(dir, 'medlevo.sqlite'));
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    expect(isLegacyTombstone(join(dir, 'medlevo.sqlite'))).toBe(true);
    const ids = idsOf(readJournal(dir))!;
    const vaultBefore = readFileSync(join(dir, 'vaults', ids.dbFile));
    // the previous release booted on it by mistake: it must refuse — never an empty database and a setup screen
    const r1a = previousReleaseBoot(dir);
    expect(r1a.ok, JSON.stringify(r1a)).toBe(false);
    expect(isLegacyTombstone(join(dir, 'medlevo.sqlite'))).toBe(true);
    expect(readFileSync(join(dir, 'vaults', ids.dbFile)).equals(vaultBefore)).toBe(true);
    // this build: still a finished multi-user layout (the tombstone is not «single-owner data beside it»)
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('multi_user');
    expect(planBoot(configFor(dir))).toEqual({ kind: 'app' });
    const app = await boot(dir);
    await app.close();
    // the dry run and a second apply do not mistake the tombstone for the owner's database
    expect(planOwnerMigration(configFor(dir)).legacy).toBeNull();
    // the data rollback (in the right order) puts the real database back in place of the tombstone
    const out = await rollbackOwnerMigration({ config: configFor(dir) });
    expect(out.movedBack).toBe(true);
    expect(isLegacyTombstone(join(dir, 'medlevo.sqlite'))).toBe(false);
    expect(readFileSync(join(dir, 'medlevo.sqlite')).equals(legacy)).toBe(true);
    expect(readdirSync(out.setAside)).toEqual(expect.arrayContaining([JOURNAL_FILE, MARKER_FILE, 'system.sqlite', 'medlevo.sqlite.moved-to-vault']));
    const back = previousReleaseBoot(dir);
    expect(back).toMatchObject({ ok: true, owner: 1 });
  }, 120_000);

  it('a tombstone left alone (system DB and vaults gone) is never «fresh»: no setup mode over it', async () => {
    const dir = copyDir(template);
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    for (const f of ['system.sqlite', MARKER_FILE, JOURNAL_FILE]) rmSync(join(dir, f), { force: true });
    rmSync(join(dir, 'vaults'), { recursive: true, force: true });
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('orphan_vaults');
    expect(planBoot(configFor(dir))).toMatchObject({ kind: 'maintenance', start: 'blocked' });
  }, 60_000);

  it('a crash right after the move (before the tombstone) resumes and writes it; a crash inside the rollback after setting it aside resumes', async () => {
    const dir = copyDir(template);
    class Crash extends Error {}
    await expect(
      runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false, hooks: { at: (p) => { if (p === 'move_vault:renamed') throw new Crash(); } } }),
    ).rejects.toBeInstanceOf(Crash);
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('migration_in_progress');
    await runOwnerMigration({ config: configFor(dir), mode: 'resume', verifyBoot: false });
    expect(isLegacyTombstone(join(dir, 'medlevo.sqlite'))).toBe(true);
    await expect(
      rollbackOwnerMigration({ config: configFor(dir), hooks: { at: (p) => { if (p === 'rollback:tombstone_aside') throw new Crash(); } } }),
    ).rejects.toBeInstanceOf(Crash);
    expect(existsSync(join(dir, 'medlevo.sqlite'))).toBe(false);
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('migration_in_progress');
    await rollbackOwnerMigration({ config: configFor(dir) });
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('legacy_single_owner');
    expect(readFileSync(join(dir, 'medlevo.sqlite')).equals(readFileSync(join(template, 'medlevo.sqlite')))).toBe(true);
  }, 120_000);
});

describe('review 5 — an empty or torn journal (crash before its first line was on disk) is «nothing started»', () => {
  for (const content of ['', '{"v":1,"step":"beg']) {
    it(`journal ${JSON.stringify(content)}: the page waits for the owner and «ابدأ» works`, async () => {
      const dir = copyDir(template);
      writeFileSync(join(dir, JOURNAL_FILE), content);
      const config = configFor(dir);
      const plan = planBoot(config);
      expect(plan).toMatchObject({ kind: 'maintenance', start: 'wait' });
      expect(planOwnerMigration(config).can_apply).toBe(true);
      await runOwnerMigration({ config, mode: 'apply', verifyBoot: false });
      expect(journalState(readJournal(dir))).toBe('complete');
      expect(readdirSync(dir).some((f) => f.startsWith('migration-journal.aborted-'))).toBe(true);
    }, 60_000);
  }
});

describe('review 6 — a boot-time rollback refused after a complete migration says where the data is and what to do', () => {
  it('another account exists: «failed», the data is in the vault, remove the variable — no false «old place», no useless retry', async () => {
    const dir = copyDir(template);
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    const app = await boot(dir);
    try {
      app.ctx.tenancy.createAccount({ username: 'student_two', displayName: 'student two', passwordHash: 'scrypt$x', recoveryHashes: [], isPlatformAdmin: false, timezone: 'Asia/Baghdad' });
    } finally {
      await app.close();
    }
    const config = configFor(dir, { MEDLEVO_OWNER_MIGRATION: 'rollback' });
    const plan = planBoot(config);
    if (plan.kind !== 'maintenance') throw new Error('expected maintenance');
    const m = await startMaintenance({ config, plan });
    try {
      await until(m, 'failed');
      expect(m.status().error).toMatchObject({ code: 'OTHER_ACCOUNTS' });
      const page = (await m.app.inject({ method: 'GET', url: '/api/maintenance' })).body;
      expect(page).not.toContain('في مكانها القديم');
      expect(page).toContain('خزنة الحساب رقم 1');
      expect(page).toContain('MEDLEVO_OWNER_MIGRATION');
      expect(page).not.toContain('/api/maintenance/retry');
    } finally {
      await m.close();
    }
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('multi_user');
  }, 120_000);
});
