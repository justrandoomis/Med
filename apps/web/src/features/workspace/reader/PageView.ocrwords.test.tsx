// H2 item 6 — the reader's OCR text layer uses the server's WORD boxes (`locator.words`): every OCR word is placed over
// its glyphs (position from its box, font size from its height) so selection and search-hit rectangles fall on the
// scanned words — before, one fixed 10 px run per region put the text on the right line but not on the words. The DOM
// text of the layer stays exactly the page's search text (offsets of search hits), and a region without word boxes is
// rendered as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { PageRegionsResponse, SourcePageView, SourceRegionView } from '@medlevo/shared';
import { setFetchImpl } from '../../../lib/api';
import { clearRegionCache } from '../data/api';
import { ocrRunSegments, regionPageText, regionTextRuns } from '../model/regionText';
import type { PageGeom } from './geometry';
import { PageView } from './PageView';
import type { PdfHandle } from './pdfDoc';
import { ReaderPageContext, type ReaderPageContextValue } from './readerContext';

const page = {
  id: 'PG-SCAN',
  version_id: 'V1',
  page_index: 0,
  printed_label: null,
  printed_label_origin: null,
  kind: 'page',
  width: 600,
  height: 800,
  unit: 'pt',
  rotation: 0,
  text_status: 'ocr',
  ocr_confidence: 0.94,
  has_images: true,
  processing_status: 'ready',
  error_code: null,
  error_detail_ar: null,
  thumbnail_file_id: null,
  render_file_id: 'RENDER1',
  section_key: null,
} as SourcePageView;

const withWords: SourceRegionView = {
  id: 'R1',
  version_id: 'V1',
  page_id: 'PG-SCAN',
  parent_region_id: null,
  kind: 'paragraph',
  reading_order: 1,
  bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 },
  locator: {
    words: [
      ['The', 0.1, 0.2, 0.06, 0.025],
      ['urea', 0.17, 0.2, 0.07, 0.025],
      ['breath', 0.25, 0.2, 0.1, 0.025],
      ['test', 0.36, 0.2, 0.06, 0.025],
      ['confirms', 0.1, 0.225, 0.14, 0.025],
      ['infection.', 0.25, 0.225, 0.15, 0.025],
    ],
  },
  text: 'The urea breath test confirms infection.',
  text_origin: 'ocr',
  lang: 'en',
  confidence: 0.92,
  structure: null,
  status: 'extracted',
};
const plain: SourceRegionView = { ...withWords, id: 'R2', reading_order: 2, bbox: { x: 0.1, y: 0.4, w: 0.5, h: 0.03 }, locator: null, text: 'Page without word boxes.' };
const REGIONS: PageRegionsResponse = { page, regions: [plain, withWords] };

const fakePdf = (): PdfHandle => {
  const pdfPage = {
    rotate: 0,
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, rawDims: { pageWidth: 600, pageHeight: 800 } }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    streamTextContent: () => new ReadableStream(),
  };
  return {
    fileId: 'PDF1',
    doc: {} as PdfHandle['doc'],
    numPages: 1,
    page: async () => pdfPage as unknown as Awaited<ReturnType<PdfHandle['page']>>,
    text: async () => ({ text: '', breaks: [] }),
    destroy: () => {},
  };
};

function mount() {
  const value: ReaderPageContextValue = {
    sourceId: 'S1',
    versionId: 'V1',
    mode: 'pdf',
    pdf: fakePdf(),
    textInteractive: true,
    inkInteractive: false,
    inkEnabled: false,
    onStrokeActiveChange: () => {},
    highlight: null,
    searchResults: [],
    currentResult: null,
    registerTextRoot: () => {},
    anchorFor: () => null,
    textLang: null,
    reportPageSize: () => {},
  };
  const geom: PageGeom = { index: 0, viewW: 600, viewH: 800, top: 0, left: 0, scale: 1, rotation: 0 };
  return render(
    <ReaderPageContext.Provider value={value}>
      <PageView page={page} geom={geom} unrotated={{ w: 600, h: 800 }} near />
    </ReaderPageContext.Provider>,
  );
}

