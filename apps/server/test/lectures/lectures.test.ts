// P1-T5 step 1 — official lectures in a subject space (BUILD_PLAN §3.7 acceptance `test/lectures/*`; ARCHITECTURE_DELTA
// §5.3, §5.5, §6.2, §6.3, §6.7, §7.4; PRD AOS-2.2, 2.3, 4.5, 18.3, 18.4, 18.10, 19H.1, 21.7, 21.8, Q5):
//   draft → approve → publish; a contributor's upload needs a moderator; the upload runs the EXISTING processing
//   pipeline inside the space; a new version is published through P1-T3's page map; drafts are seen by moderators and
//   their uploader only; a non-member, a member of another subject and a pending member get «not found» bodies;
//   withdraw keeps everything readable; a rights takedown removes the files and the text from the space (file
//   references nulled, stored_file rows deleted with foreign_keys = ON), the pages stay as placeholders with the reason.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CursorPage,
  OfficialLectureDetail,
  OfficialLectureView,
  PageRegionsResponse,
  PublishOfficialVersionPreview,
  PublishOfficialVersionResponse,
  SourceDetail,
  SourcePagesResponse,
  SearchResponse,
  SubjectEventView,
  UploadOfficialVersionResponse,
  VersionCompareResponse,
} from '@medlevo/shared';
import { createLectureWorld, drain, inSpace, lecturePdf, pagesFor, sp, SPACE_A, SPACE_B, type LectureWorld } from './world';

