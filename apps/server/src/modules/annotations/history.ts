// Version history of annotations, notes and layers (Academic OS P1-T2 step 2; ARCHITECTURE_DELTA §4.3, §6.6;
// ADR-0004 §2.8; PRD AOS-4.15 Phase 1).
//
//  * `recordRevision` writes the full stored row BEFORE a change into `annotation_revision`, in the same transaction as
//    the change (every update, delete and restore of an annotation, a note or a layer). Append-only: a revision is
//    never edited; `(entity_type, entity_id, rev)` is unique, so a replayed op cannot write a second before-image.
//  * `listLayerHistory` is the read-only per-layer list of the layers panel («سجل الطبقة»): who, when, what, where.
//    Nothing is restored from it yet (restore and the time machine are Phase 2).
import { defaultPersonalLayerId, type AnnotationAnchor, type LayerHistoryEntry, type LayerHistoryPage, type SyncOp } from '@medlevo/shared';
import { fromJson, type Db } from '../../db/db';
import { AppError } from '../../lib/errors';
import { ANNOTATION_DOC_SQL, documentKeyOfAnchor, documentKeyOfNote, getLayer, NOTE_DOC_SQL } from './layers';
import { pageLabelAr, type PageInfoRow } from './repo';

export type RevisionEntity = 'annotation' | 'note' | 'annotation_layer';
export type RevisionAction = 'update' | 'delete' | 'restore' | 'followed_update' | 'layer_restore';

interface TxLike {
  db: Db;
  now: number;
  deviceId: string;
}

/**
 * Writes the before-image of `before` (the row as stored, `SELECT *`). `where` names the layer (NULL = the default
 * personal layer) and document the item was on before the change. Call inside the writer's transaction, BEFORE the write.
 */
