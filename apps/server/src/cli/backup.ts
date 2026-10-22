// MedLevo backup CLI (§49, AC-30): `npm run backup [-- --out <dir>] [--data-dir <dir>]`
// Consistent snapshot of the database (SQLite VACUUM INTO — safe while the server is running) + every stored file
// the snapshot references + manifest.json (app version, applied migrations, row counts per table, sha256 per file),
// packaged as ONE .tar.gz archive with a .sha256 sidecar. secret.key, .env / API keys, tmp, OCR caches and earlier
// backups are never included. See docs/BACKUP_RESTORE.md.
// Exit codes: 0 completed · 3 completed with warnings (e.g. a blob referenced by the database is missing) ·
//             1 failed (nothing kept) · 2 usage / no database.
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { loadConfig, loadDotEnv } from '../config';
import { openDb } from '../db/db';
import { recordCliBackup } from '../modules/data/backups';
import { type BackupInstance, createBackup } from '../modules/data/backup';
import { encryptArchive, ENC_SUFFIX } from '../modules/data/archive-crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { ArchiveError } from '../modules/data/tar';

const HELP = `MedLevo backup
Usage: npm run backup [-- --out <dir>] [--data-dir <dir>] [--encrypt]
  --out <dir>        where to write the archive (default: <DATA_DIR>/backups)
  --data-dir <dir>   the server's data directory (default: MEDLEVO_DATA_DIR from the environment / .env)
  --encrypt          keep only an encrypted archive (.tar.gz.mlenc, MEDLEVO_BACKUP_ENCRYPTION_KEY); the plain one is removed
The archive contains the database snapshot, the stored files and manifest.json.
Never included: secret.key, .env / API keys, tmp, OCR caches, earlier backups.`;

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`missing value for ${name}`);
  return v;
}

