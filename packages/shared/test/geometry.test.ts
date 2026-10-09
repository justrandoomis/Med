import { describe, expect, it } from 'vitest';
import { normToView, normBoxToView, pdfRectToNorm, viewSize, viewToNorm, type PageViewTransform, type QuarterTurn } from '../src/geometry';

describe('page geometry (AC-21: ink returns to the same place at any zoom/rotation)', () => {
  const rotations: QuarterTurn[] = [0, 90, 180, 270];
  const scales = [0.5, 1, 1.37, 3];
  const points: Array<[number, number]> = [[0, 0], [1, 1], [0.25, 0.75], [0.9, 0.1]];
  for (const rotation of rotations) {
    for (const scale of scales) {
      it(`round-trips at rotation ${rotation} scale ${scale}`, () => {
        const t: PageViewTransform = { pageWidth: 595.28, pageHeight: 841.89, scale, rotation };
        for (const [x, y] of points) {
          const [vx, vy] = normToView(x, y, t);
          const size = viewSize(t);
          expect(vx).toBeGreaterThanOrEqual(-1e-9);
          expect(vy).toBeGreaterThanOrEqual(-1e-9);
          expect(vx).toBeLessThanOrEqual(size.width + 1e-9);
          expect(vy).toBeLessThanOrEqual(size.height + 1e-9);
          const [nx, ny] = viewToNorm(vx, vy, t);
          expect(nx).toBeCloseTo(x, 10);
          expect(ny).toBeCloseTo(y, 10);
        }
      });
    }
  }
  it('rotates the top-left corner clockwise', () => {
    const t: PageViewTransform = { pageWidth: 100, pageHeight: 200, scale: 1, rotation: 90 };
    expect(viewSize(t)).toEqual({ width: 200, height: 100 });
    expect(normToView(0, 0, t)).toEqual([200, 0]); // top-left goes to the top-right after 90° cw
  });
  it('maps boxes', () => {
    const t: PageViewTransform = { pageWidth: 100, pageHeight: 100, scale: 2, rotation: 180 };
    expect(normBoxToView({ x: 0, y: 0, w: 0.5, h: 0.25 }, t)).toEqual({ left: 100, top: 150, width: 100, height: 50 });
  });
  it('converts PDF rects (bottom-left origin) to normalized boxes', () => {
    const b = pdfRectToNorm({ x: 72, y: 700, width: 100, height: 20 }, [0, 0, 595, 842]);
    expect(b.x).toBeCloseTo(72 / 595);
    expect(b.y).toBeCloseTo((842 - 720) / 842);
  });
});
