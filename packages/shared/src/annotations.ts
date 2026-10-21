// Ink / annotation / note / session contract (§25, §26, §27, §47, AC-21, AC-22, AC-24).
// Shared by the web ink engine (writes to IndexedDB + outbox), the server annotations module
// (sync handlers + read APIs) and anything that renders annotations.
import type { NormBox } from './geometry';
import type { RichText } from './richtext';

/** [x, y, t, pressure?, tiltX?, tiltY?] — x,y normalized to the UNROTATED page box; t = ms since stroke start. */
export type InkPoint = [number, number, number, number?, number?, number?];

export const INK_TOOLS = ['pen', 'fountain', 'ball', 'highlighter'] as const;
export type InkPenTool = (typeof INK_TOOLS)[number];

export interface InkStyle {
  tool: InkPenTool;
  /** color token or #rrggbb */
  color: string;
  /** base stroke width as a fraction of the page WIDTH (zoom independent), e.g. 0.0025 */
  width: number;
  opacity?: number;
  /**
   * (parity N1, G03) what the owner's colour slot means («موانع استعمال»), copied onto the stroke when it is written:
   * read aloud with the colour (never colour alone) and usable as a «show only this meaning» filter. 1–60 characters,
   * no bidi control characters (AC-20).
   */
  meaning?: string;
  /**
   * (parity N1, G01) pen feel, saved WITH the stroke so every device draws it the same way. Absent = today's drawing:
   * smoothing radius 2, no pressure floor, no taper, width follows pressure when the pen reported it.
   */
  smoothing?: number;
  /** lowest pressure used for the width, 0–0.9 */
  pressure_floor?: number;
  /** thinning at the ends of the stroke */
  taper?: InkTaper;
  /** constant width even when the pen reported pressure */
  constant?: boolean;
  /**
   * (parity N1 wave 2, G04) the line pattern: dashes or dots, scaled to the stroke's width in page units (the same on
   * every zoom). Absent = a solid line (every stroke before wave 2).
   */
  dash?: InkDash;
  /**
   * (parity N1 wave 2, G06) the pencil: a graphite grain, and pressure changes the opacity as well as the width. Stored
   * with `tool: 'pen'` (the same points-only stroke), so an older app draws it as a pen line instead of failing.
   */
  texture?: InkTexture;
}

/** (parity N1 wave 2, G04) line patterns besides solid */
export const INK_DASHES = ['dash', 'dot'] as const;
export type InkDash = (typeof INK_DASHES)[number];
/** (parity N1 wave 2, G06) nib textures */
export const INK_TEXTURES = ['graphite'] as const;
export type InkTexture = (typeof INK_TEXTURES)[number];

/** (parity N1, G01) how a stroke's ends are drawn: 'none' = full width, 'round' = soft thinning, 'sharp' = to a point */
export const INK_TAPERS = ['none', 'round', 'sharp'] as const;
export type InkTaper = (typeof INK_TAPERS)[number];
/** (parity N1, G01) smoothing radius range of a stroke (samples on each side) */
export const INK_SMOOTHING_MAX = 6;
/** (parity N1, G03) longest meaning label of a colour slot / stroke */
export const INK_MEANING_MAX = 60;

export interface InkData {
  v: 1;
  points: InkPoint[];
  style: InkStyle;
  bbox: NormBox;
  /** what the input device actually reported (never assume) */
  pressure_available: boolean;
  tilt_available: boolean;
  /** (track F4) written while an in-app recording ran: tapping the stroke plays that moment */
  audio_link?: InkAudioLink;
}

/**
 * (Academic OS, P1-T2 step 2 — ADR-0004 §2.5) Ink data v2: the same stroke with its points packed
 * (`points_packed` = base64 of zigzag-delta varints, codec in `academic/ink-codec.ts`). Sent only to clients that
 * send `accept-ink: 2`, and accepted from them on push; the server stores and serves v1 to everyone else.
 */
export interface InkDataV2 extends Omit<InkData, 'v' | 'points'> {
  v: 2;
  points_packed: string;
}

/**
 * (track F4, §29) Time link of a pen stroke to an in-app recording: `offset_ms` from the start of the recording.
 * `auto` = set because the stroke was written while recording; `manual` = the owner changed it.
 */
export interface InkAudioLink {
  /** client id of the recording session (= the recording's id on the server once uploaded) */
  recording_id: string;
  offset_ms: number;
  origin: 'auto' | 'manual';
}

