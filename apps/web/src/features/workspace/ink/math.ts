// Pure geometry for the ink engine (no DOM). Unit-tested in test/ink/*.
//
// Spaces
//  * norm  — stored coordinates: x,y ∈ [0,1] of the UNROTATED page box (x / page width, y / page height).
//  * iso   — isotropic page space used for every distance/angle computation: X = x, Y = y · ar
//            where ar = pageHeight / pageWidth. One iso unit = the page width, so InkStyle.width
//            (a fraction of the page width) is directly an iso length.
//  * view  — css px of the rendered page (see @medlevo/shared geometry normToView / viewToNorm).
import type { InkPenTool, InkPoint, NormBox } from '@medlevo/shared';

export type Vec = [number, number];
/** any point array: Vec, InkPoint ([x, y, t, p?, …]) */
export type PointLike = ArrayLike<number | undefined>;

export function normToIso(x: number, y: number, ar: number): Vec {
  return [x, y * ar];
}

export function isoToNorm(x: number, y: number, ar: number): Vec {
  return [x, y / ar];
}

/** Round for storage (keeps payloads small; 1e-5 of a page width ≈ 0.006 pt on A4). */
export function roundTo(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ─── pressure → width curves ─────────────────────────────────────────────────────────────────
// Every curve gives factor 1 at p = 0.5 (the value the Pointer Events spec reports for hardware
// without pressure), so a pressure-less stroke and a medium-pressure stroke have the same width.
export const PRESSURE_CURVES: Record<InkPenTool, (p: number) => number> = {
  /** felt/gel pen: moderate, linear response */
  pen: (p) => 0.4 + 1.2 * p,
  /** fountain pen: expressive, accelerating response (thin hairlines → broad strokes) */
  fountain: (p) => Math.min(2.2, 0.2 + 0.8 * (2 * p) ** 1.5),
  /** ballpoint: nearly constant */
  ball: (p) => 0.85 + 0.3 * p,
  /** highlighter: chisel of constant width */
  highlighter: () => 1,
};

export function clampPressure(p: number | undefined): number {
  if (p == null || !Number.isFinite(p)) return 0.5;
  return Math.min(1, Math.max(0, p));
}

export function pressureWidthFactor(tool: InkPenTool, p: number | undefined): number {
  return PRESSURE_CURVES[tool](clampPressure(p));
}

/** Largest factor a curve can produce (for hit-test and dirty-rect margins). */
export function maxWidthFactor(tool: InkPenTool): number {
  return PRESSURE_CURVES[tool](1);
}

/**
 * Width (iso units) at one point. Constant when the device did not report pressure variation —
 * pressure_available is recorded honestly per stroke, never assumed.
 */
export function widthAt(tool: InkPenTool, baseWidth: number, pressureAvailable: boolean, p: number | undefined): number {
  return pressureAvailable ? baseWidth * pressureWidthFactor(tool, p) : baseWidth;
}

/** Did the input report a real pressure signal (not the constant 0.5/1 of pressure-less hardware)? */
export function detectPressureVariation(pressures: readonly number[], pointerType: string): boolean {
  if (pointerType === 'mouse') return false;
  let min = Infinity;
  let max = -Infinity;
  for (const p of pressures) {
    if (!(p > 0)) continue; // 0 = not in contact
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return Number.isFinite(min) && max - min > 0.01;
}

// ─── vectors & distances ─────────────────────────────────────────────────────────────────────
export function dist(a: PointLike, b: PointLike): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
}

export function pointSegDistSq(p: PointLike, a: PointLike, b: PointLike): number {
  const ax = a[0]!;
  const ay = a[1]!;
  const dx = b[0]! - ax;
  const dy = b[1]! - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0]! - ax) * dx + (p[1]! - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - p[0]!;
  const qy = ay + t * dy - p[1]!;
  return qx * qx + qy * qy;
}

function orient(a: PointLike, b: PointLike, c: PointLike): number {
  return (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
}

export function segmentsIntersect(a: PointLike, b: PointLike, c: PointLike, d: PointLike): boolean {
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Squared distance between segments ab and cd. */
export function segSegDistSq(a: PointLike, b: PointLike, c: PointLike, d: PointLike): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegDistSq(a, c, d), pointSegDistSq(b, c, d), pointSegDistSq(c, a, b), pointSegDistSq(d, a, b));
}

export function polylineLength(pts: readonly PointLike[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1]!, pts[i]!);
  return L;
}

