import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROCESS_JOB_KIND, type ImpactReport, type PageRegionsResponse, type SourceDetail, type UploadResponse } from '@medlevo/shared';
import { api, createNode, golden, type Harness, makeHarness, multipart, uploadOk } from './helpers';

let t: Harness;
beforeEach(async () => {
  t = await makeHarness();
});
afterEach(async () => {
  await t.close();
});

const detail = async (id: string) => (await api(t).get(`/api/sources/${id}`)).json() as SourceDetail;

async function replace(sourceId: string, name: string, data: Buffer, note?: string): Promise<UploadResponse> {
  const body = multipart(note ? { note } : {}, [{ name, data }]);
  const res = await t.app.inject({ method: 'POST', url: `/api/sources/${sourceId}/versions`, headers: { ...t.h, 'content-type': body.contentType }, payload: body.payload });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as UploadResponse;
}

async function seedSource(name = 'lecture_appendicitis.pdf', title?: string) {
  const subject = await createNode(t, { kind: 'subject', title: 'Surgery' });
  const course = await createNode(t, { kind: 'course', title: 'Course 1', parent_id: subject.id });
  const r = (await uploadOk(t, course.id, [{ name, data: golden(name) }], title ? { title } : {})).results[0]!;
  return { subject, course, id: r.source_id!, versionId: r.version_id! };
}