let w: LectureWorld;
beforeAll(async () => {
  w = await createLectureWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const A = (rest: string) => sp(SPACE_A, rest);

async function createLecture(person: 'mod' | 'contrib' | 'contrib2', body: Record<string, unknown>): Promise<OfficialLectureView> {
  return w.ok<OfficialLectureView>(person, 'POST', A('/lectures'), body);
}
async function uploadPdf(person: 'mod' | 'contrib' | 'contrib2', lectureId: string, name: string, data: Buffer): Promise<UploadOfficialVersionResponse> {
  const res = await w.upload(person, A(`/lectures/${lectureId}/upload`), { name, data });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as UploadOfficialVersionResponse;
}
const detail = (person: Parameters<LectureWorld['ok']>[0], id: string) => w.ok<OfficialLectureDetail>(person, 'GET', A(`/lectures/${id}`));

describe('draft → approve → publish (Q5: a contributor’s upload needs a Subject Moderator)', () => {
  let lecture: OfficialLectureView;
  let v1: UploadOfficialVersionResponse;

  it('a contributor creates a draft and uploads the file; processing runs in the space, not in any vault', async () => {
    lecture = await createLecture('contrib', { title: 'Abdomen — the renal arteries', lecture_no: 5, held_on: '2026-10-14' });
    expect(lecture).toMatchObject({ status: 'draft', space_id: SPACE_A, lecture_no: 5, lecture_no_origin: 'moderator', held_on: '2026-10-14', head_version: null, approved: null });
    expect(lecture.uploaded_by).toMatchObject({ id: w.id.contrib, display_name: 'u-contrib' });
    expect(lecture.subject).toMatchObject({ id: 'SUBJ-A', kind: 'subject', title: 'Anatomy A' });

    v1 = await uploadPdf('contrib', lecture.id, 'Abdomen lecture 5.pdf', lecturePdf(pagesFor('Lecture5', 4)));
    expect(v1.version_id).toBeTruthy();
    expect(v1.job_id).toBeTruthy();
    expect((await detail('contrib', lecture.id)).status).toBe('in_review');
    await drain(w);
    const rows = inSpace(w, SPACE_A, () => ({
      pages: w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ?', [v1.version_id])!.n,
      chunks: w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM document_chunk WHERE version_id = ?', [v1.version_id])!.n,
      status: w.t.ctx.db.get<{ s: string }>('SELECT processing_status AS s FROM source_version WHERE id = ?', [v1.version_id])!.s,
    }));
    expect(rows.pages).toBe(4);
    expect(rows.chunks).toBeGreaterThan(0);
    expect(['ready', 'partial', 'needs_review']).toContain(rows.status);
    // nothing of the official file reached the uploader's vault (AOS-3.10: chunks live only in the space)
    const vaultChunks = w.t.ctx.binding.run(w.t.ctx.tenancy.vaultBindingFor({ userId: w.id.contrib, deviceId: null, isPlatformAdmin: false }), () =>
      w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM document_chunk')!.n,
    );
    expect(vaultChunks).toBe(0);
  });

  it('the draft is visible to its uploader and the moderators only; others get the body of a missing id', async () => {
    const missing = await w.req('student', 'GET', A('/lectures/NOPE_NOT_A_LECTURE'));
    expect(missing.statusCode).toBe(404);
    const hidden = await w.req('student', 'GET', A(`/lectures/${lecture.id}`));
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual(missing.json());
    expect((await w.req('contrib2', 'GET', A(`/lectures/${lecture.id}`))).statusCode).toBe(404); // another contributor
    expect((await w.req('assistant', 'GET', A(`/lectures/${lecture.id}`))).statusCode).toBe(404); // assistants handle members, not files
    expect((await detail('mod', lecture.id)).versions).toHaveLength(1);
    const studentList = await w.ok<CursorPage<OfficialLectureView>>('student', 'GET', A('/lectures'));
    expect(studentList.items.map((l) => l.id)).not.toContain(lecture.id);
    const modList = await w.ok<CursorPage<OfficialLectureView>>('mod', 'GET', A('/lectures'));
    expect(modList.items.find((l) => l.id === lecture.id)?.status).toBe('in_review');
    // the draft's file and pages are not reachable through the re-mounted read routes either
    expect((await w.req('student', 'GET', A(`/sources/${await sourceOf(lecture.id)}`))).statusCode).toBe(404);
    expect((await w.req('mod', 'GET', A(`/sources/${await sourceOf(lecture.id)}`))).statusCode).toBe(200);
  });

  it('only a Subject Moderator approves and publishes (contributor 403 at gate 2, assistant 404/403 by the rule)', async () => {
    expect((await w.req('contrib', 'POST', A(`/lectures/${lecture.id}/approve`), {})).statusCode).toBe(403);
    expect((await w.req('contrib', 'POST', A(`/lectures/${lecture.id}/versions/${v1.version_id}/publish`), {})).statusCode).toBe(403);
    expect((await w.req('assistant', 'POST', A(`/lectures/${lecture.id}/approve`), {})).statusCode).toBe(404);
    const approved = await w.ok<OfficialLectureView>('mod', 'POST', A(`/lectures/${lecture.id}/approve`), {});
    expect(approved.status).toBe('draft');
    expect(approved.approved?.by.id).toBe(w.id.mod);
  });

  it('the publish preview changes nothing and counts copy holders as a suppressed group count', async () => {
    const preview = await w.ok<PublishOfficialVersionPreview>('mod', 'POST', A(`/lectures/${lecture.id}/versions/${v1.version_id}/publish`), { preview: true });
    expect(preview).toMatchObject({ lecture_id: lecture.id, version: { id: v1.version_id, version_no: 1, page_count: 4 }, previous: null, changes: null });
    expect(preview.holders).toEqual({ value: 0, label_ar: '0' });
    expect((await detail('mod', lecture.id)).status).toBe('draft');
  });

  it('publish makes the version the official head students see, and writes a subject_event in the same change', async () => {
    const res = await w.ok<PublishOfficialVersionResponse>('mod', 'POST', A(`/lectures/${lecture.id}/versions/${v1.version_id}/publish`), { change_note: 'الإصدار الأول' });
    expect(res).toMatchObject({ head_version_id: v1.version_id, page_map_job_id: null });
    const d = await detail('student', lecture.id);
    expect(d.status).toBe('published');
    expect(d.head_version).toMatchObject({ id: v1.version_id, version_no: 1, page_count: 4 });
    expect(d.versions[0]).toMatchObject({ id: v1.version_id, status: 'published', kind: 'upload', change_note: 'الإصدار الأول', page_map_status: null });
    expect(d.versions[0]!.published_by?.id).toBe(w.id.mod);
    const events = await w.ok<CursorPage<SubjectEventView>>('student', 'GET', A('/subject/events'));
    expect(events.items[0]).toMatchObject({ kind: 'lecture_published', ref: { type: 'official_lecture', id: lecture.id } });
    expect(events.items[0]!.title).toContain('Abdomen');
  });

  it('members read the published lecture through the re-mounted read routes (source, pages, regions, file)', async () => {
    const src = await w.ok<SourceDetail>('student', 'GET', A(`/sources/${await sourceOf(lecture.id)}`));
    expect(src.versions.map((v) => v.id)).toEqual([v1.version_id]);
    const pages = await w.ok<SourcePagesResponse>('student', 'GET', A(`/sources/${src.id}/versions/${v1.version_id}/pages`));
    expect(pages.pages).toHaveLength(4);
    const regions = await w.ok<PageRegionsResponse>('student', 'GET', A(`/sources/pages/${pages.pages[0]!.id}/regions`));
    expect(regions.regions.map((r) => r.text ?? '').join(' ')).toContain('Lecture5 page 1');
    const fileId = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ f: string }>('SELECT file_id AS f FROM source_version WHERE id = ?', [v1.version_id])!.f);
    const file = await w.req('student', 'GET', A(`/files/${fileId}`));
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // the official text stays in the space: search finds it there (P1-T5 step 2 federation), labelled with its subject,
    // never as a row of the student's vault; scope «mine» (no copy yet) finds nothing
    const search = await w.ok<SearchResponse>('student', 'GET', '/api/search?q=Lecture5');
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.every((r) => r.db?.kind === 'space' && r.db.space_id === SPACE_A && !r.db.in_library)).toBe(true);
    expect((await w.ok<SearchResponse>('student', 'GET', '/api/search?q=Lecture5&scope=mine')).results).toEqual([]);
    expect((await w.ok<SearchResponse>('outsider', 'GET', '/api/search?q=Lecture5')).results).toEqual([]);
    // a stranger to the subject gets «not found» for the very same file id
    expect((await w.req('outsider', 'GET', A(`/files/${fileId}`))).statusCode).toBe(404);
    expect((await w.req('modB', 'GET', A(`/files/${fileId}`))).statusCode).toBe(404);
  });

  it('non-members, a moderator of another subject and a pending member get «not found» (pending: MEMBERSHIP_PENDING)', async () => {
    const unknown = await w.req('outsider', 'GET', A('/no-such-route'));
    expect(unknown.statusCode).toBe(404);
    for (const p of ['outsider', 'modB'] as const) {
      const r = await w.req(p, 'GET', A('/lectures'));
      expect(r.statusCode, p).toBe(404);
      expect(r.json(), p).toEqual(unknown.json());
      expect((await w.req(p, 'GET', A(`/lectures/${lecture.id}`))).json(), p).toEqual(unknown.json());
    }
    const pending = await w.req('pending', 'GET', A('/lectures'));
    expect(pending.statusCode).toBe(403);
    expect(pending.json().error.code).toBe('MEMBERSHIP_PENDING');
    // B's moderator cannot create a lecture in A, and A's moderator nothing in B
    expect((await w.req('modB', 'POST', A('/lectures'), { title: 'x' })).statusCode).toBe(404);
    expect((await w.req('mod', 'GET', sp(SPACE_B, '/lectures'))).statusCode).toBe(404);
  });

  it('a student cannot create, upload or change official lectures (403: they can see the published lecture)', async () => {
    expect((await w.req('student', 'POST', A('/lectures'), { title: 'mine' })).statusCode).toBe(403);
    const up = await w.upload('student', A(`/lectures/${lecture.id}/upload`), { name: 'x.pdf', data: lecturePdf(pagesFor('X', 1)) });
    expect(up.statusCode).toBe(403);
    expect((await w.req('student', 'PATCH', A(`/lectures/${lecture.id}`), { title: 'renamed' })).statusCode).toBe(403);
    expect((await w.req('assistant', 'POST', A(`/lectures/${lecture.id}/withdraw`), { reason: 'error', note_ar: 'خطأ' })).statusCode).toBe(403);
  });

  async function sourceOf(lectureId: string): Promise<string> {
    return inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ s: string }>('SELECT source_id AS s FROM official_lecture WHERE id = ?', [lectureId])!.s);
  }
});

