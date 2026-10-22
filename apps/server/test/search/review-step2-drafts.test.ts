// P1-T5 step 2 review R-E — a DRAFT official lecture must not influence what members get from the federated search,
// not even through ranking: bm25 statistics (document count, term frequencies, average length) are computed over every
// row of the scoped FTS index, so a draft indexed there changes the ORDER of a member's official hits — a side channel
// telling students which terms an unpublished draft is full of. Only PUBLISHED official versions are indexed; a version
// enters the index in the transaction that publishes it. Every file here is a TEST FIXTURE.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficialLectureView, SearchResponse, UploadOfficialVersionResponse } from '@medlevo/shared';
import { scopeToken } from '../../src/modules/search/scopeTokens';
import { createLectureWorld, drain, lecturePdf, SPACE_A, sp, type LectureWorld } from '../lectures/world';
import { publishLecture } from '../forks/helpers';

let w: LectureWorld;
const filler = (i: number) => `filler words number ${i} about nothing in particular here`;
const space = () => w.t.ctx.dbs.space(SPACE_A);
const indexed = (versionId: string) => space().get<{ n: number }>(`SELECT COUNT(*) AS n FROM chunk_scope_fts WHERE chunk_scope_fts MATCH ?`, [`scope : ${scopeToken('v', versionId)}`])!.n;
const order = async () => (await w.ok<SearchResponse>('student', 'GET', '/api/search?q=quuxalpha%20quuxbeta&scope=subjects')).results.map((r) => r.source_title);

beforeAll(async () => {
  w = await createLectureWorld();
  // two official chunks: one alpha-heavy, one beta-heavy; six more published chunks with alpha only (idf(alpha) ≈ 0)
  await publishLecture(w, SPACE_A, 'Alpha heavy', [['quuxalpha quuxalpha quuxalpha quuxbeta', filler(1), filler(2)]]);
  await publishLecture(w, SPACE_A, 'Beta heavy', [['quuxalpha quuxbeta quuxbeta quuxbeta', filler(3), filler(4)]]);
  for (let i = 0; i < 6; i++) await publishLecture(w, SPACE_A, `Alpha only ${i}`, [[`quuxalpha appears here ${i}`, filler(10 + i), filler(20 + i)]]);
}, 600_000);
afterAll(async () => w?.close());

describe('R-E: drafts stay out of the scoped index (no bm25 side channel)', () => {
  let draftVersion = '';
  let draftLecture = '';

  it('a moderator’s draft full of «quuxbeta» changes neither the index nor the order a student sees', async () => {
    const before = await order();
    expect(before).toEqual(['Beta heavy', 'Alpha heavy']);
    const l = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Draft beta' });
    draftLecture = l.id;
    const pages = Array.from({ length: 80 }, (_, i) => [`quuxbeta draft page ${i}`, filler(40 + i), filler(60 + i)]);
    const up = await w.upload('mod', sp(SPACE_A, `/lectures/${l.id}/upload`), { name: 'draft.pdf', data: lecturePdf(pages) });
    expect(up.statusCode, up.body).toBe(200);
    draftVersion = (up.json() as UploadOfficialVersionResponse).version_id;
    await drain(w);
    expect(space().get<{ n: number }>('SELECT COUNT(*) AS n FROM document_chunk WHERE version_id = ?', [draftVersion])!.n).toBeGreaterThan(4);
    expect(indexed(draftVersion)).toBe(0);
    expect(await order()).toEqual(before);
  });

  it('publishing the version indexes it in the same transaction; it is then searchable like any head', async () => {
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${draftLecture}/versions/${draftVersion}/publish`), {});
    expect(indexed(draftVersion)).toBeGreaterThan(4);
    const r = await w.ok<SearchResponse>('student', 'GET', '/api/search?q=quuxbeta%20draft&scope=subjects');
    expect(r.results.some((x) => x.source_title === 'Draft beta')).toBe(true);
  });

  it('reprocessing a published version re-indexes it; a later draft version of the same lecture is not indexed', async () => {
    const up = await w.upload('mod', sp(SPACE_A, `/lectures/${draftLecture}/upload`), { name: 'draft v2.pdf', data: lecturePdf([['quuxbeta second version text', filler(200), filler(201)]]) });
    expect(up.statusCode, up.body).toBe(200);
    const v2 = (up.json() as UploadOfficialVersionResponse).version_id;
    await drain(w);
    expect(indexed(v2)).toBe(0);
    expect(indexed(draftVersion)).toBeGreaterThan(4);
  });
});
