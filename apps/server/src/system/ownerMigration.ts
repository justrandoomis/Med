// The journaled owner migration (ADR-0003 §5; BUILD_PLAN §1.3 and §3.3 step 3; P1-T1 step 3).
//
// The single owner of releases up to R1-a becomes user #1 of the multi-user layout with ZERO loss:
// DATA_DIR/medlevo.sqlite is MOVED, byte for byte, to DATA_DIR/vaults/<vault>.sqlite — no row of it is rewritten — and a
// new DATA_DIR/system.sqlite knows the account (same scrypt password string, same unused recovery codes), its active
// sessions (same token hashes: signed-in devices stay signed in), its devices, its blobs and its unfinished jobs.
//
// A resumable state machine. DATA_DIR/migration-journal.json holds one JSON line per step event, each fsync'd before
// the next action; every step checks the journal and the disk first, so it can run again after a crash at ANY point:
//
//   begin       the journal exists from here on: the boot guard resumes instead of serving or entering setup mode
//   freeze      PRAGMA wal_checkpoint(TRUNCATE), integrity_check, foreign_key_check; the database must already hold
//               every base migration of this build (the release rule: the first boot opens the vault unchanged)
//   safety      sha256 + size + per-table row counts of medlevo.sqlite; a full backup (AC-30 machinery) into
//               DATA_DIR/migration/, verified by restore:verify (with a boot on a sandbox copy); encrypted and copied to
//               R2 with its sha256 when off-site backups are configured
//   system_db   DATA_DIR/system.sqlite.migrating.tmp from the system migrations: user #1 (platform admin, legacy owner),
//               the vault row (locked), devices seeded from every device id the owner's database knows, the active
//               sessions, one blob row + hint per stored file, the job index of unfinished jobs, an audit row
//   move_vault  rename medlevo.sqlite → vaults/<vault>.sqlite (same filesystem); the sha256 must equal the reference
//   commit      vault → active; rename the temp system DB into place; write DATA_DIR/.multi-user LAST
//   verify      before the first boot: the vault's sha256 and per-table row counts equal the step-«safety» reference
//   complete    (and later `first_boot`: checksum and row counts recorded again by the server after its first boot)
//
// Before `move_vault` a step that fails for a reason a retry cannot fix (the owner's database is damaged, has no
// account, is newer or older than this build) ABORTS: the temp system DB is removed and the journal is set aside as
// migration-journal.aborted-<time>.json — the data directory is exactly the single-owner one again. Any other failure
// leaves the journal; the next boot (or `--resume`) continues from the last completed step, or the owner rolls back.
//
// Rollback (valid while no base migration has been applied to the vault since — BUILD_PLAN §1.3): move the vault file
// back to medlevo.sqlite (writes made under the new build are kept: they are in that file; a password changed meanwhile
// is copied back into its `owner` row, and a session revoked meanwhile stays revoked), and set system.sqlite, the
// marker and the journal aside in DATA_DIR/rolled-back-<time>/. The previous build then reads the database unchanged.
// Resumable too.
//
// (review) After the move DATA_DIR/medlevo.sqlite is a TOMBSTONE (layout.ts): an older release deployed by mistake
// before the data rollback refuses it instead of creating an empty database and offering first-run setup. The rollback
// sets it aside before moving the vault back. One migration or rollback at a time per process (BUSY).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync, writeSync, createReadStream } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config';
import { openDb, type Db } from '../db/db';
import { migrate, readMigrations } from '../db/migrate';
import { sha256File } from '../lib/hash';
import { newId } from '../lib/ids';
import { ENC_DEFAULT_CHUNK, ENC_SUFFIX, EncryptStream, encryptedSize } from '../lib/objectstore/encryption';
import type { S3ClientOptions } from '../lib/objectstore/s3';
import { uploadObject } from '../lib/objectstore/upload';
import { createBackup, rowCounts } from '../modules/data/backup';
import { syncHeadSeq } from '../modules/data/epoch';
import { createOffsiteClient, describeOffsiteError } from '../modules/data/offsite';
import { verifyBackup } from '../modules/data/restore';
import { detectDataDir, isLegacyDb, isLegacyTombstone, JOURNAL_FILE, LEGACY_TOMBSTONE_MAGIC, MARKER_FILE, type DataDirPaths, type DataDirState } from './layout';
import { createSystemRepos, normalizeUsername } from './repos';

export const MIGRATION_DIR = 'migration';
export const SYSTEM_TMP_SUFFIX = '.migrating.tmp';
export const ROLLED_BACK_PREFIX = 'rolled-back-';
export const ABORTED_JOURNAL_PREFIX = 'migration-journal.aborted-';
export const SERVER_LOCK_FILE = 'server.lock';
/** the tombstone's name once a rollback set it aside (in DATA_DIR/rolled-back-<time>/) */
export const TOMBSTONE_ASIDE_NAME = 'medlevo.sqlite.moved-to-vault';
export { isLegacyTombstone };

// ─── one migration or rollback at a time in this process (review: a double tap on «retry» ran two) ─────
let activeOperation: 'migration' | 'rollback' | null = null;

function acquire(kind: 'migration' | 'rollback'): () => void {
  if (activeOperation !== null) {
    throw new OwnerMigrationError(
      'BUSY',
      activeOperation === 'rollback' ? 'التراجع عن الترقية يعمل الآن على هذا الخادم؛ انتظر حتى ينتهي.' : 'الترقية تعمل الآن على هذا الخادم؛ انتظر حتى تنتهي.',
      true,
      `an owner ${activeOperation} is already running in this process`,
    );
  }
  activeOperation = kind;
  return () => {
    activeOperation = null;
  };
}

/** Is a migration or a rollback running in this process now? */
export function ownerOperationRunning(): boolean {
  return activeOperation !== null;
}

export const MIGRATION_STEPS = ['freeze', 'safety', 'system_db', 'move_vault', 'commit', 'verify'] as const;
export type MigrationStep = (typeof MIGRATION_STEPS)[number];
export type JournalStep = 'begin' | MigrationStep | 'complete' | 'first_boot' | 'aborted' | 'rollback' | 'rolled_back';

export interface JournalLine {
  v: 1;
  step: JournalStep;
  status: 'started' | 'done' | 'failed';
  at: number;
  [k: string]: unknown;
}

/** What `safety` recorded about the owner's database (the reference every later check compares with). */
export interface LegacyReference {
  sha256: string;
  size: number;
  row_counts: Record<string, number>;
  migrations: string[];
  sync_head_seq: number;
  server_epoch: string | null;
}

export class OwnerMigrationError extends Error {
  readonly code: string;
  readonly reasonAr: string;
  /** a retry (resume) can succeed — otherwise, before the move, the migration aborts and changes nothing */
  readonly retryable: boolean;
  constructor(code: string, reasonAr: string, retryable: boolean, english?: string) {
    super(`${reasonAr} — ${english ?? code}`);
    this.name = 'OwnerMigrationError';
    this.code = code;
    this.reasonAr = reasonAr;
    this.retryable = retryable;
  }
}

export interface MigrationProgress {
  step: JournalStep;
  label_ar: string;
  done?: number;
  total?: number;
  unit?: string;
}

export interface MigrationHooks {
  /** TESTS: called at every crash point (after each journal line, and between the actions of a step) */
  at?(point: string): void | Promise<void>;
}

export interface MigrationRunOptions {
  config: AppConfig;
  /** apply = start (refused when already migrated or in progress) · resume = continue an unfinished journal */
  mode: 'apply' | 'resume';
  now?: () => number;
  /** do not copy the step-0 backup to R2 even when off-site backups are configured (the owner chose so explicitly) */
  skipOffsite?: boolean;
  /** boot the app on a sandbox copy of the restored backup (default true; the restore:verify boot check) */
  verifyBoot?: boolean;
  progress?: (p: MigrationProgress) => void;
  hooks?: MigrationHooks;
  /** tests: S3 client tuning against the local fake */
  offsite?: { client?: S3ClientOptions; partSizeBytes?: number; encChunkSize?: number };
}

export interface MigrationOutcome {
  userId: string;
  vaultId: string;
  dbFile: string;
  username: string;
  reference: LegacyReference;
  backup: { path: string; sha256: string; size: number };
  offsite: { key: string; size: number } | { skipped: string };
  counts: { sessions: number; devices: number; blobs: number; jobs: number };
}

