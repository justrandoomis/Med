// Regression (I2 resilience pass, docs/PERFORMANCE.md): in Chromium, note text typed right before a page reload was
// LOST — the editor saves 600 ms after the last keystroke or on unmount, and a reload / crashed tab does neither.
// Every keystroke now leaves a synchronous localStorage draft that the next load turns into a saved note, without
// duplicates and without writing over another device's text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { richTextToPlain, type RichText } from '@medlevo/shared';
import { getDb } from '../../../lib/localdb';
import { NoteEditor } from '../panels/MineTab';
import { NOTE_DRAFT_PREFIX, readNoteDrafts, recoverNoteDrafts } from './noteDrafts';
import type { WorkspaceNoteRow } from './local';

const anchor = { type: 'page' as const, source_id: 'S1', version_id: 'V1', page_id: 'P1', page_index: 0, space: 'page_norm' as const };
const body = (t: string): RichText => ({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t }] }] });
const live = async () => (await getDb().notes.toArray()).filter((n) => !n.deletedAt) as WorkspaceNoteRow[];
const texts = async () => (await live()).map((n) => richTextToPlain(n.body as RichText)).sort();

beforeEach(async () => {
  localStorage.clear();
  const db = getDb();
  await db.open();
  await db.notes.clear();
  await db.outbox.clear();
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('note drafts survive a reload / crash', () => {
  it('text typed just before the page dies is recovered as a saved, queued note — once', async () => {
    // the 600 ms save never runs: the page is gone before it (fake timers, and the editor is never unmounted)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<NoteEditor existing={null} anchor={anchor} quote={null} pageLabel="ص 11" onClose={() => undefined} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ألم حول السرة ثم ينتقل' } });
    expect(await live()).toHaveLength(0); // nothing in IndexedDB yet …
    const drafts = readNoteDrafts();
    expect(drafts).toHaveLength(1); // … but the keystrokes are backed up synchronously

    // next load
    expect(await recoverNoteDrafts(getDb())).toBe(1);
    expect(await texts()).toEqual(['ألم حول السرة ثم ينتقل']);
    const [n] = await live();
    expect(n!.id).toBe(drafts[0]!.noteId); // the id the editor would have saved under
    expect(n!.anchor).toEqual(anchor);
    const ops = await getDb().outbox.where('entity_type').equals('note').toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'upsert', entity_id: n!.id });
    expect(readNoteDrafts()).toHaveLength(0);
    expect(await recoverNoteDrafts(getDb())).toBe(0);
    expect(await live()).toHaveLength(1);
  });

  it('a save that reached IndexedDB clears the draft: nothing is recovered twice, and the late save edits the same note', async () => {
    render(<NoteEditor existing={null} anchor={anchor} quote={null} pageLabel="ص 11" onClose={() => undefined} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'نص محفوظ' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 800)); // the debounced save runs
    });
    expect(await texts()).toEqual(['نص محفوظ']);
    expect(Object.keys(localStorage).filter((k) => k.startsWith(NOTE_DRAFT_PREFIX))).toHaveLength(0);
    expect(await recoverNoteDrafts(getDb())).toBe(0);
    expect(await live()).toHaveLength(1);
  });

  it('a draft whose text already reached IndexedDB is dropped without writing (no duplicate)', async () => {
    const db = getDb();
    await db.notes.put({ id: 'N9', nodeId: null, anchorKey: 'source_page:P1', title: null, body: body('نفس النص'), anchor, origin: 'owner', conflictOfId: null, sourceId: 'S1', rev: 2, createdAt: 1, updatedAt: 1, deletedAt: null, syncState: 'synced' } as WorkspaceNoteRow);
    localStorage.setItem(`${NOTE_DRAFT_PREFIX}k1`, JSON.stringify({ v: 1, key: 'k1', noteId: 'N9', body: body('نفس النص'), anchor, baseText: null, savedAt: 1 }));
    expect(await recoverNoteDrafts(db)).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(readNoteDrafts()).toHaveLength(0);
  });

  it('an edit of an existing note is applied on top of it; if the note changed elsewhere meanwhile, both are kept', async () => {
    const db = getDb();
    const base = { nodeId: null, anchorKey: 'source_page:P1', title: null, anchor, origin: 'owner' as const, conflictOfId: null, sourceId: 'S1', createdAt: 1, updatedAt: 1, deletedAt: null, syncState: 'synced' as const };
    await db.notes.put({ ...base, id: 'A', body: body('قبل'), rev: 3 } as WorkspaceNoteRow);
    await db.notes.put({ ...base, id: 'B', body: body('نص من جهاز آخر'), rev: 5 } as WorkspaceNoteRow);
    localStorage.setItem(`${NOTE_DRAFT_PREFIX}a`, JSON.stringify({ v: 1, key: 'a', noteId: 'A', body: body('قبل وبعد'), anchor, baseText: 'قبل', savedAt: 1 }));
    // B's editor last saw «أصل»; another device's text arrived since → never written over
    localStorage.setItem(`${NOTE_DRAFT_PREFIX}b`, JSON.stringify({ v: 1, key: 'b', noteId: 'B', body: body('تعديلي غير المحفوظ'), anchor, baseText: 'أصل', savedAt: 1 }));
    expect(await recoverNoteDrafts(db)).toBe(2);
    expect(richTextToPlain((await db.notes.get('A'))!.body as RichText)).toBe('قبل وبعد');
    const opA = (await db.outbox.where('entity_id').equals('A').toArray())[0]!;
    expect(opA).toMatchObject({ op: 'upsert', base_rev: 3 });
    expect(richTextToPlain((await db.notes.get('B'))!.body as RichText)).toBe('نص من جهاز آخر');
    expect(await texts()).toEqual(['تعديلي غير المحفوظ', 'قبل وبعد', 'نص من جهاز آخر'].sort());
  });
});
