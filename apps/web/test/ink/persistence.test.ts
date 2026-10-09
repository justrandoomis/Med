// Local-first persistence of ink (§26, §47, §55, AC-24): IndexedDB (fake-indexeddb) + outbox +
// the sync applier, and an end-to-end run against a fake server that follows the annotation merge
// rules of apps/server/src/modules/annotations/sync.ts (append by id, upsert by base_rev, stale edit
// → keep both, delete → tombstone, idempotent op_ids).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  annotationTargetKey,
  newId,
  stableStringify,
  type AnnotationAnchor,
  type AnnotationDTO,
  type InkPoint,
  type SyncChange,
  type SyncOp,
  type SyncOpResult,
  type SyncPushRequest,
} from '@medlevo/shared';
import { MedLevoDB, type OutboxRecord } from '../../src/lib/localdb';
import { SyncEngine, type SyncTransport } from '../../src/lib/sync';
import { createAnnotationApplier, registerAnnotationApplier, expectedServerRev } from '../../src/features/workspace/ink/persistence';
import { InkDocumentStore } from '../../src/features/workspace/ink/store';
import { makeInkItem, transformItem, type InkItem } from '../../src/features/workspace/ink/model';
import { onAnnotationRowsChanged } from '../../src/features/workspace/ink/events';

const anchor: AnnotationAnchor = { type: 'page', source_id: 'SRC1', version_id: 'VER1', page_id: 'PAGE1', page_index: 0, space: 'page_norm' };
const KEY = annotationTargetKey(anchor);
const AR = 842 / 595;

let db: MedLevoDB;
let t: number;
const openStores: InkDocumentStore[] = [];

function stroke(id = newId(), y = 0.5): InkItem {
  const points: InkPoint[] = Array.from({ length: 12 }, (_, i) => [0.1 + i * 0.03, y, i * 8, 0.3 + i * 0.03]);
  return makeInkItem({ id, anchor, now: t, z: 1, style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, points, pressureAvailable: true, tiltAvailable: false, pointerType: 'pen' });
}

async function openStore(key = 'doc-1'): Promise<InkDocumentStore> {
  const s = new InkDocumentStore(key, db, () => t);
  openStores.push(s);
  s.attachPage(KEY, anchor, AR);
  await s.whenLoaded(KEY);
  return s;
}

async function opsFor(id: string): Promise<OutboxRecord[]> {
  return db.outbox.where('[entity_type+entity_id]').equals(['annotation', id]).sortBy('seq');
}

beforeEach(async () => {
  db = new MedLevoDB(`ink-test-${newId()}`);
  await db.open();
  t = 1_800_000_000_000;
});

afterEach(async () => {
  for (const s of openStores.splice(0)) {
    await s.flush();
    s.dispose();
  }
  db.close();
});

