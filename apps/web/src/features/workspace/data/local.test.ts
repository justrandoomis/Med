// Local-first writes and sync appliers of the workspace (IndexedDB via fake-indexeddb).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type AnnotationDTO, type NoteDTO, type StudySessionDTO } from '@medlevo/shared';
import { MedLevoDB, kvGet } from '../../../lib/localdb';
import type { ApplierContext } from '../../../lib/sync';
import { __test, createAnnotation, deleteNote, mergeServerAnnotations, noteRowFromDTO, rebasePendingSessionOps, saveNote, saveSession, SESSION_CONFLICT_KEY, sessionRowFromDTO, type WorkspaceNoteRow, type WorkspaceSessionRow } from './local';

let db: MedLevoDB;
beforeEach(async () => {
  db = new MedLevoDB(`ws-test-${newId()}`);
  await db.open();
});
afterEach(async () => {
  db.close();
  await db.delete();
});

const anchor = { type: 'page' as const, source_id: 'S1', version_id: 'V1', page_id: 'P1', page_index: 0, space: 'page_norm' as const };
const body = (t: string) => ({ v: 1 as const, paragraphs: [{ dir: 'rtl' as const, runs: [{ t }] }] });
const ctx = async (type: string, id: string, source: 'pull' | 'push' = 'pull'): Promise<ApplierContext> => ({
  db,
  source,
  localOps: await db.outbox.where('[entity_type+entity_id]').equals([type, id]).filter((o) => o.status !== 'synced').toArray(),
});

describe('local-first writes', () => {
  it('a note is saved with its outbox op in one transaction; edits carry base_rev; delete is a tombstone op', async () => {
    const row = await saveNote(db, { body: body('ملاحظة'), anchor }, null);
    const stored = (await db.notes.get(row.id)) as WorkspaceNoteRow;
    expect(stored).toMatchObject({ anchorKey: 'source_page:P1', sourceId: 'S1', syncState: 'pending_sync' });
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity_type: 'note', entity_id: row.id, op: 'upsert', base_rev: null });
    expect(ops[0]!.payload).toMatchObject({ id: row.id, body: body('ملاحظة'), anchor });
    // the server acknowledged rev 1; the next edit is based on it
    await db.notes.update(row.id, { rev: 1 });
    await db.outbox.update(ops[0]!.seq!, { status: 'synced' });
    const edited = await saveNote(db, { body: body('معدّلة'), anchor }, (await db.notes.get(row.id)) as WorkspaceNoteRow);
    const op2 = (await db.outbox.toArray()).at(-1)!;
    expect(op2).toMatchObject({ op: 'upsert', base_rev: 1 });
    await deleteNote(db, edited);
    const op3 = (await db.outbox.toArray()).at(-1)!;
    expect(op3).toMatchObject({ op: 'delete', base_rev: 1, payload: { id: row.id } });
    expect((await db.notes.get(row.id))?.deletedAt).toBeTypeOf('number');
  });

  it('a text highlight is written as an annotation on its page target', async () => {
    const a = await createAnnotation(db, { kind: 'text_highlight', anchor, data: { v: 1, style: 'highlight', color: 'marker-yellow', rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }], quote: { exact: 'periumbilical' } }, layer: 'highlight', tool: 'highlight' });
    expect(await db.annotations.get(a.id)).toMatchObject({ targetKey: 'source_page:P1', kind: 'text_highlight' });
    const op = (await db.outbox.toArray())[0]!;
    expect(op).toMatchObject({ entity_type: 'annotation', op: 'upsert' });
    expect((op.payload as Partial<AnnotationDTO>).anchor).toEqual(anchor);
  });

  it('autosaved sessions coalesce into one pending op carrying the full place', async () => {
    const row: WorkspaceSessionRow = { id: 'SESS', sourceId: 'S1', versionId: 'V1', mode: 'learn', view: 'original', location: { page_index: 1 }, rev: null, updatedAt: 0, syncState: 'pending_sync' };
    await saveSession(db, row);
    await saveSession(db, { ...row, location: { page_index: 3, zoom: 1.5, rotation: 90 } });
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect((ops[0]!.payload as Partial<StudySessionDTO>).location).toEqual({ page_index: 3, zoom: 1.5, rotation: 90 });
  });
});

