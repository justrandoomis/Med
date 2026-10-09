// Canvas rendering of ink items from NORMALIZED data (spec §25, AC-21): positions are recomputed
// from the stored page coordinates at every zoom / rotation / device pixel ratio, so a stroke is
// drawn at the same place on the page on any device. Paths are built once per item in PAGE UNITS
// and cached; a view change only re-strokes them under a new transform (no path rebuilding).
import type { InkData, InkPoint } from '@medlevo/shared';
import { clampPressure, pressureWidthFactor, smoothPoints, type Mat } from './math';
import { isInkStroke, isShape, shapeOutline, type InkItem } from './model';
import { resolveInkColor, type PaperTone } from './palette';
import type { InkPageView } from './types';

/** page units → device px for a page view (rotation clockwise, origin at the rendered box's top-left). */
export function pageMatrix(view: InkPageView, dpr = 1): Mat {
  const s = view.scale * dpr;
  const W = view.pageWidth * s;
  const H = view.pageHeight * s;
  switch (view.rotation) {
    case 90:
      return [0, s, -s, 0, H, 0];
    case 180:
      return [-s, 0, 0, -s, W, H];
    case 270:
      return [0, -s, s, 0, 0, W];
    default:
      return [s, 0, 0, s, 0, 0];
  }
}

/** Device-pixel ratio for a canvas of this css size, capped so huge zooms never exceed browser canvas limits. */
export function canvasScale(cssW: number, cssH: number, dpr: number, maxPixels = 16_000_000): number {
  const area = Math.max(1, cssW * cssH);
  return area * dpr * dpr > maxPixels ? Math.sqrt(maxPixels / area) : dpr;
}

export interface RenderEnv {
  /** unrotated page size in page units */
  W: number;
  H: number;
  tone: PaperTone;
  css: CSSStyleDeclaration | null;
  /** alpha for highlighter strokes (lower when the blend with the page is unavailable) */
  highlightAlpha?: number;
}

/** Highlighter alpha with the multiply/screen blend reaching the page: text keeps its full contrast. */
export const HIGHLIGHT_ALPHA = 0.85;
/** Without the blend (isolated wrapper): light enough that text under it stays legible (≥ 4.5:1 on black text). */
export const HIGHLIGHT_ALPHA_ISOLATED = 0.35;

interface CachedPaths {
  W: number;
  H: number;
  /** constant-width path (or null when variable) */
  path: Path2D | null;
  /** variable width: one path per width bucket (page units) */
  buckets: Array<{ w: number; path: Path2D }> | null;
  /** single-sample stroke: a dot */
  dot: { x: number; y: number; r: number } | null;
  width: number;
}

const cache = new WeakMap<object, CachedPaths>();

function inkPaths(d: InkData, W: number, H: number): CachedPaths {
  const pts = smoothPoints(d.points, 2);
  const base = d.style.width * W;
  if (pts.length === 1) {
    const p = pts[0]!;
    const w = d.pressure_available ? base * pressureWidthFactor(d.style.tool, p[3]) : base;
    return { W, H, path: null, buckets: null, dot: { x: p[0] * W, y: p[1] * H, r: Math.max(w / 2, 0.25) }, width: w };
  }
  if (!d.pressure_available || d.style.tool === 'highlighter') {
    const path = new Path2D();
    path.moveTo(pts[0]![0] * W, pts[0]![1] * H);
    if (pts.length === 2) path.lineTo(pts[1]![0] * W, pts[1]![1] * H);
    else {
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        path.quadraticCurveTo(a[0] * W, a[1] * H, ((a[0] + b[0]) / 2) * W, ((a[1] + b[1]) / 2) * H);
      }
      const last = pts[pts.length - 1]!;
      path.lineTo(last[0] * W, last[1] * H);
    }
    return { W, H, path, buckets: null, dot: null, width: base };
  }
  return { W, H, path: null, buckets: variableBuckets(pts, d, base, W, H), dot: null, width: base };
}

