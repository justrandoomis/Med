// G3 / AC-13 — an option circled by hand without a known key is never presented as the official source answer.
// REAL server: the photo goes through the quick-add screen («إضافة سؤال سريعة» → «صورة أو لقطة شاشة»), real OCR and
// real extraction; then the question page, the practice runner and the assessed-exam builder. Golden Set
// `question_photo_circled.png` (Q7, circle around «A») and the derived Arabic photo
// `fixtures/acceptance/g3_photo_circled_ar.png` (Q5, circle around «ب»; make_g3_fixtures.mjs).
import { join } from 'node:path';
import type { QuestionDetailResponse, QuestionListResponse, QuickAddResponse } from '@medlevo/shared';
import { ACCEPTANCE_DIR } from './g1-helpers';
import { expect, GOLDEN_DIR, screenshot, setupOwner, test, type E2eApi } from './support';

async function quickAddPhoto(page: import('@playwright/test').Page, courseId: string, file: string): Promise<QuickAddResponse> {
  await page.goto(`/questions/add?course=${courseId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'إضافة سؤال سريعة' })).toBeVisible();
  // the screen itself says what a circle means before anything is uploaded
  await expect(page.getByText('الدائرة أو العلامة بالقلم على خيار لا تُعد مفتاحًا رسميًا.')).toBeVisible();
  await page.locator('#qv-file').setInputFiles(file);
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/questions/quick-add') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'حفظ الصورة واستخراج السؤال' }).click();
  const res = await answer;
  expect(res.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'حُفظت الصورة' })).toBeVisible();
  return (await res.json()) as QuickAddResponse;
}

async function theQuestion(api: E2eApi, qa: QuickAddResponse): Promise<QuestionDetailResponse> {
  await api.waitForProcessing(qa.version_id!, { questions: true });
  const list = await api.get<QuestionListResponse>(`/api/questions?source_id=${qa.source_id}`);
  expect(list.items, 'one question extracted from the photo').toHaveLength(1);
  return api.get<QuestionDetailResponse>(`/api/questions/${list.items[0]!.id}`);
}

test('AC-13: a circled option on a question photo is an unofficial mark — no key on screen, not scored, not in an assessed exam', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();

  const d = await test.step('quick add the photo through the screen; the question is extracted', async () => {
    const qa = await quickAddPhoto(page, course.id, join(GOLDEN_DIR, 'question_photo_circled.png'));
    expect(qa.mode).toBe('image');
    const detail = await theQuestion(api, qa);
    expect(detail.question.current.answer_status).toBe('missing_key');
    expect(detail.question.current.correct_option_ids).toBeNull();
    expect(detail.key_entries.map((k) => [k.mark_kind, k.binding, k.origin_known, k.key_label])).toEqual([['circled_option', 'unofficial', false, 'A']]);
    expect(detail.scorable).toBe(false);
    return detail;
  });

  await test.step('question page: «لا يوجد مفتاح», no option marked as the answer, the circle shown as «علامة على الصفحة» that is not a key', async () => {
    await page.goto(`/questions/${d.question.id}`);
    await expect(page.getByRole('list', { name: 'الخيارات كما طُبعت' }).locator('> li')).toHaveCount(4);
    await expect(page.getByRole('list', { name: 'الخيارات كما طُبعت' }).locator('.qv-option--correct, .qv-option__mark')).toHaveCount(0);
    const keys = page.locator('section[aria-labelledby="qv-keys-h"]');
    await expect(keys).toContainText('لا يوجد مفتاح');
    await expect(keys).toContainText('للتدريب غير المحسوب فقط');
    await expect(keys).toContainText('علامة على الصفحة');
    await expect(keys).toContainText('دائرة حول خيار (ليست مفتاحًا رسميًا)');
    await expect(keys).toContainText('علامة غير رسمية — لا تُعد مفتاحًا');
    await expect(page.getByText(/قد تكون إجابة طالب سابق/).first()).toBeVisible();
    await screenshot(page, testInfo, 'g3-ac13-question', { fullPage: true });
  });

  await test.step('practice: answering the circled «A» is recorded but «غير محسوب», never «إجابة صحيحة»', async () => {
    await page.getByRole('link', { name: 'تدرّب' }).first().click();
    await expect(page).toHaveURL(/\/exams\//, { timeout: 30_000 });
    await expect(page.getByText('غير محسوب').first()).toBeVisible();
    const optionA = page.getByRole('radio', { name: /Ultrasound|ltrasound|trasound/ }).first();
    await optionA.click();
    await page.getByRole('button', { name: 'تحقّق من إجابتي' }).click();
    await expect(page.getByText('غير محسوب.').first()).toBeVisible();
    await expect(page.getByText('إجابة صحيحة')).toHaveCount(0);
    await expect(page.getByText('إجابة غير صحيحة')).toHaveCount(0);
    await screenshot(page, testInfo, 'g3-ac13-practice', { fullPage: true });
  });

  await test.step('assessed exam: refused — the only question has no official key', async () => {
    const res = await api.call('POST', '/api/exams', { title: '', mode: 'exam', count: 5, question_ids: [d.question.id] });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.details.report.exclusions[0].code).toBe('unscorable');
  });

  await test.step('Arabic photo (circle around «ب»): four options read, the circle a mark, no key on screen', async () => {
    const qa = await quickAddPhoto(page, course.id, join(ACCEPTANCE_DIR, 'g3_photo_circled_ar.png'));
    const ar = await theQuestion(api, qa);
    expect(ar.question.current.options.map((o) => o.source_label)).toEqual(['أ', 'ب', 'ج', 'د']);
    expect(ar.question.current.answer_status).toBe('missing_key');
    expect(ar.key_entries.map((k) => [k.mark_kind, k.binding, k.origin_known, k.key_label])).toEqual([['circled_option', 'unofficial', false, 'ب']]);
    await page.goto(`/questions/${ar.question.id}`);
    await expect(page.getByRole('list', { name: 'الخيارات كما طُبعت' }).locator('> li')).toHaveCount(4);
    await expect(page.getByRole('list', { name: 'الخيارات كما طُبعت' })).toContainText('الأمواج فوق الصوتية');
    await expect(page.getByRole('list', { name: 'الخيارات كما طُبعت' }).locator('.qv-option--correct, .qv-option__mark')).toHaveCount(0);
    await expect(page.locator('section[aria-labelledby="qv-keys-h"]')).toContainText('علامة غير رسمية — لا تُعد مفتاحًا');
    await screenshot(page, testInfo, 'g3-ac13-question-ar', { fullPage: true });
  });
});
