// P1-T5 step 1 — adversarial review (BUILD_PLAN §1.2): regression tests for the defects the reviewer reproduced.
//   R1  a withdrawn lecture that was never published (a moderator rejecting a contributor's draft) stayed a draft for
//       nobody: students saw its title in the list, the detail and a public «سُحبت» line of the updates feed;
//   R2  draft VERSIONS were shown by lecture uploader, not version uploader: a contributor saw another contributor's
//       unapproved upload of their lecture (and its file), the uploader of a new version could not see their own;
//   R3  a retried correction job (crash after it published) marked the applied correction «failed»;
//   R4  a correction published while a newer upload waited as a draft made that upload unpublishable for ever (and its
//       identical bytes could not be uploaded again);
//   R5  a rights takedown left the lecture's text in the moderators' correction queue;
//   R6  the official offline package forwarded its reads in-process from 127.0.0.1, so every student's package shared
//       one rate-limit bucket: the 51st 12-page package of the minute failed for everybody;
//   R7  space files were served `immutable` for a year: after a takedown or a removal the device kept reading them
//       without asking the server;
//   R8  exam dates and attachments named lectures that are still drafts (ids, titles) to every member;
//   R9  a rights takedown left the lecture's sentences in the Course Brain's quotes, statements and relation reasons;
//   R10 the upload routes stored every file part of a multipart body to disk BEFORE asking whether the member may
//       upload at all: any student could make the server write up to 50 × the upload limit per request;
//   R11 a contributor could rename their draft after a moderator approved it, keeping the approval.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CursorPage,
  OfficialCorrectionResponse,
  OfficialCorrectionsResponse,
  OfficialCorrectionView,
  OfficialLectureDetail,
  OfficialLectureView,
  PublishOfficialVersionResponse,
  SubjectAttachmentView,
  SubjectEventView,
  SubjectExamDatesResponse,
  UploadOfficialVersionResponse,
} from '@medlevo/shared';
import { CorrectionsService } from '../../src/modules/lectures/corrections';
import { LecturesService } from '../../src/modules/lectures/service';
import { derivedId } from '../../src/modules/lectures/store';
import { createLectureWorld, drain, inSpace, lecturePdf, pagesFor, sp, SPACE_A, type LectureWorld, type Person } from './world';

let w: LectureWorld;
beforeAll(async () => {
  w = await createLectureWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});
const A = (rest: string) => sp(SPACE_A, rest);

async function upload(person: Person, lectureId: string, label: string, pages = 2): Promise<UploadOfficialVersionResponse> {
  const res = await w.upload(person, A(`/lectures/${lectureId}/upload`), { name: `${label}.pdf`, data: lecturePdf(pagesFor(label, pages)) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as UploadOfficialVersionResponse;
}
async function published(title: string, pages = 2): Promise<{ lecture: OfficialLectureView; v1: string }> {
  const lecture = await w.ok<OfficialLectureView>('mod', 'POST', A('/lectures'), { title });
  const v = await upload('mod', lecture.id, title.replace(/\W/g, ''), pages);
  await drain(w);
  await w.ok('mod', 'POST', A(`/lectures/${lecture.id}/versions/${v.version_id}/publish`), {});
  return { lecture, v1: v.version_id };
}
const firstRegion = (versionId: string) =>
  inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ id: string; text: string }>(`SELECT r.id, r.text FROM source_region r JOIN source_page p ON p.id = r.page_id WHERE r.version_id = ? AND r.text IS NOT NULL ORDER BY p.page_index, r.reading_order LIMIT 1`, [versionId])!);
const fileOf = (versionId: string) => inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ f: string }>('SELECT file_id AS f FROM source_version WHERE id = ?', [versionId])!.f);

