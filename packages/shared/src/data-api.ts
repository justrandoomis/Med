// Data track contract (track D1): offline downloads (Download Manager), backups / restore verification and
// exports — spec §46 (export), §47 (offline-first, download manager, storage policy), §49 (backups), AC-23, AC-30.
// The server module `apps/server/src/modules/data` implements these shapes; the web client consumes them
// (`apps/web/src/lib/offline.ts`, `apps/web/src/features/offline`).
import type { JobView } from './api';
import type { SourceType } from './enums';
import type { SourceFormat } from './sources';

// ───────────────────────────── offline downloads (§47, AC-23) ─────────────────────────────
export const OFFLINE_MANIFEST_FORMAT = 'medlevo-offline-1' as const;

/** Binary files stored on the device (IndexedDB `blobs`, key `file:<file_id>`). */
export type OfflineFileRole = 'display_pdf' | 'page_image' | 'thumbnail';

/** JSON answers stored on the device and served to the app's own GET requests while offline. */
export type OfflineDataRole =
  | 'source_detail'
  | 'pages'
  | 'page_regions'
  | 'annotations'
  | 'notes'
  | 'needs_reanchor'
  | 'latest_session'
  | 'reading_progress'
  | 'study_book_status'
  | 'study_book'
  | 'lecture_questions'
  | 'question_detail'
  | 'learning';

export interface OfflineFileEntry {
  kind: 'file';
  role: OfflineFileRole;
  file_id: string;
  /** authenticated same-origin download URL */
  url: string;
  mime: string;
  /** exact size in bytes (stored_file.size) */
  size: number;
  /** content hash; the client verifies it after downloading */
  sha256: string;
  page_id: string | null;
  page_index: number | null;
}

export interface OfflineDataEntry {
  kind: 'data';
  role: OfflineDataRole;
  /** the exact GET path the app requests, normalized (`/api/...`, query parameters sorted) */
  path: string;
  /** exact size in bytes of the JSON answer at manifest time */
  size: number;
  /** the answer reveals answer keys / correct options (questions with solutions) */
  contains_solutions: boolean;
  sha256: string;
}

export type OfflineEntry = OfflineFileEntry | OfflineDataEntry;

/**
 * The key under which a downloaded GET answer is stored and looked up: `/api/...` path + query parameters
 * sorted by name (so `?b=2&a=1` and `?a=1&b=2` are the same request). Used by the server (manifest paths) and by
 * the web client (offline transport) — one function, one key.
 */
