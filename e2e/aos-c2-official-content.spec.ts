// Phase 1 completion, track C2 — official content end to end against the REAL server and the built web app, phone
// 390 × 844 and desktop 1280 × 800, each person in a browser of their own:
//   * AOS-18.4 / 18.3: a Contributor uploads a lecture through «المحتوى الرسمي» → the Subject Moderator approves it and
//     publishes its version there (students never saw the draft); she then uploads two lectures at once («ارفع عدة
//     محاضرات», one draft per file, numbered from the files);
//   * AOS-2.2 / 4.5 / 18.18 / 19I.2: the student's subject list in number order, each lecture «رسمي» with its publisher;
//     the lecture page «رسمي · المادة», the version's publisher, each version's uploader and publisher;
//   * AOS-18.5: an Assistant invites a named person from «الرموز والدعوات» (exact username; a name prefix does not reach
//     people outside the channels he manages), sees the invitation accepted, and revokes another one;
//   * AOS-19H.3: the student's private copy of the lecture is offered the link in her library, linked from the row menu,
//     and what could not be placed waits in the official copy's review list («من محاضرتك الخاصة»).
// axe: no serious violation on the new screens in light, dark and e-ink.
import type { BrowserContext, Page } from '@playwright/test';
import type { InvitationsResponse, LibraryNodeView, OfficialLecturesResponse, UploadResponse } from '@medlevo/shared';
import { pdfFrom } from '../apps/server/test/fixtures/versions/build';
import { expect, screenshot, test, waitForWorkspace } from './support';
import { axeInLooks } from './aos-p1-channels-helpers';
import { anchorOf, buildAosWorld, CLIENT_HEADERS, eventually, fixturePages, notePayload, op, pageIds, publishWhenReady, push, ulid, type AosWorld } from './support/aos-world';

const SEED = 71_000;

