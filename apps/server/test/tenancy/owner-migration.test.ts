// P1-T1 step 3 — the journaled owner migration (ADR-0003 §5; PRD X8 a–b; BUILD_PLAN §3.3 «owner-migration.test.ts»).
//
// On a copy of a realistic R1-a single-owner data directory (test/tenancy/legacy-fixture.ts: processed lectures, ink in
// two layers, notes, cards with review history, an exam in progress, a recording, a listed backup, two signed-in
// devices): the vault file's sha256 equals the pre-move reference before the first boot; row counts are equal;
// checksums are recorded again after the first boot; the old password and an unused recovery code validate; devices
// keep their pull cursor and epoch; a legacy outbox queued on two devices replays with every op applied exactly once;
// a crash injected at EVERY point resumes to the same end state and the boot never enters setup mode; a real process
// killed with SIGKILL mid-migration resumes; the migration refuses to run twice; rollback (and a crash inside it)
// gives back the single-owner directory that the previous build reads unchanged.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SyncOpResult } from '@medlevo/shared';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { openDb } from '../../src/db/db';
import { migrate, readMigrations } from '../../src/db/migrate';
import { sha256File } from '../../src/lib/hash';
import { verifySecret } from '../../src/modules/auth/password';
import { rowCounts } from '../../src/modules/data/backup';
import { DataDirRefusedError, detectDataDir, JOURNAL_FILE, MARKER_FILE } from '../../src/system/layout';
import {
  dataDirPaths,
  idsOf,
  isLegacyTombstone,
  isStepDone,
  journalState,
  MIGRATION_DIR,
  OwnerMigrationError,
  planOwnerMigration,
  readJournal,
  recordFirstBoot,
  referenceOf,
  rollbackOwnerMigration,
  runOwnerMigration,
} from '../../src/system/ownerMigration';
import { FakeS3 } from '../data/fake-s3';
import { CSRF, createClock, sessionCookie, TEST_ORIGIN } from '../helpers/app';
import { processTemplateDir } from '../helpers/template';
import { buildLegacyFixture, copyLegacy, IPAD, LEGACY_PASSWORD, LEGACY_USERNAME, PHONE, READ_API_URLS, type LegacyFixture } from './legacy-fixture';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(SERVER_DIR, 'src', 'cli', 'migrate-multi-user.ts');
const KEY = Buffer.alloc(32, 7).toString('base64');

let fx: LegacyFixture;
let work: string;
let fake: FakeS3;
let n = 0;
const fresh = () => copyLegacy(fx, join(work, `case-${++n}`));

function env(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { NODE_ENV: 'test', MEDLEVO_DATA_DIR: dir, MEDLEVO_ORIGIN: TEST_ORIGIN, MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12', ...extra };
}
const configFor = (dir: string, extra: Record<string, string> = {}) => loadConfig(env(dir, extra));
const r2 = () => ({
  MEDLEVO_R2_ENDPOINT: fake.endpoint,
  MEDLEVO_R2_BUCKET: fake.bucket,
  MEDLEVO_R2_ACCESS_KEY_ID: fake.accessKeyId,
  MEDLEVO_R2_SECRET_ACCESS_KEY: fake.secretAccessKey,
  MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY,
});

/** Every file under a directory with its sha256 (byte-for-byte comparison of a whole data directory). */
function snapshot(dir: string, base = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(dir, base))) {
    const rel = base ? `${base}/${name}` : name;
    const abs = join(dir, rel);
    let isDir = false;
    try {
      isDir = readdirSync(abs) !== undefined;
    } catch {
      isDir = false;
    }
    if (isDir) Object.assign(out, snapshot(dir, rel));
    else out[rel] = createHash('sha256').update(readFileSync(abs)).digest('hex');
  }
  return out;
}

