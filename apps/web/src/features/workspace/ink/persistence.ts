// Local-first persistence of ink (spec §26, §47, §55; ARCHITECTURE §3.4, §4).
//
//  * Every change is written to IndexedDB together with its outbox op in ONE Dexie transaction
//    (writeAndEnqueue from lib/sync.ts) — never awaiting the network.
//  * New annotation (no local row yet)  → op 'append' (the server inserts it once by id).
//    Edit / restore of an existing one  → op 'upsert' with base_rev = the server rev this state is
//                                          based on (see expectedServerRev).
//    Removal                            → op 'delete' + a local tombstone (deletedAt); never a hard delete.
//  * The sync applier (registered once) merges server rows into Dexie without clobbering local
//    unsynced edits, honours tombstones and ignores stale (older-rev) copies.
import type { AnnotationDTO } from '@medlevo/shared';
import type { AnnotationRow, MedLevoDB, OutboxRecord } from '../../../lib/localdb';
import { writeAndEnqueue, type SyncApplier, type SyncEngine } from '../../../lib/sync';
import { notifySyncedRows } from './events';
import type { ItemChange } from './history';
import { isEngineItem, itemFromRow, payloadFromItem, rowFromItem, type InkItem, type InkRow } from './model';

export const ANNOTATION_ENTITY = 'annotation';

/**
 * The server rev a NEW op for this annotation must declare as base_rev: the last rev the server
 * acknowledged (row or op results), advanced by every op still waiting in the outbox (an append
 * inserts rev 1, an upsert/delete adds one). This keeps an edit made while the stroke's append is
 * still queued from being mistaken for a stale edit (which the server would keep as a copy).
 */
export async function expectedServerRev(db: MedLevoDB, id: string, rowRev: number | null | undefined): Promise<number | null> {
  const ops: OutboxRecord[] = await db.outbox.where('[entity_type+entity_id]').equals([ANNOTATION_ENTITY, id]).sortBy('seq');
  let rev: number | null = rowRev ?? null;
  for (const op of ops) {
    const er = (op.resultEntity as { rev?: unknown } | null | undefined)?.rev;
    if (typeof er === 'number') rev = Math.max(rev ?? 0, er);
  }
  for (const op of ops) {
    if (op.status !== 'pending') continue;
    if (op.op === 'append') rev = rev ?? 1;
    else rev = (op.base_rev ?? rev ?? 0) + 1;
  }
  return rev;
}

/** Writes item changes (+ outbox ops) atomically. Returns the target keys touched. */
export async function persistChanges(db: MedLevoDB, changes: readonly ItemChange[], now: number = Date.now()): Promise<string[]> {
  const keys = new Set<string>();
  await db.transaction('rw', [db.annotations, db.outbox], async () => {
    // one read for the whole batch; `known` follows the writes below (an id may occur twice)
    const ids = changes.map((c) => c.id);
    const found = (await db.annotations.bulkGet(ids)) as Array<InkRow | undefined>;
    const known = new Map<string, InkRow | undefined>();
    ids.forEach((id, i) => {
      if (!known.has(id)) known.set(id, found[i]);
    });
    for (const c of changes) {
      const existing = known.get(c.id);
      if (c.after) {
        const after = { ...c.after, deleted_at: null };
        const row = rowFromItem(after, { syncState: 'pending_sync', updatedAt: now, rev: existing?.rev ?? null });
        keys.add(row.targetKey);
        if (!existing) {
          await writeAndEnqueue(db, db.annotations, row, { entity_type: ANNOTATION_ENTITY, op: 'append', payload: payloadFromItem(after), client_ts: now });
        } else {
          const base = await expectedServerRev(db, c.id, existing.rev);
          await writeAndEnqueue(db, db.annotations, row, { entity_type: ANNOTATION_ENTITY, op: 'upsert', base_rev: base, payload: payloadFromItem(after), client_ts: now });
        }
        known.set(c.id, row);
      } else if (existing && !existing.deletedAt) {
        const base = await expectedServerRev(db, c.id, existing.rev);
        const row: InkRow = { ...existing, deletedAt: now, updatedAt: now, syncState: 'pending_sync' };
        keys.add(row.targetKey);
        await writeAndEnqueue(db, db.annotations, row, { entity_type: ANNOTATION_ENTITY, op: 'delete', base_rev: base, payload: { id: c.id, deleted_at: now }, client_ts: now });
        known.set(c.id, row);
      }
    }
  });
  return [...keys];
}

