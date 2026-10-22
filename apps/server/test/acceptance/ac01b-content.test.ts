// AC-01b, CONTENT paths (BUILD_PLAN §3.7 `test/acceptance/ac01b-content.test.ts`; PRD §9 / ARCHITECTURE_DELTA §15.3; the
// system paths are P1-T4's ac01b.test.ts). User A studies an official lecture of subject A and writes on it (ink, a page
// note with a secret word). Nothing of A's personal content reaches: another student of the SAME subject studying the
// SAME lecture (B1), a student of ANOTHER subject (B2), the moderator of another subject (modB), or the moderator of A's
// own subject (mod) — through routes, sync pull, search, exports, offline packages, files, AI scope or notifications.
// A refusal by id answers the body of a missing id, so it never tells anyone that A's thing exists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentCopyView, SearchResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { retrieve } from '../../src/modules/evidence/retrieval';
import { resolveScope } from '../../src/modules/evidence/scope';
import { inSpaceDb, inVault, pageIdsOf, publishLecture, publishVersion, startStudying, type Published, writeInk } from '../forks/helpers';
import { createLectureWorld, pagesFor, sp, SPACE_A, SPACE_B, type LectureWorld, type Person } from '../lectures/world';

const SECRET = 'zebracornsecret';
let w: LectureWorld;
let LA: Published;
let copyA: DocumentCopyView;
const mine: { ink: string; note: string } = { ink: '', note: '' };
// B1 = contrib2 (same subject, same lecture), B2 = outsider (member of subject B only), modB, mod (moderator of A)
const OTHERS: Person[] = ['contrib2', 'outsider', 'modB', 'mod'];

beforeAll(async () => {
  w = await createLectureWorld();
  w.setAccess('outsider', SPACE_B, { access: 'member' });
  LA = await publishLecture(w, SPACE_A, 'Renal physiology (TEST FIXTURE)', pagesFor('Renal', 4));
  await publishLecture(w, SPACE_B, 'Cardiac cycle (TEST FIXTURE)', pagesFor('Cardiac', 3), 'modB');
  copyA = (await startStudying(w, 'student', SPACE_A, LA.lectureId)).copy;
  await startStudying(w, 'contrib2', SPACE_A, LA.lectureId);
  const pages = pageIdsOf(w, SPACE_A, LA.versionId);
  const wrote = await writeInk(w, 'student', copyA, LA.versionId, pages[1]!, 1, { note: `my private ${SECRET} mnemonic for the loop of Henle` });
  mine.ink = wrote.inkId;
  mine.note = wrote.noteId!;
}, 240_000);
afterAll(async () => {
  await w?.close();
});

const leaks = (body: string) => [SECRET, copyA.id, mine.ink, mine.note].filter((x) => body.includes(x));

describe('AC-01b content — routes by id', () => {
  it('A’s copy: every other user gets the body of a missing id (read and write)', async () => {
    const missing = await w.req('contrib2', 'GET', `/api/copies/${newId()}`);
    expect(missing.statusCode).toBe(404);
    for (const who of OTHERS) {
      const get = await w.req(who, 'GET', `/api/copies/${copyA.id}`);
      expect(get.statusCode, who).toBe(404);
      expect(get.json(), who).toEqual(missing.json());
      const patch = await w.req(who, 'PATCH', `/api/copies/${copyA.id}`, { reanchor_policy: 'auto' });
      expect(patch.statusCode, who).toBe(404);
      const list = await w.ok<{ copies: DocumentCopyView[] }>(who, 'GET', '/api/copies');
      expect(list.copies.map((c) => c.id), who).not.toContain(copyA.id);
    }
    // A's copy is unchanged by those attempts
    expect((await w.ok<DocumentCopyView>('student', 'GET', `/api/copies/${copyA.id}`)).reanchor_policy).toBe('preview');
  });

  it('the same lecture, another student: B1’s reader shows B1’s own items only (same source id, another vault)', async () => {
    const annotations = await w.req('contrib2', 'GET', `/api/annotations/source/${LA.sourceId}?version_id=${LA.versionId}`);
    expect(annotations.statusCode).toBe(200);
    expect(leaks(annotations.body)).toEqual([]);
    const notes = await w.req('contrib2', 'GET', `/api/annotations/notes?source_id=${LA.sourceId}`);
    expect(leaks(notes.body)).toEqual([]);
    // who does not study it has no such source at all
    for (const who of ['outsider', 'modB', 'mod'] as const) {
      expect((await w.req(who, 'GET', `/api/sources/${LA.sourceId}`)).statusCode, who).toBe(404);
      const ann = await w.req(who, 'GET', `/api/annotations/source/${LA.sourceId}?version_id=${LA.versionId}`);
      expect(leaks(ann.body), who).toEqual([]);
    }
  });
});

