// Channel screens offline (PRD AOS-20.17; IA §7.1 «Offline»): the last answer the server gave THIS account is kept in
// the account's own localStorage namespace and shown read-only, with when it was saved, when the server cannot be
// reached. Network-only actions (joining, following, deciding) stay disabled with the reason meanwhile. Nothing here
// is ever shown to another account: the namespace is per user (lib/userStorage.ts).
import { isApiError } from '../../lib/api';
import { readJson, userStorage, writeJson } from '../../lib/userStorage';

const PREFIX = 'aos.cache.';
/** larger answers are not kept (a phone's localStorage holds ~5 MB for everything) */
const MAX_CHARS = 1_000_000;

export interface Cached<T> {
  data: T;
  /** null = a fresh answer from the server; otherwise when the shown copy was saved */
  cachedAt: number | null;
}

export async function withCache<T>(key: string, fetcher: () => Promise<T>): Promise<Cached<T>> {
  try {
    const data = await fetcher();
    const json = JSON.stringify({ at: Date.now(), data });
    if (json.length <= MAX_CHARS) userStorage.set(PREFIX + key, json);
    return { data, cachedAt: null };
  } catch (e) {
    if (isApiError(e) && e.offline) {
      const saved = readJson<{ at: number; data: T }>(userStorage, PREFIX + key);
      if (saved && typeof saved.at === 'number') return { data: saved.data, cachedAt: saved.at };
    }
    throw e;
  }
}

/** Forget a cached answer (after the viewer changed it, so a later offline view is not older than what they did). */
export function dropCache(key: string): void {
  writeJson(userStorage, PREFIX + key, null);
}
