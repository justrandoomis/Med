// G7 — AC-23 «Offline»: the downloaded lecture, the cards and the exam that was opened open WITHOUT a connection; a new
// AI request or a search beyond this device says it needs a connection, with no fake progress.
// REAL server + built web app WITH its service worker (the app shell must load from the device on a cold start), a
// Golden Set lecture and question source processed by the real pipeline; the browser is put offline with
// `context.setOffline(true)` (network emulation: every request from the page fails). No AI key exists here, so AI
// features are «requires_configuration» online — offline the owner must be told the request needs a connection.
// After going back online, what was done offline (a rating, an exam answer) reaches the server exactly once.
import type { ExamCreateResponse, LibraryNodeView, SourcePagesResponse, SyncOp } from '@medlevo/shared';
import type { Page } from '@playwright/test';
import { expect, screenshot, setupOwner, test, waitForWorkspace } from './support';

// offline, the browser reports the failing background requests (sync, capabilities) as console errors — expected here
test.use({ serviceWorkers: 'allow', allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch|NetworkError|net::ERR/i] });

const rt = (text: string, dir: 'rtl' | 'ltr' = 'rtl') => ({ v: 1, paragraphs: [{ dir, runs: [{ t: text }] }] });
const uid = () => crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0, 26);

function idbRows<T = Record<string, unknown>>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(
    (name) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open('medlevo');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction(name, 'readonly').objectStore(name).getAll();
          req.onsuccess = () => {
            resolve(req.result as T[]);
            db.close();
          };
          req.onerror = () => reject(req.error);
        };
      }),
    store,
  );
}

