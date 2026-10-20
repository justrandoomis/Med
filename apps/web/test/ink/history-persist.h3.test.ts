// Round 7 — H3 item 1 (§26 «اختبر تاريخ Undo وحفظ الحالة بعد الإغلاق أو الانهيار»): the undo / redo history of a
// document lived in memory only — after a reload or closing the app the ink was all there but nothing could be undone.
// It is now a command log in IndexedDB (kv, one entry per document, size-capped: oldest steps go first), restored when
// the document opens again. A step whose items changed since it was recorded — above all writing the SERVER tombstoned
// (erased on another device) — is never applied silently: the store asks first (pending step), and the owner either
// brings it back on purpose or skips the step.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { annotationTargetKey, newId, type AnnotationAnchor, type InkPoint } from '@medlevo/shared';
import { MedLevoDB } from '../../src/lib/localdb';
import { HISTORY_KV_KEY, HISTORY_MAX_CHARS } from '../../src/features/workspace/ink/historyLog';
import { InkDocumentStore } from '../../src/features/workspace/ink/store';
import { makeInkItem, transformItem, type InkItem } from '../../src/features/workspace/ink/model';

const anchor: AnnotationAnchor = { type: 'page', source_id: 'SRC1', version_id: 'VER1', page_id: 'PAGE1', page_index: 0, space: 'page_norm' };
const KEY = annotationTargetKey(anchor);
const AR = 842 / 595;
const DOC = 'SRC1:VER1';

let db: MedLevoDB;
let t: number;
const open: InkDocumentStore[] = [];

