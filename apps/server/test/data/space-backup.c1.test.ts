// AOS-21.1 / X8 (d) — a per-SPACE backup and its restore check, as their own artifact, platform admin only.
// The whole-instance archive (GATE-1) already carries every subject space; this is the backup of ONE subject's space
// (official lectures, versions, attachments, explanations of that course) and the files its rows reference, with:
//   * layout 'space' in manifest.json — no system DB, no vault, no other space, no blob only a vault references;
//   * encrypted with «MLVENC01» when MEDLEVO_BACKUP_ENCRYPTION_KEY is set (the plain archive never stays on disk);
//   * a restore check (decrypt, hashes, integrity, base + space migrations of this build, row counts, files, boot on a
//     sandbox) the admin starts from the platform routes; it never changes the live space;
//   * a whole data-directory restore refuses it (it is not a server);
//   * every route answers 404 to anyone but the platform admin (the space's own moderator included).
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpaceBackupsResponse, SpaceBackupView } from '@medlevo/shared';
import { parseBackupKey } from '../../src/lib/objectstore/encryption';
import { MODULES } from '../../src/modules';
import { applyRestore, RestoreTargetError, verifyBackup } from '../../src/modules/data/restore';
import { spaceBackupsDir } from '../../src/modules/data/space-backup';
import { createProcessingModule } from '../../src/modules/processing';
import { createTestApp } from '../helpers/app';
import { inVault, publishLecture, type Published } from '../forks/helpers';
import { createLectureWorld, type LectureWorld, pagesFor, SPACE_A, SPACE_B } from '../lectures/world';

const KEY_B64 = randomBytes(32).toString('base64');
const VAULT_MARKER = 'PRIVATE-VAULT-MARKER-لا-يخرج';
let w: LectureWorld;
let pubA: Published;
let vaultBlobSha: string;
let work: string;

beforeAll(async () => {
  w = await createLectureWorld({
    app: () =>
      createTestApp({
        env: { MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY_B64 },
        modules: MODULES.map((m) => (m.name === 'processing' ? { ...m, plugin: createProcessingModule({}) } : m)),
        jobs: { backoffBaseMs: 0, backoffMaxMs: 0 },
      }),
  });
  pubA = await publishLecture(w, SPACE_A, 'Renal anatomy (TEST FIXTURE)', pagesFor('SPB-A', 2));
  await publishLecture(w, SPACE_B, 'Cardiac cycle (TEST FIXTURE)', pagesFor('SPB-B', 1), 'modB');
  // a private file in a student's vault: never part of a space backup
  vaultBlobSha = (await inVault(w, 'student', () => w.t.ctx.files.put(Buffer.from(`${VAULT_MARKER} ${randomBytes(2000).toString('hex')}`), { mime: 'text/plain' }))).sha256;
  work = mkdtempSync(join(tmpdir(), 'medlevo-c1-space-backup-'));
}, 300_000);

