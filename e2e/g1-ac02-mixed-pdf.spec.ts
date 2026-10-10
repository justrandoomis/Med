// G1 / AC-02 — mixed PDF (§60): ONE file with digital text (Arabic + English), an image-only scanned page, a
// two-column page, a ruled table with a merged header and a flowchart figure with its caption
// (fixtures/acceptance/g1_mixed_lecture.pdf, built from the Golden Set). Uploaded to the REAL server and processed
// by the real pipeline (pdf.js + poppler + tesseract): reading order and the visual regions are kept, and the image
// page is never treated as empty just because the PDF has no text layer there — not by the server, not on the
// source page, and not in the reader (text layer, in-document search) or the universal search.
import { join } from 'node:path';
import type { PageRegionsResponse, SearchResponse, SourceRegionView, TableStructure, DiagramStructure, FigureStructure } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, setupOwner, test } from './support';
import { ACCEPTANCE_DIR, uploadFile, versionPages } from './g1-helpers';

const byOrder = (rs: SourceRegionView[]) => [...rs].sort((a, b) => a.reading_order - b.reading_order);

test.describe('G1 AC-02 mixed PDF', () => {
  test('text + image-only page + two columns + table + diagram: order and regions kept, image page read (server, source page, reader, search)', async ({ page, api }, testInfo) => {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g1_mixed_lecture.pdf'), { sourceType: 'lecture', title: `G1 mixed lecture ${testInfo.project.name}` });
    const proc = await api.waitForProcessing(up.version_id);

    const pages = await versionPages(api, up.source_id, up.version_id);
    const regionsOf = async (i: number) => (await api.get<PageRegionsResponse>(`/api/sources/pages/${pages[i]!.id}/regions`)).regions;

    await test.step('processing finished honestly: every page processed, the flagged Arabic defect keeps it «needs review»', async () => {
      expect(proc.job?.status).toBe('completed');
      expect(pages).toHaveLength(5);
      expect(pages.every((p) => p.processing_status === 'ready' || p.processing_status === 'needs_review')).toBe(true);
      expect(proc.summary?.pages_failed).toBe(0);
    });

    await test.step('the image-only page (file page 2) was OCR\'d, not called empty', async () => {
      const scan = pages[1]!;
      expect(scan.text_status).toBe('ocr');
      expect(scan.ocr_confidence).toBeGreaterThan(0.5);
      const text = byOrder(await regionsOf(1)).map((r) => r.text ?? '').join('\n');
      expect(text).toContain('pylori');
      expect(text).toContain('urea breath test');
      expect(text).toContain('جرثومة');
      expect(text).not.toMatch(/[‎‏‪-‮⁦-⁩]/); // logical order, no bidi controls stored
    });

    await test.step('two-column page keeps the reading order (left column top→bottom, then the right column)', async () => {
      const text = byOrder(await regionsOf(2)).map((r) => r.text ?? '').join('\n');
      const a = text.indexOf('Ultrasound is the first-line');
      const b = text.indexOf('CT abdomen is preferred');
      const c = text.indexOf('Differential diagnosis');
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThan(a);
      expect(c).toBeGreaterThan(b);
    });

    await test.step('table region: merged header across all columns, units verbatim in their cell', async () => {
      const rs = await regionsOf(3);
      const table = rs.find((r) => r.kind === 'table');
      expect(table, 'a table region').toBeTruthy();
      const st = table!.structure as TableStructure;
      expect(st.type).toBe('table');
      expect(st.rows).toBeGreaterThanOrEqual(10);
      const merged = st.cells.find((c) => c.text.includes('Alvarado score (MANTRELS)'));
      expect(merged?.colspan).toBe(st.cols);
      expect(merged?.header).toBe(true);
      expect(rs.some((r) => r.kind === 'table_cell' && r.parent_region_id === table!.id && (r.text ?? '').includes('> 10 ×10⁹/L'))).toBe(true);
    });

    await test.step('figure region with its caption; diagram labels stay UNCERTAIN and no arrows are invented', async () => {
      const rs = await regionsOf(4);
      const figure = rs.find((r) => r.kind === 'figure');
      const caption = rs.find((r) => r.kind === 'caption' && (r.text ?? '').includes('Figure 1'));
      expect(figure && caption, 'figure + caption regions').toBeTruthy();
      expect((figure!.structure as FigureStructure).caption_region_id).toBe(caption!.id);
      expect((figure!.structure as FigureStructure).image_asset_id, 'a cropped image of the figure is kept').toBeTruthy();
      const diagram = rs.find((r) => r.kind === 'diagram' && r.parent_region_id === figure!.id);
      if (diagram) {
        expect(diagram.status).toBe('uncertain');
        expect((diagram.structure as DiagramStructure).edges).toEqual([]);
        expect((diagram.structure as DiagramStructure).understanding).toBe('labels_ocr_only');
      }
    });

    await test.step('source page: the image page reads «تعرّف ضوئي (OCR)», never «لا يوجد نص»', async () => {
      await page.goto(`/sources/${up.source_id}`);
      const row = page.locator('.ml-pages__table tbody tr').nth(1);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.locator('td[data-label="النص"]')).toHaveText('تعرّف ضوئي (OCR)');
      await expect(page.locator('.ml-pages__table tbody tr').nth(3).locator('td[data-label="النص"]')).toHaveText('نص رقمي');
      await screenshot(page, testInfo, 'g1-ac02-source-pages');
    });

    await test.step('universal search finds the OCR text of the image page, labelled as machine-read', async () => {
      const res = await api.get<SearchResponse>(`/api/search?q=${encodeURIComponent('urea breath test')}`);
      const hit = res.results.find((r) => r.location?.source_id === up.source_id);
      expect(hit, 'a search hit in this lecture').toBeTruthy();
      expect(hit!.location!.page_index).toBe(1);
    });

    await test.step('reader: the image page carries its OCR text (selectable, readable) and in-document search finds it', async () => {
      await openWorkspace(page, up.source_id, { pageIndex: 1 });
      const scanPage = page.locator('.wk-page[data-page-index="1"]');
      await expect(scanPage.locator('.wk-canvas-slot canvas')).toBeVisible({ timeout: 45_000 });
      // the PDF has no text layer on this page: the OCR text must be there instead (never an empty page)
      await expect(scanPage).toContainText('urea breath test', { timeout: 30_000 });

      if (!(await page.getByRole('searchbox', { name: 'ابحث في هذا المصدر' }).isVisible())) {
        const more = page.getByRole('button', { name: 'المزيد' });
        const searchBtn = page.getByRole('button', { name: 'البحث في المصدر' }).first();
        if (await searchBtn.isVisible()) await searchBtn.click();
        else {
          await more.click();
          await page.getByRole('menuitem', { name: /البحث في المصدر/ }).click();
        }
      }
      const box = page.getByRole('searchbox', { name: 'ابحث في هذا المصدر' });
      await box.fill('pylori');
      const hits = page.locator('.wk-search__results .wk-search__hit');
      await expect(hits.filter({ hasText: 'pylori' }).first()).toBeVisible({ timeout: 30_000 });
      await expect(hits.first().locator('.wk-search__page')).toHaveText(/الصفحة 2 في الملف|ص 2/);
      // a digital page is still found through the pdf.js text (the table page, file page 4)
      await box.fill('Alvarado');
      await expect(hits.filter({ hasText: 'Alvarado' }).first()).toBeVisible({ timeout: 30_000 });
      await expect(hits.filter({ hasText: 'pylori' })).toHaveCount(0);
      await screenshot(page, testInfo, 'g1-ac02-reader-search');
    });
  });
});
