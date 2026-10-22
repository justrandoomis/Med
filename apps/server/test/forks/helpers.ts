// P1-T5 step 2 test helpers: official lectures published in a subject space (the step-1 world: SPACE_A / SPACE_B, a test
// membership provider) and the students' vaults. Every file is a TEST FIXTURE generated here.
import { expect } from 'vitest';
import type { DocumentCopyView, OfficialLectureView, StartStudyingResponse, SyncOp, SyncOpResult, UploadOfficialVersionResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { inkData, rt } from '../annotations/helpers';
import { drain, lecturePdf, type LectureWorld, type Person, sp } from '../lectures/world';

export interface Published {
  lectureId: string;
  sourceId: string;
  versionId: string;
}

/** A moderator creates, uploads (one PDF) and publishes an official lecture; returns its ids. */
export async function publishLecture(w: LectureWorld, space: string, title: string, pages: string[][], who: Person = 'mod'): Promise<Published> {
  const l = await w.ok<OfficialLectureView>(who, 'POST', sp(space, '/lectures'), { title, lecture_no: 1 });
  const up = await w.upload(who, sp(space, `/lectures/${l.id}/upload`), { name: `${title}.pdf`, data: lecturePdf(pages) });
  expect(up.statusCode, up.body).toBe(200);
  const v = up.json() as UploadOfficialVersionResponse;
  await drain(w);
  await w.ok(who, 'POST', sp(space, `/lectures/${l.id}/versions/${v.version_id}/publish`), {});
  await drain(w);
  const sourceId = inSpaceDb(w, space, (db) => db.get<{ source_id: string }>('SELECT source_id FROM official_lecture WHERE id = ?', [l.id])!.source_id);
  return { lectureId: l.id, sourceId, versionId: v.version_id };
}

/** Upload and publish a NEW version of an existing official lecture. */
export async function publishVersion(w: LectureWorld, space: string, lectureId: string, pages: string[][], name = 'v2.pdf'): Promise<string> {
  const up = await w.upload('mod', sp(space, `/lectures/${lectureId}/upload`), { name, data: lecturePdf(pages) });
  expect(up.statusCode, up.body).toBe(200);
  const v = up.json() as UploadOfficialVersionResponse;
  await drain(w);
  await w.ok('mod', 'POST', sp(space, `/lectures/${lectureId}/versions/${v.version_id}/publish`), {});
  await drain(w);
  return v.version_id;
}

export function vaultIdOf(w: LectureWorld, person: Person): string {
  return w.t.ctx.system.vaults.ofUserInternal(w.id[person])!.id;
}

/** Run `fn` with a person's vault bound (direct row assertions). */
export function inVault<T>(w: LectureWorld, person: Person, fn: () => T): T {
  return w.t.ctx.binding.run({ kind: 'vault', vaultId: vaultIdOf(w, person), viewer: null }, fn);
}

export function inSpaceDb<T>(w: LectureWorld, space: string, fn: (db: ReturnType<LectureWorld['t']['ctx']['dbs']['space']>) => T): T {
  return fn(w.t.ctx.dbs.space(space));
}

export async function startStudying(w: LectureWorld, person: Person, space: string, lectureId: string, id = newId(), extra: Record<string, unknown> = {}): Promise<StartStudyingResponse> {
  return w.ok<StartStudyingResponse>(person, 'POST', '/api/copies', { id, space_id: space, lecture_id: lectureId, mode: 'personal', ...extra });
}

let n = 0;
export function op(o: Partial<SyncOp> & Pick<SyncOp, 'entity_type' | 'entity_id'>): SyncOp {
  n++;
  return { op_id: `${newId()}${String(n).padStart(4, '0').slice(-4)}`, device_id: 'DEVICE_S', op: 'upsert', payload: {}, client_ts: Date.now(), ...o };
}

export function pageIdsOf(w: LectureWorld, space: string, versionId: string): string[] {
  return inSpaceDb(w, space, (db) => db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index', [versionId]).map((r) => r.id));
}

/** Ink (and optionally a page note) written by `person` on page `pageIndex` of a version of the lecture (sync push). */
export async function writeInk(w: LectureWorld, person: Person, copy: DocumentCopyView, versionId: string, pageId: string, pageIndex: number, opts: { note?: string; x?: number } = {}): Promise<{ inkId: string; noteId: string | null }> {
  const anchor = { type: 'page' as const, source_id: copy.source_id, version_id: versionId, page_id: pageId, page_index: pageIndex, space: 'page_norm' as const };
  const inkId = newId();
  const ops: SyncOp[] = [op({ entity_type: 'annotation', entity_id: inkId, payload: { kind: 'ink', tool: 'pen', anchor, data: inkData(opts.x ?? 0.2), layer: 'ink', z: 0, locked: false } })];
  let noteId: string | null = null;
  if (opts.note) {
    noteId = newId();
    ops.push(op({ entity_type: 'note', entity_id: noteId, payload: { node_id: null, title: null, body: rt(opts.note), anchor, origin: 'owner' } }));
  }
  const res = await w.req(person, 'POST', '/api/sync/push', { ops });
  expect(res.statusCode, res.body).toBe(200);
  for (const r of res.json().results as SyncOpResult[]) expect(r.result, JSON.stringify(r)).toBe('applied');
  return { inkId, noteId };
}

export function holdings(w: LectureWorld, person: Person, space: string, lectureId: string): Array<{ version_id: string; personal_items: number }> {
  return w.t.ctx.system.db.all<{ version_id: string; personal_items: number }>(
    'SELECT version_id, personal_items FROM lecture_copy WHERE user_id = ? AND space_id = ? AND lecture_id = ? ORDER BY version_id',
    [w.id[person], space, lectureId],
  );
}