/**
 * Variable width: each segment is stroked with round caps at the average width of its ends;
 * segments are grouped by quantized width (≤ 6 % steps) so a stroke costs a handful of stroke()
 * calls instead of one per segment. Opaque pens overlap invisibly.
 */
function variableBuckets(pts: readonly InkPoint[], d: InkData, base: number, W: number, H: number): Array<{ w: number; path: Path2D }> {
  const step = Math.max(base * 0.06, 0.05);
  const widths: number[] = new Array(pts.length);
  let ema = clampPressure(pts[0]![3]);
  for (let i = 0; i < pts.length; i++) {
    ema = ema * 0.6 + clampPressure(pts[i]![3]) * 0.4;
    widths[i] = base * pressureWidthFactor(d.style.tool, ema);
  }
  const buckets = new Map<number, Path2D>();
  for (let i = 1; i < pts.length; i++) {
    const w = (widths[i - 1]! + widths[i]!) / 2;
    const k = Math.max(1, Math.round(w / step));
    let path = buckets.get(k);
    if (!path) buckets.set(k, (path = new Path2D()));
    const a = pts[i - 1]!;
    const b = pts[i]!;
    path.moveTo(a[0] * W, a[1] * H);
    path.lineTo(b[0] * W, b[1] * H);
  }
  return [...buckets.entries()].sort((x, y) => x[0] - y[0]).map(([k, path]) => ({ w: k * step, path }));
}

function shapePaths(item: InkItem & { data: import('@medlevo/shared').ShapeData }, W: number, H: number): CachedPaths {
  const ar = H / W;
  const path = new Path2D();
  for (const line of shapeOutline(item.data, ar)) {
    // iso units × W = page units on both axes (iso Y = y·ar, page v = y·H = Y·W)
    line.forEach((p, i) => (i === 0 ? path.moveTo(p[0] * W, p[1] * W) : path.lineTo(p[0] * W, p[1] * W)));
  }
  return { W, H, path, buckets: null, dot: null, width: item.data.style.width * W };
}

function pathsFor(item: InkItem, W: number, H: number): CachedPaths | null {
  const hit = cache.get(item.data);
  if (hit && hit.W === W && hit.H === H) return hit;
  let c: CachedPaths | null = null;
  if (isInkStroke(item)) c = inkPaths(item.data, W, H);
  else if (isShape(item)) c = shapePaths(item as InkItem & { data: import('@medlevo/shared').ShapeData }, W, H);
  if (c) cache.set(item.data, c);
  return c;
}

