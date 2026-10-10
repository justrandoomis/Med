// Ink items in memory = the AnnotationDTO wire shape (@medlevo/shared/annotations), so what the
// engine holds, what it writes to the outbox and what the server returns are the same object.
// Rows in IndexedDB use the camelCase AnnotationRow of lib/localdb.ts (converted here).
import {
  annotationTargetKey,
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
import { applyMat, bboxOf, expandBox, maxWidthFactor, roundTo, rotationOf, uniformScaleOf, type Mat, type Vec } from './math';

export type InkItem = AnnotationDTO;
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
/** Items this engine renders (other kinds — text_highlight, bookmark … — belong to the reader). */
export function isEngineItem(i: InkItem): boolean {
  return (INK_ITEM_KINDS as readonly string[]).includes(i.kind);
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

export function roundPoint(p: InkPoint): InkPoint {
  const out: number[] = [coord(p[0]), coord(p[1]), Math.round(p[2])];
  if (p.length > 3 && p[3] != null) out.push(roundTo(p[3], 3));
  if (p.length > 4 && p[4] != null && p[5] != null) out.push(Math.round(p[4]), Math.round(p[5]));
  return out as unknown as InkPoint;
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
  b: BaseInput & { shape: ShapeData['shape']; from: Vec; to: Vec; rotation?: number; style: InkStyle; recognizedFrom?: InkData; pointerType?: string },
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
  return base('shape', b.shape, data, b, b.pointerType ? { pointer_type: b.pointerType } : null) as InkItemOf<ShapeData>;
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

export function shapeOutline(d: ShapeData, ar: number): Vec[][] {
  const f: Vec = [d.from[0], d.from[1] * ar];
  const t: Vec = [d.to[0], d.to[1] * ar];
  if (d.shape === 'line') return [[f, t]];
  if (d.shape === 'arrow') {
    const len = Math.hypot(t[0] - f[0], t[1] - f[1]);
    const head = arrowHeadLength(len, d.style.width);
    const ang = Math.atan2(t[1] - f[1], t[0] - f[0]);
    const spread = (28 * Math.PI) / 180;
    const h1: Vec = [t[0] - head * Math.cos(ang - spread), t[1] - head * Math.sin(ang - spread)];
    const h2: Vec = [t[0] - head * Math.cos(ang + spread), t[1] - head * Math.sin(ang + spread)];
    return [[f, t], [h1, t, h2]];
  }
  const cx = (f[0] + t[0]) / 2;
  const cy = (f[1] + t[1]) / 2;
  const hx = Math.abs(t[0] - f[0]) / 2;
  const hy = Math.abs(t[1] - f[1]) / 2;
  const rot = d.rotation ?? 0;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const place = (u: number, v: number): Vec => [cx + u * c - v * s, cy + u * s + v * c];
  if (d.shape === 'rect') {
    return [[place(-hx, -hy), place(hx, -hy), place(hx, hy), place(-hx, hy), place(-hx, -hy)]];
  }
  const n = 64;
  const pts: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(place(hx * Math.cos(a), hy * Math.sin(a)));
  }
  return [pts];
}

export function arrowHeadLength(shaftLength: number, width: number): number {
  return Math.min(shaftLength * 0.35, Math.max(width * 5, 0.018));
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
    g = { lines: shapeOutline(item.data, ar), halfWidth: item.data.style.width / 2 };
  } else if (isBoxItem(item)) {
    const b = (item.data as { box: NormBox }).box;
    const poly: Vec[] = [
      [b.x, b.y * ar],
      [b.x + b.w, b.y * ar],
      [b.x + b.w, (b.y + b.h) * ar],
      [b.x, (b.y + b.h) * ar],
    ];
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
  } else {
    g = { lines: [], halfWidth: 0 };
  }
  geomCache.set(item, { ar, g });
  return g;
}

/** Normalized bounding box including the stroke width (for the spatial index and dirty rects). */
export function itemBBox(item: InkItem, ar: number): NormBox {
  if (isBoxItem(item)) return { ...(item.data as { box: NormBox }).box };
  const g = itemGeometry(item, ar);
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

/** Apply an iso-space similarity transform (translate / uniform scale / rotate). */
export function transformItem(item: InkItem, m: Mat, ar: number, now: number): InkItem {
  const s = uniformScaleOf(m);
  if (isInkStroke(item)) return touched(item, transformInkData(item.data, m, ar), now);
  if (isShape(item)) {
    const d = item.data;
    let from: Vec;
    let to: Vec;
    let rotation = d.rotation ?? 0;
    if (d.shape === 'line' || d.shape === 'arrow') {
      from = mapIso(m, d.from[0], d.from[1], ar);
      to = mapIso(m, d.to[0], d.to[1], ar);
    } else {
      const cx = (d.from[0] + d.to[0]) / 2;
      const cy = (d.from[1] + d.to[1]) / 2;
      const hx = (Math.abs(d.to[0] - d.from[0]) / 2) * s;
      const hy = ((Math.abs(d.to[1] - d.from[1]) * ar) / 2) * s;
      const [ncx, ncyIso] = applyMat(m, cx, cy * ar);
      from = [ncx - hx, (ncyIso - hy) / ar];
      to = [ncx + hx, (ncyIso + hy) / ar];
      rotation = normalizeAngle(rotation + rotationOf(m));
    }
    const data: ShapeData = {
      ...d,
      from: [coord(from[0]), coord(from[1])],
      to: [coord(to[0]), coord(to[1])],
      style: { ...d.style, width: clampWidth(d.style.width * s) },
      ...(d.recognized_from ? { recognized_from: transformInkData(d.recognized_from, m, ar) } : {}),
    };
    if (Math.abs(rotation) > 1e-9) data.rotation = roundTo(rotation, 6);
    else delete data.rotation;
    return touched(item, data, now);
  }
  if (isTextBox(item)) {
    const b = item.data.box;
    const [cx, cy] = mapIso(m, b.x + b.w / 2, b.y + b.h / 2, ar);
    const w = b.w * s;
    const h = b.h * s;
    return touched(item, { ...item.data, box: roundBox({ x: cx - w / 2, y: cy - h / 2, w, h }), font_scale: roundTo(item.data.font_scale * s, 6) }, now);
  }
  if (isImage(item) || isLink(item)) {
    // moved and resized as a whole (aspect kept: uniform scale about its centre); a rotation moves its centre only
    const b = item.data.box;
    const [cx, cy] = mapIso(m, b.x + b.w / 2, b.y + b.h / 2, ar);
    const w = b.w * s;
    const h = b.h * s;
    const box = roundBox({ x: cx - w / 2, y: cy - h / 2, w, h });
    return isImage(item) ? touched(item, { ...item.data, box }, now) : touched(item as InkItemOf<LinkData>, { ...(item.data as LinkData), box }, now);
  }
  if (isSticky(item)) {
    const [x, y] = mapIso(m, item.data.at[0], item.data.at[1], ar);
    return touched(item, { ...item.data, at: [coord(x), coord(y)] }, now);
  }
  return item;
}

function normalizeAngle(a: number): number {
  const t = Math.PI * 2;
  let r = a % t;
  if (r > Math.PI) r -= t;
  if (r <= -Math.PI) r += t;
  return r;
}

export function recolorItem(item: InkItem, color: string, now: number): InkItem {
  if (isInkStroke(item)) return touched(item, { ...item.data, style: { ...item.data.style, color } }, now);
  if (isShape(item)) return touched(item, { ...item.data, style: { ...item.data.style, color } }, now);
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
  };
}

/** Sync payload for append/upsert: the full current state in the AnnotationDTO shape (never a patch). */
export function payloadFromItem(item: InkItem): Record<string, unknown> {
  return {
    id: item.id,
    kind: item.kind,
    tool: item.tool,
    anchor: item.anchor,
    data: item.data,
    layer: item.layer,
    z: item.z,
    locked: item.locked,
    anchor_status: item.anchor_status,
    previous_anchor: item.previous_anchor,
    input: item.input,
    created_at: item.created_at,
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
