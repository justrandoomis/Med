// The reader's page sequence with inserted note pages (track F1, §26 / §25): placement by page id first, by index
// when the page is not in the version shown (never dropped), order among pages after the same source page, moves
// across source pages, and the lookups the reader uses.
import { describe, expect, it } from 'vitest';
import type { SourcePageView } from '@medlevo/shared';
import type { WorkspaceNotePageRow } from '../data/local';
import { moveNoteInSequence } from '../notes/readerNotePages';
import { buildSequence, indexSequence, insertionAfter, placementOf, sheetLabel, type ReaderSheet } from './sequence';

const page = (i: number, label: string | null = String(11 + i)): SourcePageView => ({
  id: `P${i}`,
  version_id: 'V1',
  page_index: i,
  printed_label: label,
  printed_label_origin: label ? 'pdf_page_labels' : null,
  kind: 'page',
  width: 595,
  height: 842,
  unit: 'pt',
  rotation: 0,
  text_status: 'digital',
  ocr_confidence: null,
  has_images: false,
  processing_status: 'ready',
  error_code: null,
  error_detail_ar: null,
  thumbnail_file_id: null,
  render_file_id: null,
  section_key: null,
});
const pages = [page(0), page(1), page(2)];

let seq = 0;
function note(o: Partial<WorkspaceNotePageRow>): WorkspaceNotePageRow {
  seq++;
  return {
    id: `N${seq}`,
    sourceId: 'S1',
    nodeId: null,
    afterPageIndex: 0,
    afterPageId: null,
    title: null,
    template: 'ruled',
    kind: 'page',
    width: 595,
    height: 842,
    sortOrder: 1,
    createdAt: seq,
    updatedAt: seq,
    deletedAt: null,
    syncState: 'synced',
    ...o,
  } as WorkspaceNotePageRow;
}
const keys = (s: readonly ReaderSheet[]) => s.map((x) => (x.kind === 'source' ? `p${x.page.page_index}` : x.note.id));

describe('buildSequence', () => {
  it('inserts note pages after the source page they follow, in sort order; trashed pages and dividers are not in the reader', () => {
    const a = note({ id: 'A', afterPageIndex: 0, afterPageId: 'P0', sortOrder: 2 });
    const b = note({ id: 'B', afterPageIndex: 0, afterPageId: 'P0', sortOrder: 1 });
    const c = note({ id: 'C', afterPageIndex: 2, afterPageId: 'P2' });
    const gone = note({ id: 'GONE', afterPageIndex: 1, deletedAt: 5 });
    const divider = note({ id: 'DIV', kind: 'divider', afterPageIndex: 1 });
    expect(keys(buildSequence(pages, [a, b, c, gone, divider]))).toEqual(['p0', 'B', 'A', 'p1', 'p2', 'C']);
  });

  it('places by page id first; a page id from another version falls back to the index, clamped — the page is never dropped', () => {
    // the version shown has its pages in another order: P2 now comes first
    const reordered = [{ ...page(0), id: 'P2' }, { ...page(1), id: 'P0' }, { ...page(2), id: 'P1' }];
    const byId = note({ id: 'BYID', afterPageIndex: 0, afterPageId: 'P0' });
    expect(placementOf(byId, reordered)).toEqual({ after: 1, byIndex: false });
    const otherVersion = note({ id: 'OLD', afterPageIndex: 9, afterPageId: 'P-OLD' });
    expect(placementOf(otherVersion, reordered)).toEqual({ after: 2, byIndex: true });
    const s = buildSequence(reordered, [byId, otherVersion]);
    expect(keys(s)).toEqual(['p0', 'p1', 'BYID', 'p2', 'OLD']);
    expect(s.find((x) => x.kind === 'note' && x.note.id === 'OLD')).toMatchObject({ placedByIndex: true });
  });

  it('a page inserted before the first page (after = -1) opens the book', () => {
    const first = note({ id: 'FIRST', afterPageIndex: -1 });
    expect(keys(buildSequence(pages, [first]))).toEqual(['FIRST', 'p0', 'p1', 'p2']);
  });

  it('indexSequence maps source pages and note pages both ways', () => {
    const s = buildSequence(pages, [note({ id: 'X', afterPageIndex: 0 }), note({ id: 'Y', afterPageIndex: -1 })]);
    const ix = indexSequence(s);
    expect(keys(s)).toEqual(['Y', 'p0', 'X', 'p1', 'p2']);
    expect(ix.ofSource(0)).toBe(1);
    expect(ix.ofSource(2)).toBe(4);
    expect(ix.ofNote('X')).toBe(2);
    expect(ix.ofNote('nope')).toBe(-1);
    expect(ix.sourceAtOrBefore(2)).toBe(0);
    expect(ix.sourceAtOrBefore(0)).toBe(0);
    expect(ix.sourceAtOrBefore(4)).toBe(2);
  });

  it('labels a note page by its title, paper and place', () => {
    const s = buildSequence(pages, [note({ id: 'L', afterPageIndex: 1, afterPageId: 'P1', title: 'خلاصة', template: 'grid' })]);
    expect(sheetLabel(s[2]!, pages)).toBe('«خلاصة» — صفحة ملاحظات (مربعات) بعد ص 12 (الصفحة 2 في الملف)');
    expect(sheetLabel(s[0]!, pages)).toBe('ص 11 (الصفحة 1 في الملف)');
  });
});

