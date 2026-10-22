// AOS-4.7 / ADR-0003 Q26 (track C3) — signing out of THIS device.
//
// Default (as before): the account's local data stays on the device, in the account's own namespace (its IndexedDB
// `medlevo:<id>`, its `<id>:` keys), so writing offline keeps working and nothing waits for the network. Two ways to
// clear it at sign-out instead:
//   * the option «امسح بيانات هذا الجهاز عند الخروج» (per account, on this device);
//   * a device the account registered as shared («جهاز مشترك», `PATCH /api/accounts/me/devices/:id`) ALWAYS clears.
// «Clear» deletes the account's IndexedDB database and its localStorage / sessionStorage keys — nothing of another
// account, and none of the device's own keys (appearance, e-ink display, which account signed in last, the legacy
// claim). For user #1 holding the legacy namespace, that namespace is theirs: the database `medlevo` and its
// un-prefixed keys go.
//
// No data loss: before clearing, the device tries to send what is waiting; whatever has not reached the server — ops
// in the outbox, conflicts and refusals the account has not acknowledged (they hold text the server lacks), crash-
// recovery drafts, typed answers not saved yet (cases, written and handwritten exam answers), recordings and pictures
// not uploaded (or refused and kept here, or an interrupted recording still in chunks) — is COUNTED and the sign-out
// stops and asks. Clearing never deletes them silently; the person may sign out keeping the data here (it is sent at
// the next sign-in) or stay signed in.
//
// «Shared» is decided at the sign-out itself (C3 review R2), never only by what a screen had loaded: the sign-out asks
// the server (it must reach it anyway), and when that answer cannot be read, what this device last knew decides.
import Dexie from 'dexie';
import { logout } from './auth';
import { api } from './api';
import { getDb, LOCAL_DB_NAME, localDbNameFor, resetSharedDb, type BlobRecord, type MedLevoDB } from './localdb';
import { getSyncEngine } from './sync';
import { clearAccountStorage, readJson, storageAccount, userStorage, writeJson, type StorageAccount } from './userStorage';
import type { DevicesResponse, DeviceView } from '@medlevo/shared';
import { getDeviceId } from './deviceId';

/** per account, on this device */
export const CLEAR_ON_SIGN_OUT_KEY = 'medlevo.clearOnSignOut.v1';

// crash-recovery note drafts (features/workspace/data/noteDrafts.ts), case-editor drafts (features/cases/CaseEditor.tsx)
// and the answer typed in a running case (features/cases/CaseRunner.tsx `medlevo.cases.draft.<attempt>`) — C3 review R1
const DRAFT_KEY = /^medlevo\.(note-draft\.|cases\.editor\.|cases\.draft\.)/;
// in the account's database (kv): a written exam answer not saved yet (features/exams/local.ts) and a handwritten
// answer's pad (features/exams/HandwrittenAnswer.tsx) — an empty value means «saved / nothing typed»
const KV_TEXT_DRAFT = 'exams.written.draft.';
const KV_PAD_DRAFT = 'written-pad:';
// blobs that exist only here until uploaded (features/workspace/ink/images.ts, features/workspace/audio/recordings.ts)
export const LOCAL_ONLY_BLOB_KINDS = { image: 'annotation_image', recording: 'audio_recording', recordingChunk: 'audio_recording_chunk' } as const;

/** per account, on this device: the last answer of the server to «is this device shared?» (C3 review R2) */
export const SHARED_DEVICE_KEY = 'medlevo.sharedDevice.v1';

export function clearOnSignOutPreference(): boolean {
  return readJson<boolean>(userStorage, CLEAR_ON_SIGN_OUT_KEY) === true;
}

export function setClearOnSignOutPreference(on: boolean): void {
  writeJson(userStorage, CLEAR_ON_SIGN_OUT_KEY, on ? true : null);
}

export interface Unsent {
  /** writes waiting in the outbox */
  pending: number;
  /** conflicts / refusals not acknowledged — the server does not hold their text */
  unresolved: number;
  /** crash-recovery drafts (notes, cases) and typed answers not saved yet (case, written / handwritten exam answers) */
  drafts: number;
  /** recordings and pictures that exist only here: not uploaded yet, refused and kept, or an interrupted recording */
  uploads: number;
  total: number;
}

