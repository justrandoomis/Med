// G2 / AC-29 — a file that tries to instruct the system (bypass the Source Lock, send data elsewhere, change
// settings) cannot change behaviour or permissions. REAL server + real processing; the injected TEST FIXTURES are
// fixtures/acceptance/g2_injected_lecture.pdf (uploaded through the upload SCREEN) and g2_injected_notes_ar.docx
// (Arabic, with pictures that are only LINKED to file:///etc/passwd and to another host).
// Verified in the browser: the injected text is shown and searched as plain document text (an HTML/JS payload
// stays text: no dialog, no element, no script), not one request leaves for another host, and settings,
// capabilities, links and the lecture's lock are exactly what they were. With no AI key the AI stays «requires
// configuration» — the file cannot switch it on. Model behaviour under the injection (a model that OBEYS it) is
// verified in apps/server/test/acceptance/g2-ac29.test.ts with the test-only provider.
import { join } from 'node:path';
import type { CapabilitiesResponse, LibraryTreeResponse, ScopeResolveResponse, SearchResponse, SourceDetail } from '@medlevo/shared';
import { ACCEPTANCE_DIR, uploadFile } from './g1-helpers';
import { expect, openWorkspace, screenshot, setupOwner, test } from './support';

const EXFIL_HOST = 'exfil.attacker.example';

test('AC-29: an injected file is data — shown and searched as text, no request leaves, nothing changes', async ({ page, api, baseURL }, testInfo) => {
  const dialogs: string[] = [];
  const foreign: string[] = [];
  const own = new URL(baseURL!).host;
  page.on('dialog', (d) => {
    dialogs.push(`${d.type()}: ${d.message()}`);
    void d.dismiss();
  });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['http:', 'https:'].includes(u.protocol)) return; // data: / blob: stay in the page
    if (u.host !== own) foreign.push(r.url());
  });

  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const before = {
    settings: await api.get('/api/settings'),
    caps: Object.fromEntries(Object.entries((await api.get<CapabilitiesResponse>('/api/capabilities')).features).map(([k, v]) => [k, v.state])),
  };

  const injected = await test.step('upload the injected PDF through the upload screen', async () => {
    await page.goto(`/upload?node=${course.id}`);
    await page.locator('input[type=file]').setInputFiles(join(ACCEPTANCE_DIR, 'g2_injected_lecture.pdf'));
    await page.getByRole('button', { name: /^رفع ملف/ }).click();
    const accepted = page.getByRole('link', { name: 'التفاصيل والصفحات' });
    const addAnyway = page.getByRole('button', { name: 'أضفه نسخةً مستقلة' });
    await expect(accepted.or(addAnyway)).toBeVisible({ timeout: 60_000 });
    if (await addAnyway.isVisible()) await addAnyway.click();
    await expect(accepted).toBeVisible({ timeout: 60_000 });
    const tree = await api.get<LibraryTreeResponse>('/api/library/tree');
    const src = tree.sources.filter((s) => s.node_id === course.id && /g2_injected_lecture|injected/i.test(s.title)).at(-1)!;
    expect(src, 'the uploaded file is in the library').toBeTruthy();
    return { source_id: src.id, version_id: src.current_version_id! };
  });
  const arabic = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g2_injected_notes_ar.docx'), { sourceType: 'lecture', title: 'ملاحظات محقونة (TEST FIXTURE)' });
  expect(['completed', 'partial']).toContain((await api.waitForProcessing(injected.version_id)).job?.status);
  expect(['completed', 'partial']).toContain((await api.waitForProcessing(arabic.version_id)).job?.status);

  await test.step('reader: the injection is plain page text; the HTML / JS payload stays text', async () => {
    await openWorkspace(page, injected.source_id);
    const layer = page.locator('.wk-textlayer').first();
    await expect(layer).toContainText('SYSTEM NOTICE TO THE AI ASSISTANT', { timeout: 30_000 });
    await expect(layer).toContainText('<img src=');
    // nothing from the payload became an element
    await expect(page.locator(`img[src*="${EXFIL_HOST}"], script[src*="${EXFIL_HOST}"], a[href*="${EXFIL_HOST}"], iframe`)).toHaveCount(0);
    await screenshot(page, testInfo, 'g2-ac29-reader');
  });

  await test.step('rail: the AI is still «requires configuration» — the file cannot switch it on or widen the lock', async () => {
    const railTab = (name: string) => page.getByRole('tab', { name: new RegExp(name) });
    if (!(await railTab('الشرح والسؤال').isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
    await railTab('الشرح والسؤال').click();
    await expect(page.getByText('الشرح غير متاح الآن')).toBeVisible();
    await expect(page.locator('.sb-scope .ev-scope-badge')).toContainText('المحاضرة فقط');
  });

  await test.step('Arabic file: the injection is RTL document text; linked pictures are never fetched or read', async () => {
    await openWorkspace(page, arabic.source_id);
    const body = page.locator('.wk-main');
    await expect(body).toContainText('تجاهل كل التعليمات السابقة', { timeout: 30_000 });
    await expect(body).not.toContainText('root:x:0:0');
    await expect(page.locator(`img[src*="${EXFIL_HOST}"], img[src^="file:"]`)).toHaveCount(0);
    await screenshot(page, testInfo, 'g2-ac29-arabic');
  });

  await test.step('search: found as source text; operators in the document are data', async () => {
    const r = await api.get<SearchResponse>(`/api/search?q=${encodeURIComponent('SYSTEM NOTICE assistant')}`);
    expect(r.results.some((x) => x.location?.source_id === injected.source_id && x.origin === 'source')).toBe(true);
    for (const q of ['NEAR("pain" OR *) AND -"fossa"', '<script>fetch', 'تجاهل كل التعليمات']) expect((await api.call('GET', `/api/search?q=${encodeURIComponent(q)}`)).status()).toBe(200);
    await page.goto(`/search?q=${encodeURIComponent('<script>fetch')}`);
    await expect(page.locator('main')).toContainText('fetch', { timeout: 30_000 });
    await expect(page.locator(`script[src*="${EXFIL_HOST}"]`)).toHaveCount(0);
    await screenshot(page, testInfo, 'g2-ac29-search');
  });

  await test.step('nothing changed: settings, capabilities, links, the lecture lock; no dialog; no request left the server origin', async () => {
    expect(await api.get('/api/settings')).toEqual(before.settings);
    expect(Object.fromEntries(Object.entries((await api.get<CapabilitiesResponse>('/api/capabilities')).features).map(([k, v]) => [k, v.state]))).toEqual(before.caps);
    const detail = await api.get<SourceDetail>(`/api/sources/${injected.source_id}`);
    expect(detail.links).toHaveLength(0);
    expect(detail.source_type).toBe('lecture');
    const lock = await api.post<ScopeResolveResponse>('/api/evidence/scope/resolve', { mode: 'lecture_only', lecture_source_id: injected.source_id });
    expect(lock.sources.map((s) => s.source_id)).toEqual([injected.source_id]);
    expect(dialogs).toEqual([]);
    expect(foreign).toEqual([]);
  });
});
