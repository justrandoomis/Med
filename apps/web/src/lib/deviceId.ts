// Persistent device id (ULID) — attributes sync ops and sessions to this device (§47).
// Stored in IndexedDB (kv) together with the outbox, so the id lives exactly as long as the local
// data it describes; mirrored to localStorage for synchronous reads.
import { isId, newId } from '@medlevo/shared';
import { currentLocalDbName, getDb, kvGet, kvSet, type MedLevoDB } from './localdb';
import { userStorage } from './userStorage';

const KV_KEY = 'device.id';
const LS_KEY = 'medlevo.deviceId';
let cached: string | null = null;
/** the local database the cached id belongs to (another account in the page → another id) */
let cachedFor: string | null = null;

// P1-T1 step 3: a device id per account per device (ARCHITECTURE_DELTA §8.7) — the mirror is the account's key and
// the id itself lives in the account's own local database
function readLocalStorage(): string | null {
  const v = userStorage.get(LS_KEY);
  return isId(v) ? v : null;
}

function writeLocalStorage(id: string): void {
  userStorage.set(LS_KEY, id); // ignored when storage is unavailable: IndexedDB is the source of truth
}

/** Returns the device id, creating and persisting it on first use. */
export async function getDeviceId(db: MedLevoDB = getDb()): Promise<string> {
  if (cached && cachedFor === db.name) return cached;
  cached = null;
  let id: string | undefined;
  try {
    id = await kvGet<string>(db, KV_KEY);
  } catch {
    id = undefined;
  }
  if (!isId(id)) {
    id = readLocalStorage() ?? newId();
    try {
      await kvSet(db, KV_KEY, id);
    } catch {
      // IndexedDB unavailable (private mode on some browsers): keep the in-memory id
    }
  }
  cached = id;
  cachedFor = db.name;
  writeLocalStorage(id);
  return id;
}

/**
 * AOS-21.29 (ARCHITECTURE_DELTA §8.2): the server answered `device_unknown` — this device id was revoked in «أجهزتي»
 * (a revoked id is never revived). Take a NEW id for this account on this device and persist it; queued ops are then
 * re-sent from it.
 */
export async function replaceDeviceId(db: MedLevoDB = getDb()): Promise<string> {
  const id = newId();
  try {
    await kvSet(db, KV_KEY, id);
  } catch {
    // IndexedDB unavailable: keep the in-memory id
  }
  cached = id;
  cachedFor = db.name;
  writeLocalStorage(id);
  return id;
}

/** Synchronous best-effort read (null before getDeviceId() resolved once and nothing was stored). */
export function peekDeviceId(): string | null {
  return (cachedFor === currentLocalDbName() ? cached : null) ?? readLocalStorage();
}

/** Test helper. */
export function resetDeviceIdCache(): void {
  cached = null;
  cachedFor = null;
}

/** Human label for the sessions list, e.g. «Safari على iPad». Derived locally from the user agent. */
export function describeDevice(
  ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  maxTouchPoints: number = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0,
): string {
  let platform = 'جهاز';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) platform = 'iPad'; // iPadOS reports a Mac UA
  else if (/iPhone/.test(ua)) platform = 'iPhone';
  else if (/Android/.test(ua)) platform = /Mobile/.test(ua) ? 'هاتف Android' : 'جهاز Android لوحي';
  else if (/Windows/.test(ua)) platform = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) platform = 'Mac';
  else if (/Linux/.test(ua)) platform = 'Linux';

  let browser = 'المتصفح';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return `${browser} على ${platform}`;
}
