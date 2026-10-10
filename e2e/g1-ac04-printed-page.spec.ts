// G1 / AC-04 — printed page ≠ file page (§60). A synthetic book (fixtures/acceptance) has two unnumbered front-matter
// pages, then the body printed 1..12: the page printed «12» is file page 14, while file page 12 is printed «10».
// Two variants: with a /PageLabels tree (i, ii, 1…12) and with the numbers only printed in the footer (detected).
// A REAL citation (an evidence row cut from a region of the processed page — what a card made from a selection
// stores; no AI involved) is opened from the card screen: the chip says «ص12», the peek shows both numberings and
// «افتح المصدر» lands on file page 14 (never file page 12). Go-to understands both readings. A page with NO printed
// number is never presented as if it were printed «ص N» where another page really is printed N.
import { join } from 'node:path';
import type { CardCreateResponse, PageRegionsResponse, SourcePageView } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, setupOwner, test, type E2eApi, type UploadedFixture } from './support';
import { ACCEPTANCE_DIR, uploadFile, versionPages } from './g1-helpers';
import type { Page } from '@playwright/test';

const MARKERS = ['ALDER', 'BIRCH', 'CEDAR', 'DAHLIA', 'ELM', 'FERN', 'GINKGO', 'HAZEL', 'IRIS', 'JUNIPER', 'KESTREL', 'LARCH', 'MAPLE', 'NUTMEG'];

async function citeMarker(api: E2eApi, up: UploadedFixture, pages: SourcePageView[], fileIndex: number): Promise<string> {
  const { regions } = await api.get<PageRegionsResponse>(`/api/sources/pages/${pages[fileIndex]!.id}/regions`);
  const region = regions.find((r) => (r.text ?? '').includes(`Unique marker ${MARKERS[fileIndex]}`));
  expect(region, `a region with the marker of file page ${fileIndex + 1}`).toBeTruthy();
  const res = await api.post<CardCreateResponse>('/api/learning/cards/from-selection', {
    source_id: up.source_id,
    version_id: up.version_id,
    quote: region!.text,
    region_id: region!.id,
    kind: 'basic',
    front: `G1 AC-04 — where is the marker ${MARKERS[fileIndex]}?`,
  });
  return res.cards[0]!.id;
}

/** the reader page currently under the reading line (the indicator), its folio and the page element */
async function expectReaderAt(page: Page, fileIndex: number, folioPrimary: RegExp, folioSecondary: RegExp | null) {
  const sheet = page.locator(`.wk-page[data-page-index="${fileIndex}"]`);
  await expect(sheet).toBeInViewport({ ratio: 0.3, timeout: 30_000 });
  await expect(sheet.locator('.wk-folio__primary')).toHaveText(folioPrimary);
  if (folioSecondary) await expect(sheet.locator('.wk-folio__secondary')).toHaveText(folioSecondary);
  else await expect(sheet.locator('.wk-folio__secondary')).toHaveCount(0);
  await expect(page.locator('.wk-pageind__primary').first()).toHaveText(folioPrimary);
  await expect(sheet.locator('.wk-textlayer')).toContainText(MARKERS[fileIndex]!, { timeout: 30_000 });
}

