// P1-T2 step 1 — re-homing refused writing (ADR-0004 R2; PRD AOS-1.6, 1.9; Scenario 2 step 4). A stroke the server refuses
// on a read-only layer is never dropped: it is re-created on «ملاحظاتي» with the reason shown; a refused erase shows
// the item again; other rejections are left to today's handling.
import { beforeEach, describe, expect, it } from 'vitest';
import { newId, type AnnotationAnchor, type AnnotationDTO, type SyncOpResult, type SyncPullResponse, type SyncPushRequest } from '@medlevo/shared';
import { MedLevoDB, type NoteRow } from '../../src/lib/localdb';
import { SyncEngine, writeAndEnqueue, type SyncTransport } from '../../src/lib/sync';
import { makeInkItem, rowFromItem, type InkItem, type InkRow } from '../../src/features/workspace/ink/model';
import { persistChanges } from '../../src/features/workspace/ink/persistence';
import { onRehomed, registerRehoming, rehomedIdOf, type RehomeNotice } from '../../src/features/workspace/ink/layers/rehome';

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

const T = 1_800_000_000_000;
const anchor: AnnotationAnchor = { type: 'page', source_id: 'SRC', version_id: 'VER', page_id: 'P1', page_index: 0, space: 'page_norm' };
let db: MedLevoDB;
let transport: FakeTransport;
let engine: SyncEngine;
let notices: RehomeNotice[];