describe('R1 — a withdrawn draft (never published) stays hidden from students and out of the public feed', () => {
  it('a moderator rejecting a contributor’s upload by withdrawing it shows nothing of it to students', async () => {
    const draft = await w.ok<OfficialLectureView>('contrib', 'POST', A('/lectures'), { title: 'Rejected contributor draft' });
    await upload('contrib', draft.id, 'RejectedDraft');
    await drain(w);
    const before = await w.req('student', 'GET', A(`/lectures/${draft.id}`));
    expect(before.statusCode).toBe(404);
    await w.ok('mod', 'POST', A(`/lectures/${draft.id}/withdraw`), { reason: 'error', note_ar: 'ملف خاطئ' });
    const missing = await w.req('student', 'GET', A('/lectures/NO_SUCH_LECTURE'));
    const after = await w.req('student', 'GET', A(`/lectures/${draft.id}`));
    expect(after.statusCode).toBe(404);
    expect(after.json()).toEqual(missing.json());
    const list = await w.ok<CursorPage<OfficialLectureView>>('student', 'GET', A('/lectures?limit=100'));
    expect(list.items.map((l) => l.id)).not.toContain(draft.id);
    const feed = await w.ok<CursorPage<SubjectEventView>>('student', 'GET', A('/subject/events?limit=100'));
    expect(feed.items.some((e) => e.ref.id === draft.id)).toBe(false);
    // the moderators and the uploader still see it, withdrawn with the reason
    expect((await w.ok<OfficialLectureDetail>('mod', 'GET', A(`/lectures/${draft.id}`))).withdrawn?.note_ar).toBe('ملف خاطئ');
    expect((await w.ok<OfficialLectureDetail>('contrib', 'GET', A(`/lectures/${draft.id}`))).status).toBe('withdrawn');
    expect((await w.req('contrib2', 'GET', A(`/lectures/${draft.id}`))).statusCode).toBe(404);
  });

  it('a withdrawn PUBLISHED lecture still shows to members with its reason and a public feed line', async () => {
    const { lecture } = await published('Withdrawn after publishing');
    await w.ok('mod', 'POST', A(`/lectures/${lecture.id}/withdraw`), { reason: 'replaced', note_ar: 'استُبدلت' });
    expect((await w.ok<OfficialLectureDetail>('student', 'GET', A(`/lectures/${lecture.id}`))).withdrawn?.reason).toBe('replaced');
    const feed = await w.ok<CursorPage<SubjectEventView>>('student', 'GET', A('/subject/events?limit=100'));
    expect(feed.items.some((e) => e.ref.id === lecture.id && e.kind === 'lecture_withdrawn')).toBe(true);
  });
});

describe('R2 — a draft version is seen by the moderators and ITS uploader (not the lecture’s uploader)', () => {
  it('contrib2’s new version of contrib’s published lecture is hidden from contrib and visible to contrib2', async () => {
    const lecture = await w.ok<OfficialLectureView>('contrib', 'POST', A('/lectures'), { title: 'Contrib lecture' });
    const v1 = await upload('contrib', lecture.id, 'ContribLecture');
    await drain(w);
    await w.ok('mod', 'POST', A(`/lectures/${lecture.id}/versions/${v1.version_id}/publish`), {});
    const v2 = await upload('contrib2', lecture.id, 'ContribLectureV2', 3);
    await drain(w);
    const byContrib = await w.ok<OfficialLectureDetail>('contrib', 'GET', A(`/lectures/${lecture.id}`));
    expect(byContrib.versions.map((v) => v.id)).not.toContain(v2.version_id);
    expect((await w.req('contrib', 'GET', A(`/files/${fileOf(v2.version_id)}`))).statusCode).toBe(404);
    const byContrib2 = await w.ok<OfficialLectureDetail>('contrib2', 'GET', A(`/lectures/${lecture.id}`));
    expect(byContrib2.versions.map((v) => v.id)).toContain(v2.version_id);
    expect((await w.req('contrib2', 'GET', A(`/files/${fileOf(v2.version_id)}`))).statusCode).toBe(200);
    expect((await w.ok<OfficialLectureDetail>('mod', 'GET', A(`/lectures/${lecture.id}`))).versions.map((v) => v.id)).toContain(v2.version_id);
    expect((await w.ok<OfficialLectureDetail>('student', 'GET', A(`/lectures/${lecture.id}`))).versions.map((v) => v.id)).toEqual([v1.version_id]);
  });
});

