// Reading progress (§45): pages that were on screen long enough. Sent to the server in small batches;
// kept on the device while offline. It is shown as «صفحات عُرضت», never as completion or mastery.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadingProgressView } from '@medlevo/shared';
import { getDb, kvGet, kvSet } from '../../../lib/localdb';
import { fetchProgress, postProgress } from '../data/api';

const KEY = (sourceId: string) => `workspace.progress.pending.${sourceId}`;
const FLUSH_MS = 2500;

export function useReadingProgress(sourceId: string, versionId: string | null, online: boolean) {
  const [progress, setProgress] = useState<ReadingProgressView | null>(null);
  const queue = useRef<{ versionId: string; pages: Set<number> } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    if (!online) return;
    fetchProgress(sourceId)
      .then((p) => !cancelled && setProgress(p))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sourceId, online]);

  const flush = useCallback(async () => {
    const db = getDb();
    const stored = await kvGet<{ versionId: string; pages: number[] }>(db, KEY(sourceId)).catch(() => undefined);
    const q = queue.current;
    queue.current = null;
    const versionMatch = stored && q && stored.versionId === q.versionId;
    const merged = q
      ? { versionId: q.versionId, pages: [...new Set([...(versionMatch ? stored.pages : []), ...q.pages])] }
      : stored ?? null;
    if (!merged || merged.pages.length === 0) return;
    try {
      const view = await postProgress(sourceId, merged.versionId, merged.pages);
      setProgress(view);
      await getDb().kv.delete(KEY(sourceId)).catch(() => undefined);
    } catch {
      // offline or server error: keep the pages on this device and send them later
      await kvSet(db, KEY(sourceId), merged).catch(() => undefined);
    }
  }, [sourceId]);

  const markViewed = useCallback(
    (pageIndex: number) => {
      if (!versionId) return;
      if (!queue.current || queue.current.versionId !== versionId) queue.current = { versionId, pages: new Set() };
      queue.current.pages.add(pageIndex);
      setProgress((p) =>
        p && p.version_id === versionId && !p.pages_viewed.includes(pageIndex)
          ? { ...p, pages_viewed: [...p.pages_viewed, pageIndex].sort((a, b) => a - b), reading_progress: p.pages_total ? Math.min(1, (p.pages_viewed.length + 1) / p.pages_total) : 0 }
          : p,
      );
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), FLUSH_MS);
    },
    [versionId, flush],
  );

  useEffect(() => {
    if (online) void flush();
  }, [online, flush]);
  useEffect(() => () => void flush(), [flush]);

  return { progress, markViewed };
}