test('AC-23: lecture, cards and an opened exam work offline; AI and server search say they need a connection; nothing fake', async ({ page, api, context }, testInfo) => {
  test.setTimeout(8 * 60_000);
  await setupOwner(page);
  const stamp = `${Date.now().toString(36)}-${testInfo.project.name}`;
  const { course } = await api.createNotebookAndCourse();
  const lectureTitle = `G7 offline lecture ${stamp}`;
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: lectureTitle });
  const qs = await api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create', title: `G7 offline questions ${stamp}` });
  await api.waitForProcessing(lecture.version_id);
  await api.waitForProcessing(qs.version_id, { questions: true });
  const pages = (await api.get<SourcePagesResponse>(`/api/sources/${lecture.source_id}/versions/${lecture.version_id}/pages`)).pages;

  // writing made on another device: a note on the lecture and two cards (they reach this device through sync)
  const noteText = `ملاحظة للقراءة دون اتصال: علامة McBurney عند 1/3 المسافة ${stamp}`;
  const cardIds = [uid(), uid()];
  const other = (o: Omit<SyncOp, 'op_id' | 'device_id' | 'client_ts'>): SyncOp => ({ op_id: uid(), device_id: 'G7_OTHER_DEVICE', client_ts: Date.now(), ...o });
  const pushed = await api.post<{ results: Array<{ result: string }> }>('/api/sync/push', {
    ops: [
      other({ entity_type: 'note', entity_id: uid(), op: 'upsert', payload: { title: null, body: rt(noteText), anchor: { type: 'page', source_id: lecture.source_id, version_id: lecture.version_id, page_id: pages[0]!.id, page_index: 0, space: 'page_norm' }, origin: 'owner' } }),
      other({ entity_type: 'flashcard', entity_id: cardIds[0]!, op: 'upsert', payload: { kind: 'basic', front: rt(`ما الفحص الأول عند امرأة في سن الإنجاب؟ ${stamp}`), back: rt('Pregnancy test (β-hCG)', 'ltr'), source_id: lecture.source_id } }),
      other({ entity_type: 'flashcard', entity_id: cardIds[1]!, op: 'upsert', payload: { kind: 'basic', front: rt(`أين تقع نقطة McBurney؟ ${stamp}`), back: rt('عند ثلث المسافة من SIAS إلى السرة'), source_id: lecture.source_id } }),
    ],
  });
  expect(pushed.results.map((r) => r.result)).toEqual(['applied', 'applied', 'applied']);
  const { session } = await api.post<ExamCreateResponse>('/api/exams', { title: '', mode: 'exam', count: 3, source_ids: [qs.source_id], seed: `g7-ac23-${stamp}` });
  expect(session.items.length).toBe(3);

  await test.step('online: the review hub syncs the cards; the exam is opened once; the lecture is downloaded through the UI', async () => {
    await page.goto('/review');
    await expect(page.getByRole('link', { name: 'ابدأ المراجعة' })).toBeVisible({ timeout: 60_000 });
    await page.goto(`/exams/${session.attempt.id}`);
    await expect(page.locator('.ex-stem')).toBeVisible();
    await page.goto(`/sources/${lecture.source_id}`);
    await page.getByRole('button', { name: 'نزّل للعمل دون اتصال' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('ما سيُحفظ على هذا الجهاز')).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByText('ما لا يعمل دون اتصال')).toBeVisible();
    await dialog.getByRole('button', { name: /^نزّل/ }).click();
    await expect(dialog.getByText('صار المصدر متاحًا دون اتصال على هذا الجهاز.')).toBeVisible({ timeout: 120_000 });
    await screenshot(page, testInfo, 'g7-ac23-downloaded');
    await page.keyboard.press('Escape');
    // the app shell is cached by the service worker; it controls the page after one reload
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
    await expect(page.getByText(/على هذا الجهاز \(الإصدار 1\)/)).toBeVisible();
  });

  await context.setOffline(true);

  await test.step('offline, cold start: the app opens and the downloaded lecture renders with the owner’s note', async () => {
    await page.goto(`/study/${lecture.source_id}`);
    await waitForWorkspace(page);
    await expect(page.locator('.wk-canvas-slot canvas').first()).toBeVisible();
    await expect(page.locator('.wk-textlayer span').first()).toBeAttached({ timeout: 30_000 });
    await expect(page.locator('.wk-folio__primary').first()).toHaveText(/ص 11/);
    const railTab = (name: string) => page.getByRole('tab', { name: new RegExp(name) });
    if (!(await railTab('ملاحظاتي').isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
    await railTab('ملاحظاتي').click();
    await expect(page.getByText(noteText).first()).toBeVisible({ timeout: 20_000 });
    await screenshot(page, testInfo, 'g7-ac23-offline-lecture');

    // a NEW AI request: says it needs a connection; no spinner, no progress bar, the action cannot be started
    await railTab('الشرح والسؤال').click();
    const card = page.locator('.wk-disabled-card').filter({ hasText: 'الشرح غير متاح الآن' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('اتصال');
    await expect(page.getByRole('button', { name: 'اشرح', exact: true })).toBeDisabled();
    await expect(page.locator('[role="progressbar"], .sb-running, [aria-busy="true"]')).toHaveCount(0);
    await screenshot(page, testInfo, 'g7-ac23-offline-ai');
  });

  await test.step('offline: a search says it covers only this device; the server search is not pretended', async () => {
    await page.goto('/search');
    await page.getByRole('searchbox').first().fill('McBurney');
    await page.keyboard.press('Enter');
    await expect(page.getByText('أنت غير متصل: يُبحث في ملاحظاتك المحفوظة على هذا الجهاز فقط').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[role="progressbar"]')).toHaveCount(0);
    await screenshot(page, testInfo, 'g7-ac23-offline-search');
  });

  let reviewedCard = '';
  await test.step('offline: the review session opens, rates a card, keeps the rating on the device', async () => {
    await page.goto('/review');
    await expect(page.getByRole('link', { name: 'ابدأ المراجعة' })).toBeVisible();
    // the session is focused on THIS spec's cards (`?cards=`, a supported session parameter): on a server shared with
    // other specs (the full `npm run e2e` run) their due cards — e.g. G1 AC-04's card — would otherwise come first
    await page.goto(`/review/session?cards=${cardIds.join(',')}&back=/review`);
    await page.getByRole('button', { name: 'اعرض الإجابة' }).click();
    await page.getByRole('group', { name: 'قيّم تذكّرك' }).getByRole('button', { name: /^جيد/ }).click();
    await expect(page.getByText(/حُفظ التقييم على هذا الجهاز/)).toBeVisible();
    const events = await idbRows<{ id: string; cardId: string }>(page, 'reviewEvents');
    expect(events.length).toBe(1);
    reviewedCard = events[0]!.cardId;
    expect(cardIds).toContain(reviewedCard);
    const ops = await idbRows<{ entity_type: string; status: string }>(page, 'outbox');
    expect(ops.filter((o) => o.entity_type === 'review_event' && o.status === 'pending')).toHaveLength(1);
    await screenshot(page, testInfo, 'g7-ac23-offline-review');
  });

  await test.step('offline: the exam opened earlier opens again (cold start) and records an answer on the device', async () => {
    await page.goto(`/exams/${session.attempt.id}`);
    await expect(page.locator('.ex-stem')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('دون اتصال').first()).toBeVisible();
    await page.locator('.ex-opt').first().click();
    await expect.poll(async () => (await idbRows<{ entity_type: string; status: string }>(page, 'outbox')).filter((o) => o.entity_type === 'exam_attempt' && o.status === 'pending').length).toBeGreaterThan(0);
    await screenshot(page, testInfo, 'g7-ac23-offline-exam');
  });

  await test.step('nothing reached the server while offline', async () => {
    const card = await api.get<{ events: unknown[] }>(`/api/learning/cards/${reviewedCard}`);
    expect(card.events).toEqual([]);
    const att = await api.get<{ attempt: { answers: Record<string, unknown> } }>(`/api/exams/attempts/${session.attempt.id}`);
    expect(Object.keys(att.attempt.answers)).toEqual([]);
  });

  await context.setOffline(false);

  await test.step('back online: the rating and the answer reach the server exactly once', async () => {
    await expect.poll(async () => (await api.get<{ events: unknown[] }>(`/api/learning/cards/${reviewedCard}`)).events.length, { timeout: 90_000 }).toBe(1);
    await expect.poll(async () => Object.keys((await api.get<{ attempt: { answers: Record<string, unknown> } }>(`/api/exams/attempts/${session.attempt.id}`)).attempt.answers).length, { timeout: 90_000 }).toBe(1);
    await expect.poll(async () => (await idbRows<{ status: string }>(page, 'outbox')).filter((o) => o.status === 'pending').length, { timeout: 60_000 }).toBe(0);
    // a later sync round does not send them again
    await page.waitForTimeout(3000);
    expect((await api.get<{ events: unknown[] }>(`/api/learning/cards/${reviewedCard}`)).events).toHaveLength(1);
    const tree = await api.get<{ nodes: LibraryNodeView[] }>('/api/library/tree');
    expect(tree.nodes.some((n) => n.id === course.id)).toBe(true);
  });
});
