// AC-21 (web part) in Chromium: a stroke written with the MOUSE at one zoom/rotation is stored in
// normalized page space and, after a reload at another zoom/rotation, is rendered exactly where
// those normalized coordinates map to. This is mouse input — it says nothing about Apple Pencil
// quality, pressure, latency or palm rejection (spec §27, AC-28).
import { expect, test, type Page } from '@playwright/test';
import { normToView, type PageViewTransform, type QuarterTurn } from '../../../../../packages/shared/src/geometry';

test.describe.configure({ mode: 'serial' });

const PAGE = { pageWidth: 600, pageHeight: 800 };
type Pt = [number, number];

function viewOf(zoom: number, rot: QuarterTurn): PageViewTransform {
  return { ...PAGE, scale: zoom, rotation: rot };
}

async function open(page: Page, params: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  await page.goto(`/test/ink/harness.html?${qs}`);
  await page.waitForFunction(() => window.__ink?.ready === true);
  await expect(page.locator('.ml-ink-layer')).toHaveAttribute('data-writing', '');
  await frames(page);
}

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function layerOrigin(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('.ml-ink-layer').boundingBox();
  if (!box) throw new Error('no layer');
  return { x: box.x, y: box.y };
}

/** Draw with the mouse through normalized page points (converted with the shared geometry). */
async function drawNorm(page: Page, view: PageViewTransform, pts: Pt[]) {
  const o = await layerOrigin(page);
  const client = ([nx, ny]: Pt): Pt => {
    const [vx, vy] = normToView(nx, ny, view);
    return [o.x + vx, o.y + vy];
  };
  const [x0, y0] = client(pts[0]!);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (const p of pts.slice(1)) {
    const [x, y] = client(p);
    await page.mouse.move(x, y, { steps: 10 });
  }
  await page.mouse.up();
  await page.evaluate(() => window.__ink!.flush());
  await frames(page);
}

interface StoredRow {
  id: string;
  deletedAt: number | null;
  data: { points: number[][]; style: { tool: string } };
}

async function storedRows(page: Page): Promise<StoredRow[]> {
  return (await page.evaluate(() => window.__ink!.rows())) as StoredRow[];
}

/** Max alpha of the committed-ink canvas in a small square around a view (css px) point. */
async function inkAlphaAt(page: Page, vx: number, vy: number, r = 1.5): Promise<number> {
  return page.evaluate(
    ([x, y, rad]) => {
      const c = document.querySelectorAll<HTMLCanvasElement>('.ml-ink-layer canvas')[1]!;
      const css = c.getBoundingClientRect();
      const s = c.width / css.width;
      const ctx = c.getContext('2d')!;
      const rr = Math.max(1, Math.ceil(rad * s));
      const d = ctx.getImageData(Math.round(x * s) - rr, Math.round(y * s) - rr, 2 * rr + 1, 2 * rr + 1).data;
      let max = 0;
      for (let i = 3; i < d.length; i += 4) max = Math.max(max, d[i]!);
      return max;
    },
    [vx, vy, r] as const,
  );
}

async function expectRenderedAt(page: Page, view: PageViewTransform, norm: Pt, label: string) {
  const [vx, vy] = normToView(norm[0], norm[1], view);
  expect(await inkAlphaAt(page, vx, vy), `${label}: ink expected at view (${vx.toFixed(1)}, ${vy.toFixed(1)})`).toBeGreaterThan(100);
}

async function expectEmptyAt(page: Page, view: PageViewTransform, norm: Pt, label: string) {
  const [vx, vy] = normToView(norm[0], norm[1], view);
  expect(await inkAlphaAt(page, vx, vy, 1), `${label}: no ink expected at view (${vx.toFixed(1)}, ${vy.toFixed(1)})`).toBe(0);
}

function samplePoints(row: StoredRow): Pt[] {
  const p = row.data.points;
  return [p[0]!, p[Math.floor(p.length / 2)]!, p[p.length - 1]!].map((q) => [q[0]!, q[1]!] as Pt);
}