describe('committing ink (local first)', () => {
  it('a stroke becomes a Dexie row AND an outbox append with the same entity id — no network involved', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const store = await openStore();
    const item = stroke();
    store.commit('كتابة', [{ id: item.id, targetKey: KEY, before: null, after: item }]);
    // the page shows it immediately (memory), before IndexedDB answers
    expect(store.item(KEY, item.id)).toBe(item);
    await store.flush();
    const row = await db.annotations.get(item.id);
    expect(row).toMatchObject({ id: item.id, targetKey: KEY, kind: 'ink', syncState: 'pending_sync', deletedAt: null });
    expect(row!.data).toEqual(item.data);
    const ops = await opsFor(item.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity_type: 'annotation', entity_id: item.id, op: 'append', status: 'pending' });
    expect((ops[0]!.payload as AnnotationDTO).id).toBe(item.id);
    expect((ops[0]!.payload as AnnotationDTO).data).toEqual(item.data);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reload restores the page from IndexedDB (new store instance)', async () => {
    const a = await openStore();
    const s1 = stroke();
    const s2 = stroke(newId(), 0.7);
    a.commit('كتابة', [{ id: s1.id, targetKey: KEY, before: null, after: s1 }]);
    a.commit('كتابة', [{ id: s2.id, targetKey: KEY, before: null, after: s2 }]);
    await a.flush();
    a.dispose();
    const b = await openStore('doc-1-reloaded');
    const ids = b.items(KEY).map((i) => i.id).sort();
    expect(ids).toEqual([s1.id, s2.id].sort());
    expect(b.item(KEY, s1.id)!.data).toEqual(s1.data);
    // history does not survive a reload (documented); the ink does
    expect(b.history.canUndo).toBe(false);
  });

  it('an edit while the append is still queued declares base_rev 1 (never a false conflict); later edits coalesce', async () => {
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    const moved = transformItem(s, [1, 0, 0, 1, 0.05, 0], AR, t + 1);
    store.commit('نقل', [{ id: s.id, targetKey: KEY, before: s, after: moved }]);
    const moved2 = transformItem(moved, [1, 0, 0, 1, 0.05, 0], AR, t + 2);
    store.commit('نقل', [{ id: s.id, targetKey: KEY, before: moved, after: moved2 }]);
    await store.flush();
    const ops = await opsFor(s.id);
    expect(ops.map((o) => o.op)).toEqual(['append', 'upsert']);
    expect(ops[1]!.base_rev).toBe(1);
    expect((ops[1]!.payload as AnnotationDTO).data).toEqual(moved2.data); // full latest state, not a patch
  });

  it('delete is a tombstone (row kept, deletedAt set, delete op); reopening does not show it', async () => {
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    store.commit('محو', [{ id: s.id, targetKey: KEY, before: s, after: null }]);
    expect(store.item(KEY, s.id)).toBeUndefined();
    await store.flush();
    const row = await db.annotations.get(s.id);
    expect(row).toBeDefined();
    expect(row!.deletedAt).toBe(t);
    expect(row!.data).toEqual(s.data); // the writing itself is never discarded
    const ops = await opsFor(s.id);
    expect(ops.map((o) => o.op)).toEqual(['append', 'delete']);
    expect(ops[1]!.base_rev).toBe(1);
    const reopened = await openStore('doc-x');
    expect(reopened.item(KEY, s.id)).toBeUndefined();
  });
});

describe('persistChanges batches', () => {
  it('the same annotation twice in one batch (a retried failed write + a new edit) → append then upsert', async () => {
    const { persistChanges } = await import('../../src/features/workspace/ink/persistence');
    const s = stroke();
    const moved = transformItem(s, [1, 0, 0, 1, 0.1, 0], AR, t + 1);
    await persistChanges(db, [
      { id: s.id, targetKey: KEY, before: null, after: s },
      { id: s.id, targetKey: KEY, before: s, after: moved },
    ], t);
    const ops = await opsFor(s.id);
    expect(ops.map((o) => o.op)).toEqual(['append', 'upsert']);
    expect(ops[1]!.base_rev).toBe(1);
    expect((await db.annotations.get(s.id))!.data).toEqual(moved.data);
  });

  it('a failed IndexedDB write is reported, kept in memory and retried (never dropped)', async () => {
    const store = await openStore();
    const s = stroke();
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(() => Promise.reject(new Error('QuotaExceededError')) as never);
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    await store.flush();
    expect(store.getStatus().state).toBe('error');
    expect(store.item(KEY, s.id)).toBeDefined();
    spy.mockRestore();
    store.retrySave();
    await store.flush();
    expect(store.getStatus().state).toBe('idle');
    expect((await opsFor(s.id)).map((o) => o.op)).toEqual(['append']);
  });
});

