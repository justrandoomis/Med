// Academic OS — authorship layers on a document (P1-T2; ARCHITECTURE_DELTA §4.3, §5.4, §6.6, §7.5; ADR-0004 §2.1).
//
// * The existing `annotation.layer` column (ink | highlight | text | media) stays the RENDER class. `layer_id` carries
//   authorship and visibility. `layer_id` absent / NULL = the default personal layer of the document («ملاحظاتي»), so
//   no legacy row is rewritten and older clients keep working.
// * A document is `source:<source_id>` (a lecture, all of its versions) or `notebook:<library_node_id>`.
// * Rules R1–R6 (ADR-0004 §2.1) are enforced by the server's sync handlers; the web engine applies the same table through
//   its visibility / editability predicate (render, hit-test, eraser, lasso). The server stays the authority.
import { z } from 'zod';
import type { AnnotationDTO, NoteDTO } from '../annotations';
import type { LayerKind, UserRef } from './visibility';
import { LAYER_KINDS } from './visibility';

// ─── documents ─────────────────────────────────────────────────────────────────────────────
export type DocumentKey = `source:${string}` | `notebook:${string}`;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function sourceDocumentKey(sourceId: string): DocumentKey {
  return `source:${sourceId}`;
}
export function notebookDocumentKey(nodeId: string): DocumentKey {
  return `notebook:${nodeId}`;
}
export function parseDocumentKey(key: string): { type: 'source' | 'notebook'; id: string } | null {
  const m = /^(source|notebook):([A-Za-z0-9_-]{1,64})$/.exec(key);
  return m ? { type: m[1] as 'source' | 'notebook', id: m[2]! } : null;
}
export const documentKeySchema = z.string().regex(/^(source|notebook):[A-Za-z0-9_-]{1,64}$/, 'مفتاح المستند غير صالح.');

/**
 * The id of a document's default personal layer («ملاحظاتي»). It is derived (two independent 32-bit FNV-1a lanes over
 * the document key = 64 bits), so every device names the same layer without asking the server; rows that belong to it
 * are stored with `layer_id` NULL.
 */
