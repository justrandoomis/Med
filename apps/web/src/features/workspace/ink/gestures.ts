// Pen and finger gestures (parity N1, G14). Pure recognisers — no DOM, no store — unit-tested on a corpus of real
// handwriting shapes (test/ink/gestures.test.ts).
//
//  * Scribble to erase: recognised only AFTER a stroke was committed (never on the live path). A dense back-and-forth
//    zig-zag drawn over existing writing removes the strokes it covers — at least 2 strokes, or at least 60 % of one
//    stroke's box — as one undo step. The shape must reverse at least 5 times along one axis, with even swings between
//    two «rails», sharp turns and little progress per swing, and most of it must lie over the writing it erases. A
//    normal hand's Arabic letters (س ش ممم), Latin m / w and a hand-drawn ECG strip fail the shape tests (the ECG's waves
//    differ in height and run along the strip; loops turn smoothly; letters progress along the line). A very cramped
//    «سسس», a small cursive «vvv» or a column of ticks in one stroke CAN pass them (review of N1 wave 1) — they still
//    erase nothing on empty paper or beside writing, because the zig-zag must lie mostly over what it erases.
//    Shading or filling INSIDE a closed outline drawn before (a cell's nucleus, a hand-drawn check box) never erases that
//    outline: a scribble lying (almost) entirely inside a closed loop is drawing, not a scratch-out.
//  * Circle + hold: a closed loop held still starts a lasso selection of what it encloses.
//  * Two-finger double tap = undo, three-finger double tap = redo: fingers only, ignored while a pen is down.
import type { InkPoint, NormBox } from '@medlevo/shared';
import { bboxOf, fractionInside, pointInPolygon, polylineLength, type Vec } from './math';

// ─── scribble ──────────────────────────────────────────────────────────────────────────────────────
export interface ScribbleShape {
  /** the gesture resampled evenly (iso units: x, y · ar) */
  path: Vec[];
  /** its box (normalized) */
  box: NormBox;
  /** reversals along the zig-zag axis */
  reversals: number;
  /** median swing (iso units) */
  swing: number;
}

export interface ScribbleDiagnostics {
  ok: boolean;
  reason: 'too_short' | 'few_reversals' | 'uneven' | 'off_rails' | 'progresses' | 'smooth_turns' | null;
  reversals: number;
}

const MIN_LENGTH = 0.04; // page widths
const MIN_REVERSALS = 5;
const RESAMPLE = 240;

function resample(iso: readonly Vec[], n: number): Vec[] {
  const L = polylineLength(iso);
  if (L <= 0 || iso.length < 2) return iso.slice();
  const step = L / (n - 1);
  const out: Vec[] = [iso[0]!];
  let acc = 0;
  let i = 1;
  let prev = iso[0]!;
  while (i < iso.length && out.length < n) {
    const cur = iso[i]!;
    const d = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    if (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      const p: Vec = [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
      out.push(p);
      prev = p;
      acc = 0;
    } else {
      acc += d;
      prev = cur;
      i++;
    }
  }
  if (out.length < n) out.push(iso[iso.length - 1]!);
  return out;
}

/** The axis the pen mostly moved along (unsigned), from the doubled angles of the segments. */
function movementAxis(path: readonly Vec[]): Vec {
  let c = 0;
  let s = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i]![0] - path[i - 1]![0];
    const dy = path[i]![1] - path[i - 1]![1];
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const a = Math.atan2(dy, dx);
    c += Math.cos(2 * a) * len;
    s += Math.sin(2 * a) * len;
  }
  const t = Math.atan2(s, c) / 2;
  return [Math.cos(t), Math.sin(t)];
}

