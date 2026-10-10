// AC-30: real data (Golden Set lecture + question source uploaded and processed, annotations, notes, a session,
// flashcards + review events, a practice attempt, a Study Book) → backup (API job AND library call) → restore into
// ANOTHER directory → counts, deep equality of key rows, file hashes, and the restored app boots and serves the
// source with its annotations. Plus: secrets never in the archive, tampered / unsafe archives refused, the target
// must be empty, sessions revoked and a new sync epoch after a restore.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKUP_FORMAT, type BackupCreateResponse, type BackupsListResponse, type SourceAnnotationsResponse, type SyncPullResponse } from '@medlevo/shared';
import { openDb } from '../../src/db/db';
import { createBackup, rowCounts } from '../../src/modules/data/backup';
import { applyRestore, RestoreTargetError, verifyBackup } from '../../src/modules/data/restore';
import { tarHeader, TarGzWriter } from '../../src/modules/data/tar';
import { createTestApp, CSRF, OWNER, sessionCookie, type TestApp } from '../helpers/app';
import { dataLibrary, writeOwnerData, type DataLib, type OwnerData } from './helpers';

let lib: DataLib;
let owner: OwnerData;
let work: string;
let archive: string;
let apiBackupId: string;
const KEY_TABLES = [
  'source',
  'source_version',
  'source_page',
  'source_region',
  'stored_file',
  'annotation',
  'annotation_target',
  'note',
  'study_session',
  'question',
  'question_version',
  'question_option',
  'question_occurrence',
  'answer_key_entry',
  'question_lecture_link',
  'question_attempt',
  'exam',
  'exam_attempt',
  'flashcard',
  'review_event',
  'artifact',
  'content_block',
  'claim',
  'citation',
  'evidence',
  'source_link',
  'library_node',
  'owner',
];

