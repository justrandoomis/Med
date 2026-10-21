// Re-homing refused writing (Academic OS P1-T2 step 1; ADR-0004 R2; ARCHITECTURE §0 rule 6 «never lose the owner's
// writing»). The server refuses an op on a layer the owner cannot write (`layer_read_only`, `layer_forbidden`,
// `use_crdt`). Through the sync engine's `onRejected` hook (P1-T1 step 0 seam) this module:
//   * re-creates the refused stroke / note, under an id derived from the refused one (idempotent: delivery is at least
//     once), on «ملاحظاتي» of the same document, and queues it for sync;
//   * puts the original back as the server has it (an existing read-only item), or removes the local-only copy that
//     never landed (a new item) — the writing itself lives on in the re-homed item;
//   * a refused ERASE of a read-only item simply shows the item again (nothing to keep: the owner's stroke is untouched);
//   * marks the refused op settled and tells the owner why (`onRehomed` listeners, Arabic message).
import { REHOMED_NOTICE_AR, REHOMED_UNAVAILABLE_NOTICE_AR, type AnnotationDTO, type NoteDTO, type SyncDetailCode } from '@medlevo/shared';
import type { MedLevoDB, NoteRow, OutboxRecord } from '../../../../lib/localdb';
import { enqueue, type RejectedOp, type SyncEngine } from '../../../../lib/sync';
import { notifySyncedRows } from '../events';
import { itemFromRow, itemFromWire, payloadFromItem, rowFromItem, type InkItem, type InkRow } from '../model';

const LAYER_CODES: ReadonlySet<SyncDetailCode> = new Set(['layer_read_only', 'layer_forbidden', 'use_crdt']);

/** The re-homed copy's id: derived from the refused item, so a second delivery finds it instead of copying twice. */
export function rehomedIdOf(entityId: string): string {
  return `rh_${entityId}`.slice(0, 64);
}

export interface RehomeNotice {
  entityType: 'annotation' | 'note';
  /** the refused item */
  id: string;
  /** the new item on «ملاحظاتي» (null when nothing had to be kept, e.g. a refused erase) */
  rehomedId: string | null;
  message_ar: string;
}

