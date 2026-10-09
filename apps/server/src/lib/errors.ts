// Application errors. Messages are Arabic, specific and actionable (§56). They never contain
// stack traces, file paths, SQL, or secrets — the global error handler only emits code/message/details.
import type { ErrorCode } from '@medlevo/shared';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly messageAr: string;
  readonly status: number;
  readonly details: unknown;
  /** extra response headers (e.g. Retry-After) */
  readonly headers: Record<string, string> | undefined;

  constructor(code: ErrorCode, messageAr: string, status = 400, details?: unknown, headers?: Record<string, string>) {
    super(`${code}: ${messageAr}`);
    this.name = 'AppError';
    this.code = code;
    this.messageAr = messageAr;
    this.status = status;
    this.details = details;
    this.headers = headers;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Common, reusable errors with consistent Arabic copy. */
export const Errors = {
  notFound: (whatAr = 'العنصر') => new AppError('NOT_FOUND', `${whatAr} غير موجود.`, 404),
  unauthenticated: () => new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401),
  csrf: (reasonAr: string) => new AppError('CSRF_FAILED', reasonAr, 403),
  conflict: (messageAr: string, details?: unknown) => new AppError('CONFLICT', messageAr, 409, details),
  rateLimited: (retryAfterSec: number, messageAr?: string) =>
    new AppError(
      'RATE_LIMITED',
      messageAr ?? `محاولات كثيرة خلال وقت قصير. انتظر ${formatWaitAr(retryAfterSec)} ثم أعد المحاولة.`,
      429,
      { retry_after_seconds: retryAfterSec },
      { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSec))) },
    ),
  featureDisabled: (messageAr: string) => new AppError('FEATURE_DISABLED', messageAr, 409),
  internal: () =>
    new AppError('INTERNAL', 'حدث خطأ داخلي غير متوقع في الخادم. أعد المحاولة، وإذا تكرر فراجع سجل الخادم.', 500),
};

export function formatWaitAr(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} ثانية`;
  const m = Math.ceil(s / 60);
  if (m < 60) return m === 1 ? 'دقيقة واحدة' : m === 2 ? 'دقيقتين' : `${m} دقائق`;
  const h = Math.ceil(m / 60);
  return h === 1 ? 'ساعة واحدة' : `${h} ساعات`;
}

export interface JobErrorOptions {
  /** retryable → exponential backoff and another attempt (until max attempts) */
  retryable: boolean;
  /** the job cannot continue until the owner acts (status waiting_for_input) */
  waitForInput?: boolean;
  details?: unknown;
}

/**
 * Error thrown by job handlers. `code` is a job-specific machine code (e.g. PDF_INVALID, OCR_TIMEOUT);
 * `messageAr` is shown to the owner and must say what failed and what to do.
 */
export class JobError extends Error {
  readonly code: string;
  readonly messageAr: string;
  readonly retryable: boolean;
  readonly waitForInput: boolean;
  readonly details: unknown;

  constructor(code: string, messageAr: string, opts: JobErrorOptions) {
    super(`${code}: ${messageAr}`);
    this.name = 'JobError';
    this.code = code;
    this.messageAr = messageAr;
    this.retryable = opts.retryable;
    this.waitForInput = opts.waitForInput ?? false;
    this.details = opts.details;
  }
}

export function isJobError(e: unknown): e is JobError {
  return e instanceof JobError;
}