test('AC-21 (mouse): a stroke stays at the same normalized page position across zoom, rotation and reload', async ({ page }, info) => {
  const doc = `ac21-${Date.now()}`;
  const pageId = `P${Date.now()}`;
  const base = { doc, page: pageId, tool: 'pen' };

  // 1) write at zoom 1, no rotation
  const v1 = viewOf(1, 0);
  await open(page, { ...base, zoom: 1, rot: 0 });
  // straight strokes: render-time smoothing rounds sharp corners, so sampled raw points of a corner
  // would not lie exactly on the drawn curve; on straight segments they must
  const a: Pt[] = [
    [0.2, 0.3],
    [0.4, 0.325],
    [0.6, 0.35],
  ];
  await drawNorm(page, v1, a);
  let rows = await storedRows(page);
  expect(rows).toHaveLength(1);
  const strokeA = rows[0]!;
  // stored where the mouse touched the page (±1 css px at zoom 1)
  expect(Math.abs(strokeA.data.points[0]![0]! - 0.2)).toBeLessThan(1.01 / PAGE.pageWidth);
  expect(Math.abs(strokeA.data.points[0]![1]! - 0.3)).toBeLessThan(1.01 / PAGE.pageHeight);
  const last = strokeA.data.points[strokeA.data.points.length - 1]!;
  expect(Math.abs(last[0]! - 0.6)).toBeLessThan(1.01 / PAGE.pageWidth);
  expect(Math.abs(last[1]! - 0.35)).toBeLessThan(1.01 / PAGE.pageHeight);
  for (const p of samplePoints(strokeA)) await expectRenderedAt(page, v1, p, 'zoom 1');
  await expectEmptyAt(page, v1, [0.4, 0.45], 'zoom 1 off-stroke');
  // the outbox holds the append for this stroke (nothing waited for a server)
  const outbox = (await page.evaluate(() => window.__ink!.outbox())) as Array<{ entity_id: string; op: string }>;
  expect(outbox.filter((o) => o.entity_id === strokeA.id).map((o) => o.op)).toEqual(['append']);
  await page.screenshot({ path: info.outputPath('1-zoom1-rot0.png') });

  // 2) reload at zoom 2, rotated 90°: the same stroke, drawn where its normalized points map now
  const v2 = viewOf(2, 90);
  await open(page, { ...base, zoom: 2, rot: 90 });
  rows = await storedRows(page);
  expect(rows).toHaveLength(1);
  for (const p of samplePoints(strokeA)) await expectRenderedAt(page, v2, p, 'zoom 2 rot 90');
  // where the stroke was in the unrotated view is empty now
  const [ox, oy] = normToView(0.4, 0.3, v1);
  expect(await inkAlphaAt(page, ox, oy, 1)).toBe(0);
  await page.screenshot({ path: info.outputPath('2-zoom2-rot90.png'), fullPage: true });

  // write a second stroke in the rotated, zoomed view
  const b: Pt[] = [
    [0.3, 0.6],
    [0.5, 0.7],
  ];
  await drawNorm(page, v2, b);
  // the layer reported the stroke start/stop (the reader blocks page flips / scrolling meanwhile)
  expect(await page.evaluate(() => window.__ink!.strokeEvents)).toEqual([true, false]);
  rows = await storedRows(page);
  expect(rows).toHaveLength(2);
  const strokeB = rows.find((r) => r.id !== strokeA.id)!;
  // at zoom 2, 1 css px = 0.5 page units
  expect(Math.abs(strokeB.data.points[0]![0]! - 0.3)).toBeLessThan(0.51 / PAGE.pageWidth);
  expect(Math.abs(strokeB.data.points[0]![1]! - 0.6)).toBeLessThan(0.51 / PAGE.pageHeight);

  // 3) reload at other zooms / rotations: both strokes render at their normalized positions
  for (const [zoom, rot] of [
    [1.5, 180],
    [1, 270],
    [1, 0],
  ] as Array<[number, QuarterTurn]>) {
    const v = viewOf(zoom, rot);
    await open(page, { ...base, zoom, rot });
    expect(await storedRows(page)).toHaveLength(2);
    for (const p of [...samplePoints(strokeA), ...samplePoints(strokeB)]) await expectRenderedAt(page, v, p, `zoom ${zoom} rot ${rot}`);
    await page.screenshot({ path: info.outputPath(`3-zoom${zoom}-rot${rot}.png`), fullPage: true });
  }

});

