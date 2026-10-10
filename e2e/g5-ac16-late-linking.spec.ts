// G5 — AC-16 «ربط لاحق» against the REAL server (built web app, real processing, extraction and matching; no AI):
// the course's question source is uploaded FIRST and the Appendicitis lecture LATER. In the lecture's study rail
// («الأسئلة») the fitting questions appear with the reason for the link, the lecture pages (buttons that move the
// reader) and the question's own page in the question source (a button that opens it). Then the refutation paths
// that failed before G5: a lecture uploaded elsewhere and MOVED into the course, and an Arabic bank + Arabic lecture.
// Fixtures: Golden Set + fixtures/acceptance/g5_*.pdf (synthetic TEST FIXTURE documents, never medical content).
import { join } from 'node:path';
import type { LectureQuestionsResponse, QuestionListResponse } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, setupOwner, test, waitForWorkspace, type E2eApi } from './support';
import { ACCEPTANCE_DIR, reEscape, uploadFile } from './g1-helpers';
import type { Page } from '@playwright/test';

// A2–A4 of the Golden Set bank are covered by the Appendicitis lecture. (A1 too on a fresh server — but A1 is ONE question
// across every upload of the Golden Set on an E2E server, and the G4 AC-15 spec prints it elsewhere with another key:
// with a conflicting key the lecture can no longer confirm its answer, so it is honestly only «وثيق الصلة».)
const COVERED = ['NOT typically part of the Alvarado score', 'woman of reproductive age presents with right iliac fossa pain', 'white cell count of 11.5'];

async function coveredStems(api: E2eApi, lectureId: string): Promise<string[]> {
  return (await api.get<LectureQuestionsResponse>(`/api/questions/for-lecture/${lectureId}`)).items.filter((i) => i.link.relation === 'directly_covered').map((i) => i.stem_preview);
}

async function linkedCount(api: E2eApi, lectureId: string): Promise<number> {
  return (await api.get<LectureQuestionsResponse>(`/api/questions/for-lecture/${lectureId}`)).items.filter((i) => i.link.relation === 'directly_covered').length;
}

const allCovered = async (api: E2eApi, lectureId: string) => {
  const stems = await coveredStems(api, lectureId);
  return COVERED.every((c) => stems.some((s) => s.includes(c)));
};