beforeAll(async () => {
  lib = await dataLibrary();
  owner = await writeOwnerData(lib);
  // a secret-looking setting must never travel (defensive: no module stores secrets in owner_setting)
  lib.t.ctx.db.run(`INSERT INTO owner_setting (key, value_json, updated_at) VALUES ('provider_api_key', '"sk-ant-api03-SHOULD-NEVER-BE-EXPORTED"', 1)`);
  work = mkdtempSync(join(tmpdir(), 'medlevo-ac30-'));
}, 300_000);
afterAll(async () => {
  await lib?.t.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

function tableRows(dbPath: string, table: string): unknown[] {
  const db = openDb(dbPath);
  try {
    return db.all(`SELECT * FROM ${table} ORDER BY rowid`);
  } finally {
    db.close();
  }
}

describe('AC-30 backup → restore into another directory', () => {
  it('the data to protect really exists (not an empty backup)', () => {
    const n = (sql: string) => lib.t.ctx.db.get<{ n: number }>(sql)!.n;
    expect(n('SELECT COUNT(*) AS n FROM source')).toBe(2);
    expect(n('SELECT COUNT(*) AS n FROM source_page')).toBeGreaterThan(3);
    expect(n('SELECT COUNT(*) AS n FROM annotation')).toBe(2);
    expect(n('SELECT COUNT(*) AS n FROM note')).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM question')).toBeGreaterThan(3);
    expect(n('SELECT COUNT(*) AS n FROM question_lecture_link')).toBeGreaterThan(0);
    expect(n('SELECT COUNT(*) AS n FROM study_session')).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM review_event')).toBe(3);
    expect(owner.attemptId).not.toBeNull();
    expect(owner.book?.artifact.status).toBe('published');
  });

  it('API: POST /api/data/backups runs a job; list, download (= the archive, sha256 matches)', async () => {
    const res = await lib.t.app.inject({ method: 'POST', url: '/api/data/backups', headers: lib.h, payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    const created = (res.json() as BackupCreateResponse).backup;
    apiBackupId = created.id;
    expect(created.status).toBe('running');
    // a second backup while one runs is refused
    expect((await lib.t.app.inject({ method: 'POST', url: '/api/data/backups', headers: lib.h, payload: {} })).statusCode).toBe(409);
    await lib.t.ctx.jobs.drain();
    const list = (await lib.t.app.inject({ method: 'GET', url: '/api/data/backups', headers: lib.h })).json() as BackupsListResponse;
    const b = list.backups.find((x) => x.id === created.id)!;
    expect(b.status, JSON.stringify(b)).toBe('completed_with_warnings'); // the secret-looking setting was stripped
    expect(b.warnings_ar.join(' ')).toContain('provider_api_key');
    expect(b.summary!.files).toBe(lib.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file')!.n);
    expect(list.excluded_ar.join(' ')).toContain('secret.key');
    expect(list.storage_note_ar).toContain('خارج هذا الجهاز');
    const dl = await lib.t.app.inject({ method: 'GET', url: b.download_url!, headers: lib.h });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/gzip');
    expect(String(dl.headers['content-disposition'])).toContain('attachment');
    expect(createHash('sha256').update(dl.rawPayload).digest('hex')).toBe(b.sha256);
    archive = join(work, b.file_name);
    writeFileSync(archive, dl.rawPayload);
    // unauthenticated download / list are refused
    expect((await lib.t.app.inject({ method: 'GET', url: b.download_url! })).statusCode).toBe(401);
    expect((await lib.t.app.inject({ method: 'POST', url: '/api/data/backups', headers: { cookie: lib.h.cookie }, payload: {} })).statusCode).toBe(403);
  }, 120_000);

  it('the archive never contains the server secret, the API key, password text or the stripped setting', () => {
    const tar = gunzipSync(readFileSync(archive));
    const secret = readFileSync(join(lib.t.dataDir, 'secret.key'), 'utf8').trim();
    expect(tar.includes(Buffer.from(secret))).toBe(false);
    expect(tar.includes(Buffer.from('sk-ant-api03-SHOULD-NEVER-BE-EXPORTED'))).toBe(false);
    expect(tar.includes(Buffer.from(OWNER.password))).toBe(false);
    expect(tar.includes(Buffer.from('secret.key'))).toBe(true); // only the manifest's "excluded" note mentions it
    const names: string[] = [];
    for (let off = 0; off + 512 <= tar.length; ) {
      const h = tar.subarray(off, off + 512);
      if (h.every((x) => x === 0)) break;
      const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
      names.push(name);
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toContain('medlevo-backup/medlevo.sqlite');
    expect(names).toContain('medlevo-backup/manifest.json');
    expect(names.some((n) => /secret|\.env|tmp\/|tessdata|backups\//.test(n))).toBe(false);
  });

  it('restore:verify in a SEPARATE temp dir: every check passes and the app boots on the copy', async () => {
    const res = await verifyBackup(archive, { workDir: work });
    const failed = res.report.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(res.report.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['archive', 'manifest', 'layout', 'database_hash', 'file_hashes', 'integrity_check', 'foreign_keys', 'migrations', 'row_counts', 'files_complete', 'fts', 'sources_versions_pages', 'annotations_targets', 'questions_occurrences', 'links', 'sessions', 'learning', 'boot']),
    );
    expect(res.report.ok).toBe(true);
    // nothing left behind
    expect(readdirSync(work).filter((n) => n.startsWith('.medlevo-restore-'))).toEqual([]);
  }, 120_000);

  it('restore into another directory: counts, deep-equal key rows, file hashes; the restored app serves the source with its annotations', async () => {
    const target = join(work, 'restored-data');
    const res = await applyRestore(archive, target, { liveDataDir: lib.t.dataDir });
    expect(res.report.ok, JSON.stringify(res.report.checks.filter((c) => !c.ok))).toBe(true);
    expect(res.report.restored_to).toBe(target);
    const restoredDb = join(target, 'medlevo.sqlite');

    // row counts per key table and deep equality of the rows (owner sessions are revoked by design → compared apart)
    const live = rowCounts(lib.t.ctx.db);
    const restoredDbh = openDb(restoredDb);
    const restoredCounts = rowCounts(restoredDbh);
    restoredDbh.close();
    for (const t of KEY_TABLES) {
      expect(restoredCounts[t], t).toBe(live[t]);
      if (t === 'owner') continue;
      expect(tableRows(restoredDb, t), t).toEqual(lib.t.ctx.db.all(`SELECT * FROM ${t} ORDER BY rowid`));
    }
    const ownerRow = tableRows(restoredDb, 'owner')[0] as { password_hash: string };
    expect(ownerRow.password_hash).toBe(lib.t.ctx.db.get<{ password_hash: string }>("SELECT password_hash FROM owner")!.password_hash);

    // file store: every blob present with the recorded sha256
    for (const f of lib.t.ctx.db.all<{ storage_key: string; sha256: string; size: number }>('SELECT storage_key, sha256, size FROM stored_file')) {
      const p = join(target, 'files', ...f.storage_key.split('/'));
      expect(existsSync(p), f.storage_key).toBe(true);
      expect(statSync(p).size).toBe(f.size);
      expect(createHash('sha256').update(readFileSync(p)).digest('hex')).toBe(f.sha256);
    }
    expect(existsSync(join(target, 'secret.key'))).toBe(true); // a NEW secret (the backup carried none)
    expect(readFileSync(join(target, 'secret.key'), 'utf8')).not.toBe(readFileSync(join(lib.t.dataDir, 'secret.key'), 'utf8'));

    // boot a test app on the restored directory
    const restored: TestApp = await createTestApp({ env: { MEDLEVO_DATA_DIR: target } });
    try {
      // the old cookie is revoked (a device revoked after the snapshot must not come back)
      expect((await restored.app.inject({ method: 'GET', url: '/api/library/tree', headers: { cookie: lib.h.cookie } })).statusCode).toBe(401);
      const login = await restored.app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: OWNER.username, password: OWNER.password } });
      expect(login.statusCode, login.body).toBe(200);
      const h = { cookie: sessionCookie(login), ...CSRF };
      const src = await restored.app.inject({ method: 'GET', url: `/api/sources/${lib.lecture.sourceId}`, headers: h });
      expect(src.statusCode).toBe(200);
      expect(src.json()).toMatchObject({ id: lib.lecture.sourceId, title: 'Acute Appendicitis (TEST FIXTURE)' });
      const ann = (await restored.app.inject({ method: 'GET', url: `/api/annotations/source/${lib.lecture.sourceId}?version_id=${lib.lecture.versionId}`, headers: h })).json() as SourceAnnotationsResponse;
      expect(ann.annotations.map((a) => a.id).sort()).toEqual([owner.inkId, owner.highlightId].sort());
      const liveAnn = (await lib.t.app.inject({ method: 'GET', url: `/api/annotations/source/${lib.lecture.sourceId}?version_id=${lib.lecture.versionId}`, headers: lib.h })).json() as SourceAnnotationsResponse;
      expect(ann.annotations).toEqual(liveAnn.annotations);
      expect(ann.notes).toEqual(liveAnn.notes);
      // the original file streams with the same bytes
      const fid = restored.ctx.db.get<{ file_id: string }>('SELECT file_id FROM source_version WHERE id = ?', [lib.lecture.versionId])!.file_id;
      const file = await restored.app.inject({ method: 'GET', url: `/api/files/${fid}`, headers: h });
      expect(file.statusCode).toBe(200);
      expect(createHash('sha256').update(file.rawPayload).digest('hex')).toBe(restored.ctx.db.get<{ sha256: string }>('SELECT sha256 FROM stored_file WHERE id = ?', [fid])!.sha256);
      // the Study Book, questions with their links and the session come back
      expect((await restored.app.inject({ method: 'GET', url: `/api/studybook/books/${owner.book!.artifact.id}`, headers: h })).statusCode).toBe(200);
      const lq = (await restored.app.inject({ method: 'GET', url: `/api/questions/for-lecture/${lib.lecture.sourceId}`, headers: h })).json() as { items: unknown[] };
      expect(lq.items.length).toBeGreaterThan(0);
      const sess = (await restored.app.inject({ method: 'GET', url: `/api/annotations/sessions/latest?source_id=${lib.lecture.sourceId}`, headers: h })).json() as { session: { id: string } };
      expect(sess.session.id).toBe(owner.sessionId);
      // a new server epoch starting at the snapshot's change-feed head → clients reset their cursor
      const livePull = (await lib.t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=1', headers: lib.h })).json() as SyncPullResponse;
      const pull = (await restored.app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=1', headers: h })).json() as SyncPullResponse;
      expect(pull.server_epoch).toBeTruthy();
      expect(pull.server_epoch).not.toBe(livePull.server_epoch);
      expect(pull.epoch_base_seq).toBe(pull.head_seq);
      expect(restored.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM change_log WHERE action = 'restore'")!.n).toBe(1);
      // the backup restored from was "running" in its own snapshot: it is shown as completed, never as interrupted
      const brow = restored.ctx.db.get<{ status: string; error_detail: string | null; warnings_json: string }>('SELECT status, error_detail, warnings_json FROM data_backup WHERE id = ?', [apiBackupId])!;
      expect(brow.status).toBe('completed');
      expect(brow.error_detail).toBeNull();
      expect(brow.warnings_json).toContain('استُعيدت البيانات من هذه النسخة');
    } finally {
      await restored.close();
    }
  }, 180_000);

  it('a restore never overwrites data: non-empty target and the live data directory are refused', async () => {
    const nonEmpty = join(work, 'not-empty');
    mkdirSync(nonEmpty, { recursive: true });
    writeFileSync(join(nonEmpty, 'keep.txt'), 'owner data');
    await expect(applyRestore(archive, nonEmpty)).rejects.toBeInstanceOf(RestoreTargetError);
    expect(readFileSync(join(nonEmpty, 'keep.txt'), 'utf8')).toBe('owner data');
    await expect(applyRestore(archive, lib.t.dataDir, { liveDataDir: lib.t.dataDir })).rejects.toBeInstanceOf(RestoreTargetError);
  });

  it('a damaged archive fails verification with the exact reason, and nothing is restored', async () => {
    // flip one byte of a stored file inside the archive (re-packed with valid tar headers and gzip)
    const tar = Buffer.from(gunzipSync(readFileSync(archive)));
    let off = 0;
    let flipped = false;
    while (off + 512 <= tar.length) {
      const h = tar.subarray(off, off + 512);
      if (h.every((x) => x === 0)) break;
      const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
      const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
      if (!flipped && `${prefix ? `${prefix}/` : ''}${name}`.includes('/files/') && size > 10) {
        tar[off + 512 + 5] = tar[off + 512 + 5]! ^ 0xff;
        flipped = true;
      }
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(flipped).toBe(true);
    const bad = join(work, 'damaged.tar.gz');
    writeFileSync(bad, gzipSync(tar));
    const res = await verifyBackup(bad, { workDir: work, bootCheck: false });
    expect(res.report.ok).toBe(false);
    expect(res.report.checks.find((c) => c.name === 'file_hashes')!.ok).toBe(false);
    const target = join(work, 'restore-from-damaged');
    const applied = await applyRestore(bad, target);
    expect(applied.report.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
    // a truncated archive
    const truncated = join(work, 'truncated.tar.gz');
    const full = readFileSync(archive);
    writeFileSync(truncated, full.subarray(0, Math.floor(full.length / 2)));
    const t = await verifyBackup(truncated, { workDir: work, bootCheck: false });
    expect(t.report.ok).toBe(false);
    expect(t.report.checks[0]!.name).toBe('archive');
  });

  it('an archive with a path-traversal or symlink entry is refused before anything is written outside', async () => {
    const outside = join(work, 'escaped.txt');
    const mk = (name: string, type: 'file' | 'symlink') => {
      const data = Buffer.from('pwned');
      const h = tarHeader('medlevo-backup/x', data.length, Date.now());
      h.fill(0, 0, 100);
      h.write(name, 0, 100, 'utf8');
      if (type === 'symlink') h[156] = '2'.charCodeAt(0);
      h.fill(0x20, 148, 156);
      let sum = 0;
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      return gzipSync(Buffer.concat([h, data, Buffer.alloc(512 - data.length), Buffer.alloc(1024)]));
    };
    const trav = join(work, 'traversal.tar.gz');
    writeFileSync(trav, mk('medlevo-backup/../../escaped.txt', 'file'));
    const r1 = await verifyBackup(trav, { workDir: work, bootCheck: false });
    expect(r1.report.ok).toBe(false);
    expect(r1.report.checks[0]!.detail_ar).toContain('غير آمن');
    expect(existsSync(outside)).toBe(false);
    const sym = join(work, 'symlink.tar.gz');
    writeFileSync(sym, mk('medlevo-backup/link', 'symlink'));
    const r2 = await verifyBackup(sym, { workDir: work, bootCheck: false });
    expect(r2.report.ok).toBe(false);
    expect(r2.report.checks[0]!.detail_ar).toContain('رابط رمزي');
    // not a backup at all
    const junk = join(work, 'junk.tar.gz');
    writeFileSync(junk, Buffer.from('this is not a gzip archive'));
    expect((await verifyBackup(junk, { workDir: work, bootCheck: false })).report.ok).toBe(false);
  });

  it('createBackup (CLI path) works while the server keeps writing, and records missing blobs honestly', async () => {
    const out = join(work, 'cli-out');
    // a blob that vanished from the file store
    const victim = lib.t.ctx.db.get<{ storage_key: string; id: string }>('SELECT id, storage_key FROM stored_file ORDER BY size LIMIT 1')!;
    const victimPath = join(lib.t.dataDir, 'files', ...victim.storage_key.split('/'));
    const saved = readFileSync(victimPath);
    rmSync(victimPath);
    try {
      const res = await createBackup({
        dataDir: lib.t.dataDir,
        dbPath: lib.t.config.dbPath,
        filesDir: lib.t.config.filesDir,
        outDir: out,
        appVersion: lib.t.config.appVersion,
        now: () => Date.now(),
      });
      expect(res.manifest.files_missing.map((m) => m.file_id)).toEqual([victim.id]);
      expect(res.warnings_ar.length).toBeGreaterThan(0);
      expect(existsSync(`${res.archivePath}.sha256`)).toBe(true);
      const v = await verifyBackup(res.archivePath, { workDir: work, bootCheck: false });
      expect(v.report.ok).toBe(false);
      expect(v.report.checks.find((c) => c.name === 'files_complete')!.ok).toBe(false);
      expect(v.report.checks.find((c) => c.name === 'file_hashes')!.ok).toBe(true);
    } finally {
      writeFileSync(victimPath, saved);
    }
  }, 120_000);

  it('files already missing or damaged at backup time: refused by default (saying how to proceed), restorable with acceptMissingFiles; damaged bytes never reach the file store', async () => {
    const out = join(work, 'cli-out-missing');
    const [gone, damaged] = lib.t.ctx.db.all<{ storage_key: string; id: string; sha256: string }>('SELECT id, storage_key, sha256 FROM stored_file ORDER BY size, id LIMIT 2');
    const pathOf = (r: { storage_key: string }, root = lib.t.dataDir) => join(root, 'files', ...r.storage_key.split('/'));
    const savedGone = readFileSync(pathOf(gone!));
    const savedDamaged = readFileSync(pathOf(damaged!));
    rmSync(pathOf(gone!));
    const flipped = Buffer.from(savedDamaged);
    flipped[0] = flipped[0]! ^ 0xff;
    writeFileSync(pathOf(damaged!), flipped);
    let archivePath: string;
    try {
      const res = await createBackup({ dataDir: lib.t.dataDir, dbPath: lib.t.config.dbPath, filesDir: lib.t.config.filesDir, outDir: out, appVersion: lib.t.config.appVersion, now: () => Date.now() });
      expect(res.manifest.files_missing.map((m) => `${m.file_id}:${m.reason}`).sort()).toEqual([`${gone!.id}:missing`, `${damaged!.id}:hash_mismatch`].sort());
      archivePath = res.archivePath;
    } finally {
      writeFileSync(pathOf(gone!), savedGone);
      writeFileSync(pathOf(damaged!), savedDamaged);
    }

    // default: nothing restored, and the report says exactly how to get the writing back
    const refusedTarget = join(work, 'restore-missing-default');
    const refused = await applyRestore(archivePath, refusedTarget, { bootCheck: false });
    expect(refused.report.ok).toBe(false);
    expect(existsSync(refusedTarget)).toBe(false);
    const fc = refused.report.checks.find((c) => c.name === 'files_complete')!;
    expect(fc.ok).toBe(false);
    expect(fc.detail_ar).toContain('--accept-missing-files');

    // explicit acceptance: everything else comes back; the two files are named in the report
    const target = join(work, 'restore-missing-accepted');
    const ok = await applyRestore(archivePath, target, { acceptMissingFiles: true });
    expect(ok.report.ok, JSON.stringify(ok.report.checks.filter((c) => !c.ok))).toBe(true);
    const acc = ok.report.checks.find((c) => c.name === 'files_complete')!;
    expect(acc.detail_ar).toContain('--accept-missing-files');
    expect((acc.details as { file_ids: string[] }).file_ids.sort()).toEqual([gone!.id, damaged!.id].sort());
    const rdb = openDb(join(target, 'medlevo.sqlite'));
    try {
      expect(rdb.get<{ n: number }>('SELECT COUNT(*) AS n FROM note')!.n).toBe(lib.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note')!.n);
      expect(rdb.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation')!.n).toBe(lib.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation')!.n);
      expect(rdb.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event')!.n).toBe(lib.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event')!.n);
    } finally {
      rdb.close();
    }
    expect(existsSync(pathOf(gone!, target))).toBe(false);
    // the damaged bytes were in the archive but are NOT placed under the verified content address
    expect(existsSync(pathOf(damaged!, target))).toBe(false);
    const others = lib.t.ctx.db.all<{ id: string; storage_key: string }>('SELECT id, storage_key FROM stored_file').filter((r) => r.id !== gone!.id && r.id !== damaged!.id);
    for (const r of others) expect(existsSync(pathOf(r, target)), r.id).toBe(true);
  }, 180_000);

  it('an unreadable manifest or a database file that is not SQLite gives a failed report (never an exception)', async () => {
    const mk = async (name: string, entries: Array<[string, Buffer]>) => {
      const p = join(work, name);
      const w = new TarGzWriter(p);
      for (const [n, b] of entries) await w.addBuffer(n, b);
      await w.finish();
      return p;
    };
    const badJson = await mk('bad-manifest.tar.gz', [['medlevo-backup/manifest.json', Buffer.from('{ not json')]]);
    const r1 = await verifyBackup(badJson, { workDir: work, bootCheck: false });
    expect(r1.report.ok).toBe(false);
    expect(r1.report.checks.find((c) => c.name === 'manifest')!.ok).toBe(false);

    const garbage = Buffer.from('this is not an sqlite database '.repeat(40));
    const manifest = {
      format: BACKUP_FORMAT,
      backup_id: 'X',
      app_version: '0',
      created_at: 1,
      root: 'medlevo-backup',
      db: { path: 'medlevo-backup/medlevo.sqlite', sha256: createHash('sha256').update(garbage).digest('hex'), size: garbage.length, migrations: [], row_counts: {}, sync_head_seq: 0, server_epoch: null },
      files: [],
      files_missing: [],
      excluded: [],
    };
    const badDb = await mk('bad-db.tar.gz', [
      ['medlevo-backup/medlevo.sqlite', garbage],
      ['medlevo-backup/manifest.json', Buffer.from(JSON.stringify(manifest))],
    ]);
    const r2 = await verifyBackup(badDb, { workDir: work });
    expect(r2.report.ok).toBe(false);
    const ic = r2.report.checks.find((c) => c.name === 'integrity_check')!;
    expect(ic.ok).toBe(false);
    expect(ic.detail_ar).toContain('ليس قاعدة SQLite');
    expect(readdirSync(work).filter((n) => n.startsWith('.medlevo-restore-'))).toEqual([]);
  });

  it('the live data directory reached through a symlink is refused too', async () => {
    const link = join(work, 'link-to-live');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(lib.t.dataDir, link);
    await expect(applyRestore(archive, link, { liveDataDir: lib.t.dataDir })).rejects.toBeInstanceOf(RestoreTargetError);
  });
});
