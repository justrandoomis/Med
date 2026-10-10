// G6 / AC-28 — «قدرات Pencil» (§60): a feature the browser does not support is never shown as working, and a mouse
// test is never recorded as a real-pen test. REAL app + server, headless Chromium — where the only real input is a
// MOUSE (no stylus, no iPad here). Checked:
//  * the on-device panel «قدرات القلم على هذا الجهاز» before and after writing with the mouse: pressure / tilt / hover
//    stay «not observed», native-only Pencil features say they need a native iPad app, handwriting recognition says it
//    is not built, palm rejection says it is approximate, and the panel itself says a mouse proves nothing about a pen;
//  * a stroke written with the mouse is STORED as a mouse stroke (pointer type, no pressure, no tilt, 3-value points);
//  * a SIMULATED pen (CDP pointer events with pointerType «pen» and the constant 0.5 pressure of pressure-less
//    hardware) is not reported as pressure-capable;
//  * the lasso's «تحويل إلى نص» is disabled with its reason; the Control Center summary says no real pen was tested and
//    the capability registry does not list recognition as available.
import type { AnnotationsByTargetsResponse, CapabilitiesResponse, InkData } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, setupOwner, test, type E2eApi } from './support';
import { mouseStroke, pickInkTool, wordBox } from './g6-helpers';
import type { Locator, Page } from '@playwright/test';

