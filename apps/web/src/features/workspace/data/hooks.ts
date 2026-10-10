// Live local data for the open document (IndexedDB is the source the UI renders from).
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { AnnotationRow } from '../../../lib/localdb';
import { getDb } from '../../../lib/localdb';
import type { WorkspaceNoteRow } from './local';

export function useLive<T>(query: () => Promise<T>, deps: unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setValue, error: () => undefined });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** Live (not deleted) notes anchored to any of the given page keys, newest first. */
export function useNotes(pageKeys: readonly string[]): WorkspaceNoteRow[] {
  const key = pageKeys.join('|');
  return useLive(
    async () => {
      if (pageKeys.length === 0) return [];
      const rows = (await getDb().notes.where('anchorKey').anyOf([...pageKeys]).toArray()) as WorkspaceNoteRow[];
      return rows.filter((n) => !n.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    [key],
    [],
  );
}

/**
 * Live annotations of a kind on the given pages. Indexed by [targetKey+kind] (local schema v2): only rows of that kind
 * are read, and writes of other kinds (ink strokes) do not re-run the query (I2, docs/PERFORMANCE.md).
 */
export function useAnnotationsOfKind(pageKeys: readonly string[], kind: string): AnnotationRow[] {
  const key = pageKeys.join('|');
  return useLive(
    async () => {
      if (pageKeys.length === 0) return [];
      const rows = await getDb().annotations.where('[targetKey+kind]').anyOf(pageKeys.map((k) => [k, kind])).toArray();
      return rows.filter((a) => !a.deletedAt).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    },
    [key, kind],
    [],
  );
}

/** Local annotations flagged «تحتاج إعادة ربط» on the given pages (indexed by anchorStatus: flagged rows only). */
export function useLocalNeedsReanchor(pageKeys: readonly string[]): AnnotationRow[] {
  const key = pageKeys.join('|');
  return useLive(
    async () => {
      if (pageKeys.length === 0) return [];
      const keys = new Set(pageKeys);
      const rows = await getDb().annotations.where('anchorStatus').equals('needs_reanchor').toArray();
      return rows.filter((a) => keys.has(a.targetKey) && !a.deletedAt);
    },
    [key],
    [],
  );
}
