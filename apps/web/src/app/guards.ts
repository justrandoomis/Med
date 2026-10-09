import { redirect, type LoaderFunctionArgs } from 'react-router-dom';
import { fetchAuthStatus } from '../lib/auth';
import type { OwnerGateData } from './routeTypes';

/** Fallback when the server cannot be asked (the server's value always wins when online). */
const DEFAULT_MIN_PASSWORD = 12;

function nextParam(request: Request): string {
  const url = new URL(request.url);
  const next = url.pathname + url.search;
  return next === '/' ? '' : `?next=${encodeURIComponent(next)}`;
}

/** Only same-app paths are allowed as post-login targets (no open redirects). */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.startsWith('/login') || raw.startsWith('/setup') || raw.startsWith('/recover')) return '/';
  return raw;
}

/**
 * Gate for every authenticated route: setup → /setup, signed out → /login.
 * When the server is unreachable, the last known signed-in state of THIS device lets the owner
 * keep studying offline (local-first); the server still enforces auth on every API call.
 */
export async function ownerGateLoader({ request }: LoaderFunctionArgs): Promise<OwnerGateData> {
  const r = await fetchAuthStatus();
  if (r.kind === 'online') {
    const s = r.status;
    if (s.setup_required) throw redirect('/setup');
    if (!s.authenticated) throw redirect(`/login${nextParam(request)}`);
    return {
      mode: 'online',
      username: s.owner?.username ?? null,
      remainingRecoveryCodes: s.remaining_recovery_codes ?? null,
      sessionId: s.session?.id ?? null,
      passwordMinLength: s.password_min_length,
    };
  }
  if (r.cached?.authenticated) {
    return {
      mode: 'offline',
      username: r.cached.username,
      remainingRecoveryCodes: null,
      sessionId: null,
      passwordMinLength: DEFAULT_MIN_PASSWORD,
      offlineMessage: r.message,
    };
  }
  throw new Response(r.message, { status: 503, statusText: 'offline' });
}

export interface PublicGateData {
  offline: boolean;
  message?: string;
  passwordMinLength: number;
}

export async function setupLoader(): Promise<PublicGateData> {
  const r = await fetchAuthStatus({ force: true });
  if (r.kind === 'offline') return { offline: true, message: r.message, passwordMinLength: DEFAULT_MIN_PASSWORD };
  if (!r.status.setup_required) throw redirect(r.status.authenticated ? '/' : '/login');
  return { offline: false, passwordMinLength: r.status.password_min_length };
}

export async function loginLoader({ request }: LoaderFunctionArgs): Promise<PublicGateData> {
  const r = await fetchAuthStatus({ force: true });
  if (r.kind === 'offline') return { offline: true, message: r.message, passwordMinLength: DEFAULT_MIN_PASSWORD };
  if (r.status.setup_required) throw redirect('/setup');
  if (r.status.authenticated) throw redirect(safeNext(new URL(request.url).searchParams.get('next')));
  return { offline: false, passwordMinLength: r.status.password_min_length };
}

export async function recoverLoader(): Promise<PublicGateData> {
  const r = await fetchAuthStatus({ force: true });
  if (r.kind === 'offline') return { offline: true, message: r.message, passwordMinLength: DEFAULT_MIN_PASSWORD };
  if (r.status.setup_required) throw redirect('/setup');
  return { offline: false, passwordMinLength: r.status.password_min_length };
}