describe('source detail & metadata', () => {
  it('detail has versions, breadcrumb path and derived subject/course', async () => {
    const s = await seedSource();
    const d = await detail(s.id);
    expect(d.path.map((p) => [p.title, p.kind])).toEqual([
      ['Surgery', 'subject'],
      ['Course 1', 'course'],
    ]);
    expect(d.subject_node_id).toBe(s.subject.id);
    expect(d.course_node_id).toBe(s.course.id);
    expect(d.active_version_id).toBe(s.versionId);
    expect(d.versions).toHaveLength(1);
    expect((await api(t).get('/api/sources/NOPE')).statusCode).toBe(404);
  });

  it('PATCH: owner metadata only; type and lecture kind become the owner’s choice; validation in Arabic', async () => {
    const s = await seedSource();
    const res = await api(t).patch(`/api/sources/${s.id}`, {
      title: 'Appendicitis — lecture 3',
      source_type: 'lecture',
      lecture_kind: 'clinical',
      edition: '3rd',
      authors: ['Dr. A'],
      language: 'mixed',
      priority: 2,
      selection_reason: 'محاضرة الكورس الأساسية',
    });
    expect(res.statusCode).toBe(200);
    const d = res.json() as SourceDetail & { source_type_origin: string };
    expect(d).toMatchObject({
      title: 'Appendicitis — lecture 3',
      source_type_origin: 'owner',
      lecture_kind: 'clinical',
      lecture_kind_origin: 'owner',
      edition: '3rd',
      authors: ['Dr. A'],
      language: 'mixed',
      priority: 2,
      metadata_status: 'partial', // bibliographic data present but not confirmed
    });
    const bad = await api(t).patch(`/api/sources/${s.id}`, { original_url: 'javascript:alert(1)' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.issues[0].message).toMatch(/https/);
    expect((await api(t).patch(`/api/sources/${s.id}`, { publication_date: 'last year' })).statusCode).toBe(400);
    expect((await api(t).patch(`/api/sources/${s.id}`, { source_type: 'university_pack' })).statusCode).toBe(400);
    expect((await api(t).patch(`/api/sources/${s.id}`, { invented_field: 1 })).statusCode).toBe(400);
    const cleared = (await api(t).patch(`/api/sources/${s.id}`, { original_url: '', edition: null, authors: [] })).json();
    expect([cleared.original_url, cleared.edition, cleared.authors]).toEqual([null, null, null]);
    const audit = (await api(t).get(`/api/audit?entity_type=source&entity_id=${s.id}`)).json().entries;
    expect(audit[1].before.title).toBe('lecture appendicitis');
    expect(audit[1].after.title).toBe('Appendicitis — lecture 3');
  });

  it('PATCH node_id moves the source and recomputes subject/course; moving into the trash is refused', async () => {
    const s = await seedSource();
    const other = await createNode(t, { title: 'Loose' });
    const d = (await api(t).patch(`/api/sources/${s.id}`, { node_id: other.id })).json() as SourceDetail;
    expect([d.node_id, d.subject_node_id, d.course_node_id]).toEqual([other.id, null, null]);
    const trashed = await createNode(t, { title: 'T' });
    await api(t).post(`/api/library/nodes/${trashed.id}/trash`);
    expect((await api(t).patch(`/api/sources/${s.id}`, { node_id: trashed.id })).statusCode).toBe(409);
    // drag & drop ordering among sources of a folder
    const more = await uploadOk(t, other.id, [{ name: 'flowchart.png', data: golden('flowchart.png') }]);
    const sid2 = more.results[0]!.source_id!;
    const mv = await api(t).post(`/api/sources/${sid2}/move`, { node_id: other.id, before_id: s.id });
    expect(mv.statusCode).toBe(200);
    const list = (await api(t).get(`/api/sources?node_id=${other.id}`)).json().sources.map((x: { id: string }) => x.id);
    expect(list).toEqual([sid2, s.id]);
  });
});

describe('versions, replacement & Source Freeze', () => {
  it('replacement creates version 2; a frozen version stays the active one; content alert lists dependents', async () => {
    const s = await seedSource('lecture_cholecystitis.pdf');
    // something depended on version 1
    t.ctx.db.run(`INSERT INTO artifact_dependency (id, dependent_type, dependent_id, source_version_id, created_at) VALUES ('D1', 'artifact', 'ART9', ?, 1)`, [s.versionId]);
    const fr = await api(t).post(`/api/sources/${s.id}/freeze`, { version_id: s.versionId });
    expect(fr.statusCode).toBe(200);
    expect(fr.json().frozen_version_id).toBe(s.versionId);
    const rep = await replace(s.id, 'cholecystitis v2.pdf', golden('lecture_appendicitis.pdf'), 'نسخة مصححة من المحاضر');
    const r = rep.results[0]!;
    expect(r.status).toBe('accepted');
    const d = await detail(s.id);
    expect(d.versions.map((v) => [v.version_no, v.kind])).toEqual([
      [2, 'replacement'],
      [1, 'original'],
    ]);
    expect(d.current_version_id).toBe(r.version_id);
    expect(d.frozen_version_id).toBe(s.versionId); // never changed automatically
    expect(d.active_version_id).toBe(s.versionId);
    expect(d.versions.find((v) => v.id === s.versionId)!.is_frozen).toBe(true);
    expect(d.versions[0]!.note).toContain('نسخة مصححة');
    // processing enqueued for the new version with reason 'replacement'
    const job = t.ctx.jobs.get(d.versions[0]!.processing_summary!.job_id!)!;
    expect(job.input).toEqual({ version_id: r.version_id, reason: 'replacement' });
    const alert = t.ctx.db.get<{ kind: string; affected_json: string; summary: string }>(`SELECT * FROM content_alert WHERE source_id = ?`, [s.id])!;
    expect(alert.kind).toBe('source_replaced');
    expect(JSON.parse(alert.affected_json)).toEqual([{ type: 'artifact', id: 'ART9', impact: 'needs_review' }]);
    expect(alert.summary).toMatch(/Source Freeze/);
    // re-uploading content identical to an existing version of this source creates nothing
    const same = (await replace(s.id, 'again.pdf', golden('lecture_appendicitis.pdf'))).results[0]!;
    expect(same.status).toBe('duplicate');
    expect((await detail(s.id)).versions).toHaveLength(2);
    // unfreeze → study tools follow the latest version
    const un = (await api(t).post(`/api/sources/${s.id}/freeze`, { version_id: null })).json() as SourceDetail;
    expect(un.active_version_id).toBe(r.version_id);
    // a version of another source cannot be frozen here
    const other = await seedSource('lecture_notes_shock.docx');
    expect((await api(t).post(`/api/sources/${s.id}/freeze`, { version_id: other.versionId })).statusCode).toBe(400);
    const actions = (await api(t).get(`/api/audit?entity_type=source&entity_id=${s.id}`)).json().entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['unfreeze', 'new_version', 'freeze', 'create']);
  });

  it('replacement upload validates the file like any upload', async () => {
    const s = await seedSource('flowchart.png');
    const bad = (await replace(s.id, 'x.bin', Buffer.from('not a document'))).results[0]!;
    expect(bad.status).toBe('rejected');
    expect(bad.reason_ar).toMatch(/[؀-ۿ]/);
    expect((await detail(s.id)).versions).toHaveLength(1);
  });

  it('reprocess enqueues a NEW job each time (pages optional); validates page indexes', async () => {
    const s = await seedSource();
    const a = await api(t).post(`/api/sources/versions/${s.versionId}/reprocess`, { page_indexes: [1] });
    const b = await api(t).post(`/api/sources/versions/${s.versionId}/reprocess`, {});
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().job.id).not.toBe(b.json().job.id);
    expect(a.json().job.input).toEqual({ version_id: s.versionId, reason: 'reprocess', page_indexes: [1] });
    expect((await api(t).post(`/api/sources/versions/${s.versionId}/reprocess`, { page_indexes: [99] })).statusCode).toBe(400);
    const st = (await api(t).get(`/api/sources/versions/${s.versionId}/processing`)).json();
    expect(st.job.id).toBe(b.json().job.id); // latest job for this version
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM processing_job WHERE kind = ?', [PROCESS_JOB_KIND])!.n).toBe(3);
  });

  it('pages and regions endpoints return processing results with both page numberings available', async () => {
    const s = await seedSource();
    const now = t.clock.now();
    t.ctx.db.run(
      `INSERT INTO source_page (id, version_id, page_index, printed_label, printed_label_origin, kind, text_status, processing_status, error_code, error_detail, created_at, updated_at)
       VALUES ('P1', ?, 0, '11', 'pdf_page_labels', 'page', 'digital', 'ready', NULL, NULL, ?, ?),
              ('P2', ?, 1, '12', 'pdf_page_labels', 'page', 'failed', 'failed', 'OCR_FAILED', 'تعذرت قراءة الصفحة', ?, ?)`,
      [s.versionId, now, now, s.versionId, now, now],
    );
    t.ctx.db.run(
      `INSERT INTO source_region (id, version_id, page_id, kind, reading_order, bbox_json, text, text_origin, status, created_at, updated_at)
       VALUES ('R1', ?, 'P1', 'paragraph', 0, '{"x":0.1,"y":0.1,"w":0.5,"h":0.1}', 'McBurney point', 'digital', 'extracted', ?, ?)`,
      [s.versionId, now, now],
    );
    const pages = (await api(t).get(`/api/sources/${s.id}/versions/${s.versionId}/pages`)).json();
    expect(pages.pages.map((p: { printed_label: string }) => p.printed_label)).toEqual(['11', '12']);
    expect(pages.pages[1]).toMatchObject({ processing_status: 'failed', error_code: 'OCR_FAILED', error_detail_ar: 'تعذرت قراءة الصفحة' });
    const regions = (await api(t).get('/api/sources/pages/P1/regions')).json() as PageRegionsResponse;
    expect(regions.regions[0]).toMatchObject({ kind: 'paragraph', text: 'McBurney point', bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 } });
    expect((await api(t).get('/api/sources/pages/NOPE/regions')).statusCode).toBe(404);
    // a version id from another source is not served under this source
    const other = await seedSource('flowchart.png');
    expect((await api(t).get(`/api/sources/${s.id}/versions/${other.versionId}/pages`)).statusCode).toBe(404);
  });
});

