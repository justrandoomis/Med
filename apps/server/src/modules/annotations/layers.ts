// Authorship layers (Academic OS P1-T2; ARCHITECTURE_DELTA §4.3, §5.4, §6.6, §7.5; ADR-0004 §2.1 R1–R6).
//
//  * `annotation.layer` (ink | highlight | text | media) stays the render class; `layer_id` is authorship and visibility.
//    `layer_id` NULL = the default personal layer («ملاحظاتي») of the item's document: every legacy row, and every op of
//    an older client, so nothing written before layers existed changes.
//  * A document is `source:<source_id>` (all versions of a lecture) or `notebook:<library_node_id>`.
//  * Rules enforced here, in the sync handlers (the server is the authority; the web engine applies the same table):
//      R1  single-writer layers (personal / explanation / answers / forked) keep the op-log, unchanged;
//      R2  an op on a layer the actor cannot write is `rejected` with `detail_code` `layer_read_only` (followed copies,
//          published snapshots) or `layer_forbidden` (unknown layer, another document's layer, space-only kinds, another
//          author's item) — recorded, not retryable; the client re-homes the item into «ملاحظاتي» (never drops it);
//      R3  a `conflict_kept_both` copy is written to the layer the actor's op named — validated writable for the actor;
//      R4  an annotation / note op on a `collaborative` layer is refused with `use_crdt`;
//      R5  the eraser / lasso rule: an existing item of a read-only layer (or another author's item) cannot be moved,
//          recoloured, moved to another layer or tombstoned;
//      R6  undo stays per device / per user (single-writer layers keep today's history; nothing here changes it).
//  * The sync entity `annotation_layer` (upsert / delete, rev): a client creates personal / answers / explanation layers
//    and edits presentation fields; kind, writable, frozen and origin of server-made layers never change from a client.
import {
  CLIENT_LAYER_KINDS,
  defaultPersonalLayerId,
  LAYER_KIND_LABELS_AR,
  LAYER_KINDS,
  LAYER_REASONS_AR,
  layerAccess,
  layerColorSchema,
  layerTitleSchema,
  parseDocumentKey,
  stableStringify,
  type AnnotationAnchor,
  type AnnotationLayerDTO,
  type LayerAccess,
  type LayerKind,
  type LayerOrigin,
  type LayerView,
  type SyncDetailCode,
  type SyncOp,
} from '@medlevo/shared';
import { z } from 'zod';
import { fromJson, toJson, type Db } from '../../db/db';
import { AppError } from '../../lib/errors';
import { zodIssuesToFields } from '../../lib/http';
import type { SyncApplyResult, SyncEntityHandler, SyncTx } from '../sync/registry';
import { recordRevision } from './history';

export const DEFAULT_LAYER_TITLE_AR = LAYER_KIND_LABELS_AR.personal; // «ملاحظاتي»
/** the default layer sorts first */
const DEFAULT_LAYER_SORT = -1e9;

