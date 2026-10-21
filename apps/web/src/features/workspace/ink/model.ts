// Ink items in memory = the AnnotationDTO wire shape (@medlevo/shared/annotations), so what the
// engine holds, what it writes to the outbox and what the server returns are the same object.
// Rows in IndexedDB use the camelCase AnnotationRow of lib/localdb.ts (converted here).
import {
  annotationTargetKey,
  BOX_SHAPES,
  CLOSED_SHAPES,
  roundInkPoint,
  shapeArrowHeadLength,
  shapeOutlineIso,
  type AnnotationAnchor,
  type AnnotationDTO,
  type ImageAnnotationData,
  type InkData,
  type InkPenTool,
  type InkPoint,
  type InkStyle,
  type LinkData,
  type NormBox,
  type ShapeData,
  type StickyData,
  type TextBoxData,
} from '@medlevo/shared';
import type { AnnotationRow } from '../../../lib/localdb';
import { inkFromWire, inkToWire } from './codec';
import { inkKind, isBuiltInKind, isEngineKind } from './kinds';
import { applyMat, bboxOf, expandBox, maxWidthFactor, roundTo, rotationOf, uniformScaleOf, type Mat, type Vec } from './math';

export type InkItem = AnnotationDTO;

/** The time of an owner's edit (ms). A function of its own, so event handlers built during render can call it. */
export function nowMs(): number {
  return Date.now();
}
export type InkItemKind = 'ink' | 'shape' | 'text' | 'sticky' | 'image' | 'link';
export const INK_ITEM_KINDS: readonly InkItemKind[] = ['ink', 'shape', 'text', 'sticky', 'image', 'link'];

export type InkItemOf<D> = Omit<InkItem, 'data'> & { data: D };

export function isInkStroke(i: InkItem): i is InkItemOf<InkData> {
  return i.kind === 'ink';
}
export function isShape(i: InkItem): i is InkItemOf<ShapeData> {
  return i.kind === 'shape';
}
export function isTextBox(i: InkItem): i is InkItemOf<TextBoxData> {
  return i.kind === 'text';
}
export function isSticky(i: InkItem): i is InkItemOf<StickyData> {
  return i.kind === 'sticky';
}
/** A picture placed on the page (track F1): a box, drawn as DOM under the ink. */
export function isImage(i: InkItem): i is InkItemOf<ImageAnnotationData> {
  return i.kind === 'image';
}
/** A page link (track F1): a box that opens another page. */
export function isLink(i: InkItem): i is InkItemOf<LinkData> {
  return i.kind === 'link';
}
/** Items placed as a box (moved / resized as a whole, lasso membership = entirely inside). */
export function isBoxItem(i: InkItem): i is InkItemOf<TextBoxData> | InkItemOf<ImageAnnotationData> | InkItemOf<LinkData> {
  return i.kind === 'text' || i.kind === 'image' || i.kind === 'link';
}
export function boxOf(i: InkItem): NormBox | null {
  return isBoxItem(i) ? (i.data as { box: NormBox }).box : null;
}
/**
 * Items this engine holds in its page memory: the built-in kinds and kinds registered by other tracks (ink/kinds.ts).
 * Other kinds — text_highlight, bookmark … — belong to the reader.
 */
export function isEngineItem(i: InkItem): boolean {
  return isEngineKind(i.kind);
}

/** A reader highlight on printed text (track B1): the engine erases / clears it (G15), the reader draws it. */
export function isTextHighlight(i: InkItem): i is InkItemOf<{ v: 1; rects: NormBox[]; color: string; style: string }> {
  return i.kind === 'text_highlight';
}

/** Sticky notes are fixed-size widgets; this is their hit radius in page-width units. */
export const STICKY_HIT_RADIUS = 0.018;

const COORD_DIGITS = 5;

/**
 * Stored coordinates must stay inside what the server accepts (apps/server … annotations/schemas.ts:
 * x, y ∈ [-1, 2] — strokes may run past the page edge, not anywhere). With pointer capture a pen
 * can travel several page sizes beyond the page, and a lasso resize/move can push items far out;
 * an out-of-range op would be rejected and never sync (§47). Only the invisible part more than a
 * page beyond the edge is affected (the layer draws the page box only).
 */