describe('links between sources (course view)', () => {
  it('links a reference and a question source to a lecture; no self links; removal', async () => {
    const lec = await seedSource('lecture_appendicitis.pdf');
    const ref = (await uploadOk(t, lec.course.id, [{ name: 'reference.docx', data: golden('lecture_notes_shock.docx') }])).results[0]!.source_id!;
    const qs = (await uploadOk(t, lec.course.id, [{ name: 'questions_surgery_course1.pdf', data: golden('questions_surgery_course1.pdf') }])).results[0]!.source_id!;
    const l1 = await api(t).post(`/api/sources/${ref}/links`, { to_source_id: lec.id, relation: 'reference_for' });
    expect(l1.statusCode).toBe(200);
    await api(t).post(`/api/sources/${qs}/links`, { to_source_id: lec.id, relation: 'question_source_for' });
    // idempotent
    expect((await api(t).post(`/api/sources/${ref}/links`, { to_source_id: lec.id, relation: 'reference_for' })).json().link.id).toBe(l1.json().link.id);
    const d = await detail(lec.id);
    expect(d.links.map((l) => [l.relation, l.other_title, l.other_type])).toEqual([
      ['reference_for', 'reference', 'course_reference'],
      ['question_source_for', 'questions surgery course1', 'question_source'],
    ]);
    expect((await api(t).post(`/api/sources/${lec.id}/links`, { to_source_id: lec.id, relation: 'same_topic' })).statusCode).toBe(400);
    expect((await api(t).del(`/api/sources/${lec.id}/links/${l1.json().link.id}`)).statusCode).toBe(200);
    expect((await detail(lec.id)).links).toHaveLength(1);
    // the course view gets every link inside the course subtree in one call
    const courseLinks = (await api(t).get(`/api/library/nodes/${lec.course.id}/links`)).json().links;
    expect(courseLinks.map((l: { relation: string }) => l.relation)).toEqual(['question_source_for']);
    // a trashed linked source disappears from the links list (no link "as if available")
    await api(t).post(`/api/sources/${qs}/trash`);
    expect((await detail(lec.id)).links).toHaveLength(0);
  });
});

