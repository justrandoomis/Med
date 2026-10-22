// Restore verification and restore (§49, AC-30): "a backup that was never restored is not a guarantee".
//
// verifyBackup(archive): extracts into a SEPARATE temporary directory (never the live data), then checks
//   archive safety + manifest, the database file hash, every file hash and size, the file store against
//   stored_file, PRAGMA integrity_check + foreign_key_check, migrations against this build, row counts against the
//   manifest, the FTS indexes, relational samples (sources → versions → pages, annotations → targets,
//   questions → occurrences, links, sessions, review events → cards) and finally BOOTS the app on the restored
//   directory (health + counts). Returns a report; the temp directory is removed unless `keep`.
// applyRestore(archive, target): only into an explicit target directory that does not exist or is EMPTY (never
//   overwrites data). Verifies first (same checks), then starts a new server data epoch (clients reset their sync
//   cursor), revokes every session (a revoked device in the old snapshot must not come back), and moves the
//   verified directory into place.
// GATE-1: a multi-user archive also holds every subject space (spaces/<id>.sqlite) and its files; verification checks
//   each space like a vault (base + space migrations) and refuses an archive whose space registry names a space it does
//   not hold. Spaces keep their content as archived (no sync epoch: clients never pull from a space).
// P1-T1: a multi-user archive (system DB + every vault) restores to a complete multi-user data directory (marker
//   written, every vault gets its own new epoch, every account's sessions revoked). A single-owner archive restores
//   to medlevo.sqlite as before; its boot check runs on a sandbox copy (this build serves it after the owner migration).
// P1-T1 step 2: an ENCRYPTED archive («MLVENC01», .mlenc) is accepted when MEDLEVO_BACKUP_ENCRYPTION_KEY is given: it is
//   decrypted (every frame authenticated) into the verification's own work directory first. A per-vault archive
//   (layout 'vault') is verified like a single-owner one (sandbox boot) and restored only into its account by the
//   platform's vault restore (./vault-restore.ts), never as a whole data directory. The boot check runs a blob mark pass
//   on the restored directory, which rebuilds the registry hints from the restored vaults.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { BACKUP_FORMAT, type BackupManifest, type RestoreCheck, type RestoreReport } from '@medlevo/shared';
import { openDb, toJson, type Db } from '../../db/db';
import { MIGRATIONS_DIR, readMigrations, SPACE_MIGRATIONS_DIR, SYSTEM_MIGRATIONS_DIR } from '../../db/migrate';
import { MARKER_FILE } from '../../system/layout';
import { newId } from '../../lib/ids';
import { BACKUP_DB_PATH, BACKUP_MANIFEST_PATH, BACKUP_ROOT, BACKUP_SYSTEM_PATH, rowCounts } from './backup';
import { copyFileSync, writeFileSync } from 'node:fs';
import { startRestoreEpoch } from './epoch';
import { ArchiveError, extractTarGz, type ExtractedEntry, type TarExtractLimits } from './tar';
import { DecryptError } from '../../lib/objectstore/encryption';
import { decryptArchive, isEncryptedArchive } from './archive-crypto';

const GiB = 1024 * 1024 * 1024;
export const DEFAULT_RESTORE_LIMITS: TarExtractLimits = {
  maxEntries: 1_000_000,
  maxTotalBytes: 64 * GiB,
  maxEntryBytes: 64 * GiB,
  maxRatio: 100,
  ratioMinBytes: 8 * 1024 * 1024,
};

const migrationList = z.array(z.object({ name: z.string().max(200), checksum: z.string().max(128) })).max(10_000);
const rowCountsSchema = z.record(z.string().max(200), z.number().int().nonnegative());
const sha = z.string().regex(/^[0-9a-f]{64}$/);
/** the single-owner database, or a vault of a multi-user archive (P1-T1) */
const DB_PATH_RE = /^medlevo-backup\/(medlevo\.sqlite|vaults\/[A-Za-z0-9_-]{1,80}\.sqlite)$/;
/** a subject space of a multi-user archive (GATE-1) */
const SPACE_PATH_RE = /^medlevo-backup\/spaces\/[A-Za-z0-9_-]{1,80}\.sqlite$/;

const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  backup_id: z.string().min(1).max(64),
  app_version: z.string().max(64),
  created_at: z.number().int().nonnegative(),
  root: z.literal(BACKUP_ROOT),
  db: z.object({
    path: z.string().regex(DB_PATH_RE),
    sha256: sha,
    size: z.number().int().nonnegative(),
    migrations: migrationList,
    row_counts: rowCountsSchema,
    sync_head_seq: z.number().int().nonnegative(),
    server_epoch: z.string().max(64).nullable(),
  }),
  // P1-T1: a whole multi-user instance (system DB + every vault); step 2: ONE account's vault
  layout: z.enum(['multi_user', 'vault']).optional(),
  account: z.object({ user_id: z.string().max(64), username: z.string().max(200), display_name: z.string().max(200) }).optional(),
  system: z
    .object({ path: z.literal(BACKUP_SYSTEM_PATH), sha256: sha, size: z.number().int().nonnegative(), migrations: migrationList, row_counts: rowCountsSchema })
    .optional(),
  vaults: z
    .array(
      z.object({
        vault_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        user_id: z.string().max(64),
        db_file: z.string().regex(/^[A-Za-z0-9_-]{1,80}\.sqlite$/),
        path: z.string().regex(DB_PATH_RE),
        primary: z.boolean(),
        sha256: sha,
        size: z.number().int().nonnegative(),
        migrations: migrationList,
        row_counts: rowCountsSchema,
        sync_head_seq: z.number().int().nonnegative(),
        server_epoch: z.string().max(64).nullable(),
      }),
    )
    .max(1_000_000)
    .optional(),
  // GATE-1: every subject space of a multi-user archive (absent in archives made before R1-c)
  spaces: z
    .array(
      z.object({
        space_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        db_file: z.string().regex(/^[A-Za-z0-9_-]{1,80}\.sqlite$/),
        path: z.string().regex(SPACE_PATH_RE),
        sha256: sha,
        size: z.number().int().nonnegative(),
        migrations: migrationList,
        row_counts: rowCountsSchema,
      }),
    )
    .max(1_000_000)
    .optional(),
  files: z
    .array(
      z.object({
        path: z.string().max(400),
        file_id: z.string().max(64),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().nonnegative(),
      }),
    )
    .max(5_000_000),
  files_missing: z.array(z.object({ file_id: z.string().max(64), sha256: z.string().max(64), reason: z.string().max(64) })).max(5_000_000),
  excluded: z.array(z.string().max(400)).max(100),
});

