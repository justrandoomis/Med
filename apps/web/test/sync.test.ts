import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, type SyncOpResult, type SyncPullResponse, type SyncPushRequest, type SyncResult } from '@medlevo/shared';
import { MedLevoDB, type NoteRow } from '../src/lib/localdb';
import { ApiError, setFetchImpl, setUnauthenticatedHandler } from '../src/lib/api';
import { SyncEngine, enqueue, httpTransport, writeAndEnqueue, type SyncTransport } from '../src/lib/sync';

/**
 * Models the real server's idempotency (apps/server/src/modules/sync/registry.ts): every non-retryable
 * verdict is recorded under its op_id, and a repeated op_id answers `duplicate` + the ORIGINAL result.
 */
class IdempotentServer implements SyncTransport {
  seen = new Map<string, SyncResult>();
  pushes: SyncPushRequest[] = [];
  decide: (op: SyncPushRequest['ops'][number]) => SyncOpResult = (o) => ({ op_id: o.op_id, result: 'applied' });
  async push(req: SyncPushRequest) {
    this.pushes.push(JSON.parse(JSON.stringify(req)) as SyncPushRequest);
    return req.ops.map((o) => {
      const before = this.seen.get(o.op_id);
      if (before) return { op_id: o.op_id, result: 'duplicate' as const, original_result: before };
      const r = this.decide(o);
      if (!r.retryable) this.seen.set(o.op_id, r.result);
      return r;
    });
  }
  async pull(since: number) {
    return { changes: [], next_since: since, has_more: false };
  }
}

class FakeTransport implements SyncTransport {
  pushes: SyncPushRequest[] = [];
  pulls: Array<{ since: number; limit: number }> = [];
  pullQueue: SyncPullResponse[] = [];
  respond: (req: SyncPushRequest) => Promise<SyncOpResult[]> | SyncOpResult[] = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied' }));
  async push(req: SyncPushRequest) {
    this.pushes.push(JSON.parse(JSON.stringify(req)) as SyncPushRequest);
    return this.respond(req);
  }
  async pull(since: number, limit: number) {
    this.pulls.push({ since, limit });
    return this.pullQueue.shift() ?? { changes: [], next_since: since, has_more: false };
  }
}

let db: MedLevoDB;
let transport: FakeTransport;
let t: number;
let online: boolean;
let engine: SyncEngine;
const DEVICE = newId();

function note(id = newId(), text = 'ملاحظة'): NoteRow {
  return { id, updatedAt: t, syncState: 'pending_sync', body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: text }] }] }, rev: null };
}

function makeEngine(opts: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) {
  return new SyncEngine({
    db,
    transport,
    now: () => t,
    random: () => 0.5, // jitter factor exactly 1.0
    locks: null,
    deviceId: DEVICE,
    isOnline: () => online,
    backoffBaseMs: 1000,
    backoffMaxMs: 60_000,
    ...opts,
  });
}

beforeEach(async () => {
  db = new MedLevoDB(`medlevo-test-${newId()}`);
  await db.open();
  transport = new FakeTransport();
  t = 1_800_000_000_000;
  online = true;
  engine = makeEngine();
});