async function openPanel(page: Page): Promise<Locator> {
  const bar = page.getByRole('toolbar', { name: 'أدوات الكتابة' });
  await bar.getByRole('button', { name: 'المزيد من أدوات الكتابة' }).click();
  await page.getByRole('menuitem', { name: 'قدرات القلم على هذا الجهاز' }).click();
  const dialog = page.getByRole('dialog', { name: 'قدرات القلم على هذا الجهاز' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** status pill text of one capability row */
const rowState = (dialog: Locator, label: string | RegExp) => dialog.locator('.ml-ink-caps__row').filter({ has: dialog.page().locator('.ml-ink-caps__label', { hasText: label }) }).locator('.ml-pill, [class*="pill"]').first();

async function expectNativeAndHonestRows(dialog: Locator) {
  for (const native of ['حبر PencilKit بأقل تأخير', 'النقر المزدوج على القلم', 'الضغط على جسم القلم (Squeeze)', 'Scribble']) {
    await expect(rowState(dialog, native), native).toHaveText('يتطلب تطبيق iPad أصليًا');
  }
  await expect(rowState(dialog, 'التعرف على الخط اليدوي')).toHaveText('غير منفّذ بعد');
  await expect(rowState(dialog, 'رفض راحة اليد')).toHaveText('تقريبي على الويب');
}

async function lecture(page: Page, api: E2eApi, title: string) {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title });
  expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');
  const pageId = (await api.get<{ pages: Array<{ id: string; page_index: number }> }>(`/api/sources/${up.source_id}/versions/${up.version_id}/pages`)).pages.find((p) => p.page_index === 0)!.id;
  await openWorkspace(page, up.source_id, { pageIndex: 0 });
  return { up, pageId };
}

test.describe('G6 AC-28 pen capabilities are reported honestly', () => {
  test('mouse only: the panel never claims pen hardware; native-only features say so; a mouse stroke is stored as a mouse stroke', async ({ page, api }, testInfo) => {
    const { pageId } = await lecture(page, api, `G6 AC-28 ${testInfo.project.name}`);

    const dialog = await openPanel(page);
    await test.step('before any input: nothing about the pen is claimed', async () => {
      for (const hw of ['الضغط', 'الميل', 'تمرير القلم فوق الشاشة']) await expect(rowState(dialog, new RegExp(`^${hw}$`)), hw).toHaveText('لم يُرصد بعد');
      await expectNativeAndHonestRows(dialog);
      // offline writing is claimed only after the local database really opened
      await expect(rowState(dialog, 'الكتابة دون اتصال')).toHaveText('مدعوم ورُصد هنا');
    });

    await test.step('write in the test area with the MOUSE: still no pen claim, and the panel says a mouse proves nothing', async () => {
      const pad = dialog.getByRole('img', { name: /مساحة اختبار القلم/ });
      const b = (await pad.boundingBox())!;
      await mouseStroke(page, { x: b.x + 10, y: b.y + b.height / 2 }, { x: b.x + b.width - 10, y: b.y + b.height / 2 });
      await expect(dialog.locator('.ml-ink-caps__readout')).toContainText('فأرة');
      for (const hw of ['الضغط', 'الميل', 'تمرير القلم فوق الشاشة']) {
        await expect(rowState(dialog, new RegExp(`^${hw}$`)), hw).toHaveText('لم يُرصد بعد');
      }
      await expectNativeAndHonestRows(dialog);
      const honesty = dialog.locator('.ml-ink-caps__honesty');
      await expect(honesty).toContainText('رُصدت فأرة فقط حتى الآن.');
      await expect(honesty).toContainText('لا يثبت جودة الكتابة');
      await expect(honesty).toContainText('Apple Pencil');
      await expect(honesty).toContainText('يلزم اختبار بقلم فعلي على الجهاز');
      await screenshot(page, testInfo, 'g6-ac28-panel-mouse');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });

    await test.step('a stroke written on the page with the pen tool by mouse is recorded as a MOUSE stroke', async () => {
      await pickInkTool(page, /^القلم/);
      const w = await wordBox(page, 0, /^McBurney$/);
      await mouseStroke(page, { x: w.left + 4, y: (w.top + w.bottom) / 2 }, { x: w.right - 4, y: (w.top + w.bottom) / 2 });
      await expect
        .poll(async () => (await api.get<AnnotationsByTargetsResponse>(`/api/annotations/by-targets?keys=${encodeURIComponent(`source_page:${pageId}`)}`)).annotations.filter((a) => a.kind === 'ink').length, { timeout: 30_000 })
        .toBe(1);
      const ink = (await api.get<AnnotationsByTargetsResponse>(`/api/annotations/by-targets?keys=${encodeURIComponent(`source_page:${pageId}`)}`)).annotations.find((a) => a.kind === 'ink')!;
      expect(ink.input).toEqual({ pointer_type: 'mouse', pressure: false, tilt: false });
      const d = ink.data as InkData;
      expect(d.pressure_available).toBe(false);
      expect(d.tilt_available).toBe(false);
      expect(d.points.every((p) => p.length === 3)).toBe(true); // [x, y, t] — no invented pressure / tilt values
    });

    await test.step('the lasso offers «تحويل إلى نص» only as disabled, with its reason', async () => {
      await pickInkTool(page, /التحديد الحر/);
      const w = await wordBox(page, 0, /^McBurney$/);
      await page.mouse.click((w.left + w.right) / 2, (w.top + w.bottom) / 2);
      await page.getByRole('button', { name: 'المزيد', exact: true }).last().click();
      const convert = page.getByRole('menuitem', { name: /تحويل إلى نص/ });
      await expect(convert).toHaveAttribute('aria-disabled', 'true');
      await expect(convert).toContainText('يحتاج التعرف على الخط اليدوي، ولم يُبنَ بعد.');
      await page.keyboard.press('Escape');
    });
  });

  test('a SIMULATED pen with the constant 0.5 pressure of pressure-less hardware is not reported as pressure-capable', async ({ page, api }, testInfo) => {
    await lecture(page, api, `G6 AC-28 pen ${testInfo.project.name}`);
    const dialog = await openPanel(page);
    const pad = dialog.getByRole('img', { name: /مساحة اختبار القلم/ });
    const b = (await pad.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const y = b.y + b.height / 2;
    const ev = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number) =>
      cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force: type === 'mouseReleased' ? 0 : 0.5 });
    await ev('mousePressed', b.x + 10);
    for (let i = 1; i <= 8; i++) await ev('mouseMoved', b.x + 10 + i * ((b.width - 20) / 8));
    await ev('mouseReleased', b.x + b.width - 10);
    await expect(dialog.locator('.ml-ink-caps__readout')).toContainText('قلم');
    // a pen was seen, but it never reported varying pressure / tilt / hover → «not reported», never «supported»
    await expect(rowState(dialog, /^الضغط$/)).toHaveText('لا يبلّغ عنه هذا الجهاز');
    await expect(rowState(dialog, /^الميل$/)).toHaveText('لا يبلّغ عنه هذا الجهاز');
    await expect(rowState(dialog, 'تمرير القلم فوق الشاشة')).toHaveText('لا يبلّغ عنه هذا الجهاز');
    await expectNativeAndHonestRows(dialog);
    // the honesty line stays: simulated input proves nothing about a real Pencil
    await expect(dialog.locator('.ml-ink-caps__honesty')).toContainText('اختبار الفأرة أو اللمس أو المحاكاة لا يثبت جودة الكتابة');
    await screenshot(page, testInfo, 'g6-ac28-panel-simulated-pen');
  });

  test('Control Center: the pen summary says no real pen was tested; recognition is not listed as working', async ({ page, api }, testInfo) => {
    await setupOwner(page);
    const caps = await api.get<CapabilitiesResponse>('/api/capabilities');
    expect(caps.features['workspace.handwriting_recognition']?.state).not.toBe('available');
    expect(caps.features['workspace.ink']?.state).toBe('available');
    await page.goto('/control/capabilities');
    const pen = page.locator('section', { has: page.getByRole('heading', { name: /القلم والكتابة/ }) });
    await expect(pen).toContainText('لم يُختبر أي قلم حقيقي (Apple Pencil أو غيره) على أي جهاز');
    await expect(pen).toContainText('بالفأرة في Chromium');
    await expect(pen).toContainText('غير متاحة على الويب');
    // pressure / tilt / hover ran only with simulated events: never summarised as «working» (wording fixed in G6)
    await expect(pen).toContainText('لم تُشغَّل إلا بأحداث محاكاة');
    await expect(pen).not.toContainText('مبنية وتعمل');
    await expect(pen).toContainText('اختُبرت آليًا بالفأرة في Chromium');
    const rec = page.locator('.cc-cap', { hasText: 'التعرف على خط اليد' });
    await expect(rec).toBeVisible();
    await expect(rec).not.toContainText('تعمل');
    await screenshot(page, testInfo, 'g6-ac28-control-center', { fullPage: true });
  });
});
