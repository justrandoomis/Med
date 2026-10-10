// PERFORMANCE & RESILIENCE in the browser (§55, §58) — runs only with MEDLEVO_PERF=1 (minutes; see docs/PERFORMANCE.md).
// Real server, built web app, headless Chromium in this container. What is measured is what this container did:
// nothing here is a device FPS or pen-latency claim (no iPad, no Apple Pencil, no real phone).
//
//   MEDLEVO_PERF=1 npx playwright test e2e/perf.spec.ts --project=desktop
//
// Results: e2e/.artifacts/perf/<project>.json (+ attached to the HTML report).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import type { SourcePagesResponse, SyncOp } from '@medlevo/shared';
import { lecturePdf } from '../apps/server/test/perf/fixtures';
import { CSRF_HEADERS, E2E_ARTIFACTS_DIR, expect, openWorkspace, setupOwner, test, type E2eApi } from './support';

const PERF = process.env.MEDLEVO_PERF === '1';
const PAGES = Number(process.env.MEDLEVO_PERF_PAGES || 300);
const STROKES = Number(process.env.MEDLEVO_PERF_STROKES || 5000);
const CARDS = Number(process.env.MEDLEVO_PERF_CARDS || 3000);
const EVENTS_PER_CARD = 4;
const DAY = 86_400_000;

test.describe.configure({ mode: 'serial' });
test.skip(!PERF, 'performance suite — set MEDLEVO_PERF=1 (docs/PERFORMANCE.md)');

