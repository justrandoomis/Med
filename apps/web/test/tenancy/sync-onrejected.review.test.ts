// P1-T1 step 0 review — the `onRejected` hook must not lose a final rejection.
//
// Feature appliers are registered lazily (the ink applier when the workspace mounts, `InkProvider`), and the outbox is
// pushed from any screen or from another tab. The applier path already parks changes nobody handles yet (`syncInbox`,
// drained on registration). A rejection hook that only reaches the handlers registered at the moment of the push would
// silently drop a `layer_read_only` stroke that P1-T2 must re-home into «ملاحظاتي» (ADR-0004 R2) whenever the push
// happened before the workspace was opened, or the tab closed between storing the verdict and running the handler.
// The verdict and a «handler pending» mark are stored together; the mark is cleared only after the handlers succeeded,
// and a handler registered later receives every pending rejection of its type (at least once — handlers are idempotent).
import { beforeEach, describe, expect, it } from 'vitest';
import { newId, type SyncOpResult, type SyncPullResponse, type SyncPushRequest } from '@medlevo/shared';
import { MedLevoDB, type NoteRow } from '../../src/lib/localdb';
import { SyncEngine, writeAndEnqueue, type RejectedOp, type SyncTransport } from '../../src/lib/sync';

class FakeTransport implements SyncTransport {
  respond: (req: SyncPushRequest) => SyncOpResult[] = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied' }));
  async push(req: SyncPushRequest) {
    return this.respond(req);
  }
  async pull(since: number): Promise<SyncPullResponse> {
    return { changes: [], next_since: since, has_more: false };
  }
}

const T = 1_800_000_000_000;
let name: string;
let db: MedLevoDB;
let transport: FakeTransport;

const engineOn = (d: MedLevoDB) => new SyncEngine({ db: d, transport, now: () => T, random: () => 0.5, locks: null, deviceId: 'dev-test', isOnline: () => true });
const note = (): NoteRow => ({ id: newId(), updatedAt: T, syncState: 'pending_sync', body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'نص' }] }] }, rev: null });
const readOnly = (req: SyncPushRequest): SyncOpResult[] =>
  req.ops.map((o) => ({ op_id: o.op_id, result: 'rejected', detail: 'هذه الطبقة للقراءة فقط.', detail_code: 'layer_read_only' }));
/** lets the registration-time delivery (started without awaiting) finish */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(async () => {
  name = `medlevo-step0-review-${newId()}`;
  db = new MedLevoDB(name);
  await db.open();
  transport = new FakeTransport();
});

describe('onRejected never loses a final rejection (review of P1-T1 step 0)', () => {
  it('a rejection pushed before any handler of its type exists reaches the handler registered later, exactly once', async () => {
    const engine = engineOn(db);
    const a = note();
    await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    transport.respond = readOnly;
    await engine.pushOnce(); // e.g. pushed from the library screen: the workspace (and its handler) is not mounted yet

    const seen: RejectedOp[] = [];
    engine.onRejected('note', (r) => void seen.push(r));
    await settle();
    expect(seen.map((r) => r.op.entity_id)).toEqual([a.id]);
    expect(seen[0]!.result).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });

    // delivered: a second registration (the workspace mounts again) does not hand it over twice
    const again: RejectedOp[] = [];
    engine.onRejected('note', (r) => void again.push(r));
    await settle();
    expect(again).toEqual([]);
  });

  it('after a reload (a new engine over the same database) the pending rejection is still delivered', async () => {
    const a = note();
    await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    transport.respond = readOnly;
    await engineOn(db).pushOnce();
    db.close();

    const reopened = new MedLevoDB(name);
    await reopened.open();
    const seen: string[] = [];
    engineOn(reopened).onRejected('note', (r) => void seen.push(r.op.entity_id));
    await settle();
    expect(seen).toEqual([a.id]);
    reopened.close();
  });

  it('a handler that failed gets the rejection again on its next registration; once it succeeds, never again', async () => {
    const engine = engineOn(db);
    const a = note();
    await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    transport.respond = readOnly;
    let fail = true;
    const calls: string[] = [];
    const off = engine.onRejected('note', (r) => {
      calls.push(r.op.entity_id);
      if (fail) throw new Error('re-home failed (e.g. storage full)');
    });
    await engine.pushOnce();
    expect(calls).toEqual([a.id]);
    off();

    fail = false;
    engine.onRejected('note', (r) => void calls.push(r.op.entity_id));
    await settle();
    expect(calls).toEqual([a.id, a.id]);

    engine.onRejected('note', (r) => void calls.push(`late:${r.op.entity_id}`));
    await settle();
    expect(calls).toEqual([a.id, a.id]);
  });

  it('a rejection the owner already sent again (retry) is not handed to a handler registered later', async () => {
    const engine = engineOn(db);
    const a = note();
    await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    transport.respond = readOnly;
    await engine.pushOnce();
    const [issue] = await engine.openIssues();
    expect(await engine.retry(issue!.op_id)).not.toBeNull();

    const seen: string[] = [];
    engine.onRejected('note', (r) => void seen.push(r.op.op_id));
    await settle();
    expect(seen).toEqual([]);
  });

  it('a push and a registration at the same time deliver the rejection once', async () => {
    const engine = engineOn(db);
    const a = note();
    await writeAndEnqueue(db, db.notes, a, { entity_type: 'note', op: 'upsert' });
    transport.respond = readOnly;
    const calls: string[] = [];
    const pushing = engine.pushOnce();
    engine.onRejected('note', async (r) => {
      await new Promise((res) => setTimeout(res, 5));
      calls.push(r.op.entity_id);
    });
    await pushing;
    await settle();
    await new Promise((res) => setTimeout(res, 20));
    expect(calls).toEqual([a.id]);
  });
});
