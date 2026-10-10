// Backups made on this server (table data_backup): API job, list, download, verify, delete.
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_STATUS_LABELS_AR, type BackupStatus, type BackupView, type RestoreReport } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError, JobError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { ArchiveError } from './tar';
import { createBackup } from './backup';
import { verifyBackup } from './restore';

export const BACKUP_JOB_KIND = 'data_backup';
export const BACKUP_VERIFY_JOB_KIND = 'data_backup_verify';
const FILE_NAME_RE = /^medlevo-backup-[0-9TZ-]+-[0-9a-z]{8}\.tar\.gz$/;

export const BACKUP_INCLUDED_AR = [
  'قاعدة البيانات كاملة في لقطة متسقة: المكتبة والمصادر وإصداراتها وصفحاتها ومناطقها، الملاحظات والحبر والتمييز، الأسئلة ومفاتيحها وروابطها ومحاولاتك، البطاقات وأحداث المراجعة، الجلسات، كتب الدراسة والأدلة والاستشهادات، الإعدادات وسجل التغييرات.',
  'كل ملف تشير إليه قاعدة البيانات (الملفات الأصلية وملفات PDF المحوّلة وصور الصفحات والأشكال) مع بصمة sha256 لكل ملف.',
  'ملف manifest.json: إصدار التطبيق، والـ migrations المطبّقة، وعدد الصفوف في كل جدول، وبصمة كل ملف.',
];
export const BACKUP_STORAGE_NOTE_AR =
  'تُحفظ النسخ في مجلد backups داخل مجلد بيانات الخادم، أي على القرص نفسه. نزّل نسخة واحتفظ بها خارج هذا الجهاز؛ النسخة على القرص نفسه لا تحميك من تلفه. ونسخة لم تُختبر استعادتها ليست ضمانًا: استخدم «تحقّق من الاستعادة».';

interface BackupRow {
  id: string;
  file_name: string;
  status: BackupStatus;
  origin: 'api' | 'cli';
  size: number | null;
  sha256: string | null;
  summary_json: string | null;
  warnings_json: string | null;
  error_detail: string | null;
  job_id: string | null;
  verify_status: 'passed' | 'failed' | null;
  verify_report_json: string | null;
  verified_at: number | null;
  created_at: number;
  finished_at: number | null;
  deleted_at: number | null;
}

export function backupsDir(ctx: AppContext): string {
  return join(ctx.config.dataDir, 'backups');
}

function archivePath(ctx: AppContext, row: Pick<BackupRow, 'file_name'>): string | null {
  if (!FILE_NAME_RE.test(row.file_name)) return null;
  return join(backupsDir(ctx), row.file_name);
}

