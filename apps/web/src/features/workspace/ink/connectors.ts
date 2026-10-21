// Connectors and quick diagramming (parity N1 wave 2, G21) — pure logic, unit-tested.
//
// A connector is a line-like shape (line, arrow, double or curved arrow) whose ends are ATTACHED to an edge point of a
// closed shape (`attach.from` / `attach.to`: the shape's id and side n / e / s / w). When an attached shape moves, is
// resized or turned, its connectors follow in the SAME undo step (store.commit asks `followConnectors`), so an undo puts
// both back together and the attachments are never lost. A route can be straight, elbow (right angles, the bend is a
// control point) or curved (a control point).
//
// Medical graphs: a connector can carry a relation (causes / inhibits / treats / complicates — spoken, never an arrow
// glyph alone) and a node a Course Brain concept (`concept_id`). With both ends bound to concepts, the relation can be
// checked against the owner's knowledge map (a read, nothing is changed). N4 G48 («hide nodes» quiz) and N2 G35 read
// these fields.
import {
  CLOSED_SHAPES,
  CONNECTOR_RELATION_LABELS_AR,
  PATHWAY_HEAD_LABELS_AR,
  richTextToPlain,
  SHAPE_KIND_LABELS_AR,
  SHAPE_SIDES,
  shapeSidePoint,
  type ConnectorRelation,
  type ShapeAttach,
  type ShapeData,
  type ShapeSide,
  type StudyDiagramEdgeView,
  type StudyDiagramNodeView,
} from '@medlevo/shared';
import { layoutDiagram } from '../../studybook/diagrams/layout';
import type { ItemChange } from './history';
import type { Vec } from './math';
import { isShape, makeShapeItem, type InkItem, type InkItemOf } from './model';

type ShapeItem = InkItemOf<ShapeData>;

export function isClosed(d: ShapeData): boolean {
  return (CLOSED_SHAPES as readonly string[]).includes(d.shape);
}

export function isConnector(it: InkItem): it is ShapeItem {
  return isShape(it) && !!(it.data.attach?.from || it.data.attach?.to);
}

/**
 * Where a connector end attached to `side` of a shape sits: the side's mid point moved out by a small gap (iso units),
 * so the head drawn there — an inhibition bar ⊣ above all — is not lost in the shape's own outline.
 */
export const ATTACH_GAP = 0.006;
export function attachPoint(d: ShapeData, side: ShapeSide, ar: number): Vec | null {
  const p = shapeSidePoint(d, side, ar);
  if (!p) return null;
  const [ux, uy] = SIDE_DIR[side];
  const rot = d.shape === 'polygon' ? 0 : (d.rotation ?? 0);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [p[0] + (ux * c - uy * s) * ATTACH_GAP, p[1] + ((ux * s + uy * c) * ATTACH_GAP) / ar];
}

/** The edge point of a closed shape nearest to `p` (normalized), with its side and distance (iso). */
export function nearestSide(d: ShapeData, p: Vec, ar: number): { side: ShapeSide; at: Vec; dist: number } | null {
  let best: { side: ShapeSide; at: Vec; dist: number } | null = null;
  for (const side of SHAPE_SIDES) {
    const at = shapeSidePoint(d, side, ar);
    if (!at) return null;
    const dist = Math.hypot(at[0] - p[0], (at[1] - p[1]) * ar);
    if (!best || dist < best.dist) best = { side, at, dist };
  }
  return best;
}

/** Is `p` inside a closed shape's box (rotation ignored for the test: generous, as a finger is) or near its edge? */
function boxOf(d: ShapeData): { x0: number; y0: number; x1: number; y1: number } {
  const xs = d.points?.length ? d.points.map((q) => q[0]) : [d.from[0], d.to[0]];
  const ys = d.points?.length ? d.points.map((q) => q[1]) : [d.from[1], d.to[1]];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * The closed shape a connector end at `p` attaches to (topmost first): `p` inside its box or within `tolIso` of an edge
 * point. `candidates` are visible, editable shapes of the page in paint order.
 */
export function attachTarget(candidates: readonly InkItem[], p: Vec, ar: number, tolIso: number, exclude?: string): { item: ShapeItem; side: ShapeSide; at: Vec } | null {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const it = candidates[i]!;
    if (!isShape(it) || !isClosed(it.data) || it.id === exclude) continue;
    const ns = nearestSide(it.data, p, ar);
    if (!ns) continue;
    const b = boxOf(it.data);
    const inside = p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1;
    if (inside || ns.dist <= tolIso) return { item: it as ShapeItem, side: ns.side, at: attachPoint(it.data, ns.side, ar) ?? ns.at };
  }
  return null;
}

