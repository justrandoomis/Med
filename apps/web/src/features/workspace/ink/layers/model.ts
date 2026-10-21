// Authorship layers in the ink engine (Academic OS P1-T2 step 1; ARCHITECTURE_DELTA §5.4, §6.6; ADR-0004 R5).
//
// Pure logic: which layers a document has, which of them this study session shows, which layer new writing goes to,
// and the two predicates the store applies in render / hit-test / eraser / lasso:
//   * visible(item)  — its layer is not hidden in this session;
//   * editable(item) — its layer is the owner's and writable (not a followed copy, a snapshot or a CRDT layer), not
//     locked by the owner, and the item was written by the vault's user. Read-only items can be selected and copied.
// The server enforces the same table (layer rules R2–R5); this only keeps the UI from offering what it would refuse.
import { defaultPersonalLayerId, LAYER_KIND_LABELS_AR, layerAccess, parseDocumentKey, type LayerAccess, type LayerKind } from '@medlevo/shared';
import type { LayerRow } from '../../../../lib/localdb';

export interface LayerInfo {
  id: string;
  documentKey: string;
  kind: LayerKind;
  title: string;
  writable: boolean;
  frozen: boolean;
  /** default visibility (a study session may override it) */
  visible: boolean;
  locked: boolean;
  color: string | null;
  sortOrder: number;
  /** the document's «ملاحظاتي» (legacy rows with no layer id belong to it) */
  isDefault: boolean;
  access: LayerAccess;
  /** who a followed / copied layer came from, for the panel («من شرح سارة — الإصدار 3») */
  originLabel: string | null;
  /** the row as stored (null for a never-renamed default layer) */
  row: LayerRow | null;
}

/** What this study session shows (saved in the session's location, ARCHITECTURE_DELTA §6.6). */
export interface LayerSession {
  /** ids hidden in this session; absent = each layer's own default */
  hidden?: string[];
  /** the layer new writing goes to; null / absent = «ملاحظاتي» */
  active?: string | null;
}

const DEFAULT_SORT = -1e9;

export function originLabelOf(origin: unknown): string | null {
  if (!origin || typeof origin !== 'object') return null;
  const o = origin as { author_display?: unknown; version_no?: unknown; copied_from_layer_id?: unknown };
  if (typeof o.author_display === 'string' && o.author_display) {
    return typeof o.version_no === 'number' ? `من شرح ${o.author_display} — الإصدار ${o.version_no}` : `من شرح ${o.author_display}`;
  }
  if (typeof o.copied_from_layer_id === 'string') return 'منسوخة من طبقة أخرى';
  return null;
}

export function layerInfoFromRow(row: LayerRow, documentKey: string): LayerInfo {
  const isDefault = row.id === defaultPersonalLayerId(documentKey);
  return {
    id: row.id,
    documentKey,
    kind: row.kind,
    title: row.title,
    writable: row.writable,
    frozen: row.frozen,
    visible: row.visible,
    locked: row.locked,
    color: row.color ?? null,
    sortOrder: isDefault ? DEFAULT_SORT : row.sortOrder,
    isDefault,
    access: layerAccess({ kind: row.kind, writable: row.writable, frozen: row.frozen }),
    originLabel: originLabelOf(row.origin),
    row,
  };
}

export function defaultLayerInfo(documentKey: string): LayerInfo {
  return {
    id: defaultPersonalLayerId(documentKey),
    documentKey,
    kind: 'personal',
    title: LAYER_KIND_LABELS_AR.personal,
    writable: true,
    frozen: false,
    visible: true,
    locked: false,
    color: null,
    sortOrder: DEFAULT_SORT,
    isDefault: true,
    access: 'write',
    originLabel: null,
    row: null,
  };
}

/** The document's layers: «ملاحظاتي» first (materialised or not), then the others by their order; tombstones left out. */
export function documentLayers(rows: readonly LayerRow[], documentKey: string): LayerInfo[] {
  const defId = defaultPersonalLayerId(documentKey);
  const live = rows.filter((r) => r.documentKey === documentKey && !r.deletedAt);
  const def = live.find((r) => r.id === defId);
  const others = live
    .filter((r) => r.id !== defId)
    .map((r) => layerInfoFromRow(r, documentKey))
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.row?.createdAt ?? 0) - (b.row?.createdAt ?? 0) || a.id.localeCompare(b.id));
  return [def ? layerInfoFromRow(def, documentKey) : defaultLayerInfo(documentKey), ...others];
}

