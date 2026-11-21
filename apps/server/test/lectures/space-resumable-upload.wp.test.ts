// AOS-2.3 / 18.3 (gap «chunked / bulk upload into a space»): P1-T1's chunked, resumable uploads INTO a subject space.
//   * `/api/spaces/:s/uploads…` is declared in authz/spaceRoutes.ts and mounted by the lectures plugin; the session is
//     bound to the space (target `s:<space>`), its file is stored in the SPACE database — the uploader's vault is untouched;
//   * an interrupted upload announces the same bytes again, gets the same session back and sends only what is missing;
//   * the completed session becomes an official version through `POST /lectures/:id/upload {upload_id}` (the same
//     inspection and processing as the one-shot multipart upload);
//   * who may: contributors and official moderators of THE subject; a student or an Assistant gets 403; a stranger, a
//     member of another subject or a guest gets 404 (gate 2); someone else's session — or a vault session — is 404;
//   * the subject's storage quota is checked when the session starts (every member's open sessions into the subject
//     count) and again when the file is stored; an open space session never counts against the uploader's own vault.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LecturesFromTemplateResponse, OfficialLectureDetail, OfficialLectureView, UploadCompleteResponse, UploadOfficialVersionResponse, UploadSessionView } from '@medlevo/shared';
import { templateLectureTitles } from '@medlevo/shared';
import { MODULES } from '../../src/modules';
import { createProcessingModule } from '../../src/modules/processing';
import { STUDY_TEMPLATES } from '../../src/modules/library/templates';
import { createTestApp } from '../helpers/app';
import { createLectureWorld, drain, inSpace, lecturePdf, pagesFor, sp, SPACE_A, SPACE_B, type LectureWorld, type Person } from './world';

/** ≈ 2 KB chunks, so a small test PDF needs several */
const CHUNK_MB = '0.002';

