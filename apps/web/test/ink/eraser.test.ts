import { describe, expect, it } from 'vitest';
import type { AnnotationAnchor, InkPoint } from '@medlevo/shared';
import { erasePoints, itemHitByPath, PointEraseSession } from '../../src/features/workspace/ink/eraser';
import { makeInkItem, makeShapeItem } from '../../src/features/workspace/ink/model';
import type { Vec } from '../../src/features/workspace/ink/math';

const anchor: AnnotationAnchor = { type: 'note_page', note_page_id: 'NP1', space: 'page_norm' };
const AR = 1.4; // portrait page
const style = { tool: 'pen' as const, color: 'ink-black', width: 0.002 };

/** horizontal stroke at y from x0..x1 (norm) with n samples */
function line(x0: number, x1: number, y: number, n = 41): InkPoint[] {
  return Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / (n - 1), y, i * 10] as InkPoint);
}

/** vertical eraser path through norm x at iso coordinates */
function verticalPath(x: number, yFrom: number, yTo: number): Vec[] {
  return [
    [x, yFrom * AR],
    [x, yTo * AR],
  ];
}

describe('point eraser split', () => {
  it('cuts a stroke in two where the eraser crossed; nothing survives under the eraser', () => {
    const pts = line(0.1, 0.9, 0.5);
    const r = 0.02;
    const runs = erasePoints(pts, { style, pressure_available: false }, verticalPath(0.5, 0.4, 0.6), r, AR)!;
    expect(runs).toHaveLength(2);
    const [left, right] = runs as [InkPoint[], InkPoint[]];
    // endpoints of the original are preserved
    expect(left[0]![0]).toBeCloseTo(0.1, 10);
    expect(right[right.length - 1]![0]).toBeCloseTo(0.9, 10);
    // the cut follows the eraser radius (+ half the line width), not the sampling (densified)
    const reach = r + style.width / 2;
    expect(left[left.length - 1]![0]).toBeLessThanOrEqual(0.5 - reach + 1e-9);
    expect(left[left.length - 1]![0]).toBeGreaterThan(0.5 - reach - 0.006);
    expect(right[0]![0]).toBeGreaterThanOrEqual(0.5 + reach - 1e-9);
    for (const run of runs) for (const p of run) expect(Math.abs(p[0] - 0.5)).toBeGreaterThan(reach - 1e-9);
    // each piece is re-timed to start at 0 and keeps increasing time
    expect(right[0]![2]).toBe(0);
    expect(right[1]![2]).toBeGreaterThan(0);
  });

  it('returns null when the eraser did not touch the stroke', () => {
    expect(erasePoints(line(0.1, 0.9, 0.5), { style, pressure_available: false }, verticalPath(0.5, 0.0, 0.3), 0.01, AR)).toBeNull();
  });

  it('erasing the end leaves one piece; erasing everything leaves none', () => {
    const one = erasePoints(line(0.1, 0.9, 0.5), { style, pressure_available: false }, verticalPath(0.9, 0.4, 0.6), 0.05, AR)!;
    expect(one).toHaveLength(1);
    const none = erasePoints(line(0.45, 0.55, 0.5, 5), { style, pressure_available: false }, verticalPath(0.5, 0.4, 0.6), 0.2, AR)!;
    expect(none).toEqual([]);
  });

  it('a session keeps the original intact and accumulates cuts across moves', () => {
    const item = makeInkItem({ id: 'S1', anchor, now: 1, z: 1, style, points: line(0.1, 0.9, 0.5), pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' });
    const session = new PointEraseSession(AR);
    expect(session.apply([item], verticalPath(0.3, 0.4, 0.6), 0.02)).toEqual(['S1']);
    expect(session.apply([item], verticalPath(0.7, 0.4, 0.6), 0.02)).toEqual(['S1']);
    expect(session.pieces.get('S1')).toHaveLength(3);
    expect(session.originals.get('S1')).toBe(item); // untouched object: undo restores it exactly
    expect(item.data.points).toHaveLength(41);
  });

  it('locked strokes are never erased', () => {
    const item = { ...makeInkItem({ id: 'S2', anchor, now: 1, z: 1, style, points: line(0.1, 0.9, 0.5), pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' }), locked: true };
    const session = new PointEraseSession(AR);
    expect(session.apply([item], verticalPath(0.5, 0.4, 0.6), 0.02)).toEqual([]);
  });
});

describe('stroke eraser hit test', () => {
  it('hits strokes within radius + half width and misses farther ones', () => {
    const item = makeInkItem({ id: 'A', anchor, now: 1, z: 1, style, points: line(0.1, 0.9, 0.5), pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
    expect(itemHitByPath(item, verticalPath(0.5, 0.45, 0.55), 0.005, AR)).toBe(true);
    // a path passing 0.02 (iso) above the line with radius 0.01 misses
    const above: Vec[] = [
      [0.2, 0.5 * AR - 0.02],
      [0.8, 0.5 * AR - 0.02],
    ];
    expect(itemHitByPath(item, above, 0.01, AR)).toBe(false);
    expect(itemHitByPath(item, above, 0.02, AR)).toBe(true);
  });

  it('hits shapes along their outline, not inside an empty rectangle', () => {
    const rect = makeShapeItem({ id: 'R', anchor, now: 1, z: 1, shape: 'rect', from: [0.2, 0.2], to: [0.8, 0.8], style });
    expect(itemHitByPath(rect, [[0.5, 0.5 * AR]], 0.01, AR)).toBe(false);
    expect(itemHitByPath(rect, [[0.2, 0.5 * AR]], 0.01, AR)).toBe(true);
  });
});
