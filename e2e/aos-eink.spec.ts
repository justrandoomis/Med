// Academic OS P1-T2 step 2 — the e-ink display mode (ADR-0005 B.4; PRD AOS-4.17, OC.5) against the REAL server and the
// built web app, phone 390 × 844 and desktop 1280 × 800. Switched on in Settings → المظهر (this device only): nothing
// moves or fades, the palette is black / grey, the reader pages instead of scrolling smoothly, ink resolves to greys.
// Headless Chromium is not an e-ink screen: this checks what the app does, not how a BOOX refreshes (OC.5 [dev] stays
// «Not run (no device)»).
import type { Page } from '@playwright/test';
import { expect, openWorkspace, screenshot, setupOwner, test } from './support';

/** r === g === b for every channel of a computed rgb()/rgba() colour (grey, black or white); transparent passes */
const isGrey = (c: string) => {
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return true;
  const [r, g, b, a] = m[1]!.split(',').map((x) => Number(x.trim()));
  return a === 0 || (r === g && g === b);
};

async function motionAndPalette(page: Page) {
  return page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const visible = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], [role="switch"], .ml-btn')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const durations = visible.map((el) => getComputedStyle(el).transitionDuration.split(',').map((d) => parseFloat(d))).flat();
    const animated = visible.filter((el) => getComputedStyle(el).animationName !== 'none').length;
    const colours = visible.flatMap((el) => {
      const s = getComputedStyle(el);
      return [s.color, s.backgroundColor, s.borderTopColor];
    });
    return {
      eink: document.documentElement.getAttribute('data-eink'),
      theme: document.documentElement.getAttribute('data-theme'),
      reduceMotion: document.documentElement.getAttribute('data-reduce-motion'),
      durationBase: css.getPropertyValue('--ml-duration-base').trim(),
      accent: css.getPropertyValue('--ml-color-accent').trim(),
      scrollBehavior: css.scrollBehavior,
      maxTransitionS: Math.max(0, ...durations.filter((d) => Number.isFinite(d))),
      animated,
      colours,
    };
  });
}

test('e-ink mode: no motion, black / grey palette, paging reader, grey ink — and it switches back off', async ({ page, api }, testInfo) => {
  test.setTimeout(240_000);
  await setupOwner(page);
  await page.goto('/settings#appearance');
  const eink = page.getByRole('switch', { name: /شاشة حبر إلكتروني/ });
  await expect(eink).toBeVisible();
  await expect(eink).toHaveAttribute('aria-checked', 'false');
  // the row is a 44 px target (the design system's switch adds a 45 px touch ring on coarse pointers)
  expect((await eink.locator('xpath=ancestor::div[contains(@class, "ml-switch-row")][1]').boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  await eink.click();
  await expect(eink).toHaveAttribute('aria-checked', 'true');

  const s = await motionAndPalette(page);
  expect(s.eink).toBe('on');
  expect(s.theme).toBe('light'); // e-ink uses the light colours whatever the theme choice
  expect(s.reduceMotion).toBe('on');
  expect(parseFloat(s.durationBase)).toBe(0); // «0ms» (Chromium may serialise it as «0s»)
  expect(['#000', '#000000']).toContain(s.accent); // the production CSS is minified
  expect(s.scrollBehavior).toBe('auto');
  expect(s.maxTransitionS).toBe(0);
  expect(s.animated).toBe(0);
  const coloured = s.colours.filter((c) => !isGrey(c));
  expect(coloured, `non-grey colours on the settings screen: ${coloured.slice(0, 5).join(' | ')}`).toEqual([]);
  await screenshot(page, testInfo, 'aos-eink-settings');

  // kept on this device after a reload (localStorage), not in the synced appearance
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-eink', 'on');
  const stored = await page.evaluate(() => ({ display: localStorage.getItem('medlevo.display.v1'), appearance: localStorage.getItem('medlevo.appearance.v1') }));
  expect(JSON.parse(stored.display!)).toMatchObject({ eink: true });
  expect(stored.appearance ?? '').not.toContain('eink');

  // the reader: pages snap (a fling stops on a page edge), no smooth scrolling, ink in greys
  const { course } = await api.createNotebookAndCourse();
  const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
  await api.waitForProcessing(up.version_id);
  await openWorkspace(page, up.source_id, { pageIndex: 0 });
  const reader = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('.wk-canvas');
    const pageEl = document.querySelector<HTMLElement>('.wk-canvas .wk-page');
    const layer = document.querySelector<HTMLElement>('.ml-ink-layer');
    return {
      snapType: canvas ? getComputedStyle(canvas).scrollSnapType : null,
      snapAlign: pageEl ? getComputedStyle(pageEl).scrollSnapAlign : null,
      scrollBehavior: canvas ? getComputedStyle(canvas).scrollBehavior : null,
      inkBlue: layer ? getComputedStyle(layer).getPropertyValue('--ml-ink-c-ink-blue').trim() : null,
      hlYellow: layer ? getComputedStyle(layer).getPropertyValue('--ml-ink-c-hl-yellow').trim() : null,
    };
  });
  expect(reader.snapType).toContain('y');
  expect(reader.snapType).toContain('mandatory');
  expect(reader.snapAlign).toBe('start');
  expect(reader.scrollBehavior).toBe('auto');
  expect(reader.inkBlue).toBe('#141414');
  expect(reader.hlYellow).toBe('#d6d6d6');
  const r = await motionAndPalette(page);
  expect(r.maxTransitionS).toBe(0);
  expect(r.animated).toBe(0);
  await screenshot(page, testInfo, 'aos-eink-reader');

  // and off again: the attributes go, the owner's own appearance comes back
  await page.goto('/settings#appearance');
  await page.getByRole('switch', { name: /شاشة حبر إلكتروني/ }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-eink', 'on');
  expect(parseFloat((await motionAndPalette(page)).durationBase)).toBeGreaterThan(0);
});

test('e-ink is not suggested without the browser’s own (update: slow) signal; high contrast and lite switch independently', async ({ page }) => {
  await setupOwner(page);
  await page.goto('/settings#appearance');
  await expect(page.getByRole('switch', { name: /شاشة حبر إلكتروني/ })).toBeVisible();
  // headless Chromium reports a fast screen: no suggestion is made
  expect(await page.evaluate(() => matchMedia('(update: slow)').matches)).toBe(false);
  await expect(page.getByText('يبدو أن شاشة هذا الجهاز تُحدَّث ببطء')).toHaveCount(0);
  await page.getByRole('switch', { name: 'تباين عالٍ' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-contrast', 'on');
  await page.getByRole('switch', { name: 'وضع خفيف' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-lite', 'on');
  await expect(page.locator('html')).not.toHaveAttribute('data-eink', 'on');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ml-paper-texture-active').trim())).toBe('none');
  // leave the device as it was for later tests on this server
  await page.getByRole('switch', { name: 'تباين عالٍ' }).click();
  await page.getByRole('switch', { name: 'وضع خفيف' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-contrast', 'on');
});