describe('undo / redo command stack', () => {
  it('create → undo (tombstone) → redo (restore by upsert, same id)', async () => {
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    expect(store.history.canUndo).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.item(KEY, s.id)).toBeUndefined();
    expect(store.history.canRedo).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.item(KEY, s.id)!.data).toEqual(s.data);
    await store.flush();
    expect((await opsFor(s.id)).map((o) => o.op)).toEqual(['append', 'delete', 'upsert']);
    expect((await db.annotations.get(s.id))!.deletedAt).toBeNull();
  });

  it('point-eraser split undoes as one step: original restored, pieces tombstoned', async () => {
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    const left = stroke(newId());
    const right = stroke(newId());
    store.commit('محو جزئي', [
      { id: s.id, targetKey: KEY, before: s, after: null },
      { id: left.id, targetKey: KEY, before: null, after: left },
      { id: right.id, targetKey: KEY, before: null, after: right },
    ]);
    expect(store.items(KEY).map((i) => i.id).sort()).toEqual([left.id, right.id].sort());
    store.undo();
    expect(store.items(KEY).map((i) => i.id)).toEqual([s.id]);
    await store.flush();
    expect((await db.annotations.get(s.id))!.deletedAt).toBeNull();
    expect((await db.annotations.get(left.id))!.deletedAt).not.toBeNull();
    expect((await db.annotations.get(right.id))!.deletedAt).not.toBeNull();
  });

  it('move, recolor, new edits clear redo; limit keeps memory bounded', async () => {
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    store.setSelection({ targetKey: KEY, ids: [s.id] });
    store.recolorSelection('ink-red');
    expect((store.item(KEY, s.id)!.data as { style: { color: string } }).style.color).toBe('ink-red');
    store.transformSelection([1, 0, 0, 1, 0.1, 0]);
    store.undo();
    store.undo();
    expect(store.item(KEY, s.id)!.data).toEqual(s.data);
    expect(store.history.canRedo).toBe(true);
    store.setSelection({ targetKey: KEY, ids: [s.id] });
    store.rewidthSelection(0.004);
    expect(store.history.canRedo).toBe(false);
  });

  it('history survives remounting the provider for the same document (module registry)', async () => {
    const { getDocumentStore, __resetStores } = await import('../../src/features/workspace/ink/store');
    __resetStores();
    expect(getDocumentStore('same-doc')).toBe(getDocumentStore('same-doc'));
    expect(getDocumentStore('same-doc')).not.toBe(getDocumentStore('other-doc'));
    __resetStores();
  });

  it('copy on one page, paste on another page: new ids and the target page anchor', async () => {
    const store = await openStore();
    const other: AnnotationAnchor = { type: 'page', source_id: 'SRC1', version_id: 'VER1', page_id: 'PAGE2', page_index: 1, space: 'page_norm' };
    const otherKey = annotationTargetKey(other);
    store.attachPage(otherKey, other, AR);
    await store.whenLoaded(otherKey);
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    store.setSelection({ targetKey: KEY, ids: [s.id] });
    expect(store.copySelection()).toBe(1);
    expect(store.paste(otherKey)).toBe(1);
    const pasted = store.items(otherKey);
    expect(pasted).toHaveLength(1);
    expect(pasted[0]!.id).not.toBe(s.id);
    expect(pasted[0]!.anchor).toEqual(other);
    expect(pasted[0]!.data).toEqual(s.data); // same spot on the other page
    await store.flush();
    expect((await opsFor(pasted[0]!.id))[0]!.op).toBe('append');
  });
});