const listeners = new Set<(n: RehomeNotice) => void>();
export function onRehomed(fn: (n: RehomeNotice) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify(n: RehomeNotice) {
  listeners.forEach((l) => {
    try {
      l(n);
    } catch {
      // a listener never breaks re-homing
    }
  });
}

function isLayerRefusal(r: RejectedOp): boolean {
  const code = r.result.detail_code;
  return !!code && LAYER_CODES.has(code);
}

const isDto = (v: unknown): v is AnnotationDTO => !!v && typeof v === 'object' && typeof (v as AnnotationDTO).id === 'string' && !!(v as AnnotationDTO).anchor;

/** The item the refused op carried (its full state: payloads are never patches). */
function itemFromPayload(op: OutboxRecord, now: number): InkItem | null {
  const p = op.payload as Partial<AnnotationDTO> | null;
  if (!p || typeof p !== 'object' || !p.kind || !p.anchor || !p.data) return null;
  return itemFromWire({
    id: op.entity_id,
    kind: p.kind,
    tool: p.tool ?? null,
    anchor: p.anchor,
    data: p.data,
    layer: p.layer ?? 'ink',
    z: p.z ?? 0,
    locked: false,
    anchor_status: p.anchor_status ?? 'ok',
    previous_anchor: p.previous_anchor ?? null,
    input: p.input ?? null,
    device_id: null,
    rev: 0,
    created_at: p.created_at ?? now,
    updated_at: now,
    deleted_at: null,
  });
}

/**
 * (P1-T2 review) The owner's LATER ops of the same item still waiting in the outbox (e.g. the stroke was drawn on a layer
 * the server no longer has, then moved, offline): the server will refuse them the same way, and the re-homed copy is
 * created only once — so it is built from the last of them, not from the first refused op (the move is never lost; an
 * erase afterwards means nothing is re-homed).
 */
async function laterPendingOf(db: MedLevoDB, op: OutboxRecord): Promise<OutboxRecord | undefined> {
  if (op.seq == null) return undefined;
  const ops = await db.outbox.where('[entity_type+entity_id]').equals([op.entity_type, op.entity_id]).toArray();
  return ops
    .filter((o) => o.seq != null && o.seq > op.seq! && o.status === 'pending' && !o.supersededBy)
    .sort((a, b) => a.seq! - b.seq!)
    .at(-1);
}

export async function rehomeAnnotation(rejected: RejectedOp, db: MedLevoDB, now: number = Date.now()): Promise<RehomeNotice | null> {
  if (!isLayerRefusal(rejected)) return null;
  const { op, result } = rejected;
  const server = isDto(result.entity) ? itemFromWire(result.entity) : null;
  const keys = new Set<string>();
  const ids: string[] = [];
  let rehomedId: string | null = null;
  await db.transaction('rw', [db.annotations, db.outbox], async () => {
    const local = (await db.annotations.get(op.entity_id)) as InkRow | undefined;
    const later = await laterPendingOf(db, op);
    if (op.op !== 'delete' && later?.op !== 'delete') {
      const item = (later ? itemFromPayload(later, now) : null) ?? itemFromPayload(op, now) ?? (local ? itemFromRow(local) : null);
      if (item) {
        rehomedId = rehomedIdOf(op.entity_id);
        if (!(await db.annotations.get(rehomedId))) {
          const copy: InkItem = { ...item, id: rehomedId, layer_id: null, rev: 0, created_at: now, updated_at: now, deleted_at: null, locked: false };
          delete copy.author_user_id;
          delete copy.origin;
          delete copy.migrated_from_id;
          const row = rowFromItem(copy, { syncState: 'pending_sync', updatedAt: now, rev: null });
          await db.annotations.put(row);
          await enqueue(db, { entity_type: 'annotation', entity_id: rehomedId, op: 'append', payload: payloadFromItem(copy), client_ts: now });
          keys.add(row.targetKey);
          ids.push(rehomedId);
        }
      }
    }
    // the original: as the server has it, or (never landed) gone from this device — its writing lives on above
    if (server) {
      const row = rowFromItem(server, { syncState: 'synced', updatedAt: server.updated_at ?? now, rev: server.rev ?? null });
      await db.annotations.put(row);
      keys.add(row.targetKey);
      if (local) keys.add(local.targetKey);
    } else if (local && !local.deletedAt) {
      await db.annotations.put({ ...local, deletedAt: now, updatedAt: now, syncState: 'synced' });
      keys.add(local.targetKey);
    }
    ids.push(op.entity_id);
    if (op.seq != null) await db.outbox.update(op.seq, { acknowledgedAt: now });
  });
  if (keys.size) notifySyncedRows([...keys], ids);
  const notice: RehomeNotice = {
    entityType: 'annotation',
    id: op.entity_id,
    rehomedId,
    // (P1-T2 review) say the real reason: a read-only layer, or one that is gone / not writable from a device
    message_ar: rehomedId
      ? result.detail_code === 'layer_read_only'
        ? REHOMED_NOTICE_AR
        : REHOMED_UNAVAILABLE_NOTICE_AR
      : result.detail_code === 'layer_read_only'
        ? 'لم يُمحَ عنصر من طبقة للقراءة فقط؛ أُعيد كما هو على الخادم.'
        : 'لم يُمحَ عنصر لا يُعدَّل من هذا الجهاز؛ أُعيد كما هو على الخادم.',
  };
  notify(notice);
  return notice;
}

export async function rehomeNote(rejected: RejectedOp, db: MedLevoDB, now: number = Date.now()): Promise<RehomeNotice | null> {
  if (!isLayerRefusal(rejected)) return null;
  const { op, result } = rejected;
  const server = result.entity && typeof result.entity === 'object' && typeof (result.entity as NoteDTO).id === 'string' ? (result.entity as NoteDTO) : null;
  let rehomedId: string | null = null;
  await db.transaction('rw', [db.notes, db.outbox], async () => {
    const local = (await db.notes.get(op.entity_id)) as NoteRow | undefined;
    // (P1-T2 review) a later edit of the note still waiting in the outbox is what the owner left last
    const later = await laterPendingOf(db, op);
    if (op.op !== 'delete' && later?.op !== 'delete') {
      const p = ((later?.payload as Partial<NoteDTO> | null | undefined) ?? op.payload ?? {}) as Partial<NoteDTO>;
      if (p.body || local?.body) {
        rehomedId = rehomedIdOf(op.entity_id);
        if (!(await db.notes.get(rehomedId))) {
          const payload = { ...p, id: rehomedId, layer_id: null, created_at: now };
          const row: NoteRow = {
            ...(local ?? ({} as NoteRow)),
            id: rehomedId,
            nodeId: p.node_id ?? local?.nodeId ?? null,
            title: p.title ?? local?.title ?? null,
            body: p.body ?? local?.body,
            anchor: p.anchor ?? local?.anchor ?? null,
            anchorKey: local?.anchorKey ?? null,
            layerId: null,
            rev: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            syncState: 'pending_sync',
          };
          await db.notes.put(row);
          await enqueue(db, { entity_type: 'note', entity_id: rehomedId, op: 'upsert', base_rev: null, payload, client_ts: now });
        }
      }
    }
    if (server) {
      await db.notes.put({ ...(local ?? ({} as NoteRow)), id: server.id, body: server.body, title: server.title, anchor: server.anchor, nodeId: server.node_id, rev: server.rev, createdAt: server.created_at, updatedAt: server.updated_at, deletedAt: server.deleted_at, syncState: 'synced', ...(server.layer_id !== undefined ? { layerId: server.layer_id } : {}) });
    } else if (local && !local.deletedAt) {
      await db.notes.put({ ...local, deletedAt: now, updatedAt: now, syncState: 'synced' });
    }
    if (op.seq != null) await db.outbox.update(op.seq, { acknowledgedAt: now });
  });
  const readOnly = result.detail_code === 'layer_read_only';
  const notice: RehomeNotice = {
    entityType: 'note',
    id: op.entity_id,
    rehomedId,
    message_ar: rehomedId
      ? readOnly
        ? 'نُقلت ملاحظة إلى «ملاحظاتي» لأن الطبقة التي كُتبت عليها للقراءة فقط.'
        : 'نُقلت ملاحظة إلى «ملاحظاتي» لأن الطبقة التي كُتبت عليها لم تعد موجودة أو لا يُكتب فيها من هذا الجهاز.'
      : readOnly
        ? 'لم تُحذف ملاحظة من طبقة للقراءة فقط.'
        : 'لم تُحذف ملاحظة لا تُعدَّل من هذا الجهاز.',
  };
  notify(notice);
  return notice;
}

const registered = new WeakSet<SyncEngine>();

/** Registers the re-homing handlers once per engine (stored rejections are delivered on registration). */
export function registerRehoming(engine: SyncEngine): void {
  if (registered.has(engine)) return;
  registered.add(engine);
  engine.onRejected('annotation', async (r, { db }) => {
    await rehomeAnnotation(r, db);
  });
  engine.onRejected('note', async (r, { db }) => {
    await rehomeNote(r, db);
  });
}
