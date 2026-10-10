// PERF (MEDLEVO_PERF=1): a 300-page digital lecture through the REAL upload API and processing pipeline — time per
// page by page type, total, memory — then keyword search (FTS) latency over its chunks, scoped and universal.
// One heavy scenario per file: vitest runs each file in its own process, so the memory high-water mark is this file's.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LibraryNodeView, UploadResponse } from '@medlevo/shared';
import { searchChunks } from '../../src/modules/processing/search';
import type { TestApp, AuthHeaders } from '../helpers/app';
import { createProcessingApp } from '../processing/helpers';
import { multipart } from '../sources/helpers';
import { figureSlot, lecturePdf, PERF_ENABLED, tableSlot } from './fixtures';
import { latency, percentiles, report, withMemory } from './measure';

const PAGES = Number(process.env.MEDLEVO_PERF_PAGES || 300);
const LAYOUT = { pages: PAGES, twoColumnEvery: 5, tableEvery: 10, figureEvery: 25 } as const;

function pageType(i: number): 'two_column' | 'table' | 'figure' | 'text' {
  if (i % LAYOUT.twoColumnEvery === LAYOUT.twoColumnEvery - 1) return 'two_column';
  if (i % LAYOUT.figureEvery === figureSlot(LAYOUT.figureEvery)) return 'figure';
  if (i % LAYOUT.tableEvery === tableSlot(LAYOUT.tableEvery)) return 'table';
  return 'text';
}

describe.skipIf(!PERF_ENABLED)(`perf: ${PAGES}-page lecture`, () => {
  let t: TestApp;
  let h: AuthHeaders;
  const pageStart = new Map<number, number>();
  const pageMs = new Map<number, number>();

  beforeAll(async () => {
    t = await createProcessingApp({
      hooks: {
        beforePage: (i) => void pageStart.set(i, performance.now()),
        afterPagePersist: (i) => void pageMs.set(i, performance.now() - (pageStart.get(i) ?? performance.now())),
      },
    });
    // real wall-clock timestamps in job rows (started_at / finished_at) instead of the frozen test clock
    t.clock.now = () => Date.now();
    h = await t.login();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it('processes, indexes and searches the lecture', async () => {
    const pdf = await lecturePdf(LAYOUT);
    const node = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: h, payload: { parent_id: null, kind: 'course', title: 'Perf course' } });
    const nodeId = (node.json() as { node: LibraryNodeView }).node.id;

    const body = multipart({ node_id: nodeId, source_type: 'lecture', title: 'Perf lecture (TEST FIXTURE)' }, [{ name: 'perf-lecture.pdf', data: pdf.data }]);
    const up0 = performance.now();
    const res = await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...h, 'content-type': body.contentType }, payload: body.payload });
    const uploadMs = performance.now() - up0;
    expect(res.statusCode).toBe(200);
    const accepted = (res.json() as UploadResponse).results[0]!;
    expect(accepted.status).toBe('accepted');
    const versionId = accepted.version_id!;

    const run = await withMemory(() => t.ctx.jobs.drain());
    const job = t.ctx.db.get<{ id: string; status: string; started_at: number; finished_at: number; attempts: number }>(
      `SELECT id, status, started_at, finished_at, attempts FROM processing_job WHERE kind = 'process_source_version' AND input_json LIKE ?`,
      [`%${versionId}%`],
    )!;
    expect(['completed', 'partial']).toContain(job.status);

    const db = t.ctx.db;
    const n = (sql: string, p: unknown[] = []) => db.get<{ n: number }>(sql, p)!.n;
    const pages = n('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ?', [versionId]);
    expect(pages).toBe(PAGES);
    const statuses = db.all<{ processing_status: string; n: number }>('SELECT processing_status, COUNT(*) AS n FROM source_page WHERE version_id = ? GROUP BY processing_status', [versionId]);
    const regions = n('SELECT COUNT(*) AS n FROM source_region WHERE version_id = ?', [versionId]);
    const chunks = n('SELECT COUNT(*) AS n FROM document_chunk WHERE version_id = ?', [versionId]);
    const labels = n(`SELECT COUNT(*) AS n FROM source_page WHERE version_id = ? AND printed_label_origin = 'detected_text'`, [versionId]);
    // AC-25 shape: one region set per page — no duplicated reading orders
    expect(n('SELECT COUNT(*) AS n FROM (SELECT page_id, reading_order FROM source_region WHERE version_id = ? GROUP BY page_id, reading_order HAVING COUNT(*) > 1)', [versionId])).toBe(0);

    const byType: Record<string, number[]> = {};
    for (const [i, ms] of pageMs) (byType[pageType(i)] ??= []).push(ms);
    const jobMs = job.finished_at - job.started_at;

    // ── keyword search (FTS5, normalized) over this version, then the universal search API ──
    const scope = { versionIds: [versionId] };
    const queries = ['mmol', 'appendicitis', 'ultrasound', 'threshold', 'fixture topic 150', 'استخراج', 'القيمة التجريبية', 'NOT', 'reference ranges'];
    const scoped: Record<string, unknown> = {};
    for (const q of queries) {
      const hits = searchChunks(db, scope, q, { limit: 20 }).length;
      scoped[q] = { hits, ...(await latency(100, () => searchChunks(db, scope, q, { limit: 20 }))) };
    }
    const universal = await latency(60, (i) =>
      t.app.inject({ method: 'GET', url: `/api/search?q=${encodeURIComponent(queries[i % queries.length]!)}&limit=20`, headers: h }).then((r) => {
        if (r.statusCode !== 200) throw new Error(`search ${r.statusCode}: ${r.body}`);
      }),
    );
    const sourceId = accepted.source_id!;
    const pagesApi = await latency(20, () =>
      t.app.inject({ method: 'GET', url: `/api/sources/${sourceId}/versions/${versionId}/pages`, headers: h }).then((r) => {
        if (r.statusCode !== 200) throw new Error(`pages ${r.statusCode}: ${r.body}`);
      }),
    );

    report('lecture-300', {
      scenario: `${PAGES}-page digital lecture (two-column every 5th page, table every 10th, raster figure every 25th, printed page numbers)`,
      file_mb: Math.round((pdf.data.length / 1024 / 1024) * 100) / 100,
      upload_ms: Math.round(uploadMs),
      drain_ms: Math.round(run.ms),
      processing_job_ms: jobMs,
      per_page_ms_all: percentiles([...pageMs.values()]),
      per_page_ms_by_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, percentiles(v)])),
      throughput_pages_per_s: Math.round((PAGES / (jobMs / 1000)) * 100) / 100,
      memory: run.mem,
      result: { pages, statuses, regions, chunks, detected_printed_labels: labels, attempts: job.attempts },
      fts_scoped_ms: scoped,
      universal_search_api_ms: universal,
      pages_api_ms: pagesApi,
    });
  }, 45 * 60_000);
});