describe('sync applier merge', () => {
  function dto(item: InkItem, patch: Partial<AnnotationDTO> = {}): AnnotationDTO {
    return { ...item, rev: 1, created_at: item.created_at, updated_at: t, ...patch };
  }

  it('a pulled server copy never clobbers a local unsynced edit', async () => {
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    await store.flush();
    const applier = createAnnotationApplier(() => t);
    const server = dto(stroke(s.id, 0.9), { rev: 4 });
    await applier({ seq: 10, entity_type: 'annotation', entity_id: s.id, entity: server }, { db, source: 'pull', localOps: await opsFor(s.id) });
    expect((await db.annotations.get(s.id))!.data).toEqual(s.data);
    expect(store.item(KEY, s.id)!.data).toEqual(s.data);
  });

  it('with no local ops, the server copy is written as synced and the open page updates', async () => {
    const store = await openStore();
    const changed = new Promise<void>((resolve) => {
      const off = onAnnotationRowsChanged(() => {
        off();
        resolve();
      });
    });
    const remote = stroke(newId(), 0.3);
    await createAnnotationApplier(() => t)({ seq: 1, entity_type: 'annotation', entity_id: remote.id, entity: dto(remote, { rev: 2 }) }, { db, source: 'pull', localOps: [] });
    const row = await db.annotations.get(remote.id);
    expect(row).toMatchObject({ syncState: 'synced', rev: 2, targetKey: KEY });
    await changed;
    await vi.waitFor(() => expect(store.item(KEY, remote.id)?.data).toEqual(remote.data));
  });

  it('ignores an older copy, stores tombstones, and tombstones (never hard-deletes) what the server no longer has', async () => {
    const applier = createAnnotationApplier(() => t);
    const s = stroke();
    await applier({ seq: 5, entity_type: 'annotation', entity_id: s.id, entity: dto(s, { rev: 5 }) }, { db, source: 'pull', localOps: [] });
    await applier({ seq: 3, entity_type: 'annotation', entity_id: s.id, entity: dto(stroke(s.id, 0.1), { rev: 3 }) }, { db, source: 'pull', localOps: [] });
    expect((await db.annotations.get(s.id))!.data).toEqual(s.data);
    await applier({ seq: 6, entity_type: 'annotation', entity_id: s.id, entity: dto(s, { rev: 6, deleted_at: t }) }, { db, source: 'pull', localOps: [] });
    expect((await db.annotations.get(s.id))!.deletedAt).toBe(t);
    const g = stroke();
    await applier({ seq: 7, entity_type: 'annotation', entity_id: g.id, entity: dto(g, { rev: 1 }) }, { db, source: 'pull', localOps: [] });
    await applier({ seq: 8, entity_type: 'annotation', entity_id: g.id, entity: null }, { db, source: 'pull', localOps: [] });
    const gone = await db.annotations.get(g.id);
    expect(gone).toBeDefined();
    expect(gone!.deletedAt).toBe(t);
  });

  it('after a resolved conflict (server kept both copies) the server version is accepted locally', async () => {
    const applier = createAnnotationApplier(() => t);
    const s = stroke();
    await db.annotations.put({ id: s.id, targetKey: KEY, kind: 'ink', anchor, data: stroke(s.id, 0.2).data, updatedAt: t, syncState: 'conflict', rev: 1 });
    const conflictOp = { op_id: newId(), entity_type: 'annotation', entity_id: s.id, op: 'upsert', payload: {}, client_ts: t, status: 'conflict', result: 'conflict_kept_both', attempts: 1, nextAttemptAt: 0 } as OutboxRecord;
    await applier({ seq: null, entity_type: 'annotation', entity_id: s.id, entity: dto(s, { rev: 3 }) }, { db, source: 'push', localOps: [conflictOp] });
    expect((await db.annotations.get(s.id))!.data).toEqual(s.data);
  });
});

/** Fake server following apps/server/src/modules/annotations/sync.ts (annotation handler). */
class FakeAnnotationServer implements SyncTransport {
  rows = new Map<string, AnnotationDTO & { conflict_of_id?: string | null }>();
  seen = new Map<string, SyncOpResult>();
  changes: SyncChange[] = [];
  seq = 0;
  now = 5_000;
  online = true;

