// P1-T1 step 0 — the sync seams of lib/sync.ts (BUILD_PLAN §3.2): `onRejected(entityType, handler)` lets a feature act
// on a FINAL server rejection of one of its ops (P1-T2 re-homes a stroke refused as `layer_read_only` into «ملاحظاتي»,
// ADR-0004 R2), and outbox targets (`vault` | `space:<id>`, ARCHITECTURE_DELTA §4.5) so a space op is never pushed to
// the vault. With no handler and no target, behaviour is exactly today's.
import { beforeEach, describe, expect, it } from 'vitest';
import { newId, type SyncOpResult, type SyncPullResponse, type SyncPushRequest } from '@medlevo/shared';
import { MedLevoDB, type NoteRow, type OutboxRecord } from '../../src/lib/localdb';
import { enqueue, SyncEngine, writeAndEnqueue, type RejectedOp, type SyncTransport } from '../../src/lib/sync';

class FakeTransport implements SyncTransport {
  pushes: SyncPushRequest[] = [];
  respond: (req: SyncPushRequest) => SyncOpResult[] = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied' }));
  async push(req: SyncPushRequest) {
    this.pushes.push(JSON.parse(JSON.stringify(req)) as SyncPushRequest);
    return this.respond(req);
  }
  async pull(since: number): Promise<SyncPullResponse> {
    return { changes: [], next_since: since, has_more: false };
  }
}

let db: MedLevoDB;
let transport: FakeTransport;
let engine: SyncEngine;
const T = 1_800_000_000_000;

function note(id = newId()): NoteRow {
  return { id, updatedAt: T, syncState: 'pending_sync', body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'نص' }] }] }, rev: null };
}

beforeEach(async () => {
  db = new MedLevoDB(`medlevo-step0-${newId()}`);
  await db.open();
  transport = new FakeTransport();
  engine = new SyncEngine({ db, transport, now: () => T, random: () => 0.5, locks: null, deviceId: 'dev-test', isOnline: () => true });
});

describe('SyncEngine.onRejected (step 0 hook)', () => {
  it('calls the handler of the entity type once per final rejection, after the rejection is stored; other types are not called', async () => {
    const a = note();
    const b = note();
    await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    await writeAndEnqueue(db, db.notes, b, { entity_type: 'note', op: 'upsert' });
    await db.transaction('rw', db.outbox, () => enqueue(db, { entity_type: 'annotation', entity_id: 'ANN', op: 'append', payload: { id: 'ANN' } }));
    transport.respond = (req) =>
      req.ops.map((o) =>
        o.entity_id === a.id
          ? { op_id: o.op_id, result: 'rejected', detail: 'هذه الطبقة للقراءة فقط.', detail_code: 'layer_read_only' }
          : o.entity_type === 'annotation'
            ? { op_id: o.op_id, result: 'rejected', detail: 'مرفوض' }
            : { op_id: o.op_id, result: 'applied', entity: { id: o.entity_id, rev: 1 } },
      );
    const seen: Array<{ rejected: RejectedOp; stored: OutboxRecord | undefined }> = [];
    engine.onRejected('note', async (rejected, ctx) => {
      expect(ctx.db).toBe(db);
      seen.push({ rejected, stored: await db.outbox.where('op_id').equals(rejected.op.op_id).first() });
    });

    await engine.pushOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.rejected.op.entity_id).toBe(a.id);
    expect(seen[0]!.rejected.result).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });
    // the handler runs after the verdict was committed: the op is already stored as rejected
    expect(seen[0]!.stored?.status).toBe('rejected');
  });

  it('a rejection that came with the server copy (stored as a conflict) still reaches the handler; a retryable answer does not', async () => {
    const a = note();
    const b = note();
    await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    await writeAndEnqueue(db, db.notes, b, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) =>
      req.ops.map((o) =>
        o.entity_id === a.id
          ? { op_id: o.op_id, result: 'rejected', entity: { id: a.id, rev: 4 }, detail_code: 'layer_read_only' }
          : { op_id: o.op_id, result: 'rejected', retryable: true, detail_code: 'device_unknown' },
      );
    const ids: string[] = [];
    engine.onRejected('note', (r) => void ids.push(r.op.entity_id));
    await engine.pushOnce();
    expect(ids).toEqual([a.id]);
    const stored = await db.outbox.toArray();
    expect(stored.find((o) => o.entity_id === a.id)!.status).toBe('conflict');
    expect(stored.find((o) => o.entity_id === b.id)!.status).toBe('pending');
  });

  it('a duplicate that reports an original rejection reaches the handler (the first answer was lost)', async () => {
    const a = note();
    await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'duplicate', original_result: 'rejected', detail: 'سبق رفضه' }));
    let calls = 0;
    engine.onRejected('note', () => void calls++);
    await engine.pushOnce();
    expect(calls).toBe(1);
  });

  it('a failing handler never breaks sync: the op stays rejected and visible, later pushes continue', async () => {
    const a = note();
    await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'rejected', detail: 'مرفوض' }));
    engine.onRejected('note', () => {
      throw new Error('handler bug');
    });
    await expect(engine.pushOnce()).resolves.toMatchObject({ sent: 1, failed: false });
    expect((await engine.openIssues()).map((o) => o.entity_id)).toEqual([a.id]);
    const b = note();
    await writeAndEnqueue(db, db.notes, b, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied' }));
    await engine.pushOnce();
    expect((await db.outbox.where('entity_id').equals(b.id).first())!.status).toBe('synced');
  });

  it('several handlers per type; the returned function unregisters only its own handler', async () => {
    const calls: string[] = [];
    const off1 = engine.onRejected('note', () => void calls.push('one'));
    engine.onRejected('note', () => void calls.push('two'));
    off1();
    const a = note();
    await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'rejected' }));
    await engine.pushOnce();
    expect(calls).toEqual(['two']);
  });

  it('without a handler a rejection behaves exactly as before (stored, counted, retry creates a new op)', async () => {
    const a = note();
    await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'rejected', detail: 'مرفوض' }));
    await engine.pushOnce();
    const snap = await engine.refresh();
    expect(snap.errors).toBe(1);
    const op = (await engine.openIssues())[0]!;
    const retried = await engine.retry(op.op_id);
    expect(retried?.retryOf).toBe(op.op_id);
  });
});

