// End-to-end smoke of the web core against a REAL MedLevo server (not mocked).
// The page is served by `vite preview` (4173); /api requests are forwarded by Playwright to the server
// given as argv[2] (default http://127.0.0.1:18787). Start the server with a throwaway data dir and
// MEDLEVO_ORIGIN=http://127.0.0.1:4173.
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

const api = process.argv[2] ?? 'http://127.0.0.1:18787';
const base = 'http://127.0.0.1:4173';
const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(fallback) ? { executablePath: fallback } : {});
const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const log = [];
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && !/status of 401/.test(m.text()) && problems.push('console: ' + m.text()));
await page.route('**/api/**', async (route) => {
  const u = new URL(route.request().url());
  const res = await route.fetch({ url: api + u.pathname + u.search });
  log.push(`${route.request().method()} ${u.pathname} → ${res.status()}`);
  await route.fulfill({ response: res });
});
const step = async (name, fn) => {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    problems.push(name);
  }
};
const password = 'quiet library pages 42';
await step('redirects to /setup when no owner exists', async () => {
  await page.goto(base + '/');
  await page.waitForURL('**/setup');
});
await step('setup creates the owner and shows 10 recovery codes once', async () => {
  await page.locator('input[name="username"]').fill('owner');
  await page.locator('input[name="new-password"]').fill(password);
  await page.locator('input[name="confirm-password"]').fill(password);
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.getByRole('heading', { name: 'احفظ رموز الاسترداد' }).waitFor();
  const n = await page.locator('.ml-codes__list li').count();
  if (n !== 10) throw new Error(`expected 10 codes, got ${n}`);
});
let firstCode = '';
await step('continue is blocked until the confirmation is checked', async () => {
  firstCode = (await page.locator('.ml-codes__list li').first().textContent()).trim();
  if (await page.getByRole('button', { name: 'متابعة إلى MedLevo' }).isEnabled()) throw new Error('continue enabled before confirmation');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'متابعة إلى MedLevo' }).click();
  await page.getByRole('heading', { name: 'الرئيسية', level: 1 }).waitFor();
});
await step('sync engine reaches the real /api/sync/pull and shows «تمت المزامنة»', async () => {
  await page.getByRole('button', { name: /حالة الحفظ: تمت المزامنة/ }).waitFor({ timeout: 10_000 });
});
await step('settings load from the server and a change is saved (PATCH)', async () => {
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByRole('heading', { name: 'الإعدادات', level: 1 }).waitFor();
  await page.getByRole('radio', { name: 'داكن' }).click();
  await page.getByText('حُفظت التغييرات').waitFor();
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') throw new Error('theme not applied');
  const r = await page.evaluate(async () => (await fetch('/api/settings', { credentials: 'same-origin' })).json());
  if (r.settings.theme !== 'dark') throw new Error('server did not store theme');
});
await step('sessions list shows this device', async () => {
  await page.getByText('هذا الجهاز').first().waitFor();
});
await step('logout → /login, then login again', async () => {
  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await page.waitForURL('**/login');
  await page.locator('input[name="username"]').fill('owner');
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.getByRole('heading', { name: 'الرئيسية', level: 1 }).waitFor();
});
await step('wrong password shows the server Arabic message', async () => {
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await page.waitForURL('**/login');
  await page.locator('input[name="username"]').fill('owner');
  await page.locator('input[name="password"]').fill('wrong password here');
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.getByText('اسم المستخدم أو كلمة المرور غير صحيحة.').waitFor();
});
await step('recover with a one-time code, then login with the new password', async () => {
  await page.getByRole('link', { name: 'استخدم رمز استرداد' }).click();
  await page.locator('input[name="username"]').fill('owner');
  await page.locator('input[name="recovery-code"]').fill(firstCode);
  await page.locator('input[name="new-password"]').fill(password + ' new');
  await page.locator('input[name="confirm-password"]').fill(password + ' new');
  await page.getByRole('button', { name: 'تعيين كلمة المرور الجديدة' }).click();
  await page.waitForURL('**/login?recovered=1**');
  await page.getByText('رموز الاسترداد المتبقية: 9.').waitFor();
  await page.locator('input[name="username"]').fill('owner');
  await page.locator('input[name="password"]').fill(password + ' new');
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.getByRole('heading', { name: 'الرئيسية', level: 1 }).waitFor();
});
await step('capabilities come from the server (AI unconfigured reason is shown in settings)', async () => {
  await page.goto(base + '/settings');
  await page.getByText(/تُحفظ هذه التفضيلات الآن/).waitFor();
});
await browser.close();
console.log('\nAPI calls:\n' + [...new Set(log)].join('\n'));
console.log(problems.length ? '\nPROBLEMS:\n' + problems.join('\n') : '\nall steps passed, no console errors');
process.exitCode = problems.length ? 1 : 0;
