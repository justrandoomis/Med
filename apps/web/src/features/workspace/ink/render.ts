// Canvas rendering of ink items from NORMALIZED data (spec §25, AC-21): positions are recomputed
// from the stored page coordinates at every zoom / rotation / device pixel ratio, so a stroke is
// drawn at the same place on the page on any device. Paths are built once per item in PAGE UNITS
// and cached; a view change only re-strokes them under a new transform (no path rebuilding).
import { shapeParts, type InkData, type InkPoint, type ShapeData } from '@medlevo/shared';
import { inkKind, isBuiltInKind } from './kinds';
import { clampPressure, pressureWidthFactor, smoothPoints, type Mat } from './math';
import { isInkStroke, isShape, type InkItem } from './model';
import { dashPattern, dashPieces, graphitePattern, pencilAlpha, pencilWidthFactor, PENCIL_FLAT_ALPHA } from './pencil';
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
  /**
   * (P1-T2 review) the resolved ink palette (every colour token's computed value): display modes (e-ink, high contrast)
   * and themes change it without changing `tone`, and cached ink tiles are bitmaps of these colours
   */
  palette?: string;
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
  /** variable width: one path per width bucket (page units); (N1 wave 2) a pencil bucket also has its opacity */
  buckets: Array<{ w: number; path: Path2D; alpha?: number }> | null;
  /** single-sample stroke: a dot */
  dot: { x: number; y: number; r: number } | null;
  width: number;
  /** (N1 wave 2, G06) drawn with the graphite grain; `alpha` = the pencil's opacity when its width is constant */
  graphite?: boolean;
  alpha?: number;
  /** (N1 wave 2, G20) a shape's inside (filled translucent with its fill colour) */
  fill?: Path2D | null;
  /** (N1 wave 2, G20) parts filled with the line colour (an activation head) */
  solid?: Path2D | null;
}

const cache = new WeakMap<object, CachedPaths>();

/**
 * (N1, G01) How a stroke's width is computed: from pressure (when the pen reported it and the stroke is not «constant»),
 * with its pressure floor, and thinned at the ends by its taper. A stroke without the N1 fields draws exactly as before.
 * (N1 wave 2) A pencil stroke maps pressure to width and opacity; a dashed stroke is cut along its length.
 */
interface WidthRule {
  variable: boolean;
  floor: number;
  taper: 'round' | 'sharp' | null;
  graphite: boolean;
  dash: [number, number] | null;
}

function widthRule(d: InkData, base: number): WidthRule {
  const st = d.style;
  const hl = st.tool === 'highlighter';
  return {
    variable: d.pressure_available && !st.constant && !hl,
    floor: typeof st.pressure_floor === 'number' && st.pressure_floor > 0 ? Math.min(0.9, st.pressure_floor) : 0,
    taper: !hl && (st.taper === 'round' || st.taper === 'sharp') ? st.taper : null,
    graphite: !hl && st.texture === 'graphite',
    dash: !hl && (st.dash === 'dash' || st.dash === 'dot') ? dashPattern(st.dash, base) : null,
  };
}

/** Width factor at a fraction `t` (0 = an end of the stroke, 1 = the taper length or more away from both ends). */
export function taperFactor(taper: 'round' | 'sharp' | null, t: number): number {
  if (!taper) return 1;
  const u = Math.min(1, Math.max(0, t));
  return taper === 'round' ? 0.35 + 0.65 * Math.sqrt(u) : 0.08 + 0.92 * u;
}

function inkPaths(d: InkData, W: number, H: number): CachedPaths {
  const smoothing = typeof d.style.smoothing === 'number' ? Math.min(6, Math.max(0, Math.round(d.style.smoothing))) : 2;
  const pts = smoothPoints(d.points, smoothing);
  const base = d.style.width * W;
  const rule = widthRule(d, base);
  const factor = (p: number | undefined) => (rule.graphite ? pencilWidthFactor(clampPressure(p)) : pressureWidthFactor(d.style.tool, clampPressure(p)));
  const extra = rule.graphite ? { graphite: true, alpha: rule.variable ? undefined : PENCIL_FLAT_ALPHA } : {};
  if (pts.length === 1) {
    const p = pts[0]!;
    const w = rule.variable ? base * factor(Math.max(rule.floor, clampPressure(p[3]))) : base;
    return { W, H, path: null, buckets: null, dot: { x: p[0] * W, y: p[1] * H, r: Math.max(w / 2, 0.25) }, width: w, ...extra, ...(rule.graphite && rule.variable ? { alpha: pencilAlpha(clampPressure(p[3])) } : {}) };
  }
  if (!rule.variable && !rule.taper) {
    const path = new Path2D();
    if (rule.dash) {
      // (G04) dashes / dots cut along the smoothed line, in page units
      for (const piece of dashPieces(pts.map((q) => [q[0] * W, q[1] * H] as [number, number]), rule.dash)) {
        path.moveTo(piece.a[0], piece.a[1]);
        path.lineTo(piece.b[0], piece.b[1]);
      }
      return { W, H, path, buckets: null, dot: null, width: base, ...extra };
    }
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
    return { W, H, path, buckets: null, dot: null, width: base, ...extra };
  }
  return { W, H, path: null, buckets: variableBuckets(pts, base, W, H, rule, factor), dot: null, width: base, ...(rule.graphite ? { graphite: true } : {}) };
}

