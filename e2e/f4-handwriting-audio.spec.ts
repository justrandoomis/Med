// Track F4 — handwriting recognition & in-app recording, REAL app + server (no AI key here), Golden Set lecture.
//  1. Recognition is honest on this server: the capability is `requires_configuration` (no vision provider), a
//     recognition request is refused with AI_NOT_CONFIGURED, and in the reader the lasso's «تحويل إلى نص» is disabled
//     with that reason. «اسأل عن المحدد» still works without it: the owner types what the handwriting says, the server
//     (deterministic) finds the paragraph next to the writing and the composed question lands in the study rail's chat
//     composer — nothing is sent (the chat itself needs a key and says so).
//  2. Recording with a fake microphone (Chromium flags): nothing records before the owner's click; the indicator with
//     «يُسجَّل الآن» and «إيقاف التسجيل» is visible while recording; a pen stroke written meanwhile gets an AUTOMATIC
//     time link; after «إيقاف» the recording is stored on the device and uploaded as a «ملاحظة صوتية» source; the
//     stroke's moment plays from the lasso; the audio screen lists the stroke with its page.
import type { Page } from '@playwright/test';
import type { CapabilitiesResponse, RecordingView } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, setupOwner, test } from './support';
import { mouseStroke, pickInkTool, viewMenuItem, wordBox } from './g6-helpers';

const executablePath = process.env.PW_CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// a fake microphone (a generated tone) and no permission prompt: the recording path runs for real in Chromium
test.use({
  launchOptions: { executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  permissions: ['microphone'],
});

const WORD = /^McBurney$/;

async function lectureOpen(page: Page, api: import('./support').E2eApi, title: string) {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title });
  expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');
  return up;
}

/** a pen stroke across the printed word (mouse input), then the lasso picks it with a tap */
async function writeOnWordAndSelect(page: Page) {
  const span = page.locator('.wk-page[data-page-index="0"] .wk-textlayer span').filter({ hasText: WORD }).first();
  await expect(span).toBeAttached({ timeout: 30_000 });
  await span.scrollIntoViewIfNeeded();
  await pickInkTool(page, /^القلم/);
  const b = await wordBox(page, 0, WORD);
  const y = (b.top + b.bottom) / 2;
  await mouseStroke(page, { x: b.left + (b.right - b.left) * 0.15, y }, { x: b.left + (b.right - b.left) * 0.85, y });
  await pickInkTool(page, /التحديد الحر/);
  await page.mouse.click(b.left + (b.right - b.left) * 0.5, y);
  await expect(page.getByRole('toolbar', { name: /^إجراءات التحديد/ })).toBeVisible();
  return b;
}

