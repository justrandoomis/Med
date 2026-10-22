// Phase 1 completion, track C2 — AOS-11.27 (Phase 1 part, space side): the subject's updates feed is filtered PER
// VIEWER (ARCHITECTURE_DELTA §8.4): every row carries a visibility key (none = all members, `mod` = the subject's
// official moderators, `u:<id>` = one person), the read asks only the viewer's keys, and a second gate re-checks the
// row's target for THIS viewer, so a line about something the viewer may no longer see (a withdrawn attachment, a hidden
// draft) never reaches them. A former member reads nothing (404). Every file is a TEST FIXTURE generated here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CursorPage, OfficialLectureView, SubjectAttachmentView, SubjectEventView, UploadOfficialVersionResponse } from '@medlevo/shared';
import { createLectureWorld, drain, lecturePdf, pagesFor, SPACE_A, sp, type LectureWorld, type Person } from './world';

let w: LectureWorld;
const feed = async (who: Person) => (await w.ok<CursorPage<SubjectEventView>>(who, 'GET', sp(SPACE_A, '/subject/events?limit=50'))).items.map((e) => e.title);

beforeAll(async () => {
  w = await createLectureWorld();
  // a published lecture: a line for every member
  const A = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Feed lecture A', lecture_no: 1 });
  const ua = (await w.upload('mod', sp(SPACE_A, `/lectures/${A.id}/upload`), { name: 'a.pdf', data: lecturePdf(pagesFor('Feed A', 2)) })).json() as UploadOfficialVersionResponse;
  await drain(w);
  await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${A.id}/versions/${ua.version_id}/publish`), {});
  // a contributor's draft the moderator does not accept: a line for its uploader only
  const B = await w.ok<OfficialLectureView>('contrib', 'POST', sp(SPACE_A, '/lectures'), { title: 'Contributor draft B' });
  await w.upload('contrib', sp(SPACE_A, `/lectures/${B.id}/upload`), { name: 'b.pdf', data: lecturePdf(pagesFor('Feed B', 2)) });
  await drain(w);
  await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${B.id}/withdraw`), { reason: 'other', note_ar: 'مكرر مع محاضرة موجودة' });
  // an attachment published, then withdrawn (rights): its «ملف جديد» line must leave the members' feed
  const mp = await w.upload('mod', sp(SPACE_A, '/subject/attachments'), { name: 'summary.pdf', data: lecturePdf(pagesFor('Feed summary', 1)) }, { kind: 'summary', title: 'Withdrawn summary X' });
  expect(mp.statusCode, mp.body).toBe(200);
  const X = mp.json() as SubjectAttachmentView;
  await w.ok('mod', 'PATCH', sp(SPACE_A, `/subject/attachments/${X.id}`), { status: 'withdrawn' });
  // an attachment for moderators only
  const mm = await w.upload('mod', sp(SPACE_A, '/subject/attachments'), { name: 'key.pdf', data: lecturePdf(pagesFor('Feed key', 1)) }, { kind: 'previous_exam', title: 'Answer key (moderators)' });
  expect(mm.statusCode, mm.body).toBe(200);
  const K = mm.json() as SubjectAttachmentView;
  // (published for moderators only: the attachment's own visibility)
  const db = w.t.ctx.dbs.space(SPACE_A);
  db.run(`UPDATE subject_attachment SET visibility = 'moderators' WHERE id = ?`, [K.id]);
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('AOS-11.27 — the space feed is filtered per viewer', () => {
  it('a student reads the public lines only; a withdrawn attachment\'s line is gone for them', async () => {
    const s = await feed('student');
    expect(s).toContain('محاضرة جديدة: Feed lecture A');
    expect(s.some((t) => t.includes('Contributor draft B'))).toBe(false);
    expect(s.some((t) => t.includes('Withdrawn summary X'))).toBe(false);
    expect(s.some((t) => t.includes('Answer key'))).toBe(false);
  });

  it('the contributor also reads the line about HIS draft; nobody else does', async () => {
    const c = await feed('contrib');
    expect(c.find((t) => t.includes('Contributor draft B'))).toMatch(/لم تُعتمد مسودتك/);
    expect(c.find((t) => t.includes('Contributor draft B'))).toContain('مكرر مع محاضرة موجودة');
    expect((await feed('contrib2')).some((t) => t.includes('Contributor draft B'))).toBe(false);
    expect((await feed('assistant')).some((t) => t.includes('Contributor draft B'))).toBe(false);
  });

  it('a Subject Moderator reads the moderators\' lines too (withdrawn and moderators-only attachments)', async () => {
    const m = await feed('mod');
    expect(m).toContain('محاضرة جديدة: Feed lecture A');
    expect(m.some((t) => t.includes('Withdrawn summary X'))).toBe(true);
    // another subject's moderator, a stranger and a pending member read nothing
    for (const who of ['modB', 'outsider'] as const) expect((await w.req(who, 'GET', sp(SPACE_A, '/subject/events'))).statusCode, who).toBe(404);
    expect((await w.req('pending', 'GET', sp(SPACE_A, '/subject/events'))).statusCode).toBe(403);
  });

  it('paging never skips or repeats a visible line when hidden ones sit between them', async () => {
    const all = await feed('student');
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: CursorPage<SubjectEventView> = await w.ok<CursorPage<SubjectEventView>>('student', 'GET', sp(SPACE_A, `/subject/events?limit=1${cursor ? `&cursor=${cursor}` : ''}`));
      seen.push(...page.items.map((e) => e.title));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
  });
});