  private touch(id: string) {
    this.changes.push({ seq: ++this.seq, entity_type: 'annotation', entity_id: id, entity: this.rows.get(id) ?? null });
  }
  private content(d: Pick<AnnotationDTO, 'kind' | 'anchor' | 'data' | 'z' | 'locked'>) {
    return stableStringify({ kind: d.kind, anchor: d.anchor, data: d.data, z: d.z, locked: d.locked });
  }
  apply(op: SyncOp): SyncOpResult {
    const ex = this.rows.get(op.entity_id);
    const id = op.entity_id;
    if (op.op === 'delete') {
      if (!ex) return { op_id: op.op_id, result: 'applied' };
      if (ex.deleted_at !== null) return { op_id: op.op_id, result: 'duplicate', entity: ex };
      if (op.base_rev != null && op.base_rev < ex.rev) return { op_id: op.op_id, result: 'conflict_kept_both', entity: ex };
      this.rows.set(id, { ...ex, deleted_at: ++this.now, rev: ex.rev + 1 });
      this.touch(id);
      return { op_id: op.op_id, result: 'applied', entity: this.rows.get(id) };
    }
    const p = op.payload as AnnotationDTO;
    const fields = { kind: p.kind, tool: p.tool, anchor: p.anchor, data: p.data, layer: p.layer, z: p.z ?? 0, locked: !!p.locked, anchor_status: 'ok' as const, previous_anchor: null, input: p.input ?? null };
    if (!ex) {
      this.rows.set(id, { id, ...fields, device_id: op.device_id, rev: 1, created_at: p.created_at ?? this.now, updated_at: ++this.now, deleted_at: null });
      this.touch(id);
      return { op_id: op.op_id, result: 'applied', entity: this.rows.get(id) };
    }
    if (op.op === 'append') return { op_id: op.op_id, result: 'duplicate', entity: ex };
    if (ex.deleted_at !== null) {
      this.rows.set(id, { ...ex, ...fields, rev: ex.rev + 1, deleted_at: null, updated_at: ++this.now });
      this.touch(id);
      return { op_id: op.op_id, result: 'merged', entity: this.rows.get(id) };
    }
    if (op.base_rev != null && op.base_rev === ex.rev) {
      this.rows.set(id, { ...ex, ...fields, rev: ex.rev + 1, updated_at: ++this.now });
      this.touch(id);
      return { op_id: op.op_id, result: 'applied', entity: this.rows.get(id) };
    }
    if (this.content({ ...fields }) === this.content(ex)) return { op_id: op.op_id, result: 'duplicate', entity: ex };
    const copy = newId();
    this.rows.set(copy, { id: copy, ...fields, device_id: op.device_id, rev: 1, created_at: this.now, updated_at: ++this.now, deleted_at: null, conflict_of_id: id });
    this.touch(copy);
    return { op_id: op.op_id, result: 'conflict_kept_both', entity: ex };
  }
  async push(req: SyncPushRequest): Promise<SyncOpResult[]> {
    if (!this.online) throw Object.assign(new Error('offline'), { name: 'ApiError' });
    return req.ops.map((op) => {
      const prev = this.seen.get(op.op_id);
      if (prev) return { ...prev, result: 'duplicate' as const, original_result: prev.result };
      const r = this.apply(op);
      this.seen.set(op.op_id, r);
      return r;
    });
  }
  async pull(since: number, limit: number) {
    const ch = this.changes.filter((c) => c.seq > since).slice(0, limit);
    return { changes: ch, next_since: ch.length ? ch[ch.length - 1]!.seq : since, has_more: false };
  }
  live(): AnnotationDTO[] {
    return [...this.rows.values()].filter((r) => r.deleted_at === null);
  }
}

