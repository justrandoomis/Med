// Consistent backup (§49, AC-30): SQLite `VACUUM INTO` snapshot + the content-addressed file store + manifest.json,
// packaged as ONE `.tar.gz` archive (see ./tar.ts). Used by the CLI (`npm run backup`) and by the API job.
//
// Included: the database snapshot (everything the owner wrote: library, sources & versions, pages/regions, notes,
//   ink, questions, attempts, flashcards & review events, sessions, study books, evidence, settings, audit log) and
//   every stored file the snapshot references (originals, converted PDFs, page renders, figure crops), each with its
//   sha256.
// Excluded (never in a backup): DATA_DIR/secret.key (the server regenerates one; old signed file links simply expire),
//   environment variables / .env (ANTHROPIC_API_KEY and any other key), DATA_DIR/tmp, OCR model caches
//   (tessdata*), earlier backups (DATA_DIR/backups), blobs no database row references.
import { createHash } from 'node:crypto';
import { closeSync, constants as fsc, createReadStream, existsSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { BACKUP_FORMAT, type BackupManifest } from '@medlevo/shared';
import { openDb, type Db } from '../../db/db';
import { newId } from '../../lib/ids';
import { syncHeadSeq } from './epoch';
import { ArchiveError, TarGzWriter } from './tar';

export const BACKUP_ROOT = 'medlevo-backup';
export const BACKUP_DB_PATH = `${BACKUP_ROOT}/medlevo.sqlite`;
export const BACKUP_MANIFEST_PATH = `${BACKUP_ROOT}/manifest.json`;
export const BACKUP_EXCLUDED = [
  'secret.key (مفتاح الخادم السري — يُنشأ مفتاح جديد عند الاستعادة)',
  'متغيرات البيئة وملف .env (ومنها ANTHROPIC_API_KEY وأي مفتاح آخر)',
  'tmp (ملفات مؤقتة)',
  'tessdata و tessdata-cache (نماذج OCR تُنسخ من الحزم تلقائيًا)',
  'backups (النسخ الاحتياطية السابقة)',
  'ملفات في مخزن الملفات لا يشير إليها أي سجل في قاعدة البيانات',
];

const STORAGE_KEY_RE = /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;
/** owner_setting keys that must never travel in a backup (defensive: no module stores secrets there today) */
export const SECRET_SETTING_KEY = /(api[_-]?key|secret|token|password|credential)/i;
export const SECRET_VALUE = /(sk-ant-[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export interface BackupPaths {
  dataDir: string;
  dbPath: string;
  filesDir: string;
}

export interface CreateBackupOptions extends BackupPaths {
  /** directory receiving the archive (created 0700) */
  outDir: string;
  appVersion: string;
  now: () => number;
  backupId?: string;
  /** an open connection to snapshot from (API job); otherwise dbPath is opened (CLI, concurrent with a running server) */
  db?: Db;
  /** progress callback with real counts */
  onProgress?: (p: { stage: string; done?: number; total?: number; unit?: string }) => void;
  signal?: AbortSignal;
}

export interface BackupResult {
  backupId: string;
  archivePath: string;
  fileName: string;
  size: number;
  sha256: string;
  manifest: BackupManifest;
  warnings_ar: string[];
  summary: { tables: number; rows: number; files: number; file_bytes: number; migrations: number };
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Ordinary tables to count (FTS shadow tables excluded; virtual FTS tables counted through their own interface). */
export function countableTables(db: Db): string[] {
  const rows = db.all<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const virtuals = rows.filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql ?? '')).map((r) => r.name);
  return rows
    .filter((r) => !virtuals.some((v) => r.name.startsWith(`${v}_`) && /_(data|idx|docsize|config|content)$/.test(r.name)))
    .map((r) => r.name);
}

export function rowCounts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of countableTables(db)) {
    out[t] = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`)!.n;
  }
  return out;
}

function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolveP, reject) => {
    const h = createHash('sha256');
    let size = 0;
    const s = createReadStream(path);
    s.on('data', (c) => {
      const b = c as Buffer;
      size += b.length;
      h.update(b);
    });
    s.on('error', reject);
    s.on('end', () => resolveP({ sha256: h.digest('hex'), size }));
  });
}

/** Absolute blob path for a storage key, or null when the key is not a well-formed content address. */
export function blobPath(filesDir: string, storageKey: string): string | null {
  if (!STORAGE_KEY_RE.test(storageKey)) return null;
  const root = resolve(filesDir);
  const p = resolve(root, ...storageKey.split('/'));
  return p.startsWith(root + sep) ? p : null;
}

function isRegularFile(path: string): boolean {
  try {
    const fd = openSync(path, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
    try {
      return fstatSync(fd).isFile();
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export async function createBackup(opts: CreateBackupOptions): Promise<BackupResult> {
  const now = opts.now();
  const backupId = opts.backupId ?? newId(now);
  mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });
  const work = join(opts.outDir, `.work-${backupId}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const fileName = `medlevo-backup-${stamp(now)}-${backupId.slice(-8).toLowerCase()}.tar.gz`;
  const finalPath = join(opts.outDir, fileName);
  const partialPath = `${finalPath}.partial`;
  const warnings: string[] = [];
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new ArchiveError('WRITE_FAILED', 'أُوقف إنشاء النسخة الاحتياطية قبل اكتمالها؛ لم تُحفظ نسخة ناقصة.');
  };

  let writer: TarGzWriter | null = null;
  try {
    // 1. consistent snapshot (a read transaction: concurrent writers keep working in WAL mode)
    opts.onProgress?.({ stage: 'snapshot' });
    const snapPath = join(work, 'medlevo.sqlite');
    const live = opts.db ?? openDb(opts.dbPath);
    try {
      live.run('VACUUM INTO ?', [snapPath]);
    } finally {
      if (!opts.db) live.close();
    }
    checkAbort();

    // 2. read the snapshot: migrations, counts, referenced files; strip anything secret-looking
    const snap = openDb(snapPath);
    let manifestDb: BackupManifest['db'];
    let fileRows: Array<{ id: string; sha256: string; size: number; storage_key: string }>;
    try {
      const secretKeys = snap.all<{ key: string; value_json: string }>('SELECT key, value_json FROM owner_setting').filter(
        (r) => SECRET_SETTING_KEY.test(r.key) || SECRET_VALUE.test(r.value_json),
      );
      for (const r of secretKeys) {
        snap.run('DELETE FROM owner_setting WHERE key = ?', [r.key]);
        warnings.push(`استُبعد إعداد يشبه سرًّا من النسخة (${r.key}).`);
      }
      const migrations = snap.all<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migration ORDER BY name');
      let epoch: string | null = null;
      try {
        epoch = snap.get<{ id: string }>('SELECT id FROM data_server_epoch WHERE is_current = 1')?.id ?? null;
      } catch {
        epoch = null;
      }
      manifestDb = {
        path: BACKUP_DB_PATH,
        sha256: '',
        size: 0,
        migrations,
        row_counts: rowCounts(snap),
        sync_head_seq: syncHeadSeq(snap),
        server_epoch: epoch,
      };
      fileRows = snap.all('SELECT id, sha256, size, storage_key FROM stored_file ORDER BY id');
      if (secretKeys.length) snap.exec('VACUUM'); // the deleted values must not linger in free pages
    } finally {
      snap.close();
    }
    for (const suffix of ['-wal', '-shm']) rmSync(`${snapPath}${suffix}`, { force: true });
    const snapHash = await hashFile(snapPath);
    manifestDb.sha256 = snapHash.sha256;
    manifestDb.size = snapHash.size;
    checkAbort();

    // 3. archive: database, files, manifest (last — it records what was actually written)
    writer = new TarGzWriter(partialPath);
    opts.onProgress?.({ stage: 'database' });
    const dbEntry = await writer.addFile(BACKUP_DB_PATH, snapPath, now);
    if (dbEntry.sha256 !== manifestDb.sha256) throw new ArchiveError('SIZE_CHANGED', 'تغيّرت لقطة قاعدة البيانات أثناء نسخها.');

    const files: BackupManifest['files'] = [];
    const missing: BackupManifest['files_missing'] = [];
    let fileBytes = 0;
    for (let i = 0; i < fileRows.length; i++) {
      checkAbort();
      const f = fileRows[i]!;
      opts.onProgress?.({ stage: 'files', done: i, total: fileRows.length, unit: 'files' });
      const abs = blobPath(opts.filesDir, f.storage_key);
      if (!abs) {
        missing.push({ file_id: f.id, sha256: f.sha256, reason: 'invalid_storage_key' });
        continue;
      }
      if (!existsSync(abs) || !isRegularFile(abs)) {
        missing.push({ file_id: f.id, sha256: f.sha256, reason: 'missing' });
        continue;
      }
      const archivePath = `${BACKUP_ROOT}/files/${f.storage_key}`;
      const written = await writer.addFile(archivePath, abs, now);
      if (written.sha256 !== f.sha256 || written.size !== f.size) {
        // the blob on disk is damaged: it is in the archive under its path but NOT listed as a valid file
        missing.push({ file_id: f.id, sha256: f.sha256, reason: 'hash_mismatch' });
        continue;
      }
      files.push({ path: archivePath, file_id: f.id, sha256: f.sha256, size: f.size });
      fileBytes += f.size;
    }
    opts.onProgress?.({ stage: 'files', done: fileRows.length, total: fileRows.length, unit: 'files' });
    if (missing.length) {
      warnings.push(
        `${missing.length} ملف تشير إليه قاعدة البيانات غير موجود أو تالف في مخزن الملفات؛ النسخة لا تحتويه سليمًا (التفاصيل في manifest.json → files_missing).`,
      );
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      backup_id: backupId,
      app_version: opts.appVersion,
      created_at: now,
      root: BACKUP_ROOT,
      db: manifestDb,
      files,
      files_missing: missing,
      excluded: BACKUP_EXCLUDED,
    };
    await writer.addBuffer(BACKUP_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), now);
    const archive = await writer.finish();
    writer = null;
    renameSync(partialPath, finalPath);
    writeFileSync(`${finalPath}.sha256`, `${archive.sha256}  ${fileName}\n`, { mode: 0o600 });

    const summary = {
      tables: Object.keys(manifestDb.row_counts).length,
      rows: Object.values(manifestDb.row_counts).reduce((a, b) => a + b, 0),
      files: files.length,
      file_bytes: fileBytes,
      migrations: manifestDb.migrations.length,
    };
    return { backupId, archivePath: finalPath, fileName, size: archive.size, sha256: archive.sha256, manifest, warnings_ar: warnings, summary };
  } catch (e) {
    if (writer) await writer.abort();
    rmSync(partialPath, { force: true });
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
