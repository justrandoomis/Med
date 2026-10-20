// Round 7 — H3 item 6 (reported by the F1 review): near the end of a document the reading line slides down
// (`readingLineY`, so the last page can become current), and the place (page + offset under that line) is saved from
// there — but the place was re-applied with the line at a FIXED quarter of the viewport. Reopening a source at its
// second-to-last page on a phone therefore scrolled further than the saved place and landed one page later. The canvas
// now re-applies a held place through the exact inverse of the place computation (`scrollTopForPlace`), so the same
// page and offset come back; explicit jumps (go-to, thumbnails: a page top) keep their behaviour.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { SourcePageView } from '@medlevo/shared';
import { buildSequence } from '../model/sequence';
import { clampZoom } from '../model/zoom';
import { BookCanvas, boxesFor } from './BookCanvas';
import { anchorAt, layoutContinuous, readingLineY, scrollTopFor, scrollTopForPlace } from './geometry';
import { ReaderPageContext, type ReaderPageContextValue } from './readerContext';

const N = 14;
const VW = 390;
const VH = 727;
const ZOOM = 0.45;
const page = (i: number): SourcePageView =>
  ({
    id: `P${i}`, version_id: 'V1', page_index: i, printed_label: String(11 + i), printed_label_origin: 'pdf_page_labels', kind: 'page', width: 595, height: 842, unit: 'pt', rotation: 0,
    text_status: 'digital', ocr_confidence: null, has_images: false, processing_status: 'ready', error_code: null, error_detail_ar: null, thumbnail_file_id: null, render_file_id: null, section_key: null,
  }) as SourcePageView;
const sheets = buildSequence(Array.from({ length: N }, (_, i) => page(i)), []);
const layout = layoutContinuous(boxesFor(sheets, null), clampZoom(ZOOM), 0, VW);
const placeAt = (scrollTop: number) => anchorAt(layout, readingLineY(scrollTop, VH, layout.contentH));

// jsdom lays nothing out: a phone-sized scroller whose scrollTop is stored and whose scrollHeight is the content height
const store = new WeakMap<Element, number>();
const saved = (['clientWidth', 'clientHeight', 'scrollTop', 'scrollHeight'] as const).map((p) => [p, Object.getOwnPropertyDescriptor(HTMLElement.prototype, p) ?? Object.getOwnPropertyDescriptor(Element.prototype, p)] as const);
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => VW });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VH });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => layout.contentH });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return store.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      store.set(this, Math.max(0, Math.min(v, layout.contentH - VH)));
    },
  });
});
afterEach(() => {
  for (const [p, d] of saved) {
    if (d) Object.defineProperty(HTMLElement.prototype, p, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[p];
  }
});

function mount(pageIndex: number, initialFrac: number) {
  const ctx: ReaderPageContextValue = {
    sourceId: 'S1', versionId: 'V1', mode: 'pdf', pdf: null, textInteractive: true, inkInteractive: false, inkEnabled: false, onStrokeActiveChange: () => undefined,
    highlight: null, searchResults: [], currentResult: null, registerTextRoot: () => undefined, anchorFor: () => null, textLang: null, reportPageSize: () => undefined,
  };
  const r = render(
    <ReaderPageContext.Provider value={ctx}>
      <BookCanvas id="book" sheets={sheets} fallbackSize={null} pageIndex={pageIndex} initialFrac={initialFrac} zoom={ZOOM} fit={null} viewRotation={0} layout="continuous" spreadRtl flipAnimation={false} label="book"
        onLocation={() => undefined} onEffectiveZoom={() => undefined} onZoomGesture={() => undefined} onViewed={() => undefined} />
    </ReaderPageContext.Provider>,
  );
  const scroller = r.container.querySelector<HTMLElement>('.wk-canvas')!;
  return { scroller };
}

describe('H3 item 6 — a place saved near the end of a book is shown again exactly', () => {
  const maxScroll = layout.contentH - VH;

  it('reopening at a place on the second-to-last page shows that page and offset (it landed one page later)', () => {
    // a scroll position in the last stretch, where the reading line slides down
    let s = maxScroll - VH * 0.6;
    while (placeAt(s).index !== N - 2 && s > 0) s -= 7;
    const place = placeAt(s);
    expect(place.index).toBe(N - 2);
    const { scroller } = mount(place.index, place.frac);
    const back = placeAt(scroller.scrollTop);
    expect(back.index).toBe(place.index);
    expect(Math.abs(back.frac - place.frac)).toBeLessThan(0.01);
  });

  it('every place along the whole book survives a reopen (the inverse is exact, away from the end too)', () => {
    for (let s = 0; s <= maxScroll; s += 53) {
      const place = placeAt(s);
      const restored = scrollTopForPlace(layout, place.index, place.frac, VH);
      const back = placeAt(Math.ceil(restored));
      expect(back.index, `scrollTop ${s}`).toBe(place.index);
      expect(Math.abs(back.frac - place.frac), `scrollTop ${s}`).toBeLessThan(0.01);
    }
  });

  it('explicit jumps to a page top are unchanged: every page reached by a jump is current, the last one fully in view', () => {
    for (let i = 0; i < N; i++) expect(placeAt(scrollTopFor(layout, i, 0, VH)).index, `page ${i}`).toBe(i);
    const s = scrollTopFor(layout, N - 1, 0, VH);
    const g = layout.pages[N - 1]!;
    expect(g.top).toBeGreaterThanOrEqual(s);
    expect(g.top + g.viewH).toBeLessThanOrEqual(s + VH);
  });
});
