// P1-T5 step 2 — «اربط بالمحاضرة الرسمية» and «انشر كمحاضرة رسمية» (BUILD_PLAN §3.7 `test/forks/link-private.test.ts`,
// X8 c; ARCHITECTURE_DELTA §6.9; PRD AOS-19H.3, 19H.4). Linking a private upload copies every item to the official
// version or the review list and leaves the private source byte-identical; candidates come only from the subjects the
// user belongs to and are computed in their own vault; promoting a private lecture registers the blob in the space by
// sha256 without copying bytes, and only a Subject Moderator may do it.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LectureFromVaultResponse, LinkToOfficialResponse, OfficialLinkCandidatesResponse, UploadResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { createLectureWorld, drain, lecturePdf, pagesFor, SPACE_A, SPACE_B, sp, type LectureWorld, type Person } from '../lectures/world';
import { inSpaceDb, inVault, op, publishLecture, type Published } from './helpers';
import { inkData, rt } from '../annotations/helpers';
import type { SyncOp } from '@medlevo/shared';

let w: LectureWorld;
let L: Published;
const PAGES = pagesFor('Cardiac', 6);
const SAME_BYTES = lecturePdf(PAGES);

function filesCount(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else n++;
    }
  };
  walk(dir);
  return n;
}

async function privateUpload(person: Person, name: string, data: Buffer): Promise<{ sourceId: string; versionId: string; pageIds: string[] }> {
  const folder = inVault(w, person, () => {
    const id = newId();
    const now = Date.now();
    w.t.ctx.db.run(`INSERT INTO library_node (id, parent_id, kind, title, created_at, updated_at) VALUES (?, NULL, 'folder', 'ملفاتي', ?, ?)`, [id, now, now]);
    return id;
  });
  const res = await w.upload(person, '/api/sources/upload', { name, data }, { node_id: folder, source_type: 'lecture' });
  expect(res.statusCode, res.body).toBe(200);
  const r = (res.json() as UploadResponse).results[0]!;
  expect(r.status, JSON.stringify(r)).not.toBe('rejected');
  await drain(w);
  await drain(w);
  return inVault(w, person, () => {
    const sourceId = r.source_id!;
    const versionId = w.t.ctx.db.get<{ v: string }>('SELECT current_version_id AS v FROM source WHERE id = ?', [sourceId])!.v;
    const pageIds = w.t.ctx.db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index', [versionId]).map((x) => x.id);
    return { sourceId, versionId, pageIds };
  });
}

async function ink(person: Person, src: { sourceId: string; versionId: string; pageIds: string[] }, pageIndex: number, note?: string): Promise<string[]> {
  const anchor = { type: 'page' as const, source_id: src.sourceId, version_id: src.versionId, page_id: src.pageIds[pageIndex]!, page_index: pageIndex, space: 'page_norm' as const };
  const ids = [newId()];
  const ops: SyncOp[] = [op({ entity_type: 'annotation', entity_id: ids[0]!, payload: { kind: 'ink', tool: 'pen', anchor, data: inkData(0.3), layer: 'ink', z: 0, locked: false } })];
  if (note) {
    ids.push(newId());
    ops.push(op({ entity_type: 'note', entity_id: ids[1]!, payload: { node_id: null, title: null, body: rt(note), anchor, origin: 'owner' } }));
  }
  const res = await w.req(person, 'POST', '/api/sync/push', { ops });
  expect(res.statusCode, res.body).toBe(200);
  return ids;
}

const snapshot = (person: Person, sourceId: string) =>
  inVault(w, person, () =>
    JSON.stringify([
      w.t.ctx.db.all('SELECT * FROM source WHERE id = ?', [sourceId]),
      w.t.ctx.db.all('SELECT * FROM source_version WHERE source_id = ? ORDER BY id', [sourceId]),
      w.t.ctx.db.all(`SELECT a.* FROM annotation a WHERE json_extract(a.anchor_json, '$.source_id') = ? ORDER BY a.id`, [sourceId]),
      w.t.ctx.db.all('SELECT * FROM note WHERE source_id = ? ORDER BY id', [sourceId]),
    ]),
  );

