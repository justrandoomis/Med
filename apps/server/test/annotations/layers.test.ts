// P1-T2 step 1 — layer rules R1–R6 on the server (ADR-0004 §2.1, ARCHITECTURE_DELTA §5.4; PRD AOS-1.6, 1.9, 1.13, 4.6,
// 4.10, 21.11). The server is the authority: an op on a followed or snapshot layer is `rejected/layer_read_only` and
// recorded; a conflict copy lands on the actor's own layer; the eraser cannot tombstone another author's item; legacy
// rows (layer_id NULL) behave exactly as today (the existing annotation suites run unchanged).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPersonalLayerId, newId, type AnnotationDTO, type AnnotationLayerDTO, type LayersResponse, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { createSourceFixture, inkData, inkPayload, notePayload, op, pageAnchor, type SourceFixture } from './helpers';

let t: TestApp;
let h: AuthHeaders;
let f: SourceFixture;
let doc: string;

beforeEach(async () => {
  t = await createTestApp();
  h = await t.login();
  f = createSourceFixture(t);
  doc = `source:${f.sourceId}`;
});
afterEach(async () => {
  await t.close();
});

async function push(ops: SyncOp[]): Promise<SyncOpResult[]> {
  const res = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().results as SyncOpResult[];
}
const push1 = async (o: SyncOp) => (await push([o]))[0]!;
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: h });
const row = (id: string) => t.ctx.db.get<{ layer_id: string | null; rev: number; deleted_at: number | null; data_json: string }>('SELECT layer_id, rev, deleted_at, data_json FROM annotation WHERE id = ?', [id]);

/** A followed copy of a classmate's explanation, as the server's feed writes it (P1-T5 later): read-only, authored by U2. */
function followedLayer(): { layerId: string; itemId: string } {
  const now = t.clock.now();
  const layerId = newId(now);
  t.ctx.db.run(
    `INSERT INTO annotation_layer (id, document_key, kind, title, owner_user_id, writable, frozen, origin_json, visible, locked, sort_order, rev, created_at, updated_at)
     VALUES (?, ?, 'followed', 'شرح سارة', NULL, 0, 0, ?, 1, 0, 5, 1, ?, ?)`,
    [layerId, doc, JSON.stringify({ publication_id: 'PUB1', version_no: 3, author_user_id: 'U2', author_display: 'سارة' }), now, now],
  );
  const itemId = newId(now);
  t.ctx.db.run(
    `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, device_id, rev, created_at, updated_at, layer_id, author_user_id, origin)
     VALUES (?, 'ink', 'pen', ?, ?, 'ink', 0, 0, 'ok', NULL, 1, ?, ?, ?, 'U2', 'follow_copy')`,
    [itemId, JSON.stringify(pageAnchor(f, 0)), JSON.stringify(inkData(0.4)), now, now, layerId],
  );
  t.ctx.db.run(`INSERT INTO annotation_target (annotation_id, target_type, target_id) VALUES (?, 'source_page', ?)`, [itemId, f.pageIds[0]]);
  return { layerId, itemId };
}

function serverLayer(kind: string): string {
  const now = t.clock.now();
  const id = newId(now);
  t.ctx.db.run(`INSERT INTO annotation_layer (id, document_key, kind, title, writable, frozen, created_at, updated_at) VALUES (?, ?, ?, 'طبقة', 1, 0, ?, ?)`, [id, doc, kind, now, now]);
  return id;
}

async function ownLayer(kind: 'answers' | 'explanation' | 'personal' = 'answers', title = 'إجابات'): Promise<string> {
  const id = newId();
  const r = await push1(op({ entity_type: 'annotation_layer', entity_id: id, payload: { id, document_key: doc, kind, title } }));
  expect(r.result).toBe('applied');
  return id;
}