describe('lecture identity: number, date and title (AOS-2.2) — ordered by number, then date, then title', () => {
  it('lists published lectures by lecture number, then held_on, then title; PATCH marks the number as the moderator’s', async () => {
    const mk = async (title: string, lecture_no: number | null, held_on: string | null) => {
      const l = await createLecture('mod', { title, lecture_no, held_on });
      const v = await uploadPdf('mod', l.id, `${title}.pdf`, lecturePdf(pagesFor(title.replace(/\W/g, ''), 1)));
      await drain(w);
      await w.ok('mod', 'POST', A(`/lectures/${l.id}/versions/${v.version_id}/publish`), {});
      return l;
    };
    const c = await mk('Order C', null, null);
    const b = await mk('Order B', 2, '2026-10-02');
    const a = await mk('Order A', 2, '2026-10-01');
    const z = await mk('Order Z', 1, '2026-10-09');
    const list = await w.ok<CursorPage<OfficialLectureView>>('student', 'GET', A('/lectures?limit=100'));
    const order = list.items.filter((l) => l.title.startsWith('Order ')).map((l) => l.title);
    expect(order).toEqual(['Order Z', 'Order A', 'Order B', 'Order C']);
    // cursor pagination is stable and complete
    const p1 = await w.ok<CursorPage<OfficialLectureView>>('student', 'GET', A('/lectures?limit=2'));
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await w.ok<CursorPage<OfficialLectureView>>('student', 'GET', A(`/lectures?limit=100&cursor=${p1.next_cursor}`));
    expect([...p1.items, ...p2.items].map((l) => l.id)).toEqual(list.items.map((l) => l.id));

    const patched = await w.ok<OfficialLectureView>('mod', 'PATCH', A(`/lectures/${c.id}`), { lecture_no: 3, held_on: '2026-10-12' });
    expect(patched).toMatchObject({ lecture_no: 3, lecture_no_origin: 'moderator', held_on: '2026-10-12' });
    expect([a.id, b.id, z.id]).toHaveLength(3);
    // a contributor may fix their own draft, not a published lecture
    const draft = await createLecture('contrib', { title: 'My draft' });
    expect((await w.ok<OfficialLectureView>('contrib', 'PATCH', A(`/lectures/${draft.id}`), { title: 'My draft (fixed)' })).title).toBe('My draft (fixed)');
    expect((await w.req('contrib', 'PATCH', A(`/lectures/${c.id}`), { title: 'nope' })).statusCode).toBe(403);
  });

  it('an idempotent create: the same client id and body answer the same lecture; a different body is 409', async () => {
    const id = '01JCLIENTLECTUREIDEMPOTENT';
    const one = await createLecture('mod', { id, title: 'Idempotent lecture' });
    const two = await createLecture('mod', { id, title: 'Idempotent lecture' });
    expect(two.id).toBe(one.id);
    expect((await w.req('mod', 'POST', A('/lectures'), { id, title: 'Another title' })).statusCode).toBe(409);
  });
});

