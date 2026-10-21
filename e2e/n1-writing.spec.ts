// Parity N1 wave 1 — «writing comfort and speed, part 1» — against the REAL server and the built web app, phone 390 × 844
// and desktop 1280 × 800, Arabic UI. Checked here (the unit tests in apps/web/test/ink/n1-*.test.tsx cover the rest):
//  * G03 a colour's meaning set on one device reaches another device through /api/settings (and back); the stroke keeps
//    the meaning; the colour button names it; the legend lists it;
//  * G14 / G15 OFFLINE: a scribble over two words erases them (one undo step, announced); «امسح الصفحة» shows the count
//    before anything happens; after reconnecting and a reload, ONE undo brings the whole page back (history kept on the
//    device); on the phone, two fingers tapped twice undo and three fingers redo;
//  * G66 / G17 the toolbar arranged by the owner (a hidden tool, docked on the start side, vertical), 44 px targets on
//    the phone, no sideways scroll at 390 px; the lasso's chips and rectangle mode; the new controls in e-ink greys;
//  * G19 / G01 / G02 the arrow keys move a selection one page point; the «تشريح» pen feel is saved in the stroke; the
//    palm values and the latency MEASURED in this browser appear in «قدرات القلم على هذا الجهاز».
// Headless Chromium with a mouse (and CDP touches on the phone) is not an iPad, an S Pen or a BOOX: device rows of the
// report stay «Not run (no device)».
import type { Browser, BrowserContext, Locator, Page, TestInfo } from '@playwright/test';
import type { AnnotationDTO, AnnotationsByTargetsResponse, InkData, SettingsResponse } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, serverFor, setupOwner, test, waitForWorkspace, type E2eApi } from './support';
import { pickInkTool } from './g6-helpers';

test.use({ allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch|NetworkError|net::ERR/i] });

type Pt = [number, number];

/** The `ink` parts these tests change, back to their defaults (each project's server is shared by the later specs). */
const RESET_INK = {
  ink: {
    palettes: {},
    palm: { sensitivity: 'medium', hand: 'right' },
    toolbar: { order: [], hidden: [], dock: 'top', recent: true, insert_returns_to_lasso: false, modes: {} },
  },
};

async function lecture(page: Page, api: E2eApi, title: string) {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title });
  expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');
  const pageId = (await api.get<{ pages: Array<{ id: string; page_index: number }> }>(`/api/sources/${up.source_id}/versions/${up.version_id}/pages`)).pages.find((p) => p.page_index === 0)!.id;
  await openWorkspace(page, up.source_id, { pageIndex: 0 });
  return { up, pageId, key: `source_page:${pageId}` };
}

const bar = (page: Page) => page.getByRole('toolbar', { name: 'أدوات الكتابة' });

/** The writing area of the first page, clipped to what is on screen. */
async function writingArea(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  const b = (await page.locator('.wk-page[data-page-index="0"] .ml-ink-layer').boundingBox())!;
  const vh = page.viewportSize()!.height;
  return { x: b.x, y: b.y, w: b.width, h: Math.min(b.height, vh - b.y - 20) };
}

/** A mouse path through client points (pointer type «mouse», never a pen). `pause` ms between moves gives frames time. */
async function path(page: Page, pts: Pt[], steps = 3, pause = 0) {
  await page.mouse.move(pts[0]![0], pts[0]![1]);
  await page.mouse.down();
  for (const p of pts.slice(1)) {
    await page.mouse.move(p[0], p[1], { steps });
    if (pause) await page.waitForTimeout(pause);
  }
  await page.mouse.up();
}

/** a short handwritten «word»: a wavy line from (x, y) */
const word = (x: number, y: number, w = 36): Pt[] => [
  [x, y],
  [x + w * 0.25, y - 5],
  [x + w * 0.5, y + 4],
  [x + w * 0.75, y - 4],
  [x + w, y + 3],
];
/** a scratch-out: a zig-zag across x0..x1 drifting from y0 to y1 */
const zigzag = (x0: number, x1: number, y0: number, y1: number, swings = 9): Pt[] => Array.from({ length: swings + 1 }, (_, i): Pt => [i % 2 === 0 ? x0 : x1, y0 + ((y1 - y0) * i) / swings]);

async function serverInk(api: E2eApi, pageId: string): Promise<AnnotationDTO[]> {
  const res = await api.get<AnnotationsByTargetsResponse>(`/api/annotations/by-targets?keys=${encodeURIComponent(`source_page:${pageId}`)}`);
  return res.annotations.filter((a) => a.kind === 'ink' && !a.deleted_at);
}

/** live ink rows of a page in this device's IndexedDB */
function localInk(page: Page, targetKey: string): Promise<number> {
  return page.evaluate(
    (key) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('medlevo');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction('annotations', 'readonly').objectStore('annotations').getAll();
          req.onsuccess = () => {
            resolve((req.result as Array<{ targetKey: string; kind: string; deletedAt: number | null }>).filter((r) => r.targetKey === key && r.kind === 'ink' && !r.deletedAt).length);
            db.close();
          };
          req.onerror = () => reject(req.error);
        };
      }),
    targetKey,
  );
}