describe('the web client’s own layer ops', () => {
  it('a layer created on the device (the exact payload ink/layers/repo.ts sends) is applied', async () => {
    const id = newId();
    const now = Date.now();
    const r = await push1(
      op({ entity_type: 'annotation_layer', entity_id: id, op: 'upsert', base_rev: null, payload: { id, document_key: doc, kind: 'personal', title: 'إجاباتي (TEST)', visible: true, locked: false, color: null, sort_order: 1, created_at: now } }),
    );
    expect(r, JSON.stringify(r)).toMatchObject({ result: 'applied' });
    expect(t.ctx.db.get('SELECT kind, title FROM annotation_layer WHERE id = ?', [id])).toEqual({ kind: 'personal', title: 'إجاباتي (TEST)' });
  });
});

describe('R2 — read-only layers (followed copies, published snapshots) never change from a device', () => {
  it('a new stroke on a followed layer is rejected with layer_read_only, recorded, and a retry gets the same verdict back', async () => {
    const { layerId } = followedLayer();
    const id = newId();
    const o = op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { ...inkPayload(f), layer_id: layerId } });
    const r = await push1(o);
    expect(r).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });
    expect(r.detail).toMatch(/للقراءة فقط/);
    expect(r.retryable).toBeUndefined();
    expect(row(id)).toBeUndefined();
    expect(t.ctx.db.get('SELECT result, detail_code FROM sync_operation WHERE op_id = ?', [o.op_id])).toEqual({ result: 'rejected', detail_code: 'layer_read_only' });
    const again = await push1(o);
    expect(again).toMatchObject({ result: 'duplicate', original_result: 'rejected', detail_code: 'layer_read_only' });
  });

  it('a raw delete op on a followed item (the eraser) is refused, the server copy comes back and the row is untouched', async () => {
    const { itemId } = followedLayer();
    const before = row(itemId);
    const r = await push1(op({ entity_type: 'annotation', entity_id: itemId, op: 'delete', base_rev: 1 }));
    expect(r).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });
    expect((r.entity as AnnotationDTO).id).toBe(itemId);
    expect((r.entity as AnnotationDTO).deleted_at).toBeNull();
    expect(row(itemId)).toEqual(before);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation_revision')!.n).toBe(0);
  });

  it('moving, recolouring or re-layering a followed item is refused (it can only be copied)', async () => {
    const { itemId, layerId } = followedLayer();
    const moved = { ...inkPayload(f), data: inkData(0.7) };
    expect(await push1(op({ entity_type: 'annotation', entity_id: itemId, base_rev: 1, payload: { ...moved, layer_id: layerId } }))).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });
    expect(await push1(op({ entity_type: 'annotation', entity_id: itemId, base_rev: 1, payload: { ...moved, layer_id: null } }))).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });
    // an older client (no layer_id in its payload) cannot touch it either
    expect(await push1(op({ entity_type: 'annotation', entity_id: itemId, base_rev: 1, payload: moved }))).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });
    expect(row(itemId)!.rev).toBe(1);
  });

  it('a published snapshot is read-only too, and a note on a followed layer is refused the same way', async () => {
    const snap = serverLayer('published_snapshot');
    t.ctx.db.run('UPDATE annotation_layer SET writable = 0, frozen = 1 WHERE id = ?', [snap]);
    expect(await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { ...inkPayload(f), layer_id: snap } }))).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });
    const { layerId } = followedLayer();
    expect(await push1(op({ entity_type: 'note', entity_id: newId(), payload: { ...notePayload(f, 'ملاحظتي'), layer_id: layerId } }))).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });
  });
});

