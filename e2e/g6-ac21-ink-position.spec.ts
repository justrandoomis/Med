// G6 / AC-21 — «الحبر والموقع» (§60): writing over a source region stays in the same place after zoom, rotation,
// closing and reopening the file, and on another device. REAL app + server, Golden Set lecture. The ink is written
// with the reader's pen tool by MOUSE (the only input here — never reported as a pen, see AC-28) across the printed
// word «McBurney» of ص 11 (the end of the Arabic sentence), and its painted pixels are compared with that word's box
// in the text layer — both measured on screen, so every zoom / rotation / device is checked against the source itself.
// A second stroke is written while the page is zoomed AND rotated, and must land on its word on the other device.
// The stored stroke is also checked on the server: normalized page coordinates inside the processed region of that
// line (the source region), unrotated page space.
import type { AnnotationDTO, AnnotationsByTargetsResponse, InkData, PageRegionsResponse } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, serverFor, setupOwner, test, waitForWorkspace, type E2eApi } from './support';
import { expectInkOnWord, inkBox, mouseStroke, pickInkTool, viewMenuItem, wordBox, type Box } from './g6-helpers';
import { ACCEPTANCE_DIR, uploadFile } from './g1-helpers';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/** a printed line far from «McBurney» (≈ 115 pt above it), for the stroke written while zoomed and rotated */
const LINE = 'Learning objectives';

async function zoomIn(page: Page) {
  const btn = page.getByRole('group', { name: 'التكبير' }).getByRole('button', { name: 'تكبير', exact: true });
  if (await btn.isVisible()) await btn.click();
  else await viewMenuItem(page, 'تكبير');
}

/** the word's span, scrolled into view; once the ink is painted, the stroke must lie on the word */
async function expectStrokeOn(page: Page, word: string | RegExp, label: string): Promise<Box> {
  const span = page.locator('.wk-page[data-page-index="0"] .wk-textlayer span').filter({ hasText: word }).first();
  await expect(span).toBeAttached({ timeout: 30_000 });
  await span.scrollIntoViewIfNeeded();
  await expect.poll(() => inkBox(page, 0).then((b) => b !== null), { timeout: 30_000, message: `${label}: ink painted` }).toBe(true);
  await page.waitForTimeout(300); // layout settled (the canvas repaints after a zoom / rotation)
  const w = await span.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  await expectInkOnWord(page, 0, w, label);
  return w;
}

/** a stroke along the middle of a word's on-screen box, along its long side (text runs vertically when rotated) */
async function strokeAcross(page: Page, b: Box, from = 0.15, to = 0.85) {
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  if (w >= h) await mouseStroke(page, { x: b.left + w * from, y: b.top + h / 2 }, { x: b.left + w * to, y: b.top + h / 2 });
  else await mouseStroke(page, { x: b.left + w / 2, y: b.top + h * from }, { x: b.left + w / 2, y: b.top + h * to });
}

async function inkOnServer(api: E2eApi, pageId: string): Promise<AnnotationDTO[]> {
  const r = await api.get<AnnotationsByTargetsResponse>(`/api/annotations/by-targets?keys=${encodeURIComponent(`source_page:${pageId}`)}`);
  return r.annotations.filter((a) => a.kind === 'ink' && !a.deleted_at);
}

