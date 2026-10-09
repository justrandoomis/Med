// The sync engine is generic; concrete entity handlers are registered by their owning modules.
// Here a TEST-ONLY dummy entity proves idempotency, duplicate detection, conflict passthrough and paging.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyncOp } from '@medlevo/shared';
import { AppError } from '../src/lib/errors';
import type { SyncEntityHandler } from '../src/modules/sync/registry';
import { type AuthHeaders, createTestApp, type TestApp } from './helpers/app';

let t: TestApp;
let h: AuthHeaders;
let applyCalls = 0;

const noteHandler = (tApp: TestApp): SyncEntityHandler => ({
  apply(op, tx) {
    applyCalls++;
    const payload = op.payload as { body?: unknown };
    if (op.op !== 'delete' && typeof payload?.body !== 'string') throw new AppError('VALIDATION_FAILED', 'نص الملاحظة مفقود.', 400);
    if (payload?.body === 'explode') throw new Error('unexpected bug');
    const row = tx.db.get<{ id: string; rev: number }>('SELECT id, rev FROM test_note WHERE id = ?', [op.entity_id]);
    if (op.op === 'delete') {
      if (row) tx.db.run('UPDATE test_note SET deleted_at = ? WHERE id = ?', [tx.now, op.entity_id]);
      tx.touch('test_note', op.entity_id);
      return { result: 'applied' };
    }
    if (!row) {
      tx.db.run('INSERT INTO test_note (id, body, rev) VALUES (?, ?, 1)', [op.entity_id, payload.body as string]);
      tx.touch('test_note', op.entity_id);
      return { result: 'applied', entity: { id: op.entity_id, body: payload.body, rev: 1 } };
    }
    if (op.base_rev === row.rev) {
      tx.db.run('UPDATE test_note SET body = ?, rev = rev + 1 WHERE id = ?', [payload.body as string, op.entity_id]);
      tx.touch('test_note', op.entity_id);
      return { result: 'applied' };
    }
    // concurrent edit: keep both (incoming body saved as a copy)
    const copyId = `${op.entity_id}-c-${op.op_id}`.slice(0, 64);
    tx.db.run('INSERT INTO test_note (id, body, rev, conflict_of_id) VALUES (?, ?, 1, ?)', [copyId, payload.body as string, op.entity_id]);
    tx.touch('test_note', copyId);
    return { result: 'conflict_kept_both', detail: `حُفظت نسختك كملاحظة منفصلة (${copyId}).` };
  },
  serialize(id) {
    return tApp.ctx.db.get('SELECT id, body, rev, conflict_of_id, deleted_at FROM test_note WHERE id = ?', [id]) ?? null;
  },
});

const eventHandler = (tApp: TestApp): SyncEntityHandler => ({
  apply(op, tx) {
    if (op.op !== 'append') throw new AppError('BAD_REQUEST', 'سجل المراجعة يقبل الإضافة فقط.', 400);
    const exists = tx.db.get('SELECT 1 FROM test_event WHERE id = ?', [op.entity_id]);
    if (exists) return { result: 'duplicate' };
    tx.db.run('INSERT INTO test_event (id, rating) VALUES (?, ?)', [op.entity_id, (op.payload as { rating: number }).rating]);
    tx.touch('test_event', op.entity_id);
    return { result: 'applied' };
  },
  serialize(id) {
    return tApp.ctx.db.get('SELECT * FROM test_event WHERE id = ?', [id]) ?? null;
  },
});

let opSeq = 0;
const op = (o: Partial<SyncOp> & Pick<SyncOp, 'entity_type' | 'entity_id'>): SyncOp => ({
  op_id: `OP${String(++opSeq).padStart(6, '0')}`,
  device_id: 'DEVICE_A',
  op: 'upsert',
  payload: {},
  ...o,
});

