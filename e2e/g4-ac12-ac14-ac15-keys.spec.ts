// G4 / AC-12, AC-14, AC-15 on the REAL server (built web app, real processing + extraction + matching). No AI key
// exists here: the AI answer check (AC-14 «AI-derived Answer», AC-15 key vs MATERIAL) must show
// `requires_configuration` honestly — its behaviour with a model is covered by the server acceptance tests with the
// test-only scripted provider (apps/server/test/acceptance/g4-ac14.test.ts, g4-ac15.test.ts).
//   AC-12: g4_sections_merged_key.pdf — sections A, B, C all start at 1; the key prints Section B first and the layout
//          merges both key lines into one region → each section keeps its own key; C has none; the runner grades B1
//          with SECTION B's key. g4_key_formats.pdf — «Q1: B Q2: D» read; an unreadable key reported to the owner.
//   AC-14: the Golden Set B3 (no key) is a source question, «no key», never in an assessed exam, unscored in practice.
//   AC-15: the Golden Set A1 is answered (correct), THEN another source prints it with key C (g4_a1_other_key.pdf):
//          the conflict is shown with both printed keys, the earlier result is unchanged, assessed exams skip it.
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { CapabilitiesResponse, ExamCreateResponse, ExamResultDetail, QuestionDetailResponse, QuestionListResponse } from '@medlevo/shared';
import { ACCEPTANCE_DIR, uploadFile } from './g1-helpers';
import { expect, screenshot, setupOwner, test, type E2eApi } from './support';

async function questionAt(api: E2eApi, sourceId: string, section: string, n: string): Promise<QuestionDetailResponse> {
  const list = await api.get<QuestionListResponse>(`/api/questions?source_id=${sourceId}&limit=50`);
  for (const it of list.items) {
    const d = await api.get<QuestionDetailResponse>(`/api/questions/${it.id}`);
    if (d.question.occurrences.some((o) => o.source_id === sourceId && o.section_key === section && o.printed_number === n)) return d;
  }
  throw new Error(`no question ${section}/${n} in ${sourceId}`);
}
const keyTexts = (d: QuestionDetailResponse) =>
  d.question.current.options.filter((o) => d.question.current.correct_option_ids?.includes(o.id)).map((o) => o.text.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join(''));

async function openDetail(page: Page, id: string) {
  await page.goto(`/questions/${id}`);
  await expect(page.getByRole('heading', { name: 'مفتاح الإجابة' })).toBeVisible({ timeout: 30_000 });
}