beforeEach(() => {
  clearRegionCache();
  setFetchImpl(async () => new Response(JSON.stringify(REGIONS), { status: 200, headers: { 'content-type': 'application/json' } }));
});
afterEach(() => {
  setFetchImpl(null);
  clearRegionCache();
});

describe('OCR text layer from word boxes (H2 item 6)', () => {
  it('splits a run at its words: every character kept in order; words not found stay in the gaps', () => {
    const seg = ocrRunSegments(withWords)!;
    expect(seg.map((s) => s.text).join('')).toBe(withWords.text);
    expect(seg.filter((s) => s.kind === 'word').map((s) => s.text)).toEqual(['The', 'urea', 'breath', 'test', 'confirms', 'infection.']);
    expect(ocrRunSegments(plain)).toBeNull();
    // text changed after OCR (a repaired word): the other words still place, the changed one stays in a gap
    const repaired = ocrRunSegments({ ...withWords, text: 'The urea breath-test confirms infection.' })!;
    expect(repaired.map((s) => s.text).join('')).toBe('The urea breath-test confirms infection.');
    // too few words found → one block as before
    expect(ocrRunSegments({ ...withWords, text: 'something else entirely' })).toBeNull();
  });

  it('a table found on a scan is read from its cells at their places, not from its serialized summary (H2 item 2)', () => {
    const table: SourceRegionView = { ...plain, id: 'T', kind: 'table', reading_order: 3, text: 'Drug: Amoxicillin | Dose: 500 mg' };
    const cell: SourceRegionView = { ...plain, id: 'C', kind: 'table_cell', reading_order: 4, text: 'Amoxicillin' };
    expect(regionTextRuns([table, cell, withWords]).map((r) => r.id)).toEqual(['R1', 'C']);
  });

  it('places each OCR word over its glyphs (position and size from its box); the layer text is the page search text', async () => {
    const view = mount();
    const layer = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>('.wk-ocrlayer');
      expect(el?.textContent).toContain('urea breath test');
      return el!;
    });
    expect(layer.textContent).toBe(regionPageText(REGIONS.regions));
    const words = Array.from(layer.querySelectorAll<HTMLElement>('.wk-ocrlayer__word'));
    expect(words.map((w) => w.textContent)).toEqual(['The', 'urea', 'breath', 'test', 'confirms', 'infection.']);
    const breath = words[2]!;
    // relative to its run box (x 0.1, y 0.2, w 0.5, h 0.05): left (0.25 - 0.1) / 0.5 = 30 %, second line top 50 %
    expect(parseFloat(breath.style.left)).toBeCloseTo(30, 3);
    expect(parseFloat(breath.style.top)).toBeCloseTo(0, 3);
    expect(parseFloat(words[4]!.style.top)).toBeCloseTo(50, 3);
    expect(parseFloat(breath.style.height)).toBeCloseTo(50, 3);
    // font size from the word height on the page: 0.025 × 800 px × 0.85
    expect(parseFloat(breath.style.fontSize)).toBeCloseTo(17, 1);
    expect(breath.dataset.w).toBe('0.1');
    // the spaces between words are in the DOM (copy, offsets) but draw nothing
    expect(Array.from(layer.querySelectorAll('.wk-ocrlayer__gap')).map((g) => g.textContent)).toEqual([' ', ' ', ' ', ' ', ' ']);
    // a region without word boxes is one block, as before
    const runs = Array.from(layer.querySelectorAll('.wk-ocrlayer__run'));
    expect(runs[1]!.querySelector('.wk-ocrlayer__word')).toBeNull();
    expect(runs.map((r) => r.textContent)).toEqual([withWords.text, plain.text]);
  });
});

vi.mock('../../../lib/pdf', () => ({ loadPdfjs: async () => ({ TextLayer: class { render() { return Promise.resolve(); } cancel() {} } }) }));