test.describe('F4 handwriting recognition on a server without a vision provider', () => {
  test('recognition says requires_configuration; «اسأل عن المحدد» composes a question with the paragraph for the rail', async ({ page, api }, testInfo) => {
    const up = await lectureOpen(page, api, `F4 ask ${testInfo.project.name}`);

    await test.step('capability and API are honest', async () => {
      const caps = await api.get<CapabilitiesResponse>('/api/capabilities');
      const rec = caps.features['workspace.handwriting_recognition'];
      expect(rec.state).toBe('requires_configuration');
      expect(rec.reason_ar).toMatch(/vision/);
      const res = await api.call('POST', '/api/annotations/recognitions', {
        id: `E2E${Date.now()}`,
        purpose: 'page_ink',
        lang: 'mixed',
        annotation_ids: ['X'],
        anchor: { type: 'page', source_id: up.source_id, version_id: up.version_id, page_id: 'X', page_index: 0 },
        image_png_base64: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAAAAAA6mKC9AAAAEklEQVR4nGP4z8AARAwMDAwMAD7+B/n0VUu5AAAAAElFTkSuQmCC',
      });
      expect(res.status()).toBe(409);
      expect((await res.json()).error.code).toBe('AI_NOT_CONFIGURED');
    });

    await openWorkspace(page, up.source_id, { pageIndex: 0 });
    await writeOnWordAndSelect(page);

    await test.step('the lasso menu: «تحويل إلى نص» disabled with the reason; «اسأل عن المحدد» available', async () => {
      await page.getByRole('toolbar', { name: /^إجراءات التحديد/ }).getByRole('button', { name: 'المزيد' }).click();
      const convert = page.getByRole('menuitem', { name: /تحويل إلى نص/ });
      await expect(convert).toHaveAttribute('aria-disabled', 'true');
      await expect(convert).toContainText(/vision/);
      await screenshot(page, testInfo, 'f4-lasso-menu');
      await page.getByRole('menuitem', { name: /اسأل عن المحدد/ }).click();
    });

    await test.step('the owner types what the handwriting says; the paragraph next to it is found; the question goes to the rail', async () => {
      const dialog = page.getByRole('dialog', { name: 'اسأل عن المحدد' });
      await expect(dialog).toBeVisible();
      // the picture that WOULD be sent: the owner's strokes only
      await expect(dialog.getByRole('img', { name: /الكتابة المحددة كما تُرسل/ })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'اقرأ الخط' })).toBeDisabled();
      await expect(dialog.getByText(/vision/).first()).toBeVisible();
      await dialog.getByLabel('ما الذي كتبته بخط يدك؟').fill('ليش؟');
      await dialog.getByRole('button', { name: 'جهّز السؤال مع الفقرة المجاورة' }).click();
      const q = dialog.getByLabel('سؤالك (يمكنك تعديله)');
      await expect(q).toHaveValue(/«ليش؟»/);
      await expect(q).toHaveValue(/McBurney/);
      await expect(dialog.getByText(/لا يُرسل شيء تلقائيًا/)).toBeVisible();
      await screenshot(page, testInfo, 'f4-ask-question');
      await dialog.getByRole('button', { name: 'ضع السؤال في لوحة الدراسة' }).click();
      const composer = page.getByLabel('سؤالك عن هذا الموضع');
      await expect(composer).toHaveValue(/«ليش؟»/, { timeout: 15_000 });
      // the chat needs a key on this server: it says so, and nothing was sent
      await expect(page.getByText(/ANTHROPIC_API_KEY/).first()).toBeVisible();
      await screenshot(page, testInfo, 'f4-ask-in-rail');
    });
  });
});

