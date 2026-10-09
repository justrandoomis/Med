// Fetch wrapper for /api (ARCHITECTURE §4).
//  - same-origin credentials (HttpOnly session cookie)
//  - `x-medlevo-csrf: 1` on every mutation (non-GET/HEAD)
//  - JSON in / JSON out
//  - server errors (ApiErrorBody) → ApiError with the server's Arabic message
//  - network failures → ApiError with `offline: true` (never confused with a server answer)
import { isApiErrorBody, type ErrorCode } from '@medlevo/shared';

/** Client-side error codes in addition to the server's ErrorCode list. */
export type ClientErrorCode = 'OFFLINE' | 'NETWORK_ERROR' | 'TIMEOUT' | 'BAD_RESPONSE' | 'HTTP_ERROR';

export class ApiError extends Error {
  readonly code: ErrorCode | ClientErrorCode;
  /** HTTP status; 0 for network failures. */
  readonly status: number;
  readonly details?: unknown;
  /** True when the request never reached the server (no connection, DNS, server down, timeout). */
  readonly offline: boolean;

  constructor(opts: { code: ErrorCode | ClientErrorCode; message: string; status: number; details?: unknown; offline?: boolean }) {
    super(opts.message);
    this.name = 'ApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
    this.offline = opts.offline ?? false;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Arabic, actionable message for any thrown value. */
export function errorMessage(e: unknown, fallback = 'حدث خطأ غير متوقع. حاول مرة أخرى.'): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message && /[؀-ۿ]/.test(e.message)) return e.message;
  return fallback;
}

const STATUS_MESSAGES_AR: Record<number, string> = {
  400: 'الطلب غير صالح. راجع البيانات المدخلة.',
  401: 'انتهت الجلسة. سجّل الدخول مرة أخرى.',
  403: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
  404: 'العنصر المطلوب غير موجود أو نُقل.',
  409: 'تعارض مع حالة أحدث على الخادم. حدّث الصفحة ثم حاول مجددًا.',
  413: 'الملف أكبر من الحد المسموح.',
  415: 'صيغة الملف غير مدعومة.',
  429: 'محاولات كثيرة في وقت قصير. انتظر قليلًا ثم حاول مجددًا.',
  500: 'حدث خطأ في الخادم. حاول مرة أخرى بعد قليل.',
  502: 'الخادم غير متاح حاليًا. حاول مرة أخرى بعد قليل.',
  503: 'الخادم مشغول أو قيد الصيانة. حاول مرة أخرى بعد قليل.',
  504: 'انتهت مهلة الاتصال بالخادم. حاول مرة أخرى.',
};

export const OFFLINE_MESSAGE_AR = 'لا يوجد اتصال بالإنترنت. ما تكتبه يُحفظ على هذا الجهاز ويُزامَن عند عودة الاتصال.';
export const UNREACHABLE_MESSAGE_AR = 'تعذّر الوصول إلى الخادم. تحقّق من الاتصال ثم حاول مرة أخرى.';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Abort after this many ms (→ ApiError TIMEOUT, offline: true). */
  timeoutMs?: number;
  /** Don't trigger the global "session expired" handler on 401 (auth screens). */
  skipAuthRedirect?: boolean;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike | null = null;
let unauthenticatedHandler: (() => void) | null = null;
const MUTATION = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Test hook / alternative transport. Pass null to restore the global fetch. */
export function setFetchImpl(fn: FetchLike | null): void {
  fetchImpl = fn;
}

/** Called once when an authenticated request returns 401 (the router sends the owner to /login). */
export function setUnauthenticatedHandler(fn: (() => void) | null): void {
  unauthenticatedHandler = fn;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = path.startsWith('/api') || /^https?:/.test(path) ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export async function request<T = unknown>(method: HttpMethod, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (typeof FormData !== 'undefined' && body instanceof FormData) payload = body;
    else if (typeof Blob !== 'undefined' && body instanceof Blob) payload = body;
    else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  if (MUTATION.has(method)) headers['x-medlevo-csrf'] = '1';

  let timeoutCtrl: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let signal = opts.signal;
  if (opts.timeoutMs) {
    timeoutCtrl = new AbortController();
    timer = setTimeout(() => timeoutCtrl!.abort(), opts.timeoutMs);
    signal = opts.signal ? anySignal([opts.signal, timeoutCtrl.signal]) : timeoutCtrl.signal;
  }

  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(buildUrl(path, opts.query), {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (opts.signal?.aborted) throw err; // caller cancelled: propagate the AbortError untouched
    if (timeoutCtrl?.signal.aborted) {
      throw new ApiError({ code: 'TIMEOUT', status: 0, offline: true, message: 'انتهت مهلة الاتصال بالخادم. حاول مرة أخرى.' });
    }
    const offline = !isOnline();
    throw new ApiError({
      code: offline ? 'OFFLINE' : 'NETWORK_ERROR',
      status: 0,
      offline: true,
      message: offline ? OFFLINE_MESSAGE_AR : UNREACHABLE_MESSAGE_AR,
      details: err instanceof Error ? err.message : undefined,
    });
  }
  if (timer) clearTimeout(timer);

  if (res.status === 204 || method === 'HEAD') return undefined as T;

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    if (isApiErrorBody(data)) {
      const err = new ApiError({ code: data.error.code, message: data.error.message || STATUS_MESSAGES_AR[res.status] || 'تعذّر إكمال الطلب.', status: res.status, details: data.error.details });
      if (res.status === 401 && !opts.skipAuthRedirect) unauthenticatedHandler?.();
      throw err;
    }
    if (res.status === 401 && !opts.skipAuthRedirect) unauthenticatedHandler?.();
    throw new ApiError({
      code: res.status === 401 ? 'UNAUTHENTICATED' : res.status === 404 ? 'NOT_FOUND' : res.status >= 500 ? 'INTERNAL' : 'HTTP_ERROR',
      status: res.status,
      message: STATUS_MESSAGES_AR[res.status] ?? `تعذّر إكمال الطلب (رمز ${res.status}).`,
    });
  }

  if (text && data === undefined) {
    throw new ApiError({ code: 'BAD_RESPONSE', status: res.status, message: 'وصل رد غير متوقع من الخادم. حدّث الصفحة وحاول مجددًا.' });
  }
  return data as T;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

export const api = {
  get: <T = unknown>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body ?? {}, opts),
  put: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body ?? {}, opts),
  patch: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body ?? {}, opts),
  del: <T = unknown>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};

/**
 * Per-field messages from a VALIDATION_FAILED error (`details.issues[].path/message`), keyed by
 * field path, e.g. { password: 'النص أقصر من 12 حرفًا.' }.
 */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || !e.details || typeof e.details !== 'object') return {};
  const issues = (e.details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return {};
  const out: Record<string, string> = {};
  for (const i of issues) {
    if (i && typeof i === 'object' && typeof (i as { path?: unknown }).path === 'string' && typeof (i as { message?: unknown }).message === 'string') {
      const path = (i as { path: string }).path;
      if (!out[path]) out[path] = (i as { message: string }).message;
    }
  }
  return out;
}
