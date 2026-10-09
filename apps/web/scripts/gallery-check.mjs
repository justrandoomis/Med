// Screenshots of the dev-only component gallery (apps/web/dev/gallery.html) on the Vite dev server.
// Usage: (in apps/web) npx vite --port 5173 ; node apps/web/scripts/gallery-check.mjs [baseUrl]
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test-screenshots');
const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(fallback) ? fallback : undefined);

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const problems = [];
try {
  for (const vp of [
    { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    { name: 'desktop', width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  ]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch, colorScheme: scheme });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => problems.push(`[${vp.name}/${scheme}] pageerror: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && problems.push(`[${vp.name}/${scheme}] console: ${m.text()}`));
      const shot = async (name, fullPage = false) => {
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(outDir, `gallery-${name}-${vp.name}-${scheme}.png`), fullPage });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) problems.push(`[${vp.name}/${scheme}] ${name}: horizontal overflow ${overflow}px`);
      };
      await page.goto(`${base}/dev/gallery.html`);
      await page.getByRole('heading', { name: 'معرض مكونات التصميم' }).waitFor();
      await shot('all', true);
      // menu open (keyboard)
      await page.getByRole('button', { name: 'خيارات المصدر' }).focus();
      await page.keyboard.press('ArrowDown');
      await page.getByRole('menu').waitFor();
      await shot('menu');
      await page.keyboard.press('Escape');
      // sheet (bottom on phone, side on desktop)
      await page.getByRole('button', { name: 'لوحة جانبية' }).click();
      await page.getByRole('dialog', { name: 'لوحة الدراسة' }).waitFor();
      await shot('sheet');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      // confirm with typed confirmation + error toast
      await page.getByRole('button', { name: 'تأكيد إجراء مدمّر' }).click();
      await page.getByRole('alertdialog').waitFor();
      await shot('confirm');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: 'إشعار خطأ' }).click();
      await shot('toast');
      // tooltip on keyboard focus
      await page.getByRole('button', { name: 'تلميح' }).focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await page.getByRole('tooltip').waitFor();
      await shot('tooltip');
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'gallery: no console errors, no horizontal overflow');
