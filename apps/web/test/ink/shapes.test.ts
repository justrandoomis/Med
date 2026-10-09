import { describe, expect, it } from 'vitest';
import type { AnnotationAnchor, InkPoint } from '@medlevo/shared';
import { recognizeShape } from '../../src/features/workspace/ink/shapes';
import { makeInkItem, makeShapeItem, revertEnhancement, isInkStroke } from '../../src/features/workspace/ink/model';

const AR = 1.3;
const anchor: AnnotationAnchor = { type: 'note_page', note_page_id: 'NP', space: 'page_norm' };

/** deterministic pseudo-noise */
function noise(i: number, amp: number): number {
  return Math.sin(i * 12.9898) * 43758.5453 % 1 * amp;
}

/** iso polyline → norm InkPoints with small hand tremor */
function stroke(iso: Array<[number, number]>, step = 0.004, amp = 0.0015): InkPoint[] {
  const out: InkPoint[] = [];
  let t = 0;
  for (let k = 1; k < iso.length; k++) {
    const [ax, ay] = iso[k - 1]!;
    const [bx, by] = iso[k]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let i = k === 1 ? 0 : 1; i <= n; i++) {
      const x = ax + ((bx - ax) * i) / n + noise(out.length, amp);
      const y = ay + ((by - ay) * i) / n + noise(out.length + 7, amp);
      out.push([x, y / AR, (t += 8)]);
    }
  }
  return out;
}

function ellipseIso(cx: number, cy: number, a: number, b: number, rot = 0, n = 80): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const u = a * Math.cos(t);
    const v = b * Math.sin(t);
    pts.push([cx + u * Math.cos(rot) - v * Math.sin(rot), cy + u * Math.sin(rot) + v * Math.cos(rot)]);
  }
  return pts;
}

describe('shape recognition (hold gesture)', () => {
  it('line', () => {
    const r = recognizeShape(stroke([[0.1, 0.2], [0.7, 0.5]]), AR)!;
    expect(r.shape).toBe('line');
    expect(r.from[0]).toBeCloseTo(0.1, 1);
    expect(r.to[0]).toBeCloseTo(0.7, 1);
    expect(r.to[1]).toBeCloseTo(0.5 / AR, 1);
  });

  it('axis-aligned rectangle drawn from the middle of a side', () => {
    const r = recognizeShape(stroke([[0.4, 0.2], [0.7, 0.2], [0.7, 0.5], [0.2, 0.5], [0.2, 0.2], [0.42, 0.2]]), AR)!;
    expect(r.shape).toBe('rect');
    expect(r.rotation).toBe(0);
    expect(r.from[0]).toBeCloseTo(0.2, 1);
    expect(r.to[0]).toBeCloseTo(0.7, 1);
    expect(r.from[1] * AR).toBeCloseTo(0.2, 1);
    expect(r.to[1] * AR).toBeCloseTo(0.5, 1);
  });

  it('rotated rectangle keeps its rotation', () => {
    const a = (25 * Math.PI) / 180;
    const c = [0.5, 0.5];
    const corner = (u: number, v: number): [number, number] => [c[0]! + u * Math.cos(a) - v * Math.sin(a), c[1]! + u * Math.sin(a) + v * Math.cos(a)];
    const r = recognizeShape(stroke([corner(-0.2, -0.1), corner(0.2, -0.1), corner(0.2, 0.1), corner(-0.2, 0.1), corner(-0.2, -0.1)]), AR)!;
    expect(r.shape).toBe('rect');
    expect(r.rotation).toBeCloseTo(a, 1);
  });

  it('ellipse and circle', () => {
    const e = recognizeShape(stroke(ellipseIso(0.5, 0.6, 0.25, 0.12, 0.3)), AR)!;
    expect(e.shape).toBe('ellipse');
    expect(e.rotation).toBeCloseTo(0.3, 1);
    const c = recognizeShape(stroke(ellipseIso(0.4, 0.4, 0.15, 0.15)), AR)!;
    expect(c.shape).toBe('ellipse');
    const w = c.to[0] - c.from[0];
    const h = (c.to[1] - c.from[1]) * AR;
    expect(w / h).toBeGreaterThan(0.85);
    expect(w / h).toBeLessThan(1.18);
  });

  it('single-stroke arrow (shaft, barb, back, barb)', () => {
    const r = recognizeShape(stroke([[0.1, 0.5], [0.6, 0.5], [0.52, 0.44], [0.6, 0.5], [0.52, 0.56]]), AR)!;
    expect(r.shape).toBe('arrow');
    expect(r.from[0]).toBeCloseTo(0.1, 1);
    expect(r.to[0]).toBeCloseTo(0.6, 1);
  });

  it('rejects handwriting-like strokes (the ink stays as written)', () => {
    // zig-zag "w"
    expect(recognizeShape(stroke([[0.1, 0.2], [0.2, 0.4], [0.3, 0.25], [0.4, 0.4], [0.5, 0.2]]), AR)).toBeNull();
    // check mark (one barb only — not an arrow)
    expect(recognizeShape(stroke([[0.1, 0.4], [0.15, 0.48], [0.35, 0.2]]), AR)).toBeNull();
    // spiral / scribble
    const spiral: Array<[number, number]> = [];
    for (let i = 0; i < 120; i++) spiral.push([0.5 + 0.002 * i * Math.cos(i / 6), 0.5 + 0.002 * i * Math.sin(i / 6)]);
    expect(recognizeShape(stroke(spiral), AR)).toBeNull();
    // tiny dot-like strokes are never "enhanced"
    expect(recognizeShape(stroke([[0.5, 0.5], [0.505, 0.5]]), AR)).toBeNull();
  });

  it('reject enhancement: the shape keeps the original stroke and reverts to it exactly', () => {
    const pts = stroke(ellipseIso(0.5, 0.5, 0.2, 0.1));
    const ink = makeInkItem({ id: 'X', anchor, now: 1, z: 3, style: { tool: 'fountain', color: 'ink-blue', width: 0.003 }, points: pts, pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' });
    const r = recognizeShape(ink.data.points, AR)!;
    const shape = makeShapeItem({ id: 'X', anchor, now: 2, z: 3, shape: r.shape, from: r.from, to: r.to, rotation: r.rotation, style: ink.data.style, recognizedFrom: ink.data });
    expect(shape.data.recognized_from).toEqual(ink.data);
    const back = revertEnhancement(shape, 5)!;
    expect(isInkStroke(back)).toBe(true);
    expect(back.id).toBe('X'); // same annotation: one upsert, one undo step
    expect(back.data).toEqual(ink.data);
    expect(back.tool).toBe('fountain');
    // a shape drawn with the shape tool has nothing to revert to
    expect(revertEnhancement(makeShapeItem({ id: 'Y', anchor, now: 1, z: 1, shape: 'rect', from: [0, 0], to: [0.2, 0.2], style: ink.data.style }), 5)).toBeNull();
  });
});
