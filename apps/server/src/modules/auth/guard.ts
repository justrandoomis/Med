// Global request guard for /api/* (registered at the root, before any module):
//  1. CSRF: every non-GET/HEAD/OPTIONS /api request must carry `x-medlevo-csrf: 1`, and when an Origin
//     header is present it must be one of the configured origins (no CORS is enabled at all).
//  2. Session: resolves the owner session from the HttpOnly cookie (sliding expiry).
//  3. Auth: every /api route requires the owner session except the explicit PUBLIC_ROUTES.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '@medlevo/shared';
import type { AppConfig } from '../../config';
import type { AppContext } from '../../context';
import { Errors } from '../../lib/errors';
import { type SessionRow, SessionStore } from './sessions';

export interface RequestAuth {
  sessionId: string;
  session: SessionRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
}

/** METHOD + route pattern (as registered, including prefix). Everything else under /api needs a session. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/health',
  'HEAD /api/health',
  'GET /api/auth/status',
  'HEAD /api/auth/status',
  'POST /api/auth/setup',
  'POST /api/auth/login',
  'POST /api/auth/recover',
  // the signed short-lived token is the credential (see modules/files)
  'GET /api/files/t/:token',
  'HEAD /api/files/t/:token',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string, expiresAt: number): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: config.cookieSecure,
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/', secure: config.cookieSecure });
}

function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/api' || path.startsWith('/api/');
}

/** Decode %XX escapes (never throws). The router decodes paths, so `/%61pi/jobs` reaches `/api/jobs`. */
function decodePathLoose(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * True when the request must go through the API guard / API headers. Decided from the MATCHED ROUTE
 * (every server route is an API route — fail closed), and for unmatched requests from the raw AND the
 * percent-decoded path. Never from `req.url` alone: the router decodes `%61` → `a`, the raw URL does not.
 */
export function isApiRequest(req: FastifyRequest): boolean {
  if (req.routeOptions?.url) return true;
  const raw = req.url.split('?')[0] ?? '';
  return isApiPath(raw) || isApiPath(decodePathLoose(raw));
}

export function checkCsrf(req: FastifyRequest, config: AppConfig): void {
  if (SAFE_METHODS.has(req.method)) return;
  if (req.headers[CSRF_HEADER_NAME] !== '1') {
    throw Errors.csrf('رُفض الطلب لحمايتك من التزوير عبر المواقع (CSRF). حدّث الصفحة ثم أعد المحاولة.');
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
    throw Errors.csrf('رُفض الطلب لأنه صادر من أصل (Origin) غير مسموح.');
  }
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') {
    throw Errors.csrf('رُفض الطلب لأنه صادر من موقع آخر.');
  }
}

export function registerAuthGuard(app: FastifyInstance, ctx: AppContext): void {
  const sessions = new SessionStore(ctx.db, ctx.clock, ctx.config.auth.sessionTtlMs);
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req, reply) => {
    if (!isApiRequest(req)) return;
    checkCsrf(req, ctx.config);

    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (token) {
      const session = sessions.findActive(token);
      if (session) {
        req.auth = { sessionId: session.id, session };
        const refreshed = sessions.touch(session, req.ip ?? null);
        if (refreshed !== null) setSessionCookie(reply, ctx.config, token, refreshed);
      } else {
        clearSessionCookie(reply, ctx.config);
      }
    }

    const routeKey = `${req.method} ${req.routeOptions.url ?? ''}`;
    if (PUBLIC_ROUTES.has(routeKey)) return;
    if (!req.auth) throw Errors.unauthenticated();
  });
}
