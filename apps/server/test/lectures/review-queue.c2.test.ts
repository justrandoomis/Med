// Phase 1 completion, track C2 — AOS-3.18 (the review queue is role-scoped; uncertain values have no effect until a
// human decides; a human decision is never overridden) and AOS-3.11 (an upload whose pages match an existing official
// lecture is proposed as «إصدار جديد من …»; confirmed → a new source_version of THAT lecture, and its followers are told
// through P1-T4's notifications when it is published). Real channels (pubWorld): سارة is the Subject Moderator,
// مصطفى an Assistant (no official power), زينب a student holding a copy of the lecture, physio a student of the other
// subject. Every file is a TEST FIXTURE generated here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecideSubjectReviewResponse, ImportSuggestionListResponse, OfficialLectureDetail, OfficialLectureView, SubjectReviewResponse, UploadOfficialVersionResponse } from '@medlevo/shared';
import { call, ok } from '../channels/helpers';
import { createPubWorld, settle, startPersonal, type PubWorld, type Who } from '../forks/pubWorld';
import { lecturePdf, multipart, pagesFor } from './world';

let w: PubWorld;

async function upload(who: Who, lectureId: string, name: string, pages: string[][]): Promise<string> {
  const mp = multipart({}, { name, data: lecturePdf(pages) });
  const up = await w.t.app.inject({ method: 'POST', url: w.S(`/lectures/${lectureId}/upload`), headers: { ...w.p[who].h, 'content-type': mp.contentType }, payload: mp.body });
  expect(up.statusCode, up.body).toBe(200);
  return (up.json() as UploadOfficialVersionResponse).version_id;
}

async function draft(title: string, extra: Record<string, unknown> = {}): Promise<OfficialLectureView> {
  return ok<OfficialLectureView>(await call(w.t, w.p.sara.h, 'POST', w.S('/lectures'), { title, ...extra }));
}

const review = async (who: Who = 'sara') => ok<SubjectReviewResponse>(await call(w.t, w.p[who].h, 'GET', w.S('/subject/review')));

