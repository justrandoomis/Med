// AOS-1.24 (track C3) — undo / redo revert only the user's OWN operations; a peer's later stroke survives a local undo.
//
// Decided honestly against the PRD row: there is no multi-writer layer before Phase 4 (collaborative copies; `use_crdt`
// ops are refused by the server), so the rule is implemented and tested on the paths of Phase 1 where another
// person's writing meets this account's undo history:
//   * the FOLLOWED-LAYER path — a classmate's explanation the account follows: his strokes arrive by sync (his update,
//     «طبّق التحديث»), read-only, beside the account's own writing;
//   * the LAYER-COPY path — «انسخ إلى طبقتي» copies his items into the account's own layer (new items, no author).
// And the rule itself, in the store's step check: a change whose item NOW carries another author's writing (the state a
// multi-writer layer will produce in Phase 4, or any server copy re-attributed to someone else) is never reverted or
// re-applied by this account's undo / redo — not silently, and not even after «نفّذها» on the confirm dialog.
// What waits for Phase 4 (docs/REQUIREMENTS_MATRIX.md, AOS-1.24): the CRDT layer itself and its UndoManager scoped to
// the local origin, a peer's concurrent edit INSIDE one shared stroke, and the multi-writer E2E.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { annotationTargetKey, newId, type AnnotationAnchor, type InkPoint } from '@medlevo/shared';
import { MedLevoDB } from '../../src/lib/localdb';
import { InkDocumentStore } from '../../src/features/workspace/ink/store';
import { notifySyncedRows } from '../../src/features/workspace/ink/events';
import { makeInkItem, rowFromItem, transformItem, type InkItem } from '../../src/features/workspace/ink/model';
import { layerPredicates, type LayerInfo } from '../../src/features/workspace/ink/layers/model';

const anchor: AnnotationAnchor = { type: 'page', source_id: 'SRC1', version_id: 'VER1', page_id: 'PAGE1', page_index: 0, space: 'page_norm' };
const KEY = annotationTargetKey(anchor);
const AR = 842 / 595;
const DOC = 'SRC1:VER1';
const PEER = 'U_HASAN';
const FOLLOWED = 'LAYER_HASAN_FOLLOWED';
const MINE = 'LAYER_MINE';

let db: MedLevoDB;
let t: number;
const open: InkDocumentStore[] = [];