function fromInitCwd(p: string): string {
  return isAbsolute(p) ? p : resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

/**
 * The registered vaults of a multi-user data directory, read from its system DB (a separate read connection; the
 * server may be running). The primary — whose data_backup table lists the archive — is user #1's (the first platform
 * admin's) vault.
 */
function readInstance(systemDbPath: string, vaultsDir: string, spacesDir: string): BackupInstance {
  const sys = openDb(systemDbPath);
  try {
    const admin = sys.get<{ id: string }>(`SELECT id FROM user_account WHERE is_platform_admin = 1 ORDER BY created_at, id LIMIT 1`)?.id ?? null;
    const rows = sys.all<{ id: string; user_id: string; db_file: string }>(`SELECT id, user_id, db_file FROM vault WHERE status IN ('active','locked') ORDER BY created_at, id`);
    // GATE-1: every subject space too (official lectures and explanations live there)
    const spaces = sys.all<{ id: string; db_file: string }>(`SELECT id, db_file FROM space ORDER BY id`);
    return {
      systemPath: systemDbPath,
      vaults: rows.map((r) => ({ id: r.id, userId: r.user_id, dbFile: r.db_file, path: join(vaultsDir, r.db_file), primary: r.user_id === admin })),
      spaces: spaces.map((s) => ({ id: s.id, dbFile: s.db_file, path: join(spacesDir, s.db_file) })),
    };
  } finally {
    sys.close();
  }
}

function human(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  loadDotEnv();
  const dataDirArg = arg(argv, '--data-dir');
  const env = { ...process.env, ...(dataDirArg ? { MEDLEVO_DATA_DIR: fromInitCwd(dataDirArg) } : {}) };
  const config = loadConfig(env, { cwd: process.env.INIT_CWD ?? process.cwd() });
  // P1-T1: a multi-user data directory (system.sqlite + vaults/) is backed up whole — the system DB and every vault;
  // a single-owner one (medlevo.sqlite, R1-a and earlier) exactly as before
  const instance = existsSync(config.systemDbPath) ? readInstance(config.systemDbPath, config.vaultsDir, config.spacesDir) : null;
  if (!instance && !existsSync(config.dbPath)) {
    process.stderr.write(`MedLevo backup: no database at ${config.dbPath} or ${config.systemDbPath}. Nothing was backed up.\n`);
    return 2;
  }
  const primaryPath = instance ? (instance.vaults.find((v) => v.primary) ?? instance.vaults[0])?.path ?? null : config.dbPath;
  const serverBackups = join(config.dataDir, 'backups');
  const outArg = arg(argv, '--out');
  const outDir = outArg ? fromInitCwd(outArg) : serverBackups;
  const started = Date.now();
  process.stdout.write(
    instance ? `MedLevo backup: snapshot of ${config.systemDbPath}, ${instance.vaults.length} vault(s) in ${config.vaultsDir} and ${instance.spaces?.length ?? 0} subject space(s) in ${config.spacesDir}\n` : `MedLevo backup: snapshot of ${config.dbPath}\n`,
  );
  let lastStage = '';
  const res = await createBackup({
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    ...(instance ? { instance } : {}),
    filesDir: config.filesDir,
    outDir,
    appVersion: config.appVersion,
    now: () => Date.now(),
    onProgress: (p) => {
      if (p.stage !== lastStage) {
        lastStage = p.stage;
        process.stdout.write(`  · ${p.stage}${p.total !== undefined ? ` (${p.total} ${p.unit ?? ''})` : ''}\n`);
      }
    },
  });
  // P1-T1 step 2: --encrypt keeps only the MLVENC01 archive (an archive of several accounts should never sit in clear)
  if (argv.includes('--encrypt')) {
    const key = config.secrets.backupEncryptionKey();
    if (!key) {
      rmSync(res.archivePath, { force: true });
      rmSync(`${res.archivePath}.sha256`, { force: true });
      process.stderr.write('MedLevo backup: --encrypt needs MEDLEVO_BACKUP_ENCRYPTION_KEY. Nothing was kept.\n');
      return 2;
    }
    const enc = `${res.archivePath}${ENC_SUFFIX}`;
    const h = await encryptArchive(res.archivePath, enc, key);
    rmSync(res.archivePath, { force: true });
    rmSync(`${res.archivePath}.sha256`, { force: true });
    writeFileSync(`${enc}.sha256`, `${h.sha256}  ${res.fileName}${ENC_SUFFIX}\n`, { mode: 0o600 });
    process.stdout.write(`Encrypted: ${enc} (${h.size} bytes, sha256 ${h.sha256}); the plain archive was removed.\nVerify: npm run restore:verify -- "${enc}" (with the same key)\n`);
    return res.warnings_ar.length ? 3 : 0;
  }
  if (resolve(outDir) === resolve(serverBackups)) {
    // listed in the app (Control Center → backups) when written into the server's own backups directory
    try {
      if (!primaryPath) throw new Error('no primary vault');
      const db = openDb(primaryPath);
      try {
        recordCliBackup(db, {
          backupId: res.backupId,
          fileName: res.fileName,
          size: res.size,
          sha256: res.sha256,
          summary: res.summary,
          warnings_ar: res.warnings_ar,
          createdAt: res.manifest.created_at,
          finishedAt: Date.now(),
        });
      } finally {
        db.close();
      }
    } catch {
      // older database without the data_backup table: the archive is still complete
    }
  }
  process.stdout.write(
    [
      `Archive:   ${res.archivePath}`,
      `Size:      ${human(res.size)} (${res.size} bytes)`,
      `SHA-256:   ${res.sha256}  (also in ${res.fileName}.sha256)`,
      `Database:  ${res.summary.tables} tables, ${res.summary.rows} rows, ${res.summary.migrations} migrations`,
      `Files:     ${res.summary.files} (${human(res.summary.file_bytes)})`,
      `Excluded:  secret.key, .env / API keys, tmp, OCR caches, earlier backups`,
      `Took:      ${((Date.now() - started) / 1000).toFixed(1)} s`,
      ...res.warnings_ar.map((w) => `WARNING:   ${w}`),
      `Next: verify it restores — npm run restore:verify -- "${res.archivePath}"`,
      '',
    ].join('\n'),
  );
  return res.warnings_ar.length ? 3 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    const msg = e instanceof ArchiveError ? e.reasonAr : e instanceof Error ? e.message : String(e);
    process.stderr.write(`MedLevo backup FAILED: ${msg}\nNo partial archive was kept.\n`);
    process.exit(1);
  });
