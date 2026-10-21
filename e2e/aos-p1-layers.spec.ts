// Academic OS P1-T2 — authorship layers against the REAL server and the built web app (PRD Scenario 2 step 4; AOS-1.6,
// 1.9, 4.10, 4.11, 4.15; ADR-0004 R2–R5). A fixture FOLLOWED layer («شرح سارة», written by another user, read-only) is
// seeded straight into the throwaway server's database (labelled TEST FIXTURE — the follow flow itself is P1-T5), then:
//   * the layers panel lists it as read-only with where it came from, and offers no «اكتب هنا» for it;
//   * the UI refuses the erase (the stroke eraser leaves it, no delete op is queued); a raw delete op is refused by the
//     server with `layer_read_only`;
//   * hide / show per study session (kept across a reload);
//   * the lasso can copy it onto the owner's layer, the original stays;
//   * «انسخ الطبقة…» previews, then copies with attribution; «سجل الطبقة» lists the history;
//   * a stroke written offline on the owner's layer that the server froze meanwhile is refused and re-created on
//     «ملاحظاتي» with the reason shown — nothing is lost.
// Mouse input through Playwright: says nothing about pen latency or palm rejection (CAPABILITY_MATRIX §27).
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Locator, Page } from '@playwright/test';
import type { AnnotationsByTargetsResponse, SourcePagesResponse, SyncOp } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, serverFor, setupOwner, test, type E2eApi } from './support';

const id = () => randomUUID().replace(/-/g, '');
const SARA = 'شرح سارة (TEST FIXTURE)';

function db(project: string): DatabaseSync {
  const dir = serverFor(project).dataDir;
  if (!dir) throw new Error('this spec needs the harness-started server (its data dir)');
  const d = new DatabaseSync(join(dir, 'medlevo.sqlite'));
  d.exec('PRAGMA busy_timeout = 10000');
  return d;
}

/** A followed copy of a classmate's explanation as the follow feed (P1-T5) will write it: read-only, authored by U2. */
function seedFollowedLayer(project: string, sourceId: string, versionId: string, pageId: string) {
  const d = db(project);
  const now = Date.now();
  const layerId = id();
  const itemId = id();
  const anchor = { type: 'page', source_id: sourceId, version_id: versionId, page_id: pageId, page_index: 0, space: 'page_norm' };
  const points = Array.from({ length: 16 }, (_, k) => [Math.round((0.3 + k * 0.02) * 1e5) / 1e5, 0.4, k * 16, 0.6]);
  const data = { v: 1, points, style: { tool: 'pen', color: 'ink-red', width: 0.004 }, bbox: { x: 0.3, y: 0.398, w: 0.3, h: 0.004 }, pressure_available: true, tilt_available: false };
  d.prepare(
    `INSERT INTO annotation_layer (id, document_key, kind, title, owner_user_id, writable, frozen, origin_json, visible, locked, sort_order, rev, created_at, updated_at)
     VALUES (?, ?, 'followed', ?, NULL, 0, 0, ?, 1, 0, 5, 1, ?, ?)`,
  ).run(layerId, `source:${sourceId}`, SARA, JSON.stringify({ publication_id: 'PUB-FIXTURE', version_no: 3, author_user_id: 'U2', author_display: 'سارة' }), now, now);
  d.prepare(
    `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, device_id, rev, created_at, updated_at, layer_id, author_user_id, origin)
     VALUES (?, 'ink', 'pen', ?, ?, 'ink', 0, 0, 'ok', NULL, 1, ?, ?, ?, 'U2', 'follow_copy')`,
  ).run(itemId, JSON.stringify(anchor), JSON.stringify(data), now, now, layerId);
  d.prepare(`INSERT INTO annotation_target (annotation_id, target_type, target_id) VALUES (?, 'source_page', ?)`).run(itemId, pageId);
  // what the server's change feed would have recorded, so the device pulls both
  d.prepare(`INSERT INTO sync_change (entity_type, entity_id, changed_at) VALUES ('annotation_layer', ?, ?)`).run(layerId, now);
  d.prepare(`INSERT INTO sync_change (entity_type, entity_id, changed_at) VALUES ('annotation', ?, ?)`).run(itemId, now);
  d.close();
  return { layerId, itemId };
}

