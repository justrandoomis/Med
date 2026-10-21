// «نسخة من بياناتي» — the per-user export (P1-T1 step 2; ADR-0003 §3.6, ARCHITECTURE_DELTA §5.8, PRD AOS-21.43).
// A job in the user's OWN vault builds the vault-layout archive (manifest.json + the vault snapshot + every file the vault
// references, each with its sha256) into DATA_DIR/exports/<vault id>/. It contains this account's data only — never
// the system DB or another account's vault — and it is the same format a platform per-vault restore reads, so a user
// can keep it as their own backup. Not encrypted: it is for the user, delivered over the authenticated connection.
// The newest 3 archives are kept; deleting the account deletes them.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountExportView, JobView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError, JobError } from '../../lib/errors';
import { createBackup } from '../data/backup';

export const ACCOUNT_EXPORT_JOB = 'account_export';
export const EXPORT_NAME_RE = /^medlevo-export-[0-9TZ-]+-[0-9a-z]{8}\.tar\.gz$/;
export const EXPORTS_KEPT = 3;

export const EXPORT_INCLUDED_AR = [
  'كل بيانات حسابك في قاعدة بياناته: المكتبة والمصادر وإصداراتها، الملاحظات والحبر والطبقات، الأسئلة والبطاقات وأحداث المراجعة، كتب الدراسة، الإعدادات وسجل التغييرات.',
  'كل ملف يشير إليه حسابك (الملفات الأصلية والمحوّلة وصور الصفحات) مع بصمة sha256 لكل ملف، وملف manifest.json يصف المحتوى.',
  'لا تحتوي بيانات أي حساب آخر، ولا كلمة المرور ولا مفاتيح الخادم.',
];
export const EXPORT_NOTE_AR = 'تُحفظ آخر 3 نسخ على الخادم لتنزيلها، وتُحذف كلها عند حذف حسابك. النسخة غير مشفّرة لأنها لك: احفظها في مكان آمن.';

function boundVaultId(ctx: AppContext): string {
  const b = ctx.binding.current() ?? ctx.binding.harnessDefault();
  if (!b || b.kind !== 'vault') throw new JobError('NO_VAULT', 'لا توجد خزنة مرتبطة بهذه المهمة.', { retryable: false });
  return b.vaultId;
}

export function exportsDir(ctx: AppContext, vaultId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(vaultId)) throw new AppError('NOT_FOUND', 'النسخة غير موجودة.', 404);
  return join(ctx.config.dataDir, 'exports', vaultId);
}

interface ExportOutput {
  file_name: string;
  size: number;
  sha256: string;
  /** files the vault references that could not be put in the archive (P1-T1 step 2 review); absent in older outputs */
  missing_files?: number;
}

/** Said with the export when files are missing from it — never a silent «complete» (P1-T1 step 2 review). */
export const EXPORT_MISSING_AR = (n: number) =>
  `النسخة جاهزة لكن ينقصها ${n} ملف لم يُعثر عليه سليمًا في مخزن الملفات (ولا في نسخته السحابية إن وُجدت)؛ أسماؤها وبصماتها مذكورة في manifest.json ← files_missing. أبلغ مسؤول المنصة.`;

function keepNewest(dir: string, keep: number): void {
  if (!existsSync(dir)) return;
  const names = readdirSync(dir).filter((n) => EXPORT_NAME_RE.test(n)).sort().reverse();
  for (const n of names.slice(keep)) rmSync(join(dir, n), { force: true });
}

export function registerAccountExport(ctx: AppContext): void {
  ctx.jobs.register<Record<string, never>, ExportOutput>(ACCOUNT_EXPORT_JOB, {
    version: 'account-export-1',
    maxAttempts: 1,
    timeoutMs: 2 * 60 * 60 * 1000,
    concurrency: 1,
    handler: async (run) => {
      const vaultId = boundVaultId(ctx);
      const vault = ctx.system.vaults.byIdInternal(vaultId);
      if (!vault) throw new JobError('NO_VAULT', 'الخزنة غير موجودة.', { retryable: false });
      const user = ctx.system.users.byIdInternal(vault.user_id);
      const dir = exportsDir(ctx, vaultId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      run.progress({ stage: 'snapshot' });
      const res = await createBackup({
        dataDir: ctx.config.dataDir,
        dbPath: ctx.config.dbPath,
        filesDir: ctx.config.filesDir,
        outDir: dir,
        appVersion: ctx.config.appVersion,
        now: () => ctx.clock.now(),
        namePrefix: 'medlevo-export',
        signal: run.signal,
        onProgress: (p) => run.progress(p),
        // a file whose local copy is missing is fetched back from the object store (MEDLEVO_BLOB_STORE=r2) first
        ensureLocal: (sha, size) => ctx.blobs.ensureLocal(sha, size),
        vaultOnly: {
          // snapshotted on the job's own (bound) connection
          vault: { id: vault.id, userId: vault.user_id, dbFile: vault.db_file, path: ctx.pool.pathOfFile('vault', vault.db_file), db: ctx.db, primary: true },
          account: { user_id: vault.user_id, username: user?.username ?? '', display_name: user?.display_name ?? '' },
        },
      });
      rmSync(`${res.archivePath}.sha256`, { force: true });
      keepNewest(dir, EXPORTS_KEPT);
      ctx.audit.record({ entityType: 'account', entityId: vault.user_id, action: 'export', summary: `نسخة من بياناتك (${res.summary.files} ملفًا)`, actor: 'job', jobId: run.id });
      return { file_name: res.fileName, size: res.size, sha256: res.sha256, missing_files: res.manifest.files_missing.length };
    },
  });
}

/** The archive of a finished export of the bound vault, or null. */
export function exportFile(ctx: AppContext, job: JobView): { path: string; out: ExportOutput } | null {
  const out = job.output as ExportOutput | undefined;
  if (job.kind !== ACCOUNT_EXPORT_JOB || job.status !== 'completed' || !out || !EXPORT_NAME_RE.test(out.file_name)) return null;
  const vaultId = boundVaultId(ctx);
  const p = join(exportsDir(ctx, vaultId), out.file_name);
  try {
    return statSync(p).isFile() ? { path: p, out } : null;
  } catch {
    return null;
  }
}

export function exportView(ctx: AppContext, job: JobView): AccountExportView {
  const f = exportFile(ctx, job);
  const out = job.output as ExportOutput | undefined;
  return {
    job_id: job.id,
    status: job.status,
    created_at: job.created_at,
    finished_at: job.finished_at,
    file_name: out?.file_name ?? null,
    size: out?.size ?? null,
    sha256: out?.sha256 ?? null,
    download_url: f ? `/api/accounts/me/exports/${encodeURIComponent(job.id)}/download` : null,
    missing_files: out?.missing_files ?? null,
    warning_ar: out?.missing_files ? EXPORT_MISSING_AR(out.missing_files) : null,
    error_ar: job.error?.message ?? null,
  };
}

export function listExports(ctx: AppContext): AccountExportView[] {
  return ctx.jobs
    .list({ kind: ACCOUNT_EXPORT_JOB, limit: 20 })
    .jobs.map((j) => ctx.jobs.get(j.id))
    .filter((j): j is JobView => j !== null)
    .map((j) => exportView(ctx, j));
}