export interface VerifyOptions {
  /** parent directory of the temporary verification directory (default: the OS temp dir) */
  workDir?: string;
  /** keep the extracted directory (applyRestore moves it into place) */
  keep?: boolean;
  /** boot the app on the restored directory (default true) */
  bootCheck?: boolean;
  limits?: Partial<TarExtractLimits>;
  now?: () => number;
  /**
   * Accept files that were ALREADY missing or damaged when the backup was made (manifest `files_missing`), so the
   * owner's writing and everything else can still be restored. Explicit only (CLI `--accept-missing-files`); the
   * report names every file restored without its blob. A file missing for any other reason still fails.
   */
  acceptMissingFiles?: boolean;
  /** P1-T1 step 2: the key that opens an encrypted («MLVENC01») archive; without it an encrypted archive fails verification */
  decryptionKey?: Buffer | null;
}

export interface VerifyResult {
  report: RestoreReport;
  manifest: BackupManifest | null;
  /** the restored DATA_DIR (only while kept) */
  dataDir: string | null;
  /** the temporary directory holding it (only while kept) */
  workDir: string | null;
}

const n = (db: Db, sql: string, params: unknown[] = []) => db.get<{ n: number }>(sql, params)?.n ?? 0;

function add(checks: RestoreCheck[], name: string, ok: boolean, detail_ar: string, details?: unknown): boolean {
  const c: RestoreCheck = { name, ok, detail_ar };
  if (details !== undefined) c.details = details;
  checks.push(c);
  return ok;
}

/** Semantic relational checks beyond foreign keys (what AC-30 asks to be inspectable). */
function relationalChecks(db: Db, checks: RestoreCheck[]): void {
  // sources → versions → pages
  const badCurrent = n(db, `SELECT COUNT(*) AS n FROM source s WHERE s.current_version_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM source_version v WHERE v.id = s.current_version_id AND v.source_id = s.id)`);
  const badFrozen = n(db, `SELECT COUNT(*) AS n FROM source s WHERE s.frozen_version_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM source_version v WHERE v.id = s.frozen_version_id AND v.source_id = s.id)`);
  const pagelessReady = n(db, `SELECT COUNT(*) AS n FROM source_version v WHERE v.processing_status IN ('ready','needs_review','partial')
      AND v.format IN ('pdf','image','image_set','docx','pptx') AND NOT EXISTS (SELECT 1 FROM source_page p WHERE p.version_id = v.id)`);
  const regionPageMismatch = n(db, `SELECT COUNT(*) AS n FROM source_region r JOIN source_page p ON p.id = r.page_id WHERE p.version_id <> r.version_id`);
  const sources = n(db, 'SELECT COUNT(*) AS n FROM source');
  const versions = n(db, 'SELECT COUNT(*) AS n FROM source_version');
  const pages = n(db, 'SELECT COUNT(*) AS n FROM source_page');
  add(
    checks,
    'sources_versions_pages',
    badCurrent + badFrozen + pagelessReady + regionPageMismatch === 0,
    badCurrent + badFrozen + pagelessReady + regionPageMismatch === 0
      ? `${sources} مصدر، ${versions} إصدار، ${pages} صفحة: كل إصدار حالي/مثبّت يخص مصدره، وكل إصدار معالَج له صفحات، وكل منطقة في صفحة من إصدارها.`
      : `مشكلات ترابط: إصدار حالي لا يخص مصدره ${badCurrent}، إصدار مثبّت لا يخص مصدره ${badFrozen}، إصدار معالَج بلا صفحات ${pagelessReady}، منطقة في صفحة من إصدار آخر ${regionPageMismatch}.`,
    { sources, versions, pages, badCurrent, badFrozen, pagelessReady, regionPageMismatch },
  );

  // annotations → targets (an annotation kept for re-anchoring may point at a page that no longer exists, by design)
  const annotations = n(db, 'SELECT COUNT(*) AS n FROM annotation');
  const noTarget = n(db, 'SELECT COUNT(*) AS n FROM annotation a WHERE NOT EXISTS (SELECT 1 FROM annotation_target t WHERE t.annotation_id = a.id)');
  const danglingPage = n(db, `SELECT COUNT(*) AS n FROM annotation_target t JOIN annotation a ON a.id = t.annotation_id
      WHERE a.anchor_status <> 'needs_reanchor' AND t.target_type = 'source_page' AND NOT EXISTS (SELECT 1 FROM source_page p WHERE p.id = t.target_id)`);
  const danglingNotePage = n(db, `SELECT COUNT(*) AS n FROM annotation_target t JOIN annotation a ON a.id = t.annotation_id
      WHERE a.anchor_status <> 'needs_reanchor' AND t.target_type = 'note_page' AND NOT EXISTS (SELECT 1 FROM note_page p WHERE p.id = t.target_id)`);
  const notes = n(db, 'SELECT COUNT(*) AS n FROM note');
  add(
    checks,
    'annotations_targets',
    noTarget + danglingPage + danglingNotePage === 0,
    noTarget + danglingPage + danglingNotePage === 0
      ? `${annotations} عنصر حبر/تمييز و${notes} ملاحظة: كل عنصر له هدف موجود (صفحة مصدر أو صفحة ملاحظات).`
      : `عناصر بلا هدف ${noTarget}، تشير إلى صفحة مصدر غير موجودة ${danglingPage}، إلى صفحة ملاحظات غير موجودة ${danglingNotePage}.`,
    { annotations, notes, noTarget, danglingPage, danglingNotePage },
  );

  // questions → occurrences / versions
  const questions = n(db, 'SELECT COUNT(*) AS n FROM question');
  const sourceQuestionsNoOcc = n(db, `SELECT COUNT(*) AS n FROM question q WHERE q.origin_type = 'source'
      AND NOT EXISTS (SELECT 1 FROM question_occurrence o WHERE o.question_id = q.id)`);
  const badCurrentQv = n(db, `SELECT COUNT(*) AS n FROM question q WHERE q.current_version_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM question_version v WHERE v.id = q.current_version_id AND v.question_id = q.id)`);
  const occWrongQuestion = n(db, `SELECT COUNT(*) AS n FROM question_occurrence o JOIN question_version v ON v.id = o.question_version_id WHERE v.question_id <> o.question_id`);
  const occWrongSource = n(db, `SELECT COUNT(*) AS n FROM question_occurrence o JOIN source_version v ON v.id = o.source_version_id WHERE v.source_id <> o.source_id`);
  const attempts = n(db, 'SELECT COUNT(*) AS n FROM question_attempt');
  const attemptWrongVersion = n(db, `SELECT COUNT(*) AS n FROM question_attempt a JOIN question_version v ON v.id = a.question_version_id WHERE v.question_id <> a.question_id`);
  const qBad = sourceQuestionsNoOcc + badCurrentQv + occWrongQuestion + occWrongSource + attemptWrongVersion;
  add(
    checks,
    'questions_occurrences',
    qBad === 0,
    qBad === 0
      ? `${questions} سؤال و${attempts} محاولة: كل سؤال من مصدر له موضع في مصدره، والإصدار الحالي يخص سؤاله، وكل محاولة على إصدار من سؤالها.`
      : `سؤال من مصدر بلا موضع ${sourceQuestionsNoOcc}، إصدار حالي لا يخص سؤاله ${badCurrentQv}، موضع لإصدار سؤال آخر ${occWrongQuestion}، موضع في إصدار مصدر آخر ${occWrongSource}، محاولة على إصدار سؤال آخر ${attemptWrongVersion}.`,
    { questions, attempts, sourceQuestionsNoOcc, badCurrentQv, occWrongQuestion, occWrongSource, attemptWrongVersion },
  );

  // links: lecture links, source links, evidence → region/version
  const qLinks = n(db, 'SELECT COUNT(*) AS n FROM question_lecture_link');
  const sLinks = n(db, 'SELECT COUNT(*) AS n FROM source_link');
  const evidence = n(db, 'SELECT COUNT(*) AS n FROM evidence');
  const evidenceMismatch = n(db, `SELECT COUNT(*) AS n FROM evidence e JOIN source_region r ON r.id = e.region_id WHERE r.version_id <> e.version_id`);
  const evidenceSourceMismatch = n(db, `SELECT COUNT(*) AS n FROM evidence e JOIN source_version v ON v.id = e.version_id WHERE v.source_id <> e.source_id`);
  const citations = n(db, 'SELECT COUNT(*) AS n FROM citation');
  add(
    checks,
    'links',
    evidenceMismatch + evidenceSourceMismatch === 0,
    evidenceMismatch + evidenceSourceMismatch === 0
      ? `${qLinks} ربط سؤال بمحاضرة، ${sLinks} ربط بين مصادر، ${evidence} دليل و${citations} استشهاد: كل دليل يشير إلى منطقة وإصدار ومصدر متطابقة.`
      : `أدلة تشير إلى منطقة من إصدار آخر ${evidenceMismatch}، أو إلى إصدار من مصدر آخر ${evidenceSourceMismatch}.`,
    { qLinks, sLinks, evidence, citations, evidenceMismatch, evidenceSourceMismatch },
  );

  // sessions
  const sessions = n(db, 'SELECT COUNT(*) AS n FROM study_session');
  const sessionWrongVersion = n(db, `SELECT COUNT(*) AS n FROM study_session s JOIN source_version v ON v.id = s.version_id WHERE s.source_id IS NOT NULL AND v.source_id <> s.source_id`);
  add(
    checks,
    'sessions',
    sessionWrongVersion === 0,
    sessionWrongVersion === 0 ? `${sessions} جلسة دراسة: كل جلسة على إصدار من مصدرها.` : `${sessionWrongVersion} جلسة على إصدار من مصدر آخر.`,
    { sessions, sessionWrongVersion },
  );

  // learning: review events and derived states belong to existing cards
  const cards = n(db, 'SELECT COUNT(*) AS n FROM flashcard');
  const events = n(db, 'SELECT COUNT(*) AS n FROM review_event');
  const orphanEvents = n(db, 'SELECT COUNT(*) AS n FROM review_event e WHERE NOT EXISTS (SELECT 1 FROM flashcard c WHERE c.id = e.card_id)');
  add(
    checks,
    'learning',
    orphanEvents === 0,
    orphanEvents === 0 ? `${cards} بطاقة و${events} حدث مراجعة: كل حدث يخص بطاقة موجودة.` : `${orphanEvents} حدث مراجعة لبطاقة غير موجودة.`,
    { cards, events, orphanEvents },
  );
}

