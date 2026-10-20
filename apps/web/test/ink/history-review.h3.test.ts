// Independent review of Round 7 — H3 item 1 (persistent undo / redo). The store checks a step against the CURRENT state
// before applying it; a change it skips because the item is already as the step wants it must not come back with the
// opposite step either. Otherwise: this device wrote a stroke, another device erased it (the server's tombstone reached
// this device), undo «كتابة» is skipped quietly (the stroke is already gone) — and redo then brought the erased stroke
// back WITHOUT asking (an upsert the server applies over its tombstone).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { annotationTargetKey, newId, type AnnotationAnchor, type InkPoint } from '@medlevo/shared';
import { MedLevoDB } from '../../src/lib/localdb';
import { InkDocumentStore } from '../../src/features/workspace/ink/store';
import { makeInkItem, transformItem, type InkItem } from '../../src/features/workspace/ink/model';

const anchor: AnnotationAnchor = { type: 'page', source_id: 'SRC1', version_id: 'VER1', page_id: 'PAGE1', page_index: 0, space: 'page_norm' };
const KEY = annotationTargetKey(anchor);
const AR = 842 / 595;
const DOC = 'SRC1:VER1';

let db: MedLevoDB;
let t: number;
const open: InkDocumentStore[] = [];

function stroke(id = newId(), y = 0.5): InkItem {
  const points: InkPoint[] = Array.from({ length: 12 }, (_, i) => [0.1 + i * 0.03, y, i * 8]);
  return makeInkItem({ id, anchor, now: t, z: 1, style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, points, pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
}

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
async function close(s: InkDocumentStore): Promise<void> {
  await s.flush();
  await s.flushHistory();
  s.dispose();
  open.splice(open.indexOf(s), 1);
}

beforeEach(async () => {
  db = new MedLevoDB(`ink-h3r-${newId()}`);
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

describe('H3 review — a step skipped on undo is not re-applied silently by redo', () => {
  it('stroke written here, erased on another device: undo is quiet, and redo does NOT bring the erased stroke back', async () => {
    const a = await openDoc();
    const s = stroke();
    a.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    await close(a);
    // another device erased it; the pull stored the server's tombstone here
    await db.annotations.update(s.id, { deletedAt: t + 5, rev: 3, syncState: 'synced' });

    const b = await openDoc();
    expect(b.undoStep()).toBe('done'); // nothing to undo: the stroke is already gone
    expect(b.item(KEY, s.id)).toBeUndefined();
    const outcome = b.redoStep();
    // either nothing is left to redo for that stroke, or the owner is asked first — never a silent resurrection
    if (outcome === 'confirm') expect(b.getPendingStep()).toMatchObject({ dir: 'redo', revive: 1 });
    expect(b.item(KEY, s.id)).toBeUndefined();
    await b.flush();
    expect((await db.annotations.get(s.id))!.deletedAt).not.toBeNull();
    const ops = await db.outbox.where('[entity_type+entity_id]').equals(['annotation', s.id]).toArray();
    expect(ops.filter((o) => o.op === 'upsert')).toEqual([]);
  });

  it('the same on a page that is not on screen (checked against this device\'s copy)', async () => {
    const a = await openDoc();
    const s = stroke();
    a.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    await close(a);
    await db.annotations.update(s.id, { deletedAt: t + 5, rev: 3, syncState: 'synced' });
    const b = await openDoc(false);
    expect(b.undoStep()).toBe('checking');
    await b.stepSettled();
    const outcome = b.redoStep();
    if (outcome === 'checking') await b.stepSettled();
    await b.flush();
    expect((await db.annotations.get(s.id))!.deletedAt).not.toBeNull();
  });

  it('a step only partly skipped keeps the part that was applied: redo re-applies exactly that part', async () => {
    const a = await openDoc();
    const s1 = stroke(newId(), 0.3);
    const s2 = stroke(newId(), 0.6);
    a.commit('كتابة', [
      { id: s1.id, targetKey: KEY, before: null, after: s1 },
      { id: s2.id, targetKey: KEY, before: null, after: s2 },
    ]);
    await close(a);
    await db.annotations.update(s1.id, { deletedAt: t + 5, rev: 3, syncState: 'synced' }); // erased elsewhere
    const b = await openDoc();
    expect(b.undoStep()).toBe('done'); // removes s2 (s1 is already gone)
    expect(b.item(KEY, s2.id)).toBeUndefined();
    expect(b.redoStep()).toBe('done'); // brings back s2 — the part this device undid
    expect(b.item(KEY, s2.id)).toBeDefined();
    expect(b.item(KEY, s1.id)).toBeUndefined();
    // a move that is undone and redone still works as before
    const moved = transformItem(s2, [1, 0, 0, 1, 0.1, 0], AR, t + 1);
    b.commit('نقل', [{ id: s2.id, targetKey: KEY, before: b.item(KEY, s2.id)!, after: moved }]);
    expect(b.undoStep()).toBe('done');
    expect(b.redoStep()).toBe('done');
    expect(b.item(KEY, s2.id)!.data).toEqual(moved.data);
  });
});