// ─── rows ───────────────────────────────────────────────────────────────────────────────────
export interface LayerRow {
  id: string;
  document_key: string;
  kind: LayerKind;
  title: string;
  owner_user_id: string | null;
  writable: number;
  frozen: number;
  origin_json: string | null;
  visible: number;
  locked: number;
  color: string | null;
  sort_order: number;
  rev: number;
  device_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export const getLayer = (db: Db, id: string) => db.get<LayerRow>('SELECT * FROM annotation_layer WHERE id = ?', [id]);

export function toLayerDTO(r: LayerRow): AnnotationLayerDTO {
  return {
    id: r.id,
    document_key: r.document_key,
    kind: r.kind,
    title: r.title,
    owner_user_id: r.owner_user_id,
    writable: r.writable === 1,
    frozen: r.frozen === 1,
    origin: r.origin_json ? (fromJson<LayerOrigin>(r.origin_json) ?? null) : null,
    visible: r.visible === 1,
    locked: r.locked === 1,
    color: r.color,
    sort_order: r.sort_order,
    rev: r.rev,
    device_id: r.device_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
}

const accessOf = (r: Pick<LayerRow, 'kind' | 'writable' | 'frozen'>): LayerAccess => layerAccess({ kind: r.kind, writable: r.writable === 1, frozen: r.frozen === 1 });

// ─── documents ──────────────────────────────────────────────────────────────────────────────
function notePageDocument(db: Db, notePageId: string): string | null {
  const np = db.get<{ source_id: string | null; node_id: string | null }>('SELECT source_id, node_id FROM note_page WHERE id = ?', [notePageId]);
  if (!np) return null;
  if (np.source_id) return `source:${np.source_id}`;
  return np.node_id ? `notebook:${np.node_id}` : null;
}

/** The document an anchor belongs to (null when it cannot be resolved here, e.g. a purged note page). */
export function documentKeyOfAnchor(db: Db, anchor: AnnotationAnchor | null | undefined): string | null {
  if (!anchor) return null;
  if (anchor.type === 'page') return `source:${anchor.source_id}`;
  if (anchor.type === 'note_page') return notePageDocument(db, anchor.note_page_id);
  const art = db.get<{ primary_source_id: string | null }>('SELECT primary_source_id FROM artifact WHERE lineage_id = ? AND primary_source_id IS NOT NULL LIMIT 1', [anchor.lineage_id]);
  return art?.primary_source_id ? `source:${art.primary_source_id}` : null;
}

/** The document of a note: its anchor, else its notebook. */
export function documentKeyOfNote(db: Db, n: { anchor: AnnotationAnchor | null; source_id?: string | null; node_id: string | null }): string | null {
  if (n.source_id) return `source:${n.source_id}`;
  const viaAnchor = documentKeyOfAnchor(db, n.anchor);
  if (viaAnchor) return viaAnchor;
  return n.node_id ? `notebook:${n.node_id}` : null;
}

/** SQL expression: the document key of the annotation row aliased `a` (mirrors documentKeyOfAnchor). */
export const ANNOTATION_DOC_SQL = (a = 'a') => `(CASE json_extract(${a}.anchor_json, '$.type')
    WHEN 'page' THEN 'source:' || json_extract(${a}.anchor_json, '$.source_id')
    WHEN 'note_page' THEN (SELECT CASE WHEN np.source_id IS NOT NULL THEN 'source:' || np.source_id WHEN np.node_id IS NOT NULL THEN 'notebook:' || np.node_id END
                           FROM note_page np WHERE np.id = json_extract(${a}.anchor_json, '$.note_page_id'))
    WHEN 'block' THEN (SELECT 'source:' || ar.primary_source_id FROM artifact ar
                       WHERE ar.lineage_id = json_extract(${a}.anchor_json, '$.lineage_id') AND ar.primary_source_id IS NOT NULL LIMIT 1)
  END)`;

/** SQL expression: the document key of the note row aliased `n` (mirrors documentKeyOfNote). */
export const NOTE_DOC_SQL = (n = 'n') => `(CASE
    WHEN ${n}.source_id IS NOT NULL THEN 'source:' || ${n}.source_id
    WHEN json_extract(${n}.anchor_json, '$.type') = 'note_page' THEN (SELECT CASE WHEN np.source_id IS NOT NULL THEN 'source:' || np.source_id WHEN np.node_id IS NOT NULL THEN 'notebook:' || np.node_id END
                           FROM note_page np WHERE np.id = json_extract(${n}.anchor_json, '$.note_page_id'))
    WHEN json_extract(${n}.anchor_json, '$.type') = 'page' THEN 'source:' || json_extract(${n}.anchor_json, '$.source_id')
    WHEN ${n}.node_id IS NOT NULL THEN 'notebook:' || ${n}.node_id
  END)`;

// ─── rules (R2–R5) ─────────────────────────────────────────────────────────────────────────
export type LayerRefusal = { ok: false; code: SyncDetailCode; detail: string };
export type LayerVerdict = { ok: true; layerId: string | null } | LayerRefusal;

const refuse = (code: SyncDetailCode, detail: string = LAYER_REASONS_AR[code as keyof typeof LAYER_REASONS_AR] ?? LAYER_REASONS_AR.layer_forbidden): LayerRefusal => ({ ok: false, code, detail });

function verdictOfAccess(access: LayerAccess): LayerVerdict | null {
  if (access === 'write') return null;
  if (access === 'read_only') return refuse('layer_read_only');
  if (access === 'use_crdt') return refuse('use_crdt');
  return refuse('layer_forbidden');
}

/**
 * The layer an incoming annotation / note op names: absent / null / the document's derived default id → the default
 * personal layer (stored NULL); otherwise it must exist, be live, belong to the item's document and be writable by the
 * vault's user.
 */
export function resolveTargetLayer(db: Db, layerId: string | null | undefined, documentKey: string | null): LayerVerdict {
  if (layerId == null) return { ok: true, layerId: null };
  if (documentKey && layerId === defaultPersonalLayerId(documentKey)) return { ok: true, layerId: null };
  const row = getLayer(db, layerId);
  if (!row || row.deleted_at !== null) return refuse('layer_forbidden', 'الطبقة التي كُتب عليها غير موجودة على الخادم؛ لم يُكتب فيها شيء. نُقلت كتابتك إلى «ملاحظاتي» كي لا تضيع.');
  if (documentKey && row.document_key !== documentKey) return refuse('layer_forbidden', 'الطبقة التي كُتب عليها تخص مستندًا آخر؛ لم يُكتب فيها شيء. نُقلت كتابتك إلى «ملاحظاتي» كي لا تضيع.');
  const bad = verdictOfAccess(accessOf(row));
  if (bad) return bad;
  // a materialised default layer: its items keep layer_id NULL (one representation for «ملاحظاتي»)
  return { ok: true, layerId: row.id === defaultPersonalLayerId(row.document_key) ? null : row.id };
}

/**
 * May the vault's user change or tombstone this EXISTING item? Not when it sits on a read-only / CRDT / space layer, or
 * was written by someone else (a followed author). `actorUserId` is null in a vault (= the vault's user).
 */
export function checkExistingItem(db: Db, item: { layer_id?: string | null; author_user_id?: string | null }, actorUserId: string | null): LayerVerdict {
  // the layer first: an item of a followed copy / snapshot is `layer_read_only` whoever wrote it
  const row = item.layer_id != null ? getLayer(db, item.layer_id) : undefined;
  // (an item whose layer row disappeared — never expected: layers are tombstoned, not deleted while referenced — is
  // judged by its author only)
  const bad = row ? verdictOfAccess(accessOf(row)) : null;
  if (bad) return bad;
  if (item.author_user_id != null && item.author_user_id !== actorUserId) return refuse('layer_forbidden', LAYER_REASONS_AR.other_author);
  return { ok: true, layerId: item.layer_id ?? null };
}

/** The actor of a sync transaction (P1-T1 binds it in R1-b; in a vault today: null = the vault's user). */
export function actorOf(tx: SyncTx): string | null {
  return (tx as SyncTx & { actorUserId?: string | null }).actorUserId ?? null;
}

/** A final layer rejection as the sync engine records it (with the server's copy when there is one). */
export function layerRejection(v: LayerRefusal, entity?: unknown): SyncApplyResult {
  return { result: 'rejected', detail: v.detail, detail_code: v.code, ...(entity !== undefined ? { entity } : {}) };
}

// ─── listing (GET /api/annotations/layers) ──────────────────────────────────────────────────
function itemCount(db: Db, documentKey: string, layerId: string | null): number {
  if (layerId !== null) {
    const a = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation WHERE layer_id = ? AND deleted_at IS NULL', [layerId])!.n;
    const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note WHERE layer_id = ? AND deleted_at IS NULL', [layerId])!.n;
    return a + n;
  }
  const a = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM annotation a WHERE a.layer_id IS NULL AND a.deleted_at IS NULL AND ${ANNOTATION_DOC_SQL('a')} = ?`, [documentKey])!.n;
  const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM note n WHERE n.layer_id IS NULL AND n.deleted_at IS NULL AND ${NOTE_DOC_SQL('n')} = ?`, [documentKey])!.n;
  return a + n;
}

function viewOf(db: Db, r: LayerRow, isDefault: boolean): LayerView {
  const origin = r.origin_json ? fromJson<LayerOrigin>(r.origin_json) : null;
  return {
    id: r.id,
    document_key: r.document_key,
    kind: r.kind,
    title: r.title,
    writable: r.writable === 1,
    frozen: r.frozen === 1,
    visible: r.visible === 1,
    locked: r.locked === 1,
    color: r.color,
    sort_order: r.sort_order,
    item_count: itemCount(db, r.document_key, isDefault ? null : r.id),
    is_default: isDefault,
    access: accessOf(r),
    origin: origin
      ? {
          publication_id: origin.publication_id ?? null,
          version_no: origin.version_no ?? null,
          author: origin.author_user_id ? { id: origin.author_user_id, display_name: origin.author_display ?? 'طالب', avatar_url: null } : null,
          copied_from_layer_id: origin.copied_from_layer_id ?? null,
        }
      : null,
    rev: r.rev,
  };
}

/** The default personal layer of a document as a row (materialised or virtual). */
export function defaultLayerRow(db: Db, documentKey: string, now: number): LayerRow {
  const id = defaultPersonalLayerId(documentKey);
  return (
    getLayer(db, id) ?? {
      id,
      document_key: documentKey,
      kind: 'personal',
      title: DEFAULT_LAYER_TITLE_AR,
      owner_user_id: null,
      writable: 1,
      frozen: 0,
      origin_json: null,
      visible: 1,
      locked: 0,
      color: null,
      sort_order: DEFAULT_LAYER_SORT,
      rev: 0,
      device_id: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    }
  );
}

export function listLayers(db: Db, documentKey: string, now: number): LayerView[] {
  const defId = defaultPersonalLayerId(documentKey);
  const rows = db.all<LayerRow>('SELECT * FROM annotation_layer WHERE document_key = ? AND deleted_at IS NULL AND id <> ? ORDER BY sort_order, created_at, id', [documentKey, defId]);
  return [viewOf(db, defaultLayerRow(db, documentKey, now), true), ...rows.map((r) => viewOf(db, r, false))];
}

// ─── sync entity `annotation_layer` ─────────────────────────────────────────────────────────
const ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'معرّف غير صالح.');
export const layerPayloadSchema = z.object({
  id: ID.optional(),
  document_key: z.string().regex(/^(source|notebook):[A-Za-z0-9_-]{1,64}$/, 'مفتاح المستند غير صالح.'),
  kind: z.enum(LAYER_KINDS),
  title: layerTitleSchema,
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  color: layerColorSchema.nullish(),
  sort_order: z.number().finite().refine((n) => Math.abs(n) <= 1e12, 'ترتيب غير صالح.').optional(),
  created_at: z.number().int().nonnegative().optional(),
});
export type LayerPayload = z.infer<typeof layerPayloadSchema>;