/** Even-odd ray casting. Works for any simple or self-intersecting lasso polygon. */
export function pointInPolygon(p: PointLike, poly: readonly PointLike[]): boolean {
  const x = p[0]!;
  const y = p[1]!;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]![0]!;
    const yi = poly[i]![1]!;
    const xj = poly[j]![0]!;
    const yj = poly[j]![1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Share of `pts` inside the polygon (0..1). */
export function fractionInside(pts: readonly PointLike[], poly: readonly PointLike[]): number {
  if (pts.length === 0 || poly.length < 3) return 0;
  let n = 0;
  for (const p of pts) if (pointInPolygon(p, poly)) n++;
  return n / pts.length;
}

// ─── boxes ───────────────────────────────────────────────────────────────────────────────────
export function bboxOf(points: readonly PointLike[]): NormBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const x = p[0]!;
    const y = p[1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function expandBox(b: NormBox, mx: number, my: number = mx): NormBox {
  return { x: b.x - mx, y: b.y - my, w: b.w + 2 * mx, h: b.h + 2 * my };
}

export function unionBox(a: NormBox | null, b: NormBox): NormBox {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function boxContains(b: NormBox, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

export function boxCenter(b: NormBox): Vec {
  return [b.x + b.w / 2, b.y + b.h / 2];
}

// ─── smoothing / simplification ──────────────────────────────────────────────────────────────
/**
 * Symmetric moving average of x,y (window shrinks near the ends) — the first and last points are
 * returned unchanged, so a stroke never grows or shrinks at its ends. t/pressure/tilt are kept.
 */
export function smoothPoints<P extends PointLike>(points: readonly P[], radius = 2): P[] {
  const n = points.length;
  if (n < 3 || radius < 1) return points.slice();
  const out: P[] = new Array(n);
  out[0] = points[0]!;
  out[n - 1] = points[n - 1]!;
  for (let i = 1; i < n - 1; i++) {
    const k = Math.min(radius, i, n - 1 - i);
    let sx = 0;
    let sy = 0;
    for (let j = i - k; j <= i + k; j++) {
      sx += points[j]![0]!;
      sy += points[j]![1]!;
    }
    const c = Array.from(points[i]!) as number[];
    c[0] = sx / (2 * k + 1);
    c[1] = sy / (2 * k + 1);
    out[i] = c as unknown as P;
  }
  return out;
}

/** Ramer–Douglas–Peucker: indices of kept points (first and last always kept). */
export function rdpIndices(pts: readonly PointLike[], eps: number): number[] {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointSegDistSq(pts[i]!, pts[s]!, pts[e]!);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx > 0 && maxD > eps2) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Inserts interpolated points so that no two consecutive points are farther apart than `step`
 * (iso units). Used before point-erasing so the cut follows the eraser, not the sampling rate.
 */
export function densify(points: readonly InkPoint[], step: number, ar: number): InkPoint[] {
  if (points.length < 2 || !(step > 0)) return points.slice();
  const out: InkPoint[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = Math.hypot(b[0] - a[0], (b[1] - a[1]) * ar);
    const n = Math.min(512, Math.floor(d / step));
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push(lerpPoint(a, b, t));
    }
    out.push(b);
  }
  return out;
}

export function lerpPoint(a: InkPoint, b: InkPoint, t: number): InkPoint {
  const len = Math.max(a.length, b.length);
  const p: number[] = [];
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? b[i];
    const vb = b[i] ?? a[i];
    if (va == null || vb == null) break;
    p.push(va + (vb - va) * t);
  }
  return p as unknown as InkPoint;
}

// ─── affine transforms (iso space) ───────────────────────────────────────────────────────────
/** [a, b, c, d, e, f]: x' = a·x + c·y + e ; y' = b·x + d·y + f (same order as canvas setTransform). */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function multiply(m: Mat, n: Mat): Mat {
  // m ∘ n (apply n first)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function translate(dx: number, dy: number): Mat {
  return [1, 0, 0, 1, dx, dy];
}

export function scaleAbout(s: number, cx: number, cy: number): Mat {
  return [s, 0, 0, s, cx - s * cx, cy - s * cy];
}

/** Rotation by `theta` radians (clockwise on screen, y down) about (cx, cy). */
export function rotateAbout(theta: number, cx: number, cy: number): Mat {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}

export function applyMat(m: Mat, x: number, y: number): Vec {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function uniformScaleOf(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export function rotationOf(m: Mat): number {
  return Math.atan2(m[1], m[0]);
}

export function isIdentity(m: Mat, eps = 1e-12): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]!) <= eps);
}

export function invertMat(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-15) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