describe('outbox: enqueue', () => {
  it('persists the op in the same transaction as the entity write', async () => {
    const row = note();
    const rec = await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert', base_rev: null });
    expect(rec.status).toBe('pending');
    const name = db.name;
    db.close();
    const reopened = new MedLevoDB(name);
    const ops = await reopened.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity_type: 'note', entity_id: row.id, op: 'upsert', status: 'pending', attempts: 0 });
    expect((await reopened.notes.get(row.id))?.syncState).toBe('pending_sync');
    reopened.close();
  });

  it('refuses to enqueue outside a transaction', async () => {
    await expect(enqueue(db, { entity_type: 'note', entity_id: newId(), op: 'upsert', payload: {} })).rejects.toThrow(/transaction/);
  });

  it('rolls back the entity and the op together', async () => {
    const row = note();
    await expect(
      db.transaction('rw', [db.notes, db.outbox], async () => {
        await db.notes.put(row);
        await enqueue(db, { entity_type: 'note', entity_id: row.id, op: 'upsert', payload: row });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.notes.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('coalesces unsent upserts of the same entity, but never an op already on the wire', async () => {
    const row = note();
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert' });
    await writeAndEnqueue(db, db.notes, { ...row, title: 'v2' }, { entity_type: 'note', op: 'upsert' });
    let ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect((ops[0]!.payload as NoteRow).title).toBe('v2');

    transport.respond = () => {
      throw new ApiError({ code: 'INTERNAL', status: 500, message: 'خطأ في الخادم' });
    };
    await engine.pushOnce(); // marks sentAt
    await writeAndEnqueue(db, db.notes, { ...row, title: 'v3' }, { entity_type: 'note', op: 'upsert' });
    ops = await db.outbox.orderBy('seq').toArray();
    expect(ops).toHaveLength(2);
    expect((ops[0]!.payload as NoteRow).title).toBe('v2');
    expect((ops[1]!.payload as NoteRow).title).toBe('v3');
  });
});

describe('outbox: push', () => {
  it('push marks ops synced and sends op_id/device_id/payload', async () => {
    const row = note();
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert' });
    const r = await engine.pushOnce();
    expect(r.sent).toBe(1);
    expect(transport.pushes).toHaveLength(1);
    const sent = transport.pushes[0]!.ops[0]!;
    expect(sent).toMatchObject({ device_id: DEVICE, entity_type: 'note', entity_id: row.id, op: 'upsert', client_ts: expect.any(Number) });
    expect(sent.op_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const op = (await db.outbox.toArray())[0]!;
    expect(op.status).toBe('synced');
    expect(op.result).toBe('applied');
    expect(await engine.entityState('note', row.id)).toBe('synced');
    expect((await db.notes.get(row.id))?.syncState).toBe('synced');
    const snap = engine.getSnapshot();
    expect(snap.pending).toBe(0);
    expect(snap.state).toBe('synced');
    expect(snap.lastSyncedAt).toBe(t);
    // nothing left to send
    expect((await engine.pushOnce()).sent).toBe(0);
  });

  it('treats duplicate as success (idempotent re-send)', async () => {
    const row = note();
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'duplicate', original_result: 'applied' }));
    await engine.pushOnce();
    expect((await db.outbox.toArray())[0]!.status).toBe('synced');
    expect(await engine.entityState('note', row.id)).toBe('synced');
    expect(engine.getSnapshot().state).toBe('synced');
  });

  it('a duplicate of an op that had conflicted still surfaces the conflict', async () => {
    const row = note();
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'duplicate', original_result: 'conflict_kept_both' }));
    await engine.pushOnce();
    expect(await engine.entityState('note', row.id)).toBe('conflict');
  });

  it('keeps ops queued with exponential backoff on failures and never drops them', async () => {
    const row = note();
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert' });
    transport.respond = () => {
      throw new ApiError({ code: 'INTERNAL', status: 500, message: 'حدث خطأ في الخادم.' });
    };

    let r = await engine.pushOnce();
    expect(r.failed).toBe(true);
    let op = (await db.outbox.toArray())[0]!;
    expect(op.status).toBe('pending');
    expect(op.attempts).toBe(1);
    expect(op.nextAttemptAt).toBe(t + 1000);
    expect(op.lastError).toBe('حدث خطأ في الخادم.');

    // still in backoff → nothing is sent
    r = await engine.pushOnce();
    expect(r.sent).toBe(0);
    expect(transport.pushes).toHaveLength(1);

    t += 1000;
    await engine.pushOnce();
    op = (await db.outbox.toArray())[0]!;
    expect(op.attempts).toBe(2);
    expect(op.nextAttemptAt).toBe(t + 2000);
    expect(await engine.entityState('note', row.id)).toBe('pending_sync');

    t += 2000;
    await engine.pushOnce();
    op = (await db.outbox.toArray())[0]!;
    expect(op.attempts).toBe(3);
    expect(op.nextAttemptAt).toBe(t + 4000);
    // repeated server failures are reported honestly as an error (still queued, still retried)
    expect(await engine.entityState('note', row.id)).toBe('error');
    expect(engine.getSnapshot().state).toBe('error');
    expect(await db.outbox.count()).toBe(1);

    // the server recovers → the same op goes through
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied' }));
    t += 4000;
    await engine.pushOnce();
    expect((await db.outbox.toArray())[0]!.status).toBe('synced');
    expect(transport.pushes.at(-1)!.ops[0]!.op_id).toBe(op.op_id);
    expect(engine.getSnapshot().state).toBe('synced');
  });

  it('offline failures keep the op as «saved locally» and back off', async () => {
    const row = note();
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert' });
    transport.respond = () => {
      throw new ApiError({ code: 'OFFLINE', status: 0, offline: true, message: 'لا يوجد اتصال.' });
    };
    await engine.pushOnce();
    await engine.pushOnce();
    t += 10_000;
    await engine.pushOnce();
    t += 10_000;
    await engine.pushOnce();
    const op = (await db.outbox.toArray())[0]!;
    expect(op.status).toBe('pending');
    expect(op.attempts).toBeGreaterThanOrEqual(3);
    // offline is not an error
    expect(await engine.entityState('note', row.id)).toBe('pending_sync');
    online = false;
    expect(await engine.entityState('note', row.id)).toBe('saved_locally');
    await engine.refresh();
    expect(engine.getSnapshot().state).toBe('saved_locally');
    // when the connection returns, offline backoff is cleared
    online = true;
    await engine.resetBackoff();
    expect((await db.outbox.toArray())[0]!.nextAttemptAt).toBe(0);
  });

  it('a retryable per-op result keeps the op queued', async () => {
    const row = note();
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'rejected', retryable: true, detail: 'قاعدة البيانات مشغولة' }));
    await engine.pushOnce();
    const op = (await db.outbox.toArray())[0]!;
    expect(op.status).toBe('pending');
    expect(op.attempts).toBe(1);
  });

  it('conflict_kept_both surfaces as conflict state until the owner acknowledges it', async () => {
    const row = note();
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert', base_rev: 1 });
    const applied: unknown[] = [];
    engine.registerApplier('note', (change, ctx) => {
      applied.push({ entity: change.entity, source: ctx.source });
    });
    const serverCopy = { id: row.id, rev: 3, conflict_of_id: null };
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'conflict_kept_both', entity: serverCopy, detail: 'حُفظت نسختك كملاحظة مستقلة' }));
    await engine.pushOnce();

    const op = (await db.outbox.toArray())[0]!;
    expect(op.status).toBe('conflict');
    expect(op.result).toBe('conflict_kept_both');
    expect(await engine.entityState('note', row.id)).toBe('conflict');
    expect((await db.notes.get(row.id))?.syncState).toBe('conflict');
    const snap = engine.getSnapshot();
    expect(snap.conflicts).toBe(1);
    expect(snap.state).toBe('conflict');
    expect(applied).toEqual([{ entity: serverCopy, source: 'push' }]);
    // not re-sent automatically
    expect((await engine.pushOnce()).sent).toBe(0);
    expect(await engine.openIssues()).toHaveLength(1);

    await engine.acknowledge(op.op_id);
    expect(await engine.entityState('note', row.id)).toBe('synced');
    expect(engine.getSnapshot().conflicts).toBe(0);
    expect(await engine.openIssues()).toHaveLength(0);
  });

  it('rejected without a server copy is an error that is kept and can be retried (against an idempotent server)', async () => {
    // Regression: retry() used to re-send the SAME op_id; the real server answers a seen op_id with
    // `duplicate` + original_result 'rejected', so the retry could never succeed.
    const server = new IdempotentServer();
    engine = makeEngine({ transport: server });
    const row = note();
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert', base_rev: 4 });
    server.decide = (o) => ({ op_id: o.op_id, result: 'rejected', detail: 'الحقل title أطول من المسموح.' });
    await engine.pushOnce();
    const op = (await db.outbox.toArray())[0]!;
    expect(op.status).toBe('rejected');
    expect(op.lastError).toBe('الحقل title أطول من المسموح.');
    expect(await engine.entityState('note', row.id)).toBe('error');
    expect((await engine.pushOnce()).sent).toBe(0);

    // the owner fixed the cause on the server; the server would now accept the write
    server.decide = (o) => ({ op_id: o.op_id, result: 'applied', entity: { id: o.entity_id, rev: 5 } });
    const again = (await engine.retry(op.op_id))!;
    expect(again).toBeTruthy();
    expect(again.op_id).not.toBe(op.op_id);
    expect(again).toMatchObject({ entity_id: row.id, op: 'upsert', base_rev: 4, client_ts: op.client_ts, status: 'pending', retryOf: op.op_id });
    expect(again.payload).toEqual(op.payload);
    const old = (await db.outbox.where('op_id').equals(op.op_id).first())!;
    expect(old).toMatchObject({ status: 'rejected', supersededBy: again.op_id });
    expect(old.acknowledgedAt).toBeTruthy();
    expect(await engine.openIssues()).toHaveLength(0);
    expect(await engine.entityState('note', row.id)).toBe('pending_sync');

    await engine.pushOnce();
    expect(server.pushes.at(-1)!.ops.map((o) => o.op_id)).toEqual([again.op_id]);
    expect((await db.outbox.where('op_id').equals(again.op_id).first())!.status).toBe('synced');
    expect(await engine.entityState('note', row.id)).toBe('synced');
    expect((await db.notes.get(row.id))?.syncState).toBe('synced');
    expect(engine.getSnapshot().state).toBe('synced');

    // retrying the same rejected op twice does not queue a second copy
    expect(await engine.retry(op.op_id)).toBeNull();
    expect(await db.outbox.where('entity_id').equals(row.id).count()).toBe(2);
  });

  it('a 401 pauses sync without touching the op and without the global sign-in redirect', async () => {
    const row = note();
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert' });
    transport.respond = () => {
      throw new ApiError({ code: 'UNAUTHENTICATED', status: 401, message: 'انتهت الجلسة.' });
    };
    const r = await engine.pushOnce();
    expect(r.failed).toBe(true);
    const op = (await db.outbox.toArray())[0]!;
    expect(op).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: 0 });
    await engine.refresh();
    const snap = engine.getSnapshot();
    expect(snap.authRequired).toBe(true);
    expect(snap.state).toBe('saved_locally');
  });

  it('sends one op per entity per batch and rebases later ops on the acknowledged rev', async () => {
    const row = note();
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert', base_rev: 1 });
    transport.respond = () => {
      throw new ApiError({ code: 'INTERNAL', status: 500, message: 'x' });
    };
    await engine.pushOnce(); // first op is now "sent" → the next edit becomes its own op
    await writeAndEnqueue(db, db.notes, { ...row, title: 'edit 2' }, { entity_type: 'note', op: 'upsert', base_rev: 1 });
    const other = note();
    await writeAndEnqueue(db, db.notes, other, { entity_type: 'note', op: 'upsert' });

    t += 1000;
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied', entity: { id: o.entity_id, rev: 2 } }));
    await engine.pushOnce();
    const batch = transport.pushes.at(-1)!.ops;
    expect(batch.map((o) => o.entity_id).sort()).toEqual([row.id, other.id].sort());
    const ops = await db.outbox.orderBy('seq').toArray();
    const second = ops.find((o) => o.entity_id === row.id && o.status === 'pending')!;
    expect(second.base_rev).toBe(2);

    await engine.pushOnce();
    expect(transport.pushes.at(-1)!.ops).toEqual([expect.objectContaining({ entity_id: row.id, base_rev: 2 })]);
  });
});

