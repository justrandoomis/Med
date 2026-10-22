// Academic OS P1-T5 step 3 — PRD Scenario 4 «تحديث المحاضرة الرسمية» in a SUBJECT (the official lecture and the
// students' copies), against the REAL server and the built web app, phone 390 × 844 and desktop 1280 × 800 (BUILD_PLAN
// §3.7; PRD AOS-3.11–3.13, 4.17, 4.20, Q35; ARCHITECTURE_DELTA §6.3, §6.5):
//   1. version 1 of Lecture 5 (40 pages) is official; زينب (the browser under test) studies it: ink on p.5, a text
//      highlight on p.12, a note anchored on p.30; she follows حسن's explanation on p.10–14; هدى chose «انقل ملاحظاتي
//      تلقائيًا»;
//   2.–3. سارة uploads «Abdomen lec5 final (1).pdf» (2 pages inserted after p.10, the text of p.30 rewritten); the publish
//      preview names the page changes and the holders as a COUNT; she publishes version 2;
//   4. زينب's reader says «يوجد إصدار أحدث من المحاضرة»; the preview changes nothing; ONE tap copies the p.5 ink and the
//      p.12 highlight (to p.14); the p.30 note is listed for review with both pages side by side and placed by her; her v1
//      rows are unchanged and nothing is missing (before = moved + review + kept);
//   6. variant (auto): هدى's notes are copied without a tap, with the report in her inbox;
//   + حسن copies his explanation with the same flow and republishes; زينب's followed layer stays «مبني على الإصدار 1»
//     until then, and his update says «مبني على الإصدار 2».
// Not here (reported in docs/modules/copies-publications.md): step 5 «سارة attempts to purge version 1» — there is no
// purge route in a subject space in Phase 1 (the allow-list never lists one); the refusal with a count is asserted by
// apps/server/test/forks/versions.test.ts. The Study Book citation needs an AI provider, which the E2E server has not.
import type { Page } from '@playwright/test';
import type { NotificationsResponse, PageRegionsResponse, PublicationView, PublishOfficialVersionPreview, ReanchorCopyPreview, ReanchorCopyRunResponse } from '@medlevo/shared';
import { sentences, type FixturePage } from '../apps/server/test/fixtures/versions/build';
import { expect, screenshot, test, waitForWorkspace } from './support';
import { axeInLooks } from './aos-p1-channels-helpers';
import {
  anchorOf,
  buildAosWorld,
  copyOf,
  createLayer,
  eventually,
  fixturePages,
  inkPayload,
  itemsOf,
  notePayload,
  op,
  pageIds,
  publishApi,
  publishWhenReady,
  push,
  startCopy,
  uploadOfficial,
  type AosWorld,
} from './support/aos-world';
import { pdfFrom } from '../apps/server/test/fixtures/versions/build';

const SEED = 52_000;

/** v2: two pages inserted after p.10 and the text of p.30 rewritten (its heading kept) — Scenario 4's structure. */
function versionTwo(v1: FixturePage[]): FixturePage[] {
  const inserted: FixturePage[] = [
    { heading: 'New: Coeliac trunk branches (added slide A)', lines: sentences(SEED + 901, 8) },
    { heading: 'New: Coeliac trunk branches (added slide B)', lines: sentences(SEED + 902, 8) },
  ];
  const pages = v1.map((p, i) => (i === 29 ? { heading: p.heading, lines: sentences(SEED + 930, 8) } : p));
  return [...pages.slice(0, 10), ...inserted, ...pages.slice(10)];
}

async function studyPanelClosed(page: Page, phone: boolean): Promise<void> {
  if (!phone) return;
  const sheet = page.getByRole('dialog', { name: 'لوحة الدراسة' });
  if (await sheet.isVisible()) {
    await sheet.getByRole('button', { name: 'إغلاق', exact: true }).click();
    await expect(sheet).toBeHidden();
  }
}