const STEP_AR: Record<JournalStep, string> = {
  begin: 'بدء الترقية',
  freeze: 'تجميد قاعدة البيانات وفحص سلامتها',
  safety: 'نسخة احتياطية كاملة والتحقق من استعادتها',
  system_db: 'إنشاء قاعدة النظام وحسابك',
  move_vault: 'نقل قاعدة بياناتك كما هي إلى خزنتك',
  commit: 'تثبيت الترقية',
  verify: 'التحقق من أن بياناتك لم يتغير منها بايت واحد',
  complete: 'اكتملت الترقية',
  first_boot: 'أول تشغيل بعد الترقية',
  aborted: 'أُلغيت الترقية دون تغيير شيء',
  rollback: 'التراجع عن الترقية',
  rolled_back: 'اكتمل التراجع',
};
export const stepLabelAr = (s: JournalStep): string => STEP_AR[s];

export function dataDirPaths(config: Pick<AppConfig, 'dataDir' | 'dbPath' | 'systemDbPath' | 'vaultsDir' | 'spacesDir'>): DataDirPaths {
  return { dataDir: config.dataDir, legacyDbPath: config.dbPath, systemDbPath: config.systemDbPath, vaultsDir: config.vaultsDir, spacesDir: config.spacesDir };
}

// ─── journal ─────────────────────────────────────────────────────────────────────────────────

export function journalPath(dataDir: string): string {
  return join(dataDir, JOURNAL_FILE);
}

/** Every complete line of the journal (a line torn by a crash while it was written is ignored). */
export function readJournal(dataDir: string): JournalLine[] {
  let raw: string;
  try {
    raw = readFileSync(journalPath(dataDir), 'utf8');
  } catch {
    return [];
  }
  const out: JournalLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as JournalLine;
      if (v && v.v === 1 && typeof v.step === 'string' && typeof v.status === 'string') out.push(v);
    } catch {
      // torn last line
    }
  }
  return out;
}

function fsyncPath(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best effort (directories on some filesystems)
  }
}

type JournalInput = { step: JournalStep; status: JournalLine['status']; at: number } & Record<string, unknown>;

function appendJournal(dataDir: string, line: JournalInput): JournalLine {
  const full: JournalLine = { ...line, v: 1 };
  const path = journalPath(dataDir);
  const created = !existsSync(path);
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(full)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) fsyncPath(dataDir);
  return full;
}

function lastOf(lines: JournalLine[], step: JournalStep, status?: JournalLine['status']): JournalLine | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.step === step && (status === undefined || l.status === status)) return l;
  }
  return undefined;
}

export function isStepDone(lines: JournalLine[], step: JournalStep): boolean {
  return lastOf(lines, step, 'done') !== undefined;
}

export type JournalState = 'none' | 'in_progress' | 'complete' | 'rollback_in_progress';

/** Where the journal stands (the marker alone does not say: the marker is written inside `commit`). */
export function journalState(lines: JournalLine[]): JournalState {
  if (lines.length === 0) return 'none';
  const rb = lastOf(lines, 'rollback');
  if (rb && !isStepDone(lines, 'rolled_back')) return 'rollback_in_progress';
  if (isStepDone(lines, 'complete')) return 'complete';
  return 'in_progress';
}

/**
 * (review) A journal file holding no complete line beside the owner's database, with no system DB (nor its temp file)
 * and no marker: a crash between creating the journal and the fsync of its first line («begin», written before any
 * other action). Nothing of the migration happened — the directory is the single-owner one; the file is set aside when
 * the migration starts. Without this the server stayed «blocked» with no way out but a shell.
 */
export function journalNeverStarted(config: Pick<AppConfig, 'dataDir' | 'dbPath' | 'systemDbPath'>): boolean {
  return (
    existsSync(journalPath(config.dataDir)) &&
    readJournal(config.dataDir).length === 0 &&
    isLegacyDb(config.dbPath) &&
    !existsSync(config.systemDbPath) &&
    !existsSync(`${config.systemDbPath}${SYSTEM_TMP_SUFFIX}`) &&
    !existsSync(join(config.dataDir, MARKER_FILE))
  );
}

// ─── a server already running on this data directory ────────────────────────────────────────

export interface ServerLock {
  pid: number;
  host: string;
  started_at: number;
  mode: 'maintenance' | 'app';
}

/** Written by the server process (index.ts) for its lifetime; the CLI refuses to move files under a running server. */
export function writeServerLock(dataDir: string, mode: ServerLock['mode'], now = Date.now()): void {
  writeFileSync(join(dataDir, SERVER_LOCK_FILE), JSON.stringify({ pid: process.pid, host: hostname(), started_at: now, mode } satisfies ServerLock), { mode: 0o600 });
}

export function clearServerLock(dataDir: string): void {
  try {
    const l = JSON.parse(readFileSync(join(dataDir, SERVER_LOCK_FILE), 'utf8')) as ServerLock;
    if (l.pid === process.pid) rmSync(join(dataDir, SERVER_LOCK_FILE), { force: true });
  } catch {
    // none
  }
}

/** Another LIVE process of this host holds the lock (a lock of a dead process, or of this process, does not count). */
export function otherServerRunning(dataDir: string): ServerLock | null {
  let l: ServerLock;
  try {
    l = JSON.parse(readFileSync(join(dataDir, SERVER_LOCK_FILE), 'utf8')) as ServerLock;
  } catch {
    return null;
  }
  if (!l || typeof l.pid !== 'number' || l.pid === process.pid || l.host !== hostname()) return null;
  try {
    process.kill(l.pid, 0);
    return l;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? l : null;
  }
}

function assertNoOtherServer(dataDir: string): void {
  const other = otherServerRunning(dataDir);
  if (other) {
    throw new OwnerMigrationError(
      'SERVER_RUNNING',
      `الخادم يعمل الآن على مجلد البيانات هذا (العملية ${other.pid}). لا تُنقل الملفات تحت خادم يعمل: استخدم صفحة الترقية /api/maintenance أو أوقف الخادم ثم أعد الأمر.`,
      true,
      `a server (pid ${other.pid}) is running on this data directory`,
    );
  }
}

// ─── small helpers ───────────────────────────────────────────────────────────────────────────

const systemTmpPath = (config: AppConfig) => `${config.systemDbPath}${SYSTEM_TMP_SUFFIX}`;