describe('R4 and the other refusals', () => {
  it('collaborative layers take CRDT updates only (use_crdt); space-only kinds, unknown layers and another document’s layers are layer_forbidden', async () => {
    const collab = serverLayer('collaborative');
    expect(await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { ...inkPayload(f), layer_id: collab } }))).toMatchObject({ result: 'rejected', detail_code: 'use_crdt' });
    const group = serverLayer('group_comments');
    expect(await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { ...inkPayload(f), layer_id: group } }))).toMatchObject({ result: 'rejected', detail_code: 'layer_forbidden' });
    expect(await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { ...inkPayload(f), layer_id: 'NO_SUCH_LAYER' } }))).toMatchObject({ result: 'rejected', detail_code: 'layer_forbidden' });
    const otherDoc = newId();
    t.ctx.db.run(`INSERT INTO annotation_layer (id, document_key, kind, title, created_at, updated_at) VALUES (?, 'source:OTHER', 'answers', 'x', 1, 1)`, [otherDoc]);
    expect(await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { ...inkPayload(f), layer_id: otherDoc } }))).toMatchObject({ result: 'rejected', detail_code: 'layer_forbidden' });
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation')!.n).toBe(0);
  });

  it('the eraser cannot tombstone another author’s item even on a writable layer (layer_forbidden, server copy returned)', async () => {
    const id = newId();
    await push1(op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: inkPayload(f) }));
    t.ctx.db.run(`UPDATE annotation SET author_user_id = 'U2' WHERE id = ?`, [id]);
    const r = await push1(op({ entity_type: 'annotation', entity_id: id, op: 'delete', base_rev: 1 }));
    expect(r).toMatchObject({ result: 'rejected', detail_code: 'layer_forbidden' });
    expect(r.detail).toMatch(/شخص آخر/);
    expect(row(id)!.deleted_at).toBeNull();
  });
});

describe('R1 / R3 — the owner’s own layers keep the op-log', () => {
  it('a stroke on the owner’s answers layer is stored there; an older client’s edit (no layer_id) keeps it there', async () => {
    const answers = await ownLayer();
    const id = newId();
    const r = await push1(op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { ...inkPayload(f), layer_id: answers } }));
    expect(r.result).toBe('applied');
    expect((r.entity as AnnotationDTO).layer_id).toBe(answers);
    expect((await push1(op({ entity_type: 'annotation', entity_id: id, base_rev: 1, payload: { ...inkPayload(f), data: inkData(0.3) } }))).result).toBe('applied');
    expect(row(id)).toMatchObject({ layer_id: answers, rev: 2 });
    // moving it back to «ملاحظاتي» explicitly (layer_id null) is allowed: both layers are the owner's
    expect((await push1(op({ entity_type: 'annotation', entity_id: id, base_rev: 2, payload: { ...inkPayload(f), data: inkData(0.3), layer_id: null } }))).result).toBe('applied');
    expect(row(id)!.layer_id).toBeNull();
  });

  it('the derived id of the default layer is stored as NULL (one representation of «ملاحظاتي»)', async () => {
    const id = newId();
    expect((await push1(op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { ...inkPayload(f), layer_id: defaultPersonalLayerId(doc) } }))).result).toBe('applied');
    expect(row(id)!.layer_id).toBeNull();
  });

  it('R3: a conflict_kept_both copy lands on the layer the actor wrote to, never on someone else’s', async () => {
    const answers = await ownLayer();
    const id = newId();
    await push1(op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { ...inkPayload(f), layer_id: answers } }));
    // device A edits first (rev 2); device B's edit was made on rev 1 → keep both
    await push1(op({ entity_type: 'annotation', entity_id: id, base_rev: 1, payload: { ...inkPayload(f), data: inkData(0.31), layer_id: answers } }));
    const r = await push1(op({ entity_type: 'annotation', entity_id: id, base_rev: 1, device_id: 'DEVICE_B', payload: { ...inkPayload(f), data: inkData(0.55), layer_id: answers } }));
    expect(r.result).toBe('conflict_kept_both');
    const copy = t.ctx.db.get<{ layer_id: string | null }>('SELECT layer_id FROM annotation WHERE conflict_of_id = ?', [id]);
    expect(copy).toEqual({ layer_id: answers });
    // a stale edit that names «ملاحظاتي» keeps its copy there
    const r2 = await push1(op({ entity_type: 'annotation', entity_id: id, base_rev: 1, device_id: 'DEVICE_C', payload: { ...inkPayload(f), data: inkData(0.66), layer_id: null } }));
    expect(r2.result).toBe('conflict_kept_both');
    expect(t.ctx.db.all<{ layer_id: string | null }>('SELECT layer_id FROM annotation WHERE conflict_of_id = ? ORDER BY created_at, id', [id]).map((x) => x.layer_id).sort()).toEqual([answers, null].sort());
  });
});

