// G1 / AC-01 — personal library (§60): a surgery notebook, a course, a lecture, a reference and a question source are
// created through the real screens of the REAL server; the course groups them by role. There is no university,
// users / members, roles or subscription screen anywhere — not in the navigation, not in settings or the Control
// Center, not behind a typed URL, and not in the API.
import type { CapabilitiesResponse, LibraryTreeResponse } from '@medlevo/shared';
import { join } from 'node:path';
import { expect, GOLDEN_DIR, screenshot, setupOwner, test } from './support';
import { reEscape } from './g1-helpers';

/** words of institution / multi-user / commercial screens (Arabic + English) that must never appear in the owner UI */
const FORBIDDEN_UI = /(جامعة|الجامعة|الجامعات|كلية|اشتراك|الاشتراك|اشتراكات|الباقة|الفوترة|الدفع|المستخدمين|مستخدمون|الأعضاء|أعضاء|دعوة|المشرف|إدارة المستخدمين|صلاحيات|الطلاب|دفعة دراسية|university|subscription|billing|pricing|tenant|organi[sz]ation|cohort|admin|members?\b|invite|roles?\b)/i;

test.describe('G1 AC-01 personal library', () => {
  test('notebook → course → lecture / reference / question source through the screens; course groups them by role', async ({ page, api }, testInfo) => {
    await setupOwner(page);
    const stamp = `${Date.now().toString(36)}-${testInfo.project.name}`;
    const notebookTitle = `الجراحة ${stamp}`;
    const courseTitle = `Course 1 — البطن الحاد ${stamp}`;

    await test.step('create the surgery notebook from the library screen', async () => {
      await page.goto('/library');
      await expect(page.getByRole('heading', { level: 1, name: 'المكتبة' })).toBeVisible();
      await page.getByRole('button', { name: 'جديد', exact: true }).click();
      await page.getByRole('menuitem', { name: 'دفتر جديد' }).click();
      const dialog = page.getByRole('dialog', { name: 'دفتر جديد' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('الاسم').fill(notebookTitle);
      await dialog.getByRole('button', { name: /حفظ|إنشاء/ }).click();
      await expect(dialog).toBeHidden();
      // the new notebook opens right away
      await expect(page.getByRole('heading', { level: 1, name: new RegExp(reEscape(notebookTitle)) })).toBeVisible();
      await page.getByRole('navigation', { name: 'مسار التنقل' }).getByRole('link', { name: 'المكتبة' }).click();
      await expect(page.getByRole('link', { name: new RegExp(reEscape(notebookTitle)) }).first()).toBeVisible();
    });

    const notebook = await test.step('open it from the shelf and create a course inside', async () => {
      await page.getByRole('link', { name: new RegExp(reEscape(notebookTitle)) }).first().click();
      await expect(page.getByRole('heading', { level: 1, name: new RegExp(reEscape(notebookTitle)) })).toBeVisible();
      await page.getByRole('button', { name: 'جديد', exact: true }).click();
      await page.getByRole('menuitem', { name: 'كورس' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('الاسم').fill(courseTitle);
      await dialog.getByRole('button', { name: /حفظ|إنشاء/ }).click();
      await expect(dialog).toBeHidden();
      // either the new course opens right away or it is listed in the notebook
      await expect(page.getByRole('heading', { level: 1, name: new RegExp(reEscape(courseTitle)) }).or(page.getByRole('link', { name: new RegExp(reEscape(courseTitle)) }).first())).toBeVisible();
      const tree = await api.get<LibraryTreeResponse>('/api/library/tree');
      const nb = tree.nodes.find((n) => n.title === notebookTitle);
      const course = tree.nodes.find((n) => n.title === courseTitle);
      expect(nb?.kind, 'the notebook is a notebook at the root of the personal library').toBe('notebook');
      expect(nb?.parent_id).toBeNull();
      expect(course?.kind).toBe('course');
      expect(course?.parent_id).toBe(nb!.id);
      return { nb: nb!, course: course! };
    });

    await test.step('upload a lecture, a reference and a question source through the upload screen (owner-chosen types)', async () => {
      for (const [file, type] of [
        ['lecture_appendicitis.pdf', 'lecture'],
        ['lecture_cholecystitis.pdf', 'course_reference'],
        ['questions_surgery_course1.pdf', 'question_source'],
      ] as const) {
        await page.goto(`/upload?node=${notebook.course.id}`);
        await expect(page.getByRole('heading', { level: 1, name: 'رفع مصادر' })).toBeVisible();
        await expect(page.getByText(new RegExp(reEscape(courseTitle))).first()).toBeVisible();
        await page.getByLabel('نوع المصدر').selectOption(type);
        await page.locator('input[type=file]').setInputFiles(join(GOLDEN_DIR, file));
        await page.getByRole('button', { name: /^رفع ملف/ }).click();
        const accepted = page.getByRole('link', { name: 'التفاصيل والصفحات' });
        const addAnyway = page.getByRole('button', { name: 'أضفه نسخةً مستقلة' });
        await expect(accepted.or(addAnyway)).toBeVisible({ timeout: 60_000 });
        // the same bytes are already in this library (other specs): the owner keeps a separate copy here
        if (await addAnyway.isVisible()) await addAnyway.click();
        await expect(accepted).toBeVisible({ timeout: 60_000 });
      }
      const tree = await api.get<LibraryTreeResponse>('/api/library/tree');
      const mine = tree.sources.filter((s) => s.node_id === notebook.course.id);
      expect(mine.map((s) => s.source_type).sort()).toEqual(['course_reference', 'lecture', 'question_source']);
      for (const s of mine) {
        expect(s.course_node_id, `${s.title}: course derived from the folder`).toBe(notebook.course.id);
        const detail = (await api.source(s.id)) as typeof s & { source_type_origin?: string };
        expect(detail.source_type_origin, `${s.title}: the type the owner chose`).toBe('owner');
      }
    });

    await test.step('the course page groups the sources: المحاضرات / المراجع / مصادر الأسئلة', async () => {
      await page.goto(`/library/${notebook.course.id}`);
      await expect(page.getByRole('heading', { level: 1, name: new RegExp(reEscape(courseTitle)) })).toBeVisible();
      const group = (title: string) => page.locator('section.ml-library__section').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });
      await expect(group('المحاضرات').getByRole('link', { name: /lecture appendicitis/i })).toBeVisible();
      await expect(group('المراجع').getByRole('link', { name: /lecture cholecystitis/i })).toBeVisible();
      await expect(group('مصادر الأسئلة').getByRole('link', { name: /questions surgery course1/i })).toBeVisible();
      await screenshot(page, testInfo, 'g1-ac01-course-groups');
    });
  });

  test('no university / users / roles / subscription screen anywhere (navigation, settings, typed URLs, API)', async ({ page, api, playwright, baseURL }, testInfo) => {
    await setupOwner(page);

    await test.step('main navigation: Home, Library, Review, Settings only', async () => {
      await page.goto('/');
      const nav = page.getByRole('navigation', { name: 'التنقل الرئيسي' });
      await expect(nav.getByRole('link')).toHaveText(['الرئيسية', 'المكتبة', 'المراجعة', 'الإعدادات']);
    });

    await test.step('owner screens never mention institutions, members or subscriptions', async () => {
      for (const [path, heading] of [
        ['/', 'الرئيسية'],
        ['/library', 'المكتبة'],
        ['/review', 'المراجعة'],
        ['/settings', 'الإعدادات'],
        ['/control', 'مركز التحكم'],
        ['/control/capabilities', null],
        ['/control/storage', null],
      ] as const) {
        await page.goto(path);
        if (heading) await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        else await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await page.waitForLoadState('networkidle');
        const text = await page.locator('main, [role=main]').first().innerText();
        expect(text.match(FORBIDDEN_UI), `${path} shows an institution / multi-user / subscription term`).toBeNull();
      }
      await screenshot(page, testInfo, 'g1-ac01-control-storage');
    });

    await test.step('typed URLs of such screens land on «هذه الصفحة غير موجودة»', async () => {
      for (const path of ['/admin', '/users', '/members', '/roles', '/organization', '/university', '/subscription', '/billing', '/settings/users', '/control/users', '/team', '/invite']) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: 'هذه الصفحة غير موجودة' }), path).toBeVisible();
      }
    });

    await test.step('the API has no such endpoints and no such capability', async () => {
      for (const path of ['/api/users', '/api/admin', '/api/members', '/api/roles', '/api/organizations', '/api/universities', '/api/subscriptions', '/api/billing', '/api/invitations', '/api/library/members', '/api/auth/users', '/api/settings/users']) {
        const res = await api.call('GET', path);
        expect(res.status(), `GET ${path}`).toBe(404);
      }
      // registration of a second account is impossible: setup only works while no owner exists
      const anon = await playwright.request.newContext({ baseURL });
      try {
        const res = await anon.post('/api/auth/setup', { headers: { 'x-medlevo-csrf': '1' }, data: { username: 'second', password: 'another person 12345' } });
        expect([403, 409]).toContain(res.status());
      } finally {
        await anon.dispose();
      }
      const caps = await api.get<CapabilitiesResponse>('/api/capabilities');
      const keys = Object.keys(caps.features);
      expect(keys.filter((k) => /user|member|role|tenant|org|universit|subscri|billing|cohort|admin|invite/i.test(k))).toEqual([]);
    });
  });
});