function rmDbFiles(path: string): void {
  for (const s of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${s}`, { force: true });
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/** -wal of a closed, checkpointed database is absent or empty: then -wal/-shm can go. Otherwise: refuse. */
function dropEmptyWal(path: string, what: string): void {
  const wal = sizeOf(`${path}-wal`);
  if (wal > 0) {
    throw new OwnerMigrationError(
      'WAL_NOT_EMPTY',
      `ملف -wal لقاعدة البيانات (${what}) ليس فارغًا: شيء ما كتب فيها بعد تجميدها (خادم آخر يعمل؟). لم يُنقل شيء؛ أوقف أي خادم آخر ثم استأنف.`,
      true,
      `${path}-wal is not empty`,
    );
  }
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function shippedBaseMigrations(): string[] {
  return readMigrations().map((m) => m.name);
}

/**
 * GATE-1: the base migrations of release R1-a (git d0c8ab4) — the schema the owner migration moves byte for byte
 * (ADR-0003 §5 release rule). A later release adds base migrations of its own (R1-c: 0163, 0860) that must not run as
 * part of the move, so an R1-a database reaching such a release is sent through the multi-user release R1-b first
 * (`MULTI_USER_RELEASE_FIRST`); only a database that lacks one of THESE is «older than R1-a». Frozen: never edit.
 */
export const R1A_BASE_MIGRATIONS: readonly string[] = [
  '0001_core.sql', '0030_job_worker.sql', '0041_sync_actor_visibility.sql', '0050_change_log_actor.sql',
  '0100_library_trash.sql', '0150_sources_registry.sql', '0160_lecture_identity.sql', '0161_page_map.sql',
  '0164_version_rendition.sql', '0200_processing.sql', '0210_figure_reading.sql', '0220_page_orientation.sql',
  '0250_annotations.sql', '0260_note_pages_links_images.sql', '0270_ink_recognition.sql',
  '0271_annotation_layers.sql', '0272_annotation_revision.sql', '0274_reanchor_copy.sql',
  '0280_annotation_image_release.sql', '0290_reanchor.sql', '0300_evidence.sql',
  '0310_content_alert_question_corrected.sql', '0450_studybook.sql', '0460_study_diagram.sql', '0500_questions.sql',
  '0510_question_occurrence_lookup.sql', '0520_question_derivation.sql', '0530_question_fingerprint_v2.sql',
  '0550_exams.sql', '0560_written_handwriting.sql', '0570_simulation.sql', '0600_learning.sql', '0650_media.sql',
  '0660_audio_recording.sql', '0670_visual_source_registry.sql', '0700_control.sql', '0710_quality_ops.sql',
  '0750_data.sql', '0751_offsite_backup.sql', '0770_cases.sql', '0800_course_brain.sql',
  '0801_brain_relation_reasons_purge.sql', '0810_brain_algorithms_statements.sql', '0861_attribution.sql',
];

/** The Arabic reason an R1-a database cannot be moved by THIS release, or null when the base schema is the one shipped. */
function baseSchemaProblemAr(pending: string[]): { code: 'DB_OLDER_THAN_R1A' | 'MULTI_USER_RELEASE_FIRST'; reason_ar: string } | null {
  if (!pending.length) return null;
  const missingR1a = pending.filter((m) => R1A_BASE_MIGRATIONS.includes(m));
  if (missingR1a.length) {
    return {
      code: 'DB_OLDER_THAN_R1A',
      reason_ar: `قاعدة البيانات أقدم من الإصدار R1-a (ينقصها ${missingR1a.length} ترحيلًا أساسيًا). نقل المالك يجب ألا يغيّر قاعدة البيانات، فثبّت R1-a وشغّله مرة واحدة أولًا ثم حدّث إلى هذا الإصدار.`,
    };
  }
  const names = pending.map((m) => m.replace(/\.sql$/, '')).join('، ');
  return {
    code: 'MULTI_USER_RELEASE_FIRST',
    reason_ar:
      `قاعدة بياناتك من الإصدار R1-a. هذا الإصدار يضيف ترحيلات أساسية (${names}) لا تُطبَّق أثناء نقل بياناتك إلى الحساب رقم 1، حتى يبقى التراجع ممكنًا. ` +
      'انشر أولًا إصدار الترقية إلى الحسابات المتعددة (R1-b) وأكمل الترقية حتى «اكتملت الترقية»، ثم حدّث إلى هذا الإصدار. لم يتغير شيء.',
  };
}

interface OwnerRow {
  username: string;
  password_hash: string;
  recovery_codes_json: string;
  password_changed_at: number;
  created_at: number;
  updated_at: number;
}

function readOwner(db: Db): OwnerRow | null {
  try {
    return db.get<OwnerRow>(`SELECT username, password_hash, recovery_codes_json, password_changed_at, created_at, updated_at FROM owner WHERE id = 'owner'`) ?? null;
  } catch {
    return null;
  }
}

function tableExists(db: Db, name: string): boolean {
  return db.get<{ x: number }>(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]) !== undefined;
}

// ─── dry run ─────────────────────────────────────────────────────────────────────────────────

export interface DryRunReport {
  state: DataDirState['kind'];
  journal: JournalState;
  can_apply: boolean;
  /** blocking problems (Arabic) */
  problems_ar: string[];
  warnings_ar: string[];
  legacy: null | {
    size: number;
    wal_size: number;
    owner_username: string | null;
    migrations: number;
    pending_base_migrations: string[];
    unknown_migrations: string[];
    tables: number;
    rows: number;
    counts: Record<string, number>;
    files: { count: number; bytes: number; missing: number };
    active_sessions: number;
    device_ids: number;
    unfinished_jobs: number;
  };
  disk: { free_bytes: number | null; needed_bytes: number };
  offsite: { configured: boolean; problems_ar: string[] };
  server_running: boolean;
}

const COUNT_TABLES = ['source', 'source_page', 'annotation', 'annotation_layer', 'note', 'note_page', 'flashcard', 'review_event', 'exam_attempt', 'question_attempt', 'data_backup', 'stored_file', 'sync_operation'];

/** What the migration would do, read-only (never changes a byte of the owner's data). */
export function planOwnerMigration(config: AppConfig): DryRunReport {
  const paths = dataDirPaths(config);
  const state = detectDataDir(paths).kind;
  const lines = readJournal(config.dataDir);
  const report: DryRunReport = {
    state,
    journal: journalState(lines),
    can_apply: false,
    problems_ar: [],
    warnings_ar: [],
    legacy: null,
    disk: { free_bytes: null, needed_bytes: 0 },
    offsite: { configured: config.offsite.configured, problems_ar: config.offsite.problems_ar },
    server_running: otherServerRunning(config.dataDir) !== null,
  };
  if (state === 'multi_user' && report.journal === 'complete') report.problems_ar.push('اكتملت الترقية من قبل: لا يُعاد تشغيلها مرتين.');
  else if (state === 'migration_in_progress' && journalNeverStarted(config)) {
    // an empty / torn journal beside the owner's database: nothing started (see journalNeverStarted)
  }
  else if (state === 'multi_user') report.problems_ar.push('مجلد البيانات بنظام الحسابات المتعددة أصلًا (لا توجد قاعدة مالك واحد لنقلها).');
  else if (state === 'fresh' || state === 'unfinished_fresh') report.problems_ar.push('لا توجد قاعدة بيانات مالك واحد (medlevo.sqlite) في مجلد البيانات: لا شيء لنقله.');
  else if (state === 'orphan_vaults') report.problems_ar.push('مجلد البيانات يحتوي ملفات خزائن بلا قاعدة النظام؛ لن تبدأ الترقية فوقها.');
  else if (state === 'migration_in_progress') report.warnings_ar.push('بدأت الترقية من قبل ولم تكتمل: تُستأنف من آخر خطوة مكتملة (--resume).');
  if (existsSync(config.systemDbPath) && state === 'legacy_single_owner') report.problems_ar.push('يوجد system.sqlite بجانب medlevo.sqlite دون علامة اكتمال: حالة غير واضحة؛ افحص المجلد قبل الترقية.');
  if (report.server_running) report.warnings_ar.push('الخادم يعمل الآن على هذا المجلد: التنفيذ يتم من صفحة الترقية أو بعد إيقافه.');
  const emptyJournal = journalNeverStarted(config);
  if (emptyJournal) report.warnings_ar.push('يوجد سجل ترقية فارغ (انقطاع قبل أن يُكتب سطره الأول): لم يبدأ شيء، ويُنقل السجل جانبًا عند البدء.');

  if (isLegacyDb(config.dbPath)) {
    const db = openDb(config.dbPath);
    try {
      const owner = readOwner(db);
      const migrations = tableExists(db, 'schema_migration') ? db.all<{ name: string }>('SELECT name FROM schema_migration ORDER BY name').map((r) => r.name) : [];
      const shipped = shippedBaseMigrations();
      const pending = shipped.filter((m) => !migrations.includes(m));
      const unknown = migrations.filter((m) => !shipped.includes(m));
      const counts = rowCounts(db);
      const files = tableExists(db, 'stored_file') ? db.all<{ storage_key: string; size: number }>('SELECT storage_key, size FROM stored_file') : [];
      let missing = 0;
      let bytes = 0;
      for (const f of files) {
        bytes += f.size;
        if (!existsSync(join(config.filesDir, f.storage_key))) missing++;
      }
      const now = Date.now();
      const sessions = tableExists(db, 'auth_session') ? db.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_session WHERE revoked_at IS NULL AND expires_at > ?', [now])!.n : 0;
      const devices = deviceIdsOf(db).length;
      const jobs = tableExists(db, 'processing_job') ? db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM processing_job WHERE status IN ('queued','running','waiting_for_input')`)!.n : 0;
      report.legacy = {
        size: sizeOf(config.dbPath),
        wal_size: Math.max(0, sizeOf(`${config.dbPath}-wal`)),
        owner_username: owner?.username ?? null,
        migrations: migrations.length,
        pending_base_migrations: pending,
        unknown_migrations: unknown,
        tables: Object.keys(counts).length,
        rows: Object.values(counts).reduce((a, b) => a + b, 0),
        counts: Object.fromEntries(COUNT_TABLES.filter((t) => t in counts).map((t) => [t, counts[t]!])),
        files: { count: files.length, bytes, missing },
        active_sessions: sessions,
        device_ids: devices,
        unfinished_jobs: jobs,
      };
      if (!owner) report.problems_ar.push('قاعدة المالك الواحد لا تحتوي حساب مالك (لم يكتمل الإعداد الأول فيها): لا يوجد حساب لنقله.');
      if (unknown.length) report.problems_ar.push(`قاعدة البيانات أحدث من هذا الإصدار (ترحيلات لا يعرفها: ${unknown.join('، ')}).`);
      const schemaProblem = baseSchemaProblemAr(pending);
      if (schemaProblem) report.problems_ar.push(schemaProblem.reason_ar);
      if (missing) report.warnings_ar.push(`${missing} ملف تشير إليه قاعدة البيانات غير موجود في مخزن الملفات منذ قبل الترقية؛ تُنقل كما هي وتذكر النسخة الاحتياطية ذلك.`);
      // backup archive (database + files, gzip may shrink it) + its extracted copy for the restore check + the system DB
      report.disk.needed_bytes = Math.ceil((report.legacy.size + bytes) * 2.2) + 64 * 1024 * 1024;
    } finally {
      db.close();
    }
  }
  try {
    const s = statfsSync(config.dataDir);
    report.disk.free_bytes = Number(s.bavail) * Number(s.bsize);
  } catch {
    report.disk.free_bytes = null;
  }
  if (report.legacy && report.disk.free_bytes !== null && report.disk.free_bytes < report.disk.needed_bytes) {
    report.problems_ar.push(
      `المساحة الحرة على القرص (${Math.floor(report.disk.free_bytes / 1048576)} م.ب) أقل مما تحتاجه النسخة الاحتياطية والتحقق منها (${Math.ceil(report.disk.needed_bytes / 1048576)} م.ب). كبّر القرص من لوحة Render ثم أعد المحاولة.`,
    );
  }
  if (!config.offsite.configured) report.warnings_ar.push('النسخ خارج الخادم (R2) غير مُعدّ: تبقى النسخة الاحتياطية المتحقق منها على قرص الخادم فقط.');
  report.can_apply = (state === 'legacy_single_owner' || emptyJournal) && report.problems_ar.length === 0;
  return report;
}

