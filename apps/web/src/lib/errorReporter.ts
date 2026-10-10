// Client error tracking (§56): uncaught errors, unhandled promise rejections and route errors are REDACTED here
// (packages/shared redactClientError: no document / note text, no query strings, no tokens; stack frames reduced to
// code locations), grouped by fingerprint with a count, and sent in small batches to POST /api/control/client-errors
// with the owner's session. The server redacts again and keeps them 30 days. Nothing is ever written to the console
// (the reporter must not create the noise it reports), its own failures are dropped silently, and it never retries
// forever: offline → kept in memory for the next flush (bounded); 401 / 403 → dropped.
import { redactClientError, type ClientErrorKind, type ClientErrorReport } from '@medlevo/shared';

export const ERROR_ENDPOINT = '/api/control/client-errors';
const MAX_PENDING = 20;
/** distinct problems reported per page session (a loop throwing every frame must not flood the server) */
const MAX_DISTINCT_PER_SESSION = 30;

/** Benign browser noise that is not an application error. */
const IGNORED = [/ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i, /^Script error\.?$/i, /AbortError/];

export interface ErrorReporterOptions {
  endpoint?: string;
  /** ms between automatic flushes (default 5000) */
  flushMs?: number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  appVersion?: string;
  /** current app path (default: location.pathname) — query and hash are never read */
  route?: () => string;
  /** false → keep the batch for later instead of sending (e.g. signed out: the sink needs the owner session) */
  canSend?: () => boolean;
}

export interface ErrorReporter {
  report(kind: ClientErrorKind, error: unknown, extra?: { message?: string }): void;
  flush(opts?: { keepalive?: boolean }): Promise<void>;
  pending(): number;
  dispose(): void;
}

function describe(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) return { message: `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error.message}`, stack: error.stack ?? null };
  if (typeof error === 'string') return { message: error, stack: null };
  if (error && typeof error === 'object' && 'message' in error) return { message: String((error as { message: unknown }).message), stack: null };
  return { message: `non-error value (${typeof error})`, stack: null };
}

export function createErrorReporter(opts: ErrorReporterOptions = {}): ErrorReporter {
  const endpoint = opts.endpoint ?? ERROR_ENDPOINT;
  const doFetch = opts.fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init));
  const route = opts.route ?? (() => (typeof location !== 'undefined' ? location.pathname : '/'));
  const queue = new Map<string, ClientErrorReport & { count: number }>();
  const seen = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let sending = false;
  let disposed = false;

  const reporter: ErrorReporter = {
    report(kind, error, extra) {
      if (disposed) return;
      try {
        const d = describe(error);
        const message = extra?.message ?? d.message;
        if (IGNORED.some((re) => re.test(message))) return;
        const r = redactClientError({ kind, message, stack: d.stack, route: route(), app_version: opts.appVersion ?? null });
        const key = `${r.kind}\n${r.message.replace(/\d+/g, '#')}\n${r.stack?.split('\n')[0] ?? ''}`;
        const existing = queue.get(key);
        if (existing) {
          existing.count++;
          return;
        }
        if (queue.size >= MAX_PENDING) return;
        if (!seen.has(key)) {
          if (seen.size >= MAX_DISTINCT_PER_SESSION) return;
          seen.add(key);
        }
        queue.set(key, { ...r, count: 1 });
      } catch {
        // the reporter never throws into the page
      }
    },
    async flush(flushOpts = {}) {
      if (sending || queue.size === 0) return;
      if (opts.canSend && !opts.canSend()) return;
      sending = true;
      const batch = [...queue.entries()];
      queue.clear();
      try {
        const res = await doFetch(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: flushOpts.keepalive ?? false,
          headers: { 'content-type': 'application/json', 'x-medlevo-csrf': '1' },
          body: JSON.stringify({ errors: batch.map(([, r]) => r) }),
        });
        // 2xx: delivered · 401/403/4xx: not ours to retry (signed out / refused) · 5xx: keep for the next flush
        if (res.status >= 500) for (const [k, r] of batch) if (queue.size < MAX_PENDING) queue.set(k, r);
      } catch {
        // offline: keep (bounded) for the next flush
        for (const [k, r] of batch) if (queue.size < MAX_PENDING && !queue.has(k)) queue.set(k, r);
      } finally {
        sending = false;
      }
    },
    pending: () => queue.size,
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      queue.clear();
    },
  };
  const every = opts.flushMs ?? 5000;
  if (every > 0) timer = setInterval(() => void reporter.flush(), every);
  return reporter;
}

let installed: { reporter: ErrorReporter; remove: () => void } | null = null;

/** Install the window handlers once (main.tsx). Returns the reporter (tests inject their own fetch). */
export function installErrorReporter(win: Window = window, opts: ErrorReporterOptions = {}): ErrorReporter {
  if (installed) return installed.reporter;
  const reporter = createErrorReporter({ appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined, ...opts });
  const onError = (e: ErrorEvent) => {
    // resource load failures (img/script tags) do not reach a non-capturing window listener; this is a script error
    reporter.report('error', e.error ?? e.message, e.error ? undefined : { message: e.message || 'error event without details' });
  };
  const onRejection = (e: PromiseRejectionEvent) => reporter.report('unhandledrejection', e.reason);
  const onHide = () => void reporter.flush({ keepalive: true });
  const onVisibility = () => {
    if (win.document.visibilityState === 'hidden') onHide();
  };
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  win.addEventListener('pagehide', onHide);
  win.document.addEventListener('visibilitychange', onVisibility);
  installed = {
    reporter,
    remove: () => {
      win.removeEventListener('error', onError);
      win.removeEventListener('unhandledrejection', onRejection);
      win.removeEventListener('pagehide', onHide);
      win.document.removeEventListener('visibilitychange', onVisibility);
      reporter.dispose();
    },
  };
  return reporter;
}

/** Report an error caught by the app itself (route error screens). No-op when the reporter is not installed. */
export function reportError(kind: ClientErrorKind, error: unknown): void {
  installed?.reporter.report(kind, error);
}

/** Tests: remove the handlers and forget the singleton. */
export function uninstallErrorReporter(): void {
  installed?.remove();
  installed = null;
}
