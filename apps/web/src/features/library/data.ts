// Data access for the library / upload / sources screens.
//  * GET responses can be cached explicitly in Dexie `apiCache` (opt-in, never by the service worker)
//    so the library tree stays VIEWABLE offline (read-only). Writes always need the server.
//  * `invalidate(prefix)` re-fetches every mounted query whose key starts with the prefix.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage, isApiError } from '../../lib/api';
import { getDb } from '../../lib/localdb';

export interface QueryState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** data came from this device's cache because the server could not be reached */
  fromCache: boolean;
  cachedAt: number | null;
  refresh: () => Promise<void>;
}

type Listener = (key: string) => void;
const listeners = new Set<Listener>();

/** Re-fetch every mounted query whose key starts with `prefix`. */
export function invalidate(prefix: string): void {
  for (const l of listeners) l(prefix);
}

async function readCache<T>(key: string): Promise<{ value: T; storedAt: number } | null> {
  try {
    const row = await getDb().apiCache.get(key);
    return row ? { value: row.value as T, storedAt: row.storedAt } : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: unknown): Promise<void> {
  try {
    await getDb().apiCache.put({ key, value, storedAt: Date.now() });
  } catch {
    // storage full / private mode: the screen still works online
  }
}

/**
 * GET `path` (null → idle). With `cache: true` the last good answer is stored on the device and shown
 * when the server is unreachable (marked `fromCache`).
 */
export function useQuery<T>(path: string | null, opts: { cache?: boolean } = {}): QueryState<T> {
  const [state, setState] = useState<Omit<QueryState<T>, 'refresh'>>({ data: null, error: null, loading: !!path, fromCache: false, cachedAt: null });
  const seq = useRef(0);
  const cache = opts.cache ?? false;

  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await api.get<T>(path);
      if (mine !== seq.current) return;
      setState({ data, error: null, loading: false, fromCache: false, cachedAt: null });
      if (cache) void writeCache(`GET ${path}`, data);
    } catch (e) {
      if (mine !== seq.current) return;
      const err = isApiError(e) ? e : new ApiError({ code: 'NETWORK_ERROR', status: 0, message: errorMessage(e), offline: true });
      if (cache && err.offline) {
        const cached = await readCache<T>(`GET ${path}`);
        if (mine !== seq.current) return;
        if (cached) {
          setState({ data: cached.value, error: err, loading: false, fromCache: true, cachedAt: cached.storedAt });
          return;
        }
      }
      setState((s) => ({ ...s, error: err, loading: false }));
    }
  }, [path, cache]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!path) return;
    const l: Listener = (prefix) => {
      if (path.startsWith(prefix)) void load();
    };
    listeners.add(l);
    const onOnline = () => void load();
    window.addEventListener('online', onOnline);
    return () => {
      listeners.delete(l);
      window.removeEventListener('online', onOnline);
    };
  }, [path, load]);

  return { ...state, refresh: load };
}

/** Mutations: call the API, then refresh the affected queries. Errors propagate (Arabic messages). */
export async function mutate<T>(fn: () => Promise<T>, invalidatePrefixes: string[] = ['/library', '/sources']): Promise<T> {
  const r = await fn();
  for (const p of invalidatePrefixes) invalidate(p);
  return r;
}

export const TREE_PATH = '/library/tree';
