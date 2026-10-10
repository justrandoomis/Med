// G7 — AC-24 «مزامنة وتعارض» against the REAL server and the built web app, with real browsers as devices:
//  * two devices (two browser contexts = two IndexedDBs, two sessions) edit the same note while offline: when they come
//    back, BOTH texts exist on the server and on both devices, the later one marked as a kept conflict copy; nothing is
//    deleted — and a delete made on one device while the other edited keeps the edited text;
//  * a review whose push reached the server but whose answer was lost (connection reset after the server applied it) is
//    re-sent by the device and counted ONCE;
//  * an exam finished on a device whose finish request lost its answer is re-sent: every item is graded once, the
//    result counts each answer once.
// The «lost answer» is real network behaviour: the request is forwarded to the server, then the connection is reset
// before the browser sees the response (Playwright route.fetch → route.abort).
import type { Browser, BrowserContext, Page, Route } from '@playwright/test';
import type { ExamCreateResponse, ExamResultDetail, NoteDTO, SyncOp } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, serverFor, setupOwner, test } from './support';

test.use({ allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_RESET|Failed to load resource|Failed to fetch|NetworkError|net::ERR/i] });

const rt = (text: string) => ({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: text }] }] });
const uid = () => crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0, 26);
const plain = (n: Pick<NoteDTO, 'body'>) => n.body.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');

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

async function secondDevice(browser: Browser, project: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    baseURL: serverFor(project).baseURL,
    locale: 'ar-IQ',
    timezoneId: 'Asia/Baghdad',
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  await setupOwner(page);
  return { ctx, page };
}

