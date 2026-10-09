import { useMemo } from 'react';
import type { LibraryTreeResponse } from '@medlevo/shared';
import { TREE_PATH, useQuery } from './data';
import { buildIndex, type LibraryIndex } from './model';

/** The library tree (cached on this device for read-only offline viewing) + its index. */
export function useLibrary(include?: 'archived' | 'trash' | 'archived,trash') {
  const q = useQuery<LibraryTreeResponse>(include ? `${TREE_PATH}?include=${include}` : TREE_PATH, { cache: true });
  const index: LibraryIndex | null = useMemo(() => (q.data ? buildIndex(q.data.nodes, q.data.sources) : null), [q.data]);
  return { ...q, index };
}

const ROOT_SORT_KEY = 'medlevo.library.rootSort';
export function readRootSort(): 'manual' | 'title' | 'updated' | 'created' {
  try {
    const v = window.localStorage.getItem(ROOT_SORT_KEY);
    return v === 'title' || v === 'updated' || v === 'created' ? v : 'manual';
  } catch {
    return 'manual';
  }
}
export function writeRootSort(v: string): void {
  try {
    window.localStorage.setItem(ROOT_SORT_KEY, v);
  } catch {
    // ignore (private mode)
  }
}