/** Draws one item. The context transform must already be pageMatrix(view, dpr). */
export function drawItem(ctx: CanvasRenderingContext2D, item: InkItem, env: RenderEnv, minDevicePx = 0.6): void {
  const paths = pathsFor(item, env.W, env.H);
  if (!paths) return;
  const style = isInkStroke(item) ? item.data.style : isShape(item) ? item.data.style : null;
  if (!style) return;
  const color = resolveInkColor(style.color, env.tone, env.css);
  const highlighter = style.tool === 'highlighter';
  // never thinner than ~half a device pixel (stays visible when zoomed far out)
  const t = ctx.getTransform();
  const unitPx = Math.hypot(t.a, t.b) || 1;
  const minW = minDevicePx / unitPx;
  ctx.globalAlpha = highlighter ? (env.highlightAlpha ?? HIGHLIGHT_ALPHA) : (style.opacity ?? 1);
  ctx.globalCompositeOperation = highlighter ? 'multiply' : 'source-over';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (paths.dot) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(paths.dot.x, paths.dot.y, Math.max(paths.dot.r, minW / 2), 0, Math.PI * 2);
    ctx.fill();
  } else if (paths.path) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(paths.width, minW);
    ctx.stroke(paths.path);
  } else if (paths.buckets) {
    ctx.strokeStyle = color;
    for (const b of paths.buckets) {
      ctx.lineWidth = Math.max(b.w, minW);
      ctx.stroke(b.path);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/** Sort for painting: z, then creation order. */
export function paintOrder(a: InkItem, b: InkItem): number {
  return a.z - b.z || a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function setMatrix(ctx: CanvasRenderingContext2D, m: Mat): void {
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
}

/** Device-px rect covering a normalized box under a page matrix (any rotation). */
export function deviceRectOf(box: { x: number; y: number; w: number; h: number }, view: InkPageView, m: Mat, pad = 2): { x: number; y: number; w: number; h: number } {
  const W = view.pageWidth;
  const H = view.pageHeight;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [nx, ny] of [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ] as const) {
    const u = nx * W;
    const v = ny * H;
    xs.push(m[0] * u + m[2] * v + m[4]);
    ys.push(m[1] * u + m[3] * v + m[5]);
  }
  const x0 = Math.floor(Math.min(...xs) - pad);
  const y0 = Math.floor(Math.min(...ys) - pad);
  return { x: x0, y: y0, w: Math.ceil(Math.max(...xs) + pad) - x0, h: Math.ceil(Math.max(...ys) + pad) - y0 };
}

/** Parses a computed css colour (rgb/rgba) → [r, g, b, a] in 0..1, or null. */
export function parseCssColor(v: string): [number, number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/.exec(v);
  if (!m) return null;
  let a = 1;
  if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, a];
}

function relLuminance([r, g, b]: [number, number, number, number]): number {
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Paper tone under the ink layer: an explicit `data-ink-paper="light|dark"` on an ancestor wins;
 * otherwise the first opaque background behind the layer decides (an original PDF page stays white
 * in the dark theme, a note page follows the theme); otherwise the app theme.
 */
export function paperToneOf(el: Element | null): PaperTone {
  const start = el?.parentElement ?? null;
  const marked = start?.closest('[data-ink-paper]')?.getAttribute('data-ink-paper');
  if (marked === 'light' || marked === 'dark') return marked;
  try {
    for (let n: Element | null = start; n; n = n.parentElement) {
      const c = parseCssColor(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0.5) return relLuminance(c) < 0.25 ? 'dark' : 'light';
    }
  } catch {
    // no computed styles (tests)
  }
  const theme = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null;
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Tone of the paper the owner is writing on right now (for toolbar swatches): the page that was
 * written on last, else the first page layer on screen, else the app theme.
 */
export function currentPaperTone(): PaperTone {
  if (typeof document === 'undefined') return 'light';
  const el = document.querySelector('.ml-ink-layer[data-ink-active]') ?? document.querySelector('.ml-ink-layer[data-ink-tone]');
  const t = el?.getAttribute('data-ink-tone');
  return t === 'dark' || t === 'light' ? t : paperToneOf(null);
}

function createsStackingContext(el: Element): boolean {
  const cs = getComputedStyle(el);
  if (cs.position !== 'static' && cs.zIndex !== 'auto' && cs.zIndex !== '') return true;
  if (cs.opacity !== '' && parseFloat(cs.opacity) < 1) return true;
  if (cs.transform && cs.transform !== 'none') return true;
  if (cs.isolation === 'isolate') return true;
  if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return true;
  if (cs.filter && cs.filter !== 'none') return true;
  if (/transform|opacity|filter/.test(cs.willChange || '')) return true;
  if (/paint|strict|content/.test(cs.contain || '')) return true;
  return false;
}

/**
 * True when a wrapper between the ink layer and the page content forms a stacking context, so the
 * highlight canvas's mix-blend-mode can only blend with transparency (not with the page). The
 * renderer then draws highlights lighter so the text under them stays legible.
 */
export function highlightBlendIsolated(layerRoot: Element): boolean {
  try {
    let path: Element = layerRoot;
    for (let n = layerRoot.parentElement; n; n = n.parentElement) {
      const hasPage = Array.from(n.children).some((c) => c !== path && (c.matches('canvas, img, svg') || !!c.querySelector('canvas, img, svg') || (c.textContent ?? '').trim() !== ''));
      if (hasPage) return false;
      if (createsStackingContext(n)) return true;
      path = n;
    }
  } catch {
    return false;
  }
  return false;
}
