// Book Canvas geometry: where every page sits at a given zoom / rotation / layout. Pure functions so the
// reader can keep the owner's place exactly through zoom, rotation, layout and window changes, and render
// only the pages near the viewport (virtualization).
import { normalizeRotation, viewSize, type QuarterTurn } from '@medlevo/shared';
import { cssScale } from '../model/zoom';

export interface PageBox {
  index: number;
  /** unrotated size in page units */
  w: number;
  h: number;
  unit: 'pt' | 'px';
  /** intrinsic rotation of the page (/Rotate), degrees */
  intrinsic: number;
}

export interface PageGeom {
  index: number;
  /** rendered (rotated) page box in css px */
  viewW: number;
  viewH: number;
  /** top-left of the page box inside the scroll content */
  top: number;
  left: number;
  /** css px per page unit */
  scale: number;
  /** total rotation (intrinsic + view) */
  rotation: QuarterTurn;
}

export interface Layout {
  pages: PageGeom[];
  contentW: number;
  contentH: number;
}

export const PAGE_GAP = 20;
export const FOLIO_H = 30;
export const PAD_X = 24;
export const PAD_Y = 20;

export function pageGeomSize(p: PageBox, zoom: number, viewRotation: number): { viewW: number; viewH: number; scale: number; rotation: QuarterTurn } {
  const scale = cssScale(zoom, p.unit);
  const rotation = normalizeRotation(p.intrinsic + viewRotation);
  const { width, height } = viewSize({ pageWidth: p.w, pageHeight: p.h, scale, rotation });
  return { viewW: width, viewH: height, scale, rotation };
}

/** One column, all pages (continuous scroll). Pages are centered horizontally. */
export function layoutContinuous(pages: readonly PageBox[], zoom: number, viewRotation: number, containerWidth: number): Layout {
  const sized = pages.map((p) => ({ p, ...pageGeomSize(p, zoom, viewRotation) }));
  const maxW = sized.reduce((m, s) => Math.max(m, s.viewW), 0);
  const contentW = Math.max(containerWidth, maxW + PAD_X * 2);
  let y = PAD_Y;
  const out: PageGeom[] = sized.map((s) => {
    const g: PageGeom = { index: s.p.index, viewW: s.viewW, viewH: s.viewH, top: y, left: (contentW - s.viewW) / 2, scale: s.scale, rotation: s.rotation };
    y += s.viewH + FOLIO_H + PAGE_GAP;
    return g;
  });
  return { pages: out, contentW, contentH: y - PAGE_GAP + PAD_Y };
}

/** The pages of one spread side by side (a single page is a one-page spread). `rtl` puts the first page on the right. */
export function layoutSpread(pages: readonly PageBox[], zoom: number, viewRotation: number, containerWidth: number, rtl: boolean, containerHeight = 0): Layout {
  const sized = pages.map((p) => ({ p, ...pageGeomSize(p, zoom, viewRotation) }));
  const totalW = sized.reduce((m, s) => m + s.viewW, 0) + PAGE_GAP * Math.max(0, sized.length - 1);
  const maxH = sized.reduce((m, s) => Math.max(m, s.viewH), 0);
  const contentW = Math.max(containerWidth, totalW + PAD_X * 2);
  const contentH = Math.max(containerHeight, maxH + FOLIO_H + PAD_Y * 2);
  const startX = (contentW - totalW) / 2;
  const top = Math.max(PAD_Y, (contentH - maxH - FOLIO_H) / 2);
  const ordered = rtl ? [...sized].reverse() : sized;
  let x = startX;
  const placed = new Map<number, PageGeom>();
  for (const s of ordered) {
    placed.set(s.p.index, { index: s.p.index, viewW: s.viewW, viewH: s.viewH, top, left: x, scale: s.scale, rotation: s.rotation });
    x += s.viewW + PAGE_GAP;
  }
  return { pages: sized.map((s) => placed.get(s.p.index)!), contentW, contentH };
}

/** Indexes of the spread that contains `pageIndex`. Pairs start at the first page: [0,1], [2,3], … */
export function spreadOf(pageIndex: number, layout: 'single' | 'double' | 'continuous', count: number): number[] {
  if (count <= 0) return [];
  const i = Math.min(Math.max(0, pageIndex), count - 1);
  if (layout !== 'double') return [i];
  const first = i - (i % 2);
  return first + 1 < count ? [first, first + 1] : [first];
}

/** Next / previous spread start for paged layouts. */
export function stepSpread(pageIndex: number, dir: 1 | -1, layout: 'single' | 'double' | 'continuous', count: number): number {
  const spread = spreadOf(pageIndex, layout, count);
  const size = layout === 'double' ? 2 : 1;
  const first = spread[0] ?? 0;
  return Math.min(Math.max(0, first + dir * size), Math.max(0, count - 1));
}

/** The reading line sits a quarter down the viewport: the page under it is "the current page". */
export const ANCHOR_LINE = 0.25;

/**
 * Content y of the reading line for a scroll position. The last pages of a book can never scroll up to a line a
 * quarter down the viewport (the scroll stops at the end), so over the last stretch of scrolling the line slides
 * down to the bottom of the viewport: at the end of the book the last page is the current page. Without this a jump
 * to the last page (a citation «ص12» on a phone) left the page ABOVE it in the indicator (AC-04).
 */
export function readingLineY(scrollTop: number, viewportH: number, contentH: number): number {
  const base = viewportH * ANCHOR_LINE;
  const ramp = viewportH - base; // how far the line can still travel down
  const maxScroll = Math.max(0, contentH - viewportH);
  const start = Math.max(0, maxScroll - ramp);
  const span = maxScroll - start;
  if (span <= 0 || ramp <= 0) return scrollTop + base;
  const t = Math.min(1, Math.max(0, (scrollTop - start) / span));
  return scrollTop + base + t * ramp;
}

/** Page under content coordinate y, and how far into that page (0 = top, 1 = bottom of the page box). */
export function anchorAt(layout: Layout, y: number): { index: number; frac: number } {
  const pages = layout.pages;
  if (pages.length === 0) return { index: 0, frac: 0 };
  let lo = 0;
  let hi = pages.length - 1;
  // 2px tolerance: scroll positions are rounded by the browser, a page placed exactly on the line stays current
  const yy = y + 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid]!.top <= yy) lo = mid;
    else hi = mid - 1;
  }
  const g = pages[lo]!;
  // between pages (gap / folio) belongs to the page above
  const frac = g.viewH > 0 ? (y - g.top) / g.viewH : 0;
  return { index: g.index, frac: Math.min(1, Math.max(0, frac)) };
}

/** scrollTop that puts `frac` of page `index` on the reading line. */
export function scrollTopFor(layout: Layout, index: number, frac: number, viewportH: number): number {
  const g = layout.pages.find((p) => p.index === index) ?? layout.pages[0];
  if (!g) return 0;
  const y = g.top + Math.min(1, Math.max(0, frac)) * g.viewH - viewportH * ANCHOR_LINE;
  return Math.max(0, Math.min(y, Math.max(0, layout.contentH - viewportH)));
}

/** Pages whose boxes intersect [top, bottom] (continuous layout; pages are sorted by top). */
export function pagesInRange(layout: Layout, top: number, bottom: number): number[] {
  const out: number[] = [];
  for (const g of layout.pages) {
    if (g.top > bottom) break;
    if (g.top + g.viewH + FOLIO_H >= top) out.push(g.index);
  }
  return out;
}