describe('R3/R4 — corrections: a retried job is idempotent; an upload waiting as a draft stays publishable', () => {
  it('a correction job retried after it already published marks the correction applied (not failed)', async () => {
    const { lecture, v1 } = await published('Retried correction');
    const region = firstRegion(v1);
    const res = await w.ok<OfficialCorrectionResponse>('mod', 'POST', A(`/lectures/${lecture.id}/corrections`), { version_id: v1, items: [{ region_id: region.id, text: 'Retried page 1: corrected' }] });
    await drain(w);
    const cid = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ id: string }>('SELECT id FROM official_correction WHERE lecture_id = ?', [lecture.id])!.id);
    expect(res.version_id).toBe(derivedId('ocv', cid));
    // the crash: the job published the new version, then died before recording the correction as applied
    inSpace(w, SPACE_A, () => w.t.ctx.db.run(`UPDATE official_correction SET status = 'queued', result_version_id = NULL WHERE id = ?`, [cid]));
    const out = inSpace(w, SPACE_A, () => new CorrectionsService(w.t.ctx, new LecturesService(w.t.ctx)).runJob(cid));
    expect(out).toEqual({ version_id: res.version_id, status: 'applied' });
    const row = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ status: string; result_version_id: string | null }>('SELECT status, result_version_id FROM official_correction WHERE id = ?', [cid])!);
    expect(row).toEqual({ status: 'applied', result_version_id: res.version_id });
    const d = await w.ok<OfficialLectureDetail>('student', 'GET', A(`/lectures/${lecture.id}`));
    expect(d.versions.filter((v) => v.status === 'published')).toHaveLength(1);
  });

  it('v3 uploaded as a draft, then a correction publishes v4 from v2: v3 can still be published (page map from v4)', async () => {
    const { lecture, v1 } = await published('Draft then correction');
    const draft = await upload('mod', lecture.id, 'DraftThenCorrectionNew', 3);
    await drain(w);
    const region = firstRegion(v1);
    const corr = await w.ok<OfficialCorrectionResponse>('mod', 'POST', A(`/lectures/${lecture.id}/corrections`), { version_id: v1, items: [{ region_id: region.id, text: 'fixed text' }] });
    await drain(w);
    expect((await w.ok<OfficialLectureDetail>('mod', 'GET', A(`/lectures/${lecture.id}`))).head_version?.id).toBe(corr.version_id);
    const pub = await w.req('mod', 'POST', A(`/lectures/${lecture.id}/versions/${draft.version_id}/publish`), {});
    expect(pub.statusCode, pub.body).toBe(200);
    expect((pub.json() as PublishOfficialVersionResponse).page_map_job_id).toBeTruthy();
    await drain(w);
    const d = await w.ok<OfficialLectureDetail>('student', 'GET', A(`/lectures/${lecture.id}`));
    expect(d.head_version?.id).toBe(draft.version_id);
    expect(d.versions.find((v) => v.id === draft.version_id)).toMatchObject({ previous_version_id: corr.version_id, page_map_status: 'ready' });
    // an UPLOAD older than the head's own upload is still refused (superseded)
    const { lecture: l2 } = await published('Two drafts');
    const a = await upload('mod', l2.id, 'TwoDraftsA', 2);
    const b = await upload('mod', l2.id, 'TwoDraftsB', 3);
    await drain(w);
    await w.ok('mod', 'POST', A(`/lectures/${l2.id}/versions/${b.version_id}/publish`), {});
    expect((await w.req('mod', 'POST', A(`/lectures/${l2.id}/versions/${a.version_id}/publish`), {})).statusCode).toBe(409);
  });
});

