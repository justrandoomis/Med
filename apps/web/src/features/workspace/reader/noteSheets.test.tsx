// Inserted note pages in the Book Canvas (track F1, §26): a note page is a sheet of the reader's sequence between
// the source pages (its own paper size, never rotated with the PDF), labelled for assistive technology, drawn with
// its paper template, and its folio menu acts on that page only (rename / paper / move / new page after / trash).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { SourcePageView } from '@medlevo/shared';
import type { WorkspaceNotePageRow } from '../data/local';
import { buildSequence } from '../model/sequence';
import { BookCanvas, boxesFor } from './BookCanvas';
import { ReaderPageContext, type NotePageActions, type ReaderPageContextValue } from './readerContext';

const page = (i: number, rotation = 0): SourcePageView => ({
  id: `P${i}`,
  version_id: 'V1',
  page_index: i,
  printed_label: null,
  printed_label_origin: null,
  kind: 'page',
  width: 612,
  height: 792,
  unit: 'pt',
  rotation,
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
const note = (o: Partial<WorkspaceNotePageRow>): WorkspaceNotePageRow =>
  ({
    id: 'N1',
    sourceId: 'S1',
    nodeId: null,
    afterPageIndex: 0,
    afterPageId: 'P0',
    title: 'خلاصة',
    template: 'ruled',
    kind: 'page',
    color: null,
    width: 595,
    height: 842,
    sortOrder: 1,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    syncState: 'synced',
    ...o,
  }) as WorkspaceNotePageRow;

const sizeProps = ['clientWidth', 'clientHeight'] as const;
const saved = sizeProps.map((p) => [p, Object.getOwnPropertyDescriptor(HTMLElement.prototype, p)] as const);
beforeEach(() => {
  // jsdom lays nothing out: give the scroller a phone-sized viewport so the canvas computes its geometry
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 390 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
});
afterEach(() => {
  for (const [p, d] of saved) {
    if (d) Object.defineProperty(HTMLElement.prototype, p, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[p];
  }
});

function setup(actions: NotePageActions | null, layout: 'continuous' | 'single' = 'continuous', pageIndex = 1) {
  const ctx: ReaderPageContextValue = {
    sourceId: 'S1',
    versionId: 'V1',
    mode: 'pdf',
    pdf: null,
    textInteractive: true,
    inkInteractive: false,
    inkEnabled: false,
    notePageInk: false,
    notePageActions: actions,
    onStrokeActiveChange: () => undefined,
    highlight: null,
    searchResults: [],
    currentResult: null,
    registerTextRoot: () => undefined,
    anchorFor: () => null,
    textLang: null,
    reportPageSize: () => undefined,
  };
  const sheets = buildSequence([page(0), page(1)], [note({})]);
  const r = render(
    <ReaderPageContext.Provider value={ctx}>
      <BookCanvas
        id="book"
        sheets={sheets}
        fallbackSize={null}
        pageIndex={pageIndex}
        zoom={0.5}
        fit={null}
        viewRotation={0}
        layout={layout}
        spreadRtl
        flipAnimation={false}
        label="book"
        onLocation={() => undefined}
        onEffectiveZoom={() => undefined}
        onZoomGesture={() => undefined}
        onViewed={() => undefined}
      />
    </ReaderPageContext.Provider>,
  );
  return { sheets, container: r.container };
}

describe('note pages in the Book Canvas', () => {
  it('a note page is its own sheet between the source pages, paper-sized and never rotated with the PDF', () => {
    const sheets = buildSequence([page(0, 90), page(1)], [note({})]);
    const boxes = boxesFor(sheets, null);
    expect(boxes.map((b) => [b.w, b.h, b.intrinsic])).toEqual([
      [612, 792, 90],
      [595, 842, 0],
      [612, 792, 0],
    ]);
  });

  it('renders in sequence order with a label, its paper template and its folio', () => {
    const { container } = setup(null);
    const order = Array.from(container.querySelectorAll<HTMLElement>('[data-seq]')).map((e) => `${e.dataset.seq}:${e.dataset.notePageId ?? 'src'}`);
    expect(order[1]).toBe('1:N1');
    const group = screen.getByRole('group', { name: 'خلاصة — صفحة ملاحظات (مسطّرة)' });
    expect(group.getAttribute('aria-roledescription')).toBe('صفحة ملاحظات');
    const sheet = group.querySelector('.wk-sheet--note') as HTMLElement;
    expect(sheet.dataset.template).toBe('ruled');
    // the rule colour is a token (light / dark themes), never a fixed colour
    const paper = group.querySelector('.wk-paper') as HTMLElement;
    expect(paper.getAttribute('style')).toContain('var(--wk-paper-rule)');
    expect(within(group).getByText('مسطّرة')).toBeTruthy();
    // no actions given (read-only place): no menu
    expect(within(group).queryByRole('button', { name: /^خيارات صفحة الملاحظات/ })).toBeNull();
  });

  it('a paged layout shows the note page on its own when it is the current sheet', () => {
    const { container } = setup(null, 'single', 1);
    expect(Array.from(container.querySelectorAll<HTMLElement>('[data-seq]')).map((e) => e.dataset.seq)).toEqual(['1']);
  });

  it('the folio menu acts on this page: paper, move (disabled with a reason at the end), new page after, trash', () => {
    const actions: NotePageActions = {
      rename: vi.fn(),
      setTemplate: vi.fn(),
      move: vi.fn(),
      trash: vi.fn(),
      insertAfter: vi.fn(),
      canMove: (_id, dir) => dir === -1,
    };
    setup(actions);
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'خيارات صفحة الملاحظات «خلاصة»' }));
    open();
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /انقلها إلى الخلف/ }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /ورق مربعات/ }));
    expect(actions.setTemplate).toHaveBeenCalledWith('N1', 'grid');
    open();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /انقلها إلى الأمام/ }));
    expect(actions.move).toHaveBeenCalledWith('N1', -1);
    open();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /صفحة ملاحظات جديدة بعدها/ }));
    expect(actions.insertAfter).toHaveBeenCalledWith('N1');
    open();
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /نقل إلى المحذوفات/ }));
    expect(actions.trash).toHaveBeenCalledWith('N1');
  });
});
