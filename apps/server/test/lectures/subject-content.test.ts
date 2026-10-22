// P1-T5 step 1 — the subject's content in its space (ARCHITECTURE_DELTA §4.4 `3010_subject_content`, §5.3 «subject
// attachment / exam date: publish — C: d (approval)»; PRD AOS-2.5, 2.9; IA §4.2 «الملفات», «التحديثات»):
//   attachments (a contributor's upload is a draft a moderator publishes; drafts and their files are hidden from
//   students), the exam-date table (create / replace / cancel by a client id, idempotent), and the updates feed
//   (`subject_event`, written in the same change, cursor-paginated, never another subject's rows).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CursorPage, OfficialLectureView, SubjectAttachmentsResponse, SubjectAttachmentView, SubjectEventView, SubjectExamDatesResponse, SubjectExamDateView, SubjectDuplicatesResponse, UploadOfficialVersionResponse } from '@medlevo/shared';
import { createLectureWorld, drain, lecturePdf, pagesFor, sp, SPACE_A, SPACE_B, type LectureWorld } from './world';

let w: LectureWorld;
beforeAll(async () => {
  w = await createLectureWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});
const A = (rest: string) => sp(SPACE_A, rest);
const events = async (person: 'student' | 'mod', q = '') => (await w.ok<CursorPage<SubjectEventView>>(person, 'GET', A(`/subject/events${q}`))).items;

describe('attachments (AOS-2.5): summaries, previous exams, references', () => {
  let draft: SubjectAttachmentView;

  it('a contributor’s attachment is a draft: hidden (and its file) from students until a moderator publishes it', async () => {
    const res = await w.upload('contrib', A('/subject/attachments'), { name: 'past exam 2025.pdf', data: lecturePdf(pagesFor('Exam2025', 2)) }, { kind: 'previous_exam', title: 'أسئلة سنة 2025' });
    expect(res.statusCode, res.body).toBe(200);
    draft = res.json() as SubjectAttachmentView;
    expect(draft).toMatchObject({ kind: 'previous_exam', title: 'أسئلة سنة 2025', status: 'draft', visibility: 'course', lecture: null });
    expect(draft.uploaded_by.id).toBe(w.id.contrib);
    expect(draft.file).toMatchObject({ mime: 'application/pdf' });
    await drain(w);
    expect((await w.ok<SubjectAttachmentsResponse>('student', 'GET', A('/subject/attachments'))).attachments.map((a) => a.id)).not.toContain(draft.id);
    expect((await w.ok<SubjectAttachmentsResponse>('contrib', 'GET', A('/subject/attachments'))).attachments.map((a) => a.id)).toContain(draft.id);
    expect((await w.ok<SubjectAttachmentsResponse>('mod', 'GET', A('/subject/attachments'))).attachments.map((a) => a.id)).toContain(draft.id);
    expect((await w.req('student', 'GET', A(`/files/${draft.file!.file_id}`))).statusCode).toBe(404);
    expect((await w.req('student', 'GET', A(`/sources/${draft.source_id}`))).statusCode).toBe(404);
    expect((await events('student')).some((e) => e.ref.id === draft.id)).toBe(false);
  });

  it('only an official moderator publishes or withdraws it; publishing writes the update and opens the file to members', async () => {
    expect((await w.req('contrib', 'PATCH', A(`/subject/attachments/${draft.id}`), { status: 'published' })).statusCode).toBe(403);
    // an assistant passes gate 2 (moderator access) but never sees a draft (Q5: no power over official files)
    expect((await w.req('assistant', 'PATCH', A(`/subject/attachments/${draft.id}`), { status: 'published' })).statusCode).toBe(404);
    const pub = await w.ok<SubjectAttachmentView>('mod', 'PATCH', A(`/subject/attachments/${draft.id}`), { status: 'published' });
    expect(pub.status).toBe('published');
    expect((await w.ok<SubjectAttachmentsResponse>('student', 'GET', A('/subject/attachments'))).attachments.map((a) => a.id)).toContain(draft.id);
    expect((await w.req('student', 'GET', A(`/files/${draft.file!.file_id}`))).statusCode).toBe(200);
    // once published the assistant sees it, and may still not change it
    expect((await w.req('assistant', 'PATCH', A(`/subject/attachments/${draft.id}`), { status: 'withdrawn' })).statusCode).toBe(403);
    const e = (await events('student')).find((x) => x.ref.id === draft.id)!;
    expect(e).toMatchObject({ kind: 'attachment_published', ref: { type: 'subject_attachment', id: draft.id } });
    expect(e.title).toContain('أسئلة سنة 2025');
    const gone = await w.ok<SubjectAttachmentView>('mod', 'PATCH', A(`/subject/attachments/${draft.id}`), { status: 'withdrawn' });
    expect(gone.status).toBe('withdrawn');
    expect((await w.ok<SubjectAttachmentsResponse>('student', 'GET', A('/subject/attachments'))).attachments.map((a) => a.id)).not.toContain(draft.id);
    expect((await w.req('student', 'GET', A(`/files/${draft.file!.file_id}`))).statusCode).toBe(404);
  });

  it('a moderator’s attachment is published at once, may name one of the subject’s lectures; a student cannot upload', async () => {
    const lecture = await w.ok<OfficialLectureView>('mod', 'POST', A('/lectures'), { title: 'Lecture with summary' });
    const up = (await w.upload('mod', A(`/lectures/${lecture.id}/upload`), { name: 'l.pdf', data: lecturePdf(pagesFor('WithSummary', 1)) })).json() as UploadOfficialVersionResponse;
    await drain(w);
    await w.ok('mod', 'POST', A(`/lectures/${lecture.id}/versions/${up.version_id}/publish`), {});
    const res = await w.upload('mod', A('/subject/attachments'), { name: 'summary.pdf', data: lecturePdf(pagesFor('Summary', 1)) }, { kind: 'summary', title: 'ملخص المحاضرة', lecture_id: lecture.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'published', lecture: { id: lecture.id, title: 'Lecture with summary' } });
    const st = await w.upload('student', A('/subject/attachments'), { name: 's.pdf', data: lecturePdf(pagesFor('S', 1)) }, { kind: 'summary', title: 'x' });
    expect(st.statusCode).toBe(403);
    // a lecture id of another subject (or none at all) is refused
    const bad = await w.upload('mod', A('/subject/attachments'), { name: 'b.pdf', data: lecturePdf(pagesFor('B', 1)) }, { kind: 'summary', title: 'x', lecture_id: 'NO_SUCH_LECTURE' });
    expect(bad.statusCode).toBe(404);
    // the JSON form needs a resumable upload made INTO this subject; a vault upload id is refused with the reason
    const json = await w.req('mod', 'POST', A('/subject/attachments'), { kind: 'summary', title: 'x', upload_id: 'NOT_A_SPACE_UPLOAD' });
    expect(json.statusCode).toBe(404);
  });
});