async function openNotes(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: /ملاحظاتي/ });
  if (!(await tab.isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
  await tab.click();
}

async function editNote(page: Page, from: string, to: string): Promise<void> {
  const card = page.locator('.wk-note').filter({ hasText: from });
  await card.getByRole('button', { name: 'تعديل الملاحظة' }).click();
  const box = page.getByRole('textbox', { name: 'تعديل الملاحظة' });
  await box.fill(to);
  await page.getByRole('button', { name: 'تم' }).click();
  await expect(page.locator('.wk-note').filter({ hasText: to })).toBeVisible();
}

/** Forward the first push whose ops match to the server, then reset the connection before the browser sees the answer. */
async function loseFirstAnswer(page: Page, match: (ops: SyncOp[]) => boolean): Promise<{ lost: () => number; sent: () => number }> {
  let lost = 0;
  let sent = 0;
  await page.route('**/api/sync/push', async (route: Route) => {
    const body = route.request().postDataJSON() as { ops: SyncOp[] };
    if (match(body.ops)) sent++;
    if (lost === 0 && match(body.ops)) {
      const res = await route.fetch(); // the server receives and applies the ops
      expect(res.status()).toBe(200);
      lost++;
      await route.abort('connectionreset'); // …and the device never hears back
      return;
    }
    await route.continue();
  });
  return { lost: () => lost, sent: () => sent };
}

test('AC-24: the same note edited offline on two devices → both texts kept on both devices; a concurrent delete loses nothing', async ({ page, api, context, browser }, testInfo) => {
  test.setTimeout(6 * 60_000);
  await setupOwner(page);
  const stamp = `${Date.now().toString(36)}-${testInfo.project.name}`;
  const { course } = await api.createNotebookAndCourse();
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `G7 two devices ${stamp}` });
  await api.waitForProcessing(lecture.version_id);
  const notes = async () => (await api.get<{ notes: NoteDTO[] }>(`/api/annotations/notes?source_id=${lecture.source_id}`)).notes;

  const original = `ملاحظة أولى ${stamp}`;
  const textA = `نسخة الجهاز A: ألم ينتقل إلى RLQ خلال 24 ساعة ${stamp}`;
  const textB = `نسخة الجهاز B: WBC > 11 ×10⁹/L ${stamp}`;

  // device A writes a note through the reader
  await openWorkspace(page, lecture.source_id);
  await openNotes(page);
  await page.getByRole('button', { name: 'ملاحظة على هذه الصفحة' }).click();
  await page.getByRole('textbox', { name: /ملاحظة جديدة/ }).fill(original);
  await page.getByRole('button', { name: 'تم' }).click();
  await expect.poll(async () => (await notes()).map(plain), { timeout: 60_000 }).toEqual([original]);

  // device B (another browser profile, its own session) opens the lecture and sees it
  const B = await secondDevice(browser, testInfo.project.name);
  try {
    await openWorkspace(B.page, lecture.source_id);
    await openNotes(B.page);
    await expect(B.page.locator('.wk-note').filter({ hasText: original })).toBeVisible({ timeout: 60_000 });

    await test.step('both devices go offline and edit the same note', async () => {
      await context.setOffline(true);
      await B.ctx.setOffline(true);
      await editNote(page, original, textA);
      await editNote(B.page, original, textB);
      expect((await notes()).map(plain)).toEqual([original]); // nothing reached the server yet
    });

    await test.step('A reconnects first, then B: both texts are kept (B’s as a separate note), none deleted', async () => {
      await context.setOffline(false);
      await expect.poll(async () => (await notes()).map(plain), { timeout: 90_000 }).toEqual([textA]);
      await B.ctx.setOffline(false);
      await expect.poll(async () => (await notes()).map(plain).sort(), { timeout: 90_000 }).toEqual([textA, textB].sort());
      const all = await notes();
      const orig = all.find((n) => plain(n) === textA)!;
      const copy = all.find((n) => plain(n) === textB)!;
      expect(copy.conflict_of_id).toBe(orig.id);
      expect(all.every((n) => n.deleted_at === null)).toBe(true);
    });

    await test.step('both devices end up showing both texts; the kept copy is labelled', async () => {
      for (const p of [page, B.page]) {
        await expect
          .poll(
            async () => {
              const texts = await p.locator('.wk-note').allInnerTexts();
              return [textA, textB].every((t) => texts.some((x) => x.includes(t)));
            },
            { timeout: 90_000 },
          )
          .toBe(true);
        await expect(p.locator('.wk-note').filter({ hasText: textB }).getByText('نسخة محفوظة من تعارض')).toBeVisible();
      }
      // both devices were on the same page all along: that is not a reading-position conflict to ask about (fixed in G7)
      for (const p of [page, B.page]) await expect(p.getByText('موضع أحدث من جهاز آخر')).toHaveCount(0);
      await screenshot(B.page, testInfo, 'g7-ac24-both-kept');
    });

    await test.step('B deletes the kept copy while A (offline) edits it: the edit survives — the text is never lost', async () => {
      await context.setOffline(true);
      const later = `تعديل لاحق على النسخة من A ${stamp}`;
      await editNote(page, textB, later);
      const card = B.page.locator('.wk-note').filter({ hasText: textB });
      await card.getByRole('button', { name: 'حذف الملاحظة' }).click();
      await B.page.getByRole('alertdialog').or(B.page.getByRole('dialog')).getByRole('button', { name: 'حذف الملاحظة' }).click();
      await expect.poll(async () => (await notes()).map(plain), { timeout: 60_000 }).toEqual([textA]);
      await context.setOffline(false);
      await expect.poll(async () => (await notes()).map(plain).sort(), { timeout: 90_000 }).toEqual([textA, later].sort());
    });
  } finally {
    await B.ctx.close();
  }
});