function archiveExists(ctx: AppContext, row: BackupRow): boolean {
  const p = archivePath(ctx, row);
  if (!p) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function backupView(ctx: AppContext, row: BackupRow): BackupView {
  const report = fromJson<RestoreReport | null>(row.verify_report_json ?? 'null') ?? null;
  const done = row.status === 'completed' || row.status === 'completed_with_warnings';
  return {
    id: row.id,
    file_name: row.file_name,
    status: row.status,
    status_label_ar: BACKUP_STATUS_LABELS_AR[row.status],
    origin: row.origin,
    size: row.size,
    sha256: row.sha256,
    created_at: row.created_at,
    finished_at: row.finished_at,
    summary: fromJson(row.summary_json ?? 'null') ?? null,
    warnings_ar: fromJson<string[]>(row.warnings_json ?? '[]', []) ?? [],
    error_ar: row.error_detail,
    job: row.job_id ? ctx.jobs.get(row.job_id) : null,
    verification:
      row.verify_status && row.verified_at
        ? {
            status: row.verify_status,
            verified_at: row.verified_at,
            summary_ar:
              row.verify_status === 'passed'
                ? `نجحت الاستعادة التجريبية في مجلد منفصل: ${report?.checks.length ?? 0} فحصًا ناجحًا، وشُغّل الخادم على البيانات المستعادة.`
                : `فشلت الاستعادة التجريبية: ${(report?.checks ?? []).filter((c) => !c.ok).map((c) => c.detail_ar).join(' ')}`,
            checks_failed: (report?.checks ?? []).filter((c) => !c.ok).map((c) => c.name),
          }
        : null,
    download_url: done && !row.deleted_at && archiveExists(ctx, row) ? `/api/data/backups/${encodeURIComponent(row.id)}/download` : null,
  };
}

export function getBackupRow(ctx: AppContext, id: string): BackupRow {
  const row = ctx.db.get<BackupRow>('SELECT * FROM data_backup WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!row) throw new AppError('NOT_FOUND', 'النسخة الاحتياطية غير موجودة.', 404);
  return row;
}

export function listBackups(ctx: AppContext): BackupView[] {
  return ctx.db.all<BackupRow>('SELECT * FROM data_backup WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 100').map((r) => backupView(ctx, r));
}

/** A backup row left 'running' by a crash / restart / restore is not running any more: say so. */
export function markInterruptedBackups(ctx: AppContext): void {
  const rows = ctx.db.all<BackupRow>("SELECT * FROM data_backup WHERE status = 'running'");
  for (const r of rows) {
    const job = r.job_id ? ctx.jobs.get(r.job_id) : null;
    if (job && (job.status === 'queued' || job.status === 'running')) continue;
    ctx.db.run(`UPDATE data_backup SET status = 'failed', error_detail = ?, finished_at = ? WHERE id = ? AND status = 'running'`, [
      'انقطع إنشاء هذه النسخة قبل اكتمالها (أُعيد تشغيل الخادم). لم تُحفظ نسخة ناقصة؛ أنشئ نسخة جديدة.',
      ctx.clock.now(),
      r.id,
    ]);
  }
}

export function startBackup(ctx: AppContext): BackupView {
  const running = ctx.db.get<{ id: string }>("SELECT id FROM data_backup WHERE status = 'running' AND deleted_at IS NULL");
  if (running) throw new AppError('CONFLICT', 'هناك نسخة احتياطية قيد الإنشاء الآن. انتظر اكتمالها.', 409);
  const now = ctx.clock.now();
  const id = newId(now);
  ctx.db.run(`INSERT INTO data_backup (id, file_name, status, origin, created_at) VALUES (?, '', 'running', 'api', ?)`, [id, now]);
  const job = ctx.jobs.enqueue(BACKUP_JOB_KIND, { backup_id: id }, { idempotencyKey: `data_backup:${id}` });
  ctx.db.run('UPDATE data_backup SET job_id = ? WHERE id = ?', [job.id, id]);
  ctx.audit.record({ entityType: 'backup', entityId: id, action: 'create', summary: 'بدء إنشاء نسخة احتياطية' });
  return backupView(ctx, getBackupRow(ctx, id));
}

export function registerBackupJobs(ctx: AppContext): void {
  ctx.jobs.register<{ backup_id: string }, { file_name: string; size: number }>(BACKUP_JOB_KIND, {
    version: 'backup-1',
    maxAttempts: 1,
    timeoutMs: 6 * 60 * 60 * 1000,
    concurrency: 1,
    handler: async (run) => {
      const row = ctx.db.get<BackupRow>('SELECT * FROM data_backup WHERE id = ?', [run.input.backup_id]);
      if (!row) throw new JobError('BACKUP_NOT_FOUND', 'سجل النسخة الاحتياطية غير موجود.', { retryable: false });
      try {
        const res = await createBackup({
          dataDir: ctx.config.dataDir,
          dbPath: ctx.config.dbPath,
          filesDir: ctx.config.filesDir,
          outDir: backupsDir(ctx),
          appVersion: ctx.config.appVersion,
          now: () => ctx.clock.now(),
          backupId: row.id,
          db: ctx.db,
          signal: run.signal,
          onProgress: (p) => run.progress(p),
        });
        ctx.db.run(
          `UPDATE data_backup SET status = ?, file_name = ?, size = ?, sha256 = ?, summary_json = ?, warnings_json = ?, finished_at = ? WHERE id = ?`,
          [res.warnings_ar.length ? 'completed_with_warnings' : 'completed', res.fileName, res.size, res.sha256, toJson(res.summary), toJson(res.warnings_ar), ctx.clock.now(), row.id],
        );
        ctx.audit.record({ entityType: 'backup', entityId: row.id, action: 'completed', summary: `اكتملت نسخة احتياطية (${res.summary.files} ملفًا)`, actor: 'job', jobId: run.id });
        return { file_name: res.fileName, size: res.size };
      } catch (e) {
        const reason =
          e instanceof ArchiveError ? e.reasonAr : (e as NodeJS.ErrnoException)?.code === 'ENOSPC' ? 'لا توجد مساحة كافية على القرص لإنشاء النسخة.' : 'تعذّر إنشاء النسخة الاحتياطية. لم تُحفظ نسخة ناقصة.';
        ctx.db.run(`UPDATE data_backup SET status = 'failed', error_detail = ?, finished_at = ? WHERE id = ?`, [reason, ctx.clock.now(), row.id]);
        throw new JobError('BACKUP_FAILED', reason, { retryable: false });
      }
    },
  });

  ctx.jobs.register<{ backup_id: string }, { ok: boolean }>(BACKUP_VERIFY_JOB_KIND, {
    version: 'verify-1',
    maxAttempts: 1,
    timeoutMs: 6 * 60 * 60 * 1000,
    concurrency: 1,
    handler: async (run) => {
      const row = ctx.db.get<BackupRow>('SELECT * FROM data_backup WHERE id = ?', [run.input.backup_id]);
      const p = row ? archivePath(ctx, row) : null;
      if (!row || !p || !existsSync(p)) throw new JobError('BACKUP_NOT_FOUND', 'ملف النسخة الاحتياطية غير موجود على الخادم.', { retryable: false });
      run.progress({ stage: 'verify' });
      const res = await verifyBackup(p, { workDir: join(ctx.config.tmpDir), now: () => ctx.clock.now() });
      ctx.db.run('UPDATE data_backup SET verify_status = ?, verify_report_json = ?, verified_at = ? WHERE id = ?', [
        res.report.ok ? 'passed' : 'failed',
        toJson(res.report),
        ctx.clock.now(),
        row.id,
      ]);
      ctx.audit.record({
        entityType: 'backup',
        entityId: row.id,
        action: 'verify',
        summary: res.report.ok ? 'نجحت الاستعادة التجريبية للنسخة' : 'فشلت الاستعادة التجريبية للنسخة',
        actor: 'job',
        jobId: run.id,
      });
      return { ok: res.report.ok };
    },
  });
}

export function startVerify(ctx: AppContext, id: string): BackupView {
  const row = getBackupRow(ctx, id);
  if (row.status !== 'completed' && row.status !== 'completed_with_warnings') throw new AppError('CONFLICT', 'لا يمكن التحقق من نسخة لم تكتمل.', 409);
  if (!archiveExists(ctx, row)) throw new AppError('NOT_FOUND', 'ملف النسخة غير موجود على الخادم.', 404);
  const job = ctx.jobs.enqueue(BACKUP_VERIFY_JOB_KIND, { backup_id: id }, { idempotencyKey: `data_backup_verify:${id}:${ctx.clock.now()}` });
  ctx.db.run('UPDATE data_backup SET job_id = ? WHERE id = ?', [job.id, id]);
  return backupView(ctx, getBackupRow(ctx, id));
}

export function archiveForDownload(ctx: AppContext, id: string): { path: string; fileName: string; size: number } {
  const row = getBackupRow(ctx, id);
  if (row.status !== 'completed' && row.status !== 'completed_with_warnings') throw new AppError('CONFLICT', 'النسخة لم تكتمل بعد.', 409);
  const p = archivePath(ctx, row);
  if (!p || !existsSync(p)) throw new AppError('NOT_FOUND', 'ملف النسخة غير موجود على الخادم.', 404);
  return { path: p, fileName: row.file_name, size: statSync(p).size };
}

export function deleteBackup(ctx: AppContext, id: string): void {
  const row = getBackupRow(ctx, id);
  if (row.status === 'running') throw new AppError('CONFLICT', 'لا يمكن حذف نسخة قيد الإنشاء.', 409);
  const p = archivePath(ctx, row);
  if (p) {
    rmSync(p, { force: true });
    rmSync(`${p}.sha256`, { force: true });
  }
  ctx.db.run('UPDATE data_backup SET deleted_at = ? WHERE id = ?', [ctx.clock.now(), id]);
  ctx.audit.record({ entityType: 'backup', entityId: id, action: 'delete', summary: `حذف ملف نسخة احتياطية (${row.file_name})` });
}

/** Record a CLI-made backup when the CLI writes into this server's backups directory. */
export function recordCliBackup(
  db: import('../../db/db').Db,
  r: { backupId: string; fileName: string; size: number; sha256: string; summary: unknown; warnings_ar: string[]; createdAt: number; finishedAt: number },
): void {
  db.run(
    `INSERT OR IGNORE INTO data_backup (id, file_name, status, origin, size, sha256, summary_json, warnings_json, created_at, finished_at)
     VALUES (?, ?, ?, 'cli', ?, ?, ?, ?, ?, ?)`,
    [r.backupId, r.fileName, r.warnings_ar.length ? 'completed_with_warnings' : 'completed', r.size, r.sha256, toJson(r.summary), toJson(r.warnings_ar), r.createdAt, r.finishedAt],
  );
}