describe('exam dates (subject_exam_date): create, replace and cancel by client id, idempotent', () => {
  it('a moderator publishes, changes and cancels; each real change is one update; members read the table', async () => {
    const id = '01JEXAMDATEFINAL0000000001';
    const created = await w.ok<SubjectExamDateView>('mod', 'PUT', A(`/subject/exam-dates/${id}`), { title: 'الامتحان النهائي — الدور الأول', exam_on: '2027-01-15', starts_at: '09:30' });
    expect(created).toMatchObject({ id, status: 'published', exam_on: '2027-01-15', starts_at: '09:30', lecture_ids: [] });
    expect(created.published_by.id).toBe(w.id.mod);
    // the same body again: nothing changes, no second update
    await w.ok('mod', 'PUT', A(`/subject/exam-dates/${id}`), { title: 'الامتحان النهائي — الدور الأول', exam_on: '2027-01-15', starts_at: '09:30' });
    expect((await events('student')).filter((e) => e.ref.id === id).map((e) => e.kind)).toEqual(['exam_date_published']);
    const moved = await w.ok<SubjectExamDateView>('mod', 'PUT', A(`/subject/exam-dates/${id}`), { title: 'الامتحان النهائي — الدور الأول', exam_on: '2027-01-20', starts_at: '09:30' });
    expect(moved.status).toBe('changed');
    expect((await w.ok<SubjectExamDatesResponse>('student', 'GET', A('/subject/exam-dates'))).exam_dates.find((d) => d.id === id)?.exam_on).toBe('2027-01-20');
    const cancelled = await w.ok<SubjectExamDateView>('mod', 'DELETE', A(`/subject/exam-dates/${id}`));
    expect(cancelled.status).toBe('cancelled');
    expect((await events('student')).filter((e) => e.ref.id === id).map((e) => e.kind)).toEqual(['exam_date_changed', 'exam_date_changed', 'exam_date_published']);
    // only an official moderator (an assistant has moderator access at gate 2 but no power over official content)
    expect((await w.req('student', 'PUT', A(`/subject/exam-dates/${id}`), { title: 'x', exam_on: '2027-01-01' })).statusCode).toBe(403);
    expect((await w.req('assistant', 'PUT', A(`/subject/exam-dates/${id}`), { title: 'x', exam_on: '2027-01-01' })).statusCode).toBe(403);
    // the lectures it names must be this subject's
    expect((await w.req('mod', 'PUT', A('/subject/exam-dates/01JEXAMDATEBAD000000000001'), { title: 'x', exam_on: '2027-01-01', lecture_ids: ['NOPE'] })).statusCode).toBe(400);
  });
});