test.describe('device pixel ratio 2', () => {
  test.use({ deviceScaleFactor: 2 });
  test('the canvas backing store follows DPR and the stroke lands on the same normalized spot', async ({ page }, info) => {
    const doc = `dpr-${Date.now()}`;
    const v = viewOf(1.25, 0);
    await open(page, { doc, page: `P${Date.now()}`, zoom: 1.25, rot: 0, tool: 'fountain' });
    const size = await page.evaluate(() => {
      const c = document.querySelectorAll<HTMLCanvasElement>('.ml-ink-layer canvas')[1]!;
      return { w: c.width, css: c.getBoundingClientRect().width };
    });
    expect(size.w).toBe(Math.round(size.css * 2));
    await drawNorm(page, v, [
      [0.15, 0.4],
      [0.85, 0.42],
    ]);
    const rows = await storedRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data.style.tool).toBe('fountain');
    for (const p of samplePoints(rows[0]!)) await expectRenderedAt(page, v, p, 'dpr 2');
    await page.screenshot({ path: info.outputPath('4-dpr2.png') });
  });
});

test('highlighter: beneath the text visually (multiply blend), translucent; toolbar fits 390 px; honest capability panel', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const v = viewOf(0.55, 0);
  await open(page, { doc: `hl-${Date.now()}`, page: `P${Date.now()}`, zoom: 0.55, rot: 0, tool: 'highlighter' });
  await drawNorm(page, v, [
    [0.05, 0.075],
    [0.9, 0.075],
  ]);
  const blend = await page.evaluate(() => {
    const layer = document.querySelector('.ml-ink-layer')!;
    const hl = layer.querySelector('canvas')!;
    return { mode: getComputedStyle(hl).mixBlendMode, isolated: layer.hasAttribute('data-blend-isolated'), tone: layer.getAttribute('data-ink-tone') };
  });
  expect(blend).toEqual({ mode: 'multiply', isolated: false, tone: 'light' });
  const rows = await storedRows(page);
  expect(rows[0]!.data.style.tool).toBe('highlighter');
  // the toolbar keeps its controls inside a 390 px viewport (the rest is in «المزيد»)
  const more = page.getByRole('button', { name: 'المزيد من أدوات الكتابة' });
  const box = await more.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const toolbar = await page.locator('.ml-ink-toolbar').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(toolbar.sw).toBeLessThanOrEqual(toolbar.cw + 1);
  await page.screenshot({ path: info.outputPath('5-highlighter-390.png') });
  // capability panel: after mouse-only input nothing pen-related is claimed
  await more.click();
  await page.getByRole('menuitem', { name: /قدرات القلم على هذا الجهاز/ }).click();
  const dialog = page.getByRole('dialog', { name: 'قدرات القلم على هذا الجهاز' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/رُصدت فأرة فقط/)).toBeVisible();
  await expect(dialog.getByText('يتطلب تطبيق iPad أصليًا').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('6-capabilities-390.png'), fullPage: true });
});

test('performance with thousands of strokes on one page (measured in headless Chromium, not a device promise)', async ({ page }, info) => {
  const doc = `perf-${Date.now()}`;
  const pageId = `P${Date.now()}`;
  await open(page, { doc, page: pageId, zoom: 1, rot: 0, tool: 'pen' });
  await page.evaluate(() => window.__ink!.seed(3000));
  await page.evaluate(() => window.__ink!.flush());
  // reload: load 3000 strokes from IndexedDB and paint them
  const t0 = Date.now();
  await open(page, { doc, page: pageId, zoom: 1, rot: 0, tool: 'pen' });
  const loadAndPaintMs = Date.now() - t0;
  expect(await storedRows(page)).toHaveLength(3000);
  // full repaint (theme change → every stroke redrawn from normalized data)
  const repaintMs = await page.evaluate(async () => {
    const t = performance.now();
    document.documentElement.setAttribute('data-theme', 'light');
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return performance.now() - t;
  });
  // one new stroke on the busy page: committed through a dirty-rect repaint
  const v = viewOf(1, 0);
  const t1 = Date.now();
  await drawNorm(page, v, [
    [0.3, 0.05],
    [0.7, 0.06],
  ]);
  const strokeRoundTripMs = Date.now() - t1;
  expect(await storedRows(page)).toHaveLength(3001);
  info.annotations.push({ type: 'perf', description: `3000 strokes: reload+load+paint ${loadAndPaintMs} ms; full repaint ${repaintMs.toFixed(1)} ms; one stroke (10 mouse steps + IndexedDB flush) ${strokeRoundTripMs} ms` });
  console.log(`[ink perf] 3000 strokes: reload+load+paint ${loadAndPaintMs} ms; full repaint ${repaintMs.toFixed(1)} ms; one stroke incl. IndexedDB flush ${strokeRoundTripMs} ms`);
  // generous bounds: catches pathological regressions only
  expect(repaintMs).toBeLessThan(1500);
  await page.screenshot({ path: info.outputPath('7-3000-strokes.png') });
});
