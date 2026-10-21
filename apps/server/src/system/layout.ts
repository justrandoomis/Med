// What is in DATA_DIR, and whether this build may serve it (ADR-0003 §5 «Boot guard»; P1-T1 step 1).
//
//   DATA_DIR/system.sqlite      the system DB (identity, sessions, devices, registry, job index, …)
//   DATA_DIR/vaults/<id>.sqlite one per user
//   DATA_DIR/spaces/<id>.sqlite one per subject (R1-c)
//   DATA_DIR/files/aa/bb/<sha>  the shared content-addressed blob store (unchanged)
//   DATA_DIR/.multi-user        marker, written LAST when the layout is complete
//
// | what is in DATA_DIR                                     | this build                                           |
// |---------------------------------------------------------|------------------------------------------------------|
// | nothing at all                                          | creates the system DB, then the marker (fresh)       |
// | marker + system DB                                      | normal start                                         |
// | system DB without the marker (and nothing legacy)       | a fresh creation crashed before the marker: finish it |
// | medlevo.sqlite (single-owner data), no marker           | REFUSES to start the app — never setup mode over the |
// |                                                         | owner's data; index.ts serves the maintenance page   |
// |                                                         | and the journaled owner migration (P1-T1 step 3)     |
// | migration-journal.json without the marker               | REFUSES; index.ts resumes the migration first        |
// | vaults/*.sqlite without system.sqlite                    | REFUSES — never first-run setup over unregistered    |
// |                                                         | vaults                                               |
// | marker + system DB + medlevo.sqlite beside them         | REFUSES — a half-done manual rollback or a copied    |
// |                                                         | file: never ignore a single-owner database silently  |
// Nothing here ever writes to, moves or deletes an existing database file (the migration is system/ownerMigration.ts).
//
// After the owner migration, DATA_DIR/medlevo.sqlite is a TOMBSTONE (a short text file, P1-T1 step 3 review): a release
// up to R1-a opens that path at boot and, finding no file, would create an EMPTY database and offer first-run setup over
// the migrated data (and back that empty database up every night). SQLite refuses the tombstone («file is not a
// database»), so an older release deployed by mistake (Render «Rollback» before the data rollback) stops instead. This
// build recognises it (isLegacyTombstone) and never takes it for single-owner data; the data rollback sets it aside.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db/db';
import { migrate } from '../db/migrate';

export interface DataDirPaths {
  dataDir: string;
  /** DATA_DIR/medlevo.sqlite — the single-owner database of releases up to R1-a */
  legacyDbPath: string;
  systemDbPath: string;
  vaultsDir: string;
  spacesDir: string;
}

export const MARKER_FILE = '.multi-user';
export const JOURNAL_FILE = 'migration-journal.json';
/** first bytes of the tombstone left at DATA_DIR/medlevo.sqlite by the owner migration (never a SQLite header) */
export const LEGACY_TOMBSTONE_MAGIC = 'MEDLEVO-TOMBSTONE v1';

/** Is this file the tombstone of a migrated single-owner database (not the database itself)? */
export function isLegacyTombstone(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(LEGACY_TOMBSTONE_MAGIC.length);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n === buf.length && buf.toString('latin1') === LEGACY_TOMBSTONE_MAGIC;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** DATA_DIR/medlevo.sqlite is the owner's single-owner database (present, and not the migration's tombstone). */
export function isLegacyDb(path: string): boolean {
  return existsSync(path) && !isLegacyTombstone(path);
}

export type DataDirState =
  | { kind: 'fresh' }
  | { kind: 'multi_user' }
  | { kind: 'unfinished_fresh' }
  | { kind: 'legacy_single_owner' }
  | { kind: 'migration_in_progress' }
  | { kind: 'orphan_vaults' }
  | { kind: 'legacy_beside_multi_user' };

export class DataDirRefusedError extends Error {
  readonly state: DataDirState['kind'];
  constructor(state: DataDirState['kind'], message: string) {
    super(message);
    this.name = 'DataDirRefusedError';
    this.state = state;
  }
}

function hasSqliteFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => n.endsWith('.sqlite'));
  } catch {
    return false;
  }
}

export function detectDataDir(p: DataDirPaths): DataDirState {
  const marker = existsSync(join(p.dataDir, MARKER_FILE));
  const system = existsSync(p.systemDbPath);
  const legacy = isLegacyDb(p.legacyDbPath);
  const journal = existsSync(join(p.dataDir, JOURNAL_FILE));
  if (marker && system) return legacy ? { kind: 'legacy_beside_multi_user' } : { kind: 'multi_user' };
  if (journal) return { kind: 'migration_in_progress' };
  if (legacy) return { kind: 'legacy_single_owner' };
  if (system) return { kind: 'unfinished_fresh' };
  if (hasSqliteFiles(p.vaultsDir) || hasSqliteFiles(p.spacesDir)) return { kind: 'orphan_vaults' };
  if (marker) return { kind: 'orphan_vaults' }; // a marker without its system DB: something was removed by hand
  // the tombstone of a migrated owner without its system DB and vaults: never «fresh» (setup) over it
  if (existsSync(p.legacyDbPath)) return { kind: 'orphan_vaults' };
  return { kind: 'fresh' };
}

