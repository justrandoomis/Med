// G5 — AC-17 / AC-19 (and the honest AC-18 state) against the REAL server and the built web app; no AI key exists.
//  * AC-17: the same two questions printed in a question source AND a previous exam (G5-only fixtures — the Golden Set's
//    A1 is shared by every spec on an E2E server and gets a conflicting key from the G4 spec) → each ONE item in the
//    exam; after finishing, the correction lists both places it appears (file, page, number).
//  * AC-19: during the exam nothing on the Question Sheet points at the key — no tick / asterisk printed next to an
//    option (G5 marked bank), no source name / section / page, no hint / solution / check buttons, the picture of a
//    picture question is served without a file name and its caption (which names the answer) is not shown; the
//    runner never asks the server for a question's source, feedback or answer while the attempt runs. After finishing,
//    the correction opens the key, the occurrences and the lecture pages (a link that opens the reader there).
//  * AC-18: question generation needs an AI provider: the screen says why it is unavailable and the server answers
//    409 AI_NOT_CONFIGURED — nothing is generated or faked.
// Fixtures: Golden Set + fixtures/acceptance/g5_{dup_a,dup_b,marked_bank}.pdf (synthetic TEST FIXTURE documents).
import { join } from 'node:path';
import type { CapabilitiesResponse, ExamCreateResponse, ExamResultDetail, QuestionListResponse } from '@medlevo/shared';
import type { Page } from '@playwright/test';
import { expect, screenshot, setupOwner, test, waitForWorkspace } from './support';
import { ACCEPTANCE_DIR, uploadFile } from './g1-helpers';

/** Watch the runner's requests: while an attempt runs it may only load its own session / media and sync. */
function watchRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) seen.push(`${r.method()} ${u.pathname}`);
  });
  return seen;
}

async function answerAllAndFinish(page: Page, count: number, onItem: (i: number) => Promise<void>, beforeFinish: () => void = () => {}): Promise<void> {
  for (let i = 0; i < count; i++) {
    await expect(page.locator('.ex-stem')).toBeVisible();
    await onItem(i);
    await page.locator('.ex-opt').first().click();
    if (i < count - 1) await page.getByRole('button', { name: 'التالي' }).click();
  }
  beforeFinish();
  await page.getByRole('button', { name: 'إنهاء الاختبار' }).click();
  await page.getByRole('button', { name: 'إنهاء وعرض النتيجة' }).click();
  await expect(page).toHaveURL(/\/results$/);
}

test('AC-17 + AC-19: one item for a question printed in two files; nothing reveals the key during the exam; full evidence after', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const stamp = Date.now().toString(36);
  const bankTitle = `G5 dup bank A ${stamp}`;
  const prevTitle = `G5 previous exam B ${stamp}`;
  const lectureTitle = `Appendicitis G5x ${stamp}`;
  // the same two questions printed in a question source and in a previous exam (G5-only fixtures)
  const qs = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g5_dup_a.pdf'), { sourceType: 'question_source', title: bankTitle });
  const prev = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g5_dup_b.pdf'), { sourceType: 'previous_exam', title: prevTitle });
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: lectureTitle });
  for (const v of [qs, prev]) await api.waitForProcessing(v.version_id, { questions: true });
  await api.waitForProcessing(lecture.version_id);
  await expect
    .poll(async () => (await api.get<{ items: Array<{ link: { relation: string } }> }>(`/api/questions/for-lecture/${lecture.source_id}`)).items.filter((i) => i.link.relation === 'directly_covered').length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(2);

  const Q1 = 'Which patients with suspected appendicitis need a pregnancy test (β-hCG)?';
  const { session } = await api.post<ExamCreateResponse>('/api/exams', { title: '', mode: 'exam', count: 50, source_ids: [qs.source_id, prev.source_id], seed: `g5-e2e-${stamp}` });
  const n = session.items.length;
  // four printed questions, two distinct questions → two items
  expect(n).toBe(2);

  const requests = watchRequests(page);
  let cut = 0;
  const stems: string[] = [];
  await test.step('during the exam: each question once, no source / key / hint / solution, no source peek requests', async () => {
    await page.goto(`/exams/${session.attempt.id}`);
    await answerAllAndFinish(
      page,
      n,
      async (i) => {
        const stem = (await page.locator('.ex-stem').innerText()).trim();
        stems.push(stem);
        const sheet = await page.locator('main').innerText();
        for (const leak of [bankTitle, prevTitle, lectureTitle, 'الإجابة الصحيحة', 'مصدر المفتاح', 'ص 1 —', 'ص 12', 'رقم السؤال']) expect(sheet, `item ${i + 1}: ${leak}`).not.toContain(leak);
        for (const b of ['تلميح', 'اعرض الحل', 'تحقّق من إجابتي']) await expect(page.getByRole('button', { name: b, exact: true })).toHaveCount(0);
        if (i === 0) await screenshot(page, testInfo, 'g5-ac19-sheet');
      },
      () => (cut = requests.length),
    );
    expect(stems.filter((s) => s.includes(Q1))).toHaveLength(1);
    const during = requests.slice(0, cut).filter((r) => /\/api\/questions|\/feedback|\/solution|\/hint|\/answer|\/api\/sources|\/api\/evidence/.test(r));
    expect(during, 'no source peek / answer request while the attempt runs').toEqual([]);
  });

  await test.step('after finishing: the correction shows the key, BOTH occurrences and the lecture page', async () => {
    await expect.poll(async () => (await api.call('GET', `/api/exams/attempts/${session.attempt.id}/result`)).status(), { timeout: 30_000 }).toBe(200);
    const result = await api.get<ExamResultDetail>(`/api/exams/attempts/${session.attempt.id}/result`);
    expect(result.total_items).toBe(n);
    await page.reload();
    const item = page.locator('.ex-item').filter({ hasText: 'need a pregnancy test' });
    await expect(item).toHaveCount(1);
    await item.getByRole('button', { name: 'عرض التصحيح والأدلة' }).click();
    const fb = item.locator('.ex-feedback');
    await expect(fb.locator('.ex-fb-option[data-key="true"]')).toContainText('Women of reproductive age');
    // every place it appears is listed (file, page, number) — both files of this run
    const occurrences = fb.locator('.ex-origin li').filter({ hasText: 'سؤال من مصدر الأسئلة' });
    await expect(occurrences.filter({ hasText: `سؤال من مصدر الأسئلة — ${bankTitle} — ص 1 — رقم السؤال 1` })).toHaveCount(1);
    await expect(occurrences.filter({ hasText: `سؤال من مصدر الأسئلة — ${prevTitle} — ص 1 — رقم السؤال 1` })).toHaveCount(1);
    await screenshot(page, testInfo, 'g5-ac17-correction');
    const row = fb.getByRole('list', { name: 'في المحاضرة' }).getByRole('listitem').filter({ hasText: lectureTitle });
    await expect(row).toContainText('مغطى مباشرة');
    await row.getByRole('link', { name: 'ص 12', exact: true }).click();
    await waitForWorkspace(page);
    await expect(page).toHaveURL(new RegExp(`/study/${lecture.source_id}`));
    await expect(page.locator('.wk-pageind').first()).toContainText('ص 12');
  });
});