test.describe('F4 in-app recording (fake microphone)', () => {
  test('explicit start, visible indicator and stop, automatic time link on a stroke, stored as a voice note, plays that moment', async ({ page, api }, testInfo) => {
    // count every microphone request the page makes
    await page.addInitScript(() => {
      const w = window as unknown as { __gum: number };
      w.__gum = 0;
      const md = navigator.mediaDevices;
      if (md?.getUserMedia) {
        const orig = md.getUserMedia.bind(md);
        md.getUserMedia = (c?: MediaStreamConstraints) => {
          w.__gum++;
          return orig(c);
        };
      }
    });
    const up = await lectureOpen(page, api, `F4 rec ${testInfo.project.name}`);
    await openWorkspace(page, up.source_id, { pageIndex: 0 });
    const gum = () => page.evaluate(() => (window as unknown as { __gum: number }).__gum);
    const bar = page.getByRole('region', { name: 'التسجيل الصوتي' });

    await test.step('nothing records on its own', async () => {
      await page.waitForTimeout(1000);
      expect(await gum()).toBe(0);
      await expect(bar).toHaveCount(0);
    });

    await test.step('«سجّل ملاحظة صوتية…» starts it: indicator, time and stop control stay visible', async () => {
      await viewMenuItem(page, 'سجّل ملاحظة صوتية…');
      await expect(bar).toBeVisible();
      await expect(bar).toContainText('يُسجَّل الآن');
      await expect(bar.getByRole('button', { name: 'إيقاف التسجيل' })).toBeVisible();
      expect(await gum()).toBe(1);
      await page.waitForTimeout(1500);
      await screenshot(page, testInfo, 'f4-recording');
    });

    let word = { left: 0, top: 0, right: 0, bottom: 0 };
    await test.step('a stroke written while recording, then stop', async () => {
      word = await writeOnWordAndSelect(page);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      await bar.getByRole('button', { name: 'إيقاف التسجيل' }).click();
      await expect(bar).toContainText('حُفظ التسجيل', { timeout: 15_000 });
    });

    let recording: RecordingView | null = null;
    await test.step('uploaded as a «ملاحظة صوتية» source, linked to the lecture; the stroke carries an automatic link', async () => {
      await expect
        .poll(
          async () => {
            const r = await api.get<{ recordings: RecordingView[] }>(`/api/media/recordings?source_id=${up.source_id}`);
            recording = r.recordings[0] ?? null;
            return recording?.linked_strokes.length ?? 0;
          },
          { timeout: 60_000, message: 'recording uploaded and the stroke synced' },
        )
        .toBeGreaterThan(0);
      const rec = recording as unknown as RecordingView;
      expect(rec.linked_source_id).toBe(up.source_id);
      expect(rec.mime).toMatch(/^audio\//);
      expect(rec.stream_url).toMatch(/\/api\/media\/audio\/.+\/stream/);
      const link = rec.linked_strokes[0]!;
      expect(link.origin).toBe('auto');
      expect(link.offset_ms).toBeGreaterThan(500);
      expect(link.offset_ms).toBeLessThan(60_000);
      expect(link.page_index).toBe(0);
      const src = await api.get<{ source_type: string }>(`/api/sources/${rec.source_id}`);
      expect(src.source_type).toBe('my_audio_note');
    });

    await test.step('tapping the stroke with the lasso plays that moment (labelled automatic)', async () => {
      await pickInkTool(page, /التحديد الحر/);
      await page.mouse.click(word.left + (word.right - word.left) * 0.5, (word.top + word.bottom) / 2);
      const play = page.getByRole('button', { name: /^استمع من \d+:\d\d في التسجيل \(رابط تلقائي\)$/ });
      await expect(play).toBeVisible();
      await play.click();
      const player = page.getByRole('region', { name: 'تشغيل التسجيل' });
      await expect(player).toBeVisible();
      await expect(player.locator('audio')).toHaveAttribute('src', /^blob:|\/api\/media\/audio\//);
      await expect(player).toContainText('رابط زمني تلقائي');
      await screenshot(page, testInfo, 'f4-play-moment');
    });

    await test.step('the audio screen lists the stroke written during the recording', async () => {
      const rec = recording as unknown as RecordingView;
      await page.goto(`/media/audio/${rec.audio_id}`);
      await expect(page.getByRole('heading', { name: 'ملاحظات القلم أثناء التسجيل' })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('رابط تلقائي').first()).toBeVisible();
      await screenshot(page, testInfo, 'f4-audio-screen');
    });
  });
});

test.describe('F4 review: a recording the server refused is never invisible', () => {
  // the refusal below is staged on purpose: the browser logs the 413 answer as a failed resource load
  test.use({ allowedConsoleErrors: [/status of 413/] });
  test('a refused upload is listed on the device with the reason, can be downloaded, and «أعد محاولة الرفع» sends it', async ({ page, api }, testInfo) => {
    const up = await lectureOpen(page, api, `F4 refused ${testInfo.project.name}`);
    // the server refuses the first upload (as when the recording is larger than MEDLEVO_MAX_UPLOAD_MB)
    const refusal = 'التسجيل أكبر من حد الرفع على الخادم. يبقى محفوظًا على جهازك.';
    await page.route('**/api/media/recordings', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: refusal } }) })
        : route.continue(),
    );
    await openWorkspace(page, up.source_id, { pageIndex: 0 });
    const bar = page.getByRole('region', { name: 'التسجيل الصوتي' });
    await viewMenuItem(page, 'سجّل ملاحظة صوتية…');
    await expect(bar).toContainText('يُسجَّل الآن');
    await page.waitForTimeout(1500);
    await bar.getByRole('button', { name: 'إيقاف التسجيل' }).click();
    await expect(bar).toContainText('حُفظ التسجيل', { timeout: 15_000 });

    const notice = page.getByRole('region', { name: 'تسجيلات على هذا الجهاز' });
    await expect(notice).toContainText('لم يقبله الخادم', { timeout: 20_000 });
    await notice.getByRole('button', { name: 'عرض' }).click();
    const dialog = page.getByRole('dialog', { name: 'تسجيلات على هذا الجهاز لم تصل إلى الخادم' });
    await expect(dialog).toContainText(refusal);
    await screenshot(page, testInfo, 'f4-review-refused-recording');
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'نزّل نسخة' }).click();
    expect((await download).suggestedFilename()).toMatch(/^recording-.+\.(webm|ogg|m4a)$/);

    // the limit was raised: the same recording goes up, and the notice goes away
    await page.unroute('**/api/media/recordings');
    await dialog.getByRole('button', { name: 'أعد محاولة الرفع' }).click();
    await expect
      .poll(async () => (await api.get<{ recordings: RecordingView[] }>(`/api/media/recordings?source_id=${up.source_id}`)).recordings.map((r) => r.mime), {
        timeout: 30_000,
        message: 'the retried recording reached the server',
      })
      .toEqual([expect.stringMatching(/^audio\//)]);
    await expect(notice).toHaveCount(0, { timeout: 20_000 });
  });
});