export const COORD_MIN = -1;
export const COORD_MAX = 2;
/** server limit for NormBox.w / h */
const SIZE_MAX = 3;

export function clampCoord(v: number): number {
  return v < COORD_MIN ? COORD_MIN : v > COORD_MAX ? COORD_MAX : v;
}

/** rounded + clamped stored coordinate */
function coord(v: number): number {
  return clampCoord(roundTo(v, COORD_DIGITS));
}

/** The engine's stored-point rounding — one definition, shared with the ink v2 codec (`roundInkPoint`). */
export function roundPoint(p: InkPoint): InkPoint {
  return roundInkPoint(p);
}

function roundBox(b: NormBox): NormBox {
  const size = (v: number) => Math.min(SIZE_MAX, Math.max(0, roundTo(v, COORD_DIGITS)));
  return { x: coord(b.x), y: coord(b.y), w: size(b.w), h: size(b.h) };
}

/**
 * Largest uniform scale ≤ `s` about `anchor` (iso units) that keeps `box` (norm) inside the stored
 * range, so a lasso resize stops at the limit instead of flattening the far side. Never forces a
 * shrink: when the box is already beyond the range, scales ≤ 1 stay allowed.
 */
export function limitScaleToRange(s: number, anchor: Vec, box: NormBox, ar: number): number {
  let max = Infinity;
  const limit = (a: number, c: number, lo: number, hi: number) => {
    const d = c - a;
    if (d > 1e-12) max = Math.min(max, (hi - a) / d);
    else if (d < -1e-12) max = Math.min(max, (a - lo) / -d);
  };
  for (const x of [box.x, box.x + box.w]) limit(anchor[0], x, COORD_MIN, COORD_MAX);
  for (const y of [box.y * ar, (box.y + box.h) * ar]) limit(anchor[1], y, COORD_MIN * ar, COORD_MAX * ar);
  return Math.min(s, Math.max(1, max));
}

/** (N1, G19) The per-axis version of `limitScaleToRange` for a free resize about `anchor` (iso units). */
export function limitStretchToRange(sx: number, sy: number, anchor: Vec, box: NormBox, ar: number): [number, number] {
  const limit = (s: number, a: number, cs: number[], lo: number, hi: number) => {
    let max = Infinity;
    for (const c of cs) {
      const d = c - a;
      if (d > 1e-12) max = Math.min(max, (hi - a) / d);
      else if (d < -1e-12) max = Math.min(max, (a - lo) / -d);
    }
    return Math.min(s, Math.max(1, max));
  };
  return [limit(sx, anchor[0], [box.x, box.x + box.w], COORD_MIN, COORD_MAX), limit(sy, anchor[1], [box.y * ar, (box.y + box.h) * ar], COORD_MIN * ar, COORD_MAX * ar)];
}

function layerFor(kind: InkItemKind, tool: InkPenTool | null): InkItem['layer'] {
  if (kind === 'image') return 'media';
  if (kind === 'text' || kind === 'sticky' || kind === 'link') return 'text';
  return tool === 'highlighter' ? 'highlight' : 'ink';
}

interface BaseInput {
  id: string;
  anchor: AnnotationAnchor;
  now: number;
  z: number;
}

function base(kind: InkItemKind, tool: string | null, data: InkItem['data'], b: BaseInput, input: InkItem['input'] = null): InkItem {
  return {
    id: b.id,
    kind,
    tool,
    anchor: b.anchor,
    data,
    layer: layerFor(kind, (tool as InkPenTool) ?? null),
    z: Math.round(b.z),
    locked: false,
    anchor_status: 'ok',
    previous_anchor: null,
    input,
    device_id: null,
    rev: 0,
    created_at: b.now,
    updated_at: b.now,
    deleted_at: null,
  };
}