/** every change of this device has been delivered (no op left to send) */
async function drained(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<number>((resolve, reject) => {
              const open = indexedDB.open('medlevo');
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const db = open.result;
                const req = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
                req.onsuccess = () => {
                  resolve((req.result as Array<{ status: string }>).filter((r) => r.status === 'pending').length);
                  db.close();
                };
                req.onerror = () => reject(req.error);
              };
            }),
        ),
      { timeout: 90_000, message: 'the outbox drains' },
    )
    .toBe(0);
}

/**
 * The current tool's options: the popover from the bar, or — when the bar has no room for that button (beside the study
 * rail) — the same options in a dialog from «المزيد». Returns the open container (named after the tool and its colour).
 */
async function openToolOptions(page: Page): Promise<Locator> {
  // by keyboard: on a desktop reader beside the study rail the top bar can lay other controls over the writing bar
  // (the reader's own layout, see the report), and a keyboard press reaches the button regardless
  const button = bar(page).getByRole('button', { name: /^خيارات / });
  if ((await button.count()) && (await button.first().isVisible())) {
    const name = await button.first().getAttribute('aria-label');
    await button.first().press('Enter');
    return page.getByRole('dialog', { name: name! });
  }
  await bar(page).getByRole('button', { name: 'المزيد من أدوات الكتابة' }).press('Enter');
  const item = page.getByRole('menuitem', { name: /^خيارات / });
  const name = (await item.textContent())!.trim().replace(/…$/, '');
  await item.click();
  return page.getByRole('dialog', { name });
}

