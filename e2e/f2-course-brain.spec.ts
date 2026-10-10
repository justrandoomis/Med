// F2 — Course Brain against the REAL server (built web app, real processing, the extract_knowledge job, question
// extraction and matching; no AI anywhere in this track). Golden Set TEST FIXTURE documents only.
//  1. the course page: tabs «المصادر / خريطة المعرفة / التقدم / تغطية الأسئلة»; extraction status per lecture; the
//     interactive map driven by the KEYBOARD (one tab stop, ↓, ← in RTL to the linked column, Enter → live details,
//     Esc) and its text twin; progress with four separate measures; the coverage map with denominators;
//  2. concept correction: a rejected concept stays rejected after re-extraction;
//  3. topics: create → deterministic suggestions with reasons → reject / accept → the library filtered by the topic;
//  4. Student Knowledge Map (states in words, estimate labelled) and the Weakness Center reading an OSCE attempt.
import type { Page } from '@playwright/test';
import type { BrainConceptListResponse, CourseBrainResponse } from '@medlevo/shared';
import { expect, expectHealthyScreen, screenshot, setupOwner, test, type E2eApi } from './support';

async function waitForBrain(api: E2eApi, courseId: string, lectures: number): Promise<CourseBrainResponse> {
  let last: CourseBrainResponse | null = null;
  await expect
    .poll(
      async () => {
        last = await api.get<CourseBrainResponse>(`/api/brain/courses/${courseId}`);
        return last.lectures.filter((l) => l.extraction?.status === 'completed' && !(l.job && ['queued', 'running'].includes(l.job.status))).length;
      },
      { timeout: 120_000 },
    )
    .toBe(lectures);
  return last!;
}

async function ensureMapView(page: Page): Promise<void> {
  const radio = page.getByRole('radio', { name: 'الخريطة' });
  if ((await radio.getAttribute('aria-checked')) !== 'true') await radio.click();
  await expect(page.getByRole('group', { name: /^خريطة المعرفة:/ })).toBeVisible();
}

