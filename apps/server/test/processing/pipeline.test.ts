// Pipeline behavior: checkpoint resume without duplicates (AC-25), partial failure (AC-03), idempotent
// page re-processing, honest degradation when converters/OCR are missing (§61), legacy conversion,
// failure/abstention paths, and normalized + scope-filtered search.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROCESS_JOB_KIND, type ProcessingToolsStatusResponse } from '@medlevo/shared';
import { JobError } from '../../src/lib/errors';
import { newId } from '../../src/lib/ids';
import { searchChunks } from '../../src/modules/processing/search';
import { findExecutable } from '../../src/modules/processing/tools';
import type { TestApp } from '../helpers/app';
import { addSource, createProcessingApp, FIXTURES, pages, processVersion, regions } from './helpers';

const SOFFICE = findExecutable('soffice') ?? findExecutable('libreoffice');
const HAS_PDFTOPPM = findExecutable('pdftoppm') !== null;

function regionCounts(t: TestApp, versionId: string): number[] {
  return pages(t, versionId).map((p) => regions(t, versionId, p.page_index).length);
}

function chunkRows(t: TestApp, versionId: string) {
  return t.ctx.db.all<{ id: string; kind: string; text: string; region_ids_json: string; page_ids_json: string }>(
    'SELECT id, kind, text, region_ids_json, page_ids_json FROM document_chunk WHERE version_id = ? ORDER BY id',
    [versionId],
  );
}

