// Response/request shapes of the core server API (auth, files, jobs, audit, sync, ai, settings).
// The server types its responses with these, and the web client consumes them — one contract.
import type { JobStatus } from './enums';
import type { OwnerSettings } from './settings';

// ───────── auth (/api/auth) ─────────
export const SESSION_COOKIE_NAME = 'medlevo_session';
export const CSRF_HEADER_NAME = 'x-medlevo-csrf';
export const RECOVERY_CODE_COUNT = 10;

export interface SessionInfo {
  id: string;
  device_label: string | null;
  device_id: string | null;
  user_agent: string | null;
  ip: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  current: boolean;
}

export interface AuthStatusResponse {
  /** true until the single owner account has been created */
  setup_required: boolean;
  authenticated: boolean;
  owner: { username: string } | null;
  session: SessionInfo | null;
  /** only when authenticated */
  remaining_recovery_codes?: number;
  password_min_length: number;
  /**
   * (track D1, additive) true while no owner exists AND setup needs a setup token: the server listens on a
   * non-loopback address / behind a proxy, or MEDLEVO_SETUP_TOKEN is set. The token is MEDLEVO_SETUP_TOKEN or a
   * one-time token printed to the server log at boot (never stored in the database).
   */
  setup_token_required?: boolean;
}

export interface SetupRequest {
  username: string;
  password: string;
  device_label?: string;
  device_id?: string;
  /** (track D1, additive) required when AuthStatusResponse.setup_token_required */
  setup_token?: string;
}
export interface LoginRequest {
  username: string;
  password: string;
  device_label?: string;
  device_id?: string;
}
export interface SetupResponse {
  ok: true;
  /** shown ONCE; only hashes are stored */
  recovery_codes: string[];
  session: SessionInfo;
  notice_ar: string;
}
export interface LoginResponse {
  ok: true;
  session: SessionInfo;
}
export interface SessionsResponse {
  sessions: SessionInfo[];
}
export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}
export interface RecoverRequest {
  username: string;
  recovery_code: string;
  new_password: string;
}
export interface RecoverResponse {
  ok: true;
  remaining_recovery_codes: number;
  notice_ar: string;
}
export interface RecoveryCodesResponse {
  recovery_codes: string[];
  notice_ar: string;
}

// ───────── files (/api/files) ─────────
export interface StoredFileView {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  original_name: string | null;
  created_at: number;
}
export interface FileTokenResponse {
  token: string;
  /** relative URL usable without the session cookie until expires_at */
  url: string;
  expires_at: number;
}

// ───────── jobs (/api/jobs) ─────────
export interface JobProgress {
  stage: string;
  done?: number;
  total?: number;
  unit?: string | null;
}
export interface JobErrorView {
  code: string;
  /** Arabic, actionable; never a stack trace */
  message: string;
  retryable: boolean;
}
export interface JobView {
  id: string;
  kind: string;
  status: JobStatus;
  status_label_ar: string;
  progress: JobProgress | null;
  attempts: number;
  max_attempts: number;
  error: JobErrorView | null;
  idempotency_key: string | null;
  run_after: number;
  parent_job_id: string | null;
  version: string;
  created_at: number;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  cancel_requested_at: number | null;
  /** number of persisted checkpoints (completed steps) */
  checkpoints: number;
  input?: unknown;
  output?: unknown;
}
export interface JobsListResponse {
  jobs: JobView[];
  next_before: string | null;
}
export const JOB_STATUS_LABELS_AR: Record<JobStatus, string> = {
  queued: 'في الانتظار',
  running: 'قيد التنفيذ',
  waiting_for_input: 'بانتظار إجراء منك',
  partial: 'اكتمل جزئيًا',
  completed: 'اكتمل',
  failed: 'فشل',
  cancelled: 'أُلغي',
};

// ───────── audit (/api/audit) ─────────
export interface AuditEntry {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  summary: string | null;
  before: unknown;
  after: unknown;
  actor: string;
  job_id: string | null;
  created_at: number;
}
export interface AuditListResponse {
  entries: AuditEntry[];
  next_before: string | null;
}

