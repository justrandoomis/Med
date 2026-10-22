// Per-user browser storage (ADR-0003 §3.7, ARCHITECTURE_DELTA §4.5 and §8.7; P1-T1 step 3).
//
// Several accounts may use one browser (a shared tablet, a friend signing in on the owner's iPad). Everything the app
// keeps in the browser belongs to ONE account:
//   * IndexedDB: the account's own database (lib/localdb.ts → getDb());
//   * localStorage / sessionStorage: every key of the account is prefixed `<userId>:` (userStorage / userSession);
//   * crash-recovery drafts are written under the account's prefix and recovered only for it.
// The ONE exception is what a device kept from before accounts existed (R1-a and earlier: the IndexedDB database
// `medlevo` and the un-prefixed `medlevo.*` keys). It is CLAIMED by user #1 only — the owner migrated from the
// single-owner installation (or the first-run account) — and stays exactly where it is: user #1's namespace on that
// device is the legacy one (empty prefix, database `medlevo`). Nothing is copied or moved, so nothing can be lost on
// the way, and a rollback to the previous release still finds every local write in place. Every other account gets
// `medlevo:<id>` and `<id>:` keys and never sees the legacy data.
//
// deviceStorage holds what belongs to the DEVICE, not to an account: the display preferences (theme, e-ink /
// high-contrast mode), the performance harness switch, which account was last signed in here (offline start) and who
// claimed the legacy data. Nothing personal is kept there.
//
// Raw `localStorage` / `sessionStorage` is banned everywhere else by the lint rule (eslint.config.js).
// Every access is wrapped: private mode or blocked storage must never break writing.

export interface StorageAccount {
  userId: string;
  /** this account claimed the legacy (pre-account) data of this device: empty key prefix, IndexedDB `medlevo` */
  legacy: boolean;
}

/** device-level: who claimed the legacy data on this device ({ userId, at }) */
export const LEGACY_CLAIM_KEY = 'medlevo.legacyClaim.v1';

let active: StorageAccount | null = null;
const listeners = new Set<(a: StorageAccount | null, previous: StorageAccount | null) => void>();

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The account whose namespace the page uses (null before the sign-in state is known: the legacy namespace). */
export function storageAccount(): StorageAccount | null {
  return active;
}

export function setStorageAccount(a: StorageAccount | null): void {
  if (a && !ID_RE.test(a.userId)) throw new Error('setStorageAccount: invalid user id');
  const previous = active;
  if (previous?.userId === a?.userId && previous?.legacy === a?.legacy) return;
  active = a ? { userId: a.userId, legacy: a.legacy } : null;
  for (const fn of [...listeners]) fn(active, previous);
}

