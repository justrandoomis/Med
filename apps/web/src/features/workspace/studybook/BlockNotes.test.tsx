// Notes on Study Book paragraphs (AC-22): written to this device first with a SEMANTIC block anchor
// {lineage, block_key}; a note whose block is not in the version shown is listed as needing re-anchoring
// (never moved, never deleted); a note on an existing block jumps to it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { richTextFromPlain, type ContentBlockView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { getDb } from '../../../lib/localdb';
import { saveNote, type WorkspaceNoteRow } from '../data/local';
import { BlockNotes } from './BlockNotes';

const block = (key: string, kind: ContentBlockView['kind'], text: string, ord: number): ContentBlockView => ({
  id: `id-${key}`,
  block_key: key,
  section_key: 's1',
  ord,
  kind,
  content: richTextFromPlain(text),
  table: null,
  source_region_ids: [],
  status: 'complete',
  verification_status: 'linked',
});
const blocks = [block('h1', 'heading', 'التشخيص', 0), block('p1', 'paragraph', 'الفحص الأول عند الأطفال هو Ultrasound.', 1), block('p2', 'paragraph', 'CT abdomen عند البالغين.', 2)];

beforeEach(async () => {
  const db = getDb();
  await db.open();
  await db.notes.clear();
  await db.outbox.clear();
});

describe('BlockNotes', () => {
  it('saves a note locally on the paragraph at the top of the view, with a semantic block anchor, and queues it for sync', async () => {
    render(
      <ToastProvider>
        <BlockNotes lineageId="LIN" versionNo={2} blocks={blocks} topBlockKey="h1" onJump={() => undefined} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('ملاحظاتي على هذا الكتاب'));
    // the heading on top is skipped: the note goes on the first paragraph after it
    expect(screen.getByText(/تُربط الملاحظة بالفقرة الظاهرة أعلى الكتاب: «الفحص الأول/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('ملاحظة على هذه الفقرة'), { target: { value: 'تذكّر: الأطفال أولًا' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الملاحظة' }));
    await waitFor(async () => expect((await getDb().notes.toArray()).length).toBe(1));
    const [n] = (await getDb().notes.toArray()) as WorkspaceNoteRow[];
    expect(n!.anchorKey).toBe('artifact_block:LIN:p1');
    expect(n!.anchor).toMatchObject({ type: 'block', lineage_id: 'LIN', artifact_version: 2, block_key: 'p1' });
    expect(n!.syncState).toBe('pending_sync');
    const ops = await getDb().outbox.toArray();
    expect(ops.some((o) => o.entity_type === 'note' && o.entity_id === n!.id)).toBe(true);
    await screen.findByText('تذكّر: الأطفال أولًا');
  });

  it('a note whose block is not in this version is listed as needing re-anchoring; others jump to their block', async () => {
    await saveNote(getDb(), { body: richTextFromPlain('على فقرة اختفت'), anchor: { type: 'block', lineage_id: 'LIN', artifact_version: 1, block_key: 'gone' } });
    await saveNote(getDb(), { body: richTextFromPlain('على فقرة باقية'), anchor: { type: 'block', lineage_id: 'LIN', artifact_version: 1, block_key: 'p2' } });
    await saveNote(getDb(), { body: richTextFromPlain('كتاب آخر'), anchor: { type: 'block', lineage_id: 'OTHER', artifact_version: 1, block_key: 'p2' } });
    const jump = vi.fn();
    render(
      <ToastProvider>
        <BlockNotes lineageId="LIN" versionNo={2} blocks={blocks} topBlockKey={null} onJump={jump} />
      </ToastProvider>,
    );
    expect(await screen.findByText('ملاحظاتي على هذا الكتاب (2)')).toBeTruthy(); // only this lineage
    fireEvent.click(screen.getByText('ملاحظاتي على هذا الكتاب (2)'));
    expect(screen.getByText(/فقرتها ليست في هذه النسخة — تحتاج إعادة ربط/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /على: «CT abdomen/ }));
    expect(jump).toHaveBeenCalledWith('p2');
    // nothing was rewritten: the vanished note keeps its original anchor
    const gone = ((await getDb().notes.toArray()) as WorkspaceNoteRow[]).find((x) => x.anchorKey === 'artifact_block:LIN:gone');
    expect(gone?.anchor).toMatchObject({ block_key: 'gone', artifact_version: 1 });
  });
});