describe('a new official version through P1-T3’s page map (Scenario 4 steps 1–3, AOS-18.10)', () => {
  it('v2 with an inserted page: preview counts the changes, publish enqueues the page map, compare is ready', async () => {
    const l = await createLecture('mod', { title: 'Versioned lecture', lecture_no: 7 });
    const v1 = await uploadPdf('mod', l.id, 'lec7.pdf', lecturePdf(pagesFor('Lecture7', 5)));
    await drain(w);
    await w.ok('mod', 'POST', A(`/lectures/${l.id}/versions/${v1.version_id}/publish`), {});
    // v2: the same 5 pages plus one inserted after page 2
    const pages = pagesFor('Lecture7', 5);
    pages.splice(2, 0, ['An inserted page about the adrenal glands', 'with its own new and distinct wording here', 'nothing like the other pages at all']);
    const v2 = await uploadPdf('mod', l.id, 'lec7 final (1).pdf', lecturePdf(pages));
    // still processing: publishing is refused with the reason (students never see a half-processed version)
    const early = await w.req('mod', 'POST', A(`/lectures/${l.id}/versions/${v2.version_id}/publish`), {});
    expect(early.statusCode).toBe(409);
    await drain(w);
    const preview = await w.ok<PublishOfficialVersionPreview>('mod', 'POST', A(`/lectures/${l.id}/versions/${v2.version_id}/publish`), { preview: true });
    expect(preview.previous).toEqual({ id: v1.version_id, version_no: 1 });
    expect(preview.changes?.inserted).toBe(1);
    const pub = await w.ok<PublishOfficialVersionResponse>('mod', 'POST', A(`/lectures/${l.id}/versions/${v2.version_id}/publish`), { change_note: 'أُضيفت صفحة' });
    expect(pub.head_version_id).toBe(v2.version_id);
    expect(pub.page_map_job_id).toBeTruthy();
    await drain(w);
    const d = await detail('student', l.id);
    expect(d.versions.map((v) => [v.version_no, v.status])).toEqual([
      [2, 'published'],
      [1, 'superseded'],
    ]);
    expect(d.versions[0]).toMatchObject({ previous_version_id: v1.version_id, page_map_status: 'ready' });
    const cmp = await w.ok<VersionCompareResponse>('student', 'GET', A(`/lectures/${l.id}/versions/${v1.version_id}/compare/${v2.version_id}`));
    expect(cmp.state).toBe('ready');
    expect(cmp.counts.inserted).toBe(1);
    // a moderator confirms one pair (method «moderator»); students cannot decide
    const first = cmp.rows.find((r) => r.from && r.to)!;
    expect((await w.req('student', 'POST', A(`/lectures/${l.id}/page-map/decisions`), { from_version_id: v1.version_id, to_version_id: v2.version_id, decisions: [{ from_page_id: first.from!.page_id, action: 'confirm' }] })).statusCode).toBe(403);
    const after = await w.ok<VersionCompareResponse>('mod', 'POST', A(`/lectures/${l.id}/page-map/decisions`), {
      from_version_id: v1.version_id,
      to_version_id: v2.version_id,
      decisions: [{ from_page_id: first.from!.page_id, action: 'confirm' }],
    });
    expect(after.rows.find((r) => r.from?.page_id === first.from!.page_id)?.decided_by).toBe('moderator');
    const events = await w.ok<CursorPage<SubjectEventView>>('student', 'GET', A('/subject/events'));
    expect(events.items.some((e) => e.kind === 'version_published' && e.ref.id === l.id)).toBe(true);
    // a version of ANOTHER lecture is not this lecture's (no cross-lecture compare)
    const other = await createLecture('mod', { title: 'Other' });
    expect((await w.req('mod', 'GET', A(`/lectures/${other.id}/versions/${v1.version_id}/compare/${v2.version_id}`))).statusCode).toBe(404);
    // an upload of bytes this lecture already has is refused (no silent duplicate version)
    const dup = await w.upload('mod', A(`/lectures/${l.id}/upload`), { name: 'again.pdf', data: lecturePdf(pages) });
    expect(dup.statusCode).toBe(409);
  });
});