/** The end state of a migrated directory, without the ids a run chooses (comparable across runs). */
function endState(dir: string) {
  const lines = readJournal(dir);
  const ids = idsOf(lines)!;
  const sys = openDb(join(dir, 'system.sqlite'));
  try {
    const user = sys.get<Record<string, unknown>>('SELECT username, username_norm, password_hash, recovery_codes_json, password_changed_at, created_at, is_platform_admin, legacy_owner, status FROM user_account');
    return {
      state: detectDataDir(dataDirPaths(configFor(dir))).kind,
      journal: journalState(lines),
      steps: lines.filter((l) => l.status === 'done').map((l) => l.step),
      marker: existsSync(join(dir, MARKER_FILE)),
      legacy: existsSync(join(dir, 'medlevo.sqlite')),
      tmp: readdirSync(dir).filter((f) => f.includes('.tmp')),
      users: sys.get<{ n: number }>('SELECT COUNT(*) AS n FROM user_account')!.n,
      user,
      vaults: sys.all<{ status: string; db_file: string }>('SELECT status, db_file FROM vault').map((v) => ({ status: v.status, file: v.db_file === `${ids.vaultId}.sqlite` })),
      devices: sys.all<{ device_id: string; has_uid: number }>('SELECT device_id, length(device_uid) > 20 AS has_uid FROM device ORDER BY device_id'),
      sessions: sys.all<{ id: string; token_hash: string }>('SELECT id, token_hash FROM auth_session ORDER BY id'),
      blobs: sys.all<{ sha256: string }>('SELECT sha256 FROM blob ORDER BY sha256').map((b) => b.sha256),
      hints: sys.get<{ n: number }>('SELECT COUNT(*) AS n FROM blob_ref')!.n,
      jobs: sys.all<{ job_id: string; status: string }>('SELECT job_id, status FROM job_index ORDER BY job_id'),
      audit: sys.all<{ action: string }>("SELECT action FROM security_audit WHERE action = 'owner_migration'").length,
    };
  } finally {
    sys.close();
  }
}

async function boot(dir: string, extra: Record<string, string> = {}) {
  const app = await buildApp({ config: configFor(dir, extra), overrides: { aiProvider: null, templateDir: processTemplateDir(), clock: createClock() } });
  await app.ready();
  return app;
}

const legacyCookie = (token: string) => ({ cookie: `medlevo_session=${token}`, ...CSRF });

function spawnCli(args: string[], extraEnv: Record<string, string>, opts: { onStderr?: (s: string, kill: () => void) => void } = {}): { child: ChildProcess; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> } {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', CLI, ...args], {
    cwd: SERVER_DIR,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', INIT_CWD: SERVER_DIR, ANTHROPIC_API_KEY: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => {
    out += d.toString();
    opts.onStderr?.(out, () => child.kill('SIGKILL'));
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal, out })));
  return { child, done };
}

function cli(args: string[], extraEnv: Record<string, string>, opts: { onStderr?: (s: string, kill: () => void) => void } = {}) {
  return spawnCli(args, extraEnv, opts).done;
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'medlevo-owner-migration-'));
  fake = new FakeS3({ minPartBytes: 64 * 1024 });
  await fake.start();
  fx = await buildLegacyFixture(work);
}, 300_000);

