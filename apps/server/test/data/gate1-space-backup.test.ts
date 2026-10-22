// GATE-1 (BUILD_PLAN §3.9, DoD 9, AC-30): a whole-instance backup must carry EVERY subject space (spaces/<id>.sqlite)
// and the files its official lectures reference. Before this fix the archive held the system DB and the vaults only:
// official lectures and course-only explanations were lost by a restore, and the restored registry named space files
// that were missing (the restored server's blob mark pass failed — e2e g7-ac30-restore failed whenever a subject
// existed). Reported by P1-T3, P1-T4 and P1-T5 since step 1; closed here at the root (modules/data backup + restore).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../src/config';
import { openDb } from '../../src/db/db';
import { type BackupInstance, createBackup } from '../../src/modules/data/backup';
import { instanceBackupSources } from '../../src/modules/data/backups';
import { applyRestore, verifyBackup } from '../../src/modules/data/restore';
import { inSpaceDb, publishLecture, type Published, startStudying, vaultIdOf } from '../forks/helpers';
import { createLectureWorld, type LectureWorld, pagesFor, SPACE_A, SPACE_B } from '../lectures/world';

let w: LectureWorld;
let pub: Published;
let work: string;

beforeAll(async () => {
  w = await createLectureWorld();
  pub = await publishLecture(w, SPACE_A, 'Renal anatomy (TEST FIXTURE)', pagesFor('GATE1', 3));
  // a student's study copy: a stub in the student's vault that references the SAME blob as the space
  await startStudying(w, 'student', SPACE_A, pub.lectureId);
  work = mkdtempSync(join(tmpdir(), 'medlevo-gate1-spaces-'));
}, 300_000);

afterAll(async () => {
  await w?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

/** What the platform backup job snapshots, bound to the platform admin's vault (as the API job is). */
function instance(): BackupInstance {
  return w.t.ctx.binding.run({ kind: 'vault', vaultId: vaultIdOf(w, 'owner'), viewer: null }, () => instanceBackupSources(w.t.ctx));
}

async function backup(inst: BackupInstance, out: string) {
  return createBackup({
    dataDir: w.t.dataDir,
    dbPath: w.t.config.dbPath,
    instance: inst,
    filesDir: w.t.config.filesDir,
    outDir: join(work, out),
    appVersion: w.t.config.appVersion,
    now: () => Date.now(),
  });
}

/** the real `npm run backup` / `npm run restore:verify` processes (the CLI reads the registry from system.sqlite) */
function cli(name: 'backup' | 'restore-verify', args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(REPO_ROOT, 'apps', 'server', 'src', 'cli', `${name}.ts`), ...args], {
      cwd: join(REPO_ROOT, 'apps', 'server'),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let o = '';
    child.stdout.on('data', (d: Buffer) => (o += d.toString()));
    child.stderr.on('data', (d: Buffer) => (o += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, out: o }));
  });
}

const spaceRows = (dbPath: string, sql: string) => {
  const db = openDb(dbPath);
  try {
    return db.all(sql);
  } finally {
    db.close();
  }
};

describe('GATE-1: whole-instance backups include subject spaces', () => {
  it('the archive holds every registered space and the blobs its official lectures reference; verification boots on it', async () => {
    const res = await backup(instance(), 'full');
    expect((res.manifest.spaces ?? []).map((s) => s.space_id).sort()).toEqual([SPACE_A, SPACE_B].sort());
    const a = res.manifest.spaces!.find((s) => s.space_id === SPACE_A)!;
    expect(a.path).toBe(`medlevo-backup/spaces/${a.db_file}`);
    expect(a.row_counts.official_lecture).toBe(1);
    const spaceShas = inSpaceDb(w, SPACE_A, (db) => db.all<{ sha256: string }>('SELECT sha256 FROM stored_file').map((r) => r.sha256));
    expect(spaceShas.length).toBeGreaterThan(0);
    const archived = new Set(res.manifest.files.map((f) => f.sha256));
    for (const sha of spaceShas) expect(archived.has(sha), sha).toBe(true);

    const v = await verifyBackup(res.archivePath, { workDir: work });
    expect(v.report.checks.filter((c) => !c.ok), JSON.stringify(v.report.checks.filter((c) => !c.ok))).toEqual([]);
    expect(v.report.ok).toBe(true);
    const instanceCheck = v.report.checks.find((c) => c.name === 'instance')!;
    expect(instanceCheck.detail_ar).toContain('مساحة');
  }, 180_000);

  it('restore into another directory brings the subject back: the same official lectures and pages, its files on disk, the registry entry', async () => {
    const res = await backup(instance(), 'restore');
    const target = join(work, 'restored');
    const r = await applyRestore(res.archivePath, target, { liveDataDir: w.t.dataDir });
    expect(r.report.checks.filter((c) => !c.ok)).toEqual([]);
    const live = w.t.ctx.system.vaults.spaceByIdInternal(SPACE_A)!;
    const restoredSpace = join(target, 'spaces', live.db_file);
    expect(existsSync(restoredSpace)).toBe(true);
    const liveLectures = inSpaceDb(w, SPACE_A, (db) => db.all('SELECT * FROM official_lecture ORDER BY id'));
    expect(spaceRows(restoredSpace, 'SELECT * FROM official_lecture ORDER BY id')).toEqual(liveLectures);
    const livePages = inSpaceDb(w, SPACE_A, (db) => db.all('SELECT id, version_id, page_index FROM source_page ORDER BY id'));
    expect(spaceRows(restoredSpace, 'SELECT id, version_id, page_index FROM source_page ORDER BY id')).toEqual(livePages);
    for (const f of spaceRows(restoredSpace, 'SELECT storage_key FROM stored_file') as Array<{ storage_key: string }>) {
      expect(existsSync(join(target, 'files', ...f.storage_key.split('/'))), f.storage_key).toBe(true);
    }
    const sys = openDb(join(target, 'system.sqlite'));
    try {
      expect(sys.all<{ id: string }>('SELECT id FROM space ORDER BY id').map((s) => s.id)).toEqual([SPACE_A, SPACE_B].sort());
    } finally {
      sys.close();
    }
  }, 180_000);

  it('the backup CLI (next to the running server) archives the spaces too, and restore:verify passes on that archive', async () => {
    const out = join(work, 'cli');
    const b = await cli('backup', ['--out', out], { MEDLEVO_DATA_DIR: w.t.dataDir });
    expect(b.code, b.out).toBe(0);
    expect(b.out).toContain('2 subject space(s)');
    const archive = readdirSync(out).find((f) => f.endsWith('.tar.gz'))!;
    const v = await cli('restore-verify', [join(out, archive)], { MEDLEVO_DATA_DIR: join(work, 'cli-unused') });
    expect(v.code, v.out).toBe(0);
  }, 240_000);

  it('an archive that leaves out a registered space is refused by verification with the reason — never restored half', async () => {
    const res = await backup({ ...instance(), spaces: [] }, 'partial');
    expect(res.manifest.spaces).toEqual([]);
    const v = await verifyBackup(res.archivePath, { workDir: work, bootCheck: false });
    expect(v.report.ok).toBe(false);
    const instanceCheck = v.report.checks.find((c) => c.name === 'instance')!;
    expect(instanceCheck.ok).toBe(false);
    expect(JSON.stringify(instanceCheck.details)).toContain('space registry');
    const target = join(work, 'refused');
    const r = await applyRestore(res.archivePath, target, { bootCheck: false });
    expect(r.report.ok).toBe(false);
    expect(existsSync(join(target, 'system.sqlite'))).toBe(false);
  }, 180_000);
});