test('AC-19: marks printed next to the answer and the picture caption never reach the Question Sheet', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const marked = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g5_marked_bank.pdf'), { sourceType: 'question_source', title: `G5 marked bank ${Date.now().toString(36)}` });
  await api.waitForProcessing(marked.version_id, { questions: true });
  expect((await api.get<QuestionListResponse>(`/api/questions?source_id=${marked.source_id}`)).total).toBe(4);
  const { session } = await api.post<ExamCreateResponse>('/api/exams', { title: '', mode: 'exam', count: 10, source_ids: [marked.source_id] });
  expect(session.items).toHaveLength(4);

  const media: Array<{ status: number; disposition: string; type: string }> = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/exams/media/')) media.push({ status: r.status(), disposition: r.headers()['content-disposition'] ?? '', type: r.headers()['content-type'] ?? '' });
  });
  await page.goto(`/exams/${session.attempt.id}`);
  let sawPicture = false;
  await answerAllAndFinish(page, 4, async () => {
    const sheet = await page.locator('main').innerText();
    expect(sheet).not.toMatch(/[✓✔]/);
    expect(sheet).not.toMatch(/Figure 1|Ultrasound of an inflamed|synthetic|g5_marked/);
    for (const opt of await page.locator('.ex-opt .ex-opt__text').allInnerTexts()) {
      expect(opt.trim()).not.toMatch(/\*|answer\s*:/i);
    }
    const img = page.locator('.ex-media img');
    if ((await img.count()) > 0) {
      sawPicture = true;
      await expect(img).toHaveAttribute('alt', 'الصورة 1 المرفقة بالسؤال');
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await screenshot(page, testInfo, 'g5-ac19-picture');
    }
  });
  expect(sawPicture).toBe(true);
  expect(media.length).toBeGreaterThan(0);
  for (const m of media) {
    expect(m.status).toBe(200);
    expect(m.type).toMatch(/^image\//);
    expect(m.disposition).not.toMatch(/filename/i);
  }
});

test('AC-18 (no AI key here): question generation says it is unavailable and why; the server refuses; nothing is generated', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const caps = await api.get<CapabilitiesResponse>('/api/capabilities');
  expect(caps.features['ai.generate_questions'].state).toBe('requires_configuration');
  const reason = caps.features['ai.generate_questions'].reason_ar!;
  await page.goto('/exams/generate');
  await expect(page.getByRole('heading', { level: 1, name: 'توليد أسئلة صعبة من محاضرتك' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: reason })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ولّد وتحقق' })).toBeDisabled();
  await screenshot(page, testInfo, 'g5-ac18-generate-unavailable');
  const { course } = await api.createNotebookAndCourse();
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
  await api.waitForProcessing(lecture.version_id);
  const res = await api.call('POST', '/api/exams/generate', { lecture_source_id: lecture.source_id, topic: 'pregnancy test investigations', count: 1, difficulty: 'hard' });
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AI_NOT_CONFIGURED');
  expect((await api.get<QuestionListResponse>(`/api/questions?origin=generated&lecture_id=${lecture.source_id}`)).items).toHaveLength(0);
});
