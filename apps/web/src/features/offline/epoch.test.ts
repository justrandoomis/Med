// Sync after a server restore (track D1, lib/sync.ts): a new server_epoch (or a cursor above the server's head)
// resets the pull cursor, and this device's writes acknowledged AFTER the restored snapshot are sent again as new
// ops — before the re-pull, so the older server copy never overwrites them. Modelled against an idempotent,
// rev-checking server that can be snapshotted and restored.
import { beforeEach, describe, expect, it } from 'vitest';
import { newId, type SyncChange, type SyncOpResult, type SyncPullResponse, type SyncPushRequest } from '@medlevo/shared';
import { ApiError } from '../../lib/api';
import { kvGet, MedLevoDB, type NoteRow } from '../../lib/localdb';
import { SERVER_EPOCH_KEY, SERVER_RESTORE_NOTICE_KEY, SyncEngine, writeAndEnqueue, type SyncTransport } from '../../lib/sync';

interface ServerNote {
  id: string;
  rev: number;
  text: string;
}
interface ServerState {
  notes: Map<string, ServerNote>;
  seen: Map<string, SyncOpResult>;
  feed: Array<{ seq: number; id: string }>;
  head: number;
}

const clone = (s: ServerState): ServerState => ({
  notes: new Map([...s.notes].map(([k, v]) => [k, { ...v }])),
  seen: new Map(s.seen),
  feed: s.feed.map((f) => ({ ...f })),
  head: s.head,
});

class RestorableServer implements SyncTransport {
  state: ServerState = { notes: new Map(), seen: new Map(), feed: [], head: 0 };
  epoch = 'E1';
  base = 0;
  pulls: number[] = [];
  pushes: SyncPushRequest[] = [];

  /** like the real server (modules/sync): a push that names another epoch is refused before anything is applied */
  guardEpoch = true;

  async push(req: SyncPushRequest): Promise<SyncOpResult[]> {
    this.pushes.push(JSON.parse(JSON.stringify(req)) as SyncPushRequest);
    if (this.guardEpoch && typeof req.server_epoch === 'string' && req.server_epoch !== this.epoch) {
      throw new ApiError({ code: 'CONFLICT', status: 409, message: 'epoch changed', details: { server_epoch_changed: true, server_epoch: this.epoch } });
    }
    return req.ops.map((o) => {
      const before = this.state.seen.get(o.op_id);
      if (before) return { ...before, result: 'duplicate', original_result: before.result };
      const text = ((o.payload as { body?: { paragraphs?: Array<{ runs: Array<{ t: string }> }> } }).body?.paragraphs?.[0]?.runs?.[0]?.t ?? '') as string;
      const cur = this.state.notes.get(o.entity_id);
      let res: SyncOpResult;
      if (!cur || (o.base_rev ?? 0) === cur.rev) {
        const next = { id: o.entity_id, rev: (cur?.rev ?? 0) + 1, text };
        this.state.notes.set(o.entity_id, next);
        this.state.head++;
        this.state.feed = this.state.feed.filter((f) => f.id !== o.entity_id).concat({ seq: this.state.head, id: o.entity_id });
        res = { op_id: o.op_id, result: 'applied', entity: { id: next.id, rev: next.rev, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: text }] }] } }, server_seq: this.state.head };
      } else {
        res = { op_id: o.op_id, result: 'conflict_kept_both', server_seq: this.state.head };
      }
      this.state.seen.set(o.op_id, res);
      return res;
    });
  }

  async pull(since: number): Promise<SyncPullResponse> {
    this.pulls.push(since);
    const changes: SyncChange[] = this.state.feed
      .filter((f) => f.seq > since)
      .map((f) => {
        const n = this.state.notes.get(f.id)!;
        return { seq: f.seq, entity_type: 'note', entity_id: f.id, entity: { id: n.id, rev: n.rev, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: n.text }] }] } } };
      });
    return { changes, next_since: changes.length ? changes[changes.length - 1]!.seq : since, has_more: false, server_epoch: this.epoch, epoch_base_seq: this.base, head_seq: this.state.head };
  }

  backup(): ServerState {
    return clone(this.state);
  }

  restore(snapshot: ServerState, epoch: string) {
    this.state = clone(snapshot);
    this.epoch = epoch;
    this.base = snapshot.head;
  }
}

let db: MedLevoDB;
let server: RestorableServer;
let engine: SyncEngine;
let t = 1_800_000_000_000;