describe('end to end with the sync engine (AC-24)', () => {
  function engineFor(transport: SyncTransport, online: () => boolean = () => true) {
    const e = new SyncEngine({ db, transport, now: () => t, random: () => 0.5, locks: null, deviceId: 'DEV-A', isOnline: online });
    registerAnnotationApplier(e);
    return e;
  }

  it('writes offline, syncs later; the stroke reaches the server once and later edits are not conflicts', async () => {
    const server = new FakeAnnotationServer();
    let online = false;
    const engine = engineFor(server, () => online);
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    await store.flush();
    await engine.syncNow();
    expect(server.rows.size).toBe(0);
    expect(await engine.entityState('annotation', s.id)).toBe('saved_locally');

    online = true;
    await engine.pushOnce();
    expect(server.rows.get(s.id)!.rev).toBe(1);
    await vi.waitFor(async () => expect((await db.annotations.get(s.id))!.rev).toBe(1));
    expect(await expectedServerRev(db, s.id, 1)).toBe(1);

    // edit → upsert with base_rev 1 → applied (rev 2), no copy
    const moved = transformItem(store.item(KEY, s.id)!, [1, 0, 0, 1, 0.05, 0.02], AR, t + 5);
    store.commit('نقل', [{ id: s.id, targetKey: KEY, before: store.item(KEY, s.id)!, after: moved }]);
    await store.flush();
    await engine.pushOnce();
    expect(server.rows.get(s.id)!.rev).toBe(2);
    expect(server.live()).toHaveLength(1);
    expect(await engine.entityState('annotation', s.id)).toBe('synced');
  });

  it('an edit made while the append is in flight is applied in order (no false conflict)', async () => {
    const server = new FakeAnnotationServer();
    const engine = engineFor(server);
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    const moved = transformItem(s, [1, 0, 0, 1, 0.1, 0], AR, t + 1);
    store.commit('نقل', [{ id: s.id, targetKey: KEY, before: s, after: moved }]);
    await store.flush();
    await engine.pushOnce(); // append (one op per entity per batch)
    await engine.pushOnce(); // upsert base_rev 1
    expect(server.live()).toHaveLength(1);
    expect(server.rows.get(s.id)!.rev).toBe(2);
    expect(server.rows.get(s.id)!.data).toEqual(moved.data);
  });

  it('two devices editing the same stroke keep both versions; a repeated push is counted once', async () => {
    const server = new FakeAnnotationServer();
    const engine = engineFor(server);
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    await store.flush();
    await engine.pushOnce();
    // device B moves the stroke first (rev 1 → 2)
    const fromB = transformItem({ ...s, rev: 1 }, [1, 0, 0, 1, 0, 0.2], AR, t + 3);
    server.apply({ op_id: newId(), device_id: 'DEV-B', entity_type: 'annotation', entity_id: s.id, op: 'upsert', base_rev: 1, payload: fromB, client_ts: t });
    // device A recolors its version based on rev 1 → stale → server keeps both
    store.setSelection({ targetKey: KEY, ids: [s.id] });
    store.recolorSelection('ink-red');
    await store.flush();
    const res = await engine.pushOnce();
    expect(res.results[0]!.result).toBe('conflict_kept_both');
    expect(server.live()).toHaveLength(2); // nothing lost
    expect(await engine.entityState('annotation', s.id)).toBe('conflict');
    // pull brings the copy (A's edit) next to B's version
    await engine.pullOnce();
    const local = (await db.annotations.where('targetKey').equals(KEY).toArray()).filter((r) => !r.deletedAt);
    expect(local).toHaveLength(2);
    // the same op sent again (lost response) is a duplicate, never a second stroke
    const again = await server.push({ ops: [{ op_id: (await opsFor(s.id))[0]!.op_id, device_id: 'DEV-A', entity_type: 'annotation', entity_id: s.id, op: 'append', payload: s, client_ts: t }] });
    expect(again[0]!.result).toBe('duplicate');
    expect(server.live()).toHaveLength(2);
  });

  it('erase then undo on another device: the restore wins over the tombstone (edit concurrent with delete keeps the stroke)', async () => {
    const server = new FakeAnnotationServer();
    const engine = engineFor(server);
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    store.commit('محو', [{ id: s.id, targetKey: KEY, before: s, after: null }]);
    store.undo();
    await store.flush();
    for (let i = 0; i < 3; i++) await engine.pushOnce();
    expect(server.live().map((r) => r.id)).toEqual([s.id]);
    expect(store.item(KEY, s.id)).toBeDefined();
  });
});
