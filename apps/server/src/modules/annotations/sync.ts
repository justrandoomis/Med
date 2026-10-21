// Sync entity handlers for annotation / note / note_page / study_session (ARCHITECTURE §3.4, spec §47, AC-24).
//
// Merge policies (no blind last-write-wins):
//  annotation  append: insert if absent, else duplicate (ink strokes by id).
//              upsert: absent → insert · base_rev == rev → apply (rev+1) · tombstoned → the edit restores the
//                      stroke (an edit concurrent with a delete keeps the edited stroke) · identical content →
//                      duplicate · stale base_rev → keep both: the incoming edit is stored as a NEW annotation
//                      (conflict_of_id = original) → conflict_kept_both.
//              delete: tombstone (deleted_at, rev+1) · stale base_rev (edited elsewhere since) → the edited stroke
//                      is kept → conflict_kept_both.
//  note        like annotation, but a stale edit becomes a new note with conflict_of_id (conflict_kept_both).
//  note_page   upsert with rev; a stale metadata edit is rejected WITH the server copy (the owner decides);
//              delete = tombstone (a stale delete keeps the page).
//  study_session  upsert only; a stale base_rev means another device saved a position since → rejected with
//              the server copy (never overwritten silently, §46); the client asks the owner.
// Every write touches the change feed in the same transaction; page anchors maintain annotation_target.
//
// Academic OS P1-T2 (ADR-0004 §2.1, ARCHITECTURE_DELTA §4.3, §5.4): annotation and note ops may name a `layer_id`
// (absent → an insert goes to the default personal layer «ملاحظاتي», an edit keeps the item's layer, so an older client
// never moves anything). Layer rules R2–R5 are checked before any write (see ./layers.ts): an op on a read-only,
// collaborative or foreign layer, or on another author's item, is `rejected` with a `detail_code` and the server's
// copy; a conflict copy stays on the actor's own layer (R3). Every update, delete and restore writes a before-image
// into `annotation_revision` in the same transaction (./history.ts). Ink v2 (packed points) is accepted and stored as
// v1; answers carry v2 only for clients that sent `accept-ink: 2`.
import {
  annotationTargetKey,
  newId,
  parseRichText,
  stableStringify,
  toInkV1,
  type AnnotationAnchor,
  type InkDataV2,
  type SyncOp,
} from '@medlevo/shared';
import type { z } from 'zod';
import { fromJson, type Db } from '../../db/db';
import { AppError } from '../../lib/errors';
import { zodIssuesToFields } from '../../lib/http';
import type { SerializeOptions, SyncApplyResult, SyncEntityHandler, SyncTx } from '../sync/registry';
import { recordAnnotationRevision, recordNoteRevision } from './history';
import { actorOf, annotationLayerHandler, checkExistingItem, documentKeyOfAnchor, documentKeyOfNote, layerRejection, resolveTargetLayer } from './layers';
import {
  getAnnotation,
  getNote,
  getNotePage,
  getSession,
  indexNote,
  pageAnchorResolves,
  toAnnotationDTO,
  toJson,
  toNoteDTO,
  toNotePageDTO,
  toSessionDTO,
  writeAnnotationTarget,
  type AnnotationRow,
  type NotePageRow,
  type NoteRow,
  type StudySessionRow,
} from './repo';
import {
  annotationPayloadSchema,
  MAX_PAYLOAD_BYTES,
  notePagePayloadSchema,
  notePayloadSchema,
  studySessionPayloadSchema,
  type AnnotationPayload,
  type NotePagePayload,
  type NotePayload,
} from './schemas';

const WHAT_AR: Record<string, string> = {
  annotation: 'الكتابة/التعليق',
  note: 'الملاحظة',
  note_page: 'صفحة الملاحظات',
  study_session: 'موضع الدراسة',
};

