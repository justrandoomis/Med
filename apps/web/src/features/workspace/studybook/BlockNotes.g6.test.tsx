// G6 / AC-22 regression: after a Study Book update, a note is never shown «على» a DIFFERENT paragraph that inherited
// its block key (block keys carry an ordinal per region: a regeneration with fewer / reordered paragraphs about a region
// hands the key to another paragraph). Two signals, both tested: the server's re-anchoring report for the version
// shown (`unanchoredIds`), and — offline, before any report — the quote the note kept of its paragraph.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { richTextFromPlain, type ContentBlockView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { getDb } from '../../../lib/localdb';
import { saveNote } from '../data/local';
import { BlockNotes } from './BlockNotes';

const block = (key: string, text: string, ord: number): ContentBlockView => ({
  id: `id-${key}`,
  block_key: key,
  section_key: 's1',
  ord,
  kind: 'paragraph',
  content: richTextFromPlain(text),
  table: null,
  source_region_ids: ['R1'],
  status: 'complete',
  verification_status: 'linked',
});

const FIRST = 'Anorexia and nausea are common;';
const SECOND = 'vomiting usually follows the onset of pain.';

beforeEach(async () => {
  const db = getDb();
  await db.open();
  await db.notes.clear();
  await db.outbox.clear();
});

async function mount(blocks: ContentBlockView[], versionNo: number, unanchoredIds?: Set<string>) {
  const jump = vi.fn();
  render(
    <ToastProvider>
      <BlockNotes lineageId="LIN" versionNo={versionNo} blocks={blocks} topBlockKey={null} onJump={jump} unanchoredIds={unanchoredIds} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText(/ملاحظاتي على هذا الكتاب/));
  return jump;
}

describe('BlockNotes after a Study Book update (AC-22)', () => {
  it('a note whose key now holds ANOTHER paragraph (its kept quote no longer matches) is listed for re-anchoring, not shown on it', async () => {
    // written on v1's first paragraph (key k0); v2 dropped that paragraph and the second one inherited k0
    await saveNote(getDb(), { body: richTextFromPlain('ملاحظتي على الفقرة الأولى'), anchor: { type: 'block', lineage_id: 'LIN', artifact_version: 1, block_key: 'k0', quote: { exact: FIRST } } });
    const jump = await mount([block('k0', SECOND, 0)], 2);
    await screen.findByText('ملاحظتي على الفقرة الأولى');
    expect(screen.queryByRole('button', { name: /على: «vomiting/ })).toBeNull();
    expect(screen.getByText(/فقرتها تغيّرت في هذه النسخة — تحتاج إعادة ربط/)).toBeTruthy();
    expect(jump).not.toHaveBeenCalled();
    // the note itself is untouched on this device
    const [n] = await getDb().notes.toArray();
    expect(n!.anchorKey).toBe('artifact_block:LIN:k0');
    expect(n!.deletedAt ?? null).toBeNull();
  });

  it('the server report wins even without a quote (chat «save as note» anchors carry none)', async () => {
    const note = await saveNote(getDb(), { body: richTextFromPlain('ملاحظة من المحادثة'), anchor: { type: 'block', lineage_id: 'LIN', artifact_version: 1, block_key: 'k0' } });
    await mount([block('k0', SECOND, 0)], 2, new Set([note.id]));
    await screen.findByText('ملاحظة من المحادثة');
    expect(screen.queryByRole('button', { name: /على: «/ })).toBeNull();
    expect(screen.getByText(/فقرتها تغيّرت في هذه النسخة/)).toBeTruthy();
  });

  it('the same paragraph (identical, or lightly reworded) keeps the note attached and jumpable', async () => {
    await saveNote(getDb(), { body: richTextFromPlain('ملاحظة باقية'), anchor: { type: 'block', lineage_id: 'LIN', artifact_version: 1, block_key: 'k0', quote: { exact: FIRST } } });
    const jump = await mount([block('k0', 'Anorexia and nausea are common.', 0), block('k1', SECOND, 1)], 2);
    await screen.findByText('ملاحظة باقية');
    fireEvent.click(screen.getByRole('button', { name: /على: «Anorexia and nausea/ }));
    expect(jump).toHaveBeenCalledWith('k0');
  });
});
