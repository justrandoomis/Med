// G7 — AC-30 «الاستعادة», tested the way the owner would do it: the owner writes in the real app (ink drawn on the page,
// a note, the reading place, a card and its review), makes a backup from the «بياناتك» screen, has the SERVER verify the
// restore, downloads the archive, restores it with the real command-line tool into an empty directory, starts a SECOND
// real server on the restored data and signs in from a fresh browser: the library, the lecture with its ink and note,
// the reading place, the linked questions, the cards and the review log are all there.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { AnnotationDTO, LectureQuestionsResponse, NoteDTO, SyncOp } from '@medlevo/shared';
import { apiAs, expect, openWorkspace, screenshot, setupOwner, test } from './support';
import { SERVER_DIR } from './support/paths';
import { startServer, type RunningServer } from './support/server';

const rt = (text: string) => ({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: text }] }] });
const uid = () => crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0, 26);
const plain = (n: Pick<NoteDTO, 'body'>) => n.body.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');

async function drawStroke(page: Page, fx: number, fy: number): Promise<void> {
  const box = (await page.locator('.wk-page[data-page-index="0"] .ml-ink-layer').boundingBox())!;
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.mouse.down();
  for (let k = 1; k <= 12; k++) await page.mouse.move(box.x + box.width * (fx + k * 0.01), box.y + box.height * (fy + (k % 2) * 0.005));
  await page.mouse.up();
}