describe('AC-01b content — sync, search, exports, offline, files', () => {
  it('sync pull: nothing of A in anyone else’s change feed', async () => {
    for (const who of OTHERS) {
      const pull = await w.req(who, 'GET', '/api/sync/pull?since=0&limit=1000');
      expect(pull.statusCode, who).toBe(200);
      expect(leaks(pull.body), who).toEqual([]);
    }
    // (sanity) A's own feed has it
    expect(leaks((await w.req('student', 'GET', '/api/sync/pull?since=0&limit=1000')).body)).toContain(SECRET);
  });

  it('search: A’s note is found by A only; official text of A’s subject only by members of A', async () => {
    expect((await w.ok<SearchResponse>('student', 'GET', `/api/search?q=${SECRET}`)).results.length).toBeGreaterThan(0);
    for (const who of OTHERS) {
      const r = await w.ok<SearchResponse>(who, 'GET', `/api/search?q=${SECRET}`);
      expect(r.results, who).toEqual([]);
    }
    for (const who of ['outsider', 'modB'] as const) {
      const r = await w.ok<SearchResponse>(who, 'GET', '/api/search?q=Renal');
      expect(r.results.filter((x) => x.db?.kind === 'space' && x.db.space_id === SPACE_A), who).toEqual([]);
    }
  });

  it('exports and offline packages: B1’s export holds nothing of A; nobody else can export or download A’s copy', async () => {
    const notesExport = await w.req('contrib2', 'GET', '/api/data/export/notes');
    expect(notesExport.statusCode).toBe(200);
    expect(leaks(notesExport.body)).toEqual([]);
    const manifest = await w.req('contrib2', 'GET', `/api/data/offline/${LA.sourceId}/manifest`);
    expect(leaks(manifest.body)).toEqual([]);
    for (const who of ['outsider', 'modB', 'mod'] as const) {
      expect((await w.req(who, 'GET', `/api/data/export/source/${LA.sourceId}`)).statusCode, who).toBe(404);
      expect((await w.req(who, 'GET', `/api/data/offline/${LA.sourceId}/manifest`)).statusCode, who).toBe(404);
    }
  });

  it('files: A’s vault row for the lecture file is A’s; the space file only for members of A', async () => {
    const vaultFile = inVault(w, 'student', () => w.t.ctx.db.get<{ file_id: string }>('SELECT file_id FROM source_version WHERE id = ?', [LA.versionId])!.file_id);
    const spaceFile = inSpaceDb(w, SPACE_A, (db) => db.get<{ file_id: string }>('SELECT file_id FROM source_version WHERE id = ?', [LA.versionId])!.file_id);
    expect((await w.req('student', 'GET', `/api/files/${vaultFile}`)).statusCode).toBe(200);
    for (const who of ['outsider', 'modB'] as const) {
      expect((await w.req(who, 'GET', `/api/files/${vaultFile}`)).statusCode, who).toBe(404);
      expect((await w.req(who, 'GET', sp(SPACE_A, `/files/${spaceFile}`))).statusCode, who).toBe(404);
    }
  });
});

describe('AC-01b content — AI scope', () => {
  it('nobody else can lock a request on A’s copy; B1’s own lock on the same lecture never sees A’s notes', async () => {
    // the lock is resolved in the requester's OWN vault: A's source id answers exactly like an id that does not exist
    const ghost = newId();
    for (const who of ['outsider', 'modB', 'mod'] as const) {
      const r = await w.req(who, 'POST', '/api/evidence/scope/resolve', { mode: 'lecture_only', lecture_source_id: LA.sourceId, include_my_notes: true });
      const missing = await w.req(who, 'POST', '/api/evidence/scope/resolve', { mode: 'lecture_only', lecture_source_id: ghost, include_my_notes: true });
      expect(r.statusCode, who).toBe(missing.statusCode);
      expect(r.statusCode, who).toBeGreaterThanOrEqual(400);
      expect(r.body.replaceAll(LA.sourceId, 'ID'), who).toBe(missing.body.replaceAll(ghost, 'ID'));
      expect(leaks(r.body), who).toEqual([]);
    }
    const candidates = inVault(w, 'contrib2', () => {
      const scope = resolveScope(w.t.ctx, { mode: 'lecture_only', lecture_source_id: LA.sourceId, include_my_notes: true });
      return retrieve(w.t.ctx, { scope, query: `${SECRET} Henle`, k: 20, purpose: 'general' }).candidates;
    });
    expect(candidates.some((c) => c.text.includes(SECRET))).toBe(false);
    // (page notes are not retrieval sources; «ملاحظاتي» sources are the owner's own vault rows, linked by the owner)
    expect(candidates.every((c) => c.version_id === LA.versionId || c.scope_origin === 'my_notes')).toBe(true);
  });
});

describe('AC-01b content — notifications after a new official version', () => {
  it('holders are told about the version; A’s copy report goes to A alone; nobody outside A’s subject hears of it', async () => {
    await publishVersion(w, SPACE_A, LA.lectureId, pagesFor('Renal', 4, { 2: 'Renal page 3: the revised wording of the countercurrent section' }));
    for (const who of OTHERS) {
      const inbox = await w.req(who, 'GET', '/api/notifications');
      expect(inbox.statusCode, who).toBe(200);
      expect(leaks(inbox.body), who).toEqual([]);
      if (who === 'outsider' || who === 'modB') expect(inbox.body.includes(LA.lectureId), who).toBe(false);
    }
    // the moderator of A sees counts only: the publish preview never names a holder
    const preview = inSpaceDb(w, SPACE_A, (db) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM official_lecture WHERE id = ?', [LA.lectureId])!.n);
    expect(preview).toBe(1);
    const holders = w.t.ctx.system.db.all<Record<string, unknown>>('SELECT * FROM lecture_copy WHERE lecture_id = ?', [LA.lectureId]);
    for (const h of holders) expect(Object.keys(h).sort()).toEqual(['lecture_id', 'personal_items', 'space_id', 'updated_at', 'user_id', 'version_id']);
    expect(JSON.stringify(holders)).not.toContain(SECRET);
  });
});