function stroke(id = newId(), y = 0.5, n = 12): InkItem {
  const points: InkPoint[] = Array.from({ length: n }, (_, i) => [0.1 + (i % 25) * 0.03, y, i * 8]);
  return makeInkItem({ id, anchor, now: t, z: 1, style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, points, pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
}

/** the reader opening the document: a fresh store (memory empty), its history restored from IndexedDB */
async function openDoc(attach = true): Promise<InkDocumentStore> {
  const s = new InkDocumentStore(DOC, db, () => t);
  open.push(s);
  await s.historyReady;
  if (attach) {
    s.attachPage(KEY, anchor, AR);
    await s.whenLoaded(KEY);
  }
  return s;
}
/** the app is closed: everything in memory is gone, only IndexedDB is left */
async function close(s: InkDocumentStore): Promise<void> {
  await s.flush();
  await s.flushHistory();
  s.dispose();
  open.splice(open.indexOf(s), 1);
}

beforeEach(async () => {
  db = new MedLevoDB(`ink-h3-${newId()}`);
  await db.open();
  t = 1_800_000_000_000;
});
afterEach(async () => {
  for (const s of open.splice(0)) {
    await s.flush();
    s.dispose();
  }
  db.close();
});

describe('H3 item 1 — the undo history survives a reload / closing the app', () => {
  it('write, move, close the app, reopen: both steps undo (then redo) as before', async () => {
    const a = await openDoc();
    const s = stroke();
    a.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    const moved = transformItem(s, [1, 0, 0, 1, 0.1, 0], AR, t + 1);
    a.commit('نقل', [{ id: s.id, targetKey: KEY, before: s, after: moved }]);
    await close(a);

    const b = await openDoc();
    expect(b.item(KEY, s.id)!.data).toEqual(moved.data); // the ink itself was always kept
    expect(b.history.canUndo).toBe(true);
    expect(b.history.undoLabel).toBe('نقل');
    expect(b.undoStep()).toBe('done');
    expect(b.item(KEY, s.id)!.data).toEqual(s.data);
    expect(b.undoStep()).toBe('done');
    expect(b.item(KEY, s.id)).toBeUndefined();
    expect(b.history.canUndo).toBe(false);
    // the redo stack is part of the log too
    await close(b);
    const c = await openDoc();
    expect(c.history.canRedo).toBe(true);
    expect(c.redoStep()).toBe('done');
    expect(c.item(KEY, s.id)!.data).toEqual(s.data);
    await c.flush();
    expect((await db.annotations.get(s.id))!.deletedAt).toBeNull();
  });

  it('writing erased on another device (a server tombstone) is never brought back silently: the step asks, «skip» keeps it erased', async () => {
    const a = await openDoc();
    const s = stroke();
    a.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    const moved = transformItem(s, [1, 0, 0, 1, 0.1, 0], AR, t + 1);
    a.commit('نقل', [{ id: s.id, targetKey: KEY, before: s, after: moved }]);
    await close(a);
    // meanwhile another device erased the stroke; the pull stored the server's tombstone on this device
    await db.annotations.update(s.id, { deletedAt: t + 5, rev: 3, syncState: 'synced' });

    const b = await openDoc();
    expect(b.item(KEY, s.id)).toBeUndefined();
    expect(b.undoStep()).toBe('confirm');
    expect(b.getPendingStep()).toMatchObject({ dir: 'undo', label_ar: 'نقل', revive: 1 });
    // nothing was applied while the question is open
    expect(b.item(KEY, s.id)).toBeUndefined();
    b.skipPendingStep();
    expect(b.getPendingStep()).toBeNull();
    expect(b.item(KEY, s.id)).toBeUndefined();
    await b.flush();
    expect((await db.annotations.get(s.id))!.deletedAt).not.toBeNull();
    // the skipped step is gone; the next one («كتابة» → remove) would only remove what is already removed: done quietly
    expect(b.history.undoLabel).toBe('كتابة');
    expect(b.undoStep()).toBe('done');
    expect(b.item(KEY, s.id)).toBeUndefined();
  });

  it('…and «bring it back» restores it on purpose (an upsert the server applies over its tombstone)', async () => {
    const a = await openDoc();
    const s = stroke();
    a.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    const moved = transformItem(s, [1, 0, 0, 1, 0.1, 0], AR, t + 1);
    a.commit('نقل', [{ id: s.id, targetKey: KEY, before: s, after: moved }]);
    await close(a);
    await db.annotations.update(s.id, { deletedAt: t + 5, rev: 3, syncState: 'synced' });
    const b = await openDoc();
    expect(b.undoStep()).toBe('confirm');
    b.confirmPendingStep();
    expect(b.item(KEY, s.id)!.data).toEqual(s.data);
    await b.flush();
    expect((await db.annotations.get(s.id))!.deletedAt).toBeNull();
    const ops = await db.outbox.where('[entity_type+entity_id]').equals(['annotation', s.id]).sortBy('seq');
    expect(ops.at(-1)).toMatchObject({ op: 'upsert' });
  });

  it('an item edited on another device since the step is not overwritten without a question either', async () => {
    const a = await openDoc();
    const s = stroke();
    a.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    a.setSelection({ targetKey: KEY, ids: [s.id] });
    a.recolorSelection('ink-red');
    await close(a);
    // the other device moved it after this device recoloured it
    const row = await db.annotations.get(s.id);
    await db.annotations.put({ ...row!, data: { ...(row!.data as object), bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.01 } }, rev: 4, syncState: 'synced' });
    const b = await openDoc();
    expect(b.undoStep()).toBe('confirm');
    expect(b.getPendingStep()).toMatchObject({ label_ar: 'تغيير اللون', revive: 0, changed: 1 });
  });

  it('a step on a page that is not on screen is checked against this device\'s copy first', async () => {
    const a = await openDoc();
    const s = stroke();
    a.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    await close(a);
    await db.annotations.update(s.id, { deletedAt: t + 5, rev: 2, syncState: 'synced' });
    const b = await openDoc(false); // the page with the stroke is not rendered
    // undoing «كتابة» removes the stroke — it is already removed: nothing to bring back, done quietly
    expect(b.undoStep()).toBe('checking');
    await b.stepSettled();
    expect(b.getPendingStep()).toBeNull();
    expect(b.history.canUndo).toBe(false);
  });

  it('the log is size-capped: the oldest steps go first, the newest are kept', async () => {
    const a = await openDoc();
    const big: InkItem[] = [];
    for (let i = 0; i < 40; i++) {
      const s = stroke(newId(), 0.1 + i * 0.02, 3000); // ~ 3 000 samples each
      big.push(s);
      a.commit(`كتابة ${i}`, [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    }
    await close(a);
    const saved = (await db.kv.get(HISTORY_KV_KEY(DOC)))!.value as { undo: Array<{ label_ar: string }> };
    expect(JSON.stringify(saved).length).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    expect(saved.undo.length).toBeGreaterThan(0);
    expect(saved.undo.length).toBeLessThan(40);
    expect(saved.undo.at(-1)!.label_ar).toBe('كتابة 39');
    const b = await openDoc();
    expect(b.history.undoLabel).toBe('كتابة 39');
  });
});
