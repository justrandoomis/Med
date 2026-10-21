// Consistent backup (§49, AC-30): SQLite `VACUUM INTO` snapshot + the content-addressed file store + manifest.json,
// packaged as ONE `.tar.gz` archive (see ./tar.ts). Used by the CLI (`npm run backup`) and by the API job.
//
// Included: the database snapshot (everything the owner wrote: library, sources & versions, pages/regions, notes,
//   ink, questions, attempts, flashcards & review events, sessions, study books, evidence, settings, audit log) and
//   every stored file the snapshot references (originals, converted PDFs, page renders, figure crops), each with its
//   sha256.
// Multi-user layout (P1-T1 step 1): the archive holds the system DB (accounts, sessions, devices, registry, job index)
//   and EVERY registered vault at their data-directory paths (system.sqlite, vaults/<id>.sqlite), plus each referenced
//   blob once; `manifest.db` describes the primary vault (the requester's / user #1's), `manifest.vaults` all of them.
//   A single-owner archive (medlevo.sqlite) of releases up to R1-a stays readable and restorable.
// Vault layout (P1-T1 step 2): ONE account's vault (vaults/<id>.sqlite) and the files it references — the per-vault
//   backup of the platform admin and the user's own «نسخة من بياناتي»; no system DB, no other account.
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
/** the single-owner database (releases up to R1-a; still restorable) */
export const BACKUP_DB_PATH = `${BACKUP_ROOT}/medlevo.sqlite`;
/** P1-T1 multi-user archives: the system DB and every vault, at their data-directory paths */
export const BACKUP_SYSTEM_PATH = `${BACKUP_ROOT}/system.sqlite`;
export const backupVaultPath = (dbFile: string): string => `${BACKUP_ROOT}/vaults/${dbFile}`;
const DB_FILE_NAME_RE = /^[A-Za-z0-9_-]{1,80}\.sqlite$/;
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

/** One registered vault to back up (multi-user instance, P1-T1). */
export interface BackupVaultSource {
  id: string;
  userId: string;
  dbFile: string;
  /** absolute path of the live file (opened read-consistently when `db` is not given) */
  path: string;
  db?: Db;
  /** the vault `manifest.db` describes (the requester's / user #1's) */
  primary: boolean;
}

/** The whole multi-user instance: the system DB and every registered vault (P1-T1). */
export interface BackupInstance {
  systemPath: string;
  systemDb?: Db;
  vaults: BackupVaultSource[];
}