function stroke(layerId: string | null, id = newId()): InkItem {
  const it = makeInkItem({ id, anchor, now: T, z: 1, style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, points: [[0.1, 0.1, 0], [0.2, 0.15, 16]], pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' });
  return { ...it, layer_id: layerId };
}
const refuse = (code: 'layer_read_only' | 'layer_forbidden' | 'use_crdt', entity?: unknown) => (req: SyncPushRequest) =>
  req.ops.map((o) => ({ op_id: o.op_id, result: 'rejected' as const, detail: 'هذه الطبقة للقراءة فقط', detail_code: code, ...(entity ? { entity } : {}) }));

beforeEach(async () => {
  db = new MedLevoDB(`medlevo-rehome-${newId()}`);
  await db.open();
  transport = new FakeTransport();
  engine = new SyncEngine({ db, transport, now: () => T, random: () => 0.5, locks: null, deviceId: 'dev-test', isOnline: () => true });
  registerRehoming(engine);
  notices = [];
  onRehomed((n) => notices.push(n));
});

describe('re-homing a stroke refused on a read-only layer', () => {
  it('re-creates it on «ملاحظاتي» under a derived id, removes the local-only copy, settles the op and says why', async () => {
    const s = stroke('FOLLOWED_LAYER');
    await persistChanges(db, [{ id: s.id, targetKey: 'source_page:P1', before: null, after: s }], T);
    transport.respond = refuse('layer_read_only');
    await engine.pushOnce();

    const rh = (await db.annotations.get(rehomedIdOf(s.id))) as InkRow | undefined;
    expect(rh).toBeDefined();
    expect(rh!.layerId).toBeNull();
    expect(rh!.data).toEqual(s.data);
    expect(rh!.targetKey).toBe('source_page:P1');
    expect(((await db.annotations.get(s.id)) as InkRow).deletedAt).toEqual(expect.any(Number));
    const ops = await db.outbox.where('entity_id').equals(rehomedIdOf(s.id)).toArray();
    expect(ops.map((o) => [o.op, o.status])).toEqual([['append', 'pending']]);
    expect((ops[0]!.payload as { layer_id: unknown }).layer_id).toBeNull();
    const refused = await db.outbox.where('entity_id').equals(s.id).first();
    expect(refused!.acknowledgedAt).toEqual(expect.any(Number));
    expect(notices).toEqual([expect.objectContaining({ entityType: 'annotation', id: s.id, rehomedId: rehomedIdOf(s.id), message_ar: expect.stringContaining('ملاحظاتي') })]);

    // the re-homed copy is what reaches the server next
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied', entity: { id: o.entity_id, rev: 1 } }));
    await engine.pushOnce();
    expect(transport.pushes.at(-1)!.ops.map((o) => o.entity_id)).toEqual([rehomedIdOf(s.id)]);
  });

  it('a second delivery of the same refusal (at least once) copies nothing twice', async () => {
    const s = stroke('FOLLOWED_LAYER');
    await persistChanges(db, [{ id: s.id, targetKey: 'source_page:P1', before: null, after: s }], T);
    transport.respond = refuse('layer_forbidden');
    await engine.pushOnce();
    const { rehomeAnnotation } = await import('../../src/features/workspace/ink/layers/rehome');
    const op = (await db.outbox.where('entity_id').equals(s.id).first())!;
    await rehomeAnnotation({ op, result: { op_id: op.op_id, result: 'rejected', detail_code: 'layer_forbidden' } }, db, T + 5);
    expect(await db.annotations.where('id').startsWith('rh_').count()).toBe(1);
    expect(await db.outbox.where('entity_id').equals(rehomedIdOf(s.id)).count()).toBe(1);
  });

  it('an edit of an existing read-only item: the original comes back as the server has it, the edit lives on in «ملاحظاتي»', async () => {
    const original = stroke('FOLLOWED_LAYER');
    const serverCopy: AnnotationDTO = { ...original, rev: 1, author_user_id: 'U2' };
    await db.annotations.put(rowFromItem(serverCopy, { syncState: 'synced', updatedAt: T, rev: 1 }));
    const moved: InkItem = { ...serverCopy, data: { ...(serverCopy.data as object), bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.05 } } as InkItem['data'] };
    await persistChanges(db, [{ id: original.id, targetKey: 'source_page:P1', before: serverCopy, after: moved }], T);
    transport.respond = refuse('layer_read_only', serverCopy);
    await engine.pushOnce();
    const back = (await db.annotations.get(original.id)) as InkRow;
    expect(back.deletedAt ?? null).toBeNull();
    expect(back.syncState).toBe('synced');
    expect(back.data).toEqual(serverCopy.data);
    const rh = (await db.annotations.get(rehomedIdOf(original.id))) as InkRow;
    expect((rh.data as { bbox: unknown }).bbox).toEqual({ x: 0.5, y: 0.5, w: 0.1, h: 0.05 });
    expect(rh.authorUserId).toBeUndefined();
  });

  it('a refused erase of a followed item shows the item again; nothing is re-homed', async () => {
    const original = stroke('FOLLOWED_LAYER');
    const serverCopy: AnnotationDTO = { ...original, rev: 1, author_user_id: 'U2' };
    await db.annotations.put(rowFromItem(serverCopy, { syncState: 'synced', updatedAt: T, rev: 1 }));
    await persistChanges(db, [{ id: original.id, targetKey: 'source_page:P1', before: serverCopy, after: null }], T);
    expect(((await db.annotations.get(original.id)) as InkRow).deletedAt).toBe(T);
    transport.respond = refuse('layer_read_only', serverCopy);
    await engine.pushOnce();
    expect(((await db.annotations.get(original.id)) as InkRow).deletedAt ?? null).toBeNull();
    expect(await db.annotations.get(rehomedIdOf(original.id))).toBeUndefined();
    expect(notices[0]).toMatchObject({ rehomedId: null });
  });

  it('a note refused on a read-only layer is re-homed the same way', async () => {
    const id = newId();
    const row: NoteRow = { id, updatedAt: T, syncState: 'pending_sync', body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'سؤالي' }] }] }, rev: null, layerId: 'FOLLOWED_LAYER', anchor, anchorKey: 'source_page:P1' };
    await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert', payload: { id, body: row.body, anchor, layer_id: 'FOLLOWED_LAYER' } });
    transport.respond = refuse('layer_read_only');
    await engine.pushOnce();
    const rh = await db.notes.get(rehomedIdOf(id));
    expect(rh).toMatchObject({ layerId: null, body: row.body });
    expect((await db.notes.get(id))!.deletedAt).toEqual(expect.any(Number));
  });

  it('other rejections (not a layer refusal) are left exactly as today', async () => {
    const s = stroke(null);
    await persistChanges(db, [{ id: s.id, targetKey: 'source_page:P1', before: null, after: s }], T);
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'rejected', detail: 'بيانات غير صالحة' }));
    await engine.pushOnce();
    expect(await db.annotations.get(rehomedIdOf(s.id))).toBeUndefined();
    expect(((await db.annotations.get(s.id)) as InkRow).deletedAt ?? null).toBeNull();
    expect((await db.outbox.where('entity_id').equals(s.id).first())!.acknowledgedAt ?? null).toBeNull();
    expect(notices).toEqual([]);
  });
});