function deviceIdsOf(db: Db): Array<{ device_id: string; label: string | null; first: number; last: number }> {
  const out = new Map<string, { device_id: string; label: string | null; first: number; last: number }>();
  const add = (id: string | null, label: string | null, first: number, last: number) => {
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
    const cur = out.get(id);
    if (!cur) out.set(id, { device_id: id, label, first, last });
    else {
      cur.first = Math.min(cur.first, first);
      cur.last = Math.max(cur.last, last);
      cur.label ??= label;
    }
  };
  if (tableExists(db, 'auth_session')) {
    for (const r of db.all<{ device_id: string | null; device_label: string | null; f: number; l: number }>(
      'SELECT device_id, MAX(device_label) AS device_label, MIN(created_at) AS f, MAX(last_seen_at) AS l FROM auth_session WHERE device_id IS NOT NULL GROUP BY device_id',
    )) {
      add(r.device_id, r.device_label, r.f, r.l);
    }
  }
  if (tableExists(db, 'sync_operation')) {
    for (const r of db.all<{ device_id: string; f: number; l: number }>('SELECT device_id, MIN(received_at) AS f, MAX(received_at) AS l FROM sync_operation GROUP BY device_id')) {
      add(r.device_id, null, r.f, r.l);
    }
  }
  return [...out.values()].sort((a, b) => (a.device_id < b.device_id ? -1 : 1));
}

// ─── the migration ───────────────────────────────────────────────────────────────────────────

export async function runOwnerMigration(o: MigrationRunOptions): Promise<MigrationOutcome> {
  const release = acquire('migration');
  try {
    return await runOwnerMigrationLocked(o);
  } finally {
    release();
  }
}

async function runOwnerMigrationLocked(o: MigrationRunOptions): Promise<MigrationOutcome> {
  const { config } = o;
  const now = o.now ?? Date.now;
  const paths = dataDirPaths(config);
  const at = async (point: string) => {
    await o.hooks?.at?.(point);
  };
  const progress = (step: JournalStep, extra: Partial<MigrationProgress> = {}) => o.progress?.({ step, label_ar: STEP_AR[step], ...extra });

  if (o.mode === 'apply' && journalNeverStarted(config)) {
    // nothing started (an empty / torn journal): set it aside, then start normally
    renameSync(journalPath(config.dataDir), join(config.dataDir, `${ABORTED_JOURNAL_PREFIX}${stamp(now())}-empty.json`));
    fsyncPath(config.dataDir);
  }
  let lines = readJournal(config.dataDir);
  const js = journalState(lines);
  const state = detectDataDir(paths).kind;
  if (js === 'rollback_in_progress') {
    throw new OwnerMigrationError('ROLLBACK_IN_PROGRESS', 'بدأ تراجع عن الترقية ولم يكتمل؛ أكمله أولًا (--rollback).', false);
  }
  if (o.mode === 'apply') {
    if (js === 'complete' || state === 'multi_user') {
      throw new OwnerMigrationError('ALREADY_MIGRATED', 'اكتملت الترقية من قبل: لا تُشغَّل مرتين. بياناتك في خزنة الحساب #1.', false, 'already migrated');
    }
    if (js === 'in_progress') throw new OwnerMigrationError('IN_PROGRESS', 'بدأت الترقية من قبل ولم تكتمل: استأنفها (--resume) ولا تبدأها من جديد.', false, 'a migration is in progress: resume it');
    if (state !== 'legacy_single_owner') {
      throw new OwnerMigrationError('NOTHING_TO_MIGRATE', 'لا توجد قاعدة بيانات مالك واحد (medlevo.sqlite) لنقلها.', false, `nothing to migrate (${state})`);
    }
    if (existsSync(config.systemDbPath)) {
      throw new OwnerMigrationError('AMBIGUOUS_LAYOUT', 'يوجد system.sqlite بجانب medlevo.sqlite دون علامة اكتمال: حالة غير واضحة. لم يتغير شيء؛ افحص مجلد البيانات.', false, 'system.sqlite exists beside medlevo.sqlite');
    }
    assertNoOtherServer(config.dataDir);
    lines.push(appendJournal(config.dataDir, { step: 'begin', status: 'done', at: now(), from: 'medlevo.sqlite', app_version: config.appVersion, host: hostname(), pid: process.pid }));
    progress('begin');
    await at('begin:done');
  } else {
    if (js === 'none') throw new OwnerMigrationError('NO_JOURNAL', 'لا توجد ترقية بدأت ولم تكتمل لاستئنافها.', false, 'no migration journal');
    if (js === 'complete') {
      const out = outcomeFromJournal(lines);
      if (out) return out;
    }
    assertNoOtherServer(config.dataDir);
  }

  try {
    for (const step of MIGRATION_STEPS) {
      lines = readJournal(config.dataDir);
      if (isStepDone(lines, step)) continue;
      progress(step);
      lines.push(appendJournal(config.dataDir, { step, status: 'started', at: now(), ...startedData(step, lines, now) }));
      await at(`${step}:started`);
      const result = await STEP_RUNNERS[step]({ ...o, now, lines, at, progress });
      lines.push(appendJournal(config.dataDir, { step, status: 'done', at: now(), ...result }));
      await at(`${step}:done`);
    }
    lines = readJournal(config.dataDir);
    if (!isStepDone(lines, 'complete')) {
      lines.push(appendJournal(config.dataDir, { step: 'complete', status: 'done', at: now() }));
      progress('complete');
    }
  } catch (e) {
    if (e instanceof OwnerMigrationError) {
      lines = readJournal(config.dataDir);
      const moved = lastOf(lines, 'move_vault', 'started') !== undefined;
      appendJournal(config.dataDir, { step: lastStartedStep(lines) ?? 'begin', status: 'failed', at: now(), code: e.code, reason_ar: e.reasonAr, retryable: e.retryable });
      if (!moved && !e.retryable) abortMigration(config, e, now);
    }
    throw e;
  }
  const out = outcomeFromJournal(readJournal(config.dataDir));
  if (!out) throw new OwnerMigrationError('JOURNAL_INCOMPLETE', 'سجل الترقية ناقص بعد اكتمالها؛ لم يُحذف شيء.', false);
  return out;
}

function lastStartedStep(lines: JournalLine[]): JournalStep | null {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.status === 'started') return lines[i]!.step;
  return null;
}

/** Before the move nothing of the owner's data has changed: drop the temp system DB and set the journal aside. */
function abortMigration(config: AppConfig, e: OwnerMigrationError, now: () => number): void {
  rmDbFiles(systemTmpPath(config));
  appendJournal(config.dataDir, { step: 'aborted', status: 'done', at: now(), code: e.code, reason_ar: e.reasonAr });
  renameSync(journalPath(config.dataDir), join(config.dataDir, `${ABORTED_JOURNAL_PREFIX}${stamp(now())}.json`));
  fsyncPath(config.dataDir);
}

