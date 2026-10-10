// PERF (MEDLEVO_PERF=1): one 6000×8000 (48 MP) RGB page photo through the REAL upload API and processing pipeline.
// Above the OCR pixel budget (MAX_OCR_PIXELS) the page is kept as a figure with a specific reason — the question here
// is what that costs in time and memory (own file → own process → the memory high-water mark is this scenario's).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LibraryNodeView, UploadResponse } from '@medlevo/shared';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { createProcessingApp } from '../processing/helpers';
import { multipart } from '../sources/helpers';
import { largeScanPng, PERF_ENABLED } from './fixtures';
import { report, withMemory } from './measure';

const W = Number(process.env.MEDLEVO_PERF_IMAGE_W || 6000);
const H = Number(process.env.MEDLEVO_PERF_IMAGE_H || 8000);

describe.skipIf(!PERF_ENABLED)(`perf: ${W}×${H} image page`, () => {
  let t: TestApp;
  let h: AuthHeaders;
  beforeAll(async () => {
    t = await createProcessingApp();
    t.clock.now = () => Date.now();
    h = await t.login();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it('stores and processes the image without decoding it beyond what is needed', async () => {
    const img = await largeScanPng(W, H);
    const node = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: h, payload: { parent_id: null, kind: 'course', title: 'Perf images' } });
    const nodeId = (node.json() as { node: LibraryNodeView }).node.id;
    const body = multipart({ node_id: nodeId, source_type: 'lecture', title: 'Perf photo (TEST FIXTURE)' }, [{ name: 'perf-photo.png', data: img.data, contentType: 'image/png' }]);
    const upload = await withMemory(async () => t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...h, 'content-type': body.contentType }, payload: body.payload }));
    expect(upload.value.statusCode).toBe(200);
    const r = (upload.value.json() as UploadResponse).results[0]!;
    expect(r.status).toBe('accepted');

    const run = await withMemory(() => t.ctx.jobs.drain(), 5);
    const page = t.ctx.db.get<{ text_status: string; processing_status: string; error_code: string | null; width: number; height: number }>(
      'SELECT text_status, processing_status, error_code, width, height FROM source_page WHERE version_id = ?',
      [r.version_id],
    )!;
    const figure = t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM source_region WHERE version_id = ? AND kind = 'figure'`, [r.version_id])!.n;
    const job = t.ctx.db.get<{ status: string; started_at: number; finished_at: number }>(
      `SELECT status, started_at, finished_at FROM processing_job WHERE kind = 'process_source_version' AND input_json LIKE ?`,
      [`%${r.version_id}%`],
    )!;
    // honest outcome: kept as an image figure with a specific reason, never an "empty page"
    expect(page).toMatchObject({ width: W, height: H });
    if (W * H > 40_000_000) expect(page.error_code).toBe('IMAGE_TOO_LARGE');
    expect(figure).toBeGreaterThan(0);

    report('image-48mp', {
      scenario: `${W}×${H} RGB PNG page photo (${Math.round((W * H) / 1e6)} MP), uploaded as an image source`,
      file_mb: Math.round((img.data.length / 1024 / 1024) * 100) / 100,
      upload_ms: Math.round(upload.ms),
      upload_memory: upload.mem,
      processing_job_ms: job.finished_at - job.started_at,
      drain_ms: Math.round(run.ms),
      processing_memory: run.mem,
      result: { ...page, figure_regions: figure, job_status: job.status },
    });
  }, 20 * 60_000);
});
