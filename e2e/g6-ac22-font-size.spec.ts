// G6 / AC-22 — «تغيير الكتاب» (§60): changing the font size (or updating the Study Book) never drops the owner's
// notes on a different paragraph; what cannot be re-anchored is kept for review. REAL app + server, Golden Set.
//  * Font size: the owner's highlight, ink and page note are made at 100 %, the text size is raised to 150 % in
//    Settings, and everything is checked again — on screen against the very words it was made on, and on the server
//    (unchanged rows, nothing flagged for re-anchoring). The same for a note on a reflowing DOCX paragraph.
//  * Study Book update: generating a Study Book needs the AI provider, which has no key here — the reader says so
//    (the view is disabled with the server's reason). The update path itself (regeneration with notes on its
//    paragraphs) is verified with the test-only scripted provider in apps/server/test/acceptance/g6-ac22.test.ts.
import type { AnnotationsByTargetsResponse, FeatureStatus, StudyBookStatusResponse } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, setupOwner, test, type E2eApi } from './support';
import { expectInkOnWord, inkBox, mouseStroke, pickInkTool, wordBox } from './g6-helpers';
import type { Page } from '@playwright/test';

const LINE = 'Anorexia and nausea are common; vomiting usually follows the onset of pain.';

async function setTextScale(page: Page, label: '100%' | '150%') {
  await page.goto('/settings');
  const group = page.getByRole('radiogroup', { name: 'حجم النص' });
  await group.getByRole('radio', { name: label }).click();
  await expect(group.getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ml-text-scale').trim())).toBe(label === '150%' ? '1.5' : '1');
}

async function openRailTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name: new RegExp(name) });
  if (!(await tab.isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
  await tab.click();
}

async function selectText(page: Page, root: ReturnType<Page['locator']>) {
  await root.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = document.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.mouse.move(1, 1);
  await page.dispatchEvent('body', 'pointerup');
  await expect(page.getByRole('toolbar', { name: 'أدوات النص المحدد' })).toBeVisible();
}

const rects = (e: Element) => {
  const r = e.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

async function pageAnnotations(api: E2eApi, pageId: string) {
  return (await api.get<AnnotationsByTargetsResponse>(`/api/annotations/by-targets?keys=${encodeURIComponent(`source_page:${pageId}`)}`)).annotations.filter((a) => !a.deleted_at);
}

test.describe('G6 AC-22 font size and Study Book updates never move the owner\'s notes', () => {
  test.afterEach(async ({ page }) => {
    // the text size is an owner setting (synced): put it back for the other specs on this server
    await setTextScale(page, '100%').catch(() => undefined);
  });

  test('PDF page: highlight, ink and note made at 100 % are on the same words at 150 %; nothing re-anchored', async ({ page, api }, testInfo) => {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `G6 AC-22 ${testInfo.project.name}` });
    expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');
    const pageId = (await api.get<{ pages: Array<{ id: string; page_index: number }> }>(`/api/sources/${up.source_id}/versions/${up.version_id}/pages`)).pages.find((p) => p.page_index === 0)!.id;
    await setTextScale(page, '100%');
    await openWorkspace(page, up.source_id, { pageIndex: 0 });
    const layer = page.locator('.wk-page[data-page-index="0"] .wk-textlayer');
    const line = layer.locator('span').filter({ hasText: LINE }).first();
    await expect(line).toBeAttached({ timeout: 30_000 });
    await line.scrollIntoViewIfNeeded();

    await test.step('at 100 %: highlight a printed line, attach a note to it, write over «McBurney»', async () => {
      await selectText(page, line);
      await page.getByRole('toolbar', { name: 'أدوات النص المحدد' }).getByRole('button', { name: 'تظليل' }).click();
      await expect(page.locator('.wk-page[data-page-index="0"] .wk-mark--highlight').first()).toBeVisible();
      await selectText(page, line);
      await page.getByRole('toolbar', { name: 'أدوات النص المحدد' }).getByRole('button', { name: 'ملاحظة' }).click();
      await page.getByLabel(/ملاحظة جديدة/).fill('ملاحظتي على سطر الأعراض');
      await page.getByRole('button', { name: 'تم', exact: true }).click();
      // phones: the study rail is a sheet over the book — close it before writing on the page
      const sheetClose = page.getByRole('dialog').getByRole('button', { name: 'إغلاق', exact: true });
      if (await sheetClose.isVisible()) await sheetClose.click();
      await pickInkTool(page, /^القلم/);
      const w = await wordBox(page, 0, /^McBurney$/);
      await mouseStroke(page, { x: w.left + (w.right - w.left) * 0.15, y: (w.top + w.bottom) / 2 }, { x: w.left + (w.right - w.left) * 0.85, y: (w.top + w.bottom) / 2 });
      await pickInkTool(page, /^(تحديد النص|اليد)/).catch(() => undefined);
      await expect.poll(async () => (await pageAnnotations(api, pageId)).map((a) => a.kind).sort(), { timeout: 30_000 }).toEqual(['ink', 'text_highlight']);
      await expect.poll(async () => (await api.get<{ notes: unknown[] }>(`/api/annotations/notes?source_id=${up.source_id}`)).notes.length, { timeout: 30_000 }).toBe(1);
    });
    const before = await pageAnnotations(api, pageId);
    const notesBefore = (await api.get<{ notes: Array<{ id: string; anchor: unknown; rev: number }> }>(`/api/annotations/notes?source_id=${up.source_id}`)).notes;

    await test.step('raise the text size to 150 % in Settings', async () => {
      await setTextScale(page, '150%');
      await screenshot(page, testInfo, 'g6-ac22-settings-150');
    });

    await test.step('back in the reader at 150 %: the highlight covers the same printed line, the ink is on «McBurney»', async () => {
      await openWorkspace(page, up.source_id, { pageIndex: 0 });
      expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeCloseTo(24, 0);
      await line.scrollIntoViewIfNeeded();
      const mark = page.locator('.wk-page[data-page-index="0"] .wk-mark--highlight').first();
      await expect(mark).toBeVisible({ timeout: 30_000 });
      const m = await mark.evaluate(rects);
      const l = await line.evaluate(rects);
      // the mark sits on the line (same vertical band, inside its horizontal extent)
      expect(Math.abs((m.top + m.bottom) / 2 - (l.top + l.bottom) / 2)).toBeLessThan((l.bottom - l.top) / 2);
      expect(m.left).toBeGreaterThanOrEqual(l.left - 4);
      expect(m.right).toBeLessThanOrEqual(l.right + 4);
      await expect.poll(() => inkBox(page, 0).then((b) => b !== null), { timeout: 30_000 }).toBe(true);
      await expectInkOnWord(page, 0, await wordBox(page, 0, /^McBurney$/), '150 %');
      await screenshot(page, testInfo, 'g6-ac22-reader-150');
    });

    await test.step('the note is still on this page with the quote of that line', async () => {
      await openRailTab(page, 'ملاحظاتي');
      const note = page.locator('.wk-note').filter({ hasText: 'ملاحظتي على سطر الأعراض' }).first();
      await expect(note).toBeVisible();
      await expect(note).toContainText('Anorexia and nausea are common');
      await expect(page.getByRole('radio', { name: /إعادة ربط/ })).not.toHaveText(/\(\d+\)/); // nothing to re-anchor
    });

    await test.step('server: annotations and note unchanged (same rows, same revisions), none flagged for re-anchoring', async () => {
      const after = await pageAnnotations(api, pageId);
      expect(after.map((a) => ({ id: a.id, rev: a.rev, data: a.data, anchor_status: a.anchor_status }))).toEqual(before.map((a) => ({ id: a.id, rev: a.rev, data: a.data, anchor_status: 'ok' })));
      const notesAfter = (await api.get<{ notes: Array<{ id: string; anchor: unknown; rev: number }> }>(`/api/annotations/notes?source_id=${up.source_id}`)).notes;
      expect(notesAfter.map((n) => ({ id: n.id, anchor: n.anchor, rev: n.rev }))).toEqual(notesBefore.map((n) => ({ id: n.id, anchor: n.anchor, rev: n.rev })));
      const re = await api.get<{ items: unknown[] }>(`/api/annotations/needs-reanchor?source_id=${up.source_id}`);
      expect(re.items).toEqual([]);
    });
  });

  test('reflowing DOCX paragraph: a note made on a paragraph keeps its quote of that paragraph at 150 %', async ({ page, api }, testInfo) => {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await api.uploadFixture(course.id, 'lecture_notes_shock.docx', { sourceType: 'lecture', onDuplicate: 'create', title: `G6 AC-22 docx ${testInfo.project.name}` });
    expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');
    await setTextScale(page, '100%');
    await openWorkspace(page, up.source_id);
    const block = page.locator('.wk-textsheet__block').filter({ hasText: /[A-Za-z؀-ۿ]{4}/ }).nth(1);
    await expect(block).toBeVisible({ timeout: 30_000 });
    const regionId = await block.getAttribute('data-region-id');
    const paragraph = ((await block.textContent()) ?? '').trim();
    const heightBefore = await block.evaluate((e) => e.getBoundingClientRect().height);

    await selectText(page, block.locator('.ml-rt').first());
    await page.getByRole('toolbar', { name: 'أدوات النص المحدد' }).getByRole('button', { name: 'ملاحظة' }).click();
    await page.getByLabel(/ملاحظة جديدة/).fill('ملاحظتي على هذه الفقرة');
    await page.getByRole('button', { name: 'تم', exact: true }).click();
    await expect.poll(async () => (await api.get<{ notes: unknown[] }>(`/api/annotations/notes?source_id=${up.source_id}`)).notes.length, { timeout: 30_000 }).toBe(1);
    const [n0] = (await api.get<{ notes: Array<{ id: string; anchor: { page_id?: string; quote?: { exact?: string } } | null; rev: number }> }>(`/api/annotations/notes?source_id=${up.source_id}`)).notes;

    await setTextScale(page, '150%');
    await openWorkspace(page, up.source_id);
    const same = page.locator(`[data-region-id="${regionId}"]`);
    await expect(same).toBeVisible({ timeout: 30_000 });
    // the paragraph really reflowed (taller at the larger text size) and still holds the quoted text
    expect(await same.evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThan(heightBefore);
    expect(((await same.textContent()) ?? '').trim()).toBe(paragraph);
    await openRailTab(page, 'ملاحظاتي');
    const note = page.locator('.wk-note').filter({ hasText: 'ملاحظتي على هذه الفقرة' }).first();
    await expect(note).toBeVisible();
    const [n1] = (await api.get<{ notes: Array<{ id: string; anchor: unknown; rev: number }> }>(`/api/annotations/notes?source_id=${up.source_id}`)).notes;
    expect(n1).toMatchObject({ id: n0!.id, rev: n0!.rev, anchor: n0!.anchor });
    expect(paragraph.replace(/\s+/g, ' ')).toContain((n0!.anchor?.quote?.exact ?? paragraph).replace(/\s+/g, ' ').slice(0, 40));
    await screenshot(page, testInfo, 'g6-ac22-docx-150');
  });

  test('Study Book update cannot run here (no AI key): the reader and the API say so honestly', async ({ page, api }, testInfo) => {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `G6 AC-22 book ${testInfo.project.name}` });
    expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');
    const st = await api.get<StudyBookStatusResponse>(`/api/studybook/books?source_id=${up.source_id}`);
    expect(st.book).toBeNull();
    expect(st.can_generate.available).toBe(false);
    expect(st.can_generate.reason_ar).toBeTruthy();
    const caps = await api.get<{ features: Record<string, FeatureStatus> }>('/api/capabilities');
    expect(caps.features['ai.study_book']?.state).toBe('requires_configuration');
    await openWorkspace(page, up.source_id);
    const trigger = page.getByRole('button', { name: /^(المحاضرة الأصلية|خيارات القراءة)$/ }).first();
    await trigger.click();
    const item = page.getByRole('menuitem', { name: /كتاب الدراسة/ }).first();
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('aria-disabled', 'true');
  });
});
