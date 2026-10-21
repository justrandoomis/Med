// API error envelope. Messages are actionable and never leak server internals or secrets.
export const ERROR_CODES = [
  'BAD_REQUEST', 'VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'CONFLICT',
  'RATE_LIMITED', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_FORMAT', 'SETUP_REQUIRED', 'ALREADY_SET_UP',
  'AI_NOT_CONFIGURED', 'AI_BUDGET_EXCEEDED', 'AI_PROVIDER_ERROR', 'OUT_OF_SCOPE', 'INSUFFICIENT_EVIDENCE',
  'SCHEMA_REJECTED', 'INVALID_EVIDENCE', 'FEATURE_DISABLED', 'OFFLINE_REQUIRES_CONNECTION', 'INTERNAL',
  // Academic OS, Phase 1 (ARCHITECTURE_DELTA §7.1) — appended only, never reordered or renamed
  'MEMBERSHIP_REQUIRED', 'MEMBERSHIP_PENDING', 'LAYER_READ_ONLY', 'PUBLICATION_FROZEN', 'CONSENT_REQUIRED',
  'QUOTA_EXCEEDED', 'JOIN_CODE_INVALID', 'SPACE_UNAVAILABLE', 'CLIENT_TOO_OLD', 'LOGIN_SLOWED', 'NO_TENANT_BOUND',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * HTTP status of each Academic OS Phase 1 code (ARCHITECTURE_DELTA §7.1). Messages stay Arabic and actionable:
 *  * MEMBERSHIP_REQUIRED — a visible channel the viewer has not joined (the join flow is offered);
 *  * MEMBERSHIP_PENDING — the join request is waiting for approval;
 *  * LAYER_READ_ONLY — a REST write to a followed or snapshot layer (sync answers with `detail_code` instead);
 *  * PUBLICATION_FROZEN — an edit of a published version (republish instead);
 *  * CONSENT_REQUIRED — a missing consent record; `details.kind` names it;
 *  * QUOTA_EXCEEDED — storage, AI, ASR or room quota; `details` = {kind, used, limit, resets_at};
 *  * JOIN_CODE_INVALID — wrong, expired, revoked or exhausted code (one generic message, rate-limited);
 *  * SPACE_UNAVAILABLE — the space is migrating, or read-only for writes;
 *  * CLIENT_TOO_OLD — a pre-multi-user client; the app shows «حدّث التطبيق» and updates its service worker;
 *  * LOGIN_SLOWED — progressive per-account sign-in delay; `details.retry_after_s`; a recovery code bypasses it;
 *  * NO_TENANT_BOUND — an internal bug (database access without a bound tenant): never user-facing, logged.
 */
export const ACADEMIC_ERROR_HTTP_STATUS = {
  MEMBERSHIP_REQUIRED: 403,
  MEMBERSHIP_PENDING: 403,
  LAYER_READ_ONLY: 409,
  PUBLICATION_FROZEN: 409,
  CONSENT_REQUIRED: 409,
  QUOTA_EXCEEDED: 409,
  JOIN_CODE_INVALID: 400,
  SPACE_UNAVAILABLE: 503,
  CLIENT_TOO_OLD: 426,
  LOGIN_SLOWED: 429,
  NO_TENANT_BOUND: 500,
} as const satisfies Partial<Record<ErrorCode, number>>;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string; // Arabic, human readable, actionable
    details?: unknown;
  };
}

export function isApiErrorBody(v: unknown): v is ApiErrorBody {
  return typeof v === 'object' && v !== null && 'error' in v && typeof (v as ApiErrorBody).error?.code === 'string';
}