export interface ShapeData {
  v: 1;
  /**
   * (parity N1 wave 2, G20) triangle, polygon, curved and double arrows were added. An R1-a app draws them as an ellipse
   * in their frame and, if it MOVES one, keeps only the frame: a curved / double arrow comes out pointing down-right and
   * a polygon's corners stay behind (review of N1 wave 2, R10). Since the R1-b final verification the server refuses
   * that edit from an R1-a app and answers with its copy (annotations/sync.ts; docs/modules/ink.md).
   */
  shape: ShapeKind;
  /** normalized corners / endpoints (a polygon: the corners of its bounding box) */
  from: [number, number];
  to: [number, number];
  rotation?: number;
  style: InkStyle;
  /** when produced by shape recognition, the original stroke is kept so the owner can reject the enhancement */
  recognized_from?: InkData;
  /** (track F4) drawn while an in-app recording ran */
  audio_link?: InkAudioLink;
  // ── (parity N1 wave 2 — G20 shapes, G21 connectors; every field optional: a shape without them draws as before) ──
  /** inside colour of a closed shape (a colour token or #rrggbb), drawn translucent so writing under it stays readable */
  fill?: string;
  /** rounded corners of a rectangle: the radius as a fraction of the page width */
  corner?: number;
  /** text inside the shape (RichText: bidi-correct, terms and doses isolated) */
  label?: RichText;
  /** font size of the label as a fraction of the page width (absent = SHAPE_LABEL_SCALE) */
  label_scale?: number;
  /** a polygon's corners (normalized, unrotated page) */
  points?: Array<[number, number]>;
  /** a curved route's control point, or an elbow route's bend (its x) — normalized */
  control?: [number, number];
  /** physiology / pharmacology notation of the arrow head at `to`: activation →, inhibition ⊣, conversion ⇢ */
  head?: PathwayHead;
  /** (G21) how a connector runs between its ends (absent: straight; a curved arrow is always curved) */
  route?: ConnectorRoute;
  /** (G21) the shapes a connector is attached to (an edge point of each); it follows them when they move */
  attach?: { from?: ShapeAttach; to?: ShapeAttach };
  /** (G21) what the connection means (read aloud; checked against the Course Brain when both ends are concepts) */
  relation?: ConnectorRelation;
  /** (G21) a node bound to a Course Brain concept (`concept.id`) and its name when bound (display only) */
  concept_id?: string;
  concept_name?: string;
}