export function normalizeOfflinePath(url: string): string {
  const hashless = url.split('#')[0] ?? '';
  const q = hashless.indexOf('?');
  let path = q >= 0 ? hashless.slice(0, q) : hashless;
  const query = q >= 0 ? hashless.slice(q + 1) : '';
  // absolute URLs (same origin) → path only
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(path);
  if (m) path = m[1] ?? '/';
  if (!path.startsWith('/api')) path = `/api${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return path;
  const params = new URLSearchParams(query);
  const pairs: Array<[string, string]> = [];
  params.forEach((v, k) => pairs.push([k, v]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const sorted = new URLSearchParams(pairs).toString();
  return sorted ? `${path}?${sorted}` : path;
}

export interface OfflineManifestResponse {
  format: typeof OFFLINE_MANIFEST_FORMAT;
  source: { id: string; title: string; source_type: SourceType; format: SourceFormat };
  version: { id: string; version_no: number; is_active: boolean; page_count: number | null; processing_status: string };
  /** include_solutions as requested (default true) */
  include_solutions: boolean;
  generated_at: number;
  /** sha256 over every entry (path/file + content hash): a different value later means the server content changed */
  content_hash: string;
  entries: OfflineEntry[];
  /** real byte counts (no estimates) */
  totals: { bytes: number; file_bytes: number; data_bytes: number; files: number; data: number; solution_bytes: number };
  contents: {
    pages: number;
    page_images: number;
    has_display_pdf: boolean;
    annotations: number;
    notes: number;
    note_pages: number;
    study_book: { artifact_id: string; version_no: number; status: string; blocks: number; is_frozen: boolean } | null;
    questions: { linked: number; with_solutions: number };
    flashcards: number;
    review_events: number;
  };
  /** what an offline copy cannot do (Arabic, specific) */
  not_included_ar: string[];
}

export interface OfflineBundleEntry {
  path: string;
  role: OfflineDataRole;
  contains_solutions: boolean;
  sha256: string;
  body: unknown;
}

/** GET /api/data/offline/:sourceId/bundle — every data entry of the manifest in one answer. */
export interface OfflineBundleResponse {
  format: typeof OFFLINE_MANIFEST_FORMAT;
  source_id: string;
  version_id: string;
  content_hash: string;
  generated_at: number;
  entries: OfflineBundleEntry[];
}

/** GET /api/data/offline/:sourceId/learning — flashcards made from the source and their review history. */
export interface OfflineLearningResponse {
  source_id: string;
  flashcards: Array<{
    id: string;
    kind: string;
    front: unknown;
    back: unknown;
    source_id: string | null;
    source_version_id: string | null;
    evidence_ids: string[];
    origin: string;
    suspended: boolean;
    rev: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  }>;
  review_events: Array<{ id: string; card_id: string; rating: number; reviewed_at: number; duration_ms: number | null; device_id: string | null }>;
}

// ───────────────────────────── backups (§49, AC-30) ─────────────────────────────
export const BACKUP_FORMAT = 'medlevo-backup-1' as const;
export const BACKUP_STATUSES = ['running', 'completed', 'completed_with_warnings', 'failed'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];
export const BACKUP_STATUS_LABELS_AR: Record<BackupStatus, string> = {
  running: 'قيد الإنشاء',
  completed: 'اكتملت',
  completed_with_warnings: 'اكتملت مع تنبيهات',
  failed: 'فشلت',
};

export interface BackupFileRecord {
  /** path inside the archive, e.g. `files/ab/cd/<sha256>` */
  path: string;
  file_id: string;
  sha256: string;
  size: number;
}

/** manifest.json inside every backup archive */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  backup_id: string;
  app_version: string;
  created_at: number;
  /** archive layout root folder */
  root: string;
  db: {
    path: string;
    sha256: string;
    size: number;
    /** applied migrations at snapshot time (name + checksum) */
    migrations: Array<{ name: string; checksum: string }>;
    /** rows per table (FTS shadow tables excluded) */
    row_counts: Record<string, number>;
    /** sync change-feed head at snapshot time (the restored server starts its epoch here) */
    sync_head_seq: number;
    server_epoch: string | null;
  };
  files: BackupFileRecord[];
  /** referenced by the database but absent / damaged in the live file store at backup time */
  files_missing: Array<{ file_id: string; sha256: string; reason: string }>;
  /** never part of a backup */
  excluded: string[];
}

export interface BackupView {
  id: string;
  file_name: string;
  status: BackupStatus;
  status_label_ar: string;
  origin: 'api' | 'cli';
  size: number | null;
  sha256: string | null;
  created_at: number;
  finished_at: number | null;
  summary: { tables: number; rows: number; files: number; file_bytes: number; migrations: number } | null;
  warnings_ar: string[];
  error_ar: string | null;
  job: JobView | null;
  verification: { status: 'passed' | 'failed'; verified_at: number; summary_ar: string; checks_failed: string[] } | null;
  /** authenticated download (only for finished archives that exist) */
  download_url: string | null;
}

export interface BackupsListResponse {
  backups: BackupView[];
  included_ar: string[];
  excluded_ar: string[];
  /** where the archives live and why a copy elsewhere is needed */
  storage_note_ar: string;
}

export interface BackupCreateResponse {
  backup: BackupView;
}

export interface RestoreCheck {
  /** machine name, e.g. `integrity_check`, `file_hashes`, `row_counts` */
  name: string;
  ok: boolean;
  /** Arabic, specific */
  detail_ar: string;
  details?: unknown;
}

export interface RestoreReport {
  ok: boolean;
  backup_id: string | null;
  backup_created_at: number | null;
  app_version: string | null;
  checks: RestoreCheck[];
  started_at: number;
  finished_at: number;
  /** verification happened in a separate temporary directory, removed afterwards unless kept */
  work_dir: string | null;
  /** set only for `--target` restores */
  restored_to: string | null;
}

// ───────────────────────────── export (§46) ─────────────────────────────
// 'docx' (track F5): Word document built on the server (Study Book, notes, questions, a source's text)
export const EXPORT_FORMATS = ['md', 'json', 'html', 'docx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_FORMAT_FORMAT = 'medlevo-export-1' as const;

export type ExportKind = 'source' | 'artifact' | 'notes' | 'questions' | 'all';

/** `manifest` of every JSON export: what was exported, at which version, with content hashes. */
export interface ExportManifest {
  format: typeof EXPORT_FORMAT_FORMAT;
  kind: ExportKind;
  exported_at: number;
  app_version: string;
  entities: Array<{ type: string; id: string; version: number | string | null; sha256: string }>;
  /** files referenced (not embedded): identify them by content hash */
  files: Array<{ file_id: string; sha256: string; size: number; mime: string; role: string }>;
  notes_ar: string[];
}

/** Capability-aware description of the export formats (shown before exporting). */
export interface ExportFormatsResponse {
  formats: Array<{ format: ExportFormat; label_ar: string; note_ar: string }>;
  /** PDF is produced by printing the HTML export in the browser — said plainly */
  pdf_note_ar: string;
  /** other formats with their honest state */
  other: Array<{ key: string; label_ar: string; available: boolean; reason_ar: string | null }>;
}