/**
 * The connector after its attached shapes moved: each attached end goes to its shape's edge point; a control point
 * (curve, elbow bend) moves with the middle of the ends. `get` returns a shape's current state. Unchanged → the same item.
 */
export function rerouteConnector(conn: ShapeItem, get: (id: string) => InkItem | undefined, ar: number, now: number): ShapeItem {
  const d = conn.data;
  const end = (a: ShapeAttach | undefined, cur: [number, number]): [number, number] => {
    if (!a) return cur;
    const target = get(a.id);
    if (!target || target.deleted_at || !isShape(target) || !isClosed(target.data)) return cur;
    const at = attachPoint(target.data, a.side, ar);
    return at ? [round5(at[0]), round5(at[1])] : cur;
  };
  const from = end(d.attach?.from, d.from);
  const to = end(d.attach?.to, d.to);
  if (from[0] === d.from[0] && from[1] === d.from[1] && to[0] === d.to[0] && to[1] === d.to[1]) return conn;
  const next: ShapeData = { ...d, from, to };
  if (d.control) {
    const mx = (from[0] + to[0] - d.from[0] - d.to[0]) / 2;
    const my = (from[1] + to[1] - d.from[1] - d.to[1]) / 2;
    next.control = [round5(d.control[0] + mx), round5(d.control[1] + my)];
  }
  return { ...conn, data: next, updated_at: now };
}

function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

/**
 * The connectors that must follow a commit: every connector of the page attached to a shape this commit changed (moved,
 * resized, turned, restyled …). Connectors already in the commit are re-routed in place (they were moved with the
 * selection; their attached ends still follow the shapes). Returns the changes to append (or replace).
 */
export function followConnectors(pageItems: ReadonlyMap<string, InkItem>, changes: readonly ItemChange[], targetKey: string, ar: number, now: number): ItemChange[] {
  const touched = new Map<string, InkItem | null>();
  for (const c of changes) if (c.targetKey === targetKey) touched.set(c.id, c.after);
  const movedShapes = [...touched.entries()].filter(([, after]) => after && isShape(after) && isClosed((after as ShapeItem).data)).map(([id]) => id);
  if (movedShapes.length === 0) return [];
  const moved = new Set(movedShapes);
  const get = (id: string) => (touched.has(id) ? (touched.get(id) ?? undefined) : pageItems.get(id));
  const out: ItemChange[] = [];
  for (const it of pageItems.values()) {
    if (!isConnector(it)) continue;
    const a = it.data.attach!;
    if (!(a.from && moved.has(a.from.id)) && !(a.to && moved.has(a.to.id))) continue;
    const base = touched.has(it.id) ? touched.get(it.id) : it;
    if (!base || !isShape(base)) continue;
    const next = rerouteConnector(base as ShapeItem, get, ar, now);
    if (next === base) continue;
    out.push({ id: it.id, targetKey, before: it, after: next });
  }
  return out;
}

/**
 * (review of N1 wave 2) A copy of a connector (paste, duplicate, «انسخ إلى طبقتي») is attached to the COPIES of its
 * shapes: `ids` maps each copied item's id to its copy's. An end whose shape was not copied with it is left free (its
 * point stays where it is) — otherwise moving the original shape would pull the copy away from the copied diagram.
 * Anything else is returned as it is.
 */