describe('checkpoint resume after a crash (AC-25)', () => {
  const calls: Array<[number, number]> = [];
  let t: TestApp;
  beforeAll(async () => {
    t = await createProcessingApp({
      hooks: {
        beforePage: (i, attempt) => {
          calls.push([i, attempt]);
        },
        afterPagePersist: (i, attempt) => {
          // the page's rows are already written, but its checkpoint is not: simulate the process dying here
          if (i === 2 && attempt === 1) throw new JobError('TEST_CRASH', 'محاكاة انقطاع أثناء المعالجة.', { retryable: true });
        },
      },
    });
  }, 60_000);
  afterAll(async () => t?.close());

  it('resumes from the checkpoint and never duplicates regions, review items or chunks', async () => {
    const crashed = await addSource(t, 'lecture_appendicitis.pdf', 'pdf');
    const job = await processVersion(t, crashed.versionId);
    expect(job.attempts).toBe(2);
    expect(job.status).toBe('completed');
    // pages 0 and 1 ran once (checkpointed); page 2 ran again after the crash; page 3 once
    expect(calls.filter(([i]) => i === 0)).toEqual([[0, 1]]);
    expect(calls.filter(([i]) => i === 1)).toEqual([[1, 1]]);
    expect(calls.filter(([i]) => i === 2)).toEqual([
      [2, 1],
      [2, 2],
    ]);
    expect(calls.filter(([i]) => i === 3)).toEqual([[3, 2]]);

    // a clean run of the same file in another version gives the same structure
    const clean = await addSource(t, 'lecture_appendicitis.pdf', 'pdf');
    await processVersion(t, clean.versionId);
    expect(regionCounts(t, crashed.versionId)).toEqual(regionCounts(t, clean.versionId));
    const texts = (vid: string) => regions(t, vid).map((r) => `${r.page_index}|${r.kind}|${r.reading_order}|${r.text}`);
    expect(texts(crashed.versionId)).toEqual(texts(clean.versionId));
    expect(new Set(texts(crashed.versionId)).size).toBe(texts(crashed.versionId).length);
    expect(chunkRows(t, crashed.versionId).map((c) => c.text)).toEqual(chunkRows(t, clean.versionId).map((c) => c.text));
    const items = (vid: string) =>
      t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_queue_item WHERE json_extract(details_json, '$.version_id') = ?`, [vid])!.n;
    expect(items(crashed.versionId)).toBe(items(clean.versionId));
    const assets = (vid: string) => t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM image_asset WHERE version_id = ?', [vid])!.n;
    expect(assets(crashed.versionId)).toBe(assets(clean.versionId));
    expect(pages(t, crashed.versionId)).toHaveLength(4); // pages upserted, never duplicated
  }, 120_000);
});

describe('one failing page never fails the version (AC-03) and can be re-processed alone', () => {
  let failOn: number | null = 1;
  let t: TestApp;
  beforeAll(async () => {
    t = await createProcessingApp({
      hooks: {
        beforePage: (i) => {
          if (i === failOn) throw new Error('simulated parser crash on this page');
        },
      },
    });
  }, 60_000);
  afterAll(async () => t?.close());

  it('marks the version partial, lists the failed page with an Arabic reason, keeps the others readable', async () => {
    const { versionId, sourceId } = await addSource(t, 'lecture_appendicitis.pdf', 'pdf');
    const job = await processVersion(t, versionId);
    expect(job.status).toBe('partial');
    const ps = pages(t, versionId);
    expect(ps[1]!.processing_status).toBe('failed');
    expect(ps[1]!.error_code).toBe('PAGE_PROCESSING_FAILED');
    expect(ps[1]!.error_detail).toMatch(/بقية الصفحات لم تتأثر/);
    expect(regions(t, versionId, 1)).toHaveLength(0);
    for (const i of [0, 2, 3]) {
      expect(['ready', 'needs_review']).toContain(ps[i]!.processing_status);
      expect(regions(t, versionId, i).length).toBeGreaterThan(0);
    }
    const v = t.ctx.db.get<{ processing_status: string; processing_summary_json: string }>(
      'SELECT processing_status, processing_summary_json FROM source_version WHERE id = ?',
      [versionId],
    )!;
    expect(v.processing_status).toBe('partial');
    const summary = JSON.parse(v.processing_summary_json);
    expect(summary.coverage_complete).toBe(false);
    expect(summary.pages_failed).toBe(1);
    expect(summary.failed_pages).toEqual([
      expect.objectContaining({ page_index: 1, printed_label: '12', error_code: 'PAGE_PROCESSING_FAILED' }),
    ]);
    expect(summary.stage_label_ar).toContain('جزئيًا');
    expect(t.ctx.db.get<{ s: string }>('SELECT processing_status AS s FROM source WHERE id = ?', [sourceId])!.s).toBe('partial');

    // the readable pages are indexed already
    expect(chunkRows(t, versionId).length).toBeGreaterThan(0);

    // re-process ONLY page 1: other pages keep their region ids; the version becomes complete
    failOn = null;
    const keep = (i: number) => regions(t, versionId, i).map((r) => r.id);
    const before = { 0: keep(0), 2: keep(2), 3: keep(3) };
    const chunksBefore = chunkRows(t, versionId);
    const again = await processVersion(t, versionId, { page_indexes: [1], reason: 'reprocess' });
    expect(again.status).toBe('completed');
    expect(keep(0)).toEqual(before[0]);
    expect(keep(2)).toEqual(before[2]);
    expect(keep(3)).toEqual(before[3]);
    expect(regions(t, versionId, 1).length).toBeGreaterThan(0);
    expect(pages(t, versionId)[1]!.processing_status).toBe('ready');
    const after = t.ctx.db.get<{ s: string }>('SELECT processing_status AS s FROM source_version WHERE id = ?', [versionId])!.s;
    expect(after).toBe('needs_review'); // page 0 still has the flagged Arabic region
    // unchanged chunks kept their ids (diff re-index); page-1 chunks were added
    const chunksAfter = chunkRows(t, versionId);
    const keptIds = chunksBefore.filter((c) => chunksAfter.some((a) => a.id === c.id));
    expect(keptIds.length).toBeGreaterThan(0);
    expect(chunksAfter.length).toBeGreaterThan(chunksBefore.length);
    expect(new Set(chunksAfter.map((c) => c.text)).size).toBe(chunksAfter.length);

    // re-processing the same page again is idempotent
    const counts = regionCounts(t, versionId);
    const chunkCount = chunksAfter.length;
    await processVersion(t, versionId, { page_indexes: [1], reason: 'reprocess' });
    expect(regionCounts(t, versionId)).toEqual(counts);
    expect(chunkRows(t, versionId)).toHaveLength(chunkCount);
    expect(chunkRows(t, versionId).map((c) => c.text).sort()).toEqual(chunksAfter.map((c) => c.text).sort());
    // chunks that do not touch page 1 keep their ids; page-1 chunks point at the new region ids
    const page1 = pages(t, versionId)[1]!.id;
    const untouched = (rows: ReturnType<typeof chunkRows>) => rows.filter((c) => !c.page_ids_json.includes(page1)).map((c) => c.id);
    expect(untouched(chunkRows(t, versionId)).sort()).toEqual(untouched(chunksAfter).sort());
  }, 120_000);

  it('refuses to silently drop regions that evidence already cites; the page keeps its previous content', async () => {
    failOn = null;
    const { versionId, sourceId } = await addSource(t, 'lecture_cholecystitis.pdf', 'pdf');
    await processVersion(t, versionId);
    const region = regions(t, versionId, 0).find((r) => r.kind === 'paragraph')!;
    t.ctx.db.run(
      `INSERT INTO evidence (id, version_id, source_id, page_id, region_id, quote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId(), versionId, sourceId, region.page_id, region.id, region.text, t.clock.now()],
    );
    const before = regions(t, versionId, 0).map((r) => r.id);
    const job = await processVersion(t, versionId, { page_indexes: [0], reason: 'reprocess' });
    expect(job.status).toBe('partial');
    const p = pages(t, versionId)[0]!;
    expect(p.processing_status).toBe('failed');
    expect(p.error_code).toBe('REGIONS_IN_USE');
    expect(p.error_detail).toContain('نسخة مصححة');
    expect(regions(t, versionId, 0).map((r) => r.id)).toEqual(before);
  }, 60_000);
});

