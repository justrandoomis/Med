// The pencil (parity N1 wave 2, G06) and line patterns (G04): pure helpers of the renderer.
//
// A pencil stroke is an ordinary points-only stroke (`style.tool: 'pen'`, `style.texture: 'graphite'`, so an older app
// draws it as a pen line). Drawn here: pressure changes the width AND the opacity (light pressure = light grey, as on
// paper), and the line carries a graphite grain — MedLevo's own procedural texture (a seeded noise tile, no image from
// anywhere), laid in PAGE units so it stays the same on every zoom and device. Without pressure (a finger, a mouse) the
// pencil keeps one opacity.
//
// Dashes and dots are cut along the stroke by arc length in page units, scaled to the stroke's width: the pattern does
// not change with the zoom, works with pressure widths and tapers, and is cached with the stroke's paths.
import type { InkDash } from '@medlevo/shared';

/** pressure → width factor of the pencil (1 at p = 0.5 like every curve) */
export function pencilWidthFactor(p: number): number {
  return 0.55 + 0.9 * clamp01(p);
}
/** pressure → opacity of the pencil (light touch = light grey) */
export function pencilAlpha(p: number): number {
  return 0.32 + 0.66 * clamp01(p);
}
/** the pencil's opacity when the device reports no pressure */
export const PENCIL_FLAT_ALPHA = 0.82;
/** largest width factor (hit-test margins) */
export const PENCIL_MAX_FACTOR = pencilWidthFactor(1);

function clamp01(v: number): number {
  return !Number.isFinite(v) ? 0.5 : v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The dash pattern [on, off] in page units for a stroke of base width `w` (page units). */
export function dashPattern(dash: InkDash, w: number): [number, number] {
  const width = Math.max(w, 0.35);
  // a dot is a zero-length mark drawn with a round cap: a tiny «on» keeps it visible on every engine
  if (dash === 'dot') return [Math.max(0.01, width * 0.02), Math.max(1.6, width * 2.2)];
  return [Math.max(2.5, width * 4), Math.max(1.8, width * 2.6)];
}

type P = readonly [number, number];

/**
 * Cuts a polyline (page units) into the «on» parts of a dash pattern, by arc length. Each piece keeps the index of the
 * segment it came from (variable-width strokes give a piece its segment's width).
 */
export function dashPieces(pts: readonly P[], pattern: readonly [number, number]): Array<{ a: [number, number]; b: [number, number]; seg: number }> {
  const [on, off] = pattern;
  const period = on + off;
  const out: Array<{ a: [number, number]; b: [number, number]; seg: number }> = [];
  if (pts.length === 0 || !(period > 0)) return out;
  if (pts.length === 1) return [{ a: [pts[0]![0], pts[0]![1]], b: [pts[0]![0] + on, pts[0]![1]], seg: 0 }];
  let pos = 0; // arc length at the start of the segment
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    // the dashes are [k·period, k·period + on] along the whole line; those meeting this segment are cut from it (by
    // index, not by stepping a remainder: a float remainder a hair under the period would stall the loop)
    const end = pos + len;
    for (let k = Math.floor(pos / period); k * period < end; k++) {
      const s0 = Math.max(k * period, pos);
      const s1 = Math.min(k * period + on, end);
      if (s1 > s0) out.push({ a: lerp(a, b, (s0 - pos) / len), b: lerp(a, b, (s1 - pos) / len), seg: i });
    }
    pos = end;
  }
  return out;
}

function lerp(a: P, b: P, t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// ─── the graphite grain ───────────────────────────────────────────────────────────────────────
/** A tiny seeded generator (same grain on every device and every redraw). */
export function seededNoise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Alpha values (0..255) of the grain tile: fine noise with faint diagonal fibres. Pure (unit-tested). */
export function grainAlphas(size = 48, seed = 0x5eed): Uint8ClampedArray {
  const rnd = seededNoise(seed);
  const out = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fibre = Math.sin((x + y * 0.6) * 0.9) * 0.08;
      const v = 0.6 + rnd() * 0.4 + fibre;
      out[y * size + x] = Math.round(Math.min(1, Math.max(0.35, v)) * 255);
    }
  }
  return out;
}

const GRAIN_SIZE = 48;
/** one grain cell = this many page units (≈ 0.35 pt): fine enough to read as texture, not as dots */
const GRAIN_CELL_PAGE_UNITS = 0.35;
const patterns = new Map<string, CanvasPattern | null>();

/**
 * A pattern of the colour with the graphite grain, laid in page units (the context's transform maps page units to device
 * pixels). null when this browser cannot make one (tests, no canvas): the pencil is then drawn in the plain colour.
 */
export function graphitePattern(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | null {
  const hit = patterns.get(color);
  if (hit !== undefined) return hit;
  let pattern: CanvasPattern | null = null;
  try {
    const tile = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const tctx = tile?.getContext('2d') ?? null;
    if (tile && tctx && typeof ctx.createPattern === 'function') {
      tile.width = GRAIN_SIZE;
      tile.height = GRAIN_SIZE;
      tctx.fillStyle = color;
      tctx.fillRect(0, 0, GRAIN_SIZE, GRAIN_SIZE);
      const img = tctx.getImageData(0, 0, GRAIN_SIZE, GRAIN_SIZE);
      const alphas = grainAlphas(GRAIN_SIZE);
      for (let i = 0; i < alphas.length; i++) img.data[i * 4 + 3] = alphas[i]!;
      tctx.putImageData(img, 0, 0);
      pattern = ctx.createPattern(tile, 'repeat');
      if (pattern && typeof DOMMatrix !== 'undefined' && typeof pattern.setTransform === 'function') {
        pattern.setTransform(new DOMMatrix([GRAIN_CELL_PAGE_UNITS, 0, 0, GRAIN_CELL_PAGE_UNITS, 0, 0]));
      }
    }
  } catch {
    pattern = null;
  }
  // the cache stays small: one pattern per resolved colour
  if (patterns.size > 64) patterns.clear();
  patterns.set(color, pattern);
  return pattern;
}
