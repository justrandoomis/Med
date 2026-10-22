// Academic OS P1-T4 step 3 — J9 «الانضمام إلى مادة» against the REAL server and the built web app, phone 390 × 844 and
// desktop 1280 × 800 (BUILD_PLAN §3.6; IA §4.1, §4.3, J9; PRD AOS-2.11–2.16, 18.13): an invite link landing that
// shows only the channel's title and creates an account with it, a class code typed in the join sheet → pending →
// approved by the moderator → an inbox entry → the subject page and «تابع المادة»; a QR read from a generated picture;
// the scanner that degrades to typing the code when the camera cannot be used, and the same scanner reading a REAL
// camera stream (Chromium's fake capture device playing a QR).
import { expect, screenshot, test } from './support';
import type { ChannelNodeDetail, JoinPreviewResponse, MeResponse, NotificationsResponse } from '@medlevo/shared';
import { axeInLooks, buildWorld, createCode, joinPath, ownerSession, qrGif, qrY4m, registerStudent, stampFor, STUDENT_PASSWORD, tokenOf } from './aos-p1-channels-helpers';

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('J9 join a subject', () => {
  test('invite link → new account with only the title shown; code → pending → approved with an inbox entry; «تابع المادة»', async ({ page, playwright, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const owner = await ownerSession(playwright, baseURL!);
    try {
      const stamp = stampFor(testInfo.project.name);
      const w = await buildWorld(owner.api, stamp);
      const link = await createCode(owner.api, w.open.id, 'invite_link', false);
      const code = await createCode(owner.api, w.approval.id, 'class_code', true);
      expect(link.link).toMatch(/\/join\/[A-Za-z0-9_-]{16,}$/);
      expect(code.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

      await test.step('the public landing of the invite link shows the channel title — and nothing else of the tree', async () => {
        // anonymous: the preview names the title, kind and policy only
        const anon = await playwright.request.newContext({ baseURL });
        try {
          const res = await anon.get(`/api/channels/join/preview?token=${tokenOf(link.link!)}`);
          expect(res.status()).toBe(200);
          const body = (await res.json()) as JoinPreviewResponse;
          expect(Object.keys(body).sort()).toEqual(['kind', 'requires_approval', 'title_ar']);
          expect(body.title_ar).toBe(w.open.title);
        } finally {
          await anon.dispose();
        }
        await page.goto(joinPath(link.link!));
        await expect(page.getByRole('heading', { level: 1, name: 'دعوة للانضمام' })).toBeVisible();
        await expect(page.getByText(`دعوة للانضمام إلى: ${w.open.title}`)).toBeVisible();
        const text = await page.locator('main').innerText();
        for (const other of [w.university.title, w.college.title, w.approval.title]) expect(text, 'the landing names only the invited channel').not.toContain(other);
        await expect(page.getByRole('link', { name: 'لدي حساب — سجّل الدخول' })).toHaveAttribute('href', `/login?next=${encodeURIComponent(joinPath(link.link!))}`);
        await screenshot(page, testInfo, 'aos-j9-invite-landing');
        expect(await axeInLooks(page, 'invite landing')).toEqual([]);
      });

      await test.step('create an account with this invitation → recovery codes → joined', async () => {
        await page.getByRole('button', { name: 'أنشئ حسابًا بهذه الدعوة' }).click();
        const form = page.getByRole('form', { name: 'حساب جديد بهذه الدعوة' });
        await form.getByLabel('الاسم الظاهر').fill(`سارة ${stamp}`);
        await form.getByLabel('اسم المستخدم').fill(`sara_${stamp}`);
        await form.getByLabel('كلمة المرور', { exact: true }).fill(STUDENT_PASSWORD);
        await form.getByLabel('تأكيد كلمة المرور').fill(STUDENT_PASSWORD);
        await form.getByRole('button', { name: 'أنشئ الحساب وانضم' }).click();
        await expect(page.getByText('أُنشئ حسابك. احفظ رموز الاسترداد')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText('تم الانضمام')).toBeVisible();
        const proceed = page.getByRole('button', { name: 'متابعة إلى القنوات' });
        await expect(proceed).toBeDisabled();
        await page.getByRole('checkbox').check();
        await proceed.click();
        await expect(page.getByRole('heading', { level: 1, name: 'القنوات' })).toBeVisible();
        const mine = page.getByRole('region', { name: 'قنواتي' });
        await expect(mine.getByRole('link', { name: new RegExp(reEscape(w.open.title)) })).toBeVisible();
      });

      const me = (await (await page.request.get('/api/accounts/me')).json()) as MeResponse;

      await test.step('type the class code in the join sheet → «طلبك قيد المراجعة»', async () => {
        await page.getByRole('button', { name: 'انضم برمز أو QR' }).click();
        const sheet = page.getByRole('dialog', { name: 'انضم إلى مادة' });
        // a phone keyboard in Arabic: lower case, spaces and Arabic-Indic digits are read as the code
        await sheet.getByLabel('رمز الانضمام أو رابط الدعوة').fill(code.code!.toLowerCase().replace('-', ' '));
        await screenshot(page, testInfo, 'aos-j9-join-sheet');
        await sheet.getByRole('button', { name: 'انضم', exact: true }).click();
        await expect(sheet.getByText('طلبك قيد المراجعة')).toBeVisible();
        await sheet.getByRole('button', { name: 'تم' }).click();
        await expect(sheet).toBeHidden();
        const pending = page.getByRole('region', { name: 'طلبات معلّقة' });
        await expect(pending.getByText(w.approval.title)).toBeVisible();
        await screenshot(page, testInfo, 'aos-j9-channels-pending');
        // the subject page says so too, without any lecture of the subject
        await page.goto(`/subjects/${w.approval.id}`);
        await expect(page.getByText('طلبك قيد المراجعة').first()).toBeVisible();
        await expect(page.getByRole('tab', { name: /المحاضرات/ })).toHaveCount(0);
      });

      await test.step('the moderator approves → an unread inbox entry that opens the subject', async () => {
        await owner.api.post(`/api/channels/nodes/${w.approval.id}/members/${me.id}/decision`, { decision: 'approve' });
        await page.goto('/');
        const bell = page.getByRole('link', { name: /^التنبيهات، \d+ غير مقروءة?$/ });
        await expect(bell).toBeVisible();
        await bell.click();
        await expect(page.getByRole('heading', { level: 1, name: 'التنبيهات' })).toBeVisible();
        const entry = page.getByRole('link', { name: new RegExp(`قُبل طلب انضمامك إلى «${reEscape(w.approval.title)}»`) });
        await expect(entry).toBeVisible();
        await expect(page.locator('.nt-row--unread').filter({ has: entry }).getByText('غير مقروء')).toBeVisible();
        await screenshot(page, testInfo, 'aos-j9-inbox');
        expect(await axeInLooks(page, 'inbox')).toEqual([]);
        await entry.click();
        await expect(page).toHaveURL(new RegExp(`/subjects/${w.approval.id}`));
        await expect(page.getByRole('heading', { level: 1, name: w.approval.title })).toBeVisible();
        const inbox = await (await page.request.get('/api/notifications')).json() as NotificationsResponse;
        const n = inbox.items.find((i) => i.kind === 'join_decided' && i.text_ar.includes(w.approval.title));
        expect(n?.read_at, 'opening the entry marks it read').not.toBeNull();
      });

      await test.step('the subject page: honest empty tabs and «تابع المادة» kept on the server', async () => {
        await expect(page.getByRole('tab', { name: /المحاضرات/ })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByText('لا توجد محاضرات رسمية منشورة في هذه المادة بعد.')).toBeVisible();
        const follow = page.getByRole('switch', { name: 'تابع المادة' });
        await expect(follow).toHaveAttribute('aria-checked', 'false');
        await follow.click();
        await expect(follow).toHaveAttribute('aria-checked', 'true');
        await expect.poll(async () => ((await (await page.request.get(`/api/channels/nodes/${w.approval.id}`)).json()) as ChannelNodeDetail).viewer.course_follow).not.toBeNull();
        await page.reload();
        await expect(page.getByRole('switch', { name: 'تابع المادة' })).toHaveAttribute('aria-checked', 'true');
        await screenshot(page, testInfo, 'aos-j9-subject-lectures');
        expect(await axeInLooks(page, 'subject lectures')).toEqual([]);
        for (const [tab, empty] of [
          ['الملفات', /لا توجد ملفات بعد/],
          ['التحديثات', /لا تحديثات بعد/],
        ] as const) {
          await page.getByRole('tab', { name: new RegExp(tab) }).click();
          await expect(page.getByRole('tabpanel')).toContainText(empty);
          await expect(page).toHaveURL(/tab=/);
          await screenshot(page, testInfo, `aos-j9-subject-${tab === 'الملفات' ? 'files' : 'updates'}`);
          expect(await axeInLooks(page, `subject ${tab}`)).toEqual([]);
        }
        // «قنواتي» marks the followed subject
        await page.goto('/channels');
        await expect(page.getByRole('link', { name: new RegExp(`${reEscape(w.approval.title)}.*تتابعها`) })).toBeVisible();
        expect(await axeInLooks(page, 'channels home')).toEqual([]);
      });
    } finally {
      await owner.dispose();
    }
  });

  test('QR read from a picture; without a camera the scanner hands back to the code field', async ({ page, playwright, baseURL }, testInfo) => {
    const owner = await ownerSession(playwright, baseURL!);
    try {
      const stamp = stampFor(testInfo.project.name);
      const w = await buildWorld(owner.api, stamp);
      const classCode = await createCode(owner.api, w.approval.id, 'class_code', true);
      const link = await createCode(owner.api, w.open.id, 'invite_link', false);
      await registerStudent(page.request, { username: `ali_${stamp}`, display_name: `علي ${stamp}` }, { code: classCode.code! });

      await page.goto('/channels');
      await page.getByRole('button', { name: 'انضم برمز أو QR' }).click();
      const sheet = page.getByRole('dialog', { name: 'انضم إلى مادة' });
      const field = sheet.getByLabel('رمز الانضمام أو رابط الدعوة');

      await test.step('no camera allowed here: an Arabic reason, and the code field takes over', async () => {
        await sheet.getByRole('button', { name: 'امسح رمز QR' }).click();
        await expect(sheet.getByRole('status').filter({ hasText: /كاميرا/ })).toBeVisible({ timeout: 15_000 });
        await expect(field).toBeFocused();
        await expect(sheet.getByRole('button', { name: 'امسح رمز QR' })).toBeVisible();
        await screenshot(page, testInfo, 'aos-j9-no-camera');
      });

      await test.step('a picture of the QR → the channel title first → «انضم إلى …» → joined', async () => {
        await sheet.locator('input[type=file]').setInputFiles({ name: 'qr.gif', mimeType: 'image/gif', buffer: qrGif(link.qr_payload ?? link.link!) });
        await expect(sheet.getByText(`دعوة للانضمام إلى: ${w.open.title}`)).toBeVisible({ timeout: 15_000 });
        await expect(sheet.getByText('تنضم مباشرة.')).toBeVisible();
        await screenshot(page, testInfo, 'aos-j9-qr-preview');
        await sheet.getByRole('button', { name: `انضم إلى ${w.open.title}` }).click();
        await expect(sheet.getByText('تم الانضمام')).toBeVisible();
        await sheet.getByRole('link', { name: 'افتح المادة' }).click();
        await expect(page).toHaveURL(new RegExp(`/subjects/${w.open.id}`));
        await expect(page.getByRole('heading', { level: 1, name: w.open.title })).toBeVisible();
      });
    } finally {
      await owner.dispose();
    }
  });

  test('the in-app scanner decodes a QR from a real camera stream (Chromium fake capture device)', async ({ playwright, baseURL }, testInfo) => {
    const owner = await ownerSession(playwright, baseURL!);
    const stamp = stampFor(testInfo.project.name);
    const w = await buildWorld(owner.api, stamp);
    const link = await createCode(owner.api, w.open.id, 'invite_link', false);
    const code = await createCode(owner.api, w.approval.id, 'class_code', true);
    const video = qrY4m(link.qr_payload ?? link.link!);
    const browser = await playwright.chromium.launch({
      executablePath: process.env.PW_CHROMIUM_PATH || '/opt/pw-browsers/chromium',
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
    });
    try {
      const { viewport, isMobile, hasTouch, deviceScaleFactor } = testInfo.project.use;
      const context = await browser.newContext({ baseURL, locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block', permissions: ['camera'], viewport, isMobile, hasTouch, deviceScaleFactor });
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(e.message));
      page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
      await registerStudent(page.request, { username: `noor_${stamp}`, display_name: `نور ${stamp}` }, { code: code.code! });
      await page.goto('/channels');
      await page.getByRole('button', { name: 'انضم برمز أو QR' }).click();
      const sheet = page.getByRole('dialog', { name: 'انضم إلى مادة' });
      await sheet.getByRole('button', { name: 'امسح رمز QR' }).click();
      await expect(sheet.getByText(`دعوة للانضمام إلى: ${w.open.title}`)).toBeVisible({ timeout: 30_000 });
      await sheet.getByRole('button', { name: `انضم إلى ${w.open.title}` }).click();
      await expect(sheet.getByText('تم الانضمام')).toBeVisible();
      const detail = (await (await page.request.get(`/api/channels/nodes/${w.open.id}`)).json()) as ChannelNodeDetail;
      expect(detail.viewer.membership?.status).toBe('approved');
      expect(problems).toEqual([]);
      await context.close();
    } finally {
      await browser.close();
      await owner.dispose();
    }
  });

  test.describe('offline and keyboard', () => {
    test.use({ allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch|NetworkError|net::ERR/i] });

    test('offline: «القنوات» and the subject page from the copy on this device, read-only with the reason (AOS-20.17)', async ({ page, playwright, baseURL }, testInfo) => {
      const owner = await ownerSession(playwright, baseURL!);
      const stamp = stampFor(testInfo.project.name);
      try {
        const w = await buildWorld(owner.api, stamp);
        const code = await createCode(owner.api, w.open.id, 'class_code', false);
        await registerStudent(page.request, { username: `ward_${stamp}`, display_name: `وارد ${stamp}` }, { code: code.code! });
      } finally {
        await owner.dispose();
      }
      const nav = page.getByRole('navigation', { name: 'التنقل الرئيسي' });
      // online first: the screens keep their last answer on this device
      await page.goto('/channels');
      const subjectLink = page.getByRole('region', { name: 'قنواتي' }).getByRole('link').first();
      await expect(subjectLink).toBeVisible();
      await subjectLink.click();
      await expect(page.getByRole('switch', { name: 'تابع المادة' })).toBeVisible();
      await nav.getByRole('link', { name: 'أنا', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'أنا' })).toBeVisible();
      await page.context().setOffline(true);
      try {
        await nav.getByRole('link', { name: 'القنوات', exact: true }).click();
        await expect(page.getByText(/تعرض نسخة محفوظة على هذا الجهاز/)).toBeVisible();
        const join = page.getByRole('button', { name: 'انضم برمز أو QR' });
        await expect(join).toBeDisabled();
        await expect(page.getByText('الانضمام يحتاج اتصالًا بالإنترنت.').first()).toBeVisible();
        await screenshot(page, testInfo, 'aos-j9-channels-offline');
        await page.getByRole('region', { name: 'قنواتي' }).getByRole('link').first().click();
        await expect(page.getByText(/تعرض نسخة محفوظة على هذا الجهاز/)).toBeVisible();
        await expect(page.getByRole('switch', { name: 'تابع المادة' })).toBeDisabled();
        await screenshot(page, testInfo, 'aos-j9-subject-offline');
      } finally {
        await page.context().setOffline(false);
      }
    });

    test('keyboard only: open the join sheet, type a code, join, close (AOS-19L.4)', async ({ page, playwright, baseURL }, testInfo) => {
      const owner = await ownerSession(playwright, baseURL!);
      const stamp = stampFor(testInfo.project.name);
      let second = '';
      try {
        const w = await buildWorld(owner.api, stamp);
        const first = await createCode(owner.api, w.approval.id, 'class_code', true);
        second = (await createCode(owner.api, w.open.id, 'class_code', false)).code!;
        await registerStudent(page.request, { username: `key_${stamp}`, display_name: `مفاتيح ${stamp}` }, { code: first.code! });
      } finally {
        await owner.dispose();
      }
      await page.goto('/channels');
      const joinButton = page.getByRole('button', { name: 'انضم برمز أو QR' });
      await expect(joinButton).toBeVisible();
      await joinButton.focus();
      await page.keyboard.press('Enter');
      const sheet = page.getByRole('dialog', { name: 'انضم إلى مادة' });
      await expect(sheet).toBeVisible();
      // focus starts inside the sheet; reach the field with Tab and type
      const field = sheet.getByLabel('رمز الانضمام أو رابط الدعوة');
      for (let i = 0; i < 8 && !(await field.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
      await expect(field).toBeFocused();
      await page.keyboard.type(second);
      await page.keyboard.press('Enter');
      await expect(sheet.getByText('تم الانضمام')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(joinButton).toBeFocused();
    });
  });

  test.describe('refusals say why', () => {
    test.use({ allowedConsoleErrors: [/status of 40[0349]/] });

    test('a revoked or unknown invite link, and a wrong class code', async ({ page, playwright, baseURL }, testInfo) => {
      const owner = await ownerSession(playwright, baseURL!);
      try {
        const stamp = stampFor(testInfo.project.name);
        const w = await buildWorld(owner.api, stamp);
        const code = await createCode(owner.api, w.approval.id, 'class_code', true);
        const revoked = await createCode(owner.api, w.open.id, 'invite_link', false);
        await owner.api.del(`/api/channels/codes/${revoked.view.id}`);

        // the public preview: a revoked token answers exactly like one that never existed
        const anon = await playwright.request.newContext({ baseURL });
        try {
          const a = await anon.get(`/api/channels/join/preview?token=${tokenOf(revoked.link!)}`);
          const b = await anon.get(`/api/channels/join/preview?token=${'x'.repeat(32)}`);
          expect(a.status()).toBe(404);
          expect(b.status()).toBe(404);
          expect(await a.text()).toBe(await b.text());
        } finally {
          await anon.dispose();
        }
        await page.goto(joinPath(revoked.link!));
        await expect(page.getByRole('alert').filter({ hasText: 'لا يمكن استخدام هذه الدعوة' })).toContainText('الرابط غير صالح أو انتهت صلاحيته أو أُلغي');
        await expect(page.getByText(w.open.title)).toHaveCount(0);
        await screenshot(page, testInfo, 'aos-j9-invalid-link', { healthy: false });

        await registerStudent(page.request, { username: `zaid_${stamp}`, display_name: `زيد ${stamp}` }, { code: code.code! });
        await page.goto('/channels');
        await page.getByRole('button', { name: 'انضم برمز أو QR' }).click();
        const sheet = page.getByRole('dialog', { name: 'انضم إلى مادة' });
        await sheet.getByLabel('رمز الانضمام أو رابط الدعوة').fill('ZZZZ-ZZZZ');
        await sheet.getByRole('button', { name: 'انضم', exact: true }).click();
        await expect(sheet.locator('.ml-field__error').first()).toContainText(/[؀-ۿ]/);
        await sheet.getByLabel('رمز الانضمام أو رابط الدعوة').fill('abc');
        await sheet.getByRole('button', { name: 'انضم', exact: true }).click();
        await expect(sheet.getByText(/رمز الانضمام|8 رموز/).first()).toBeVisible();
      } finally {
        await owner.dispose();
      }
    });
  });
});