async function practiceAndAnswer(page: Page, questionId: string, optionText: string) {
  await page.goto(`/practice?question_id=${questionId}`);
  await expect(page).toHaveURL(/\/exams\//, { timeout: 30_000 });
  await page.locator('.ex-opt').filter({ hasText: optionText }).click();
  await page.getByRole('button', { name: 'تحقّق من إجابتي' }).click();
  return page.url().split('/exams/')[1]!.split(/[?#]/)[0]!;
}

test('AC-12 + AC-14 + AC-15: keys per section, keyless questions unscored, a later conflicting key shown and nothing re-graded', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const [bank, merged, formats] = await Promise.all([
    api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create', title: 'Surgery Course 1 Questions' }),
    uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g4_sections_merged_key.pdf'), { sourceType: 'question_source', title: 'G4 sections' }),
    uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g4_key_formats.pdf'), { sourceType: 'question_source', title: 'G4 key formats' }),
  ]);
  for (const u of [bank, merged, formats]) expect((await api.waitForProcessing(u.version_id, { questions: true, timeoutMs: 180_000 })).job?.status).toBe('completed');

  await test.step('AC-12: three sections restart at 1; the merged per-section key binds each section to its own questions', async () => {
    expect(keyTexts(await questionAt(api, merged.source_id, 'A', '1'))).toEqual(['Vitamin C']);
    expect(keyTexts(await questionAt(api, merged.source_id, 'A', '2'))).toEqual(['Vitamin E']);
    expect(keyTexts(await questionAt(api, merged.source_id, 'B', '2'))).toEqual(['Glucagon']);
    expect(keyTexts(await questionAt(api, merged.source_id, 'B', '3'))).toEqual(['Alpha cells']);
    const b1 = await questionAt(api, merged.source_id, 'B', '1');
    expect(keyTexts(b1)).toEqual(['Pancreas']);
    await openDetail(page, b1.question.id);
    await expect(page.getByText('سؤال من مصدر الأسئلة — G4 sections — ص 1 — رقم السؤال 1 (Section B)').first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'الخيارات كما طُبعت' }).getByRole('listitem').filter({ hasText: 'Pancreas' })).toContainText('الإجابة — حسب مفتاح المصدر');
    await screenshot(page, testInfo, 'g4-ac12-b1-detail', { fullPage: true });
    // Section C has no key: it never borrows question 1 of A or B
    const c1 = await questionAt(api, merged.source_id, 'C', '1');
    expect(c1.question.current.answer_status).toBe('missing_key');
    await openDetail(page, c1.question.id);
    await expect(page.getByText('لا يوجد مفتاح مطبوع لهذا السؤال في مصادره.')).toBeVisible();
  });

  await test.step('AC-12: the runner grades B1 with SECTION B\'s key (Section A\'s letter for question 1 is wrong here)', async () => {
    const b1 = await questionAt(api, merged.source_id, 'B', '1');
    await practiceAndAnswer(page, b1.question.id, 'Spleen');
    await expect(page.getByText('إجابة غير صحيحة')).toBeVisible();
    await expect(page.locator('.ex-opt[data-key="true"]')).toContainText('Pancreas');
    await screenshot(page, testInfo, 'g4-ac12-runner-b1');
  });

  await test.step('AC-12: «Q1: B Q2: D» is read as Part 1\'s key; Part 2\'s unreadable key is reported in the review queue, never guessed', async () => {
    expect((await api.get<QuestionListResponse>(`/api/questions?source_id=${formats.source_id}`)).items).toHaveLength(5);
    expect(keyTexts(await questionAt(api, formats.source_id, '1', '1'))).toEqual(['Vitamin D']);
    expect((await questionAt(api, formats.source_id, '2', '1')).question.current.answer_status).toBe('missing_key');
    await page.goto(`/questions/review?source_id=${formats.source_id}`);
    await expect(page.getByText(/Q1 is C, Q2 is B, Q3 is A/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/بصيغة لم تُقرأ/).first()).toBeVisible();
    await screenshot(page, testInfo, 'g4-ac12-unread-key-review', { fullPage: true });
  });

  await test.step('AC-14: B3 has no key — shown as a source question, «no key», unscored; never in an assessed exam', async () => {
    const b3 = await questionAt(api, bank.source_id, 'B', '3');
    expect(b3.question.origin_type).toBe('source');
    expect(b3.scorable).toBe(false);
    await openDetail(page, b3.question.id);
    await expect(page.getByText('سؤال من مصدر الأسئلة — Surgery Course 1 Questions — ص 2 — رقم السؤال 3 (Section B)').first()).toBeVisible();
    await expect(page.getByText(/المفتاح:\s*لا يوجد مفتاح/).first()).toBeVisible();
    await expect(page.getByText('للتدريب غير المحسوب فقط', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.qv-option--correct')).toHaveCount(0);
    for (const mode of ['exam', 'simulation'] as const) {
      const r = await api.post<ExamCreateResponse>('/api/exams', { title: '', mode, count: 50, source_ids: [bank.source_id] });
      expect(r.session.items.map((i) => i.question_id), mode).not.toContain(b3.question.id);
    }
    await practiceAndAnswer(page, b3.question.id, 'Ultrasound');
    await expect(page.getByText('غير محسوب', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.ex-result-line--neutral')).toContainText('غير محسوب.');
    await screenshot(page, testInfo, 'g4-ac14-runner-unscored');
  });

  await test.step('AC-14 / AC-15: the AI answer check is honestly unavailable without a key — disabled with the reason, 409, nothing changes', async () => {
    const caps = await api.get<CapabilitiesResponse>('/api/capabilities');
    expect(caps.features['ai.answer_check'].state).toBe('requires_configuration');
    const b3 = await questionAt(api, bank.source_id, 'B', '3');
    await openDetail(page, b3.question.id);
    const btn = page.getByRole('button', { name: 'تحقق من الإجابة بالأدلة' });
    await expect(btn).toBeDisabled();
    const reasonId = await btn.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    await expect(page.locator(`[id="${reasonId}"]`)).toContainText('ANTHROPIC_API_KEY');
    await screenshot(page, testInfo, 'g4-ac14-answer-check-disabled');
    const res = await api.call('POST', `/api/questions/${b3.question.id}/answer-check`, {});
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AI_NOT_CONFIGURED');
    const after = await api.get<QuestionDetailResponse>(`/api/questions/${b3.question.id}`);
    expect(after.question.current.id).toBe(b3.question.current.id);
    expect(after.question.current.answer_status).toBe('missing_key');
  });

  await test.step('AC-15: A1 answered correctly, then another source prints it with key C → conflict shown, original keys kept, result unchanged', async () => {
    const a1 = await questionAt(api, bank.source_id, 'A', '1');
    // A1 is ONE question across every upload of the Golden Set on this server (exact duplicates, AC-17). On a server an
    // earlier run already gave the revision sheet, A1 is conflicting before this step: then only the lasting state is
    // checked (the spec stays re-runnable on a used server, e2e/README.md).
    const fresh = a1.question.current.answer_status === 'source_key';
    if (!fresh) testInfo.annotations.push({ type: 'note', description: 'A1 was already conflicting on this used server; the before/after comparison ran on a fresh server only.' });
    const attemptId = await practiceAndAnswer(page, a1.question.id, "McBurney's point");
    await expect(page.getByText(fresh ? 'إجابة صحيحة' : 'غير محسوب.')).toBeVisible();
    const before = await api.get<ExamResultDetail>(`/api/exams/attempts/${attemptId}/result`).catch(() => null);

    const other = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g4_a1_other_key.pdf'), { sourceType: 'question_source', title: 'G4 revision sheet' });
    expect((await api.waitForProcessing(other.version_id, { questions: true, timeoutMs: 180_000 })).job?.status).toBe('completed');
    const d = await api.get<QuestionDetailResponse>(`/api/questions/${a1.question.id}`);
    expect(d.question.current.answer_status).toBe('conflicting_key');
    // every printed key is kept as printed (B from each Golden Set copy, C from the revision sheet)
    expect([...new Set(d.key_entries.map((k) => k.key_label))].sort()).toEqual(['B', 'C']);
    if (fresh) expect(d.versions.find((v) => v.id === a1.question.current.id)?.answer_status).toBe('source_key');

    await openDetail(page, a1.question.id);
    await expect(page.getByText(/المفتاح:\s*مفتاح متعارض/).first()).toBeVisible();
    await expect(page.locator('.qv-alert').first()).toContainText('متعارضة');
    await expect(page.getByText('للتدريب غير المحسوب فقط', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.qv-option--correct')).toHaveCount(0); // no answer is presented as the key any more
    await screenshot(page, testInfo, 'g4-ac15-conflict-detail', { fullPage: true });

    // nothing re-graded: the attempt keeps its result, a new assessed exam skips the question
    if (before) {
      const after = await api.get<ExamResultDetail>(`/api/exams/attempts/${attemptId}/result`);
      expect(after.correct).toBe(before.correct);
    }
    const preview = await api.post<{ report: { exclusions: Array<{ code: string; question_ids: string[] }> } }>('/api/exams/preview', { title: '', mode: 'exam', count: 50, source_ids: [bank.source_id] });
    expect(preview.report.exclusions.find((e) => e.code === 'unscorable')?.question_ids).toContain(a1.question.id);
    if (fresh) {
      await page.goto(`/exams/${attemptId}`);
      await expect(page.getByText('إجابة صحيحة')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/لم يُعَد تقييمها/).first()).toBeVisible();
      await screenshot(page, testInfo, 'g4-ac15-earlier-attempt-unchanged');
    }
  });
});
