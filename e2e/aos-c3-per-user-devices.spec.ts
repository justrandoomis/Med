// Track C3 — one account on two devices, per user (two browser contexts = two devices of the same student), against the
// REAL server and the built web app, phone 390 × 844 and desktop 1280 × 800:
//   * AOS-14.11 — AC-24 for spaced repetition per user vault: the same card reviewed OFFLINE on both devices → both
//     reviews kept (two events, folded by time), nothing in conflict; a review whose answer was lost is re-sent and
//     counted once; another student never sees the card.
//   * AOS-19J.1 — the universal study session per user: a lecture opened on one device continues on the other at the
//     same page; a newer position saved by the other device is never overwritten silently («موضع أحدث من جهاز آخر لك»
//     asks); another student's session of the same official lecture is his own.
import type { Browser, BrowserContext, Page, Route } from '@playwright/test';
import type { LatestSessionResponse, SyncOp } from '@medlevo/shared';
import { expect, screenshot, serverFor, setupOwner, test } from './support';
import { buildAosWorld, eventually, fixturePages, MEMBER_PASSWORD, op, push, startCopy, ulid, type AosWorld, type Member } from './support/aos-world';

test.use({ allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_RESET|Failed to load resource|Failed to fetch|NetworkError|net::ERR/i] });

const rt = (text: string) => ({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: text }] }] });

/** The second device: another browser profile, the SAME student signed in through the login screen. */
async function secondDevice(browser: Browser, project: string, username: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: serverFor(project).baseURL, locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await setupOwner(page, { username, password: MEMBER_PASSWORD });
  return { ctx, page };
}

function outboxRows(page: Page, userId: string): Promise<Array<{ entity_type: string; status: string }>> {
  return page.evaluate(
    (name) =>
      new Promise<Array<{ entity_type: string; status: string }>>((resolve) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('outbox')) {
            db.close();
            return resolve([]);
          }
          const q = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
          q.onsuccess = () => {
            resolve(q.result as Array<{ entity_type: string; status: string }>);
            db.close();
          };
          q.onerror = () => resolve([]);
        };
        open.onerror = () => resolve([]);
      }),
    `medlevo:${userId}`,
  );
}

