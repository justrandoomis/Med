// Academic OS AC-01a (PRD §3.2 rule 8 split, §9; ARCHITECTURE_DELTA §15.3; BUILD_PLAN §3.6) — replaces
// e2e/g1-ac01-personal-library.spec.ts. Every step of today's AC-01 passes for a user who has NO channel, through the
// real screens of the REAL server, phone 390 × 844 and desktop 1280 × 800: a surgery notebook, a course, a lecture, a
// reference and a question source; the course groups them by role. Those screens show no channel UI. The five
// destinations of the app shell keep every earlier screen reachable («الإعدادات» and «مركز التحكم» under «أنا»).
// The vocabulary bans and the four-label assertion of the old spec are retired with the five-destination navigation
// (PRD rule 8 replacement; IA §3.1); AC-01b (no cross-user leakage) is apps/server/test/acceptance/ac01b*.test.ts.
import type { ChannelNodeDetail, LibraryTreeResponse } from '@medlevo/shared';
import { join } from 'node:path';
import { expect, GOLDEN_DIR, screenshot, setupOwner, test } from './support';
import { buildWorld, createCode, ownerSession, registerStudent, stampFor, STUDENT_PASSWORD } from './aos-p1-channels-helpers';
import { reEscape } from './g1-helpers';

/** what a channel would add to a screen — none of it may appear on the personal-library screens of a user without one */
const CHANNEL_UI = /(القنوات|قناة|موادي من القنوات|موجودة رسميًا|رسمي|انضم|رمز الانضمام|مشرف المادة|تابع المادة|ابدأ الدراسة)/;

