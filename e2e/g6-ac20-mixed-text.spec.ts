// G6 / AC-20 — mixed text (§60): numbers, units, parentheses and English terms keep their correct order inside Arabic
// in DISPLAY, COPY, SEARCH and EXPORT. Real server + built web app, Golden Set lecture (its page ص 11 has an Arabic
// sentence that ends with «McBurney», drawn by the PDF producer in a scrambled content order), plus an owner note
// typed with the §21 samples and super/subscripts. «Order» is checked where the owner sees it: glyph positions on
// screen (each LTR expression drawn left to right, Arabic before/after it on the correct side), the clipboard, the
// search hits, and the exported HTML rendered (screen and print media).
//
// Two defects were found here and fixed (regression tests in the unit suites):
//  * reader copy: selecting the whole mixed line from its start to its end copied «يبدأ األلم عادMcBurney» — the middle
//    of the sentence was lost (DOM order of the pdf.js text layer = the PDF's content-stream order) and the in-document
//    search never found «نقطة McBurney» (reader/textOrder.ts);
//  * display / export: «×10⁹», «CO₂», «HCO₃⁻» were isolated without their super/subscript, which the browser then drew
//    on the other side — «⁹×10», «₂CO» (packages/shared richtext.ts segmentRuns).
import { expect, openWorkspace, screenshot, setupOwner, test, type E2eApi } from './support';
import { expectDrawnLeftToRight, expectReadBefore } from './g6-helpers';
import type { Page } from '@playwright/test';

const NOTE =
  'عدد الكريات البيضاء أعلى من 11 ×10⁹ في اللتر، ويرتفع CO₂ (في الدم) وتنخفض HCO₃⁻؛ الصوديوم Na+ 135 mmol/L والجرعة 5 mg IV وpH 7.35 وجرثومة H. pylori والفحص (CT abdomen) والتسلسل A → B → C.';
const LTR_EXPRESSIONS = ['11 ×10⁹', 'CO₂', 'HCO₃⁻', 'Na+ 135 mmol/L', '5 mg IV', 'pH 7.35', 'H. pylori', '(CT abdomen)', 'A → B → C'];
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩؜]/;

async function expectMixedNoteDrawn(page: Page, root: ReturnType<Page['locator']>, label: string) {
  await test.step(`${label}: every LTR expression drawn left to right, the Arabic around it on the correct side`, async () => {
    for (const expr of LTR_EXPRESSIONS) await expectDrawnLeftToRight(root, expr);
    await expectReadBefore(root, 'من', '11', 'من 11 ×10⁹ في');
    await expectReadBefore(root, '⁹', 'في', 'من 11 ×10⁹ في');
    await expectReadBefore(root, 'ويرتفع', 'CO₂', 'ويرتفع CO₂ (في');
    await expectReadBefore(root, '₂', '(في', 'ويرتفع CO₂ (في');
  });
}

async function openRailTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name: new RegExp(name) });
  if (!(await tab.isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
  await tab.click();
}

async function lecture(page: Page, api: E2eApi, title: string) {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title });
  const proc = await api.waitForProcessing(up.version_id);
  expect(proc.job?.status).toBe('completed');
  return up;
}