test('F2: course page — knowledge map by keyboard + text twin, progress, coverage; concept decisions persist', async ({ page, api }, testInfo) => {
  test.setTimeout(300_000);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const stamp = Date.now().toString(36);
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `Appendicitis F2 ${stamp}` });
  const notes = await api.uploadFixture(course.id, 'lecture_notes_shock.docx', { sourceType: 'lecture', onDuplicate: 'create', title: `Shock notes F2 ${stamp}` });
  const bank = await api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create', title: `Bank F2 ${stamp}` });
  await api.waitForProcessing(lecture.version_id);
  await api.waitForProcessing(notes.version_id);
  await api.waitForProcessing(bank.version_id, { questions: true });
  await waitForBrain(api, course.id, 2);

  await test.step('course page → «خريطة المعرفة»: extraction status, objectives, the map', async () => {
    await page.goto(`/library/${course.id}?tab=map`);
    await expect(page.getByRole('tab', { name: 'خريطة المعرفة' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: /هيكل المعرفة/ })).toBeVisible();
    await expect(page.getByText(/استُخرج هيكل 2 من 2 مصادر/)).toBeVisible();
    await page.getByText(/أهداف التعلم المذكورة \(2\)/).click();
    await expect(page.getByText('Describe the typical migration of pain in acute appendicitis.')).toBeVisible();
    await ensureMapView(page);
    await screenshot(page, testInfo, 'f2-course-map');
  });

  await test.step('the map by keyboard: one tab stop, ↓, ← (RTL) to the linked concept, Enter shows its links, Esc clears', async () => {
    const group = page.getByRole('group', { name: /^خريطة المعرفة:/ });
    const nodes = group.getByRole('button');
    await expect(nodes.first()).toBeVisible();
    expect(await group.locator('button[tabindex="0"]').count()).toBe(1);
    const first = group.locator('button[tabindex="0"]');
    await first.focus();
    await expect(first).toHaveAccessibleName(/^محاضرة: /);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator(':focus')).toHaveAccessibleName(/^محاضرة: Shock notes F2/);
    await page.keyboard.press('ArrowLeft'); // RTL: the next column (concepts) is on the left
    const focused = page.locator(':focus');
    await expect(focused).toHaveAccessibleName(/^مفهوم: /);
    await page.keyboard.press('Enter');
    await expect(focused).toHaveAttribute('aria-pressed', 'true');
    const panel = page.getByRole('region', { name: 'تفاصيل العنصر المختار' });
    await expect(panel.getByRole('link', { name: /افتح المفهوم/ })).toBeVisible();
    await expect(panel.getByText(/محاضرة:/).first()).toBeVisible();
    await screenshot(page, testInfo, 'f2-map-selected');
    await page.keyboard.press('Escape');
    await expect(panel.getByText(/اختر عنصرًا في الخريطة/)).toBeVisible();
  });

  await test.step('the text twin carries the lectures, concepts with their pages, and the questions', async () => {
    await page.getByRole('radio', { name: 'القائمة النصية' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(`Appendicitis F2 ${stamp}`) })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ultrasound', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'ص 12 (الصفحة 2 في الملف)' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'الأسئلة', exact: true })).toBeVisible();
    await screenshot(page, testInfo, 'f2-map-text-twin');
  });

  await test.step('«التقدم»: reading, explanation coverage, practice and the mastery ESTIMATE as separate measures', async () => {
    await page.getByRole('tab', { name: 'التقدم' }).click();
    await expect(page.getByRole('heading', { name: 'القراءة', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'تغطية الشرح (كتاب الدراسة)' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'الإتقان (تقدير)' })).toBeVisible();
    await expect(page.getByText(/لا تقدير بعد/).first()).toBeVisible();
    await screenshot(page, testInfo, 'f2-progress');
  });

  await test.step('«تغطية الأسئلة»: source vs generated, attempted, uncovered — with denominators', async () => {
    await page.getByRole('tab', { name: 'تغطية الأسئلة' }).click();
    await page.getByLabel('المحاضرة').selectOption({ label: `Appendicitis F2 ${stamp}` });
    await expect(page.getByText('الصفحات (المقام: 4 صفحات)')).toBeVisible();
    await expect(page.getByText(/صفحات لها أسئلة من المصادر/)).toBeVisible();
    await expect(page.getByText(/صفحات لها أسئلة مولدة/)).toBeVisible();
    await expect(page.getByText('لها أسئلة من المصادر').first()).toBeVisible();
    await screenshot(page, testInfo, 'f2-coverage');
  });

  await test.step('concept correction: reject a suggestion — it stays rejected after re-extraction', async () => {
    await page.getByRole('tab', { name: 'خريطة المعرفة' }).click();
    await page.getByRole('link', { name: /المفاهيم والعلاقات \(تصحيح\)/ }).click();
    await expect(page.getByRole('heading', { name: 'المفاهيم والعلاقات', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'ارفض المفهوم Rebound tenderness' }).click();
    await expect(page.getByText(/رفضت «Rebound tenderness»/)).toBeVisible();
    await api.post('/api/brain/extract', { course_node_id: course.id });
    await waitForBrain(api, course.id, 2);
    const rejected = await api.get<BrainConceptListResponse>(`/api/brain/concepts?course_node_id=${course.id}&status=rejected`);
    expect(rejected.items.map((c) => c.name)).toContain('Rebound tenderness');
    await page.reload();
    await page.getByRole('radio', { name: 'المرفوضة' }).click();
    await expect(page.getByRole('link', { name: /Rebound tenderness/ })).toBeVisible();
    await screenshot(page, testInfo, 'f2-concepts');
  });
});