describe('honest degradation when converters / OCR are missing (§61)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createProcessingApp({ tools: { pdftoppm: null, soffice: null }, ocr: false });
  }, 60_000);
  afterAll(async () => t?.close());

  it('capabilities and GET /api/processing/status explain what is missing', async () => {
    const caps = t.ctx.capabilities.snapshot().features;
    expect(caps['processing.pdf'].state).toBe('available');
    expect(caps['processing.ocr']).toMatchObject({ state: 'requires_configuration' });
    expect(caps['processing.ocr'].reason_ar).toContain('OCR');
    expect(caps['processing.legacy_office'].state).toBe('requires_configuration');
    expect(caps['processing.images'].state).toBe('requires_configuration');
    expect(caps['processing.vision'].state).toBe('requires_configuration'); // no AI provider and not built
    const headers = await t.login();
    const res = await t.app.inject({ method: 'GET', url: '/api/processing/status', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ProcessingToolsStatusResponse;
    expect(body.tools.pdftoppm.available).toBe(false);
    expect(body.tools.pdftoppm.reason_ar).toContain('pdftoppm');
    expect(body.tools.soffice.available).toBe(false);
    expect(body.tools.tesseract.available).toBe(false);
    expect(body.pipeline_version).toBe('process-v1');
    expect(body.index_version).toBe('chunk-v1');
    expect(body.features.find((f) => f.key === 'processing.ocr')?.state).toBe('requires_configuration');
    const anon = await t.app.inject({ method: 'GET', url: '/api/processing/status' });
    expect(anon.statusCode).toBe(401);
  });

  it('a scanned page is marked "needs OCR" with a reason — never treated as empty (AC-02)', async () => {
    const { versionId } = await addSource(t, 'mixed_scanned_lecture.pdf', 'pdf');
    const job = await processVersion(t, versionId);
    expect(job.status).toBe('completed');
    const p = pages(t, versionId)[1]!;
    expect(p.text_status).toBe('needs_ocr');
    expect(p.processing_status).toBe('needs_review');
    expect(p.error_code).toBe('OCR_UNAVAILABLE');
    expect(p.error_detail).toContain('لم تُعامل الصفحة كصفحة فارغة');
    const item = t.ctx.db.get<{ kind: string }>('SELECT kind FROM review_queue_item WHERE entity_id = ?', [p.id]);
    expect(item?.kind).toBe('unreadable_page');
    const v = t.ctx.db.get<{ s: string; j: string }>('SELECT processing_status AS s, processing_summary_json AS j FROM source_version WHERE id = ?', [versionId])!;
    expect(v.s).toBe('needs_review');
    expect(JSON.parse(v.j).failed_pages).toEqual([expect.objectContaining({ page_index: 1, error_code: 'OCR_UNAVAILABLE' })]);
    // review fix: the summary does not call an unread page merely "needs review"
    expect(JSON.parse(v.j).stage_label_ar).toContain('منها 1 لم يُقرأ نصها');
  });

  it('an image without OCR keeps the image as a figure and says why its text was not read', async () => {
    const { versionId } = await addSource(t, 'scanned_page.png', 'image');
    await processVersion(t, versionId);
    const p = pages(t, versionId)[0]!;
    expect(p.text_status).toBe('needs_ocr');
    const rs = regions(t, versionId);
    expect(rs.map((r) => r.kind)).toEqual(['figure']);
    const asset = t.ctx.db.get<{ file_id: string }>('SELECT file_id FROM image_asset WHERE region_id = ?', [rs[0]!.id]);
    expect(asset?.file_id).toBe(p.render_file_id);
  });

  it('a legacy .doc cannot be converted without LibreOffice → the version fails with a specific reason', async () => {
    const { versionId } = await addSource(t, 'lecture_notes_shock.docx', 'pdf', { legacy: true, fileName: 'notes.doc' });
    const job = await processVersion(t, versionId);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('CONVERTER_MISSING');
    const v = t.ctx.db.get<{ s: string; j: string }>('SELECT processing_status AS s, processing_summary_json AS j FROM source_version WHERE id = ?', [versionId])!;
    expect(v.s).toBe('failed');
    expect(JSON.parse(v.j).stage_label_ar).toContain('LibreOffice');
  });
});

