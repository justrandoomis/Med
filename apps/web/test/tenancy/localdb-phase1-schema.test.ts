// P1-T1 step 0 — the whole Phase 1 LOCAL_SCHEMA bump (BUILD_PLAN §3.2, ARCHITECTURE_DELTA §4.5, PRD AOS-4.6):
// `layers`, `copies`, `spaceCursors`, the `layerId` index on annotations and notes, outbox targets, the per-user database
// name and the draft-ownership rule. Append-only and index-only: a device that already holds the owner's v2 database
// keeps every row byte for byte (unsynced writes and outbox ops included). Legacy rows carry no layerId: absent = the
// default personal layer, so no row is rewritten.
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@medlevo/shared';
import {
  draftBelongsTo,
  ENTITY_TABLE,
  LOCAL_DB_NAME,
  LOCAL_SCHEMA,
  localDbNameFor,
  MedLevoDB,
  outboxTarget,
  SYNC_ENTITY_TYPES,
  type CopyRow,
  type LayerRow,
  type SpaceCursorRecord,
} from '../../src/lib/localdb';

const opened: string[] = [];
afterEach(async () => {
  for (const n of opened.splice(0)) await Dexie.delete(n);
});

/** A Dexie database at exactly the shipped v1 + v2 schema (what the owner's device holds before this release). */
function previousSchemaDb(name: string): Dexie {
  const d = new Dexie(name);
  for (const v of LOCAL_SCHEMA.filter((s) => s.version <= 2)) d.version(v.version).stores(v.stores);
  return d;
}

const T0 = 1_800_000_000_000;
const body = (t: string) => ({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t }] }] });

/** One row in every v2 table, including writes that never reached the server. */
async function seedEveryTable(d: Dexie) {
  await d.table('annotations').bulkPut([
    { id: 'A1', targetKey: 'source_page:p1', kind: 'ink', anchor: { page_id: 'p1' }, data: { points: [[0.1, 0.2, 0.5]] }, updatedAt: T0, syncState: 'synced', rev: 3 },
    { id: 'A2', targetKey: 'source_page:p1', kind: 'text_highlight', anchor: { page_id: 'p1' }, data: { color: 'yellow' }, updatedAt: T0 + 1, syncState: 'pending_sync', rev: null },
    { id: 'A3', targetKey: 'note_page:np1', kind: 'ink', anchor: {}, data: {}, updatedAt: T0 + 2, syncState: 'saved_locally', anchorStatus: 'needs_reanchor' },
  ]);
  await d.table('notes').bulkPut([
    { id: 'N1', nodeId: 'n1', anchorKey: null, body: body('ملاحظة متزامنة'), updatedAt: T0, syncState: 'synced', rev: 2 },
    { id: 'N2', nodeId: null, anchorKey: 'source_page:p1', body: body('لم تُرسل بعد'), updatedAt: T0 + 5, syncState: 'pending_sync', rev: null },
  ]);
  await d.table('notePages').put({ id: 'NP1', nodeId: 'n1', template: 'ruled', width: 1000, height: 1414, sortOrder: 1, updatedAt: T0, syncState: 'synced' });
  await d.table('flashcards').put({ id: 'F1', kind: 'basic', front: body('س'), back: body('ج'), origin: 'owner', updatedAt: T0, syncState: 'pending_sync' });
  await d.table('reviewEvents').put({ id: 'R1', cardId: 'F1', rating: 3, reviewedAt: T0, updatedAt: T0, syncState: 'pending_sync' });
  await d.table('questionAttempts').put({ id: 'Q1', questionId: 'q', questionVersionId: 'qv', answeredAt: T0, updatedAt: T0, syncState: 'synced' });
  await d.table('examAttempts').put({ id: 'E1', examId: 'e', status: 'in_progress', startedAt: T0, updatedAt: T0, syncState: 'pending_sync' });
  await d.table('studySessions').put({ id: 'S1', sourceId: 's', mode: 'learn', view: 'original', location: { page: 3 }, updatedAt: T0, syncState: 'synced' });
  await d.table('outbox').bulkAdd([
    { op_id: 'op-sent', entity_type: 'annotation', entity_id: 'A1', op: 'append', payload: { id: 'A1' }, client_ts: T0, status: 'synced', attempts: 1, nextAttemptAt: 0 },
    { op_id: 'op-pending', entity_type: 'annotation', entity_id: 'A2', op: 'append', payload: { id: 'A2' }, client_ts: T0 + 1, status: 'pending', attempts: 2, nextAttemptAt: T0 + 60_000, lastError: 'offline' },
    { op_id: 'op-note', entity_type: 'note', entity_id: 'N2', op: 'upsert', payload: { id: 'N2' }, client_ts: T0 + 5, status: 'pending', attempts: 0, nextAttemptAt: 0 },
    { op_id: 'op-rejected', entity_type: 'flashcard', entity_id: 'F1', op: 'upsert', payload: { id: 'F1' }, client_ts: T0 + 6, status: 'rejected', attempts: 1, nextAttemptAt: 0, result: 'rejected', resultDetail: 'سبب' },
  ]);
  await d.table('syncInbox').put({ entity_type: 'study_session', entity_id: 'S9', seq: 41, entity: { id: 'S9' }, receivedAt: T0 });
  await d.table('kv').bulkPut([
    { key: 'sync.pull.since', value: 41, updatedAt: T0 },
    { key: 'sync.server.epoch', value: 'epoch-1', updatedAt: T0 },
  ]);
  await d.table('offlineSources').put({ sourceId: 's', versionId: 'v', sizeBytes: 10, downloadedAt: T0, parts: ['pages'] });
  await d.table('blobs').put({ id: 'B1', sourceId: 's', versionId: 'v', kind: 'page_image', mime: 'image/png', size: 3, data: new Blob([new Uint8Array([1, 2, 3])]), storedAt: T0 });
  await d.table('apiCache').put({ key: 'GET /api/library/tree', value: { nodes: [] }, storedAt: T0, etag: 'W/"1"' });
}