type BootResult = { ok: boolean; detail: string; details: unknown };

/** Boot the real app on a multi-user data directory (P1-T1): health, the primary vault's counts, auth required. */
async function bootOn(dataDir: string, primaryVaultId: string, expected: Record<string, number>, scope: 'restored' | 'sandbox'): Promise<BootResult> {
  // dynamic imports: app.ts imports the module registry, which imports this module
  const { buildApp } = await import('../../app');
  const { loadConfig } = await import('../../config');
  const config = loadConfig({
    NODE_ENV: 'development',
    MEDLEVO_DATA_DIR: dataDir,
    MEDLEVO_LOG_LEVEL: 'silent',
    MEDLEVO_HOST: '127.0.0.1',
    MEDLEVO_ORIGIN: 'http://127.0.0.1:1',
    MEDLEVO_SCRYPT_LOG_N: '12',
  });
  const app = await buildApp({ config, overrides: { aiProvider: null } });
  try {
    await app.ready();
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    const vault = { kind: 'vault' as const, vaultId: primaryVaultId, viewer: null };
    const { sources, annotations } = app.ctx.binding.run(vault, () => ({
      sources: app.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source')!.n,
      annotations: app.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation')!.n,
    }));
    const unauth = await app.inject({ method: 'GET', url: '/api/library/tree' });
    // P1-T1 step 2: a blob mark pass on the restored directory rebuilds the registry hints from the restored vaults
    const mark = await app.ctx.gc.run('mark');
    const ok =
      health.statusCode === 200 &&
      (health.json() as { ok: boolean }).ok &&
      sources === (expected.source ?? 0) &&
      annotations === (expected.annotation ?? 0) &&
      unauth.statusCode === 401 &&
      mark.status === 'completed';
    const where = scope === 'restored' ? 'على البيانات المستعادة' : 'على نسخة تجريبية من البيانات المستعادة (قاعدة المالك الواحد تُفتح بعد ترحيلها إلى حساب)';
    return {
      ok,
      detail: ok
        ? `شُغّل الخادم ${where}: /api/health سليم، ${sources} مصدر و${annotations} عنصر كتابة، والمسارات المحمية تطلب تسجيل الدخول.`
        : `فشل تشغيل الخادم ${where} كما يجب (health ${health.statusCode}، مصادر ${sources}/${expected.source ?? 0}، كتابات ${annotations}/${expected.annotation ?? 0}).`,
      details: { health: health.statusCode, sources, annotations, protected_status: unauth.statusCode, scope, blob_mark: { status: mark.status, databases: mark.databases_marked, blobs: mark.blobs_marked } },
    };
  } finally {
    await app.close();
  }
}

/** A multi-user archive extracts to a complete data directory: mark it and boot on it. */
async function bootCheckMultiUser(dataDir: string, primaryVaultId: string, expected: Record<string, number>): Promise<BootResult> {
  const marker = join(dataDir, MARKER_FILE);
  if (!existsSync(marker)) writeFileSync(marker, 'restored multi-user layout\n', { mode: 0o600 });
  return bootOn(dataDir, primaryVaultId, expected, 'restored');
}

