// Round 7 H4 against the REAL server (built web app, production server, no AI key), phone 390 × 844 and desktop:
//  1. «بياناتك» → «التصدير» → «الملف الأصلي مع كتابتي (PDF مسطح)»: the summary says what will be drawn (and what will
//     not, with the reason) BEFORE the file is built; the download is a real PDF (a copy of the original with the
//     owner's ink drawn on it — checked by the server tests with pdftoppm);
//  2. Control Center → «المصادر البصرية المسموح بها»: fetching is said to be off, an entry is added (the domain is
//     normalized from a URL), disabled and deleted after a stated impact; the screen is healthy on both widths.
import { readFileSync } from 'node:fs';
import type { SourcePagesResponse, VisualSourceListResponse } from '@medlevo/shared';
import { expect, expectHealthyScreen, screenshot, setupOwner, test } from './support';

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.toUpperCase().replace(/[^A-Z0-9]/g, 'X');

test('H4: the original PDF with my writing — summary first, then a real PDF', async ({ page, api }, testInfo) => {
  test.setTimeout(300_000);
  await setupOwner(page);
  const stamp = `${Date.now().toString(36)}-${testInfo.project.name}`;
  const { course } = await api.createNotebookAndCourse();
  const title = `H4 annotated ${stamp}`;
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title });
  await api.waitForProcessing(lecture.version_id);
  const pages = (await api.get<SourcePagesResponse>(`/api/sources/${lecture.source_id}/versions/${lecture.version_id}/pages`)).pages;
  const anchor = (i: number) => ({ type: 'page', source_id: lecture.source_id, version_id: lecture.version_id, page_id: pages[i]!.id, page_index: i, space: 'page_norm' });
  const stroke = { v: 1, points: [[0.2, 0.3, 0, 0.5], [0.4, 0.31, 16, 0.5], [0.6, 0.32, 32, 0.5]], style: { tool: 'pen', color: 'ink-red', width: 0.004 }, bbox: { x: 0.2, y: 0.3, w: 0.4, h: 0.02 }, pressure_available: false, tilt_available: false };
  const pushed = await api.post<{ results: Array<{ result: string }> }>('/api/sync/push', {
    ops: [
      { op_id: uid(), device_id: 'H4_E2E', client_ts: Date.now(), base_rev: null, entity_type: 'annotation', entity_id: uid(), op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: anchor(0), data: stroke, layer: 'ink', z: 0 } },
      {
        op_id: uid(),
        device_id: 'H4_E2E',
        client_ts: Date.now(),
        base_rev: null,
        entity_type: 'annotation',
        entity_id: uid(),
        op: 'upsert',
        payload: { kind: 'text', anchor: anchor(0), data: { v: 1, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 }, text: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'ملاحظتي' }] }] }, color: 'ink-black', font_scale: 1 }, layer: 'text', z: 0 },
      },
    ],
  });
  expect(pushed.results.map((r) => r.result)).toEqual(['applied', 'applied']);

  await page.goto('/offline?tab=export');
  await expect(page.getByRole('tab', { name: 'التصدير' })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('ما الذي تصدّره').selectOption({ label: 'الملف الأصلي مع كتابتي (PDF مسطح)' });
  await page.getByLabel('المصدر').selectOption({ label: title });
  const summary = page.getByRole('region', { name: 'ما سيحتويه الملف' });
  await expect(summary.getByText('سيُرسم على 1 صفحة: 1 ضربة قلم.')).toBeVisible({ timeout: 30_000 });
  await expect(summary.getByText(/مربعات النص لا تُرسم في PDF المسطح/)).toBeVisible();
  await expect(summary.getByText(/ليست حبرًا قابلًا لإعادة التحرير/)).toBeVisible();
  // no browser-print button and no format choice for the flattened PDF
  await expect(page.getByRole('button', { name: /افتح نسخة الطباعة/ })).toHaveCount(0);
  await expectHealthyScreen(page, 'h4-export-annotated');
  await screenshot(page, testInfo, 'h4-export-annotated');

  const response = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/data/export/source/${lecture.source_id}/annotated-pdf`);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'نزّل الملف' }).click();
  const res = await response;
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/pdf');
  // the saved file (the response body of a download is not kept by the browser)
  const saved = await (await download).path();
  expect(readFileSync(saved).subarray(0, 5).toString()).toBe('%PDF-');
  await expect(page.getByText('جُهّز الملف للحفظ على جهازك.')).toBeVisible();
});

test('H4: the registry of allowed external visual sources in the Control Center', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  // a clean list for this project's server
  for (const it of (await api.get<VisualSourceListResponse>('/api/media/visual-sources')).items) await api.del(`/api/media/visual-sources/${it.id}`);
  const name = `Atlas ${testInfo.project.name}`;

  await page.goto('/control/visual-sources');
  await expect(page.getByRole('heading', { level: 1, name: 'المصادر البصرية المسموح بها' })).toBeVisible();
  await expect(page.getByText('معطّل على الخادم', { exact: true })).toBeVisible();
  await expect(page.getByText(/لا مصادر بصرية في سجلك بعد/)).toBeVisible();

  await page.getByLabel(/^الاسم/).fill(name);
  await page.getByLabel(/^النطاق/).fill('https://www.atlas-e2e-test.org/cases/');
  await page.getByLabel(/^ملاحظة الترخيص/).fill('CC BY-NC-SA (TEST)');
  await page.getByRole('button', { name: 'أضف' }).click();
  const item = page.locator('.cc-vs-item').filter({ hasText: name });
  await expect(item).toBeVisible();
  await expect(item.getByText('atlas-e2e-test.org/cases/')).toBeVisible();
  await expect(item.getByText('مفعّل', { exact: true })).toBeVisible();
  await expectHealthyScreen(page, 'h4-visual-sources');
  await screenshot(page, testInfo, 'h4-visual-sources');

  await item.getByRole('switch', { name: 'يُقبل منه' }).click();
  await expect(item.getByText('معطّل', { exact: true })).toBeVisible();
  const stored = (await api.get<VisualSourceListResponse>('/api/media/visual-sources')).items.find((i) => i.name === name)!;
  expect(stored).toMatchObject({ domain: 'atlas-e2e-test.org', path_prefix: '/cases/', enabled: false });

  await item.getByRole('button', { name: `احذف «${name}»` }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText(/لن تُقبل بعد الآن صور خارجية من هذا الموقع/)).toBeVisible();
  await dialog.getByRole('button', { name: 'احذف من السجل' }).click();
  await expect(item).toHaveCount(0);
  expect((await api.get<VisualSourceListResponse>('/api/media/visual-sources')).items.find((i) => i.name === name)).toBeUndefined();
});
