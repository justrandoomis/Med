// Owner authentication client (/api/auth/*, shapes from packages/shared/src/api.ts).
import type {
  AuthStatusResponse,
  ChangePasswordRequest,
  LoginResponse,
  RecoverRequest,
  RecoverResponse,
  RecoveryCodesResponse,
  SessionsResponse,
  SetupResponse,
} from '@medlevo/shared';
import { api, isApiError } from './api';
import { describeDevice, getDeviceId } from './deviceId';

const LAST_AUTH_KEY = 'medlevo.lastAuth.v1';

export interface CachedAuth {
  authenticated: boolean;
  username: string | null;
  at: number;
}

function readLastAuth(): CachedAuth | null {
  try {
    const raw = window.localStorage.getItem(LAST_AUTH_KEY);
    return raw ? (JSON.parse(raw) as CachedAuth) : null;
  } catch {
    return null;
  }
}

function writeLastAuth(v: CachedAuth | null) {
  try {
    if (v) window.localStorage.setItem(LAST_AUTH_KEY, JSON.stringify(v));
    else window.localStorage.removeItem(LAST_AUTH_KEY);
  } catch {
    // ignore
  }
}

export type AuthGateResult =
  | { kind: 'online'; status: AuthStatusResponse }
  /** server unreachable: last known state from this device (local-first: the owner can keep studying offline) */
  | { kind: 'offline'; cached: CachedAuth | null; message: string };

let statusCache: { value: AuthStatusResponse; at: number } | null = null;
const STATUS_TTL_MS = 30_000;

/** Auth status with a short in-memory cache (route loaders call this on navigation). */
export async function fetchAuthStatus(opts: { force?: boolean } = {}): Promise<AuthGateResult> {
  if (!opts.force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return { kind: 'online', status: statusCache.value };
  try {
    const status = await api.get<AuthStatusResponse>('/auth/status', { skipAuthRedirect: true, timeoutMs: 15_000 });
    statusCache = { value: status, at: Date.now() };
    writeLastAuth(status.authenticated ? { authenticated: true, username: status.owner?.username ?? null, at: Date.now() } : null);
    return { kind: 'online', status };
  } catch (e) {
    if (isApiError(e) && e.offline) return { kind: 'offline', cached: readLastAuth(), message: e.message };
    throw e;
  }
}

export function invalidateAuthStatus(): void {
  statusCache = null;
}

/** Marks the session as gone locally (after logout / 401). Local data stays on the device. */
export function forgetAuth(): void {
  statusCache = null;
  writeLastAuth(null);
}

async function deviceFields() {
  let device_id: string | undefined;
  try {
    device_id = await getDeviceId();
  } catch {
    device_id = undefined;
  }
  return { device_id, device_label: describeDevice() };
}

export async function setupOwner(username: string, password: string): Promise<SetupResponse> {
  const res = await api.post<SetupResponse>('/auth/setup', { username, password, ...(await deviceFields()) }, { skipAuthRedirect: true });
  invalidateAuthStatus();
  return res;
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await api.post<LoginResponse>('/auth/login', { username, password, ...(await deviceFields()) }, { skipAuthRedirect: true });
  invalidateAuthStatus();
  return res;
}

/**
 * Signs this device out. Only forgets the local "signed in" state once the server confirmed it (or
 * answered 401: already signed out). If the request fails (offline / server down) the HttpOnly session
 * cookie is still valid, so the device stays signed in — locally too — and the error is thrown.
 */
export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout', {}, { skipAuthRedirect: true });
  } catch (e) {
    if (!(isApiError(e) && e.status === 401)) throw e;
  }
  forgetAuth();
}

export async function recoverAccount(body: RecoverRequest): Promise<RecoverResponse> {
  const res = await api.post<RecoverResponse>('/auth/recover', body, { skipAuthRedirect: true });
  forgetAuth();
  return res;
}

export function listSessions(): Promise<SessionsResponse> {
  return api.get<SessionsResponse>('/auth/sessions');
}

export async function revokeSession(id: string): Promise<{ ok: true; current: boolean }> {
  const res = await api.del<{ ok: true; current: boolean }>(`/auth/sessions/${encodeURIComponent(id)}`);
  if (res.current) forgetAuth();
  return res;
}

export function changePassword(body: ChangePasswordRequest): Promise<{ ok: true; revoked_sessions: number }> {
  return api.post('/auth/password', body);
}

export function regenerateRecoveryCodes(password: string): Promise<RecoveryCodesResponse> {
  return api.post<RecoveryCodesResponse>('/auth/recovery-codes', { password });
}
