// Shape recognition after a hold gesture (spec §28: «تحسين الدائرة والمستطيل والسهم والخط بعد
// gesture مناسب، مع إمكانية رفض التحسين والعودة للأصل»). Deterministic geometry, no AI.
// The recognized shape keeps the original stroke in ShapeData.recognized_from so the owner can
// undo the enhancement at any time (not only with Undo).
import type { InkPoint, ShapeData } from '@medlevo/shared';
import { bboxOf, dist, polylineLength, pointSegDistSq, rdpIndices, type Vec } from './math';

export interface RecognizedShape {
  shape: ShapeData['shape'];
  /** normalized; for rect/ellipse the corners of the UNROTATED box */
  from: Vec;
  to: Vec;
  /** radians, clockwise about the box centre (rect/ellipse only) */
  rotation: number;
}

const SNAP = (8 * Math.PI) / 180;

function toIso(points: readonly InkPoint[], ar: number): Vec[] {
  return points.map((p) => [p[0], p[1] * ar]);
}

function fromIso(p: Vec, ar: number): Vec {
  return [p[0], p[1] / ar];
}

function turnAngle(a: Vec, b: Vec, c: Vec): number {
  const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/** Resample a polyline to n points evenly spaced by arc length. */
export function resample(pts: readonly Vec[], n: number): Vec[] {
  const L = polylineLength(pts);
  if (pts.length < 2 || L === 0) return pts.slice(0, 1);
  const step = L / (n - 1);
  const out: Vec[] = [pts[0]!];
  let acc = 0;
  let prev = pts[0]!;
  let i = 1;
  while (i < pts.length && out.length < n) {
    const cur = pts[i]!;
    const d = dist(prev, cur);
    if (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      const q: Vec = [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])];
      out.push(q);
      prev = q;
      acc = 0;
    } else {
      acc += d;
      prev = cur;
      i++;
    }
  }
  while (out.length < n) out.push(pts[pts.length - 1]!);
  return out;
}

function boxShape(shape: 'rect' | 'ellipse', c: Vec, hx: number, hy: number, theta: number, ar: number): RecognizedShape {
  // keep the rotation in (-45°, 45°] by swapping the extents; snap near-axis-aligned shapes
  let t = theta;
  let ex = hx;
  let ey = hy;
  while (t > Math.PI / 4) {
    t -= Math.PI / 2;
    [ex, ey] = [ey, ex];
  }
  while (t <= -Math.PI / 4) {
    t += Math.PI / 2;
    [ex, ey] = [ey, ex];
  }
  if (Math.abs(t) < SNAP) t = 0;
  return { shape, from: fromIso([c[0] - ex, c[1] - ey], ar), to: fromIso([c[0] + ex, c[1] + ey], ar), rotation: t };
}

function tryLine(p: Vec[], L: number): RecognizedShape | null {
  const a = p[0]!;
  const b = p[p.length - 1]!;
  const D = dist(a, b);
  if (D < 0.9 * L) return null;
  let maxDev = 0;
  for (const q of p) maxDev = Math.max(maxDev, Math.sqrt(pointSegDistSq(q, a, b)));
  if (maxDev > 0.05 * D) return null;
  return { shape: 'line', from: a, to: b, rotation: 0 };
}

function tryArrow(p: Vec[], diag: number): RecognizedShape | null {
  const idx = rdpIndices(p, 0.06 * diag);
  if (idx.length < 4 || idx.length > 7) return null;
  const v = idx.map((i) => p[i]!);
  const tail = v[0]!;
  const tip = v[1]!;
  const S = dist(tail, tip);
  if (S < 0.6 * diag) return null; // the shaft dominates an arrow
  const ux = (tip[0] - tail[0]) / S;
  const uy = (tip[1] - tail[1]) / S;
  let left = false;
  let right = false;
  for (let k = 2; k < v.length; k++) {
    const q = v[k]!;
    const dx = q[0] - tip[0];
    const dy = q[1] - tip[1];
    if (Math.hypot(dx, dy) > 0.5 * S) return null; // the head stays near the tip
    const along = dx * ux + dy * uy;
    const side = ux * dy - uy * dx;
    if (Math.abs(side) > 0.04 * S && along < 0) {
      if (side > 0) left = true;
      else right = true;
    }
  }
  if (!left || !right) return null;
  return { shape: 'arrow', from: tail, to: tip, rotation: 0 };
}

