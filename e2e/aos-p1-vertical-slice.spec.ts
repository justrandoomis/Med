// Academic OS — the Phase 1 vertical slice (PRD §5.3; BUILD_PLAN §3.7, P1-T5 step 3) against the REAL server and the
// built web app, in the browser of each person who acts in it (phone project 390 × 844; desktop project at a TABLET
// viewport 834 × 1194, as the slice asks):
//   a new user (زينب) joins the subject with a class code → opens the official lecture → «ابدأ الدراسة» creates her
//   personal copy → writes OFFLINE → syncs → picks حسن's course-only explanation (published from HIS browser through
//   «انشر شرحك») as a followed copy → حسن publishes an update from his browser → she previews and applies it with her ink
//   intact → the moderator uploads version 2 with inserted pages → her notes move after one tap → she reports the
//   explanation («أبلغ») and the subject's Assistant hides it with a reason and restores it.
// Blocked here: the iPad offline-writing run on a real device (`[dev]` part of the slice) — «Not run (no device)»; mouse
// input through Playwright says nothing about pen latency or palm rejection.
import type { BrowserContext, Page } from '@playwright/test';
import type { DocumentCopyView, ReanchorCopyPreview, ReportView } from '@medlevo/shared';
import { expect, screenshot, test, waitForWorkspace } from './support';
import { axeInLooks } from './aos-p1-channels-helpers';
import { mouseStroke, pickInkTool } from './g6-helpers';
import { sentences, pdfFrom } from '../apps/server/test/fixtures/versions/build';
import { anchorOf, buildAosWorld, createLayer, eventually, fixturePages, inkPayload, itemsOf, layerFingerprint, op, pageIds, publishWhenReady, push, uploadOfficial, type AosWorld } from './support/aos-world';

test.use({ allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch|NetworkError|net::ERR/i] });

const SEED = 63_000;
const summary = (page: Page, i: number) => page.locator(`.wk-page[data-page-index="${i}"] .ml-ink-layer p.ml-visually-hidden`);
const inkCount = async (page: Page, i: number) => Number(/خطوط بالقلم (\d+)/.exec((await summary(page, i).textContent()) ?? '')?.[1] ?? 0);