let w: LectureWorld;
beforeAll(async () => {
  w = await createLectureWorld({
    app: () => createTestApp({ modules: MODULES.map((m) => (m.name === 'processing' ? { ...m, plugin: createProcessingModule({}) } : m)), jobs: { backoffBaseMs: 0, backoffMaxMs: 0 }, env: { MEDLEVO_UPLOAD_CHUNK_MB: CHUNK_MB, MEDLEVO_LOG_LEVEL: 'error' } }),
  });
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const announce = (data: Buffer, name: string, space = SPACE_A) => ({ size: data.length, sha256: sha(data), mime: 'application/pdf', name, target: { space_id: space } });
const start = (who: Person, data: Buffer, name: string, space = SPACE_A, body: unknown = announce(data, name, space)) => w.req(who, 'POST', sp(space, '/uploads'), body);
const putChunk = (who: Person, id: string, n: number, part: Buffer, space = SPACE_A) =>
  w.t.app.inject({ method: 'PUT', url: sp(space, `/uploads/${id}/chunks/${n}`), headers: { ...w.h[who], 'content-type': 'application/octet-stream', 'x-content-sha256': sha(part) }, payload: part });
const partsOf = (data: Buffer, size: number) => Array.from({ length: Math.ceil(data.length / size) }, (_, i) => data.subarray(i * size, (i + 1) * size));

/** a whole chunked upload into the space, completed; returns the upload id */
async function uploadAll(who: Person, data: Buffer, name: string): Promise<string> {
  const s = (await start(who, data, name)).json() as UploadSessionView;
  const parts = partsOf(data, s.chunk_size);
  for (let n = 0; n < parts.length; n++) if (!s.received.includes(n)) { const r = await putChunk(who, s.upload_id, n, parts[n]!); expect(r.statusCode, r.body).toBe(200); }
  const done = await w.req(who, 'POST', sp(SPACE_A, `/uploads/${s.upload_id}/complete`), {});
  expect(done.statusCode, done.body).toBe(200);
  return s.upload_id;
}

const vaultIdOf = (who: Person) => w.t.ctx.system.vaults.ofUserInternal(w.id[who])!.id;

describe('AOS-2.3 / 18.3 — a resumable upload into the subject space', () => {
  it('a contributor sends a lecture in chunks; the connection cuts; the same session resumes; the file becomes a version in the space', async () => {
    const data = lecturePdf(pagesFor('Resume', 14));
    const s1 = await start('contrib', data, 'Lecture 9 resumable.pdf');
    expect(s1.statusCode, s1.body).toBe(200);
    const v1 = s1.json() as UploadSessionView;
    expect(v1.status).toBe('open');
    expect(v1.chunks).toBeGreaterThan(2);
    const parts = partsOf(data, v1.chunk_size);
    expect((await putChunk('contrib', v1.upload_id, 0, parts[0]!)).json().received).toEqual([0]);
    expect((await putChunk('contrib', v1.upload_id, 2, parts[2]!)).json().received).toEqual([0, 2]);

    // «the connection cut»: the phone announces the same bytes again — same session, the chunks it holds are kept
    const again = (await start('contrib', data, 'Lecture 9 resumable.pdf')).json() as UploadSessionView;
    expect(again.upload_id).toBe(v1.upload_id);
    expect(again.received).toEqual([0, 2]);
    expect((await w.req('contrib', 'GET', sp(SPACE_A, `/uploads/${v1.upload_id}`))).json().received).toEqual([0, 2]);

    // completing early names what is missing; the lecture cannot take an unfinished upload
    const early = await w.req('contrib', 'POST', sp(SPACE_A, `/uploads/${v1.upload_id}/complete`), {});
    expect(early.statusCode).toBe(409);
    expect(early.json().error.details.missing).toContain(1);
    const draft = await w.ok<OfficialLectureView>('contrib', 'POST', sp(SPACE_A, '/lectures'), { title: 'Resumable lecture', lecture_no: 9 });
    const unfinished = await w.req('contrib', 'POST', sp(SPACE_A, `/lectures/${draft.id}/upload`), { upload_id: v1.upload_id });
    expect(unfinished.statusCode, unfinished.body).toBe(409);
    expect(unfinished.json().error.message).toMatch(/لم يكتمل رفع هذا الملف/);

    for (let n = 0; n < parts.length; n++) if (!again.received.includes(n)) expect((await putChunk('contrib', v1.upload_id, n, parts[n]!)).statusCode).toBe(200);
    const done = await w.req('contrib', 'POST', sp(SPACE_A, `/uploads/${v1.upload_id}/complete`), {});
    expect(done.statusCode, done.body).toBe(200);
    const { file } = done.json() as UploadCompleteResponse;
    expect(file).toMatchObject({ sha256: sha(data), size: data.length });

    // stored in the SPACE database, not in the contributor's vault
    expect(inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file WHERE sha256 = ?', [sha(data)])!.n)).toBe(1);
    const vaultHas = w.t.ctx.binding.run({ kind: 'vault', vaultId: vaultIdOf('contrib'), viewer: null }, () => w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file WHERE sha256 = ?', [sha(data)])!.n);
    expect(vaultHas).toBe(0);

    // the completed session becomes the draft's version (inspection + processing as for a one-shot upload)
    const up = await w.ok<UploadOfficialVersionResponse>('contrib', 'POST', sp(SPACE_A, `/lectures/${draft.id}/upload`), { upload_id: v1.upload_id });
    expect(up.version_id).toBeTruthy();
    await drain(w);
    const detail = await w.ok<OfficialLectureDetail>('contrib', 'GET', sp(SPACE_A, `/lectures/${draft.id}`));
    expect(detail.status).toBe('in_review'); // a contributor's file waits for a Subject Moderator (Q5)
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0]).toMatchObject({ file_name: 'Lecture 9 resumable.pdf', page_count: 14, uploaded_by: { id: w.id.contrib } });
    expect(['ready', 'partial', 'needs_review']).toContain(detail.versions[0]!.processing_status);
    // the moderator sees it and may approve it as usual
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${draft.id}/approve`), {});
  });

  it('a moderator\'s upload of bytes the subject already holds completes at once (nothing sent again)', async () => {
    const data = lecturePdf(pagesFor('Resume', 14));
    const s = (await start('mod', data, 'same.pdf')).json() as UploadSessionView;
    expect(s.status).toBe('completed');
    expect(s.file_id).toBeTruthy();
  });

  it('attachments take a completed upload too', async () => {
    const data = lecturePdf(pagesFor('Syllabus', 2));
    const id = await uploadAll('mod', data, 'syllabus.pdf');
    const res = await w.req('mod', 'POST', sp(SPACE_A, '/subject/attachments'), { kind: 'summary', title: 'ملخص المادة', upload_id: id });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('AOS-2.3 — who may upload into the subject, and whose session is whose', () => {
  it('a student and an Assistant are refused (403); a stranger, a member of another subject and a pending member learn nothing', async () => {
    const data = lecturePdf(pagesFor('Who', 1));
    const openBefore = w.t.ctx.system.uploads.openBytesToInternal(`s:${SPACE_A}`);
    for (const who of ['student', 'assistant'] as const) {
      const res = await start(who, data, 'x.pdf');
      expect(res.statusCode, `${who}: ${res.body}`).toBe(403);
    }
    for (const who of ['outsider', 'modB'] as const) {
      const res = await start(who, data, 'x.pdf');
      expect(res.statusCode, `${who}: ${res.body}`).toBe(404);
    }
    const pending = await start('pending', data, 'x.pdf');
    expect([403, 404], pending.body).toContain(pending.statusCode);
    const guest = await w.t.app.inject({ method: 'POST', url: sp(SPACE_A, '/uploads'), payload: announce(data, 'x.pdf') });
    expect([401, 403, 404]).toContain(guest.statusCode);
    // nothing was opened for any of them
    expect(w.t.ctx.system.uploads.openBytesToInternal(`s:${SPACE_A}`)).toBe(openBefore);
  });

  it('another member\'s session, a vault session, another subject\'s target: 404 / 400', async () => {
    const data = lecturePdf(pagesFor('Mine', 3));
    const mine = (await start('contrib', data, 'mine.pdf')).json() as UploadSessionView;
    // another contributor of the same subject: not found
    expect((await w.req('contrib2', 'GET', sp(SPACE_A, `/uploads/${mine.upload_id}`))).statusCode).toBe(404);
    expect((await putChunk('contrib2', mine.upload_id, 0, partsOf(data, mine.chunk_size)[0]!)).statusCode).toBe(404);
    expect((await w.req('mod', 'POST', sp(SPACE_A, `/uploads/${mine.upload_id}/complete`), {})).statusCode).toBe(404);
    const theirLecture = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Not with your upload' });
    expect((await w.req('mod', 'POST', sp(SPACE_A, `/lectures/${theirLecture.id}/upload`), { upload_id: mine.upload_id })).statusCode).toBe(404);
    // the session is not reachable through the vault route either (it belongs to the space)
    expect((await w.req('contrib', 'GET', `/api/files/uploads/${mine.upload_id}`)).statusCode).toBe(404);
    expect((await w.req('contrib', 'DELETE', sp(SPACE_A, `/uploads/${mine.upload_id}`))).statusCode).toBe(200);

    // a completed VAULT session cannot be turned into an official version
    const vaultData = lecturePdf(pagesFor('Vault', 1));
    const vs = (await w.req('contrib', 'POST', '/api/files/uploads', { size: vaultData.length, sha256: sha(vaultData), mime: 'application/pdf', name: 'v.pdf' })).json() as UploadSessionView;
    const vparts = partsOf(vaultData, vs.chunk_size);
    for (let n = 0; n < vparts.length; n++) {
      const r = await w.t.app.inject({ method: 'PUT', url: `/api/files/uploads/${vs.upload_id}/chunks/${n}`, headers: { ...w.h.contrib, 'content-type': 'application/octet-stream', 'x-content-sha256': sha(vparts[n]!) }, payload: vparts[n]! });
      expect(r.statusCode).toBe(200);
    }
    expect((await w.req('contrib', 'POST', `/api/files/uploads/${vs.upload_id}/complete`, {})).statusCode).toBe(200);
    const own = await w.ok<OfficialLectureView>('contrib', 'POST', sp(SPACE_A, '/lectures'), { title: 'Vault session draft' });
    expect((await w.req('contrib', 'POST', sp(SPACE_A, `/lectures/${own.id}/upload`), { upload_id: vs.upload_id })).statusCode).toBe(404);

    // the body must name THIS subject; the vault route refuses a space target
    const wrong = await start('contrib', data, 'w.pdf', SPACE_A, { ...announce(data, 'w.pdf'), target: { space_id: SPACE_B } });
    expect(wrong.statusCode).toBe(400);
    expect((await start('contrib', data, 'w.pdf', SPACE_A, { ...announce(data, 'w.pdf'), target: 'vault' })).statusCode).toBe(400);
    const vaultRoute = await w.req('contrib', 'POST', '/api/files/uploads', announce(data, 'w.pdf'));
    expect(vaultRoute.statusCode).toBe(400);
  });
});

describe('AOS-21.9 / 21.45 — the subject\'s quota on resumable uploads', () => {
  it('a session that would take the subject over its limit is refused when it starts; open sessions count', async () => {
    const owner = w.id.owner;
    const used = w.t.ctx.quota.spaceStorageUsed(SPACE_A);
    // every member's open sessions into the subject count as used
    const total = used.bytes_db + used.bytes_files + w.t.ctx.system.uploads.openBytesToInternal(`s:${SPACE_A}`);
    const a = lecturePdf(pagesFor('QuotaA', 4));
    const b = lecturePdf(pagesFor('QuotaB', 4));
    try {
      // room for one of them, not for both
      w.t.ctx.system.quotas.setSpaceInternal(SPACE_A, { storage_bytes_limit: total + Math.floor(Math.max(a.length, b.length) * 1.5) }, owner);
      const first = await start('contrib', a, 'qa.pdf');
      expect(first.statusCode, first.body).toBe(200);
      const second = await start('contrib2', b, 'qb.pdf');
      expect(second.statusCode, second.body).toBe(409);
      expect(second.json().error).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { kind: 'space_storage', space_id: SPACE_A } });
      expect(second.json().error.message).toContain('Anatomy A');
      // abandoning the first frees its room
      expect((await w.req('contrib', 'DELETE', sp(SPACE_A, `/uploads/${(first.json() as UploadSessionView).upload_id}`))).statusCode).toBe(200);
      expect((await start('contrib2', b, 'qb.pdf')).statusCode).toBe(200);
    } finally {
      w.t.ctx.system.quotas.setSpaceInternal(SPACE_A, { storage_bytes_limit: null }, owner);
    }
  });

  it('a session into the subject never counts against the uploader\'s own vault quota', async () => {
    const owner = w.id.owner;
    const small = Buffer.alloc(1000, 7);
    const vaultId = vaultIdOf('contrib');
    try {
      // a 5 MB session into the subject (announced only: the bytes need not arrive for the quota to count it)
      const big = { size: 5 * 1024 * 1024, sha256: sha(Buffer.from('big lecture')), mime: 'application/pdf', name: 'big.pdf', target: { space_id: SPACE_A } };
      expect((await w.req('contrib', 'POST', sp(SPACE_A, '/uploads'), big)).statusCode).toBe(200);
      // the vault has room for 1 MB more — the open 5 MB space session must not use that room
      w.t.ctx.system.quotas.setUserInternal(w.id.contrib, { storage_bytes_limit: w.t.ctx.quota.storageTotal(vaultId) + 1024 * 1024 }, owner);
      const res = await w.req('contrib', 'POST', '/api/files/uploads', { size: small.length, sha256: sha(small), mime: 'application/octet-stream', name: 's.bin' });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      w.t.ctx.system.quotas.setUserInternal(w.id.contrib, { storage_bytes_limit: null }, owner);
    }
  });
});

describe('AOS-2.3 / 18.3 templates — the lecture skeleton of a study template', () => {
  it('a Subject Moderator creates one draft per topic; sending it again creates nothing; contributors and Assistants are refused', async () => {
    const tpl = STUDY_TEMPLATES.find((t) => t.key === 'pathology')!;
    const titles = templateLectureTitles(tpl);
    expect(titles).toEqual(['أذية الخلية — Cell injury', 'الالتهاب — Inflammation', 'الأورام — Neoplasia', 'علم الأمراض الجهازي — Systemic pathology']);
    const r = await w.ok<LecturesFromTemplateResponse>('mod', 'POST', sp(SPACE_A, '/lectures/from-template'), { template_key: 'pathology' });
    expect(r.created.map((l) => l.title)).toEqual(titles);
    expect(r.created.every((l) => l.status === 'draft')).toBe(true);
    expect(r.skipped).toEqual([]);
    const again = await w.ok<LecturesFromTemplateResponse>('mod', 'POST', sp(SPACE_A, '/lectures/from-template'), { template_key: 'pathology' });
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual(titles);
    // drafts: students do not see them
    const seen = await w.ok<{ items: OfficialLectureView[] }>('student', 'GET', sp(SPACE_A, '/lectures'));
    expect(seen.items.some((l) => titles.includes(l.title))).toBe(false);
    for (const who of ['contrib', 'assistant', 'student'] as const) {
      const res = await w.req(who, 'POST', sp(SPACE_A, '/lectures/from-template'), { template_key: 'pathology' });
      expect(res.statusCode, `${who}: ${res.body}`).toBe(403);
    }
    expect((await w.req('modB', 'POST', sp(SPACE_A, '/lectures/from-template'), { template_key: 'pathology' })).statusCode).toBe(404);
    expect((await w.req('mod', 'POST', sp(SPACE_A, '/lectures/from-template'), { template_key: 'nope' })).statusCode).toBe(400);
  });
});