// ───────── sync (/api/sync) ─────────
export const SYNC_OPS = ['upsert', 'delete', 'append'] as const;
export type SyncOpKind = (typeof SYNC_OPS)[number];
export const SYNC_RESULTS = ['applied', 'merged', 'conflict_kept_both', 'duplicate', 'rejected'] as const;
export type SyncResult = (typeof SYNC_RESULTS)[number];

export interface SyncOp {
  /** client-generated ULID; the same logical write always carries the same op_id */
  op_id: string;
  device_id: string;
  entity_type: string;
  /** client-generated ULID of the entity */
  entity_id: string;
  op: SyncOpKind;
  base_rev?: number | null;
  payload: unknown;
  client_ts?: number;
}
export interface SyncOpResult {
  op_id: string;
  result: SyncResult;
  /** for result === 'duplicate': what happened the first time */
  original_result?: SyncResult;
  entity?: unknown;
  detail?: string;
  /** true → the server failed transiently; keep the op in the outbox and retry later */
  retryable?: boolean;
  /**
   * (track D1, additive) change-feed head right after this op was recorded. A client keeps it with the
   * acknowledged op: after a server restore (new server_epoch whose epoch_base_seq is below it) the op is not
   * in the restored data and is sent again.
   */
  server_seq?: number;
}
export interface SyncPushRequest {
  ops: SyncOp[];
  /**
   * (track D1, additive) the server data epoch this device last pulled from. When the server's current epoch is
   * different (its data was restored from a backup), the push is refused with 409 CONFLICT
   * `details.server_epoch_changed` and NOTHING is applied: the device first resets its pull cursor and re-queues
   * the writes the restored server lacks, then pushes again. Omitted by older clients (no check).
   */
  server_epoch?: string;
}
export interface SyncPushResponse {
  results: SyncOpResult[];
  /** latest change sequence after applying */
  server_seq: number;
}
export interface SyncChange {
  seq: number;
  entity_type: string;
  entity_id: string;
  /** null → deleted / not available */
  entity: unknown | null;
}
export interface SyncPullResponse {
  changes: SyncChange[];
  next_since: number;
  has_more: boolean;
  /**
   * (track D1, additive) id of the server's data epoch. It changes when the server's data is replaced by a
   * restore: the client then resets its pull cursor (a restored server may be BEHIND the client's cursor) and
   * pulls everything again.
   */
  server_epoch?: string;
  /** change-feed head when this epoch started (0 for a server that was never restored) */
  epoch_base_seq?: number;
  /** current change-feed head (a client cursor above it means the server's data went back in time) */
  head_seq?: number;
}

// ───────── ai (/api/ai) ─────────
export const AI_TASKS = [
  'explain', 'study_book', 'chat', 'summarize', 'compare', 'verify_support', 'generate_questions',
  'validate_question', 'vision_figure', 'grade_written', 'case_sim', 'classify', 'embed', 'transcribe',
  // (track F4) handwriting recognition of a cropped picture of pen strokes (vision)
  'ink_recognize',
] as const;
export type AiTask = (typeof AI_TASKS)[number];

export interface AiTaskStatus {
  available: boolean;
  model?: string;
  reason_ar?: string;
}
export interface AiBudgetStatus {
  monthly_usd: number;
  spent_usd: number;
  remaining_usd: number;
  /** epoch ms of the start of the current budget month (owner timezone) */
  period_start: number;
  /** costs are estimates computed from token usage, not provider invoices */
  estimated: true;
}
export interface AiStatusResponse {
  configured: boolean;
  provider?: string;
  tasks: Record<AiTask, AiTaskStatus>;
  budget: AiBudgetStatus;
}

// ───────── settings (/api/settings) ─────────
export interface SettingsResponse {
  settings: OwnerSettings;
}

// ───────── health ─────────
export interface HealthResponse {
  ok: boolean;
  version: string;
  time: number;
}
