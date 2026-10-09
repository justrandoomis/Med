// AC-21 (logic part): ink stored in normalized, UNROTATED page space returns to the same spot at
// any zoom / rotation / device pixel ratio. The browser part is test/ink/e2e/ink-position.pw.ts.
import { describe, expect, it } from 'vitest';
import { normToView, viewSize, viewToNorm, type QuarterTurn } from '@medlevo/shared';
import { StrokeCapture } from '../../src/features/workspace/ink/input';
import { applyMat } from '../../src/features/workspace/ink/math';
import { makeInkItem, transformItem } from '../../src/features/workspace/ink/model';
import { pageMatrix } from '../../src/features/workspace/ink/render';
import type { InkPageView } from '../../src/features/workspace/ink/types';

const PAGE = { pageWidth: 595, pageHeight: 842 }; // A4 in pt
const ZOOMS = [0.5, 1, 1.37, 2, 4];
const ROTATIONS: QuarterTurn[] = [0, 90, 180, 270];

function view(scale: number, rotation: QuarterTurn): InkPageView {
  return { ...PAGE, scale, rotation };
}

describe('normalized coordinates are invariant under zoom / rotation / DPR', () => {
  const samples: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [0.25, 0.75],
    [0.913, 0.0421],
  ];

  it('view → norm → view round trip is exact for every zoom and rotation', () => {
    for (const z of ZOOMS)
      for (const r of ROTATIONS)
        for (const [nx, ny] of samples) {
          const v = view(z, r);
          const [vx, vy] = normToView(nx, ny, v);
          const [bx, by] = viewToNorm(vx, vy, v);
          expect(bx).toBeCloseTo(nx, 12);
          expect(by).toBeCloseTo(ny, 12);
        }
  });

  it('the canvas matrix draws a page point exactly where normToView puts it (× DPR)', () => {
    for (const z of ZOOMS)
      for (const r of ROTATIONS)
        for (const dpr of [1, 2, 3])
          for (const [nx, ny] of samples) {
            const v = view(z, r);
            const [vx, vy] = normToView(nx, ny, v);
            const [dx, dy] = applyMat(pageMatrix(v, dpr), nx * PAGE.pageWidth, ny * PAGE.pageHeight);
            expect(dx).toBeCloseTo(vx * dpr, 9);
            expect(dy).toBeCloseTo(vy * dpr, 9);
          }
  });

  it('the same physical page spot captured at different zoom/rotation yields the same stored points', () => {
    // the owner touches the page where a given page point is displayed, in each view
    const target: Array<[number, number]> = [
      [0.2, 0.3],
      [0.21, 0.31],
      [0.25, 0.35],
    ];
    const stored: number[][][] = [];
    for (const z of ZOOMS)
      for (const r of ROTATIONS) {
        const v = view(z, r);
        // page box placed at an arbitrary screen offset
        const left = 37;
        const top = 120;
        const toNorm = (cx: number, cy: number) => viewToNorm(cx - left, cy - top, v);
        const ev = (nx: number, ny: number, t: number) => {
          const [vx, vy] = normToView(nx, ny, v);
          return { clientX: vx + left, clientY: vy + top, timeStamp: 1000 + t, pressure: 0.5, pointerType: 'mouse' };
        };
        const cap = new StrokeCapture('mouse', toNorm, PAGE.pageHeight / PAGE.pageWidth, ev(target[0]![0], target[0]![1], 0));
        cap.add(ev(target[1]![0], target[1]![1], 8));
        cap.end(ev(target[2]![0], target[2]![1], 16));
        const item = makeInkItem({ id: 'S', anchor: { type: 'note_page', note_page_id: 'N', space: 'page_norm' }, now: 0, z: 1, style: { tool: 'pen', color: 'ink-black', width: 0.0025 }, points: cap.finalPoints(), pressureAvailable: cap.pressureAvailable, tiltAvailable: cap.tiltAvailable, pointerType: 'mouse' });
        stored.push(item.data.points.map((p) => [p[0], p[1]]));
      }
    for (const s of stored) {
      expect(s).toHaveLength(3);
      s.forEach((p, i) => {
        expect(p[0]).toBeCloseTo(target[i]![0], 5);
        expect(p[1]).toBeCloseTo(target[i]![1], 5);
      });
    }
  });

  it('the rendered page box is the page rotated, at the zoomed size', () => {
    expect(viewSize(view(2, 90))).toEqual({ width: PAGE.pageHeight * 2, height: PAGE.pageWidth * 2 });
    expect(viewSize(view(1.5, 180))).toEqual({ width: PAGE.pageWidth * 1.5, height: PAGE.pageHeight * 1.5 });
  });

  it('moving a stroke by a lasso translation in one view lands on the same page spot in another', () => {
    const anchor = { type: 'note_page' as const, note_page_id: 'N', space: 'page_norm' as const };
    const ar = PAGE.pageHeight / PAGE.pageWidth;
    const item = makeInkItem({ id: 'M', anchor, now: 0, z: 1, style: { tool: 'pen', color: 'ink-black', width: 0.0025 }, points: [[0.1, 0.1, 0], [0.2, 0.1, 10]], pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
    // translate by +0.3 page widths horizontally, +0.2 page heights vertically (iso: dy = 0.2 · ar)
    const moved = transformItem(item, [1, 0, 0, 1, 0.3, 0.2 * ar], ar, 1);
    expect(moved.data).toMatchObject({ points: [[0.4, 0.3, 0], [0.5, 0.3, 10]] });
  });
});
