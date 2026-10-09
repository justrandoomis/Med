// Persistent device id (ULID) — attributes sync ops and sessions to this device (§47).
// Stored in IndexedDB (kv) together with the outbox, so the id lives exactly as long as the local
// data it describes; mirrored to localStorage for synchronous reads.
import { isId, newId } from '@medlevo/shared';
import { getDb, kvGet, kvSet, type MedLevoDB } from './localdb';

const KV_KEY = 'device.id';
const LS_KEY = 'medlevo.deviceId';
let cached: string | null = null;

function readLocalStorage(): string | null {
  try {
    const v = window.localStorage.getItem(LS_KEY);
    return isId(v) ? v : null;
  } catch {
    return null;
  }
}

function writeLocalStorage(id: string): void {
  try {
    window.localStorage.setItem(LS_KEY, id);
  } catch {
    // ignore: IndexedDB is the source of truth
  }
}

/** Returns the device id, creating and persisting it on first use. */
export async function getDeviceId(db: MedLevoDB = getDb()): Promise<string> {
  if (cached) return cached;
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
  writeLocalStorage(id);
  return id;
}

/** Synchronous best-effort read (null before getDeviceId() resolved once and nothing was stored). */
export function peekDeviceId(): string | null {
  return cached ?? readLocalStorage();
}

/** Test helper. */
export function resetDeviceIdCache(): void {
  cached = null;
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