export interface CreateBackupOptions extends BackupPaths {
  /** directory receiving the archive (created 0700) */
  outDir: string;
  appVersion: string;
  now: () => number;
  backupId?: string;
  /** an open connection to snapshot from (API job); otherwise dbPath is opened (CLI, concurrent with a running server) */
  db?: Db;
  /** P1-T1: back up the multi-user layout — the system DB and every vault; `dbPath` / `db` are then unused */
  instance?: BackupInstance;
  /** P1-T1 step 2: back up ONE vault and the files it references (layout 'vault'); `dbPath` / `db` unused */
  vaultOnly?: { vault: BackupVaultSource; account: { user_id: string; username: string; display_name: string } };
  /** archive file name prefix (default «medlevo-backup»; exports use «medlevo-export») */
  namePrefix?: 'medlevo-backup' | 'medlevo-vault' | 'medlevo-export';
  /** progress callback with real counts */
  onProgress?: (p: { stage: string; done?: number; total?: number; unit?: string }) => void;
  signal?: AbortSignal;
  /**
   * P1-T1 step 2 review: a referenced blob whose local copy is missing is fetched back first (MEDLEVO_BLOB_STORE=r2 —
   * the object store holds it) instead of being left out of the archive; resolves false when it cannot be had.
   */
  ensureLocal?: (sha256: string, size: number) => Promise<boolean>;
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

interface VaultSnapshot {
  migrations: Array<{ name: string; checksum: string }>;
  row_counts: Record<string, number>;
  sync_head_seq: number;
  server_epoch: string | null;
  sha256: string;
  size: number;
  fileRows: Array<{ id: string; sha256: string; size: number; storage_key: string }>;
}

/** VACUUM INTO a consistent snapshot of one database (a read transaction: writers keep working in WAL mode). */
function vacuumInto(live: Db | undefined, livePath: string, outPath: string): void {
  // a database file that is not there is an error — never an empty database created by opening the path
  if (!live && !existsSync(livePath)) throw new ArchiveError('WRITE_FAILED', 'ملف قاعدة بيانات مسجّل غير موجود على القرص؛ لم تُنشأ نسخة.');
  const db = live ?? openDb(livePath);
  try {
    db.run('VACUUM INTO ?', [outPath]);
  } finally {
    if (!live) db.close();
  }
}

/** Snapshot one vault (or the single-owner database): strip secret-looking settings, read what the manifest needs. */
async function snapshotVault(live: Db | undefined, livePath: string, outPath: string, warnings: string[], label: string): Promise<VaultSnapshot> {
  vacuumInto(live, livePath, outPath);
  const snap = openDb(outPath);
  let meta: Omit<VaultSnapshot, 'sha256' | 'size'>;
  try {
    const secretKeys = snap.all<{ key: string; value_json: string }>('SELECT key, value_json FROM owner_setting').filter(
      (r) => SECRET_SETTING_KEY.test(r.key) || SECRET_VALUE.test(r.value_json),
    );
    for (const r of secretKeys) {
      snap.run('DELETE FROM owner_setting WHERE key = ?', [r.key]);
      warnings.push(`استُبعد إعداد يشبه سرًّا من النسخة${label} (${r.key}).`);
    }
    let epoch: string | null = null;
    try {
      epoch = snap.get<{ id: string }>('SELECT id FROM data_server_epoch WHERE is_current = 1')?.id ?? null;
    } catch {
      epoch = null;
    }
    meta = {
      migrations: snap.all<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migration ORDER BY name'),
      row_counts: rowCounts(snap),
      sync_head_seq: syncHeadSeq(snap),
      server_epoch: epoch,
      fileRows: snap.all('SELECT id, sha256, size, storage_key FROM stored_file ORDER BY id'),
    };
    if (secretKeys.length) snap.exec('VACUUM'); // the deleted values must not linger in free pages
  } finally {
    snap.close();
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${outPath}${suffix}`, { force: true });
  const h = await hashFile(outPath);
  return { ...meta, sha256: h.sha256, size: h.size };
}

export async function createBackup(opts: CreateBackupOptions): Promise<BackupResult> {
  const now = opts.now();
  const backupId = opts.backupId ?? newId(now);
  mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });
  const work = join(opts.outDir, `.work-${backupId}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const fileName = `${opts.namePrefix ?? 'medlevo-backup'}-${stamp(now)}-${backupId.slice(-8).toLowerCase()}.tar.gz`;
  const finalPath = join(opts.outDir, fileName);
  const partialPath = `${finalPath}.partial`;
  const warnings: string[] = [];
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new ArchiveError('WRITE_FAILED', 'أُوقف إنشاء النسخة الاحتياطية قبل اكتمالها؛ لم تُحفظ نسخة ناقصة.');
  };
  let writer: TarGzWriter | null = null;
  try {
    // 1. consistent snapshots — the single-owner database, or (P1-T1) the system DB and EVERY registered vault
    opts.onProgress?.({ stage: 'snapshot' });
    const inst = opts.instance;
    let manifestDb: BackupManifest['db'];
    let manifestSystem: BackupManifest['system'];
    let manifestVaults: BackupManifest['vaults'];
    const archiveDbs: Array<{ path: string; abs: string; sha256: string }> = [];
    const fileRowsAll: Array<{ id: string; sha256: string; size: number; storage_key: string }> = [];
    let totalRows = 0;
    if (opts.vaultOnly) {
      // P1-T1 step 2: one account's vault only
      const src = opts.vaultOnly.vault;
      if (!DB_FILE_NAME_RE.test(src.dbFile)) throw new ArchiveError('WRITE_FAILED', 'اسم ملف خزنة غير صالح في السجل؛ لم تُنشأ نسخة.');
      mkdirSync(join(work, 'vaults'), { recursive: true, mode: 0o700 });
      const out = join(work, 'vaults', src.dbFile);
      const v = await snapshotVault(src.db, src.path, out, warnings, '');
      const path = backupVaultPath(src.dbFile);
      manifestVaults = [{ vault_id: src.id, user_id: src.userId, db_file: src.dbFile, path, primary: true, sha256: v.sha256, size: v.size, migrations: v.migrations, row_counts: v.row_counts, sync_head_seq: v.sync_head_seq, server_epoch: v.server_epoch }];
      manifestDb = { path, sha256: v.sha256, size: v.size, migrations: v.migrations, row_counts: v.row_counts, sync_head_seq: v.sync_head_seq, server_epoch: v.server_epoch };
      archiveDbs.push({ path, abs: out, sha256: v.sha256 });
      fileRowsAll.push(...v.fileRows);
      totalRows = Object.values(v.row_counts).reduce((a, b) => a + b, 0);
    } else if (!inst) {
      const snapPath = join(work, 'medlevo.sqlite');
      const v = await snapshotVault(opts.db, opts.dbPath, snapPath, warnings, '');
      manifestDb = { path: BACKUP_DB_PATH, sha256: v.sha256, size: v.size, migrations: v.migrations, row_counts: v.row_counts, sync_head_seq: v.sync_head_seq, server_epoch: v.server_epoch };
      archiveDbs.push({ path: BACKUP_DB_PATH, abs: snapPath, sha256: v.sha256 });
      fileRowsAll.push(...v.fileRows);
      totalRows = Object.values(v.row_counts).reduce((a, b) => a + b, 0);
    } else {
      if (inst.vaults.length === 0) throw new ArchiveError('WRITE_FAILED', 'لا توجد خزنة بيانات مسجّلة لنسخها.');
      mkdirSync(join(work, 'vaults'), { recursive: true, mode: 0o700 });
      const sysPath = join(work, 'system.sqlite');
      vacuumInto(inst.systemDb, inst.systemPath, sysPath);
      const sysSnap = openDb(sysPath);
      let sysMeta: { migrations: Array<{ name: string; checksum: string }>; row_counts: Record<string, number> };
      try {
        sysMeta = { migrations: sysSnap.all('SELECT name, checksum FROM schema_migration ORDER BY name'), row_counts: rowCounts(sysSnap) };
      } finally {
        sysSnap.close();
      }
      for (const suffix of ['-wal', '-shm']) rmSync(`${sysPath}${suffix}`, { force: true });
      const sysHash = await hashFile(sysPath);
      manifestSystem = { path: BACKUP_SYSTEM_PATH, sha256: sysHash.sha256, size: sysHash.size, migrations: sysMeta.migrations, row_counts: sysMeta.row_counts };
      archiveDbs.push({ path: BACKUP_SYSTEM_PATH, abs: sysPath, sha256: sysHash.sha256 });
      manifestVaults = [];
      const primary = inst.vaults.find((v) => v.primary) ?? inst.vaults[0]!;
      for (const src of inst.vaults) {
        checkAbort();
        if (!DB_FILE_NAME_RE.test(src.dbFile)) throw new ArchiveError('WRITE_FAILED', 'اسم ملف خزنة غير صالح في السجل؛ لم تُنشأ نسخة.');
        const out = join(work, 'vaults', src.dbFile);
        const v = await snapshotVault(src.db, src.path, out, warnings, inst.vaults.length > 1 ? ` (خزنة ${src.id})` : '');
        const path = backupVaultPath(src.dbFile);
        manifestVaults.push({ vault_id: src.id, user_id: src.userId, db_file: src.dbFile, path, primary: src === primary, sha256: v.sha256, size: v.size, migrations: v.migrations, row_counts: v.row_counts, sync_head_seq: v.sync_head_seq, server_epoch: v.server_epoch });
        archiveDbs.push({ path, abs: out, sha256: v.sha256 });
        fileRowsAll.push(...v.fileRows);
        totalRows += Object.values(v.row_counts).reduce((a, b) => a + b, 0);
        if (src === primary) manifestDb = { path, sha256: v.sha256, size: v.size, migrations: v.migrations, row_counts: v.row_counts, sync_head_seq: v.sync_head_seq, server_epoch: v.server_epoch };
      }
    }
    checkAbort();

    // 2. archive: databases, files (each blob once, even when several vaults reference it), manifest (last)
    writer = new TarGzWriter(partialPath);
    opts.onProgress?.({ stage: 'database' });
    for (const d of archiveDbs) {
      const entry = await writer.addFile(d.path, d.abs, now);
      if (entry.sha256 !== d.sha256) throw new ArchiveError('SIZE_CHANGED', 'تغيّرت لقطة قاعدة البيانات أثناء نسخها.');
    }

    const files: BackupManifest['files'] = [];
    const missing: BackupManifest['files_missing'] = [];
    const seen = new Set<string>();
    const fileRows = fileRowsAll.filter((f) => (seen.has(f.storage_key) ? false : (seen.add(f.storage_key), true)));
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
      if ((!existsSync(abs) || !isRegularFile(abs)) && opts.ensureLocal) {
        try {
          await opts.ensureLocal(f.sha256, f.size);
        } catch {
          // reported as missing just below
        }
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
      db: manifestDb!,
      files,
      files_missing: missing,
      excluded: BACKUP_EXCLUDED,
    };
    if (opts.vaultOnly) {
      manifest.layout = 'vault';
      manifest.vaults = manifestVaults!;
      manifest.account = opts.vaultOnly.account;
    } else if (inst) {
      manifest.layout = 'multi_user';
      manifest.system = manifestSystem!;
      manifest.vaults = manifestVaults!;
    }
    await writer.addBuffer(BACKUP_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), now);
    const archive = await writer.finish();
    writer = null;
    renameSync(partialPath, finalPath);
    writeFileSync(`${finalPath}.sha256`, `${archive.sha256}  ${fileName}\n`, { mode: 0o600 });

    const summary = {
      tables: Object.keys(manifest.db.row_counts).length,
      rows: totalRows,
      files: files.length,
      file_bytes: fileBytes,
      migrations: manifest.db.migrations.length,
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