function parseLayerPayload(op: SyncOp): LayerPayload {
  const r = layerPayloadSchema.safeParse(op.payload);
  if (!r.success) {
    const issues = zodIssuesToFields(r.error).slice(0, 3);
    throw new AppError('VALIDATION_FAILED', `رفض الخادم الطبقة لأن بياناتها غير صالحة. ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join(' ')}`.trim(), 400, { issues });
  }
  if (r.data.id !== undefined && r.data.id !== op.entity_id) throw new AppError('VALIDATION_FAILED', 'معرّف الطبقة داخل البيانات لا يطابق معرّف العملية.', 400);
  return r.data;
}

const PRESENTATION = (r: Pick<LayerRow, 'visible' | 'locked' | 'color' | 'sort_order'>) => ({ visible: r.visible, locked: r.locked, color: r.color, sort_order: r.sort_order });

function layerContentKey(r: Pick<LayerRow, 'document_key' | 'kind' | 'title' | 'visible' | 'locked' | 'color' | 'sort_order'>): string {
  return stableStringify({ d: r.document_key, k: r.kind, t: r.title, ...PRESENTATION(r) });
}

function liveItems(db: Db, layerId: string): number {
  return (
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation WHERE layer_id = ? AND deleted_at IS NULL', [layerId])!.n +
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note WHERE layer_id = ? AND deleted_at IS NULL', [layerId])!.n
  );
}

