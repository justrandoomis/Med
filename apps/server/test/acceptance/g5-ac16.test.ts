// G5 — AC-16 «ربط لاحق»: the course's question source is uploaded FIRST, the Appendicitis lecture LATER; the fitting
// questions appear on the lecture with the reason for the link and the pages of the question source AND the lecture.
// REAL pipeline (upload → processing → questions hook → extraction → matching), no AI. Also refutation paths: both
// files uploaded back to back (matching may run before extraction finished), an Arabic question bank + Arabic lecture,
// a lecture uploaded elsewhere and MOVED into the course later (then moved away), a question source first uploaded with
// the wrong type and corrected afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LectureQuestionsResponse, QuestionOriginalView, UploadResponse } from '@medlevo/shared';
import { expected } from '../processing/helpers';
import { multipart } from '../sources/helpers';
import { api, createNode, golden, listAll, questionAt, uploadAndProcess, type QApp } from '../questions/helpers';
import { acceptanceFixture, appWith } from './g5-helpers';

let t: QApp;

beforeAll(async () => {
  t = await appWith(null);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

async function forLecture(lectureId: string, pageId?: string): Promise<LectureQuestionsResponse> {
  const res = await api(t).get(`/api/questions/for-lecture/${lectureId}${pageId ? `?page_id=${pageId}` : ''}`);
  expect(res.statusCode).toBe(200);
  return res.json() as LectureQuestionsResponse;
}

/** Upload WITHOUT running the jobs (to queue several files back to back). */
async function uploadOnly(nodeId: string, name: string, data: Buffer, sourceType: string, title: string): Promise<{ sourceId: string; versionId: string }> {
  const body = multipart({ node_id: nodeId, source_type: sourceType, title, on_duplicate: 'create' }, [{ name, data }]);
  const res = await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...t.h, 'content-type': body.contentType }, payload: body.payload });
  expect(res.statusCode).toBe(200);
  const r = (res.json() as UploadResponse).results[0]!;
  return { sourceId: r.source_id!, versionId: r.version_id! };
}