test('official content: contributor upload → approve → publish, bulk upload, the student\'s «رسمي» list and page, invitations by name, linking a private lecture', async ({ page, browser, playwright, baseURL }, testInfo) => {
  test.setTimeout(600_000);
  const use = testInfo.project.use;
  const contexts: BrowserContext[] = [];
  const newPage = async (): Promise<Page> => {
    const ctx = await browser.newContext({ baseURL, viewport: use.viewport, isMobile: use.isMobile, hasTouch: use.hasTouch, deviceScaleFactor: use.deviceScaleFactor, locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block' });
    contexts.push(ctx);
    return ctx.newPage();
  };
  const aliPage = await newPage();
  const zainabPage = await newPage();
  const mustafaPage = await newPage();
  const lecturePages = fixturePages('Lecture 5', 6, SEED);
  const w: AosWorld = await buildAosWorld({
    playwright,
    baseURL: baseURL!,
    project: testInfo.project.name,
    page: { key: 'sara', page },
    pages: [
      { key: 'ali', page: aliPage },
      { key: 'zainab', page: zainabPage },
      { key: 'mustafa', page: mustafaPage },
    ],
    people: {
      sara: { name: 'سارة', role: 'subject_moderator' },
      mustafa: { name: 'مصطفى', role: 'assistant' },
      ali: { name: 'علي' },
      zainab: { name: 'زينب' },
      noor: { name: 'نور', outsider: true },
      huda: { name: 'هدى', outsider: true },
    },
    lecture: { title: 'Lecture 5 — The abdominal wall', pages: lecturePages, fileName: 'Abdomen lec5.pdf' },
  }).catch(async (e) => {
    for (const c of contexts) await c.close();
    throw e;
  });
  try {
    const { sara, ali, zainab, noor, huda } = w.people as Record<string, NonNullable<AosWorld['people'][string]>>;
    await w.owner.post(`/api/channels/nodes/${w.subject.id}/roles`, { user_id: ali!.userId, role: 'contributor' });
    const pdf = (label: string, n: number, seed: number) => pdfFrom(fixturePages(label, n, seed), { tag: `TEST FIXTURE ${w.stamp}` });
    const lectures = () => sara!.api.get<OfficialLecturesResponse>(w.S('/lectures?limit=100'));
    const L3 = 'Lecture 3 — Renal anatomy (TEST FIXTURE)';

    await test.step('18.4: the Contributor adds a lecture with its file through «المحتوى الرسمي»; it waits, students never see it', async () => {
      await aliPage.goto('/admin/official');
      await expect(aliPage.getByRole('heading', { level: 1, name: 'المحتوى الرسمي' })).toBeVisible();
      await aliPage.getByLabel('عنوان المحاضرة').fill(L3);
      await aliPage.getByLabel('رقم المحاضرة').fill('3');
      await aliPage.getByLabel(/^ملف المحاضرة/).setInputFiles({ name: 'renal-lecture-3.pdf', mimeType: 'application/pdf', buffer: pdf('Renal', 3, SEED + 100) });
      await aliPage.getByRole('button', { name: 'أضف وارفع الملف' }).click();
      await expect(aliPage.getByText('أُضيفت المحاضرة؛ تنتظر موافقة مشرف المادة.')).toBeVisible({ timeout: 60_000 });
      const forStudent = await zainab!.api.get<OfficialLecturesResponse>(w.S('/lectures?limit=100'));
      expect(forStudent.items.some((l) => l.title === L3), 'a draft is never listed to a student').toBe(false);
    });

    await test.step('18.4: the Subject Moderator approves it and publishes its version there', async () => {
      await page.goto('/admin/official');
      const row = page.locator('li.lec-admin__row[data-status]').filter({ hasText: 'Renal anatomy' });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole('button', { name: 'وافق' }).click();
      await expect(page.getByText('تمت الموافقة على المسودة.')).toBeVisible();
      const publish = row.getByRole('button', { name: 'انشر الإصدار 1' });
      await expect
        .poll(
          async () => {
            await page.reload();
            await expect(row).toBeVisible({ timeout: 30_000 });
            return publish.isEnabled();
          },
          { timeout: 180_000, intervals: [1500] },
        )
        .toBe(true);
      await publish.click();
      const dialog = page.getByRole('dialog', { name: /نشر الإصدار 1 من/ });
      await dialog.getByRole('button', { name: 'انشر للطلاب' }).click();
      await expect(page.getByText('نُشر الإصدار للطلاب.')).toBeVisible({ timeout: 60_000 });
      const l = (await lectures()).items.find((x) => x.title === L3)!;
      expect(l.status).toBe('published');
      expect(l.uploaded_by.id).toBe(ali!.userId);
      expect(l.head_version?.published_by?.id).toBe(sara!.userId);
      await screenshot(page, testInfo, 'c2-official-admin');
      expect(await axeInLooks(page, 'official content')).toEqual([]);
    });

    await test.step('2.3 / 18.3: «ارفع عدة محاضرات» — two files, two drafts named from them', async () => {
      const bulk = page.getByRole('region', { name: 'ارفع عدة محاضرات' });
      await bulk.getByLabel(/ملفات المحاضرات/).setInputFiles([
        { name: 'Lecture 7 cardiac cycle.pdf', mimeType: 'application/pdf', buffer: pdf('Cardiac', 3, SEED + 200) },
        { name: 'Lecture 6 lungs.pdf', mimeType: 'application/pdf', buffer: pdf('Lungs', 3, SEED + 300) },
      ]);
      await bulk.getByRole('button', { name: 'ارفع محاضرتين' }).click();
      await expect(bulk.getByText('رُفعت 2 من 2. الأرقام والتواريخ تُقرأ من الملفات وتنتظر مراجعتك.')).toBeVisible({ timeout: 120_000 });
      for (const title of ['Lecture 7 cardiac cycle', 'Lecture 6 lungs']) {
        const l = (await lectures()).items.find((x) => x.title === title)!;
        expect(l, title).toBeTruthy();
        const detail = await sara!.api.get<{ versions: Array<{ id: string }> }>(w.S(`/lectures/${l.id}`));
        await publishWhenReady(sara!, w.spaceId, l.id, detail.versions[0]!.id);
      }
      // the numbers are read from the file names (certain), after the analysis of each file
      await eventually(lectures, (r) => ['Lecture 7 cardiac cycle', 'Lecture 6 lungs'].every((t) => r.items.find((x) => x.title === t)?.lecture_no !== null), 'numbers read from the files', 120_000);
    });

    await test.step('2.2 / 4.5 / 19I.2: the student\'s subject list — number order, each «رسمي» with its publisher', async () => {
      await zainabPage.goto(`/subjects/${w.subject.id}`);
      await expect(zainabPage.getByRole('heading', { level: 1, name: w.subject.title })).toBeVisible();
      const panel = zainabPage.getByRole('tabpanel');
      const rows = panel.locator('li.ml-list__row');
      await expect(rows).toHaveCount(4, { timeout: 30_000 });
      const texts = await rows.allTextContents();
      expect(texts.map((t) => /المحاضرة (\d+)/.exec(t)?.[1])).toEqual(['3', '5', '6', '7']);
      for (const t of texts) {
        expect(t).toContain('رسمي');
        expect(t).toContain('نشرها سارة');
      }
      expect(texts[3]).toContain('(مقروء من الملف)');
      await screenshot(zainabPage, testInfo, 'c2-student-lectures');
      expect(await axeInLooks(zainabPage, 'subject lectures')).toEqual([]);
    });

    await test.step('4.5 / 18.18: the lecture page — «رسمي · المادة», the publisher, each version\'s uploader and publisher', async () => {
      await zainabPage.getByRole('link', { name: /Renal anatomy/ }).click();
      await expect(zainabPage.getByRole('heading', { level: 1, name: L3 })).toBeVisible();
      await expect(zainabPage.getByText(`رسمي · ${w.subject.title}`)).toBeVisible();
      await expect(zainabPage.getByText('نشر الإصدار 1: سارة')).toBeVisible();
      const version = zainabPage.getByRole('list', { name: 'الإصدارات المنشورة' }).getByRole('listitem').first();
      await expect(version).toContainText('رفعه علي');
      await expect(version).toContainText('نشره سارة');
      await screenshot(zainabPage, testInfo, 'c2-student-lecture');
      expect(await axeInLooks(zainabPage, 'lecture page')).toEqual([]);
    });

    await test.step('18.5: an Assistant invites a named person from «الرموز والدعوات», sees it accepted, revokes another', async () => {
      await mustafaPage.goto(`/admin/codes?node=${w.subject.id}`);
      const search = mustafaPage.getByRole('textbox', { name: /ابحث عن شخص/ });
      await expect(search).toBeVisible({ timeout: 30_000 });
      // a name prefix never reaches people outside the channels he manages
      await search.fill('نو');
      await expect(mustafaPage.getByText(/لا أحد بهذا الاسم في القنوات التي تديرها/)).toBeVisible();
      await search.fill(`noor_${w.stamp}`);
      const results = mustafaPage.getByRole('list', { name: 'نتائج البحث' });
      await expect(results.getByText('اسم المستخدم مطابق تمامًا')).toBeVisible();
      await results.getByRole('button', { name: 'ادعُ نور' }).click();
      await expect(mustafaPage.getByText('أُرسلت الدعوة إلى نور.')).toBeVisible();
      const sent = mustafaPage.getByRole('list', { name: 'الدعوات المرسلة' });
      await expect(sent.getByRole('listitem').filter({ hasText: 'نور' })).toContainText('بانتظار الرد');
      // she accepts in her own account (her notice); the list says so
      const mine = await noor!.api.get<InvitationsResponse>('/api/channels/invitations');
      const inv = mine.invitations.find((i) => i.node.id === w.subject.id)!;
      await noor!.api.post(`/api/channels/invitations/${inv.id}/decision`, { accept: true });
      await mustafaPage.reload();
      await expect(mustafaPage.getByRole('list', { name: 'الدعوات المرسلة' }).getByRole('listitem').filter({ hasText: 'نور' })).toContainText('قُبلت', { timeout: 30_000 });
      // another invitation, revoked from the screen
      await mustafaPage.getByRole('textbox', { name: /ابحث عن شخص/ }).fill(`huda_${w.stamp}`);
      await mustafaPage.getByRole('list', { name: 'نتائج البحث' }).getByRole('button', { name: 'ادعُ هدى' }).click();
      await expect(mustafaPage.getByText('أُرسلت الدعوة إلى هدى.')).toBeVisible();
      await mustafaPage.getByRole('button', { name: 'ألغِ دعوة هدى' }).click();
      await expect(mustafaPage.getByText('أُلغيت دعوة هدى.')).toBeVisible();
      await expect(mustafaPage.getByRole('list', { name: 'الدعوات المرسلة' }).getByRole('listitem').filter({ hasText: 'هدى' })).toContainText('أُلغيت');
      expect((await huda!.api.get<InvitationsResponse>('/api/channels/invitations')).invitations.filter((i) => i.node.id === w.subject.id)).toEqual([]);
      await screenshot(mustafaPage, testInfo, 'c2-invitations');
      expect(await axeInLooks(mustafaPage, 'invitations')).toEqual([]);
    });

    await test.step('19H.3: her private copy is offered the link in the library; linking copies her notes, the rest waits for review', async () => {
      // her own file: the official pages and one summary page of her own (it maps to nothing safely)
      const variant = pdfFrom([...lecturePages, { heading: 'My own summary page (TEST FIXTURE)', lines: ['my own revision summary written for the exam', 'nothing like this is in the official file'] }], { tag: `TEST FIXTURE ${w.stamp}` });
      const { node: notebook } = await zainab!.api.post<{ node: LibraryNodeView }>('/api/library/nodes', { parent_id: null, kind: 'notebook', title: `دفتري ${w.stamp}`, cover: { style: 'linen', color: 'rose', symbol: 'book' } });
      const { node: course } = await zainab!.api.post<{ node: LibraryNodeView }>('/api/library/nodes', { parent_id: notebook.id, kind: 'course', title: `التشريح الخاص ${w.stamp}` });
      const res = await zainab!.api.request.post('/api/sources/upload', {
        headers: { ...CLIENT_HEADERS },
        multipart: { node_id: course.id, source_type: 'lecture', files: { name: 'my lecture 5.pdf', mimeType: 'application/pdf', buffer: variant } },
        timeout: 120_000,
      });
      expect(res.status(), await res.text()).toBe(200);
      const up = ((await res.json()) as UploadResponse).results[0]!;
      await eventually(() => zainab!.api.get<{ job: { status: string } | null }>(`/api/sources/versions/${up.version_id}/processing`), (s) => s.job?.status === 'completed' || s.job?.status === 'partial', 'her file processed', 180_000);
      const ids = await pageIds(zainab!, up.source_id!, up.version_id!);
      await push(zainab!, [
        op('note', ulid(), notePayload(anchorOf(up.source_id!, up.version_id!, ids, 1), 'ملاحظتي على الصفحة الثانية', null)),
        op('note', ulid(), notePayload(anchorOf(up.source_id!, up.version_id!, ids, ids.length - 1), 'ملاحظة على ملخصي الخاص', null)),
      ]);
      await zainabPage.goto(`/library/${course.id}`);
      const row = zainabPage.locator('li').filter({ hasText: 'my lecture 5' }).first();
      await expect(row.getByText(new RegExp(`موجودة رسميًا في ${w.subject.title}`))).toBeVisible({ timeout: 60_000 });
      await row.getByRole('button', { name: /^خيارات «/ }).click();
      await zainabPage.getByRole('menuitem', { name: 'اربط بالمحاضرة الرسمية…' }).click();
      const dialog = zainabPage.getByRole('dialog', { name: 'اربط بالمحاضرة الرسمية' });
      await expect(dialog.getByText(/Lecture 5 — The abdominal wall/)).toBeVisible({ timeout: 30_000 });
      await dialog.getByRole('button', { name: 'اربط وانسخ ملاحظاتي' }).click();
      const done = zainabPage.getByRole('dialog', { name: 'رُبطت المحاضرة بنسختها الرسمية' });
      await expect(done).toBeVisible({ timeout: 120_000 });
      await expect(done).toContainText('محاضرتك الخاصة وكل ما عليها لم يتغيّر.');
      await done.getByRole('button', { name: 'راجع ما لم يُنسخ' }).click();
      await waitForWorkspace(zainabPage);
      await expect(zainabPage.getByText(/ربطت محاضرتك الخاصة/).first()).toBeVisible({ timeout: 60_000 });
      await expect(zainabPage.getByRole('button', { name: /اتركها في محاضرتك الخاصة/ }).first()).toBeVisible();
      await screenshot(zainabPage, testInfo, 'c2-linked-review');
    });
  } finally {
    await w.dispose();
    for (const c of contexts) await c.close();
  }
});