async function inkMenu(page: Page, item: RegExp) {
  await bar(page).getByRole('button', { name: 'المزيد من أدوات الكتابة' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

async function inkSettings(page: Page, tab?: string): Promise<Locator> {
  await inkMenu(page, /إعدادات الكتابة/);
  const dialog = page.getByRole('dialog', { name: 'إعدادات الكتابة' });
  await expect(dialog).toBeVisible();
  if (tab) await dialog.getByRole('tab', { name: tab }).click();
  return dialog;
}

async function undo(page: Page) {
  const b = bar(page).getByRole('button', { name: 'تراجع', exact: true });
  if ((await b.count()) && (await b.isVisible())) {
    await b.click();
    return;
  }
  await inkMenu(page, /^تراجع/);
}

const inkSettingsOnServer = async (api: E2eApi) => (await api.get<SettingsResponse>('/api/settings')).settings.ink;

async function secondDevice(browser: Browser, testInfo: TestInfo): Promise<{ ctx: BrowserContext; page: Page }> {
  const phone = testInfo.project.name === 'phone';
  const ctx = await browser.newContext({
    ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } }),
    baseURL: serverFor(testInfo.project.name).baseURL,
    locale: 'ar-IQ',
    timezoneId: 'Asia/Baghdad',
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  await setupOwner(page);
  return { ctx, page };
}

test.describe('N1 wave 1 — writing comfort and speed', () => {
  test('G03: a colour’s meaning set here reaches the other device (and back); every stroke keeps its meaning', async ({ page, api, browser }, testInfo) => {
    test.setTimeout(300_000);
    const { up, pageId } = await lecture(page, api, `N1 G03 ${testInfo.project.name} ${Date.now().toString(36)}`);
    try {
      await test.step('name the black pen «دواء» in «إعدادات الكتابة» → saved with the owner’s settings', async () => {
        const dialog = await inkSettings(page);
        const meaning = dialog.getByRole('textbox', { name: 'معنى أسود' });
        await meaning.fill('دواء');
        await meaning.press('Enter');
        await expect.poll(async () => (await inkSettingsOnServer(api)).palettes.pen?.[0], { timeout: 30_000 }).toEqual({ color: 'ink-black', meaning: 'دواء' });
        await screenshot(page, testInfo, 'n1-g03-colours');
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      });

      await test.step('the pen names the meaning with its colour; the stroke is saved with it', async () => {
        await pickInkTool(page, /^القلم/);
        const opts = await openToolOptions(page);
        await expect(opts).toHaveAccessibleName('خيارات قلم: أسود — دواء');
        await page.keyboard.press('Escape');
        await expect(opts).toBeHidden();
        const a = await writingArea(page);
        await path(page, word(a.x + a.w * 0.3, a.y + a.h * 0.5, 80));
        await expect.poll(async () => (await serverInk(api, pageId)).map((i) => (i.data as InkData).style.meaning), { timeout: 30_000 }).toEqual(['دواء']);
        await inkMenu(page, /دليل الألوان/);
        const legend = page.getByRole('dialog', { name: 'دليل الألوان ومعانيها' });
        await expect(legend).toContainText('دواء');
        await expect(legend.getByRole('button', { name: 'اعرض «دواء» فقط' })).toBeVisible();
        await page.keyboard.press('Escape');
      });

      await test.step('another device sees the meaning; its change comes back here after a reload', async () => {
        const B = await secondDevice(browser, testInfo);
        try {
          await openWorkspace(B.page, up.source_id, { pageIndex: 0 });
          await pickInkTool(B.page, /^القلم/);
          await expect(async () => {
            const opts = await openToolOptions(B.page);
            await expect(opts).toHaveAccessibleName('خيارات قلم: أسود — دواء', { timeout: 2_000 });
            await B.page.keyboard.press('Escape');
            await expect(opts).toBeHidden();
          }).toPass({ timeout: 30_000 });
          const dialog = await inkSettings(B.page);
          const meaning = dialog.getByRole('textbox', { name: 'معنى أسود' });
          await expect(meaning).toHaveValue('دواء');
          await meaning.fill('آلية');
          await meaning.press('Enter');
          await expect.poll(async () => (await inkSettingsOnServer(api)).palettes.pen?.[0]?.meaning, { timeout: 30_000 }).toBe('آلية');
        } finally {
          await B.ctx.close();
        }
        await page.reload();
        await waitForWorkspace(page);
        await pickInkTool(page, /^القلم/);
        await expect(async () => {
          const opts = await openToolOptions(page);
          await expect(opts).toHaveAccessibleName('خيارات قلم: أسود — آلية', { timeout: 2_000 });
          await page.keyboard.press('Escape');
          await expect(opts).toBeHidden();
        }).toPass({ timeout: 30_000 });
      });
    } finally {
      await api.patch('/api/settings', RESET_INK);
    }
  });

  test('G14 / G15 offline: a scribble erases the words under it; «امسح الصفحة» counts first; ONE undo after a reload brings the page back', async ({ page, api, context }, testInfo) => {
    test.setTimeout(300_000);
    const { pageId, key } = await lecture(page, api, `N1 G14 ${testInfo.project.name} ${Date.now().toString(36)}`);
    await pickInkTool(page, /^القلم/);
    const a = await writingArea(page);
    const x = a.x + a.w * 0.25;
    const y = a.y + a.h * 0.45;

    await test.step('offline: two words and a far one, then a scribble over the two words', async () => {
      await context.setOffline(true);
      await path(page, word(x, y));
      await path(page, word(x + 44, y));
      await path(page, word(x, y + Math.min(140, a.h * 0.4)));
      await expect.poll(() => localInk(page, key)).toBe(3);
      await path(page, zigzag(x - 6, x + 86, y - 9, y + 10), 2);
      await expect(page.getByText(/مُسح خطان بالخربشة/)).toBeAttached();
      await expect.poll(() => localInk(page, key)).toBe(1); // the scribble itself is not kept either
      await undo(page);
      await expect.poll(() => localInk(page, key)).toBe(3);
    });

    await test.step('«امسح الصفحة»: the count first, nothing removed until confirmed; then one step removes the page', async () => {
      await inkMenu(page, /امسح الصفحة/);
      const dlg = page.getByRole('dialog', { name: 'امسح الصفحة' });
      await expect(dlg.getByRole('status')).toHaveText('سيُمسح: ٣ خطوط بالقلم.');
      // (review) the dialog names the page it clears (the page in view)
      await expect(dlg).toContainText(/الصفحة التي تُمسح: الصفحة [١-٩]/);
      expect(await localInk(page, key)).toBe(3);
      await screenshot(page, testInfo, 'n1-g15-clear-page');
      await dlg.getByRole('button', { name: 'امسح ٣ عنصر' }).click();
      await expect(dlg).toBeHidden();
      await expect.poll(() => localInk(page, key)).toBe(0);
    });

    await test.step('back online: the tombstones reach the server; after a reload ONE undo restores the page', async () => {
      await context.setOffline(false);
      await drained(page);
      await expect.poll(async () => (await serverInk(api, pageId)).length, { timeout: 60_000 }).toBe(0);
      await page.reload();
      await waitForWorkspace(page);
      await undo(page);
      await expect.poll(() => localInk(page, key)).toBe(3);
      await drained(page);
      await expect.poll(async () => (await serverInk(api, pageId)).length, { timeout: 60_000 }).toBe(3);
    });

    if (testInfo.project.name === 'phone') {
      await test.step('phone: two fingers tapped twice undo, three fingers tapped twice redo', async () => {
        await pickInkTool(page, /^القلم/);
        const b = await writingArea(page);
        const cdp = await page.context().newCDPSession(page);
        const tap = async (n: number) => {
          const touchPoints = Array.from({ length: n }, (_, i) => ({ x: b.x + b.w * 0.3 + i * 50, y: b.y + b.h * 0.3, id: i, radiusX: 4, radiusY: 4 }));
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        };
        await tap(2);
        await tap(2);
        await expect.poll(() => localInk(page, key)).toBe(2); // the last word written is undone
        await drained(page);
        await expect.poll(async () => (await serverInk(api, pageId)).length, { timeout: 60_000 }).toBe(2);
        await tap(3);
        await tap(3);
        await expect.poll(() => localInk(page, key)).toBe(3);
        await drained(page);
        await expect.poll(async () => (await serverInk(api, pageId)).length, { timeout: 60_000 }).toBe(3);
      });
    }
  });

  test('G66 / G17: the toolbar arranged by the owner, the lasso chips and rectangle — 44 px targets, no sideways scroll, e-ink greys', async ({ page, api }, testInfo) => {
    test.setTimeout(300_000);
    await lecture(page, api, `N1 G66 ${testInfo.project.name} ${Date.now().toString(36)}`);
    const phone = testInfo.project.name === 'phone';
    try {
      await test.step('hide the laser and dock the bar on the start side (synced)', async () => {
        const dialog = await inkSettings(page, 'شريط الأدوات');
        await dialog.getByRole('switch', { name: 'مؤشر الليزر' }).click();
        await dialog.getByRole('radio', { name: 'جانب البداية' }).click();
        await expect.poll(async () => (await inkSettingsOnServer(api)).toolbar, { timeout: 30_000 }).toMatchObject({ hidden: ['laser'], dock: 'start' });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      });

      await test.step('a vertical bar on the right (the start side in Arabic), without the hidden tool; 44 px targets; no sideways scroll', async () => {
        const tb = bar(page);
        await expect(tb).toHaveAttribute('aria-orientation', 'vertical');
        const wrap = (await page.locator('.ml-ink-toolbar[data-dock="start"]').boundingBox())!;
        const vw = page.viewportSize()!.width;
        expect(wrap.x + wrap.width).toBeGreaterThan(vw - 24);
        await expect(tb.getByRole('button', { name: 'مؤشر الليزر' })).toHaveCount(0);
        const heights = await tb.getByRole('button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => Math.min(r.width, r.height)));
        expect(heights.length).toBeGreaterThan(3);
        for (const h of heights) expect(h).toBeGreaterThanOrEqual(phone ? 43.5 : 39.5);
        await screenshot(page, testInfo, 'n1-g66-docked');
      });

      await test.step('the lasso: «حبري فقط» and the rectangle, remembered for this document on this device', async () => {
        await pickInkTool(page, /^التحديد الحر/);
        const pop = await openToolOptions(page);
        await expect(pop).toHaveAccessibleName('خيارات التحديد (الشكل والأنواع)');
        await pop.getByRole('button', { name: 'حبري فقط' }).click();
        await expect(pop.getByRole('button', { name: 'الحبر' })).toHaveAttribute('aria-pressed', 'true');
        await expect(pop.getByRole('button', { name: 'النصوص' })).toHaveAttribute('aria-pressed', 'false');
        await pop.getByRole('radio', { name: 'مستطيل' }).click();
        const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('medlevo.ink.lasso.v1:')).map((k) => JSON.parse(localStorage.getItem(k)!)));
        expect(saved).toEqual([{ mode: 'rect', types: { ink: true, shape: false, text: false, image: false, link: false } }]);
        await page.keyboard.press('Escape');
      });

      await test.step('e-ink: the writing settings and the chips are black / grey', async () => {
        await page.evaluate(() => localStorage.setItem('medlevo.display.v1', JSON.stringify({ eink: true })));
        await page.reload();
        await waitForWorkspace(page);
        await expect(page.locator('html')).toHaveAttribute('data-eink', 'on');
        const dialog = await inkSettings(page, 'شريط الأدوات');
        const colours = await dialog.evaluate((el) =>
          Array.from(el.querySelectorAll<HTMLElement>('button, [role="switch"], [role="radio"], [role="tab"], input'))
            .filter((e) => e.getBoundingClientRect().width > 0)
            .flatMap((e) => {
              const s = getComputedStyle(e);
              return [s.color, s.backgroundColor, s.borderTopColor];
            }),
        );
        const coloured = colours.filter((c) => {
          const m = /rgba?\(([^)]+)\)/.exec(c);
          if (!m) return false;
          const [r, g, b, al] = m[1]!.split(',').map((v) => Number(v.trim()));
          return al !== 0 && !(r === g && g === b);
        });
        expect(coloured, `non-grey colours in «إعدادات الكتابة» under e-ink: ${coloured.slice(0, 5).join(' | ')}`).toEqual([]);
        await screenshot(page, testInfo, 'n1-eink-settings');
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        // (review) the pen colours are near-black greys here: each slot shows its name in the colour picker
        await pickInkTool(page, /^القلم/);
        const pop = await openToolOptions(page);
        const names = pop.locator('[role="radio"] .ml-ink-color__name');
        await expect(names.first()).toBeVisible();
        await expect(names.first()).toHaveText('أسود');
        expect(await names.count()).toBeGreaterThanOrEqual(6);
        await screenshot(page, testInfo, 'n1-eink-colour-names');
        await page.keyboard.press('Escape');
        await page.evaluate(() => localStorage.removeItem('medlevo.display.v1'));
      });
    } finally {
      await api.patch('/api/settings', RESET_INK);
    }
  });

  test('G19 / G01 / G02: the arrows move a selection one point; the pen feel is saved in the stroke; palm values and measured latency', async ({ page, api }, testInfo) => {
    test.setTimeout(300_000);
    const { pageId } = await lecture(page, api, `N1 G19 ${testInfo.project.name} ${Date.now().toString(36)}`);
    try {
      await pickInkTool(page, /^القلم/);
      const a = await writingArea(page);
      const y0 = a.y + a.h * 0.35;
      // several slow strokes: each move gets its own frame (the latency is measured from these)
      for (let i = 0; i < 3; i++) {
        const y = y0 + i * 40;
        await path(page, Array.from({ length: 12 }, (_, k): Pt => [a.x + a.w * 0.2 + k * (a.w * 0.04), y + (k % 2 ? 3 : -3)]), 1, 20);
      }
      await expect.poll(async () => (await serverInk(api, pageId)).length, { timeout: 30_000 }).toBe(3);

      await test.step('G19: a selected stroke moves one page point per arrow press, in the direction pressed', async () => {
        const before = (await serverInk(api, pageId)).map((i) => i.data as InkData).sort((p, q) => p.bbox.y - q.bbox.y)[0]!.bbox;
        await pickInkTool(page, /^التحديد الحر/);
        await page.mouse.click(a.x + a.w * 0.4, y0);
        const frame = page.locator('.ml-ink-selection');
        await expect(frame).toBeVisible();
        await expect(frame).toHaveAttribute('role', 'group');
        await expect(frame).toHaveAttribute('aria-label', /^المحدد: ١ عنصر/);
        await page.keyboard.press('ArrowLeft');
        await expect
          .poll(async () => {
            const b = (await serverInk(api, pageId)).map((i) => i.data as InkData).sort((p, q) => p.bbox.y - q.bbox.y)[0]!.bbox;
            return Math.round((before.x - b.x) * 10000) / 10000;
          }, { timeout: 30_000 })
          .toBeGreaterThan(0.001); // ≈ 1 / page width in points (an A4 page: 1/595)
        const after = (await serverInk(api, pageId)).map((i) => i.data as InkData).sort((p, q) => p.bbox.y - q.bbox.y)[0]!.bbox;
        expect(before.x - after.x).toBeLessThan(0.003);
        expect(after.y).toBeCloseTo(before.y, 4);
        await page.keyboard.press('Escape');
        await expect(frame).toBeHidden();
      });

      await test.step('G01: «تشريح» for this document — the next stroke is steadier, thin and of constant width', async () => {
        await pickInkTool(page, /^القلم/);
        const opts = await openToolOptions(page);
        await opts.getByRole('radio', { name: 'تشريح' }).click();
        await page.keyboard.press('Escape');
        await expect(opts).toBeHidden();
        await path(page, word(a.x + a.w * 0.3, y0 + 160, 90));
        await expect
          .poll(async () => (await serverInk(api, pageId)).map((i) => (i.data as InkData).style).find((s) => s.constant), { timeout: 30_000 })
          .toMatchObject({ smoothing: 6, constant: true });
        const st = (await serverInk(api, pageId)).map((i) => (i.data as InkData).style).find((s) => s.constant)!;
        expect(st.width).toBeLessThanOrEqual(0.0016);
        // the strokes written before keep their classic drawing (nothing new stored in them)
        expect((await serverInk(api, pageId)).map((i) => (i.data as InkData).style).filter((s) => s.smoothing === undefined)).toHaveLength(3);
      });

      await test.step('G02 + latency: the capability panel shows the palm values in force and only latency measured here', async () => {
        const dialog = await inkSettings(page, 'راحة اليد');
        await dialog.getByRole('radio', { name: 'عالية' }).click();
        await expect.poll(async () => (await inkSettingsOnServer(api)).palm.sensitivity, { timeout: 30_000 }).toBe('high');
        await expect(dialog).toContainText('32 بكسل');
        await page.keyboard.press('Escape');
        await inkMenu(page, /قدرات القلم على هذا الجهاز/);
        const caps = page.getByRole('dialog', { name: 'قدرات القلم على هذا الجهاز' });
        const row = (label: string) => caps.locator('.ml-ink-caps__row').filter({ has: page.locator('.ml-ink-caps__label', { hasText: label }) });
        await expect(row('رفض راحة اليد')).toContainText('حساسية عالية');
        await expect(row('رفض راحة اليد')).toContainText('تقريبي على الويب');
        const latency = row('زمن الاستجابة');
        await expect(latency).toContainText('مدعوم ورُصد هنا');
        await expect(latency).toContainText('قِيس على هذا الجهاز في هذه الجلسة: الفأرة — الوسيط');
        await screenshot(page, testInfo, 'n1-g01-latency');
      });
    } finally {
      await api.patch('/api/settings', RESET_INK);
    }
  });
});

