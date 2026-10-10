// Integration (I1 #2 and #4) on one rendered reader page.
//  #2 An image-only (scanned) page whose image the Download Manager stored is drawn from that copy (object URL,
//     revoked on unmount) — image requests never pass through the API transport, so `/api/files/:id` cannot work
//     offline. A page image that was not downloaded says so while offline.
//  #4 A region the owner superseded with a correction (status 'rejected') is never overlaid, listed or searched in
//     the reader, in image mode (OCR layer) and in text mode (DOCX / slide paragraphs).
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import type { OfflineManifestResponse, PageRegionsResponse, SourcePageView, SourceRegionView } from '@medlevo/shared';
import { setFetchImpl } from '../../../lib/api';
import { downloadSource, removeDownload, useFileSrc } from '../../../lib/offline';
import { clearRegionCache, fetchRegions, readerRegions } from '../data/api';
import type { PageGeom } from './geometry';
import { PageView } from './PageView';
import { ReaderPageContext, type ReaderPageContextValue } from './readerContext';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const page = (over: Partial<SourcePageView> = {}): SourcePageView => ({
  id: 'PG1',
  version_id: 'V1',
  page_index: 0,
  printed_label: null,
  printed_label_origin: null,
  kind: 'image',
  width: 1000,
  height: 1400,
  unit: 'px',
  rotation: 0,
  text_status: 'ocr',
  ocr_confidence: 0.9,
  has_images: true,
  processing_status: 'ready',
  error_code: null,
  error_detail_ar: null,
  thumbnail_file_id: null,
  render_file_id: 'IMG1',
  section_key: null,
  ...over,
} as SourcePageView);

const region = (id: string, text: string, status: SourceRegionView['status'], order: number): SourceRegionView => ({
  id,
  version_id: 'V1',
  page_id: 'PG1',
  parent_region_id: null,
  kind: 'paragraph',
  reading_order: order,
  bbox: { x: 0.1, y: 0.1 * order, w: 0.8, h: 0.05 },
  locator: null,
  text,
  text_origin: status === 'owner_reviewed' ? 'owner' : 'ocr',
  lang: 'en',
  confidence: 0.8,
  structure: null,
  status,
});

const REGIONS: PageRegionsResponse = {
  page: page(),
  regions: [region('R-OLD', 'Misread OCR text (superseded)', 'rejected', 1), region('R-NEW', 'Corrected text by the owner', 'owner_reviewed', 1), region('R-2', 'Second line', 'extracted', 2)],
};

const geom: PageGeom = { index: 0, viewW: 500, viewH: 700, top: 0, left: 0, scale: 0.5, rotation: 0 };

function ctx(mode: ReaderPageContextValue['mode']): ReaderPageContextValue {
  return {
    sourceId: 'S1',
    versionId: 'V1',
    mode,
    pdf: null,
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
}

function mount(mode: ReaderPageContextValue['mode'], p = page()) {
  return render(
    <ReaderPageContext.Provider value={ctx(mode)}>
      <PageView page={p} geom={geom} unrotated={{ w: 1000, h: 1400 }} near />
    </ReaderPageContext.Provider>,
  );
}

function setOnline(on: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => on });
}

async function downloadScan() {
  const manifest: OfflineManifestResponse = {
    format: 'medlevo-offline-1',
    source: { id: 'S1', title: 'Scanned page', source_type: 'lecture', format: 'image' },
    version: { id: 'V1', version_no: 1, is_active: true, page_count: 1, processing_status: 'ready' },
    include_solutions: true,
    generated_at: 1,
    content_hash: 'H',
    entries: [{ kind: 'file', role: 'page_image', file_id: 'IMG1', url: '/api/files/IMG1', mime: 'image/png', size: PNG.length, sha256: sha(PNG), page_id: 'PG1', page_index: 0 }],
    totals: { bytes: PNG.length, file_bytes: PNG.length, data_bytes: 0, files: 1, data: 0, solution_bytes: 0 },
    contents: { pages: 1, page_images: 1, has_display_pdf: false, annotations: 0, notes: 0, note_pages: 0, study_book: null, questions: { linked: 0, with_solutions: 0 }, flashcards: 0, review_events: 0 },
    not_included_ar: [],
  };
  const bundle = { format: 'medlevo-offline-1', source_id: 'S1', version_id: 'V1', content_hash: 'H', generated_at: 1, entries: [] };
  setFetchImpl(async (url) => new Response(JSON.stringify(url.includes('/manifest') ? manifest : bundle), { status: 200, headers: { 'content-type': 'application/json' } }));
  await downloadSource('S1', { fetchFile: vi.fn(async () => new Response(PNG as BodyInit, { status: 200 })) });
}

