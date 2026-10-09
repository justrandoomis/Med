import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { PROCESS_JOB_KIND, type ProcessingStatusResponse, type SourceDetail, type SourcePagesResponse, type UploadFileResult } from '@medlevo/shared';
import { suggestSourceType } from '../../src/modules/sources/classify';
import { sniff } from '../../src/modules/sources/sniff';
import { enqueuePendingVersions, setSofficeAvailableForTests } from '../../src/modules/sources/upload';
import { CSRF } from '../helpers/app';
import { api, createNode, golden, type Harness, localFixture, makeHarness, multipart, upload, uploadOk } from './helpers';

let t: Harness | null = null;
afterEach(async () => {
  setSofficeAvailableForTests(null);
  await t?.close();
  t = null;
});

const detail = async (h: Harness, id: string) => (await api(h).get(`/api/sources/${id}`)).json() as SourceDetail;
const AR = /[؀-ۿ]/;

describe('Golden Set uploads (one per fixture type)', () => {
  it('PDF: accepted from content, page count, pages pagination, type suggested from the name, processing enqueued', async () => {
    t = await makeHarness();
    const node = await createNode(t, { title: 'Lectures' });
    const res = await uploadOk(t, node.id, [{ name: 'lecture_appendicitis.pdf', data: golden('lecture_appendicitis.pdf'), contentType: 'image/png' }]);
    const r = res.results[0]!;
    expect(r).toMatchObject({ status: 'accepted', detected_format: 'pdf', suggested_source_type: 'lecture', file_name: 'lecture_appendicitis.pdf' });
    const d = await detail(t, r.source_id!);
    expect(d).toMatchObject({ title: 'lecture appendicitis', source_type: 'lecture', source_type_origin: 'auto', metadata_status: 'unknown', format: 'pdf', page_count: 4 });
    // never invented metadata
    expect([d.edition, d.authors, d.publication_date, d.original_url, d.language]).toEqual([null, null, null, null, null]);
    const v = d.versions[0]!;
    expect(v).toMatchObject({ version_no: 1, kind: 'original', format: 'pdf', pagination: 'pages', mime: 'application/pdf', page_count: 4, processing_status: 'pending' });
    expect(v.display_file_id).toBe(v.file_id);
    expect(v.processing_summary).toMatchObject({ stage: 'queued', pages_total: 4, pages_ready: 0, coverage_complete: false });
    const job = t.ctx.jobs.get(v.processing_summary!.job_id!)!;
    expect(job.kind).toBe(PROCESS_JOB_KIND);
    expect(job.status).toBe('queued');
    expect(job.input).toEqual({ version_id: v.id, reason: 'upload' });
    expect(job.idempotency_key).toBe(`${PROCESS_JOB_KIND}:${v.id}:upload`);
    const st = (await api(t).get(`/api/sources/versions/${v.id}/processing`)).json() as ProcessingStatusResponse;
    expect(st.job!.id).toBe(job.id);
    expect(st.summary!.stage).toBe('queued');
  });

  it('DOCX → paragraphs (no invented page count); PPTX → slides with the slide count', async () => {
    t = await makeHarness();
    const node = await createNode(t, { title: 'N' });
    const res = await uploadOk(t, node.id, [
      { name: 'lecture_notes_shock.docx', data: golden('lecture_notes_shock.docx') },
      { name: 'slides_shock.pptx', data: golden('slides_shock.pptx') },
    ]);
    expect(res.results.map((r) => [r.status, r.detected_format])).toEqual([
      ['accepted', 'docx'],
      ['accepted', 'pptx'],
    ]);
    const docx = await detail(t, res.results[0]!.source_id!);
    expect(docx.versions[0]).toMatchObject({ format: 'docx', pagination: 'paragraphs', page_count: null, display_file_id: null });
    const pptx = await detail(t, res.results[1]!.source_id!);
    expect(pptx.versions[0]).toMatchObject({ format: 'pptx', pagination: 'slides', page_count: 3, display_file_id: null });
    expect(pptx.source_type).toBe('lecture');
  });

  it('PNG → image source with one image page (render file, pixel size); question photo suggested as question source', async () => {
    t = await makeHarness();
    const node = await createNode(t, { title: 'N' });
    const res = await uploadOk(t, node.id, [{ name: 'question_photo_circled.png', data: golden('question_photo_circled.png') }]);
    const r = res.results[0]!;
    expect(r).toMatchObject({ status: 'accepted', detected_format: 'image', suggested_source_type: 'question_source' });
    const d = await detail(t, r.source_id!);
    const pages = (await api(t).get(`/api/sources/${d.id}/versions/${d.versions[0]!.id}/pages`)).json() as SourcePagesResponse;
    expect(pages.pages).toHaveLength(1);
    expect(pages.pages[0]).toMatchObject({ page_index: 0, kind: 'image', unit: 'px', render_file_id: d.versions[0]!.file_id, processing_status: 'pending' });
    expect(pages.pages[0]!.width).toBeGreaterThan(10);
    expect(pages.pages[0]!.height).toBeGreaterThan(10);
  });

  it('ZIP of images → image set in natural order; junk entries rejected with Arabic reasons (Golden expected.json)', async () => {
    t = await makeHarness();
    const node = await createNode(t, { title: 'Histology' });
    const res = await uploadOk(t, node.id, [{ name: 'histology_images.zip', data: golden('histology_images.zip') }]);
    const r = res.results[0]!;
    expect(r).toMatchObject({ status: 'accepted', detected_format: 'zip' });
    expect(r.rejected_entries!.map((e) => e.name).sort()).toEqual(['__MACOSX/slides/._01_epithelium.png', 'slides/.DS_Store', 'slides/readme.txt'].sort());
    for (const e of r.rejected_entries!) expect(e.reason_ar).toMatch(AR);
    const d = await detail(t, r.source_id!);
    const v = d.versions[0]!;
    expect(v).toMatchObject({ format: 'image_set', pagination: 'images', file_id: null, page_count: 3, mime: 'application/zip' });
    expect(v.original_file_id).toBeTruthy();
    const pages = (await api(t).get(`/api/sources/${d.id}/versions/${v.id}/pages`)).json() as SourcePagesResponse;
    expect(pages.pages.map((p) => p.section_key)).toEqual(['slides/01_epithelium.png', 'slides/02_connective_tissue.png', 'slides/10_muscle.png']);
    expect(pages.pages.map((p) => p.page_index)).toEqual([0, 1, 2]);
    expect(new Set(pages.pages.map((p) => p.render_file_id)).size).toBe(3);
    // the temp extraction directory is cleaned up
    expect(readdirSync(t.config.tmpDir).filter((n) => n.startsWith('zip-') || n.startsWith('upload-'))).toEqual([]);
  });

  it('type suggestions follow the Golden Set ground truth', () => {
    expect(suggestSourceType('questions_previous_exam_2024.pdf', 'pdf').type).toBe('previous_exam');
    expect(suggestSourceType('questions_surgery_course1.pdf', 'pdf').type).toBe('question_source');
    expect(suggestSourceType('lecture_appendicitis.pdf', 'pdf').type).toBe('lecture');
    expect(suggestSourceType('محاضرة 3 القلب.pdf', 'pdf').type).toBe('lecture');
    expect(suggestSourceType('أسئلة الجراحة.pdf', 'pdf').type).toBe('question_source');
    expect(suggestSourceType('MCQs cardio.pdf', 'pdf').type).toBe('question_source');
    expect(suggestSourceType('selection.pdf', 'pdf')).toEqual({ type: 'lecture', matched: false });
    expect(suggestSourceType('Atlas of histology.pdf', 'pdf').type).toBe('image_atlas');
    expect(suggestSourceType('voice note.m4a', 'audio').type).toBe('my_audio_note');
    expect(suggestSourceType('lec 4.mp3', 'audio').type).toBe('lecture_audio');
  });

  it('owner-chosen type wins over the suggestion and is marked as the owner’s choice', async () => {
    t = await makeHarness();
    const node = await createNode(t, { title: 'N' });
    const res = await uploadOk(t, node.id, [{ name: 'questions_previous_exam_2024.pdf', data: golden('questions_previous_exam_2024.pdf') }], {
      source_type: 'question_source',
      title: 'امتحان 2024',
    });
    expect(res.results[0]!.suggested_source_type).toBe('previous_exam');
    const d = await detail(t, res.results[0]!.source_id!);
    expect(d).toMatchObject({ title: 'امتحان 2024', source_type: 'question_source', source_type_origin: 'owner' });
  });
});