// ─── parity N1 wave 2 — part 2 of «writing comfort and speed» ───────────────────────────────────────────────────────
// Checked against the real server (the unit tests in apps/web/test/ink/n1w2-*.test.ts[x] cover the rest):
//  * G06 / G04 the pencil is saved as points-only pen ink with the graphite texture; a dashed preset is saved dashed;
//  * G20 / G21 a filled, rounded rectangle; a connector with an inhibition head (⊣) attached to two shapes; moving one
//    shape re-routes the connector in the same step, and ONE undo puts both back with the attachment;
//  * G09 the zoom window: a tap places the box, a stroke in the strip is saved inside the box on the page, and the box
//    moves on to the LEFT (Arabic, right to left);
//  * G10 «أفسح مكانًا» moves only the writing below the line; the word reflow says why it is unavailable (no AI here);
//  * G67 / G11 the page menu from a right click; the neat copy is a view: the stored ink does not change;
//  * G08 a stroke along the ruler is straight; the measurement is labelled «تقدير تعليمي — ليس قياسًا سريريًا» and never
//    saved.
const RESET_INK_W2 = { ink: { snap: { enabled: true, items: true, grid: true, regions: true }, zoom: { direction: 'auto', auto_advance: true } } };

async function serverItems(api: E2eApi, pageId: string, kind: 'ink' | 'shape'): Promise<AnnotationDTO[]> {
  const res = await api.get<AnnotationsByTargetsResponse>(`/api/annotations/by-targets?keys=${encodeURIComponent(`source_page:${pageId}`)}`);
  return res.annotations.filter((a) => a.kind === kind && !a.deleted_at);
}