/** Forward the first matching push to the server, then reset the connection before the device hears the answer. */
async function loseFirstAnswer(page: Page, match: (ops: SyncOp[]) => boolean): Promise<{ lost: () => number; sent: () => number }> {
  let lost = 0;
  let sent = 0;
  await page.route('**/api/sync/push', async (route: Route) => {
    const body = route.request().postDataJSON() as { ops: SyncOp[] };
    if (match(body.ops)) sent++;
    if (lost === 0 && match(body.ops)) {
      const res = await route.fetch();
      expect(res.status()).toBe(200);
      lost++;
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  return { lost: () => lost, sent: () => sent };
}

async function world(page: Page, playwright: Parameters<typeof buildAosWorld>[0]['playwright'], baseURL: string, project: string, seed: number): Promise<AosWorld> {
  return buildAosWorld({
    playwright,
    baseURL,
    project,
    page: { key: 'mona', page },
    people: { mona: { name: 'منى' }, sami: { name: 'سامي' }, mod: { name: 'المشرف', role: 'subject_moderator' } },
    lecture: { title: `Lecture 6 — two devices fixture ${seed}`, pages: fixturePages('Lecture 6', 4, seed), fileName: 'lecture6.pdf' },
  });
}

test('AOS-14.11 — AC-24 per user: the same card reviewed offline on two devices of one student; a lost answer re-sent once; nobody else sees it', async ({ page, browser, playwright, baseURL }, testInfo) => {
  test.setTimeout(420_000);
  const w = await world(page, playwright, baseURL!, testInfo.project.name, 71_000);
  const mona = w.people.mona as Member;
  const sami = w.people.sami as Member;
  const B = await secondDevice(browser, testInfo.project.name, `mona_${w.stamp}`);
  try {
    const cardId = ulid();
    await push(mona, [{ ...op('flashcard', cardId, { kind: 'basic', front: rt(`سؤال بطاقة منى ${w.stamp}`), back: rt('Pregnancy test (β-hCG)') }), device_id: 'C3_SETUP' }]);
    type CardDetail = { events: Array<{ id: string; rating?: string }>; card: { review_state: { reps: number } } };
    const detail = () => mona.api.get<CardDetail>(`/api/learning/cards/${cardId}`);

    await test.step('both devices have the card (per user database medlevo:<id>), then both go offline', async () => {
      for (const p of [page, B.page]) {
        await p.goto('/review');
        await expect(p.getByRole('link', { name: 'ابدأ المراجعة' })).toBeVisible({ timeout: 60_000 });
        await p.goto(`/review/session?cards=${cardId}`);
        await expect(p.getByRole('button', { name: 'اعرض الإجابة' })).toBeVisible({ timeout: 30_000 });
      }
      await page.context().setOffline(true);
      await B.ctx.setOffline(true);
    });

    await test.step('device A rates «جيد», device B rates «صعب» — both offline', async () => {
      for (const [p, rating] of [[page, /^جيد/], [B.page, /^صعب/]] as const) {
        await p.getByRole('button', { name: 'اعرض الإجابة' }).click();
        await p.getByRole('group', { name: 'قيّم تذكّرك' }).getByRole('button', { name: rating }).click();
        await expect.poll(async () => (await outboxRows(p, mona.userId)).filter((o) => o.entity_type === 'review_event' && o.status === 'pending').length).toBe(1);
      }
      expect((await detail()).events).toHaveLength(0); // nothing reached the server yet
    });

    await test.step('A reconnects, then B: both reviews are kept (two events), nothing in conflict on either device', async () => {
      await page.context().setOffline(false);
      await expect.poll(async () => (await detail()).events.length, { timeout: 90_000 }).toBe(1);
      await B.ctx.setOffline(false);
      await expect.poll(async () => (await detail()).events.length, { timeout: 90_000 }).toBe(2);
      expect((await detail()).card.review_state.reps).toBe(2);
      for (const p of [page, B.page]) {
        await expect.poll(async () => (await outboxRows(p, mona.userId)).filter((o) => o.entity_type === 'review_event' && o.status === 'pending').length, { timeout: 60_000 }).toBe(0);
        expect((await outboxRows(p, mona.userId)).filter((o) => o.status === 'conflict' || o.status === 'rejected')).toEqual([]);
      }
    });

    await test.step('a review whose answer was lost is re-sent by the device and counted once', async () => {
      const net = await loseFirstAnswer(page, (ops) => ops.some((o) => o.entity_type === 'review_event'));
      await page.goto(`/review/session?cards=${cardId}`);
      // reviewed a minute ago: not due yet — «راجعها الآن قبل موعدها» (an early review, counted in the log)
      await page.getByRole('button', { name: 'راجعها الآن قبل موعدها' }).click();
      await page.getByRole('button', { name: 'اعرض الإجابة' }).click();
      await page.getByRole('group', { name: 'قيّم تذكّرك' }).getByRole('button', { name: /^جيد/ }).click();
      await expect.poll(() => net.lost(), { timeout: 60_000 }).toBe(1);
      await expect.poll(async () => (await outboxRows(page, mona.userId)).filter((o) => o.entity_type === 'review_event' && o.status === 'pending').length, { timeout: 90_000 }).toBe(0);
      expect(net.sent()).toBeGreaterThanOrEqual(2);
      expect((await detail()).events).toHaveLength(3);
      await page.unroute('**/api/sync/push');
      await screenshot(page, testInfo, 'c3-ac24-per-user-review');
    });

    await test.step('per user: another student of the same subject never sees the card', async () => {
      expect([403, 404]).toContain((await sami.api.call('GET', `/api/learning/cards/${cardId}`)).status());
      const due = await sami.api.call('GET', '/api/learning/cards?limit=200');
      if (due.ok()) expect(await due.text()).not.toContain(cardId);
      const dbs = await page.evaluate(async () => ((await indexedDB.databases?.()) ?? []).map((d) => d.name));
      expect(dbs).toContain(`medlevo:${mona.userId}`);
    });
  } finally {
    await B.ctx.close();
    await w.dispose();
  }
});

test('AOS-19J.1 — the study session per user: continue on the other device; a newer position is never overwritten silently', async ({ page, browser, playwright, baseURL }, testInfo) => {
  test.setTimeout(420_000);
  const w = await world(page, playwright, baseURL!, testInfo.project.name, 72_000);
  const mona = w.people.mona as Member;
  const sami = w.people.sami as Member;
  const B = await secondDevice(browser, testInfo.project.name, `mona_${w.stamp}`);
  try {
    const copy = await startCopy(w, mona, { mode: 'personal' });
    const src = copy.source_id;
    const latest = async (m: Member) => (await m.api.get<LatestSessionResponse>(`/api/annotations/sessions/latest?source_id=${src}`)).session;

    let deviceA = '';
    await test.step('device A reads page 3, then loses the connection', async () => {
      await page.goto(`/study/${src}?page=2`);
      await expect(page.locator('.wk-canvas-slot canvas, .wk-page-image, .wk-textsheet').first()).toBeVisible({ timeout: 60_000 });
      const s = await eventually(() => latest(mona), (x) => x?.location?.page_index === 2, 'A’s position reaches the server');
      deviceA = s!.device_id ?? '';
      await page.context().setOffline(true);
    });

    await test.step('device B opens the lecture with no page asked: it continues at page 3 (A’s place)', async () => {
      await B.page.goto(`/study/${src}`);
      await expect(B.page.locator('.wk-canvas-slot canvas, .wk-page-image, .wk-textsheet').first()).toBeVisible({ timeout: 60_000 });
      await expect(B.page.locator('.wk-pageind').first()).toHaveAttribute('aria-label', /3 من 4/, { timeout: 30_000 });
      await expect(B.page.getByRole('dialog', { name: /موضع أحدث/ })).toHaveCount(0);
    });

    await test.step('B moves to page 1: the newer position (B’s) is on the server', async () => {
      await B.page.locator('.wk-pageind').first().click();
      await B.page.getByLabel('انتقل إلى صفحة').fill('#1');
      await B.page.getByLabel('انتقل إلى صفحة').press('Enter');
      await eventually(() => latest(mona), (x) => x?.location?.page_index === 0 && x.device_id !== deviceA, 'B’s newer position reaches the server');
    });

    await test.step('A, offline on its older base, moves to page 2 and reconnects: never written over B’s silently — A is asked', async () => {
      await page.locator('.wk-pageind').first().click();
      await page.getByLabel('انتقل إلى صفحة').fill('#2');
      await page.getByLabel('انتقل إلى صفحة').press('Enter');
      await expect(page.locator('.wk-pageind').first()).toHaveAttribute('aria-label', /2 من 4/);
      await page.waitForTimeout(2500); // the autosave (1.2 s) queues A's place in its outbox
      await page.context().setOffline(false);
      const dialog = page.getByRole('dialog', { name: 'موضع أحدث من جهاز آخر لك' });
      await expect(dialog).toBeVisible({ timeout: 90_000 });
      await expect(dialog).toContainText('على جهاز آخر لك وصلت إلى');
      await expect(dialog).toContainText('لم يُكتب أي موضع فوق الآخر');
      expect((await latest(mona))!.location.page_index, 'the server keeps B’s position while A has not chosen').toBe(0);
      // (the rail's «مناطق هذه الصفحة» says honestly that it could not load while A was offline — not checked here)
      await screenshot(page, testInfo, 'c3-session-newer-elsewhere', { healthy: false });
      // A chooses to stay: only now is A's place the newest one
      await dialog.getByRole('button', { name: 'البقاء هنا' }).click();
      await eventually(() => latest(mona), (x) => x?.location?.page_index === 1, 'A’s chosen position is saved after the choice', 90_000);
    });

    await test.step('per user: another student’s session of the same official lecture is his own', async () => {
      const other = await startCopy(w, sami, { mode: 'personal' });
      const s = await sami.api.get<LatestSessionResponse>(`/api/annotations/sessions/latest?source_id=${other.source_id}`);
      expect(s.session, 'Sami has no session of Mona’s').toBeNull();
    });
  } finally {
    await B.ctx.close();
    await w.dispose();
  }
});
