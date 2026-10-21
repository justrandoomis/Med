// The client-version gate and the session-user check (ARCHITECTURE_DELTA §4.5, §8.7; ADR-0003 §3.7; P1-T1 step 3).
//
// 1. Old clients. Every request of the multi-user web client carries `x-medlevo-client: <app version>`. A client of
//    R1-a or earlier sends none; its IndexedDB `medlevo` holds the single owner's outbox. If such a stale tab (or an
//    un-updated PWA) ran under ANOTHER account's session — a second user signed in on the same browser — it would push
//    the owner's queued writes, or pull that account's data into the owner's local database. So a request without a
//    supported version is answered `426 CLIENT_TOO_OLD` when it could write or read data as an account other than
//    user #1:
//      * every mutation (non-GET/HEAD/OPTIONS), and every GET that asks for JSON (`Accept: application/json` — what the
//        old client's fetch wrapper sends; images, audio and downloads loaded by the browser itself never do);
//      * NOT for user #1's own sessions: user #1 is the owner migrated from the single-owner installation (or the
//        first-run account), whose local data the old client holds anyway — the owner's stale tab keeps working until
//        it updates;
//      * signing in: an old client may sign in only as user #1 (checked in the login handler, after the password);
//      * public routes that hand out no account data (health, status, sign-out, recover, the signed file token) pass.
// 2. Another account in another tab. Two tabs share ONE session cookie. The web client sends `x-medlevo-user: <the
//    account the page belongs to>`; when it names another account than the session's, the request is refused with 401
//    and nothing is applied — a tab of user A never pushes A's outbox under user B's session.
import { CLIENT_VERSION_HEADER_NAME, isSupportedClientVersion, MIN_CLIENT_VERSION, USER_HEADER_NAME } from '@medlevo/shared';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';

export const CLIENT_TOO_OLD_AR =
  'هذه نسخة قديمة من التطبيق على هذا الجهاز ولا تعمل مع الحسابات المتعددة. اضغط «تحديث الآن» في إشعار التحديث، أو أغلق كل نوافذ التطبيق ثم افتحه من جديد. ما كتبته محفوظ على جهازك ولن يُرسل باسم حساب آخر.';
export const SESSION_USER_CHANGED_AR =
  'سُجّل الدخول بحساب آخر في نافذة أخرى من هذا المتصفح. لم يُرسل شيء من هذه النافذة باسمه؛ ما كتبته فيها محفوظ على جهازك ويُرسل حين تدخل بحسابك من جديد.';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function clientTooOldError(): AppError {
  return new AppError('CLIENT_TOO_OLD', CLIENT_TOO_OLD_AR, 426, { min_version: MIN_CLIENT_VERSION });
}

/** Does this request lack a supported client version? */
export function isOldClient(req: FastifyRequest): boolean {
  const v = req.headers[CLIENT_VERSION_HEADER_NAME];
  return !isSupportedClientVersion(Array.isArray(v) ? v[0] : v);
}

/** Could this request write data, or read account data into a client's local database? */
export function isDataRequest(req: FastifyRequest): boolean {
  if (!SAFE.has(req.method)) return true;
  if (req.method !== 'GET') return false;
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.toLowerCase().includes('application/json');
}

/** User #1 — the first account: the owner migrated from the single-owner installation, or the first-run account. */
export function isUserOne(ctx: AppContext, userId: string): boolean {
  return ctx.system.users.firstUserIdInternal() === userId;
}

/** Public routes an old client may use whatever its version (they hand out or change no account data). */
const OLD_CLIENT_ALLOWED = new Set(['GET /api/health', 'HEAD /api/health', 'GET /api/auth/status', 'HEAD /api/auth/status', 'POST /api/auth/logout', 'POST /api/auth/recover', 'GET /api/files/t/:token', 'HEAD /api/files/t/:token', 'GET /api/maintenance', 'HEAD /api/maintenance']);

/**
 * Called by the auth guard once the session is resolved. Throws 426 for an old client acting as an account other than
 * user #1, and 401 when the page names another account than the session's.
 */
export function enforceClientGate(ctx: AppContext, req: FastifyRequest, routeKey: string, isPublic: boolean): void {
  const named = req.headers[USER_HEADER_NAME];
  const pageUser = Array.isArray(named) ? named[0] : named;
  if (typeof pageUser === 'string' && pageUser.length > 0 && req.auth && pageUser !== req.auth.user.id && !isPublic) {
    throw new AppError('UNAUTHENTICATED', SESSION_USER_CHANGED_AR, 401, { session_user_changed: true });
  }
  if (OLD_CLIENT_ALLOWED.has(routeKey) || routeKey === 'POST /api/auth/login' || routeKey === 'POST /api/auth/setup') return;
  if (!isOldClient(req) || !isDataRequest(req)) return;
  if (!req.auth) return; // no session: the auth guard answers 401 (or the public route runs)
  if (isUserOne(ctx, req.auth.user.id)) return;
  throw clientTooOldError();
}