const V2_TABLES = ['annotations', 'notes', 'notePages', 'flashcards', 'reviewEvents', 'questionAttempts', 'examAttempts', 'studySessions', 'outbox', 'syncInbox', 'kv', 'offlineSources', 'apiCache'];

async function dump(d: Dexie): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of V2_TABLES) out[t] = await d.table(t).toArray();
  out.blobs = (await d.table('blobs').toArray()).map((b: { data: Blob }) => ({ ...b, data: b.data.size }));
  return out;
}

describe('LOCAL_SCHEMA Phase 1 bump (v3)', () => {
  it('is appended after v2; shipped entries are untouched', () => {
    expect(LOCAL_SCHEMA.map((s) => s.version)).toEqual([1, 2, 3]);
    expect(LOCAL_SCHEMA[1]!.stores).toEqual({ annotations: 'id, targetKey, updatedAt, syncState, [targetKey+kind], anchorStatus' });
    const v3 = LOCAL_SCHEMA[2]!;
    expect(v3.upgrade).toBeUndefined(); // index-only: no row is rewritten
    expect(Object.keys(v3.stores).sort()).toEqual(['annotations', 'copies', 'layers', 'notes', 'spaceCursors']);
  });

  it("upgrades the owner's v2 database: every row of every table is kept unchanged, unsynced ones included", async () => {
    const name = `upgrade-v3-${newId()}`;
    opened.push(name);
    const v2 = previousSchemaDb(name);
    await v2.open();
    expect(v2.verno).toBe(2);
    await seedEveryTable(v2);
    const before = await dump(v2);
    v2.close();

    const v3 = new MedLevoDB(name);
    await v3.open();
    expect(v3.verno).toBe(3);
    expect(await dump(v3)).toEqual(before);
    // the v2 indexes still answer
    expect((await v3.annotations.where('[targetKey+kind]').equals(['source_page:p1', 'text_highlight']).toArray()).map((r) => r.id)).toEqual(['A2']);
    expect((await v3.annotations.where('anchorStatus').equals('needs_reanchor').toArray()).map((r) => r.id)).toEqual(['A3']);
    expect((await v3.outbox.where('status').equals('pending').toArray()).map((o) => o.op_id).sort()).toEqual(['op-note', 'op-pending']);
    // the new tables exist and are empty
    expect(await v3.layers.count()).toBe(0);
    expect(await v3.copies.count()).toBe(0);
    expect(await v3.spaceCursors.count()).toBe(0);
    // legacy rows have no layerId (the default personal layer) and stay out of the new index
    expect(await v3.annotations.where('layerId').above('').count()).toBe(0);
    expect(await v3.notes.where('layerId').above('').count()).toBe(0);
    // every legacy outbox op targets the vault
    expect((await v3.outbox.toArray()).map(outboxTarget)).toEqual(['vault', 'vault', 'vault', 'vault']);
    v3.close();

    // opening again is a no-op
    const again = new MedLevoDB(name);
    await again.open();
    expect(await dump(again)).toEqual(before);
    again.close();
  });

  it('the new tables and indexes work: layers by document, items by layer, copies by source, a cursor per target', async () => {
    const name = `v3-${newId()}`;
    opened.push(name);
    const db = new MedLevoDB(name);
    await db.open();
    const layer: LayerRow = {
      id: 'L1',
      documentKey: 'source:s1',
      kind: 'followed',
      title: 'شرح سارة',
      writable: false,
      frozen: false,
      visible: true,
      locked: false,
      sortOrder: 1,
      updatedAt: T0,
      syncState: 'synced',
    };
    await db.layers.bulkPut([layer, { ...layer, id: 'L2', documentKey: 'source:s2', kind: 'personal', title: 'ملاحظاتي', writable: true }]);
    await db.annotations.bulkPut([
      { id: 'A1', targetKey: 'source_page:p1', kind: 'ink', anchor: {}, data: {}, updatedAt: T0, syncState: 'synced', layerId: 'L1' },
      { id: 'A2', targetKey: 'source_page:p1', kind: 'ink', anchor: {}, data: {}, updatedAt: T0, syncState: 'synced' },
    ]);
    await db.notes.put({ id: 'N1', body: body('x'), updatedAt: T0, syncState: 'synced', layerId: 'L1' });
    const copy: CopyRow = { id: 'C1', sourceId: 's1', mode: 'followed', personalLayerId: 'L2', copiedLayerId: 'L1', updatePolicy: 'preview', publicationId: 'P1', updatedAt: T0, syncState: 'synced' };
    await db.copies.put(copy);
    const cursor: SpaceCursorRecord = { target: 'space:sp1', since: 12, epoch: 'e1', updatedAt: T0 };
    await db.spaceCursors.put(cursor);

    expect((await db.layers.where('documentKey').equals('source:s1').toArray()).map((l) => l.id)).toEqual(['L1']);
    expect((await db.annotations.where('layerId').equals('L1').toArray()).map((a) => a.id)).toEqual(['A1']);
    expect((await db.notes.where('layerId').equals('L1').toArray()).map((n) => n.id)).toEqual(['N1']);
    expect((await db.copies.where('sourceId').equals('s1').toArray()).map((c) => c.id)).toEqual(['C1']);
    expect((await db.copies.where('publicationId').equals('P1').toArray()).map((c) => c.id)).toEqual(['C1']);
    expect(await db.spaceCursors.get('space:sp1')).toEqual(cursor);
    db.close();
  });

  it('layers are a synced entity type mirrored like the others (annotation_layer → layers)', () => {
    expect(SYNC_ENTITY_TYPES).toContain('annotation_layer');
    expect(ENTITY_TABLE.annotation_layer).toBe('layers');
    // the eight entity types of today keep their tables
    expect(ENTITY_TABLE).toMatchObject({
      annotation: 'annotations', note: 'notes', note_page: 'notePages', flashcard: 'flashcards', review_event: 'reviewEvents',
      question_attempt: 'questionAttempts', study_session: 'studySessions', exam_attempt: 'examAttempts',
    });
  });
});

