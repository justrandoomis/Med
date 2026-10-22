// Track C3 — AOS-19L.4: every dialog of «إدارة القنوات» used with the KEYBOARD ONLY (no pointer at all), against the
// REAL server and the built web app, phone 390 × 844 and desktop 1280 × 800. For each dialog: the trigger is reached with
// Tab, Enter opens it, focus moves inside, Tab / Shift+Tab stay inside (focus trap), Escape closes it and focus returns
// to the trigger; then the action itself is done with Tab, typing, the arrow keys (native selects) and Enter:
//   «الشجرة» add / edit / move / archive · «الرموز والدعوات» revoke · «الأعضاء» reject with a reason ·
//   «الأدوار» grant and revoke · «الإشراف» hide with a reason · «المحتوى الرسمي» withdraw with a reason.
import type { Locator, Page } from '@playwright/test';
import type { ChannelTreeResponse, CreateJoinCodeResponse, JoinCodesResponse, OfficialLectureDetail } from '@medlevo/shared';
import { expect, screenshot, setupOwner, test } from './support';
import { registerStudent } from './aos-p1-channels-helpers';
import { anchorOf, buildAosWorld, createLayer, fixturePages, op, pageIds, publishApi, push, startCopy, uploadOfficial, type AosWorld, type Member } from './support/aos-world';
import { pdfFrom } from '../apps/server/test/fixtures/versions/build';

const isFocused = (l: Locator) => l.evaluate((el) => el === document.activeElement).catch(() => false);

/** Reach `target` with Tab only (from wherever focus is); fails when Tab never gets there. */
async function tabTo(page: Page, target: Locator, max = 120): Promise<void> {
  await expect(target).toBeVisible();
  for (let i = 0; i < max; i++) {
    if (await isFocused(target)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`not reachable with the Tab key: ${target.toString()}`);
}

async function focusInside(dialog: Locator): Promise<boolean> {
  return dialog.evaluate((d) => d.contains(document.activeElement));
}

/**
 * Open a dialog with the keyboard and check the contract of a modal dialog: focus moves in, Tab and Shift+Tab stay in,
 * Escape closes it and gives focus back to its trigger. Leaves it OPEN again (re-opened with Enter) for the action.
 */
async function keyboardDialog(page: Page, trigger: Locator, dialog: Locator): Promise<void> {
  await tabTo(page, trigger);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect.poll(() => focusInside(dialog), { message: 'focus moves into the dialog' }).toBe(true);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
    expect(await focusInside(dialog), 'Tab / Shift+Tab stay inside the dialog').toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect.poll(() => isFocused(trigger), { message: 'focus returns to the trigger after Escape' }).toBe(true);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect.poll(() => focusInside(dialog)).toBe(true);
}

/** Type into a field reached with Tab (select-all first, so an existing value is replaced). */
async function typeInto(page: Page, field: Locator, text: string): Promise<void> {
  await tabTo(page, field);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text);
}

/** Choose the next option of a native select with the arrow key; returns the chosen option's text. */
async function arrowSelect(page: Page, select: Locator, presses = 1): Promise<string> {
  await tabTo(page, select);
  for (let i = 0; i < presses; i++) await page.keyboard.press('ArrowDown');
  return select.evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex]?.text ?? '');
}

async function press(page: Page, button: Locator): Promise<void> {
  await tabTo(page, button);
  await page.keyboard.press('Enter');
}