/** Indices of the turning points along one projected coordinate, with hysteresis `h`. */
function turningPoints(v: readonly number[], h: number): number[] {
  const out: number[] = [0];
  let dir = 0;
  let ext = 0;
  for (let i = 1; i < v.length; i++) {
    const x = v[i]!;
    if (dir === 0) {
      if (Math.abs(x - v[0]!) > h) {
        dir = x > v[0]! ? 1 : -1;
        ext = i;
      } else if ((x > v[0]! && x > v[ext]!) || (x < v[0]! && x < v[ext]!)) ext = i;
      continue;
    }
    if ((dir > 0 && x > v[ext]!) || (dir < 0 && x < v[ext]!)) ext = i;
    else if (Math.abs(x - v[ext]!) > h) {
      out.push(ext);
      dir = -dir;
      ext = i;
    }
  }
  out.push(v.length - 1);
  return out;
}

/** Direction angle between two resampled points. */
function heading(p: readonly Vec[], a: number, b: number): number {
  return Math.atan2(p[b]![1] - p[a]![1], p[b]![0] - p[a]![0]);
}

function angleBetween(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/** Is this stroke (normalized points) shaped like a scribble? Returns the shape, or why not (diagnostics). */
export function analyseScribble(points: readonly InkPoint[] | readonly Vec[], ar: number): { shape: ScribbleShape | null; diag: ScribbleDiagnostics } {
  const no = (reason: ScribbleDiagnostics['reason'], reversals = 0) => ({ shape: null, diag: { ok: false, reason, reversals } });
  if (points.length < 8) return no('too_short');
  const iso: Vec[] = points.map((p) => [p[0]!, p[1]! * ar]);
  const L = polylineLength(iso);
  if (L < MIN_LENGTH) return no('too_short');
  const path = resample(iso, RESAMPLE);
  const u = movementAxis(path);
  const su = path.map((p) => p[0] * u[0] + p[1] * u[1]);
  const sv = path.map((p) => -p[0] * u[1] + p[1] * u[0]);
  const lo = Math.min(...su);
  const hi = Math.max(...su);
  const range = hi - lo;
  if (range <= 0) return no('few_reversals');
  const turns = turningPoints(su, range * 0.25);
  const reversals = turns.length - 2;
  if (reversals < MIN_REVERSALS) return no('few_reversals', reversals);
  // even swings: the half-cycles between turning points are of similar size
  const swings: number[] = [];
  for (let i = 1; i < turns.length; i++) swings.push(Math.abs(su[turns[i]!]! - su[turns[i - 1]!]!));
  const inner = swings.slice(1, -1);
  const sorted = [...inner].sort((a, b) => a - b);
  const swing = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (!(swing > 0)) return no('uneven', reversals);
  const even = inner.filter((s) => s >= swing * 0.5 && s <= swing * 1.7).length / inner.length;
  if (even < 0.75) return no('uneven', reversals);
  // two rails: every inner turning point lies near the top or the bottom of the swing range
  const rails = turns.slice(1, -1).filter((k) => {
    const f = (su[k]! - lo) / range;
    return f <= 0.3 || f >= 0.7;
  }).length;
  if (rails / reversals < 0.75) return no('off_rails', reversals);
  // little progress along the other axis per swing (letters and ECG strips advance along the line)
  const advance = (Math.max(...sv) - Math.min(...sv)) / (reversals + 1);
  if (advance > swing * 0.45) return no('progresses', reversals);
  // sharp turns: the pen comes back along (nearly) the way it went
  const step = Math.max(2, Math.round((RESAMPLE * swing * 0.18) / L));
  let sharp = 0;
  for (const k of turns.slice(1, -1)) {
    const a = Math.max(0, k - step);
    const b = Math.min(path.length - 1, k + step);
    if (k - a < 1 || b - k < 1) continue;
    if (angleBetween(heading(path, a, k), heading(path, k, b)) >= (115 * Math.PI) / 180) sharp++;
  }
  if (sharp / reversals < 0.7) return no('smooth_turns', reversals);
  const nb = bboxOf(path.map((p) => [p[0], p[1] / ar] as Vec));
  return { shape: { path, box: nb, reversals, swing }, diag: { ok: true, reason: null, reversals } };
}

export function detectScribble(points: readonly InkPoint[] | readonly Vec[], ar: number): ScribbleShape | null {
  return analyseScribble(points, ar).shape;
}

export interface ScribbleCandidate {
  id: string;
  /** normalized box of the item (with its stroke width) */
  box: NormBox;
  /** does the scribble's path touch the item's ink? */
  touched: boolean;
  /**
   * (review) the item as a closed outline (iso polygon: a drawn circle, box or organ border; a rectangle or ellipse
   * shape) — absent when it does not close on itself. A scribble lying inside it is shading, never a scratch-out of it.
   */
  outline?: readonly Vec[];
}

/** Share of the scribble's path inside an outline above which the scribble is shading / filling that outline. */
const SHADING_INSIDE = 0.8;

function overlapRatio(a: NormBox, b: NormBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const area = Math.max(a.w, 1e-6) * Math.max(a.h, 1e-6);
  return Math.min(1, (w * h) / area);
}

/**
 * Which items a recognised scribble erases: the strokes it touches whose box it covers by at least 60 % (so it removes
 * at least 2 covered strokes, or one stroke at ≥ 60 % of its box), provided a good part of the scribble lies over them —
 * a zig-zag drawn on blank paper next to writing, or shading inside a drawn outline, erases nothing.
 */
export function scribbleTargets(s: ScribbleShape, candidates: readonly ScribbleCandidate[], ar: number): string[] {
  // the scribble's reach: its box with a small margin (a scratch-out rarely spans every dot and descender exactly)
  const mx = s.box.w * 0.1;
  const my = s.box.h * 0.1;
  const reach: NormBox = { x: s.box.x - mx, y: s.box.y - my, w: s.box.w + 2 * mx, h: s.box.h + 2 * my };
  const hits = candidates
    .filter((c) => c.touched)
    // (review) shading or filling inside a closed outline drawn before: the outline is not what is being scratched out
    .filter((c) => !(c.outline && c.outline.length >= 3 && fractionInside(s.path, c.outline) >= SHADING_INSIDE))
    .map((c) => ({ c, cover: overlapRatio(c.box, reach) }))
    .filter((x) => x.cover >= 0.6);
  if (hits.length === 0) return [];
  const pad = s.swing * 0.15;
  const boxes = hits.map((x) => x.c.box);
  const over = s.path.filter((p) => {
    const nx = p[0];
    const ny = p[1] / ar;
    return boxes.some((b) => nx >= b.x - pad && nx <= b.x + b.w + pad && ny >= b.y - pad / ar && ny <= b.y + b.h + pad / ar);
  }).length;
  if (over / s.path.length < 0.4) return [];
  return hits.map((x) => x.c.id);
}

// ─── closed loop (circle + hold → lasso) ───────────────────────────────────────────────────────────
/**
 * The stroke as a lasso polygon (normalized points) when it is a closed loop: long enough, ending near where it began,
 * enclosing a real area, and going round about once. Null otherwise.
 */
export function closedLoop(points: readonly InkPoint[] | readonly Vec[], ar: number): Vec[] | null {
  return loopIso(points, ar, 0.06, (L) => Math.max(0.02, L * 0.15)) ? points.map((p) => [p[0]!, p[1]!] as Vec) : null;
}

/**
 * (review) A stroke that closes on itself — a drawn circle, a hand-drawn box, the border of an organ — as an iso polygon
 * (x, y · ar); null otherwise. Smaller loops count than for the circle + hold gesture (a nucleus, a check box).
 */
export function closedOutline(points: readonly InkPoint[] | readonly Vec[], ar: number): Vec[] | null {
  return loopIso(points, ar, 0.012, (L) => Math.max(0.006, L * 0.2));
}

/** The loop test shared by `closedLoop` and `closedOutline`; returns the iso points when the stroke is a loop. */
function loopIso(points: readonly InkPoint[] | readonly Vec[], ar: number, minLength: number, maxGap: (L: number) => number): Vec[] | null {
  if (points.length < 8) return null;
  const iso: Vec[] = points.map((p) => [p[0]!, p[1]! * ar]);
  const L = polylineLength(iso);
  if (L < minLength) return null;
  const first = iso[0]!;
  const last = iso[iso.length - 1]!;
  const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);
  if (gap > maxGap(L)) return null;
  let area = 0;
  for (let i = 0, j = iso.length - 1; i < iso.length; j = i++) area += (iso[j]![0] + iso[i]![0]) * (iso[j]![1] - iso[i]![1]);
  area = Math.abs(area) / 2;
  // a loop's area is a real share of the circle with the same perimeter (a back-and-forth line has almost none)
  const circle = (L * L) / (4 * Math.PI);
  if (area < circle * 0.25) return null;
  let turning = 0;
  for (let i = 2; i < iso.length; i++) {
    const a = Math.atan2(iso[i - 1]![1] - iso[i - 2]![1], iso[i - 1]![0] - iso[i - 2]![0]);
    const b = Math.atan2(iso[i]![1] - iso[i - 1]![1], iso[i]![0] - iso[i - 1]![0]);
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turning += d;
  }
  const turns = Math.abs(turning) / (2 * Math.PI);
  if (turns < 0.75 || turns > 1.6) return null;
  return iso;
}

