// Track F3 — study modes & AI-gated tools against the REAL server (built web app, real processing, question extraction
// and matching; NO AI provider exists here). Golden Set TEST FIXTURE documents only.
//  1. The study-mode switch in the reading bar arranges the SAME rail: Learn shows five sections (explanations first);
//     «امتحن نفسك» hides «الشرح والسؤال» and «المصادر» with the reason in words, hides why a question was linked and its
//     original page, starts an assessed exam from a question, and disables «اشرح» on a selection. The mode is saved with
//     the study session (IndexedDB → outbox → server) and comes back after a reload. The «حالات» section lists the
//     lecture's case. Create MCQ, the interactive diagram and the figure reading say «requires configuration» with the
//     server's reason — never a fake result — and the API refuses them with AI_NOT_CONFIGURED.
//  2. Derived question versions, the generated simulation (its DNA plan is computed WITHOUT AI and labelled «ليست نسخة
//     متوقعة من الامتحان القادم») and the vision reading of a figure are honest about the missing provider.
// What the AI paths produce with a model (published / review queue / abstained, keys and option ids kept, plan shares,
// claim chips, uncertain readings) is verified in apps/server/test/f3/*.test.ts with the scripted test provider.
import type { Page } from '@playwright/test';
import type { CapabilitiesResponse, LatestSessionResponse, LectureQuestionsResponse, PageRegionsResponse, QuestionListResponse, SimulationPlanView } from '@medlevo/shared';
import { versionPages } from './g1-helpers';
import { expect, expectHealthyScreen, openWorkspace, screenshot, setupOwner, test, waitForWorkspace, type E2eApi } from './support';

const railTabs = (page: Page) => page.getByRole('tablist', { name: 'أقسام لوحة الدراسة' }).getByRole('tab');

/** open the rail (phone: a sheet behind «لوحة الدراسة») and select a section */
async function railTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true });
  if (!(await tab.isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** phone: the rail is a modal sheet over the reader — close it before using the reading bar or the page */
async function closeRailSheet(page: Page): Promise<void> {
  const sheet = page.getByRole('dialog', { name: 'لوحة الدراسة' });
  if (await sheet.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  }
}

async function switchMode(page: Page, label: string): Promise<void> {
  await closeRailSheet(page);
  await page.getByRole('button', { name: /^وضع الدراسة: / }).first().click();
  await page.getByRole('menu', { name: 'وضع الدراسة' }).getByRole('menuitem', { name: new RegExp(label) }).click();
  await expect(page.getByRole('button', { name: `وضع الدراسة: ${label}` }).first()).toBeVisible();
}

async function lectureWithBank(api: E2eApi, stamp: string) {
  const { course } = await api.createNotebookAndCourse();
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `F3 lecture ${stamp}` });
  const bank = await api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create', title: `F3 bank ${stamp}` });
  expect(['completed', 'partial']).toContain((await api.waitForProcessing(lecture.version_id)).job?.status);
  await api.waitForProcessing(bank.version_id, { questions: true });
  // the bank's questions are matched to the lecture (deterministic matching job)
  await expect
    .poll(async () => (await api.get<LectureQuestionsResponse>(`/api/questions/for-lecture/${lecture.source_id}`)).items.length, { timeout: 120_000 })
    .toBeGreaterThan(0);
  return { course, lecture, bank };
}

