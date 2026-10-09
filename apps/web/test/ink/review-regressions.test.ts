// Regression tests from the independent review of the ink engine (track B2 review).
// Each block names the defect it pins down; all of them failed before the fix.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationTargetKey, newId, type AnnotationAnchor, type InkPoint } from '@medlevo/shared';
// The server's own payload schema: what the engine writes to the outbox must be accepted by
// apps/server/src/modules/annotations (a rejected op would never sync — §47).
import { annotationPayloadSchema } from '../../../server/src/modules/annotations/schemas';
import { MedLevoDB, type OutboxRecord } from '../../src/lib/localdb';
import { erasePoints, PointEraseSession } from '../../src/features/workspace/ink/eraser';
import { StrokeCapture } from '../../src/features/workspace/ink/input';
import { scaleAbout, translate } from '../../src/features/workspace/ink/math';
import { COORD_MAX, COORD_MIN, limitScaleToRange, makeInkItem, makeShapeItem, makeStickyItem, makeTextItem, payloadFromItem, transformItem, type InkItem } from '../../src/features/workspace/ink/model';
import { createAnnotationApplier } from '../../src/features/workspace/ink/persistence';
import { InkDocumentStore } from '../../src/features/workspace/ink/store';
import { richTextFromPlain } from '@medlevo/shared';

const anchor: AnnotationAnchor = { type: 'page', source_id: 'SRC1', version_id: 'VER1', page_id: 'PAGE1', page_index: 0, space: 'page_norm' };
const KEY = annotationTargetKey(anchor);
const AR = 842 / 595;
const style = { tool: 'pen' as const, color: 'ink-blue', width: 0.0025 };

let db: MedLevoDB;
let t: number;
const stores: InkDocumentStore[] = [];

function stroke(id = newId(), y = 0.5): InkItem {
  const points: InkPoint[] = Array.from({ length: 12 }, (_, i) => [0.1 + i * 0.03, y, i * 8, 0.3 + i * 0.03]);
  return makeInkItem({ id, anchor, now: t, z: 1, style, points, pressureAvailable: true, tiltAvailable: false, pointerType: 'pen' });
}

async function openStore(): Promise<InkDocumentStore> {
  const s = new InkDocumentStore(`doc-${newId()}`, db, () => t);
  stores.push(s);
  s.attachPage(KEY, anchor, AR);
  await s.whenLoaded(KEY);
  return s;
}

async function opsFor(id: string): Promise<OutboxRecord[]> {
  return db.outbox.where('[entity_type+entity_id]').equals(['annotation', id]).sortBy('seq');
}

function serverAccepts(item: InkItem): { ok: boolean; issues: string } {
  const r = annotationPayloadSchema.safeParse(payloadFromItem(item));
  return { ok: r.success, issues: r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3)) };
}

beforeEach(async () => {
  db = new MedLevoDB(`ink-review-${newId()}`);
  await db.open();
  t = 1_800_000_000_000;
});

afterEach(async () => {
  for (const s of stores.splice(0)) {
    await s.flush();
    s.dispose();
  }
  db.close();
});

describe('failed IndexedDB write retried later never overwrites a newer state', () => {
  it('create fails, a move succeeds, the retry of the create must not revert the move', async () => {
    const store = await openStore();
    const s = stroke();
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(() => Promise.reject(new Error('AbortError')) as never);
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    const moved = transformItem(s, translate(0.1, 0), AR, t + 1);
    store.commit('نقل', [{ id: s.id, targetKey: KEY, before: s, after: moved }]);
    await store.flush();
    spy.mockRestore();
    // the move reached IndexedDB; the failed create is superseded by it
    expect((await db.annotations.get(s.id))!.data).toEqual(moved.data);
    store.retrySave();
    await store.flush();
    expect(store.getStatus().state).toBe('idle');
    expect((await db.annotations.get(s.id))!.data).toEqual(moved.data);
    // every op in the outbox carries the latest state (the server must end with the moved stroke)
    const ops = await opsFor(s.id);
    expect((ops[ops.length - 1]!.payload as { data: unknown }).data).toEqual(moved.data);
    // and a reload shows the moved stroke
    const reopened = await openStore();
    expect(reopened.item(KEY, s.id)!.data).toEqual(moved.data);
  });

  it('a failed write followed by more failures and a success writes the CURRENT memory state once', async () => {
    const store = await openStore();
    const s = stroke();
    const spy = vi.spyOn(db, 'transaction').mockImplementation(() => Promise.reject(new Error('QuotaExceededError')) as never);
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    const moved = transformItem(s, translate(0.05, 0), AR, t + 1);
    store.commit('نقل', [{ id: s.id, targetKey: KEY, before: s, after: moved }]);
    await store.flush();
    expect(store.getStatus().state).toBe('error');
    spy.mockRestore();
    store.retrySave();
    await store.flush();
    expect(store.getStatus().state).toBe('idle');
    expect((await db.annotations.get(s.id))!.data).toEqual(moved.data);
    expect((await opsFor(s.id)).map((o) => o.op)).toEqual(['append']);
  });

  it('a failed delete is retried as a delete (tombstone), even after the item left memory', async () => {
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    await store.flush();
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(() => Promise.reject(new Error('AbortError')) as never);
    store.commit('محو', [{ id: s.id, targetKey: KEY, before: s, after: null }]);
    await store.flush();
    spy.mockRestore();
    expect(store.getStatus().state).toBe('error');
    store.retrySave();
    await store.flush();
    expect((await db.annotations.get(s.id))!.deletedAt).toBe(t);
    expect((await opsFor(s.id)).map((o) => o.op)).toEqual(['append', 'delete']);
  });
});