describe('the updates feed (AOS-2.9)', () => {
  it('is cursor-paginated newest first, and a space never shows another subject’s events', async () => {
    for (let i = 0; i < 3; i++) await w.ok('mod', 'PUT', A(`/subject/exam-dates/01JFEED00000000000000000${i}`), { title: `اختبار ${i}`, exam_on: `2027-02-0${i + 1}` });
    const p1 = await w.ok<CursorPage<SubjectEventView>>('student', 'GET', A('/subject/events?limit=2'));
    expect(p1.items).toHaveLength(2);
    expect(p1.items[0]!.seq).toBeGreaterThan(p1.items[1]!.seq);
    const p2 = await w.ok<CursorPage<SubjectEventView>>('student', 'GET', A(`/subject/events?limit=2&cursor=${p1.next_cursor}`));
    expect(p2.items[0]!.seq).toBeLessThan(p1.items[1]!.seq);
    // B's moderator in B sees B's (empty) feed, never A's rows
    w.setAccess('modB', SPACE_B, { access: 'moderator', roles: ['subject_moderator'] });
    expect((await w.ok<CursorPage<SubjectEventView>>('modB', 'GET', sp(SPACE_B, '/subject/events'))).items).toEqual([]);
    expect((await w.req('outsider', 'GET', A('/subject/events'))).statusCode).toBe(404);
  });
});

describe('«الملفات المكررة» (AOS-18.11): identical and near-duplicate files within the subject only', () => {
  it('groups byte-identical uploads and near-duplicates (≥ 60 % of pages), for official moderators only', async () => {
    const mk = async (title: string, data: Buffer) => {
      const l = await w.ok<OfficialLectureView>('mod', 'POST', A('/lectures'), { title });
      const up = await w.upload('mod', A(`/lectures/${l.id}/upload`), { name: `${title}.pdf`, data });
      expect(up.statusCode, up.body).toBe(200);
      return l;
    };
    const same = lecturePdf(pagesFor('Dup', 5));
    const one = await mk('Dup one', same);
    const two = await mk('Dup two', same);
    const near = await mk('Dup near', lecturePdf(pagesFor('Dup', 5, { 4: 'A rewritten fifth page about the ureter and its course' })));
    const other = await mk('Unrelated', lecturePdf(pagesFor('Unrelated', 5)));
    await drain(w);
    const res = await w.ok<SubjectDuplicatesResponse>('mod', 'GET', A('/subject/duplicates'));
    const identical = res.groups.find((g) => g.kind === 'identical' && g.items.some((i) => i.id === one.id))!;
    expect(identical.items.map((i) => i.id).sort()).toEqual([one.id, two.id].sort());
    const nearGroup = res.groups.find((g) => g.kind === 'near' && g.items.some((i) => i.id === near.id))!;
    expect(nearGroup.similarity).toBeGreaterThanOrEqual(0.6);
    expect(nearGroup.similarity).toBeLessThan(1);
    expect(res.groups.some((g) => g.items.some((i) => i.id === other.id))).toBe(false);
    expect(res.checked.versions).toBeGreaterThanOrEqual(4);
    expect((await w.req('student', 'GET', A('/subject/duplicates'))).statusCode).toBe(403);
    expect((await w.req('contrib', 'GET', A('/subject/duplicates'))).statusCode).toBe(403);
    // B's moderator never sees A's files
    expect((await w.ok<SubjectDuplicatesResponse>('modB', 'GET', sp(SPACE_B, '/subject/duplicates'))).groups).toEqual([]);
  });
});
