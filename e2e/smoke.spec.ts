// Smoke test of the main study flow against the REAL server (one fresh server + data dir per project):
// first-run setup → notebook + course → upload a lecture (through the upload screen) and a question source
// (through the API) → real processing + question extraction → library → source page → study workspace
// (printed page label «ص 11», AC-04) → Question Vault lists the extracted questions → Review hub → Control Center
// (AI honestly «requires configuration»: no AI key exists here). Runs on phone (390×844) and desktop (1280×800);
// the consoleGuard fixture fails the test on any console error, page error or 5xx API answer.
import type { CapabilitiesResponse, LectureQuestionsResponse, LibraryTreeResponse, QuestionListResponse, SourcePagesResponse } from '@medlevo/shared';
import { apiAs, expect, GOLDEN_DIR, openWorkspace, screenshot, setupOwner, test, waitForWorkspace } from './support';
import { join } from 'node:path';

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('smoke: setup → library → upload → processing → reader → vault → review → control', async ({ page, api }, testInfo) => {
  await test.step('owner first-run setup through the real screens', async () => {
    // every project gets its own fresh server: when no owner exists yet the screens must run the real first-run setup;
    // when another spec ran first on this server (specs run in file order), a repeat / retry, or an external
    // E2E_BASE_URL server, the owner exists and the screens log in instead
    const fresh = ((await (await page.request.get('/api/auth/status')).json()) as { setup_required: boolean }).setup_required;
    const how = await setupOwner(page);
    if (fresh) expect(how).toBe('setup');
    else expect(['login', 'already']).toContain(how);
    await screenshot(page, testInfo, '01-home');
  });

  const { notebook, course } = await test.step('create a notebook and a course', () => api.createNotebookAndCourse());

  await test.step('library shows the notebook, then the course inside it', async () => {
    await page.goto('/library');
    await expect(page.getByRole('heading', { level: 1, name: 'المكتبة' })).toBeVisible();
    await page.getByRole('link', { name: new RegExp(reEscape(notebook.title)) }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(reEscape(notebook.title)) })).toBeVisible();
    await page.getByRole('link', { name: new RegExp(reEscape(course.title)) }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(reEscape(course.title)) })).toBeVisible();
    await screenshot(page, testInfo, '02-course-empty');
  });

  const lecture = await test.step('upload the lecture through the upload screen', async () => {
    await page.goto(`/upload?node=${course.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'رفع مصادر' })).toBeVisible();
    await page.locator('input[type=file]').setInputFiles(join(GOLDEN_DIR, 'lecture_appendicitis.pdf'));
    await page.getByRole('button', { name: /^رفع ملف/ }).click();
    const accepted = page.getByRole('link', { name: 'التفاصيل والصفحات' });
    const addAnyway = page.getByRole('button', { name: 'أضفه نسخةً مستقلة' });
    await expect(accepted.or(addAnyway)).toBeVisible({ timeout: 60_000 });
    // same bytes already on this server (a repeated run): the owner decides — keep a separate copy
    if (await addAnyway.isVisible()) await addAnyway.click();
    await expect(accepted).toBeVisible({ timeout: 60_000 });
    const tree = await api.get<LibraryTreeResponse>('/api/library/tree');
    const src = tree.sources.find((s) => s.node_id === course.id && s.format === 'pdf' && /appendicitis/i.test(s.title));
    expect(src, 'the uploaded lecture is in the library tree').toBeTruthy();
    expect(src!.source_type).toBe('lecture');
    expect(src!.current_version_id).toBeTruthy();
    return { source_id: src!.id, version_id: src!.current_version_id! };
  });

  const qsource = await test.step('upload the question source through the API', () =>
    // on_duplicate=create: a repeated run against the same server stores a separate copy (exact duplicates then
    // attach to the existing questions instead of doubling them, AC-17)
    api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create' }),
  );

  await test.step('real processing finishes (and question extraction)', async () => {
    const lec = await api.waitForProcessing(lecture.version_id);
    expect(lec.job?.status).toBe('completed');
    const qs = await api.waitForProcessing(qsource.version_id, { questions: true });
    expect(qs.job?.status).toBe('completed');
    expect(qs.extraction?.job?.status).toBe('completed');
    const pages = await api.get<SourcePagesResponse>(`/api/sources/${lecture.source_id}/versions/${lecture.version_id}/pages`);
    expect(pages.pages.map((p) => p.printed_label)).toEqual(['11', '12', '13', '14']);
  });

  await test.step('upload screen shows the processed lecture; course lists both sources', async () => {
    await expect(page.getByRole('link', { name: /افتح للقراءة/ })).toBeVisible({ timeout: 30_000 });
    await screenshot(page, testInfo, '03-upload-done');
    await page.goto(`/library/${course.id}`);
    await expect(page.getByRole('link', { name: /lecture appendicitis/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /questions surgery course1/i }).first()).toBeVisible();
    await screenshot(page, testInfo, '04-course');
  });

  await test.step('source page shows printed label vs file position (AC-04)', async () => {
    await page.getByRole('link', { name: /lecture appendicitis/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/sources/${lecture.source_id}$`));
    await expect(page.getByText('ص 11 (الصفحة 1 في الملف)').first()).toBeVisible();
    await screenshot(page, testInfo, '05-source');
  });

  const caps = await test.step('capabilities: AI is honestly not configured (no key in this environment)', async () => {
    const caps = await api.get<CapabilitiesResponse>('/api/capabilities');
    expect(caps.ai.configured).toBe(false);
    for (const key of ['ai.explain', 'ai.chat', 'ai.study_book', 'ai.generate_questions'] as const) {
      expect(caps.features[key].state, `${key} without an AI key`).toBe('requires_configuration');
      expect(caps.features[key].reason_ar, `${key} explains why`).toBeTruthy();
    }
    return caps;
  });

  await test.step('study workspace renders the PDF with the printed page label «ص 11»', async () => {
    // in-app navigation from the source page
    await page.getByRole('link', { name: 'افتح في مساحة الدراسة' }).click();
    await waitForWorkspace(page);
    await expect(page).toHaveURL(new RegExp(`/study/${lecture.source_id}`));
    await expect(page.locator('.wk-textlayer span').first()).toBeAttached({ timeout: 30_000 });
    await expect(page.locator('.wk-folio__primary').first()).toHaveText(/ص 11/);
    await expect(page.locator('.wk-pageind').first()).toContainText('ص 11');
    // a hard load of the deep link (SPA fallback of the real server) opens the same book again
    await openWorkspace(page, lecture.source_id);
    await expect(page.locator('.wk-folio__primary').first()).toHaveText(/ص 11/);
    await screenshot(page, testInfo, '06-workspace');
  });

  await test.step('study rail: explain says why AI is unavailable; questions tab lists the linked questions (AC-16)', async () => {
    // the lecture came first, the question source later: matching links them once extraction finished
    await expect
      .poll(async () => (await api.get<LectureQuestionsResponse>(`/api/questions/for-lecture/${lecture.source_id}`)).matching.state, { timeout: 60_000 })
      .toBe('done');
    const linked = await api.get<LectureQuestionsResponse>(`/api/questions/for-lecture/${lecture.source_id}`);
    expect(linked.items.length, 'questions of the course linked to the appendicitis lecture').toBeGreaterThan(0);

    const railTab = (name: string) => page.getByRole('tab', { name: new RegExp(name) });
    if (!(await railTab('الأسئلة').isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
    await railTab('الشرح والسؤال').click();
    await expect(page.getByText('الشرح غير متاح الآن')).toBeVisible();
    await expect(page.getByText(caps.features['ai.explain'].reason_ar!).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'اشرح', exact: true })).toBeDisabled();
    await screenshot(page, testInfo, '07-rail-explain');

    await railTab('الأسئلة').click();
    await expect(page.getByRole('link', { name: 'كل أسئلة المحاضرة في الخزنة' })).toBeVisible();
    await expect(page.locator('.qv-rail__list li').first()).toBeVisible();
    await screenshot(page, testInfo, '08-rail-questions');
  });

  await test.step('Question Vault lists the extracted questions', async () => {
    const list = await api.get<QuestionListResponse>(`/api/questions?source_id=${qsource.source_id}`);
    expect(list.total).toBe(7);
    await page.goto(`/questions?source_id=${qsource.source_id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'خزنة أسئلتي' })).toBeVisible();
    await expect(page.locator('.qv-count')).toHaveText('7 أسئلة');
    await expect(page.locator('.qv-list > li')).toHaveCount(7);
    // stems as printed, with their origin (section-aware numbering, AC-12) and the negation kept (AC-11)
    await expect(page.getByText('Which point is classically tender in acute appendicitis?').first()).toBeVisible();
    await expect(page.getByText('Which of the following is NOT typically part of the Alvarado score?').first()).toBeVisible();
    await expect(page.getByText(/questions surgery course1/).first()).toBeVisible();
    await screenshot(page, testInfo, '09-vault');
  });

  const nav = (name: string) => page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('link', { name, exact: true });

  await test.step('Review hub opens from the main navigation', async () => {
    await nav('المراجعة').click();
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.getByRole('heading', { level: 1, name: 'المراجعة' })).toBeVisible();
    await screenshot(page, testInfo, '10-review');
  });

  await test.step('Control Center opens from settings and shows AI as not configured', async () => {
    await nav('الإعدادات').click();
    await expect(page.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeVisible();
    await page.getByRole('link', { name: /مركز التحكم/ }).click();
    await expect(page).toHaveURL(/\/control$/);
    await expect(page.getByRole('heading', { level: 1, name: 'مركز التحكم' })).toBeVisible();
    await expect(page.getByText(/غير مهيأ على الخادم/).first()).toBeVisible();
    await screenshot(page, testInfo, '11-control');
  });
});

test('smoke: owner API session (setupOwner(request) + apiAs) and CSRF guard', async ({ request, playwright, baseURL }) => {
  // a second "device": its own cookie jar, signed in through the API (setup if this server is still fresh)
  const how = await setupOwner(request);
  expect(['setup', 'login']).toContain(how);
  const api = apiAs(request);
  const { notebook } = await api.createNotebookAndCourse();
  const tree = await api.get<LibraryTreeResponse>('/api/library/tree');
  expect(tree.nodes.some((n) => n.id === notebook.id)).toBe(true);
  // the same mutation without the CSRF header is refused by the server (ARCHITECTURE §3.1)
  const refused = await request.post('/api/library/nodes', { data: { parent_id: null, kind: 'notebook', title: 'بلا ترويسة CSRF' } });
  expect(refused.status()).toBe(403);
  // and nothing is readable without the owner session
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    expect((await anonymous.get('/api/library/tree')).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
});
