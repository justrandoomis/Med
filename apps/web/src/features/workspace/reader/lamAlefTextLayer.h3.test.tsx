// Round 7 — H3 item 8: the reader's selectable pdf.js text layer showed (and copied) the PDF's reversed lam-alef
// («األلم» for «الألم», «ال يعد» for «لا يعد») although the server repairs it in the stored text. The reader now applies
// the SAME narrow repair (shared `fixReversedLamAlef`) to the text-layer items and to the in-document search text —
// character for character (the repair never changes a length), so search offsets, DOM text nodes and hit rectangles
// still agree. Words the rule must never touch stay exactly as the PDF has them.
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { SourcePageView } from '@medlevo/shared';
import type { PageGeom } from './geometry';
import { PageView } from './PageView';
import { pdfHandleFor, type PdfHandle } from './pdfDoc';
import { ReaderPageContext, type ReaderPageContextValue } from './readerContext';

const item = (str: string, x: number, hasEOL = false, y = 700) => ({ str, dir: 'rtl', transform: [12, 0, 0, 12, x, y], width: str.length * 6, height: 12, fontName: 'F1', hasEOL });

/** A page of the Golden Set kind: reversed ligatures at word starts, split across items, plus words that must not move. */
const ITEMS = [
  item('يبدأ ', 500),
  item('األلم ', 440),
  item('عادة حول السرة', 300, true),
  // a word split over two items by the producer: «اإل» + «نجاب»
  item('اإل', 520, false, 680),
  item('نجاب ', 480, false, 680),
  item('أي مما يلي ال يعد عرضًا إال الحمى', 200, true, 680),
  // must never change: correct article + hamza, «ألم», «إلى», «الآن», «آلة», «إلا», «ألا», «الالتهاب», «العالج» (inside a word: not repairable)
  item('الألم ألم إلى الآن آلة إلا ألا الالتهاب العالج McBurney 2-3 cm', 100, true, 660),
];
const RAW_TEXT = ITEMS.map((i) => i.str).join('');

function fakeDoc() {
  const pageProxy = {
    rotate: 0,
    cleanup: vi.fn(() => true),
    getTextContent: async () => ({ items: ITEMS.map((i) => ({ ...i })), styles: {} }),
    getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale, rawDims: { pageWidth: 595, pageHeight: 842 } }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  };
  const doc = { numPages: 1, getPage: vi.fn(async () => pageProxy as unknown as PDFPageProxy), loadingTask: { destroy: vi.fn() } } as unknown as PDFDocumentProxy;
  return doc;
}

describe('H3 item 8 — reversed lam-alef in the reader text layer', () => {
  it('the in-document search text is repaired, keeps its length and its line breaks', async () => {
    const h = pdfHandleFor(fakeDoc(), 'F1');
    const t = await h.text(0);
    expect(t.text).toContain('يبدأ الألم عادة');
    expect(t.text).toContain('الإنجاب');
    expect(t.text).toContain('أي مما يلي لا يعد عرضًا إلا الحمى');
    expect(t.text).not.toContain('األلم');
    // false positives: untouched
    expect(t.text).toContain('الألم ألم إلى الآن آلة إلا ألا الالتهاب العالج McBurney 2-3 cm');
    expect(t.text.length).toBe(RAW_TEXT.length);
    const rawBreaks: number[] = [];
    let n = 0;
    for (const i of ITEMS) {
      n += i.str.length;
      if (i.hasEOL) rawBreaks.push(n);
    }
    expect(t.breaks).toEqual(rawBreaks);
  });

  it('the selectable text layer shows (so copies) the repaired words, item by item with the same lengths', async () => {
    const seen: Array<{ items: Array<{ str: string }> }> = [];
    vi.doMock('../../../lib/pdf', () => ({
      loadPdfjs: async () => ({
        TextLayer: class {
          private c: HTMLElement;
          private src: { items: Array<{ str: string }> };
          constructor(o: { textContentSource: { items: Array<{ str: string }> }; container: HTMLElement }) {
            this.c = o.container;
            this.src = o.textContentSource;
            seen.push(o.textContentSource);
          }
          render() {
            for (const it of this.src.items) {
              const s = document.createElement('span');
              s.textContent = it.str;
              this.c.appendChild(s);
            }
            return Promise.resolve();
          }
          cancel() {}
        },
      }),
    }));
    vi.resetModules();
    const { PageView: FreshPageView } = (await import('./PageView')) as { PageView: typeof PageView };
    const { ReaderPageContext: Ctx } = (await import('./readerContext')) as { ReaderPageContext: typeof ReaderPageContext };
    const doc = fakeDoc();
    const handle = pdfHandleFor(doc, 'F1') as PdfHandle;
    const page: SourcePageView = {
      id: 'P0', version_id: 'V1', page_index: 0, printed_label: '11', printed_label_origin: 'pdf_page_labels', kind: 'page', width: 595, height: 842, unit: 'pt', rotation: 0,
      text_status: 'digital', ocr_confidence: null, has_images: false, processing_status: 'ready', error_code: null, error_detail_ar: null, thumbnail_file_id: null, render_file_id: null, section_key: null,
    } as SourcePageView;
    const geom: PageGeom = { index: 0, viewW: 595, viewH: 842, top: 0, left: 0, scale: 1, rotation: 0 };
    const roots: Array<HTMLElement | null> = [];
    const value: ReaderPageContextValue = {
      sourceId: 'S1', versionId: 'V1', mode: 'pdf', pdf: handle, textInteractive: true, inkInteractive: false, inkEnabled: false, onStrokeActiveChange: () => {},
      highlight: null, searchResults: [], currentResult: null, registerTextRoot: (_i, el) => roots.push(el), anchorFor: () => null, textLang: 'ar', reportPageSize: () => {},
    };
    const view = render(
      <Ctx.Provider value={value}>
        <FreshPageView page={page} geom={geom} unrotated={{ w: 595, h: 842 }} near />
      </Ctx.Provider>,
    );
    const layer = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>('.wk-textlayer');
      expect(el?.textContent).toContain('الألم');
      return el!;
    });
    expect(layer.textContent).not.toContain('األلم');
    expect(layer.textContent).toContain('لا يعد عرضًا إلا الحمى');
    // item by item: same count, same lengths (spans keep their pdf.js geometry)
    expect(seen[0]!.items.map((i) => i.str.length)).toEqual(ITEMS.map((i) => i.str.length));
    // the DOM text of the text root is exactly the search text (hits land on the right characters)
    expect(layer.textContent).toBe((await handle.text(0)).text);
    vi.doUnmock('../../../lib/pdf');
  });
});