describe('pull', () => {
  it('applies changes through registered appliers and persists the cursor', async () => {
    const seen: string[] = [];
    engine.registerApplier('note', (c) => {
      seen.push(c.entity_id);
    });
    transport.pullQueue.push(
      { changes: [{ seq: 5, entity_type: 'note', entity_id: 'A', entity: { id: 'A' } }], next_since: 5, has_more: true },
      { changes: [{ seq: 9, entity_type: 'note', entity_id: 'B', entity: null }], next_since: 9, has_more: false },
    );
    const r = await engine.pullOnce();
    expect(r.applied).toBe(2);
    expect(seen).toEqual(['A', 'B']);
    expect(transport.pulls.map((p) => p.since)).toEqual([0, 5]);
    expect((await db.kv.get('sync.pull.since'))?.value).toBe(9);

    await engine.pullOnce();
    expect(transport.pulls.at(-1)!.since).toBe(9);
  });

  it('parks changes without an applier and delivers them when one registers (lazy feature routes)', async () => {
    transport.pullQueue.push({
      changes: [
        { seq: 1, entity_type: 'flashcard', entity_id: 'C1', entity: { id: 'C1', v: 1 } },
        { seq: 2, entity_type: 'flashcard', entity_id: 'C1', entity: { id: 'C1', v: 2 } },
      ],
      next_since: 2,
      has_more: false,
    });
    const r = await engine.pullOnce();
    expect(r.inboxed).toBe(2);
    expect(await db.syncInbox.count()).toBe(1); // latest change per entity
    const got: unknown[] = [];
    engine.registerApplier('flashcard', (c) => {
      got.push(c.entity);
    });
    await engine.drainInbox('flashcard');
    expect(got).toEqual([{ id: 'C1', v: 2 }]);
    expect(await db.syncInbox.count()).toBe(0);
  });

  it('a failing pull (server error) is shown as an error, an offline one is not; success clears it', async () => {
    transport.pull = async () => {
      throw new ApiError({ code: 'INTERNAL', status: 500, message: 'الخادم غير متاح.' });
    };
    await engine.pullOnce();
    expect(engine.getSnapshot().state).toBe('error');
    transport.pull = async () => {
      throw new ApiError({ code: 'OFFLINE', status: 0, offline: true, message: 'لا يوجد اتصال.' });
    };
    await engine.pullOnce();
    expect(engine.getSnapshot().state).toBe('synced');
    transport.pull = async (since) => ({ changes: [], next_since: since, has_more: false });
    await engine.pullOnce();
    expect(engine.getSnapshot()).toMatchObject({ state: 'synced', pullFailed: false, lastSyncedAt: t });
  });

  it('gives local unsynced ops to the applier so it does not overwrite them', async () => {
    const row = note('N1');
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert' });
    let localOps = -1;
    engine.registerApplier('note', (_c, ctx) => {
      localOps = ctx.localOps.length;
    });
    transport.pullQueue.push({ changes: [{ seq: 3, entity_type: 'note', entity_id: 'N1', entity: { id: 'N1' } }], next_since: 3, has_more: false });
    await engine.pullOnce();
    expect(localOps).toBe(1);
  });
});