describe('upload info', () => {
  it('states the real limits and what can be processed right now', async () => {
    const info = (await api(t).get('/api/sources/upload-info')).json();
    expect(info).toMatchObject({ max_upload_bytes: t.config.limits.maxUploadBytes, max_zip_entries: t.config.limits.maxZipEntries, processing_available: true });
    expect(typeof info.legacy_office).toBe('boolean');
  });
});

describe('source trash / restore / purge', () => {
  it('trash → restore (parent in trash asks for a destination) → purge with token removes its files', async () => {
    const s = await seedSource('scanned_page.png');
    const keep = await seedSource('flowchart.png');
    await api(t).post(`/api/sources/${s.id}/trash`);
    expect((await api(t).post(`/api/sources/${s.id}/trash`)).statusCode).toBe(409);
    expect((await api(t).post(`/api/sources/${s.id}/open`)).statusCode).toBe(409);
    await api(t).post(`/api/library/nodes/${s.course.id}/trash`);
    const r1 = await api(t).post(`/api/sources/${s.id}/restore`, {});
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.details.reason).toBe('parent_in_trash');
    const r2 = await api(t).post(`/api/sources/${s.id}/restore`, { node_id: keep.course.id });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().source.course_node_id).toBe(keep.course.id);
    // purge
    await api(t).post(`/api/sources/${s.id}/trash`);
    const d = await detail(s.id);
    const fileId = d.versions[0]!.file_id!;
    const path = t.ctx.files.path(fileId);
    const impact = (await api(t).get(`/api/sources/${s.id}/impact?mode=purge`)).json() as ImpactReport;
    expect(impact).toMatchObject({ nodes: 0, sources: 1, versions: 1, pages: 1 });
    const res = await api(t).del(`/api/sources/${s.id}?confirm_token=${encodeURIComponent(impact.confirm_token!)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().removed_files).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect((await api(t).get(`/api/sources/${s.id}`)).statusCode).toBe(404);
    expect((await detail(keep.id)).versions[0]!.file_id).toBeTruthy();
    expect(t.ctx.files.verifyBlob((await detail(keep.id)).versions[0]!.file_id!)).toBe(true);
    // a token for a source cannot purge a node and vice versa
    expect((await api(t).del(`/api/library/nodes/${s.course.id}?confirm_token=${encodeURIComponent(impact.confirm_token!)}`)).statusCode).toBe(400);
  });

  it('a source trashed together with its folder is restored through the folder', async () => {
    const s = await seedSource('flowchart.png');
    await api(t).post(`/api/library/nodes/${s.subject.id}/trash`);
    const r = await api(t).post(`/api/sources/${s.id}/restore`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.reason).toBe('trashed_with_parent');
    expect(r.json().error.message).toContain('Surgery');
  });

  it('archive / unarchive a single source', async () => {
    const s = await seedSource('flowchart.png');
    await api(t).post(`/api/sources/${s.id}/archive`);
    expect((await api(t).get('/api/library/tree')).json().sources).toHaveLength(0);
    expect((await api(t).get('/api/library/tree?include=archived')).json().sources).toHaveLength(1);
    await api(t).post(`/api/sources/${s.id}/unarchive`);
    expect((await api(t).get('/api/library/tree')).json().sources).toHaveLength(1);
  });
});
