// Academic OS — files: chunked resumable uploads, the blob registry and its GC, per-vault backups (ARCHITECTURE_DELTA
// §7.12, §4.1 `2250_ops`; P1-T1 step 2). Types and zod schemas only.
import { z } from 'zod';
import type { StoredFileView } from '../api';

// ───────── chunked, resumable uploads (/api/files/uploads) ─────────

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** POST /api/files/uploads — announce the bytes first (size + whole sha256); a matching open session is resumed. */
export const createUploadSchema = z
  .object({
    size: z.number().int().positive(),
    sha256: sha256Hex,
    mime: z.string().trim().max(255).optional(),
    name: z.string().trim().max(512).optional(),
    /** the user's own vault; a subject space arrives with R1-c */
    target: z.union([z.literal('vault'), z.object({ space_id: z.string().min(1).max(64) }).strict()]).default('vault'),
  })
  .strict();
export type CreateUploadRequest = z.infer<typeof createUploadSchema>;

export const UPLOAD_STATUSES = ['open', 'completed', 'expired', 'failed'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export interface UploadSessionView {
  upload_id: string;
  status: UploadStatus;
  size: number;
  sha256: string;
  /** every chunk but the last has exactly this many bytes */
  chunk_size: number;
  chunks: number;
  /** indexes (0-based) of chunks the server holds and verified */
  received: number[];
  expires_at: number;
  /** the stored file once completed (also right away when the vault already holds these bytes) */
  file_id: string | null;
}

/** PUT /api/files/uploads/:id/chunks/:n — raw body; this header carries the chunk's sha256 (hex). */
export const UPLOAD_CHUNK_SHA_HEADER = 'x-content-sha256';

export interface UploadCompleteResponse {
  file: StoredFileView;
  /** the vault already held these bytes */
  deduplicated: boolean;
  session: UploadSessionView;
}

export const UPLOAD_LABELS_AR = {
  not_found: 'جلسة الرفع غير موجودة أو انتهت. ابدأ الرفع من جديد.',
  expired: 'انتهت مدة جلسة الرفع قبل اكتمالها. ابدأ الرفع من جديد؛ الأجزاء التي أُرسلت سابقًا لم تعد محفوظة.',
  closed: 'جلسة الرفع هذه لم تعد مفتوحة.',
  chunk_index: 'رقم الجزء خارج حدود هذا الملف.',
  chunk_size: 'حجم الجزء لا يطابق حجم الأجزاء المتفق عليه لهذا الرفع.',
  chunk_hash: 'بصمة الجزء لا تطابق محتواه (تلف أثناء الإرسال). أعد إرسال هذا الجزء.',
  missing_chunks: (n: number) => `لم تصل كل أجزاء الملف بعد (${n} جزءًا ناقصًا). أرسل الأجزاء الناقصة ثم أكمل.`,
  whole_hash: 'الملف المجمّع لا يطابق البصمة المعلنة عند بدء الرفع؛ لم يُحفظ شيء. ابدأ الرفع من جديد.',
  too_large: 'حجم الملف أكبر من الحد المسموح للرفع.',
  space_target: 'الرفع إلى مادة مشتركة يصل مع قنوات المواد (الإصدار R1-c).',
} as const;

// ───────── blob registry and GC (platform admin) ─────────

export interface BlobSweepView {
  id: string;
  kind: 'sweep' | 'mark';
  status: 'running' | 'completed' | 'incomplete' | 'failed';
  started_at: number;
  finished_at: number | null;
  databases_marked: number;
  blobs_marked: number;
  registered: number;
  orphaned: number;
  quarantined: number;
  deleted: number;
  restored: number;
  error: string | null;
}

/** GET /api/platform/blobs — counts only (never a file name or whose a blob is). */
export interface PlatformBlobsResponse {
  registry: { blobs: number; bytes: number; orphaned: number; quarantined: number; in_object_store: number };
  object_store: { kind: 'local' | 'r2'; pending_copies: number };
  sweep: { running: boolean; schedule: string | null; recent: BlobSweepView[] };
  policy_ar: string;
}

export const runSweepSchema = z.object({ kind: z.enum(['sweep', 'mark']).default('sweep') }).strict();

// ───────── per-vault backups and restore (platform admin) ─────────

export interface VaultBackupView {
  file_name: string;
  size: number;
  sha256: string;
  encrypted: boolean;
  created_at: number;
}

export interface VaultBackupsResponse {
  vault_id: string;
  backups: VaultBackupView[];
  note_ar: string;
}

export const restoreVaultSchema = z.object({ file_name: z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/) }).strict();

/** AOS-21.1 / X8 (d): one per-space backup archive (platform admin; names, sizes and checks only — never content). */
export type SpaceBackupView = VaultBackupView;

/** AOS-21.1 / X8 (d): the last restore check of one space backup in this process. */
export interface SpaceBackupCheckView {
  space_id: string;
  file_name: string;
  /** true while the check runs (it runs in the background) */
  running: boolean;
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail_ar: string }>;
  started_at: number;
  finished_at: number | null;
}

export interface SpaceBackupsResponse {
  space_id: string;
  title: string;
  backups: SpaceBackupView[];
  note_ar: string;
  last_check: SpaceBackupCheckView | null;
}

/** POST /api/platform/spaces/:spaceId/backups/verify */
export const verifySpaceBackupSchema = restoreVaultSchema;

export interface VaultRestoreResponse {
  vault_id: string;
  ok: boolean;
  /** the checks of the verification that ran first (nothing changes unless all pass) */
  checks: Array<{ name: string; ok: boolean; detail_ar: string }>;
  /** where the vault file that was replaced is kept (rollback) */
  rollback_copy: string | null;
  sessions_revoked: number;
}