test('F3: the study mode arranges the rail and persists; Exam hides explanations; «حالات»; AI tools are honest', async ({ page, api }, testInfo) => {
  test.setTimeout(300_000);
  await setupOwner(page);
  const stamp = `${Date.now().toString(36)}-${testInfo.project.name}`;
  const { lecture } = await lectureWithBank(api, stamp);
  const caps = await api.get<CapabilitiesResponse>('/api/capabilities');
  for (const k of ['ai.generate_questions', 'ai.summaries', 'processing.vision'] as const) expect(caps.features[k].state, k).toBe('requires_configuration');
  // an owner-written OSCE station of this lecture (its Source Lock names the lecture)
  await api.post('/api/cases', {
    definition: {
      kind: 'osce',
      title: `OSCE F3 RIF pain (TEST) ${stamp}`,
      facts: [{ id: 'f_onset', label: 'بداية الألم', value: 'بدأ الألم أمس حول السرة', kind: 'history', reveal: 'on_request' }],
      osce: {
        station_type: 'history_taking',
        candidate_instructions: 'خذ القصة المرضية من مريض يشكو ألمًا في البطن.',
        roles: ['patient', 'examiner'],
        minutes: 8,
        patient_responses: [{ id: 'r_onset', match: ['متى بدأ', 'onset'], fact_id: 'f_onset' }],
      },
      checklist: [{ id: 'o_onset', text: 'Asked about the onset of pain', category: 'history', match: ['متى بدأ', 'onset'], order: 1 }],
    },
    scope: { mode: 'lecture_only', lecture_source_id: lecture.source_id, reference_source_ids: [], version_pins: {}, include_my_notes: false },
  });

  await openWorkspace(page, lecture.source_id, { pageIndex: 0 });

  await test.step('Learn by default: the switch names the mode; five sections, explanations first; the diagram tool says why it is off', async () => {
    await expect(page.getByRole('button', { name: 'وضع الدراسة: تعلّم' }).first()).toBeVisible();
    await railTab(page, 'الشرح والسؤال');
    await expect(railTabs(page)).toHaveText(['الشرح والسؤال', 'المصادر', 'الأسئلة', 'حالات', 'ملاحظاتي']);
    await expect(page.getByText('وضع الدراسة: تعلّم', { exact: true })).toBeVisible();
    const draw = page.getByRole('button', { name: 'ارسم المخطط' });
    await draw.scrollIntoViewIfNeeded();
    await expect(draw).toBeDisabled();
    await expect(page.getByText(caps.features['ai.summaries'].reason_ar!, { exact: true }).first()).toBeVisible();
    await screenshot(page, testInfo, 'f3-learn-rail');
    const res = await api.call('POST', '/api/studybook/diagrams', { kind: 'flowchart', source_id: lecture.source_id, topic: 'appendicitis work-up' });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe('AI_NOT_CONFIGURED');
  });

  await test.step('«امتحن نفسك»: explanations and sources hidden with the reason; no link reasons or original pages; an assessed exam', async () => {
    await switchMode(page, 'امتحن نفسك');
    await railTab(page, 'الأسئلة');
    await expect(railTabs(page)).toHaveText(['الأسئلة', 'حالات', 'ملاحظاتي']);
    await expect(page.getByText(/مخفي الآن: «الشرح والسؤال» و«المصادر»/)).toBeVisible();
    await expect(page.locator('.qv-rail__item').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('لماذا رُبط بهذه المحاضرة؟')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /افتح الأصل/ })).toHaveCount(0);
    const start = page.getByRole('link', { name: 'امتحن نفسك' }).first();
    await expect(start).toHaveAttribute('href', /mode=exam/);
    await expectHealthyScreen(page);
    await screenshot(page, testInfo, 'f3-exam-rail');
    // (F3 review) the Study Book (generated explanations) is off too, with the mode as the reason — not only the rail
    if (testInfo.project.name === 'desktop') {
      await closeRailSheet(page);
      await page.getByRole('button', { name: 'المحاضرة الأصلية' }).first().click();
      const book = page.getByRole('menuitem', { name: /^كتاب الدراسة/ });
      await expect(book).toHaveAttribute('aria-disabled', 'true');
      await expect(book).toContainText('امتحن نفسك');
      await page.keyboard.press('Escape');
    }
  });

  await test.step('«حالات»: the lecture’s OSCE station with its origin; in Exam mode it is started, never shown', async () => {
    await railTab(page, 'حالات');
    const item = page.locator('.wk-case').filter({ hasText: `OSCE F3 RIF pain (TEST) ${stamp}` });
    await expect(item).toBeVisible();
    await expect(item.getByText('كتبتها بنفسك')).toBeVisible();
    await expect(item.getByRole('link', { name: 'ابدأ الحالة' })).toBeVisible();
    await screenshot(page, testInfo, 'f3-cases');
  });

  await test.step('a selection in Exam mode: «اشرح» is off with the reason; Create MCQ is disabled with the AI reason', async () => {
    await closeRailSheet(page);
    const span = page.locator('.wk-page[data-page-index="0"] .wk-textlayer span').filter({ hasText: /^McBurney$/ }).first();
    await expect(span).toBeAttached({ timeout: 30_000 });
    await span.scrollIntoViewIfNeeded();
    const b = (await span.boundingBox())!;
    const y = b.y + b.height / 2;
    await page.mouse.move(b.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, y, { steps: 4 });
    await page.mouse.move(b.x + b.width - 1, y, { steps: 4 });
    await page.mouse.up();
    const bar = page.getByRole('toolbar', { name: 'أدوات النص المحدد' });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button', { name: 'اشرح' })).toBeDisabled();
    // (F3 review) the reason is exposed to assistive technology, not only as a hover title
    await expect(bar.getByRole('button', { name: 'اشرح' })).toHaveAccessibleDescription(/امتحن نفسك/);
    await bar.getByRole('button', { name: 'المزيد' }).click();
    const mcq = page.getByRole('menuitem', { name: /أنشئ سؤال اختيار من متعدد/ });
    await expect(mcq).toHaveAttribute('aria-disabled', 'true');
    await expect(mcq).toContainText('ANTHROPIC_API_KEY');
    await screenshot(page, testInfo, 'f3-exam-selection');
    await page.keyboard.press('Escape');
    const res = await api.call('POST', '/api/exams/generate', {
      lecture_source_id: lecture.source_id,
      anchor: { page_id: (await versionPages(api, lecture.source_id, lecture.version_id))[0]!.id, quote: 'McBurney' },
      origin: 'selection',
      count: 1,
      difficulty: 'hard',
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe('AI_NOT_CONFIGURED');
  });

  await test.step('the mode is saved with the session: the server has it, and it comes back after a reload', async () => {
    await expect
      .poll(async () => (await api.get<LatestSessionResponse>(`/api/annotations/sessions/latest?source_id=${lecture.source_id}`)).session?.mode, { timeout: 30_000 })
      .toBe('exam');
    await page.reload();
    await waitForWorkspace(page);
    await expect(page.getByRole('button', { name: 'وضع الدراسة: امتحن نفسك' }).first()).toBeVisible();
    await railTab(page, 'الأسئلة');
    await expect(railTabs(page)).toHaveText(['الأسئلة', 'حالات', 'ملاحظاتي']);
  });

  await test.step('back to «راجع»: notes first, every section back', async () => {
    await switchMode(page, 'راجع');
    await railTab(page, 'ملاحظاتي');
    await expect(railTabs(page)).toHaveText(['ملاحظاتي', 'الأسئلة', 'حالات', 'الشرح والسؤال', 'المصادر']);
    await expectHealthyScreen(page);
    await screenshot(page, testInfo, 'f3-review-rail');
  });
});

