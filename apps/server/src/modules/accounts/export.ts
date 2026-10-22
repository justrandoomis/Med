// «نسخة من بياناتي» — the per-user export (P1-T1 step 2; ADR-0003 §3.6, ARCHITECTURE_DELTA §5.8, PRD AOS-21.43).
// A job in the user's OWN vault builds the vault-layout archive (manifest.json + the vault snapshot + every file the vault
// references, each with its sha256) into DATA_DIR/exports/<vault id>/. It contains this account's data only — never
// the system DB or another account's vault — and it is the same format a platform per-vault restore reads, so a user
// can keep it as their own backup. Not encrypted: it is for the user, delivered over the authenticated connection.
// The newest 3 archives are kept; deleting the account deletes them.
// AOS-21.43: the kept archives are the account's bytes on the server, so they COUNT IN ITS STORAGE QUOTA
// (system/quota.ts). An export with no room left is refused before its job starts; a finished archive first makes
// room by removing that account's OLDER archives; one that does not fit even alone is removed again and the job fails
// with the reason (the earlier archives stay).
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountExportView, JobView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError, JobError } from '../../lib/errors';
import type { Viewer } from '../../system/binding';
import { createBackup } from '../data/backup';

export const ACCOUNT_EXPORT_JOB = 'account_export';
export const EXPORT_NAME_RE = /^medlevo-export-[0-9TZ-]+-[0-9a-z]{8}\.tar\.gz$/;
export const EXPORTS_KEPT = 3;

export const EXPORT_INCLUDED_AR = [
  'كل بيانات حسابك في قاعدة بياناته: المكتبة والمصادر وإصداراتها، الملاحظات والحبر والطبقات، الأسئلة والبطاقات وأحداث المراجعة، كتب الدراسة، الإعدادات وسجل التغييرات.',
  'كل ملف يشير إليه حسابك (الملفات الأصلية والمحوّلة وصور الصفحات) مع بصمة sha256 لكل ملف، وملف manifest.json يصف المحتوى.',
  'لا تحتوي بيانات أي حساب آخر، ولا كلمة المرور ولا مفاتيح الخادم.',
];
export const EXPORT_NOTE_AR = 'تُحفظ آخر 3 نسخ على الخادم لتنزيلها وتُحسب من مساحة حسابك (تُحذف الأقدم أولًا عند الحاجة)، وتُحذف كلها عند حذف حسابك. النسخة غير مشفّرة لأنها لك: احفظها في مكان آمن.';

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

const MiB = 1024 * 1024;
const mbAr = (n: number) => `${(n / MiB).toFixed(n >= 100 * MiB ? 0 : 1)} م.ب`;

/** AOS-21.43: why an export does not fit (exports count in the account's storage). */
export const EXPORT_QUOTA_AR = (usedBytes: number, limitBytes: number, needBytes: number | null) =>
  `لا توجد مساحة كافية في حسابك لنسخة من بياناتك${needBytes !== null ? ` (تحتاج النسخة ${mbAr(needBytes)})` : ''}: تستخدم ${mbAr(usedBytes)} من ${mbAr(limitBytes)}، والنسخ المحفوظة على الخادم تُحسب من مساحتك. احذف ملفات لا تحتاجها أو اطلب من مسؤول المنصة زيادة المساحة.`;

/** AOS-21.43: before an export job starts — refused when the account has no room left at all (QUOTA_EXCEEDED). */
export function assertExportHasRoom(ctx: AppContext, v: Viewer): void {
  const vault = ctx.system.vaults.ofViewer(v);
  const limit = ctx.quota.storageLimit(v.userId);
  if (!vault || limit === null) return;
  const u = ctx.quota.storageUsed(vault.id);
  // older archives are dropped to make room, so only the vault and its files must leave room for a new one
  if (u.bytes_db + u.bytes_files >= limit) {
    throw new AppError('QUOTA_EXCEEDED', EXPORT_QUOTA_AR(u.bytes_db + u.bytes_files + u.bytes_exports, limit, null), 409, {
      kind: 'storage',
      used: u.bytes_db + u.bytes_files + u.bytes_exports,
      limit,
      wanted: null,
      resets_at: null,
    });
  }
}

/**
 * AOS-21.43: after the new archive `fresh` is written — make it fit the quota by removing OLDER archives (oldest first);
 * if it cannot fit even alone, remove it (the older archives stay) and fail with the reason.
 */
function fitInQuota(ctx: AppContext, vaultId: string, userId: string, dir: string, fresh: string): void {
  const limit = ctx.quota.storageLimit(userId);
  if (limit === null) return;
  const older = readdirSync(dir)
    .filter((n) => EXPORT_NAME_RE.test(n) && n !== fresh)
    .sort();
  const sizeOf = (n: string) => {
    try {
      return statSync(join(dir, n)).size;
    } catch {
      return 0;
    }
  };
  const total = ctx.quota.storageTotal(vaultId);
  const olderBytes = older.reduce((a, n) => a + sizeOf(n), 0);
  if (total - olderBytes > limit) {
    const need = sizeOf(fresh);
    rmSync(join(dir, fresh), { force: true });
    throw new JobError('QUOTA_EXCEEDED', EXPORT_QUOTA_AR(total - need, limit, need), { retryable: false });
  }
  for (const n of older) {
    if (ctx.quota.storageTotal(vaultId) <= limit) break;
    rmSync(join(dir, n), { force: true });
  }
}

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
      // AOS-21.43: the archives count in the account's quota — older ones go first, an archive that cannot fit is not kept
      fitInQuota(ctx, vaultId, vault.user_id, dir, res.fileName);
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