// (P1-T2 review) a refused LAYER op: the server keeps the layer (e.g. it still has items this device has not loaded, on
// another version or a note page) — the device shows it again as the server has it, never a tombstone the server refused
describe('a layer op the server refuses', () => {
  it('a refused delete brings the layer back as the server has it (the server sends its copy)', async () => {
    const { createLayer, deleteLayer, registerLayerApplier } = await import('../../src/features/workspace/ink/layers/repo');
    const { layerInfoFromRow } = await import('../../src/features/workspace/ink/layers/model');
    registerLayerApplier(engine);
    const doc = 'source:SRC';
    const row = await createLayer(db, { documentKey: doc, title: 'إجاباتي', kind: 'answers' });
    const serverCopy = { id: row.id, document_key: doc, kind: 'answers', title: 'إجاباتي', owner_user_id: null, writable: true, frozen: false, origin: null, visible: true, locked: false, color: null, sort_order: 1, rev: 1, device_id: 'dev-test', created_at: T, updated_at: T, deleted_at: null };
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied' as const, entity: serverCopy }));
    await engine.pushOnce();
    await deleteLayer(db, layerInfoFromRow((await db.layers.get(row.id))!, doc));
    expect((await db.layers.get(row.id))!.deletedAt).toEqual(expect.any(Number));
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'rejected' as const, detail: 'لا تُحذف طبقة فيها عناصر.', entity: serverCopy }));
    await engine.pushOnce();
    const back = await db.layers.get(row.id);
    expect(back!.deletedAt ?? null).toBeNull();
    expect(back!.syncState).toBe('synced');
  });

  it('the panel counts a layer’s items on every page this device has (other versions, note pages), not only the pages in view', async () => {
    const { countLayerItems } = await import('../../src/features/workspace/ink/layers/repo');
    const s = stroke('LAYER_X');
    const onNotePage: InkItem = { ...s, anchor: { type: 'note_page', note_page_id: 'NP1', space: 'page_norm' } };
    await persistChanges(db, [{ id: s.id, targetKey: 'note_page:NP1', before: null, after: onNotePage }], T);
    const erased = stroke('LAYER_X');
    await persistChanges(db, [{ id: erased.id, targetKey: 'source_page:P1', before: null, after: erased }], T);
    await persistChanges(db, [{ id: erased.id, targetKey: 'source_page:P1', before: erased, after: null }], T + 1);
    expect(await countLayerItems(db, 'LAYER_X')).toBe(1); // the live note-page stroke; the erased one does not count
    expect(await countLayerItems(db, 'OTHER')).toBe(0);
  });
});