describe('R5 — a rights takedown removes the lecture’s text from the corrections queue too', () => {
  it('open and applied corrections keep no text of a taken-down lecture; open ones are closed', async () => {
    const { lecture, v1 } = await published('Takedown with proposals');
    const region = firstRegion(v1);
    const p = await w.ok<OfficialCorrectionResponse>('contrib', 'POST', A(`/lectures/${lecture.id}/corrections`), { version_id: v1, items: [{ region_id: region.id, text: 'COPYRIGHTED SENTENCE from the lecture' }], note: 'note' });
    await w.ok('mod', 'POST', A(`/lectures/${lecture.id}/withdraw`), { reason: 'rights_takedown', note_ar: 'طلب صاحب الحقوق' });
    const queue = await w.ok<OfficialCorrectionsResponse>('mod', 'GET', A(`/subject/corrections?lecture_id=${lecture.id}`));
    expect(JSON.stringify(queue)).not.toContain('COPYRIGHTED SENTENCE');
    const item = queue.corrections.find((c) => c.id === p.review_item_id) as OfficialCorrectionView;
    expect(item.status).toBe('rejected');
    expect(item.items).toEqual([]);
  });
});

describe('R9 — after a rights takedown no table of the space holds the lecture’s text', () => {
  it('chunks, regions, concept quotes, relation statements, algorithms and figure readings keep none of it', async () => {
    const lecture = await w.ok<OfficialLectureView>('mod', 'POST', A('/lectures'), { title: 'Rights holder lecture' });
    const pages = Array.from({ length: 3 }, (_, i) => [
      `Sepsis is defined as Zqxmarker organ dysfunction caused by infection ${i + 1}.`,
      `Hypertension causes Zqxmarker stroke in adults.`,
      `Tachycardia refers to a Zqxmarker heart rate above 100 beats per minute.`,
    ]);
    const res = await w.upload('mod', A(`/lectures/${lecture.id}/upload`), { name: 'rights.pdf', data: lecturePdf(pages) });
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json() as UploadOfficialVersionResponse;
    await drain(w);
    await w.ok('mod', 'POST', A(`/lectures/${lecture.id}/versions/${v.version_id}/publish`), {});
    await drain(w);
    const holders = () =>
      inSpace(w, SPACE_A, () => {
        const db = w.t.ctx.db;
        const tables = db
          .all<{ name: string; sql: string | null }>(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`)
          // concept names are short terms shared by the subject (not the lecture's prose); the audit log names titles only
          .filter((t) => !/VIRTUAL TABLE/i.test(t.sql ?? '') && !/_(data|idx|content|docsize|config)$/.test(t.name) && !['audit_log', 'concept', 'concept_alias'].includes(t.name));
        const found: string[] = [];
        for (const t of tables) {
          for (const c of db.all<{ name: string; type: string }>(`PRAGMA table_info(${t.name})`)) {
            if (!/TEXT|^$/i.test(c.type)) continue;
            const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t.name} WHERE CAST(${c.name} AS TEXT) LIKE '%Zqxmarker%'`)!.n;
            if (n) found.push(`${t.name}.${c.name}`);
          }
        }
        return found;
      });
    // before: the pages, the search chunks and the Course Brain's quotes hold the lecture's sentences
    expect(holders()).toEqual(expect.arrayContaining(['source_region.text', 'document_chunk.text', 'concept_mention.quote', 'concept_relation_statement.quote', 'concept_relation.reasons_json']));
    await w.ok('mod', 'POST', A(`/lectures/${lecture.id}/withdraw`), { reason: 'rights_takedown', note_ar: 'طلب صاحب الحقوق' });
    expect(holders()).toEqual([]);
    const fts = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH 'Zqxmarker'`)!.n);
    expect(fts).toBe(0);
  });
});

describe('R6/R7 — the official offline package and space files', () => {
  it('internal reads of offline packages do not share one rate-limit bucket across students', async () => {
    const { lecture } = await published('Popular before the exam', 12);
    const pkg = (ip: string) => w.t.app.inject({ method: 'GET', url: A(`/lectures/${lecture.id}/offline-package`), headers: w.h.student, remoteAddress: ip });
    // 50 packages (12 page-region reads each = 600 forwarded reads) from one device …
    for (let i = 0; i < 50; i++) expect((await pkg('10.7.0.1')).statusCode).toBe(200);
    // … and another student's package still builds
    const other = await pkg('10.7.0.2');
    expect(other.statusCode, other.body).toBe(200);
    // a client calling the read route directly is still rate-limited by its own address
    const pageId = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ id: string }>(`SELECT p.id FROM source_page p JOIN official_lecture l ON l.head_version_id = p.version_id WHERE l.id = ? LIMIT 1`, [lecture.id])!.id);
    let limited = false;
    for (let i = 0; i < 700 && !limited; i++) {
      const r = await w.t.app.inject({ method: 'GET', url: A(`/sources/pages/${pageId}/regions`), headers: { ...w.h.student, 'x-medlevo-forward': 'guess' }, remoteAddress: '10.7.0.3' });
      limited = r.statusCode === 429;
    }
    expect(limited).toBe(true);
  }, 120_000);

  it('a space file is revalidated on every use (no year-long immutable cache), with a 304 for an unchanged file', async () => {
    const { v1 } = await published('Cache headers');
    const res = await w.req('student', 'GET', A(`/files/${fileOf(v1)}`));
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['cache-control'])).not.toContain('immutable');
    expect(String(res.headers['cache-control'])).toContain('no-cache');
    const again = await w.req('student', 'GET', A(`/files/${fileOf(v1)}`), undefined, { 'if-none-match': String(res.headers.etag) });
    expect(again.statusCode).toBe(304);
    // a removed member's revalidation answers «not found»
    w.setAccess('student', SPACE_A, null);
    try {
      const gone = await w.req('student', 'GET', A(`/files/${fileOf(v1)}`), undefined, { 'if-none-match': String(res.headers.etag) });
      expect(gone.statusCode).toBe(404);
    } finally {
      w.setAccess('student', SPACE_A, { access: 'member' });
    }
  });
});

describe('R8 — nothing names a draft lecture to students (exam dates, attachments)', () => {
  it('an exam date listing a draft lecture shows students only the published ones; an attachment on a draft lecture hides it', async () => {
    const draft = await w.ok<OfficialLectureView>('mod', 'POST', A('/lectures'), { title: 'Secret upcoming lecture' });
    const { lecture: pub } = await published('Public lecture for exam');
    await w.ok('mod', 'PUT', A('/subject/exam-dates/EXAM-R8'), { title: 'Midterm', exam_on: '2026-12-01', lecture_ids: [draft.id, pub.id] });
    const forStudent = await w.ok<SubjectExamDatesResponse>('student', 'GET', A('/subject/exam-dates'));
    expect(forStudent.exam_dates.find((e) => e.id === 'EXAM-R8')?.lecture_ids).toEqual([pub.id]);
    const forMod = await w.ok<SubjectExamDatesResponse>('mod', 'GET', A('/subject/exam-dates'));
    expect(forMod.exam_dates.find((e) => e.id === 'EXAM-R8')?.lecture_ids).toEqual([draft.id, pub.id]);

    const res = await w.upload('mod', A('/subject/attachments'), { name: 'summary.pdf', data: lecturePdf(pagesFor('SecretSummary', 1)) }, { kind: 'summary', title: 'ملخص', lecture_id: draft.id });
    expect(res.statusCode, res.body).toBe(200);
    const att = res.json() as SubjectAttachmentView;
    const seen = (await w.ok<{ attachments: SubjectAttachmentView[] }>('student', 'GET', A('/subject/attachments'))).attachments.find((a) => a.id === att.id);
    expect(seen).toBeTruthy();
    expect(JSON.stringify(seen)).not.toContain('Secret upcoming lecture');
    expect(seen!.lecture).toBeNull();
  });
});

describe('R10 — a member who may not upload is refused before the body is read', () => {
  const twoFiles = (fields: Record<string, string> = {}) => {
    const boundary = '----r10';
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    for (const n of ['a.pdf', 'b.pdf']) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${n}"\r\nContent-Type: application/pdf\r\n\r\n`));
      parts.push(lecturePdf(pagesFor(n, 1)));
      parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
  };

  it('a student’s multipart upload to a lecture or to the subject’s files is 403 / 404 whatever the body holds', async () => {
    const { lecture } = await published('Upload order');
    const mp = twoFiles();
    const toLecture = await w.t.app.inject({ method: 'POST', url: A(`/lectures/${lecture.id}/upload`), headers: { ...w.h.student, 'content-type': mp.contentType }, payload: mp.payload });
    expect(toLecture.statusCode, toLecture.body).toBe(403);
    const toMissing = await w.t.app.inject({ method: 'POST', url: A('/lectures/NO_SUCH_LECTURE/upload'), headers: { ...w.h.student, 'content-type': mp.contentType }, payload: mp.payload });
    expect(toMissing.statusCode, toMissing.body).toBe(404);
    const att = twoFiles({ kind: 'summary', title: 'x' });
    const toFiles = await w.t.app.inject({ method: 'POST', url: A('/subject/attachments'), headers: { ...w.h.student, 'content-type': att.contentType }, payload: att.payload });
    expect(toFiles.statusCode, toFiles.body).toBe(403);
    // an allowed uploader still gets the one-file rule
    const mod = await w.t.app.inject({ method: 'POST', url: A(`/lectures/${lecture.id}/upload`), headers: { ...w.h.mod, 'content-type': mp.contentType }, payload: mp.payload });
    expect(mod.statusCode, mod.body).toBe(400);
  });
});