describe('inserting and moving note pages', () => {
  it('a new page after a source page goes right after it (before older note pages there); after a note page, right after that one', () => {
    const s = buildSequence(pages, [note({ id: 'K', afterPageIndex: 0, afterPageId: 'P0', sortOrder: 5 })]);
    expect(insertionAfter(s, 0)).toEqual({ afterPageIndex: 0, afterPageId: 'P0', prevOrder: null, nextOrder: 5 });
    expect(insertionAfter(s, 1)).toEqual({ afterPageIndex: 0, afterPageId: 'P0', prevOrder: 5, nextOrder: null });
  });

  it('moves past a neighbouring note page of the same place, and across source pages in both directions', () => {
    const a = note({ id: 'A', afterPageIndex: 1, afterPageId: 'P1', sortOrder: 1 });
    const b = note({ id: 'B', afterPageIndex: 1, afterPageId: 'P1', sortOrder: 2 });
    const c = note({ id: 'C', afterPageIndex: 0, afterPageId: 'P0', sortOrder: 7 });
    const s = buildSequence(pages, [a, b, c]);
    expect(keys(s)).toEqual(['p0', 'C', 'p1', 'A', 'B', 'p2']);
    // B earlier: before A, same place
    const bUp = moveNoteInSequence(s, 'B', -1)!;
    expect(bUp.afterPageIndex).toBeUndefined();
    expect(bUp.sortOrder!).toBeLessThan(1);
    // A earlier: across p1 → it now follows p0, after C
    expect(moveNoteInSequence(s, 'A', -1)).toEqual({ afterPageIndex: 0, afterPageId: 'P0', sortOrder: 8 });
    // B later: across p2 → follows p2, first there
    expect(moveNoteInSequence(s, 'B', 1)).toEqual({ afterPageIndex: 2, afterPageId: 'P2', sortOrder: 1 });
    // C earlier: across p0 → before the first page
    expect(moveNoteInSequence(s, 'C', -1)).toEqual({ afterPageIndex: -1, afterPageId: null, sortOrder: 1 });
    // nothing beyond the ends
    const last = buildSequence(pages, [note({ id: 'Z', afterPageIndex: 2, afterPageId: 'P2' })]);
    expect(moveNoteInSequence(last, 'Z', 1)).toBeNull();
    expect(moveNoteInSequence(last, 'missing', 1)).toBeNull();
  });
});