/** What has not reached the server from this account on this device. */
export async function unsentOnThisDevice(db: MedLevoDB = getDb()): Promise<Unsent> {
  let pending = 0;
  let unresolved = 0;
  try {
    pending = await db.outbox.where('status').equals('pending').count();
    unresolved = (await db.outbox.where('status').anyOf('conflict', 'rejected').toArray()).filter((o) => !o.acknowledgedAt && !o.supersededBy).length;
  } catch {
    // an unreadable database cannot be counted: treat it as holding something, so it is never deleted unseen
    pending = Math.max(pending, 1);
  }
  let drafts = userStorage.keys('medlevo.').filter((k) => DRAFT_KEY.test(k)).length;
  try {
    const typed = await db.kv.where('key').startsWith(KV_TEXT_DRAFT).toArray();
    drafts += typed.filter((r) => typeof r.value === 'string' && r.value.trim() !== '').length;
    const pads = await db.kv.where('key').startsWith(KV_PAD_DRAFT).toArray();
    drafts += pads.filter((r) => Array.isArray(r.value) && r.value.length > 0).length;
  } catch {
    drafts = Math.max(drafts, 1);
  }
  let uploads = 0;
  try {
    const K = LOCAL_ONLY_BLOB_KINDS;
    const finished = (await db.blobs.where('kind').anyOf(K.image, K.recording).toArray()) as Array<BlobRecord & { uploadState?: string; recordingId?: string }>;
    uploads = finished.filter((b) => b.uploadState !== 'uploaded').length;
    // chunks of a recording that was never finished here (the page died while recording): one per recording
    const finishedIds = new Set(finished.map((b) => b.recordingId).filter(Boolean));
    const chunks = (await db.blobs.where('kind').equals(K.recordingChunk).toArray()) as Array<BlobRecord & { recordingId?: string }>;
    uploads += new Set(chunks.map((c) => c.recordingId ?? c.id).filter((id) => !finishedIds.has(id))).size;
  } catch {
    uploads = Math.max(uploads, 1);
  }
  return { pending, unresolved, drafts, uploads, total: pending + unresolved + drafts + uploads };
}

/** «Arabic count» of what has not been sent, for the question shown before clearing. */
export function unsentAr(u: Unsent): string {
  const parts: string[] = [];
  if (u.pending) parts.push(`${u.pending} ${u.pending === 1 ? 'تغيير ينتظر الإرسال' : 'تغييرات تنتظر الإرسال'}`);
  if (u.unresolved) parts.push(`${u.unresolved} ${u.unresolved === 1 ? 'تعارض أو رفض لم تراجعه' : 'تعارضات أو رفض لم تراجعها'}`);
  if (u.drafts) parts.push(`${u.drafts} ${u.drafts === 1 ? 'مسودة محفوظة' : 'مسودات محفوظة'}`);
  if (u.uploads) parts.push(`${u.uploads} ${u.uploads === 1 ? 'تسجيل أو صورة لم يصل إلى الخادم' : 'تسجيلات أو صور لم تصل إلى الخادم'}`);
  return parts.join('، ');
}

/**
 * THIS browser among the account's devices: by the page's own device id first — a session opened at the very first
 * sign-in on a device predates the account's local device id, so the server cannot mark it `current` — else the one
 * the server marks current. Revoked devices are never «this device».
 */
export function thisDevice(devices: readonly DeviceView[], myDeviceId: string | null): DeviceView | null {
  const live = devices.filter((d) => d.revoked_at === null);
  return (myDeviceId ? live.find((d) => d.device_id === myDeviceId) : undefined) ?? live.find((d) => d.current) ?? null;
}

async function myDeviceId(): Promise<string | null> {
  try {
    return await getDeviceId();
  } catch {
    return null;
  }
}

/** What the server last said about this device being shared (this account, this device). */
export function rememberSharedDevice(shared: boolean): void {
  writeJson(userStorage, SHARED_DEVICE_KEY, shared);
}
function lastKnownShared(): boolean {
  return readJson<boolean>(userStorage, SHARED_DEVICE_KEY) === true;
}