/** The layer an item is on (an item without a layer id is on «ملاحظاتي»). */
export function layerKeyOf(item: { layer_id?: string | null }, defaultId: string): string {
  return item.layer_id ?? defaultId;
}

/** The ids hidden in this session: the session's own list once it has one, else the layers' defaults. */
export function hiddenLayerIds(layers: readonly LayerInfo[], session: LayerSession): Set<string> {
  if (session.hidden) return new Set(session.hidden);
  return new Set(layers.filter((l) => !l.visible).map((l) => l.id));
}

/** Can new writing go to this layer? */
export function canWriteTo(layer: LayerInfo | undefined): boolean {
  return !!layer && layer.access === 'write' && !layer.locked;
}

/** The layer new writing goes to, as an item's `layer_id` (null = «ملاحظاتي»); an unusable choice falls back to it. */
export function activeLayerId(layers: readonly LayerInfo[], session: LayerSession): string | null {
  const id = session.active ?? null;
  if (!id) return null;
  const layer = layers.find((l) => l.id === id);
  if (!canWriteTo(layer) || layer!.isDefault) return null;
  return id;
}

type PredicateItem = { layer_id?: string | null; author_user_id?: string | null; anchor?: { type: string; source_id?: string } | null };

export interface LayerPredicates {
  visible(item: PredicateItem): boolean;
  editable(item: PredicateItem): boolean;
  /** false for an item of another document in the same store (the active layer is not stamped on it) */
  inDocument(item: PredicateItem): boolean;
  active: string | null;
}

/**
 * An item of ANOTHER document in the same ink store (the split pane's second source): this document's layer choices do
 * not apply to it (its layers are its own document's), so it is shown and left to the server's rules.
 */
function foreignTo(documentKey: string | undefined): (it: PredicateItem) => boolean {
  const doc = documentKey ? parseDocumentKey(documentKey) : null;
  if (!doc || doc.type !== 'source') return () => false;
  return (it) => it.anchor?.type === 'page' && !!it.anchor.source_id && it.anchor.source_id !== doc.id;
}

export function layerPredicates(layers: readonly LayerInfo[], session: LayerSession): LayerPredicates {
  const defaultId = layers.find((l) => l.isDefault)?.id ?? '';
  const hidden = hiddenLayerIds(layers, session);
  const byId = new Map(layers.map((l) => [l.id, l]));
  const foreign = foreignTo(layers[0]?.documentKey);
  return {
    visible: (it) => foreign(it) || !hidden.has(layerKeyOf(it, defaultId)),
    editable: (it) => {
      if (it.author_user_id) return false; // another author's item (a followed explanation)
      if (foreign(it)) return true;
      const layer = byId.get(layerKeyOf(it, defaultId));
      // a layer this device does not know yet (its row has not synced): the server still decides
      if (!layer) return true;
      return layer.access === 'write' && !layer.locked;
    },
    inDocument: (it) => !foreign(it),
    active: activeLayerId(layers, session),
  };
}

/** Why an item cannot be changed, for the lasso bar («للقراءة فقط»). */
export function readOnlyReasonAr(layer: LayerInfo | undefined, authoredElsewhere: boolean): string {
  if (authoredElsewhere || layer?.access === 'read_only') return 'عناصر من طبقة للقراءة فقط (شرح تتابعه أو نسخة منشورة): يمكنك نسخها إلى طبقتك فقط.';
  if (layer?.locked) return 'الطبقة مقفلة: افتحها من لوحة الطبقات لتعديلها.';
  return 'لا يمكن تعديل هذه العناصر من هنا؛ يمكنك نسخها.';
}

export function layerKindLabelAr(layer: LayerInfo): string {
  // «ملاحظاتي» names the document's default layer only; another personal layer is «طبقة شخصية»
  if (layer.kind === 'personal' && !layer.isDefault) return 'طبقة شخصية';
  return LAYER_KIND_LABELS_AR[layer.kind];
}
