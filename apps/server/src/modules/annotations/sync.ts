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
import {
  annotationTargetKey,
  newId,
  parseRichText,
  stableStringify,
  type AnnotationAnchor,
  type SyncOp,
} from '@medlevo/shared';
import type { z } from 'zod';
import type { Db } from '../../db/db';
import { AppError } from '../../lib/errors';
import { zodIssuesToFields } from '../../lib/http';
import type { SyncApplyResult, SyncEntityHandler, SyncTx } from '../sync/registry';
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
      data: p.data,
      layer: layerFor(p),
      z: p.z ?? 0,
      locked: p.locked ?? false,
      anchor_status: unresolved ? 'needs_reanchor' : (p.anchor_status ?? 'ok'),
      previous_anchor: unresolved ? ((p.previous_anchor as AnnotationAnchor | null | undefined) ?? anchor) : ((p.previous_anchor as AnnotationAnchor | null | undefined) ?? null),
      input: p.input ?? null,
    },
  };
}

function annotationContentKey(f: Pick<AnnotationFields, 'kind' | 'tool' | 'anchor' | 'data' | 'layer' | 'z' | 'locked'>): string {
  return stableStringify({ kind: f.kind, tool: f.tool, anchor: f.anchor, data: f.data, layer: f.layer, z: f.z, locked: f.locked });
}

function rowContentKey(r: AnnotationRow): string {
  const d = toAnnotationDTO(r);
  return annotationContentKey({ kind: d.kind, tool: d.tool, anchor: d.anchor, data: d.data as Record<string, unknown>, layer: d.layer, z: d.z, locked: d.locked });
}

function insertAnnotation(tx: SyncTx, id: string, f: AnnotationFields, createdAt: number, conflictOf: string | null): void {
  tx.db.run(
    `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, previous_anchor_json, input_json,
                             device_id, rev, created_at, updated_at, deleted_at, conflict_of_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)`,
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
    ],
  );
  writeAnnotationTarget(tx.db, id, f.anchor);
  tx.touch('annotation', id);
}