describe('appliers (pull + push results → IndexedDB)', () => {
  const noteDTO = (p: Partial<NoteDTO> = {}): NoteDTO => ({ id: 'N1', node_id: null, title: null, body: body('من الخادم'), anchor, origin: 'owner', ai_record: null, rev: 3, conflict_of_id: null, device_id: 'OTHER', created_at: 1, updated_at: 2, deleted_at: null, ...p });

  it('writes a pulled note when nothing local is pending', async () => {
    await __test.noteApplier({ seq: 1, entity_type: 'note', entity_id: 'N1', entity: noteDTO() }, await ctx('note', 'N1'));
    expect(await db.notes.get('N1')).toMatchObject({ rev: 3, anchorKey: 'source_page:P1', syncState: 'synced' });
  });

  it('never overwrites a note with unsynced local edits (only follows the rev of our own acknowledged op)', async () => {
    const row = await saveNote(db, { id: 'N1', body: body('محلي'), anchor }, null);
    await __test.noteApplier({ seq: 2, entity_type: 'note', entity_id: row.id, entity: noteDTO() }, await ctx('note', row.id));
    expect(((await db.notes.get(row.id))!.body as ReturnType<typeof body>).paragraphs[0]!.runs[0]!.t).toBe('محلي');
    expect((await db.notes.get(row.id))!.rev ?? null).toBeNull();
    await __test.noteApplier({ seq: null, entity_type: 'note', entity_id: row.id, entity: noteDTO({ rev: 1 }) }, await ctx('note', row.id, 'push'));
    expect((await db.notes.get(row.id))!.rev).toBe(1);
    expect(((await db.notes.get(row.id))!.body as ReturnType<typeof body>).paragraphs[0]!.runs[0]!.t).toBe('محلي');
  });

  it('a refused session save (another device newer) is parked for the owner, the local place is kept', async () => {
    const row: WorkspaceSessionRow = { id: 'SESS', sourceId: 'S1', versionId: 'V1', mode: 'learn', view: 'original', location: { page_index: 1 }, rev: 1, updatedAt: 0, syncState: 'pending_sync' };
    await saveSession(db, row);
    const op = (await db.outbox.toArray())[0]!;
    await db.outbox.update(op.seq!, { status: 'conflict', result: 'rejected' });
    const server: StudySessionDTO = { id: 'SESS', source_id: 'S1', version_id: 'V1', mode: 'learn', view: 'original', location: { page_index: 9 }, scope: null, device_id: 'OTHER', rev: 2, created_at: 1, updated_at: 5 };
    await __test.sessionApplier({ seq: null, entity_type: 'study_session', entity_id: 'SESS', entity: server }, await ctx('study_session', 'SESS', 'push'));
    expect(await kvGet(db, SESSION_CONFLICT_KEY('SESS'))).toEqual(server);
    expect(((await db.studySessions.get('SESS')) as WorkspaceSessionRow).location.page_index).toBe(1);
    expect((await db.studySessions.get('SESS'))!.rev).toBe(1);
  });

  it('a pulled move from another device is applied with a visible remoteChange marker (no silent jump)', async () => {
    const base: StudySessionDTO = { id: 'SESS', source_id: 'S1', version_id: 'V1', mode: 'learn', view: 'original', location: { page_index: 1 }, scope: null, device_id: 'ME', rev: 1, created_at: 1, updated_at: 1 };
    await db.studySessions.put(sessionRowFromDTO(base));
    await __test.sessionApplier({ seq: 3, entity_type: 'study_session', entity_id: 'SESS', entity: { ...base, device_id: 'OTHER', rev: 2, location: { page_index: 7 } } }, await ctx('study_session', 'SESS'));
    const r = (await db.studySessions.get('SESS')) as WorkspaceSessionRow;
    expect(r.rev).toBe(2);
    expect(r.remoteChange).toMatchObject({ deviceId: 'OTHER', location: { page_index: 7 } });
  });

  it('seeding annotations from the server skips rows with local ops and older revisions', async () => {
    const mine = await createAnnotation(db, { kind: 'bookmark', anchor, data: { v: 1 }, layer: 'text' });
    const dto = (id: string, rev: number): AnnotationDTO => ({ id, kind: 'bookmark', tool: null, anchor, data: { v: 1, label: 'server' }, layer: 'text', z: 0, locked: false, anchor_status: 'ok', previous_anchor: null, input: null, device_id: 'OTHER', rev, created_at: 1, updated_at: 1, deleted_at: null });
    const n = await mergeServerAnnotations(db, [dto(mine.id, 4), dto('A2', 1)]);
    expect(n).toBe(1);
    expect((await db.annotations.get(mine.id))!.data).toEqual({ v: 1 });
    expect(await db.annotations.get('A2')).toMatchObject({ rev: 1, targetKey: 'source_page:P1', syncState: 'synced' });
    expect(await mergeServerAnnotations(db, [dto('A2', 1)])).toBe(0);
  });
});