describe('outbox targets (step 0 seam)', () => {
  it('ops without a target are vault ops (today); the push sends exactly today’s op shape', async () => {
    const a = note();
    const rec = await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    expect(rec.target).toBeUndefined();
    await engine.pushOnce();
    expect(Object.keys(transport.pushes[0]!.ops[0]!).sort()).toEqual(['base_rev', 'client_ts', 'device_id', 'entity_id', 'entity_type', 'op', 'op_id', 'payload']);
  });

  it('a space op is kept in the outbox and never pushed to the vault endpoint; an explicit vault target is pushed', async () => {
    await db.transaction('rw', db.outbox, async () => {
      await enqueue(db, { entity_type: 'annotation', entity_id: 'SP-1', op: 'append', payload: { id: 'SP-1' }, target: 'space:sp1' });
      await enqueue(db, { entity_type: 'annotation', entity_id: 'V-1', op: 'append', payload: { id: 'V-1' }, target: 'vault' });
    });
    const stored = await db.outbox.toArray();
    expect(stored.find((o) => o.entity_id === 'SP-1')!.target).toBe('space:sp1');
    expect(stored.find((o) => o.entity_id === 'V-1')!.target).toBeUndefined(); // 'vault' is the default: not stored
    const r = await engine.pushOnce();
    expect(r.sent).toBe(1);
    expect(transport.pushes.flatMap((p) => p.ops.map((o) => o.entity_id))).toEqual(['V-1']);
    const sp = (await db.outbox.where('entity_id').equals('SP-1').first())!;
    expect(sp).toMatchObject({ status: 'pending', attempts: 0, sentAt: null });
    expect((await engine.refresh()).pending).toBe(1); // still counted as waiting (honest «not sent yet»)
  });

  it('an upsert is coalesced only into a pending op of the same target', async () => {
    await db.transaction('rw', db.outbox, async () => {
      await enqueue(db, { entity_type: 'note', entity_id: 'X', op: 'upsert', payload: { v: 1 }, target: 'space:sp1' });
      await enqueue(db, { entity_type: 'note', entity_id: 'X', op: 'upsert', payload: { v: 2 } });
      await enqueue(db, { entity_type: 'note', entity_id: 'X', op: 'upsert', payload: { v: 3 } });
    });
    const ops = await db.outbox.where('entity_id').equals('X').sortBy('seq');
    expect(ops.map((o) => [o.target ?? 'vault', (o.payload as { v: number }).v])).toEqual([
      ['space:sp1', 1],
      ['vault', 3],
    ]);
  });

  it('refuses a malformed target', async () => {
    await expect(db.transaction('rw', db.outbox, () => enqueue(db, { entity_type: 'note', entity_id: 'Y', op: 'upsert', payload: {}, target: 'space:' as never }))).rejects.toThrow();
  });
});