describe('per-user database name (ADR-0003 §3.7) — a seam only: the app still opens «medlevo»', () => {
  it('names one database per user; the legacy owner (no user id yet) keeps today’s database', () => {
    expect(LOCAL_DB_NAME).toBe('medlevo');
    expect(localDbNameFor(null)).toBe('medlevo');
    expect(localDbNameFor(undefined)).toBe('medlevo');
    expect(localDbNameFor('01JUSER')).toBe('medlevo:01JUSER');
    expect(localDbNameFor('01JUSER')).not.toBe(localDbNameFor('01JOTHER'));
    expect(() => localDbNameFor('')).toThrow();
  });
});

describe('draft ownership rule (ARCHITECTURE_DELTA §4.5)', () => {
  it('a tagged draft belongs only to its writer; an untagged legacy draft only to the legacy owner', () => {
    expect(draftBelongsTo('u1', { userId: 'u1', isLegacyOwner: false })).toBe(true);
    expect(draftBelongsTo('u1', { userId: 'u2', isLegacyOwner: true })).toBe(false);
    expect(draftBelongsTo(null, { userId: 'u1', isLegacyOwner: true })).toBe(true);
    expect(draftBelongsTo(undefined, { userId: 'u1', isLegacyOwner: true })).toBe(true);
    expect(draftBelongsTo(null, { userId: 'u2', isLegacyOwner: false })).toBe(false);
  });
});
