// G2 / AC-06 — an evidence id or a page that does not exist never becomes a visible, valid citation (REAL server).
// No AI key exists here, so model output itself is exercised in apps/server/test/acceptance/g2-ac06.test.ts (test-only
// provider: fabricated aliases, raw ids, page references written into the text). This spec covers what the browser
// and the API do with ids / pages that do not exist:
//   * the evidence API answers «missing» / 404 — the web never receives a view to draw a chip from;
//   * a link that names a page this version does not have (a stale citation) does NOT open another page as if it were
//     the cited one: the reader says so and stays where the owner was (defect found by G2: it silently clamped to
//     the last page — «ص 14» shown for a page 99 that does not exist; now: a notice, the first page, no highlight);
//   * a real citation link (control) still opens its page with the cited region highlighted.
import type { EvidenceView, PageRegionsResponse, SourcePagesResponse } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, setupOwner, test, waitForWorkspace } from './support';

test('AC-06: ids and pages that do not exist are refused, never shown as a citation', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
  expect((await api.waitForProcessing(lecture.version_id)).job?.status).toBe('completed');
  const pages = (await api.get<SourcePagesResponse>(`/api/sources/${lecture.source_id}/versions/${lecture.version_id}/pages`)).pages;
  expect(pages).toHaveLength(4);
  const regions = (await api.get<PageRegionsResponse>(`/api/sources/pages/${pages[1]!.id}/regions`)).regions;
  const us = regions.find((r) => (r.text ?? '').includes('Ultrasound is the first-line'))!;
  const real = (await api.post<{ evidence: EvidenceView }>('/api/evidence/from-region', { region_id: us.id })).evidence;

  await test.step('evidence API: unknown / fabricated ids are «missing» or 404 — never a view', async () => {
    const batch = await api.post<{ evidence: EvidenceView[]; missing: string[] }>('/api/evidence/batch', { ids: [real.id, 'E1', 'E99', 'does-not-exist', '__proto__'] });
    expect(batch.evidence.map((e) => e.id)).toEqual([real.id]);
    expect(batch.missing.sort()).toEqual(['E1', 'E99', '__proto__', 'does-not-exist'].sort());
    expect((await api.call('GET', '/api/evidence/does-not-exist')).status()).toBe(404);
    expect((await api.call('GET', '/api/evidence/claims/does-not-exist')).status()).toBe(404);
    // the real one points at file page 2, printed «12»
    expect(real.locator_label_ar).toBe('ص 12 (الصفحة 2 في الملف)');
  });

  await test.step('control: a real citation link opens its page with the cited region highlighted', async () => {
    await page.goto(`/study/${lecture.source_id}?v=${lecture.version_id}&page=1&page_id=${real.page_id}&region=${real.region_id}`);
    await waitForWorkspace(page);
    await expect(page.locator('.wk-pageind').first()).toContainText('ص 12');
    await expect(page.locator('.wk-region-hl').first()).toBeVisible();
    await expect(page.getByText('الموضع المطلوب غير موجود في هذا الإصدار')).toHaveCount(0);
  });

  await test.step('a page number this version does not have (page=99): said so, no other page passed off as the cited one', async () => {
    await page.goto(`/study/${lecture.source_id}?v=${lecture.version_id}&page=99&region=${real.region_id}`);
    await waitForWorkspace(page);
    await expect(page.getByRole('alert').filter({ hasText: 'الموضع المطلوب غير موجود في هذا الإصدار' })).toBeVisible();
    await expect(page.locator('.wk-region-hl')).toHaveCount(0);
    // not clamped to the last page («ص 14») and presented as the cited one: the book opens at its first page
    await expect(page.locator('.wk-pageind').first()).toContainText('ص 11');
    await screenshot(page, testInfo, 'g2-ac06-missing-page');
  });

  await test.step('a page id that does not exist (stale / fabricated link): the same', async () => {
    await page.goto(`/study/${lecture.source_id}?v=${lecture.version_id}&page_id=PAGE-DOES-NOT-EXIST&region=REGION-DOES-NOT-EXIST`);
    await waitForWorkspace(page);
    await expect(page.getByRole('alert').filter({ hasText: 'الموضع المطلوب غير موجود في هذا الإصدار' })).toBeVisible();
    await expect(page.locator('.wk-region-hl')).toHaveCount(0);
    await page.getByRole('button', { name: 'حسنًا' }).click();
    await expect(page.getByText('الموضع المطلوب غير موجود في هذا الإصدار')).toHaveCount(0);
  });

  await test.step('a plain reload of the workspace shows no such notice', async () => {
    await openWorkspace(page, lecture.source_id);
    await expect(page.getByText('الموضع المطلوب غير موجود في هذا الإصدار')).toHaveCount(0);
  });
});
