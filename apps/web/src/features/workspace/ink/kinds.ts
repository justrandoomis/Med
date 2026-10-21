// Item-kind registry (parity N1 Wave 0 seam — docs/research/NOTE_APP_FEATURE_PARITY.md B.3).
//
// Every kind of annotation the ink engine deals with is described here: whether the engine holds it in its page memory
// (draws, hit-tests and lassoes it), whether the lasso may select it, the erasers / «امسح الصفحة» may remove it and an
// export may include it, and its content type (what the lasso chips, the eraser filter and «احذف كل …» group by).
//
// The built-in kinds are registered below; their drawing, geometry and transforms stay in render.ts / model.ts, which
// read the flags from here. Other tracks register their own kinds from their own folders (N4 `tape`, N2 board nodes)
// with `registerInkKind`, giving the functions the engine cannot know: `draw` (canvas, page units), `geometry` (iso
// polylines for hit-testing and erasing), `bounds`, and optionally `transform`. Nothing here imports the engine, so the
// registry never creates an import cycle.
import type { AnnotationDTO, NormBox } from '@medlevo/shared';

type Item = AnnotationDTO;
type Vec = [number, number];
type Mat = [number, number, number, number, number, number];

/**
 * What an item is, for the owner: the groups the lasso chips (G17), the selective eraser (G15), «احذف كل … في الدفتر»
 * and the «نسخة نظيفة للمراجعة» view work with. A registered kind may add its own (its kind name by default).
 */
export type InkContentType = 'pen' | 'highlighter' | 'shape' | 'text' | 'sticky' | 'image' | 'link' | 'text_highlight' | (string & {});

export interface InkKindGeometry {
  /** polylines in iso units (x, y · ar) */
  lines: Vec[][];
  /** half the widest line width (iso): hit tolerance */
  halfWidth: number;
  /** a filled area (iso polygon) that counts as a hit */
  area?: Vec[];
}

export interface InkKindEnv {
  /** unrotated page size in page units */
  W: number;
  H: number;
  tone: 'light' | 'dark';
  css: CSSStyleDeclaration | null;
}

export interface InkKindSpec {
  kind: string;
  /** the kind's name in Arabic (singular), e.g. «خط بالقلم» */
  label_ar: string;
  /** plural name for counts, e.g. «خطوط بالقلم» */
  plural_ar: string;
  /**
   * true: the engine keeps these items in its page memory (draws, hit-tests, lassoes them). false: the reader draws them
   * (text highlights) — the engine only reads them from this device's storage to erase or clear them.
   */
  engine: boolean;
  /** the lasso (loop, rectangle, tap) may select it */
  selectable: boolean;
  /** the stroke / point erasers, the scribble gesture and «امسح الصفحة» may remove it */
  erasable: boolean;
  /** an export (N5) may include it */
  exportable: boolean;
  /** content type of an item of this kind (default: one fixed type) */
  contentType: (item: Item) => InkContentType;
  // ── only for kinds registered by other tracks (the built-ins are drawn and measured by render.ts / model.ts) ──
  /** draws the item on the committed-ink canvas; the context's transform maps page units to device pixels */
  draw?: (ctx: CanvasRenderingContext2D, item: Item, env: InkKindEnv) => void;
  /** iso-space geometry for hit-tests and erasers */
  geometry?: (item: Item, ar: number) => InkKindGeometry;
  /** normalized bounding box (spatial index, dirty rects) */
  bounds?: (item: Item, ar: number) => NormBox;
  /** applies an iso-space similarity transform (move / resize / rotate); absent = the item does not move */
  transform?: (item: Item, m: Mat, ar: number, now: number) => Item;
}

export type InkKindInput = Omit<InkKindSpec, 'contentType' | 'plural_ar'> & { contentType?: InkKindSpec['contentType']; plural_ar?: string };

const registry = new Map<string, InkKindSpec>();
const BUILT_IN = new Set<string>();
let version = 0;

function put(spec: InkKindInput): InkKindSpec {
  const full: InkKindSpec = { ...spec, plural_ar: spec.plural_ar ?? spec.label_ar, contentType: spec.contentType ?? (() => spec.kind) };
  registry.set(spec.kind, full);
  version++;
  return full;
}

/**
 * Registers a kind (another track's own item). Returns a function that removes it again (tests, hot reload). A built-in
 * kind cannot be replaced.
 */
export function registerInkKind(spec: InkKindInput): () => void {
  if (BUILT_IN.has(spec.kind)) throw new Error(`ink kind «${spec.kind}» is built in`);
  if (spec.engine && (!spec.geometry || !spec.bounds)) throw new Error(`ink kind «${spec.kind}»: an engine kind needs geometry() and bounds()`);
  const full = put(spec);
  return () => {
    if (registry.get(spec.kind) === full) {
      registry.delete(spec.kind);
      version++;
    }
  };
}

export function inkKind(kind: string): InkKindSpec | undefined {
  return registry.get(kind);
}

export function isBuiltInKind(kind: string): boolean {
  return BUILT_IN.has(kind);
}

/** All registered kinds (built-in first). */
export function inkKinds(): InkKindSpec[] {
  return [...registry.values()];
}

/** Changes whenever a kind is registered or removed. */
export function inkKindsVersion(): number {
  return version;
}

/** Held in the engine's page memory. */
export function isEngineKind(kind: string): boolean {
  return !!registry.get(kind)?.engine;
}

export function contentTypeOf(item: Item): InkContentType {
  return registry.get(item.kind)?.contentType(item) ?? item.kind;
}