describe('every payload the engine writes is accepted by the server schema', () => {
  it('a pen dragged far outside the page (pointer capture) still yields a valid stroke', () => {
    // at a small zoom the pointer can travel several page sizes beyond the page box
    const toNorm = (x: number, y: number): [number, number] => [x / 100, y / 140];
    const ev = (x: number, y: number, ts: number) => ({ clientX: x, clientY: y, timeStamp: ts, pressure: 0.5, pointerType: 'mouse' });
    const c = new StrokeCapture('mouse', toNorm, AR, ev(50, 70, 0));
    c.add(ev(-400, 70, 10));
    c.add(ev(-400, 900, 20));
    c.end(ev(900, 900, 30));
    const item = makeInkItem({ id: newId(), anchor, now: t, z: 1, style, points: c.finalPoints(), pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
    const r = serverAccepts(item);
    expect(r.ok, r.issues).toBe(true);
    // the part on the page is kept exactly
    expect((item.data as { points: InkPoint[] }).points[0]!.slice(0, 2)).toEqual([0.5, 0.5]);
  });

  it('a lasso resize ×20 or a far move keeps strokes, shapes, text boxes and sticky notes valid', () => {
    const items: InkItem[] = [
      stroke(),
      makeShapeItem({ id: newId(), anchor, now: t, z: 2, shape: 'rect', from: [0.6, 0.6], to: [0.9, 0.8], style }),
      makeShapeItem({ id: newId(), anchor, now: t, z: 3, shape: 'arrow', from: [0.1, 0.9], to: [0.4, 0.95], style }),
      makeTextItem({ id: newId(), anchor, now: t, z: 4, box: { x: 0.5, y: 0.1, w: 0.3, h: 0.05 }, text: richTextFromPlain('نص'), color: 'ink-black', fontScale: 0.022 }),
      makeStickyItem({ id: newId(), anchor, now: t, z: 5, at: [0.95, 0.95], text: 'ملاحظة', color: 'hl-yellow' }),
    ];
    for (const m of [scaleAbout(20, 0, 0), scaleAbout(20, 1, AR), translate(5, -5 * AR)]) {
      for (const it of items) {
        const r = serverAccepts(transformItem(it, m, AR, t + 1));
        expect(r.ok, `${it.kind}: ${r.issues}`).toBe(true);
      }
    }
  });

  it('the lasso resize stops at the storable edge instead of flattening the selection', () => {
    const box = { x: 0.6, y: 0.6, w: 0.3, h: 0.2 };
    const anchorIso: [number, number] = [box.x, box.y * AR]; // dragging the bottom-right corner
    const s = limitScaleToRange(20, anchorIso, box, AR);
    expect(s).toBeLessThan(20);
    // the far corner lands exactly on the limit, nothing beyond it
    const farX = anchorIso[0] + s * box.w;
    const farY = (anchorIso[1] + s * box.h * AR) / AR;
    expect(Math.max(farX, farY)).toBeCloseTo(COORD_MAX, 9);
    expect(Math.min(farX, farY)).toBeGreaterThanOrEqual(COORD_MIN);
    // small resizes are untouched; a box already past the edge may still shrink
    expect(limitScaleToRange(1.5, anchorIso, box, AR)).toBe(1.5);
    expect(limitScaleToRange(0.5, [0, 0], { x: 0, y: 0, w: 2.5, h: 0.1 }, AR)).toBe(0.5);
  });

  it('point-eraser pieces of a very long stroke stay within the server point limit and keep the original samples', () => {
    // a long, fast zig-zag: 19 000 samples ~0.003 page widths apart
    const pts: InkPoint[] = [];
    for (let i = 0; i < 19_000; i++) {
      const row = Math.floor(i / 300);
      const k = i % 300;
      const x = row % 2 === 0 ? 0.05 + k * 0.003 : 0.95 - k * 0.003;
      pts.push([x, 0.01 + row * 0.015, i * 4, 0.5 + 0.2 * Math.sin(i / 10)]);
    }
    const original = makeInkItem({ id: 'LONG', anchor, now: t, z: 1, style, points: pts, pressureAvailable: true, tiltAvailable: false, pointerType: 'pen' });
    const session = new PointEraseSession(AR);
    // a tiny eraser (high zoom) crossing one row
    const radius = 0.0045;
    session.apply([original], [[0.5, (0.01 + 10 * 0.015) * AR - 0.005], [0.5, (0.01 + 10 * 0.015) * AR + 0.005]], radius);
    const pieces = session.pieces.get('LONG')!;
    expect(pieces.length).toBe(2);
    const originalKeys = new Set((original.data as { points: InkPoint[] }).points.map((p) => `${p[0]},${p[1]}`));
    for (const run of pieces) {
      expect(run.length).toBeLessThanOrEqual(20_000);
      // only the two ends of a piece may be new (interpolated at the cut); the rest are the owner's samples
      const inner = run.slice(1, -1).filter((p) => !originalKeys.has(`${p[0]},${p[1]}`));
      expect(inner.length).toBeLessThanOrEqual(1);
      const piece = makeInkItem({ id: newId(), anchor, now: t, z: 1, style, points: run, pressureAvailable: true, tiltAvailable: false, pointerType: 'pen' });
      const r = serverAccepts(piece);
      expect(r.ok, r.issues).toBe(true);
    }
    const total = pieces.reduce((n, r) => n + r.length, 0);
    expect(total).toBeLessThanOrEqual(pts.length + 4);
  });

  it('erasePoints still cuts at the eraser edge (not at the next original sample)', () => {
    const pts: InkPoint[] = [
      [0.1, 0.5, 0],
      [0.9, 0.5, 100],
    ];
    const r = 0.02;
    const runs = erasePoints(pts, { style, pressure_available: false }, [[0.5, 0.4 * AR], [0.5, 0.6 * AR]], r, AR)!;
    expect(runs).toHaveLength(2);
    const reach = r + style.width / 2;
    expect(runs[0]![runs[0]!.length - 1]![0]).toBeGreaterThan(0.5 - reach - 0.01);
    expect(runs[1]![0]![0]).toBeLessThan(0.5 + reach + 0.01);
  });
});

describe('sync applier never replaces writing the server did not keep', () => {
  it('re-reads the outbox at write time: a local edit queued after the change was dispatched is kept', async () => {
    const store = await openStore();
    const s = stroke();
    store.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    await store.flush();
    const server = { ...stroke(s.id, 0.9), rev: 3, updated_at: t };
    // the engine took its snapshot of local ops BEFORE the owner's write landed (empty list)
    await createAnnotationApplier(() => t)({ seq: 9, entity_type: 'annotation', entity_id: s.id, entity: server }, { db, source: 'pull', localOps: [] });
    expect((await db.annotations.get(s.id))!.data).toEqual(s.data);
  });

  it('a conflict that is NOT conflict_kept_both (rejected with a server copy) keeps the local row until acknowledged', async () => {
    const s = stroke();
    await db.annotations.put({ id: s.id, targetKey: KEY, kind: 'ink', anchor, data: s.data, updatedAt: t, syncState: 'conflict', rev: 1 });
    const op = { op_id: newId(), entity_type: 'annotation', entity_id: s.id, op: 'upsert', payload: {}, client_ts: t, status: 'conflict', result: 'rejected', attempts: 1, nextAttemptAt: 0 } as OutboxRecord;
    await db.outbox.add(op);
    const server = { ...stroke(s.id, 0.2), rev: 2, updated_at: t };
    const applier = createAnnotationApplier(() => t);
    await applier({ seq: 3, entity_type: 'annotation', entity_id: s.id, entity: server }, { db, source: 'pull', localOps: [op] });
    expect((await db.annotations.get(s.id))!.data).toEqual(s.data);
    // a duplicate whose original verdict is unknown is treated the same (conservative)
    const dup = { ...op, op_id: newId(), result: 'duplicate' } as OutboxRecord;
    await applier({ seq: 4, entity_type: 'annotation', entity_id: s.id, entity: server }, { db, source: 'pull', localOps: [dup] });
    expect((await db.annotations.get(s.id))!.data).toEqual(s.data);
    // once the owner acknowledged it, the server copy is accepted
    await db.outbox.where('op_id').equals(op.op_id).modify({ acknowledgedAt: t });
    await applier({ seq: 5, entity_type: 'annotation', entity_id: s.id, entity: server }, { db, source: 'pull', localOps: [{ ...op, acknowledgedAt: t }] });
    expect((await db.annotations.get(s.id))!.data).toEqual(server.data);
  });
});
