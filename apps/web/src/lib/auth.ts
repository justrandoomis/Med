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
import type { MeLite } from '@medlevo/shared';
import { api, isApiError } from './api';
import { describeDevice, getDeviceId } from './deviceId';
import { claimLegacyLocalData, currentLocalDbName, LOCAL_DB_NAME, localDbNameFor, openedLocalDbName } from './localdb';
import { deviceStorage, readJson, setStorageAccount, storageAccount, writeJson } from './userStorage';

/**
 * Device-level (not an account's): which account was last signed in on THIS device, so the app can open that
 * account's local data offline. R1-a wrote it without `userId` — that was the single owner, whose data is the legacy
 * namespace (P1-T1 step 3).
 */
const LAST_AUTH_KEY = 'medlevo.lastAuth.v1';

export interface CachedAuth {
  authenticated: boolean;
  username: string | null;
  at: number;
  /** (P1-T1 step 3) the account; absent in a cache written by R1-a (the single owner) */
  userId?: string;
  /** (P1-T1 step 3) that account claimed the legacy local data of this device */
  legacy?: boolean;
}

function readLastAuth(): CachedAuth | null {
  return readJson<CachedAuth>(deviceStorage, LAST_AUTH_KEY);
}

function writeLastAuth(v: CachedAuth | null) {
  writeJson(deviceStorage, LAST_AUTH_KEY, v);
}

/**
 * (P1-T1 step 3 review) The login name of the account this page belongs to, normalised like the server
 * (NFKC, trimmed, lower case). A sign-out does not reload the page, so the page's storage account outlives it: a device
 * id is sent with a sign-in only when the SAME account signs in again (deviceFields).
 */
let pageUsername: string | null = null;
const normalizeLogin = (u: string): string => u.normalize('NFKC').trim().toLowerCase();

/**
 * The page now belongs to `user` (P1-T1 step 3, ADR-0003 §3.7): user #1 first claims the local data this device kept
 * from before accounts; then every storage access of the page uses that account's namespace (getDb(), userStorage).
 * Returns 'reload' when the page had already opened another account's local data — the caller reloads, so nothing
 * of the previous account (its open database, its sync engine, its drafts in memory) can act under the new one.
 */
export async function activateAccount(user: MeLite): Promise<'same' | 'activated' | 'reload'> {
  const legacy = user.owns_legacy_device_data === true ? await claimLegacyLocalData(user.id) : false;
  const previous = storageAccount();
  const opened = openedLocalDbName();
  const nextName = legacy ? LOCAL_DB_NAME : localDbNameFor(user.id);
  setStorageAccount({ userId: user.id, legacy });
  pageUsername = normalizeLogin(user.username);
  writeLastAuth({ authenticated: true, username: user.username, at: Date.now(), userId: user.id, legacy });
  if (previous && previous.userId !== user.id) return 'reload';
  if (opened !== null && opened !== nextName) return 'reload';
  return previous ? 'same' : 'activated';
}

/** Offline start: the account last signed in on this device (an R1-a cache = the single owner = legacy data). */
export function activateCachedAccount(c: CachedAuth): void {
  if (typeof c.userId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.userId)) setStorageAccount({ userId: c.userId, legacy: c.legacy === true });
  else setStorageAccount(null);
  pageUsername = c.username ? normalizeLogin(c.username) : null;
}

/** The local database name the page uses now (diagnostics and tests). */
export function pageLocalDbName(): string {
  return currentLocalDbName();
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
    // signed in: the account (and its legacy claim) is recorded by activateAccount; a status without `user` (a server
    // older than accounts) refreshes the pointer as R1-a did, keeping the account it names; signed out: forget this
    // device's pointer only when it is this page's account (another tab may have signed another account in)
    if (status.authenticated && !status.user) writeLastAuth({ ...(readLastAuth() ?? {}), authenticated: true, username: status.owner?.username ?? null, at: Date.now() });
    if (!status.authenticated) forgetPointer();
    return { kind: 'online', status };
  } catch (e) {
    if (isApiError(e) && e.offline) return { kind: 'offline', cached: readLastAuth(), message: e.message };
    throw e;
  }
}

/** (track F5) last known sign-in state on this device — the error reporter sends only while signed in (no 401 noise). */
export function lastKnownAuthenticated(): boolean {
  return readLastAuth()?.authenticated === true;
}

export function invalidateAuthStatus(): void {
  statusCache = null;
}

function forgetPointer(): void {
  const pointer = readLastAuth();
  const mine = storageAccount();
  // an R1-a pointer (no userId), or this page's own account: forget it; another account's pointer (set by another tab
  // that signed in meanwhile) stays
  if (!pointer || !pointer.userId || !mine || pointer.userId === mine.userId) writeLastAuth(null);
}

/** Marks the session as gone locally (after logout / 401). Local data stays on the device, in its account's namespace. */
export function forgetAuth(): void {
  statusCache = null;
  forgetPointer();
}

async function deviceFields(username?: string) {
  // the device id belongs to an account (it lives in that account's local database): send it only when this page
  // belongs to the account signing in — signing in as another account (after a sign-out in this page, too) must not
  // borrow the previous account's device id
  let device_id: string | undefined;
  const same = username === undefined ? true : pageUsername !== null && normalizeLogin(username) === pageUsername;
  if (storageAccount() !== null && same) {
    try {
      device_id = await getDeviceId();
    } catch {
      device_id = undefined;
    }
  }
  return { device_id, device_label: describeDevice() };
}

export async function setupOwner(username: string, password: string): Promise<SetupResponse> {
  const res = await api.post<SetupResponse>('/auth/setup', { username, password, ...(await deviceFields(username)) }, { skipAuthRedirect: true });
  invalidateAuthStatus();
  return res;
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await api.post<LoginResponse>('/auth/login', { username, password, ...(await deviceFields(username)) }, { skipAuthRedirect: true });
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