// (P1-T2 review) the owner drew a stroke on a layer the server no longer has (deleted on another device), then moved it —
// both ops are refused one after the other: the re-homed copy must end as the owner LAST left the stroke
describe('several refused ops of the same item', () => {
  /** the server: ops naming the deleted layer (or of an item it never had) are refused; the re-homed copy is applied */
  const refuseOnGoneLayer = (req: SyncPushRequest) =>
    req.ops.map((o) =>
      o.entity_id.startsWith('rh_')
        ? { op_id: o.op_id, result: 'applied' as const, entity: { ...(o.payload as object), id: o.entity_id, rev: 1, updated_at: T, deleted_at: null } }
        : { op_id: o.op_id, result: 'rejected' as const, detail: 'الطبقة غير موجودة', detail_code: 'layer_forbidden' as const },
    );
  it('a later refused edit updates the re-homed copy (never dropped); a later refused erase removes it', async () => {
    const s = stroke('GONE_LAYER');
    await persistChanges(db, [{ id: s.id, targetKey: 'source_page:P1', before: null, after: s }], T);
    const moved: InkItem = { ...s, data: { ...(s.data as object), bbox: { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } } as InkItem['data'], updated_at: T + 1 };
    await persistChanges(db, [{ id: s.id, targetKey: 'source_page:P1', before: s, after: moved }], T + 1);
    transport.respond = refuseOnGoneLayer;
    await engine.pushOnce(); // the append
    await engine.pushOnce(); // the move (and the re-homed copy, which the server accepts)
    const rh = (await db.annotations.get(rehomedIdOf(s.id))) as InkRow;
    expect((rh.data as { bbox: unknown }).bbox).toEqual({ x: 0.6, y: 0.6, w: 0.1, h: 0.05 });
    expect(rh.deletedAt ?? null).toBeNull();
    // what reached the server for the copy: the moved stroke, on «ملاحظاتي»
    const sent = transport.pushes.flatMap((p) => p.ops).filter((o) => o.entity_id === rehomedIdOf(s.id));
    expect(sent).toHaveLength(1);
    expect((sent[0]!.payload as { data: { bbox: unknown } }).data.bbox).toEqual({ x: 0.6, y: 0.6, w: 0.1, h: 0.05 });
    expect((sent[0]!.payload as { layer_id: unknown }).layer_id).toBeNull();
  });

  it('draw then erase, both refused: the erased stroke is not brought back on «ملاحظاتي»', async () => {
    const s = stroke('GONE_LAYER');
    await persistChanges(db, [{ id: s.id, targetKey: 'source_page:P1', before: null, after: s }], T);
    await persistChanges(db, [{ id: s.id, targetKey: 'source_page:P1', before: s, after: null }], T + 1);
    transport.respond = refuseOnGoneLayer;
    await engine.pushOnce();
    await engine.pushOnce();
    const rh = (await db.annotations.get(rehomedIdOf(s.id))) as InkRow | undefined;
    expect(rh === undefined || typeof rh.deletedAt === 'number').toBe(true);
  });
});

describe('the notice says why', () => {
  it('a layer that is gone (layer_forbidden) is not called «read-only»; a read-only layer is', async () => {
    const a = stroke('GONE_LAYER');
    await persistChanges(db, [{ id: a.id, targetKey: 'source_page:P1', before: null, after: a }], T);
    transport.respond = refuse('layer_forbidden');
    await engine.pushOnce();
    expect(notices.at(-1)!.message_ar).toContain('ملاحظاتي');
    expect(notices.at(-1)!.message_ar).not.toContain('للقراءة فقط');
    const b = stroke('FOLLOWED_LAYER');
    await persistChanges(db, [{ id: b.id, targetKey: 'source_page:P1', before: null, after: b }], T);
    transport.respond = (req) => req.ops.map((o) => (o.entity_id === b.id ? { op_id: o.op_id, result: 'rejected' as const, detail: 'x', detail_code: 'layer_read_only' as const } : { op_id: o.op_id, result: 'applied' as const }));
    await engine.pushOnce();
    expect(notices.at(-1)!.message_ar).toContain('للقراءة فقط');
  });
});