// Regression (independent review of track B1): after the owner answered «موضع أحدث من جهاز آخر», a save that was
// still queued from before (e.g. read offline, reopened online) kept the refused base_rev — the coalesced next
// save inherited it, the server refused it again and the owner was asked a second time.
describe('session conflict resolution (§46)', () => {
  const server: StudySessionDTO = { id: 'SESS', source_id: 'S1', version_id: 'V1', mode: 'learn', view: 'original', location: { page_index: 9 }, scope: null, device_id: 'OTHER', rev: 4, created_at: 1, updated_at: 5 };
  const stale: WorkspaceSessionRow = { id: 'SESS', sourceId: 'S1', versionId: 'V1', mode: 'learn', view: 'original', location: { page_index: 2 }, rev: 3, updatedAt: 0, syncState: 'pending_sync' };

  it('«stay here»: queued saves move onto the server revision and keep this device\'s place', async () => {
    await saveSession(db, stale);
    expect((await db.outbox.toArray())[0]).toMatchObject({ base_rev: 3, status: 'pending' });
    expect(await rebasePendingSessionOps(db, server, false)).toBe(1);
    // the next autosave coalesces into the same op and keeps the new base
    await saveSession(db, { ...stale, rev: 4, location: { page_index: 3 } });
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ base_rev: 4 });
    expect((ops[0]!.payload as Partial<StudySessionDTO>).location).toEqual({ page_index: 3 });
  });

  it('«go there»: queued saves carry the other device\'s place (an older position never overwrites the choice)', async () => {
    await saveSession(db, stale);
    await rebasePendingSessionOps(db, server, true);
    const [op] = await db.outbox.toArray();
    expect(op).toMatchObject({ base_rev: 4 });
    expect((op!.payload as Partial<StudySessionDTO>).location).toEqual({ page_index: 9 });
  });

  it('leaves settled ops and other sessions alone', async () => {
    await saveSession(db, stale);
    await saveSession(db, { ...stale, id: 'OTHER_SESSION' });
    const first = (await db.outbox.toArray())[0]!;
    await db.outbox.update(first.seq!, { status: 'conflict' });
    expect(await rebasePendingSessionOps(db, server, false)).toBe(0);
    expect((await db.outbox.toArray()).map((o) => o.base_rev)).toEqual([3, 3]);
  });
});

// Regression (independent review of track B1): after a note conflict (conflict_kept_both) the original note
// stayed frozen with this device's text and the old rev — the device showed its own text twice (original +
// the server's conflict copy), never the other device's, and every later edit was stale again and spawned
// one more conflict copy on the server.
describe('note conflict kept both (§47)', () => {
  const serverNote = (p: Partial<NoteDTO>): NoteDTO => ({ id: 'N1', node_id: null, title: null, body: body('نص الجهاز الآخر'), anchor, origin: 'owner', ai_record: null, rev: 2, conflict_of_id: null, device_id: 'OTHER', created_at: 1, updated_at: 2, deleted_at: null, ...p });

  it('the original follows the server; this device\'s text lives in the copy; the next edit is based on the server rev', async () => {
    await db.notes.put(noteRowFromDTO(serverNote({ rev: 1, body: body('أصل') })));
    const mine = await saveNote(db, { body: body('نص هذا الجهاز'), anchor }, (await db.notes.get('N1')) as WorkspaceNoteRow);
    const op = (await db.outbox.toArray()).at(-1)!;
    expect(op).toMatchObject({ base_rev: 1 });
    // the server kept both: original = other device's text (rev 2), this device's text = new note N2
    await db.outbox.update(op.seq!, { status: 'conflict', result: 'conflict_kept_both', resultEntity: serverNote({}) });
    await __test.noteApplier({ seq: null, entity_type: 'note', entity_id: 'N1', entity: serverNote({}) }, await ctx('note', 'N1', 'push'));
    await __test.noteApplier({ seq: 5, entity_type: 'note', entity_id: 'N2', entity: serverNote({ id: 'N2', body: body('نص هذا الجهاز'), conflict_of_id: 'N1', device_id: 'ME', rev: 1 }) }, await ctx('note', 'N2'));
    const original = (await db.notes.get('N1')) as WorkspaceNoteRow;
    expect(original.rev).toBe(2);
    expect((original.body as ReturnType<typeof body>).paragraphs[0]!.runs[0]!.t).toBe('نص الجهاز الآخر');
    expect(((await db.notes.get('N2'))!.body as ReturnType<typeof body>).paragraphs[0]!.runs[0]!.t).toBe(((mine.body as ReturnType<typeof body>).paragraphs[0]!.runs[0]!.t));
    const next = await saveNote(db, { body: body('تعديل لاحق'), anchor }, original);
    expect((await db.outbox.toArray()).at(-1)).toMatchObject({ entity_id: next.id, base_rev: 2 });
  });

  it('an unsent edit still protects the note from a pulled copy', async () => {
    await saveNote(db, { id: 'N1', body: body('محلي غير مرسل'), anchor }, null);
    await __test.noteApplier({ seq: 9, entity_type: 'note', entity_id: 'N1', entity: serverNote({}) }, await ctx('note', 'N1'));
    expect(((await db.notes.get('N1'))!.body as ReturnType<typeof body>).paragraphs[0]!.runs[0]!.t).toBe('محلي غير مرسل');
  });
});