function tryRect(p: Vec[], L: number, ar: number): RecognizedShape | null {
  const closed = p.concat([p[0]!]);
  const idx = rdpIndices(closed, 0.045 * L);
  let v = idx.map((i) => closed[i]!);
  if (v.length > 1 && dist(v[0]!, v[v.length - 1]!) < 0.08 * L) v = v.slice(0, -1);
  // drop near-straight vertices (a start point in the middle of a side)
  let changed = true;
  while (changed && v.length > 3) {
    changed = false;
    for (let i = 0; i < v.length; i++) {
      const a = v[(i - 1 + v.length) % v.length]!;
      const b = v[i]!;
      const c = v[(i + 1) % v.length]!;
      if (turnAngle(a, b, c) < (30 * Math.PI) / 180) {
        v = v.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  if (v.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const ang = turnAngle(v[(i + 3) % 4]!, v[i]!, v[(i + 1) % 4]!);
    if (Math.abs(ang - Math.PI / 2) > (25 * Math.PI) / 180) return null;
  }
  // orientation from the longest side
  let best = 0;
  let theta = 0;
  for (let i = 0; i < 4; i++) {
    const a = v[i]!;
    const b = v[(i + 1) % 4]!;
    const d = dist(a, b);
    if (d > best) {
      best = d;
      theta = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
  }
  const c = Math.cos(-theta);
  const s = Math.sin(-theta);
  const local = p.map((q): Vec => [q[0] * c - q[1] * s, q[0] * s + q[1] * c]);
  const b = bboxOf(local);
  const lc: Vec = [b.x + b.w / 2, b.y + b.h / 2];
  const cc = Math.cos(theta);
  const ss = Math.sin(theta);
  const center: Vec = [lc[0] * cc - lc[1] * ss, lc[0] * ss + lc[1] * cc];
  return boxShape('rect', center, b.w / 2, b.h / 2, theta, ar);
}

function tryEllipse(p: Vec[], ar: number): RecognizedShape | null {
  const r = resample(p, 64);
  let mx = 0;
  let my = 0;
  for (const q of r) {
    mx += q[0];
    my += q[1];
  }
  mx /= r.length;
  my /= r.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const q of r) {
    const dx = q[0] - mx;
    const dy = q[1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= r.length;
  syy /= r.length;
  sxy /= r.length;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  if (!(l2 > 0)) return null;
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const a = Math.sqrt(2 * l1);
  const b = Math.sqrt(2 * l2);
  if (b / a < 0.12) return null;
  const c = Math.cos(-theta);
  const s = Math.sin(-theta);
  let err = 0;
  const angleCover = new Set<number>();
  for (const q of r) {
    const dx = q[0] - mx;
    const dy = q[1] - my;
    const u = dx * c - dy * s;
    const w = dx * s + dy * c;
    err += Math.abs(Math.hypot(u / a, w / b) - 1);
    angleCover.add(Math.floor(((Math.atan2(w / b, u / a) + Math.PI) / (2 * Math.PI)) * 12));
  }
  err /= r.length;
  if (err > 0.12 || angleCover.size < 11) return null;
  return boxShape('ellipse', [mx, my], a, b, theta, ar);
}

/** Recognize a line / arrow / rectangle / ellipse, or null (the stroke stays as written). */
export function recognizeShape(points: readonly InkPoint[], ar: number): RecognizedShape | null {
  if (points.length < 4) return null;
  const p = toIso(points, ar);
  const L = polylineLength(p);
  const bb = bboxOf(p);
  const diag = Math.hypot(bb.w, bb.h);
  if (L < 0.02 || diag < 0.015) return null;
  const line = tryLine(p, L);
  if (line) return { ...line, from: fromIso(line.from, ar), to: fromIso(line.to, ar) };
  const D = dist(p[0]!, p[p.length - 1]!);
  if (D <= 0.2 * L) return tryRect(p, L, ar) ?? tryEllipse(p, ar);
  const arrow = tryArrow(p, diag);
  if (arrow) return { ...arrow, from: fromIso(arrow.from, ar), to: fromIso(arrow.to, ar) };
  return null;
}