/**
 * Variable width: each segment is stroked with round caps at the average width of its ends;
 * segments are grouped by quantized width (≤ 6 % steps) so a stroke costs a handful of stroke()
 * calls instead of one per segment. Opaque pens overlap invisibly.
 * (N1 wave 2) A pencil groups by width AND opacity (both follow the pressure); a dashed stroke keeps only the «on» parts
 * of each segment.
 */
function variableBuckets(pts: readonly InkPoint[], base: number, W: number, H: number, rule: WidthRule, factor: (p: number | undefined) => number): Array<{ w: number; path: Path2D; alpha?: number }> {
  const step = Math.max(base * 0.06, 0.05);
  const widths: number[] = new Array(pts.length);
  const alphas: number[] | null = rule.graphite && rule.variable ? new Array(pts.length) : null;
  const press = (p: number | undefined) => Math.max(rule.floor, clampPressure(p));
  let ema = press(pts[0]![3]);
  for (let i = 0; i < pts.length; i++) {
    ema = ema * 0.6 + press(pts[i]![3]) * 0.4;
    widths[i] = rule.variable ? base * factor(ema) : base;
    if (alphas) alphas[i] = pencilAlpha(ema);
  }
  if (rule.taper) {
    // distance along the stroke (page units) from each end; the taper runs over a quarter of the stroke at most
    const along: number[] = new Array(pts.length);
    along[0] = 0;
    for (let i = 1; i < pts.length; i++) along[i] = along[i - 1]! + Math.hypot((pts[i]![0] - pts[i - 1]![0]) * W, (pts[i]![1] - pts[i - 1]![1]) * H);
    const total = along[pts.length - 1]!;
    const span = Math.max(1e-6, Math.min(total * 0.25, base * 8));
    for (let i = 0; i < pts.length; i++) widths[i] = widths[i]! * taperFactor(rule.taper, Math.min(along[i]!, total - along[i]!) / span);
  }
  const buckets = new Map<string, { k: number; a: number | null; path: Path2D }>();
  const add = (i: number, a: readonly number[], b: readonly number[]) => {
    const w = (widths[i - 1]! + widths[i]!) / 2;
    const k = Math.max(1, Math.round(w / step));
    const ak = alphas ? Math.round(((alphas[i - 1]! + alphas[i]!) / 2) * 12) : null;
    const key = ak === null ? `${k}` : `${k}:${ak}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = { k, a: ak, path: new Path2D() }));
    bucket.path.moveTo(a[0]!, a[1]!);
    bucket.path.lineTo(b[0]!, b[1]!);
  };
  if (rule.dash) {
    for (const piece of dashPieces(pts.map((q) => [q[0] * W, q[1] * H] as [number, number]), rule.dash)) add(piece.seg, piece.a, piece.b);
  } else {
    for (let i = 1; i < pts.length; i++) add(i, [pts[i - 1]![0] * W, pts[i - 1]![1] * H], [pts[i]![0] * W, pts[i]![1] * H]);
  }
  return [...buckets.values()]
    .sort((x, y) => x.k - y.k || (x.a ?? 0) - (y.a ?? 0))
    .map((b) => (b.a === null ? { w: b.k * step, path: b.path } : { w: b.k * step, path: b.path, alpha: b.a / 12 }));
}

function shapePaths(item: InkItem & { data: ShapeData }, W: number, H: number): CachedPaths {
  const d = item.data;
  const ar = H / W;
  const path = new Path2D();
  const width = d.style.width * W;
  const dash = d.style.dash === 'dash' || d.style.dash === 'dot' ? dashPattern(d.style.dash, width) : null;
  let fill: Path2D | null = null;
  let solid: Path2D | null = null;
  // iso units × W = page units on both axes (iso Y = y·ar, page v = y·H = Y·W)
  for (const part of shapeParts(d, ar)) {
    const pts = part.pts.map((p) => [p[0] * W, p[1] * W] as [number, number]);
    if (part.solid) {
      solid ??= new Path2D();
      pts.forEach((p, i) => (i === 0 ? solid!.moveTo(p[0], p[1]) : solid!.lineTo(p[0], p[1])));
      solid.closePath();
    }
    if (part.closed && d.fill && part.role === 'body') {
      fill ??= new Path2D();
      pts.forEach((p, i) => (i === 0 ? fill!.moveTo(p[0], p[1]) : fill!.lineTo(p[0], p[1])));
      fill.closePath();
    }
    // (G04) the outline's own dash, (G20) a conversion arrow's dashed shaft; heads are always solid lines
    const pattern = part.role === 'body' ? (part.dashed ? dashPattern('dash', width) : dash) : null;
    if (pattern) {
      for (const piece of dashPieces(pts, pattern)) {
        path.moveTo(piece.a[0], piece.a[1]);
        path.lineTo(piece.b[0], piece.b[1]);
      }
    } else {
      pts.forEach((p, i) => (i === 0 ? path.moveTo(p[0], p[1]) : path.lineTo(p[0], p[1])));
      // a closed outline joins at its first corner like at the others
      if (part.closed) path.closePath();
    }
  }
  return { W, H, path, buckets: null, dot: null, width, fill, solid };
}

function pathsFor(item: InkItem, W: number, H: number): CachedPaths | null {
  const hit = cache.get(item.data);
  if (hit && hit.W === W && hit.H === H) return hit;
  let c: CachedPaths | null = null;
  if (isInkStroke(item)) c = inkPaths(item.data, W, H);
  else if (isShape(item)) c = shapePaths(item as InkItem & { data: ShapeData }, W, H);
  if (c) cache.set(item.data, c);
  return c;
}

/** (tests) The cached paths of an item at a page size. */
export function pathsForTest(item: InkItem, W: number, H: number): CachedPaths | null {
  return pathsFor(item, W, H);
}

/** (N1 wave 2, G20) opacity of a shape's fill: the writing under it stays readable */
export const SHAPE_FILL_ALPHA = 0.28;

/** Draws one item. The context transform must already be pageMatrix(view, dpr). */
export function drawItem(ctx: CanvasRenderingContext2D, item: InkItem, env: RenderEnv, minDevicePx = 0.6): void {
  if (!isBuiltInKind(item.kind)) {
    // (N1 Wave 0) a kind registered by another track draws itself
    const draw = inkKind(item.kind)?.draw;
    if (draw) {
      ctx.save();
      try {
        draw(ctx, item, env);
      } finally {
        ctx.restore();
      }
    }
    return;
  }
  const paths = pathsFor(item, env.W, env.H);
  if (!paths) return;
  const style = isInkStroke(item) ? item.data.style : isShape(item) ? item.data.style : null;
  if (!style) return;
  const highlighter = style.tool === 'highlighter';
  const color = resolveInkColor(style.color, env.tone, env.css, highlighter ? 'highlighter' : 'pen');
  // never thinner than ~half a device pixel (stays visible when zoomed far out)
  const t = ctx.getTransform();
  const unitPx = Math.hypot(t.a, t.b) || 1;
  const minW = minDevicePx / unitPx;
  const baseAlpha = highlighter ? (env.highlightAlpha ?? HIGHLIGHT_ALPHA) : (style.opacity ?? 1);
  ctx.globalAlpha = baseAlpha * (paths.alpha ?? 1);
  ctx.globalCompositeOperation = highlighter ? 'multiply' : 'source-over';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // (N1 wave 2, G06) the pencil's grain (the plain colour where the browser cannot make a pattern)
  const ink: string | CanvasPattern = paths.graphite ? (graphitePattern(ctx, color) ?? color) : color;
  // (N1 wave 2, G20) a shape's inside first, translucent, then its outline
  if (paths.fill && isShape(item) && item.data.fill) {
    ctx.fillStyle = resolveInkColor(item.data.fill, env.tone, env.css, item.data.fill.startsWith('hl-') ? 'highlighter' : 'pen');
    ctx.globalAlpha = baseAlpha * SHAPE_FILL_ALPHA;
    ctx.fill(paths.fill);
    ctx.globalAlpha = baseAlpha;
  }
  if (paths.dot) {
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(paths.dot.x, paths.dot.y, Math.max(paths.dot.r, minW / 2), 0, Math.PI * 2);
    ctx.fill();
  } else if (paths.path) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(paths.width, minW);
    ctx.stroke(paths.path);
  } else if (paths.buckets) {
    ctx.strokeStyle = ink;
    for (const b of paths.buckets) {
      if (b.alpha !== undefined) ctx.globalAlpha = baseAlpha * b.alpha;
      ctx.lineWidth = Math.max(b.w, minW);
      ctx.stroke(b.path);
    }
  }
  if (paths.solid) {
    ctx.fillStyle = color;
    ctx.globalAlpha = baseAlpha;
    ctx.fill(paths.solid);
    ctx.lineWidth = Math.max(paths.width, minW);
    ctx.strokeStyle = color;
    ctx.stroke(paths.solid);
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