/** Lasso membership of sampled item points (normalized) in a loop: at least half of them inside. */
export function enclosedBy(loop: readonly Vec[], samples: readonly Vec[], wholeBox = false): boolean {
  return wholeBox ? samples.every((p) => pointInPolygon(p, loop)) : fractionInside(samples, loop) >= 0.5;
}

// ─── two- / three-finger double tap ────────────────────────────────────────────────────────────────
export const TAP_MAX_MS = 320;
export const DOUBLE_TAP_MS = 450;
export const TAP_SLOP_PX = 14;

interface Finger {
  x: number;
  y: number;
}

/**
 * Turns finger pointer events into «two-finger double tap» (undo) and «three-finger double tap» (redo). Fingers only: a
 * group is void when any finger moved, when it lasted too long, when a pointer was cancelled (the browser started a
 * scroll or zoom) or when a pen touched the screen meanwhile.
 */
export class FingerTapDetector {
  private fingers = new Map<number, Finger>();
  private max = 0;
  private start = 0;
  private void = false;
  private lastTap: { fingers: number; at: number } | null = null;
  private pens = 0;

  constructor(private readonly onDoubleTap: (fingers: 2 | 3) => void) {}

  down(id: number, pointerType: string, x: number, y: number, t: number): void {
    if (pointerType === 'pen') {
      this.pens++;
      this.void = true;
      this.lastTap = null;
      return;
    }
    if (pointerType !== 'touch') return;
    if (this.fingers.size === 0) {
      this.max = 0;
      this.start = t;
      this.void = this.pens > 0;
    }
    this.fingers.set(id, { x, y });
    this.max = Math.max(this.max, this.fingers.size);
  }

  move(id: number, x: number, y: number): void {
    const f = this.fingers.get(id);
    if (f && Math.hypot(x - f.x, y - f.y) > TAP_SLOP_PX) this.void = true;
  }

  up(id: number, pointerType: string, t: number): void {
    if (pointerType === 'pen') {
      this.pens = Math.max(0, this.pens - 1);
      return;
    }
    if (!this.fingers.delete(id) || this.fingers.size > 0) return;
    const ok = !this.void && t - this.start <= TAP_MAX_MS && (this.max === 2 || this.max === 3);
    if (!ok) {
      this.lastTap = null;
      return;
    }
    const prev = this.lastTap;
    if (prev && prev.fingers === this.max && t - prev.at <= DOUBLE_TAP_MS) {
      this.lastTap = null;
      this.onDoubleTap(this.max as 2 | 3);
    } else {
      this.lastTap = { fingers: this.max, at: t };
    }
  }

  cancel(id: number, pointerType: string): void {
    if (pointerType === 'pen') {
      this.pens = Math.max(0, this.pens - 1);
      return;
    }
    if (this.fingers.delete(id)) this.void = true;
    if (this.fingers.size === 0) this.lastTap = null;
  }
}