describe('engine wiring', () => {
  afterEach(() => {
    setFetchImpl(null);
    setUnauthenticatedHandler(null);
  });

  it('the HTTP transport never triggers the global session-expired redirect (background requests)', async () => {
    // Regression: a 401 on a background push/pull navigated to /login, unmounting the workspace mid-writing.
    const redirect = vi.fn();
    setUnauthenticatedHandler(redirect);
    setFetchImpl(async () => new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'انتهت الجلسة.' } }), { status: 401 }));
    const op = { op_id: newId(), device_id: DEVICE, entity_type: 'note', entity_id: newId(), op: 'upsert' as const, payload: {} };
    await expect(httpTransport.push({ ops: [op] })).rejects.toMatchObject({ status: 401 });
    await expect(httpTransport.pull(0, 10)).rejects.toMatchObject({ status: 401 });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a pull requested while a push-only run is in flight is not lost', async () => {
    // Regression: the coalesced re-run reused the first call's { pull: false }.
    engine = makeEngine({ pollIntervalMs: 1e9, pushDebounceMs: 1e9 });
    engine.start();
    await vi.waitFor(() => expect(transport.pulls).toHaveLength(1)); // start() syncs once
    await engine.syncNow(); // settle the initial run
    const pullsBefore = transport.pulls.length;

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    transport.respond = async (req) => {
      await gate;
      return req.ops.map((o) => ({ op_id: o.op_id, result: 'applied' }));
    };
    await writeAndEnqueue(db, db.notes, note(), { entity_type: 'note', op: 'upsert' });
    const first = engine.syncNow({ pull: false }); // push in flight
    await vi.waitFor(() => expect(transport.pushes.length).toBeGreaterThan(0));
    const second = engine.syncNow(); // wants a pull
    release();
    await first;
    await second;
    expect(transport.pulls.length).toBe(pullsBefore + 1);
    engine.stop();
  });
});
