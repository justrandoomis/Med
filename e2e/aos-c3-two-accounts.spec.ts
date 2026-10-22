// Track C3 — two accounts in ONE browser (AOS-1.38) and the sign-out clearing option (AOS-4.7, ADR-0003 Q26), against
// the REAL server and the built web app, phone 390 × 844 and desktop 1280 × 800.
//
//   * أمل (A) studies in this browser: a note that reached the server, a second note written while the server could not
//     be reached (it waits in A's outbox), an unsaved crash-recovery draft, an invitation in her inbox. She signs out
//     (default: her data stays on this device, in her own namespace).
//   * بدر (B) signs in on the SAME browser: nothing of A is visible to him — not in his IndexedDB, his outbox, his
//     drafts, the Cache Storage, his library, search or notifications — and A's waiting note is never pushed under his
//     session (the server never receives it while B is signed in). B signs out with «امسح بيانات هذا الجهاز عند الخروج»:
//     his database and keys are gone; A's stay.
//   * A signs in again: her waiting note and her draft reach the server under HER session. She marks this browser as a
//     shared device («أجهزتي › هذا جهاز مشترك») and signs out: her data on this device is cleared — always, after
//     everything reached the server.
import type { Page } from '@playwright/test';
import type { ChannelNodeView, NoteDTO, NotificationsResponse } from '@medlevo/shared';
import { expect, openWorkspace, screenshot, setupOwner, test } from './support';
import { axeInLooks } from './aos-p1-channels-helpers';
import { buildAosWorld, CLIENT_HEADERS, clientApi, eventually, fixturePages, MEMBER_PASSWORD, startCopy, type AosWorld, type Member } from './support/aos-world';

// the push is cut while A signs out (her note must stay waiting): the browser logs the refused requests
test.use({ allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED|ERR_FAILED|Failed to load resource|Failed to fetch|net::ERR/i] });

const plain = (n: Pick<NoteDTO, 'body'>) => n.body.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');

interface Idb {
  names: string[];
  notes: string[];
  outbox: Array<{ entity_type: string; status: string; text: string }>;
}

/** What one IndexedDB database of this browser holds (notes' text, outbox ops with their text). */
function readIdb(page: Page, name: string): Promise<Idb> {
  return page.evaluate(async (dbName) => {
    const names = ((await indexedDB.databases?.()) ?? []).map((d) => d.name ?? '').filter(Boolean);
    if (!names.includes(dbName)) return { names, notes: [], outbox: [] };
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(dbName);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = <T,>(store: string) =>
      new Promise<T[]>((res) => {
        if (!db.objectStoreNames.contains(store)) return res([]);
        const q = db.transaction(store, 'readonly').objectStore(store).getAll();
        q.onsuccess = () => res(q.result as T[]);
        q.onerror = () => res([]);
      });
    const text = (v: unknown) => JSON.stringify(v ?? null);
    const notes = (await all<{ body: unknown }>('notes')).map((n) => text(n.body));
    const outbox = (await all<{ entity_type: string; status: string; payload: unknown }>('outbox')).map((o) => ({ entity_type: o.entity_type, status: o.status, text: text(o.payload) }));
    db.close();
    return { names, notes, outbox };
  }, name);
}

async function signOutHere(page: Page, opts: { clear?: boolean } = {}): Promise<void> {
  await page.goto('/settings');
  const box = page.getByRole('checkbox', { name: /امسح بيانات هذا الجهاز عند الخروج/ });
  await expect(box).toBeVisible();
  if (opts.clear !== undefined && (await box.isChecked()) !== opts.clear && (await box.isEnabled())) await box.click();
  await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
}

