// P1-T5 step 1 — corrections of official lectures (ARCHITECTURE_DELTA §6.7; PRD AOS-18.9; review W2-step0 N1):
//   * a correction of a PUBLISHED version creates version n+1 (kind 'correction') through the page map — the regions of
//     the published version are immutable, so a citation pinned to them keeps its text;
//   * a draft version is corrected in place;
//   * a contributor's correction is a proposal in the moderators' queue; accepting it creates the new version,
//     rejecting it changes nothing; a student cannot propose.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficialCorrectionResponse, OfficialCorrectionsResponse, OfficialCorrectionView, OfficialLectureDetail, OfficialLectureView, UploadOfficialVersionResponse, VersionCompareResponse } from '@medlevo/shared';
import { createLectureWorld, drain, inSpace, lecturePdf, pagesFor, sp, SPACE_A, type LectureWorld } from './world';

let w: LectureWorld;
beforeAll(async () => {
  w = await createLectureWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});
const A = (rest: string) => sp(SPACE_A, rest);

async function publishedLecture(title: string, pages = 3): Promise<{ lecture: OfficialLectureView; versionId: string }> {
  const lecture = await w.ok<OfficialLectureView>('mod', 'POST', A('/lectures'), { title });
  const res = await w.upload('mod', A(`/lectures/${lecture.id}/upload`), { name: `${title}.pdf`, data: lecturePdf(pagesFor(title.replace(/\W/g, ''), pages)) });
  expect(res.statusCode, res.body).toBe(200);
  const v = res.json() as UploadOfficialVersionResponse;
  await drain(w);
  await w.ok('mod', 'POST', A(`/lectures/${lecture.id}/versions/${v.version_id}/publish`), {});
  return { lecture, versionId: v.version_id };
}

const firstRegion = (versionId: string) =>
  inSpace(w, SPACE_A, () =>
    w.t.ctx.db.get<{ id: string; text: string; page_id: string }>(
      `SELECT r.id, r.text, r.page_id FROM source_region r JOIN source_page p ON p.id = r.page_id
        WHERE r.version_id = ? AND r.text LIKE '%page 1:%' ORDER BY p.page_index, r.reading_order LIMIT 1`,
      [versionId],
    )!,
  );
const regionText = (id: string) => inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ text: string | null }>('SELECT text FROM source_region WHERE id = ?', [id])?.text ?? null);

describe('a moderator’s correction of a published version creates a new official version (§6.7)', () => {
  it('v2 carries the corrected text, v1’s region keeps its text verbatim, the page map pairs every page safely', async () => {
    const { lecture, versionId: v1 } = await publishedLecture('Correctable');
    const region = firstRegion(v1);
    const before = region.text;
    const res = await w.ok<OfficialCorrectionResponse>('mod', 'POST', A(`/lectures/${lecture.id}/corrections`), {
      version_id: v1,
      items: [{ region_id: region.id, text: 'Correctable page 1: the RIGHT renal artery arises from the abdominal aorta' }],
      note: 'تصحيح اسم الشريان',
    });
    expect(res.created_new_version).toBe(true);
    expect(res.review_item_id).toBeNull();
    expect(res.version_id).toBeTruthy();
    await drain(w);
    const d = await w.ok<OfficialLectureDetail>('student', 'GET', A(`/lectures/${lecture.id}`));
    expect(d.head_version?.id).toBe(res.version_id);
    expect(d.versions[0]).toMatchObject({ id: res.version_id, version_no: 2, kind: 'correction', status: 'published', change_note: 'تصحيح اسم الشريان', previous_version_id: v1, page_map_status: 'ready' });
    expect(d.versions[1]).toMatchObject({ id: v1, status: 'superseded' });
    // the published version is immutable: its region still says what it said
    expect(regionText(region.id)).toBe(before);
    const corrected = inSpace(w, SPACE_A, () =>
      w.t.ctx.db.get<{ text: string; text_origin: string }>(
        `SELECT text, text_origin FROM source_region WHERE version_id = ? AND text LIKE '%RIGHT renal artery%'`,
        [res.version_id],
      ),
    );
    expect(corrected).toMatchObject({ text_origin: 'owner' });
    // the new version is searchable with the corrected words, and the old one still with the old words
    const hits = inSpace(w, SPACE_A, () => w.t.ctx.db.all<{ version_id: string }>(`SELECT c.version_id FROM chunk_fts f JOIN document_chunk c ON c.rowid = f.rowid WHERE chunk_fts MATCH 'RIGHT'`));
    expect(hits.map((h) => h.version_id)).toContain(res.version_id);
    // identical pages map «safe» (same layout); the corrected page is mapped too
    const cmp = await w.ok<VersionCompareResponse>('mod', 'GET', A(`/lectures/${lecture.id}/versions/${v1}/compare/${res.version_id}`));
    expect(cmp.state).toBe('ready');
    expect(cmp.rows.every((r) => r.from && r.to)).toBe(true);
    expect(cmp.counts.inserted).toBe(0);
  });

  it('a draft version is corrected in place (no new version); a region of another version is refused', async () => {
    const lecture = await w.ok<OfficialLectureView>('mod', 'POST', A('/lectures'), { title: 'Draft only' });
    const up = (await w.upload('mod', A(`/lectures/${lecture.id}/upload`), { name: 'draft.pdf', data: lecturePdf(pagesFor('DraftOnly', 2)) })).json() as UploadOfficialVersionResponse;
    await drain(w);
    const region = firstRegion(up.version_id);
    const res = await w.ok<OfficialCorrectionResponse>('mod', 'POST', A(`/lectures/${lecture.id}/corrections`), { version_id: up.version_id, items: [{ region_id: region.id, text: 'DraftOnly page 1: corrected in place' }] });
    expect(res).toEqual({ version_id: up.version_id, created_new_version: false, review_item_id: null });
    expect(regionText(region.id)).toBe('DraftOnly page 1: corrected in place');
    const { versionId: otherV } = await publishedLecture('Other lecture');
    const foreign = firstRegion(otherV);
    const bad = await w.req('mod', 'POST', A(`/lectures/${lecture.id}/corrections`), { version_id: up.version_id, items: [{ region_id: foreign.id, text: 'x' }] });
    expect(bad.statusCode).toBe(404);
  });
});

