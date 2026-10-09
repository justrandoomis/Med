// Regression (independent review of track B1): the note editor saved 600 ms after the last keystroke and
// CANCELLED that save when it unmounted — closing the rail / sheet, switching tabs or opening another note
// right after typing dropped the last words (§0.6: never lose the owner's writing). Two overlapping saves of
// a new note (debounce + «تم») could also create the note twice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { richTextToPlain, type RichText } from '@medlevo/shared';
import { getDb } from '../../../lib/localdb';
import { NoteEditor } from './MineTab';

const anchor = { type: 'page' as const, source_id: 'S1', version_id: 'V1', page_id: 'P1', page_index: 0, space: 'page_norm' as const };

beforeEach(async () => {
  const db = getDb();
  await db.open();
  await db.notes.clear();
  await db.outbox.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

const notes = async () => (await getDb().notes.toArray()).filter((n) => !n.deletedAt);

describe('NoteEditor', () => {
  it('keeps what was typed when the editor closes before the debounced save ran', async () => {
    const r = render(<NoteEditor existing={null} anchor={anchor} quote={null} pageLabel="ص 11" onClose={() => undefined} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ألم حول السرة' } });
    r.unmount(); // e.g. the owner closed the rail sheet immediately
    await waitFor(async () => expect(await notes()).toHaveLength(1));
    const [n] = await notes();
    expect(richTextToPlain(n!.body as RichText)).toBe('ألم حول السرة');
    const ops = await getDb().outbox.where('entity_type').equals('note').toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'upsert', entity_id: n!.id });
  });

  it('two saves in a row create ONE note (the second edits it)', async () => {
    render(<NoteEditor existing={null} anchor={anchor} quote={null} pageLabel="ص 11" onClose={() => undefined} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'نص أول' } });
    const done = screen.getByRole('button', { name: 'تم' });
    await act(async () => {
      fireEvent.click(done);
      fireEvent.click(done);
    });
    await waitFor(async () => expect((await getDb().outbox.toArray()).length).toBeGreaterThan(0));
    // let both saves finish
    await act(async () => {
      await new Promise((res) => setTimeout(res, 50));
    });
    expect(await notes()).toHaveLength(1);
  });

  it('never writes over another device\'s text that arrived while the editor was open: keeps both', async () => {
    const db = getDb();
    const body = (t: string): RichText => ({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t }] }] });
    const existing = { id: 'N1', nodeId: null, anchorKey: 'source_page:P1', title: null, body: body('أصل'), anchor, origin: 'owner' as const, conflictOfId: null, sourceId: 'S1', rev: 1, createdAt: 1, updatedAt: 1, deletedAt: null, syncState: 'synced' as const };
    await db.notes.put(existing);
    render(<NoteEditor existing={existing} anchor={anchor} quote={null} pageLabel="ص 11" onClose={() => undefined} />);
    // a conflict was kept on the server: the original now carries the other device's text (rev 3)
    await db.notes.put({ ...existing, body: body('نص الجهاز الآخر'), rev: 3 });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'نص هذا الجهاز' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'تم' }));
    });
    await waitFor(async () => expect(await notes()).toHaveLength(2));
    const all = await notes();
    expect(richTextToPlain(all.find((n) => n.id === 'N1')!.body as RichText)).toBe('نص الجهاز الآخر');
    expect(richTextToPlain(all.find((n) => n.id !== 'N1')!.body as RichText)).toBe('نص هذا الجهاز');
  });
});

