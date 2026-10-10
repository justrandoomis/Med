// G1 / AC-03 — partial failure (§60) against the REAL server with real failures (no hooks, no SQL):
//   * fixtures/acceptance/g1_partial_images.zip — an ordered image set whose 2nd picture is a truncated PNG: the real
//     OCR fails on it → that page «تعثّرت» with its reason, the version is partial, pages 1 and 3 stay readable;
//   * fixtures/acceptance/g1_damaged_page.pdf — a PDF whose 2nd page has a damaged content stream: flagged
//     (unreadable, needs review) instead of a silent «ready» empty page.
// The source page, the reader and the Control Center show the stumble; the summary preview (no AI needed) says the
// summary will NOT be complete, and generating one honestly requires configuration (no AI key here).
import { join } from 'node:path';
import type { ProcessingSummary, SummaryPreviewResponse } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, setupOwner, test } from './support';
import { ACCEPTANCE_DIR, uploadFile, versionPages } from './g1-helpers';

test.describe('G1 AC-03 partial failure', () => {
  test('one damaged page is shown clearly, the others stay readable, the summary is never called complete', async ({ page, api }, testInfo) => {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const stamp = testInfo.project.name;
    const imgs = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g1_partial_images.zip'), { sourceType: 'lecture', title: `G1 partial images ${stamp}` });
    const pdf = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g1_damaged_page.pdf'), { sourceType: 'lecture', title: `G1 damaged page ${stamp}` });
    const procImgs = await api.waitForProcessing(imgs.version_id);
    const procPdf = await api.waitForProcessing(pdf.version_id);

    await test.step('server: real partial results (failed page with its reason; damaged PDF page flagged, not empty)', async () => {
      expect(procImgs.job?.status).toBe('partial');
      const s1 = procImgs.summary as ProcessingSummary;
      expect(s1).toMatchObject({ pages_total: 3, pages_failed: 1, coverage_complete: false });
      const ip = await versionPages(api, imgs.source_id, imgs.version_id);
      expect(ip.map((p) => p.processing_status)).toEqual([expect.stringMatching(/ready|needs_review/), 'failed', expect.stringMatching(/ready|needs_review/)]);
      expect(ip[1]!.error_code).toBe('OCR_FAILED');

      expect(procPdf.job?.status).toBe('completed');
      expect((procPdf.summary as ProcessingSummary).coverage_complete).toBe(false);
      const pp = await versionPages(api, pdf.source_id, pdf.version_id);
      expect(pp.map((p) => p.processing_status)).toEqual(['ready', 'needs_review', 'ready']);
      expect(pp[1]).toMatchObject({ error_code: 'PAGE_CONTENT_DAMAGED', text_status: 'no_text_found' });
    });

    await test.step('source page: the failed page, its reason and «إعادة المعالجة»; the others readable; no complete summary', async () => {
      await page.goto(`/sources/${imgs.source_id}`);
      await expect(page.getByText(/اكتملت المعالجة جزئيًا/).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/التغطية غير كاملة/).first()).toBeVisible();
      await expect(page.getByText(/بقية الصفحات قابلة للقراءة، ولن يُعرض أي ملخص على أنه كامل قبل معالجتها/)).toBeVisible();
      const rows = page.locator('.ml-pages__table tbody tr');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(1)).toHaveAttribute('data-status', 'failed');
      await expect(rows.nth(1)).toContainText('تعثّرت');
      await expect(rows.nth(1)).toContainText('02_damaged.png');
      await expect(rows.nth(1)).toContainText('فشل محرك التعرف الضوئي');
      await expect(rows.nth(1).getByRole('button', { name: /إعادة المعالجة/ })).toBeVisible();
      for (const i of [0, 2]) await expect(rows.nth(i)).not.toHaveAttribute('data-status', 'failed');
      await screenshot(page, testInfo, 'g1-ac03-source-partial');

      await page.goto(`/sources/${pdf.source_id}`);
      const prow = page.locator('.ml-pages__table tbody tr').nth(1);
      await expect(prow).toHaveAttribute('data-status', 'needs_review', { timeout: 30_000 });
      await expect(prow).toContainText('تحتاج مراجعة');
      await expect(prow).toContainText('تالف جزئيًا');
      await expect(page.getByText(/لم يُقرأ نصها/).first()).toBeVisible();
      await screenshot(page, testInfo, 'g1-ac03-source-damaged-pdf');
    });

    await test.step('reader: the readable pages open with their text while the stumble is elsewhere', async () => {
      await openWorkspace(page, imgs.source_id, { pageIndex: 0 });
      await expect(page.locator('.wk-page[data-page-index="0"] .wk-ocrlayer')).toContainText('pylori', { timeout: 30_000 });
      await openWorkspace(page, imgs.source_id, { pageIndex: 2 });
      await expect(page.locator('.wk-page[data-page-index="2"] img.wk-page-image')).toBeVisible();
      await openWorkspace(page, pdf.source_id, { pageIndex: 2 });
      await expect(page.locator('.wk-page[data-page-index="2"] .wk-textlayer span').first()).toBeAttached({ timeout: 30_000 });
      await screenshot(page, testInfo, 'g1-ac03-reader');
    });

    await test.step('Control Center → processing: both versions page by page with the specific reason', async () => {
      await page.goto('/control/processing');
      for (const [title, reason] of [
        [`G1 partial images ${stamp}`, 'فشل محرك التعرف الضوئي'],
        [`G1 damaged page ${stamp}`, 'تالف جزئيًا'],
      ] as const) {
        const item = page.locator('li.cc-version').filter({ hasText: title });
        await expect(item).toBeVisible({ timeout: 30_000 });
        await expect(item.locator('.cc-pages__row')).toHaveCount(1);
        await expect(item.locator('.cc-pages__reason')).toContainText(reason);
        await expect(item.locator('.cc-version__note')).not.toBeEmpty();
      }
      await screenshot(page, testInfo, 'g1-ac03-control-processing');
    });

    await test.step('summaries: the preview says NOT complete and names the page; generation honestly needs an AI key', async () => {
      for (const src of [imgs, pdf]) {
        const prev = await api.post<SummaryPreviewResponse>('/api/studybook/summaries/preview', { type: 'detailed', source_id: src.source_id, scope: { mode: 'lecture_only', lecture_source_id: src.source_id } });
        expect(prev.will_be_complete).toBe(false);
        expect(prev.pages_unreadable).toEqual([1]);
        expect(prev.notes_ar.join(' ')).toContain('غير مقروءة');
      }
      const gen = await api.call('POST', '/api/studybook/summaries', { type: 'detailed', source_id: imgs.source_id, scope: { mode: 'lecture_only', lecture_source_id: imgs.source_id } });
      expect(gen.status()).toBe(409);
      expect(((await gen.json()) as { error: { code: string } }).error.code).toBe('AI_NOT_CONFIGURED');
    });
  });
});
