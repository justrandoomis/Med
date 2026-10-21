// The ruler (parity N1 wave 2, G08): an overlay on one page — moved with one finger (or the keyboard), turned with two
// fingers (or a handle, or [ / ]), with its angle shown — that pen strokes started along its edge snap to. Geometry in
// normalized page space, so it stays where it is at every zoom and page rotation (AC-21). The ruler is NEVER saved as
// ink: it lives in the open document's memory only. Its marks are centimetres of the page as printed (the page's own
// units), never a measurement of anything drawn on it.
import type { InkPoint } from '@medlevo/shared';
import type { Vec } from './math';

export interface RulerState {
  /** the page the ruler lies on */
  targetKey: string;
  /** centre (normalized, unrotated page) */
  cx: number;
  cy: number;
  /** clockwise radians in page space */
  angle: number;
  /** length as a fraction of the page width */
  length: number;
}

/** thickness of the ruler's body (fraction of the page width) */
export const RULER_THICKNESS = 0.05;
/** a stroke snaps when it starts this close to the edge (css px) */
export const RULER_SNAP_PX = 22;
/** page units (pt) in one centimetre */
export const PT_PER_CM = 72 / 2.54;

export function placeRuler(targetKey: string, at: Vec = [0.5, 0.5], angle = 0): RulerState {
  return { targetKey, cx: at[0], cy: at[1], angle, length: 0.8 };
}

/** The writing edge (iso units): the top side of the body in the ruler's own frame. */
export function rulerEdge(r: RulerState, ar: number): { a: Vec; b: Vec } {
  const c: Vec = [r.cx, r.cy * ar];
  const ux = Math.cos(r.angle);
  const uy = Math.sin(r.angle);
  // the normal pointing «up» in the ruler's frame
  const nx = uy;
  const ny = -ux;
  const half = r.length / 2;
  const off = RULER_THICKNESS / 2;
  return {
    a: [c[0] - ux * half + nx * off, c[1] - uy * half + ny * off],
    b: [c[0] + ux * half + nx * off, c[1] + uy * half + ny * off],
  };
}

/** The ruler's body corners (iso units, clockwise from the start of the writing edge). */
export function rulerCorners(r: RulerState, ar: number): Vec[] {
  const { a, b } = rulerEdge(r, ar);
  const nx = -Math.sin(r.angle) * RULER_THICKNESS;
  const ny = Math.cos(r.angle) * RULER_THICKNESS;
  return [a, b, [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]];
}

/** The nearest point of the edge's line to `p` (iso), and how far along the edge it lies (0 = start, 1 = end). */
export function projectOnEdge(p: Vec, edge: { a: Vec; b: Vec }): { at: Vec; t: number; dist: number } {
  const dx = edge.b[0] - edge.a[0];
  const dy = edge.b[1] - edge.a[1];
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = ((p[0] - edge.a[0]) * dx + (p[1] - edge.a[1]) * dy) / len2;
  const at: Vec = [edge.a[0] + t * dx, edge.a[1] + t * dy];
  return { at, t, dist: Math.hypot(p[0] - at[0], p[1] - at[1]) };
}

/** Does a stroke that starts at `p` (iso) follow the ruler? Near the edge, along its length, on the writing side. */
export function startsAtEdge(p: Vec, r: RulerState, ar: number, tolIso: number): boolean {
  const pr = projectOnEdge(p, rulerEdge(r, ar));
  return pr.dist <= tolIso && pr.t >= -0.05 && pr.t <= 1.05;
}

/**
 * A stroke drawn along the ruler: every sample moved onto the edge's line (time, pressure and tilt kept), so the line is
 * straight. Points are normalized (unrotated page).
 */
export function snapPointsToRuler(points: readonly InkPoint[], r: RulerState, ar: number): InkPoint[] {
  const edge = rulerEdge(r, ar);
  return points.map((p) => {
    const { at } = projectOnEdge([p[0], p[1] * ar], edge);
    const q = p.slice() as number[];
    q[0] = at[0];
    q[1] = at[1] / ar;
    return q as unknown as InkPoint;
  });
}

/** The angle shown on the ruler: degrees in [0, 180), whole numbers. */
export function rulerAngleDeg(r: RulerState): number {
  let d = Math.round((r.angle * 180) / Math.PI) % 180;
  if (d < 0) d += 180;
  return d;
}

/** Turned by `deg` degrees; near a multiple of 15° it settles on it (a ruler is often wanted level or at 45°). */
export function rotateRuler(r: RulerState, deg: number, snap = true): RulerState {
  let a = r.angle + (deg * Math.PI) / 180;
  if (snap) {
    const step = Math.PI / 12;
    const near = Math.round(a / step) * step;
    if (Math.abs(a - near) < (1.5 * Math.PI) / 180) a = near;
  }
  return { ...r, angle: a };
}

/** Moved by a normalized offset, its centre kept on the page. */
export function moveRuler(r: RulerState, dx: number, dy: number): RulerState {
  return { ...r, cx: Math.min(1, Math.max(0, r.cx + dx)), cy: Math.min(1, Math.max(0, r.cy + dy)) };
}

/**
 * Two fingers on the ruler: the turn of the line between them and the move of their middle (client px), applied to
 * the state the gesture started with.
 */
export function twoFingerRuler(start: RulerState, a0: Vec, b0: Vec, a1: Vec, b1: Vec, pxToNorm: (dx: number, dy: number) => Vec): RulerState {
  const ang0 = Math.atan2(b0[1] - a0[1], b0[0] - a0[0]);
  const ang1 = Math.atan2(b1[1] - a1[1], b1[0] - a1[0]);
  const m0: Vec = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2];
  const m1: Vec = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
  const [dx, dy] = pxToNorm(m1[0] - m0[0], m1[1] - m0[1]);
  return rotateRuler(moveRuler(start, dx, dy), ((ang1 - ang0) * 180) / Math.PI);
}

/** Centimetre and half-centimetre marks along the ruler (fractions 0..1 of its length), for a page `pageWidthPt` wide. */
export function rulerMarks(r: RulerState, pageWidthPt: number): Array<{ t: number; major: boolean; label: string | null }> {
  const lenPt = r.length * pageWidthPt;
  const out: Array<{ t: number; major: boolean; label: string | null }> = [];
  for (let half = 0; half * (PT_PER_CM / 2) <= lenPt + 1e-6; half++) {
    const major = half % 2 === 0;
    out.push({ t: (half * (PT_PER_CM / 2)) / lenPt, major, label: major ? String(half / 2) : null });
  }
  return out;
}
