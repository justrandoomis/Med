// Pages of one version in a bounded pool (MEDLEVO_PROCESSING_PARALLELISM; one OCR worker per lane): the same result as
// the sequential run — every page processed once, in page order in the output, stage timings reported (no poppler).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/app';
import { addSource, createProcessingApp, pages, processVersion, regions } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await createProcessingApp({ parallelism: 2 });
}, 120_000);
afterAll(async () => {
  await t?.close();
});

describe('processing pages in parallel', () => {
  it('an image set on two lanes: all pages ready once, output in page order, timings reported', async () => {
    const src = await addSource(t, 'histology_images.zip', 'image_set');
    const job = await processVersion(t, src.versionId);
    expect(job.status).toBe('completed');
    const out = job.output as { pages_processed: number[]; timings_ms?: Record<string, number> };
    expect(out.pages_processed).toEqual([0, 1, 2]);
    expect(Object.keys(out.timings_ms ?? {})).toEqual(expect.arrayContaining(['inspect', 'pages', 'index', 'ocr_sum']));
    expect(pages(t, src.versionId).map((p) => p.processing_status)).toEqual(['ready', 'ready', 'ready']);
    // one checkpoint per page, no duplicated regions
    const rs = regions(t, src.versionId);
    expect(new Set(rs.map((r) => `${r.page_index}:${r.reading_order}`)).size).toBe(rs.length);
  }, 300_000);
});
