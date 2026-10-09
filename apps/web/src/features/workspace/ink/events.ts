// Change notifications for annotation rows that did NOT come from this document's own edits:
// the sync applier (pulls / push results) and other tabs (BroadcastChannel). Open documents
// refresh only the pages (targetKeys) that changed.
export interface AnnotationRowsChanged {
  targetKeys: string[];
  /** ids written, when known (null → reload the whole page) */
  ids: string[] | null;
  origin: 'sync' | 'other_tab';
}

type Listener = (e: AnnotationRowsChanged) => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null | undefined;
const CHANNEL = 'medlevo-annotations';
/** identifies this tab so it ignores its own broadcasts */
const TAB_ID = Math.random().toString(36).slice(2);

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
    channel?.addEventListener('message', (ev: MessageEvent) => {
      const d = ev.data as { tab?: string; targetKeys?: unknown; ids?: unknown } | null;
      if (!d || d.tab === TAB_ID || !Array.isArray(d.targetKeys)) return;
      emitLocal({ targetKeys: d.targetKeys.filter((k): k is string => typeof k === 'string'), ids: Array.isArray(d.ids) ? (d.ids as string[]) : null, origin: 'other_tab' });
    });
  } catch {
    channel = null;
  }
  return channel;
}

function emitLocal(e: AnnotationRowsChanged) {
  listeners.forEach((l) => {
    try {
      l(e);
    } catch {
      // a listener must never break the sync applier
    }
  });
}

export function onAnnotationRowsChanged(l: Listener): () => void {
  getChannel();
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Rows written by the sync applier in THIS tab (open documents in this tab and other tabs refresh). */
export function notifySyncedRows(targetKeys: string[], ids: string[] | null): void {
  if (targetKeys.length === 0) return;
  emitLocal({ targetKeys, ids, origin: 'sync' });
  broadcast(targetKeys, ids);
}

/** This tab wrote rows locally (owner edits): tell other tabs only. */
export function broadcast(targetKeys: string[], ids: string[] | null): void {
  try {
    getChannel()?.postMessage({ tab: TAB_ID, targetKeys, ids });
  } catch {
    // ignore (closed channel / unsupported)
  }
}