export function recordRevision(
  tx: TxLike,
  entityType: RevisionEntity,
  before: Record<string, unknown>,
  action: RevisionAction,
  op: Pick<SyncOp, 'op_id'> | null,
  where: { layerId: string | null; documentKey: string | null },
  actorUserId: string | null = null,
): void {
  tx.db.run(
    `INSERT OR IGNORE INTO annotation_revision (entity_type, entity_id, rev, action, snapshot_json, actor_user_id, device_id, op_id, at, layer_id, document_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entityType, String(before.id), Number(before.rev ?? 0), action, JSON.stringify(before), actorUserId, tx.deviceId, op?.op_id ?? null, tx.now, where.layerId, where.documentKey],
  );
}

/** Before-image of an annotation row (its layer and document are read from the row itself). */
export function recordAnnotationRevision(tx: TxLike, row: Record<string, unknown> & { anchor_json: string; layer_id?: string | null }, action: RevisionAction, op: Pick<SyncOp, 'op_id'> | null, actorUserId: string | null = null): void {
  const doc = documentKeyOfAnchor(tx.db, fromJson<AnnotationAnchor>(row.anchor_json));
  recordRevision(tx, 'annotation', row, action, op, { layerId: row.layer_id ?? null, documentKey: doc }, actorUserId);
}

/** Before-image of a note row. */
export function recordNoteRevision(
  tx: TxLike,
  row: Record<string, unknown> & { anchor_json: string | null; layer_id?: string | null; source_id?: string | null; node_id: string | null },
  action: RevisionAction,
  op: Pick<SyncOp, 'op_id'> | null,
  actorUserId: string | null = null,
): void {
  const doc = documentKeyOfNote(tx.db, { anchor: row.anchor_json ? (fromJson<AnnotationAnchor>(row.anchor_json) ?? null) : null, source_id: row.source_id ?? null, node_id: row.node_id });
  recordRevision(tx, 'note', row, action, op, { layerId: row.layer_id ?? null, documentKey: doc }, actorUserId);
}

/** The op that made a revision is known only after the write; stamp it (same transaction). */
export function stampRevisionOp(db: Db, entityType: RevisionEntity, entityId: string, rev: number, opId: string): void {
  db.run('UPDATE annotation_revision SET op_id = COALESCE(op_id, ?) WHERE entity_type = ? AND entity_id = ? AND rev = ?', [opId, entityType, entityId, rev]);
}

// ─── the layer history list ──────────────────────────────────────────────────────────────────
/** item names with their grammatical gender (the verb agrees: «أُضيف شكل» / «أُضيفت صورة») */
const KIND_AR: Record<string, { name: string; f: boolean }> = {
  ink: { name: 'كتابة بالقلم', f: true },
  shape: { name: 'شكل', f: false },
  text: { name: 'مربع نص', f: false },
  sticky: { name: 'ملاحظة لاصقة', f: true },
  image: { name: 'صورة', f: true },
  link: { name: 'رابط صفحة', f: false },
  bookmark: { name: 'علامة', f: true },
  highlight: { name: 'تظليل', f: false },
  text_highlight: { name: 'تظليل نص', f: false },
  underline: { name: 'تسطير', f: false },
  note: { name: 'ملاحظة', f: true },
  layer: { name: 'الطبقة', f: true },
};
const ACTION_AR: Record<LayerHistoryEntry['action'], [masculine: string, feminine: string]> = {
  create: ['أُضيف', 'أُضيفت'],
  update: ['عُدّل', 'عُدّلت'],
  delete: ['حُذف', 'حُذفت'],
  restore: ['أُعيد', 'أُعيدت'],
  followed_update: ['حدّثه مصدره:', 'حدّثها مصدرها:'],
  layer_restore: ['استُعيد', 'استُعيدت'],
};

export function historySummaryAr(action: LayerHistoryEntry['action'], kind: string, pageLabel: string | null): string {
  const k = KIND_AR[kind] ?? { name: 'عنصر', f: false };
  const verb = kind === 'layer' && action === 'create' ? 'أُنشئت' : ACTION_AR[action][k.f ? 1 : 0];
  return `${verb} ${k.name}${pageLabel ? ` — ${pageLabel}` : ''}`;
}

interface Raw {
  et: LayerHistoryEntry['entity_type'];
  eid: string;
  rev: number;
  action: LayerHistoryEntry['action'];
  at: number;
  dev: string | null;
  actor: string | null;
  kind: string | null;
  anchor: string | null;
}

/** cursor `<at>:<entity_id>:<rev>` (newest first) */
function parseCursor(before: string | undefined): { at: number; eid: string; rev: number } | null {
  if (!before) return null;
  const m = /^(\d{1,15}):([A-Za-z0-9_-]{1,64}):(\d{1,9})$/.exec(before);
  if (!m) throw new AppError('VALIDATION_FAILED', 'مؤشر الصفحة غير صالح.', 400);
  return { at: Number(m[1]), eid: m[2]!, rev: Number(m[3]) };
}

function pageLabelOf(db: Db, anchorJson: string | null): string | null {
  const a = anchorJson ? fromJson<AnnotationAnchor>(anchorJson) : null;
  if (!a) return null;
  if (a.type === 'page') {
    const p = db.get<PageInfoRow>('SELECT id, version_id, page_index, printed_label, kind FROM source_page WHERE id = ?', [a.page_id]);
    return p ? pageLabelAr(db, p) : `الصفحة ${a.page_index + 1} في الملف`;
  }
  if (a.type === 'note_page') {
    const np = db.get<{ title: string | null }>('SELECT title FROM note_page WHERE id = ?', [a.note_page_id]);
    return np?.title ? `صفحة ملاحظات: ${np.title}` : 'صفحة ملاحظات';
  }
  return 'كتاب الدراسة';
}

/**
 * The history of one layer, newest first: what was added, changed, erased or restored on it, by whom and when.
 * `documentKey` is needed only for a document's default layer before it was ever renamed (it has no row yet).
 */
export function listLayerHistory(db: Db, layerId: string, opts: { documentKey?: string; before?: string; limit: number }): LayerHistoryPage {
  const row = getLayer(db, layerId);
  const documentKey = row?.document_key ?? opts.documentKey ?? null;
  if (!documentKey || (!row && defaultPersonalLayerId(documentKey) !== layerId)) throw new AppError('NOT_FOUND', 'الطبقة غير موجودة.', 404);
  const isDefault = layerId === defaultPersonalLayerId(documentKey);
  const cursor = parseCursor(opts.before);

  const revCond = isDefault ? `document_key = ? AND (layer_id IS NULL OR (entity_type = 'annotation_layer' AND entity_id = ?))` : `layer_id = ?`;
  const revParams = isDefault ? [documentKey, layerId] : [layerId];
  const annCond = isDefault ? `a.layer_id IS NULL AND ${ANNOTATION_DOC_SQL('a')} = ?` : 'a.layer_id = ?';
  const noteCond = isDefault ? `n.layer_id IS NULL AND ${NOTE_DOC_SQL('n')} = ?` : 'n.layer_id = ?';
  const itemParam = isDefault ? documentKey : layerId;
  const cursorSql = cursor ? 'WHERE (at < ? OR (at = ? AND (eid < ? OR (eid = ? AND rev < ?))))' : '';
  const cursorParams = cursor ? [cursor.at, cursor.at, cursor.eid, cursor.eid, cursor.rev] : [];

  const rows = db.all<Raw>(
    `SELECT * FROM (
       SELECT entity_type AS et, entity_id AS eid, rev, action, at, device_id AS dev, actor_user_id AS actor,
              CASE entity_type WHEN 'annotation' THEN json_extract(snapshot_json, '$.kind') WHEN 'note' THEN 'note' ELSE 'layer' END AS kind,
              CASE WHEN entity_type IN ('annotation', 'note') THEN json_extract(snapshot_json, '$.anchor_json') END AS anchor
         FROM annotation_revision WHERE ${revCond}
       UNION ALL
       SELECT 'annotation', a.id, 0, 'create', a.created_at, CASE WHEN a.rev = 1 THEN a.device_id END, a.author_user_id, a.kind, a.anchor_json FROM annotation a WHERE ${annCond}
       UNION ALL
       SELECT 'note', n.id, 0, 'create', n.created_at, CASE WHEN n.rev = 1 THEN n.device_id END, n.author_user_id, 'note', n.anchor_json FROM note n WHERE ${noteCond}
     ) ${cursorSql}
     ORDER BY at DESC, eid DESC, rev DESC LIMIT ?`,
    [...revParams, itemParam, itemParam, ...cursorParams, opts.limit + 1],
  );
  const page = rows.slice(0, opts.limit);
  const entries: LayerHistoryEntry[] = page.map((r) => {
    const kind = r.kind ?? 'ink';
    const page_label_ar = r.et === 'annotation_layer' ? null : pageLabelOf(db, r.anchor);
    return {
      entity_type: r.et,
      entity_id: r.eid,
      rev: r.rev,
      action: r.action,
      at: r.at,
      actor: r.actor ? { id: r.actor, display_name: 'مستخدم آخر', avatar_url: null } : null,
      actor_label_ar: r.actor ? 'مستخدم آخر' : 'أنت',
      device_id: r.dev,
      item_kind: r.et === 'annotation_layer' ? 'layer' : kind,
      summary_ar: historySummaryAr(r.action, r.et === 'annotation_layer' ? 'layer' : kind, page_label_ar),
      page_label_ar,
    };
  });
  const last = page[page.length - 1];
  return { layer_id: layerId, entries, next_before: rows.length > opts.limit && last ? `${last.at}:${last.eid}:${last.rev}` : null };
}

/** Revisions of the given items (purge preview / purge extension). */
export function countRevisionsOf(db: Db, entityType: RevisionEntity, idsSql: string): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM annotation_revision WHERE entity_type = ? AND entity_id IN ${idsSql}`, [entityType])!.n;
}