test.describe('G6 AC-21 ink stays on its source region', () => {
  test('pen stroke over «McBurney»: same place after zoom, rotation, close/reopen, reload and on another device', async ({ page, api, browser }, testInfo) => {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `G6 AC-21 ${testInfo.project.name}` });
    expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');
    const pages = (await api.get<{ pages: Array<{ id: string; page_index: number }> }>(`/api/sources/${up.source_id}/versions/${up.version_id}/pages`)).pages;
    const pageId = pages.find((p) => p.page_index === 0)!.id;
    await openWorkspace(page, up.source_id, { pageIndex: 0 });
    const mcb = /^McBurney$/;

    let expectedX: [number, number] = [0, 0];
    await test.step('write across the printed word with the pen tool (mouse)', async () => {
      const span = page.locator('.wk-page[data-page-index="0"] .wk-textlayer span').filter({ hasText: mcb }).first();
      await expect(span).toBeAttached({ timeout: 30_000 });
      await span.scrollIntoViewIfNeeded();
      await pickInkTool(page, /^القلم/);
      const b = await wordBox(page, 0, mcb); // the word ending the Arabic line, not «(McBurney's point).» above it
      const layers = await page.locator('.wk-page[data-page-index="0"] .wk-layers').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, width: r.width };
      });
      expectedX = [(b.left - layers.left) / layers.width, (b.right - layers.left) / layers.width];
      await strokeAcross(page, b);
      await expectStrokeOn(page, mcb, 'as written');
      await screenshot(page, testInfo, 'g6-ac21-written');
    });

    await test.step('stored on the server in normalized page space, inside the processed region of that line', async () => {
      await expect.poll(async () => (await inkOnServer(api, pageId)).length, { timeout: 30_000 }).toBe(1);
      const [a] = await inkOnServer(api, pageId);
      const d = a!.data as InkData;
      expect(a!.anchor).toMatchObject({ type: 'page', page_id: pageId, page_index: 0, space: 'page_norm' });
      const xs = d.points.map((p) => p[0]);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(expectedX[0] - 0.005);
      expect(Math.max(...xs)).toBeLessThanOrEqual(expectedX[1] + 0.005);
      const { regions } = await api.get<PageRegionsResponse>(`/api/sources/pages/${pageId}/regions`);
      const region = regions.find((r) => (r.text ?? '').includes('McBurney') && /[؀-ۿ]/.test(r.text ?? ''))!;
      expect(region?.bbox, 'the Arabic line region with «McBurney»').toBeTruthy();
      const bb = region.bbox!;
      for (const [x, y] of d.points) {
        expect(x).toBeGreaterThanOrEqual(bb.x - 0.005);
        expect(x).toBeLessThanOrEqual(bb.x + bb.w + 0.005);
        expect(y).toBeGreaterThanOrEqual(bb.y - 0.01);
        expect(y).toBeLessThanOrEqual(bb.y + bb.h + 0.01);
      }
      // what the input really was (AC-28): a mouse, no pressure, no tilt
      expect(a!.input).toMatchObject({ pointer_type: 'mouse', pressure: false });
      expect(d.pressure_available).toBe(false);
      expect(d.points.every((p) => p.length === 3)).toBe(true);
    });

    await test.step('zoom in twice → still over the word', async () => {
      await zoomIn(page);
      await zoomIn(page);
      await expectStrokeOn(page, mcb, 'zoomed');
    });

    await test.step('rotate the view 90° → still over the word (which now runs vertically)', async () => {
      await viewMenuItem(page, 'تدوير مع عقارب الساعة');
      await expect(page.locator('.wk-page[data-page-index="0"] .wk-layers')).toHaveAttribute('data-rot', '90');
      const word = await expectStrokeOn(page, mcb, 'rotated 90°');
      expect(word.bottom - word.top).toBeGreaterThan(word.right - word.left); // the word really is vertical now
      await screenshot(page, testInfo, 'g6-ac21-rotated');
    });

    await test.step('while zoomed and rotated, write a second stroke along another printed line', async () => {
      const line = page.locator('.wk-page[data-page-index="0"] .wk-textlayer span').filter({ hasText: LINE }).first();
      await line.scrollIntoViewIfNeeded();
      const b = await wordBox(page, 0, LINE);
      await strokeAcross(page, b, 0.15, 0.85);
      await expect.poll(async () => (await inkOnServer(api, pageId)).length, { timeout: 30_000 }).toBe(2);
      await pickInkTool(page, /^(تحديد النص|اليد)/).catch(() => undefined);
    });

    await test.step('close the file and open it again → both strokes on their words', async () => {
      await page.goto('/library');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await openWorkspace(page, up.source_id);
      await expectStrokeOn(page, mcb, 'reopened (first stroke)');
      await expectStrokeOn(page, LINE, 'reopened (second stroke)');
    });

    await test.step('reload → still there and in place (read from this device)', async () => {
      await page.reload();
      await waitForWorkspace(page);
      await expectStrokeOn(page, mcb, 'reloaded (first stroke)');
      await expectStrokeOn(page, LINE, 'reloaded (second stroke)');
    });

    await test.step('another device (other screen size and pixel density, empty local storage) → both strokes on their words', async () => {
      const other = testInfo.project.name === 'phone' ? { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
      const ctx2 = await browser.newContext({ ...other, baseURL: serverFor(testInfo.project.name).baseURL, locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block' });
      const problems: string[] = [];
      try {
        const p2 = await ctx2.newPage();
        p2.on('pageerror', (e) => problems.push(e.message));
        p2.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
        await setupOwner(p2.request);
        await openWorkspace(p2, up.source_id, { pageIndex: 0 });
        await expectStrokeOn(p2, mcb, 'other device (first stroke)');
        // the stroke written zoomed + rotated on the first device lies on its line here
        await expectStrokeOn(p2, LINE, 'other device (second stroke, written rotated + zoomed)');
        // whatever rotation the synced reading session brought along, turn this device's view back upright and check again
        const layers2 = p2.locator('.wk-page[data-page-index="0"] .wk-layers');
        for (let i = 0; i < 4 && (await layers2.getAttribute('data-rot')) !== '0'; i++) await viewMenuItem(p2, 'تدوير عكس عقارب الساعة');
        await expect(layers2).toHaveAttribute('data-rot', '0');
        await expectStrokeOn(p2, mcb, 'other device, upright (first stroke)');
        await expectStrokeOn(p2, LINE, 'other device, upright (second stroke)');
        await p2.screenshot({ path: `e2e/.artifacts/screenshots/${testInfo.project.name}/g6-ac21-other-device.png` });
      } finally {
        await ctx2.close();
      }
      expect(problems, 'console errors on the second device').toEqual([]);
    });
  });

  test('a page with an intrinsic /Rotate 90: the stroke stays on its word upright, view-rotated back, after reload and on another device', async ({ page, api, browser }, testInfo) => {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g6_rotated_page.pdf'), { sourceType: 'lecture', title: `G6 AC-21 rotated ${testInfo.project.name}` });
    expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');
    const pages = (await api.get<{ pages: Array<{ id: string; page_index: number }> }>(`/api/sources/${up.source_id}/versions/${up.version_id}/pages`)).pages;
    const pageId = pages.find((p) => p.page_index === 0)!.id;
    await openWorkspace(page, up.source_id, { pageIndex: 0 });
    const mcb = /^McBurney$/;
    const layers = page.locator('.wk-page[data-page-index="0"] .wk-layers');
    await expect(layers).toHaveAttribute('data-rot', '90'); // shown turned, as every viewer shows it

    await test.step('write along the (vertical) word', async () => {
      const span = page.locator('.wk-page[data-page-index="0"] .wk-textlayer span').filter({ hasText: mcb }).first();
      await expect(span).toBeAttached({ timeout: 30_000 });
      await span.scrollIntoViewIfNeeded();
      await pickInkTool(page, /^القلم/);
      const b = await wordBox(page, 0, mcb);
      expect(b.bottom - b.top).toBeGreaterThan(b.right - b.left);
      await strokeAcross(page, b);
      await expectStrokeOn(page, mcb, 'written on the /Rotate page');
      await pickInkTool(page, /^(تحديد النص|اليد)/).catch(() => undefined);
    });

    await test.step('stored in UNROTATED page space, inside the processed region holding the word (regions are unrotated too)', async () => {
      await expect.poll(async () => (await inkOnServer(api, pageId)).length, { timeout: 30_000 }).toBe(1);
      const d = (await inkOnServer(api, pageId))[0]!.data as InkData;
      const { regions } = await api.get<PageRegionsResponse>(`/api/sources/pages/${pageId}/regions`);
      // NOTE (open finding, processing): on a page whose /Rotate turns its text sideways, layout runs in display space
      // where the text is vertical, so this line is stored as several regions («McBurney» alone) — see docs/ACCEPTANCE.md G6
      const bb = regions.find((r) => (r.text ?? '').includes('McBurney') && !(r.text ?? '').includes("McBurney's"))!.bbox!;
      for (const [x, y] of d.points) {
        expect(x).toBeGreaterThanOrEqual(bb.x - 0.005);
        expect(x).toBeLessThanOrEqual(bb.x + bb.w + 0.005);
        expect(y).toBeGreaterThanOrEqual(bb.y - 0.01);
        expect(y).toBeLessThanOrEqual(bb.y + bb.h + 0.01);
      }
    });

    await test.step('view-rotate back to upright → on the word', async () => {
      await viewMenuItem(page, 'تدوير عكس عقارب الساعة');
      await expect(layers).toHaveAttribute('data-rot', '0');
      await expectStrokeOn(page, mcb, 'upright');
    });

    await test.step('reload → on the word', async () => {
      await page.reload();
      await waitForWorkspace(page);
      await expectStrokeOn(page, mcb, 'reloaded');
    });

    await test.step('another device → on the word', async () => {
      const ctx2 = await browser.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true, baseURL: serverFor(testInfo.project.name).baseURL, locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block' });
      try {
        const p2 = await ctx2.newPage();
        await setupOwner(p2.request);
        await openWorkspace(p2, up.source_id, { pageIndex: 0 });
        await expectStrokeOn(p2, mcb, 'other device (tablet size)');
      } finally {
        await ctx2.close();
      }
    });
  });
});