beforeEach(async () => {
  t = await createTestApp();
  ({ headers: h } = await t.setupOwner());
  t.ctx.db.exec(`CREATE TABLE test_note (id TEXT PRIMARY KEY, body TEXT, rev INTEGER, conflict_of_id TEXT, deleted_at INTEGER) STRICT;
                 CREATE TABLE test_event (id TEXT PRIMARY KEY, rating INTEGER) STRICT;`);
  t.ctx.sync.registerEntity('test_note', noteHandler(t));
  t.ctx.sync.registerEntity('test_event', eventHandler(t));
  applyCalls = 0;
});
afterEach(async () => {
  await t.close();
});

const push = (ops: SyncOp[]) => t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops } });

describe('sync push', () => {
  it('applies an op once; re-sending the same op_id returns duplicate + the original result', async () => {
    const o = op({ entity_type: 'test_note', entity_id: 'N1', payload: { body: 'نص' } });
    const r1 = await push([o]);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().results[0]).toMatchObject({ op_id: o.op_id, result: 'applied' });
    const r2 = await push([o]);
    expect(r2.json().results[0]).toMatchObject({ op_id: o.op_id, result: 'duplicate', original_result: 'applied', entity: { id: 'N1', body: 'نص', rev: 1 } });
    expect(applyCalls).toBe(1);
    expect(t.ctx.db.all('SELECT * FROM test_note')).toHaveLength(1);
    expect(t.ctx.sync.operation(o.op_id)).toMatchObject({ result: 'applied', entity_type: 'test_note', payload: { body: 'نص' } });
  });

  it('detects duplicates of append-only entities sent with different op ids (counted once)', async () => {
    const a = op({ entity_type: 'test_event', entity_id: 'E1', op: 'append', payload: { rating: 3 } });
    const b = op({ entity_type: 'test_event', entity_id: 'E1', op: 'append', payload: { rating: 3 }, device_id: 'DEVICE_B' });
    const res = await push([a, b]);
    expect(res.json().results.map((r: { result: string }) => r.result)).toEqual(['applied', 'duplicate']);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM test_event')!.n).toBe(1);
  });

  it('passes conflict_kept_both through and never loses either version', async () => {
    await push([op({ entity_type: 'test_note', entity_id: 'N2', payload: { body: 'v1' } })]);
    const fromA = op({ entity_type: 'test_note', entity_id: 'N2', base_rev: 1, payload: { body: 'edit from A' } });
    const fromB = op({ entity_type: 'test_note', entity_id: 'N2', base_rev: 1, payload: { body: 'edit from B' }, device_id: 'DEVICE_B' });
    const res = await push([fromA, fromB]);
    const [ra, rb] = res.json().results;
    expect(ra.result).toBe('applied');
    expect(rb.result).toBe('conflict_kept_both');
    expect(rb.detail).toMatch(/[؀-ۿ]/);
    const bodies = t.ctx.db.all<{ body: string }>('SELECT body FROM test_note ORDER BY id').map((r) => r.body);
    expect(bodies).toEqual(expect.arrayContaining(['edit from A', 'edit from B']));
  });

  it('records handler rejections; unknown types and unexpected errors are retryable and NOT recorded', async () => {
    const bad = op({ entity_type: 'test_note', entity_id: 'N3', payload: {} });
    const unknown = op({ entity_type: 'flashcard_future', entity_id: 'X1', payload: {} });
    const boom = op({ entity_type: 'test_note', entity_id: 'N4', payload: { body: 'explode' } });
    const res = await push([bad, unknown, boom]);
    const [r1, r2, r3] = res.json().results;
    expect(r1).toMatchObject({ result: 'rejected', detail: 'نص الملاحظة مفقود.' });
    expect(r1.retryable).toBeUndefined();
    expect(r2).toMatchObject({ result: 'rejected', retryable: true });
    expect(r3).toMatchObject({ result: 'rejected', retryable: true });
    expect(t.ctx.sync.operation(bad.op_id)?.result).toBe('rejected');
    expect(t.ctx.sync.operation(unknown.op_id)).toBeNull();
    expect(t.ctx.sync.operation(boom.op_id)).toBeNull();
    expect(t.ctx.db.get("SELECT 1 FROM test_note WHERE id = 'N4'")).toBeUndefined();
    // the client retries later after the bug is fixed / type is supported: it is applied then
    const fixed = { ...boom, payload: { body: 'fine now' } };
    expect((await push([fixed])).json().results[0].result).toBe('applied');
  });

  it('validates op shape', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops: [{ entity_type: 'test_note' }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    const empty = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops: [] } });
    expect(empty.statusCode).toBe(400);
  });
});

