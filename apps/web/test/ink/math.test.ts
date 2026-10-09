import { describe, expect, it } from 'vitest';
import type { InkPoint } from '@medlevo/shared';
import {
  applyMat,
  densify,
  detectPressureVariation,
  invertMat,
  maxWidthFactor,
  multiply,
  pointInPolygon,
  PRESSURE_CURVES,
  pressureWidthFactor,
  rdpIndices,
  rotateAbout,
  scaleAbout,
  smoothPoints,
  translate,
  uniformScaleOf,
  widthAt,
  type Vec,
} from '../../src/features/workspace/ink/math';

describe('pressure → width curves', () => {
  it('every curve gives exactly the base width at p = 0.5 (pressure-less hardware value)', () => {
    for (const tool of ['pen', 'fountain', 'ball', 'highlighter'] as const) {
      expect(pressureWidthFactor(tool, 0.5)).toBeCloseTo(1, 10);
    }
  });

  it('curves differ per tool: fountain most expressive, ball nearly constant, highlighter constant', () => {
    const range = (t: keyof typeof PRESSURE_CURVES) => PRESSURE_CURVES[t](1) - PRESSURE_CURVES[t](0);
    expect(range('fountain')).toBeGreaterThan(range('pen'));
    expect(range('pen')).toBeGreaterThan(range('ball'));
    expect(range('ball')).toBeGreaterThan(0);
    expect(range('highlighter')).toBe(0);
    expect(maxWidthFactor('fountain')).toBeGreaterThan(maxWidthFactor('pen'));
  });

  it('curves are monotonic (more pressure never thins the line)', () => {
    for (const tool of ['pen', 'fountain', 'ball'] as const) {
      let prev = -Infinity;
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const f = pressureWidthFactor(tool, p);
        expect(f).toBeGreaterThanOrEqual(prev);
        prev = f;
      }
    }
  });

  it('clamps out-of-range and missing pressure', () => {
    expect(pressureWidthFactor('pen', 7)).toBe(pressureWidthFactor('pen', 1));
    expect(pressureWidthFactor('pen', -3)).toBe(pressureWidthFactor('pen', 0));
    expect(pressureWidthFactor('pen', undefined)).toBe(1);
    expect(pressureWidthFactor('pen', Number.NaN)).toBe(1);
  });

  it('width is constant when the stroke did not report pressure (recorded honestly per stroke)', () => {
    expect(widthAt('fountain', 0.003, false, 0.1)).toBe(0.003);
    expect(widthAt('fountain', 0.003, false, 0.9)).toBe(0.003);
    expect(widthAt('fountain', 0.003, true, 0.1)).toBeLessThan(widthAt('fountain', 0.003, true, 0.9));
  });

  it('detects real pressure variation only (mouse and the constant 0.5 never count)', () => {
    expect(detectPressureVariation([0.5, 0.5, 0.5], 'pen')).toBe(false);
    expect(detectPressureVariation([0.2, 0.35, 0.6], 'mouse')).toBe(false);
    expect(detectPressureVariation([0.2, 0.35, 0.6], 'pen')).toBe(true);
    expect(detectPressureVariation([0, 0.5, 0.5, 0], 'touch')).toBe(false); // 0 = not in contact
    expect(detectPressureVariation([], 'pen')).toBe(false);
  });
});

describe('smoothing', () => {
  const jitter: InkPoint[] = Array.from({ length: 40 }, (_, i) => [0.1 + i * 0.01, 0.5 + (i % 2 ? 0.004 : -0.004), i * 8, 0.5]);

  it('keeps the first and last point exactly (a stroke never grows or shrinks at its ends)', () => {
    const s = smoothPoints(jitter, 3);
    expect(s[0]).toEqual(jitter[0]);
    expect(s[s.length - 1]).toEqual(jitter[jitter.length - 1]);
    expect(s).toHaveLength(jitter.length);
  });

  it('reduces jitter in the interior and keeps t / pressure', () => {
    const s = smoothPoints(jitter, 3);
    const dev = (pts: readonly InkPoint[]) => Math.max(...pts.slice(3, -3).map((p) => Math.abs(p[1] - 0.5)));
    expect(dev(s)).toBeLessThan(dev(jitter) / 3);
    expect(s[10]![2]).toBe(jitter[10]![2]);
    expect(s[10]![3]).toBe(0.5);
  });

  it('leaves short strokes alone', () => {
    const two: InkPoint[] = [
      [0.1, 0.1, 0],
      [0.2, 0.2, 5],
    ];
    expect(smoothPoints(two)).toEqual(two);
  });
});

describe('geometry helpers', () => {
  it('RDP keeps the corners of a polyline', () => {
    const pts: Vec[] = [];
    for (let i = 0; i <= 10; i++) pts.push([i / 10, 0]);
    for (let i = 1; i <= 10; i++) pts.push([1, i / 10]);
    const idx = rdpIndices(pts, 0.01);
    expect(idx).toEqual([0, 10, 20]);
  });

  it('densify inserts interpolated samples (t and pressure too) without moving originals', () => {
    const pts: InkPoint[] = [
      [0, 0, 0, 0.2],
      [0.1, 0, 100, 0.6],
    ];
    const d = densify(pts, 0.01, 1);
    expect(d.length).toBeGreaterThanOrEqual(10);
    expect(d[0]).toEqual(pts[0]);
    expect(d[d.length - 1]).toEqual(pts[1]);
    const mid = d[Math.floor(d.length / 2)]!;
    expect(mid[2]).toBeGreaterThan(0);
    expect(mid[2]).toBeLessThan(100);
    expect(mid[3]!).toBeGreaterThan(0.2);
    expect(mid[3]!).toBeLessThan(0.6);
  });

  it('point in polygon (concave lasso)', () => {
    const c: Vec[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0.5, 0.4],
      [0, 1],
    ];
    expect(pointInPolygon([0.5, 0.2], c)).toBe(true);
    expect(pointInPolygon([0.5, 0.8], c)).toBe(false); // inside the notch
    expect(pointInPolygon([1.5, 0.5], c)).toBe(false);
  });

  it('affine helpers compose, invert and report uniform scale', () => {
    const m = multiply(translate(0.1, 0.2), multiply(rotateAbout(Math.PI / 3, 0.5, 0.5), scaleAbout(2, 0.5, 0.5)));
    expect(uniformScaleOf(m)).toBeCloseTo(2, 10);
    const inv = invertMat(m)!;
    const [x, y] = applyMat(m, 0.3, 0.7);
    const [bx, by] = applyMat(inv, x, y);
    expect(bx).toBeCloseTo(0.3, 10);
    expect(by).toBeCloseTo(0.7, 10);
    // rotation about a point keeps that point fixed
    const [px, py] = applyMat(rotateAbout(1.2, 0.4, 0.6), 0.4, 0.6);
    expect(px).toBeCloseTo(0.4, 12);
    expect(py).toBeCloseTo(0.6, 12);
  });
});
