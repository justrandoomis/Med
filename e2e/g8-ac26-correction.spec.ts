// G8 / AC-26 against the REAL server and the built web app (both projects; no AI key exists — nothing here needs AI):
// the owner answers a G8-only question in practice, an exam that pins the question is created and left untaken, then
// the owner corrects the key through the question screen («تحديد المفتاح بنفسي»). Verified in the app:
//   * the dialog's result tells the impact (no silent re-grading);
//   * Control Center → تنبيهات المحتوى lists the alert; every affected item is named in Arabic (never an internal key
//     such as «question_attempt»), with its title, and opens the question;
//   * the old version, the attempt on it and its result are kept; the feedback of the old attempt says the key changed;
//   * offline, the alerts screen says it needs the server instead of showing an empty list.
// Re-runnable on a used server: the key is flipped between the printed «Ultrasound» and «CT abdomen».
import { join } from 'node:path';
import type { AttemptFeedbackView, ContentAlertView, ExamCreateResponse, QuestionDetailResponse, QuestionListResponse } from '@medlevo/shared';
import { expect, expectHealthyScreen, screenshot, setupOwner, test } from './support';
import { ACCEPTANCE_DIR, uploadFile } from './g1-helpers';

// offline step: the browser logs the failed request itself
test.use({ allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch|net::ERR/i] });

const STEM = 'which imaging test is preferred in adults';
const textOf = (o: { text: { paragraphs: Array<{ runs: Array<{ t: string }> }> } }) => o.text.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join(' ');

test('AC-26: correcting a key names the affected tools in an alert and keeps the old version, the attempt and its result', async ({ page, api, context }, testInfo) => {
  test.setTimeout(240_000);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const bank = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g8_key_bank.pdf'), { sourceType: 'question_source', title: `G8 Revision Bank ${Date.now().toString(36)}` });
  await api.waitForProcessing(bank.version_id, { questions: true });
  const list = await api.get<QuestionListResponse>(`/api/questions?source_id=${bank.source_id}&limit=50`);
  const q3 = list.items.find((i) => i.stem_preview.includes(STEM))!;
  expect(q3, 'Q3 extracted').toBeTruthy();
  const before = await api.get<QuestionDetailResponse>(`/api/questions/${q3.id}`);
  const v0 = before.question.current;
  const keyText = textOf(v0.options.find((o) => v0.correct_option_ids?.includes(o.id))!);
  const nextText = /Ultrasound/.test(keyText) ? 'CT abdomen' : 'Ultrasound';

  let practiceAttempt = '';
  await test.step('practice in the runner: the answer the current key accepts', async () => {
    const { session } = await api.post<ExamCreateResponse>('/api/exams', { title: '', mode: 'practice', count: 1, question_ids: [q3.id], policy: { shuffle_options: false } });
    practiceAttempt = session.attempt.id;
    await page.goto(`/exams/${session.attempt.id}`);
    await expect(page.locator('.ex-stem')).toContainText(STEM);
    await page.locator('.ex-opt').filter({ hasText: keyText }).click();
    await page.getByRole('button', { name: 'واثق' }).click();
    await page.getByRole('button', { name: 'تحقّق من إجابتي' }).click();
    await expect(page.locator('.ex-feedback')).toBeVisible();
    await expect(page.getByText('مدى ثقتك المسجّل مع إجابتك: واثق')).toBeVisible();
  });
  // an exam created before the correction and not taken yet (it pins the current version)
  const pending = await api.post<ExamCreateResponse>('/api/exams', { title: `G8 pending ${Date.now().toString(36)}`, mode: 'exam', count: 1, question_ids: [q3.id] });
  expect(pending.session.items[0]!.question_version_id).toBe(v0.id);

  await test.step('the owner corrects the key on the question screen; the result reports the impact', async () => {
    await page.goto(`/questions/${q3.id}`);
    await page.getByRole('button', { name: /تحديد المفتاح بنفسي|تعديل مفتاحي/ }).click();
    const dialog = page.getByRole('dialog', { name: 'تحديد مفتاح الإجابة بنفسك' });
    await dialog.locator('label.qv-choice').filter({ hasText: nextText }).click();
    await dialog.getByLabel('السبب (اختياري)').fill('G8: راجعت المحاضرة ص 12');
    await dialog.getByRole('button', { name: 'حفظ المفتاح' }).click();
    await expect(page.getByText('حُفظ المفتاح في نسخة جديدة')).toBeVisible();
    await expect(page.getByText(/لم يُعَد تقييم أي محاولة تلقائيًا/).first()).toBeVisible();
    await expectHealthyScreen(page);
  });

  const after = await api.get<QuestionDetailResponse>(`/api/questions/${q3.id}`);
  expect(after.question.current.id).not.toBe(v0.id);
  expect(after.versions.find((v) => v.id === v0.id)!.correct_option_ids).toEqual(v0.correct_option_ids);
  expect(after.attempts_by_version[v0.id]).toBeGreaterThanOrEqual(1);
  const alerts = (await api.get<{ alerts: ContentAlertView[] }>('/api/evidence/alerts?status=all&limit=200')).alerts;
  const alert = alerts.find((a) => a.kind === 'key_corrected' && a.items.some((i) => i.type === 'question_version' && i.id === v0.id))!;
  expect(alert, 'a key_corrected alert for the old version').toBeTruthy();
  expect(alert.items.some((i) => i.type === 'exam' && i.id === pending.session.exam.id), 'the untaken exam is named').toBe(true);
  expect(alert.items.some((i) => i.type === 'question_attempt'), 'the attempt whose result would change is named').toBe(true);

  await test.step('Control Center → alerts: every affected tool named in Arabic with its title, and it opens the question', async () => {
    await page.goto('/control/alerts');
    const card = page.locator(`li.ev-alert[data-kind="key_corrected"]`).filter({ has: page.locator('.ev-alert__item-title', { hasText: STEM }) }).first();
    await card.locator('summary').click();
    const items = card.locator('.ev-alert__items');
    await expect(items).toContainText('محاولة إجابة');
    await expect(items).toContainText('اختبار');
    await expect(items).not.toContainText('question_attempt');
    await expect(items).not.toContainText('question_version');
    await screenshot(page, testInfo, 'g8-ac26-alert');
    await items.getByRole('link').filter({ hasText: STEM }).first().click();
    await expect(page).toHaveURL(new RegExp(`/questions/${q3.id}$`));
  });

  await test.step('the old attempt keeps its result; its feedback says the key changed after it', async () => {
    const fb = await api.get<AttemptFeedbackView>(`/api/exams/attempts/${practiceAttempt}/items/0/feedback`);
    expect(fb.is_correct).toBe(true);
    expect(fb.question_version_id).toBe(v0.id);
    expect(fb.newer_version_note_ar).toMatch(/[؀-ۿ]/);
  });

  await test.step('offline: the alerts screen says it needs the server', async () => {
    await page.goto('/control/alerts');
    await expect(page.locator('li.ev-alert').first()).toBeVisible();
    await context.setOffline(true);
    try {
      await page.getByRole('radio', { name: 'الكل' }).click();
      await expect(page.getByText('تنبيهات تغيّر المحتوى تحتاج الاتصال بالخادم.')).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});