test('F3: derived versions, the generated simulation plan and the figure reading are honest without a provider', async ({ page, api }, testInfo) => {
  test.setTimeout(300_000);
  await setupOwner(page);
  const stamp = `${Date.now().toString(36)}-${testInfo.project.name}`;
  const { course, lecture, bank } = await lectureWithBank(api, stamp);
  const caps = await api.get<CapabilitiesResponse>('/api/capabilities');

  await test.step('question screen: «النسخ المشتقة» disabled with the reason; the API refuses', async () => {
    const q = (await api.get<QuestionListResponse>(`/api/questions?source_id=${bank.source_id}&limit=50`)).items[0]!;
    await page.goto(`/questions/${q.id}`);
    await expect(page.getByRole('heading', { name: /النسخ المشتقة/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'إعادة صياغة' })).toBeDisabled();
    await expect(page.getByText(/ANTHROPIC_API_KEY/).first()).toBeVisible();
    await expect(page.getByText('لا توجد نسخ مشتقة لهذا السؤال.')).toBeVisible();
    await expectHealthyScreen(page);
    await screenshot(page, testInfo, 'f3-derived');
    const res = await api.call('POST', `/api/questions/${q.id}/derived`, { kind: 'paraphrase' });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe('AI_NOT_CONFIGURED');
  });

  await test.step('«محاكاة مولدة»: the DNA plan with denominators (no AI needed), labelled; generation off with the reason', async () => {
    await expect
      .poll(async () => (await api.post<{ plan: SimulationPlanView }>('/api/exams/simulations/preview', { count: 4, difficulty: 'hard', course_node_id: course.id })).plan.buckets.map((b) => b.lecture_source_id), { timeout: 60_000 })
      .toContain(lecture.source_id);
    await page.goto(`/exams/simulate?course_node_id=${course.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'محاكاة مولدة' })).toBeVisible();
    await expect(page.getByText(/ليست نسخة متوقعة من الامتحان القادم/).first()).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: `F3 lecture ${stamp}` });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/\d+ من \d+/);
    const go = page.getByRole('button', { name: 'ولّد المحاكاة وتحقق منها' });
    await expect(go).toBeDisabled();
    await expect(page.getByText(caps.features['ai.generate_questions'].reason_ar!, { exact: false }).first()).toBeVisible();
    await expectHealthyScreen(page);
    await screenshot(page, testInfo, 'f3-simulation-plan');
    const res = await api.call('POST', '/api/exams/simulations', { count: 4, difficulty: 'hard', course_node_id: course.id });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe('AI_NOT_CONFIGURED');
    // reachable from Exam DNA
    await page.goto('/review/dna');
    await expect(page.getByRole('link', { name: 'اعرض خطة المحاكاة' })).toBeVisible();
  });

  await test.step('reader → «المصادر» → the flowchart of printed page 14: the vision reading is labelled, off with the reason', async () => {
    const p14 = (await versionPages(api, lecture.source_id, lecture.version_id)).find((p) => p.printed_label === '14')!;
    await page.goto(`/study/${lecture.source_id}?page_id=${p14.id}`);
    await waitForWorkspace(page);
    await railTab(page, 'المصادر');
    const row = page.locator('.wk-region-row').filter({ has: page.locator('.wk-region-row__kind', { hasText: /^مخطط$/ }) });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await row.getByRole('button', { name: 'بنية الشكل (قراءة بصرية)' }).click();
    await expect(row.getByText(/قراءة بصرية مشتقة للشكل — ليست نص المصدر/)).toBeVisible();
    await expect(row.getByRole('button', { name: 'اقرأ بنية الشكل' })).toBeDisabled();
    await expect(row.getByText(caps.features['processing.vision'].reason_ar!, { exact: true })).toBeVisible();
    await screenshot(page, testInfo, 'f3-figure-reading');
    const regions = await api.get<PageRegionsResponse>(`/api/sources/pages/${p14.id}/regions`);
    const diagram = regions.regions.find((r) => r.kind === 'diagram')!;
    const res = await api.call('POST', `/api/processing/figures/${diagram.id}/analyze`, {});
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe('AI_NOT_CONFIGURED');
    // the region itself is unchanged: still uncertain, relations not inferred
    const again = (await api.get<PageRegionsResponse>(`/api/sources/pages/${p14.id}/regions`)).regions.find((r) => r.id === diagram.id)!;
    expect(again.status).toBe(diagram.status);
  });
});