export function defaultPersonalLayerId(documentKey: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < documentKey.length; i++) {
    const c = documentKey.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ ((c * 31 + i) & 0xffff), 0x01000193);
  }
  return `pl_${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

// ─── who may do what with a layer, in a vault (§5.4) ────────────────────────────────────────
/**
 * * `write` — the vault's user writes it with the op-log (R1): personal, explanation, answers, forked;
 * * `read_only` — followed copies and published snapshots: an op on them is `rejected/layer_read_only` (R2) and the
 *   client re-homes the item into «ملاحظاتي»;
 * * `use_crdt` — collaborative layers take CRDT updates only (R4);
 * * `forbidden` — kinds that only live in a subject space (group comments, suggestions) are refused in a vault.
 */
export type LayerAccess = 'write' | 'read_only' | 'use_crdt' | 'forbidden';

export function layerAccess(layer: { kind: LayerKind; writable: boolean; frozen: boolean; deleted?: boolean }): LayerAccess {
  if (layer.kind === 'collaborative') return 'use_crdt';
  if (layer.kind === 'group_comments' || layer.kind === 'suggestion') return 'forbidden';
  if (layer.kind === 'followed' || layer.kind === 'published_snapshot') return 'read_only';
  if (!layer.writable || layer.frozen) return 'read_only';
  return 'write';
}

/** Layer kinds a client may create in its own vault (§7.5); every other kind is created by the server only. */
export const CLIENT_LAYER_KINDS = ['personal', 'answers', 'explanation'] as const satisfies readonly LayerKind[];
export type ClientLayerKind = (typeof CLIENT_LAYER_KINDS)[number];

export const LAYER_REASONS_AR = {
  layer_read_only: 'هذه الطبقة للقراءة فقط (شرح تتابعه أو نسخة منشورة)؛ لم تُغيَّر. نُقلت كتابتك إلى «ملاحظاتي» كي لا تضيع.',
  layer_forbidden: 'لا يمكن الكتابة في هذه الطبقة من هذا الجهاز؛ لم تُغيَّر. نُقلت كتابتك إلى «ملاحظاتي» كي لا تضيع.',
  use_crdt: 'هذه طبقة مشتركة تُكتب عبر التعاون المباشر فقط؛ لم تُغيَّر.',
  other_author: 'هذا العنصر كتبه شخص آخر؛ لا يُمحى ولا يُعدَّل من هنا، ويمكنك نسخه إلى طبقتك.',
  layer_not_empty: 'لا تُحذف طبقة فيها عناصر. انقل العناصر أو احذفها أولًا؛ لا يُحذف شيء دون علمك.',
  default_layer: 'لا تُحذف «ملاحظاتي»: هي الطبقة الأساسية لكل مستند.',
} as const;

/** Shown to the owner when the client re-homes a refused item (ADR-0004 R2, AOS-1.6 / 1.9). */
export const REHOMED_NOTICE_AR = 'نُقلت كتابة إلى «ملاحظاتي» لأن الطبقة التي كُتبت عليها للقراءة فقط.';
/** (P1-T2 review) the same, when the layer is gone or cannot be written from a device (`layer_forbidden`, `use_crdt`) */
export const REHOMED_UNAVAILABLE_NOTICE_AR = 'نُقلت كتابة إلى «ملاحظاتي» لأن الطبقة التي كُتبت عليها لم تعد موجودة أو لا يُكتب فيها من هذا الجهاز.';

// ─── wire shapes ───────────────────────────────────────────────────────────────────────────
/** A layer row (sync entity `annotation_layer`; snake_case wire format). */
export interface AnnotationLayerDTO {
  id: string;
  document_key: string;
  kind: LayerKind;
  title: string;
  /** null in a vault = the vault's user */
  owner_user_id: string | null;
  writable: boolean;
  frozen: boolean;
  /** where a copied / followed layer came from */
  origin: LayerOrigin | null;
  /** default visibility (a study session may override it) */
  visible: boolean;
  /** the owner locked it against accidental edits (a client-side guard, not a permission) */
  locked: boolean;
  color: string | null;
  sort_order: number;
  rev: number;
  device_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface LayerOrigin {
  space_id?: string | null;
  publication_id?: string | null;
  version_no?: number | null;
  author_user_id?: string | null;
  author_display?: string | null;
  /** a layer copy («انسخ الطبقة»): the layer and document it was copied from */
  copied_from_layer_id?: string | null;
  copied_from_document_key?: string | null;
}

/** What the layers panel shows (GET /api/annotations/layers?document_key=). */
export interface LayerView {
  id: string;
  document_key: string;
  kind: LayerKind;
  title: string;
  writable: boolean;
  frozen: boolean;
  visible: boolean;
  locked: boolean;
  color: string | null;
  sort_order: number;
  /** live items (annotations + notes) on the layer */
  item_count: number;
  /** true for the document's default personal layer («ملاحظاتي»; legacy rows with no layer id belong to it) */
  is_default: boolean;
  /** what the client may do with it, from `layerAccess` */
  access: LayerAccess;
  origin: { publication_id: string | null; version_no: number | null; author: UserRef | null; copied_from_layer_id: string | null } | null;
  rev: number;
}
export interface LayersResponse {
  document_key: string;
  layers: LayerView[];
}

/** Kinds a layer copy can filter on (§7.5 `CopyLayersRequest.kinds`). */
export const COPY_KIND_FILTERS = ['ink', 'shape', 'highlight', 'text_highlight', 'text', 'sticky', 'image', 'link', 'bookmark', 'note'] as const;
export type CopyKindFilter = (typeof COPY_KIND_FILTERS)[number];

export interface CopyLayersRequest {
  /** Phase 1: exactly one layer (merging several is Phase 2) */
  from_layer_ids: string[];
  /**
   * the document of `from_layer_ids[0]` — needed only when it is a document's default «ملاحظاتي» layer that was never
   * renamed (its id is derived from the document key and has no row to look it up)
   */
  document_key?: string;
  kinds?: CopyKindFilter[];
  /** source page ids or note page ids to copy from (default: all) */
  page_ids?: string[];
  /**
   * where the copies go: an existing layer (`document_key` again only for a never-renamed default layer), or a new layer
   * with this title in `document_key` (default: the source layer's document). Another document = another copy of the
   * same lecture: pages are matched by position and must have the same count (else the items are listed as skipped).
   */
  into: { layer_id: string; document_key?: string } | { new_title: string; document_key?: string };
  /** true → counts only, nothing is written */
  preview?: boolean;
}

export interface CopyPreview {
  /** items that will be copied */
  items: number;
  by_kind: Record<string, number>;
  /** pages the copied items sit on */
  pages: number;
  by_page: Array<{ target_key: string; label_ar: string; items: number }>;
  /** pictures referenced by the copied image items (the bytes are shared, never duplicated) */
  images: number;
  /** items already copied by an earlier run (a re-run copies nothing twice) */
  already_copied: number;
  /** items that cannot be copied, with the reason */
  skipped: Array<{ reason_ar: string; items: number }>;
  attributions: UserRef[];
  /** the layer the copies go to (null while previewing a copy into a new layer) */
  into_layer_id: string | null;
}

export interface CopyLayersResponse {
  preview: CopyPreview;
  /** set when the copy was written (not a preview) */
  result?: { into_layer_id: string; copied: number; already_copied: number };
}

/** One entry of a layer's history list (AOS-4.15 Phase 1: read-only; nothing is restored from it yet). */
export interface LayerHistoryEntry {
  entity_type: 'annotation' | 'note' | 'annotation_layer';
  entity_id: string;
  /** the revision the entry describes (create entries: 0) */
  rev: number;
  action: 'create' | 'update' | 'delete' | 'restore' | 'followed_update' | 'layer_restore';
  at: number;
  /** null = you (the vault's user) */
  actor: UserRef | null;
  actor_label_ar: string;
  device_id: string | null;
  /** annotation kind, 'note' or 'layer' */
  item_kind: string;
  summary_ar: string;
  page_label_ar: string | null;
}
export interface LayerHistoryPage {
  layer_id: string;
  entries: LayerHistoryEntry[];
  /** pass as `before` for the next (older) page; null = the end */
  next_before: string | null;
}

/** Attribution of a copied item («مأخوذ من …»; never evidence). */
export interface AttributionView {
  entity_type: 'annotation' | 'note' | 'note_page' | 'annotation_layer' | 'publication_version';
  entity_id: string;
  author_user_id: string;
  author_display: string;
  derived_from: Array<{ space_id: string | null; publication_id: string | null; version_no: number | null; item_id: string; layer_id?: string | null; document_key?: string | null }>;
  created_at: number;
}

/** `author_user_id` of the vault's own user before accounts exist (R1-a); the owner migration maps it to user #1. */
export const VAULT_SELF_USER = 'vault:self';

// ─── zod (server request validation; client parsing) ─────────────────────────────────────────
const idSchema = z.string().regex(ID_RE, 'معرّف غير صالح.');
export const layerTitleSchema = z
  .string()
  .trim()
  .min(1, 'اكتب اسمًا للطبقة.')
  .max(80, 'اسم الطبقة أطول من 80 حرفًا.')
  .refine((t) => !/[\u202a-\u202e\u2066-\u2069]/.test(t), 'اسم الطبقة يحتوي محارف تحكم في الاتجاه.');
export const layerColorSchema = z.string().regex(/^(#[0-9a-fA-F]{6}|[a-z][a-z0-9-]{1,30})$/, 'لون غير صالح.');

export const layerCreateSchema = z.object({
  id: idSchema,
  document_key: documentKeySchema,
  title: layerTitleSchema,
  kind: z.enum(CLIENT_LAYER_KINDS),
  color: layerColorSchema.nullish(),
  sort_order: z.number().finite().optional(),
});
export const layerPatchSchema = z
  .object({
    title: layerTitleSchema.optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    color: layerColorSchema.nullable().optional(),
    sort_order: z.number().finite().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, 'لا يوجد ما يُغيَّر.');

export const copyLayersRequestSchema = z.object({
  from_layer_ids: z.array(idSchema).length(1, 'انسخ طبقة واحدة في كل مرة (دمج عدة طبقات يأتي لاحقًا).'),
  document_key: documentKeySchema.optional(),
  kinds: z.array(z.enum(COPY_KIND_FILTERS)).min(1).max(COPY_KIND_FILTERS.length).optional(),
  page_ids: z.array(idSchema).min(1).max(2000).optional(),
  into: z.union([z.object({ layer_id: idSchema, document_key: documentKeySchema.optional() }), z.object({ new_title: layerTitleSchema, document_key: documentKeySchema.optional() })]),
  preview: z.boolean().optional(),
});

export const layerKindSchemaAll = z.enum(LAYER_KINDS);

// ─── copy my notes to a new version («انقل ملاحظاتي إلى الإصدار الجديد»; P1-T2 step 3) ─────────────────────────────
// ARCHITECTURE_DELTA §6.3; PRD AOS-3.13, 4.17, 4.20, Q35; Scenario 4 (note side). COPY, NEVER MOVE: every item on the
// earlier version stays there unchanged; a copy (deterministic id per item and target version) is written on the new
// version where P1-T3's page map (`isCopyTarget`) says the page is the same; anything else is listed for the owner's
// review, never guessed. Nothing changes before the owner's tap (the preview is read-only); a run can be undone (its
// copies are tombstoned, the originals never touched). Invariant shown to the owner: total = moved + needs review + kept.

/** Why an item is listed «تحتاج مراجعة» instead of being copied. */
export const REANCHOR_REVIEW_REASONS = ['page_changed', 'page_moved', 'page_removed', 'page_uncertain', 'layout_changed', 'quote_not_found'] as const;
export type ReanchorReviewReason = (typeof REANCHOR_REVIEW_REASONS)[number];
export const REANCHOR_REVIEW_REASONS_AR: Record<ReanchorReviewReason, string> = {
  page_changed: 'تغيّر نص صفحتها في الإصدار الجديد؛ لا تُنسخ إليها دون قرارك.',
  page_moved: 'صفحتها انتقلت إلى موضع آخر في الإصدار الجديد؛ تأكّد أنها الصفحة نفسها.',
  page_removed: 'لا توجد صفحة مقابلة لصفحتها في الإصدار الجديد (حُذفت أو تغيّرت كليًا).',
  page_uncertain: 'مطابقة صفحتها مع الإصدار الجديد غير مؤكدة.',
  layout_changed: 'نص صفحتها لم يتغير لكن ترتيب عناصرها تغيّر؛ قد لا تقع الكتابة في مكانها نفسه.',
  quote_not_found: 'النص المظلَّل لم يوجد بالحرف في الصفحة المقابلة.',
};

/** Why an item stays on the earlier version (counted «بقيت على الإصدار السابق»). */
export const REANCHOR_KEPT_REASONS = ['owner_choice', 'read_only_layer'] as const;
export type ReanchorKeptReason = (typeof REANCHOR_KEPT_REASONS)[number];
export const REANCHOR_KEPT_REASONS_AR: Record<ReanchorKeptReason, string> = {
  owner_choice: 'اخترت إبقاءها على الإصدار السابق.',
  read_only_layer: 'على طبقة للقراءة فقط (طبقة متابَعة تتبع ناشرها)؛ لا تُنقل من هنا.',
};

export interface ReanchorPageRef {
  page_id: string;
  page_index: number;
  /** «ص 12 (الصفحة 14 في الملف)» */
  label_ar: string;
  /** a page image can be shown (`GET /api/versions/pages/:id/thumbnail`) */
  thumbnail: boolean;
}

export interface ReanchorVersionRef {
  id: string;
  version_no: number;
}

/** One item listed «تحتاج مراجعة» (the owner copies it to a page they pick, or keeps it on the earlier version). */
export interface ReanchorReviewItem {
  /** items of one pen group (same old page, same reason) share it and are copied together */
  group_key: string;
  kind: 'annotation' | 'note';
  id: string;
  /** the revision the list saw (a newer edit elsewhere → 409, nothing changes) */
  rev: number;
  /** the annotation kind, or 'note' */
  item_kind: string;
  label_ar: string;
  /** the highlighted quote or the note's text (bounded) */
  preview: string | null;
  from: ReanchorPageRef;
  /** the page map's candidate on the new version (uncertain, moved or re-laid-out), null when there is none */
  suggested: ReanchorPageRef | null;
  reason: ReanchorReviewReason;
  reason_ar: string;
}

/** GET /api/annotations/reanchor-copy?source_id=&from_version_id=&to_version_id= — what the tap would do (read-only). */
export interface ReanchorCopyPreview {
  /** `pending` / `failed`: the page map is not ready (counts of items are still given); `none`: nothing to carry */
  state: 'ready' | 'pending' | 'failed' | 'none';
  reason_ar: string | null;
  source_id: string;
  from_version: ReanchorVersionRef | null;
  to_version: ReanchorVersionRef;
  /** the page map's algorithm and the time it was computed (sent back with the run: a changed map → 409) */
  algo: string | null;
  map_computed_at: number | null;
  /** personal items on the earlier version = already_moved + copy + needs_review + kept */
  total: number;
  /** items the tap copies now */
  copy: number;
  /** items carried forward by an earlier run or review decision (never copied twice) */
  already_moved: number;
  needs_review: number;
  kept: number;
  /** per new page: where the copies land, and the old page they come from (one old page ↔ one new page) */
  will_copy: Array<{ page: ReanchorPageRef; from_page_index: number; from: ReanchorPageRef; items: number }>;
  by_kind: Record<string, number>;
  review: ReanchorReviewItem[];
  kept_by_reason: Array<{ reason: ReanchorKeptReason; reason_ar: string; items: number }>;
  /** the items you chose to keep on the earlier version (bounded): each can go back to the review list */
  kept_items: Array<{ kind: 'annotation' | 'note'; id: string; rev: number; item_kind: string; label_ar: string; preview: string | null; from: ReanchorPageRef }>;
  /** every earlier version of the lecture that holds personal items (the default `from` is the newest with pending ones) */
  earlier: Array<{ version: ReanchorVersionRef; items: number; pending: number }>;
  /** the latest tap between these versions (its undo is offered while it is not undone; a review copy has its own) */
  last_run: ReanchorCopyReport | null;
  /** «سيُنقل 2 · يحتاج مراجعة 1 · يبقى على الإصدار 1: 0» */
  summary_ar: string;
}

/** The report of one run (the tap) or one review decision; stored, so it can be shown again and undone. */
export interface ReanchorCopyReport {
  /** null: nothing was copied, so nothing was recorded (a repeated run is a no-op) */
  id: string | null;
  source_id: string;
  kind: 'run' | 'manual';
  from_version: ReanchorVersionRef;
  to_version: ReanchorVersionRef;
  total: number;
  copied: number;
  already_moved: number;
  needs_review: number;
  kept: number;
  /** distinct new pages the copies landed on */
  pages: number;
  by_page: Array<{ page: ReanchorPageRef; items: number }>;
  /** «نُقل 41 عنصرًا إلى 12 صفحة؛ 6 تحتاج مراجعتك؛ 3 بقيت على الإصدار السابق» */
  summary_ar: string;
  created_at: number;
  undone_at: number | null;
  /** after an undo: copies tombstoned, and copies kept because you changed them after the copy */
  undo: { tombstoned: number; kept_edited: number } | null;
}

/** POST /api/annotations/reanchor-copy — the owner's tap. */
export interface ReanchorCopyRunRequest {
  source_id: string;
  from_version_id: string;
  to_version_id: string;
  /** the preview's `map_computed_at`: the map changed since → 409 and nothing is copied */
  map_computed_at?: number | null;
}
export interface ReanchorCopyRunResponse {
  report: ReanchorCopyReport;
}

/** POST /api/annotations/reanchor-copy/undo — tombstones the run's copies (only those); the originals never change. */
export interface ReanchorCopyUndoRequest {
  run_id: string;
}

/**
 * POST /api/annotations/reanchor with a cross-version action (Round 7's re-anchoring route, reused AS A COPY):
 *  * `copy` — copy the items to the page the owner picked on `to_version_id` (optionally at a paragraph region); the
 *    originals stay on their version;
 *  * `keep_on_previous` — «اتركها على الإصدار السابق»: nothing is written to the items; they are counted «بقيت»;
 *  * `review_again` — undo a «keep» decision (the items return to the review list).
 */
export interface ReanchorCopyActionRequest {
  action: 'copy' | 'keep_on_previous' | 'review_again';
  items: Array<{ kind: 'annotation' | 'note'; id: string; rev: number }>;
  to_version_id: string;
  target?: { type: 'page'; version_id: string; page_id: string; region_id?: string | null };
}
export interface ReanchorCopyActionResponse {
  /** the copies written (empty for keep / review_again) */
  annotations: AnnotationDTO[];
  notes: NoteDTO[];
  summary_ar: string;
  /** the recorded review copy (undoable), null for keep / review_again */
  report: ReanchorCopyReport | null;
}

const reanchorItemSchema = z.object({ kind: z.enum(['annotation', 'note']), id: idSchema, rev: z.number().int().min(0) });
export const reanchorCopyRunSchema = z.object({
  source_id: idSchema,
  from_version_id: idSchema,
  to_version_id: idSchema,
  map_computed_at: z.number().int().nonnegative().nullish(),
});
export const reanchorCopyUndoSchema = z.object({ run_id: idSchema });
export const reanchorCopyActionSchema = z
  .object({
    action: z.enum(['copy', 'keep_on_previous', 'review_again']),
    items: z.array(reanchorItemSchema).min(1).max(500),
    to_version_id: idSchema,
    target: z.object({ type: z.literal('page'), version_id: idSchema, page_id: idSchema, region_id: idSchema.nullish() }).optional(),
  })
  .refine((b) => b.action !== 'copy' || (!!b.target && b.target.version_id === b.to_version_id), { message: 'اختر صفحة من الإصدار الجديد (target).' })
  .refine((b) => new Set(b.items.map((i) => `${i.kind}:${i.id}`)).size === b.items.length, { message: 'تكرر عنصر في الطلب نفسه؛ أرسل كل عنصر مرة واحدة.' });

/** Arabic count of items: «عنصر واحد», «عنصران», «3 عناصر», «41 عنصرًا». */
export function itemsCountAr(n: number): string {
  if (n === 0) return 'لا شيء';
  if (n === 1) return 'عنصر واحد';
  if (n === 2) return 'عنصران';
  return n <= 10 ? `${n} عناصر` : `${n} عنصرًا`;
}
/** Arabic count of pages after «إلى»: «صفحة واحدة», «صفحتين», «3 صفحات», «12 صفحة». */
export function pagesCountAr(n: number): string {
  if (n === 1) return 'صفحة واحدة';
  if (n === 2) return 'صفحتين';
  return n <= 10 ? `${n} صفحات` : `${n} صفحة`;
}