afterAll(async () => {
  await fake?.stop();
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('the release rule (BUILD_PLAN §1.3)', () => {
  it('the fixture database holds every base migration this build ships — so the first boot opens the vault unchanged', () => {
    const db = openDb(join(fx.dir, 'medlevo.sqlite'));
    try {
      const applied = db.all<{ name: string }>('SELECT name FROM schema_migration ORDER BY name').map((r) => r.name);
      expect(applied).toEqual(readMigrations().map((m) => m.name));
      expect(applied).toContain('0861_attribution.sql'); // R1-a's last base migration: R1-b adds none (Phase 1 completion C2 adds 0862 after it)
    } finally {
      db.close();
    }
  });
});

describe('dry run', () => {
  it('reports what it would do and changes no byte', () => {
    const dir = fresh();
    const before = snapshot(dir);
    const report = planOwnerMigration(configFor(dir));
    expect(snapshot(dir)).toEqual(before);
    expect(report.state).toBe('legacy_single_owner');
    expect(report.can_apply).toBe(true);
    expect(report.problems_ar).toEqual([]);
    expect(report.legacy!.owner_username).toBe(LEGACY_USERNAME);
    expect(report.legacy!.pending_base_migrations).toEqual([]);
    expect(report.legacy!.active_sessions).toBe(2);
    expect(report.legacy!.counts.annotation).toBeGreaterThan(3);
    expect(report.legacy!.files.count).toBeGreaterThan(2);
    expect(report.legacy!.files.missing).toBe(0);
  });
});

describe('apply (X8 a–b)', () => {
  let dir: string;
  let referenceSha: string;
  beforeAll(async () => {
    dir = fresh();
    referenceSha = (await sha256File(join(dir, 'medlevo.sqlite'))).sha256;
    await runOwnerMigration({ config: configFor(dir, r2()), mode: 'apply', verifyBoot: true, offsite: { client: { sleep: async () => {} }, partSizeBytes: 64 * 1024, encChunkSize: 4096 } });
  }, 240_000);

  it('moves the database byte for byte, records the reference, a verified backup and its encrypted R2 copy', async () => {
    const lines = readJournal(dir);
    expect(journalState(lines)).toBe('complete');
    const ref = referenceOf(lines)!;
    const ids = idsOf(lines)!;
    // the vault file IS the owner's database: same sha256 before the first boot
    expect(ref.sha256).toBe(referenceSha);
    expect((await sha256File(join(dir, 'vaults', ids.dbFile))).sha256).toBe(referenceSha);
    expect(lines.find((l) => l.step === 'verify' && l.status === 'done')!.pre_boot_sha256).toBe(referenceSha);
    // (review) the old place holds the tombstone an older release refuses — never the database, never nothing
    expect(isLegacyTombstone(join(dir, 'medlevo.sqlite'))).toBe(true);
    expect(existsSync(join(dir, MARKER_FILE))).toBe(true);
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('multi_user');
    // the step-0 backup: in DATA_DIR/migration, verified by a real restore check, and its encrypted copy in R2
    const safety = lines.find((l) => l.step === 'safety' && l.status === 'done')!;
    const backup = safety.backup as { path: string; sha256: string };
    expect(backup.path.startsWith(join(dir, MIGRATION_DIR))).toBe(true);
    expect((await sha256File(backup.path)).sha256).toBe(backup.sha256);
    const report = JSON.parse(readFileSync(`${backup.path}.verify.json`, 'utf8')) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(report.ok).toBe(true);
    expect(report.checks.some((c) => /boot/.test(c.name) && c.ok)).toBe(true);
    const offsite = safety.offsite as { key: string; size: number };
    expect(offsite.key).toMatch(/backups\/medlevo-backup-.+\.tar\.gz\.mlenc$/);
    expect(fake.objects.get(offsite.key)?.body.length).toBe(offsite.size);
  });

  it('user #1 is the owner verbatim; sessions, devices, blobs and unfinished jobs are in the system DB', () => {
    const s = endState(dir);
    const legacy = openDb(join(fx.dir, 'medlevo.sqlite'));
    try {
      const owner = legacy.get<Record<string, unknown>>(`SELECT username, password_hash, recovery_codes_json, password_changed_at, created_at FROM owner`)!;
      expect(s.user).toMatchObject({ ...owner, is_platform_admin: 1, legacy_owner: 1, status: 'active', username_norm: LEGACY_USERNAME });
      expect(s.users).toBe(1);
      expect(s.vaults).toEqual([{ status: 'active', file: true }]);
      // both active sessions keep their token hash (signed-in devices stay signed in); the expired one is not copied
      const active = legacy.all<{ id: string; token_hash: string }>(`SELECT id, token_hash FROM auth_session WHERE expires_at > ? ORDER BY id`, [Date.now()]);
      expect(s.sessions).toEqual(active);
      expect(s.sessions).toHaveLength(2);
      // a device row (server-issued device_uid) for every device id the database knows — sessions and sync history
      expect(s.devices.map((d) => d.device_id)).toEqual(expect.arrayContaining([IPAD, PHONE, 'DATA_TEST_DEVICE', 'OLD_LAPTOP_03']));
      expect(s.devices.every((d) => d.has_uid === 1)).toBe(true);
      expect(s.blobs).toEqual(legacy.all<{ sha256: string }>('SELECT sha256 FROM stored_file ORDER BY sha256').map((r) => r.sha256));
      expect(s.hints).toBe(s.blobs.length);
      expect(s.jobs.map((j) => j.job_id)).toEqual(legacy.all<{ id: string }>(`SELECT id FROM processing_job WHERE status IN ('queued','running','waiting_for_input') ORDER BY id`).map((r) => r.id));
      expect(s.audit).toBe(1);
      expect(s.tmp).toEqual([]);
    } finally {
      legacy.close();
    }
  });

  it('first boot: the vault opens unchanged; the old password, a recovery code and both sessions work; the same data answers', async () => {
    const app = await boot(dir);
    try {
      // checksums and per-table row counts recorded again after the first boot (ADR-0003 §5 step 11)
      const ids = idsOf(readJournal(dir))!;
      const line = await recordFirstBoot({
        dataDir: dir,
        vaultPath: (id) => app.ctx.pool.pathOf('vault', id),
        checkpoint: (id) => app.ctx.binding.run({ kind: 'vault', vaultId: id, viewer: null }, () => {
          app.ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          return rowCounts(app.ctx.db);
        }),
      });
      expect(line).not.toBeNull();
      expect(isStepDone(readJournal(dir), 'first_boot')).toBe(true);
      const ref = referenceOf(readJournal(dir))!;
      // no base migration ran at the first boot
      const vault = app.ctx.binding.run({ kind: 'vault', vaultId: ids.vaultId, viewer: null }, () => app.ctx.db.all<{ name: string }>('SELECT name FROM schema_migration ORDER BY name').map((r) => r.name));
      expect(vault).toEqual(ref.migrations);
      // the old password signs in; an unused recovery code validates (checked without consuming it)
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'user-agent': 'vitest' }, payload: { username: LEGACY_USERNAME, password: LEGACY_PASSWORD } });
      expect(login.statusCode, login.body).toBe(200);
      const user = app.ctx.system.users.findForAuth(LEGACY_USERNAME)!;
      const hashes = JSON.parse(user.recovery_codes_json) as string[];
      expect(hashes).toHaveLength(fx.recoveryCodes.length);
      expect(await verifySecret(fx.recoveryCodes[1]!, hashes[1]!)).toBe(true);
      // the expired legacy session is not a session; both active ones are, and they see exactly the data from before
      expect((await app.inject({ method: 'GET', url: '/api/library/tree', headers: legacyCookie(fx.tokens.expired) })).statusCode).toBe(401);
      for (const token of [fx.tokens.ipad, fx.tokens.phone]) {
        for (const url of READ_API_URLS) {
          const r = await app.inject({ method: 'GET', url, headers: legacyCookie(token) });
          expect(r.statusCode, `${url} ${r.body}`).toBe(200);
          expect(r.json(), url).toEqual(fx.apiBefore[url]);
        }
      }
    } finally {
      await app.close();
    }
  });

  it('devices keep their cursor and epoch; the legacy outbox of two devices replays with every op applied exactly once', async () => {
    const app = await boot(dir);
    try {
      const h = legacyCookie(fx.tokens.ipad);
      // pull continues with the same cursor and epoch: nothing new since what the devices had
      const pull = (await app.inject({ method: 'GET', url: `/api/sync/pull?since=${fx.pullBefore.head_seq}`, headers: h })).json() as { changes: unknown[]; server_epoch: string; head_seq: number };
      expect(pull.server_epoch).toBe(fx.pullBefore.server_epoch);
      expect(pull.head_seq).toBe(fx.pullBefore.head_seq);
      expect(pull.changes).toEqual([]);
      const push = async (headers: Record<string, string>, ops: unknown[]) => {
        const r = await app.inject({ method: 'POST', url: '/api/sync/push', headers, payload: { ops, server_epoch: fx.pullBefore.server_epoch } });
        expect(r.statusCode, r.body).toBe(200);
        return (r.json() as { results: SyncOpResult[] }).results;
      };
      // the queued ops of both devices (each device pushes its own, with its own session)
      const ipadOps = fx.queuedOps.filter((o) => o.device_id === IPAD);
      const phoneOps = fx.queuedOps.filter((o) => o.device_id === PHONE);
      const first = [...(await push(h, ipadOps)), ...(await push(legacyCookie(fx.tokens.phone), phoneOps))];
      expect(first.map((r) => r.result)).toEqual(fx.queuedOps.map(() => 'applied'));
      // retried (the device lost the answer): duplicates, never applied twice; ops pushed BEFORE the upgrade too
      const again = await push(h, fx.queuedOps);
      expect(again.map((r) => r.result)).toEqual(fx.queuedOps.map(() => 'duplicate'));
      const old = await push(h, fx.pushedOps.slice(0, 5));
      expect(old.every((r) => r.result === 'duplicate')).toBe(true);
      // and every queued entity exists exactly once
      const ids = idsOf(readJournal(dir))!;
      app.ctx.binding.run({ kind: 'vault', vaultId: ids.vaultId, viewer: null }, () => {
        for (const o of fx.queuedOps) {
          expect(app.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_operation WHERE op_id = ?', [o.op_id])!.n).toBe(1);
          expect(app.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_operation WHERE op_id = ? AND result = 'rejected'`, [o.op_id])!.n).toBe(0);
        }
      });
      const after = (await app.inject({ method: 'GET', url: `/api/sync/pull?since=${fx.pullBefore.head_seq}`, headers: h })).json() as { changes: Array<{ entity_id: string }> };
      expect(after.changes.map((c) => c.entity_id).sort()).toEqual(expect.arrayContaining(fx.queuedOps.map((o) => o.entity_id)));
    } finally {
      await app.close();
    }
  });

  it('refuses to run twice', async () => {
    await expect(runOwnerMigration({ config: configFor(dir), mode: 'apply' })).rejects.toMatchObject({ code: 'ALREADY_MIGRATED' });
    const r = await cli(['--apply', '--data-dir', dir], env(dir));
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/اكتملت الترقية من قبل/);
  }, 60_000);
});

describe('boot guard — never setup mode over the owner data', () => {
  it('a single-owner directory and an unfinished journal are refused by the app (nothing created)', async () => {
    const dir = fresh();
    const before = snapshot(dir);
    await expect(boot(dir)).rejects.toBeInstanceOf(DataDirRefusedError);
    expect(snapshot(dir)).toEqual(before);
  });

  it('marker + system DB + a medlevo.sqlite beside them (a half-done manual rollback) is refused, not ignored', async () => {
    const dir = fresh();
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    writeFileSync(join(dir, 'medlevo.sqlite'), readFileSync(join(fx.dir, 'medlevo.sqlite')));
    await expect(boot(dir)).rejects.toBeInstanceOf(DataDirRefusedError);
  }, 120_000);
});

describe('crash at every point of the journal resumes to the same end state', () => {
  const POINTS = [
    'begin:done',
    'freeze:started',
    'freeze:done',
    'safety:started',
    'safety:backup_written',
    'safety:done',
    'system_db:started',
    'system_db:written',
    'system_db:done',
    'move_vault:started',
    'move_vault:renamed',
    'move_vault:tombstone', // (review) the tombstone at medlevo.sqlite
    'move_vault:done',
    'commit:started',
    'commit:renamed',
    'commit:marker',
    'commit:done',
    'verify:started',
    'verify:done',
  ];
  let reference: ReturnType<typeof endState>;
  let legacySha: string;
  beforeAll(async () => {
    const dir = fresh();
    legacySha = (await sha256File(join(dir, 'medlevo.sqlite'))).sha256;
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    reference = endState(dir);
  }, 120_000);

  class Crash extends Error {}
  for (const point of POINTS) {
    it(`crash at ${point}`, async () => {
      const dir = fresh();
      await expect(
        runOwnerMigration({
          config: configFor(dir),
          mode: 'apply',
          verifyBoot: false,
          hooks: {
            at: (p) => {
              if (p === point) throw new Crash(p);
            },
          },
        }),
      ).rejects.toBeInstanceOf(Crash);
      // after the crash: never «fresh» (setup mode), the app refuses to serve, the owner's database exists somewhere
      const kind = detectDataDir(dataDirPaths(configFor(dir))).kind;
      expect(['migration_in_progress', 'multi_user']).toContain(kind);
      if (kind !== 'multi_user') await expect(boot(dir)).rejects.toBeInstanceOf(DataDirRefusedError);
      const ids = idsOf(readJournal(dir));
      const where = existsSync(join(dir, 'medlevo.sqlite')) && !isLegacyTombstone(join(dir, 'medlevo.sqlite')) ? join(dir, 'medlevo.sqlite') : join(dir, 'vaults', ids!.dbFile);
      expect((await sha256File(where)).sha256).toBe(legacySha);
      // resume to the same end state
      await runOwnerMigration({ config: configFor(dir), mode: 'resume', verifyBoot: false });
      expect(endState(dir)).toEqual(reference);
      expect((await sha256File(join(dir, 'vaults', idsOf(readJournal(dir))!.dbFile))).sha256).toBe(legacySha);
    }, 120_000);
  }
});

describe('a real process killed with SIGKILL mid-migration', () => {
  for (const point of ['safety:backup_written', 'move_vault:renamed', 'commit:renamed']) {
    it(`kill -9 at ${point}, then --resume`, async () => {
      const dir = fresh();
      const legacySha = (await sha256File(join(dir, 'medlevo.sqlite'))).sha256;
      const killed = await cli(['--apply', '--data-dir', dir, '--no-verify-boot'], { ...env(dir), MEDLEVO_TEST_HOOKS: '1', MEDLEVO_TEST_MIGRATION_PAUSE_AT: point }, {
        onStderr: (out, kill) => {
          if (out.includes(`PAUSED ${point}`)) kill();
        },
      });
      expect(killed.signal, killed.out).toBe('SIGKILL');
      expect(journalState(readJournal(dir))).toBe('in_progress');
      expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('migration_in_progress');
      await expect(boot(dir)).rejects.toBeInstanceOf(DataDirRefusedError);
      const resumed = await cli(['--resume', '--data-dir', dir, '--no-verify-boot'], env(dir));
      expect(resumed.code, resumed.out).toBe(0);
      const s = endState(dir);
      expect(s.journal).toBe('complete');
      expect(s.state).toBe('multi_user');
      expect((await sha256File(join(dir, 'vaults', idsOf(readJournal(dir))!.dbFile))).sha256).toBe(legacySha);
      const app = await boot(dir);
      try {
        const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'user-agent': 'vitest' }, payload: { username: LEGACY_USERNAME, password: LEGACY_PASSWORD } });
        expect(login.statusCode, login.body).toBe(200);
        const tree = await app.inject({ method: 'GET', url: '/api/library/tree', headers: { cookie: sessionCookie(login), ...CSRF } });
        expect(tree.json()).toEqual(fx.apiBefore['/api/library/tree']);
      } finally {
        await app.close();
      }
    }, 180_000);
  }

  it('kill -9 at growing delays until it completes, resuming each time', async () => {
    const dir = fresh();
    const legacySha = (await sha256File(join(dir, 'medlevo.sqlite'))).sha256;
    const kills: string[] = [];
    // the delay counts from the moment the run writes its first journal line (process start-up time varies with the
    // load of the machine; a small fixture migrates in a few hundred ms), so every run is killed INSIDE the migration
    for (const delay of [0, 15, 30, 60, 100, 160, 250, 400, 650, 1000, 1600]) {
      const mode = existsSync(join(dir, JOURNAL_FILE)) ? '--resume' : '--apply';
      if (journalState(readJournal(dir)) === 'complete') break;
      const before = readJournal(dir).length;
      const run = spawnCli([mode, '--data-dir', dir, '--no-verify-boot'], env(dir));
      let timer: NodeJS.Timeout | undefined;
      const poll = setInterval(() => {
        if (readJournal(dir).length > before) {
          clearInterval(poll);
          timer = setTimeout(() => run.child.kill('SIGKILL'), delay);
        }
      }, 2);
      const r = await run.done;
      clearInterval(poll);
      clearTimeout(timer);
      kills.push(`${mode} after ${delay} ms → ${r.signal ?? r.code} (${journalState(readJournal(dir))}, last: ${readJournal(dir).at(-1)?.step}:${readJournal(dir).at(-1)?.status})`);
      // never setup mode in between
      expect(['legacy_single_owner', 'migration_in_progress', 'multi_user']).toContain(detectDataDir(dataDirPaths(configFor(dir))).kind);
    }
    // at least one run was really killed in the middle of the migration (journal left unfinished)
    expect(kills.some((k) => k.includes('SIGKILL (in_progress')), kills.join('\n')).toBe(true);
    process.stdout.write(`random kills:\n${kills.join('\n')}\n`);
    // whatever state the kills left (they may have finished): resume (or nothing to do) ends complete
    const state = journalState(readJournal(dir));
    if (state !== 'complete') {
      const resumed = await cli(['--resume', '--data-dir', dir, '--no-verify-boot'], env(dir));
      expect(resumed.code, resumed.out).toBe(0);
    }
    expect(journalState(readJournal(dir)), kills.join('\n')).toBe('complete');
    expect((await sha256File(join(dir, 'vaults', idsOf(readJournal(dir))!.dbFile))).sha256).toBe(legacySha);
  }, 240_000);
});

describe('abort before the move changes nothing', () => {
  it('a database without an owner account', async () => {
    const dir = fresh();
    const db = openDb(join(dir, 'medlevo.sqlite'));
    db.run('DELETE FROM owner');
    db.close();
    const before = snapshot(dir);
    await expect(runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false })).rejects.toMatchObject({ code: 'NO_OWNER' });
    const after = snapshot(dir);
    const added = Object.keys(after).filter((k) => !(k in before));
    expect(added.every((k) => k.startsWith('migration-journal.aborted-'))).toBe(true);
    for (const k of Object.keys(before)) expect(after[k], k).toBe(before[k]);
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('legacy_single_owner');
  });

  it('a database older than R1-a (a base migration missing) is refused: the migration must not change the database', async () => {
    const dir = fresh();
    const db = openDb(join(dir, 'medlevo.sqlite'));
    db.run(`DELETE FROM schema_migration WHERE name = '0861_attribution.sql'`);
    db.close();
    await expect(runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false })).rejects.toMatchObject({ code: 'DB_OLDER_THAN_R1A' });
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('legacy_single_owner');
    expect(existsSync(join(dir, 'system.sqlite'))).toBe(false);
  });
});

describe('rollback (ADR-0003 §5 step 12)', () => {
  it('gives back medlevo.sqlite with the writes made since and the current password; the previous build reads it unchanged', async () => {
    const dir = fresh();
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    // use the new build: a note pushed and the password changed
    const app = await boot(dir);
    let noteId: string;
    try {
      const h = legacyCookie(fx.tokens.ipad);
      noteId = fx.queuedOps[1]!.entity_id;
      const r = await app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops: [fx.queuedOps[1]] } });
      expect((r.json() as { results: SyncOpResult[] }).results[0]!.result).toBe('applied');
      const pw = await app.inject({ method: 'POST', url: '/api/auth/password', headers: h, payload: { current_password: LEGACY_PASSWORD, new_password: 'a-brand-new-password-42' } });
      expect(pw.statusCode, pw.body).toBe(200);
    } finally {
      await app.close();
    }
    const out = await rollbackOwnerMigration({ config: configFor(dir) });
    expect(out.movedBack).toBe(true);
    expect(out.passwordCopiedBack).toBe(true);
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('legacy_single_owner');
    expect(existsSync(join(dir, 'system.sqlite'))).toBe(false);
    expect(existsSync(join(dir, MARKER_FILE))).toBe(false);
    expect(existsSync(join(dir, JOURNAL_FILE))).toBe(false);
    expect(readdirSync(out.setAside).sort()).toEqual(expect.arrayContaining([JOURNAL_FILE, MARKER_FILE, 'system.sqlite']));
    // «the old build reads it unchanged»: the base runner has nothing to apply; the note written under the new build
    // is there; the owner row holds the CURRENT password
    const db = openDb(join(dir, 'medlevo.sqlite'));
    try {
      expect(migrate(db).applied).toEqual([]);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note WHERE id = ?', [noteId!])!.n).toBe(1);
      const owner = db.get<{ password_hash: string }>(`SELECT password_hash FROM owner`)!;
      expect(await verifySecret('a-brand-new-password-42', owner.password_hash)).toBe(true);
    } finally {
      db.close();
    }
  }, 120_000);

  it('a crash inside the rollback resumes; a second migration after it works', async () => {
    const dir = fresh();
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    await expect(
      rollbackOwnerMigration({
        config: configFor(dir),
        hooks: {
          at: (p) => {
            if (p === 'rollback:moved_back') throw new Error('crash');
          },
        },
      }),
    ).rejects.toThrow('crash');
    expect(journalState(readJournal(dir))).toBe('rollback_in_progress');
    await expect(runOwnerMigration({ config: configFor(dir), mode: 'resume' })).rejects.toMatchObject({ code: 'ROLLBACK_IN_PROGRESS' });
    await rollbackOwnerMigration({ config: configFor(dir) });
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('legacy_single_owner');
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    expect(journalState(readJournal(dir))).toBe('complete');
  }, 120_000);

  it('is refused once a base migration was applied to the vault (then the step-0 backup is the way back)', async () => {
    const dir = fresh();
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    const ids = idsOf(readJournal(dir))!;
    const db = openDb(join(dir, 'vaults', ids.dbFile));
    db.run(`INSERT INTO schema_migration (name, checksum, applied_at) VALUES ('0999_future_release.sql', 'x', 1)`);
    db.close();
    await expect(rollbackOwnerMigration({ config: configFor(dir) })).rejects.toMatchObject({ code: 'BASE_MIGRATION_SINCE' });
    expect(detectDataDir(dataDirPaths(configFor(dir))).kind).toBe('multi_user');
  }, 120_000);

  it('is refused when other accounts exist', async () => {
    const dir = fresh();
    await runOwnerMigration({ config: configFor(dir), mode: 'apply', verifyBoot: false });
    const app = await boot(dir);
    try {
      app.ctx.tenancy.createAccount({ username: 'student_two', displayName: 'student two', passwordHash: 'scrypt$x', recoveryHashes: [], isPlatformAdmin: false, timezone: 'Asia/Baghdad' });
    } finally {
      await app.close();
    }
    const err = await rollbackOwnerMigration({ config: configFor(dir) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnerMigrationError);
    expect((err as OwnerMigrationError).code).toBe('OTHER_ACCOUNTS');
  }, 120_000);
});