export function makeInkItem(
  b: BaseInput & { style: InkStyle; points: InkPoint[]; pressureAvailable: boolean; tiltAvailable: boolean; pointerType: string },
): InkItemOf<InkData> {
  const points = b.points.map(roundPoint);
  const data: InkData = {
    v: 1,
    points,
    style: b.style,
    bbox: roundBox(bboxOf(points)),
    pressure_available: b.pressureAvailable,
    tilt_available: b.tiltAvailable,
  };
  return base('ink', b.style.tool, data, b, { pointer_type: b.pointerType, pressure: b.pressureAvailable, tilt: b.tiltAvailable }) as InkItemOf<InkData>;
}

export function makeShapeItem(
  b: BaseInput & {
    shape: ShapeData['shape'];
    from: Vec;
    to: Vec;
    rotation?: number;
    style: InkStyle;
    recognizedFrom?: InkData;
    pointerType?: string;
    /** (N1 wave 2) fill, corner, head, route, attachments, polygon corners, control point … (rounded like the rest) */
    extra?: Partial<Omit<ShapeData, 'v' | 'shape' | 'from' | 'to' | 'rotation' | 'style' | 'recognized_from'>>;
  },
): InkItemOf<ShapeData> {
  const data: ShapeData = {
    v: 1,
    shape: b.shape,
    from: [coord(b.from[0]), coord(b.from[1])],
    to: [coord(b.to[0]), coord(b.to[1])],
    ...(b.rotation ? { rotation: roundTo(b.rotation, 6) } : {}),
    style: b.style,
    ...(b.recognizedFrom ? { recognized_from: b.recognizedFrom } : {}),
  };
  if (b.extra) Object.assign(data, roundShapeExtra(b.extra));
  return base('shape', b.shape, data, b, b.pointerType ? { pointer_type: b.pointerType } : null) as InkItemOf<ShapeData>;
}

