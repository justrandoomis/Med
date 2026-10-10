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
import { ExternalLinkDialog } from '../notes/NotePageDialogs';

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

  it('keeps the owner on the same sheet when note pages arrive, are trashed or move before it (review F1)', () => {
    const ctx: ReaderPageContextValue = {
      sourceId: 'S1',
      versionId: 'V1',
      mode: 'pdf',
      pdf: null,
      textInteractive: true,
      inkInteractive: false,
      inkEnabled: false,
      notePageInk: false,
      notePageActions: null,
      onStrokeActiveChange: () => undefined,
      highlight: null,
      searchResults: [],
      currentResult: null,
      registerTextRoot: () => undefined,
      anchorFor: () => null,
      textLang: null,
      reportPageSize: () => undefined,
    };
    const pages = [page(0), page(1), page(2), page(3)];
    const view = (sheets: ReturnType<typeof buildSequence>, pageIndex: number) => (
      <ReaderPageContext.Provider value={ctx}>
        <BookCanvas
          id="book"
          sheets={sheets}
          fallbackSize={null}
          pageIndex={pageIndex}
          zoom={0.5}
          fit={null}
          viewRotation={0}
          layout="continuous"
          spreadRtl
          flipAnimation={false}
          label="book"
          onLocation={() => undefined}
          onEffectiveZoom={() => undefined}
          onZoomGesture={() => undefined}
          onViewed={() => undefined}
        />
      </ReaderPageContext.Provider>
    );
    // the page under the reading line (a quarter down the viewport, ANCHOR_LINE)
    const pageAtLine = (container: HTMLElement) => {
      const scroller = container.querySelector<HTMLElement>('#book')!;
      const line = scroller.scrollTop + 800 * 0.25;
      const els = Array.from(container.querySelectorAll<HTMLElement>('[data-seq]')).sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
      let hit: HTMLElement | undefined;
      for (const e of els) if (parseFloat(e.style.top) <= line) hit = e;
      return hit?.dataset.notePageId ?? `P${hit?.dataset.pageIndex}`;
    };
    // opened on the 4th page: the note pages are still loading from IndexedDB
    const r = render(view(buildSequence(pages, []), 3));
    expect(pageAtLine(r.container)).toBe('P3');
    // a note page after the 1st page arrives (IndexedDB / the server): the reader stays on the 4th page
    const withNote = buildSequence(pages, [note({ id: 'N1', afterPageId: 'P0', afterPageIndex: 0 })]);
    r.rerender(view(withNote, 4));
    expect(pageAtLine(r.container)).toBe('P3');
    // a second one before it, then the first is trashed: still the 4th page
    const two = buildSequence(pages, [note({ id: 'N1', afterPageId: 'P0', afterPageIndex: 0 }), note({ id: 'N2', afterPageId: 'P1', afterPageIndex: 1, sortOrder: 2 })]);
    r.rerender(view(two, 5));
    expect(pageAtLine(r.container)).toBe('P3');
    r.rerender(view(buildSequence(pages, [note({ id: 'N2', afterPageId: 'P1', afterPageIndex: 1, sortOrder: 2 })]), 4));
    expect(pageAtLine(r.container)).toBe('P3');
  });

  it('when the note page the owner is on goes away, the place stays where it was (the sheet that follows it)', () => {
    const ctx = { sourceId: 'S1', versionId: 'V1', mode: 'pdf', pdf: null, textInteractive: true, inkInteractive: false, inkEnabled: false, notePageInk: false, notePageActions: null, onStrokeActiveChange: () => undefined, highlight: null, searchResults: [], currentResult: null, registerTextRoot: () => undefined, anchorFor: () => null, textLang: null, reportPageSize: () => undefined } as ReaderPageContextValue;
    const pages = [page(0), page(1), page(2), page(3)];
    const props = { id: 'book', fallbackSize: null, zoom: 0.5, fit: null, viewRotation: 0, layout: 'continuous' as const, spreadRtl: true, flipAnimation: false, label: 'book', onLocation: () => undefined, onEffectiveZoom: () => undefined, onZoomGesture: () => undefined, onViewed: () => undefined };
    const withNote = buildSequence(pages, [note({ id: 'N9', afterPageId: 'P1', afterPageIndex: 1 })]);
    const r = render(
      <ReaderPageContext.Provider value={ctx}>
        <BookCanvas {...props} sheets={withNote} pageIndex={2} />
      </ReaderPageContext.Provider>,
    );
    const scroller = r.container.querySelector<HTMLElement>('#book')!;
    const topOf = (sel: string) => parseFloat(r.container.querySelector<HTMLElement>(sel)!.style.top);
    expect(scroller.scrollTop + 200).toBeGreaterThanOrEqual(topOf('[data-note-page-id="N9"]'));
    r.rerender(
      <ReaderPageContext.Provider value={ctx}>
        <BookCanvas {...props} sheets={buildSequence(pages, [])} pageIndex={2} />
      </ReaderPageContext.Provider>,
    );
    // the third page (the one that followed the trashed note page) is under the reading line
    const line = scroller.scrollTop + 200;
    expect(line).toBeGreaterThanOrEqual(topOf('[data-page-index="2"]'));
    expect(line).toBeLessThan(topOf('[data-page-index="3"]'));
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

describe('external links of a PDF (review F1)', () => {
  it('opens only after an explicit confirmation, in a new window without opener; shows the address that would really open', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      const onClose = vi.fn();
      // a right-to-left override in the path and a look-alike (Cyrillic «а») host: displayed normalized, never as written
      const raw = 'https://exаmple.org/‮gpj.exe';
      const r = render(<ExternalLinkDialog url={raw} onClose={onClose} />);
      const dialog = screen.getByRole('alertdialog');
      expect(dialog.textContent).toContain('https://xn--exmple-4nf.org/%E2%80%AEgpj.exe');
      expect(dialog.textContent).not.toContain('‮');
      expect(open).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
      expect(open).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
      r.unmount();
      render(<ExternalLinkDialog url="https://example.org/a" onClose={() => undefined} />);
      fireEvent.click(screen.getByRole('button', { name: 'افتح في نافذة جديدة' }));
      await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://example.org/a', '_blank', 'noopener,noreferrer'));
    } finally {
      open.mockRestore();
    }
  });

  it('a javascript: / data: link is never opened, even when the owner confirms', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      const onClose = vi.fn();
      render(<ExternalLinkDialog url="javascript:alert(1)" onClose={onClose} />);
      expect(screen.getByRole('alertdialog').textContent).toContain('ليس رابط ويب أو بريد');
      fireEvent.click(screen.getByRole('button', { name: 'حسنًا' }));
      await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
});