export function reattachCopy(item: InkItem, ids: ReadonlyMap<string, string>): InkItem {
  if (!isConnector(item)) return item;
  const a = item.data.attach!;
  const remap = (end: ShapeAttach | undefined): ShapeAttach | undefined => (end && ids.has(end.id) ? { id: ids.get(end.id)!, side: end.side } : undefined);
  const from = remap(a.from);
  const to = remap(a.to);
  const data: ShapeData = { ...item.data };
  if (from || to) data.attach = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  else delete data.attach;
  return { ...item, data };
}

/** The direction of a side (normalized offsets, before the shape's rotation). */
const SIDE_DIR: Record<ShapeSide, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
const OPPOSITE: Record<ShapeSide, ShapeSide> = { n: 's', s: 'n', e: 'w', w: 'e' };

/**
 * «أضف شكلًا متصلًا»: a copy of `node` (same kind, size and style, no label or concept) placed beside it on `side`, and
 * a connector (an arrow) from `side` of `node` to the facing side of the new shape. One commit, one undo step.
 */
export function connectedShapePlan(node: ShapeItem, side: ShapeSide, ar: number, now: number, ids: { shape: string; connector: string }, z: number): { shape: ShapeItem; connector: ShapeItem } {
  const d = node.data;
  const b = boxOf(d);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const gapX = Math.max(0.04, w * 0.6);
  const gapY = Math.max(0.03, h * 0.8);
  const [ux, uy] = SIDE_DIR[side];
  const dx = ux * (w + gapX);
  const dy = uy * (h + gapY);
  const extra: Partial<ShapeData> = {};
  if (d.fill) extra.fill = d.fill;
  if (d.corner) extra.corner = d.corner;
  if (d.points?.length) extra.points = d.points.map((q) => [q[0] + dx, q[1] + dy]);
  const shape = makeShapeItem({
    id: ids.shape,
    anchor: node.anchor,
    now,
    z,
    shape: d.shape,
    from: [d.from[0] + dx, d.from[1] + dy],
    to: [d.to[0] + dx, d.to[1] + dy],
    rotation: d.rotation,
    style: { tool: 'pen', color: d.style.color, width: d.style.width, ...(d.style.dash ? { dash: d.style.dash } : {}) },
    extra,
  });
  shape.layer_id = node.layer_id ?? null;
  const fromAt = attachPoint(d, side, ar)!;
  const toAt = attachPoint(shape.data, OPPOSITE[side], ar)!;
  const connector = makeShapeItem({
    id: ids.connector,
    anchor: node.anchor,
    now,
    z: z + 1,
    shape: 'arrow',
    from: fromAt,
    to: toAt,
    style: { tool: 'pen', color: d.style.color, width: d.style.width },
    extra: { attach: { from: { id: node.id, side }, to: { id: shape.id, side: OPPOSITE[side] } } },
  });
  connector.layer_id = node.layer_id ?? null;
  return { shape, connector };
}

/**
 * «رتّب تلقائيًا»: the selected nodes laid out as a flowchart (layered by the connectors between them, first branch at
 * the reading start — right in RTL), inside the area they occupy now (at least as tall as the layers need). Uses the
 * study diagrams' layout (web/features/studybook/diagrams/layout.ts). Returns the node moves; the connectors follow.
 */
