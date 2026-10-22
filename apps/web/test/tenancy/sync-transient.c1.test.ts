// AOS-21.29 (ARCHITECTURE_DELTA §8.2) — the client side of the transient sync rejections the server never records:
//   * `device_unknown` (this device was revoked in «أجهزتي»): the engine takes a NEW device id and re-sends the same op;
//   * `op_id_taken` (the op id was recorded for another actor): the engine re-issues the op under a NEW op id (same
//     entity, same payload);
//   both keep the op queued (never rejected for good), and the op applies on the next push.
import { beforeEach, describe, expect, it } from 'vitest';
import { newId, type SyncOpResult, type SyncPullResponse, type SyncPushRequest } from '@medlevo/shared';
import { MedLevoDB, type NoteRow } from '../../src/lib/localdb';
import { SyncEngine, writeAndEnqueue, type SyncTransport } from '../../src/lib/sync';

class FakeTransport implements SyncTransport {
  pushes: SyncPushRequest[] = [];
  respond: (req: SyncPushRequest) => SyncOpResult[] = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied', entity: { id: o.entity_id, rev: 1 } }));
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
let now = 1_800_000_000_000;

function note(id = newId()): NoteRow {
  return { id, updatedAt: now, syncState: 'pending_sync', body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'نص' }] }] }, rev: null };
}

beforeEach(async () => {
  db = new MedLevoDB(`medlevo-c1-transient-${newId()}`);
  await db.open();
  transport = new FakeTransport();
  engine = new SyncEngine({ db, transport, now: () => now, random: () => 0.5, locks: null, deviceId: 'DEV-REVOKED', isOnline: () => true });
});

describe('AOS-21.29 — transient rejections on the client', () => {
  it('device_unknown: the next push comes from a new device id and the op applies', async () => {
    const n = note();
    await writeAndEnqueue(db, db.notes, n, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'rejected', retryable: true, detail_code: 'device_unknown', detail: 'أُلغي هذا الجهاز' }));
    await engine.pushOnce();
    const first = transport.pushes[0]!.ops[0]!;
    expect(first.device_id).toBe('DEV-REVOKED');
    expect((await db.outbox.toArray())[0]!.status).toBe('pending');

    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: o.device_id === 'DEV-REVOKED' ? 'rejected' : 'applied', entity: { id: o.entity_id, rev: 1 } }));
    now += 10 * 60_000; // past the backoff
    await engine.pushOnce();
    const second = transport.pushes[1]!.ops[0]!;
    expect(second.device_id).not.toBe('DEV-REVOKED');
    expect(second.op_id).toBe(first.op_id); // the same op, from the new device
    expect((await db.outbox.toArray())[0]!.status).toBe('synced');
  });

  it('op_id_taken: the op is re-issued under a new op id (same entity and payload) and applies', async () => {
    const n = note();
    await writeAndEnqueue(db, db.notes, n, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'rejected', retryable: true, detail_code: 'op_id_taken' }));
    await engine.pushOnce();
    const first = transport.pushes[0]!.ops[0]!;
    expect((await db.outbox.toArray())[0]!.status).toBe('pending');

    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied', entity: { id: o.entity_id, rev: 1 } }));
    now += 10 * 60_000;
    await engine.pushOnce();
    const second = transport.pushes[1]!.ops[0]!;
    expect(second.op_id).not.toBe(first.op_id);
    expect(second.entity_id).toBe(first.entity_id);
    expect(second.payload).toEqual(first.payload);
    const stored = (await db.outbox.toArray())[0]!;
    expect(stored.status).toBe('synced');
    expect(stored.op_id).toBe(second.op_id);
  });

  it('another retryable answer (quota_exceeded) keeps the device id and the op id', async () => {
    const n = note();
    await writeAndEnqueue(db, db.notes, n, { entity_type: 'note', op: 'upsert' });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'rejected', retryable: true, detail_code: 'quota_exceeded' }));
    await engine.pushOnce();
    now += 10 * 60_000;
    await engine.pushOnce();
    expect(transport.pushes[1]!.ops[0]!.op_id).toBe(transport.pushes[0]!.ops[0]!.op_id);
    expect(transport.pushes[1]!.ops[0]!.device_id).toBe('DEV-REVOKED');
  });
});