// regression: 'sync' was reported 'available' while no entity type could be synced at all
describe('sync capability', () => {
  it('is not_implemented (with an Arabic reason) until an entity type is registered, then available', async () => {
    const bare = await createTestApp();
    try {
      const st = bare.ctx.capabilities.get('sync');
      expect(st.state).toBe('not_implemented');
      expect(st.reason_ar).toMatch(/[؀-ۿ]/);
      bare.ctx.sync.registerEntity('test_note', noteHandler(bare));
      expect(bare.ctx.capabilities.get('sync').state).toBe('available');
    } finally {
      await bare.close();
    }
    // the shared app registered its handlers after boot
    expect(t.ctx.capabilities.get('sync').state).toBe('available');
  });
});

describe('sync pull', () => {
  it('pages through the change feed by seq; an entity appears once at its latest change', async () => {
    const ops = ['A', 'B', 'C', 'D', 'E'].map((x) => op({ entity_type: 'test_note', entity_id: `P${x}`, payload: { body: x } }));
    await push(ops);
    const seen: string[] = [];
    let since = 0;
    for (let guard = 0; guard < 10; guard++) {
      const res = await t.app.inject({ method: 'GET', url: `/api/sync/pull?since=${since}&limit=2`, headers: h });
      expect(res.statusCode).toBe(200);
      const page = res.json();
      expect(page.changes.length).toBeLessThanOrEqual(2);
      for (const c of page.changes) {
        expect(c.seq).toBeGreaterThan(since);
        seen.push(c.entity_id);
      }
      since = page.next_since;
      if (!page.has_more) break;
    }
    expect(seen).toEqual(['PA', 'PB', 'PC', 'PD', 'PE']);

    // update PB → it moves to the end of the feed (older row removed)
    await push([op({ entity_type: 'test_note', entity_id: 'PB', base_rev: 1, payload: { body: 'B2' } })]);
    const after = await t.app.inject({ method: 'GET', url: `/api/sync/pull?since=${since}`, headers: h });
    expect(after.json().changes).toEqual([{ seq: expect.any(Number), entity_type: 'test_note', entity_id: 'PB', entity: expect.objectContaining({ body: 'B2', rev: 2 }) }]);
    const full = t.ctx.sync.pull(0, 100);
    expect(full.changes.filter((c) => c.entity_id === 'PB')).toHaveLength(1);
    expect(full.has_more).toBe(false);

    // deletions are visible as tombstones
    await push([op({ entity_type: 'test_note', entity_id: 'PC', op: 'delete' })]);
    const del = t.ctx.sync.pull(after.json().next_since, 10);
    expect(del.changes[0]).toMatchObject({ entity_id: 'PC', entity: expect.objectContaining({ deleted_at: expect.any(Number) }) });
  });

  it('touch() is atomic: a failed re-insert never drops the entity from the feed', () => {
    t.ctx.sync.touch('test_note', 'ATOM');
    const before = t.ctx.db.get<{ seq: number }>("SELECT seq FROM sync_change WHERE entity_id = 'ATOM'")!;
    t.ctx.db.exec(`CREATE TRIGGER test_fail_touch BEFORE INSERT ON sync_change WHEN NEW.entity_id = 'ATOM' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    expect(() => t.ctx.sync.touch('test_note', 'ATOM')).toThrow();
    expect(t.ctx.db.get<{ seq: number }>("SELECT seq FROM sync_change WHERE entity_id = 'ATOM'")).toEqual(before);
    expect(t.ctx.db.inTransaction).toBe(false);
  });

  it('returns an empty page with next_since unchanged when nothing is new', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=999', headers: h });
    expect(res.json()).toEqual({ changes: [], next_since: 999, has_more: false });
  });
});