const results: Record<string, unknown> = {};
test.afterAll(async ({}, testInfo) => {
  if (!PERF || Object.keys(results).length === 0) return;
  const dir = join(E2E_ARTIFACTS_DIR, 'perf');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${testInfo.project.name}.json`);
  writeFileSync(file, JSON.stringify({ environment: { chromium: 'headless (Playwright, /opt/pw-browsers/chromium)', project: testInfo.project.name, viewport: testInfo.project.use.viewport, measured_at: new Date().toISOString() }, results }, null, 2));
  process.stdout.write(`[perf] web results written to ${file}\n`);
});

const id = () => crypto.randomUUID().replace(/-/g, '');
const r1 = (n: number) => Math.round(n * 10) / 10;

function pct(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0;
  return { n: s.length, p50: r1(at(0.5)), p95: r1(at(0.95)), max: r1(s[s.length - 1] ?? 0) };
}

async function metrics(cdp: CDPSession): Promise<{ jsHeapMb: number; nodes: number }> {
  const { metrics: m } = (await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
  const v = (n: string) => m.find((x) => x.name === n)?.value ?? 0;
  return { jsHeapMb: r1(v('JSHeapUsedSize') / 1048576), nodes: v('Nodes') };
}

async function gcHeap(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  return (await metrics(cdp)).jsHeapMb;
}

/** canvases in the document right now (page canvases, ink canvases, their backing-store size) */
function canvasStats(page: Page) {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('canvas')];
    const pageCanvases = all.filter((c) => c.classList.contains('wk-pagecanvas'));
    return {
      canvases: all.length,
      page_canvases: pageCanvases.length,
      page_canvases_with_bitmap: pageCanvases.filter((c) => c.width > 0).length,
      ink_canvases: all.filter((c) => c.classList.contains('ml-ink-layer__canvas')).length,
      canvas_megapixels: Math.round(all.reduce((s, c) => s + c.width * c.height, 0) / 1e4) / 100,
      page_elements: document.querySelectorAll('.wk-canvas .wk-page').length,
    };
  });
}

/** long tasks (main thread blocked > 50 ms) since the page started, from a buffered PerformanceObserver */
async function installLongTasks(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: Array<{ start: number; duration: number }>; __firstPageCanvasAt: number | null };
    w.__longTasks = [];
    w.__firstPageCanvasAt = null;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // not supported
    }
    new MutationObserver(() => {
      if (w.__firstPageCanvasAt === null && document.querySelector('canvas.wk-pagecanvas')) w.__firstPageCanvasAt = performance.now();
    }).observe(document, { childList: true, subtree: true });
  });
}

async function longTasksSince(page: Page, since: number) {
  const list = await page.evaluate((s) => (window as unknown as { __longTasks: Array<{ start: number; duration: number }> }).__longTasks.filter((t) => t.start >= s), since);
  return { count: list.length, total_ms: r1(list.reduce((a, t) => a + t.duration, 0)), max_ms: r1(Math.max(0, ...list.map((t) => t.duration))) };
}

const now = (page: Page) => page.evaluate(() => performance.now());

async function uploadPdf(api: E2eApi, nodeId: string, name: string, data: Buffer, sourceType = 'lecture') {
  const res = await api.request.post('/api/sources/upload', {
    headers: { ...CSRF_HEADERS },
    multipart: { node_id: nodeId, source_type: sourceType, on_duplicate: 'create', title: `${name} (TEST FIXTURE)`, files: { name, mimeType: 'application/pdf', buffer: data } },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const r = ((await res.json()) as { results: Array<{ status: string; source_id: string; version_id: string }> }).results[0]!;
  expect(r.status).toBe('accepted');
  return r;
}

async function pageIds(api: E2eApi, sourceId: string, versionId: string): Promise<string[]> {
  const r = await api.get<SourcePagesResponse>(`/api/sources/${sourceId}/versions/${versionId}/pages`);
  return r.pages.map((p) => p.id);
}

async function pushAll(api: E2eApi, ops: SyncOp[]) {
  for (let i = 0; i < ops.length; i += 500) {
    const res = await api.post<{ results: Array<{ result: string }> }>('/api/sync/push', { ops: ops.slice(i, i + 500) });
    const bad = res.results.filter((r) => r.result !== 'applied');
    expect(bad, JSON.stringify(bad.slice(0, 3))).toHaveLength(0);
  }
}

/** rows of one IndexedDB table of the app's local database (read directly, without the app's code) */
function idbRows<T = Record<string, unknown>>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(
    (name) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open('medlevo');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction(name, 'readonly').objectStore(name).getAll();
          req.onsuccess = () => {
            resolve(req.result as T[]);
            db.close();
          };
          req.onerror = () => reject(req.error);
        };
      }),
    store,
  );
}

type Rich = { paragraphs: Array<{ runs: Array<{ t: string }> }> };
/** plain text of a stored note body (mixed-direction text is split into runs) */
const plain = (b: Rich) => b.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');

let lecture: { sourceId: string; versionId: string; pageIds: string[] } | null = null;

test('300-page lecture: open time, render while scrolling, virtualization keeps memory bounded', async ({ page, api }, testInfo) => {
  test.setTimeout(30 * 60_000);
  await installLongTasks(page);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const pdf = await lecturePdf({ pages: PAGES, twoColumnEvery: 5, tableEvery: 10, figureEvery: 25 });
  const up = await uploadPdf(api, course.id, 'perf-lecture.pdf', pdf.data);
  const p0 = Date.now();
  const processed = await api.waitForProcessing(up.version_id, { timeoutMs: 20 * 60_000 });
  const processingMs = Date.now() - p0;
  expect(processed.job?.status).toBe('completed');
  lecture = { sourceId: up.source_id, versionId: up.version_id, pageIds: await pageIds(api, up.source_id, up.version_id) };

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  // ── open: navigation → first page canvas painted ──
  const t0 = Date.now();
  await openWorkspace(page, up.source_id);
  const openWallMs = Date.now() - t0;
  const firstCanvasAt = await page.evaluate(() => (window as unknown as { __firstPageCanvasAt: number | null }).__firstPageCanvasAt);
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return n ? { dom_content_loaded_ms: Math.round(n.domContentLoadedEventEnd), load_ms: Math.round(n.loadEventEnd) } : null;
  });
  await expect(page.locator('.wk-content--paged')).toHaveCount(0); // continuous layout (the default)
  const heapAfterOpen = await gcHeap(cdp);
  const atOpen = await canvasStats(page);

  // ── scroll through every page, one page at a time: time until that page's canvas is painted ──
  const perPage: number[] = [];
  const samples: Array<Record<string, unknown>> = [];
  let maxPageCanvases = 0;
  let maxLiveCanvases = 0;
  const scrollStart = await now(page);
  for (let start = 0; start < PAGES; start += 10) {
    const chunk = await page.evaluate(
      async ([from, to]) => {
        const el = document.querySelector<HTMLElement>('.wk-canvas')!;
        const out: Array<{ i: number; ms: number; pageCanvases: number; live: number }> = [];
        for (let i = from; i < to; i++) {
          const pg = el.querySelector<HTMLElement>(`.wk-page[data-page-index="${i}"]`)!;
          const t = performance.now();
          el.scrollTop = pg.offsetTop - 8;
          await new Promise<void>((resolve, reject) => {
            const limit = t + 30_000;
            const check = () => {
              const c = pg.querySelector<HTMLCanvasElement>('canvas.wk-pagecanvas');
              if (c && c.width > 0) resolve();
              else if (performance.now() > limit) reject(new Error(`page ${i} did not render in 30 s`));
              else requestAnimationFrame(check);
            };
            check();
          });
          const pcs = [...document.querySelectorAll<HTMLCanvasElement>('canvas.wk-pagecanvas')];
          out.push({ i, ms: performance.now() - t, pageCanvases: pcs.length, live: pcs.filter((c) => c.width > 0).length });
        }
        return out;
      },
      [start, Math.min(PAGES, start + 10)] as const,
    );
    for (const c of chunk) {
      perPage.push(c.ms);
      maxPageCanvases = Math.max(maxPageCanvases, c.pageCanvases);
      maxLiveCanvases = Math.max(maxLiveCanvases, c.live);
    }
    if (start % 50 === 0 || start + 10 >= PAGES) samples.push({ page: Math.min(PAGES, start + 10), ...(await metrics(cdp)), ...(await canvasStats(page)) });
  }
  const scrollLongTasks = await longTasksSince(page, scrollStart);
  const heapAfterScrollGc = await gcHeap(cdp);

  // ── fling: from the end back to the top in 40 big jumps without waiting, then the first page must render ──
  const fling = await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('.wk-canvas')!;
    for (let k = 40; k >= 0; k--) {
      el.scrollTop = (el.scrollHeight * k) / 40;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    const t = performance.now();
    const pg = el.querySelector<HTMLElement>('.wk-page[data-page-index="0"]')!;
    await new Promise<void>((resolve) => {
      const check = () => {
        const c = pg.querySelector<HTMLCanvasElement>('canvas.wk-pagecanvas');
        if (c && c.width > 0) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
    return { first_page_render_after_fling_ms: Math.round(performance.now() - t) };
  });
  await page.waitForTimeout(500);
  const afterFling = await canvasStats(page);

  // virtualization: only pages near the viewport keep a page canvas
  expect(maxPageCanvases).toBeLessThanOrEqual(12);
  expect(afterFling.page_canvases).toBeLessThanOrEqual(12);

  results.lecture = {
    scenario: `${PAGES}-page digital lecture (2.5 MB PDF), continuous layout, ${testInfo.project.name} viewport`,
    server_processing_wall_ms: processingMs,
    open: { wall_ms_goto_to_canvas_visible: openWallMs, nav_start_to_first_page_canvas_ms: firstCanvasAt === null ? null : Math.round(firstCanvasAt), navigation: nav, js_heap_after_gc_mb: heapAfterOpen, canvases: atOpen },
    scroll_page_by_page: { per_page_render_ms: pct(perPage), max_page_canvases_in_dom: maxPageCanvases, max_page_canvases_with_bitmap: maxLiveCanvases, long_tasks: scrollLongTasks, samples },
    js_heap_after_visiting_all_pages_gc_mb: heapAfterScrollGc,
    fling: { ...fling, canvases_after: afterFling },
  };
});

test('5 000 ink strokes on one page: load + paint, a new stroke, zoom repaint', async ({ page, api }) => {
  test.setTimeout(15 * 60_000);
  await installLongTasks(page);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
  await api.waitForProcessing(up.version_id);
  const ids = await pageIds(api, up.source_id, up.version_id);
  const anchor = { type: 'page', source_id: up.source_id, version_id: up.version_id, page_id: ids[0]!, page_index: 0, space: 'page_norm' };
  const ops: SyncOp[] = Array.from({ length: STROKES }, (_, s) => {
    const sid = id();
    const x0 = 0.05 + ((s * 37) % 80) / 100;
    const y0 = 0.05 + ((s * 53) % 85) / 100;
    const points = Array.from({ length: 40 }, (_, k) => [Math.round((x0 + k * 0.002) * 1e5) / 1e5, Math.round((y0 + Math.sin(k / 4) * 0.004) * 1e5) / 1e5, k * 8]);
    return {
      op_id: id(),
      device_id: 'perf-seed',
      entity_type: 'annotation',
      entity_id: sid,
      op: 'append',
      client_ts: Date.now(),
      payload: { kind: 'ink', tool: 'pen', anchor, layer: 'ink', z: s, locked: false, data: { v: 1, points, style: { tool: 'pen', color: 'ink-blue', width: 0.002 }, bbox: { x: x0, y: y0 - 0.004, w: 0.08, h: 0.008 }, pressure_available: false, tilt_available: false } },
    } as SyncOp;
  });
  await pushAll(api, ops);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const t0 = Date.now();
  await openWorkspace(page, up.source_id, { pageIndex: 0 });
  const summary = page.locator('.wk-page[data-page-index="0"] .ml-ink-layer p.ml-visually-hidden');
  await expect(summary).toContainText(`خطوط بالقلم ${STROKES}`, { timeout: 120_000 });
  const loadedMs = Date.now() - t0;
  // the committed-ink canvas really has the strokes painted
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = document.querySelectorAll<HTMLCanvasElement>('.wk-page[data-page-index="0"] .ml-ink-layer canvas')[1];
          if (!c || !c.width) return 0;
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 4 * 16) if (d[i]! > 0) n++;
          return n;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(1000);
  const paintedMs = Date.now() - t0;
  const loadLongTasks = await longTasksSince(page, 0);
  const heap = await gcHeap(cdp);

  // a new stroke with the pen (mouse input — not a Pencil latency measurement)
  await page.keyboard.press('KeyP');
  const layer = page.locator('.wk-page[data-page-index="0"] .ml-ink-layer');
  await expect(layer).toHaveAttribute('data-writing', '');
  const box = (await layer.boundingBox())!;
  const before = await now(page);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let k = 1; k <= 30; k++) await page.mouse.move(box.x + box.width * (0.3 + k * 0.01), box.y + box.height * (0.5 + Math.sin(k / 3) * 0.02));
  const upAt = Date.now();
  await page.mouse.up();
  await expect(summary).toContainText(`خطوط بالقلم ${STROKES + 1}`);
  const commitMs = Date.now() - upAt;
  const strokeLongTasks = await longTasksSince(page, before);

  // zoom in: every stroke is repainted at the new scale
  await page.keyboard.press('Escape');
  const zoomStart = await now(page);
  await page.locator('.wk-canvas').first().focus();
  await page.keyboard.press('+');
  await page.waitForTimeout(1500);
  const zoomLongTasks = await longTasksSince(page, zoomStart);

  const local = await idbRows<{ targetKey: string; deletedAt: number | null }>(page, 'annotations');
  results.ink = {
    scenario: `${STROKES} pen strokes × 40 samples on one page (seeded through the sync API), fresh browser profile`,
    open_to_strokes_loaded_ms: loadedMs,
    open_to_strokes_painted_ms: paintedMs,
    long_tasks_during_open: loadLongTasks,
    js_heap_after_gc_mb: heap,
    local_rows_in_indexeddb: local.filter((r) => r.targetKey === `source_page:${ids[0]}`).length,
    new_stroke: { pointerup_to_committed_ms: commitMs, long_tasks_during_stroke: strokeLongTasks },
    zoom_in_repaint_long_tasks: zoomLongTasks,
  };
});

test('review hub: 3 000 cards + 12 000 review events — first sync, then the local fold', async ({ page, api }) => {
  test.setTimeout(20 * 60_000);
  await installLongTasks(page);
  await setupOwner(page);
  const t = Date.now();
  const rt = (s: string) => ({ v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: s }] }] });
  const cardIds = Array.from({ length: CARDS }, () => id());
  await pushAll(
    api,
    cardIds.map((cid, i) => ({ op_id: id(), device_id: 'perf-seed', entity_type: 'flashcard', entity_id: cid, op: 'upsert', client_ts: t, payload: { id: cid, kind: 'basic', front: rt(`Fixture card ${i + 1} (TEST FIXTURE)`), back: rt(`Fixture answer ${i + 1}`), origin: 'owner', created_at: t - 120 * DAY + i * 1000 } }) as SyncOp),
  );
  const offsets = [1, 4, 12, 40];
  const events: SyncOp[] = [];
  cardIds.forEach((cid, i) => {
    for (let k = 0; k < EVENTS_PER_CARD; k++) {
      const eid = id();
      events.push({ op_id: id(), device_id: 'perf-seed', entity_type: 'review_event', entity_id: eid, op: 'append', client_ts: t, payload: { id: eid, card_id: cid, rating: (i + k) % 11 === 0 ? 1 : 3, reviewed_at: t - 120 * DAY + i * 1000 + offsets[k]! * DAY, duration_ms: 5000 } } as SyncOp);
    }
  });
  await pushAll(api, events);
  const server = await api.get<{ counts: { due_now: number } }>('/api/learning/review/queue');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  // first visit on this device: the cards and events arrive through the sync pull, then the device folds them
  const t0 = Date.now();
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'المراجعة', level: 1 })).toBeVisible();
  await expect.poll(async () => (await idbRows(page, 'reviewEvents')).length, { timeout: 15 * 60_000, intervals: [1000] }).toBe(CARDS * EVENTS_PER_CARD);
  await expect(page.locator('.lw-today')).toContainText('مستحقة الآن', { timeout: 120_000 });
  const firstSyncMs = Date.now() - t0;
  const firstLongTasks = await longTasksSince(page, 0);
  const todayText = (await page.locator('.lw-today').innerText()).replace(/\s+/g, ' ').slice(0, 200);

  // later visits: everything is on the device — only the local fold (FSRS replay of every card) runs
  const t1 = Date.now();
  await page.reload();
  await expect(page.locator('.lw-today')).toContainText('مستحقة الآن', { timeout: 120_000 });
  const reopenMs = Date.now() - t1;
  const reopenLongTasks = await longTasksSince(page, 0);
  results.review = {
    scenario: `${CARDS} flashcards + ${CARDS * EVENTS_PER_CARD} review events (seeded through the sync API), FSRS fold on the device`,
    server_due_now: server.counts.due_now,
    hub_sentence: todayText,
    first_visit_sync_and_fold_ms: firstSyncMs,
    first_visit_long_tasks: firstLongTasks,
    reopen_fold_from_indexeddb_ms: reopenMs,
    reopen_long_tasks: reopenLongTasks,
    js_heap_after_gc_mb: await gcHeap(cdp),
  };
});

test.describe('resilience', () => {
  async function workspaceWithFixture(page: Page, api: E2eApi) {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
    await api.waitForProcessing(up.version_id);
    const ids = await pageIds(api, up.source_id, up.version_id);
    await openWorkspace(page, up.source_id, { pageIndex: 0 });
    return { up, ids };
  }

  async function drawStroke(page: Page, fx: number, fy: number, opts: { lift?: boolean } = {}) {
    const box = (await page.locator('.wk-page[data-page-index="0"] .ml-ink-layer').boundingBox())!;
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
    await page.mouse.down();
    for (let k = 1; k <= 12; k++) await page.mouse.move(box.x + box.width * (fx + k * 0.01), box.y + box.height * (fy + (k % 2) * 0.005));
    if (opts.lift !== false) await page.mouse.up();
  }

  const liveInk = async (page: Page, pageId: string) =>
    (await idbRows<{ targetKey: string; kind: string; deletedAt: number | null }>(page, 'annotations')).filter((r) => r.targetKey === `source_page:${pageId}` && r.kind === 'ink' && !r.deletedAt).length;

  test('reload mid-stroke and right after typing a note: nothing lost beyond the stroke in flight', async ({ page, api }) => {
    test.setTimeout(10 * 60_000);
    const { up, ids } = await workspaceWithFixture(page, api);
    await page.keyboard.press('KeyP');
    await expect(page.locator('.wk-page[data-page-index="0"] .ml-ink-layer')).toHaveAttribute('data-writing', '');
    for (let s = 0; s < 3; s++) await drawStroke(page, 0.2, 0.2 + s * 0.08);
    // a 4th stroke is in flight (pen down, moving) when the page reloads
    await drawStroke(page, 0.2, 0.6, { lift: false });
    await page.reload();
    await expect(page.locator('.wk-canvas-slot canvas').first()).toBeVisible({ timeout: 45_000 });
    const inkAfterReload = await liveInk(page, ids[0]!);

    // a note typed and the page reloaded at once (before the editor's 600 ms save debounce)
    await page.getByRole('tab', { name: 'ملاحظاتي' }).click();
    await page.getByRole('button', { name: 'ملاحظة على هذه الصفحة' }).click();
    const marker = `ملاحظة قبل إعادة التحميل ${id().slice(0, 6)}`;
    await page.getByRole('textbox', { name: /ملاحظة جديدة/ }).fill(marker);
    await page.reload();
    await expect(page.locator('.wk-canvas-slot canvas').first()).toBeVisible({ timeout: 45_000 });
    // the text was backed up synchronously while typing; the reloaded app saves it to IndexedDB (and the outbox)
    const hasNote = async () =>
      (await idbRows<{ body: { paragraphs: Array<{ runs: Array<{ t: string }> }> }; deletedAt: number | null }>(page, 'notes')).some(
        (n) => !n.deletedAt && plain(n.body).includes(marker),
      );
    let noteKept = false;
    const recoverFrom = Date.now();
    for (let k = 0; k < 100 && !noteKept; k++) {
      noteKept = await hasNote();
      if (!noteKept) await page.waitForTimeout(100);
    }
    const noteRecoveredAfterMs = Date.now() - recoverFrom;

    // and the server converges to the same (three strokes, the note)
    await expect
      .poll(async () => (await api.get<{ annotations: Array<{ kind: string }> }>(`/api/annotations/by-targets?keys=${encodeURIComponent(`source_page:${ids[0]}`)}`)).annotations.filter((a) => a.kind === 'ink').length, { timeout: 60_000 })
      .toBe(3);
    const serverNotes = await api.get<{ notes: Array<{ body: { paragraphs: Array<{ runs: Array<{ t: string }> }> } }> }>(`/api/annotations/notes?source_id=${up.source_id}`);
    results.reload = {
      strokes_completed_before_reload: 3,
      strokes_in_indexeddb_after_reload: inkAfterReload,
      note_typed_then_reloaded_immediately_kept: noteKept,
      note_in_indexeddb_within_ms_of_reload_ready: noteKept ? noteRecoveredAfterMs : null,
      server_note_texts: serverNotes.notes.map((n) => plain(n.body)),
    };
    expect(inkAfterReload).toBe(3); // the in-flight stroke is the only writing lost
    expect(noteKept, 'note text typed just before a reload').toBe(true);
    await expect.poll(async () => (await api.get<{ notes: Array<{ body: { paragraphs: Array<{ runs: Array<{ t: string }> }> } }> }>(`/api/annotations/notes?source_id=${up.source_id}`)).notes.some((n) => plain(n.body).includes(marker)), { timeout: 60_000 }).toBe(true);
  });

  test.describe('offline', () => {
    // while offline the browser reports the failed requests of the sync engine as console errors — expected here
    test.use({ allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch|NetworkError/i] });

    test('offline → online: writing stays on the device, then converges on the server', async ({ page, api, context }) => {
      test.setTimeout(10 * 60_000);
      const { up, ids } = await workspaceWithFixture(page, api);
      await context.setOffline(true);
      await page.keyboard.press('KeyP');
      await expect(page.locator('.wk-page[data-page-index="0"] .ml-ink-layer')).toHaveAttribute('data-writing', '');
      await drawStroke(page, 0.25, 0.3);
      await drawStroke(page, 0.25, 0.4);
      await page.getByRole('tab', { name: 'ملاحظاتي' }).click();
      await page.getByRole('button', { name: 'ملاحظة على هذه الصفحة' }).click();
      const marker = `ملاحظة دون اتصال ${id().slice(0, 6)}`;
      await page.getByRole('textbox', { name: /ملاحظة جديدة/ }).fill(marker);
      await page.getByRole('button', { name: 'تم' }).click();
      await expect.poll(() => liveInk(page, ids[0]!)).toBe(2);
      const pendingOps = (await idbRows<{ status: string }>(page, 'outbox')).filter((o) => o.status === 'pending').length;
      const serverWhileOffline = (await api.get<{ annotations: unknown[] }>(`/api/annotations/by-targets?keys=${encodeURIComponent(`source_page:${ids[0]}`)}`)).annotations.length;

      const back = Date.now();
      await context.setOffline(false);
      await expect
        .poll(async () => (await api.get<{ annotations: Array<{ kind: string }> }>(`/api/annotations/by-targets?keys=${encodeURIComponent(`source_page:${ids[0]}`)}`)).annotations.filter((a) => a.kind === 'ink').length, { timeout: 120_000, intervals: [200] })
        .toBe(2);
      await expect.poll(async () => (await api.get<{ notes: Array<{ body: { paragraphs: Array<{ runs: Array<{ t: string }> }> } }> }>(`/api/annotations/notes?source_id=${up.source_id}`)).notes.some((n) => plain(n.body).includes(marker)), { timeout: 120_000, intervals: [200] }).toBe(true);
      const convergedMs = Date.now() - back;
      await expect.poll(async () => (await idbRows<{ status: string }>(page, 'outbox')).filter((o) => o.status === 'pending').length, { timeout: 60_000 }).toBe(0);
      results.offline = { pending_ops_while_offline: pendingOps, server_annotations_while_offline: serverWhileOffline, online_to_server_has_everything_ms: convergedMs };
      expect(serverWhileOffline).toBe(0);
      expect(pendingOps).toBeGreaterThanOrEqual(3);
    });
  });
});
