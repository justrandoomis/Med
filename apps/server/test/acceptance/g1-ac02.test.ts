// G1 / AC-02 — mixed PDF through the REAL processing pipeline (pdf.js + poppler + tesseract): ONE file
// (fixtures/acceptance/g1_mixed_lecture.pdf) with digital English + Arabic text, an image-only scanned page in the
// middle, a two-column page, a ruled table with a merged header and a flowchart figure with its caption.
// The reader-side half (OCR text layer + in-document search on the scanned PDF page) is covered by
// apps/web/src/features/workspace/reader/PageView.ocrpdf.test.tsx and e2e/g1-ac02-mixed-pdf.spec.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiagramStructure, FigureStructure, TableStructure } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import { searchChunks } from '../../src/modules/processing/search';
import type { TestApp } from '../helpers/app';
import { addSource, createProcessingApp, pages, pageText, processVersion, regions } from '../processing/helpers';

const FIXTURE = join(REPO_ROOT, 'fixtures', 'acceptance', 'g1_mixed_lecture.pdf');

let t: TestApp;
let versionId: string;
beforeAll(async () => {
  t = await createProcessingApp();
  const s = await addSource(t, 'g1_mixed_lecture.pdf', 'pdf', { data: readFileSync(FIXTURE), fileName: 'g1_mixed_lecture.pdf' });
  versionId = s.versionId;
  const job = await processVersion(t, versionId);
  expect(job.status).toBe('completed');
}, 180_000);
afterAll(async () => {
  await t?.close();
});

describe('G1 AC-02 — mixed PDF: reading order and visual regions kept, the image page is read (never empty)', () => {
  it('every page is processed; nothing failed; the only review flag is the real Arabic extraction defect', () => {
    const ps = pages(t, versionId);
    expect(ps.map((p) => p.processing_status)).toEqual(['needs_review', 'ready', 'ready', 'ready', 'ready']);
    expect(ps[0]!.text_status).toBe('digital');
    const flagged = regions(t, versionId, 0).filter((r) => r.status === 'needs_review');
    expect(flagged.map((r) => r.text)).toEqual([expect.stringContaining('عادةS')]);
  });

  it('the image-only page in the middle is OCR\'d with its English and Arabic lines, not called empty', () => {
    const p = pages(t, versionId)[1]!;
    expect(p.text_status).toBe('ocr');
    expect(p.render_file_id).toBeTruthy();
    expect(p.ocr_confidence!).toBeGreaterThan(0.5);
    const text = pageText(t, versionId, 1);
    expect(text).toContain('pylori');
    expect(text).toContain('urea breath test');
    expect(text).toContain('جرثومة');
    expect(regions(t, versionId, 1).every((r) => r.text_origin === 'ocr')).toBe(true);
  });

  it('the OCR text is indexed for search (scope-filtered) like any digital page', () => {
    const hits = searchChunks(t.ctx.db, { versionIds: [versionId] }, 'urea breath test');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain('urea breath test');
  });

  it('two-column page: left column top→bottom before the right column', () => {
    const text = pageText(t, versionId, 2);
    const order = ['Ultrasound is the first-line', 'CT abdomen is preferred', 'Differential diagnosis'].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('table: merged header across all columns, header flag, units verbatim in their own cell', () => {
    const rs = regions(t, versionId, 3);
    const table = rs.find((r) => r.kind === 'table')!;
    const st = JSON.parse(table.structure_json!) as TableStructure;
    expect(st.rows).toBe(10);
    expect(st.cols).toBe(3);
    expect(st.cells.find((c) => c.text.includes('Alvarado score (MANTRELS)'))).toMatchObject({ colspan: 3, header: true });
    expect(rs.filter((r) => r.kind === 'table_cell' && r.parent_region_id === table.id).map((r) => r.text)).toContain('> 10 ×10⁹/L');
  });

  it('figure kept as a visual region with its caption, a cropped image and uncertain diagram labels (no invented arrows)', () => {
    const rs = regions(t, versionId, 4);
    const figure = rs.find((r) => r.kind === 'figure')!;
    const fs = JSON.parse(figure.structure_json!) as FigureStructure;
    const caption = rs.find((r) => r.id === fs.caption_region_id)!;
    expect(caption.text).toContain('Figure 1');
    expect(fs.image_asset_id).toBeTruthy();
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM image_asset WHERE id = ?', [fs.image_asset_id])!.n).toBe(1);
    const diagram = rs.find((r) => r.kind === 'diagram' && r.parent_region_id === figure.id)!;
    expect(diagram.status).toBe('uncertain');
    const ds = JSON.parse(diagram.structure_json!) as DiagramStructure;
    expect(ds.understanding).toBe('labels_ocr_only');
    expect(ds.edges).toEqual([]);
    expect(ds.nodes.every((n) => n.certainty === 'uncertain')).toBe(true);
    // the paragraph that mentions the figure is linked to it
    expect(fs.referenced_by_region_ids?.length).toBeGreaterThan(0);
  });

  it('printed numbers are never invented: the inserted scan breaks the offset of page 1, which therefore gets no label', () => {
    const ps = pages(t, versionId);
    expect(ps.map((p) => p.printed_label)).toEqual([null, null, '12', '13', '14']);
    expect(ps.slice(2).every((p) => p.printed_label_origin === 'detected_text')).toBe(true);
  });
});