test('Scenario 4: a new official version — notes copied with one tap (or automatically), the review list, the followed explanation built on version 1', async ({ page, playwright, baseURL }, testInfo) => {
  test.setTimeout(600_000);
  const phone = testInfo.project.name === 'phone';
  const v1Pages = fixturePages('Lecture 5', 40, SEED);
  const w: AosWorld = await buildAosWorld({
    playwright,
    baseURL: baseURL!,
    project: testInfo.project.name,
    page: { key: 'zainab', page },
    people: { sara: { name: 'سارة', role: 'subject_moderator' }, hasan: { name: 'حسن' }, zainab: { name: 'زينب' }, huda: { name: 'هدى' } },
    lecture: { title: 'Lecture 5 — The abdominal wall', pages: v1Pages, fileName: 'Abdomen lec5.pdf' },
  });
  try {
    const { sara, hasan, zainab, huda } = w.people as Record<string, NonNullable<AosWorld['people'][string]>>;

    // ── step 1: زينب's notes on v1; حسن's explanation on p.10–14 that she follows; هدى with the automatic move ──
    const zCopy = await startCopy(w, zainab!, { mode: 'personal' });
    const src = zCopy.source_id;
    const v1 = zCopy.lecture!.version_id;
    const ids = await pageIds(zainab!, src, v1);
    const A = (p: number) => anchorOf(src, v1, ids, p - 1);
    const regions = await zainab!.api.get<PageRegionsResponse>(w.S(`/sources/pages/${ids[11]}/regions`));
    const para = regions.regions.find((r) => r.kind !== 'heading' && r.kind !== 'header' && r.kind !== 'footer' && !!r.text && !!r.bbox)!;
    expect(para, 'a text region on p.12 to highlight').toBeTruthy();
    const quote = para.text!.replace(/\s+/g, ' ').trim().slice(0, 40).trim();
    const Z = { ink: `${w.stamp}ZINK`.toUpperCase(), hl: `${w.stamp}ZHL`.toUpperCase(), n30: `${w.stamp}ZN30`.toUpperCase() };
    await push(zainab!, [
      op('annotation', Z.ink, inkPayload(A(5), 0.2, 0.3, null), 'append'),
      op('annotation', Z.hl, { kind: 'text_highlight', tool: 'highlight', anchor: A(12), layer: 'highlight', z: 0, locked: false, layer_id: null, data: { v: 1, style: 'highlight', color: 'marker-yellow', rects: [{ x: para.bbox!.x, y: para.bbox!.y, w: para.bbox!.w, h: Math.min(0.02, para.bbox!.h) }], quote: { exact: quote } } }, 'append'),
      op('note', Z.n30, notePayload(A(30), 'ملاحظتي على صفحة جدار البطن 30', null)),
    ]);
    const hCopy = await startCopy(w, hasan!, { mode: 'personal' });
    const hLayer = await createLayer(hasan!, hCopy.source_id, 'شرحي');
    await push(hasan!, [10, 11, 12, 13, 14].map((p) => op('annotation', `${w.stamp}H${p}`.toUpperCase(), inkPayload(A(p), 0.15, 0.5, hLayer), 'append')));
    const pub = await publishApi(w, hasan!, [hLayer], 'شرح حسن');
    const zFollow = await startCopy(w, zainab!, { mode: 'followed', publication_id: pub.id });
    const hudaCopy = await startCopy(w, huda!, { mode: 'personal' });
    await huda!.api.patch(`/api/copies/${hudaCopy.id}`, { reanchor_policy: 'auto' });
    await push(huda!, [op('annotation', `${w.stamp}UINK`.toUpperCase(), inkPayload(A(5), 0.3, 0.4, null), 'append'), op('note', `${w.stamp}UN30`.toUpperCase(), notePayload(A(30), 'ملاحظة هدى على الصفحة 30', null))]);

    const v1State = async () => {
      const it = await itemsOf(zainab!, src, v1);
      const mine = new Set(Object.values(Z));
      return JSON.stringify({ a: it.annotations.filter((a) => mine.has(a.id)).sort((x, y) => x.id.localeCompare(y.id)), n: it.notes.filter((n) => mine.has(n.id)) });
    };
    const before = await v1State();
    expect(JSON.parse(before).a).toHaveLength(2);
    expect(JSON.parse(before).n).toHaveLength(1);

    // ── steps 2–3: سارة uploads the renamed file with 2 inserted pages and a rewritten p.30, previews, publishes ──
    const v2 = await uploadOfficial(sara!, w.spaceId, w.lecture.id, 'Abdomen lec5 final (1).pdf', pdfFrom(versionTwo(v1Pages), { tag: `TEST FIXTURE ${w.stamp}` }));
    const preview = await eventually(
      () => sara!.api.post<PublishOfficialVersionPreview>(w.S(`/lectures/${w.lecture.id}/versions/${v2}/publish`), { preview: true }).catch(() => null),
      (p) => !!p && p.changes !== null,
      'the publish preview with the page changes',
      180_000,
    );
    expect(preview!.version.version_no).toBe(2);
    expect(preview!.changes).toMatchObject({ inserted: 2 });
    expect((preview!.changes!.changed ?? 0) + (preview!.changes!.edited ?? 0)).toBeGreaterThanOrEqual(1);
    // the holders, as a count (3 students hold a copy: suppressed under 5, never names)
    expect(preview!.holders).toEqual({ value: null, label_ar: 'أقل من 5' });
    await publishWhenReady(sara!, w.spaceId, w.lecture.id, v2, 'أُضيفت شريحتان بعد الصفحة 10 وصُحّح نص الصفحة 30');

    // ── step 6 (auto): هدى's notes are copied without a tap, with the report in her inbox ──
    const hudaV2 = await eventually(() => itemsOf(huda!, src, v2), (it) => it.annotations.some((a) => a.migrated_from_id === `${w.stamp}UINK`.toUpperCase()), 'هدى’s ink copied to version 2 automatically', 120_000);
    expect(hudaV2.annotations.find((a) => a.migrated_from_id === `${w.stamp}UINK`.toUpperCase())).toMatchObject({ origin: 'reanchor_copy', anchor: { version_id: v2, page_index: 4 } });
    await eventually(async () => (await huda!.api.get<NotificationsResponse>('/api/notifications')).items.some((n) => n.kind === 'reanchor_ready'), Boolean, 'the automatic move’s report in هدى’s inbox');

    let pv: ReanchorCopyPreview | null = null;
    await test.step('4. «يوجد إصدار أحدث من المحاضرة»; the preview changes nothing', async () => {
      pv = await eventually(() => zainab!.api.get<ReanchorCopyPreview>(`/api/annotations/reanchor-copy?source_id=${src}&to_version_id=${v2}`), (p) => p.state === 'ready', 'her page map is ready', 120_000);
      // her three items: 2 copied safely, the p.30 note to review; حسن's followed items stay with his explanation
      expect(pv).toMatchObject({ copy: 2, needs_review: 1 });
      expect(pv!.total).toBe(pv!.copy + pv!.needs_review + pv!.kept + pv!.already_moved);
      await page.goto(`/study/${src}`);
      await waitForWorkspace(page);
      const bar = page.getByRole('region', { name: 'نسختي من المحاضرة الرسمية' });
      await expect(bar.getByText('متابَعة: شرح حسن · حسن · الإصدار 1')).toBeVisible({ timeout: 30_000 });
      await expect(bar.getByText('الشرح مبني على الإصدار 1 من المحاضرة')).toBeVisible();
      const banner = page.locator('.ml-migrate-banner');
      await expect(banner).toContainText('يوجد إصدار أحدث من المحاضرة', { timeout: 30_000 });
      await expect(banner).toContainText(pv!.summary_ar);
      await banner.getByRole('button', { name: 'معاينة النقل…' }).click();
      const dialog = page.getByRole('dialog', { name: 'انقل ملاحظاتي إلى الإصدار 2' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/نسخ، لا نقل/)).toBeVisible();
      await screenshot(page, testInfo, 'aos-s4-migrate-preview');
      expect(await axeInLooks(page, 'official-version move preview', '[role="dialog"]')).toEqual([]);
      expect(await v1State()).toBe(before);
    });

    await test.step('4. ONE tap copies the p.5 ink and the p.12 highlight (to p.14); the p.30 note is placed from the review list', async () => {
      const dialog = page.getByRole('dialog', { name: 'انقل ملاحظاتي إلى الإصدار 2' });
      await dialog.getByRole('button', { name: 'انقل ملاحظاتي إلى الإصدار 2' }).click();
      const report = page.getByRole('dialog', { name: 'تقرير نقل الملاحظات' });
      await expect(report).toBeVisible({ timeout: 30_000 });
      await expect(report.getByText(new RegExp(`قبل النقل: ${pv!.total} = نُقل 2 \\+ تحتاج مراجعة 1 \\+ بقي ${pv!.kept}\\.`))).toBeVisible();
      await screenshot(page, testInfo, 'aos-s4-migrate-report');
      const at2 = await itemsOf(zainab!, src, v2);
      const copyOfItem = (from: string) => at2.annotations.find((a) => a.migrated_from_id === from);
      expect(copyOfItem(Z.ink)).toMatchObject({ origin: 'reanchor_copy', anchor_status: 'reanchored', anchor: { version_id: v2, page_index: 4 } });
      expect(copyOfItem(Z.hl)).toMatchObject({ origin: 'reanchor_copy', anchor: { version_id: v2, page_index: 13 } });
      expect(await v1State(), 'her v1 rows are unchanged (copied, never moved)').toBe(before);

      await report.getByRole('button', { name: 'راجع العناصر (1)' }).click();
      const list = page.getByRole('list', { name: 'تحتاج مراجعة من الإصدار 1' });
      await expect(list).toBeVisible({ timeout: 30_000 });
      const changed = list.getByRole('listitem').filter({ hasText: 'ملاحظتي على صفحة جدار البطن 30' });
      await expect(changed).toContainText('تغيّر نص صفحتها');
      await expect(changed.getByRole('img', { name: /من الإصدار 1/ })).toBeVisible();
      await screenshot(page, testInfo, 'aos-s4-review-list');
      await changed.getByRole('button', { name: 'اختر مكانها…' }).click();
      const place = page.getByRole('dialog', { name: 'أين تنسخ الملاحظة في الإصدار 2؟' });
      await expect(place).toBeVisible();
      await expect(place.getByLabel('الصفحة', { exact: true })).toHaveValue('31');
      await place.getByRole('button', { name: 'انسخها هنا' }).click();
      await expect(place).toBeHidden({ timeout: 15_000 });
      await expect(page.getByRole('list', { name: 'تحتاج مراجعة من الإصدار 1' })).toHaveCount(0, { timeout: 15_000 });
      const after = await itemsOf(zainab!, src, v2);
      expect(after.notes.find((n) => n.migrated_from_id === Z.n30)?.anchor).toMatchObject({ version_id: v2, page_index: 31 });
      expect(await v1State()).toBe(before);
      await studyPanelClosed(page, phone);
    });

    await test.step('حسن copies his explanation with the same flow and republishes: her followed copy then says «مبني على الإصدار 2»', async () => {
      const hp = await eventually(() => hasan!.api.get<ReanchorCopyPreview>(`/api/annotations/reanchor-copy?source_id=${src}&to_version_id=${v2}`), (p) => p.state === 'ready', 'his page map', 120_000);
      const run = await hasan!.api.post<ReanchorCopyRunResponse>('/api/annotations/reanchor-copy', { source_id: src, from_version_id: hp.from_version!.id, to_version_id: v2, map_computed_at: hp.map_computed_at });
      expect(run.report.copied).toBe(5);
      const r = await hasan!.api.post<PublicationView>(w.S(`/publications/${pub.id}/versions`), { layer_ids: [hLayer], change_note: 'نقلت الشرح إلى الإصدار 2 من المحاضرة' });
      expect(r.versions.map((v) => v.lecture_version_no)).toEqual([1, 2]);
      const c = await eventually(() => copyOf(zainab!, zFollow.id), (x) => x.pending_version_no === 2, 'her followed copy has version 2 pending');
      expect(c.publication).toMatchObject({ built_on_version_no: 1, pending_built_on_version_no: 2 });
      await page.reload();
      await waitForWorkspace(page);
      const bar = page.getByRole('region', { name: 'نسختي من المحاضرة الرسمية' });
      await expect(bar.getByText('تحديث متاح من حسن: الإصدار 2 (مبني على الإصدار 2 من المحاضرة)')).toBeVisible({ timeout: 30_000 });
      await bar.getByRole('button', { name: 'اعرض التغييرات' }).click();
      const dialog = page.getByRole('dialog', { name: 'تحديث الشرح' });
      await expect(dialog.getByText(/ملاحظاتك الشخصية: لا يتغيّر منها أي عنصر/)).toBeVisible();
      await dialog.getByRole('button', { name: 'طبّق التحديث' }).click();
      await expect(bar.getByText('الشرح مبني على الإصدار 2 من المحاضرة')).toBeVisible({ timeout: 15_000 });
      const followed = (await itemsOf(zainab!, src)).annotations.filter((a) => a.layer_id === zFollow.copied_layer_id);
      expect(followed).toHaveLength(5);
      for (const a of followed) expect(a.anchor).toMatchObject({ version_id: v2 });
      expect(await v1State()).toBe(before);
      await screenshot(page, testInfo, 'aos-s4-followed-built-on-v2');
    });
  } finally {
    await w.dispose();
  }
});