// ───────── (parity N1 wave 2) shapes, pathway notation and connectors ─────────
export const SHAPE_KINDS = ['line', 'arrow', 'rect', 'ellipse', 'triangle', 'polygon', 'curved_arrow', 'double_arrow'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
/** shapes kept as a box (from / to = corners of the unrotated box; rotation about its centre) */
export const BOX_SHAPES: readonly ShapeKind[] = ['rect', 'ellipse', 'triangle'];
/** shapes that run from one end to the other (connectors are these) */
export const LINE_SHAPES: readonly ShapeKind[] = ['line', 'arrow', 'curved_arrow', 'double_arrow'];
/** closed shapes (they can be filled, carry a label and be connected) */
export const CLOSED_SHAPES: readonly ShapeKind[] = ['rect', 'ellipse', 'triangle', 'polygon'];
export const SHAPE_KIND_LABELS_AR: Record<ShapeKind, string> = {
  line: 'خط مستقيم',
  arrow: 'سهم',
  rect: 'مستطيل',
  ellipse: 'شكل بيضاوي',
  triangle: 'مثلث',
  polygon: 'مضلّع',
  curved_arrow: 'سهم منحنٍ',
  double_arrow: 'سهم مزدوج',
};

/** pathway arrow heads (physiology / pharmacology) */
export const PATHWAY_HEADS = ['activation', 'inhibition', 'conversion'] as const;
export type PathwayHead = (typeof PATHWAY_HEADS)[number];
/** their spoken names (never the glyph alone: a bare arrow glyph inside RTL text can be shown pointing the wrong way) */
export const PATHWAY_HEAD_LABELS_AR: Record<PathwayHead, string> = { activation: 'ينشّط', inhibition: 'يثبّط', conversion: 'يتحوّل إلى' };

export const CONNECTOR_ROUTES = ['straight', 'elbow', 'curve'] as const;
export type ConnectorRoute = (typeof CONNECTOR_ROUTES)[number];
export const CONNECTOR_ROUTE_LABELS_AR: Record<ConnectorRoute, string> = { straight: 'مستقيم', elbow: 'بزوايا قائمة', curve: 'منحنٍ' };

/** medical relation types of a connector (N4 G48 and N2 G35 read them) */
export const CONNECTOR_RELATIONS = ['causes', 'inhibits', 'treats', 'complicates'] as const;
export type ConnectorRelation = (typeof CONNECTOR_RELATIONS)[number];
export const CONNECTOR_RELATION_LABELS_AR: Record<ConnectorRelation, string> = { causes: 'يسبّب', inhibits: 'يثبّط', treats: 'يعالج', complicates: 'يُعقّد (مضاعفة لـ)' };

/** the edge points of a shape a connector can attach to: top, right, bottom, left of its box (before its rotation) */
export const SHAPE_SIDES = ['n', 'e', 's', 'w'] as const;
export type ShapeSide = (typeof SHAPE_SIDES)[number];
export interface ShapeAttach {
  /** the shape's annotation id */
  id: string;
  side: ShapeSide;
}

/** most corners of a polygon */
export const SHAPE_POLYGON_MAX = 64;
/** default label size (fraction of the page width ≈ 10 pt on A4) */
export const SHAPE_LABEL_SCALE = 0.017;
/** longest label (characters) */
export const SHAPE_LABEL_MAX = 500;
/** largest corner radius (fraction of the page width) */
export const SHAPE_CORNER_MAX = 0.2;

type IsoVec = [number, number];

/** One drawn part of a shape, in «iso» units (x = normalized x, y = normalized y × page height / page width). */
export interface ShapePart {
  pts: IsoVec[];
  /** body: the outline or the shaft; head: an arrow head */
  role: 'body' | 'head';
  /** closed outline (fillable) */
  closed?: boolean;
  /** filled with the line colour (an activation head) */
  solid?: boolean;
  /** drawn dashed whatever the style (the shaft of a conversion arrow ⇢) */
  dashed?: boolean;
}

/** Length of an arrow head (iso units) for a shaft and a line width. */
export function shapeArrowHeadLength(shaftLength: number, width: number): number {
  return Math.min(shaftLength * 0.35, Math.max(width * 5, 0.018));
}

function quadPoint(a: IsoVec, c: IsoVec, b: IsoVec, t: number): IsoVec {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
}

/** The default control point of a curve: the middle pushed sideways by a quarter of the length (iso). */
export function defaultCurveControl(f: IsoVec, t: IsoVec): IsoVec {
  const mx = (f[0] + t[0]) / 2;
  const my = (f[1] + t[1]) / 2;
  const dx = t[0] - f[0];
  const dy = t[1] - f[1];
  return [mx - dy * 0.25, my + dx * 0.25];
}

/** The route of a line-like shape between its ends (iso). */
export function shapeRoute(d: ShapeData, ar: number): IsoVec[] {
  const f: IsoVec = [d.from[0], d.from[1] * ar];
  const t: IsoVec = [d.to[0], d.to[1] * ar];
  const route = d.shape === 'curved_arrow' ? 'curve' : (d.route ?? 'straight');
  if (route === 'curve') {
    const c: IsoVec = d.control ? [d.control[0], d.control[1] * ar] : defaultCurveControl(f, t);
    const out: IsoVec[] = [];
    for (let i = 0; i <= 24; i++) out.push(quadPoint(f, c, t, i / 24));
    return out;
  }
  if (route === 'elbow') {
    const bx = d.control ? d.control[0] : (f[0] + t[0]) / 2;
    return [f, [bx, f[1]], [bx, t[1]], t];
  }
  return [f, t];
}

function headParts(tip: IsoVec, from: IsoVec, size: number, head: PathwayHead | 'open'): ShapePart[] {
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  if (head === 'inhibition') {
    // ⊣: a bar across the end of the shaft
    const hw = size * 0.6;
    const px = -Math.sin(ang) * hw;
    const py = Math.cos(ang) * hw;
    return [{ pts: [[tip[0] + px, tip[1] + py], [tip[0] - px, tip[1] - py]], role: 'head' }];
  }
  const spread = (28 * Math.PI) / 180;
  const h1: IsoVec = [tip[0] - size * Math.cos(ang - spread), tip[1] - size * Math.sin(ang - spread)];
  const h2: IsoVec = [tip[0] - size * Math.cos(ang + spread), tip[1] - size * Math.sin(ang + spread)];
  if (head === 'activation') return [{ pts: [h1, tip, h2, h1], role: 'head', closed: true, solid: true }];
  return [{ pts: [h1, tip, h2], role: 'head' }];
}

/** A rounded rectangle's outline (iso), corners clockwise from the top-left; `r` is clamped to the box. */
function roundedBox(place: (u: number, v: number) => IsoVec, hx: number, hy: number, r: number): IsoVec[] {
  const rr = Math.max(0, Math.min(r, hx, hy));
  if (rr <= 1e-9) return [place(-hx, -hy), place(hx, -hy), place(hx, hy), place(-hx, hy), place(-hx, -hy)];
  const out: IsoVec[] = [];
  const corners: Array<[number, number, number]> = [
    [hx - rr, -hy + rr, -Math.PI / 2],
    [hx - rr, hy - rr, 0],
    [-hx + rr, hy - rr, Math.PI / 2],
    [-hx + rr, -hy + rr, Math.PI],
  ];
  for (const [cu, cv, a0] of corners) for (let i = 0; i <= 6; i++) {
    const a = a0 + (i / 6) * (Math.PI / 2);
    out.push(place(cu + rr * Math.cos(a), cv + rr * Math.sin(a)));
  }
  out.push(out[0]!);
  return out;
}

/**
 * (parity N1 wave 2) The drawn parts of a shape in iso units: its outline (or route) and its arrow heads. The web engine
 * draws and hit-tests these, and the server's PDF export draws the same outline. A line, arrow, rectangle or ellipse
 * without the wave-2 fields gives exactly the geometry it had before.
 */
export function shapeParts(d: ShapeData, ar: number): ShapePart[] {
  const shape = d.shape;
  if (shape === 'line' || shape === 'arrow' || shape === 'curved_arrow' || shape === 'double_arrow') {
    const route = shapeRoute(d, ar);
    const conversion = d.head === 'conversion' && shape !== 'line';
    const parts: ShapePart[] = [{ pts: route, role: 'body', ...(conversion ? { dashed: true } : {}) }];
    if (shape === 'line' && !d.head) return parts;
    const f = route[0]!;
    const t = route[route.length - 1]!;
    const len = Math.hypot(t[0] - f[0], t[1] - f[1]);
    const size = shapeArrowHeadLength(len, d.style.width);
    parts.push(...headParts(t, route[route.length - 2]!, size, d.head ?? 'open'));
    if (shape === 'double_arrow') parts.push(...headParts(f, route[1]!, size, 'open'));
    return parts;
  }
  if (shape === 'polygon' && Array.isArray(d.points) && d.points.length >= 3) {
    const pts = d.points.map((p): IsoVec => [p[0], p[1] * ar]);
    return [{ pts: [...pts, pts[0]!], role: 'body', closed: true }];
  }
  const f: IsoVec = [d.from[0], d.from[1] * ar];
  const t: IsoVec = [d.to[0], d.to[1] * ar];
  const cx = (f[0] + t[0]) / 2;
  const cy = (f[1] + t[1]) / 2;
  const hx = Math.abs(t[0] - f[0]) / 2;
  const hy = Math.abs(t[1] - f[1]) / 2;
  const rot = d.rotation ?? 0;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const place = (u: number, v: number): IsoVec => [cx + u * c - v * s, cy + u * s + v * c];
  if (shape === 'rect') {
    if (d.corner && d.corner > 0) return [{ pts: roundedBox(place, hx, hy, d.corner), role: 'body', closed: true }];
    return [{ pts: [place(-hx, -hy), place(hx, -hy), place(hx, hy), place(-hx, hy), place(-hx, -hy)], role: 'body', closed: true }];
  }
  if (shape === 'triangle') return [{ pts: [place(0, -hy), place(hx, hy), place(-hx, hy), place(0, -hy)], role: 'body', closed: true }];
  const n = 64;
  const pts: IsoVec[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(place(hx * Math.cos(a), hy * Math.sin(a)));
  }
  return [{ pts, role: 'body', closed: true }];
}

/** The outline polylines of a shape (iso): every part of `shapeParts`. */
export function shapeOutlineIso(d: ShapeData, ar: number): IsoVec[][] {
  return shapeParts(d, ar).map((p) => p.pts);
}

/**
 * (G21) The edge point of a shape on `side` (normalized): the middle of that side of its box, turned with the box. A
 * polygon uses its bounding box; a line-like shape has no edge points (null).
 */
export function shapeSidePoint(d: ShapeData, side: ShapeSide, ar: number): [number, number] | null {
  if (!(CLOSED_SHAPES as readonly string[]).includes(d.shape)) return null;
  let x0 = Math.min(d.from[0], d.to[0]);
  let x1 = Math.max(d.from[0], d.to[0]);
  let y0 = Math.min(d.from[1], d.to[1]);
  let y1 = Math.max(d.from[1], d.to[1]);
  if (d.shape === 'polygon' && Array.isArray(d.points) && d.points.length) {
    x0 = Math.min(...d.points.map((p) => p[0]));
    x1 = Math.max(...d.points.map((p) => p[0]));
    y0 = Math.min(...d.points.map((p) => p[1]));
    y1 = Math.max(...d.points.map((p) => p[1]));
  }
  const cx = (x0 + x1) / 2;
  const cy = ((y0 + y1) / 2) * ar;
  const hx = (x1 - x0) / 2;
  const hy = ((y1 - y0) / 2) * ar;
  const [u, v] = side === 'n' ? [0, -hy] : side === 's' ? [0, hy] : side === 'e' ? [hx, 0] : [-hx, 0];
  const rot = d.shape === 'polygon' ? 0 : (d.rotation ?? 0);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [cx + u * c - v * s, (cy + u * s + v * c) / ar];
}

export interface TextBoxData {
  v: 1;
  box: NormBox;
  text: RichText;
  color: string;
  font_scale: number;
  /**
   * (parity N1, G19) rotation about the box's centre in radians, clockwise, in page space (so it survives zoom and the
   * page's own rotation, AC-21). Absent = 0.
   */
  rotation?: number;
}

export interface StickyData {
  v: 1;
  at: [number, number];
  text: string;
  color: string;
  collapsed?: boolean;
}

export interface TextQuote {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface TextHighlightData {
  v: 1;
  style: 'highlight' | 'underline';
  color: string;
  /** visual rects on the page (normalized) */
  rects: NormBox[];
  quote: TextQuote;
  /** region ids the selection intersects, when known */
  region_ids?: string[];
}

export interface BookmarkData {
  v: 1;
  label?: string;
}

export type AnnotationKind = 'ink' | 'highlight' | 'underline' | 'shape' | 'text' | 'sticky' | 'image' | 'bookmark' | 'link' | 'text_highlight';

/**
 * (Academic OS, ARCHITECTURE_DELTA §4.3) how an annotation row came to exist: written on a device (every row before
 * this release), or copied by the server (`layer_copy` = «انسخ الطبقة», `reanchor_copy` = a note carried to a new
 * version; the follow / fork / publish copies arrive with the channels release).
 */
export const ANNOTATION_ORIGINS = ['device', 'crdt_projection', 'publish_copy', 'follow_copy', 'fork_copy', 'layer_copy', 'reanchor_copy'] as const;
export type AnnotationOrigin = (typeof ANNOTATION_ORIGINS)[number];

export type AnnotationAnchor =
  | { type: 'page'; source_id: string; version_id: string; page_id: string; page_index: number; space: 'page_norm' }
  | { type: 'note_page'; note_page_id: string; space: 'page_norm' }
  | { type: 'block'; lineage_id: string; artifact_version: number; block_key: string; quote?: TextQuote; start?: number; end?: number };

export function annotationTargetKey(anchor: AnnotationAnchor): string {
  switch (anchor.type) {
    case 'page':
      return `source_page:${anchor.page_id}`;
    case 'note_page':
      return `note_page:${anchor.note_page_id}`;
    case 'block':
      return `artifact_block:${anchor.lineage_id}:${anchor.block_key}`;
  }
}

/** Wire format of an annotation (sync payload for upsert/append, pull entity, read APIs). snake_case. */
export interface AnnotationDTO {
  id: string;
  kind: AnnotationKind;
  tool: string | null;
  anchor: AnnotationAnchor;
  data: InkData | ShapeData | TextBoxData | StickyData | TextHighlightData | BookmarkData | LinkData | ImageAnnotationData | Record<string, unknown>;
  layer: 'ink' | 'highlight' | 'text' | 'media';
  z: number;
  locked: boolean;
  anchor_status: 'ok' | 'needs_reanchor' | 'reanchored';
  previous_anchor: AnnotationAnchor | null;
  /** pointerType, pressure/tilt availability, device label — for the capability matrix, never PII */
  input: { pointer_type?: string; pressure?: boolean; tilt?: boolean } | null;
  device_id: string | null;
  rev: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  /** (H3 item 2) the owner chose to keep this item detached from any place (it stays listed, never deleted) */
  detached_at?: number | null;
  /**
   * (Academic OS, P1-T2) the authorship layer (`annotation_layer.id`). Absent or null = the default personal layer of
   * the document («ملاحظاتي»): every row written before layers existed, and every op of an older client.
   */
  layer_id?: string | null;
  /** (P1-T2) who wrote it; null in a vault = the vault's own user */
  author_user_id?: string | null;
  /** (P1-T2) the item a layer copy / re-anchor copy was made from (the original is never changed) */
  migrated_from_id?: string | null;
  /** (P1-T2) how the row came to exist (server-set; a client's value is ignored) */
  origin?: AnnotationOrigin;
}

export interface NoteDTO {
  id: string;
  node_id: string | null;
  title: string | null;
  body: RichText;
  anchor: AnnotationAnchor | null;
  origin: 'owner' | 'ai_answer' | 'handwriting_recognition';
  ai_record: Record<string, unknown> | null;
  rev: number;
  conflict_of_id: string | null;
  device_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  /** (H3 item 2) where the note was anchored before the owner re-anchored it */
  previous_anchor?: AnnotationAnchor | null;
  /** (H3 item 2) the owner chose to keep this note detached from any place */
  detached_at?: number | null;
  /** (P1-T2) the authorship layer; absent / null = the default personal layer of the document */
  layer_id?: string | null;
  /** (P1-T2) who wrote it; null in a vault = the vault's own user */
  author_user_id?: string | null;
  /** (P1-T2) the note a layer copy / re-anchor copy was made from */
  migrated_from_id?: string | null;
}

export interface NotePageDTO {
  id: string;
  node_id: string | null;
  source_id: string | null;
  after_page_index: number | null;
  title: string | null;
  template: 'blank' | 'ruled' | 'dotted' | 'grid';
  width: number;
  height: number;
  sort_order: number;
  rev: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** Where the owner was (§46 Study Session). */
export interface StudyLocation {
  page_index?: number;
  page_id?: string;
  block_key?: string;
  zoom?: number;
  /** scroll offset inside the page as a fraction [0,1] */
  page_offset?: number;
  rotation?: number;
  layout?: 'single' | 'double' | 'continuous';
  rail?: { open: boolean; width: number; tab: string };
  left_panel?: { open: boolean; tab: 'thumbnails' | 'outline' | 'bookmarks' | 'layers' };
  split?: { mode: string; secondary_source_id?: string; secondary_page_index?: number } | null;
  /**
   * (Academic OS, P1-T2 — ARCHITECTURE_DELTA §6.6) layers shown in THIS study session: the ids hidden here (the
   * default personal layer is `default_personal_layer`'s id) and the layer new writing goes to (null = «ملاحظاتي»).
   * Absent = every layer as its own `visible` default says.
   */
  layers?: { hidden?: string[]; active?: string | null };
}

export interface StudySessionDTO {
  id: string;
  source_id: string | null;
  version_id: string | null;
  mode: 'learn' | 'understand' | 'practice' | 'review' | 'exam';
  view: 'original' | 'study_book' | 'split';
  location: StudyLocation;
  scope: unknown | null;
  device_id: string | null;
  rev: number;
  created_at: number;
  updated_at: number;
}

/** Entity types synced through /api/sync for this contract. */
export const ANNOTATION_SYNC_ENTITIES = ['annotation', 'note', 'note_page', 'study_session'] as const;

// ───────── Notebook pages, page links and images (§26, §25, §5 — track F1) ─────────

/** Paper templates of a note page (subtle, token-based, never reducing contrast). */
export const NOTE_PAGE_TEMPLATES = ['blank', 'ruled', 'dotted', 'grid'] as const;
export type NotePageTemplate = (typeof NOTE_PAGE_TEMPLATES)[number];
export const NOTE_PAGE_TEMPLATE_LABELS_AR: Record<NotePageTemplate, string> = {
  blank: 'فارغة',
  ruled: 'مسطّرة',
  dotted: 'منقّطة',
  grid: 'مربعات',
};

/** A note page is a writing page, or a section divider that starts a tab of the notebook. */
export const NOTE_PAGE_KINDS = ['page', 'divider'] as const;
export type NotePageKind = (typeof NOTE_PAGE_KINDS)[number];

/**
 * NotePageDTO fields added by the notebook track (always sent by the server; optional for older clients/rows).
 *  * kind          — 'page' (default) or 'divider' (a section start; its title names the tab)
 *  * color         — a cover colour token (COVER_COLORS) for a divider's tab, or null
 *  * after_page_id — the source page the page was inserted after (placement survives a re-numbered version:
 *                    the page is placed after that page when it exists in the version shown, else by
 *                    after_page_index; it is never dropped, §25)
 */
export interface NotePageExtra {
  kind?: NotePageKind;
  color?: string | null;
  after_page_id?: string | null;
}
export type NotePageView = NotePageDTO & NotePageExtra;

/** Where a page link leads: a page (optionally a region on it) of a source version, or a note page. */
export type LinkTarget =
  | {
      type: 'source_page';
      source_id: string;
      /** the version the link was made against (null → the active version) */
      version_id: string | null;
      page_id: string | null;
      page_index: number;
      /** region on the target page (normalized, unrotated) — highlighted on arrival */
      bbox?: NormBox | null;
      region_id?: string | null;
    }
  | { type: 'note_page'; note_page_id: string; bbox?: NormBox | null };

/** `annotation.kind = 'link'`: a clickable box on a page that opens another page (Back returns, §11). */
export interface LinkData {
  v: 1;
  /** the clickable area on THIS page (normalized) */
  box: NormBox;
  target: LinkTarget;
  /** what the owner called the link (shown on the page), e.g. «انظر الجدول» */
  label?: string | null;
  /** the target as the owner saw it when linking, e.g. «ص 12 — محاضرة الزائدة» (display only) */
  target_label?: string | null;
}

/**
 * `annotation.kind = 'image'`: a picture the owner placed on a page. Non-destructive (the page is never changed).
 * The bytes travel separately (POST /api/annotations/images, keyed by `image_key`, a client ULID), so a page with an
 * image syncs even while the upload waits for a connection; other devices show «لم تصل الصورة بعد» until it arrives.
 */
export interface ImageAnnotationData {
  v: 1;
  image_key: string;
  /** placement on the page (normalized; the aspect ratio of the picture is kept) */
  box: NormBox;
  mime: AnnotationImageMime;
  natural_w: number;
  natural_h: number;
  bytes: number;
  /** owner-written description (alt text); null → «صورة أضفتها» */
  alt?: string | null;
  /** original file name, display only */
  name?: string | null;
  /** (parity N1, G19) rotation about the box's centre in radians, clockwise, in page space. Absent = 0. */
  rotation?: number;
}

export const ANNOTATION_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type AnnotationImageMime = (typeof ANNOTATION_IMAGE_MIMES)[number];
/** Size limit of one inserted picture (server and web enforce the same number). */
export const ANNOTATION_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Largest side accepted (pixels) — larger pictures are refused with a reason, never silently scaled. */
export const ANNOTATION_IMAGE_MAX_SIDE = 12_000;

/**
 * (Round 7 — H3 item 4) «بطاقة إخفاء في صورة» from a lasso selection: POST /api/annotations/page-crops cuts the area of
 * the SOURCE page under the selection box out of the stored source file (server-side; never the owner's ink, never a
 * picture sent by the client) and keeps it as a picture of that source (`image_asset`) an image-occlusion card can use.
 * `id` is a client ULID: sending the same request again returns the same picture.
 */
export interface PageCropRequest {
  id: string;
  page_id: string;
  /** the selection box, normalized to the page as the reader shows it */
  bbox: NormBox;
}
export interface PageCropView {
  image_asset_id: string;
  file_id: string;
  /** the picture's URL (owner session) */
  url: string;
  width: number;
  height: number;
  source_id: string;
  version_id: string;
  page_id: string;
  page_index: number;
  bbox: NormBox;
}
export interface PageCropResponse {
  crop: PageCropView;
  created: boolean;
}