/** Is THIS device registered as shared? null when the server could not say (offline, old server). Remembered. */
export async function currentDeviceIsShared(): Promise<boolean | null> {
  try {
    const r = await api.get<DevicesResponse>('/accounts/me/devices', { timeoutMs: 15_000, skipAuthRedirect: true });
    const mine = thisDevice(r.devices, await myDeviceId());
    const shared = mine ? mine.shared_device === true : null;
    if (shared !== null) rememberSharedDevice(shared);
    return shared;
  } catch {
    return null;
  }
}

/**
 * Delete one account's local data on this device: its IndexedDB database and its keys. Nothing of another account and
 * none of the device's keys. The page's database instance is closed first.
 */
export async function clearAccountDeviceData(account: StorageAccount): Promise<{ database: string; keys: number }> {
  const database = account.legacy ? LOCAL_DB_NAME : localDbNameFor(account.userId);
  resetSharedDb();
  // the other tabs of this account leave first (their open connection would otherwise hold the deletion, and their
  // next write would create the database again)
  announceCleared(account.userId);
  await Dexie.delete(database);
  const keys = clearAccountStorage(account);
  return { database, keys };
}

/**
 * (C3 review R9) Other open tabs of the SAME account on this browser: after this device's copy of the account was
 * deleted, a second tab still showed the account's lecture and notes on screen and, on its next local write (the study
 * position autosaves every second or so), re-created the database the clearing had just deleted. The clearing tab
 * announces it; every signed-in page listens and leaves through a full load (nothing of the account stays in memory).
 */
const ACCOUNT_CHANNEL = 'medlevo-account';
type AccountMessage = { type: 'cleared'; userId: string };

function announceCleared(userId: string): void {
  try {
    const c = new BroadcastChannel(ACCOUNT_CHANNEL);
    c.postMessage({ type: 'cleared', userId } satisfies AccountMessage);
    c.close();
  } catch {
    // no BroadcastChannel: the other tab finds its session gone at its next request
  }
}

/** Installed by every signed-in page: leave when another tab cleared this account's data on this device. */
export function listenForAccountClear(): () => void {
  let c: BroadcastChannel | null = null;
  try {
    c = new BroadcastChannel(ACCOUNT_CHANNEL);
  } catch {
    return () => undefined;
  }
  c.onmessage = (e: MessageEvent) => {
    const m = e.data as Partial<AccountMessage> | null;
    const mine = storageAccount();
    if (!m || m.type !== 'cleared' || !mine || m.userId !== mine.userId) return;
    try {
      getSyncEngine().stop();
    } catch {
      // ignore
    }
    resetSharedDb();
    afterClear.go('/login');
  };
  return () => c?.close();
}

export type SignOutOutcome =
  | { kind: 'signed_out'; cleared: boolean }
  /** clearing was asked for but something has not reached the server: nothing was done yet */
  | { kind: 'unsent'; unsent: Unsent };

/** How the page leaves after a clearing sign-out: a full load, so no account state stays in memory (tests override). */
export const afterClear = {
  go(path: string): void {
    window.location.replace(path);
  },
};

/**
 * Sign out of this device; `clear` deletes the account's local data afterwards (see the file comment). The server must
 * confirm the sign-out first (offline it throws and nothing changes). With `clear`, what has not been sent stops it.
 * A device registered as shared clears whatever `clear` says (asked here, not taken from a screen that may not have
 * loaded it). `keep`: the person was told what has not been sent and chose to keep it all on this device.
 */
export async function signOutThisDevice(opts: { clear: boolean; keep?: boolean }): Promise<SignOutOutcome> {
  const account = storageAccount();
  let clear = opts.clear && !opts.keep;
  if (!clear && !opts.keep && account) clear = (await currentDeviceIsShared()) ?? lastKnownShared();
  if (clear && account) {
    try {
      await getSyncEngine().syncNow();
    } catch {
      // counted below
    }
    const unsent = await unsentOnThisDevice();
    if (unsent.total > 0) return { kind: 'unsent', unsent };
  }
  await logout();
  getSyncEngine().stop();
  if (clear && account) {
    await clearAccountDeviceData(account);
    return { kind: 'signed_out', cleared: true };
  }
  return { kind: 'signed_out', cleared: false };
}