async function firstPage(api: E2eApi, sourceId: string, versionId: string): Promise<string> {
  const r = await api.get<SourcePagesResponse>(`/api/sources/${sourceId}/versions/${versionId}/pages`);
  return r.pages[0]!.id;
}

const summary = (page: Page) => page.locator('.wk-page[data-page-index="0"] .ml-ink-layer p.ml-visually-hidden');
const inkCount = async (page: Page) => Number(/خطوط بالقلم (\d+)/.exec((await summary(page).textContent()) ?? '')?.[1] ?? 0);

async function layersPanel(page: Page): Promise<Locator> {
  const tab = page.getByRole('tab', { name: 'الطبقات' });
  if (!(await tab.isVisible())) {
    const direct = page.getByRole('button', { name: 'الصفحات والفهرس والعلامات' });
    if (await direct.count()) await direct.first().click();
    else {
      // phone: the page panel is in the reader's «خيارات القراءة» menu
      await page.getByRole('button', { name: 'خيارات القراءة' }).first().click();
      await page.getByRole('menuitem', { name: 'الصفحات والفهرس والعلامات' }).click();
    }
  }
  await tab.click();
  const panel = page.locator('.ml-layers');
  await expect(panel).toBeVisible();
  return panel;
}

/** client point of a normalized page position on page 0 */
async function at(page: Page, x: number, y: number) {
  const b = (await page.locator('.wk-page[data-page-index="0"] .ml-ink-layer').boundingBox())!;
  return { x: b.x + b.width * x, y: b.y + b.height * y };
}

async function drag(page: Page, pts: Array<[number, number]>) {
  const first = await at(page, pts[0]![0], pts[0]![1]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) {
    const p = await at(page, x, y);
    await page.mouse.move(p.x, p.y, { steps: 8 });
  }
  await page.mouse.up();
}

// the offline step: requests the reader makes while the network is down fail in the browser console (expected)
test.use({ allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED/] });

