// PERF (MEDLEVO_PERF=1): dense two-column pages (≈ 1 000+ words each, Arabic + English) and image-only (scanned)
// pages through the REAL upload API and pipeline — time per page and memory for the layout path and the OCR path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LibraryNodeView, UploadResponse } from '@medlevo/shared';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { createProcessingApp } from '../processing/helpers';
import { multipart } from '../sources/helpers';
import { lecturePdf, PERF_ENABLED, scannedPdf } from './fixtures';
import { percentiles, report, withMemory } from './measure';

const DENSE_PAGES = Number(process.env.MEDLEVO_PERF_DENSE_PAGES || 40);
const SCANNED_PAGES = Number(process.env.MEDLEVO_PERF_SCANNED_PAGES || 8);

describe.skipIf(!PERF_ENABLED)('perf: dense two-column pages and scanned pages', () => {
  let t: TestApp;
  let h: AuthHeaders;
  let nodeId: string;
  const pageStart = new Map<string, number>();
  const pageMs = new Map<string, number>();
  let current = '';

  beforeAll(async () => {
    t = await createProcessingApp({
      hooks: {
        beforePage: (i) => void pageStart.set(`${current}:${i}`, performance.now()),
        afterPagePersist: (i) => void pageMs.set(`${current}:${i}`, performance.now() - pageStart.get(`${current}:${i}`)!),
      },
    });
    t.clock.now = () => Date.now();
    h = await t.login();
    const node = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: h, payload: { parent_id: null, kind: 'course', title: 'Perf dense' } });
    nodeId = (node.json() as { node: LibraryNodeView }).node.id;
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  async function run(label: string, name: string, data: Buffer) {
    current = label;
    const body = multipart({ node_id: nodeId, source_type: 'lecture', title: `${label} (TEST FIXTURE)` }, [{ name, data }]);
    const res = await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...h, 'content-type': body.contentType }, payload: body.payload });
    expect(res.statusCode).toBe(200);
    const r = (res.json() as UploadResponse).results[0]!;
    expect(r.status).toBe('accepted');
    const m = await withMemory(() => t.ctx.jobs.drain());
    const db = t.ctx.db;
    const job = db.get<{ status: string; started_at: number; finished_at: number }>(
      `SELECT status, started_at, finished_at FROM processing_job WHERE kind = 'process_source_version' AND input_json LIKE ?`,
      [`%${r.version_id}%`],
    )!;
    const pages = db.all<{ processing_status: string; text_status: string; n: number }>(
      'SELECT processing_status, text_status, COUNT(*) AS n FROM source_page WHERE version_id = ? GROUP BY processing_status, text_status',
      [r.version_id],
    );
    const words = db.get<{ chars: number; regions: number }>(`SELECT SUM(LENGTH(text)) AS chars, COUNT(*) AS regions FROM source_region WHERE version_id = ? AND kind NOT IN ('header','footer')`, [r.version_id])!;
    const per = [...pageMs.entries()].filter(([k]) => k.startsWith(`${label}:`)).map(([, v]) => v);
    return { job_ms: job.finished_at - job.started_at, job_status: job.status, per_page_ms: percentiles(per), memory: m.mem, pages, text_chars: words.chars, regions: words.regions };
  }

  it('measures the layout path (dense two-column) and the OCR path (scanned)', async () => {
    const dense = await lecturePdf({ pages: DENSE_PAGES, allDense: true });
    const denseRes = await run('dense', 'perf-dense.pdf', dense.data);
    expect(denseRes.job_status).toBe('completed');

    const scanned = await scannedPdf(SCANNED_PAGES);
    const scannedRes = await run('scanned', 'perf-scanned.pdf', scanned.data);
    expect(['completed', 'partial']).toContain(scannedRes.job_status);
    expect(scannedRes.pages.some((p) => p.text_status === 'ocr')).toBe(true);

    report('dense-ocr', {
      dense: { scenario: `${DENSE_PAGES} dense two-column pages (8.4 pt, 18 paragraphs/page, Arabic + English)`, avg_chars_per_page: Math.round(denseRes.text_chars / DENSE_PAGES), ...denseRes },
      scanned: { scenario: `${SCANNED_PAGES} image-only pages (Chromium screenshots at 1240×1754, rendered at 200 dpi, tesseract eng+ara)`, ...scannedRes },
    });
  }, 45 * 60_000);
});