/** The newest aborted journal's reason (the maintenance page shows why the last attempt stopped). */
export function lastAbort(dataDir: string): { at: number; code: string; reason_ar: string } | null {
  let names: string[];
  try {
    names = readdirSync(dataDir).filter((n) => n.startsWith(ABORTED_JOURNAL_PREFIX)).sort();
  } catch {
    return null;
  }
  const name = names.at(-1);
  if (!name) return null;
  try {
    const lines = readFileSync(join(dataDir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as JournalLine);
    const a = lines.reverse().find((l) => l.step === 'aborted');
    return a ? { at: a.at, code: String(a.code ?? ''), reason_ar: String(a.reason_ar ?? '') } : null;
  } catch {
    return null;
  }
}

/** Ids chosen when `system_db` starts are journaled with its «started» line, so a resumed step reuses them. */
function startedData(step: MigrationStep, lines: JournalLine[], now: () => number): Record<string, unknown> {
  if (step !== 'system_db') return {};
  const prev = lastOf(lines, 'system_db', 'started');
  if (prev && typeof prev.user_id === 'string' && typeof prev.vault_id === 'string') return { user_id: prev.user_id, vault_id: prev.vault_id, db_file: prev.db_file };
  const vaultId = newId(now());
  return { user_id: newId(now()), vault_id: vaultId, db_file: `${vaultId}.sqlite` };
}

export function referenceOf(lines: JournalLine[]): LegacyReference | null {
  const s = lastOf(lines, 'safety', 'done');
  return (s?.legacy as LegacyReference | undefined) ?? null;
}

export function idsOf(lines: JournalLine[]): { userId: string; vaultId: string; dbFile: string } | null {
  const s = lastOf(lines, 'system_db', 'started');
  if (!s || typeof s.user_id !== 'string' || typeof s.vault_id !== 'string' || typeof s.db_file !== 'string') return null;
  return { userId: s.user_id, vaultId: s.vault_id, dbFile: s.db_file };
}

function outcomeFromJournal(lines: JournalLine[]): MigrationOutcome | null {
  const ref = referenceOf(lines);
  const ids = idsOf(lines);
  const safety = lastOf(lines, 'safety', 'done');
  const sys = lastOf(lines, 'system_db', 'done');
  if (!ref || !ids || !safety || !sys || !isStepDone(lines, 'complete')) return null;
  return {
    userId: ids.userId,
    vaultId: ids.vaultId,
    dbFile: ids.dbFile,
    username: String(sys.username ?? ''),
    reference: ref,
    backup: safety.backup as MigrationOutcome['backup'],
    offsite: safety.offsite as MigrationOutcome['offsite'],
    counts: sys.counts as MigrationOutcome['counts'],
  };
}

/** Write the tombstone at DATA_DIR/medlevo.sqlite (temp file + rename: never a torn tombstone). */
function writeLegacyTombstone(config: AppConfig, ids: { userId: string; vaultId: string; dbFile: string }, at: number): void {
  const text = [
    LEGACY_TOMBSTONE_MAGIC,
    `This MedLevo data directory was upgraded to the multi-user layout on ${new Date(at).toISOString()}.`,
    `The owner's single-owner database is now vaults/${ids.dbFile} (user #1 ${ids.userId}, vault ${ids.vaultId}), byte for byte.`,
    'This file only stops an older release (R1-a or earlier) from creating an empty database here and offering first-run setup.',
    'To go back: run the data rollback FIRST (MEDLEVO_OWNER_MIGRATION=rollback, docs/DEPLOY_PHONE_AR.md), then deploy the older release.',
    'رُقّي مجلد البيانات هذا إلى نظام الحسابات المتعددة، وقاعدة بيانات المالك الآن في مجلد vaults كما هي. هذا الملف يمنع الإصدار القديم من إنشاء قاعدة فارغة هنا.',
    'للعودة: نفّذ التراجع عن الترقية أولًا (MEDLEVO_OWNER_MIGRATION=rollback) ثم انشر الإصدار القديم.',
    '',
  ].join('\n');
  const tmp = `${config.dbPath}.tombstone.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  fsyncPath(tmp);
  renameSync(tmp, config.dbPath);
  fsyncPath(config.dataDir);
}

interface StepContext extends Omit<MigrationRunOptions, 'progress'> {
  now: () => number;
  lines: JournalLine[];
  at: (point: string) => Promise<void>;
  progress: (step: JournalStep, extra?: Partial<MigrationProgress>) => void;
}

type StepRunner = (c: StepContext) => Promise<Record<string, unknown>>;

const STEP_RUNNERS: Record<MigrationStep, StepRunner> = {
  // 1. freeze: every committed write is in the main file; the file is sound; this build knows exactly its migrations
  async freeze({ config }) {
    if (!isLegacyDb(config.dbPath)) throw new OwnerMigrationError('LEGACY_MISSING', 'قاعدة بيانات المالك (medlevo.sqlite) غير موجودة قبل تجميدها.', false);
    const db = openDb(config.dbPath);
    let fkViolations = 0;
    let migrations: string[] = [];
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const integrity = db.all<{ integrity_check: string }>('PRAGMA integrity_check').map((r) => r.integrity_check);
      if (!(integrity.length === 1 && integrity[0] === 'ok')) {
        throw new OwnerMigrationError(
          'INTEGRITY_FAILED',
          `فحص سلامة قاعدة بياناتك (integrity_check) لم ينجح: ${integrity.slice(0, 3).join('؛ ')}. لم يُنقل شيء ولم يتغير شيء. استعد آخر نسخة احتياطية سليمة أو اطلب المساعدة قبل الترقية.`,
          false,
        );
      }
      fkViolations = db.all('PRAGMA foreign_key_check').length;
      if (!readOwner(db)) {
        throw new OwnerMigrationError('NO_OWNER', 'قاعدة المالك الواحد لا تحتوي حساب مالك (لم يكتمل الإعداد الأول فيها): لا يوجد حساب لنقله. لم يتغير شيء.', false);
      }
      migrations = db.all<{ name: string }>('SELECT name FROM schema_migration ORDER BY name').map((r) => r.name);
    } finally {
      db.close();
    }
    const shipped = shippedBaseMigrations();
    const unknown = migrations.filter((m) => !shipped.includes(m));
    const pending = shipped.filter((m) => !migrations.includes(m));
    if (unknown.length) {
      throw new OwnerMigrationError('DB_NEWER', `قاعدة البيانات أحدث من هذا الإصدار (${unknown.join('، ')}). لم يتغير شيء؛ ثبّت الإصدار الذي أنشأها.`, false);
    }
    const schemaProblem = baseSchemaProblemAr(pending);
    if (schemaProblem) {
      throw new OwnerMigrationError(schemaProblem.code, schemaProblem.code === 'DB_OLDER_THAN_R1A' ? `${schemaProblem.reason_ar} لم يتغير شيء.` : schemaProblem.reason_ar, false);
    }
    dropEmptyWal(config.dbPath, 'medlevo.sqlite');
    return { fk_violations: fkViolations, migrations: migrations.length };
  },

  // 0 (ADR-0003 §5). Safety first: the reference checksum and counts, then a verified backup, then (optionally) R2
  async safety({ config, now, at, progress, skipOffsite, verifyBoot, offsite }) {
    const before = await sha256File(config.dbPath);
    const db = openDb(config.dbPath);
    let legacy: LegacyReference;
    try {
      let epoch: string | null = null;
      try {
        epoch = db.get<{ id: string }>('SELECT id FROM data_server_epoch WHERE is_current = 1')?.id ?? null;
      } catch {
        epoch = null;
      }
      legacy = {
        sha256: before.sha256,
        size: before.size,
        row_counts: rowCounts(db),
        migrations: db.all<{ name: string }>('SELECT name FROM schema_migration ORDER BY name').map((r) => r.name),
        sync_head_seq: syncHeadSeq(db),
        server_epoch: epoch,
      };
    } finally {
      db.close();
    }
    dropEmptyWal(config.dbPath, 'medlevo.sqlite');
    const outDir = join(config.dataDir, MIGRATION_DIR);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const backup = await createBackup({
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      filesDir: config.filesDir,
      outDir,
      appVersion: config.appVersion,
      now,
      onProgress: (p) => progress('safety', { label_ar: p.stage === 'files' ? 'نسخة احتياطية: الملفات' : 'نسخة احتياطية: قاعدة البيانات', done: p.done, total: p.total, unit: p.unit }),
    });
    await at('safety:backup_written');
    progress('safety', { label_ar: 'التحقق من استعادة النسخة الاحتياطية (تشغيل تجريبي)' });
    mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });
    const verified = await verifyBackup(backup.archivePath, { workDir: config.tmpDir, bootCheck: verifyBoot ?? true, acceptMissingFiles: true, now });
    writeFileSync(`${backup.archivePath}.verify.json`, JSON.stringify(verified.report, null, 2), { mode: 0o600 });
    if (!verified.report.ok) {
      const failed = verified.report.checks.filter((c) => !c.ok).map((c) => c.detail_ar).join(' ');
      throw new OwnerMigrationError('BACKUP_VERIFY_FAILED', `فشل التحقق من استعادة النسخة الاحتياطية، فلم تبدأ الترقية: ${failed}`.trim(), true);
    }
    const after = await sha256File(config.dbPath);
    if (after.sha256 !== legacy.sha256) {
      throw new OwnerMigrationError('LEGACY_CHANGED', 'تغيّرت قاعدة بياناتك أثناء النسخ الاحتياطي (هل يعمل خادم آخر؟). لم يُنقل شيء؛ أوقفه ثم استأنف.', true);
    }

    // off-site: the same archive, encrypted on this server, beside the nightly backups (restorable with
    // `medlevo-restore-offsite --key <file>`; kept by the normal retention policy)
    let offsiteResult: MigrationOutcome['offsite'];
    if (!config.offsite.configured) offsiteResult = { skipped: 'not_configured' };
    else if (skipOffsite) offsiteResult = { skipped: 'skipped_by_owner' };
    else {
      const master = config.secrets.backupEncryptionKey();
      if (!master) throw new OwnerMigrationError('OFFSITE_KEY_MISSING', 'مفتاح تشفير النسخ (MEDLEVO_BACKUP_ENCRYPTION_KEY) غير موجود؛ لم تُرفع النسخة.', true);
      progress('safety', { label_ar: 'رفع نسخة مشفرة إلى R2' });
      const key = `${config.offsite.prefix}backups/${backup.fileName}${ENC_SUFFIX}`;
      const chunkSize = offsite?.encChunkSize ?? ENC_DEFAULT_CHUNK;
      const archiveSize = statSync(backup.archivePath).size;
      const total = encryptedSize(archiveSize, chunkSize);
      const salt = randomBytes(32);
      try {
        const client = createOffsiteClient(config, offsite?.client ?? {});
        await uploadObject(client, key, () => createReadStream(backup.archivePath).pipe(new EncryptStream(master, { salt, chunkSize })), total, {
          partSize: offsite?.partSizeBytes ?? config.offsite.partSizeBytes,
          contentType: 'application/octet-stream',
          metadata: {
            'medlevo-format': 'medlevo-backup-1+mlvenc01',
            'medlevo-key-id': config.offsite.keyId ?? '',
            'medlevo-backup-id': backup.backupId,
            'medlevo-archive-sha256': backup.sha256,
            'medlevo-app-version': config.appVersion,
            'medlevo-purpose': 'owner-migration',
          },
          onProgress: (p) => progress('safety', { label_ar: 'رفع نسخة مشفرة إلى R2', done: p.bytes, total: p.totalBytes, unit: 'bytes' }),
        });
        const head = await client.headObject(key);
        if (!head || head.size !== total) throw new Error('size not confirmed');
      } catch (e) {
        const d = describeOffsiteError(e);
        throw new OwnerMigrationError('OFFSITE_FAILED', `تعذّر رفع النسخة الاحتياطية المشفرة إلى R2: ${d.reasonAr} لم يُنقل شيء. أعد المحاولة، أو تابع دون نسخة خارج الخادم (النسخة المحلية المتحقق منها موجودة).`, true);
      }
      offsiteResult = { key, size: total };
      writeFileSync(join(outDir, `${backup.fileName}${ENC_SUFFIX}.r2-key`), `${key}\n`, { mode: 0o600 });
    }
    return {
      legacy,
      backup: { path: backup.archivePath, file: backup.fileName, sha256: backup.sha256, size: backup.size, warnings_ar: backup.warnings_ar, verify_ok: true },
      offsite: offsiteResult,
    };
  },

  // 2, 4, 5. The system DB as a temp file: user #1, the vault (locked), devices, sessions, blobs, job index
  async system_db({ config, now, lines, at }) {
    const ids = idsOf(lines);
    if (!ids) throw new OwnerMigrationError('JOURNAL_IDS_MISSING', 'سجل الترقية لا يحمل معرّفات الحساب والخزنة.', false);
    const tmp = systemTmpPath(config);
    rmDbFiles(tmp);
    if (!isLegacyDb(config.dbPath)) throw new OwnerMigrationError('LEGACY_MISSING', 'قاعدة بيانات المالك (medlevo.sqlite) غير موجودة قبل إنشاء قاعدة النظام.', false);
    const ref = referenceOf(lines);
    if (!ref) throw new OwnerMigrationError('JOURNAL_REFERENCE_MISSING', 'سجل الترقية لا يحمل البصمة المرجعية لقاعدة بياناتك.', false);

    // read everything the system DB needs from the owner's database (no write)
    const legacy = openDb(config.dbPath);
    let owner: OwnerRow;
    let sessions: Array<Record<string, unknown>>;
    let devices: ReturnType<typeof deviceIdsOf>;
    let files: Array<{ sha256: string; size: number; mime: string; storage_key: string; created_at: number }>;
    let jobs: Array<{ id: string; kind: string; status: string; run_after: number }>;
    const t = now();
    try {
      owner = readOwner(legacy)!;
      if (!owner) throw new OwnerMigrationError('NO_OWNER', 'قاعدة المالك الواحد لا تحتوي حساب مالك.', false);
      sessions = legacy.all(`SELECT id, token_hash, device_id, device_label, user_agent, ip, created_at, last_seen_at, expires_at FROM auth_session WHERE revoked_at IS NULL AND expires_at > ?`, [t]);
      devices = deviceIdsOf(legacy);
      files = legacy.all(`SELECT sha256, size, mime, storage_key, created_at FROM stored_file ORDER BY sha256`);
      jobs = legacy.all(`SELECT id, kind, status, run_after FROM processing_job WHERE status IN ('queued','running','waiting_for_input') ORDER BY id`);
    } finally {
      legacy.close();
    }
    dropEmptyWal(config.dbPath, 'medlevo.sqlite');

    const sys = openDb(tmp);
    try {
      migrate(sys, { sets: ['system'], now });
      const repos = createSystemRepos(sys, { now });
      sys.tx(() => {
        // user #1 from the owner row VERBATIM: same login name, the same scrypt string (the same password works), the
        // same unused recovery codes, the same dates; platform admin and the legacy owner
        repos.users.createInternal({
          id: ids.userId,
          username: owner.username,
          displayName: owner.username,
          passwordHash: owner.password_hash,
          recoveryHashes: [],
          isPlatformAdmin: true,
          legacyOwner: true,
          timezone: config.timezone,
        });
        sys.run('UPDATE user_account SET recovery_codes_json = ?, password_changed_at = ?, created_at = ?, updated_at = ? WHERE id = ?', [
          owner.recovery_codes_json,
          owner.password_changed_at,
          owner.created_at,
          owner.updated_at,
          ids.userId,
        ]);
        sys.run('UPDATE user_profile SET updated_at = ? WHERE user_id = ?', [owner.updated_at, ids.userId]);
        const fileBytes = files.reduce((a, f) => a + f.size, 0);
        sys.run(`INSERT INTO vault (id, user_id, db_file, status, bytes_db, bytes_files, created_at) VALUES (?, ?, ?, 'locked', ?, ?, ?)`, [
          ids.vaultId,
          ids.userId,
          ids.dbFile,
          ref.size,
          fileBytes,
          owner.created_at,
        ]);
        // devices: every device the owner's database knows, each with a server-issued device_uid (ADR-0003 §5 step 5)
        for (const d of devices) {
          sys.run(`INSERT INTO device (user_id, device_id, device_uid, label, platform, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, NULL, ?, ?)`, [
            ids.userId,
            d.device_id,
            newId(t),
            d.label,
            d.first,
            d.last,
          ]);
        }
        // sessions: the same token hashes — signed-in devices stay signed in
        for (const s of sessions) {
          sys.run(
            `INSERT INTO auth_session (id, user_id, token_hash, device_id, device_label, user_agent, ip, created_at, last_seen_at, expires_at, revoked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
            [s.id, ids.userId, s.token_hash, s.device_id, s.device_label, s.user_agent, s.ip, s.created_at, s.last_seen_at, s.expires_at],
          );
        }
        // blobs: DATA_DIR/files stays where it is (storage keys unchanged) and becomes the shared store
        for (const f of files) {
          repos.blobs.registerInternal({ sha256: f.sha256, size: f.size, mime: f.mime, storageKey: f.storage_key }, f.created_at);
          sys.run(`INSERT INTO blob_ref (sha256, db_id, ref_count) VALUES (?, ?, 1) ON CONFLICT (sha256, db_id) DO UPDATE SET ref_count = 1`, [f.sha256, ids.vaultId]);
        }
        // the job index: unfinished work of the owner's database is found by the worker
        for (const j of jobs) {
          repos.jobIndex.upsertInternal({ db_kind: 'vault', db_id: ids.vaultId, job_id: j.id, kind: j.kind, status: j.status, run_after: j.run_after, actor_user_id: ids.userId });
        }
        repos.securityAudit.record({
          actorUserId: ids.userId,
          actorRole: 'system',
          action: 'owner_migration',
          targetDb: `v:${ids.vaultId}`,
          summary: 'نُقل حساب المالك وبياناته إلى الحساب #1 دون تغيير (ADR-0003 §5)',
          details: { sessions: sessions.length, devices: devices.length, blobs: files.length, jobs: jobs.length, legacy_sha256: ref.sha256 },
        });
      });
      sys.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      sys.close();
    }
    dropEmptyWal(tmp, 'system.sqlite (مؤقت)');
    fsyncPath(tmp);
    fsyncPath(config.dataDir);
    await at('system_db:written');
    return { username: owner.username, username_norm: normalizeUsername(owner.username), counts: { sessions: sessions.length, devices: devices.length, blobs: files.length, jobs: jobs.length } };
  },

  // 3. the owner's database becomes vault #1, byte for byte
  async move_vault({ config, lines, at, now }) {
    const ids = idsOf(lines)!;
    const ref = referenceOf(lines)!;
    const vaultPath = join(config.vaultsDir, ids.dbFile);
    const legacyThere = isLegacyDb(config.dbPath);
    const vaultThere = existsSync(vaultPath);
    if (legacyThere && vaultThere) throw new OwnerMigrationError('BOTH_PRESENT', 'يوجد medlevo.sqlite وملف الخزنة معًا: حالة غير متوقعة. لم يُحذف شيء؛ لا تتابع قبل فحص المجلد.', false);
    if (!legacyThere && !vaultThere) throw new OwnerMigrationError('NEITHER_PRESENT', 'لم يُعثر على قاعدة بياناتك لا في مكانها القديم ولا في الخزنة. لم يُحذف شيء؛ استعد النسخة الاحتياطية من مجلد migration.', false);
    if (legacyThere) {
      dropEmptyWal(config.dbPath, 'medlevo.sqlite');
      const h = await sha256File(config.dbPath);
      if (h.sha256 !== ref.sha256 || h.size !== ref.size) {
        throw new OwnerMigrationError('LEGACY_CHANGED', 'تغيّرت قاعدة بياناتك بعد النسخ الاحتياطي (هل يعمل خادم آخر؟). لم يُنقل شيء.', false);
      }
      mkdirSync(config.vaultsDir, { recursive: true, mode: 0o700 });
      renameSync(config.dbPath, vaultPath);
      fsyncPath(config.vaultsDir);
      fsyncPath(config.dataDir);
      await at('move_vault:renamed');
    }
    const h = await sha256File(vaultPath);
    if (h.sha256 !== ref.sha256 || h.size !== ref.size) {
      throw new OwnerMigrationError('VAULT_CHECKSUM', 'بصمة ملف الخزنة بعد النقل لا تطابق البصمة المرجعية. لا يُشغَّل التطبيق؛ تراجع عن الترقية أو استعد النسخة الاحتياطية.', false);
    }
    // the tombstone in the database's old place: an older release deployed by mistake refuses it (layout.ts)
    if (!existsSync(config.dbPath)) {
      writeLegacyTombstone(config, ids, now());
      await at('move_vault:tombstone');
    }
    return { vault_path: vaultPath, sha256: h.sha256 };
  },

  // 6. commit: vault active, the system DB in place by rename, the marker LAST
  async commit({ config, lines, at }) {
    const ids = idsOf(lines)!;
    const tmp = systemTmpPath(config);
    const tmpThere = existsSync(tmp);
    const sysThere = existsSync(config.systemDbPath);
    if (tmpThere && !sysThere) {
      const db = openDb(tmp);
      try {
        db.run(`UPDATE vault SET status = 'active' WHERE id = ?`, [ids.vaultId]);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
      dropEmptyWal(tmp, 'system.sqlite (مؤقت)');
      fsyncPath(tmp);
      renameSync(tmp, config.systemDbPath);
      fsyncPath(config.dataDir);
      await at('commit:renamed');
    } else if (sysThere) {
      // renamed before a crash: make sure it is OUR system DB, then that the vault is active
      const db = openDb(config.systemDbPath);
      try {
        const v = db.get<{ status: string }>('SELECT status FROM vault WHERE id = ? AND user_id = ?', [ids.vaultId, ids.userId]);
        if (!v) throw new OwnerMigrationError('SYSTEM_DB_FOREIGN', 'قاعدة النظام الموجودة لا تخص هذه الترقية. لم يُحذف شيء؛ افحص مجلد البيانات.', false);
        if (v.status !== 'active') db.run(`UPDATE vault SET status = 'active' WHERE id = ?`, [ids.vaultId]);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
      if (tmpThere) rmDbFiles(tmp);
    } else {
      throw new OwnerMigrationError('SYSTEM_DB_MISSING', 'قاعدة النظام المؤقتة غير موجودة قبل التثبيت؛ أعد خطوة إنشائها (استئناف).', true);
    }
    mkdirSync(config.spacesDir, { recursive: true, mode: 0o700 });
    const marker = join(config.dataDir, MARKER_FILE);
    if (!existsSync(marker)) {
      writeFileSync(marker, `multi-user layout created by the owner migration ${new Date().toISOString()} (user #1 ${ids.userId}, vault ${ids.vaultId})\n`, { mode: 0o600 });
      fsyncPath(config.dataDir);
      await at('commit:marker');
    }
    return {};
  },

  // 11 (before the first boot). The vault is the owner's database, byte for byte, with the same rows
  async verify({ config, lines }) {
    const ids = idsOf(lines)!;
    const ref = referenceOf(lines)!;
    const vaultPath = join(config.vaultsDir, ids.dbFile);
    const h1 = await sha256File(vaultPath);
    if (h1.sha256 !== ref.sha256) throw new OwnerMigrationError('VAULT_CHECKSUM', 'بصمة الخزنة قبل أول تشغيل لا تطابق البصمة المرجعية. لا يُشغَّل التطبيق؛ تراجع أو استعد النسخة.', false);
    const db = openDb(vaultPath);
    let counts: Record<string, number>;
    try {
      counts = rowCounts(db);
    } finally {
      db.close();
    }
    dropEmptyWal(vaultPath, 'الخزنة');
    const diff = Object.keys({ ...counts, ...ref.row_counts }).filter((k) => counts[k] !== ref.row_counts[k]);
    if (diff.length) throw new OwnerMigrationError('ROW_COUNTS', `عدد الصفوف تغيّر في: ${diff.join('، ')}. لا يُشغَّل التطبيق.`, false);
    const h2 = await sha256File(vaultPath);
    if (h2.sha256 !== ref.sha256) throw new OwnerMigrationError('VAULT_CHECKSUM', 'تغيّرت بصمة الخزنة أثناء عدّ الصفوف.', false);
    return { pre_boot_sha256: h1.sha256, tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0) };
  },
};