/** The layer row as it was at `rev` (its before-image in `annotation_revision`), or null when there is none. */
function baseSnapshot(db: Db, id: string, rev: number): LayerRow | null {
  const r = db.get<{ snapshot_json: string }>(`SELECT snapshot_json FROM annotation_revision WHERE entity_type = 'annotation_layer' AND entity_id = ? AND rev = ?`, [id, rev]);
  return r ? (fromJson<LayerRow>(r.snapshot_json) ?? null) : null;
}

export function annotationLayerHandler(db: Db): SyncEntityHandler {
  const serialize = (id: string) => {
    const r = getLayer(db, id);
    return r ? toLayerDTO(r) : null;
  };
  const isClientKind = (k: LayerKind) => (CLIENT_LAYER_KINDS as readonly string[]).includes(k);
  return {
    serialize,
    apply(op, tx): SyncApplyResult {
      if (op.op !== 'upsert' && op.op !== 'delete') throw new AppError('BAD_REQUEST', `العملية «${op.op}» غير مدعومة للطبقات.`, 400);
      const existing = getLayer(tx.db, op.entity_id);

      if (op.op === 'delete') {
        if (!existing) {
          // the default layer is never a row a client may delete; a missing one is nothing to delete
          return { result: 'applied', detail: 'لا توجد هذه الطبقة على الخادم؛ لا شيء يُحذف.' };
        }
        if (existing.deleted_at !== null) return { result: 'duplicate', entity: toLayerDTO(existing) };
        if (existing.id === defaultPersonalLayerId(existing.document_key)) return layerRejection(refuse('layer_forbidden', LAYER_REASONS_AR.default_layer), toLayerDTO(existing));
        if (!isClientKind(existing.kind)) return layerRejection(refuse('layer_read_only', 'هذه الطبقة يديرها الخادم (شرح تتابعه أو نسخة منشورة)؛ لا تُحذف من هنا.'), toLayerDTO(existing));
        if (liveItems(tx.db, existing.id) > 0) {
          return { result: 'rejected', detail: LAYER_REASONS_AR.layer_not_empty, entity: toLayerDTO(existing) };
        }
        recordRevision(tx, 'annotation_layer', existing as unknown as Record<string, unknown>, 'delete', op, { layerId: existing.id, documentKey: existing.document_key });
        tx.db.run('UPDATE annotation_layer SET deleted_at = ?, updated_at = ?, rev = rev + 1, device_id = ? WHERE id = ?', [tx.now, tx.now, tx.deviceId, existing.id]);
        tx.touch('annotation_layer', existing.id);
        return { result: 'applied', entity: serialize(existing.id) };
      }

      const p = parseLayerPayload(op);
      const isDefault = op.entity_id === defaultPersonalLayerId(p.document_key);
      if (!existing) {
        if (!isClientKind(p.kind) || (isDefault && p.kind !== 'personal')) {
          return layerRejection(refuse('layer_forbidden', 'لا يُنشئ الجهاز هذا النوع من الطبقات؛ يُنشئه الخادم وحده.'));
        }
        if (!parseDocumentKey(p.document_key)) throw new AppError('VALIDATION_FAILED', 'مفتاح المستند غير صالح.', 400);
        const created = typeof p.created_at === 'number' && p.created_at > 0 && p.created_at <= tx.now ? p.created_at : tx.now;
        tx.db.run(
          `INSERT INTO annotation_layer (id, document_key, kind, title, owner_user_id, writable, frozen, origin_json, visible, locked, color, sort_order, rev, device_id, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, NULL, 1, 0, NULL, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
          [op.entity_id, p.document_key, p.kind, p.title, p.visible === false ? 0 : 1, p.locked ? 1 : 0, p.color ?? null, p.sort_order ?? (isDefault ? DEFAULT_LAYER_SORT : 0), tx.deviceId, created, tx.now],
        );
        tx.touch('annotation_layer', op.entity_id);
        return { result: 'applied', entity: serialize(op.entity_id) };
      }

      if (existing.document_key !== p.document_key) throw new AppError('VALIDATION_FAILED', 'لا تنتقل طبقة إلى مستند آخر.', 400);
      const clientKind = isClientKind(existing.kind);
      // a server-made layer the server removed is not brought back by a device
      if (existing.deleted_at !== null && !clientKind) return { result: 'duplicate', entity: toLayerDTO(existing) };
      const stale = op.base_rev != null && op.base_rev !== existing.rev;
      // (P1-T2 review) a stale op (another device changed the layer since this one last saw it) carries the WHOLE row:
      // three-way merge with the before-image of the rev it was based on — a field the op did not change keeps the
      // newer value (a lock from the phone never puts back the name the iPad just replaced); a field both changed: the
      // later op wins, the earlier value stays in the layer's history
      const base = stale ? baseSnapshot(tx.db, existing.id, op.base_rev!) : null;
      const merge = <K extends keyof LayerRow>(k: K, incoming: LayerRow[K]): LayerRow[K] => (base && incoming === base[k] ? existing[k] : incoming);
      // server-made layers (followed copies, snapshots, forks): only the presentation of THIS vault's view may change
      const next = {
        kind: merge('kind', clientKind && isClientKind(p.kind) && !(isDefault && p.kind !== 'personal') ? p.kind : existing.kind),
        title: merge('title', clientKind ? p.title : existing.title),
        visible: merge('visible', p.visible === undefined ? existing.visible : p.visible ? 1 : 0),
        locked: merge('locked', p.locked === undefined ? existing.locked : p.locked ? 1 : 0),
        color: merge('color', p.color === undefined ? existing.color : (p.color ?? null)),
        sort_order: merge('sort_order', p.sort_order ?? existing.sort_order),
      };
      const changesProtected = !clientKind && (p.title !== existing.title || p.kind !== existing.kind) && !(base && p.title === base.title && p.kind === base.kind);
      if (changesProtected && layerContentKey({ ...existing, ...next, document_key: existing.document_key }) === layerContentKey(existing)) {
        return layerRejection(refuse('layer_read_only', 'اسم هذه الطبقة ونوعها يحددهما مصدرها؛ لم يُغيَّرا.'), toLayerDTO(existing));
      }
      if (existing.deleted_at === null && layerContentKey({ ...existing, ...next }) === layerContentKey(existing)) return { result: 'duplicate', entity: toLayerDTO(existing) };
      recordRevision(tx, 'annotation_layer', existing as unknown as Record<string, unknown>, existing.deleted_at !== null ? 'restore' : 'update', op, { layerId: existing.id, documentKey: existing.document_key });
      tx.db.run(
        `UPDATE annotation_layer SET kind = ?, title = ?, visible = ?, locked = ?, color = ?, sort_order = ?, deleted_at = NULL, rev = rev + 1, device_id = ?, updated_at = ? WHERE id = ?`,
        [next.kind, next.title, next.visible, next.locked, next.color, next.sort_order, tx.deviceId, tx.now, existing.id],
      );
      tx.touch('annotation_layer', existing.id);
      const notes: string[] = [];
      if (changesProtected) notes.push('اسم هذه الطبقة ونوعها يحددهما مصدرها؛ حُفظت إعدادات العرض فقط.');
      if (stale) notes.push('عُدّلت الطبقة من جهاز آخر؛ حُفظ تعديلك الأحدث، والنسخة السابقة باقية في سجل الطبقة.');
      if (existing.deleted_at !== null) notes.push('كانت الطبقة محذوفة وأعادها تعديلك.');
      return { result: notes.length ? 'merged' : 'applied', entity: serialize(existing.id), ...(notes.length ? { detail: notes.join(' ') } : {}) };
    },
  };
}

// ─── REST helpers (POST / PATCH /api/annotations/layers) ───────────────────────────────────
/** Applies a REST layer write as a sync op of this server (recorded, touched, idempotent by op id like any op). */
export function layerOpPayload(row: LayerRow, patch: Partial<Pick<LayerPayload, 'title' | 'visible' | 'locked' | 'color' | 'sort_order'>>): LayerPayload {
  return {
    id: row.id,
    document_key: row.document_key,
    kind: row.kind,
    title: patch.title ?? row.title,
    visible: patch.visible ?? row.visible === 1,
    locked: patch.locked ?? row.locked === 1,
    color: patch.color === undefined ? row.color : patch.color,
    sort_order: patch.sort_order ?? row.sort_order,
  };
}

export { toJson };
