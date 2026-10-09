// Regression tests for defects found in the independent review of track A1 (library & sources).
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImpactReport, SourceDetail, SourcePagesResponse } from '@medlevo/shared';
import { AppError } from '../../src/lib/errors';
import { tiffSize } from '../../src/modules/sources/sniff';
import { registerReplacement, registerUpload } from '../../src/modules/sources/upload';
import { api, createNode, GOLDEN, golden, type Harness, makeHarness, uploadOk } from './helpers';

let t: Harness | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const n = (h: Harness, sql: string, p: unknown[] = []) => h.ctx.db.get<{ n: number }>(sql, p)!.n;

async function purgeNode(h: Harness, nodeId: string) {
  await api(h).post(`/api/library/nodes/${nodeId}/trash`);
  const impact = (await api(h).get(`/api/library/nodes/${nodeId}/impact?mode=purge`)).json() as ImpactReport;
  const res = await api(h).del(`/api/library/nodes/${nodeId}?confirm_token=${encodeURIComponent(impact.confirm_token!)}`);
  return { impact, res };
}

describe('purge (review fixes)', () => {
  it('a question version OUTSIDE the purge set derived from a purged one no longer makes the purge fail; it is kept, unlinked and flagged', async () => {
    t = await makeHarness();
    const root = await createNode(t, { title: 'Exams' });
    const up = await uploadOk(t, root.id, [{ name: 'questions_surgery_course1.pdf', data: golden('questions_surgery_course1.pdf') }]);
    const sid = up.results[0]!.source_id!;
    const vid = up.results[0]!.version_id!;
    const db = t.ctx.db;
    const now = t.clock.now();
    db.run(`INSERT INTO question (id, origin_type, created_at, updated_at) VALUES ('Q1', 'source', ?, ?)`, [now, now]);
    db.run(
      `INSERT INTO question_version (id, question_id, version_no, kind, qtype, stem_json, extraction_status, answer_status, created_by, created_at)
       VALUES ('QV1', 'Q1', 1, 'raw_extraction', 'sba', '{}', 'extracted', 'missing_key', 'extraction', ?)`,
      [now],
    );
    db.run(
      `INSERT INTO question_occurrence (id, question_id, question_version_id, source_id, source_version_id, printed_number, page_ids_json, region_ids_json, created_at)
       VALUES ('QO1', 'Q1', 'QV1', ?, ?, '1', '[]', '[]', ?)`,
      [sid, vid, now],
    );
    // a generated variant (another question) derived from the source question
    db.run(`INSERT INTO question (id, origin_type, created_at, updated_at) VALUES ('Q2', 'generated', ?, ?)`, [now, now]);
    db.run(
      `INSERT INTO question_version (id, question_id, version_no, kind, qtype, stem_json, extraction_status, answer_status, created_by, derived_from_version_id, created_at)
       VALUES ('QV2', 'Q2', 1, 'generated', 'sba', '{}', 'extracted', 'missing_key', 'generation', 'QV1', ?)`,
      [now],
    );
    const { impact, res } = await purgeNode(t, root.id);
    expect(impact.questions).toBe(1);
    expect(impact.lines_ar.join('\n')).toMatch(/خارج هذا العنصر/);
    expect(res.statusCode, res.body).toBe(200); // was a 500 (FK violation) before the fix
    expect(n(t, `SELECT COUNT(*) AS n FROM question WHERE id = 'Q1'`)).toBe(0);
    expect(db.get<{ d: string | null }>(`SELECT derived_from_version_id AS d FROM question_version WHERE id = 'QV2'`)).toEqual({ d: null });
    const alert = db.get<{ affected_json: string }>(`SELECT affected_json FROM content_alert WHERE kind = 'source_deleted'`)!;
    expect(JSON.parse(alert.affected_json)).toEqual(expect.arrayContaining([{ type: 'question_version', id: 'QV2', impact: 'needs_review' }]));
  });

  it('processing jobs of purged versions are cancelled (not left queued to fail later); other jobs are untouched', async () => {
    t = await makeHarness();
    const doomed = await createNode(t, { title: 'Doomed' });
    const keep = await createNode(t, { title: 'Keep' });
    const a = (await uploadOk(t, doomed.id, [{ name: 'lecture_cholecystitis.pdf', data: golden('lecture_cholecystitis.pdf') }])).results[0]!;
    const b = (await uploadOk(t, keep.id, [{ name: 'lecture_appendicitis.pdf', data: golden('lecture_appendicitis.pdf') }])).results[0]!;
    const jobOf = (versionId: string) =>
      t!.ctx.db.get<{ status: string }>(`SELECT status FROM processing_job WHERE json_extract(input_json, '$.version_id') = ?`, [versionId])!.status;
    expect([jobOf(a.version_id!), jobOf(b.version_id!)]).toEqual(['queued', 'queued']);
    const { res } = await purgeNode(t, doomed.id);
    expect(res.statusCode).toBe(200);
    expect(jobOf(a.version_id!)).toBe('cancelled');
    expect(jobOf(b.version_id!)).toBe('queued');
  });

  it('study conversations about the purged sources are counted and listed in the impact before they are deleted', async () => {
    t = await makeHarness();
    const root = await createNode(t, { title: 'R' });
    const up = (await uploadOk(t, root.id, [{ name: 'flowchart.png', data: golden('flowchart.png') }])).results[0]!;
    const db = t.ctx.db;
    const now = t.clock.now();
    db.run(`INSERT INTO contextual_thread (id, source_id, version_id, scope_json, created_at, updated_at) VALUES ('TH1', ?, ?, '{}', ?, ?)`, [up.source_id, up.version_id, now, now]);
    db.run(`INSERT INTO message (id, thread_id, role, content_json, created_at) VALUES ('M1', 'TH1', 'owner', '{}', ?)`, [now]);
    const trashImpact = (await api(t).get(`/api/sources/${up.source_id}/impact?mode=trash`)).json() as ImpactReport;
    expect(trashImpact.lines_ar.join('\n')).toMatch(/تبقى محفوظة/);
    await api(t).post(`/api/sources/${up.source_id}/trash`);
    const impact = (await api(t).get(`/api/sources/${up.source_id}/impact?mode=purge`)).json() as ImpactReport;
    expect(impact.lines_ar.join('\n')).toMatch(/محادثات الدراسة المرتبطة بهذه المصادر ورسائلها: محادثة واحدة/);
    const res = await api(t).del(`/api/sources/${up.source_id}?confirm_token=${encodeURIComponent(impact.confirm_token!)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().removed.threads).toBe(1);
    expect(n(t, `SELECT COUNT(*) AS n FROM message WHERE id = 'M1'`)).toBe(0);
  });
});

describe('uploads (review fixes)', () => {
  it('an image ZIP whose images exceed the uncompressed limit is rejected WHOLE — never stored truncated', async () => {
    t = await makeHarness({ env: { MEDLEVO_MAX_ZIP_UNCOMPRESSED_MB: '0.1' } }); // ≈ 105 KB
    const node = await createNode(t, { title: 'Slides' });
    const z = new JSZip();
    z.file('slides/01.png', golden('flowchart.png')); // ~25 KB
    z.file('slides/02.png', golden('scanned_page.png')); // ~110 KB → crosses the limit
    z.file('slides/03.png', golden('question_photo_circled.png'));
    const data = await z.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    const r = (await uploadOk(t, node.id, [{ name: 'slides.zip', data }])).results[0]!;
    expect(r.status).toBe('rejected');
    expect(r.detected_format).toBe('zip');
    expect(r.reason_ar).toMatch(/يتجاوز الحد المسموح/);
    expect(r.reason_ar).toMatch(/لم يُحفظ منه شيء/);
    expect(r.rejected_entries!.map((e) => e.name)).toEqual(expect.arrayContaining(['slides/02.png', 'slides/03.png']));
    expect(n(t, 'SELECT COUNT(*) AS n FROM source')).toBe(0);
    expect(n(t, 'SELECT COUNT(*) AS n FROM stored_file')).toBe(0);
    expect(readdirSync(t.config.tmpDir).filter((x) => x.startsWith('zip-'))).toEqual([]);
  });

  it('a registration that fails after the files were stored (folder trashed during the upload) leaves no orphaned blob and says why', async () => {
    t = await makeHarness();
    const live = await createNode(t, { title: 'Live' });
    const gone = await createNode(t, { title: 'Gone' });
    const existing = (await uploadOk(t, live.id, [{ name: 'flowchart.png', data: golden('flowchart.png') }])).results[0]!;
    const sharedBlob = t.ctx.db.get<{ file_id: string }>('SELECT file_id FROM source_version WHERE id = ?', [existing.version_id])!.file_id;
    await api(t).post(`/api/library/nodes/${gone.id}/trash`);
    const blobsBefore = n(t, 'SELECT COUNT(*) AS n FROM stored_file');
    const incoming = (name: string) => {
      const tmpPath = join(t!.config.tmpDir, `review-${name}`);
      copyFileSync(join(GOLDEN, name), tmpPath);
      return { tmpPath, fileName: name, size: golden(name).length, truncated: false };
    };
    for (const name of ['scanned_page.png', 'flowchart.png']) {
      let err: unknown = null;
      try {
        await registerUpload(t.ctx, incoming(name), { nodeId: gone.id, onDuplicate: 'create' });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(409);
      expect((err as AppError).messageAr).toMatch(/سلة المحذوفات/);
    }
    // the new blob is gone again; the deduplicated blob of the existing source stays
    expect(n(t, 'SELECT COUNT(*) AS n FROM stored_file')).toBe(blobsBefore);
    expect(t.ctx.files.verifyBlob(sharedBlob)).toBe(true);
    expect(n(t, 'SELECT COUNT(*) AS n FROM source')).toBe(1);

    // replacement of a source that was trashed while its new version was uploading
    await api(t).post(`/api/sources/${existing.source_id}/trash`);
    let err: unknown = null;
    try {
      await registerReplacement(t.ctx, existing.source_id!, incoming('scanned_page.png'), null);
    } catch (e) {
      err = e;
    }
    expect((err as AppError).messageAr).toMatch(/سلة المحذوفات/);
    expect(n(t, 'SELECT COUNT(*) AS n FROM source_version WHERE source_id = ?', [existing.source_id])).toBe(1);
    expect(n(t, 'SELECT COUNT(*) AS n FROM stored_file')).toBe(blobsBefore);
  });

  it('TIFF pixel size is read from the first IFD even when it lies after the pixel data (beyond the sniffed head)', async () => {
    // little-endian TIFF: header → 300 KB of pixel bytes → IFD (width 640 LONG, height 480 SHORT)
    const pixels = Buffer.alloc(300 * 1024, 0xff);
    const ifdOffset = 8 + pixels.length;
    const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0]);
    header.writeUInt32LE(ifdOffset, 4);
    const ifd = Buffer.alloc(2 + 2 * 12 + 4);
    ifd.writeUInt16LE(2, 0);
    ifd.writeUInt16LE(256, 2); // ImageWidth
    ifd.writeUInt16LE(4, 4); // LONG
    ifd.writeUInt32LE(1, 6);
    ifd.writeUInt32LE(640, 10);
    ifd.writeUInt16LE(257, 14); // ImageLength
    ifd.writeUInt16LE(3, 16); // SHORT
    ifd.writeUInt32LE(1, 18);
    ifd.writeUInt16LE(480, 22);
    const tiff = Buffer.concat([header, pixels, ifd]);
    t = await makeHarness();
    const node = await createNode(t, { title: 'Scans' });
    const r = (await uploadOk(t, node.id, [{ name: 'scan.tif', data: tiff }])).results[0]!;
    expect(r).toMatchObject({ status: 'accepted', detected_format: 'image' });
    const d = (await api(t).get(`/api/sources/${r.source_id}`)).json() as SourceDetail;
    const pages = (await api(t).get(`/api/sources/${d.id}/versions/${d.versions[0]!.id}/pages`)).json() as SourcePagesResponse;
    expect(pages.pages[0]).toMatchObject({ width: 640, height: 480, unit: 'px' });

    // big-endian, SHORT/SHORT; garbage → null
    const mm = Buffer.alloc(8 + 2 + 24 + 4);
    mm.write('MM', 0, 'latin1');
    mm.writeUInt16BE(42, 2);
    mm.writeUInt32BE(8, 4);
    mm.writeUInt16BE(2, 8);
    mm.writeUInt16BE(256, 10);
    mm.writeUInt16BE(3, 12);
    mm.writeUInt32BE(1, 14);
    mm.writeUInt16BE(1200, 18);
    mm.writeUInt16BE(257, 22);
    mm.writeUInt16BE(3, 24);
    mm.writeUInt32BE(1, 26);
    mm.writeUInt16BE(900, 30);
    const reader = (b: Buffer) => async (o: number, l: number) => b.subarray(o, o + l);
    expect(await tiffSize(reader(mm))).toEqual({ width: 1200, height: 900 });
    expect(await tiffSize(reader(Buffer.from('II*\0\xff\xff\xff\x7f', 'latin1')))).toBeNull();
    expect(existsSync(t.config.tmpDir)).toBe(true);
  });
});
