// The undo / redo history of a document on THIS device (Round 7 — H3 item 1, §26 «اختبر تاريخ Undo وحفظ الحالة بعد
// الإغلاق أو الانهيار»). The history used to live in memory only: after a reload or closing the app the ink was all
// there, but nothing could be undone. It is now kept as a command log in IndexedDB (`kv`, one entry per document:
// `ink.history.v1:<documentKey>`), written a moment after each change and when the page is hidden, and restored when
// the document opens again.
//  * Size cap: HISTORY_MAX_CHARS of JSON per document (a step that erased thousands of long strokes is large). When
//    the log is over it, the OLDEST undo steps go first, then the redo steps farthest away; a single step larger than
//    the cap is kept in memory only. The 200-step limit of the in-memory history still applies.
//  * The log holds item states (before → after), never anything the device does not already hold: the ink itself is in
//    the `annotations` table and syncs as before. Undoing a restored step goes through the same checks as any undo
//    (store.ts): a step whose items changed since — e.g. writing the server tombstoned — is never applied silently.
import type { MedLevoDB } from '../../../lib/localdb';
import type { Command } from './history';

export const HISTORY_KV_KEY = (documentKey: string) => `ink.history.v1:${documentKey}`;
/** at most this many characters of JSON per document (≈ 4 MB of UTF-16 in IndexedDB) */
export const HISTORY_MAX_CHARS = 2_000_000;

export interface SavedHistory {
  v: 1;
  undo: Command[];
  redo: Command[];
  savedAt: number;
}

/** The newest steps that fit the cap (undo steps nearest the present first, then redo steps nearest the present). */
export function capHistory(undo: readonly Command[], redo: readonly Command[], maxChars = HISTORY_MAX_CHARS): { undo: Command[]; redo: Command[]; dropped: number } {
  const overhead = 64;
  let budget = maxChars - overhead;
  const keptUndo: Command[] = [];
  const keptRedo: Command[] = [];
  const size = (c: Command) => JSON.stringify(c).length + 1;
  // walk outwards from the present: the last undo step and the last redo step (top of each stack) matter most
  let u = undo.length - 1;
  let r = redo.length - 1;
  let stopU = false;
  let stopR = false;
  while (u >= 0 || r >= 0) {
    if (u >= 0 && !stopU) {
      const s = size(undo[u]!);
      if (s <= budget) {
        keptUndo.unshift(undo[u]!);
        budget -= s;
      } else stopU = true; // older steps cannot be undone past a missing one
    }
    u--;
    if (r >= 0 && !stopR) {
      const s = size(redo[r]!);
      if (s <= budget) {
        keptRedo.unshift(redo[r]!);
        budget -= s;
      } else stopR = true;
    }
    r--;
  }
  return { undo: keptUndo, redo: keptRedo, dropped: undo.length + redo.length - keptUndo.length - keptRedo.length };
}

export async function saveHistory(db: MedLevoDB, documentKey: string, undo: readonly Command[], redo: readonly Command[], now = Date.now()): Promise<void> {
  const capped = capHistory(undo, redo);
  const value: SavedHistory = { v: 1, undo: capped.undo, redo: capped.redo, savedAt: now };
  if (value.undo.length === 0 && value.redo.length === 0) {
    await db.kv.delete(HISTORY_KV_KEY(documentKey));
    return;
  }
  await db.kv.put({ key: HISTORY_KV_KEY(documentKey), value, updatedAt: now });
}

export async function loadHistory(db: MedLevoDB, documentKey: string): Promise<SavedHistory | null> {
  const row = await db.kv.get(HISTORY_KV_KEY(documentKey));
  const v = row?.value as SavedHistory | undefined;
  if (!v || v.v !== 1 || !Array.isArray(v.undo) || !Array.isArray(v.redo)) return null;
  const valid = (c: unknown): c is Command => !!c && typeof (c as Command).label_ar === 'string' && Array.isArray((c as Command).changes);
  return { v: 1, undo: v.undo.filter(valid), redo: v.redo.filter(valid), savedAt: Number(v.savedAt) || 0 };
}