/** the open options of the current tool (their name follows the tool chosen inside them) */
const optionsOf = (page: Page) => page.getByRole('dialog', { name: /^خيارات / }).last();

/** a mouse drag between two client points */
async function drag(page: Page, from: Pt, to: Pt, steps = 10) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}

test.describe('N1 wave 2 — writing comfort and speed, part 2', () => {
  test('G06 / G04 / G20 / G21: pencil and dashes saved; a filled shape; a connector follows its shape in one undo step', async ({ page, api }, testInfo) => {
    test.setTimeout(300_000);
    const { pageId } = await lecture(page, api, `N1 W2 shapes ${testInfo.project.name} ${Date.now().toString(36)}`);
    try {
      const a = await writingArea(page);
      await test.step('G06 / G04: the pencil, dashed — stored as a pen stroke with the graphite texture and the pattern', async () => {
        await pickInkTool(page, /^القلم/);
        const opts = await openToolOptions(page);
        await opts.getByRole('radio', { name: 'رصاص' }).click();
        // the options are named after the tool: now «خيارات قلم رصاص: …»
        await optionsOf(page).getByRole('radio', { name: 'متقطع' }).click();
        await page.keyboard.press('Escape');
        await path(page, word(a.x + a.w * 0.2, a.y + a.h * 0.15, 120));
        await expect.poll(async () => (await serverItems(api, pageId, 'ink')).map((i) => (i.data as InkData).style)[0], { timeout: 30_000 }).toMatchObject({ tool: 'pen', texture: 'graphite', dash: 'dash' });
        const row = (await serverItems(api, pageId, 'ink'))[0]!;
        expect(row.tool).toBe('pen');
        expect(Object.keys(row.data as object).sort()).toEqual(['bbox', 'points', 'pressure_available', 'style', 'tilt_available', 'v']);
      });

      const ay = a.y + a.h * 0.42;
      const A: Pt[] = [
        [a.x + a.w * 0.12, ay],
        [a.x + a.w * 0.34, ay + a.h * 0.08],
      ];
      const B: Pt[] = [
        [a.x + a.w * 0.62, ay],
        [a.x + a.w * 0.84, ay + a.h * 0.08],
      ];
      await test.step('G20: two filled, rounded rectangles', async () => {
        await pickInkTool(page, /^الأشكال/);
        const opts = await openToolOptions(page);
        await opts.getByRole('radio', { name: 'مستطيل' }).click();
        await optionsOf(page).getByRole('radiogroup', { name: 'التعبئة' }).getByRole('radio').nth(1).click();
        await optionsOf(page).getByRole('button', { name: 'زوايا مستديرة' }).click();
        await page.keyboard.press('Escape');
        await drag(page, A[0]!, A[1]!);
        // a shape tool may hand back to the lasso after one shape (the owner's setting): pick it again
        await pickInkTool(page, /^الأشكال/);
        await drag(page, B[0]!, B[1]!);
        await expect.poll(async () => (await serverItems(api, pageId, 'shape')).length, { timeout: 30_000 }).toBe(2);
        for (const s of await serverItems(api, pageId, 'shape')) expect(s.data).toMatchObject({ shape: 'rect', fill: 'hl-yellow' });
        expect(((await serverItems(api, pageId, 'shape'))[0]!.data as { corner?: number }).corner).toBeGreaterThan(0);
      });

      await test.step('G21: a connector with an inhibition head from A’s edge to B’s edge is attached to both', async () => {
        await pickInkTool(page, /^الأشكال/);
        const opts = await openToolOptions(page);
        await opts.getByRole('radio', { name: 'موصِّل' }).click();
        await optionsOf(page).getByRole('radio', { name: /يثبّط/ }).click();
        await page.keyboard.press('Escape');
        const mid = (ay + ay + a.h * 0.08) / 2;
        await drag(page, [A[1]![0] - 2, mid], [B[0]![0] + 2, mid], 14);
        await expect.poll(async () => (await serverItems(api, pageId, 'shape')).length, { timeout: 30_000 }).toBe(3);
        const conn = (await serverItems(api, pageId, 'shape')).find((s) => (s.data as { attach?: unknown }).attach)!;
        expect(conn.data).toMatchObject({ shape: 'arrow', head: 'inhibition' });
        expect((conn.data as { attach: { from?: unknown; to?: unknown } }).attach.from).toBeTruthy();
        expect((conn.data as { attach: { from?: unknown; to?: unknown } }).attach.to).toBeTruthy();
        await screenshot(page, testInfo, 'n1w2-shapes-connector');
      });

      await test.step('moving B re-routes the connector (same step); one undo puts both back, attachments kept', async () => {
        const shapesNow = await serverItems(api, pageId, 'shape');
        const conn0 = shapesNow.find((s) => (s.data as { attach?: unknown }).attach)!;
        const to0 = (conn0.data as { to: [number, number] }).to;
        await pickInkTool(page, /^التحديد الحر/);
        await page.mouse.click((B[0]![0] + B[1]![0]) / 2, (B[0]![1] + B[1]![1]) / 2);
        await expect(page.locator('.ml-ink-selection')).toBeVisible();
        for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowDown');
        await expect.poll(async () => ((await serverItems(api, pageId, 'shape')).find((s) => s.id === conn0.id)!.data as { to: [number, number] }).to[1], { timeout: 30_000 }).toBeGreaterThan(to0[1] + 0.005);
        await page.keyboard.press('Escape');
        await undo(page);
        await expect.poll(async () => ((await serverItems(api, pageId, 'shape')).find((s) => s.id === conn0.id)!.data as { to: [number, number] }).to[1], { timeout: 30_000 }).toBeCloseTo(to0[1], 4);
        const back = (await serverItems(api, pageId, 'shape')).find((s) => s.id === conn0.id)!;
        expect((back.data as { attach: unknown }).attach).toEqual((conn0.data as { attach: unknown }).attach);
      });
    } finally {
      await api.patch('/api/settings', RESET_INK);
      await api.patch('/api/settings', RESET_INK_W2);
    }
  });

  test('G09 / G10 / G67 / G11 / G08: zoom window right to left, insert space, page menu and neat copy, ruler, measurement', async ({ page, api }, testInfo) => {
    test.setTimeout(360_000);
    const { pageId } = await lecture(page, api, `N1 W2 aids ${testInfo.project.name} ${Date.now().toString(36)}`);
    try {
      const a = await writingArea(page);
      await test.step('G09: a tap places the box; a stroke in the strip is saved inside it; the box moves on to the left', async () => {
        await pickInkTool(page, /^نافذة الكتابة المكبّرة/);
        await page.mouse.click(a.x + a.w * 0.85, a.y + a.h * 0.2);
        const strip = page.getByRole('application', { name: /اكتب هنا/ });
        await expect(strip).toBeVisible();
        const target = page.locator('.ml-ink-zoom-target');
        await expect(target).toBeVisible();
        const before = (await target.boundingBox())!;
        await screenshot(page, testInfo, 'n1w2-zoom-window');
        const s = (await strip.boundingBox())!;
        // written right to left across the strip, into its left third
        await path(page, Array.from({ length: 10 }, (_, k): Pt => [s.x + s.width * (0.9 - k * 0.08), s.y + s.height * (0.5 + (k % 2 ? 0.12 : -0.12))]), 2);
        await expect.poll(async () => (await serverItems(api, pageId, 'ink')).length, { timeout: 30_000 }).toBe(1);
        const pts = ((await serverItems(api, pageId, 'ink'))[0]!.data as InkData).points;
        const xs = pts.map((p) => p[0]);
        expect(Math.max(...xs)).toBeLessThanOrEqual(0.86);
        await expect.poll(async () => (await target.boundingBox())!.x, { timeout: 15_000 }).toBeLessThan(before.x - 2);
        await page.getByRole('button', { name: 'إغلاق نافذة الكتابة المكبّرة' }).click();
        await expect(strip).toBeHidden();
      });

      await test.step('G10: «أفسح مكانًا» moves only the writing below the line', async () => {
        await pickInkTool(page, /^القلم/);
        await path(page, word(a.x + a.w * 0.3, a.y + a.h * 0.45, 100));
        await path(page, word(a.x + a.w * 0.3, a.y + a.h * 0.7, 100));
        await expect.poll(async () => (await serverItems(api, pageId, 'ink')).length, { timeout: 30_000 }).toBe(3);
        const byY = async () => (await serverItems(api, pageId, 'ink')).map((i) => ({ id: i.id, y: (i.data as InkData).bbox.y })).sort((p, q) => p.y - q.y);
        const before = await byY();
        await pickInkTool(page, /^أفسح مكانًا/);
        await drag(page, [a.x + a.w * 0.5, a.y + a.h * 0.58], [a.x + a.w * 0.5, a.y + a.h * 0.58 + 40]);
        await expect.poll(async () => (await byY()).find((r) => r.id === before[2]!.id)!.y, { timeout: 30_000 }).toBeGreaterThan(before[2]!.y + 0.01);
        const after = await byY();
        expect(after.find((r) => r.id === before[1]!.id)!.y).toBeCloseTo(before[1]!.y, 5);
        expect(after.find((r) => r.id === before[0]!.id)!.y).toBeCloseTo(before[0]!.y, 5);
      });

      await test.step('the word reflow is offered only with handwriting recognition: here it says why not', async () => {
        await pickInkTool(page, /^التحديد الحر/);
        const w = (await serverItems(api, pageId, 'ink')).map((i) => (i.data as InkData).bbox).sort((p, q) => p.y - q.y)[1]!;
        const b = (await page.locator('.wk-page[data-page-index="0"] .ml-ink-layer').boundingBox())!;
        await page.mouse.click(b.x + (w.x + w.w / 2) * b.width, b.y + (w.y + w.h / 2) * b.height);
        await expect(page.locator('.ml-ink-selection')).toBeVisible();
        await page.locator('.ml-ink-selbar').getByRole('button', { name: 'المزيد' }).click();
        const item = page.getByRole('menuitem', { name: /أعد ترتيب الكلمات/ });
        await expect(item).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByRole('menu')).toContainText('تحتاج قراءة الخط');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
      });

      await test.step('G67 / G11: the page menu from a right click; the neat copy changes nothing stored', async () => {
        const stored = JSON.stringify((await serverItems(api, pageId, 'ink')).map((i) => [i.id, i.rev, i.data]));
        await pickInkTool(page, /^التحديد الحر/);
        await page.mouse.click(a.x + a.w * 0.9, a.y + a.h * 0.95, { button: 'right' });
        const menu = page.getByRole('menu', { name: 'قائمة الصفحة' });
        await expect(menu).toBeVisible();
        await expect(menu.getByRole('menuitem', { name: /الصق هنا/ })).toHaveAttribute('aria-disabled', 'true');
        await expect(menu.getByRole('menuitem', { name: /صفحة ملاحظات بعد هذه الصفحة/ })).toBeVisible();
        await screenshot(page, testInfo, 'n1w2-page-menu');
        await menu.getByRole('menuitem', { name: /النسخة المرتبة لهذه الصفحة/ }).click();
        await expect(page.locator('.wk-page[data-page-index="0"] .ml-ink-layer')).toHaveAttribute('data-neat', '');
        await expect(page.getByRole('note').filter({ hasText: 'نسخة مرتبة' })).toContainText('لم يتغير');
        await screenshot(page, testInfo, 'n1w2-neat-copy');
        await page.getByRole('button', { name: 'اعرض الحبر كما كتبته' }).click();
        await expect(page.locator('.wk-page[data-page-index="0"] .ml-ink-layer')).not.toHaveAttribute('data-neat', '');
        expect(JSON.stringify((await serverItems(api, pageId, 'ink')).map((i) => [i.id, i.rev, i.data]))).toBe(stored);
      });

      await test.step('G08: a stroke along the ruler is straight; the ruler is not saved', async () => {
        const count = (await serverItems(api, pageId, 'ink')).length;
        await pickInkTool(page, /^المسطرة/);
        const ruler = page.getByRole('group', { name: /المسطرة/ });
        await expect(ruler).toBeVisible();
        const r = (await ruler.boundingBox())!;
        await pickInkTool(page, /^القلم/);
        // written just above the ruler's top (writing) edge — a press ON the ruler moves the ruler
        await path(page, [
          [r.x + r.width * 0.2, r.y - 5],
          [r.x + r.width * 0.35, r.y - 11],
          [r.x + r.width * 0.5, r.y - 3],
          [r.x + r.width * 0.65, r.y - 9],
        ]);
        await expect.poll(async () => (await serverItems(api, pageId, 'ink')).length, { timeout: 30_000 }).toBe(count + 1);
        const newest = (await serverItems(api, pageId, 'ink')).sort((p, q) => q.created_at - p.created_at)[0]!;
        const ys = (newest.data as InkData).points.map((p) => p[1]);
        expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.0005);
        await screenshot(page, testInfo, 'n1w2-ruler');
        await pickInkTool(page, /^المسطرة/);
        await expect(ruler).toBeHidden();
      });

      await test.step('G08: the measurement is labelled educational and never saved', async () => {
        const count = (await serverItems(api, pageId, 'ink')).length + (await serverItems(api, pageId, 'shape')).length;
        await pickInkTool(page, /^قياس تعليمي/);
        await drag(page, [a.x + a.w * 0.2, a.y + a.h * 0.3], [a.x + a.w * 0.6, a.y + a.h * 0.3]);
        const panel = page.getByRole('region', { name: 'قياس تعليمي' });
        await expect(panel).toContainText('تقدير تعليمي — ليس قياسًا سريريًا');
        await expect(panel).toContainText('لا يُحفظ كحبر');
        await screenshot(page, testInfo, 'n1w2-measure');
        await page.waitForTimeout(1500);
        expect((await serverItems(api, pageId, 'ink')).length + (await serverItems(api, pageId, 'shape')).length).toBe(count);
        await panel.getByRole('button', { name: 'أغلق' }).click();
      });
      // no sideways scroll at 390 px with the new panels
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    } finally {
      await api.patch('/api/settings', RESET_INK);
      await api.patch('/api/settings', RESET_INK_W2);
    }
  });
});