describe('rejections with reasons (content is sniffed, never trusted by extension)', () => {
  async function one(h: Harness, name: string, data: Buffer): Promise<UploadFileResult> {
    const node = await createNode(h, { title: `N ${name}` });
    return (await uploadOk(h, node.id, [{ name, data }])).results[0]!;
  }

  it('password-protected PDF rejected; owner-restricted (no open password) accepted with a note', async () => {
    t = await makeHarness();
    const pw = await one(t, 'secret.pdf', localFixture('password_protected.pdf'));
    expect(pw).toMatchObject({ status: 'rejected', detected_format: 'pdf' });
    expect(pw.reason_ar).toContain('كلمة مرور');
    const restricted = await one(t, 'restricted.pdf', localFixture('owner_restricted.pdf'));
    expect(restricted.status).toBe('accepted');
    expect((await detail(t, restricted.source_id!)).versions[0]!.note).toContain('مقيّد');
  });

  it('garbage, fake PDF, unknown/text/HTML/executable/HEIC/BMP/empty files are rejected with specific Arabic reasons', async () => {
    t = await makeHarness();
    const cases: Array<[string, Buffer, RegExp]> = [
      // fixed first bytes: random ones could (rarely) look like an MP3 frame or a JPEG and make this test flaky
      ['random.pdf', Buffer.concat([Buffer.from([0x00, 0x13, 0x37, 0x42]), randomBytes(4092)]), /صيغة الملف غير معروفة/],
      ['fake.pdf', Buffer.from('%PDF-1.7\nthis is not really a pdf\n%%EOF\n'), /تالف/],
      ['notes.txt', Buffer.from('plain text notes\nline two\n'), /النص العادي/],
      ['page.html', Buffer.from('<!DOCTYPE html><html><body>x</body></html>'), /HTML/],
      ['setup.png', Buffer.concat([Buffer.from('MZ'), randomBytes(200)]), /تنفيذي/],
      ['IMG_0001.heic', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), randomBytes(64)]), /HEIC/],
      ['scan.bmp', Buffer.concat([Buffer.from('BM'), randomBytes(64)]), /BMP/],
      ['empty.pdf', Buffer.alloc(0), /فارغ/],
      ['archive.rar', Buffer.concat([Buffer.from('Rar!'), randomBytes(32)]), /RAR/],
    ];
    for (const [name, data, re] of cases) {
      const r = await one(t, name, data);
      expect(r.status, name).toBe('rejected');
      expect(r.reason_ar, name).toMatch(re);
      expect(r.source_id).toBeUndefined();
    }
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source')!.n).toBe(0);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file')!.n).toBe(0); // rejected files are never stored
  });

  it('ZIP: traversal entries rejected, archives without images rejected, spreadsheets/OpenDocument rejected', async () => {
    t = await makeHarness();
    const zip = async (entries: Array<[string, Buffer | string]>) => {
      const z = new JSZip();
      for (const [n, d] of entries) z.file(n, d);
      return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    };
    const img = golden('flowchart.png');
    const mixed = await one(t, 'set.zip', await zip([['../evil.png', img], ['b/2.png', img], ['b/10.png', golden('scanned_page.png')], ['doc.pdf', '%PDF-1.7 x']]));
    expect(mixed.status).toBe('accepted');
    const reasons = Object.fromEntries(mixed.rejected_entries!.map((e) => [e.name, e.reason_ar]));
    expect(reasons['../evil.png']).toMatch(/\.\.\//);
    expect(reasons['doc.pdf']).toMatch(/ليس صورة/);
    const noImages = await one(t, 'docs.zip', await zip([['a.txt', 'hello'], ['b.txt', 'world']]));
    expect(noImages).toMatchObject({ status: 'rejected', detected_format: 'zip' });
    expect(noImages.reason_ar).toMatch(/لا يحتوي الأرشيف على صور/);
    expect(noImages.rejected_entries).toHaveLength(2);
    const xlsx = await one(t, 'sheet.xlsx', await zip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<w/>']]));
    expect(xlsx.reason_ar).toMatch(/Excel/);
    const odt = await one(t, 'doc.odt', await zip([['mimetype', 'application/vnd.oasis.opendocument.text'], ['content.xml', '<x/>']]));
    expect(odt.reason_ar).toMatch(/OpenDocument/);
    const brokenDocx = await one(t, 'broken.docx', await zip([['[Content_Types].xml', '<Types/>'], ['word/styles.xml', '<s/>']]));
    expect(brokenDocx.reason_ar).toMatch(/تالف/);
  });

  it('legacy .doc/.ppt: rejected with a reason without LibreOffice; accepted as convert-only with it', async () => {
    t = await makeHarness();
    const ole = (stream: string) =>
      Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504), Buffer.from(stream, 'utf16le'), Buffer.alloc(256)]);
    setSofficeAvailableForTests(false);
    const no = await one(t, 'old.doc', ole('WordDocument'));
    expect(no).toMatchObject({ status: 'rejected', detected_format: 'doc' });
    expect(no.reason_ar).toMatch(/LibreOffice/);
    setSofficeAvailableForTests(true);
    const yes = await one(t, 'old lecture.ppt', ole('PowerPoint Document'));
    expect(yes).toMatchObject({ status: 'accepted', detected_format: 'ppt' });
    const v = (await detail(t, yes.source_id!)).versions[0]!;
    expect(v).toMatchObject({ format: 'pdf', pagination: 'slides', file_id: null, display_file_id: null, mime: 'application/vnd.ms-powerpoint' });
    expect(v.original_file_id).toBeTruthy();
    const xls = await one(t, 'grades.xls', ole('Workbook'));
    expect(xls.reason_ar).toMatch(/Excel/);
    const enc = await one(t, 'locked.docx', ole('EncryptedPackage'));
    expect(enc.reason_ar).toMatch(/كلمة مرور/);
  });

  it('audio is stored as lecture audio with transcription honestly marked unavailable (no job)', async () => {
    t = await makeHarness();
    const node = await createNode(t, { title: 'N' });
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), randomBytes(2048)]);
    const r = (await uploadOk(t, node.id, [{ name: 'lecture 3 recording.mp3', data: mp3 }])).results[0]!;
    expect(r).toMatchObject({ status: 'accepted', detected_format: 'audio', suggested_source_type: 'lecture_audio' });
    const d = await detail(t, r.source_id!);
    expect(d.versions[0]).toMatchObject({ format: 'audio', pagination: 'timestamps', processing_status: 'partial' });
    expect(d.versions[0]!.processing_summary!.stage_label_ar).toMatch(/التفريغ النصي.*غير متاح/);
    expect(d.versions[0]!.processing_summary!.coverage_complete).toBe(false);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM processing_job')!.n).toBe(0);
    const re = await api(t).post(`/api/sources/versions/${d.versions[0]!.id}/reprocess`, {});
    expect(re.statusCode).toBe(409);
    expect(re.json().error.code).toBe('FEATURE_DISABLED');
  });

  it('size limit applies per file: the oversized one is rejected, the rest of the upload continues', async () => {
    t = await makeHarness({ env: { MEDLEVO_MAX_UPLOAD_MB: '0.05' } }); // ≈ 52 KB
    const node = await createNode(t, { title: 'N' });
    const res = await uploadOk(t, node.id, [
      { name: 'scanned_page.png', data: golden('scanned_page.png') }, // 110 KB
      { name: 'flowchart.png', data: golden('flowchart.png') }, // 25 KB
    ]);
    expect(res.results.map((r) => r.status)).toEqual(['rejected', 'accepted']);
    expect(res.results[0]!.reason_ar).toMatch(/أكبر من الحد المسموح/);
  });

  it('sniffing table', () => {
    expect(sniff(golden('lecture_appendicitis.pdf').subarray(0, 64))).toEqual({ kind: 'pdf' });
    expect(sniff(golden('flowchart.png').subarray(0, 64))).toEqual({ kind: 'image', mime: 'image/png' });
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(sniff(Buffer.from('GIF89a....'))).toEqual({ kind: 'image', mime: 'image/gif' });
    expect(sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toEqual({ kind: 'image', mime: 'image/webp' });
    expect(sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]))).toEqual({ kind: 'audio', mime: 'audio/wav' });
    expect(sniff(Buffer.from('OggS\0\x02'))).toEqual({ kind: 'audio', mime: 'audio/ogg' });
    expect(sniff(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A ')]))).toEqual({ kind: 'audio', mime: 'audio/mp4' });
    expect(sniff(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom')]))).toEqual({ kind: 'unsupported', what: 'video' });
    expect(sniff(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toEqual({ kind: 'image', mime: 'image/tiff' });
    expect(sniff(golden('slides_shock.pptx').subarray(0, 8))).toEqual({ kind: 'zip' });
  });
});

describe('multi-file & duplicates', () => {
  it('reports each file of a mixed upload (accepted / rejected / duplicate) in order', async () => {
    t = await makeHarness();
    const node = await createNode(t, { title: 'Mixed' });
    const pdf = golden('lecture_cholecystitis.pdf');
    const res = await uploadOk(t, node.id, [
      { name: 'lecture_cholecystitis.pdf', data: pdf },
      { name: 'virus.exe', data: Buffer.concat([Buffer.from('MZ'), randomBytes(100)]) },
      { name: 'copy of lecture.pdf', data: pdf },
      { name: 'flowchart.png', data: golden('flowchart.png') },
    ]);
    expect(res.results.map((r) => [r.file_name, r.status])).toEqual([
      ['lecture_cholecystitis.pdf', 'accepted'],
      ['virus.exe', 'rejected'],
      ['copy of lecture.pdf', 'duplicate'],
      ['flowchart.png', 'accepted'],
    ]);
    expect(res.results[2]!.duplicate_of).toEqual({ source_id: res.results[0]!.source_id, version_id: res.results[0]!.version_id, title: 'lecture cholecystitis' });
  });

  it('duplicate detection never deletes or merges silently; on_duplicate=create makes a flagged copy', async () => {
    t = await makeHarness();
    const a = await createNode(t, { title: 'A' });
    const b = await createNode(t, { title: 'B' });
    const first = (await uploadOk(t, a.id, [{ name: 'q.pdf', data: golden('questions_surgery_course1.pdf') }])).results[0]!;
    const dup = (await uploadOk(t, b.id, [{ name: 'other name.pdf', data: golden('questions_surgery_course1.pdf') }])).results[0]!;
    expect(dup.status).toBe('duplicate');
    expect(dup.reason_ar).toMatch(/لم يُنشأ مصدر جديد ولم يُحذف شيء/);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source')!.n).toBe(1);
    expect((await detail(t, first.source_id!)).title).toBe('q'); // original untouched
    const forced = (await uploadOk(t, b.id, [{ name: 'other name.pdf', data: golden('questions_surgery_course1.pdf') }], { on_duplicate: 'create' })).results[0]!;
    expect(forced.status).toBe('accepted');
    expect(forced.duplicate_of!.source_id).toBe(first.source_id);
    expect((await detail(t, forced.source_id!)).versions[0]!.note).toMatch(/محتوى مطابق/);
    // the same bytes are stored once (content-addressed)
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file')!.n).toBe(1);
    // a duplicate of a source in the trash says so
    await api(t).post(`/api/sources/${first.source_id}/trash`);
    await api(t).post(`/api/sources/${forced.source_id}/trash`);
    const again = (await uploadOk(t, a.id, [{ name: 'q.pdf', data: golden('questions_surgery_course1.pdf') }])).results[0]!;
    expect(again.status).toBe('duplicate');
    expect(again.reason_ar).toMatch(/سلة المحذوفات/);
  });
});

describe('upload request validation & auth', () => {
  it('requires node_id, a live folder and at least one file; requires session + CSRF', async () => {
    t = await makeHarness();
    const node = await createNode(t, { title: 'N' });
    const noNode = multipart({}, [{ name: 'a.png', data: golden('flowchart.png') }]);
    const r1 = await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...t.h, 'content-type': noNode.contentType }, payload: noNode.payload });
    expect(r1.statusCode).toBe(400);
    expect((await upload(t, 'NOPE', [{ name: 'a.png', data: golden('flowchart.png') }])).statusCode).toBe(404);
    expect((await upload(t, node.id, [])).statusCode).toBe(400);
    await api(t).post(`/api/library/nodes/${node.id}/trash`);
    expect((await upload(t, node.id, [{ name: 'a.png', data: golden('flowchart.png') }])).statusCode).toBe(409);
    const json = await api(t).post('/api/sources/upload', { node_id: node.id });
    expect(json.statusCode).toBe(415);
    const body = multipart({ node_id: node.id }, [{ name: 'a.png', data: golden('flowchart.png') }]);
    expect((await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...CSRF, 'content-type': body.contentType }, payload: body.payload })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { cookie: t.h.cookie, 'content-type': body.contentType }, payload: body.payload })).statusCode).toBe(403);
  });

  it('without a processing handler the upload still succeeds and says processing is unavailable; it is queued on the next boot with a handler', async () => {
    t = await makeHarness({ processing: 'none' });
    const node = await createNode(t, { title: 'N' });
    const r = (await uploadOk(t, node.id, [{ name: 'lecture_cholecystitis.pdf', data: golden('lecture_cholecystitis.pdf') }])).results[0]!;
    expect(r.status).toBe('accepted');
    const st = (await api(t).get(`/api/sources/versions/${r.version_id}/processing`)).json() as ProcessingStatusResponse;
    expect(st.job).toBeNull();
    expect(st.summary!.stage_label_ar).toMatch(/غير متاحة/);
    const re = await api(t).post(`/api/sources/versions/${r.version_id}/reprocess`, {});
    expect(re.statusCode).toBe(409);
    expect(re.json().error.message).toMatch(/غير متاحة/);
    // a later boot that has a handler queues the pending version (once)
    t.ctx.jobs.register(PROCESS_JOB_KIND, { version: 'late', handler: async () => ({}) });
    expect(enqueuePendingVersions(t.ctx)).toBe(1);
    expect(enqueuePendingVersions(t.ctx)).toBe(1);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM processing_job')!.n).toBe(1);
    const after = (await api(t).get(`/api/sources/versions/${r.version_id}/processing`)).json() as ProcessingStatusResponse;
    expect(after.job!.status).toBe('queued');
    expect(after.summary!.job_id).toBe(after.job!.id);
  });
});