test('AC-24: a review whose answer was lost is re-sent and counted once; an exam finish re-sent grades each item once', async ({ page, api }, testInfo) => {
  test.setTimeout(6 * 60_000);
  await setupOwner(page);
  const stamp = `${Date.now().toString(36)}-${testInfo.project.name}`;
  const { course } = await api.createNotebookAndCourse();
  const qs = await api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create', title: `G7 resend questions ${stamp}` });
  await api.waitForProcessing(qs.version_id, { questions: true });

  await test.step('review: the push reaches the server, the connection resets before the answer; the device re-sends; ONE event', async () => {
    const cardId = uid();
    await api.post('/api/sync/push', { ops: [{ op_id: uid(), device_id: 'G7_OTHER_DEVICE', client_ts: Date.now(), entity_type: 'flashcard', entity_id: cardId, op: 'upsert', payload: { kind: 'basic', front: rt(`سؤال بطاقة ${stamp}`), back: rt('Pregnancy test (β-hCG)') } }] });
    // the card reaches this device through sync first (the hub can start a session)
    await page.goto('/review');
    await expect(page.getByRole('link', { name: 'ابدأ المراجعة' })).toBeVisible({ timeout: 60_000 });
    const net = await loseFirstAnswer(page, (ops) => ops.some((o) => o.entity_type === 'review_event'));
    await page.goto(`/review/session?cards=${cardId}`);
    await page.getByRole('button', { name: 'اعرض الإجابة' }).click();
    await page.getByRole('group', { name: 'قيّم تذكّرك' }).getByRole('button', { name: /^جيد/ }).click();
    await expect.poll(() => net.lost(), { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await idbRows<{ entity_type: string; status: string }>(page, 'outbox')).filter((o) => o.entity_type === 'review_event' && o.status === 'synced').length, { timeout: 90_000 }).toBe(1);
    expect(net.sent()).toBeGreaterThanOrEqual(2); // it really went over the wire twice
    const d = await api.get<{ events: Array<{ id: string }>; card: { review_state: { reps: number } } }>(`/api/learning/cards/${cardId}`);
    expect(d.events).toHaveLength(1);
    expect(d.card.review_state.reps).toBe(1);
    // the device shows no error for it
    expect((await idbRows<{ status: string; lastError: string | null }>(page, 'outbox')).filter((o) => o.status === 'rejected' || o.status === 'conflict')).toEqual([]);
    await page.unroute('**/api/sync/push');
  });

  await test.step('exam: finishing re-sent after a lost answer → each item graded once, the result counts each answer once', async () => {
    const { session } = await api.post<ExamCreateResponse>('/api/exams', { title: '', mode: 'exam', count: 3, source_ids: [qs.source_id], seed: `g7-ac24-${stamp}` });
    const n = session.items.length;
    expect(n).toBe(3);
    const net = await loseFirstAnswer(page, (ops) => ops.some((o) => o.entity_type === 'exam_attempt' && (o.payload as { status?: string }).status === 'completed'));
    await page.goto(`/exams/${session.attempt.id}`);
    for (let i = 0; i < n; i++) {
      await expect(page.locator('.ex-stem')).toBeVisible();
      await page.locator('.ex-opt').first().click();
      if (i < n - 1) await page.getByRole('button', { name: 'التالي' }).click();
    }
    await page.getByRole('button', { name: 'إنهاء الاختبار' }).click();
    await page.getByRole('button', { name: 'إنهاء وعرض النتيجة' }).click();
    await expect.poll(() => net.lost(), { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await api.call('GET', `/api/exams/attempts/${session.attempt.id}/result`)).status(), { timeout: 90_000 }).toBe(200);
    await expect.poll(async () => (await idbRows<{ entity_type: string; status: string }>(page, 'outbox')).filter((o) => o.entity_type === 'exam_attempt' && o.status === 'pending').length, { timeout: 90_000 }).toBe(0);
    expect(net.sent()).toBeGreaterThanOrEqual(2);
    const result = await api.get<ExamResultDetail>(`/api/exams/attempts/${session.attempt.id}/result`);
    expect(result.answered).toBe(n);
    expect(result.items).toHaveLength(n);
    expect(result.missing_on_server).toBe(0);
    const list = await api.get<{ items: Array<{ attempt_id: string }> }>('/api/exams/attempts?limit=50');
    expect(list.items.filter((a) => a.attempt_id === session.attempt.id)).toHaveLength(1);
    await expect(page).toHaveURL(/\/results$/);
    await screenshot(page, testInfo, 'g7-ac24-exam-result');
    await page.unroute('**/api/sync/push');
  });
});