test('P1-T2: a followed layer is read-only everywhere; hide/show, lasso copy, layer copy, history and re-homing', async ({ page, api, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the full flow runs on desktop; the phone gets the panel check below');
  test.setTimeout(420_000);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
  await api.waitForProcessing(up.version_id);
  const pageId = await firstPage(api, up.source_id, up.version_id);
  const fx = seedFollowedLayer(testInfo.project.name, up.source_id, up.version_id, pageId);

  await openWorkspace(page, up.source_id, { pageIndex: 0 });
  await expect.poll(() => inkCount(page), { timeout: 60_000 }).toBe(1);

  // ── the panel: read-only, where it came from, no «اكتب هنا» ──
  const panel = await layersPanel(page);
  const sara = panel.locator('li.ml-layer', { hasText: SARA });
  await expect(sara).toBeVisible({ timeout: 30_000 });
  await expect(sara.getByText('للقراءة فقط')).toBeVisible();
  await expect(sara.getByText('من شرح سارة — الإصدار 3')).toBeVisible();
  await expect(sara.getByRole('radio')).toHaveCount(0);
  await expect(panel.getByRole('radio', { name: 'اكتب في طبقة «ملاحظاتي»', exact: true })).toBeChecked();
  for (const b of await panel.getByRole('button').all()) expect((await b.boundingBox())!.height, (await b.getAttribute('aria-label')) ?? 'button').toBeGreaterThanOrEqual(43.5);
  await screenshot(page, testInfo, 'aos-p1-layers-panel');

  // ── the UI refuses the erase ──
  await page.locator('.wk-canvas').first().focus();
  await page.keyboard.press('KeyE');
  await drag(page, [
    [0.45, 0.33],
    [0.45, 0.47],
  ]);
  await page.waitForTimeout(500);
  expect(await inkCount(page)).toBe(1);
  const deletes = await page.evaluate(
    (itemId) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('medlevo');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction('outbox', 'readonly').objectStore('outbox').getAll();
          req.onsuccess = () => {
            resolve((req.result as Array<{ entity_id: string; op: string }>).filter((o) => o.entity_id === itemId && o.op === 'delete').length);
            open.result.close();
          };
        };
      }),
    fx.itemId,
  );
  expect(deletes).toBe(0);

  // ── a raw delete op is refused by the server ──
  const refused = await api.post<{ results: Array<{ result: string; detail_code?: string }> }>('/api/sync/push', {
    ops: [{ op_id: id(), device_id: 'e2e-raw', entity_type: 'annotation', entity_id: fx.itemId, op: 'delete', base_rev: 1, client_ts: Date.now(), payload: { id: fx.itemId } } as SyncOp],
  });
  expect(refused.results[0]).toMatchObject({ result: 'rejected', detail_code: 'layer_read_only' });
  const still = await api.get<AnnotationsByTargetsResponse>(`/api/annotations/by-targets?keys=${encodeURIComponent(`source_page:${pageId}`)}`);
  expect(JSON.stringify(still)).toContain(fx.itemId);

  // ── hide / show per study session, kept across a reload ──
  await page.keyboard.press('KeyH');
  await sara.getByRole('button', { name: new RegExp(`^أخفِ طبقة «${SARA.replace(/[()]/g, '\\$&')}»`) }).click();
  await expect(summary(page)).toContainText('وفي طبقات مخفية 1');
  expect(await inkCount(page)).toBe(0);
  await page.waitForTimeout(2500); // the session place is saved shortly after a change
  await page.reload();
  await expect(summary(page)).toContainText('وفي طبقات مخفية 1', { timeout: 60_000 });
  const panel2 = await layersPanel(page);
  await panel2.locator('li.ml-layer', { hasText: SARA }).getByRole('button', { name: /^أظهر طبقة/ }).click();
  await expect.poll(() => inkCount(page)).toBe(1);

  // ── the lasso copies a read-only item onto the owner's layer; the original stays ──
  await page.locator('.wk-canvas').first().focus();
  await page.keyboard.press('KeyL');
  await drag(page, [
    [0.25, 0.34],
    [0.68, 0.34],
    [0.68, 0.46],
    [0.25, 0.46],
    [0.25, 0.34],
  ]);
  const bar = page.locator('.ml-ink-selbar');
  await expect(bar.getByText('للقراءة فقط')).toBeVisible();
  await bar.getByRole('button', { name: 'انسخ إلى طبقتي' }).click();
  await expect.poll(() => inkCount(page)).toBe(2);
  await page.keyboard.press('Escape');

  // ── «انسخ الطبقة…»: preview first, then the copy, with attribution; the source layer is unchanged ──
  const panel3 = await layersPanel(page);
  await panel3.locator('li.ml-layer', { hasText: SARA }).getByRole('button', { name: /^خيارات طبقة/ }).click();
  await page.getByRole('menuitem', { name: 'انسخ الطبقة…' }).click();
  const copyDialog = page.getByRole('dialog', { name: /انسخ طبقة/ });
  await copyDialog.getByRole('button', { name: 'اعرض المعاينة' }).click();
  await expect(copyDialog.locator('.ml-copy-preview')).toContainText('سيُنسخ 1');
  await expect(copyDialog.locator('.ml-copy-preview')).toContainText('سارة');
  await copyDialog.getByRole('button', { name: /^انسخ 1/ }).click();
  await expect(copyDialog).toBeHidden();
  await expect(panel3.locator('li.ml-layer', { hasText: `نسخة من «${SARA}»` })).toBeVisible({ timeout: 30_000 });

  // ── «سجل الطبقة» (read-only) of «ملاحظاتي» lists the copy written above ──
  await panel3.getByRole('button', { name: 'خيارات طبقة «ملاحظاتي»', exact: true }).click();
  await page.getByRole('menuitem', { name: 'سجل الطبقة' }).click();
  const history = page.getByRole('dialog', { name: /سجل طبقة/ });
  await expect(history.locator('.ml-layer-history__row').first()).toBeVisible({ timeout: 30_000 });
  await screenshot(page, testInfo, 'aos-p1-layers-history');
  await page.keyboard.press('Escape');
  await expect(history).toBeHidden();

  // ── re-homing: written offline on the owner's own layer, which the server froze meanwhile → kept on «ملاحظاتي» ──
  const panel4 = await layersPanel(page);
  await panel4.getByRole('button', { name: 'طبقة جديدة' }).click();
  const create = page.getByRole('dialog', { name: 'طبقة جديدة' });
  await create.getByLabel('اسم الطبقة').fill('إجاباتي (TEST)');
  await create.getByRole('button', { name: 'أنشئ الطبقة' }).click();
  const mine = panel4.locator('li.ml-layer', { hasText: 'إجاباتي (TEST)' });
  await expect(mine.getByRole('radio')).toBeChecked();
  const myLayerId = (await mine.getAttribute('data-layer-id'))!;
  await expect
    .poll(async () => (await api.get<{ layers: Array<{ id: string }> }>(`/api/annotations/layers?document_key=${encodeURIComponent(`source:${up.source_id}`)}`)).layers.some((l) => l.id === myLayerId), { timeout: 30_000 })
    .toBe(true);
  await context.setOffline(true);
  await page.locator('.wk-canvas').first().focus();
  await page.keyboard.press('KeyP');
  await drag(page, [
    [0.3, 0.6],
    [0.6, 0.62],
  ]);
  // 1 followed + 1 lasso copy + 1 from «انسخ الطبقة» + this one
  await expect.poll(() => inkCount(page)).toBe(4);
  const frozen = db(testInfo.project.name);
  frozen.prepare('UPDATE annotation_layer SET frozen = 1 WHERE id = ?').run(myLayerId);
  frozen.close();
  await context.setOffline(false);
  await expect(page.getByText('نُقلت كتابة إلى «ملاحظاتي»').first()).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () => {
        const r = await api.get<AnnotationsByTargetsResponse>(`/api/annotations/by-targets?keys=${encodeURIComponent(`source_page:${pageId}`)}`);
        const all = JSON.stringify(r);
        return /"id":"rh_[A-Za-z0-9]+"/.test(all);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  // the writing itself is still on the page (now on «ملاحظاتي»)
  expect(await inkCount(page)).toBe(4);
  const ld = db(testInfo.project.name);
  const rehomed = ld.prepare(`SELECT layer_id, deleted_at FROM annotation WHERE id LIKE 'rh_%'`).all() as Array<{ layer_id: string | null; deleted_at: number | null }>;
  ld.close();
  expect(rehomed).toEqual([{ layer_id: null, deleted_at: null }]);
  await screenshot(page, testInfo, 'aos-p1-layers-rehomed');
});