function parsePayload<S extends z.ZodType>(schema: S, op: SyncOp): z.output<S> {
  const what = WHAT_AR[op.entity_type] ?? 'العنصر';
  let size = 0;
  try {
    size = JSON.stringify(op.payload ?? null).length;
  } catch {
    throw new AppError('VALIDATION_FAILED', `تعذّر قراءة بيانات ${what}.`, 400);
  }
  if (size > MAX_PAYLOAD_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', `بيانات ${what} أكبر من الحد المسموح للمزامنة.`, 413);
  const r = schema.safeParse(op.payload);
  if (!r.success) {
    const issues = zodIssuesToFields(r.error).slice(0, 3);
    const lines = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join(' ');
    throw new AppError('VALIDATION_FAILED', `رفض الخادم ${what} لأن بياناتها غير صالحة. ${lines}`.trim(), 400, { issues });
  }
  const data = r.data as { id?: string };
  if (data.id !== undefined && data.id !== op.entity_id) {
    throw new AppError('VALIDATION_FAILED', `معرّف ${what} داخل البيانات لا يطابق معرّف العملية.`, 400);
  }
  return r.data;
}

function requireOps(op: SyncOp, allowed: ReadonlyArray<SyncOp['op']>): void {
  if (!allowed.includes(op.op)) {
    const what = WHAT_AR[op.entity_type] ?? 'العنصر';
    throw new AppError('BAD_REQUEST', `العملية «${op.op}» غير مدعومة لـ${what}.`, 400);
  }
}

function clampCreated(createdAt: number | undefined, now: number): number {
  return typeof createdAt === 'number' && createdAt > 0 && createdAt <= now ? createdAt : now;
}

// ───────────────────────────── annotation ─────────────────────────────
function layerFor(p: AnnotationPayload): 'ink' | 'highlight' | 'text' | 'media' {
  if (p.layer) return p.layer;
  if (p.kind === 'text_highlight' || p.kind === 'highlight') return 'highlight';
  if (p.kind === 'text' || p.kind === 'sticky' || p.kind === 'bookmark') return 'text';
  if (p.kind === 'image') return 'media';
  const tool = (p.data as { style?: { tool?: unknown } }).style?.tool;
  return tool === 'highlighter' ? 'highlight' : 'ink';
}

function toolFor(p: AnnotationPayload): string | null {
  if (p.tool) return p.tool;
  const tool = (p.data as { style?: { tool?: unknown } }).style?.tool;
  return typeof tool === 'string' ? tool : null;
}

interface AnnotationFields {
  kind: AnnotationPayload['kind'];
  tool: string | null;
  anchor: AnnotationAnchor;
  data: Record<string, unknown>;
  layer: 'ink' | 'highlight' | 'text' | 'media';
  z: number;
  locked: boolean;
  anchor_status: 'ok' | 'needs_reanchor' | 'reanchored';
  previous_anchor: AnnotationAnchor | null;
  input: AnnotationPayload['input'] | null;
}

/** Normalize a payload into stored fields. A page anchor that does not resolve is kept, flagged needs_reanchor. */
function annotationFields(db: Db, p: AnnotationPayload): { fields: AnnotationFields; unresolved: boolean } {
  const anchor = p.anchor as AnnotationAnchor;
  const unresolved = !pageAnchorResolves(db, anchor);
  return {
    unresolved,
    fields: {
      kind: p.kind,
      tool: toolFor(p),
      anchor,
      // ink v2 (packed points) is stored as v1: one stored format for every reader (re-anchoring, export, recognition)
      data: p.kind === 'ink' && (p.data as { v?: unknown }).v === 2 ? (toInkV1(p.data as unknown as InkDataV2) as unknown as Record<string, unknown>) : p.data,
      layer: layerFor(p),
      z: p.z ?? 0,
      locked: p.locked ?? false,
      anchor_status: unresolved ? 'needs_reanchor' : (p.anchor_status ?? 'ok'),
      previous_anchor: unresolved ? ((p.previous_anchor as AnnotationAnchor | null | undefined) ?? anchor) : ((p.previous_anchor as AnnotationAnchor | null | undefined) ?? null),
      input: p.input ?? null,
    },
  };
}

function annotationContentKey(f: Pick<AnnotationFields, 'kind' | 'tool' | 'anchor' | 'data' | 'layer' | 'z' | 'locked'>, layerId: string | null): string {
  return stableStringify({ kind: f.kind, tool: f.tool, anchor: f.anchor, data: f.data, layer: f.layer, z: f.z, locked: f.locked, layer_id: layerId });
}

function rowContentKey(r: AnnotationRow): string {
  const d = toAnnotationDTO(r);
  return annotationContentKey({ kind: d.kind, tool: d.tool, anchor: d.anchor, data: d.data as Record<string, unknown>, layer: d.layer, z: d.z, locked: d.locked }, r.layer_id ?? null);
}

/**
 * An image annotation now points at its uploaded bytes (prune keeps them while any annotation does). A picture a
 * purge had released (H3 item 10: the copy was still queued on another device) is claimed again.
 */
function markImageReferenced(tx: SyncTx, f: AnnotationFields): void {
  if (f.kind !== 'image') return;
  const key = (f.data as { image_key?: unknown }).image_key;
  if (typeof key === 'string') {
    tx.db.run('UPDATE annotation_image SET referenced = 1, released_at = NULL WHERE image_key = ? AND (referenced = 0 OR released_at IS NOT NULL)', [key]);
  }
}

function insertAnnotation(tx: SyncTx, id: string, f: AnnotationFields, createdAt: number, conflictOf: string | null, layerId: string | null): void {
  tx.db.run(
    `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, previous_anchor_json, input_json,
                             device_id, rev, created_at, updated_at, deleted_at, conflict_of_id, layer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)`,
    [
      id,
      f.kind,
      f.tool,
      toJson(f.anchor),
      toJson(f.data),
      f.layer,
      f.z,
      f.locked,
      f.anchor_status,
      f.previous_anchor ? toJson(f.previous_anchor) : null,
      f.input ? toJson(f.input) : null,
      tx.deviceId,
      createdAt,
      tx.now,
      conflictOf,
      layerId,
    ],
  );
  writeAnnotationTarget(tx.db, id, f.anchor);
  markImageReferenced(tx, f);
  tx.touch('annotation', id);
}

function updateAnnotation(tx: SyncTx, id: string, f: AnnotationFields, restore: boolean, layerId: string | null): void {
  tx.db.run(
    `UPDATE annotation SET kind = ?, tool = ?, anchor_json = ?, data_json = ?, layer = ?, z = ?, locked = ?, anchor_status = ?,
            previous_anchor_json = ?, input_json = ?, device_id = ?, rev = rev + 1, updated_at = ?, layer_id = ?${restore ? ', deleted_at = NULL' : ''}
     WHERE id = ?`,
    [
      f.kind,
      f.tool,
      toJson(f.anchor),
      toJson(f.data),
      f.layer,
      f.z,
      f.locked,
      f.anchor_status,
      f.previous_anchor ? toJson(f.previous_anchor) : null,
      f.input ? toJson(f.input) : null,
      tx.deviceId,
      tx.now,
      layerId,
      id,
    ],
  );
  writeAnnotationTarget(tx.db, id, f.anchor);
  markImageReferenced(tx, f);
  tx.touch('annotation', id);
}

const UNRESOLVED_AR = 'الصفحة التي كُتب عليها غير موجودة في هذا الإصدار على الخادم؛ حُفظت الكتابة كما هي في قائمة «تحتاج إعادة ربط».';

/** Shape kinds added after R1-a whose geometry an R1-a app cannot move without damage (review R10 of N1 wave 2). */
const LEGACY_UNSAFE_SHAPES = new Set(['polygon', 'curved_arrow', 'double_arrow']);
export const LEGACY_SHAPE_AR =
  'هذا الشكل (سهم منحنٍ أو سهم مزدوج أو مضلّع) رُسم بإصدار أحدث من التطبيق، وتحريكه أو تغيير شكله من هذا الإصدار القديم يفسده. أُعيد الشكل كما هو محفوظ على الخادم؛ حدّث التطبيق على هذا الجهاز ثم عدّله.';

/** Would this edit change the geometry of a shape kind the R1-a app cannot transform? */
function legacyClientWouldDamage(existing: AnnotationRow, incoming: AnnotationFields): boolean {
  if (existing.kind !== 'shape') return false;
  const stored = fromJson<Record<string, unknown>>(existing.data_json) ?? {};
  if (!LEGACY_UNSAFE_SHAPES.has(String(stored.shape))) return false;
  const geometry = (d: Record<string, unknown>) => stableStringify([d.shape ?? null, d.from ?? null, d.to ?? null, d.points ?? null, d.control ?? null, d.rotation ?? 0]);
  return incoming.kind !== 'shape' || geometry(incoming.data) !== geometry(stored);
}

export function annotationHandler(db: Db): SyncEntityHandler {
  const serialize = (id: string, opts?: SerializeOptions) => {
    const r = getAnnotation(db, id);
    return r ? toAnnotationDTO(r, { inkFormat: opts?.inkFormat }) : null;
  };
  return {
    serialize,
    apply(op, tx): SyncApplyResult {
      requireOps(op, ['upsert', 'append', 'delete']);
      const fmt = { inkFormat: tx.format?.inkFormat };
      const existing = getAnnotation(tx.db, op.entity_id);
      const actor = actorOf(tx);

      if (op.op === 'delete') {
        if (!existing) return { result: 'applied', detail: 'لا توجد هذه الكتابة على الخادم؛ لا شيء يُحذف.' };
        if (existing.deleted_at !== null) return { result: 'duplicate', entity: toAnnotationDTO(existing, fmt) };
        // R2 / R5: an item of a read-only layer, or another author's item, is never tombstoned (the server's copy is
        // returned so the device shows it again)
        const own = checkExistingItem(tx.db, existing, actor);
        if (!own.ok) return layerRejection(own, toAnnotationDTO(existing, fmt));
        if (op.base_rev != null && op.base_rev < existing.rev) {
          // edited on another device after this device last saw it: keep the edited stroke
          return {
            result: 'conflict_kept_both',
            entity: toAnnotationDTO(existing, fmt),
            detail: 'لم تُحذف هذه الكتابة لأنها عُدّلت من جهاز آخر بعد آخر مزامنة؛ احتُفظ بالنسخة المعدّلة.',
          };
        }
        recordAnnotationRevision(tx, existing as unknown as Record<string, unknown> & AnnotationRow, 'delete', op, actor);
        tx.db.run('UPDATE annotation SET deleted_at = ?, updated_at = ?, rev = rev + 1, device_id = ? WHERE id = ?', [tx.now, tx.now, tx.deviceId, op.entity_id]);
        tx.touch('annotation', op.entity_id);
        return { result: 'applied', entity: serialize(op.entity_id, tx.format) };
      }

      const p = parsePayload(annotationPayloadSchema, op);
      const { fields, unresolved } = annotationFields(tx.db, p);
      const detail = unresolved ? UNRESOLVED_AR : undefined;
      // (Release R1-b; parity N1 wave-2 review R10) an R1-a app does not know these shape kinds: moving one there keeps
      // only its frame (a curved / double arrow's ends normalised — its direction and pathway head can flip — and a
      // polygon's corners left behind). Such an edit is refused WITH the server's copy, so the old app shows a conflict
      // and puts the shape back as stored; deleting, restoring unchanged and recolouring still go through.
      if (tx.format?.legacyClient && existing && op.op === 'upsert' && legacyClientWouldDamage(existing, fields)) {
        return { result: 'rejected', entity: toAnnotationDTO(existing, fmt), detail: LEGACY_SHAPE_AR };
      }
      // the layer the op names (absent: an insert → «ملاحظاتي»; an edit keeps the item's layer — an older client never
      // moves an item off its layer)
      const requested = p.layer_id === undefined ? (existing?.layer_id ?? null) : p.layer_id;
      const target = resolveTargetLayer(tx.db, requested, documentKeyOfAnchor(tx.db, fields.anchor));

      if (!existing) {
        if (!target.ok) return layerRejection(target);
        insertAnnotation(tx, op.entity_id, fields, clampCreated(p.created_at, tx.now), null, target.layerId);
        return { result: 'applied', entity: serialize(op.entity_id, tx.format), ...(detail ? { detail } : {}) };
      }
      if (op.op === 'append') {
        // append-only by id: the stroke already exists → counted once
        return { result: 'duplicate', entity: toAnnotationDTO(existing, fmt) };
      }
      // R2 / R5: an item of a read-only layer or another author's item is not moved, recoloured or re-layered
      const own = checkExistingItem(tx.db, existing, actor);
      if (!own.ok) return layerRejection(own, toAnnotationDTO(existing, fmt));
      if (!target.ok) return layerRejection(target, toAnnotationDTO(existing, fmt));
      const layerId = target.layerId;
      // (H3 item 2) an item the owner re-anchored keeps its previous anchor and its «reanchored» status through later
      // edits from devices whose local copy does not carry them
      if (!fields.previous_anchor && existing.previous_anchor_json) fields.previous_anchor = fromJson<AnnotationAnchor>(existing.previous_anchor_json);
      if (fields.anchor_status === 'ok' && existing.anchor_status === 'reanchored') fields.anchor_status = 'reanchored';
      if (existing.deleted_at !== null) {
        // edit concurrent with a delete (or an undo of an erase): the edited stroke is kept
        recordAnnotationRevision(tx, existing as unknown as Record<string, unknown> & AnnotationRow, 'restore', op, actor);
        updateAnnotation(tx, op.entity_id, fields, true, layerId);
        return {
          result: 'merged',
          entity: serialize(op.entity_id, tx.format),
          detail: 'كانت هذه الكتابة محذوفة على الخادم، وأعادها تعديلك الأحدث كي لا تضيع الكتابة المعدّلة.',
        };
      }
      if (op.base_rev != null && op.base_rev === existing.rev) {
        recordAnnotationRevision(tx, existing as unknown as Record<string, unknown> & AnnotationRow, 'update', op, actor);
        updateAnnotation(tx, op.entity_id, fields, false, layerId);
        return { result: 'applied', entity: serialize(op.entity_id, tx.format), ...(detail ? { detail } : {}) };
      }
      const incomingKey = annotationContentKey(fields, layerId);
      if (incomingKey === rowContentKey(existing)) {
        return { result: 'duplicate', entity: toAnnotationDTO(existing, fmt) };
      }
      // the same stale edit arriving again under a new op id (G7 / AC-24: a «retry» re-built on the device) is
      // already kept as a copy next to the original — never a second identical copy
      const sameCopy = tx.db
        .all<AnnotationRow>('SELECT * FROM annotation WHERE conflict_of_id = ? AND deleted_at IS NULL', [existing.id])
        .find((c) => rowContentKey(c) === incomingKey);
      if (sameCopy) {
        return { result: 'duplicate', entity: toAnnotationDTO(existing, fmt), detail: 'هذا التعديل محفوظ مسبقًا كعنصر منفصل بجانب نسخة الخادم؛ لم تُنشأ نسخة مكررة.' };
      }
      // stale edit: keep both — the incoming edit becomes a new annotation next to the server version, on the layer the
      // actor's op named (validated writable for the actor above: R3, a conflict copy stays with its author)
      const copyId = newId(tx.now);
      insertAnnotation(tx, copyId, fields, tx.now, existing.id, layerId);
      return {
        result: 'conflict_kept_both',
        entity: toAnnotationDTO(existing, fmt),
        detail: 'عُدّلت هذه الكتابة من جهاز آخر في الوقت نفسه؛ احتُفظ بالنسختين: نسخة الخادم ونسختك كعنصر منفصل بجانبها.',
      };
    },
  };
}

// ───────────────────────────── note ─────────────────────────────
interface NoteFields {
  /** (P1-T2) authorship layer; resolved by the handler (NULL = «ملاحظاتي») */
  layer_id?: string | null;
  node_id: string | null;
  title: string | null;
  body: NotePayload['body'];
  anchor: AnnotationAnchor | null;
  origin: 'owner' | 'ai_answer' | 'handwriting_recognition';
  ai_record: Record<string, unknown> | null;
  source_id: string | null;
  anchor_target_key: string | null;
}

function noteFields(db: Db, p: NotePayload): { fields: NoteFields; notes: string[] } {
  const notes: string[] = [];
  let nodeId = p.node_id ?? null;
  if (nodeId && !db.get('SELECT 1 AS x FROM library_node WHERE id = ?', [nodeId])) {
    nodeId = null;
    notes.push('المجلد المحدد غير موجود على الخادم؛ حُفظت الملاحظة دون مجلد.');
  }
  const anchor = (p.anchor as AnnotationAnchor | null | undefined) ?? null;
  let sourceId: string | null = null;
  if (anchor?.type === 'page') {
    sourceId = db.get('SELECT 1 AS x FROM source WHERE id = ?', [anchor.source_id]) ? anchor.source_id : null;
    if (!sourceId) notes.push('المصدر المرتبط بالملاحظة غير موجود على الخادم؛ حُفظت الملاحظة مع موضعها السابق.');
  } else if (anchor?.type === 'note_page') {
    sourceId = db.get<{ source_id: string | null }>('SELECT source_id FROM note_page WHERE id = ?', [anchor.note_page_id])?.source_id ?? null;
  }
  return {
    notes,
    fields: {
      node_id: nodeId,
      title: p.title ?? null,
      // validated by richTextSchema; parseRichText strips bidi control characters from every run (§21)
      body: parseRichText(p.body),
      anchor,
      origin: p.origin ?? 'owner',
      ai_record: p.ai_record ?? null,
      source_id: sourceId,
      anchor_target_key: anchor ? annotationTargetKey(anchor) : null,
    },
  };
}

function noteContentKey(f: Pick<NoteFields, 'node_id' | 'title' | 'body' | 'anchor' | 'origin' | 'ai_record'>, layerId: string | null): string {
  return stableStringify({ node_id: f.node_id, title: f.title, body: f.body, anchor: f.anchor, origin: f.origin, ai_record: f.ai_record, layer_id: layerId });
}

function noteRowContentKey(r: NoteRow): string {
  const d = toNoteDTO(r);
  return noteContentKey({ node_id: d.node_id, title: d.title, body: d.body, anchor: d.anchor, origin: d.origin, ai_record: d.ai_record }, r.layer_id ?? null);
}

function insertNote(tx: SyncTx, id: string, f: NoteFields, createdAt: number, baseRev: number | null, conflictOf: string | null): void {
  tx.db.run(
    `INSERT INTO note (id, node_id, title, body_json, anchor_json, origin, ai_record_json, rev, base_rev, conflict_of_id, device_id,
                       created_at, updated_at, deleted_at, source_id, anchor_target_key, layer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      id,
      f.node_id,
      f.title,
      toJson(f.body),
      f.anchor ? toJson(f.anchor) : null,
      f.origin,
      f.ai_record ? toJson(f.ai_record) : null,
      baseRev,
      conflictOf,
      tx.deviceId,
      createdAt,
      tx.now,
      f.source_id,
      f.anchor_target_key,
      f.layer_id ?? null,
    ],
  );
  indexNote(tx.db, { id, title: f.title, body: f.body, origin: f.origin, deleted: false });
  tx.touch('note', id);
}

function updateNote(tx: SyncTx, id: string, f: NoteFields, baseRev: number | null, restore: boolean): void {
  tx.db.run(
    `UPDATE note SET node_id = ?, title = ?, body_json = ?, anchor_json = ?, origin = ?, ai_record_json = ?, rev = rev + 1, base_rev = ?,
            device_id = ?, updated_at = ?, source_id = ?, anchor_target_key = ?, layer_id = ?${restore ? ', deleted_at = NULL' : ''}
     WHERE id = ?`,
    [
      f.node_id,
      f.title,
      toJson(f.body),
      f.anchor ? toJson(f.anchor) : null,
      f.origin,
      f.ai_record ? toJson(f.ai_record) : null,
      baseRev,
      tx.deviceId,
      tx.now,
      f.source_id,
      f.anchor_target_key,
      f.layer_id ?? null,
      id,
    ],
  );
  indexNote(tx.db, { id, title: f.title, body: f.body, origin: f.origin, deleted: false });
  tx.touch('note', id);
}

export function noteHandler(db: Db): SyncEntityHandler {
  const serialize = (id: string) => {
    const r = getNote(db, id);
    return r ? toNoteDTO(r) : null;
  };
  return {
    serialize,
    apply(op, tx): SyncApplyResult {
      requireOps(op, ['upsert', 'delete']);
      const existing = getNote(tx.db, op.entity_id);
      const actor = actorOf(tx);
      if (op.op === 'delete') {
        if (!existing) return { result: 'applied', detail: 'لا توجد هذه الملاحظة على الخادم؛ لا شيء يُحذف.' };
        if (existing.deleted_at !== null) return { result: 'duplicate', entity: toNoteDTO(existing) };
        const own = checkExistingItem(tx.db, existing, actor);
        if (!own.ok) return layerRejection(own, toNoteDTO(existing));
        if (op.base_rev != null && op.base_rev < existing.rev) {
          return {
            result: 'conflict_kept_both',
            entity: toNoteDTO(existing),
            detail: 'لم تُحذف الملاحظة لأنها عُدّلت من جهاز آخر بعد آخر مزامنة؛ احتُفظ بالنص المعدّل.',
          };
        }
        recordNoteRevision(tx, existing as unknown as Record<string, unknown> & NoteRow, 'delete', op, actor);
        tx.db.run('UPDATE note SET deleted_at = ?, updated_at = ?, rev = rev + 1, device_id = ? WHERE id = ?', [tx.now, tx.now, tx.deviceId, op.entity_id]);
        indexNote(tx.db, { id: op.entity_id, title: null, body: { v: 1, paragraphs: [] }, origin: existing.origin, deleted: true });
        tx.touch('note', op.entity_id);
        return { result: 'applied', entity: serialize(op.entity_id) };
      }

      const p = parsePayload(notePayloadSchema, op);
      const { fields, notes } = noteFields(tx.db, p);
      const baseRev = op.base_rev ?? null;
      const extra = notes.length ? { detail: notes.join(' ') } : {};
      // the layer the op names (absent: an insert → «ملاحظاتي»; an edit keeps the note's layer)
      const requested = p.layer_id === undefined ? (existing?.layer_id ?? null) : p.layer_id;
      const target = resolveTargetLayer(tx.db, requested, documentKeyOfNote(tx.db, fields));
      if (!target.ok) return layerRejection(target, existing ? toNoteDTO(existing) : undefined);
      fields.layer_id = target.layerId;

      if (!existing) {
        insertNote(tx, op.entity_id, fields, clampCreated(p.created_at, tx.now), baseRev, null);
        return { result: notes.length ? 'merged' : 'applied', entity: serialize(op.entity_id), ...extra };
      }
      const own = checkExistingItem(tx.db, existing, actor);
      if (!own.ok) return layerRejection(own, toNoteDTO(existing));
      if (existing.deleted_at !== null) {
        recordNoteRevision(tx, existing as unknown as Record<string, unknown> & NoteRow, 'restore', op, actor);
        updateNote(tx, op.entity_id, fields, baseRev, true);
        return {
          result: 'merged',
          entity: serialize(op.entity_id),
          detail: ['كانت هذه الملاحظة محذوفة على الخادم، وأعادها تعديلك الأحدث كي لا يضيع النص.', ...notes].join(' '),
        };
      }
      if (baseRev !== null && baseRev === existing.rev) {
        recordNoteRevision(tx, existing as unknown as Record<string, unknown> & NoteRow, 'update', op, actor);
        updateNote(tx, op.entity_id, fields, baseRev, false);
        return { result: notes.length ? 'merged' : 'applied', entity: serialize(op.entity_id), ...extra };
      }
      const incomingKey = noteContentKey(fields, target.layerId);
      if (incomingKey === noteRowContentKey(existing)) {
        return { result: 'duplicate', entity: toNoteDTO(existing) };
      }
      // the same concurrent edit arriving again under a new op id (G7 / AC-24) is already saved as a separate note
      const sameCopy = tx.db
        .all<NoteRow>('SELECT * FROM note WHERE conflict_of_id = ? AND deleted_at IS NULL', [existing.id])
        .find((c) => noteRowContentKey(c) === incomingKey);
      if (sameCopy) {
        return { result: 'duplicate', entity: toNoteDTO(existing), detail: 'نصك محفوظ مسبقًا كملاحظة منفصلة بجانب الأصل؛ لم تُنشأ نسخة مكررة.' };
      }
      // concurrent edit: the incoming text is saved as a separate note that points at the original (on the actor's layer, R3)
      const copyId = newId(tx.now);
      insertNote(tx, copyId, fields, tx.now, baseRev, existing.id);
      return {
        result: 'conflict_kept_both',
        entity: toNoteDTO(existing),
        detail: 'عُدّلت هذه الملاحظة من جهاز آخر في الوقت نفسه؛ حُفظ نصك كملاحظة منفصلة بجانب الأصل ولم يُحذف شيء.',
      };
    },
  };
}

// ───────────────────────────── note_page ─────────────────────────────
type NotePageFields = NotePagePayload & { node_id: string | null; source_id: string | null; after_page_id: string | null; color: string | null };

function notePageFields(db: Db, p: NotePagePayload): { fields: NotePageFields; notes: string[] } {
  const notes: string[] = [];
  let nodeId = p.node_id ?? null;
  let sourceId = p.source_id ?? null;
  let after = p.after_page_index ?? null;
  let afterPageId = p.after_page_id ?? null;
  if (nodeId && !db.get('SELECT 1 AS x FROM library_node WHERE id = ?', [nodeId])) {
    nodeId = null;
    notes.push('المجلد المحدد غير موجود على الخادم؛ حُفظت الصفحة دون مجلد.');
  }
  if (sourceId && !db.get('SELECT 1 AS x FROM source WHERE id = ?', [sourceId])) {
    sourceId = null;
    after = null;
    afterPageId = null;
    notes.push('المصدر المرتبط غير موجود على الخادم؛ حُفظت صفحة الملاحظات منفصلة عنه.');
  }
  if (afterPageId) {
    // the page it follows must be a page of that source (any version); otherwise the index alone places it
    const pg = db.get<{ source_id: string }>('SELECT v.source_id FROM source_page p JOIN source_version v ON v.id = p.version_id WHERE p.id = ?', [afterPageId]);
    if (!pg || pg.source_id !== sourceId) {
      afterPageId = null;
      notes.push('الصفحة التي أُضيفت صفحة الملاحظات بعدها غير موجودة في هذا المصدر على الخادم؛ تبقى في موضعها برقم الصفحة.');
    }
  }
  return {
    notes,
    fields: { ...p, node_id: nodeId, source_id: sourceId, after_page_index: after, after_page_id: afterPageId, title: p.title ?? null, color: p.color ?? null },
  };
}

/** (H3 item 7) A page that lost BOTH its notebook and its source is kept and listed in «صفحات بلا دفتر». */
const ORPHAN_PAGE_AR = 'لم تعد الصفحة تتبع دفترًا ولا مصدرًا؛ حُفظت مع ما كُتب عليها في «صفحات بلا دفتر» في المكتبة، ومن هناك تنقلها إلى دفتر أو تحذفها.';
function orphanNotes(f: NotePageFields, p: NotePagePayload, notes: string[]): string[] {
  const lostLink = (p.node_id && !f.node_id) || (p.source_id && !f.source_id);
  return !f.node_id && !f.source_id && lostLink ? [...notes, ORPHAN_PAGE_AR] : notes;
}

function notePageContentKey(f: {
  node_id: string | null;
  source_id: string | null;
  after_page_index?: number | null | undefined;
  after_page_id?: string | null | undefined;
  title?: string | null | undefined;
  template: string;
  kind?: string | null | undefined;
  page_kind?: string | null | undefined;
  color?: string | null | undefined;
  width: number;
  height: number;
  sort_order: number;
}): string {
  return stableStringify({
    node_id: f.node_id,
    source_id: f.source_id,
    after_page_index: f.after_page_index ?? null,
    after_page_id: f.after_page_id ?? null,
    title: f.title ?? null,
    template: f.template,
    kind: f.kind ?? f.page_kind ?? 'page',
    color: f.color ?? null,
    width: f.width,
    height: f.height,
    sort_order: f.sort_order,
  });
}

export function notePageHandler(db: Db): SyncEntityHandler {
  const serialize = (id: string) => {
    const r = getNotePage(db, id);
    return r ? toNotePageDTO(r) : null;
  };
  const write = (tx: SyncTx, id: string, f: NotePageFields, existing: NotePageRow | undefined, createdAt: number) => {
    if (!existing) {
      tx.db.run(
        `INSERT INTO note_page (id, node_id, source_id, after_page_index, title, template, width, height, sort_order, deleted_at, created_at, updated_at, rev, device_id,
                                page_kind, color, after_page_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?, ?)`,
        [id, f.node_id, f.source_id, f.after_page_index ?? null, f.title ?? null, f.template, f.width, f.height, f.sort_order, createdAt, tx.now, tx.deviceId, f.kind, f.color, f.after_page_id],
      );
    } else {
      tx.db.run(
        `UPDATE note_page SET node_id = ?, source_id = ?, after_page_index = ?, title = ?, template = ?, width = ?, height = ?, sort_order = ?,
                deleted_at = NULL, updated_at = ?, rev = rev + 1, device_id = ?, page_kind = ?, color = ?, after_page_id = ? WHERE id = ?`,
        [f.node_id, f.source_id, f.after_page_index ?? null, f.title ?? null, f.template, f.width, f.height, f.sort_order, tx.now, tx.deviceId, f.kind, f.color, f.after_page_id, id],
      );
    }
    tx.touch('note_page', id);
  };
  return {
    serialize,
    apply(op, tx): SyncApplyResult {
      requireOps(op, ['upsert', 'delete']);
      const existing = getNotePage(tx.db, op.entity_id);
      if (op.op === 'delete') {
        if (!existing) return { result: 'applied', detail: 'لا توجد صفحة الملاحظات هذه على الخادم؛ لا شيء يُحذف.' };
        if (existing.deleted_at !== null) return { result: 'duplicate', entity: toNotePageDTO(existing) };
        if (op.base_rev != null && op.base_rev < existing.rev) {
          return { result: 'conflict_kept_both', entity: toNotePageDTO(existing), detail: 'لم تُحذف صفحة الملاحظات لأنها عُدّلت من جهاز آخر بعد آخر مزامنة.' };
        }
        tx.db.run('UPDATE note_page SET deleted_at = ?, updated_at = ?, rev = rev + 1, device_id = ? WHERE id = ?', [tx.now, tx.now, tx.deviceId, op.entity_id]);
        tx.touch('note_page', op.entity_id);
        return { result: 'applied', entity: serialize(op.entity_id) };
      }
      const p = parsePayload(notePagePayloadSchema, op);
      const placed = notePageFields(tx.db, p);
      const fields = placed.fields;
      const notes = orphanNotes(fields, p, placed.notes);
      const extra = notes.length ? { detail: notes.join(' ') } : {};
      if (!existing) {
        write(tx, op.entity_id, fields, undefined, clampCreated(p.created_at, tx.now));
        return { result: notes.length ? 'merged' : 'applied', entity: serialize(op.entity_id), ...extra };
      }
      if (existing.deleted_at !== null) {
        write(tx, op.entity_id, fields, existing, existing.created_at);
        return { result: 'merged', entity: serialize(op.entity_id), detail: ['كانت صفحة الملاحظات محذوفة على الخادم، وأعادها تعديلك.', ...notes].join(' ') };
      }
      if (op.base_rev != null && op.base_rev === existing.rev) {
        write(tx, op.entity_id, fields, existing, existing.created_at);
        return { result: notes.length ? 'merged' : 'applied', entity: serialize(op.entity_id), ...extra };
      }
      if (notePageContentKey(fields) === notePageContentKey(existing)) return { result: 'duplicate', entity: toNotePageDTO(existing) };
      return {
        result: 'rejected',
        entity: toNotePageDTO(existing),
        detail: 'غُيّرت بيانات صفحة الملاحظات من جهاز آخر بعد آخر مزامنة؛ لم يُكتب فوقها. راجع النسختين واختر.',
      };
    },
  };
}

// ───────────────────────────── study_session ─────────────────────────────
/** The same reading place: source, version, view and the page (by id, else index) / Study Book block. */
function samePlace(existing: StudySessionRow, sourceId: string | null, versionId: string | null, view: string, loc: { page_id?: string; page_index?: number; block_key?: string }): boolean {
  const cur = (fromJson<{ page_id?: string; page_index?: number; block_key?: string }>(existing.location_json) ?? {}) as { page_id?: string; page_index?: number; block_key?: string };
  if (existing.source_id !== sourceId || existing.version_id !== versionId || existing.view !== view) return false;
  if ((cur.block_key ?? null) !== (loc.block_key ?? null)) return false;
  if (cur.page_id && loc.page_id) return cur.page_id === loc.page_id;
  return (cur.page_index ?? null) === (loc.page_index ?? null) && (cur.page_id ?? null) === (loc.page_id ?? null);
}

export function studySessionHandler(db: Db): SyncEntityHandler {
  const serialize = (id: string) => {
    const r = getSession(db, id);
    return r ? toSessionDTO(r) : null;
  };
  return {
    serialize,
    apply(op, tx): SyncApplyResult {
      requireOps(op, ['upsert']);
      const p = parsePayload(studySessionPayloadSchema, op);
      const sourceId = p.source_id ?? null;
      const versionId = p.version_id ?? null;
      if (sourceId && !tx.db.get('SELECT 1 AS x FROM source WHERE id = ?', [sourceId])) {
        throw new AppError('NOT_FOUND', 'المصدر الذي يخص موضع الدراسة غير موجود على الخادم.', 404);
      }
      if (versionId) {
        const v = tx.db.get<{ source_id: string }>('SELECT source_id FROM source_version WHERE id = ?', [versionId]);
        if (!v || (sourceId && v.source_id !== sourceId)) {
          throw new AppError('NOT_FOUND', 'إصدار المصدر المحفوظ في موضع الدراسة غير موجود أو لا يخص هذا المصدر.', 404);
        }
      }
      const existing = getSession(tx.db, op.entity_id);
      const scope = p.scope === undefined || p.scope === null ? null : toJson(p.scope);
      if (!existing) {
        tx.db.run(
          `INSERT INTO study_session (id, source_id, version_id, mode, view, location_json, scope_json, device_id, rev, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [op.entity_id, sourceId, versionId, p.mode, p.view, toJson(p.location), scope, tx.deviceId, clampCreated(p.created_at, tx.now), tx.now],
        );
        tx.touch('study_session', op.entity_id);
        return { result: 'applied', entity: serialize(op.entity_id) };
      }
      const write = () => {
        tx.db.run(
          `UPDATE study_session SET source_id = ?, version_id = ?, mode = ?, view = ?, location_json = ?, scope_json = ?, device_id = ?,
                  rev = rev + 1, updated_at = ? WHERE id = ?`,
          [sourceId, versionId, p.mode, p.view, toJson(p.location), scope, tx.deviceId, tx.now, op.entity_id],
        );
        tx.touch('study_session', op.entity_id);
      };
      if (op.base_rev != null && op.base_rev === existing.rev) {
        write();
        return { result: 'applied', entity: serialize(op.entity_id) };
      }
      if (samePlace(existing, sourceId, versionId, p.view, p.location)) {
        // G7 / AC-24: both devices are at the same place — nothing to choose between, so the owner is not asked. The
        // newer view preferences (zoom, rail, layout) are taken: preferences are last-write-wins (ARCHITECTURE §3.4).
        write();
        return { result: 'merged', entity: serialize(op.entity_id), detail: 'الجهازان عند الموضع نفسه؛ حُفظت إعدادات العرض الأحدث.' };
      }
      // another device saved a newer position since this device last synced: never overwrite it silently (§46)
      return {
        result: 'rejected',
        entity: toSessionDTO(existing),
        detail: 'حُفظ موضع دراسة أحدث لهذا المصدر من جهاز آخر؛ لم يُكتب فوقه. اختر الموضع الذي تريد المتابعة منه.',
      };
    },
  };
}

export function registerAnnotationSync(sync: { registerEntity(type: string, handler: SyncEntityHandler): void }, db: Db): void {
  sync.registerEntity('annotation', annotationHandler(db));
  sync.registerEntity('note', noteHandler(db));
  sync.registerEntity('note_page', notePageHandler(db));
  sync.registerEntity('study_session', studySessionHandler(db));
  // (P1-T2) authorship layers: a client creates personal / answers / explanation layers and edits their presentation
  sync.registerEntity('annotation_layer', annotationLayerHandler(db));
}