test('F2: topics with suggestions and decisions; library filter; Student Knowledge Map; OSCE signals in the Weakness Center', async ({ page, api }, testInfo) => {
  test.setTimeout(300_000);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const stamp = Date.now().toString(36);
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `Appendicitis topics ${stamp}` });
  const bank = await api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create', title: `Bank topics ${stamp}` });
  await api.waitForProcessing(lecture.version_id);
  await api.waitForProcessing(bank.version_id, { questions: true });
  await waitForBrain(api, course.id, 1);

  await test.step('create a topic → suggested links with their reason → reject one, accept another', async () => {
    await page.goto('/library');
    await page.getByRole('link', { name: 'الموضوعات' }).click();
    await expect(page.getByRole('heading', { name: 'الموضوعات', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'موضوع جديد' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'موضوع جديد' });
    await dlg.getByLabel('اسم الموضوع').fill('Alvarado score');
    await dlg.getByLabel('الاسم العربي (اختياري)').fill(`مقياس ألفارادو ${stamp}`);
    await dlg.getByRole('button', { name: 'احفظ' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(`مقياس ألفارادو ${stamp}`), level: 1 })).toBeVisible();
    const suggested = page.getByRole('region', { name: 'روابط مقترحة — راجعها' });
    await expect(suggested.getByText('لماذا: اسم الموضوع مذكور في نص السؤال.').first()).toBeVisible();
    await screenshot(page, testInfo, 'f2-topic-suggestions');
    const reject = suggested.getByRole('button', { name: /^ارفض الاقتراح: Which of the following is NOT typically part of the Alvarado score/ }).first();
    await reject.click();
    await expect(page.getByText(/رفضت الاقتراح/)).toBeVisible();
    await suggested.getByRole('button', { name: `اقبل الرابط: Appendicitis topics ${stamp}` }).click();
    const linked = page.getByRole('region', { name: 'مرتبط بالموضوع' });
    await expect(linked.getByRole('link', { name: `Appendicitis topics ${stamp}` })).toBeVisible();
    await expect(page.getByText(/المرفوضة \(1\)/)).toBeVisible();
  });

  await test.step('the topic is a library filter', async () => {
    await page.getByRole('link', { name: /اعرض المكتبة مصفّاة بهذا الموضوع/ }).click();
    await expect(page.getByRole('heading', { name: /مصفّاة بالموضوع/ })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(`Appendicitis topics ${stamp}`) })).toBeVisible();
    await expectHealthyScreen(page);
    await screenshot(page, testInfo, 'f2-library-topic-filter');
    await page.getByRole('button', { name: 'إلغاء التصفية' }).click();
    await expect(page.getByRole('tab', { name: 'الرف' })).toBeVisible();
  });

  await test.step('Student Knowledge Map: states in words + icon, the estimate labelled as an estimate', async () => {
    await page.goto(`/knowledge?course=${course.id}`);
    await expect(page.getByRole('heading', { name: 'خريطة معرفتي', level: 1 })).toBeVisible();
    await expect(page.getByText(/ليس قياسًا يقينيًا/)).toBeVisible();
    const list = page.getByRole('list', { name: 'المفاهيم وحالتها' });
    await expect(list.getByText('لم تبدأ بعد').first()).toBeVisible();
    await expect(list.getByText(/لا تقدير بعد/).first()).toBeVisible();
    await screenshot(page, testInfo, 'f2-knowledge-map');
  });

  await test.step('an OSCE attempt shows up in the Weakness Center as its own signal type with a retry action', async () => {
    const created = await api.post<{ id: string }>('/api/cases', {
      definition: {
        kind: 'osce',
        title: `OSCE F2 history (TEST) ${stamp}`,
        facts: [{ id: 'f_onset', label: 'بداية الألم', value: 'بدأ الألم أمس حول السرة', kind: 'history', reveal: 'on_request' }],
        osce: {
          station_type: 'history_taking',
          candidate_instructions: 'خذ القصة المرضية من مريض يشكو ألمًا في البطن.',
          roles: ['patient', 'examiner'],
          minutes: 8,
          patient_responses: [{ id: 'r_onset', match: ['متى بدأ', 'onset'], fact_id: 'f_onset' }],
        },
        checklist: [
          { id: 'o_onset', text: 'Asked about the onset of pain', category: 'history', match: ['متى بدأ', 'onset'], order: 1 },
          { id: 'o_fever', text: 'Asked about fever', category: 'history', match: ['حرارة', 'fever'], order: 2 },
        ],
      },
      scope: null,
    });
    const run = await api.post<{ attempt: { id: string } }>(`/api/cases/${created.id}/attempts`, {});
    const ev = (event: Record<string, unknown>) => api.post(`/api/cases/attempts/${run.attempt.id}/events`, { event_id: `e2e${Math.random().toString(36).slice(2, 12)}`, ...event });
    await ev({ type: 'utterance', text: 'متى بدأ الألم؟' });
    await ev({ type: 'finish' });
    await page.goto('/weakness');
    const item = page.locator('.lw-wk').filter({ hasText: `OSCE F2 history (TEST) ${stamp}` });
    await expect(item).toBeVisible();
    await expect(item.getByText('حالة / OSCE / شفهي')).toBeVisible();
    await expect(item.getByRole('link', { name: /أعد محاولة/ })).toBeVisible();
    await expect(page.getByText(/كل بند في قائمة التقييم إشارة بنوعها/)).toBeVisible();
    await screenshot(page, testInfo, 'f2-weakness-osce');
  });
});
