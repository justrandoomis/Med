// Crash-safe note drafts (§0.6 «never lose the owner's writing», §58 reload / crash tests).
//
// The note editor saves to IndexedDB 600 ms after the last keystroke, and on unmount. A browser reload, a crashed
// tab or a killed app never unmounts anything, and an IndexedDB write started while the page is being torn down is
// not guaranteed to commit — measured in Chromium (docs/PERFORMANCE.md): text typed right before a reload was LOST.
// So every keystroke also writes a small synchronous backup to localStorage; a successful IndexedDB save removes it;
// the next load turns any backup still present into a saved note (IndexedDB row + outbox op, like a normal save).
//
// Recovery never creates duplicates and never writes over someone else's text:
//   * the draft carries the note id the editor saves under (new notes get their id when the editor opens);
//   * already saved with the same text → nothing to do;
//   * the stored note is still what the editor last saw → the draft is applied on top of it;
//   * the stored note changed elsewhere meanwhile (or was deleted) → the draft is kept as a NEW note next to it.
import { richTextToPlain, stripBidiControls, type AnnotationAnchor, type RichText } from '@medlevo/shared';
import type { MedLevoDB } from '../../../lib/localdb';
import { saveNote, type WorkspaceNoteRow } from './local';

export const NOTE_DRAFT_PREFIX = 'medlevo.note-draft.';

export interface NoteDraft {
  v: 1;
  /** the editor instance (stable while it is open) */
  key: string;
  /** the note id the editor saves under */
  noteId: string;
  body: RichText;
  anchor: AnnotationAnchor | null;
  /** text of the stored note as the editor last saw / wrote it (null: not stored yet) */
  baseText: string | null;
  savedAt: number;
}

export function noteText(body: RichText): string {
  return stripBidiControls(richTextToPlain(body));
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Synchronous backup of what is being typed (best effort: a full or blocked storage never blocks typing). */
export function writeNoteDraft(d: Omit<NoteDraft, 'v' | 'savedAt'>): void {
  try {
    storage()?.setItem(NOTE_DRAFT_PREFIX + d.key, JSON.stringify({ v: 1, ...d, savedAt: Date.now() } satisfies NoteDraft));
  } catch {
    // quota / private mode: the IndexedDB save still runs
  }
}

/** Remove the backup once `savedText` is in IndexedDB — unless newer text was typed meanwhile. */
export function clearNoteDraft(key: string, savedText?: string): void {
  const s = storage();
  if (!s) return;
  try {
    if (savedText !== undefined) {
      const raw = s.getItem(NOTE_DRAFT_PREFIX + key);
      const d = raw ? (JSON.parse(raw) as NoteDraft) : null;
      if (d && noteText(d.body) !== savedText) return;
    }
    s.removeItem(NOTE_DRAFT_PREFIX + key);
  } catch {
    // ignore
  }
}

export function readNoteDrafts(): NoteDraft[] {
  const s = storage();
  if (!s) return [];
  const out: NoteDraft[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k?.startsWith(NOTE_DRAFT_PREFIX)) continue;
      try {
        const d = JSON.parse(s.getItem(k) ?? 'null') as NoteDraft | null;
        if (d && d.v === 1 && typeof d.noteId === 'string' && d.body && Array.isArray(d.body.paragraphs)) out.push(d);
      } catch {
        // unreadable entry: left for inspection, never applied
      }
    }
  } catch {
    return out;
  }
  return out;
}

let running: Promise<number> | null = null;

/** Turn every backup left by an interrupted editor into a saved note. Returns how many notes were written. */
export function recoverNoteDrafts(db: MedLevoDB): Promise<number> {
  running ??= (async () => {
    let written = 0;
    for (const d of readNoteDrafts()) {
      const text = noteText(d.body);
      if (!text.trim()) {
        clearNoteDraft(d.key);
        continue;
      }
      const row = ((await db.notes.get(d.noteId)) as WorkspaceNoteRow | undefined) ?? null;
      const live = row && !row.deletedAt ? row : null;
      if (live && noteText(live.body as RichText) === text) {
        clearNoteDraft(d.key); // the save did reach IndexedDB
        continue;
      }
      if (live && (d.baseText === null || noteText(live.body as RichText) === d.baseText)) {
        await saveNote(db, { body: d.body, anchor: (live.anchor as AnnotationAnchor | null) ?? d.anchor }, live);
      } else if (!row) {
        await saveNote(db, { id: d.noteId, body: d.body, anchor: d.anchor }, null);
      } else {
        // changed on another device meanwhile, or deleted: keep both — the draft becomes its own note
        await saveNote(db, { body: d.body, anchor: d.anchor }, null);
      }
      written++;
      clearNoteDraft(d.key);
    }
    return written;
  })().finally(() => {
    running = null;
  });
  return running;
}
