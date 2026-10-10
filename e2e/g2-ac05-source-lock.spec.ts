// G2 / AC-05 — Source Lock on the REAL server (no AI key exists here, so every AI answer must say it needs
// configuration — never a cached or invented one). Golden Set: the appendicitis lecture and the cholecystitis
// reference (the only file that mentions Murphy's sign), linked as «R reference_for lecture».
// What this verifies end to end: the premise (the answer is ONLY in the reference), the lock the server resolves for
// «Lecture Only» whatever the request smuggles in, an out-of-lock anchor refused before anything else, AI requests
// refused honestly with nothing stored or served, and the rail's Source Lock UI (badge, picker preview, nothing widens
// until «طبّق النطاق», Ask disabled with the server's reason). The AI paths themselves (abstention + wider-scope
// action, no cache across locks) are verified in apps/server/test/acceptance/g2-ac05.test.ts with the test-only
// provider; the web chat lock in apps/web/src/features/workspace/studybook/ChatScope.g2.test.tsx.
import type { PageRegionsResponse, ScopeResolveResponse, SearchResponse, SourcePagesResponse } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, setupOwner, test } from './support';

test('AC-05: «Lecture Only» is the lecture alone; an answer only in the reference is never served inside it', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
  const reference = await api.uploadFixture(course.id, 'lecture_cholecystitis.pdf', { sourceType: 'course_reference', onDuplicate: 'create' });
  expect((await api.waitForProcessing(lecture.version_id)).job?.status).toBe('completed');
  expect((await api.waitForProcessing(reference.version_id)).job?.status).toBe('completed');
  await api.post(`/api/sources/${reference.source_id}/links`, { to_source_id: lecture.source_id, relation: 'reference_for' });

  await test.step('premise: «Murphy» is in the reference and NOT in the lecture', async () => {
    const inLecture = await api.get<SearchResponse>(`/api/search?q=Murphy&source_id=${lecture.source_id}`);
    const inRef = await api.get<SearchResponse>(`/api/search?q=Murphy&source_id=${reference.source_id}`);
    expect(inLecture.results.filter((r) => r.location?.source_id === lecture.source_id)).toHaveLength(0);
    expect(inRef.results.length).toBeGreaterThan(0);
  });

  await test.step('the server resolves «Lecture Only» to the lecture alone, whatever the request carries', async () => {
    const narrow = await api.post<ScopeResolveResponse>('/api/evidence/scope/resolve', {
      mode: 'lecture_only',
      lecture_source_id: lecture.source_id,
      reference_source_ids: [reference.source_id],
      version_pins: { [reference.source_id]: reference.version_id },
      versionIds: [reference.version_id],
      allow_external: true,
    });
    expect(narrow.sources.map((s) => s.source_id)).toEqual([lecture.source_id]);
    expect(narrow.scope.versionIds).toEqual([lecture.version_id]);
    const wide = await api.post<ScopeResolveResponse>('/api/evidence/scope/resolve', { mode: 'lecture_plus_references', lecture_source_id: lecture.source_id });
    expect(wide.sources.map((s) => s.source_id).sort()).toEqual([lecture.source_id, reference.source_id].sort());
  });

  await test.step('an anchor in the reference under «Lecture Only» is refused (OUT_OF_SCOPE) before anything else', async () => {
    const pages = await api.get<SourcePagesResponse>(`/api/sources/${reference.source_id}/versions/${reference.version_id}/pages`);
    const regions = await api.get<PageRegionsResponse>(`/api/sources/pages/${pages.pages[0]!.id}/regions`);
    const murphy = regions.regions.find((r) => (r.text ?? '').includes('Murphy'))!;
    expect(murphy, 'the Murphy region of the reference').toBeTruthy();
    const res = await api.call('POST', '/api/studybook/explain', {
      action: 'explain',
      style: 'detailed',
      anchor: { source_id: reference.source_id, version_id: reference.version_id, page_id: pages.pages[0]!.id, region_ids: [murphy.id] },
      scope: { mode: 'lecture_only', lecture_source_id: lecture.source_id },
    });
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OUT_OF_SCOPE');
  });

  await test.step('without an AI provider: explain / compare / chat answer «requires configuration»; nothing is stored or served', async () => {
    const pages = await api.get<SourcePagesResponse>(`/api/sources/${lecture.source_id}/versions/${lecture.version_id}/pages`);
    const anchor = { source_id: lecture.source_id, version_id: lecture.version_id, page_id: pages.pages[0]!.id, region_ids: [] };
    const lock = { mode: 'lecture_only', lecture_source_id: lecture.source_id };
    const explain = await api.call('POST', '/api/studybook/explain', { action: 'explain', style: 'detailed', anchor, scope: lock, instruction: "What is Murphy's sign?" });
    expect(explain.status()).toBe(409);
    expect(((await explain.json()) as { error: { code: string } }).error.code).toBe('AI_NOT_CONFIGURED');
    const compare = await api.call('POST', '/api/studybook/compare', { items: ["Murphy's sign", 'McBurney'], scope: lock });
    expect(compare.status()).toBe(409);
    const thread = await api.post<{ thread: { id: string } }>('/api/studybook/threads', { anchor, scope: lock, style: 'detailed' });
    const ask = await api.call('POST', `/api/studybook/threads/${thread.thread.id}/messages`, { text: "What is Murphy's sign?" });
    expect(ask.status()).toBe(409);
    const t = await api.get<{ messages: unknown[] }>(`/api/studybook/threads/${thread.thread.id}`);
    expect(t.messages).toHaveLength(0); // no draft, no «answer» at all
    const artifacts = await api.get<{ artifacts: unknown[] }>(`/api/studybook/artifacts?source_id=${lecture.source_id}`);
    expect(artifacts.artifacts).toHaveLength(0); // nothing cached to be served later
  });

  await test.step('the rail shows the lock; the picker previews the server lock; nothing widens until «طبّق النطاق»', async () => {
    await openWorkspace(page, lecture.source_id);
    const railTab = (name: string) => page.getByRole('tab', { name: new RegExp(name) });
    if (!(await railTab('الشرح والسؤال').isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
    await railTab('الشرح والسؤال').click();
    const badge = page.locator('.sb-scope .ev-scope-badge');
    await expect(badge).toContainText('المحاضرة فقط');
    await page.getByRole('button', { name: 'غيّر النطاق' }).click();
    const preview = page.locator('.ev-scope-picker__preview');
    await expect(preview.locator('li')).toHaveCount(1);
    await expect(preview).toContainText(/appendicitis/i);
    await page.getByRole('radio', { name: /المحاضرة \+ المراجع/ }).check();
    await expect(preview.locator('li')).toHaveCount(2);
    await expect(preview).toContainText(/cholecystitis/i);
    await screenshot(page, testInfo, 'g2-ac05-picker-wider-preview');
    await page.getByRole('button', { name: 'إلغاء' }).click();
    await expect(badge).toContainText('المحاضرة فقط'); // the preview never applied itself
    // Ask: disabled with the server's reason (no key) — no answer can come from anywhere
    await page.getByRole('radio', { name: 'سؤال' }).click();
    await expect(page.getByLabel('سؤالك عن هذا الموضع')).toBeDisabled();
    await expect(page.locator('#sb-chat-reason')).toContainText('ANTHROPIC_API_KEY');
    await screenshot(page, testInfo, 'g2-ac05-ask-disabled');
  });
});
