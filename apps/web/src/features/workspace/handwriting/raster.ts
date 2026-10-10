// The picture sent to the vision reader (track F4, §28): ONLY the selected pen strokes, re-drawn black on white,
// cropped to their own bounds, normalized in size and line width — never a screenshot of the page (no printed text,
// colours, highlights or other notes leak into the request). Planning is pure (unit-tested); drawing needs a canvas.
import { RECOGNITION_IMAGE_MIN_SIDE, RECOGNITION_RENDER_LONG_EDGE, type InkData } from '@medlevo/shared';
import { isInkStroke, isShape, shapeOutline, type InkItem } from '../ink/model';

export type Polyline = Array<[number, number]>;

/**
 * Writing in a selection as polylines in iso units (x and y both in page widths). Highlighter strokes are not writing
 * and are left out; recognized shapes are drawn as their outline (the reader is told to ignore drawings).
 */
export function writingPolylines(items: readonly InkItem[], ar: number): Polyline[] {
  const out: Polyline[] = [];
  for (const it of items) {
    if (isInkStroke(it)) {
      const d = it.data as InkData;
      if (d.style.tool === 'highlighter') continue;
      out.push(d.points.map((p) => [p[0], p[1] * ar]));
    } else if (isShape(it)) {
      for (const line of shapeOutline(it.data, ar)) out.push(line.map((p) => [p[0], p[1]]));
    }
  }
  return out.filter((l) => l.length > 0);
}

export interface RasterPlan {
  width: number;
  height: number;
  /** px per iso unit */
  scale: number;
  ox: number;
  oy: number;
  lineWidth: number;
  polylines: Polyline[];
}

export interface PlanOptions {
  /** longest side of the picture (px) — the reader's sweet spot */
  maxLongEdge?: number;
  /** px per page width for normal writing (a word of 0.1 page width → 400 px) */
  pxPerUnit?: number;
  padding?: number;
}

/** Size and transform of the picture for these polylines (null when there is nothing to draw). */
export function planRaster(polylines: readonly Polyline[], opts: PlanOptions = {}): RasterPlan | null {
  const maxLong = opts.maxLongEdge ?? RECOGNITION_RENDER_LONG_EDGE;
  const pad = opts.padding ?? 16;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of polylines)
    for (const [x, y] of l) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  if (!Number.isFinite(minX)) return null;
  const w = Math.max(maxX - minX, 1e-4);
  const h = Math.max(maxY - minY, 1e-4);
  const long = Math.max(w, h);
  // normal writing at ~4000 px per page width, but the whole selection fits the long edge
  const scale = Math.min(opts.pxPerUnit ?? 4000, (maxLong - 2 * pad) / long);
  const lineWidth = Math.min(10, Math.max(2, Math.round(scale * 0.0018 * 10) / 10));
  const minSide = Math.max(RECOGNITION_IMAGE_MIN_SIDE, 32);
  const width = Math.max(minSide, Math.ceil(w * scale + 2 * pad));
  const height = Math.max(minSide, Math.ceil(h * scale + 2 * pad));
  // centred when the minimum size is larger than the content
  const ox = (width - w * scale) / 2 - minX * scale;
  const oy = (height - h * scale) / 2 - minY * scale;
  return { width, height, scale, ox, oy, lineWidth, polylines: polylines.map((l) => l.slice()) };
}

/** Polyline points in picture pixels. */
export function planPixels(plan: RasterPlan): Polyline[] {
  return plan.polylines.map((l) => l.map(([x, y]) => [x * plan.scale + plan.ox, y * plan.scale + plan.oy]));
}

export interface RenderedPicture {
  base64: string;
  dataUrl: string;
  width: number;
  height: number;
}

export const CANVAS_UNAVAILABLE_AR = 'تعذّر رسم الكتابة كصورة في هذا المتصفح، فلا يمكن إرسالها للقراءة.';
export const NOTHING_TO_READ_AR = 'لا توجد كتابة بالقلم في التحديد لقراءتها.';

/** Draws the plan black on white and returns a PNG. Throws an Error with an Arabic message when impossible. */
export function drawPlan(plan: RasterPlan, doc: Document = document): RenderedPicture {
  const canvas = doc.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) throw new Error(CANVAS_UNAVAILABLE_AR);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, plan.width, plan.height);
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#000000';
  ctx.lineWidth = plan.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const l of planPixels(plan)) {
    if (l.length === 1) {
      ctx.beginPath();
      ctx.arc(l[0]![0], l[0]![1], plan.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(l[0]![0], l[0]![1]);
    for (let i = 1; i < l.length; i++) ctx.lineTo(l[i]![0], l[i]![1]);
    ctx.stroke();
  }
  let dataUrl = '';
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch {
    dataUrl = '';
  }
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error(CANVAS_UNAVAILABLE_AR);
  return { base64: dataUrl.slice('data:image/png;base64,'.length), dataUrl, width: plan.width, height: plan.height };
}

/** The picture of the writing in a lasso selection. */
export function renderSelectionPicture(items: readonly InkItem[], ar: number, doc?: Document): RenderedPicture {
  const plan = planRaster(writingPolylines(items, ar));
  if (!plan) throw new Error(NOTHING_TO_READ_AR);
  return drawPlan(plan, doc);
}

/** The picture of a written-answer pad (strokes in pad-width units, [x, y, t?]). */
export function renderPadPicture(strokes: ReadonlyArray<ReadonlyArray<readonly number[]>>, doc?: Document): RenderedPicture {
  const plan = planRaster(strokes.map((s) => s.map((p) => [p[0]!, p[1]!] as [number, number])), { pxPerUnit: 1200 });
  if (!plan) throw new Error('اكتب إجابتك في اللوحة أولًا.');
  return drawPlan(plan, doc);
}