async function openNotes(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: /ملاحظاتي/ });
  if (!(await tab.isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
  await tab.click();
}

test('two accounts in one browser: nothing of one is visible to the other; sign-out keeps or clears this device’s data', async ({ page, playwright, baseURL }, testInfo) => {
  test.setTimeout(420_000);
  const w: AosWorld = await buildAosWorld({
    playwright,
    baseURL: baseURL!,
    project: testInfo.project.name,
    page: { key: 'amal', page },
    people: { amal: { name: 'أمل' }, badr: { name: 'بدر' }, mod: { name: 'المشرفة', role: 'subject_moderator' } },
    lecture: { title: 'Lecture 3 — two accounts fixture', pages: fixturePages('Lecture 3', 3, 61_000), fileName: 'lecture3.pdf' },
  });
  const amalInPage = w.people.amal as Member;
  const badr = w.people.badr as Member;
  // a word found nowhere else (the fixture PDF carries the run stamp, so the stamp alone is not A's)
  const unique = `amalsecret${w.stamp}`;
  // each note ends with its own Latin token: a stored body splits Arabic and Latin into separate runs, so the local
  // stores are searched by the token
  const tok = { sent: `${unique}sent`, waiting: `${unique}waiting`, draft: `${unique}draft` };
  const sentText = `ملاحظة أمل المرسلة ${tok.sent}`;
  const waitingText = `ملاحظة أمل المنتظرة ${tok.waiting}`;
  const draftText = `مسودة أمل غير المحفوظة ${tok.draft}`;
  let sourceId = '';
  // A's own API session, apart from the page (the page's cookie jar changes hands below)
  const aReq = await playwright.request.newContext({ baseURL });
  const login = await aReq.post('/api/auth/login', { headers: { ...CLIENT_HEADERS }, data: { username: `amal_${w.stamp}`, password: MEMBER_PASSWORD } });
  expect(login.status(), await login.text()).toBe(200);
  const amal: Member = { ...amalInPage, api: clientApi(aReq) };
  try {
    await test.step('A studies: a note that reaches the server, an invitation in her inbox', async () => {
      const copy = await startCopy(w, amalInPage, { mode: 'personal' });
      sourceId = copy.source_id;
      // an invitation to another subject (by the platform admin): a notification that is A's alone
      const other = await w.owner.post<ChannelNodeView>('/api/channels/nodes', { parent_id: w.subject.parent_id, kind: 'subject', title: `الكيمياء الحيوية ${unique}`, create_space: true, join_policy: 'open_with_code' });
      await w.owner.post(`/api/channels/nodes/${other.id}/invitations`, { user_ids: [amal.userId] });
      await eventually(() => amal.api.get<NotificationsResponse>('/api/notifications'), (r) => r.items.some((n) => n.kind === 'invitation'), 'A is told of the invitation');

      await openWorkspace(page, sourceId);
      await openNotes(page);
      await page.getByRole('button', { name: 'ملاحظة على هذه الصفحة' }).click();
      await page.getByRole('textbox', { name: /ملاحظة جديدة/ }).fill(sentText);
      await page.getByRole('button', { name: 'تم', exact: true }).click();
      await expect.poll(async () => (await amal.api.get<{ notes: NoteDTO[] }>(`/api/annotations/notes?source_id=${sourceId}`)).notes.map(plain), { timeout: 60_000 }).toContain(sentText);
    });

    await test.step('the server cannot be reached: a second note waits in A’s outbox; a third stays an unsaved draft', async () => {
      await page.route('**/api/sync/push', (route) => route.abort('internetdisconnected'));
      await page.getByRole('button', { name: 'ملاحظة على هذه الصفحة' }).click();
      await page.getByRole('textbox', { name: /ملاحظة جديدة/ }).fill(waitingText);
      await page.getByRole('button', { name: 'تم', exact: true }).click();
      await expect.poll(async () => (await readIdb(page, `medlevo:${amal.userId}`)).outbox.filter((o) => o.status === 'pending' && o.text.includes(tok.waiting)).length, { timeout: 30_000 }).toBe(1);
      // typed, never saved: the crash-recovery draft (A's namespace in localStorage)
      await page.getByRole('button', { name: 'ملاحظة على هذه الصفحة' }).click();
      await page.getByRole('textbox', { name: /ملاحظة جديدة/ }).fill(draftText);
      await expect.poll(() => page.evaluate((id) => Object.keys(localStorage).filter((k) => k.startsWith(`${id}:medlevo.note-draft.`)).length, amal.userId)).toBeGreaterThan(0);
    });

    await test.step('A asks to clear this device while a note has not reached the server: nothing is cleared, she is asked', async () => {
      await page.goto('/settings');
      const box = page.getByRole('checkbox', { name: /امسح بيانات هذا الجهاز عند الخروج/ });
      if (!(await box.isChecked())) await box.click();
      await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
      const ask = page.getByRole('dialog', { name: 'لم تصل كل بياناتك إلى الخادم' });
      await expect(ask).toBeVisible({ timeout: 30_000 });
      expect(await axeInLooks(page, 'unsent-data dialog', '[role="dialog"]')).toEqual([]);
      await screenshot(page, testInfo, 'c3-signout-unsent');
      await ask.getByRole('button', { name: 'ابقَ مسجّلًا وأرسلها أولًا' }).click();
      await expect(ask).toBeHidden();
      await expect(page).not.toHaveURL(/\/login/);
      const idb = await readIdb(page, `medlevo:${amal.userId}`);
      expect(idb.outbox.some((o) => o.status === 'pending' && o.text.includes(tok.waiting))).toBe(true);
    });

    await test.step('A signs out (default: her data stays here, in her namespace)', async () => {
      await signOutHere(page, { clear: false });
      const idb = await readIdb(page, `medlevo:${amal.userId}`);
      expect(idb.outbox.some((o) => o.status === 'pending' && o.text.includes(tok.waiting))).toBe(true);
      expect(idb.notes.some((n) => n.includes(tok.sent))).toBe(true);
      // the unsaved text is A's alone: still a draft in her localStorage keys, or (the composer keeps what was typed when
      // the screen closes) a waiting note in her own database
      const draftKeys = await page.evaluate((id) => Object.keys(localStorage).filter((k) => k.startsWith(`${id}:medlevo.note-draft.`)).map((k) => localStorage.getItem(k) ?? ''), amal.userId);
      expect(draftKeys.some((v) => v.includes(tok.draft)) || idb.outbox.some((o) => o.status === 'pending' && o.text.includes(tok.draft))).toBe(true);
    });

    await test.step('B signs in on the same browser: nothing of A in his IndexedDB, outbox, drafts or caches', async () => {
      await setupOwner(page, { username: `badr_${w.stamp}`, password: MEMBER_PASSWORD });
      await expect(page.getByRole('heading', { name: 'الرئيسية', level: 1 })).toBeVisible();
      await page.unroute('**/api/sync/push');
      const mine = await readIdb(page, `medlevo:${badr.userId}`);
      expect(mine.names, 'one database per account').toEqual(expect.arrayContaining([`medlevo:${amal.userId}`, `medlevo:${badr.userId}`]));
      for (const t of [tok.sent, tok.waiting, tok.draft]) {
        expect(mine.notes.some((n) => n.includes(t)), `B's notes hold «${t}»`).toBe(false);
        expect(mine.outbox.some((o) => o.text.includes(t)), `B's outbox holds «${t}»`).toBe(false);
      }
      // drafts belong to their writer: none recovered under B, A's still in A's namespace
      const store = await page.evaluate(() => Object.entries(localStorage));
      expect(store.filter(([k, v]) => !k.startsWith(`${amal.userId}:`) && v.includes(unique)), 'no key outside A’s namespace holds her text').toEqual([]);
      expect(store.filter(([k]) => k.startsWith(`${badr.userId}:`) && k.includes('note-draft'))).toEqual([]);
      // Cache Storage holds the app shell only, never an API answer
      const cached = await page.evaluate(async () => {
        const out: string[] = [];
        for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) out.push(r.url);
        return out;
      });
      expect(cached.filter((u) => new URL(u).pathname.startsWith('/api/'))).toEqual([]);
    });

    await test.step('…and none of A in his library, search or notifications; her waiting note never reached the server under his session', async () => {
      const asB = clientApi(page.request);
      const recent = await asB.get<unknown>('/api/annotations/sessions/recent');
      expect(JSON.stringify(recent), 'B continues none of A’s study sessions').not.toContain(sourceId);
      await page.goto(`/search?q=${encodeURIComponent(unique)}&mode=exact`);
      await expect(page.locator('.sr-results')).toContainText('لا نتائج', { timeout: 30_000 });
      await page.goto('/notifications');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText(/الكيمياء الحيوية/)).toHaveCount(0);
      const bNotes = await asB.get<NotificationsResponse>('/api/notifications');
      expect(bNotes.items.filter((n) => n.kind === 'invitation')).toEqual([]);
      // B's session reads nothing of A's notes (his vault has none); the server holds only A's first note
      const r = await asB.call('GET', `/api/annotations/notes?source_id=${sourceId}`);
      if (r.ok()) expect(await r.text()).not.toContain(unique);
      else expect([403, 404]).toContain(r.status());
      await page.waitForTimeout(3000); // several sync rounds of B's engine
      const aNow = (await amal.api.get<{ notes: NoteDTO[] }>(`/api/annotations/notes?source_id=${sourceId}`)).notes.map(plain);
      expect(aNow).toContain(sentText);
      expect(aNow).not.toContain(waitingText);
      await screenshot(page, testInfo, 'c3-two-accounts-b-inbox');
    });

    await test.step('B signs out with «امسح بيانات هذا الجهاز عند الخروج»: his data is gone from this browser, A’s stays', async () => {
      await signOutHere(page, { clear: true });
      const after = await readIdb(page, `medlevo:${badr.userId}`);
      expect(after.names).not.toContain(`medlevo:${badr.userId}`);
      expect(after.names).toContain(`medlevo:${amal.userId}`);
      const keys = await page.evaluate(() => Object.keys(localStorage));
      expect(keys.filter((k) => k.startsWith(`${badr.userId}:`))).toEqual([]);
      expect(keys.some((k) => k.startsWith(`${amal.userId}:`))).toBe(true);
    });

    await test.step('A signs in again: her waiting note and her draft reach the server under HER session', async () => {
      await setupOwner(page, { username: `amal_${w.stamp}`, password: MEMBER_PASSWORD });
      await expect
        .poll(async () => (await amal.api.get<{ notes: NoteDTO[] }>(`/api/annotations/notes?source_id=${sourceId}`)).notes.map(plain), { timeout: 90_000 })
        .toEqual(expect.arrayContaining([sentText, waitingText, draftText]));
    });

    await test.step('a device registered as shared always clears: A marks this browser shared and signs out', async () => {
      await page.goto('/me/devices');
      const shared = page.getByRole('switch', { name: 'هذا جهاز مشترك' });
      await expect(shared).toBeVisible();
      await shared.click();
      await expect(shared).toHaveAttribute('aria-checked', 'true');
      await page.goto('/settings');
      const box = page.getByRole('checkbox', { name: /امسح بيانات هذا الجهاز عند الخروج/ });
      await expect(box).toBeChecked();
      await expect(box).toBeDisabled();
      await expect(page.getByText(/هذا الجهاز مسجّل جهازًا مشتركًا/)).toBeVisible();
      await screenshot(page, testInfo, 'c3-shared-device-sign-out');
      await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
      await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
      const after = await readIdb(page, `medlevo:${amal.userId}`);
      expect(after.names).not.toContain(`medlevo:${amal.userId}`);
      expect((await page.evaluate(() => Object.keys(localStorage))).filter((k) => k.startsWith(`${amal.userId}:`))).toEqual([]);
      // nothing was lost on the way: everything she wrote is on the server
      const onServer = (await amal.api.get<{ notes: NoteDTO[] }>(`/api/annotations/notes?source_id=${sourceId}`)).notes.map(plain);
      expect(onServer).toEqual(expect.arrayContaining([sentText, waitingText, draftText]));
    });
  } finally {
    await aReq.dispose();
    await w.dispose();
  }
});
