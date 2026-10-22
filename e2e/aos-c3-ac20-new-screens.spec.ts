// Track C3 — AOS-20.3 / AOS-1.16: the G6 AC-20 checks (e2e/g6-ac20-mixed-text.spec.ts) extended to the NEW editors of
// the Academic OS, against the REAL server and the built web app, phone 390 × 844 and desktop 1280 × 800. Text pasted
// with invisible bidi controls (RLE/PDF, RLM, isolates — what WhatsApp, Word and PDF viewers leave in copied text) into
//   * a channel / subject title («الشجرة»), * an official lecture title («المحتوى الرسمي»),
//   * an explanation title and its change note («انشر شرحك», «انشر إصدارًا جديدًا»), * a moderation reason («الإشراف»)
// is stored WITHOUT any control character, and is drawn where people read it with every LTR expression left to right and
// the Arabic around it on the correct side.
import type { Browser, Page } from '@playwright/test';
import type { ChannelTreeResponse, OfficialLecturesResponse, PublicationView } from '@medlevo/shared';
import { expect, screenshot, serverFor, setupOwner, test } from './support';
import { expectDrawnLeftToRight, expectReadBefore } from './g6-helpers';
import { anchorOf, buildAosWorld, createLayer, eventually, fixturePages, inkPayload, MEMBER_PASSWORD, op, pageIds, push, startCopy, type AosWorld, type Member } from './support/aos-world';

const BIDI = /[؜‎‏‪-‮⁦-⁩]/;
/** the text a person pastes (controls included) and what must be stored and shown */
const pasted = (s: string) => s.replace('Anatomy', '‫Anatomy').replace('101', '101‬').replace('(CT', '‏(CT').replace('×10⁹', '⁦×10⁹⁩');

async function studentPage(browser: Browser, project: string, username: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: project === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: project === 'phone', hasTouch: project === 'phone', baseURL: serverFor(project).baseURL, locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await setupOwner(page, { username, password: MEMBER_PASSWORD });
  return { page, close: () => ctx.close() };
}