export function onStorageAccountChange(fn: (a: StorageAccount | null, previous: StorageAccount | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Key prefix of an account's namespace: '' for the legacy namespace (no account yet, or the claiming user #1). */
export function namespacePrefix(a: StorageAccount | null = active): string {
  return a && !a.legacy ? `${a.userId}:` : '';
}

/** A key of the legacy namespace never starts with «<id>:» (prefixed keys always do). */
const PREFIXED = /^[A-Za-z0-9_-]{1,64}:/;

function store(kind: 'local' | 'session'): Storage | null {
  try {
    const s = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

interface KeyValueStorage {
  get(key: string): string | null;
  /** null removes; returns false when the browser refused (quota, private mode) */
  set(key: string, value: string | null): boolean;
  remove(key: string): void;
  /** names (without the account prefix) of this namespace's keys that start with `prefix` */
  keys(prefix?: string): string[];
}

function namespaced(kind: 'local' | 'session', prefixOf: () => string, legacyOf: () => boolean): KeyValueStorage {
  return {
    get(key) {
      try {
        return store(kind)?.getItem(prefixOf() + key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      const s = store(kind);
      if (!s) return false;
      try {
        if (value === null) s.removeItem(prefixOf() + key);
        else s.setItem(prefixOf() + key, value);
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        store(kind)?.removeItem(prefixOf() + key);
      } catch {
        // ignore
      }
    },
    keys(prefix = '') {
      const s = store(kind);
      if (!s) return [];
      const ns = prefixOf();
      const legacy = legacyOf();
      const out: string[] = [];
      try {
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k === null) continue;
          if (legacy) {
            if (!PREFIXED.test(k) && k.startsWith(prefix)) out.push(k);
          } else if (k.startsWith(ns + prefix)) out.push(k.slice(ns.length));
        }
      } catch {
        return out;
      }
      return out;
    },
  };
}

const isLegacy = () => active === null || active.legacy;

/** The signed-in account's localStorage keys (`<userId>:` prefix; user #1's legacy namespace has none). */
export const userStorage: KeyValueStorage = namespaced('local', () => namespacePrefix(), isLegacy);
/** The signed-in account's sessionStorage keys (the same namespace rule; per tab). */
export const userSession: KeyValueStorage = namespaced('session', () => namespacePrefix(), isLegacy);
/** Keys of the DEVICE (never personal data): display preferences, the last signed-in account, the legacy claim. */
export const deviceStorage: KeyValueStorage = namespaced('local', () => '', () => true);

/** JSON helpers over a namespace (unreadable JSON reads as null). */
export function readJson<T>(s: KeyValueStorage, key: string): T | null {
  const raw = s.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
export function writeJson(s: KeyValueStorage, key: string, value: unknown): boolean {
  return s.set(key, value === null || value === undefined ? null : JSON.stringify(value));
}

/** Who claimed the legacy data on this device (null: nobody yet). */
export function legacyClaimHolder(): string | null {
  const v = readJson<{ userId?: unknown }>(deviceStorage, LEGACY_CLAIM_KEY);
  return v && typeof v.userId === 'string' && ID_RE.test(v.userId) ? v.userId : null;
}

export function recordLegacyClaim(userId: string): void {
  writeJson(deviceStorage, LEGACY_CLAIM_KEY, { userId, at: Date.now() });
}

/** «Clear this device» for one account (ARCHITECTURE_DELTA §4.5): its own keys only; legacy keys stay (they are user #1's). */
export function clearAccountKeys(userId: string): number {
  const s = store('local');
  if (!s || !ID_RE.test(userId)) return 0;
  const doomed: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(`${userId}:`)) doomed.push(k);
    }
    for (const k of doomed) s.removeItem(k);
  } catch {
    return 0;
  }
  return doomed.length;
}

/**
 * Keys of the DEVICE (never of an account): the display preferences, the ink tile cache switch, which account signed
 * in last here and who claimed the legacy data. «Clear this device» for an account never removes them.
 */
export const DEVICE_KEYS: ReadonlySet<string> = new Set(['medlevo.appearance.v1', 'medlevo.display.v1', 'medlevo.ink.tiles', 'medlevo.lastAuth.v1', LEGACY_CLAIM_KEY]);

/**
 * (AOS-4.7 / Q26, track C3) «امسح بيانات هذا الجهاز عند الخروج» for one account: every localStorage AND sessionStorage
 * key of its namespace — `<userId>:` keys, or, for user #1 holding the legacy namespace, the un-prefixed keys except the
 * device's own (DEVICE_KEYS). Nothing of another account. Returns how many keys were removed.
 */
export function clearAccountStorage(account: StorageAccount): number {
  if (!ID_RE.test(account.userId)) return 0;
  let removed = 0;
  for (const kind of ['local', 'session'] as const) {
    const s = store(kind);
    if (!s) continue;
    const doomed: string[] = [];
    try {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k === null) continue;
        if (account.legacy ? !PREFIXED.test(k) && !DEVICE_KEYS.has(k) : k.startsWith(`${account.userId}:`)) doomed.push(k);
      }
      for (const k of doomed) s.removeItem(k);
      removed += doomed.length;
    } catch {
      // storage blocked: nothing more can be removed (and nothing more can be read by anyone either)
    }
  }
  return removed;
}
