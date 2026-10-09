// Renders the PNG fallbacks of the app icon from the SVG sources in public/icons/.
// iOS (apple-touch-icon) and some install surfaces need raster icons.
// Usage: node apps/web/scripts/render-icons.mjs   (uses the Playwright Chromium already installed)
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, '..', 'public', 'icons');

const targets = [
  { svg: 'icon.svg', out: 'icon-192.png', size: 192 },
  { svg: 'icon.svg', out: 'icon-512.png', size: 512 },
  { svg: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
  // apple-touch-icon must be opaque & square (iOS applies its own mask) → use the full-bleed variant
  { svg: 'icon-maskable.svg', out: 'apple-touch-icon.png', size: 180 },
];

// The sandbox ships an older Chromium build than the installed @playwright/test expects;
// CHROMIUM_PATH (or the default below when present) points at it explicitly.
const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(fallback) ? fallback : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const t of targets) {
    const svg = await readFile(join(iconsDir, t.svg), 'utf8');
    await page.setViewportSize({ width: t.size, height: t.size });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">` +
        `<div style="width:${t.size}px;height:${t.size}px">${svg.replace('<svg ', `<svg width="${t.size}" height="${t.size}" `)}</div>` +
        `</body></html>`,
    );
    await page.screenshot({ path: join(iconsDir, t.out), omitBackground: true, clip: { x: 0, y: 0, width: t.size, height: t.size } });
    console.log('wrote', t.out);
  }
} finally {
  await browser.close();
}