test('AC-20 on the new editors: titles, change notes and reasons pasted with bidi controls are stored clean and drawn in order', async ({ page, browser, playwright, baseURL }, testInfo) => {
  test.setTimeout(420_000);
  const w: AosWorld = await buildAosWorld({
    playwright,
    baseURL: baseURL!,
    project: testInfo.project.name,
    people: { mod: { name: 'المشرف', role: 'subject_moderator' }, hasan: { name: 'حسن' }, reem: { name: 'ريم' } },
    lecture: { title: 'Lecture 9 — AC-20 fixture', pages: fixturePages('Lecture 9', 2, 91_000), fileName: 'lecture9.pdf' },
  });
  const hasan = w.people.hasan as Member;
  const reem = w.people.reem as Member;
  const subjectTitle = `التشريح Anatomy 101 (CT abdomen) ×10⁹ ${w.stamp}`;
  // Arabic-led titles (the paragraph direction is detected from the text — richtext.detectDir, ≥ 40 % Arabic letters → RTL)
  const lectureTitle = `محاضرة Anatomy 101 للكلية عن جدار البطن (CT abdomen) ${w.stamp}`;
  const pubTitle = `شرح Anatomy 101 للكلية عن جدار البطن (CT abdomen) ${w.stamp}`;
  const changeNote = `أضفت Anatomy 101 وجرعة 5 mg IV (CT abdomen)`;
  const reason = `معلومة خاطئة عن Anatomy 101 (CT abdomen)`;
  const S = w.S;
  const student = await studentPage(browser, testInfo.project.name, `hasan_${w.stamp}`);
  try {
    await setupOwner(page);

    await test.step('«الشجرة»: a subject title pasted with controls → stored clean; drawn in order in the tree and on the subject page', async () => {
      const collegeId = w.subject.parent_id!;
      const college = (await w.owner.get<ChannelTreeResponse>('/api/channels/tree?depth=7')).nodes.find((n) => n.id === collegeId)!;
      await page.goto(`/admin/tree?node=${collegeId}`);
      await page.getByRole('button', { name: `أضف تحت ${college.title}` }).click();
      const dialog = page.getByRole('dialog', { name: `عقدة جديدة تحت ${college.title}` });
      await dialog.getByLabel('النوع').selectOption('subject');
      const field = dialog.getByLabel('الاسم', { exact: true });
      await field.fill(pasted(subjectTitle));
      await expect(field).toHaveValue(subjectTitle);
      await dialog.getByRole('button', { name: 'أنشئ' }).click();
      await expect(dialog).toBeHidden();
      const node = await eventually(async () => (await w.owner.get<ChannelTreeResponse>('/api/channels/tree?depth=7')).nodes.find((n) => n.title.includes(w.stamp) && n.title.startsWith('التشريح Anatomy')), Boolean, 'the subject is in the tree');
      expect(node!.title).toBe(subjectTitle);
      expect(BIDI.test(node!.title)).toBe(false);
      const row = page.locator('.ad-tree__title').filter({ hasText: 'Anatomy 101' });
      for (const expr of ['Anatomy 101', '(CT abdomen)', '×10⁹']) await expectDrawnLeftToRight(row, expr);
      await expectReadBefore(row, 'التشريح', 'Anatomy', 'التشريح Anatomy');
      await page.goto(`/subjects/${node!.id}`);
      const heading = page.getByRole('heading', { level: 1 }).filter({ hasText: 'Anatomy 101' });
      await expect(heading).toBeVisible();
      await expectDrawnLeftToRight(heading, 'Anatomy 101');
      await expectReadBefore(heading, 'التشريح', 'Anatomy', 'التشريح Anatomy');
      await screenshot(page, testInfo, 'c3-ac20-subject-title');
    });

    await test.step('«المحتوى الرسمي»: a lecture title pasted with controls → stored clean; drawn in order', async () => {
      await page.goto(`/admin/official?node=${w.subject.id}`);
      // the new subject from the step above is a second subject this owner manages → the scope chooser appears
      const scope = page.getByLabel('المادة', { exact: true });
      await expect(scope).toBeVisible();
      await scope.selectOption(w.subject.id);
      const title = page.getByLabel('عنوان المحاضرة');
      await title.fill(pasted(lectureTitle));
      await expect(title).toHaveValue(lectureTitle);
      await page.getByRole('button', { name: 'أضف مسودة' }).click();
      const list = await eventually(() => w.owner.get<OfficialLecturesResponse>(S('/lectures?status=draft')), (r) => r.items.some((l) => l.title.includes(w.stamp)), 'the draft lecture is listed');
      const stored = list.items.find((l) => l.title.includes(w.stamp))!;
      expect(stored.title).toBe(lectureTitle);
      expect(BIDI.test(stored.title)).toBe(false);
      const shown = page.getByText(lectureTitle, { exact: false }).first();
      await expect(shown).toBeVisible();
      await expectDrawnLeftToRight(shown, 'Anatomy 101');
      await expectDrawnLeftToRight(shown, '(CT abdomen)');
      await expectReadBefore(shown, 'محاضرة', 'Anatomy', 'محاضرة Anatomy');
    });

    let pub: PublicationView | null = null;
    await test.step('«انشر شرحك» and «انشر إصدارًا جديدًا»: title and change note pasted with controls → stored clean; drawn in order', async () => {
      const copy = await startCopy(w, hasan, { mode: 'personal' });
      const ids = await pageIds(hasan, copy.source_id, copy.lecture!.version_id);
      const layer = await createLayer(hasan, copy.source_id, 'شرحي');
      await push(hasan, [op('annotation', `${w.stamp}A20`.toUpperCase(), inkPayload(anchorOf(copy.source_id, copy.lecture!.version_id, ids, 0), 0.2, 0.3, layer), 'append')]);
      const sp = student.page;
      await sp.goto(`/subjects/${w.spaceId}/lectures/${w.lecture.id}?tab=explanations`);
      await sp.getByRole('button', { name: 'انشر شرحك' }).click();
      const dialog = sp.getByRole('dialog', { name: 'انشر شرحك' });
      const titleBox = dialog.getByRole('textbox', { name: /عنوان الشرح/ });
      await titleBox.fill(pasted(pubTitle));
      await expect(titleBox).toHaveValue(pubTitle);
      await dialog.getByRole('button', { name: 'انشر', exact: true }).click();
      const h1 = sp.getByRole('heading', { level: 1 }).filter({ hasText: 'Anatomy 101' });
      await expect(h1).toBeVisible({ timeout: 30_000 });
      const pubId = sp.url().split('/publications/')[1]!.split(/[?#]/)[0]!;
      pub = await hasan.api.get<PublicationView>(S(`/publications/${pubId}`));
      expect(pub.title).toBe(pubTitle);
      expect(BIDI.test(pub.title)).toBe(false);
      await expectDrawnLeftToRight(h1, 'Anatomy 101');
      await expectDrawnLeftToRight(h1, '(CT abdomen)');
      await expectReadBefore(h1, 'شرح', 'Anatomy', 'شرح Anatomy');

      // a second version with a change note pasted with controls
      await push(hasan, [op('annotation', `${w.stamp}A21`.toUpperCase(), inkPayload(anchorOf(copy.source_id, copy.lecture!.version_id, ids, 0), 0.2, 0.5, layer), 'append')]);
      await sp.getByRole('button', { name: 'انشر إصدارًا جديدًا' }).click();
      const again = sp.getByRole('dialog', { name: 'انشر إصدارًا جديدًا' });
      const note = again.getByRole('textbox', { name: /ما الذي تغيّر/ });
      await note.fill(changeNote.replace('Anatomy', '‪Anatomy').replace('IV', 'IV‬‎'));
      await expect(note).toHaveValue(changeNote);
      await again.getByRole('button', { name: 'انشر الإصدار', exact: true }).click();
      await expect(again).toBeHidden({ timeout: 30_000 });
      const v2 = await eventually(() => hasan.api.get<PublicationView>(S(`/publications/${pubId}`)), (p) => p.head_version_no === 2, 'version 2 is published');
      const stored = v2.versions.find((v) => v.no === 2)!.change_note!;
      expect(stored).toBe(changeNote);
      expect(BIDI.test(stored)).toBe(false);
      await sp.reload();
      const shownNote = sp.getByText(changeNote).first();
      await expect(shownNote).toBeVisible();
      await expectDrawnLeftToRight(shownNote, '5 mg IV');
      await expectReadBefore(shownNote, 'أضفت', 'Anatomy', 'أضفت Anatomy');
      await screenshot(sp, testInfo, 'c3-ac20-publication');
    });

    await test.step('«الإشراف»: a reason pasted with controls → stored clean (the author reads it as written)', async () => {
      await reem.api.post('/api/moderation/reports', { target: { db: 'system', type: 'publication', id: pub!.id }, reason: 'wrong_content', note: 'خطأ' });
      await page.goto(`/admin/moderation?node=${w.subject.id}`);
      const row = page.locator('li.ad-report').filter({ hasText: 'Anatomy 101' });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole('button', { name: 'أخفِ مع السبب' }).click();
      const dialog = page.getByRole('dialog', { name: 'أخفِ مع السبب' });
      const box = dialog.getByLabel('السبب (يقرؤه الكاتب والمُبلِّغ)');
      await box.fill(reason.replace('Anatomy', '⁧Anatomy').replace('101', '101⁩').replace('(CT', '؜(CT'));
      await expect(box).toHaveValue(reason);
      await dialog.getByRole('button', { name: 'أخفِ', exact: true }).click();
      await expect(page.getByText('أُخفي المحتوى وأُبلغ الكاتب والمُبلِّغ.')).toBeVisible();
      const hidden = await hasan.api.get<PublicationView>(S(`/publications/${pub!.id}`));
      const text = JSON.stringify(hidden);
      expect(text).toContain(reason);
      expect(BIDI.test(text)).toBe(false);
    });
  } finally {
    await student.close();
    await w.dispose();
  }
});