describe('failure and abstention paths', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createProcessingApp();
  }, 60_000);
  afterAll(async () => t?.close());

  it('an invalid PDF fails the version with an Arabic reason (not retried)', async () => {
    const { versionId } = await addSource(t, 'broken.pdf', 'pdf', { data: Buffer.from('%PDF-1.4 this is not really a pdf'), fileName: 'broken.pdf' });
    const job = await processVersion(t, versionId);
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(1);
    expect(job.error?.code).toBe('PDF_INVALID');
    expect(job.error?.message).toContain('PDF');
    const v = t.ctx.db.get<{ s: string; j: string }>('SELECT processing_status AS s, processing_summary_json AS j FROM source_version WHERE id = ?', [versionId])!;
    expect(v.s).toBe('failed');
    expect(JSON.parse(v.j).stage_label_ar).toBe(job.error?.message);
  });

  it('a missing version fails fast', async () => {
    const job = t.ctx.jobs.enqueue(PROCESS_JOB_KIND, { version_id: newId() });
    await t.ctx.jobs.drain();
    const done = t.ctx.jobs.get(job.id)!;
    expect(done.status).toBe('failed');
    expect(done.error?.code).toBe('VERSION_NOT_FOUND');
  });

  it('rejects malformed job input', () => {
    expect(() => t.ctx.jobs.enqueue(PROCESS_JOB_KIND, { version_id: 'x', page_indexes: [-1] })).toThrow();
  });

  it("never overrides the owner's lecture kind", async () => {
    const { versionId, sourceId } = await addSource(t, 'lecture_cholecystitis.pdf', 'pdf');
    t.ctx.db.run(`UPDATE source SET lecture_kind = 'practical', lecture_kind_origin = 'owner' WHERE id = ?`, [sourceId]);
    await processVersion(t, versionId);
    expect(t.ctx.db.get('SELECT lecture_kind, lecture_kind_origin FROM source WHERE id = ?', [sourceId])).toEqual({
      lecture_kind: 'practical',
      lecture_kind_origin: 'owner',
    });
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_queue_item WHERE kind = 'classification_suggestion' AND entity_id = ?`, [sourceId])!.n).toBe(0);
  });

  it('reports real page progress while running', async () => {
    const { versionId } = await addSource(t, 'lecture_cholecystitis.pdf', 'pdf');
    const job = await processVersion(t, versionId);
    expect(job.progress).toMatchObject({ stage: 'validate' });
    const out = job.output as { summary: { pages_total: number }; pages_processed: number[] };
    expect(out.pages_processed).toEqual([0, 1]);
    expect(out.summary.pages_total).toBe(2);
  });
});

describe('normalized, scope-filtered keyword search over chunks', () => {
  let t: TestApp;
  let appendicitis: string;
  let cholecystitis: string;
  beforeAll(async () => {
    t = await createProcessingApp();
    appendicitis = (await addSource(t, 'lecture_appendicitis.pdf', 'pdf')).versionId;
    cholecystitis = (await addSource(t, 'lecture_cholecystitis.pdf', 'pdf')).versionId;
    await processVersion(t, appendicitis);
    await processVersion(t, cholecystitis);
  }, 120_000);
  afterAll(async () => t?.close());

  it('«الالم» (no hamza) finds the chunk that contains «الألم»; harakat and ta-marbuta do not matter', () => {
    const hits = searchChunks(t.ctx.db, { versionIds: [appendicitis] }, 'الالم');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain('الألم');
    expect(searchChunks(t.ctx.db, { versionIds: [appendicitis] }, 'الحُفْرَة الحرقفيه').length).toBeGreaterThan(0);
    // stored text is never normalized
    expect(hits[0]!.text).not.toContain('الالم');
  });

  it('the version filter is applied in SQL before ranking: a lecture-only scope never sees other versions', () => {
    // «ultrasound» appears in both lectures
    const both = searchChunks(t.ctx.db, { versionIds: [appendicitis, cholecystitis] }, 'ultrasound');
    expect(new Set(both.map((h) => h.version_id))).toEqual(new Set([appendicitis, cholecystitis]));
    const onlyChole = searchChunks(t.ctx.db, { versionIds: [cholecystitis] }, 'ultrasound', { limit: 1 });
    expect(onlyChole).toHaveLength(1);
    expect(onlyChole[0]!.version_id).toBe(cholecystitis);
    // a term only in the out-of-scope lecture → no results (abstain), not a fallback to other sources
    expect(searchChunks(t.ctx.db, { versionIds: [cholecystitis] }, 'McBurney')).toEqual([]);
    expect(searchChunks(t.ctx.db, { versionIds: [] }, 'ultrasound')).toEqual([]);
  });

  it('headers/footers are not searchable chunk text; FTS stays consistent after re-indexing', async () => {
    expect(searchChunks(t.ctx.db, { versionIds: [appendicitis] }, 'Lecture 3 TEST FIXTURE Surgery Course')).toEqual([]);
    await processVersion(t, appendicitis, { page_indexes: [0], reason: 'reprocess' });
    t.ctx.db.run(`INSERT INTO chunk_fts(chunk_fts) VALUES ('integrity-check')`);
    expect(searchChunks(t.ctx.db, { versionIds: [appendicitis] }, 'periumbilical')).toHaveLength(1);
  });
});

describe.skipIf(!SOFFICE || !HAS_PDFTOPPM)('legacy Word (.doc) conversion with LibreOffice', () => {
  let t: TestApp;
  let dir: string;
  beforeAll(async () => {
    t = await createProcessingApp();
    dir = mkdtempSync(join(tmpdir(), 'medlevo-doc-'));
  }, 60_000);
  afterAll(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('converts .doc → PDF in an isolated profile, stores it, then processes it as PDF', async () => {
    // build a real legacy .doc from the DOCX fixture (test setup only)
    execFileSync(
      SOFFICE!,
      [`-env:UserInstallation=file://${join(dir, 'profile')}`, '--headless', '--norestore', '--convert-to', 'doc', '--outdir', dir, join(FIXTURES, 'lecture_notes_shock.docx')],
      { stdio: 'ignore', timeout: 120_000, env: { PATH: process.env.PATH ?? '', HOME: dir } },
    );
    const doc = readFileSync(join(dir, 'lecture_notes_shock.doc'));
    expect(doc.subarray(0, 4).toString('hex')).toBe('d0cf11e0'); // OLE2
    const { versionId } = await addSource(t, 'notes.doc', 'pdf', { legacy: true, data: doc, fileName: 'notes.doc' });
    const job = await processVersion(t, versionId);
    expect(job.status).toBe('completed');
    const v = t.ctx.db.get<{ file_id: string; display_file_id: string; original_file_id: string; page_count: number }>(
      'SELECT file_id, display_file_id, original_file_id, page_count FROM source_version WHERE id = ?',
      [versionId],
    )!;
    expect(v.file_id).toBeTruthy();
    expect(v.display_file_id).toBe(v.file_id);
    expect(v.file_id).not.toBe(v.original_file_id); // the original stays untouched
    expect(t.ctx.files.stat(v.file_id)?.mime).toBe('application/pdf');
    expect(v.page_count).toBeGreaterThan(0);
    const text = regions(t, versionId).map((r) => r.text ?? '').join('\n');
    expect(text).toContain('Shock is classified as hypovolaemic');
    expect(text).toContain('الصدمة إلى نقص الحجم');
    // the converter's font emits the damma in the wrong place: flagged for review, not stored silently
    const arabic = regions(t, versionId).find((r) => r.text?.includes('الصدمة إلى نقص الحجم'))!;
    if (!arabic.text!.includes('تُصنف')) expect(arabic.status).toBe('needs_review');
  }, 180_000);
});