/**
 * A single-owner archive (R1-a and earlier) restores to `medlevo.sqlite`, which this build serves only after the
 * owner migration (P1-T1 step 3). The boot check therefore runs on a SANDBOX: a fresh multi-user directory whose one
 * vault is a COPY of the restored database — the restored file itself is never touched or migrated.
 */
async function bootCheckSingleOwner(work: string, restoredDb: string, expected: Record<string, number>): Promise<BootResult> {
  const sandbox = join(work, 'boot-sandbox');
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(join(sandbox, 'vaults'), { recursive: true });
  try {
    const { prepareDataDir } = await import('../../system/layout');
    prepareDataDir(
      { dataDir: sandbox, legacyDbPath: join(sandbox, 'medlevo.sqlite'), systemDbPath: join(sandbox, 'system.sqlite'), vaultsDir: join(sandbox, 'vaults'), spacesDir: join(sandbox, 'spaces') },
      Date.now,
    );
    const vaultId = `restorecheck${newId(Date.now()).toLowerCase()}`;
    copyFileSync(restoredDb, join(sandbox, 'vaults', `${vaultId}.sqlite`));
    const sys = openDb(join(sandbox, 'system.sqlite'));
    try {
      const t = Date.now();
      sys.run(
        `INSERT INTO user_account (id, username, username_norm, display_name, password_hash, password_changed_at, is_platform_admin, created_at, updated_at)
         VALUES ('restore-check', 'restore-check', 'restore-check', 'restore-check', 'scrypt$disabled', ?, 1, ?, ?)`,
        [t, t, t],
      );
      sys.run(`INSERT INTO vault (id, user_id, db_file, status, created_at) VALUES (?, 'restore-check', ?, 'active', ?)`, [vaultId, `${vaultId}.sqlite`, t]);
    } finally {
      sys.close();
    }
    return await bootOn(sandbox, vaultId, expected, 'sandbox');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function onDiskShas(dataDir: string): Set<string> {
  return new Set(listFilesUnder(join(dataDir, 'files')).map((p) => p.split('/').pop() ?? ''));
}

/**
 * Multi-user archives (P1-T1): the system DB (integrity, foreign keys, system migrations, row counts) and every
 * non-primary vault (the same checks with the base migrations, plus its referenced blobs), and the registry in the
 * system DB names exactly the archived vaults with the same owners.
 */
function instanceChecks(extractDir: string, manifest: BackupManifest, onDisk: Set<string>, acceptMissing: boolean, checks: RestoreCheck[]): void {
  const problems: string[] = [];
  const known = (dir: string, set: 'system' | 'base' | 'space') => new Map(readMigrations(dir, set).map((m) => [m.name, m.checksum]));
  const checkDb = (label: string, path: string, entry: { migrations: Array<{ name: string; checksum: string }>; row_counts: Record<string, number> }, build: Map<string, string>) => {
    let db: Db | null = null;
    try {
      db = openDb(join(extractDir, path));
      const integrity = db.all<{ integrity_check: string }>('PRAGMA integrity_check');
      if (!(integrity.length === 1 && integrity[0]!.integrity_check === 'ok')) problems.push(`${label}: PRAGMA integrity_check`);
      if (db.all('PRAGMA foreign_key_check').length) problems.push(`${label}: foreign_key_check`);
      const applied = db.all<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migration ORDER BY name');
      if (JSON.stringify(applied) !== JSON.stringify(entry.migrations)) problems.push(`${label}: migrations ≠ manifest`);
      if (applied.some((m) => build.get(m.name) !== m.checksum)) problems.push(`${label}: migration unknown to this build or changed`);
      const counts = rowCounts(db);
      if (Object.entries(entry.row_counts).some(([t, c]) => counts[t] !== c)) problems.push(`${label}: row counts ≠ manifest`);
      return db;
    } catch (e) {
      problems.push(`${label}: ${(e as Error).message.slice(0, 120)}`);
      db?.close();
      return null;
    }
  };
  const sys = checkDb('system', manifest.system!.path, manifest.system!, known(SYSTEM_MIGRATIONS_DIR, 'system'));
  if (sys) {
    try {
      const registry = sys.all<{ id: string; user_id: string; db_file: string }>(`SELECT id, user_id, db_file FROM vault WHERE status IN ('active','locked') ORDER BY id`);
      const archived = [...manifest.vaults!].sort((a, b) => (a.vault_id < b.vault_id ? -1 : 1));
      const same =
        registry.length === archived.length && registry.every((r, i) => r.id === archived[i]!.vault_id && r.user_id === archived[i]!.user_id && r.db_file === archived[i]!.db_file);
      if (!same) problems.push('system: the vault registry does not name exactly the archived vaults');
      // GATE-1: the space registry names exactly the archived spaces (an archive that left a subject out is refused)
      const spaceRegistry = sys.all<{ id: string; db_file: string }>('SELECT id, db_file FROM space ORDER BY id');
      const archivedSpaces = [...(manifest.spaces ?? [])].sort((a, b) => (a.space_id < b.space_id ? -1 : 1));
      const sameSpaces =
        spaceRegistry.length === archivedSpaces.length && spaceRegistry.every((r, i) => r.id === archivedSpaces[i]!.space_id && r.db_file === archivedSpaces[i]!.db_file);
      if (!sameSpaces) problems.push(`system: the space registry does not name exactly the archived spaces (registry ${spaceRegistry.length}, archive ${archivedSpaces.length})`);
    } finally {
      sys.close();
    }
  }
  const missingAtBackup = new Set(manifest.files_missing.map((m) => m.sha256));
  for (const v of manifest.vaults!.filter((x) => !x.primary)) {
    const db = checkDb(`vault ${v.vault_id}`, v.path, v, known(MIGRATIONS_DIR, 'base'));
    if (!db) continue;
    try {
      const absent = db.all<{ sha256: string }>('SELECT sha256 FROM stored_file').filter((f) => !onDisk.has(f.sha256) && !(acceptMissing && missingAtBackup.has(f.sha256)));
      if (absent.length) problems.push(`vault ${v.vault_id}: ${absent.length} referenced file(s) not in the archive`);
    } finally {
      db.close();
    }
  }
  // GATE-1: every subject space — integrity, foreign keys, base + space migrations of this build, row counts, files
  const spaceBuild = new Map([...known(MIGRATIONS_DIR, 'base'), ...known(SPACE_MIGRATIONS_DIR, 'space')]);
  for (const sp of manifest.spaces ?? []) {
    const db = checkDb(`space ${sp.space_id}`, sp.path, sp, spaceBuild);
    if (!db) continue;
    try {
      const absent = db.all<{ sha256: string }>('SELECT sha256 FROM stored_file').filter((f) => !onDisk.has(f.sha256) && !(acceptMissing && missingAtBackup.has(f.sha256)));
      if (absent.length) problems.push(`space ${sp.space_id}: ${absent.length} referenced file(s) not in the archive`);
    } finally {
      db.close();
    }
  }
  add(
    checks,
    'instance',
    problems.length === 0,
    problems.length === 0
      ? `قاعدة النظام و${manifest.vaults!.length} خزنة و${(manifest.spaces ?? []).length} مساحة مادة سليمة ومطابقة لهذا الإصدار، وسجل الخزائن والمساحات يطابق النسخة.`
      : `${problems.length} مشكلة في قاعدة النظام أو الخزائن الأخرى أو مساحات المواد.`,
    problems.length ? problems.slice(0, 30) : undefined,
  );
}

function listFilesUnder(dir: string, base = ''): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFilesUnder(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

export async function verifyBackup(archivePath: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const checks: RestoreCheck[] = [];
  const limits: TarExtractLimits = { ...DEFAULT_RESTORE_LIMITS, ...opts.limits };
  const parent = opts.workDir ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, '.medlevo-restore-'));
  const extractDir = join(work, 'extract');
  const dataDir = join(extractDir, BACKUP_ROOT);
  let manifest: BackupManifest | null = null;
  let keepIt = false;

  const finish = (): VerifyResult => {
    const ok = checks.length > 0 && checks.every((c) => c.ok);
    const report: RestoreReport = {
      ok,
      backup_id: manifest?.backup_id ?? null,
      backup_created_at: manifest?.created_at ?? null,
      app_version: manifest?.app_version ?? null,
      checks,
      started_at: started,
      finished_at: now(),
      work_dir: opts.keep && ok ? work : null,
      restored_to: null,
    };
    keepIt = !!opts.keep && ok;
    return { report, manifest, dataDir: keepIt ? dataDir : null, workDir: keepIt ? work : null };
  };

  try {
    // 0. an encrypted archive is decrypted into this work directory first (P1-T1 step 2)
    let plainArchive = archivePath;
    if (existsSync(archivePath) && statSync(archivePath).isFile() && isEncryptedArchive(archivePath)) {
      if (!opts.decryptionKey) {
        add(checks, 'decrypt', false, 'هذه النسخة مشفّرة (MLVENC01). اضبط MEDLEVO_BACKUP_ENCRYPTION_KEY بالمفتاح الذي شُفّرت به ثم أعد المحاولة.');
        return finish();
      }
      plainArchive = join(work, 'archive.tar.gz');
      try {
        await decryptArchive(archivePath, plainArchive, opts.decryptionKey);
        add(checks, 'decrypt', true, 'فُكّ تشفير النسخة وتُحقّق من سلامة كل أجزائها (MLVENC01، AES-256-GCM).');
      } catch (e) {
        add(checks, 'decrypt', false, e instanceof DecryptError ? e.reasonAr : 'تعذّر فك تشفير النسخة.');
        return finish();
      }
    }

    // 1. archive (safe extraction with limits)
    let entries: ExtractedEntry[];
    try {
      if (!existsSync(plainArchive) || !statSync(plainArchive).isFile()) {
        add(checks, 'archive', false, 'ملف النسخة الاحتياطية غير موجود.');
        return finish();
      }
      const r = await extractTarGz(plainArchive, extractDir, limits);
      if (plainArchive !== archivePath) rmSync(plainArchive, { force: true });
      entries = r.entries;
      add(checks, 'archive', true, `استُخرج الأرشيف بأمان في مجلد مؤقت منفصل: ${entries.length} عنصرًا.`, { entries: entries.length, inflated_bytes: r.inflatedBytes });
    } catch (e) {
      add(checks, 'archive', false, e instanceof ArchiveError ? e.reasonAr : 'تعذّرت قراءة الأرشيف.', e instanceof ArchiveError ? { code: e.code } : undefined);
      return finish();
    }
    const byPath = new Map(entries.map((e) => [e.path, e]));

    // 2. manifest
    const mEntry = byPath.get(BACKUP_MANIFEST_PATH);
    if (!mEntry || mEntry.size > 512 * 1024 * 1024) {
      add(checks, 'manifest', false, 'الأرشيف لا يحتوي manifest.json صالحًا.');
      return finish();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(mEntry.absPath, 'utf8')) as unknown;
    } catch {
      raw = null;
    }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) {
      add(checks, 'manifest', false, 'ملف manifest.json لا يطابق صيغة نسخ MedLevo الاحتياطية.');
      return finish();
    }
    manifest = parsed.data as BackupManifest;
    const multi = manifest.layout === 'multi_user';
    const vaultOnly = manifest.layout === 'vault';
    if (vaultOnly) {
      const vs = manifest.vaults ?? [];
      const ok = !manifest.system && !manifest.spaces?.length && vs.length === 1 && vs[0]!.primary && vs[0]!.path === manifest.db.path && vs[0]!.path === `${BACKUP_ROOT}/vaults/${vs[0]!.db_file}`;
      if (!ok) {
        add(checks, 'manifest', false, 'ملف manifest.json لنسخة خزنة واحدة غير متّسق.');
        return finish();
      }
    } else if (multi) {
      const vs = manifest.vaults ?? [];
      const primaries = vs.filter((v) => v.primary);
      const consistent =
        !!manifest.system &&
        vs.length > 0 &&
        primaries.length === 1 &&
        primaries[0]!.path === manifest.db.path &&
        vs.every((v) => v.path === `${BACKUP_ROOT}/vaults/${v.db_file}`) &&
        new Set(vs.map((v) => v.db_file)).size === vs.length &&
        (manifest.spaces ?? []).every((sp) => sp.path === `${BACKUP_ROOT}/spaces/${sp.db_file}`) &&
        new Set((manifest.spaces ?? []).map((sp) => sp.db_file)).size === (manifest.spaces ?? []).length;
      if (!consistent) {
        add(checks, 'manifest', false, 'ملف manifest.json لنسخة متعددة الحسابات غير متّسق (قاعدة النظام أو قائمة الخزائن).');
        return finish();
      }
    } else if (manifest.db.path !== BACKUP_DB_PATH || manifest.system || manifest.vaults || manifest.spaces) {
      add(checks, 'manifest', false, 'ملف manifest.json لا يطابق صيغة نسخ MedLevo الاحتياطية.');
      return finish();
    }
    add(
      checks,
      'manifest',
      true,
      `نسخة ${manifest.backup_id} من الإصدار ${manifest.app_version}، أُنشئت ${new Date(manifest.created_at).toISOString()}${multi ? `؛ تشمل قاعدة النظام و${manifest.vaults!.length} خزنة و${(manifest.spaces ?? []).length} مساحة مادة` : vaultOnly ? '؛ خزنة حساب واحد وملفاتها' : ''}.`,
    );
    const dbEntries = multi
      ? [
          { path: manifest.system!.path, sha256: manifest.system!.sha256, size: manifest.system!.size },
          ...manifest.vaults!.map((v) => ({ path: v.path, sha256: v.sha256, size: v.size })),
          ...(manifest.spaces ?? []).map((sp) => ({ path: sp.path, sha256: sp.sha256, size: sp.size })),
        ]
      : [{ path: manifest.db.path, sha256: manifest.db.sha256, size: manifest.db.size }];

    // 3. layout: every entry is expected
    const listed = new Set<string>([BACKUP_MANIFEST_PATH, ...dbEntries.map((d) => d.path), ...manifest.files.map((f) => f.path)]);
    const damagedShas = new Set(manifest.files_missing.filter((m) => m.reason === 'hash_mismatch').map((m) => m.sha256));
    const unexpected = entries.filter((e) => !listed.has(e.path) && !(e.path.startsWith(`${BACKUP_ROOT}/files/`) && damagedShas.has(e.path.split('/').pop() ?? '')));
    add(
      checks,
      'layout',
      unexpected.length === 0,
      unexpected.length === 0 ? 'كل عناصر الأرشيف مذكورة في manifest.json.' : `${unexpected.length} عنصر في الأرشيف غير مذكور في manifest.json.`,
      unexpected.length ? { unexpected: unexpected.slice(0, 20).map((e) => e.path) } : undefined,
    );

    // a blob that was already damaged when the backup was made is in the archive under its path but is NOT a valid
    // file: it never stays in the restored file store (the app would serve wrong bytes under a verified hash)
    const listedFiles = new Set(manifest.files.map((f) => f.path));
    for (const e of entries) {
      if (e.path.startsWith(`${BACKUP_ROOT}/files/`) && !listedFiles.has(e.path)) rmSync(e.absPath, { force: true });
    }

    // 4. database file hashes (the single-owner database, or the system DB and every vault)
    const absentDbs = dbEntries.filter((d) => !byPath.has(d.path));
    if (absentDbs.length) {
      add(checks, 'database_hash', false, 'ملف قاعدة البيانات غير موجود في الأرشيف.', { missing: absentDbs.map((d) => d.path).slice(0, 20) });
      return finish();
    }
    const badDbs = dbEntries.filter((d) => byPath.get(d.path)!.sha256 !== d.sha256 || byPath.get(d.path)!.size !== d.size);
    add(
      checks,
      'database_hash',
      badDbs.length === 0,
      badDbs.length === 0
        ? dbEntries.length > 1
          ? `بصمة sha256 مطابقة لكل قواعد البيانات (${dbEntries.length}).`
          : 'بصمة sha256 لقاعدة البيانات مطابقة.'
        : 'بصمة قاعدة البيانات لا تطابق manifest.json — الملف تالف أو مُعدَّل.',
      badDbs.length ? { bad: badDbs.map((d) => d.path).slice(0, 20) } : undefined,
    );

    // 5. file hashes
    const badFiles: string[] = [];
    for (const f of manifest.files) {
      const e = byPath.get(f.path);
      if (!e || e.sha256 !== f.sha256 || e.size !== f.size || !f.path.endsWith(`/${f.sha256}`)) badFiles.push(f.file_id);
    }
    add(
      checks,
      'file_hashes',
      badFiles.length === 0,
      badFiles.length === 0 ? `${manifest.files.length} ملفًا: الحجم وبصمة sha256 لكل ملف مطابقان.` : `${badFiles.length} ملف مفقود أو بصمته غير مطابقة.`,
      badFiles.length ? { file_ids: badFiles.slice(0, 50) } : undefined,
    );

    // 6. database checks
    let opened: Db | null = null;
    try {
      opened = openDb(join(extractDir, manifest.db.path));
      opened.get('SELECT COUNT(*) AS n FROM sqlite_master');
    } catch (e) {
      try {
        opened?.close();
      } catch {
        /* ignore */
      }
      add(checks, 'integrity_check', false, `تعذّر فتح قاعدة البيانات المستعادة (الملف ليس قاعدة SQLite سليمة): ${(e as Error).message.slice(0, 160)}`);
      return finish();
    }
    const db: Db = opened;
    let counts: Record<string, number> = {};
    try {
      const integrity = db.all<{ integrity_check: string }>('PRAGMA integrity_check');
      const intOk = integrity.length === 1 && integrity[0]!.integrity_check === 'ok';
      add(checks, 'integrity_check', intOk, intOk ? 'PRAGMA integrity_check: ok.' : 'PRAGMA integrity_check أبلغ عن تلف.', intOk ? undefined : integrity.slice(0, 20));

      const fk = db.all('PRAGMA foreign_key_check');
      add(checks, 'foreign_keys', fk.length === 0, fk.length === 0 ? 'لا توجد مراجع مفقودة (PRAGMA foreign_key_check).' : `${fk.length} مرجع مفقود بين الجداول.`, fk.length ? fk.slice(0, 20) : undefined);

      // migrations: the snapshot's list equals the manifest; all are known to this build with the same checksum
      const applied = db.all<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migration ORDER BY name');
      const build = new Map(readMigrations().map((m) => [m.name, m.checksum]));
      const sameAsManifest = JSON.stringify(applied) === JSON.stringify(manifest.db.migrations);
      const unknown = applied.filter((m) => !build.has(m.name));
      const changed = applied.filter((m) => build.has(m.name) && build.get(m.name) !== m.checksum);
      const pending = [...build.keys()].filter((name) => !applied.some((m) => m.name === name));
      add(
        checks,
        'migrations',
        sameAsManifest && unknown.length === 0 && changed.length === 0,
        !sameAsManifest
          ? 'قائمة migrations في قاعدة البيانات لا تطابق manifest.json.'
          : unknown.length
            ? `النسخة من إصدار أحدث من هذا الخادم (${unknown.length} migration غير معروفة) — حدّث الخادم قبل الاستعادة.`
            : changed.length
              ? `${changed.length} migration بمحتوى مختلف عن هذا الإصدار.`
              : pending.length
                ? `${applied.length} migration مطبّقة ومعروفة لهذا الإصدار؛ ستُطبَّق ${pending.length} migration أحدث عند تشغيل الخادم.`
                : `${applied.length} migration مطبّقة ومطابقة لهذا الإصدار.`,
        { applied: applied.length, pending, unknown: unknown.map((m) => m.name), changed: changed.map((m) => m.name) },
      );

      // row counts
      counts = rowCounts(db);
      const diffs = Object.entries(manifest.db.row_counts).filter(([t, c]) => counts[t] !== c).map(([t, c]) => ({ table: t, manifest: c, restored: counts[t] ?? null }));
      add(
        checks,
        'row_counts',
        diffs.length === 0,
        diffs.length === 0
          ? `عدد الصفوف مطابق في ${Object.keys(manifest.db.row_counts).length} جدولًا (${Object.values(manifest.db.row_counts).reduce((a, b) => a + b, 0)} صفًّا).`
          : `${diffs.length} جدول بعدد صفوف مختلف عن manifest.json.`,
        diffs.length ? diffs.slice(0, 30) : undefined,
      );

      // stored files ↔ archive
      // matched by content (sha256): in a multi-user archive one blob serves every vault that references it
      const stored = db.all<{ id: string; sha256: string }>('SELECT id, sha256 FROM stored_file');
      const listedShas = new Set(manifest.files.map((f) => f.sha256));
      const notRestorable = stored.filter((s) => !listedShas.has(s.sha256));
      const onDisk = new Set(listFilesUnder(join(dataDir, 'files')).map((p) => p.split('/').pop()));
      const absent = stored.filter((s) => listedShas.has(s.sha256) && !onDisk.has(s.sha256));
      const missingAtBackup = new Set(manifest.files_missing.map((m) => m.sha256));
      // files missing only because they were already missing/damaged at backup time (recorded in the manifest)
      const knownMissing = notRestorable.filter((s) => missingAtBackup.has(s.sha256));
      const unexplained = [...notRestorable.filter((s) => !missingAtBackup.has(s.sha256)), ...absent];
      const complete = notRestorable.length === 0 && absent.length === 0 && manifest.files_missing.length === 0;
      const accepted = !complete && !!opts.acceptMissingFiles && unexplained.length === 0;
      add(
        checks,
        'files_complete',
        complete || accepted,
        complete
          ? `كل ملف تشير إليه قاعدة البيانات (${stored.length}) موجود في النسخة.`
          : accepted
            ? `قُبلت الاستعادة دون ${knownMissing.length} ملف كان مفقودًا أو تالفًا عند إنشاء النسخة (--accept-missing-files): كتاباتك وبقية البيانات تُستعاد، وهذه الملفات وحدها لن تُفتح. البقية (${stored.length - knownMissing.length}) سليمة.`
            : `${notRestorable.length + absent.length} ملف تشير إليه قاعدة البيانات غير موجود سليمًا في النسخة${
                unexplained.length === 0
                  ? ' (كان مفقودًا أو تالفًا عند إنشاء النسخة). لاستعادة كتاباتك وبقية البيانات دون هذه الملفات وحدها، أعد الأمر مع --accept-missing-files'
                  : ''
              }.`,
        notRestorable.length || absent.length || manifest.files_missing.length
          ? { file_ids: [...notRestorable, ...absent].slice(0, 50).map((s) => s.id), at_backup_time: manifest.files_missing.slice(0, 50), accepted }
          : undefined,
      );

      // FTS indexes
      // chunk_fts is an external-content index of NORMALIZED text (ml_norm, migration 0200): its content cannot be
      // compared with document_chunk.text directly, so check structure, the rowid mapping, and real lookups.
      const ftsProblems: string[] = [];
      for (const table of ['chunk_fts', 'question_fts', 'owner_content_fts']) {
        try {
          db.run(`INSERT INTO ${table}(${table}, rank) VALUES ('integrity-check', 0)`);
        } catch (e) {
          ftsProblems.push(`${table}: ${(e as Error).message.slice(0, 120)}`);
        }
      }
      try {
        const orphanIndex = n(db, 'SELECT COUNT(*) AS n FROM chunk_fts_docsize d WHERE NOT EXISTS (SELECT 1 FROM document_chunk c WHERE c.rowid = d.id)');
        const unindexed = n(db, 'SELECT COUNT(*) AS n FROM document_chunk c WHERE NOT EXISTS (SELECT 1 FROM chunk_fts_docsize d WHERE d.id = c.rowid)');
        if (orphanIndex || unindexed) ftsProblems.push(`chunk_fts: ${orphanIndex} index rows without a chunk, ${unindexed} chunks not indexed`);
        const samples = db.all<{ rowid: number; text: string }>('SELECT rowid, text FROM document_chunk ORDER BY rowid LIMIT 400');
        let probed = 0;
        for (const s of samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / 5)) === 0).slice(0, 5)) {
          const word = (s.text.match(/[\p{L}\p{N}]{4,}/gu) ?? [])[0];
          if (!word) continue;
          const norm = db.get<{ v: string }>('SELECT ml_norm(?) AS v', [word])?.v;
          if (!norm || !/^[\p{L}\p{N}]+$/u.test(norm)) continue;
          probed++;
          const hit = db.get('SELECT 1 AS x FROM chunk_fts WHERE chunk_fts MATCH ? AND rowid = ?', [`"${norm}"`, s.rowid]);
          if (!hit) ftsProblems.push(`chunk_fts: chunk ${s.rowid} is not found by its own word`);
        }
        if (samples.length && !probed) ftsProblems.push('chunk_fts: no searchable sample');
      } catch (e) {
        ftsProblems.push(`chunk_fts: ${(e as Error).message.slice(0, 120)}`);
      }
      add(checks, 'fts', ftsProblems.length === 0, ftsProblems.length === 0 ? 'فهارس البحث النصي (FTS) سليمة ومتطابقة مع المحتوى.' : 'فهرس بحث نصي غير متطابق مع المحتوى.', ftsProblems.length ? ftsProblems : undefined);

      relationalChecks(db, checks);
    } finally {
      db.close();
    }

    // 6b. multi-user: the system DB and every other vault, and the registry ↔ archive consistency
    if (multi && checks.every((c) => c.ok)) instanceChecks(extractDir, manifest, onDiskShas(dataDir), !!opts.acceptMissingFiles, checks);

    // 7. boot the app on the restored directory (multi-user), or on a sandbox copy of a single-owner database
    if (opts.bootCheck !== false && checks.every((c) => c.ok)) {
      try {
        const b = multi
          ? await bootCheckMultiUser(dataDir, manifest.vaults!.find((v) => v.primary)!.vault_id, counts)
          : await bootCheckSingleOwner(work, join(extractDir, manifest.db.path), counts);
        add(checks, 'boot', b.ok, b.detail, b.details);
      } catch (e) {
        add(checks, 'boot', false, `تعذّر تشغيل الخادم على البيانات المستعادة: ${(e as Error).message.slice(0, 200)}`);
      }
    } else if (opts.bootCheck !== false) {
      add(checks, 'boot', false, 'لم يُجرَ اختبار التشغيل لأن فحوصًا سابقة فشلت.');
    }
    return finish();
  } finally {
    if (!keepIt) rmSync(work, { recursive: true, force: true });
  }
}