let created: string[];
let revoked: string[];
beforeEach(() => {
  clearRegionCache();
  created = [];
  revoked = [];
  // jsdom has no object URLs: record them
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const u = `blob:test/${++n}`;
    created.push(u);
    return u;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
    revoked.push(u);
  });
});

afterEach(async () => {
  setOnline(true);
  setFetchImpl(null);
  clearRegionCache();
  await removeDownload('S1');
});

describe('image pages from the download (I1 #2)', () => {
  it('a downloaded page image is drawn from this device and its object URL is revoked on unmount', async () => {
    await downloadScan();
    setOnline(false);
    setFetchImpl(async (url) => {
      if (url.includes('/regions')) return new Response(JSON.stringify(REGIONS), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new TypeError('Failed to fetch');
    });
    const view = mount('image');
    const img = await waitFor(() => {
      const el = document.querySelector<HTMLImageElement>('img.wk-page-image');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(img.getAttribute('src')).toBe(created[0]);
    expect(img.getAttribute('src')).not.toContain('/api/files/');
    view.unmount();
    expect(revoked).toEqual([created[0]]);
  });

  it('not downloaded → the authenticated file route; offline, a failed image says it is not on this device', async () => {
    const { result } = renderHook(() => useFileSrc('NOT-HERE'));
    await waitFor(() => expect(result.current).toBe('/api/files/NOT-HERE'));
    expect(created).toHaveLength(0);

    setOnline(false);
    setFetchImpl(async () => new Response(JSON.stringify({ ...REGIONS, regions: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    mount('image', page({ render_file_id: 'NOT-HERE' }));
    const img = await waitFor(() => {
      const el = document.querySelector<HTMLImageElement>('img.wk-page-image');
      expect(el).not.toBeNull();
      return el!;
    });
    img.dispatchEvent(new Event('error'));
    expect(await screen.findByText('صورة هذه الصفحة غير محمّلة على هذا الجهاز؛ تظهر عند عودة الاتصال.')).toBeTruthy();
  });
});

describe('superseded (rejected) regions are not shown in the reader (I1 #4)', () => {
  beforeEach(() => {
    setFetchImpl(async () => new Response(JSON.stringify(REGIONS), { status: 200, headers: { 'content-type': 'application/json' } }));
  });

  it('readerRegions / fetchRegions drop rejected regions (one source for overlays, lists and in-page search)', async () => {
    expect(readerRegions(REGIONS).regions.map((r) => r.id)).toEqual(['R-NEW', 'R-2']);
    expect((await fetchRegions('PG1')).regions.map((r) => r.id)).toEqual(['R-NEW', 'R-2']);
  });

  it('image mode: the OCR text layer carries the correction, not the superseded text', async () => {
    mount('image');
    expect(await screen.findByText('Corrected text by the owner')).toBeTruthy();
    expect(screen.queryByText('Misread OCR text (superseded)')).toBeNull();
    expect(document.querySelectorAll('.wk-ocrlayer__run')).toHaveLength(2);
  });

  it('text mode: superseded paragraphs are not listed', async () => {
    mount('text', page({ kind: 'docx_section', render_file_id: null }));
    expect(await screen.findByText('Corrected text by the owner')).toBeTruthy();
    expect(screen.queryByText('Misread OCR text (superseded)')).toBeNull();
    expect(document.querySelector('[data-region-id="R-OLD"]')).toBeNull();
  });
});