test.describe('G6 AC-20 mixed Arabic / English text', () => {
  test('reader: copying the whole mixed line gives the sentence in reading order; the in-document search finds the mixed phrase', async ({ page, api, context }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const up = await lecture(page, api, `G6 AC-20 reader ${testInfo.project.name}`);
    await openWorkspace(page, up.source_id, { pageIndex: 0 });
    const layer = page.locator('.wk-page[data-page-index="0"] .wk-textlayer');
    await expect(layer).toContainText('McBurney', { timeout: 30_000 });

    await test.step('the text layer holds the line in logical order (DOM order = reading order)', async () => {
      const text = (await layer.textContent()) ?? '';
      expect(text).toContain('حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى عند نقطة McBurney.');
      expect(text.indexOf('يبدأ')).toBeLessThan(text.indexOf('حول السرة'));
    });

    await test.step('drag from the start of the line (right) to its end (left), «نسخ» → the clipboard holds the whole sentence in order', async () => {
      const start = (await layer.locator('span', { hasText: 'يبدأ' }).first().boundingBox())!;
      // the sentence ends at the far left: the full stop after «McBurney»
      const end = (await layer.locator('span').filter({ hasText: /^\.$/ }).first().boundingBox())!;
      const y = start.y + start.height / 2;
      await page.mouse.move(start.x + start.width - 0.3, y);
      await page.mouse.down();
      await page.mouse.move((start.x + end.x) / 2, y, { steps: 6 });
      await page.mouse.move(end.x + 0.5, end.y + end.height / 2, { steps: 6 });
      await page.mouse.up();
      const bar = page.getByRole('toolbar', { name: 'أدوات النص المحدد' });
      await expect(bar).toBeVisible();
      await bar.getByRole('button', { name: 'نسخ' }).click();
      await expect(page.getByText('نُسخ النص.')).toBeVisible();
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      expect(BIDI_CONTROLS.test(clip)).toBe(false);
      expect(clip.startsWith('يبدأ'), clip).toBe(true);
      // the whole middle of the sentence is there, in reading order, with the English term where it is read
      expect(clip).toContain('حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى عند نقطة McBurney');
      await screenshot(page, testInfo, 'g6-ac20-reader-selection');
    });

    await test.step('in-document search: «نقطة McBurney» and «عند نقطة McBurney» are found on ص 11', async () => {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'البحث في المصدر' }).first().click();
      const field = page.getByRole('searchbox', { name: 'ابحث في هذا المصدر' });
      for (const q of ['نقطة McBurney', 'عند نقطة McBurney', '11 ×10⁹/L']) {
        await field.fill(q);
        const hit = page.locator('.wk-search__hit').first();
        await expect(hit, q).toBeVisible({ timeout: 30_000 });
        await expect(hit.locator('.wk-search__page')).toHaveText(/ص 11/);
        await expect(hit.locator('mark')).toHaveText(q);
      }
    });
  });

  test('owner note with the §21 samples: displayed in order, copied as typed, found by a mixed phrase, exported in order (screen + print)', async ({ page, api, context }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const up = await lecture(page, api, `G6 AC-20 note ${testInfo.project.name}`);
    await openWorkspace(page, up.source_id, { pageIndex: 0 });

    const body = page.locator('.wk-note__body').filter({ hasText: 'عدد الكريات البيضاء' }).first();
    await test.step('typed in «ملاحظاتي» → saved and shown', async () => {
      await openRailTab(page, 'ملاحظاتي');
      await page.getByRole('button', { name: 'ملاحظة على هذه الصفحة' }).click();
      await page.getByLabel(/ملاحظة جديدة/).fill(NOTE);
      await page.getByRole('button', { name: 'تم', exact: true }).click();
      await expect(body).toBeVisible();
      await expect(body).toHaveText(NOTE);
    });
    await expectMixedNoteDrawn(page, body, 'note in the study rail');
    await screenshot(page, testInfo, 'g6-ac20-note');

    await test.step('copy (select the note, Ctrl/⌘+C) → exactly the typed text, no control characters', async () => {
      await body.evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = document.getSelection()!;
        s.removeAllRanges();
        s.addRange(r);
      });
      await page.keyboard.press('ControlOrMeta+C');
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      expect(clip.trim()).toBe(NOTE);
    });

    await test.step('synced to the server in logical order', async () => {
      await expect
        .poll(async () => {
          const r = await api.get<{ notes: Array<{ body: { paragraphs: Array<{ runs: Array<{ t: string }> }> } }> }>(`/api/annotations/notes?source_id=${up.source_id}`);
          return r.notes.map((n) => n.body.paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join('\n'));
        }, { timeout: 30_000 })
        .toContain(NOTE);
    });

    await test.step('universal search, exact phrase «ويرتفع CO₂» → the note; the snippet draws it in order', async () => {
      await page.goto(`/search?q=${encodeURIComponent('ويرتفع CO₂')}&mode=exact&types=notes`);
      const item = page.locator('.sr-item').first();
      await expect(item).toBeVisible({ timeout: 30_000 });
      const snippet = item.locator('.sr-item__snippet');
      await expect(snippet).toContainText('ويرتفع CO₂');
      await expectDrawnLeftToRight(snippet, 'CO₂');
      await expectReadBefore(snippet, 'ويرتفع', 'CO₂', 'ويرتفع CO₂');
      await screenshot(page, testInfo, 'g6-ac20-search');
      // the reversed order is not an exact match
      await page.goto(`/search?q=${encodeURIComponent('CO₂ ويرتفع')}&mode=exact&types=notes`);
      await expect(page.locator('.sr-results')).toContainText('لا نتائج لـ', { timeout: 30_000 });
    });

    await test.step('export: HTML (and its print rendering = the PDF path) draws every expression in order', async () => {
      const res = await api.request.get(`/api/data/export/notes?source_id=${up.source_id}&format=html`);
      expect(res.ok()).toBe(true);
      const html = await res.text();
      expect(BIDI_CONTROLS.test(html)).toBe(false);
      const md = await (await api.request.get(`/api/data/export/notes?source_id=${up.source_id}&format=md`)).text();
      expect(BIDI_CONTROLS.test(md)).toBe(false);
      expect(md.replace(/\\([\\`*_[\]<>#|~!{}+\-=.])/g, '$1')).toContain(NOTE);

      const src = await (await api.request.get(`/api/data/export/source/${up.source_id}?format=html`)).text();
      const doc = await page.context().newPage();
      try {
        await doc.setContent(html);
        const p = doc.locator('p', { hasText: 'عدد الكريات البيضاء' }).first();
        await expect(p).toHaveText(NOTE);
        await expectMixedNoteDrawn(doc, p, 'exported HTML (screen)');
        await doc.emulateMedia({ media: 'print' });
        await expectMixedNoteDrawn(doc, p, 'exported HTML (print → PDF)');
        // the lecture export: «… عند نقطة McBurney.» — the full stop ends the RTL sentence (left of the term)
        await doc.emulateMedia({ media: 'screen' });
        await doc.setContent(src);
        const line = doc.locator('p', { hasText: 'عند نقطة McBurney' }).first();
        await expect(line).toContainText('عند نقطة McBurney.');
        await expectDrawnLeftToRight(line, 'McBurney');
        await expectReadBefore(line, 'نقطة', 'McBurney', 'نقطة McBurney.');
        await expectReadBefore(line, 'McBurney', '.', 'McBurney.');
      } finally {
        await doc.close();
      }
    });
  });
});