test('«إدارة القنوات» by keyboard only: every dialog opens, traps focus, closes with Escape and completes its action', async ({ page, playwright, baseURL }, testInfo) => {
  test.setTimeout(480_000);
  const w: AosWorld = await buildAosWorld({
    playwright,
    baseURL: baseURL!,
    project: testInfo.project.name,
    people: { mod: { name: 'المشرف', role: 'subject_moderator' }, hasan: { name: 'حسن' }, reem: { name: 'ريم' } },
    lecture: { title: 'Lecture 8 — keyboard fixture', pages: fixturePages('Lecture 8', 2, 81_000), fileName: 'lecture8.pdf' },
  });
  const tree = async () => (await w.owner.get<ChannelTreeResponse>('/api/channels/tree?depth=7')).nodes;
  const byTitle = async (title: string) => (await tree()).find((n) => n.title === title);
  const collegeId = w.subject.parent_id!;
  const college = (await tree()).find((n) => n.id === collegeId)!;
  const dept = `قسم بلوحة المفاتيح ${w.stamp}`;
  const deptRenamed = `قسم معدّل ${w.stamp}`;
  try {
    await setupOwner(page);

    await test.step('«الشجرة»: add, edit, move and archive — each dialog by keyboard', async () => {
      await page.goto(`/admin/tree?node=${collegeId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'الشجرة' })).toBeVisible();
      const add = page.getByRole('button', { name: `أضف تحت ${college.title}` });
      let dialog = page.getByRole('dialog', { name: `عقدة جديدة تحت ${college.title}` });
      await keyboardDialog(page, add, dialog);
      await typeInto(page, dialog.getByLabel('الاسم', { exact: true }), dept);
      await press(page, dialog.getByRole('button', { name: 'أنشئ' }));
      await expect(dialog).toBeHidden();
      await expect.poll(async () => (await byTitle(dept))?.parent_id).toBe(collegeId);

      const edit = page.getByRole('button', { name: `عدّل ${dept}` });
      dialog = page.getByRole('dialog', { name: `تعديل «${dept}»` });
      await keyboardDialog(page, edit, dialog);
      await typeInto(page, dialog.getByLabel('الاسم', { exact: true }), deptRenamed);
      await press(page, dialog.getByRole('button', { name: 'احفظ' }));
      await expect(dialog).toBeHidden();
      await expect.poll(async () => !!(await byTitle(deptRenamed))).toBe(true);

      const move = page.getByRole('button', { name: `انقل ${deptRenamed}` });
      dialog = page.getByRole('dialog', { name: `نقل «${deptRenamed}»` });
      await keyboardDialog(page, move, dialog);
      const target = await arrowSelect(page, dialog.getByLabel('الوجهة'));
      expect(target).not.toBe('');
      await press(page, dialog.getByRole('button', { name: 'انقل', exact: true }));
      await expect(dialog).toBeHidden();
      await expect.poll(async () => (await byTitle(deptRenamed))?.parent_id).not.toBe(collegeId);

      // the moved department is in another branch now: archive it from its new place in the tree
      const moved = (await byTitle(deptRenamed))!;
      await page.goto(`/admin/tree?node=${moved.parent_id}`);
      const archive = page.getByRole('button', { name: `أرشف ${deptRenamed}` });
      const confirm = page.getByRole('alertdialog');
      await keyboardDialog(page, archive, confirm);
      await expect(confirm).toContainText('لا يُحذف شيء');
      await press(page, confirm.getByRole('button', { name: 'أرشف', exact: true }));
      await expect.poll(async () => (await byTitle(deptRenamed))?.status).toBe('archived');
    });

    await test.step('«الرموز والدعوات»: create a code and revoke it, by keyboard', async () => {
      await page.goto(`/admin/codes?node=${w.subject.id}`);
      await expect(page.getByRole('heading', { level: 1, name: 'الرموز والدعوات' })).toBeVisible();
      await press(page, page.getByRole('button', { name: 'أنشئ', exact: true }));
      await expect(page.getByRole('region', { name: 'رمز الانضمام الجديد' }).locator('code')).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      const codes = await w.owner.get<JoinCodesResponse>(`/api/channels/nodes/${w.subject.id}/codes`);
      const fresh = codes.codes.filter((c) => c.kind === 'class_code' && !c.revoked_at).sort((a, b) => b.created_at - a.created_at)[0]!;
      const revoke = page.getByRole('button', { name: `ألغِ الرمز …${fresh.hint}` });
      const confirm = page.getByRole('alertdialog');
      await keyboardDialog(page, revoke, confirm);
      await press(page, confirm.getByRole('button', { name: 'ألغِ الرمز' }));
      await expect.poll(async () => (await w.owner.get<JoinCodesResponse>(`/api/channels/nodes/${w.subject.id}/codes`)).codes.find((c) => c.id === fresh.id)?.revoked_at ?? null).not.toBeNull();
    });

    await test.step('«الأعضاء وطلبات الانضمام»: reject a request with a reason, by keyboard', async () => {
      const ctx = await playwright.request.newContext({ baseURL });
      const student = { username: `kb_${w.stamp}`, display_name: `طالب لوحة المفاتيح ${w.stamp}` };
      try {
        const code = await w.owner.post<CreateJoinCodeResponse>(`/api/channels/nodes/${w.subject.id}/codes`, { kind: 'class_code', expires_in_hours: 24, requires_approval: true });
        await registerStudent(ctx, student, { code: code.code! });
      } finally {
        await ctx.dispose();
      }
      await page.goto(`/admin/members?node=${w.subject.id}`);
      await expect(page.getByRole('heading', { level: 1, name: /الأعضاء/ })).toBeVisible();
      const reject = page.getByRole('button', { name: `ارفض ${student.display_name}` });
      const dialog = page.getByRole('dialog', { name: `رفض طلب ${student.display_name}` });
      await keyboardDialog(page, reject, dialog);
      await typeInto(page, dialog.getByRole('textbox'), 'الرمز لمجموعة أخرى؛ اطلب رمز مجموعتك.');
      await press(page, dialog.getByRole('button', { name: 'ارفض', exact: true }));
      await expect(dialog).toBeHidden();
      await expect(page.locator('li').filter({ hasText: student.display_name })).toHaveCount(0);
    });

    await test.step('«الأدوار»: grant a role with the arrow keys, revoke it in its confirm dialog — by keyboard', async () => {
      await page.goto(`/admin/roles?node=${w.subject.id}`);
      await expect(page.getByRole('heading', { level: 1, name: 'الأدوار' })).toBeVisible();
      const who = await arrowSelect(page, page.getByLabel('الشخص'));
      expect(who).not.toBe('');
      await arrowSelect(page, page.getByLabel('الدور'));
      const role = await page.getByLabel('الدور').evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex]?.text ?? '');
      await press(page, page.getByRole('button', { name: 'امنح الدور' }));
      const here = page.locator('li').filter({ hasText: 'على هذه العقدة' }).filter({ hasText: who }).filter({ hasText: role });
      await expect(here).toBeVisible();
      const revoke = here.getByRole('button', { name: new RegExp(`^اسحب دور ${role} من `) });
      const confirm = page.getByRole('alertdialog');
      await keyboardDialog(page, revoke, confirm);
      await press(page, confirm.getByRole('button', { name: 'اسحب الدور' }));
      await expect(here).toHaveCount(0);
    });

    await test.step('«الإشراف»: hide a reported explanation with a reason, by keyboard', async () => {
      const hasan = w.people.hasan as Member;
      const reem = w.people.reem as Member;
      const copy = await startCopy(w, hasan, { mode: 'personal' });
      const ids = await pageIds(hasan, copy.source_id, copy.lecture!.version_id);
      const layer = await createLayer(hasan, copy.source_id, 'شرحي');
      await push(hasan, [op('annotation', `${w.stamp}KB1`.toUpperCase(), { kind: 'text', tool: 'text', anchor: anchorOf(copy.source_id, copy.lecture!.version_id, ids, 0), layer: 'text', z: 0, locked: false, layer_id: layer, data: { v: 1, text: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'شرح للإبلاغ' }] }] }, box: { x: 0.2, y: 0.6, w: 0.4, h: 0.05 }, color: 'ink-blue', font_scale: 1 } }, 'append')]);
      const title = `شرح حسن للوحة المفاتيح ${w.stamp}`;
      const pub = await publishApi(w, hasan, [layer], title);
      await reem.api.post('/api/moderation/reports', { target: { db: 'system', type: 'publication', id: pub.id }, reason: 'wrong_content', note: 'خطأ' });

      await page.goto(`/admin/moderation?node=${w.subject.id}`);
      await expect(page.getByRole('heading', { level: 1, name: 'الإشراف' })).toBeVisible();
      const row = page.locator('li.ad-report').filter({ hasText: title });
      await expect(row).toBeVisible();
      const hide = row.getByRole('button', { name: 'أخفِ مع السبب' });
      const dialog = page.getByRole('dialog', { name: 'أخفِ مع السبب' });
      await keyboardDialog(page, hide, dialog);
      await typeInto(page, dialog.getByLabel('السبب (يقرؤه الكاتب والمُبلِّغ)'), 'معلومة خاطئة في الصفحة 1.');
      await press(page, dialog.getByRole('button', { name: 'أخفِ', exact: true }));
      await expect(page.getByText('أُخفي المحتوى وأُبلغ الكاتب والمُبلِّغ.')).toBeVisible();
    });

    await test.step('«المحتوى الرسمي»: publish a new version with a change note, by keyboard (C3 review: the one admin dialog the spec had not reached)', async () => {
      const mod = w.people.mod as Member;
      const v2 = await uploadOfficial(mod, w.spaceId, w.lecture.id, 'lecture8-v2.pdf', pdfFrom(fixturePages('Lecture 8 v2', 2, 82_000), { tag: `KB V2 ${w.stamp}` }));
      await page.goto('/admin');
      await press(page, page.getByRole('link', { name: /^المحتوى الرسمي/ }));
      await expect(page.getByRole('heading', { level: 1, name: /المحتوى الرسمي/ })).toBeVisible();
      if (!page.url().includes(w.subject.id)) await page.goto(`${new URL(page.url()).pathname}?node=${w.subject.id}`);
      const scope = page.getByLabel('المادة', { exact: true });
      await expect(scope.or(page.locator('.lec-admin__scope-line'))).toBeVisible();
      if (await scope.isVisible()) await scope.selectOption(w.subject.id);
      const publish = page.getByRole('button', { name: 'انشر الإصدار 2' });
      // the button is offered once the file is processed (the screen says so meanwhile): reload until it is
      await expect
        .poll(
          async () => {
            if (await publish.isEnabled().catch(() => false)) return true;
            await page.reload();
            if (await scope.isVisible().catch(() => false)) await scope.selectOption(w.subject.id);
            return publish.isEnabled().catch(() => false);
          },
          { timeout: 180_000, intervals: [2_000] },
        )
        .toBe(true);
      const dialog = page.getByRole('dialog', { name: /^نشر الإصدار 2 من/ });
      await keyboardDialog(page, publish, dialog);
      await typeInto(page, dialog.getByLabel('ملاحظة التغيير (يراها الطلاب)'), 'صُحّحت الصفحة 2.');
      await press(page, dialog.getByRole('button', { name: 'انشر للطلاب' }));
      await expect(dialog).toBeHidden();
      await expect.poll(async () => (await w.owner.get<OfficialLectureDetail>(w.S(`/lectures/${w.lecture.id}`))).head_version?.id, { timeout: 60_000 }).toBe(v2);
    });

    await test.step('«المحتوى الرسمي»: withdraw a lecture with a reason, by keyboard', async () => {
      await page.goto('/admin');
      await press(page, page.getByRole('link', { name: /^المحتوى الرسمي/ }));
      await expect(page.getByRole('heading', { level: 1, name: /المحتوى الرسمي/ })).toBeVisible();
      if (!page.url().includes(w.subject.id)) await page.goto(`${new URL(page.url()).pathname}?node=${w.subject.id}`);
      // when this owner manages more than one subject (other specs share the server), the scope is a native <select>
      // — operable by keyboard by the browser itself; choosing it is set-up here, not the dialog under test
      const scope = page.getByLabel('المادة', { exact: true });
      await expect(scope.or(page.locator('.lec-admin__scope-line'))).toBeVisible();
      if (await scope.isVisible()) await scope.selectOption(w.subject.id);
      const lectureRow = page.locator('li, article, section').filter({ hasText: w.lecture.title }).filter({ has: page.getByRole('button', { name: 'اسحب', exact: true }) }).last();
      const withdraw = lectureRow.getByRole('button', { name: 'اسحب', exact: true });
      const confirm = page.getByRole('alertdialog');
      await keyboardDialog(page, withdraw, confirm);
      await typeInto(page, confirm.getByRole('textbox'), 'استُبدلت بنسخة مصححة.');
      await screenshot(page, testInfo, 'c3-admin-keyboard-withdraw');
      await press(page, confirm.getByRole('button', { name: 'اسحب المحاضرة' }));
      await expect(confirm).toBeHidden();
      await expect
        .poll(async () => (await w.owner.get<OfficialLectureDetail>(w.S(`/lectures/${w.lecture.id}`))).status)
        .toBe('withdrawn');
    });
  } finally {
    await w.dispose();
  }
});