test('P1-T2: the layers panel on a phone — RTL, 44 px targets, no sideways scroll', async ({ page, api }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout check');
  test.setTimeout(240_000);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
  await api.waitForProcessing(up.version_id);
  const pageId = await firstPage(api, up.source_id, up.version_id);
  seedFollowedLayer(testInfo.project.name, up.source_id, up.version_id, pageId);
  await openWorkspace(page, up.source_id, { pageIndex: 0 });
  const panel = await layersPanel(page);
  await expect(panel.locator('li.ml-layer', { hasText: SARA })).toBeVisible({ timeout: 30_000 });
  for (const b of await panel.getByRole('button').all()) expect((await b.boundingBox())!.height, (await b.getAttribute('aria-label')) ?? 'button').toBeGreaterThanOrEqual(43.5);
  await screenshot(page, testInfo, 'aos-p1-layers-panel-phone');
  // (P1-T2 review, PRD AOS-20.2) the panel's text keeps ≥ 4.5:1 against what is behind it, in light and in dark
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const low = await panel.evaluate((root) => {
      const rgb = (c: string) => (/rgba?\(([^)]+)\)/.exec(c)?.[1] ?? '0,0,0,0').split(',').map((x) => Number(x.trim()));
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
      };
      const bgOf = (el: Element | null): number[] => {
        for (let e = el; e; e = e.parentElement) {
          const c = rgb(getComputedStyle(e).backgroundColor);
          if ((c[3] ?? 1) > 0.5) return c;
        }
        return [255, 255, 255, 1];
      };
      const out: string[] = [];
      for (const el of Array.from(root.querySelectorAll<HTMLElement>('.ml-layer__title, .ml-layer__meta, .ml-layer__badge, .ml-layer__origin, .ml-layers__intro, .ml-layer__active'))) {
        if (!el.getBoundingClientRect().width) continue;
        const fg = lum(rgb(getComputedStyle(el).color));
        const bg = lum(bgOf(el));
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        if (ratio < 4.5) out.push(`${el.className}: ${ratio.toFixed(2)}`);
      }
      return out;
    });
    expect(low, `${scheme}: text under 4.5:1 in the layers panel`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${scheme}: no sideways scroll`).toBe(true);
  }
  await screenshot(page, testInfo, 'aos-p1-layers-panel-phone-dark');
});