afterAll(async () => {
  await w?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

const url = (space: string, rest = '') => `/api/platform/spaces/${space}/backups${rest}`;

async function makeBackup(space: string): Promise<SpaceBackupView> {
  const res = await w.req('owner', 'POST', url(space), {});
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as SpaceBackupView;
}

async function lastCheck(space: string): Promise<NonNullable<SpaceBackupsResponse['last_check']>> {
  for (let i = 0; i < 600; i++) {
    const body = (await w.req('owner', 'GET', url(space))).json() as SpaceBackupsResponse;
    if (body.last_check && !body.last_check.running) return body.last_check;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the restore check did not finish');
}

describe('AOS-21.1 / X8 (d) — per-space backup', () => {
  it('holds ONE space and the files its rows reference — encrypted, nothing of another space or of a vault', async () => {
    const view = await makeBackup(SPACE_A);
    expect(view.file_name).toMatch(/^medlevo-space-[0-9TZ-]+-[0-9a-z]{8}\.tar\.gz\.mlenc$/);
    expect(view.encrypted).toBe(true);
    const dir = spaceBackupsDir(w.t.ctx, SPACE_A);
    expect(readdirSync(dir).sort()).toEqual([view.file_name, `${view.file_name}.sha256`].sort());
    const bytes = readFileSync(join(dir, view.file_name));
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('MLVENC01');

    const v = await verifyBackup(join(dir, view.file_name), { workDir: work, keep: true, decryptionKey: parseBackupKey(KEY_B64) });
    try {
      expect(v.report.ok, JSON.stringify(v.report.checks.filter((c) => !c.ok))).toBe(true);
      const m = v.manifest!;
      expect(m.layout).toBe('space');
      expect(m.system).toBeUndefined();
      expect(m.vaults).toBeUndefined();
      expect(m.spaces!.map((s) => s.space_id)).toEqual([SPACE_A]);
      expect(m.subject).toMatchObject({ space_id: SPACE_A, title: 'Anatomy A' });
      // the extracted directory: only this space's database and files
      const root = v.dataDir!;
      expect(existsSync(join(root, 'system.sqlite'))).toBe(false);
      expect(existsSync(join(root, 'vaults'))).toBe(false);
      expect(readdirSync(join(root, 'spaces'))).toEqual([m.spaces![0]!.db_file]);
      const shas = m.files.map((f) => f.sha256);
      expect(shas.length).toBeGreaterThan(0);
      expect(shas).not.toContain(vaultBlobSha);
      const spaceShas = w.t.ctx.dbs.space(SPACE_A).all<{ sha256: string }>('SELECT sha256 FROM stored_file').map((r) => r.sha256);
      expect(new Set(shas)).toEqual(new Set(spaceShas));
      const spaceB = w.t.ctx.dbs.space(SPACE_B).all<{ sha256: string }>('SELECT sha256 FROM stored_file').map((r) => r.sha256);
      for (const s of spaceB.filter((x) => !spaceShas.includes(x))) expect(shas).not.toContain(s);
      // the restored space still has the published lecture
      expect(v.report.checks.find((c) => c.name === 'boot')).toMatchObject({ ok: true });
      expect(m.db.row_counts.official_lecture).toBe(1);
    } finally {
      if (v.workDir) rmSync(v.workDir, { recursive: true, force: true });
    }
  });

  it('the restore check runs from the platform routes and reports every check; it never changes the live space', async () => {
    const view = await makeBackup(SPACE_A);
    const before = w.t.ctx.dbs.space(SPACE_A).get<{ n: number }>('SELECT COUNT(*) AS n FROM official_lecture')!.n;
    const res = await w.req('owner', 'POST', url(SPACE_A, '/verify'), { file_name: view.file_name });
    expect(res.statusCode, res.body).toBe(202);
    const check = await lastCheck(SPACE_A);
    expect(check.ok, JSON.stringify(check.checks.filter((c) => !c.ok))).toBe(true);
    expect(check.file_name).toBe(view.file_name);
    expect(check.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['decrypt', 'manifest', 'database_hash', 'file_hashes', 'integrity_check', 'migrations', 'row_counts', 'files_complete', 'boot', 'space']));
    expect(w.t.ctx.dbs.space(SPACE_A).get<{ n: number }>('SELECT COUNT(*) AS n FROM official_lecture')!.n).toBe(before);
    // listed with the backups of THIS space only
    const list = (await w.req('owner', 'GET', url(SPACE_A))).json() as SpaceBackupsResponse;
    expect(list.backups.map((b) => b.file_name)).toContain(view.file_name);
    expect(list.note_ar).toMatch(/مساحة مادة/);
    expect(((await w.req('owner', 'GET', url(SPACE_B))).json() as SpaceBackupsResponse).backups.map((b) => b.file_name)).not.toContain(view.file_name);
  });

  it('a damaged archive fails the check with the reason', async () => {
    const view = await makeBackup(SPACE_A);
    const p = join(spaceBackupsDir(w.t.ctx, SPACE_A), view.file_name);
    const bytes = readFileSync(p);
    bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    writeFileSync(p, bytes);
    expect((await w.req('owner', 'POST', url(SPACE_A, '/verify'), { file_name: view.file_name })).statusCode).toBe(202);
    const check = await lastCheck(SPACE_A);
    expect(check.ok).toBe(false);
    expect(check.checks.find((c) => !c.ok)!.detail_ar.length).toBeGreaterThan(0);
  });

  it("another space's archive placed in this space's folder is refused (it is not this space's)", async () => {
    const other = await makeBackup(SPACE_B);
    copyFileSync(join(spaceBackupsDir(w.t.ctx, SPACE_B), other.file_name), join(spaceBackupsDir(w.t.ctx, SPACE_A), other.file_name));
    expect((await w.req('owner', 'POST', url(SPACE_A, '/verify'), { file_name: other.file_name })).statusCode).toBe(202);
    const check = await lastCheck(SPACE_A);
    expect(check.ok).toBe(false);
    expect(check.checks.find((c) => c.name === 'space')).toMatchObject({ ok: false });
  });

  it('a whole data-directory restore refuses a space archive', async () => {
    const view = await makeBackup(SPACE_A);
    const target = join(work, 'restore-target');
    await expect(applyRestore(join(spaceBackupsDir(w.t.ctx, SPACE_A), view.file_name), target, { decryptionKey: parseBackupKey(KEY_B64), bootCheck: false })).rejects.toBeInstanceOf(
      RestoreTargetError,
    );
    expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);
  });

  it('platform admin only: the moderator of the space, a member and a stranger get 404 on every route', async () => {
    const view = await makeBackup(SPACE_A);
    for (const who of ['mod', 'student', 'outsider'] as const) {
      expect((await w.req(who, 'GET', url(SPACE_A))).statusCode).toBe(404);
      expect((await w.req(who, 'POST', url(SPACE_A), {})).statusCode).toBe(404);
      expect((await w.req(who, 'POST', url(SPACE_A, '/verify'), { file_name: view.file_name })).statusCode).toBe(404);
    }
    // an unknown space is a 404 for the admin too (making a backup is limited to 6 per 10 minutes: the admin used them)
    expect((await w.req('owner', 'GET', url('NOSUCHSPACE'))).statusCode).toBe(404);
    expect((await w.req('owner', 'POST', url('NOSUCHSPACE', '/verify'), { file_name: view.file_name })).statusCode).toBe(404);
    expect(pubA.lectureId).toBeTruthy();
  });
});