// ─── after the first boot ────────────────────────────────────────────────────────────────────

/**
 * The first boot after the migration opened the vault through the unchanged runner (no base migration, so no schema
 * change) and ran the per-database open hooks. Record the checksum and the per-table row counts again (ADR-0003 §5
 * step 11). Called by the server once, after it is ready; idempotent.
 */
export async function recordFirstBoot(o: { dataDir: string; vaultPath: (vaultId: string) => string | null; checkpoint: (vaultId: string) => Record<string, number>; now?: () => number }): Promise<JournalLine | null> {
  const lines = readJournal(o.dataDir);
  if (journalState(lines) !== 'complete' || isStepDone(lines, 'first_boot')) return null;
  const ids = idsOf(lines);
  const ref = referenceOf(lines);
  if (!ids || !ref) return null;
  const path = o.vaultPath(ids.vaultId);
  if (!path) return null;
  const counts = o.checkpoint(ids.vaultId);
  const h = await sha256File(path);
  const changed = Object.keys({ ...counts, ...ref.row_counts }).filter((k) => counts[k] !== ref.row_counts[k]);
  return appendJournal(o.dataDir, { step: 'first_boot', status: 'done', at: (o.now ?? Date.now)(), sha256: h.sha256, size: h.size, row_counts: counts, tables_changed_by_first_boot: changed });
}