function updateAnnotation(tx: SyncTx, id: string, f: AnnotationFields, restore: boolean): void {
  tx.db.run(
    `UPDATE annotation SET kind = ?, tool = ?, anchor_json = ?, data_json = ?, layer = ?, z = ?, locked = ?, anchor_status = ?,
            previous_anchor_json = ?, input_json = ?, device_id = ?, rev = rev + 1, updated_at = ?${restore ? ', deleted_at = NULL' : ''}
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
      id,
    ],
  );
  writeAnnotationTarget(tx.db, id, f.anchor);
  tx.touch('annotation', id);
}

const UNRESOLVED_AR = 'الصفحة التي كُتب عليها غير موجودة في هذا الإصدار على الخادم؛ حُفظت الكتابة كما هي في قائمة «تحتاج إعادة ربط».';

export function annotationHandler(db: Db): SyncEntityHandler {
  const serialize = (id: string) => {
    const r = getAnnotation(db, id);
    return r ? toAnnotationDTO(r) : null;
  };
  return {
    serialize,
    apply(op, tx): SyncApplyResult {
      requireOps(op, ['upsert', 'append', 'delete']);
      const existing = getAnnotation(tx.db, op.entity_id);

      if (op.op === 'delete') {
        if (!existing) return { result: 'applied', detail: 'لا توجد هذه الكتابة على الخادم؛ لا شيء يُحذف.' };
        if (existing.deleted_at !== null) return { result: 'duplicate', entity: toAnnotationDTO(existing) };
        if (op.base_rev != null && op.base_rev < existing.rev) {
          // edited on another device after this device last saw it: keep the edited stroke
          return {
            result: 'conflict_kept_both',
            entity: toAnnotationDTO(existing),
            detail: 'لم تُحذف هذه الكتابة لأنها عُدّلت من جهاز آخر بعد آخر مزامنة؛ احتُفظ بالنسخة المعدّلة.',
          };
        }
        tx.db.run('UPDATE annotation SET deleted_at = ?, updated_at = ?, rev = rev + 1, device_id = ? WHERE id = ?', [tx.now, tx.now, tx.deviceId, op.entity_id]);
        tx.touch('annotation', op.entity_id);
        return { result: 'applied', entity: serialize(op.entity_id) };
      }

      const p = parsePayload(annotationPayloadSchema, op);
      const { fields, unresolved } = annotationFields(tx.db, p);
      const detail = unresolved ? UNRESOLVED_AR : undefined;

      if (!existing) {
        insertAnnotation(tx, op.entity_id, fields, clampCreated(p.created_at, tx.now), null);
        return { result: 'applied', entity: serialize(op.entity_id), ...(detail ? { detail } : {}) };
      }
      if (op.op === 'append') {
        // append-only by id: the stroke already exists → counted once
        return { result: 'duplicate', entity: toAnnotationDTO(existing) };
      }
      if (existing.deleted_at !== null) {
        // edit concurrent with a delete (or an undo of an erase): the edited stroke is kept
        updateAnnotation(tx, op.entity_id, fields, true);
        return {
          result: 'merged',
          entity: serialize(op.entity_id),
          detail: 'كانت هذه الكتابة محذوفة على الخادم، وأعادها تعديلك الأحدث كي لا تضيع الكتابة المعدّلة.',
        };
      }
      if (op.base_rev != null && op.base_rev === existing.rev) {
        updateAnnotation(tx, op.entity_id, fields, false);
        return { result: 'applied', entity: serialize(op.entity_id), ...(detail ? { detail } : {}) };
      }
      if (annotationContentKey(fields) === rowContentKey(existing)) {
        return { result: 'duplicate', entity: toAnnotationDTO(existing) };
      }
      // stale edit: keep both — the incoming edit becomes a new annotation next to the server version
      const copyId = newId(tx.now);
      insertAnnotation(tx, copyId, fields, tx.now, existing.id);
      return {
        result: 'conflict_kept_both',
        entity: toAnnotationDTO(existing),
        detail: 'عُدّلت هذه الكتابة من جهاز آخر في الوقت نفسه؛ احتُفظ بالنسختين: نسخة الخادم ونسختك كعنصر منفصل بجانبها.',
      };
    },
  };
}

// ───────────────────────────── note ─────────────────────────────
interface NoteFields {
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

function noteContentKey(f: Pick<NoteFields, 'node_id' | 'title' | 'body' | 'anchor' | 'origin' | 'ai_record'>): string {
  return stableStringify({ node_id: f.node_id, title: f.title, body: f.body, anchor: f.anchor, origin: f.origin, ai_record: f.ai_record });
}

function noteRowContentKey(r: NoteRow): string {
  const d = toNoteDTO(r);
  return noteContentKey({ node_id: d.node_id, title: d.title, body: d.body, anchor: d.anchor, origin: d.origin, ai_record: d.ai_record });
}

function insertNote(tx: SyncTx, id: string, f: NoteFields, createdAt: number, baseRev: number | null, conflictOf: string | null): void {
  tx.db.run(
    `INSERT INTO note (id, node_id, title, body_json, anchor_json, origin, ai_record_json, rev, base_rev, conflict_of_id, device_id,
                       created_at, updated_at, deleted_at, source_id, anchor_target_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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
    ],
  );
  indexNote(tx.db, { id, title: f.title, body: f.body, origin: f.origin, deleted: false });
  tx.touch('note', id);
}