async function openQuestionsTab(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: /الأسئلة/ });
  // on a phone the rail is a sheet that may still be closing (after a page jump): retry until it is open and stable
  await expect(async () => {
    if (!(await tab.isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click({ timeout: 3000 });
    await tab.click({ timeout: 3000 });
    await expect(page.getByRole('link', { name: 'كل أسئلة المحاضرة في الخزنة' })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
}

const railItem = (page: Page, stem: string) => page.locator('.qv-rail__item').filter({ hasText: stem });

test('AC-16: question source first, lecture later → the questions on the lecture with reasons, lecture pages and source pages', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const bank = `Surgery bank G5 ${Date.now().toString(36)}`;

  const qs = await test.step('the question source is uploaded FIRST and extracted', async () => {
    const up = await api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create', title: bank });
    const done = await api.waitForProcessing(up.version_id, { questions: true });
    expect(done.extraction?.job?.status).toBe('completed');
    expect((await api.get<QuestionListResponse>(`/api/questions?source_id=${up.source_id}`)).total).toBe(7);
    return up;
  });

  const lecture = await test.step('the Appendicitis lecture is uploaded LATER; matching links its questions', async () => {
    const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `Appendicitis G5 ${Date.now().toString(36)}` });
    await api.waitForProcessing(up.version_id);
    await expect.poll(() => allCovered(api, up.source_id), { timeout: 60_000 }).toBe(true);
    return up;
  });

  await test.step('rail «الأسئلة»: the question with its source page, the reason and the lecture pages', async () => {
    await openWorkspace(page, lecture.source_id);
    await openQuestionsTab(page);
    // A3 spans pages 1–2 of the question source; its answer (β-hCG) is on the lecture's printed page 12
    const a3 = railItem(page, 'woman of reproductive age presents with right iliac fossa pain');
    await expect(a3).toHaveCount(1);
    await expect(a3.getByRole('button', { name: `افتح الأصل: سؤال من مصدر الأسئلة — ${bank} — ص 1–2 — رقم السؤال 3 (Section A)` })).toBeVisible();
    await expect(a3.getByText('مغطى مباشرة').first()).toBeVisible();
    await a3.getByText('لماذا رُبط بهذه المحاضرة؟').click();
    await expect(a3.locator('.qv-rail__reason')).toContainText('Pregnancy test');
    await expect(a3.locator('.qv-rail__reason')).toContainText('ص 12');
    await expect(a3.getByRole('button', { name: 'ص 12', exact: true })).toBeVisible();
    // A1 is on the lecture too (with its relation and reason, whatever the state of its key on this server)
    await expect(railItem(page, 'Which point is classically tender in acute appendicitis?')).toHaveCount(1);
    await screenshot(page, testInfo, 'g5-ac16-rail-reason');
  });

  await test.step('a lecture page button moves the reader to that page (A2 → «ص 13», the Alvarado table)', async () => {
    const a2 = railItem(page, 'NOT typically part of the Alvarado score');
    await a2.getByText('لماذا رُبط بهذه المحاضرة؟').click();
    await expect(a2.locator('.qv-rail__reason')).toContainText('NOT');
    await a2.getByRole('button', { name: 'ص 13', exact: true }).click();
    await expect(page.locator('.wk-pageind').first()).toContainText('ص 13', { timeout: 15_000 });
  });

  await test.step('«افتح الأصل» opens the question source on the question\'s page', async () => {
    // on a phone the rail is a sheet that closed to show the page: open it again
    await openQuestionsTab(page);
    const a3 = railItem(page, 'woman of reproductive age presents with right iliac fossa pain');
    await a3.getByRole('button', { name: new RegExp(`^افتح الأصل: سؤال من مصدر الأسئلة — ${reEscape(bank)}`) }).click();
    await waitForWorkspace(page);
    await expect(page).toHaveURL(new RegExp(`/study/${qs.source_id}`));
    await expect(page.locator('.wk-pageind').first()).toContainText(/ص 1|الصفحة 1/);
    await screenshot(page, testInfo, 'g5-ac16-original');
  });
});

test('AC-16: a lecture uploaded elsewhere and MOVED into the course later gets the course\'s questions', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course, notebook } = await api.createNotebookAndCourse();
  const bank = `Bank moved G5 ${Date.now().toString(36)}`;
  const qs = await api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create', title: bank });
  await api.waitForProcessing(qs.version_id, { questions: true });
  // uploaded into the notebook itself (not the course): no question source there
  const lecture = await api.uploadFixture(notebook.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `Appendicitis unfiled ${Date.now().toString(36)}` });
  await api.waitForProcessing(lecture.version_id);
  expect((await api.get<LectureQuestionsResponse>(`/api/questions/for-lecture/${lecture.source_id}`)).matching.state).toBe('no_question_sources');

  await api.patch(`/api/sources/${lecture.source_id}`, { node_id: course.id });
  await expect.poll(() => allCovered(api, lecture.source_id), { timeout: 60_000 }).toBe(true);

  await openWorkspace(page, lecture.source_id);
  await openQuestionsTab(page);
  const a3 = railItem(page, 'woman of reproductive age presents with right iliac fossa pain');
  await expect(a3.getByRole('button', { name: new RegExp(`^افتح الأصل: سؤال من مصدر الأسئلة — ${reEscape(bank)} — ص 1–2 — رقم السؤال 3`) })).toBeVisible();
  await expect(page.getByText('لم يُعثر على أسئلة من مصادر الكورس تغطيها هذه المحاضرة.')).toHaveCount(0);
  await screenshot(page, testInfo, 'g5-ac16-moved');
});

test('AC-16 (Arabic): an Arabic bank first, an Arabic lecture later → linked with Arabic reasons, RTL', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const bank = `بنك أسئلة المرارة ${Date.now().toString(36)}`;
  const qs = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g5_questions_ar.pdf'), { sourceType: 'question_source', title: bank });
  await api.waitForProcessing(qs.version_id, { questions: true });
  const lecture = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g5_lecture_ar.pdf'), { sourceType: 'lecture', title: `محاضرة التهاب المرارة ${Date.now().toString(36)}` });
  await api.waitForProcessing(lecture.version_id);
  await expect.poll(() => linkedCount(api, lecture.source_id), { timeout: 60_000 }).toBe(2);

  await openWorkspace(page, lecture.source_id);
  await openQuestionsTab(page);
  const q2 = railItem(page, 'ما الفحص الأولي المفضل عند الشك بحصى المرارة؟');
  await expect(q2).toHaveCount(1);
  await expect(q2.getByRole('button', { name: `افتح الأصل: سؤال من مصدر الأسئلة — ${bank} — ص 1 — رقم السؤال 2` })).toBeVisible();
  await q2.getByText('لماذا رُبط بهذه المحاضرة؟').click();
  await expect(q2.locator('.qv-rail__reason')).toContainText('مذكورة في المحاضرة');
  await expect(q2.locator('.qv-rail__reason')).toContainText('Ultrasound');
  await expect(q2.getByRole('button', { name: 'ص 2', exact: true })).toBeVisible();
  // the femur question of the same bank is not offered as covered by this lecture
  await expect(railItem(page, 'كسر عظم الفخذ').locator('.qv-rail__pills').getByText('مغطى مباشرة')).toHaveCount(0);
  await screenshot(page, testInfo, 'g5-ac16-arabic');
});