test('Phase 1 vertical slice: join → study → write offline → follow a classmate’s explanation → his update → a new official version → report, hide, restore', async ({ page, context, browser, playwright, baseURL }, testInfo) => {
  test.setTimeout(600_000);
  const phone = testInfo.project.name === 'phone';
  if (!phone) await page.setViewportSize({ width: 834, height: 1194 });
  const use = testInfo.project.use;
  const hasanContext: BrowserContext = await browser.newContext({
    baseURL,
    viewport: phone ? use.viewport : { width: 834, height: 1194 },
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    deviceScaleFactor: use.deviceScaleFactor,
    locale: 'ar-IQ',
    timezoneId: 'Asia/Baghdad',
    serviceWorkers: 'block',
  });
  const hasanPage = await hasanContext.newPage();
  const v1Pages = fixturePages('Lecture 5', 12, SEED);
  const w: AosWorld = await buildAosWorld({
    playwright,
    baseURL: baseURL!,
    project: testInfo.project.name,
    page: { key: 'zainab', page },
    pages: [{ key: 'hasan', page: hasanPage }],
    // زينب is a new account of the platform (another subject's code) who is NOT yet a member of Anatomy
    people: { sara: { name: 'سارة', role: 'subject_moderator' }, mustafa: { name: 'مصطفى', role: 'assistant' }, hasan: { name: 'حسن' }, zainab: { name: 'زينب', outsider: true } },
    lecture: { title: 'Lecture 5 — Anatomy of the Abdomen', pages: v1Pages, fileName: 'lecture5.pdf' },
  });
  try {
    const { sara, mustafa, hasan, zainab } = w.people as Record<string, NonNullable<AosWorld['people'][string]>>;

    await test.step('she joins the subject with the class code', async () => {
      await page.goto('/channels');
      await page.getByRole('button', { name: 'انضم برمز أو QR' }).click();
      const sheet = page.getByRole('dialog', { name: 'انضم إلى مادة' });
      await sheet.getByLabel('رمز الانضمام أو رابط الدعوة').fill(w.code);
      await sheet.getByRole('button', { name: 'انضم', exact: true }).click();
      await expect(sheet.getByText('تم الانضمام')).toBeVisible();
      await sheet.getByRole('link', { name: 'افتح المادة' }).click();
      await expect(page.getByRole('heading', { level: 1, name: w.subject.title })).toBeVisible();
    });

    let personal: DocumentCopyView | null = null;
    await test.step('opens the official lecture → «ابدأ الدراسة» creates her personal copy', async () => {
      await page.getByRole('tab', { name: /المحاضرات/ }).click();
      await page.getByRole('link', { name: new RegExp(w.lecture.title.replace(/[—]/g, '.')) }).click();
      await expect(page.getByRole('heading', { level: 1, name: w.lecture.title })).toBeVisible();
      await page.getByRole('button', { name: 'ابدأ الدراسة' }).click();
      const dialog = page.getByRole('dialog', { name: 'ابدأ الدراسة' });
      await dialog.getByRole('button', { name: 'ابدأ الدراسة' }).click();
      await waitForWorkspace(page);
      personal = await eventually(async () => (await zainab!.api.get<{ copies: DocumentCopyView[] }>(`/api/copies?space_id=${w.spaceId}&lecture_id=${w.lecture.id}`)).copies.find((c) => c.mode === 'personal') ?? null, Boolean, 'her personal copy');
      await expect(page.getByRole('region', { name: 'نسختي من المحاضرة الرسمية' })).toBeVisible({ timeout: 30_000 });
    });
    const src = personal!.source_id;
    const v1 = personal!.lecture!.version_id;
    const ids = await pageIds(zainab!, src, v1);

    await test.step('writes OFFLINE on p.1, then syncs', async () => {
      await expect.poll(() => inkCount(page, 0), { timeout: 30_000 }).toBe(0);
      await context.setOffline(true);
      await pickInkTool(page, /^القلم/);
      const layer = page.locator('.wk-page[data-page-index="0"] .ml-ink-layer');
      await layer.scrollIntoViewIfNeeded();
      const b = (await layer.boundingBox())!;
      await mouseStroke(page, { x: b.x + b.width * 0.2, y: b.y + b.height * 0.45 }, { x: b.x + b.width * 0.6, y: b.y + b.height * 0.47 });
      await mouseStroke(page, { x: b.x + b.width * 0.25, y: b.y + b.height * 0.55 }, { x: b.x + b.width * 0.7, y: b.y + b.height * 0.56 });
      await expect.poll(() => inkCount(page, 0)).toBe(2);
      await screenshot(page, testInfo, 'aos-slice-offline-ink');
      await context.setOffline(false);
      await eventually(() => itemsOf(zainab!, src), (it) => it.annotations.filter((a) => a.kind === 'ink' && !a.layer_id).length === 2, 'her offline strokes reached the server', 60_000);
    });
    const mineBefore = layerFingerprint(await itemsOf(zainab!, src), [null]);

    // حسن's explanation (his device writes it through the sync API), published from HIS browser
    const hCopy = (await hasan!.api.post<{ copy: DocumentCopyView }>('/api/copies', { id: `${w.stamp}HCOPY`.toUpperCase(), space_id: w.spaceId, lecture_id: w.lecture.id, mode: 'personal' })).copy;
    const hLayer = await createLayer(hasan!, hCopy.source_id, 'شرحي');
    const A = (p: number) => anchorOf(src, v1, ids, p - 1);
    await push(hasan!, [1, 2, 3].flatMap((p) => [0, 1].map((k) => op('annotation', `${w.stamp}H${p}${k}`.toUpperCase(), inkPayload(A(p), 0.1 + k * 0.3, 0.3, hLayer), 'append'))));
    let pubId = '';
    await test.step('حسن publishes from his browser: «الشروحات» → «انشر شرحك» (his own layers only, a reminder about patients)', async () => {
      await hasanPage.goto(`/subjects/${w.spaceId}/lectures/${w.lecture.id}?tab=explanations`);
      await hasanPage.getByRole('button', { name: 'انشر شرحك' }).click();
      const dialog = hasanPage.getByRole('dialog', { name: 'انشر شرحك' });
      await expect(dialog.getByRole('checkbox', { name: /شرحي/ })).toBeChecked();
      await expect(dialog.getByText(/لا تنشر اسم مريض/)).toBeVisible();
      await dialog.getByRole('textbox', { name: /عنوان الشرح/ }).fill('شرح حسن');
      await screenshot(hasanPage, testInfo, 'aos-slice-publish-dialog');
      expect(await axeInLooks(hasanPage, 'publish dialog', '[role="dialog"]')).toEqual([]);
      await dialog.getByRole('button', { name: 'انشر', exact: true }).click();
      await expect(hasanPage.getByRole('heading', { level: 1, name: 'شرح حسن' })).toBeVisible({ timeout: 30_000 });
      pubId = hasanPage.url().split('/publications/')[1]!.split(/[?#]/)[0]!;
      await expect(hasanPage.getByText('نُشر 6 عناصر.')).toBeVisible();
      await expect(hasanPage.getByRole('button', { name: 'انشر إصدارًا جديدًا' })).toBeVisible();
      await expect(hasanPage.getByRole('button', { name: 'اسحب الشرح' })).toBeVisible();
      await expect(hasanPage.getByRole('button', { name: 'أبلغ' })).toHaveCount(0);
      await screenshot(hasanPage, testInfo, 'aos-slice-author-page');
      expect(await axeInLooks(hasanPage, 'author’s publication page')).toEqual([]);
    });

    let followedId = '';
    await test.step('she picks it as a followed copy (her own copy is not touched)', async () => {
      await page.goto(`/subjects/${w.spaceId}/lectures/${w.lecture.id}`);
      await page.getByRole('tab', { name: 'الشروحات' }).click();
      await page.getByRole('link', { name: /شرح حسن/ }).click();
      await page.getByRole('button', { name: 'ابدأ الدراسة بهذا الشرح' }).click();
      const dialog = page.getByRole('dialog', { name: 'ابدأ الدراسة بهذا الشرح' });
      await expect(dialog.getByRole('checkbox', { name: /انسخ ملاحظاتي من نسختي إليها/ })).not.toBeChecked();
      await dialog.getByRole('button', { name: 'ابدأ الدراسة' }).click();
      await waitForWorkspace(page);
      followedId = new URL(page.url()).searchParams.get('copy') ?? '';
      await expect(page.getByRole('region', { name: 'نسختي من المحاضرة الرسمية' }).getByText('متابَعة: شرح حسن · حسن · الإصدار 1')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => inkCount(page, 0), { timeout: 30_000 }).toBe(4);
    });
    expect(layerFingerprint(await itemsOf(zainab!, src), [null])).toBe(mineBefore);

    await test.step('حسن publishes an update from his browser; she previews and applies it with her ink intact', async () => {
      await push(hasan!, [4, 5].map((p) => op('annotation', `${w.stamp}H${p}U`.toUpperCase(), inkPayload(A(p), 0.2, 0.6, hLayer), 'append')));
      await hasanPage.getByRole('button', { name: 'انشر إصدارًا جديدًا' }).click();
      const dialog = hasanPage.getByRole('dialog', { name: 'انشر إصدارًا جديدًا' });
      await expect(dialog.getByRole('checkbox', { name: /شرحي/ })).toBeChecked();
      await dialog.getByRole('textbox', { name: /ما الذي تغيّر/ }).fill('أضفت الصفحتين 4 و5');
      await dialog.getByRole('button', { name: 'انشر الإصدار' }).click();
      await expect(hasanPage.getByText('أضفت الصفحتين 4 و5')).toBeVisible({ timeout: 30_000 });
      await eventually(() => zainab!.api.get<DocumentCopyView>(`/api/copies/${followedId}`), (c) => c.pending_version_no === 2, 'her copy has the update pending');
      await page.reload();
      await waitForWorkspace(page);
      const bar = page.getByRole('region', { name: 'نسختي من المحاضرة الرسمية' });
      await expect(bar.getByText('تحديث متاح من حسن: الإصدار 2')).toBeVisible({ timeout: 30_000 });
      await bar.getByRole('button', { name: 'اعرض التغييرات' }).click();
      const preview = page.getByRole('dialog', { name: 'تحديث الشرح' });
      await expect(preview.getByText('حسن: أضاف عنصرين في صفحتين')).toBeVisible();
      await screenshot(page, testInfo, 'aos-slice-update-preview');
      await preview.getByRole('button', { name: 'طبّق التحديث' }).click();
      await expect(bar.getByText('متابَعة: شرح حسن · حسن · الإصدار 2')).toBeVisible({ timeout: 15_000 });
      expect(layerFingerprint(await itemsOf(zainab!, src), [null]), 'her personal ink is intact').toBe(mineBefore);
    });

    await test.step('the moderator uploads version 2 with inserted pages; her notes move after ONE tap', async () => {
      const v1Rows = layerFingerprint(await itemsOf(zainab!, src, v1), [null]);
      const v2Pages = [...v1Pages.slice(0, 1), { heading: 'New: added slide (TEST FIXTURE)', lines: sentences(SEED + 900, 8) }, ...v1Pages.slice(1)];
      const v2 = await uploadOfficial(sara!, w.spaceId, w.lecture.id, 'Abdomen lec5 final (1).pdf', pdfFrom(v2Pages, { tag: `TEST FIXTURE ${w.stamp}` }));
      await publishWhenReady(sara!, w.spaceId, w.lecture.id, v2, 'أُضيفت شريحة بعد الصفحة 1');
      await eventually(() => zainab!.api.get<ReanchorCopyPreview>(`/api/annotations/reanchor-copy?source_id=${src}&to_version_id=${v2}`), (p) => p.state === 'ready', 'her page map', 120_000);
      await page.goto(`/study/${src}`);
      await waitForWorkspace(page);
      const banner = page.locator('.ml-migrate-banner');
      // she was reading version 1 (the reader remembers where she was): the banner offers version 2 first
      const open2 = banner.getByRole('button', { name: 'افتح الإصدار 2' }).or(banner.getByRole('link', { name: 'افتح الإصدار 2' }));
      if (await open2.first().isVisible().catch(() => false)) {
        await open2.first().click();
        await waitForWorkspace(page);
      }
      await expect(banner).toContainText('يوجد إصدار أحدث من المحاضرة', { timeout: 30_000 });
      await banner.getByRole('button', { name: 'معاينة النقل…' }).click();
      const dialog = page.getByRole('dialog', { name: 'انقل ملاحظاتي إلى الإصدار 2' });
      await dialog.getByRole('button', { name: 'انقل ملاحظاتي إلى الإصدار 2' }).click();
      const report = page.getByRole('dialog', { name: 'تقرير نقل الملاحظات' });
      await expect(report).toBeVisible({ timeout: 30_000 });
      await screenshot(page, testInfo, 'aos-slice-migrate-report');
      const at2 = await itemsOf(zainab!, src, v2);
      const moved = at2.annotations.filter((a) => a.migrated_from_id && !a.layer_id);
      expect(moved, 'both of her offline strokes are on version 2').toHaveLength(2);
      for (const a of moved) expect(a.anchor).toMatchObject({ version_id: v2, page_index: 0 });
      expect(layerFingerprint(await itemsOf(zainab!, src, v1), [null]), 'her v1 rows are unchanged (copied, never moved)').toBe(v1Rows);
      await report.getByRole('button', { name: 'تم' }).click();
    });

    await test.step('she reports the explanation («أبلغ»); the Assistant hides it with a reason, then restores it', async () => {
      await page.goto(`/subjects/${w.spaceId}/publications/${pubId}`);
      await page.getByRole('button', { name: 'أبلغ' }).click();
      const dialog = page.getByRole('dialog', { name: 'أبلغ عن هذا الشرح' });
      await dialog.getByRole('radio', { name: 'معلومة خاطئة' }).check();
      await dialog.getByRole('textbox', { name: /تفاصيل/ }).fill('السهم في الصفحة 2 يشير إلى الوريد');
      await screenshot(page, testInfo, 'aos-slice-report-dialog');
      expect(await axeInLooks(page, 'report dialog', '[role="dialog"]')).toEqual([]);
      const sent = page.waitForResponse((r) => r.url().endsWith('/api/moderation/reports') && r.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'أرسل البلاغ' }).click();
      const report = (await (await sent).json()) as ReportView;
      await expect(dialog).toBeHidden();
      await mustafa!.api.post('/api/moderation/actions', { report_id: report.id, action: 'hide', reason_ar: 'معلومة خاطئة في الصفحة 2' });
      await page.reload();
      await expect(page.getByRole('note').filter({ hasText: 'أخفى المشرف هذا الشرح: معلومة خاطئة في الصفحة 2. ما عندك باقٍ كما هو' })).toBeVisible();
      await expect(page.getByText('أخفاه المشرف')).toBeVisible();
      await screenshot(page, testInfo, 'aos-slice-hidden');
      await mustafa!.api.post('/api/moderation/actions', { target: { db: 'system', type: 'publication', id: pubId }, action: 'restore', reason_ar: 'صُحّح الخطأ.' });
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'شرح حسن' })).toBeVisible();
      await expect(page.getByText(/أخفى المشرف/)).toHaveCount(0);
      // nothing of hers was touched by the report, the hide or the restore
      const mine = (await itemsOf(zainab!, src)).annotations.filter((a) => !a.layer_id);
      expect(mine.filter((a) => !a.migrated_from_id)).toHaveLength(2);
      expect(mine.filter((a) => a.migrated_from_id)).toHaveLength(2);
    });
  } finally {
    await w.dispose();
    await hasanContext.close();
  }
});
