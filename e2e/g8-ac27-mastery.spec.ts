// G8 / AC-27 against the REAL server and the built web app (both projects; no AI needed): in the practice runner the
// owner answers one G8 question correctly by GUESSING, one correctly after asking for a HINT, and one wrongly; then:
//   * the feedback says plainly that a guess / a hinted answer is not mastery; the confidence recorded with a checked
//     answer can no longer be changed (no re-labelling a guess after seeing the correction);
//   * the hint the server served is counted even though the device's own counter is not trusted;
//   * the mastery estimate and the weakness center use those signals (assisted answers raise mastery less), and the
//     weakness explains itself in words;
//   * the mistake type is editable in the feedback AND in the Mistake Genome; the edit survives a reload; the automatic
//     suggestion stays visible next to the owner's choice.
// Questions 1, 2 and 4 of the G8-only bank are used (question 3's key is corrected by the AC-26 spec on the same server).
import { join } from 'node:path';
import type { ExamCreateResponse, MistakeGenomeView, QuestionListResponse, SourceProgressDetail, WeaknessListResponse } from '@medlevo/shared';
import { expect, expectHealthyScreen, screenshot, setupOwner, test } from './support';
import { ACCEPTANCE_DIR, uploadFile } from './g1-helpers';

test('AC-27: guessed / hinted correct answers are not mastery; the owner sees why and edits the mistake type', async ({ page, api }, testInfo) => {
  test.setTimeout(300_000);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const stamp = Date.now().toString(36);
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `Appendicitis G8-27 ${stamp}` });
  const bank = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g8_key_bank.pdf'), { sourceType: 'question_source', title: `G8 Revision Bank 27 ${stamp}` });
  await api.waitForProcessing(lecture.version_id);
  await api.waitForProcessing(bank.version_id, { questions: true });
  const list = await api.get<QuestionListResponse>(`/api/questions?source_id=${bank.source_id}&limit=50`);
  const byStem = (s: string) => list.items.find((i) => i.stem_preview.includes(s))!.id;
  const q1 = byStem('where does the pain');
  const q2 = byStem('which white cell count');
  const q4 = byStem('which differential diagnosis');
  const { session } = await api.post<ExamCreateResponse>('/api/exams', { title: '', mode: 'practice', count: 3, question_ids: [q1, q2, q4], policy: { hints: 'progressive', shuffle_options: false } });

  const signals: string[] = [];
  await test.step('practice: a guess, a hinted answer and a mistake', async () => {
    await page.goto(`/exams/${session.attempt.id}`);
    for (let i = 0; i < 3; i++) {
      const stem = await page.locator('.ex-stem').innerText();
      const fb = page.locator('.ex-feedback');
      if (stem.includes('where does the pain')) {
        await page.locator('.ex-opt').filter({ hasText: 'In the periumbilical region' }).click();
        await page.getByRole('button', { name: 'تخمين' }).click();
        await page.getByRole('button', { name: 'تحقّق من إجابتي' }).click();
        await expect(fb.getByRole('note').filter({ hasText: 'صحيحة بالتخمين — لا تُعد إتقانًا' })).toBeVisible();
        // the confidence of a checked answer is a recorded fact now — no button to change it
        await expect(page.getByText('مدى ثقتك المسجّل مع إجابتك: تخمين')).toBeVisible();
        await expect(page.getByRole('button', { name: 'واثق' })).toHaveCount(0);
        signals.push('guess');
      } else if (stem.includes('which white cell count')) {
        await page.getByRole('button', { name: 'تلميح', exact: true }).click();
        await expect(page.locator('.ex-hint').first()).toBeVisible();
        await page.locator('.ex-opt').filter({ hasText: 'Above 11' }).click();
        await page.getByRole('button', { name: 'واثق' }).click();
        await page.getByRole('button', { name: 'تحقّق من إجابتي' }).click();
        await expect(fb.getByRole('note').filter({ hasText: 'صحيحة بعد تلميح' })).toBeVisible();
        signals.push('hint');
      } else {
        await page.locator('.ex-opt').filter({ hasText: 'Gout' }).click();
        await page.getByRole('button', { name: 'واثق' }).click();
        await page.getByRole('button', { name: 'تحقّق من إجابتي' }).click();
        const select = fb.getByLabel('صنّف خطأك');
        await expect(select).toBeVisible();
        await select.selectOption({ label: 'خطأ قراءة' });
        await expect(fb.getByText('صنّفته بنفسك.')).toBeVisible();
        await screenshot(page, testInfo, 'g8-ac27-feedback-mistake');
        signals.push('wrong');
      }
      if (i < 2) await page.getByRole('button', { name: 'التالي' }).click();
    }
    expect(signals.sort()).toEqual(['guess', 'hint', 'wrong']);
  });

  await test.step('the server counted the hint and weighs assisted answers less', async () => {
    const attempts = await api.get<{ items: Array<{ id: string }> }>('/api/exams/attempts?limit=5');
    expect(attempts.items.length).toBeGreaterThan(0);
    const p = await api.get<SourceProgressDetail>(`/api/learning/progress/${bank.source_id}`);
    expect(p.mastery_estimate).not.toBeNull();
    expect(p.mastery_estimate!).toBeLessThan(0.5); // a guess (0.2) + a hint (0.35) + a mistake — far from 1
    const weak = await api.get<WeaknessListResponse>('/api/learning/weakness?status=all');
    const w = weak.items.find((x) => x.signal_views.some((s) => s.question_id === q4 && s.correct === false))!;
    expect(w, 'the mistake produced a weak point').toBeTruthy();
    const assisted = w.signal_views.filter((s) => s.question_id === q1 || s.question_id === q2);
    for (const s of assisted) expect(s.weight!).toBeLessThan(1);
    expect(w.score_formula_ar).toContain('التخمين');
    expect(w.reasons_ar.join(' ')).toMatch(/[؀-ۿ]/);
  });

  await test.step('Weakness Center: the reasons in words; the Mistake Genome edits the type and the edit survives a reload', async () => {
    await page.goto('/weakness');
    await expect(page.getByRole('heading', { name: /أنماط أخطائك/ })).toBeVisible();
    await expectHealthyScreen(page);
    const genome = await api.get<MistakeGenomeView>('/api/learning/mistakes/genome');
    const rec = genome.recent.find((r) => r.question_id === q4)!;
    expect(rec.mistake_type).toBe('misread');
    expect(rec.mistake_origin).toBe('owner');
    const row = page.locator('.lw-genome-recent__item').filter({ hasText: 'which differential diagnosis' }).first();
    await expect(row).toContainText('صنّفته بنفسك');
    if (rec.auto_mistake_type) await expect(row).toContainText('الاقتراح الآلي');
    await row.getByLabel('نوع الخطأ').selectOption({ label: 'خلط بين مفهومين' });
    await expect(page.getByText('حُفظ تصنيفك. الإجابة نفسها لم تتغير.')).toBeVisible();
    await page.reload();
    const again = page.locator('.lw-genome-recent__item').filter({ hasText: 'which differential diagnosis' }).first();
    await expect(again.getByLabel('نوع الخطأ')).toHaveValue('concept_confusion');
    await screenshot(page, testInfo, 'g8-ac27-genome');
    // a CORRECT answer cannot be classified as a mistake, whatever path is used
    const g2 = await api.get<MistakeGenomeView>('/api/learning/mistakes/genome');
    expect(g2.recent.some((r) => r.question_id === q1 || r.question_id === q2)).toBe(false);
  });
});
