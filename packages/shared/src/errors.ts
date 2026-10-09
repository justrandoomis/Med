// API error envelope. Messages are actionable and never leak server internals or secrets.
export const ERROR_CODES = [
  'BAD_REQUEST', 'VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'CONFLICT',
  'RATE_LIMITED', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_FORMAT', 'SETUP_REQUIRED', 'ALREADY_SET_UP',
  'AI_NOT_CONFIGURED', 'AI_BUDGET_EXCEEDED', 'AI_PROVIDER_ERROR', 'OUT_OF_SCOPE', 'INSUFFICIENT_EVIDENCE',
  'SCHEMA_REJECTED', 'INVALID_EVIDENCE', 'FEATURE_DISABLED', 'OFFLINE_REQUIRES_CONNECTION', 'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

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