test.describe('AC-01a — the personal library for a user with no channel', () => {
  test('notebook → course → lecture / reference / question source through the screens; the course groups them by role', async ({ page, playwright, baseURL }, testInfo) => {
    test.setTimeout(240_000);
    const stamp = stampFor(testInfo.project.name);

    const userId = await test.step('a new account whose only join request was declined: it belongs to no channel', async () => {
      const owner = await ownerSession(playwright, baseURL!);
      try {
        const w = await buildWorld(owner.api, stamp);
        const code = await createCode(owner.api, w.approval.id, 'class_code', true);
        const r = await registerStudent(page.request, { username: `layla_${stamp}`, display_name: `ليلى ${stamp}` }, { code: code.code! });
        expect(r.membership?.status).toBe('pending');
        await owner.api.post(`/api/channels/nodes/${w.approval.id}/members/${r.user.id}/decision`, { decision: 'reject', reason: 'المادة لطلاب المرحلة الثالثة فقط.' });
        const seen = (await (await page.request.get(`/api/channels/nodes/${w.approval.id}`)).json()) as ChannelNodeDetail;
        expect(seen.space_id, 'no subject space for this account').toBeNull();
        expect(seen.viewer.membership?.status).toBe('rejected');
        return r.user.id;
      } finally {
        await owner.dispose();
      }
    });
    expect(userId).toBeTruthy();

    await test.step('«القنوات» says so plainly — and that the personal library works without channels', async () => {
      await page.goto('/channels');
      await expect(page.getByText('لم تنضم إلى أي مادة بعد')).toBeVisible();
      await expect(page.getByText('مكتبتك الشخصية تعمل كما هي دون قنوات.')).toBeVisible();
    });

    const notebookTitle = `الجراحة ${stamp}`;
    const courseTitle = `Course 1 — البطن الحاد ${stamp}`;
    const noChannelUi = async (where: string) => {
      const text = await page.locator('main').first().innerText();
      expect(text.match(CHANNEL_UI), `${where} shows channel UI to a user without a channel`).toBeNull();
    };

    await test.step('create the surgery notebook from the library screen', async () => {
      await page.goto('/library');
      await expect(page.getByRole('heading', { level: 1, name: 'المكتبة' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noChannelUi('/library');
      await page.getByRole('button', { name: 'جديد', exact: true }).click();
      await page.getByRole('menuitem', { name: 'دفتر جديد' }).click();
      const dialog = page.getByRole('dialog', { name: 'دفتر جديد' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('الاسم').fill(notebookTitle);
      await dialog.getByRole('button', { name: /حفظ|إنشاء/ }).click();
      await expect(dialog).toBeHidden();
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
      await expect(page.getByRole('heading', { level: 1, name: new RegExp(reEscape(courseTitle)) }).or(page.getByRole('link', { name: new RegExp(reEscape(courseTitle)) }).first())).toBeVisible();
      const tree = (await (await page.request.get('/api/library/tree')).json()) as LibraryTreeResponse;
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
        await noChannelUi('/upload');
        await page.getByLabel('نوع المصدر').selectOption(type);
        await page.locator('input[type=file]').setInputFiles(join(GOLDEN_DIR, file));
        await page.getByRole('button', { name: /^رفع ملف/ }).click();
        const accepted = page.getByRole('link', { name: 'التفاصيل والصفحات' });
        const addAnyway = page.getByRole('button', { name: 'أضفه نسخةً مستقلة' });
        await expect(accepted.or(addAnyway)).toBeVisible({ timeout: 60_000 });
        if (await addAnyway.isVisible()) await addAnyway.click();
        await expect(accepted).toBeVisible({ timeout: 60_000 });
      }
      const tree = (await (await page.request.get('/api/library/tree')).json()) as LibraryTreeResponse;
      const mine = tree.sources.filter((s) => s.node_id === notebook.course.id);
      expect(mine.map((s) => s.source_type).sort()).toEqual(['course_reference', 'lecture', 'question_source']);
      for (const s of mine) {
        expect(s.course_node_id, `${s.title}: course derived from the folder`).toBe(notebook.course.id);
        const detail = (await (await page.request.get(`/api/sources/${s.id}`)).json()) as typeof s & { source_type_origin?: string };
        expect(detail.source_type_origin, `${s.title}: the type the owner chose`).toBe('owner');
      }
    });

    await test.step('the course page groups the sources: المحاضرات / المراجع / مصادر الأسئلة — with no channel UI', async () => {
      await page.goto(`/library/${notebook.course.id}`);
      await expect(page.getByRole('heading', { level: 1, name: new RegExp(reEscape(courseTitle)) })).toBeVisible();
      const group = (title: string) => page.locator('section.ml-library__section').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });
      await expect(group('المحاضرات').getByRole('link', { name: /lecture appendicitis/i })).toBeVisible();
      await expect(group('المراجع').getByRole('link', { name: /lecture cholecystitis/i })).toBeVisible();
      await expect(group('مصادر الأسئلة').getByRole('link', { name: /questions surgery course1/i })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noChannelUi(`/library/${notebook.course.id}`);
      await screenshot(page, testInfo, 'aos-ac01a-course-groups');
      await page.goto(`/library/${notebook.nb.id}`);
      await expect(page.getByRole('heading', { level: 1, name: new RegExp(reEscape(notebookTitle)) })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noChannelUi(`/library/${notebook.nb.id}`);
    });
  });

  test.describe('the app shell', () => {
    // The Control Center asks every account for the server's off-site backup status (GET /api/data/offsite, PL-0),
    // which is the platform admin's alone: another account gets the plain 404 and the browser logs it. The screen
    // itself shows no error (features/control — not this track's; reported in the P1-T4 step 3 report).
    test.use({ allowedConsoleErrors: [/status of 404/] });

    // Review of P1-T4 step 3 (R6): the five destinations, the bell and the save status made the top bar wider than an iPad
    // in portrait (768 / 820 px: the page scrolled sideways) and at 150 % text on every iPad; its destination links were
    // 36 px tall on touch. iPad + Apple Pencil is the first device (owner clarifications), so the shell is measured on a
    // 390 px phone and on iPad mini / Air portrait and landscape, at 100 % and 150 % text.
    test('the shell fits a 390 px phone and iPad sizes at 100 % and 150 % text: no sideways scroll, 44 px touch targets', async ({ browser, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'one run covers every size (each size opens its own touch context)');
      const sizes = [
        { name: 'phone 390', width: 390, height: 844 },
        { name: 'iPad mini portrait', width: 768, height: 1024 },
        { name: 'iPad Air portrait', width: 820, height: 1180 },
        { name: 'iPad mini landscape', width: 1133, height: 744 },
        { name: 'iPad Air landscape', width: 1180, height: 820 },
      ];
      const problems: string[] = [];
      for (const size of sizes) {
        const context = await browser.newContext({ baseURL, locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block', viewport: { width: size.width, height: size.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        try {
          const page = await context.newPage();
          await setupOwner(page);
          for (const scale of ['1', '1.5']) {
            await page.goto('/');
            await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
            await page.evaluate((s) => {
              document.documentElement.style.setProperty('--ml-text-scale', s);
              document.documentElement.setAttribute('data-text-scale', s);
            }, scale);
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            const m = await page.evaluate(() => {
              const shown = (el: Element) => {
                const b = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
              };
              const controls = Array.from(document.querySelectorAll<HTMLElement>('header.ml-topbar a, header.ml-topbar button, nav.ml-tabbar a')).filter(shown);
              return {
                overflow: document.scrollingElement!.scrollWidth - window.innerWidth,
                // a mobile browser widens the layout viewport to fit content wider than the device
                layout: window.innerWidth,
                controls: controls.map((el) => {
                  const b = el.getBoundingClientRect();
                  return { name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30), h: b.height, w: b.width, left: b.left, right: b.right };
                }),
              };
            });
            const at = `${size.name} @ ${scale === '1' ? '100' : '150'} %`;
            if (m.layout > size.width || m.overflow > 0) problems.push(`${at}: the page is ${Math.max(m.layout, size.width + m.overflow)} px wide on a ${size.width} px screen (sideways scroll)`);
            for (const c of m.controls) {
              if (c.h < 43.5 || c.w < 43.5) problems.push(`${at}: «${c.name}» is ${Math.round(c.w)}×${Math.round(c.h)} px (< 44 px touch target)`);
              if (c.left < -0.5 || c.right > size.width + 0.5) problems.push(`${at}: «${c.name}» lies outside the screen`);
            }
            const nav = page.getByRole('navigation', { name: 'التنقل الرئيسي' }).filter({ visible: true });
            await expect(nav.getByRole('link')).toHaveText(['الرئيسية', 'المكتبة', 'القنوات', 'المراجعة', 'أنا']);
            if (scale === '1.5') await screenshot(page, testInfo, `aos-shell-${size.width}x${size.height}-150`, { healthy: false });
          }
        } finally {
          await context.close();
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });

    test('the five destinations keep every earlier screen reachable; no channel administration without a role', async ({ page, playwright, baseURL }, testInfo) => {
      const stamp = stampFor(testInfo.project.name);
      const owner = await ownerSession(playwright, baseURL!);
      try {
        const w = await buildWorld(owner.api, stamp);
        const code = await createCode(owner.api, w.approval.id, 'class_code', true);
        const r = await registerStudent(page.request, { username: `sami_${stamp}`, display_name: `سامي ${stamp}` }, { code: code.code! });
        await owner.api.post(`/api/channels/nodes/${w.approval.id}/members/${r.user.id}/decision`, { decision: 'reject' });
      } finally {
        await owner.dispose();
      }

      await test.step('main navigation: الرئيسية، المكتبة، القنوات، المراجعة، أنا', async () => {
        await page.goto('/');
        const nav = page.getByRole('navigation', { name: 'التنقل الرئيسي' });
        await expect(nav.getByRole('link')).toHaveText(['الرئيسية', 'المكتبة', 'القنوات', 'المراجعة', 'أنا']);
        await expect(nav.getByRole('link', { name: 'الرئيسية' })).toHaveAttribute('aria-current', 'page');
      });

      await test.step('every earlier screen opens: Home, Library, Review, Settings and the Control Center (via «أنا»), Downloads', async () => {
        const nav = page.getByRole('navigation', { name: 'التنقل الرئيسي' });
        for (const [label, heading] of [
          ['الرئيسية', 'الرئيسية'],
          ['المكتبة', 'المكتبة'],
          ['المراجعة', 'المراجعة'],
          ['أنا', 'أنا'],
        ] as const) {
          await nav.getByRole('link', { name: label, exact: true }).click();
          await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        }
        for (const [link, heading] of [
          [/^الإعدادات/, 'الإعدادات'],
          [/^مركز التحكم/, 'مركز التحكم'],
          [/^التنزيلات/, null],
        ] as const) {
          await nav.getByRole('link', { name: 'أنا', exact: true }).click();
          await page.getByRole('main').getByRole('link', { name: link }).click();
          if (heading) await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
          else await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
          // the sub-pages of «أنا» keep it as the current destination
          await expect(nav.getByRole('link', { name: 'أنا', exact: true })).toHaveAttribute('aria-current', 'page');
        }
        await page.goto('/me');
        await expect(page.getByRole('link', { name: /إدارة القنوات/ }), 'no role → no administration entry').toHaveCount(0);
        await screenshot(page, testInfo, 'aos-ac01a-me');
      });

      await test.step('typed URLs of screens that do not exist — and of «إدارة القنوات» without a role — are the missing page', async () => {
        for (const path of ['/admin', '/admin/tree', '/users', '/members', '/roles', '/organization', '/subscription', '/billing', '/settings/users', '/control/users', '/team']) {
          await page.goto(path);
          await expect(page.getByRole('heading', { name: 'هذه الصفحة غير موجودة' }), path).toBeVisible();
        }
      });

      await test.step('no open sign-up: registration needs a join proof; setup is closed once the owner exists', async () => {
        const anon = await playwright.request.newContext({ baseURL });
        try {
          const setup = await anon.post('/api/auth/setup', { headers: { 'x-medlevo-csrf': '1' }, data: { username: 'second', password: 'another person 12345' } });
          expect([403, 409]).toContain(setup.status());
          const bare = await anon.post('/api/auth/register', { headers: { 'x-medlevo-csrf': '1' }, data: { username: `free_${stamp}`, display_name: 'حر', password: STUDENT_PASSWORD } });
          expect(bare.status()).toBe(400);
          for (const path of ['/api/users', '/api/members', '/api/organizations', '/api/subscriptions', '/api/billing', '/api/library/members', '/api/auth/users', '/api/settings/users']) {
            expect((await page.request.get(path)).status(), `GET ${path}`).toBe(404);
          }
        } finally {
          await anon.dispose();
        }
      });
    });
  });
});