beforeAll(async () => {
  w = await createPubWorld(6);
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('3.11 — «إصدار جديد من …»: proposed, confirmed by the moderator, then its followers are told', () => {
  let B: OfficialLectureView;
  it('a re-exported file uploaded as a new lecture is proposed as a new version of the existing one — only to the subject moderators', async () => {
    await startPersonal(w, 'zainab'); // a holder of a copy of the lecture
    B = await draft('Lecture 5 (re-exported by the department)');
    await upload('sara', B.id, 'lecture5-reexport.pdf', pagesFor('Lecture 5', 6, { 5: 'a brand new final summary slide added this year' }));
    await w.t.ctx.jobs.drain();
    const q = await review();
    const nv = q.items.find((i) => i.suggestion.field === 'new_version_of');
    expect(nv, JSON.stringify(q.items.map((i) => i.suggestion.field))).toBeTruthy();
    expect(nv!.lecture).toMatchObject({ id: B.id, status: 'in_review' === B.status ? 'in_review' : B.status });
    expect(nv!.target_lecture).toMatchObject({ id: w.lecture.id, status: 'published', head_version_no: 1 });
    expect(nv!.suggestion.reasons_ar.length).toBeGreaterThan(0);
    // role-scoped: a member is refused, an Assistant has no power over official content, strangers see nothing
    expect((await call(w.t, w.p.zainab.h, 'GET', w.S('/subject/review'))).statusCode).toBe(403);
    expect((await call(w.t, w.p.mustafa.h, 'GET', w.S('/subject/review'))).statusCode).toBe(403);
    expect((await call(w.t, w.p.physio.h, 'GET', w.S('/subject/review'))).statusCode).toBe(404);
    expect((await call(w.t, w.p.ahmad.h, 'GET', w.S('/subject/review'))).statusCode).toBe(404);
    // the student's own review queue is her vault's: nothing of the subject's uploads is in it
    const mine = ok<ImportSuggestionListResponse>(await call(w.t, w.p.zainab.h, 'GET', '/api/versions/suggestions'));
    expect(mine.suggestions.map((s) => s.id)).not.toContain(nv!.suggestion.id);
    // undecided, it changes nothing: the lecture still has one version
    expect(ok<OfficialLectureDetail>(await call(w.t, w.p.sara.h, 'GET', w.S(`/lectures/${w.lecture.id}`))).versions).toHaveLength(1);
  });

  it('accepting makes the file a new DRAFT version of the existing lecture (same stored file); the duplicate draft leaves', async () => {
    const q = await review();
    const nv = q.items.find((i) => i.suggestion.field === 'new_version_of')!;
    // a member cannot decide
    expect((await call(w.t, w.p.zainab.h, 'POST', w.S(`/subject/review/${nv.suggestion.id}/decide`), { action: 'accept' })).statusCode).toBe(403);
    expect((await call(w.t, w.p.mustafa.h, 'POST', w.S(`/subject/review/${nv.suggestion.id}/decide`), { action: 'accept' })).statusCode).toBe(403);
    const res = ok<DecideSubjectReviewResponse>(await call(w.t, w.p.sara.h, 'POST', w.S(`/subject/review/${nv.suggestion.id}/decide`), { action: 'accept' }));
    expect(res.new_version).toMatchObject({ lecture_id: w.lecture.id, version_no: 2 });
    expect(res.result_ar).toContain('الإصدار 2');
    const db = w.t.ctx.dbs.space(w.space);
    const files = db.all<{ version_no: number; f: string | null }>('SELECT version_no, COALESCE(file_id, original_file_id) AS f FROM source_version WHERE source_id = ? ORDER BY version_no', [w.lecture.sourceId]);
    const uploaded = db.get<{ f: string }>('SELECT COALESCE(v.file_id, v.original_file_id) AS f FROM source_version v JOIN official_lecture l ON l.source_id = v.source_id WHERE l.id = ?', [B.id])!.f;
    expect(files.map((f) => f.version_no)).toEqual([1, 2]);
    expect(files[1]!.f).toBe(uploaded); // no byte copy: the same stored file
    // the new version waits as a draft (students still read version 1); the duplicate lecture is gone for everyone
    const detail = ok<OfficialLectureDetail>(await call(w.t, w.p.sara.h, 'GET', w.S(`/lectures/${w.lecture.id}`)));
    expect(detail.head_version!.version_no).toBe(1);
    expect(detail.versions.find((v) => v.version_no === 2)).toMatchObject({ status: 'draft' });
    expect((await call(w.t, w.p.zainab.h, 'GET', w.S(`/lectures/${B.id}`))).statusCode).toBe(404);
    expect(ok<OfficialLectureDetail>(await call(w.t, w.p.sara.h, 'GET', w.S(`/lectures/${B.id}`))).withdrawn).toMatchObject({ reason: 'replaced' });
    expect((await review()).items.some((i) => i.suggestion.id === nv.suggestion.id)).toBe(false);
    // deciding twice is refused (409), nothing changes
    expect((await call(w.t, w.p.sara.h, 'POST', w.S(`/subject/review/${nv.suggestion.id}/decide`), { action: 'accept' })).statusCode).toBe(409);
  });

  it('publishing the new version tells the holders of the lecture (P1-T4 inbox), never the moderator by mistake', async () => {
    await w.t.ctx.jobs.drain();
    const v2 = ok<OfficialLectureDetail>(await call(w.t, w.p.sara.h, 'GET', w.S(`/lectures/${w.lecture.id}`))).versions.find((v) => v.version_no === 2)!;
    ok(await call(w.t, w.p.sara.h, 'POST', w.S(`/lectures/${w.lecture.id}/versions/${v2.id}/publish`), {}));
    await settle(w);
    await settle(w);
    const inbox = ok<{ items: Array<{ kind: string; payload: Record<string, unknown> }> }>(await call(w.t, w.p.zainab.h, 'GET', '/api/notifications'));
    const told = inbox.items.find((n) => n.kind === 'official_version');
    expect(told, JSON.stringify(inbox.items.map((i) => i.kind))).toBeTruthy();
    expect(told!.payload).toMatchObject({ version_no: 2 });
    const other = ok<{ items: Array<{ kind: string }> }>(await call(w.t, w.p.physio.h, 'GET', '/api/notifications'));
    expect(other.items.some((n) => n.kind === 'official_version')).toBe(false);
  });
});

describe('3.18 — an uncertain number waits for the moderator; a certain one fills an empty number; a human decision wins', () => {
  it('a weak hint («L9») is only proposed: no number until the moderator accepts it', async () => {
    const C = await draft('Histology of the kidney');
    await upload('sara', C.id, 'L9 histology.pdf', pagesFor('Histology kidney', 3));
    await w.t.ctx.jobs.drain();
    const item = (await review()).items.find((i) => i.lecture?.id === C.id && i.suggestion.field === 'lecture_no');
    expect(item?.suggestion).toMatchObject({ certainty: 'uncertain', status: 'open', value: { field: 'lecture_no', lecture_no: 9 } });
    expect(ok<OfficialLectureView>(await call(w.t, w.p.sara.h, 'GET', w.S(`/lectures/${C.id}`))).lecture_no).toBeNull(); // no effect yet
    const res = ok<DecideSubjectReviewResponse>(await call(w.t, w.p.sara.h, 'POST', w.S(`/subject/review/${item!.suggestion.id}/decide`), { action: 'accept' }));
    expect(res.item.lecture).toMatchObject({ id: C.id, lecture_no: 9 });
    expect(ok<OfficialLectureView>(await call(w.t, w.p.sara.h, 'GET', w.S(`/lectures/${C.id}`)))).toMatchObject({ lecture_no: 9, lecture_no_origin: 'moderator' });
  });

  it('«Lecture 12» in the file name fills an empty number (detected); a moderator\'s number is never overwritten by analysis', async () => {
    const D = await draft('Renal physiology');
    await upload('sara', D.id, 'Lecture 12 renal physiology.pdf', pagesFor('Renal physiology', 3));
    await w.t.ctx.jobs.drain();
    expect(ok<OfficialLectureView>(await call(w.t, w.p.sara.h, 'GET', w.S(`/lectures/${D.id}`)))).toMatchObject({ lecture_no: 12, lecture_no_origin: 'detected' });
    const E = await draft('Cardiac output', { lecture_no: 3 });
    await upload('sara', E.id, 'Lecture 14 cardiac output.pdf', pagesFor('Cardiac output', 3));
    await w.t.ctx.jobs.drain();
    expect(ok<OfficialLectureView>(await call(w.t, w.p.sara.h, 'GET', w.S(`/lectures/${E.id}`)))).toMatchObject({ lecture_no: 3, lecture_no_origin: 'moderator' });
  });

  it('rejecting a proposal keeps it from coming back, and changes nothing else', async () => {
    const F = await draft('Endocrine pancreas');
    await upload('sara', F.id, 'session 4 endocrine.pdf', pagesFor('Endocrine pancreas', 3));
    await w.t.ctx.jobs.drain();
    const item = (await review()).items.find((i) => i.lecture?.id === F.id && i.suggestion.field === 'lecture_no')!;
    const res = ok<DecideSubjectReviewResponse>(await call(w.t, w.p.sara.h, 'POST', w.S(`/subject/review/${item.suggestion.id}/decide`), { action: 'reject' }));
    expect(res.item.suggestion.status).toBe('rejected');
    expect(ok<OfficialLectureView>(await call(w.t, w.p.sara.h, 'GET', w.S(`/lectures/${F.id}`))).lecture_no).toBeNull();
    // reprocessing the same file does not bring the rejected value back
    const v = ok<OfficialLectureDetail>(await call(w.t, w.p.sara.h, 'GET', w.S(`/lectures/${F.id}`))).versions[0]!;
    ok(await call(w.t, w.p.sara.h, 'POST', w.S(`/sources/versions/${v.id}/reprocess`), {}));
    await w.t.ctx.jobs.drain();
    expect((await review()).items.some((i) => i.lecture?.id === F.id && i.suggestion.field === 'lecture_no')).toBe(false);
  });
});