const text = (n: NoteRow | undefined) => (n?.body as { paragraphs: Array<{ runs: Array<{ t: string }> }> } | undefined)?.paragraphs[0]?.runs[0]?.t;
const noteRow = (id: string, s: string, rev: number | null): NoteRow => ({ id, updatedAt: t, syncState: 'pending_sync', rev, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: s }] }] } });

beforeEach(async () => {
  db = new MedLevoDB(`epoch-test-${newId()}`);
  await db.open();
  server = new RestorableServer();
  engine = new SyncEngine({ db, transport: server, now: () => t, random: () => 0.5, locks: null, deviceId: 'DEV', isOnline: () => true });
  // a minimal applier with the workspace rule: never overwrite a row that still has local ops; rev-guarded
  engine.registerApplier('note', async (change, ctx) => {
    if (ctx.localOps.length) return;
    const e = change.entity as { id: string; rev: number; body: unknown } | null;
    if (!e) return;
    const cur = await ctx.db.notes.get(e.id);
    if (cur && (cur.rev ?? 0) > e.rev && ctx.source === 'pull') return;
    await ctx.db.notes.put({ id: e.id, rev: e.rev, body: e.body, updatedAt: t, syncState: 'synced' });
  });
});

describe('server data epoch', () => {
  it('first contact stores the epoch without resetting anything', async () => {
    await engine.syncNow();
    expect(await kvGet(db, SERVER_EPOCH_KEY)).toBe('E1');
    expect(server.pulls).toEqual([0]);
    expect(await kvGet(db, SERVER_RESTORE_NOTICE_KEY)).toBeUndefined();
  });

  it('after a restore: cursor reset, writes acknowledged after the snapshot re-sent, nothing overwritten or lost', async () => {
    // A is written and synced (in the backup)
    await writeAndEnqueue(db, db.notes, noteRow('A', 'أ-1', null), { entity_type: 'note', op: 'upsert', base_rev: null });
    await engine.syncNow();
    const snapshot = server.backup(); // head 1
    // after the backup: B created, A edited — both acknowledged by the old server
    t += 1000;
    await writeAndEnqueue(db, db.notes, noteRow('B', 'ب-1', null), { entity_type: 'note', op: 'upsert', base_rev: null });
    await writeAndEnqueue(db, db.notes, noteRow('A', 'أ-2', 1), { entity_type: 'note', op: 'upsert', base_rev: 1 });
    await engine.syncNow();
    expect(server.state.notes.get('A')).toMatchObject({ rev: 2, text: 'أ-2' });
    expect(await db.outbox.where('status').equals('synced').count()).toBe(3);

    // disaster → restore from the backup: the server's data (and change feed) went back to head 1
    server.restore(snapshot, 'E2');
    expect(server.state.notes.get('B')).toBeUndefined();
    t += 1000;
    await engine.syncNow(); // pull detects the new epoch
    const notice = await kvGet<{ resent: number; epoch: string }>(db, SERVER_RESTORE_NOTICE_KEY);
    expect(notice).toMatchObject({ resent: 2, epoch: 'E2' });
    expect(await kvGet(db, SERVER_EPOCH_KEY)).toBe('E2');
    // the re-pull from 0 did not overwrite the newer local A with the restored server's older A
    expect(text(await db.notes.get('A'))).toBe('أ-2');
    expect(server.pulls).toContain(0);
    // the re-sent ops (new op ids) reach the restored server
    await engine.syncNow();
    expect(server.state.notes.get('A')).toMatchObject({ rev: 2, text: 'أ-2' });
    expect(server.state.notes.get('B')).toMatchObject({ text: 'ب-1' });
    const ops = await db.outbox.toArray();
    expect(ops.filter((o) => o.status === 'pending')).toHaveLength(0);
    expect(ops.filter((o) => o.status === 'conflict' || o.status === 'rejected')).toHaveLength(0);
    // the original op of A (in the backup) was NOT re-sent
    const resent = ops.filter((o) => o.retryOf);
    expect(resent.map((o) => o.entity_id).sort()).toEqual(['A', 'B']);
    expect(new Set(resent.map((o) => o.op_id)).size).toBe(2);
  });

  it('writes made while the server was being restored are sent AFTER the reset: no conflict copies, no duplicates, newest text wins', async () => {
    await writeAndEnqueue(db, db.notes, noteRow('A', 'أ-1', null), { entity_type: 'note', op: 'upsert', base_rev: null });
    await engine.syncNow();
    const snapshot = server.backup(); // head 1: A rev 1
    t += 1000;
    await writeAndEnqueue(db, db.notes, noteRow('A', 'أ-2', 1), { entity_type: 'note', op: 'upsert', base_rev: 1 });
    await writeAndEnqueue(db, db.notes, noteRow('B', 'ب-1', null), { entity_type: 'note', op: 'upsert', base_rev: null });
    await engine.syncNow(); // acknowledged by the old server (after the backup)
    expect(server.state.notes.get('A')).toMatchObject({ rev: 2 });

    // the server goes down and is restored; meanwhile this device keeps writing (pending, not sent)
    server.restore(snapshot, 'E2');
    t += 1000;
    await writeAndEnqueue(db, db.notes, noteRow('A', 'أ-3', 2), { entity_type: 'note', op: 'upsert', base_rev: 2 });
    await writeAndEnqueue(db, db.notes, noteRow('C', 'ج-1', null), { entity_type: 'note', op: 'upsert', base_rev: null });

    // first sync after the restore: push comes first in syncNow — it must not land on the restored server blindly
    const before = server.pushes.length;
    await engine.syncNow();
    // the first push named the old epoch and was refused untouched; the engine pulled (reset) and pushed again
    expect(server.pushes[before]?.server_epoch).toBe('E1');
    expect(server.pushes.slice(before + 1).every((p) => p.server_epoch === 'E2')).toBe(true);
    await engine.syncNow();
    const ops = await db.outbox.toArray();
    expect(ops.filter((o) => o.status === 'pending')).toHaveLength(0);
    expect(ops.filter((o) => o.status === 'conflict' || o.status === 'rejected')).toHaveLength(0);
    // the restored server ends with the newest text of every note, each applied once
    expect(server.state.notes.get('A')).toMatchObject({ rev: 3, text: 'أ-3' });
    expect(server.state.notes.get('B')).toMatchObject({ rev: 1, text: 'ب-1' });
    expect(server.state.notes.get('C')).toMatchObject({ rev: 1, text: 'ج-1' });
    expect(text(await db.notes.get('A'))).toBe('أ-3');
    expect(await kvGet(db, SERVER_EPOCH_KEY)).toBe('E2');
    // only the two writes the restored server lacked (A rev 2, B) were re-sent; the pending ones were sent once
    expect(ops.filter((o) => o.retryOf).map((o) => o.entity_id).sort()).toEqual(['A', 'B']);
    const sentC = server.pushes.flatMap((p) => p.ops).filter((o) => o.entity_id === 'C');
    expect(new Set(sentC.map((o) => o.op_id)).size).toBe(1);
  });

  it('a cursor above the server head (data copied back without a new epoch) also resets the cursor', async () => {
    await writeAndEnqueue(db, db.notes, noteRow('A', 'أ-1', null), { entity_type: 'note', op: 'upsert', base_rev: null });
    await engine.syncNow();
    await writeAndEnqueue(db, db.notes, noteRow('B', 'ب-1', null), { entity_type: 'note', op: 'upsert', base_rev: null });
    await engine.syncNow();
    const cursor = await kvGet<number>(db, 'sync.pull.since');
    expect(cursor).toBe(2);
    server.restore({ notes: new Map([['A', { id: 'A', rev: 1, text: 'أ-1' }]]), seen: new Map(), feed: [{ seq: 1, id: 'A' }], head: 1 }, 'E1'); // same epoch id
    server.base = 0;
    await engine.syncNow();
    expect(server.pulls.slice(-1)[0]).toBe(0);
    // only what the server cannot have (acknowledged above its head) is re-sent: B, not A
    expect((await kvGet<{ resent: number }>(db, SERVER_RESTORE_NOTICE_KEY))?.resent).toBe(1);
    await engine.syncNow();
    expect(server.state.notes.get('B')).toMatchObject({ text: 'ب-1' });
    expect((await db.outbox.toArray()).filter((o) => o.status === 'conflict')).toHaveLength(0);
  });

  it('an older server without epochs: nothing changes', async () => {
    const legacy: SyncTransport = {
      push: server.push.bind(server),
      pull: async (since) => ({ changes: [], next_since: since, has_more: false }),
    };
    const e2 = new SyncEngine({ db, transport: legacy, now: () => t, locks: null, deviceId: 'DEV', isOnline: () => true });
    await e2.syncNow();
    expect(await kvGet(db, SERVER_EPOCH_KEY)).toBeUndefined();
  });
});