describe('a contributor’s correction is a proposal the moderators decide (AOS-18.9)', () => {
  it('proposal → queue → accept → new version; reject changes nothing; a student cannot propose', async () => {
    const { lecture, versionId: v1 } = await publishedLecture('Proposed');
    const region = firstRegion(v1);
    const before = region.text;
    const proposal = await w.ok<OfficialCorrectionResponse>('contrib', 'POST', A(`/lectures/${lecture.id}/corrections`), {
      version_id: v1,
      items: [{ region_id: region.id, text: 'Proposed page 1: the LEFT renal artery' }],
      note: 'خطأ في الجهة',
    });
    expect(proposal.version_id).toBeNull();
    expect(proposal.created_new_version).toBe(false);
    expect(proposal.review_item_id).toBeTruthy();
    await drain(w);
    expect((await w.ok<OfficialLectureDetail>('mod', 'GET', A(`/lectures/${lecture.id}`))).versions).toHaveLength(1);

    // the queue: moderators only
    expect((await w.req('contrib', 'GET', A('/subject/corrections'))).statusCode).toBe(403);
    expect((await w.req('student', 'GET', A('/subject/corrections'))).statusCode).toBe(403);
    const queue = await w.ok<OfficialCorrectionsResponse>('mod', 'GET', A('/subject/corrections?status=open'));
    const item = queue.corrections.find((c) => c.id === proposal.review_item_id)!;
    expect(item).toMatchObject({ status: 'open', lecture: { id: lecture.id }, version: { id: v1, version_no: 1 }, note: 'خطأ في الجهة' });
    expect(item.proposed_by.id).toBe(w.id.contrib);
    expect(item.items[0]).toMatchObject({ region_id: region.id, before, after: 'Proposed page 1: the LEFT renal artery', page_index: 0 });

    // a contributor cannot decide; a moderator accepts → the job publishes version 2
    expect((await w.req('contrib', 'POST', A(`/lectures/${lecture.id}/corrections/${item.id}/decide`), { decision: 'accept' })).statusCode).toBe(403);
    const accepted = await w.ok<OfficialCorrectionView>('mod', 'POST', A(`/lectures/${lecture.id}/corrections/${item.id}/decide`), { decision: 'accept' });
    expect(accepted.status).toBe('queued');
    await drain(w);
    const done = (await w.ok<OfficialCorrectionsResponse>('mod', 'GET', A(`/subject/corrections?lecture_id=${lecture.id}`))).corrections.find((c) => c.id === item.id)!;
    expect(done.status).toBe('applied');
    expect(done.decided_by?.id).toBe(w.id.mod);
    const d = await w.ok<OfficialLectureDetail>('student', 'GET', A(`/lectures/${lecture.id}`));
    expect(d.head_version?.id).toBe(done.result_version_id);
    expect(d.versions[0]).toMatchObject({ version_no: 2, kind: 'correction' });
    expect(regionText(region.id)).toBe(before);
    // deciding twice is refused (the proposal is closed)
    expect((await w.req('mod', 'POST', A(`/lectures/${lecture.id}/corrections/${item.id}/decide`), { decision: 'reject' })).statusCode).toBe(409);

    // reject: nothing changes
    const p2 = await w.ok<OfficialCorrectionResponse>('contrib', 'POST', A(`/lectures/${lecture.id}/corrections`), { version_id: done.result_version_id, items: [{ region_id: firstRegion(done.result_version_id!).id, text: 'wrong' }] });
    const rejected = await w.ok<OfficialCorrectionView>('mod', 'POST', A(`/lectures/${lecture.id}/corrections/${p2.review_item_id}/decide`), { decision: 'reject', note_ar: 'النص الحالي صحيح.' });
    expect(rejected).toMatchObject({ status: 'rejected', decision_note: 'النص الحالي صحيح.' });
    await drain(w);
    expect((await w.ok<OfficialLectureDetail>('mod', 'GET', A(`/lectures/${lecture.id}`))).versions).toHaveLength(2);

    // a student sees the lecture but may not correct it
    const st = await w.req('student', 'POST', A(`/lectures/${lecture.id}/corrections`), { version_id: v1, items: [{ region_id: region.id, text: 'x' }] });
    expect(st.statusCode).toBe(403);
  });
});
