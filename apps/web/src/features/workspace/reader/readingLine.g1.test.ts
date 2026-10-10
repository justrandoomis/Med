// G1 / AC-04 regression (found on a 390×844 phone): a citation «ص12» that points at the LAST page of a book opened
// the right page, but the indicator said «ص 11» — the last page can never scroll up to a reading line a quarter down
// the viewport, so the page above it stayed "current". The reading line now slides to the bottom over the last stretch.
import { describe, expect, it } from 'vitest';
import { ANCHOR_LINE, anchorAt, layoutContinuous, readingLineY, scrollTopFor, type PageBox } from './geometry';

// 14 A4 pages at a phone's fit-width scale (390 px wide, 24 px margins → 342 css px for 595 pt), viewport 727 px high
const pages: PageBox[] = Array.from({ length: 14 }, (_, index) => ({ index, w: 595, h: 842, unit: 'pt', intrinsic: 0 }));
const VH = 727;
const ZOOM = (342 / 595) * (72 / 96);
const layout = layoutContinuous(pages, ZOOM, 0, 390);
const maxScroll = layout.contentH - VH;
const current = (scrollTop: number) => anchorAt(layout, readingLineY(scrollTop, VH, layout.contentH)).index;

describe('G1 AC-04 — the current page at the end of the book', () => {
  it('jumping to the last page makes the last page current (it used to report the page above it)', () => {
    const target = scrollTopFor(layout, 13, 0, VH);
    expect(target).toBe(maxScroll); // clamped: the last page cannot reach the reading line
    expect(anchorAt(layout, target + VH * ANCHOR_LINE).index).toBe(12); // the old rule: the page above
    expect(current(target)).toBe(13);
  });

  it('every page reached by a jump is the current page, from the first to the last', () => {
    for (let i = 0; i < 14; i++) expect(current(scrollTopFor(layout, i, 0, VH)), `page ${i}`).toBe(i);
  });

  it('away from the end the reading line stays a quarter down; scrolling never goes backwards', () => {
    expect(readingLineY(0, VH, layout.contentH)).toBe(VH * ANCHOR_LINE);
    let last = -1;
    for (let s = 0; s <= maxScroll; s += 37) {
      const c = current(s);
      expect(c).toBeGreaterThanOrEqual(last);
      last = c;
    }
  });

  it('a document shorter than the viewport keeps its first page current at the top', () => {
    const short = layoutContinuous(pages.slice(0, 1), ZOOM, 0, 390);
    expect(anchorAt(short, readingLineY(0, 2000, short.contentH)).index).toBe(0);
  });
});