export function isSelectable(item: Item): boolean {
  return !!registry.get(item.kind)?.selectable;
}

export function isErasable(item: Item): boolean {
  return !!registry.get(item.kind)?.erasable;
}

/** Drawn on the committed-ink canvases (strokes, shapes and registered kinds with `draw`). */
export function isCanvasItem(item: Item): boolean {
  if (item.kind === 'ink' || item.kind === 'shape') return true;
  return !BUILT_IN.has(item.kind) && !!registry.get(item.kind)?.draw;
}

/** (G17) The lasso chips: which chip lets an item of this content type into a selection. */
export type LassoChip = 'ink' | 'shape' | 'text' | 'image' | 'link';
export const LASSO_CHIPS: readonly LassoChip[] = ['ink', 'shape', 'text', 'image', 'link'];
export const LASSO_CHIP_LABELS_AR: Record<LassoChip, string> = { ink: 'الحبر', shape: 'الأشكال', text: 'النصوص', image: 'الصور', link: 'الروابط' };

export function lassoChipOf(type: InkContentType): LassoChip | null {
  if (type === 'pen' || type === 'highlighter') return 'ink';
  if (type === 'shape') return 'shape';
  if (type === 'text' || type === 'sticky') return 'text';
  if (type === 'image') return 'image';
  if (type === 'link') return 'link';
  return null;
}

/** Does the lasso filter let this item in? Kinds without a chip (registered by other tracks) pass only when every chip is on. */
export function lassoAllows(item: Item, types: Record<LassoChip, boolean> | undefined): boolean {
  if (!types) return true;
  const chip = lassoChipOf(contentTypeOf(item));
  if (chip) return types[chip];
  return LASSO_CHIPS.every((c) => types[c]);
}

/** (G15) Does the eraser filter let the eraser remove this item? Registered erasable kinds are always allowed. */
export function eraserAllows(item: Item, types: { pen: boolean; highlighter: boolean; shape: boolean; text_highlight: boolean } | undefined): boolean {
  if (!isErasable(item)) return false;
  if (!types) return item.kind !== 'text_highlight';
  const t = contentTypeOf(item);
  if (t === 'pen' || t === 'highlighter' || t === 'shape' || t === 'text_highlight') return types[t as 'pen' | 'highlighter' | 'shape' | 'text_highlight'];
  return true;
}

/** Content types, their Arabic names (singular / plural) for the filters and counts. */
export const CONTENT_TYPE_LABELS_AR: Record<string, { one: string; many: string }> = {
  pen: { one: 'خط بالقلم', many: 'خطوط بالقلم' },
  highlighter: { one: 'تظليل بالقلم', many: 'تظليلات بالقلم' },
  shape: { one: 'شكل', many: 'أشكال' },
  text: { one: 'مربع نص', many: 'مربعات نص' },
  sticky: { one: 'ملاحظة لاصقة', many: 'ملاحظات لاصقة' },
  image: { one: 'صورة', many: 'صور' },
  link: { one: 'رابط صفحة', many: 'روابط صفحات' },
  text_highlight: { one: 'تظليل على النص المطبوع', many: 'تظليلات على النص المطبوع' },
};

export function contentTypeLabel(type: string, n = 1): string {
  const l = CONTENT_TYPE_LABELS_AR[type];
  if (l) return n === 1 ? l.one : l.many;
  const spec = [...registry.values()].find((s) => s.kind === type);
  return spec ? (n === 1 ? spec.label_ar : spec.plural_ar) : type;
}

// ── the built-in kinds ──
const fixed = (t: InkContentType) => () => t;
for (const spec of [
  {
    kind: 'ink',
    label_ar: 'خط بالقلم',
    plural_ar: 'خطوط بالقلم',
    engine: true,
    selectable: true,
    erasable: true,
    exportable: true,
    contentType: (i: Item) => ((i.data as { style?: { tool?: string } }).style?.tool === 'highlighter' ? 'highlighter' : 'pen'),
  },
  { kind: 'shape', label_ar: 'شكل', plural_ar: 'أشكال', engine: true, selectable: true, erasable: true, exportable: true, contentType: fixed('shape') },
  // text boxes, sticky notes, pictures and links are moved, deleted and cleared, never rubbed out by a pen eraser
  { kind: 'text', label_ar: 'مربع نص', plural_ar: 'مربعات نص', engine: true, selectable: true, erasable: false, exportable: true, contentType: fixed('text') },
  { kind: 'sticky', label_ar: 'ملاحظة لاصقة', plural_ar: 'ملاحظات لاصقة', engine: true, selectable: true, erasable: false, exportable: true, contentType: fixed('sticky') },
  { kind: 'image', label_ar: 'صورة', plural_ar: 'صور', engine: true, selectable: true, erasable: false, exportable: true, contentType: fixed('image') },
  { kind: 'link', label_ar: 'رابط صفحة', plural_ar: 'روابط صفحات', engine: true, selectable: true, erasable: false, exportable: true, contentType: fixed('link') },
  // the reader's highlights on printed text: drawn by the reader; the engine can erase / clear them (G15), never move them
  { kind: 'text_highlight', label_ar: 'تظليل على النص المطبوع', plural_ar: 'تظليلات على النص المطبوع', engine: false, selectable: false, erasable: true, exportable: true, contentType: fixed('text_highlight') },
] satisfies InkKindInput[]) {
  put(spec);
  BUILT_IN.add(spec.kind);
}