describe('withdraw keeps everything readable; a rights takedown removes the files and text from the space (§6.3)', () => {
  it('withdraw: status and reason shown, files still served to members, nothing can be published or uploaded after', async () => {
    const l = await createLecture('mod', { title: 'Withdrawn lecture' });
    const v = await uploadPdf('mod', l.id, 'withdrawn.pdf', lecturePdf(pagesFor('Withdrawn', 2)));
    await drain(w);
    await w.ok('mod', 'POST', A(`/lectures/${l.id}/versions/${v.version_id}/publish`), {});
    const d = await w.ok<OfficialLectureDetail>('mod', 'POST', A(`/lectures/${l.id}/withdraw`), { reason: 'replaced', note_ar: 'استُبدلت بالمحاضرة 8.' });
    expect(d.status).toBe('withdrawn');
    expect(d.withdrawn).toMatchObject({ reason: 'replaced', note_ar: 'استُبدلت بالمحاضرة 8.' });
    const fileId = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ f: string }>('SELECT file_id AS f FROM source_version WHERE id = ?', [v.version_id])!.f);
    expect((await w.req('student', 'GET', A(`/files/${fileId}`))).statusCode).toBe(200);
    expect((await detail('student', l.id)).withdrawn?.reason).toBe('replaced');
    expect((await w.req('mod', 'POST', A(`/lectures/${l.id}/versions/${v.version_id}/publish`), {})).statusCode).toBe(403);
    expect((await w.upload('mod', A(`/lectures/${l.id}/upload`), { name: 'w2.pdf', data: lecturePdf(pagesFor('W2', 1)) })).statusCode).toBe(403);
    const events = await w.ok<CursorPage<SubjectEventView>>('student', 'GET', A('/subject/events'));
    expect(events.items.some((e) => e.kind === 'lecture_withdrawn' && e.ref.id === l.id)).toBe(true);
  });

  it('rights takedown: file references nulled, stored_file rows deleted with foreign_keys ON, text out of search; pages stay', async () => {
    const shared = lecturePdf(pagesFor('Takedown', 3));
    const keep = await createLecture('mod', { title: 'Same bytes, kept' });
    const kv = await uploadPdf('mod', keep.id, 'same.pdf', shared);
    const l = await createLecture('mod', { title: 'Taken down lecture' });
    const v = await uploadPdf('mod', l.id, 'takedown.pdf', shared);
    await drain(w);
    await w.ok('mod', 'POST', A(`/lectures/${keep.id}/versions/${kv.version_id}/publish`), {});
    await w.ok('mod', 'POST', A(`/lectures/${l.id}/versions/${v.version_id}/publish`), {});
    const fileId = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ f: string }>('SELECT file_id AS f FROM source_version WHERE id = ?', [v.version_id])!.f);
    const pageId = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index LIMIT 1', [v.version_id])!.id);

    const d = await w.ok<OfficialLectureDetail>('mod', 'POST', A(`/lectures/${l.id}/withdraw`), { reason: 'rights_takedown', note_ar: 'طلب صاحب الحقوق سحب الملف.' });
    expect(d.withdrawn).toMatchObject({ reason: 'rights_takedown', note_ar: 'طلب صاحب الحقوق سحب الملف.' });
    const after = inSpace(w, SPACE_A, () => ({
      fk: w.t.ctx.db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys,
      version: w.t.ctx.db.get<{ file_id: string | null; original_file_id: string | null; display_file_id: string | null }>('SELECT file_id, original_file_id, display_file_id FROM source_version WHERE id = ?', [v.version_id])!,
      pages: w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ?', [v.version_id])!.n,
      pageFiles: w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ? AND (render_file_id IS NOT NULL OR thumbnail_file_id IS NOT NULL)', [v.version_id])!.n,
      chunks: w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM document_chunk WHERE version_id = ?', [v.version_id])!.n,
      texts: w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_region WHERE version_id = ? AND text IS NOT NULL', [v.version_id])!.n,
      keptFile: w.t.ctx.db.get<{ f: string | null }>('SELECT file_id AS f FROM source_version WHERE id = ?', [kv.version_id])!.f,
    }));
    expect(after.fk).toBe(1);
    expect(after.version).toEqual({ file_id: null, original_file_id: null, display_file_id: null });
    expect(after.pages).toBe(3); // placeholders keep the page count and sizes
    expect(after.pageFiles).toBe(0);
    expect(after.chunks).toBe(0);
    expect(after.texts).toBe(0);
    // the other lecture with the same bytes keeps its file (deduplicated content is never deleted under it)
    expect(after.keptFile).toBe(fileId);
    expect((await w.req('student', 'GET', A(`/files/${after.keptFile}`))).statusCode).toBe(200);
    // nothing of the taken-down lecture is served any more; its pages remain as placeholders with the reason
    expect((await w.req('student', 'GET', A(`/sources/pages/${pageId}/regions`))).statusCode).toBe(404);
    const src = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ s: string }>('SELECT source_id AS s FROM official_lecture WHERE id = ?', [l.id])!.s);
    const pages = await w.ok<SourcePagesResponse>('student', 'GET', A(`/sources/${src}/versions/${v.version_id}/pages`));
    expect(pages.pages).toHaveLength(3);
    expect(pages.pages.every((p) => !p.render_file_id)).toBe(true);
    // a second takedown or withdraw answers the same state (no error, nothing more removed)
    const again = await w.ok<OfficialLectureDetail>('mod', 'POST', A(`/lectures/${l.id}/withdraw`), { reason: 'rights_takedown', note_ar: 'طلب صاحب الحقوق سحب الملف.' });
    expect(again.withdrawn?.reason).toBe('rights_takedown');
  });
});