function updateNote(tx: SyncTx, id: string, f: NoteFields, baseRev: number | null, restore: boolean): void {
  tx.db.run(
    `UPDATE note SET node_id = ?, title = ?, body_json = ?, anchor_json = ?, origin = ?, ai_record_json = ?, rev = rev + 1, base_rev = ?,
            device_id = ?, updated_at = ?, source_id = ?, anchor_target_key = ?${restore ? ', deleted_at = NULL' : ''}
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
      if (op.op === 'delete') {
        if (!existing) return { result: 'applied', detail: 'لا توجد هذه الملاحظة على الخادم؛ لا شيء يُحذف.' };
        if (existing.deleted_at !== null) return { result: 'duplicate', entity: toNoteDTO(existing) };
        if (op.base_rev != null && op.base_rev < existing.rev) {
          return {
            result: 'conflict_kept_both',
            entity: toNoteDTO(existing),
            detail: 'لم تُحذف الملاحظة لأنها عُدّلت من جهاز آخر بعد آخر مزامنة؛ احتُفظ بالنص المعدّل.',
          };
        }
        tx.db.run('UPDATE note SET deleted_at = ?, updated_at = ?, rev = rev + 1, device_id = ? WHERE id = ?', [tx.now, tx.now, tx.deviceId, op.entity_id]);
        indexNote(tx.db, { id: op.entity_id, title: null, body: { v: 1, paragraphs: [] }, origin: existing.origin, deleted: true });
        tx.touch('note', op.entity_id);
        return { result: 'applied', entity: serialize(op.entity_id) };
      }

      const p = parsePayload(notePayloadSchema, op);
      const { fields, notes } = noteFields(tx.db, p);
      const baseRev = op.base_rev ?? null;
      const extra = notes.length ? { detail: notes.join(' ') } : {};

      if (!existing) {
        insertNote(tx, op.entity_id, fields, clampCreated(p.created_at, tx.now), baseRev, null);
        return { result: notes.length ? 'merged' : 'applied', entity: serialize(op.entity_id), ...extra };
      }
      if (existing.deleted_at !== null) {
        updateNote(tx, op.entity_id, fields, baseRev, true);
        return {
          result: 'merged',
          entity: serialize(op.entity_id),
          detail: ['كانت هذه الملاحظة محذوفة على الخادم، وأعادها تعديلك الأحدث كي لا يضيع النص.', ...notes].join(' '),
        };
      }
      if (baseRev !== null && baseRev === existing.rev) {
        updateNote(tx, op.entity_id, fields, baseRev, false);
        return { result: notes.length ? 'merged' : 'applied', entity: serialize(op.entity_id), ...extra };
      }
      if (noteContentKey(fields) === noteRowContentKey(existing)) {
        return { result: 'duplicate', entity: toNoteDTO(existing) };
      }
      // concurrent edit: the incoming text is saved as a separate note that points at the original
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
function notePageFields(db: Db, p: NotePagePayload): { fields: NotePagePayload & { node_id: string | null; source_id: string | null }; notes: string[] } {
  const notes: string[] = [];
  let nodeId = p.node_id ?? null;
  let sourceId = p.source_id ?? null;
  let after = p.after_page_index ?? null;
  if (nodeId && !db.get('SELECT 1 AS x FROM library_node WHERE id = ?', [nodeId])) {
    nodeId = null;
    notes.push('المجلد المحدد غير موجود على الخادم؛ حُفظت الصفحة دون مجلد.');
  }
  if (sourceId && !db.get('SELECT 1 AS x FROM source WHERE id = ?', [sourceId])) {
    sourceId = null;
    after = null;
    notes.push('المصدر المرتبط غير موجود على الخادم؛ حُفظت صفحة الملاحظات منفصلة عنه.');
  }
  return { notes, fields: { ...p, node_id: nodeId, source_id: sourceId, after_page_index: after, title: p.title ?? null } };
}

function notePageContentKey(f: { node_id: string | null; source_id: string | null; after_page_index?: number | null | undefined; title?: string | null | undefined; template: string; width: number; height: number; sort_order: number }): string {
  return stableStringify({
    node_id: f.node_id,
    source_id: f.source_id,
    after_page_index: f.after_page_index ?? null,
    title: f.title ?? null,
    template: f.template,
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
  const write = (tx: SyncTx, id: string, f: ReturnType<typeof notePageFields>['fields'], existing: NotePageRow | undefined, createdAt: number) => {
    if (!existing) {
      tx.db.run(
        `INSERT INTO note_page (id, node_id, source_id, after_page_index, title, template, width, height, sort_order, deleted_at, created_at, updated_at, rev, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?)`,
        [id, f.node_id, f.source_id, f.after_page_index ?? null, f.title ?? null, f.template, f.width, f.height, f.sort_order, createdAt, tx.now, tx.deviceId],
      );
    } else {
      tx.db.run(
        `UPDATE note_page SET node_id = ?, source_id = ?, after_page_index = ?, title = ?, template = ?, width = ?, height = ?, sort_order = ?,
                deleted_at = NULL, updated_at = ?, rev = rev + 1, device_id = ? WHERE id = ?`,
        [f.node_id, f.source_id, f.after_page_index ?? null, f.title ?? null, f.template, f.width, f.height, f.sort_order, tx.now, tx.deviceId, id],
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
      const { fields, notes } = notePageFields(tx.db, p);
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
      if (op.base_rev != null && op.base_rev === existing.rev) {
        tx.db.run(
          `UPDATE study_session SET source_id = ?, version_id = ?, mode = ?, view = ?, location_json = ?, scope_json = ?, device_id = ?,
                  rev = rev + 1, updated_at = ? WHERE id = ?`,
          [sourceId, versionId, p.mode, p.view, toJson(p.location), scope, tx.deviceId, tx.now, op.entity_id],
        );
        tx.touch('study_session', op.entity_id);
        return { result: 'applied', entity: serialize(op.entity_id) };
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
}