test('AC-30: backup made in the app, restore verified by the server, restored with the CLI, a second server shows everything', async ({ page, api, browser }, testInfo) => {
  test.setTimeout(10 * 60_000);
  await setupOwner(page);
  const stamp = `${Date.now().toString(36)}-${testInfo.project.name}`;
  const { notebook, course } = await api.createNotebookAndCourse({ notebookTitle: `دفتر الاستعادة ${stamp}`, courseTitle: `Course G7 restore ${stamp}` });
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `G7 restore lecture ${stamp}` });
  const qs = await api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create', title: `G7 restore questions ${stamp}` });
  await api.waitForProcessing(lecture.version_id);
  await api.waitForProcessing(qs.version_id, { questions: true });
  await expect.poll(async () => (await api.get<LectureQuestionsResponse>(`/api/questions/for-lecture/${lecture.source_id}`)).items.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const linkedBefore = (await api.get<LectureQuestionsResponse>(`/api/questions/for-lecture/${lecture.source_id}`)).items.length;
  const noteText = `ملاحظتي قبل النسخ الاحتياطي: WBC > 11 ×10⁹/L ${stamp}`;

  await test.step('the owner writes in the reader: two ink strokes, a note, then reads on to ص 12', async () => {
    await openWorkspace(page, lecture.source_id, { pageIndex: 0 });
    await page.keyboard.press('KeyP');
    await expect(page.locator('.wk-page[data-page-index="0"] .ml-ink-layer')).toHaveAttribute('data-writing', '');
    await drawStroke(page, 0.25, 0.3);
    await drawStroke(page, 0.25, 0.45);
    await page.keyboard.press('Escape');
    const tab = page.getByRole('tab', { name: /ملاحظاتي/ });
    if (!(await tab.isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
    await tab.click();
    await page.getByRole('button', { name: 'ملاحظة على هذه الصفحة' }).click();
    await page.getByRole('textbox', { name: /ملاحظة جديدة/ }).fill(noteText);
    await page.getByRole('button', { name: 'تم' }).click();
    // on a phone the study rail is a bottom sheet over the book: close it before turning pages
    const sheet = page.locator('.ml-overlay--sheet');
    if (await sheet.isVisible()) {
      await sheet.getByRole('button', { name: 'إغلاق', exact: true }).click();
      await expect(sheet).toBeHidden();
    }
    await page.locator('.wk-pageind').first().click();
    await page.locator('.wk-goto input').fill('12');
    await page.locator('.wk-goto button[type="submit"]').click();
    await expect(page.locator('.wk-pageind').first()).toContainText('ص 12');
    // everything reaches the server
    await expect.poll(async () => (await api.get<{ annotations: AnnotationDTO[] }>(`/api/annotations/source/${lecture.source_id}?version_id=${lecture.version_id}`)).annotations.filter((a) => a.kind === 'ink').length, { timeout: 60_000 }).toBe(2);
    await expect.poll(async () => (await api.get<{ notes: NoteDTO[] }>(`/api/annotations/notes?source_id=${lecture.source_id}`)).notes.map(plain), { timeout: 60_000 }).toEqual([noteText]);
    await expect.poll(async () => (await api.get<{ session: { location: { page_index: number } } | null }>(`/api/annotations/sessions/latest?source_id=${lecture.source_id}`)).session?.location.page_index, { timeout: 60_000 }).toBe(1);
  });

  const cardId = uid();
  await test.step('a card with a review (another device)', async () => {
    const r = await api.post<{ results: Array<{ result: string }> }>('/api/sync/push', {
      ops: [
        { op_id: uid(), device_id: 'G7_PHONE', client_ts: Date.now(), entity_type: 'flashcard', entity_id: cardId, op: 'upsert', payload: { kind: 'basic', front: rt(`بطاقة الاستعادة ${stamp}`), back: rt('Pregnancy test (β-hCG)'), source_id: lecture.source_id } },
        { op_id: uid(), device_id: 'G7_PHONE', client_ts: Date.now(), entity_type: 'review_event', entity_id: uid(), op: 'append', payload: { card_id: cardId, rating: 3, reviewed_at: Date.now() - 60_000, duration_ms: 4000 } },
      ] satisfies SyncOp[],
    });
    expect(r.results.map((x) => x.result)).toEqual(['applied', 'applied']);
  });

  const work = mkdtempSync(join(tmpdir(), 'medlevo-e2e-g7-ac30-'));
  let restoredServer: RunningServer | null = null;
  try {
    const archive = join(work, 'backup.tar.gz');
    await test.step('«بياناتك» → back up now → the server verifies the restore → download the archive', async () => {
      await page.goto('/offline?tab=backups');
      await page.getByRole('button', { name: 'أنشئ نسخة احتياطية الآن' }).click();
      const download = page.getByRole('link', { name: 'نزّل النسخة' }).first();
      await expect(download).toBeVisible({ timeout: 120_000 });
      await expect(page.getByText('لم تُختبر استعادة هذه النسخة بعد').first()).toBeVisible(); // honest until tested
      await page.getByRole('button', { name: 'تحقّق من الاستعادة' }).first().click();
      await expect(page.getByText(/اختُبرت الاستعادة/).first()).toBeVisible({ timeout: 180_000 });
      await screenshot(page, testInfo, 'g7-ac30-backup-verified');
      const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
      await file.saveAs(archive);
    });

    const target = join(work, 'restored');
    await test.step('restore with the command-line tool into an empty directory (every check passes)', () => {
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(SERVER_DIR, 'src', 'cli', 'restore-verify.ts'), archive, '--target', target], {
        cwd: SERVER_DIR,
        env: { ...process.env, INIT_CWD: SERVER_DIR, ANTHROPIC_API_KEY: '' },
        encoding: 'utf8',
        timeout: 300_000,
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(r.status, out).toBe(0);
      expect(out).toContain('RESULT: PASS');
      expect(out).not.toContain('[FAIL]');
    });

    await test.step('a second real server on the restored data; the owner signs in again from a fresh browser', async () => {
      restoredServer = await startServer(`restored-${testInfo.project.name}`, target);
      const ctx = await browser.newContext({ baseURL: restoredServer.baseURL, locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block', viewport: testInfo.project.use.viewport ?? { width: 1280, height: 800 } });
      try {
        const p2 = await ctx.newPage();
        expect(await setupOwner(p2)).toBe('login'); // the owner and the password came back; every session was revoked
        const api2 = apiAs(p2.request);

        // library: the notebook and its course
        await p2.goto(`/library/${notebook.id}`);
        await expect(p2.getByRole('link', { name: new RegExp(`Course G7 restore ${stamp}`) }).first()).toBeVisible();

        // the reader opens where the owner stopped (ص 12), with the note and the two ink strokes
        await p2.goto(`/study/${lecture.source_id}`);
        await expect(p2.locator('.wk-canvas-slot canvas').first()).toBeVisible({ timeout: 45_000 });
        await expect(p2.locator('.wk-pageind').first()).toContainText('ص 12', { timeout: 30_000 });
        const tab = p2.getByRole('tab', { name: /ملاحظاتي/ });
        if (!(await tab.isVisible())) await p2.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
        await tab.click();
        await expect(p2.getByText(noteText).first()).toBeVisible({ timeout: 30_000 });
        const ink = (await api2.get<{ annotations: AnnotationDTO[] }>(`/api/annotations/source/${lecture.source_id}?version_id=${lecture.version_id}`)).annotations.filter((a) => a.kind === 'ink');
        expect(ink).toHaveLength(2);
        expect(ink.every((a) => a.anchor.type === 'page' && a.anchor.page_index === 0)).toBe(true);
        await screenshot(p2, testInfo, 'g7-ac30-restored-reader');

        // the questions and their links to the lecture
        const linked = await api2.get<LectureQuestionsResponse>(`/api/questions/for-lecture/${lecture.source_id}`);
        expect(linked.items.length).toBe(linkedBefore);
        const railQ = p2.getByRole('tab', { name: /الأسئلة/ });
        await railQ.click();
        await expect(p2.locator('.qv-rail__list li').first()).toBeVisible({ timeout: 30_000 });

        // the card and its review log
        const card = await api2.get<{ events: unknown[]; card: { review_state: { reps: number } } }>(`/api/learning/cards/${cardId}`);
        expect(card.events).toHaveLength(1);
        expect(card.card.review_state.reps).toBe(1);
        await p2.goto('/review/cards');
        await expect(p2.getByText(`بطاقة الاستعادة ${stamp}`).first()).toBeVisible({ timeout: 60_000 });
        await screenshot(p2, testInfo, 'g7-ac30-restored-cards');
      } finally {
        await ctx.close();
      }
    });
  } finally {
    if (restoredServer) await (restoredServer as RunningServer).stop();
    rmSync(work, { recursive: true, force: true });
  }
});