export type RefusedState = 'legacy_single_owner' | 'migration_in_progress' | 'orphan_vaults' | 'legacy_beside_multi_user';

const REFUSALS: Record<RefusedState, string> = {
  legacy_single_owner:
    'الترقية لم تكتمل بعد: مجلد البيانات يحتوي قاعدة بيانات المالك الواحد (medlevo.sqlite). لا يعمل التطبيق ولن يبدأ إعدادًا جديدًا فوقها قبل نقلها إلى الحساب #1 ' +
    '(صفحة الترقية /api/maintenance، أو الأمر npm run migrate:multi-user -- --apply). لم يُغيَّر أي ملف. ' +
    '— Upgrade not finished: DATA_DIR holds the single-owner database (medlevo.sqlite). The app will not start (and never runs first-run setup over it) before the owner migration; no file was changed.',
  migration_in_progress:
    'ترحيل المالك إلى نظام الحسابات المتعددة بدأ ولم يكتمل (migration-journal.json). يُستأنف من آخر خطوة مكتملة (عند التشغيل، أو npm run migrate:multi-user -- --resume) قبل أن يعمل التطبيق؛ لم يُغيَّر أي ملف هنا. ' +
    '— An owner migration journal exists without the completion marker. It is resumed (at boot or with --resume) before the app starts; no file was changed here.',
  legacy_beside_multi_user:
    'مجلد البيانات يحتوي نظام الحسابات المتعددة (system.sqlite والعلامة) وبجانبه قاعدة مالك واحد (medlevo.sqlite): حالة غير واضحة (تراجع يدوي لم يكتمل؟). لن يعمل الخادم ولن يتجاهل أيًا منهما؛ ' +
    'أكمل التراجع (npm run migrate:multi-user -- --rollback) أو انقل medlevo.sqlite إلى مكان آخر بعد فحصه. لم يُغيَّر أي ملف. ' +
    '— DATA_DIR holds the multi-user layout AND a single-owner medlevo.sqlite. The server refuses to guess; finish the rollback or move medlevo.sqlite away. No file was changed.',
  orphan_vaults:
    'مجلد البيانات يحتوي ملفات خزائن (vaults) بلا قاعدة النظام (system.sqlite). لن يبدأ الخادم إعدادًا جديدًا فوقها؛ استعد قاعدة النظام من النسخة الاحتياطية. ' +
    '— DATA_DIR holds vault files without system.sqlite. The server refuses to run first-run setup over them; restore the system database from a backup.',
};

function fsyncPath(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best effort
  }
}

/**
 * Make DATA_DIR ready for this build, or refuse (DataDirRefusedError) without touching anything. A fresh directory
 * gets its system DB (built as a temp file and renamed into place) and then the marker.
 */
export function prepareDataDir(p: DataDirPaths, now: () => number): DataDirState {
  mkdirSync(p.dataDir, { recursive: true, mode: 0o700 });
  const state = detectDataDir(p);
  if (state.kind === 'legacy_single_owner' || state.kind === 'migration_in_progress' || state.kind === 'orphan_vaults' || state.kind === 'legacy_beside_multi_user') {
    throw new DataDirRefusedError(state.kind, REFUSALS[state.kind]);
  }
  mkdirSync(p.vaultsDir, { recursive: true, mode: 0o700 });
  mkdirSync(p.spacesDir, { recursive: true, mode: 0o700 });
  if (state.kind === 'fresh') {
    const tmp = `${p.systemDbPath}.${randomBytes(4).toString('hex')}.tmp`;
    const db = openDb(tmp);
    try {
      migrate(db, { sets: ['system'], now });
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    for (const s of ['-wal', '-shm']) rmSync(`${tmp}${s}`, { force: true });
    fsyncPath(tmp);
    renameSync(tmp, p.systemDbPath);
    fsyncPath(p.dataDir);
  }
  if (state.kind === 'fresh' || state.kind === 'unfinished_fresh') {
    writeFileSync(join(p.dataDir, MARKER_FILE), `multi-user layout created ${new Date(now()).toISOString()}\n`, { mode: 0o600 });
    fsyncPath(p.dataDir);
  }
  return state;
}