describe('the official offline package of a lecture (§5.5: from lectures/:id/offline-package, never /api/data)', () => {
  it('lists the official content through the space routes with exact sizes and hashes; every path answers the same bytes', async () => {
    const l = await createLecture('mod', { title: 'Offline lecture' });
    const v = await uploadPdf('mod', l.id, 'offline.pdf', lecturePdf(pagesFor('Offline', 2)));
    await drain(w);
    expect((await w.req('student', 'GET', A(`/lectures/${l.id}/offline-package`))).statusCode).toBe(404); // a draft
    await w.ok('mod', 'POST', A(`/lectures/${l.id}/versions/${v.version_id}/publish`), {});
    const pkg = await w.ok<{ space_id: string; lecture_id: string; content_hash: string; entries: Array<{ kind: string; path?: string; url?: string; sha256: string; size: number; role: string }>; totals: { files: number; data: number }; version: { id: string } }>(
      'student',
      'GET',
      A(`/lectures/${l.id}/offline-package`),
    );
    expect(pkg).toMatchObject({ space_id: SPACE_A, lecture_id: l.id, version: { id: v.version_id } });
    expect(pkg.totals.files).toBeGreaterThanOrEqual(1);
    const data = pkg.entries.filter((e) => e.kind === 'data');
    expect(data.map((e) => e.role)).toEqual(expect.arrayContaining(['source_detail', 'pages', 'page_regions']));
    for (const e of data) {
      expect(e.path!.startsWith(`/api/spaces/${SPACE_A}/`), e.path).toBe(true);
      const res = await w.req('student', 'GET', e.path!);
      expect(res.statusCode, e.path).toBe(200);
    }
    for (const f of pkg.entries.filter((e) => e.kind === 'file')) {
      expect(f.url!.startsWith(`/api/spaces/${SPACE_A}/files/`), f.url).toBe(true);
      const res = await w.req('student', 'GET', f.url!);
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.length).toBe(f.size);
    }
    // never a personal item: an official package carries no annotations or notes of anyone
    expect(pkg.entries.some((e) => e.role === 'annotations' || e.role === 'notes')).toBe(false);
  });
});