export function autoLayoutPlan(nodes: readonly ShapeItem[], connectors: readonly ShapeItem[], ar: number, rtl: boolean, now: number): ItemChange[] {
  if (nodes.length < 2) return [];
  const ids = new Set(nodes.map((n) => n.id));
  const viewNodes = nodes.map((n) => ({ key: n.id, label: '', kind: 'step', order: null, time_label: null, statement: '', claim_ids: [], verification: 'linked' }) as unknown as StudyDiagramNodeView);
  const edges = connectors
    .filter((c) => c.data.attach?.from && c.data.attach?.to && ids.has(c.data.attach.from.id) && ids.has(c.data.attach.to.id))
    .map((c) => ({ from: c.data.attach!.from!.id, to: c.data.attach!.to!.id }) as unknown as StudyDiagramEdgeView);
  const layout = layoutDiagram('flowchart', viewNodes, edges, rtl);
  const boxes = nodes.map((n) => boxOf(n.data));
  const area = { x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)), x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)) };
  const maxH = Math.max(...boxes.map((b) => b.y1 - b.y0));
  const rowH = Math.max(maxH * 1.9, (area.y1 - area.y0) / Math.max(1, layout.layers.length));
  const width = Math.max(area.x1 - area.x0, 0.3);
  const out: ItemChange[] = [];
  nodes.forEach((n, i) => {
    const p = layout.nodes.get(n.id);
    if (!p) return;
    const b = boxes[i]!;
    const cx = area.x0 + (p.xPct / 100) * width;
    const cy = area.y0 + maxH / 2 + p.layer * rowH;
    const dx = cx - (b.x0 + b.x1) / 2;
    const dy = cy - (b.y0 + b.y1) / 2;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
    const d = n.data;
    const data: ShapeData = { ...d, from: [round5(d.from[0] + dx), round5(d.from[1] + dy)], to: [round5(d.to[0] + dx), round5(d.to[1] + dy)] };
    if (d.points?.length) data.points = d.points.map((q) => [round5(q[0] + dx), round5(q[1] + dy)]);
    out.push({ id: n.id, targetKey: '', before: n, after: { ...n, data, updated_at: now } });
  });
  return out;
}

// ── words for the owner and the screen reader ──
/** The name of a node: its label, else its concept, else its kind («مستطيل»). */
export function nodeName(d: ShapeData): string {
  const label = d.label ? richTextToPlain(d.label).trim() : '';
  return label || d.concept_name || SHAPE_KIND_LABELS_AR[d.shape];
}

/** «Insulin يسبّب GLUT4», «من A إلى B» when the connector has no relation — words, never a bare arrow glyph (AC-08). */
export function connectorSentence(conn: ShapeData, name: (id: string) => string | null): string {
  const from = conn.attach?.from ? (name(conn.attach.from.id) ?? 'شكل محذوف') : 'نقطة حرة';
  const to = conn.attach?.to ? (name(conn.attach.to.id) ?? 'شكل محذوف') : 'نقطة حرة';
  const verb = conn.relation ? CONNECTOR_RELATION_LABELS_AR[conn.relation] : conn.head ? PATHWAY_HEAD_LABELS_AR[conn.head] : null;
  return verb ? `«${from}» ${verb} «${to}»` : `من «${from}» إلى «${to}»`;
}

/** The Course Brain relation kind a connector relation is checked against (`inhibits` has none there). */
export const BRAIN_RELATION_OF: Record<ConnectorRelation, 'causes' | 'treats' | 'complication_of' | null> = { causes: 'causes', treats: 'treats', complicates: 'complication_of', inhibits: null };

export type RelationCheck =
  | { status: 'found'; support: 'stated' | 'inferred' }
  | { status: 'missing' }
  | { status: 'no_kind' }
  | { status: 'unbound' };

/**
 * Checks one connector against the knowledge map's relations of its source concept. Pure: `relations` are the Course
 * Brain relations of the source concept (GET /api/brain/relations?concept_id=…).
 */
export function checkRelation(conn: ShapeData, ends: { from: string | null; to: string | null }, relations: ReadonlyArray<{ from: { id: string }; to: { id: string }; relation: string; support: 'stated' | 'inferred'; status: string }>): RelationCheck {
  if (!ends.from || !ends.to || !conn.relation) return { status: 'unbound' };
  const kind = BRAIN_RELATION_OF[conn.relation];
  if (!kind) return { status: 'no_kind' };
  const hit = relations.find((r) => r.status !== 'rejected' && r.relation === kind && r.from.id === ends.from && r.to.id === ends.to);
  return hit ? { status: 'found', support: hit.support } : { status: 'missing' };
}

export const RELATION_CHECK_LABELS_AR: Record<RelationCheck['status'], string> = {
  found: 'موجودة في خريطة المعرفة',
  missing: 'غير موجودة في خريطة المعرفة (لا يعني أنها خطأ)',
  no_kind: 'لا يوجد في خريطة المعرفة نوع علاقة مماثل («يثبّط»)',
  unbound: 'اربط الطرفين بمفهومين واختر نوع العلاقة لتتحقق منها',
};
