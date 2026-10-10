// G1 / AC-02 regression: a scanned (image-only) page INSIDE a PDF has no PDF text layer, so pdf.js finds no text
// there. The server OCR'd it (text_status 'ocr'); the reader must carry that OCR text as the page's text layer
// (selectable, read by screen readers, the root for search hits) and the in-document search must search it.
// Before the fix the reader showed the scan with an EMPTY text layer and the search never found its words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { PageRegionsResponse, SourcePageView, SourceRegionView } from '@medlevo/shared';
import { setFetchImpl } from '../../../lib/api';
import { pageText } from '../chrome/SearchPanel';
import { clearRegionCache } from '../data/api';
import { pdfPageUsesRegionText, regionPageText } from '../model/regionText';
import { searchPages } from '../model/search';
import type { PageGeom } from './geometry';
import { PageView } from './PageView';
import type { PdfHandle } from './pdfDoc';
import { ReaderPageContext, type ReaderPageContextValue } from './readerContext';

const page = (over: Partial<SourcePageView>): SourcePageView =>
  ({
    id: 'PG-SCAN',
    version_id: 'V1',
    page_index: 1,
    printed_label: null,
    printed_label_origin: null,
    kind: 'page',
    width: 595,
    height: 842,
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
    ...over,
  }) as SourcePageView;

const region = (id: string, text: string, order: number, over: Partial<SourceRegionView> = {}): SourceRegionView => ({
  id,
  version_id: 'V1',
  page_id: 'PG-SCAN',
  parent_region_id: null,
  kind: 'paragraph',
  reading_order: order,
  bbox: { x: 0.1, y: 0.1 * order, w: 0.8, h: 0.05 },
  locator: null,
  text,
  text_origin: 'ocr',
  lang: 'en',
  confidence: 0.9,
  structure: null,
  status: 'extracted',
  ...over,
});

const REGIONS: PageRegionsResponse = {
  page: page({}),
  regions: [
    region('R2', 'The urea breath test is a non-invasive test for active infection.', 2),
    region('R1', 'Helicobacter pylori (H. pylori) infection is a common cause of peptic ulcer disease.', 1),
    region('RF', '', 3, { kind: 'figure', text: null }),
  ],
};

/** a pdf.js page stand-in: no text content at all (a scan), drawing resolves at once */
const fakePdf = (): PdfHandle & { textCalls: number[] } => {
  const textCalls: number[] = [];
  const pdfPage = {
    rotate: 0,
    getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale, rawDims: { pageWidth: 595, pageHeight: 842 } }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    streamTextContent: () => new ReadableStream(),
  };
  return {
    fileId: 'PDF1',
    doc: {} as PdfHandle['doc'],
    numPages: 3,
    page: async () => pdfPage as unknown as Awaited<ReturnType<PdfHandle['page']>>,
    text: async (i: number) => {
      textCalls.push(i);
      return { text: i === 1 ? '' : 'Ultrasound is the first-line imaging test.', breaks: [] };
    },
    destroy: () => {},
    textCalls,
  };
};

const geom: PageGeom = { index: 1, viewW: 595, viewH: 842, top: 0, left: 0, scale: 1, rotation: 0 };

function mount(p: SourcePageView, pdf: PdfHandle, registerTextRoot: ReaderPageContextValue['registerTextRoot']) {
  const value: ReaderPageContextValue = {
    sourceId: 'S1',
    versionId: 'V1',
    mode: 'pdf',
    pdf,
    textInteractive: true,
    inkInteractive: false,
    inkEnabled: false,
    onStrokeActiveChange: () => {},
    highlight: null,
    searchResults: [],
    currentResult: null,
    registerTextRoot,
    anchorFor: () => null,
    textLang: null,
    reportPageSize: () => {},
  };
  return render(
    <ReaderPageContext.Provider value={value}>
      <PageView page={p} geom={geom} unrotated={{ w: 595, h: 842 }} near />
    </ReaderPageContext.Provider>,
  );
}

let regionRequests: string[];
beforeEach(() => {
  clearRegionCache();
  regionRequests = [];
  setFetchImpl(async (url) => {
    regionRequests.push(url);
    return new Response(JSON.stringify(REGIONS), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  setFetchImpl(null);
  clearRegionCache();
});

describe('G1 AC-02 — a scanned page inside a PDF is read from its OCR text, never as an empty page', () => {
  it('only OCR / mixed PDF pages use region text', () => {
    expect(pdfPageUsesRegionText({ text_status: 'ocr' })).toBe(true);
    expect(pdfPageUsesRegionText({ text_status: 'mixed' })).toBe(true);
    for (const s of ['digital', 'no_text_found', 'needs_ocr', 'pending', 'failed'] as const) expect(pdfPageUsesRegionText({ text_status: s })).toBe(false);
  });

  it('the reader puts the OCR runs (reading order, no figure) on the scanned PDF page and registers them as its text root', async () => {
    const roots: Array<HTMLElement | null> = [];
    const view = mount(page({}), fakePdf(), (_i, el) => roots.push(el));
    const layer = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>('.wk-page[data-page-index="1"] .wk-ocrlayer');
      expect(el?.textContent).toContain('urea breath test');
      return el!;
    });
    expect(Array.from(layer.querySelectorAll('.wk-ocrlayer__run')).map((s) => s.textContent)).toEqual([REGIONS.regions[1]!.text, REGIONS.regions[0]!.text]);
    await waitFor(() => expect(roots.at(-1)).toBe(layer));
    // the text root's DOM text is exactly the page's search text (offsets of hits land on the right characters)
    expect(layer.textContent).toBe(regionPageText(REGIONS.regions));
  });

  it('a digital PDF page keeps the pdf.js text layer and fetches no regions', async () => {
    const view = mount(page({ id: 'PG-DIGITAL', page_index: 0, text_status: 'digital', has_images: false, render_file_id: null }), fakePdf(), () => {});
    await waitFor(() => expect(view.container.querySelector('.wk-textlayer')).not.toBeNull());
    expect(view.container.querySelector('.wk-ocrlayer')).toBeNull();
    expect(regionRequests.filter((u) => u.includes('/regions'))).toEqual([]);
  });

  it('in-document search reads the scanned page from its OCR text (and digital pages from pdf.js)', async () => {
    const pdf = fakePdf();
    const doc = { mode: 'pdf' as const, pdf };
    const scan = await pageText(doc, page({}));
    expect(scan.text).toContain('pylori');
    const digital = await pageText(doc, page({ id: 'PG0', page_index: 0, text_status: 'digital' }));
    expect(digital.text).toContain('Ultrasound');
    expect(pdf.textCalls).toEqual([0]); // the scan was not read from the (empty) PDF text layer
    const res = searchPages(
      [
        { pageIndex: 0, ...digital },
        { pageIndex: 1, ...scan },
      ],
      'pylori',
    );
    expect(res.results.map((r) => r.pageIndex)).toEqual([1, 1]);
  });
});

vi.mock('../../../lib/pdf', () => ({ loadPdfjs: async () => ({ TextLayer: class { render() { return Promise.resolve(); } cancel() {} } }) }));
