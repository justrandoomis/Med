// G4 / AC-10, AC-11 on the REAL server (built web app, real processing + extraction; no AI involved).
//   AC-10: g4_long_questions.pdf — Q2's stem starts at the bottom of page 1, stops mid-sentence and continues on page 2
//          (a value at the line start, «38.4 °C»), and its five options sit at the BOTTOM of page 2. The vault shows ONE
//          question with every option and «ص 1–2»; the side-by-side review renders BOTH original pages with the question
//          highlighted; the practice runner delivers it whole and grades it with the printed key.
//   AC-11: g4_units_negation.pdf / g4_negation_ar.pdf — values typed with super/subscript font effects (10⁹, PaCO₂,
//          HCO₃⁻), decimal commas, bold NOT, lower-case «except», and the Arabic negation words «لا» / «إلا» (lam-alef
//          ligatures in the PDF) — kept as printed, flagged and emphasized in the vault and in the runner.
// Fixtures: fixtures/acceptance/make_g4_fixtures.py (synthetic TEST FIXTURE documents, never medical content).
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { QuestionDetailResponse, QuestionListResponse } from '@medlevo/shared';
import { ACCEPTANCE_DIR, uploadFile } from './g1-helpers';
import { expect, screenshot, setupOwner, test, type E2eApi } from './support';

async function questionByNumber(api: E2eApi, sourceId: string, n: string, section = ''): Promise<QuestionDetailResponse> {
  const list = await api.get<QuestionListResponse>(`/api/questions?source_id=${sourceId}&limit=50`);
  for (const it of list.items) {
    const d = await api.get<QuestionDetailResponse>(`/api/questions/${it.id}`);
    if (d.question.occurrences.some((o) => o.source_id === sourceId && o.printed_number === n && o.section_key === section)) return d;
  }
  throw new Error(`no question ${section}${n} in ${sourceId}`);
}

async function openDetail(page: Page, id: string) {
  await page.goto(`/questions/${id}`);
  await expect(page.getByRole('list', { name: 'الخيارات كما طُبعت' })).toBeVisible({ timeout: 30_000 });
}

