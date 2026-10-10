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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { BACKUP_FORMAT, type BackupManifest, type RestoreCheck, type RestoreReport } from '@medlevo/shared';
import { openDb, toJson, type Db } from '../../db/db';
import { readMigrations } from '../../db/migrate';
import { newId } from '../../lib/ids';
import { BACKUP_DB_PATH, BACKUP_MANIFEST_PATH, BACKUP_ROOT, rowCounts } from './backup';
import { startRestoreEpoch } from './epoch';
import { ArchiveError, extractTarGz, type ExtractedEntry, type TarExtractLimits } from './tar';

const GiB = 1024 * 1024 * 1024;
export const DEFAULT_RESTORE_LIMITS: TarExtractLimits = {
  maxEntries: 1_000_000,
  maxTotalBytes: 64 * GiB,
  maxEntryBytes: 64 * GiB,
  maxRatio: 100,
  ratioMinBytes: 8 * 1024 * 1024,
};

const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  backup_id: z.string().min(1).max(64),
  app_version: z.string().max(64),
  created_at: z.number().int().nonnegative(),
  root: z.literal(BACKUP_ROOT),
  db: z.object({
    path: z.literal(BACKUP_DB_PATH),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
    migrations: z.array(z.object({ name: z.string().max(200), checksum: z.string().max(128) })).max(10_000),
    row_counts: z.record(z.string().max(200), z.number().int().nonnegative()),
    sync_head_seq: z.number().int().nonnegative(),
    server_epoch: z.string().max(64).nullable(),
  }),
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

async function bootCheck(dataDir: string, expected: Record<string, number>): Promise<{ ok: boolean; detail: string; details: unknown }> {
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
    const sources = app.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source')!.n;
    const annotations = app.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation')!.n;
    const unauth = await app.inject({ method: 'GET', url: '/api/library/tree' });
    const ok = health.statusCode === 200 && (health.json() as { ok: boolean }).ok && sources === (expected.source ?? 0) && annotations === (expected.annotation ?? 0) && unauth.statusCode === 401;
    return {
      ok,
      detail: ok
        ? `شُغّل الخادم على البيانات المستعادة: /api/health سليم، ${sources} مصدر و${annotations} عنصر كتابة، والمسارات المحمية تطلب تسجيل الدخول.`
        : `فشل تشغيل الخادم على البيانات المستعادة كما يجب (health ${health.statusCode}، مصادر ${sources}/${expected.source ?? 0}، كتابات ${annotations}/${expected.annotation ?? 0}).`,
      details: { health: health.statusCode, sources, annotations, protected_status: unauth.statusCode },
    };
  } finally {
    await app.close();
  }
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
    // 1. archive (safe extraction with limits)
    let entries: ExtractedEntry[];
    try {
      if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
        add(checks, 'archive', false, 'ملف النسخة الاحتياطية غير موجود.');
        return finish();
      }
      const r = await extractTarGz(archivePath, extractDir, limits);
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
    add(checks, 'manifest', true, `نسخة ${manifest.backup_id} من الإصدار ${manifest.app_version}، أُنشئت ${new Date(manifest.created_at).toISOString()}.`);

    // 3. layout: every entry is expected
    const listed = new Set<string>([BACKUP_MANIFEST_PATH, BACKUP_DB_PATH, ...manifest.files.map((f) => f.path)]);
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

    // 4. database file hash
    const dbEntry = byPath.get(BACKUP_DB_PATH);
    if (!dbEntry) {
      add(checks, 'database_hash', false, 'ملف قاعدة البيانات غير موجود في الأرشيف.');
      return finish();
    }
    add(
      checks,
      'database_hash',
      dbEntry.sha256 === manifest.db.sha256 && dbEntry.size === manifest.db.size,
      dbEntry.sha256 === manifest.db.sha256 ? 'بصمة sha256 لقاعدة البيانات مطابقة.' : 'بصمة قاعدة البيانات لا تطابق manifest.json — الملف تالف أو مُعدَّل.',
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
      opened = openDb(join(dataDir, 'medlevo.sqlite'));
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
      const stored = db.all<{ id: string; sha256: string }>('SELECT id, sha256 FROM stored_file');
      const listedIds = new Set(manifest.files.map((f) => f.file_id));
      const notRestorable = stored.filter((s) => !listedIds.has(s.id));
      const onDisk = new Set(listFilesUnder(join(dataDir, 'files')).map((p) => p.split('/').pop()));
      const absent = stored.filter((s) => listedIds.has(s.id) && !onDisk.has(s.sha256));
      const missingAtBackup = new Set(manifest.files_missing.map((m) => m.file_id));
      // files missing only because they were already missing/damaged at backup time (recorded in the manifest)
      const knownMissing = notRestorable.filter((s) => missingAtBackup.has(s.id));
      const unexplained = [...notRestorable.filter((s) => !missingAtBackup.has(s.id)), ...absent];
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

    // 7. boot the app on the restored directory
    if (opts.bootCheck !== false && checks.every((c) => c.ok)) {
      try {
        const b = await bootCheck(dataDir, counts);
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
  try {
    const db = openDb(join(res.dataDir, 'medlevo.sqlite'));
    try {
      const t = now();
      const epoch = startRestoreEpoch(db, { now: t, backupId: res.manifest?.backup_id ?? null, backupCreatedAt: res.manifest?.created_at ?? null });
      db.tx(() => {
        const revoked = db.run('UPDATE auth_session SET revoked_at = ? WHERE revoked_at IS NULL', [t]).changes;
        // the backup being restored was itself "running" in its own snapshot (the API job snapshots first): it did
        // complete — say so instead of calling it interrupted. Its archive is not inside the restored directory.
        if (res.manifest?.backup_id) {
          db.run(
            `UPDATE data_backup SET status = 'completed', error_detail = NULL, warnings_json = ?, finished_at = COALESCE(finished_at, ?)
             WHERE id = ? AND status IN ('running', 'failed')`,
            [
              toJson(['استُعيدت البيانات من هذه النسخة. ملف الأرشيف نفسه ليس داخل مجلد البيانات المستعاد؛ احتفظ به حيث هو.']),
              res.manifest.created_at,
              res.manifest.backup_id,
            ],
          );
        }
        db.run(
          `UPDATE data_backup SET status = 'failed', error_detail = ?, finished_at = ? WHERE status = 'running'`,
          ['انقطع إنشاء هذه النسخة: البيانات استُعيدت من لقطة أُخذت أثناء إنشائها.', t],
        );
        db.run(
          `INSERT INTO change_log (id, entity_type, entity_id, action, summary, after_json, actor, created_at) VALUES (?, 'server', 'data', 'restore', ?, ?, 'system', ?)`,
          [
            newId(t),
            `استُعيدت البيانات من النسخة الاحتياطية ${res.manifest?.backup_id ?? ''}؛ أُلغيت ${revoked} جلسة وبدأت حقبة بيانات جديدة للمزامنة.`,
            JSON.stringify({ backup_id: res.manifest?.backup_id ?? null, backup_created_at: res.manifest?.created_at ?? null, epoch: epoch.id }),
            t,
          ],
        );
      });
    } finally {
      db.close();
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