beforeAll(async () => {
  w = await createLectureWorld();
  L = await publishLecture(w, SPACE_A, 'Cardiac cycle (TEST FIXTURE)', PAGES);
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('«هذه المحاضرة موجودة رسميًا» — candidates', () => {
  it('the same file (sha256) and a re-exported variant (≥ 60 % of pages) are found; an unrelated deck is not', async () => {
    const same = await privateUpload('student', 'my cardiac.pdf', SAME_BYTES);
    const c1 = await w.ok<OfficialLinkCandidatesResponse>('student', 'GET', `/api/copies/link-candidates?source_id=${same.sourceId}`);
    expect(c1.candidates.map((c) => [c.lecture_id, c.basis])).toEqual([[L.lectureId, 'sha256']]);
    expect(c1.candidates[0]!.basis_ar[0]).toContain('موجودة رسميًا');
    const variant = await privateUpload('student', 'cardiac edited.pdf', lecturePdf(pagesFor('Cardiac', 6, { 5: 'my own extra summary page written by me' })));
    const c2 = await w.ok<OfficialLinkCandidatesResponse>('student', 'GET', `/api/copies/link-candidates?source_id=${variant.sourceId}`);
    expect(c2.candidates.map((c) => [c.lecture_id, c.basis])).toEqual([[L.lectureId, 'fingerprints']]);
    expect(c2.candidates[0]!.matched_pages).toBe(5);
    const other = await privateUpload('student', 'unrelated.pdf', lecturePdf(pagesFor('Ophthalmology retina', 4)));
    expect((await w.ok<OfficialLinkCandidatesResponse>('student', 'GET', `/api/copies/link-candidates?source_id=${other.sourceId}`)).candidates).toEqual([]);
  });

  it('a user who is not a member of the subject never sees its lecture as a candidate', async () => {
    const mine = await privateUpload('outsider', 'cardiac copy.pdf', SAME_BYTES);
    expect((await w.ok<OfficialLinkCandidatesResponse>('outsider', 'GET', `/api/copies/link-candidates?source_id=${mine.sourceId}`)).candidates).toEqual([]);
    const res = await w.req('outsider', 'POST', '/api/copies/link', { id: newId(), source_id: mine.sourceId, space_id: SPACE_A, lecture_id: L.lectureId, to_version_id: L.versionId });
    expect(res.statusCode).toBe(404);
    // another user's source id is «not found» in my vault
    expect((await w.req('student', 'GET', `/api/copies/link-candidates?source_id=${mine.sourceId}`)).statusCode).toBe(404);
  });
});

describe('«اربط بالمحاضرة الرسمية» — copy, never move', () => {
  it('every private item ends on the official version (or the review list); the private source is byte-identical', async () => {
    w.setAccess('contrib', SPACE_A, { access: 'member', roles: ['contributor'] });
    const priv = await privateUpload('contrib', 'cardiac lecture mine.pdf', SAME_BYTES);
    const ids = [...(await ink('contrib', priv, 1, 'ملاحظة على الصفحة الثانية')), ...(await ink('contrib', priv, 3))];
    const before = snapshot('contrib', priv.sourceId);
    const res = await w.ok<LinkToOfficialResponse>('contrib', 'POST', '/api/copies/link', { id: 'LINK_COPY_1', source_id: priv.sourceId, space_id: SPACE_A, lecture_id: L.lectureId, to_version_id: L.versionId });
    expect(res.copy.source_id).toBe(L.sourceId);
    expect(res.summary).toMatchObject({ total: 3, copied: 3, needs_review: 0, kept: 0 });
    expect(snapshot('contrib', priv.sourceId)).toBe(before);
    inVault(w, 'contrib', () => {
      const copies = w.t.ctx.db.all<{ migrated_from_id: string; anchor_json: string; layer_id: string | null }>(
        `SELECT migrated_from_id, anchor_json, layer_id FROM annotation WHERE origin = 'reanchor_copy' UNION ALL SELECT migrated_from_id, anchor_json, layer_id FROM note WHERE migrated_from_id IS NOT NULL`,
      );
      expect(copies.map((c) => c.migrated_from_id).sort()).toEqual([...ids].sort());
      for (const c of copies) {
        expect(JSON.parse(c.anchor_json)).toMatchObject({ source_id: L.sourceId, version_id: L.versionId });
        expect(c.layer_id).toBeNull(); // the stub's «ملاحظاتي»
      }
      expect(w.t.ctx.db.all('PRAGMA foreign_key_check')).toEqual([]);
    });
    // linking again copies nothing more
    const again = await w.ok<LinkToOfficialResponse>('contrib', 'POST', '/api/copies/link', { id: 'LINK_COPY_1', source_id: priv.sourceId, space_id: SPACE_A, lecture_id: L.lectureId, to_version_id: L.versionId });
    expect(again.copy.id).toBe(res.copy.id);
    inVault(w, 'contrib', () => expect(w.t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM annotation WHERE origin = 'reanchor_copy'`)!.n).toBe(2));
  });

  it('a file that does not match is refused with the reason; nothing is written', async () => {
    const other = await privateUpload('contrib', 'unrelated2.pdf', lecturePdf(pagesFor('Dermatology lesions', 3)));
    const res = await w.req('contrib', 'POST', '/api/copies/link', { id: newId(), source_id: other.sourceId, space_id: SPACE_A, lecture_id: L.lectureId, to_version_id: L.versionId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('60%');
  });
});

describe('«انشر كمحاضرة رسمية» (19H.4)', () => {
  it('a Subject Moderator promotes a private source: the blob is registered by sha256, no byte copied; a draft is created', async () => {
    const priv = await privateUpload('mod', 'histology lab.pdf', lecturePdf(pagesFor('Histology', 4)));
    const filesBefore = filesCount(w.t.ctx.config.filesDir);
    const res = await w.ok<LectureFromVaultResponse>('mod', 'POST', sp(SPACE_A, '/lectures/from-vault'), { source_id: priv.sourceId, title: 'Histology lab', lecture_no: 7 });
    expect(res.lecture).toMatchObject({ title: 'Histology lab', lecture_no: 7, status: 'draft' });
    expect(filesCount(w.t.ctx.config.filesDir)).toBe(filesBefore);
    const privSha = inVault(w, 'mod', () => w.t.ctx.db.get<{ s: string }>('SELECT f.sha256 AS s FROM source_version v JOIN stored_file f ON f.id = v.file_id WHERE v.id = ?', [priv.versionId])!.s);
    const spaceSha = inSpaceDb(w, SPACE_A, (db) => db.get<{ s: string }>('SELECT f.sha256 AS s FROM source_version v JOIN stored_file f ON f.id = COALESCE(v.file_id, v.original_file_id) WHERE v.id = ?', [res.version_id])!.s);
    expect(spaceSha).toBe(privSha);
    await drain(w);
    // published through the normal flow
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${res.lecture.id}/versions/${res.version_id}/publish`), {});
    // the same bytes again are refused (no duplicate official lecture)
    const again = await w.req('mod', 'POST', sp(SPACE_A, '/lectures/from-vault'), { source_id: priv.sourceId, title: 'Histology lab again' });
    expect(again.statusCode).toBe(409);
  });

  it('members without the role are refused (403), another subject’s moderator gets «not found»; an Assistant has no official power', async () => {
    const priv = await privateUpload('student', 'student file.pdf', lecturePdf(pagesFor('Student file', 2)));
    // gate 2: the route needs moderator access in THIS subject — a member who can see the subject gets 403, a stranger 404
    for (const who of ['student', 'contrib'] as const) {
      const r = await w.req(who, 'POST', sp(SPACE_A, '/lectures/from-vault'), { source_id: priv.sourceId, title: 'x' });
      expect(r.statusCode, who).toBe(403);
    }
    expect((await w.req('modB', 'POST', sp(SPACE_A, '/lectures/from-vault'), { source_id: priv.sourceId, title: 'x' })).statusCode).toBe(404);
    const a = await w.req('assistant', 'POST', sp(SPACE_A, '/lectures/from-vault'), { source_id: priv.sourceId, title: 'x' });
    expect(a.statusCode).toBe(403);
    // a moderator can only promote a source of THEIR OWN vault
    const notMine = await w.req('mod', 'POST', sp(SPACE_A, '/lectures/from-vault'), { source_id: priv.sourceId, title: 'x' });
    expect(notMine.statusCode).toBe(404);
    expect((await w.req('modB', 'POST', sp(SPACE_B, '/lectures/from-vault'), { source_id: priv.sourceId, title: 'x' })).statusCode).toBe(404);
  });
});