test('AC-10 + AC-11: a two-page question with its options at the bottom of page 2; values, units and negation as printed', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const [long, units, neg] = await Promise.all([
    uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g4_long_questions.pdf'), { sourceType: 'question_source', title: 'G4 long questions' }),
    uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g4_units_negation.pdf'), { sourceType: 'question_source', title: 'G4 units' }),
    uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g4_negation_ar.pdf'), { sourceType: 'question_source', title: 'G4 Arabic negation' }),
  ]);
  for (const u of [long, units, neg]) expect((await api.waitForProcessing(u.version_id, { questions: true, timeoutMs: 180_000 })).job?.status).toBe('completed');

  const q2 = await questionByNumber(api, long.source_id, '2');

  await test.step('AC-10 vault detail: ONE question, the whole stem from both pages, all five options, «ص 1–2», printed key D', async () => {
    expect((await api.get<QuestionListResponse>(`/api/questions?source_id=${long.source_id}`)).items).toHaveLength(3);
    await openDetail(page, q2.question.id);
    const stem = page.locator('.qv-sheet__stem');
    await expect(stem).toContainText('A 58-year-old man is brought to the emergency department');
    await expect(stem).toContainText('38.4 °C, his blood pressure is 90/60 mmHg and his pulse is 118/min.');
    await expect(stem).toContainText('Which of the following is NOT part of the initial management?');
    await expect(stem.locator('em', { hasText: 'NOT' })).toBeVisible();
    const options = page.getByRole('list', { name: 'الخيارات كما طُبعت' }).getByRole('listitem');
    await expect(options).toHaveCount(5);
    await expect(options.nth(4)).toContainText('Hourly urine output monitoring');
    await expect(options.nth(3)).toContainText('Routine prophylactic antibiotics');
    await expect(options.nth(3)).toContainText('الإجابة — حسب مفتاح المصدر');
    await expect(page.getByText('سؤال من مصدر الأسئلة — G4 long questions — ص 1–2 — رقم السؤال 2').first()).toBeVisible();
    await screenshot(page, testInfo, 'g4-ac10-detail', { fullPage: true });
  });

  await test.step('AC-10 original location: the review screen renders BOTH pages, each with the question highlighted', async () => {
    await page.goto(`/questions/${q2.question.id}/review`);
    const pages = page.locator('.qv-orig__page');
    await expect(pages).toHaveCount(2, { timeout: 30_000 });
    for (const i of [0, 1]) {
      await expect(pages.nth(i).locator('canvas')).toBeVisible();
      await expect(pages.nth(i).locator('.qv-orig__box').first()).toBeAttached();
    }
    await expect(page.locator('.qv-orig__caption').nth(0)).toContainText('1');
    await expect(page.locator('.qv-orig__caption').nth(1)).toContainText('2');
    await screenshot(page, testInfo, 'g4-ac10-original-two-pages', { fullPage: true });
  });

  await test.step('AC-10 open the original page from the vault: the reader opens the question\'s first page with its region highlighted', async () => {
    await openDetail(page, q2.question.id);
    await page.getByRole('link', { name: /افتح الصفحة الأصلية/ }).first().click();
    await expect(page).toHaveURL(/\/study\//);
    await expect(page.locator('.wk-region-hl').first()).toBeVisible({ timeout: 45_000 });
  });

  await test.step('AC-10 practice: the runner delivers the whole question (5 options, NOT flagged) and grades it with the printed key', async () => {
    await page.goto(`/practice?question_id=${q2.question.id}`);
    await expect(page).toHaveURL(/\/exams\//, { timeout: 30_000 });
    await expect(page.locator('.ex-stem')).toContainText('On examination his temperature is');
    await expect(page.locator('.ex-stem')).toContainText('NOT part of the initial management');
    await expect(page.getByText(/سؤال منفي/).first()).toBeVisible();
    const opts = page.locator('.ex-opt');
    await expect(opts).toHaveCount(5);
    await opts.filter({ hasText: 'Routine prophylactic antibiotics' }).click();
    await page.getByRole('button', { name: 'تحقّق من إجابتي' }).click();
    await expect(page.getByText('إجابة صحيحة')).toBeVisible();
    await screenshot(page, testInfo, 'g4-ac10-runner');
  });

  await test.step('AC-11 values typed with font effects keep their meaning; decimal commas and comparison signs as printed', async () => {
    const u1 = await questionByNumber(api, units.source_id, '1');
    await openDetail(page, u1.question.id);
    await expect(page.locator('.qv-sheet__stem')).toContainText('11.5 × 10⁹/L');
    await expect(page.locator('.qv-sheet__stem')).not.toContainText('109/L');
    const u2 = await questionByNumber(api, units.source_id, '2');
    await openDetail(page, u2.question.id);
    await expect(page.locator('.qv-sheet__stem')).toContainText('pH 7.32 and PaCO₂ 52 mmHg');
    const u3 = await questionByNumber(api, units.source_id, '3');
    await openDetail(page, u3.question.id);
    await expect(page.locator('.qv-sheet__stem')).toContainText('6,5 mmol/L and creatinine 1,2 mg/dL');
    const e6 = await questionByNumber(api, neg.source_id, '6', 'E');
    await openDetail(page, e6.question.id);
    await expect(page.locator('.qv-sheet__stem')).toContainText('PaCO₂ 52 mmHg and HCO₃⁻ 26 mmol/L');
    await screenshot(page, testInfo, 'g4-ac11-units');
  });

  await test.step('AC-11 negation: bold NOT, lower-case «except», Arabic «لا» / «إلا» kept, flagged and emphasized', async () => {
    const u5 = await questionByNumber(api, units.source_id, '5');
    await openDetail(page, u5.question.id);
    await expect(page.locator('.qv-sheet__stem em', { hasText: 'except' })).toBeVisible();
    const a1 = await questionByNumber(api, neg.source_id, '1');
    expect(a1.question.current.negation_terms).toEqual(['لا']);
    await openDetail(page, a1.question.id);
    await expect(page.locator('.qv-sheet__stem')).toContainText('أي مما يلي لا يسبب ارتفاع حرارة المريض؟');
    await expect(page.locator('.qv-sheet__stem em', { hasText: 'لا' })).toBeVisible();
    await screenshot(page, testInfo, 'g4-ac11-arabic-negation');
    const a2 = await questionByNumber(api, neg.source_id, '2');
    await openDetail(page, a2.question.id);
    await expect(page.locator('.qv-sheet__stem')).toContainText('جميع ما يلي من مضاعفات التهاب الزائدة إلا:');
    await expect(page.locator('.qv-sheet__stem em', { hasText: 'إلا' })).toBeVisible();
    // the runner warns about the negation too
    await page.goto(`/practice?question_id=${a1.question.id}`);
    await expect(page).toHaveURL(/\/exams\//, { timeout: 30_000 });
    await expect(page.getByText(/سؤال منفي/).first()).toBeVisible();
    await expect(page.locator('.ex-stem')).toContainText('لا يسبب');
  });

  await test.step('AC-11 a question processing could not read with certainty is not approved automatically (needs review, not scorable)', async () => {
    const a4 = await questionByNumber(api, neg.source_id, '4');
    expect(a4.question.status).toBe('needs_review');
    expect(a4.scorable).toBe(false);
    await openDetail(page, a4.question.id);
    await expect(page.getByText('للتدريب غير المحسوب فقط', { exact: true }).first()).toBeVisible();
    // the Arabic-Indic decimal is shown exactly as printed
    await expect(page.locator('.qv-sheet__stem')).toContainText('٣٫٥ ملمول/لتر');
    const preview = await api.post<{ report: { exclusions: Array<{ code: string; question_ids: string[] }> } }>('/api/exams/preview', { title: '', mode: 'exam', count: 50, source_ids: [neg.source_id] });
    expect(preview.report.exclusions.find((e) => e.code === 'unscorable')?.question_ids).toContain(a4.question.id);
  });
});