describe('R11 — a contributor’s change to an approved draft asks for approval again', () => {
  it('approve → contributor renames → in review, approval cleared; a moderator’s own edit keeps it', async () => {
    const l = await w.ok<OfficialLectureView>('contrib', 'POST', A('/lectures'), { title: 'Approved draft' });
    await upload('contrib', l.id, 'ApprovedDraft');
    await drain(w);
    expect((await w.ok<OfficialLectureView>('mod', 'POST', A(`/lectures/${l.id}/approve`), {})).approved?.by.id).toBe(w.id.mod);
    const renamed = await w.ok<OfficialLectureView>('contrib', 'PATCH', A(`/lectures/${l.id}`), { title: 'Approved draft (changed after approval)' });
    expect(renamed).toMatchObject({ status: 'in_review', approved: null });
    // the same body again changes nothing (idempotent replay)
    expect((await w.ok<OfficialLectureView>('contrib', 'PATCH', A(`/lectures/${l.id}`), { title: 'Approved draft (changed after approval)' })).status).toBe('in_review');
    await w.ok('mod', 'POST', A(`/lectures/${l.id}/approve`), {});
    const byMod = await w.ok<OfficialLectureView>('mod', 'PATCH', A(`/lectures/${l.id}`), { lecture_no: 9 });
    expect(byMod.status).toBe('draft');
    expect(byMod.approved?.by.id).toBe(w.id.mod);
  });
});

describe('processing inside the space: the follow-up jobs run in the space binding and none fails', () => {
  it('after drain no job of the space has failed', async () => {
    await published('Follow-ups');
    const failed = inSpace(w, SPACE_A, () => w.t.ctx.db.all<{ kind: string; error: string | null }>(`SELECT kind, error_detail AS error FROM processing_job WHERE status = 'failed'`));
    expect(failed).toEqual([]);
  });
});
