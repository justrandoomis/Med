import { describe, expect, it } from 'vitest';
import { ANCHOR_LINE, anchorAt, layoutContinuous, layoutSpread, pagesInRange, scrollTopFor, spreadOf, stepSpread, type PageBox } from './geometry';
import { fitWidthZoom, zoomIn, zoomOut } from '../model/zoom';

const A4: PageBox[] = [0, 1, 2, 3].map((index) => ({ index, w: 595.3, h: 841.9, unit: 'pt', intrinsic: 0 }));

describe('book canvas geometry', () => {
  it('stacks pages in one centered column', () => {
    const l = layoutContinuous(A4, 1, 0, 1000);
    expect(l.pages).toHaveLength(4);
    expect(l.pages[0]!.top).toBeLessThan(l.pages[1]!.top);
    expect(l.pages[0]!.left).toBeCloseTo((1000 - l.pages[0]!.viewW) / 2);
    expect(l.pages[0]!.viewW).toBeCloseTo(595.3 * (96 / 72));
  });

  it('keeps the owner’s place (page + fraction under the reading line) through zoom and rotation', () => {
    const vh = 800;
    const before = layoutContinuous(A4, 1, 0, 1000);
    const top = scrollTopFor(before, 2, 0.4, vh);
    const place = anchorAt(before, top + vh * ANCHOR_LINE);
    expect(place.index).toBe(2);
    expect(place.frac).toBeCloseTo(0.4, 3);
    for (const [zoom, rot] of [
      [2.5, 0],
      [0.5, 90],
      [1.25, 270],
    ] as const) {
      const after = layoutContinuous(A4, zoom, rot, 1000);
      const t2 = scrollTopFor(after, place.index, place.frac, vh);
      const again = anchorAt(after, t2 + vh * ANCHOR_LINE);
      expect(again.index).toBe(2);
      expect(again.frac).toBeCloseTo(0.4, 3);
    }
  });

  it('a page placed exactly on the line stays current despite rounded scroll positions', () => {
    const l = layoutContinuous(A4, 1.07, 0, 900);
    const y = l.pages[2]!.top - 0.6; // the browser rounded scrollTop down
    expect(anchorAt(l, y).index).toBe(2);
  });

  it('rotation swaps the page box', () => {
    const l = layoutContinuous([A4[0]!], 1, 90, 1000);
    expect(l.pages[0]!.viewW).toBeCloseTo(841.9 * (96 / 72));
    expect(l.pages[0]!.rotation).toBe(90);
    const intrinsic = layoutContinuous([{ ...A4[0]!, intrinsic: 90 }], 1, 270, 1000);
    expect(intrinsic.pages[0]!.rotation).toBe(0);
  });

  it('renders only pages near the viewport', () => {
    const l = layoutContinuous(Array.from({ length: 300 }, (_, index) => ({ index, w: 595, h: 842, unit: 'pt' as const, intrinsic: 0 })), 1, 0, 1000);
    const near = pagesInRange(l, l.pages[150]!.top - 800, l.pages[150]!.top + 1600);
    expect(near.length).toBeLessThanOrEqual(4);
    expect(near).toContain(150);
  });

  it('spreads: pairs from the first page, right-to-left order for Arabic books', () => {
    expect(spreadOf(3, 'double', 7)).toEqual([2, 3]);
    expect(spreadOf(6, 'double', 7)).toEqual([6]);
    expect(spreadOf(3, 'single', 7)).toEqual([3]);
    expect(stepSpread(2, 1, 'double', 7)).toBe(4);
    expect(stepSpread(0, -1, 'double', 7)).toBe(0);
    const ltr = layoutSpread([A4[0]!, A4[1]!], 1, 0, 2000, false);
    const rtl = layoutSpread([A4[0]!, A4[1]!], 1, 0, 2000, true);
    expect(ltr.pages[0]!.left).toBeLessThan(ltr.pages[1]!.left);
    expect(rtl.pages[0]!.left).toBeGreaterThan(rtl.pages[1]!.left);
  });

  it('zoom steps and fit-width', () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomOut(1)).toBe(0.9);
    expect(zoomIn(5)).toBe(5);
    expect(zoomOut(0.25)).toBe(0.25);
    const z = fitWidthZoom({ containerWidth: 900, pageWidth: 595.3, pageHeight: 841.9, unit: 'pt', rotation: 0 });
    expect(595.3 * (96 / 72) * z).toBeCloseTo(900 - 48, 0);
    const z2 = fitWidthZoom({ containerWidth: 900, pageWidth: 595.3, pageHeight: 841.9, unit: 'pt', rotation: 0, columns: 2 });
    expect(z2).toBeLessThan(z / 1.9);
  });
});