/** Live (not tombstoned) engine items of one page. */
export async function loadTarget(db: MedLevoDB, targetKey: string): Promise<InkItem[]> {
  const rows = await db.annotations.where('targetKey').equals(targetKey).toArray();
  const out: InkItem[] = [];
  for (const r of rows) {
    if (r.deletedAt) continue;
    const item = itemFromRow(r);
    if (isEngineItem(item)) out.push(item);
  }
  return out;
}

export async function loadRows(db: MedLevoDB, ids: readonly string[]): Promise<Array<AnnotationRow | undefined>> {
  return db.annotations.bulkGet(ids as string[]);
}

// ─── sync applier ─────────────────────────────────────────────────────────────────────────────
function isDto(v: unknown): v is AnnotationDTO {
  return !!v && typeof v === 'object' && typeof (v as AnnotationDTO).id === 'string' && typeof (v as AnnotationDTO).kind === 'string' && !!(v as AnnotationDTO).anchor;
}

/**
 * Does this local op mean the local row holds writing the server does not (verifiably) have?
 *  * pending → not sent / not answered yet;
 *  * rejected, not acknowledged → the server refused it;
 *  * conflict, not acknowledged, whose verdict is NOT conflict_kept_both → the server answered
 *    `rejected` with its own copy (or a `duplicate` whose original verdict we cannot tell): the
 *    owner's version was not kept there, so it must not be replaced by the server copy.
 * After `conflict_kept_both` the server stored the owner's version as its own annotation (which
 * arrives separately), so accepting the server copy for this id loses nothing.
 */
export function holdsUnsyncedWriting(o: OutboxRecord): boolean {
  if (o.status === 'pending') return true;
  if (o.acknowledgedAt) return false;
  if (o.status === 'rejected') return true;
  if (o.status === 'conflict') return o.result !== 'conflict_kept_both';
  return false;
}

/**
 * Applier for pulled / pushed `annotation` entities (ALL annotation kinds, so the reader's text
 * highlights land in the same table). Merge rules:
 *  * a local op that still holds writing the server does not have (holdsUnsyncedWriting) → the
 *    local row is kept untouched; the queued op carries it to the server, which merges by its own
 *    rules (never LWW). The outbox is re-read inside the write transaction: an owner edit that
 *    landed after the engine took its snapshot of local ops is never overwritten.
 *  * a resolved conflict (conflict_kept_both) is safe to replace: the server kept the owner's
 *    version as its own copy, which arrives as a separate annotation.
 *  * older copies (rev lower than the local row's) are ignored; tombstones are stored as tombstones;
 *    an entity the server no longer has is tombstoned locally (never hard-deleted).
 */
export function createAnnotationApplier(now: () => number = Date.now): SyncApplier {
  return async (change, { db, localOps }) => {
    if (localOps.some(holdsUnsyncedWriting)) return;
    const written = await db.transaction('rw', [db.annotations, db.outbox], async () => {
      const ops = await db.outbox.where('[entity_type+entity_id]').equals([ANNOTATION_ENTITY, change.entity_id]).toArray();
      if (ops.some(holdsUnsyncedWriting)) return null;
      const existing = (await db.annotations.get(change.entity_id)) as InkRow | undefined;
      const dto = change.entity;
      if (!isDto(dto)) {
        if (existing && !existing.deletedAt) {
          await db.annotations.put({ ...existing, deletedAt: now(), syncState: 'synced' });
          return { keys: [existing.targetKey], id: existing.id };
        }
        return null;
      }
      if (existing?.rev != null && typeof dto.rev === 'number' && dto.rev < existing.rev) return null;
      // the same server revision is already here (e.g. seeded by the reader's download when the document opened):
      // nothing to write — rewriting 5 000 identical strokes one by one cost a repaint and a live-query run each (I2)
      if (existing && existing.syncState === 'synced' && existing.rev != null && dto.rev === existing.rev && !!existing.deletedAt === !!dto.deleted_at) return null;
      const row = rowFromItem(dto, { syncState: 'synced', updatedAt: dto.updated_at ?? now(), rev: dto.rev ?? null });
      await db.annotations.put(row);
      const keys = new Set([row.targetKey]);
      if (existing && existing.targetKey !== row.targetKey) keys.add(existing.targetKey);
      return { keys: [...keys], id: row.id };
    });
    if (written) notifySyncedRows(written.keys, [written.id]);
  };
}

const registered = new WeakSet<SyncEngine>();

/** Registers the annotation applier once per engine (idempotent; parked changes are delivered). */
export function registerAnnotationApplier(engine: SyncEngine): void {
  if (registered.has(engine)) return;
  registered.add(engine);
  engine.registerApplier(ANNOTATION_ENTITY, createAnnotationApplier());
}