async function openCitationFromCard(page: Page, cardId: string, chipText: RegExp, locator: RegExp) {
  await page.goto(`/review/cards/${cardId}`);
  const chip = page.locator('.ev-chip').first().getByRole('button');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toHaveText(chipText);
  await chip.click();
  const peek = page.getByRole('dialog').filter({ has: page.locator('.ev-peek') });
  await expect(peek.locator('.ev-peek__locator')).toHaveText(locator);
  await peek.getByRole('button', { name: 'افتح المصدر' }).click();
  await expect(page).toHaveURL(/\/study\//);
}

async function goTo(page: Page, input: string) {
  await page.locator('.wk-pageind').first().click();
  const field = page.getByLabel('انتقل إلى صفحة');
  await field.fill(input);
  await page.getByRole('button', { name: 'انتقال', exact: true }).click();
}

test.describe('G1 AC-04 printed page vs file page', () => {
  test('/PageLabels book: citation «ص12» opens file page 14 (not 12), both numberings shown; go-to reads both', async ({ page, api }, testInfo) => {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g1_front_matter_labels.pdf'), { sourceType: 'lecture', title: `G1 front matter labels ${testInfo.project.name}` });
    const proc = await api.waitForProcessing(up.version_id);
    expect(proc.job?.status).toBe('completed');
    const pages = await versionPages(api, up.source_id, up.version_id);
    expect(pages.map((p) => p.printed_label)).toEqual(['i', 'ii', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(pages.every((p) => p.printed_label_origin === 'pdf_page_labels')).toBe(true);

    const card12 = await test.step('a card made from a selection on the page printed 12 cites it', () => citeMarker(api, up, pages, 13));

    await test.step('the chip says «ص12», the peek shows both numberings, «افتح المصدر» lands on file page 14', async () => {
      await openCitationFromCard(page, card12, /^محاضرة ص12$/, /^ص 12 \(الصفحة 14 في الملف\)$/);
      await expectReaderAt(page, 13, /^ص 12$/, /^الصفحة 14 في الملف$/);
      // the cited region is highlighted on that page, not on file page 12
      await expect(page.locator('.wk-page[data-page-index="13"] .wk-region-hl').first()).toBeVisible();
      await expect(page.locator('.wk-page[data-page-index="11"] .wk-region-hl')).toHaveCount(0);
      await screenshot(page, testInfo, 'g1-ac04-citation-opened');
    });

    await test.step('go-to: «12» and «ص ١٢» → printed 12 (file page 14); «#12» → file page 12 (printed 10); «ii» → front matter', async () => {
      await openWorkspace(page, up.source_id, { pageIndex: 0 });
      await goTo(page, '12');
      await expectReaderAt(page, 13, /^ص 12$/, /^الصفحة 14 في الملف$/);
      // the other reading of «12» is offered, not silently chosen
      await expect(page.getByRole('status').filter({ hasText: 'فُتحت الصفحة المطبوع عليها هذا الرقم' })).toBeVisible();
      await page.keyboard.press('Escape');
      await goTo(page, 'ص ١٢');
      await expectReaderAt(page, 13, /^ص 12$/, /^الصفحة 14 في الملف$/);
      await page.keyboard.press('Escape');
      await goTo(page, '#12');
      await expectReaderAt(page, 11, /^ص 10$/, /^الصفحة 12 في الملف$/);
      await goTo(page, 'ii');
      await expectReaderAt(page, 1, /^ص ii$/, /^الصفحة 2 في الملف$/);
    });
  });

  test('detected labels: citation «ص12» opens file page 14; an unnumbered page is never shown as a printed «ص 1»', async ({ page, api }, testInfo) => {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g1_front_matter_detected.pdf'), { sourceType: 'lecture', title: `G1 front matter detected ${testInfo.project.name}` });
    const proc = await api.waitForProcessing(up.version_id);
    expect(proc.job?.status).toBe('completed');
    const pages = await versionPages(api, up.source_id, up.version_id);
    expect(pages.map((p) => p.printed_label)).toEqual([null, null, '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);

    await test.step('citation of the page printed 12 (detected from the footer) opens file page 14', async () => {
      const card12 = await citeMarker(api, up, pages, 13);
      await openCitationFromCard(page, card12, /^محاضرة ص12$/, /^ص 12 \(الصفحة 14 في الملف\)$/);
      await expectReaderAt(page, 13, /^ص 12$/, /^الصفحة 14 في الملف$/);
    });

    await test.step('citation of the unnumbered cover: identified by its file position, not as «ص1» (which is printed on file page 3)', async () => {
      const cardCover = await citeMarker(api, up, pages, 0);
      await openCitationFromCard(page, cardCover, /^محاضرة الصفحة 1 في الملف$/, /^الصفحة 1 في الملف$/);
      await expectReaderAt(page, 0, /^الصفحة 1 في الملف$/, null);
      // and the page that IS printed 1 keeps its identity
      await goTo(page, '1');
      await expectReaderAt(page, 2, /^ص 1$/, /^الصفحة 3 في الملف$/);
      await screenshot(page, testInfo, 'g1-ac04-detected-labels');
    });
  });
});
