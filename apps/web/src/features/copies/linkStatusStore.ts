// The batched store behind the official state of library rows (Phase 1 completion C2; see linkStatus.tsx). One request
// per batch of visible rows (`GET /api/copies/link-status`, ≤ 30 ids); cached for the session; dropped after a link.
import { useEffect, useSyncExternalStore } from 'react';
import type { OfficialLinkStatus, OfficialLinkStatusResponse } from '@medlevo/shared';
import { api } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';

const BATCH = 30;
/** source id → its status (null: known to have none) */
const known = new Map<string, OfficialLinkStatus | null>();
const asked = new Set<string>();
let queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const notify = () => {
  version++;
  for (const l of listeners) l();
};

async function flush(): Promise<void> {
  timer = null;
  const ids = queue;
  queue = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    try {
      const res = await api.get<OfficialLinkStatusResponse>('/copies/link-status', { query: { source_ids: chunk.join(',') }, timeoutMs: 20_000, skipAuthRedirect: true });
      const by = new Map(res.statuses.map((s) => [s.source_id, s]));
      for (const id of chunk) known.set(id, by.get(id) ?? null);
    } catch {
      // not known: asked again on the next visit (never a claim made on a failed answer)
      for (const id of chunk) asked.delete(id);
    }
  }
  notify();
}

function request(id: string): void {
  if (known.has(id) || asked.has(id)) return;
  asked.add(id);
  queue.push(id);
  timer ??= setTimeout(() => void flush(), 0);
}

/** Forget what is known about these rows (after «اربط بالمحاضرة الرسمية» or a review decision). */
export function dropLinkStatus(ids: readonly string[]): void {
  for (const id of ids) {
    known.delete(id);
    asked.delete(id);
  }
  notify();
}

/** For tests: forget everything. */
export function resetLinkStatusCache(): void {
  known.clear();
  asked.clear();
  queue = [];
  if (timer) clearTimeout(timer);
  timer = null;
  notify();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The row's official state: undefined while unknown (offline, loading, failed), null when it has none. */
export function useLinkStatus(sourceId: string): OfficialLinkStatus | null | undefined {
  const online = useOnline();
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    if (online) request(sourceId);
  }, [online, sourceId]);
  return known.get(sourceId);
}