function stroke(y: number, extra: Partial<InkItem> = {}): InkItem {
  const points: InkPoint[] = Array.from({ length: 12 }, (_, i) => [0.1 + i * 0.03, y, i * 8]);
  return { ...makeInkItem({ id: newId(), anchor, now: t, z: 1, style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, points, pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' }), ...extra };
}

/** The layers of a followed copy: the account's own «ملاحظاتي», its own explanation layer, and Hasan's followed layer. */
function layers(): LayerInfo[] {
  const base = { documentKey: 'source:SRC1', visible: true, locked: false, sortOrder: 0, row: null } as unknown as LayerInfo;
  return [
    { ...base, id: 'DEFAULT', kind: 'personal', isDefault: true, access: 'write', title: 'ملاحظاتي' } as LayerInfo,
    { ...base, id: MINE, kind: 'explanation', isDefault: false, access: 'write', title: 'شرحي', sortOrder: 1 } as LayerInfo,
    { ...base, id: FOLLOWED, kind: 'explanation', isDefault: false, access: 'read_only', title: 'شرح حسن', sortOrder: 2 } as LayerInfo,
  ];
}

async function openDoc(): Promise<InkDocumentStore> {
  const s = new InkDocumentStore(DOC, db, () => t);
  open.push(s);
  await s.historyReady;
  const p = layerPredicates(layers(), { active: MINE });
  s.setVisibility(p.visible as (it: InkItem) => boolean);
  s.setEditability(p.editable as (it: InkItem) => boolean);
  s.setActiveLayer(MINE);
  s.attachPage(KEY, anchor, AR);
  await s.whenLoaded(KEY);
  return s;
}

/** A row written by the sync applier (his update reached this device) — the store hears about it as from sync. */
async function arrivesBySync(s: InkDocumentStore, item: InkItem, rev = 1): Promise<void> {
  await db.annotations.put(rowFromItem(item, { syncState: 'synced', updatedAt: t, rev }));
  notifySyncedRows([KEY], [item.id]);
  await new Promise((r) => setTimeout(r, 30));
  await s.whenLoaded(KEY);
}

beforeEach(async () => {
  db = new MedLevoDB(`ink-c3-undo-${newId()}`);
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

describe('AOS-1.24 — the followed-layer path', () => {
  it('my stroke, then his later stroke arrives: undo removes mine only; redo brings mine back; his survives both', async () => {
    const s = await openDoc();
    const mine = stroke(0.3);
    s.commit('كتابة', [{ id: mine.id, targetKey: KEY, before: null, after: mine }]);
    t += 1000;
    const his = stroke(0.6, { layer_id: FOLLOWED, author_user_id: PEER });
    await arrivesBySync(s, his);
    expect(s.item(KEY, his.id)).toBeDefined();

    expect(s.undoStep()).toBe('done');
    expect(s.item(KEY, mine.id)).toBeUndefined();
    expect(s.item(KEY, his.id)).toBeDefined();
    expect(s.redoStep()).toBe('done');
    expect(s.item(KEY, mine.id)).toBeDefined();
    expect(s.item(KEY, his.id)!.data).toEqual(his.data);
    await s.flush();
    const ops = await db.outbox.where('[entity_type+entity_id]').equals(['annotation', his.id]).toArray();
    expect(ops, 'nothing of his is ever sent from this account').toEqual([]);
  });

  it('deleting a selection that holds his stroke and mine deletes mine only; its undo restores mine only', async () => {
    const s = await openDoc();
    const his = stroke(0.6, { layer_id: FOLLOWED, author_user_id: PEER });
    await arrivesBySync(s, his);
    const mine = stroke(0.3);
    s.commit('كتابة', [{ id: mine.id, targetKey: KEY, before: null, after: mine }]);
    s.setSelection({ targetKey: KEY, ids: [mine.id, his.id] });
    s.deleteSelection();
    expect(s.item(KEY, mine.id)).toBeUndefined();
    expect(s.item(KEY, his.id)).toBeDefined();
    expect(s.undoStep()).toBe('done');
    expect(s.item(KEY, mine.id)).toBeDefined();
    expect(s.item(KEY, his.id)!.data).toEqual(his.data);
  });
});

describe('AOS-1.24 — the layer-copy path («انسخ إلى طبقتي»)', () => {
  it('copying his stroke makes MY item; his next update moves his original; my undo removes my copy and never reverts his move', async () => {
    const s = await openDoc();
    const his = stroke(0.6, { layer_id: FOLLOWED, author_user_id: PEER });
    await arrivesBySync(s, his);
    s.setSelection({ targetKey: KEY, ids: [his.id] });
    expect(s.copySelectionToActiveLayer()).toBe(1);
    const copyId = s.getSelection()!.ids[0]!;
    const copy = s.item(KEY, copyId)!;
    expect(copy.layer_id).toBe(MINE);
    expect(copy.author_user_id).toBeUndefined();
    // his update (the publisher moved his stroke) arrives after my copy
    t += 1000;
    const moved = { ...transformItem(his, [1, 0, 0, 1, 0.05, 0], AR, t), rev: 2 };
    await arrivesBySync(s, moved, 2);
    expect(s.undoStep()).toBe('done');
    expect(s.item(KEY, copyId)).toBeUndefined();
    expect(s.item(KEY, his.id)!.data).toEqual(moved.data);
  });
});

describe('AOS-1.24 — the rule: a step never reverts another person’s later writing', () => {
  it('an item of my step that now carries another author’s writing is left as he left it — no silent revert, no «نفّذها» revert', async () => {
    const s = await openDoc();
    const mine = stroke(0.3, { layer_id: MINE });
    s.commit('كتابة', [{ id: mine.id, targetKey: KEY, before: null, after: mine }]);
    const recolored = { ...mine, data: { ...mine.data, style: { ...(mine.data as { style: object }).style, color: 'ink-red' } }, updated_at: t + 1 } as InkItem;
    s.commit('تلوين', [{ id: mine.id, targetKey: KEY, before: mine, after: recolored }]);
    await s.flush();
    // a later state of the same item written by someone else (a multi-writer layer in Phase 4; any re-attributed copy)
    t += 5000;
    const his = { ...transformItem(recolored, [1, 0, 0, 1, 0.1, 0], AR, t), author_user_id: PEER, rev: 3 } as InkItem;
    await arrivesBySync(s, his, 3);
    const before = JSON.stringify(s.item(KEY, mine.id));
    const opsBefore = await db.outbox.where('[entity_type+entity_id]').equals(['annotation', mine.id]).count();

    const outcome = s.undoStep();
    if (outcome === 'confirm') s.confirmPendingStep();
    expect(JSON.stringify(s.item(KEY, mine.id)), 'his later writing survives my undo').toBe(before);
    // and my history moved past that step: the next undo is my own earlier step (still about his item now → also left)
    const next = s.undoStep();
    if (next === 'confirm') s.confirmPendingStep();
    expect(JSON.stringify(s.item(KEY, mine.id))).toBe(before);
    await s.flush();
    // no write of this account goes out for his item (the two ops before are my own write and recolour, sent earlier)
    expect(await db.outbox.where('[entity_type+entity_id]').equals(['annotation', mine.id]).count(), 'no op of mine overwrites his').toBe(opsBefore);
    expect(s.lastForeign).toBe(1);
  });

  it('a step with my own items and one now his: mine are undone, his is left; redo re-applies mine only', async () => {
    const s = await openDoc();
    const a = stroke(0.3, { layer_id: MINE });
    const b = stroke(0.5, { layer_id: MINE });
    s.commit('كتابة', [
      { id: a.id, targetKey: KEY, before: null, after: a },
      { id: b.id, targetKey: KEY, before: null, after: b },
    ]);
    await s.flush();
    t += 5000;
    const hisB = { ...transformItem(b, [1, 0, 0, 1, 0.1, 0], AR, t), author_user_id: PEER, rev: 2 } as InkItem;
    await arrivesBySync(s, hisB, 2);
    const outcome = s.undoStep();
    if (outcome === 'confirm') s.confirmPendingStep();
    expect(s.item(KEY, a.id)).toBeUndefined();
    expect(s.item(KEY, b.id)!.data).toEqual(hisB.data);
    expect(s.redoStep()).toBe('done');
    expect(s.item(KEY, a.id)).toBeDefined();
    expect(s.item(KEY, b.id)!.data).toEqual(hisB.data);
  });
});