describe('the annotation_layer entity and the layers API', () => {
  it('lists «ملاحظاتي» first, then the owner’s and followed layers with their access, origin and live item counts', async () => {
    const { layerId } = followedLayer();
    const answers = await ownLayer();
    await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: inkPayload(f) }));
    await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { ...inkPayload(f), layer_id: answers } }));
    await push1(op({ entity_type: 'note', entity_id: newId(), payload: { ...notePayload(f, 'سؤال'), layer_id: answers } }));
    const res = (await get(`/api/annotations/layers?document_key=${doc}`)).json() as LayersResponse;
    expect(res.layers.map((l) => [l.kind, l.access, l.item_count, l.is_default])).toEqual([
      ['personal', 'write', 1, true],
      ['answers', 'write', 2, false],
      ['followed', 'read_only', 1, false],
    ]);
    expect(res.layers[2]!.id).toBe(layerId);
    expect(res.layers[2]!.origin).toMatchObject({ publication_id: 'PUB1', version_no: 3, author: { id: 'U2', display_name: 'سارة' } });
  });

  it('a device creates personal / answers / explanation layers only; server-made kinds are refused', async () => {
    const id = newId();
    expect(await push1(op({ entity_type: 'annotation_layer', entity_id: id, payload: { id, document_key: doc, kind: 'followed', title: 'x' } }))).toMatchObject({ result: 'rejected', detail_code: 'layer_forbidden' });
    expect(await push1(op({ entity_type: 'annotation_layer', entity_id: id, payload: { id, document_key: doc, kind: 'answers', title: '  إجابات  ' } }))).toMatchObject({ result: 'applied' });
    expect(t.ctx.db.get('SELECT kind, title, writable FROM annotation_layer WHERE id = ?', [id])).toEqual({ kind: 'answers', title: 'إجابات', writable: 1 });
  });

  it('a followed layer can be hidden or recoloured in this vault, but not renamed, re-kinded or deleted from a device', async () => {
    const { layerId } = followedLayer();
    const base = { id: layerId, document_key: doc, kind: 'followed', title: 'شرح سارة' };
    expect((await push1(op({ entity_type: 'annotation_layer', entity_id: layerId, base_rev: 1, payload: { ...base, visible: false } }))).result).toBe('applied');
    expect(await push1(op({ entity_type: 'annotation_layer', entity_id: layerId, base_rev: 2, payload: { ...base, visible: false, title: 'شرحي' } }))).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });
    expect(await push1(op({ entity_type: 'annotation_layer', entity_id: layerId, op: 'delete', base_rev: 2 }))).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });
    expect(t.ctx.db.get('SELECT title, kind, visible, writable, deleted_at FROM annotation_layer WHERE id = ?', [layerId])).toEqual({ title: 'شرح سارة', kind: 'followed', visible: 0, writable: 0, deleted_at: null });
  });

  it('a layer with live items is never deleted (nothing disappears silently); an empty one is tombstoned; «ملاحظاتي» is never deleted', async () => {
    const answers = await ownLayer();
    const item = newId();
    await push1(op({ entity_type: 'annotation', entity_id: item, op: 'append', payload: { ...inkPayload(f), layer_id: answers } }));
    const refused = await push1(op({ entity_type: 'annotation_layer', entity_id: answers, op: 'delete', base_rev: 1 }));
    expect(refused.result).toBe('rejected');
    expect(refused.detail).toMatch(/فيها عناصر/);
    await push1(op({ entity_type: 'annotation', entity_id: item, op: 'delete', base_rev: 1 }));
    expect((await push1(op({ entity_type: 'annotation_layer', entity_id: answers, op: 'delete', base_rev: 1 }))).result).toBe('applied');
    expect(t.ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM annotation_layer WHERE id = ?', [answers])!.deleted_at).not.toBeNull();
    // the default layer, once renamed, is a row — and still cannot be deleted
    const def = defaultPersonalLayerId(doc);
    expect((await push1(op({ entity_type: 'annotation_layer', entity_id: def, payload: { id: def, document_key: doc, kind: 'personal', title: 'دفتري' } }))).result).toBe('applied');
    expect(await push1(op({ entity_type: 'annotation_layer', entity_id: def, op: 'delete', base_rev: 1 }))).toMatchObject({ result: 'rejected', detail_code: 'layer_forbidden' });
  });

  it('two devices editing a layer: the later edit wins and the earlier state stays in the layer history', async () => {
    const answers = await ownLayer();
    const base = { id: answers, document_key: doc, kind: 'answers' };
    await push1(op({ entity_type: 'annotation_layer', entity_id: answers, base_rev: 1, payload: { ...base, title: 'أجوبة' } }));
    const r = await push1(op({ entity_type: 'annotation_layer', entity_id: answers, base_rev: 1, device_id: 'DEVICE_B', payload: { ...base, title: 'حلول' } }));
    expect(r.result).toBe('merged');
    expect((r.entity as AnnotationLayerDTO).title).toBe('حلول');
    const titles = t.ctx.db.all<{ s: string }>(`SELECT json_extract(snapshot_json, '$.title') AS s FROM annotation_revision WHERE entity_id = ? ORDER BY rev`, [answers]).map((x) => x.s);
    expect(titles).toEqual(['إجابات', 'أجوبة']);
  });

  it('REST: create, hide a followed layer, and a rename of it answers 409 LAYER_READ_ONLY', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/annotations/layers', headers: h, payload: { id: 'L_REST', document_key: doc, title: 'شرحي', kind: 'explanation' } });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ id: 'L_REST', kind: 'explanation', access: 'write', item_count: 0 });
    const { layerId } = followedLayer();
    const hide = await t.app.inject({ method: 'PATCH', url: `/api/annotations/layers/${layerId}`, headers: h, payload: { visible: false } });
    expect(hide.statusCode, hide.body).toBe(200);
    expect(hide.json().visible).toBe(false);
    const rename = await t.app.inject({ method: 'PATCH', url: `/api/annotations/layers/${layerId}`, headers: h, payload: { title: 'لي' } });
    expect(rename.statusCode).toBe(409);
    expect(rename.json().error.code).toBe('LAYER_READ_ONLY');
    // the layer row reached the change feed for the owner's other devices
    const pulled = (await get('/api/sync/pull?since=0')).json();
    expect(pulled.changes.filter((c: { entity_type: string }) => c.entity_type === 'annotation_layer').map((c: { entity_id: string }) => c.entity_id)).toEqual(expect.arrayContaining(['L_REST', layerId]));
  });

  // (P1-T2 review) two devices: the iPad renames a layer, the phone (which last saw the old row) locks it — the phone's
  // op carries the whole row, and must not silently put the old name back
  it('a stale presentation change from another device keeps the newer rename (three-way merge with the before-image)', async () => {
    const id = await ownLayer('answers', 'إجابات');
    const base = { id, document_key: doc, kind: 'answers', title: 'إجابات', visible: true, locked: false, color: null, sort_order: 1 };
    const a = await push1(op({ entity_type: 'annotation_layer', entity_id: id, base_rev: 1, device_id: 'IPAD', payload: { ...base, title: 'إجابات الفصل 3' } }));
    expect(a.result).toBe('applied');
    const b = await push1(op({ entity_type: 'annotation_layer', entity_id: id, base_rev: 1, device_id: 'PHONE', payload: { ...base, locked: true } }));
    expect(b.result).toBe('merged');
    expect(t.ctx.db.get('SELECT title, locked FROM annotation_layer WHERE id = ?', [id])).toEqual({ title: 'إجابات الفصل 3', locked: 1 });
    // both changed the same field: the later one wins, and the earlier value stays in the layer's history
    const c = await push1(op({ entity_type: 'annotation_layer', entity_id: id, base_rev: 1, device_id: 'PHONE', payload: { ...base, title: 'أجوبة' } }));
    expect(c.result).toBe('merged');
    expect(t.ctx.db.get<{ title: string }>('SELECT title FROM annotation_layer WHERE id = ?', [id])!.title).toBe('أجوبة');
  });
});
