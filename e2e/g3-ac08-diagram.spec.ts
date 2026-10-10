// G3 / AC-08 — a diagram's unreadable parts are shown as uncertain and never become a fixed exam answer. REAL server
// + real processing of the Golden Set lecture (flowchart «Figure 1» on printed page 14). No AI key exists here: the
// AI explanation of the figure and question generation must say «requires configuration» — never a fake result.
// What a model does with the figure (arrow direction in words, uncertain items, no fixed answer from OCR labels) is
// verified in apps/server/test/acceptance/g3-ac08.test.ts with the test-only scripted provider.
import type { CapabilitiesResponse, ImageListResponse, ImageQuizView, QuestionListResponse } from '@medlevo/shared';
import { versionPages } from './g1-helpers';
import { expect, screenshot, setupOwner, test, waitForWorkspace } from './support';

test('AC-08: the flowchart labels are «uncertain» in the reader; AI paths are honest; the Image Quiz never asks an uncertain label', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
  expect(['completed', 'partial']).toContain((await api.waitForProcessing(lecture.version_id)).job?.status);
  const p14 = (await versionPages(api, lecture.source_id, lecture.version_id)).find((p) => p.printed_label === '14')!;
  expect(p14, 'printed page 14 exists').toBeTruthy();
  const caps = await api.get<CapabilitiesResponse>('/api/capabilities');

  await test.step('reader → «المصادر»: the diagram region of page 14 is «غير مؤكد», its OCR labels shown as read', async () => {
    await page.goto(`/study/${lecture.source_id}?page_id=${p14.id}`);
    await waitForWorkspace(page);
    const railTab = (name: string) => page.getByRole('tab', { name: new RegExp(name) });
    if (!(await railTab('المصادر').isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
    await railTab('المصادر').click();
    const diagramRow = page.locator('.wk-region-row').filter({ has: page.locator('.wk-region-row__kind', { hasText: /^مخطط$/ }) });
    await expect(diagramRow).toHaveCount(1, { timeout: 30_000 });
    await expect(diagramRow).toContainText('غير مؤكد');
    await expect(diagramRow).toContainText('Alvarado score');
    // the caption is ordinary extracted text, not uncertain
    const captionRow = page.locator('.wk-region-row').filter({ has: page.locator('.wk-region-row__kind', { hasText: /^تعليق شكل$/ }) });
    await expect(captionRow).toContainText('Figure 1');
    await expect(captionRow).not.toContainText('غير مؤكد');
    await screenshot(page, testInfo, 'g3-ac08-diagram-uncertain');
  });

  await test.step('«اشرح الشكل» is disabled with the server reason; the API answers «not configured» and stores nothing', async () => {
    const railTab = (name: string) => page.getByRole('tab', { name: new RegExp(name) });
    await railTab('الشرح والسؤال').click();
    await expect(page.getByRole('button', { name: 'اشرح الشكل' })).toBeDisabled();
    await expect(page.locator('#sb-figure-reason')).toContainText(caps.features['ai.figure_explain'].reason_ar!);
    const fig = await api.call('POST', '/api/studybook/explain', {
      action: 'explain_image',
      style: 'detailed',
      anchor: { source_id: lecture.source_id, version_id: lecture.version_id, page_id: p14.id },
      scope: { mode: 'lecture_only', lecture_source_id: lecture.source_id },
    });
    expect(fig.status()).toBe(409);
    expect((await fig.json()).error.code).toBe('AI_NOT_CONFIGURED');
    const gen = await api.call('POST', '/api/exams/generate', { lecture_source_id: lecture.source_id, page_ids: [p14.id], count: 1, difficulty: 'medium' });
    expect(gen.status()).toBe(409);
    expect((await gen.json()).error.code).toBe('AI_NOT_CONFIGURED');
    const generated = await api.get<QuestionListResponse>(`/api/questions?lecture_id=${lecture.source_id}&origin=generated`);
    expect(generated.items).toHaveLength(0);
    await screenshot(page, testInfo, 'g3-ac08-figure-explain-honest');
  });

  await test.step('Image Quiz on the real figure: an uncertain label blocks the quiz; with a certain one only that one is asked', async () => {
    const img = (await api.get<ImageListResponse>(`/api/media/images?source_id=${lecture.source_id}`)).images.find((i) => (i.caption ?? '').includes('Figure 1'))!;
    expect(img, 'the flowchart is in the image explorer').toBeTruthy();
    await api.post(`/api/media/images/${img.id}/overlays`, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.02, y: 0.58, w: 0.28, h: 0.16 }, label: 'Score ≥ 7', certainty: 'uncertain' });
    await page.goto(`/media/images/${img.id}`);
    const start = page.getByRole('button', { name: 'اختبر نفسك على هذه الصورة' });
    await expect(start).toBeDisabled();
    await expect(page.locator('#md-quiz-why')).toContainText('التسميات غير المؤكدة لا تصبح أجوبة');
    await expect(page.getByText('التسمية غير مؤكدة، ولا تصبح جوابًا ثابتًا في الاختبار').first()).toBeVisible();
    await screenshot(page, testInfo, 'g3-ac08-quiz-blocked');

    await api.post(`/api/media/images/${img.id}/overlays`, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.36, y: 0.27, w: 0.28, h: 0.11 }, label: 'Alvarado score', certainty: 'from_caption' });
    await page.reload();
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page).toHaveURL(/\/media\/quiz\//);
    await expect(page.getByRole('heading', { level: 1, name: 'ماذا تخفي المناطق المرقّمة؟' })).toBeVisible();
    await expect(page.getByText(/استُبعد قناع واحد/)).toBeVisible();
    // no answer anywhere in the quiz page: neither the asked label nor the uncertain one
    const main = page.locator('main');
    await expect(main).not.toContainText('Score ≥ 7');
    await expect(main).not.toContainText('Alvarado score');
    const quizId = page.url().split('/media/quiz/')[1]!.split(/[?#]/)[0]!;
    const quiz = await api.get<ImageQuizView>(`/api/media/quiz/${quizId}`);
    expect(quiz.masks).toHaveLength(1);
    expect(quiz.excluded).toHaveLength(1);
    await screenshot(page, testInfo, 'g3-ac08-quiz');
  });
});