const lecturePageIds = (versionId: string) => new Set(t.ctx.db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ?', [versionId]).map((p) => p.id));

/** The Golden expectations: A1–A4 directly covered with reasons + pages of both files; B1–B3 never «directly covered». */
async function expectGoldenLinks(qsId: string, lecture: { sourceId: string; versionId: string }, qsTitle: string) {
  const res = await forLecture(lecture.sourceId);
  expect(res.matching.state).toBe('done');
  const pages = lecturePageIds(lecture.versionId);
  for (const e of expected.matching.expect_linked_to_lecture as Array<{ section: string; n: string }>) {
    const qid = questionAt(t, qsId, e.section, e.n);
    const item = res.items.find((i) => i.question_id === qid);
    expect(item, `${e.section}${e.n} on the lecture`).toBeTruthy();
    expect(item!.link.relation).toBe('directly_covered');
    expect(item!.link.answerable_from_lecture).toBe(true);
    // the reason names the lecture pages it rests on — the same pages the link lists
    expect(item!.link.lecture_pages.length).toBeGreaterThan(0);
    for (const p of item!.link.lecture_pages) {
      expect(pages.has(p.page_id), 'lecture page of the current lecture version').toBe(true);
      expect(p.label_ar).toMatch(/^ص 1[1-4]$/);
      expect(item!.link.reason).toContain(p.label_ar);
    }
    expect(item!.link.reason).toMatch(/المحاضرة/);
    // and the question's own page in the question source (origin + an openable original location)
    expect(item!.origin_label_ar).toMatch(new RegExp(`^سؤال من مصدر الأسئلة — ${qsTitle} — ص \\d(–\\d)? — رقم السؤال ${e.n} \\(Section ${e.section}\\)$`));
    expect(item!.original?.source_id).toBe(qsId);
    expect(item!.original?.page_id).toBeTruthy();
    expect(item!.original?.bbox).toBeTruthy();
  }
  for (const e of expected.matching.expect_not_directly_covered as Array<{ section: string; n: string }>) {
    const item = res.items.find((i) => i.question_id === questionAt(t, qsId, e.section, e.n));
    if (item) expect(item.link.relation).not.toBe('directly_covered');
  }
  // one row per question (an exact duplicate in a second file is not listed twice)
  expect(new Set(res.items.map((i) => i.question_id)).size).toBe(res.items.length);
  return res;
}

describe('AC-16: question source first, lecture later (Golden Set)', () => {
  let course: string;
  let qs: { sourceId: string; versionId: string };
  let prev: { sourceId: string; versionId: string };
  let lecture: { sourceId: string; versionId: string };

  it('before the lecture exists its questions are already in the vault, unlinked', async () => {
    course = (await createNode(t, 'Surgery Course 1')).id;
    qs = await uploadAndProcess(t, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Surgery Course 1 Questions');
    prev = await uploadAndProcess(t, course, 'questions_previous_exam_2024.pdf', golden('questions_previous_exam_2024.pdf'), 'previous_exam', 'Previous exam 2024');
    expect(await listAll(t, `source_id=${qs.sourceId}`)).toHaveLength(7);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM question_lecture_link')!.n).toBe(0);
  });

  it('the lecture uploaded later shows A1–A4 with the reason, the lecture pages and the question source page', async () => {
    lecture = await uploadAndProcess(t, course, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Acute Appendicitis');
    const res = await expectGoldenLinks(qs.sourceId, lecture, 'Surgery Course 1 Questions');
    // A1 is printed in both files: one row, whose reason names the answer and its page
    const a1 = res.items.find((i) => i.question_id === questionAt(t, qs.sourceId, 'A', '1'))!;
    expect(questionAt(t, prev.sourceId, '', '1')).toBe(a1.question_id);
    expect(a1.link.reason).toContain("McBurney's point");
    expect(a1.link.reason).toContain('ص 11');
    // the original location opens on the question source page with the question's box
    const orig = (await api(t).get(`/api/questions/${a1.question_id}/original`)).json() as QuestionOriginalView;
    expect(orig.pages[0]!.page_id).toBe(a1.original!.page_id);
    expect(orig.pages[0]!.boxes.length).toBeGreaterThan(0);
    // the questions of the page being read come first (the table page carries the Alvarado question)
    const tablePage = t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 2', [lecture.versionId])!.id;
    const onPage = await forLecture(lecture.sourceId, tablePage);
    expect(onPage.items[0]!.on_this_page).toBe(true);
    expect(onPage.items[0]!.link.lecture_pages.map((p) => p.page_id)).toContain(tablePage);
  });
});

describe('AC-16: refutation paths', () => {
  it('both files uploaded back to back (matching may run before extraction finished) → the same links', async () => {
    const course = (await createNode(t, 'Surgery Course — back to back')).id;
    const qs = await uploadOnly(course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Bank B2B');
    const lecture = await uploadOnly(course, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Appendicitis B2B');
    await t.ctx.jobs.drain();
    await expectGoldenLinks(qs.sourceId, lecture, 'Bank B2B');
  });

  it('Arabic question bank first, Arabic lecture later → linked with Arabic reasons and the lecture pages', async () => {
    const course = (await createNode(t, 'الجراحة — المرارة')).id;
    const qar = await uploadAndProcess(t, course, 'g5_questions_ar.pdf', acceptanceFixture('g5_questions_ar.pdf'), 'question_source', 'بنك أسئلة المرارة');
    expect(await listAll(t, `source_id=${qar.sourceId}`)).toHaveLength(3);
    const lar = await uploadAndProcess(t, course, 'g5_lecture_ar.pdf', acceptanceFixture('g5_lecture_ar.pdf'), 'lecture', 'محاضرة التهاب المرارة');
    const res = await forLecture(lar.sourceId);
    expect(res.matching.state).toBe('done');
    const pages = lecturePageIds(lar.versionId);
    const q1 = res.items.find((i) => i.question_id === questionAt(t, qar.sourceId, '', '1'));
    const q2 = res.items.find((i) => i.question_id === questionAt(t, qar.sourceId, '', '2'));
    for (const [item, answer, page] of [[q1, 'مورفي', 'ص 1'], [q2, 'Ultrasound', 'ص 2']] as const) {
      expect(item, answer).toBeTruthy();
      expect(item!.link.relation).toBe('directly_covered');
      expect(item!.link.reason).toMatch(/^الإجابة \(«.+»\) مذكورة في المحاضرة/);
      expect(item!.link.reason).toContain(answer);
      expect(item!.link.lecture_pages.map((p) => p.label_ar)).toContain(page);
      for (const p of item!.link.lecture_pages) expect(pages.has(p.page_id)).toBe(true);
      expect(item!.origin_label_ar).toMatch(/^سؤال من مصدر الأسئلة — بنك أسئلة المرارة — ص 1 — رقم السؤال [12]$/);
    }
    // the femur question has nothing to do with this lecture
    const q3 = res.items.find((i) => i.question_id === questionAt(t, qar.sourceId, '', '3'));
    if (q3) expect(q3.link.relation).not.toBe('directly_covered');
  });

  it('a lecture uploaded elsewhere and MOVED into the course later gets its questions; moved away, it keeps none of them', async () => {
    const course = (await createNode(t, 'Surgery Course — moved lecture')).id;
    const other = (await createNode(t, 'Another course (no question sources)')).id;
    const inbox = (await createNode(t, 'Inbox', 'notebook')).id;
    const qs = await uploadAndProcess(t, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Bank Moved');
    const lecture = await uploadAndProcess(t, inbox, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Appendicitis (inbox)');
    expect((await forLecture(lecture.sourceId)).matching.state).toBe('no_question_sources');

    // PATCH node_id (the source's «نقل» dialog)
    expect((await api(t).patch(`/api/sources/${lecture.sourceId}`, { node_id: course })).statusCode).toBe(200);
    await t.ctx.jobs.drain();
    await expectGoldenLinks(qs.sourceId, lecture, 'Bank Moved');

    // drag & drop to a course without question sources: the old course's suggestions go, the state says why
    expect((await api(t).post(`/api/sources/${lecture.sourceId}/move`, { node_id: other })).statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const away = await forLecture(lecture.sourceId);
    expect(away.items).toHaveLength(0);
    expect(away.matching.state).toBe('no_question_sources');

    // and back again
    expect((await api(t).post(`/api/sources/${lecture.sourceId}/move`, { node_id: course })).statusCode).toBe(200);
    await t.ctx.jobs.drain();
    await expectGoldenLinks(qs.sourceId, lecture, 'Bank Moved');
  });

  it('an owner decision survives a move: a rejected link stays rejected, an accepted one stays', async () => {
    const course = (await createNode(t, 'Surgery Course — decisions')).id;
    const qs = await uploadAndProcess(t, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Bank Decisions');
    const lecture = await uploadAndProcess(t, course, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Appendicitis decisions');
    const res = await forLecture(lecture.sourceId);
    const a1 = res.items.find((i) => i.question_id === questionAt(t, qs.sourceId, 'A', '1'))!;
    const a2 = res.items.find((i) => i.question_id === questionAt(t, qs.sourceId, 'A', '2'))!;
    expect((await api(t).post(`/api/questions/links/${a1.link.id}/decision`, { status: 'accepted' })).statusCode).toBe(200);
    expect((await api(t).post(`/api/questions/links/${a2.link.id}/decision`, { status: 'rejected', reason: 'ليس من هذه المحاضرة' })).statusCode).toBe(200);
    const other = (await createNode(t, 'Elsewhere')).id;
    await api(t).post(`/api/sources/${lecture.sourceId}/move`, { node_id: other });
    await t.ctx.jobs.drain();
    const status = (id: string) => t.ctx.db.get<{ status: string }>('SELECT status FROM question_lecture_link WHERE id = ?', [id])?.status;
    expect(status(a1.link.id)).toBe('accepted');
    expect(status(a2.link.id)).toBe('rejected');
    const away = await forLecture(lecture.sourceId);
    expect(away.items.map((i) => i.question_id)).toEqual([a1.question_id]);
  });

  it('a question source uploaded with the wrong type («lecture») and corrected later gets extracted and linked', async () => {
    const course = (await createNode(t, 'Surgery Course — retyped')).id;
    const lecture = await uploadAndProcess(t, course, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Appendicitis retyped');
    const wrong = await uploadAndProcess(t, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'lecture', 'Bank Retyped');
    expect(await listAll(t, `source_id=${wrong.sourceId}`)).toHaveLength(0);
    expect((await forLecture(lecture.sourceId)).matching.state).toBe('no_question_sources');
    expect((await api(t).patch(`/api/sources/${wrong.sourceId}`, { source_type: 'question_source' })).statusCode).toBe(200);
    await t.ctx.jobs.drain();
    expect(await listAll(t, `source_id=${wrong.sourceId}`)).toHaveLength(7);
    await expectGoldenLinks(wrong.sourceId, lecture, 'Bank Retyped');
    // as a «lecture» it had been matched against the course: nothing of that remains
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM question_lecture_link WHERE lecture_source_id = ?`, [wrong.sourceId])!.n).toBe(0);
  });
});