export class RestoreTargetError extends Error {
  constructor(readonly reasonAr: string) {
    super(reasonAr);
    this.name = 'RestoreTargetError';
  }
}

/**
 * Restores an archive into `target` (must not exist, or be an EMPTY directory; never the live data directory).
 * Nothing is moved into place unless every verification check passed.
 */
export async function applyRestore(
  archivePath: string,
  target: string,
  opts: VerifyOptions & { liveDataDir?: string | null } = {},
): Promise<VerifyResult> {
  const now = opts.now ?? Date.now;
  const abs = resolve(target);
  // compare real paths too: a symlink (or a path through one) to the live data directory is the live data directory
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      try {
        return join(realpathSync(dirname(p)), basename(p));
      } catch {
        return resolve(p);
      }
    }
  };
  if (opts.liveDataDir) {
    const live = real(resolve(opts.liveDataDir));
    const tgt = real(abs);
    if (resolve(opts.liveDataDir) === abs || live === tgt || live.startsWith(tgt + sep)) {
      throw new RestoreTargetError('مجلد الهدف هو مجلد بيانات الخادم الحالي (أو يحتويه). الاستعادة لا تكتب فوق بيانات قائمة أبدًا؛ اختر مجلدًا فارغًا.');
    }
  }
  if (existsSync(abs)) {
    if (!statSync(abs).isDirectory()) throw new RestoreTargetError('مسار الهدف موجود وليس مجلدًا.');
    if (readdirSync(abs).length > 0) throw new RestoreTargetError('مجلد الهدف ليس فارغًا. الاستعادة لا تكتب فوق بيانات قائمة؛ اختر مجلدًا فارغًا أو غير موجود.');
  }
  mkdirSync(dirname(abs), { recursive: true });
  const res = await verifyBackup(archivePath, { ...opts, workDir: dirname(abs), keep: true });
  if (!res.report.ok || !res.dataDir || !res.workDir) return res;
  const staging = res.workDir;
  if (res.manifest?.layout === 'vault') {
    rmSync(staging, { recursive: true, force: true });
    throw new RestoreTargetError(
      'هذه نسخة خزنة حساب واحد، لا نسخة خادم كاملة: تُستعاد داخل حسابها على الخادم العامل (استعادة خزنة من أدوات مسؤول المنصة)، لا في مجلد بيانات جديد.',
    );
  }
  try {
    const t = now();
    const backupId = res.manifest?.backup_id ?? null;
    const multi = res.manifest?.layout === 'multi_user';
    let revoked = 0;
    if (multi) {
      // P1-T1: every session of every account is revoked (a revoked device in the old snapshot must not come back)
      const sys = openDb(join(res.dataDir, 'system.sqlite'));
      try {
        revoked = sys.run('UPDATE auth_session SET revoked_at = ? WHERE revoked_at IS NULL', [t]).changes;
      } finally {
        sys.close();
      }
      writeFileSync(join(res.dataDir, MARKER_FILE), `restored from backup ${backupId ?? ''} at ${new Date(t).toISOString()}\n`, { mode: 0o600 });
    }
    const vaultFiles = multi ? res.manifest!.vaults!.map((v) => join(res.dataDir!, 'vaults', v.db_file)) : [join(res.dataDir, 'medlevo.sqlite')];
    for (const file of vaultFiles) {
      const db = openDb(file);
      try {
        const epoch = startRestoreEpoch(db, { now: t, backupId, backupCreatedAt: res.manifest?.created_at ?? null });
        db.tx(() => {
          if (!multi) revoked = db.run('UPDATE auth_session SET revoked_at = ? WHERE revoked_at IS NULL', [t]).changes;
          // the backup being restored was itself "running" in its own snapshot (the API job snapshots first): it did
          // complete — say so instead of calling it interrupted. Its archive is not inside the restored directory.
          if (backupId) {
            db.run(
              `UPDATE data_backup SET status = 'completed', error_detail = NULL, warnings_json = ?, finished_at = COALESCE(finished_at, ?)
               WHERE id = ? AND status IN ('running', 'failed')`,
              [toJson(['استُعيدت البيانات من هذه النسخة. ملف الأرشيف نفسه ليس داخل مجلد البيانات المستعاد؛ احتفظ به حيث هو.']), res.manifest!.created_at, backupId],
            );
          }
          db.run(`UPDATE data_backup SET status = 'failed', error_detail = ?, finished_at = ? WHERE status = 'running'`, [
            'انقطع إنشاء هذه النسخة: البيانات استُعيدت من لقطة أُخذت أثناء إنشائها.',
            t,
          ]);
          // (PL-0) an off-site run caught in the snapshot is over too (a backup from before migration 0751 has no table)
          if (db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'data_offsite_backup'`)) {
            db.run(`UPDATE data_offsite_backup SET status = 'failed', error_detail = ?, finished_at = ? WHERE status = 'running'`, [
              'انتهى هذا النسخ مع الاستعادة: البيانات استُعيدت من لقطة أُخذت أثناءه. النسخ التالي يبدأ من جديد.',
              t,
            ]);
          }
          db.run(
            `INSERT INTO change_log (id, entity_type, entity_id, action, summary, after_json, actor, created_at) VALUES (?, 'server', 'data', 'restore', ?, ?, 'system', ?)`,
            [
              newId(t),
              `استُعيدت البيانات من النسخة الاحتياطية ${backupId ?? ''}؛ أُلغيت ${revoked} جلسة وبدأت حقبة بيانات جديدة للمزامنة.`,
              JSON.stringify({ backup_id: backupId, backup_created_at: res.manifest?.created_at ?? null, epoch: epoch.id }),
              t,
            ],
          );
        });
      } finally {
        db.close();
      }
    }
    rmSync(join(res.dataDir, 'tmp'), { recursive: true, force: true });
    if (existsSync(abs)) rmdirSync(abs);
    renameSync(res.dataDir, abs);
    rmSync(staging, { recursive: true, force: true });
    res.report.restored_to = abs;
    res.report.work_dir = null;
    add(res.report.checks, 'apply', true, `نُقلت البيانات المستعادة إلى ${abs}، وبدأت حقبة مزامنة جديدة، وأُلغيت كل الجلسات (سجّل الدخول من جديد).`);
    res.dataDir = abs;
    res.workDir = null;
    return res;
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}