/** (N1 wave 2) The optional shape fields with their coordinates on the stored grid (undefined fields are left out). */
function roundShapeExtra(x: Partial<ShapeData>): Partial<ShapeData> {
  const out: Partial<ShapeData> = {};
  for (const [k, v] of Object.entries(x) as Array<[keyof ShapeData, unknown]>) {
    if (v === undefined || v === null) continue;
    if (k === 'points') out.points = (v as Array<[number, number]>).map((p) => [coord(p[0]), coord(p[1])]);
    else if (k === 'control') out.control = [coord((v as [number, number])[0]), coord((v as [number, number])[1])];
    else if (k === 'corner' || k === 'label_scale') (out as Record<string, unknown>)[k] = roundTo(v as number, 6);
    else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** (N1 wave 2) A closed shape: it can be filled, labelled and connected. */
export function isClosedShape(i: InkItem): i is InkItemOf<ShapeData> {
  return isShape(i) && (CLOSED_SHAPES as readonly string[]).includes(i.data.shape);
}
/** (N1 wave 2) A shape that runs from one end to the other (a line, an arrow, a connector). */
export function isLineShape(i: InkItem): i is InkItemOf<ShapeData> {
  return isShape(i) && !(CLOSED_SHAPES as readonly string[]).includes(i.data.shape);
}

export function makeTextItem(b: BaseInput & { box: NormBox; text: TextBoxData['text']; color: string; fontScale: number }): InkItemOf<TextBoxData> {
  const data: TextBoxData = { v: 1, box: roundBox(b.box), text: b.text, color: b.color, font_scale: roundTo(b.fontScale, 6) };
  return base('text', 'text', data, b) as InkItemOf<TextBoxData>;
}

export function makeStickyItem(b: BaseInput & { at: Vec; text: string; color: string }): InkItemOf<StickyData> {
  const data: StickyData = { v: 1, at: [coord(b.at[0]), coord(b.at[1])], text: b.text, color: b.color, collapsed: false };
  return base('sticky', 'sticky', data, b) as InkItemOf<StickyData>;
}

export function makeImageItem(b: BaseInput & { data: ImageAnnotationData }): InkItemOf<ImageAnnotationData> {
  const data: ImageAnnotationData = { ...b.data, box: roundBox(b.data.box) };
  return base('image', 'image', data, b) as InkItemOf<ImageAnnotationData>;
}

export function makeLinkItem(b: BaseInput & { box: NormBox; target: LinkData['target']; label?: string | null; targetLabel?: string | null }): InkItemOf<LinkData> {
  const data: LinkData = { v: 1, box: roundBox(b.box), target: b.target, label: b.label ?? null, target_label: b.targetLabel ?? null };
  return base('link', 'link', data, b) as InkItemOf<LinkData>;
}

// ─── geometry per item (iso space), cached by object identity ───────────────────────────────
export interface ItemGeometry {
  /** polylines in iso units */
  lines: Vec[][];
  /** half of the widest stroke width (iso) — hit tolerance */
  halfWidth: number;
  /** filled area to hit-test (text boxes, sticky notes), iso polygon */
  area?: Vec[];
}

const geomCache = new WeakMap<InkItem, { ar: number; g: ItemGeometry }>();

/** The outline polylines of a shape (iso): the shared geometry (`shapeParts`), the same the PDF export draws. */
export function shapeOutline(d: ShapeData, ar: number): Vec[][] {
  return shapeOutlineIso(d, ar);
}

export function arrowHeadLength(shaftLength: number, width: number): number {
  return shapeArrowHeadLength(shaftLength, width);
}

export function itemGeometry(item: InkItem, ar: number): ItemGeometry {
  const hit = geomCache.get(item);
  if (hit && hit.ar === ar) return hit.g;
  let g: ItemGeometry;
  if (isInkStroke(item)) {
    const d = item.data;
    g = {
      lines: [d.points.map((p) => [p[0], p[1] * ar] as Vec)],
      halfWidth: (d.style.width * (d.pressure_available ? maxWidthFactor(d.style.tool) : 1)) / 2,
    };
  } else if (isShape(item)) {
    const lines = shapeOutline(item.data, ar);
    // (N1 wave 2) a filled or labelled closed shape is hit anywhere inside it (a tap on its label selects it)
    const inside = isClosedShape(item) && (!!item.data.fill || !!item.data.label) ? lines[0] : undefined;
    g = { lines, halfWidth: item.data.style.width / 2, ...(inside ? { area: inside } : {}) };
  } else if (isBoxItem(item)) {
    const d = item.data as { box: NormBox; rotation?: number };
    const poly = boxCorners(d.box, d.rotation ?? 0, ar);
    g = { lines: [[...poly, poly[0]!]], halfWidth: 0, area: poly };
  } else if (isSticky(item)) {
    const [x, y] = item.data.at;
    const r = STICKY_HIT_RADIUS;
    const poly: Vec[] = [
      [x - r, y * ar - r],
      [x + r, y * ar - r],
      [x + r, y * ar + r],
      [x - r, y * ar + r],
    ];
    g = { lines: [[...poly, poly[0]!]], halfWidth: 0, area: poly };
  } else if (isTextHighlight(item)) {
    // the middle line of each highlighted line of text, as thick as the line: an eraser crossing the highlight hits it
    const rects = Array.isArray(item.data.rects) ? item.data.rects : [];
    let half = 0;
    const lines: Vec[][] = [];
    for (const r of rects) {
      const cy = (r.y + r.h / 2) * ar;
      lines.push([
        [r.x, cy],
        [r.x + r.w, cy],
      ]);
      half = Math.max(half, (r.h * ar) / 2);
    }
    g = { lines, halfWidth: half };
  } else {
    // (N1 Wave 0) a kind registered by another track measures itself
    const spec = isBuiltInKind(item.kind) ? undefined : inkKind(item.kind);
    g = spec?.geometry ? spec.geometry(item, ar) : { lines: [], halfWidth: 0 };
  }
  geomCache.set(item, { ar, g });
  return g;
}

/**
 * (N1, G19) The four corners (iso units, clockwise from the top-left) of a box rotated by `rotation` radians
 * (clockwise, page space) about its centre.
 */
export function boxCorners(b: NormBox, rotation: number, ar: number): Vec[] {
  const cx = b.x + b.w / 2;
  const cy = (b.y + b.h / 2) * ar;
  const hx = b.w / 2;
  const hy = (b.h * ar) / 2;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const place = (u: number, v: number): Vec => [cx + u * c - v * s, cy + u * s + v * c];
  return [place(-hx, -hy), place(hx, -hy), place(hx, hy), place(-hx, hy)];
}

/** Axis-aligned bounds (norm) of a rotated box; the box itself when it is not rotated. */
export function rotatedBoxBounds(b: NormBox, rotation: number, ar: number): NormBox {
  if (!rotation) return { ...b };
  const pts = boxCorners(b, rotation, ar).map((p): Vec => [p[0], p[1] / ar]);
  return bboxOf(pts);
}

/** Normalized bounding box including the stroke width (for the spatial index and dirty rects). */
export function itemBBox(item: InkItem, ar: number): NormBox {
  if (isBoxItem(item)) return rotatedBoxBounds((item.data as { box: NormBox; rotation?: number }).box, (item.data as { rotation?: number }).rotation ?? 0, ar);
  if (!isBuiltInKind(item.kind)) {
    const spec = inkKind(item.kind);
    if (spec?.bounds) return spec.bounds(item, ar);
  }
  const g = itemGeometry(item, ar);
  if (g.lines.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const all: Vec[] = [];
  for (const l of g.lines) for (const p of l) all.push([p[0], p[1] / ar]);
  const b = bboxOf(all);
  return expandBox(b, g.halfWidth, g.halfWidth / ar);
}

/** Points used to decide lasso membership (norm). */
export function lassoSamplePoints(item: InkItem, ar: number): Vec[] {
  if (isBoxItem(item)) {
    const b = (item.data as { box: NormBox }).box;
    return [[b.x + b.w / 2, b.y + b.h / 2]];
  }
  if (isSticky(item)) return [[item.data.at[0], item.data.at[1]]];
  const g = itemGeometry(item, ar);
  const out: Vec[] = [];
  for (const l of g.lines) {
    const step = Math.max(1, Math.floor(l.length / 64));
    for (let i = 0; i < l.length; i += step) out.push([l[i]![0], l[i]![1] / ar]);
    const last = l[l.length - 1];
    if (last) out.push([last[0], last[1] / ar]);
  }
  return out;
}

// ─── edits (pure; return NEW objects so caches and history stay valid) ───────────────────────
function touched<T extends InkItem>(item: T, data: T['data'], now: number): T {
  return { ...item, data, updated_at: now };
}

function mapIso(m: Mat, x: number, y: number, ar: number): Vec {
  const [X, Y] = applyMat(m, x, y * ar);
  return [X, Y / ar];
}

function transformInkData(d: InkData, m: Mat, ar: number): InkData {
  const s = uniformScaleOf(m);
  const points = d.points.map((p) => {
    const [x, y] = mapIso(m, p[0], p[1], ar);
    const q = p.slice() as number[];
    q[0] = x;
    q[1] = y;
    return roundPoint(q as unknown as InkPoint);
  });
  return { ...d, points, bbox: roundBox(bboxOf(points)), style: { ...d.style, width: clampWidth(d.style.width * s) } };
}

export function clampWidth(w: number): number {
  return roundTo(Math.min(0.2, Math.max(0.0003, w)), 6);
}

/** A translate / uniform scale / rotate transform (no stretch). */
export function isSimilarity(m: Mat, eps = 1e-9): boolean {
  return Math.abs(m[0] - m[3]) <= eps && Math.abs(m[1] + m[2]) <= eps;
}

/**
 * (N1, G19) Can this item be stretched (a free resize: different scales across and down)? Shapes that are not rotated,
 * text boxes that are not rotated, strokes and sticky notes can; pictures and links keep their proportions.
 */
export function canStretch(item: InkItem): boolean {
  if (isInkStroke(item) || isSticky(item)) return true;
  if (isShape(item)) return !(BOX_SHAPES as readonly string[]).includes(item.data.shape) || !item.data.rotation;
  if (isTextBox(item)) return !item.data.rotation;
  return false;
}

/**
 * Apply an iso-space transform: a similarity (translate / uniform scale / rotate), or (N1, G19) an axis-aligned stretch
 * (scale across ≠ scale down, no rotation) for items that `canStretch`; a picture or link given a stretch keeps its
 * proportions (uniform scale about its centre).
 */
export function transformItem(item: InkItem, m: Mat, ar: number, now: number): InkItem {
  const s = uniformScaleOf(m);
  const stretch = !isSimilarity(m);
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  if (isInkStroke(item)) return touched(item, transformInkData(item.data, m, ar), now);
  if (isShape(item)) {
    const d = item.data;
    let from: Vec;
    let to: Vec;
    let rotation = d.rotation ?? 0;
    const moved: Partial<ShapeData> = {};
    if (!(BOX_SHAPES as readonly string[]).includes(d.shape)) {
      // lines, arrows, connectors and polygons: every stored point goes through the transform (a stretch included)
      from = mapIso(m, d.from[0], d.from[1], ar);
      to = mapIso(m, d.to[0], d.to[1], ar);
      if (d.control) {
        const c = mapIso(m, d.control[0], d.control[1], ar);
        moved.control = [coord(c[0]), coord(c[1])];
      }
      if (d.points?.length) {
        const pts = d.points.map((p) => mapIso(m, p[0], p[1], ar));
        moved.points = pts.map((p) => [coord(p[0]), coord(p[1])]);
        const bb = bboxOf(pts);
        from = [bb.x, bb.y];
        to = [bb.x + bb.w, bb.y + bb.h];
      }
    } else {
      const cx = (d.from[0] + d.to[0]) / 2;
      const cy = (d.from[1] + d.to[1]) / 2;
      const hx = (Math.abs(d.to[0] - d.from[0]) / 2) * (stretch ? sx : s);
      const hy = ((Math.abs(d.to[1] - d.from[1]) * ar) / 2) * (stretch ? sy : s);
      const [ncx, ncyIso] = applyMat(m, cx, cy * ar);
      from = [ncx - hx, (ncyIso - hy) / ar];
      to = [ncx + hx, (ncyIso + hy) / ar];
      if (!stretch) rotation = normalizeAngle(rotation + rotationOf(m));
    }
    // (N1 wave 2) rounded corners and the label scale with the shape
    if (d.corner) moved.corner = roundTo(Math.min(0.2, Math.max(1e-5, d.corner * (stretch ? Math.min(sx, sy) : s))), 6);
    if (d.label_scale && !stretch) moved.label_scale = roundTo(Math.min(0.1, Math.max(0.004, d.label_scale * s)), 6);
    const data: ShapeData = {
      ...d,
      from: [coord(from[0]), coord(from[1])],
      to: [coord(to[0]), coord(to[1])],
      style: { ...d.style, width: clampWidth(d.style.width * s) },
      ...(d.recognized_from ? { recognized_from: transformInkData(d.recognized_from, m, ar) } : {}),
      ...moved,
    };
    if (Math.abs(rotation) > 1e-9) data.rotation = roundTo(rotation, 6);
    else delete data.rotation;
    return touched(item, data, now);
  }
  if (isTextBox(item)) {
    // (N1, G19) a text box turns with the selection: its rotation is kept in page space (AC-21)
    const b = item.data.box;
    const [cx, cy] = mapIso(m, b.x + b.w / 2, b.y + b.h / 2, ar);
    if (stretch && !item.data.rotation) {
      // a free resize changes the box; the letters keep their size (the text re-wraps in the new box)
      const w = b.w * sx;
      const h = b.h * sy;
      return touched(item, { ...item.data, box: roundBox({ x: cx - w / 2, y: cy - h / 2, w, h }) }, now);
    }
    const w = b.w * s;
    const h = b.h * s;
    const data: TextBoxData = { ...item.data, box: roundBox({ x: cx - w / 2, y: cy - h / 2, w, h }), font_scale: roundTo(item.data.font_scale * s, 6) };
    if (!stretch) setRotation(data, (item.data.rotation ?? 0) + rotationOf(m));
    return touched(item, data, now);
  }
  if (isImage(item)) {
    // moved and resized as a whole (aspect kept: uniform scale about its centre); (N1, G19) and turned with the selection
    const b = item.data.box;
    const [cx, cy] = mapIso(m, b.x + b.w / 2, b.y + b.h / 2, ar);
    const w = b.w * s;
    const h = b.h * s;
    const data: ImageAnnotationData = { ...item.data, box: roundBox({ x: cx - w / 2, y: cy - h / 2, w, h }) };
    if (!stretch) setRotation(data, (item.data.rotation ?? 0) + rotationOf(m));
    return touched(item, data, now);
  }
  if (isLink(item)) {
    // a page link stays upright: a rotation moves its centre only
    const b = item.data.box;
    const [cx, cy] = mapIso(m, b.x + b.w / 2, b.y + b.h / 2, ar);
    const w = b.w * s;
    const h = b.h * s;
    return touched(item as InkItemOf<LinkData>, { ...(item.data as LinkData), box: roundBox({ x: cx - w / 2, y: cy - h / 2, w, h }) }, now);
  }
  if (isSticky(item)) {
    const [x, y] = mapIso(m, item.data.at[0], item.data.at[1], ar);
    return touched(item, { ...item.data, at: [coord(x), coord(y)] }, now);
  }
  // (N1 Wave 0) a kind registered by another track moves itself (or stays where it is)
  const spec = isBuiltInKind(item.kind) ? undefined : inkKind(item.kind);
  return spec?.transform ? spec.transform(item, m, ar, now) : item;
}

/** Stores a rotation (radians, normalized to (−π, π]); a rotation of ~0 is removed (the item stays as before N1). */
function setRotation(data: { rotation?: number }, angle: number): void {
  const r = normalizeAngle(angle);
  if (Math.abs(r) > 1e-9) data.rotation = roundTo(r, 6);
  else delete data.rotation;
}

function normalizeAngle(a: number): number {
  const t = Math.PI * 2;
  let r = a % t;
  if (r > Math.PI) r -= t;
  if (r <= -Math.PI) r += t;
  return r;
}

/** A style with a new colour and (N1, G03) the meaning of the slot it came from (`null` removes the old meaning). */
function restyle(style: InkStyle, color: string, meaning: string | null | undefined): InkStyle {
  const next: InkStyle = { ...style, color };
  if (meaning === undefined) return next;
  if (meaning) next.meaning = meaning;
  else delete next.meaning;
  return next;
}

/** `meaning` (N1): undefined keeps the item's meaning, null removes it, a string sets it (strokes and shapes). */
export function recolorItem(item: InkItem, color: string, now: number, meaning?: string | null): InkItem {
  if (isInkStroke(item)) return touched(item, { ...item.data, style: restyle(item.data.style, color, meaning) }, now);
  if (isShape(item)) return touched(item, { ...item.data, style: restyle(item.data.style, color, meaning) }, now);
  if (isTextBox(item)) return touched(item, { ...item.data, color }, now);
  if (isSticky(item)) return touched(item, { ...item.data, color }, now);
  return item;
}

export function rewidthItem(item: InkItem, width: number, now: number): InkItem {
  if (isInkStroke(item)) return touched(item, { ...item.data, style: { ...item.data.style, width: clampWidth(width) } }, now);
  if (isShape(item)) return touched(item, { ...item.data, style: { ...item.data.style, width: clampWidth(width) } }, now);
  return item;
}

export function withLock(item: InkItem, locked: boolean, now: number): InkItem {
  return { ...item, locked, updated_at: now };
}

export function withZ(item: InkItem, z: number, now: number): InkItem {
  return { ...item, z: Math.round(z), updated_at: now };
}

/** A copy with a new id on (possibly) another page. Server-side identity fields are reset. */
export function cloneItem(item: InkItem, id: string, anchor: AnnotationAnchor, now: number, z: number): InkItem {
  return {
    ...item,
    id,
    anchor,
    z: Math.round(z),
    locked: false,
    anchor_status: 'ok',
    previous_anchor: null,
    device_id: null,
    rev: 0,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

// ─── IndexedDB rows ⇄ items ⇄ sync payloads ──────────────────────────────────────────────────
export interface InkRow extends AnnotationRow {
  previousAnchor?: unknown;
  deviceId?: string | null;
  /** (P1-T2) who wrote it (null/absent = the vault's user), the item a copy came from, how the row came to exist */
  authorUserId?: string | null;
  migratedFromId?: string | null;
  origin?: string;
}

export function rowFromItem(item: InkItem, extra: Pick<AnnotationRow, 'syncState' | 'updatedAt'> & { rev?: number | null }): InkRow {
  return {
    id: item.id,
    targetKey: annotationTargetKey(item.anchor),
    kind: item.kind,
    tool: item.tool,
    anchor: item.anchor,
    data: item.data,
    layer: item.layer,
    z: item.z,
    locked: item.locked,
    anchorStatus: item.anchor_status,
    previousAnchor: item.previous_anchor,
    input: item.input,
    deviceId: item.device_id,
    rev: extra.rev ?? (item.rev > 0 ? item.rev : null),
    createdAt: item.created_at,
    updatedAt: extra.updatedAt,
    deletedAt: item.deleted_at,
    syncState: extra.syncState,
    // (P1-T2) authorship layer: absent = the default personal layer; only stored when the item names one
    ...(item.layer_id !== undefined ? { layerId: item.layer_id } : {}),
    ...(item.author_user_id ? { authorUserId: item.author_user_id } : {}),
    ...(item.migrated_from_id ? { migratedFromId: item.migrated_from_id } : {}),
    ...(item.origin && item.origin !== 'device' ? { origin: item.origin } : {}),
  };
}

export function itemFromRow(row: AnnotationRow): InkItem {
  const r = row as InkRow;
  return {
    id: r.id,
    kind: r.kind as InkItem['kind'],
    tool: r.tool ?? null,
    anchor: r.anchor as AnnotationAnchor,
    data: r.data as InkItem['data'],
    layer: r.layer ?? 'ink',
    z: r.z ?? 0,
    locked: !!r.locked,
    anchor_status: r.anchorStatus ?? 'ok',
    previous_anchor: (r.previousAnchor as AnnotationAnchor | null | undefined) ?? null,
    input: (r.input as InkItem['input']) ?? null,
    device_id: r.deviceId ?? null,
    rev: r.rev ?? 0,
    created_at: r.createdAt ?? r.updatedAt,
    updated_at: r.updatedAt,
    deleted_at: r.deletedAt ?? null,
    ...(r.layerId !== undefined ? { layer_id: r.layerId } : {}),
    ...(r.authorUserId ? { author_user_id: r.authorUserId } : {}),
    ...(r.migratedFromId ? { migrated_from_id: r.migratedFromId } : {}),
    ...(r.origin && r.origin !== 'device' ? { origin: r.origin as InkItem['origin'] } : {}),
  };
}

/** A server entity (pull / push answer) as the engine keeps it: packed ink points decoded to v1. */
export function itemFromWire(dto: InkItem): InkItem {
  const data = inkFromWire(dto.kind, dto.data);
  return data === dto.data ? dto : { ...dto, data };
}

/** Sync payload for append/upsert: the full current state in the AnnotationDTO shape (never a patch). */
export function payloadFromItem(item: InkItem): Record<string, unknown> {
  return {
    id: item.id,
    kind: item.kind,
    tool: item.tool,
    anchor: item.anchor,
    // (P1-T2) packed points (v2) once the server has shown it speaks v2; v1 otherwise
    data: inkToWire(item.kind, item.data),
    layer: item.layer,
    z: item.z,
    locked: item.locked,
    anchor_status: item.anchor_status,
    previous_anchor: item.previous_anchor,
    input: item.input,
    created_at: item.created_at,
    // (P1-T2) the item's layer (absent: an older row → the server keeps the item's layer; new writing names it)
    ...(item.layer_id !== undefined ? { layer_id: item.layer_id } : {}),
  };
}

/**
 * «إلغاء تحسين الشكل»: a recognized shape becomes the exact stroke the owner wrote again (same id,
 * so it is one upsert and one undo step). Returns null when the shape was drawn as a shape.
 */
export function revertEnhancement(item: InkItem, now: number): InkItem | null {
  if (!isShape(item) || !item.data.recognized_from) return null;
  const orig = item.data.recognized_from;
  return {
    ...item,
    kind: 'ink',
    tool: orig.style.tool,
    layer: orig.style.tool === 'highlighter' ? 'highlight' : 'ink',
    data: orig,
    input: item.input,
    updated_at: now,
  };
}