// ─── rollback ────────────────────────────────────────────────────────────────────────────────

export interface RollbackOutcome {
  /** where system.sqlite, the marker and the journal were set aside */
  setAside: string;
  /** the vault file was moved back to medlevo.sqlite (false: the migration had not moved it yet) */
  movedBack: boolean;
  passwordCopiedBack: boolean;
}

/**
 * Undo the owner migration — at any point of it, and resumable. Refused when other accounts exist (their data cannot go
 * back into a single-owner layout) and when a base migration was applied to the vault since (then the step-0 backup is
 * the way back: ADR-0003 §5 step 12).
 */
export async function rollbackOwnerMigration(o: { config: AppConfig; now?: () => number; hooks?: MigrationHooks }): Promise<RollbackOutcome> {
  const release = acquire('rollback');
  try {
    return await rollbackLocked(o);
  } finally {
    release();
  }
}

async function rollbackLocked(o: { config: AppConfig; now?: () => number; hooks?: MigrationHooks }): Promise<RollbackOutcome> {
  const { config } = o;
  const now = o.now ?? Date.now;
  const at = async (p: string) => {
    await o.hooks?.at?.(p);
  };
  const lines = readJournal(config.dataDir);
  if (lines.length === 0) throw new OwnerMigrationError('NO_JOURNAL', 'لا يوجد سجل ترقية في مجلد البيانات: لا شيء للتراجع عنه.', false);
  assertNoOtherServer(config.dataDir);
  const ids = idsOf(lines);
  const ref = referenceOf(lines);
  const started = lastOf(lines, 'rollback', 'started');
  const aside = typeof started?.set_aside === 'string' ? started.set_aside : join(config.dataDir, `${ROLLED_BACK_PREFIX}${stamp(now())}`);
  const vaultPath = ids ? join(config.vaultsDir, ids.dbFile) : null;

  // refusals (checked before anything moves)
  if (!started) {
    if (existsSync(config.systemDbPath)) {
      const sys = openDb(config.systemDbPath);
      try {
        const others = sys.get<{ n: number }>(`SELECT COUNT(*) AS n FROM vault WHERE user_id <> ? AND status <> 'deleted'`, [ids?.userId ?? ''])!.n;
        const spaces = sys.get<{ n: number }>('SELECT COUNT(*) AS n FROM space')!.n;
        if (others > 0 || spaces > 0) {
          throw new OwnerMigrationError('OTHER_ACCOUNTS', 'توجد حسابات أو مواد أخرى بعد الترقية: لا يمكن إعادتها إلى نظام المالك الواحد. استعد النسخة الاحتياطية بدلًا من ذلك.', false);
        }
      } finally {
        sys.close();
      }
    }
    if (vaultPath && existsSync(vaultPath) && ref) {
      const db = openDb(vaultPath);
      try {
        const names = db.all<{ name: string }>('SELECT name FROM schema_migration ORDER BY name').map((r) => r.name);
        const added = names.filter((n) => !ref.migrations.includes(n));
        if (added.length) {
          throw new OwnerMigrationError(
            'BASE_MIGRATION_SINCE',
            `طُبّقت ترحيلات أساسية على خزنتك بعد الترقية (${added.join('، ')}): الإصدار السابق لن يقرأها. طريق العودة الآن هو استعادة النسخة الاحتياطية المأخوذة قبل الترقية (مجلد migration أو R2).`,
            false,
          );
        }
      } finally {
        db.close();
      }
    }
    if (isLegacyDb(config.dbPath) && vaultPath && existsSync(vaultPath)) {
      throw new OwnerMigrationError('BOTH_PRESENT', 'يوجد medlevo.sqlite وملف الخزنة معًا: لن يُكتب أحدهما فوق الآخر. افحص المجلد.', false);
    }
    lines.push(appendJournal(config.dataDir, { step: 'rollback', status: 'started', at: now(), set_aside: aside }));
    await at('rollback:started');
  }

  mkdirSync(aside, { recursive: true, mode: 0o700 });
  // 1. the marker first: from here the directory is never «multi-user» again until a new migration
  const marker = join(config.dataDir, MARKER_FILE);
  if (existsSync(marker)) {
    renameSync(marker, join(aside, MARKER_FILE));
    fsyncPath(config.dataDir);
  }
  await at('rollback:marker');

  // 2. a password changed under the new build is copied back into the owner row (so the same password keeps working)
  let passwordCopiedBack = false;
  let movedBack = false;
  if (vaultPath && existsSync(vaultPath)) {
    let current: { password_hash: string; recovery_codes_json: string; password_changed_at: number; updated_at: number } | undefined;
    // (review) the sessions still valid under the new build: every other session of the vault is revoked on the way
    // back — a device signed out after the upgrade (password change, «sign out this device») stays signed out
    let liveSessions: Map<string, number> | null = null;
    if (ids && existsSync(config.systemDbPath)) {
      const sys = openDb(config.systemDbPath);
      try {
        current = sys.get('SELECT password_hash, recovery_codes_json, password_changed_at, updated_at FROM user_account WHERE id = ?', [ids.userId]);
        liveSessions = new Map(
          sys
            .all<{ id: string; expires_at: number }>('SELECT id, expires_at FROM auth_session WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?', [ids.userId, now()])
            .map((r) => [r.id, r.expires_at]),
        );
      } finally {
        sys.close();
      }
    }
    const db = openDb(vaultPath);
    try {
      const owner = readOwner(db);
      db.tx(() => {
        if (current && owner && (owner.password_hash !== current.password_hash || owner.recovery_codes_json !== current.recovery_codes_json)) {
          db.run(`UPDATE owner SET password_hash = ?, recovery_codes_json = ?, password_changed_at = ?, updated_at = ? WHERE id = 'owner'`, [
            current.password_hash,
            current.recovery_codes_json,
            current.password_changed_at,
            current.updated_at,
          ]);
          passwordCopiedBack = true;
        }
        if (liveSessions && tableExists(db, 'auth_session')) {
          const t = now();
          for (const s of db.all<{ id: string; expires_at: number }>('SELECT id, expires_at FROM auth_session WHERE revoked_at IS NULL')) {
            const live = liveSessions.get(s.id);
            if (live === undefined) db.run('UPDATE auth_session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [t, s.id]);
            else if (live > s.expires_at) db.run('UPDATE auth_session SET expires_at = ? WHERE id = ?', [live, s.id]); // still signed in
          }
        }
      });
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    dropEmptyWal(vaultPath, 'الخزنة');
    // the tombstone in the database's old place is set aside (kept with the multi-user files)
    if (isLegacyTombstone(config.dbPath)) {
      renameSync(config.dbPath, join(aside, TOMBSTONE_ASIDE_NAME));
      fsyncPath(config.dataDir);
      await at('rollback:tombstone_aside');
    }
    // 3. the vault file goes back to its single-owner name
    renameSync(vaultPath, config.dbPath);
    fsyncPath(config.vaultsDir);
    fsyncPath(config.dataDir);
    movedBack = true;
    await at('rollback:moved_back');
  } else if (!isLegacyDb(config.dbPath)) {
    throw new OwnerMigrationError('NEITHER_PRESENT', 'لم يُعثر على قاعدة بياناتك لا في الخزنة ولا في مكانها القديم. لم يُحذف شيء؛ استعد النسخة الاحتياطية من مجلد migration.', false);
  }

  // 4. the system DB (and a temp one) set aside — never deleted
  for (const p of [config.systemDbPath, systemTmpPath(config)]) {
    for (const s of ['', '-wal', '-shm']) {
      if (existsSync(`${p}${s}`)) renameSync(`${p}${s}`, join(aside, `${p.split('/').pop()}${s}`));
    }
  }
  fsyncPath(config.dataDir);
  await at('rollback:system_aside');

  // 5. the journal last (with its final line): the directory is the single-owner one again
  appendJournal(config.dataDir, { step: 'rolled_back', status: 'done', at: now(), moved_back: movedBack, password_copied_back: passwordCopiedBack });
  renameSync(journalPath(config.dataDir), join(aside, JOURNAL_FILE));
  fsyncPath(config.dataDir);
  return { setAside: aside, movedBack, passwordCopiedBack };
}

/** Short status of a data directory for the CLI and the maintenance page. */
export function migrationStatus(config: AppConfig): {
  state: DataDirState['kind'];
  journal: JournalState;
  lines: JournalLine[];
  last_failure: { code: string; reason_ar: string; retryable: boolean } | null;
  last_abort: ReturnType<typeof lastAbort>;
} {
  const lines = readJournal(config.dataDir);
  const failed = [...lines].reverse().find((l) => l.status === 'failed');
  const doneAfter = failed ? lines.slice(lines.indexOf(failed) + 1).some((l) => l.status === 'done') : false;
  return {
    state: detectDataDir(dataDirPaths(config)).kind,
    journal: journalState(lines),
    lines,
    last_failure: failed && !doneAfter ? { code: String(failed.code ?? ''), reason_ar: String(failed.reason_ar ?? ''), retryable: failed.retryable === true } : null,
    last_abort: lastAbort(config.dataDir),
  };
}

