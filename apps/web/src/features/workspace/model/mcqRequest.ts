// «أنشئ سؤال اختيار من متعدد» from a selection (§30, track F3): the selection toolbar hands the selection over through
// this small store; the workspace opens the rail's «الأسئلة» section, which shows the Create MCQ panel for it. Same
// pattern as the explanation hand-over (aiActions.ts) — a separate store, so the two never consume each other's requests.
import { useSyncExternalStore } from 'react';
import type { NormBox } from '@medlevo/shared';

export interface McqRequest {
  /** unique per click (the rail reacts once) */
  id: string;
  source_id: string;
  version_id: string;
  page_id: string;
  pageIndex: number;
  /** the selected text (logical order, ≤ 6000 characters) */
  text: string;
  /** selection rectangles (normalized, unrotated page) → the panel resolves the region ids under them */
  rects: NormBox[];
}

let pending: McqRequest | null = null;
const listeners = new Set<() => void>();
let seq = 0;

export const mcqRequestStore = {
  get: (): McqRequest | null => pending,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  request(r: Omit<McqRequest, 'id'>): McqRequest {
    pending = { ...r, text: r.text.slice(0, 6000), id: `${Date.now()}-${++seq}` };
    listeners.forEach((l) => l());
    return pending;
  },
  clear(id?: string): void {
    if (id && pending?.id !== id) return;
    pending = null;
    listeners.forEach((l) => l());
  },
};

export function useMcqRequest(): McqRequest | null {
  return useSyncExternalStore(mcqRequestStore.subscribe, mcqRequestStore.get, mcqRequestStore.get);
}
