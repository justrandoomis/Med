// UI-level helpers: owner setup / login (through the real screens or the API), opening the study workspace,
// and screenshots into e2e/.artifacts.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { CSRF_HEADERS } from './api';
import { E2E_ARTIFACTS_DIR } from './paths';

export interface OwnerCredentials {
  username: string;
  password: string;
}

/** The single owner every E2E server gets (scrypt-hashed by the real server; throwaway data dir). */
export const OWNER: OwnerCredentials = { username: 'owner', password: 'quiet library pages 42' };

const isPage = (t: Page | APIRequestContext): t is Page => typeof (t as Page).goto === 'function';

/**
 * Make sure the owner exists and is signed in.
 * - with a Page: through the real screens — first-run setup (recovery codes confirmed) or login — ending on Home.
 * - with an APIRequestContext: POST /api/auth/setup or /api/auth/login (cookie lands in that context).
 * Idempotent: a later call on the same server logs in instead of setting up. Returns what happened.
 */
export async function setupOwner(target: Page | APIRequestContext, creds: OwnerCredentials = OWNER): Promise<'setup' | 'login' | 'already'> {
  if (!isPage(target)) {
    const status = (await (await target.get('/api/auth/status')).json()) as { setup_required: boolean; authenticated?: boolean };
    const path = status.setup_required ? '/api/auth/setup' : '/api/auth/login';
    const res = await target.post(path, { headers: { ...CSRF_HEADERS }, data: creds });
    if (!res.ok()) throw new Error(`${path} → ${res.status()}: ${await res.text()}`);
    return status.setup_required ? 'setup' : 'login';
  }

  const page = target;
  await page.goto('/');
  const home = page.getByRole('heading', { name: 'الرئيسية', level: 1 });
  const setupHeading = page.getByRole('heading', { name: 'إنشاء حساب المالك' });
  const loginButton = page.getByRole('button', { name: 'دخول', exact: true });
  await expect(home.or(setupHeading).or(loginButton)).toBeVisible({ timeout: 30_000 });

  if (await setupHeading.isVisible()) {
    await expect(page).toHaveURL(/\/setup$/);
    await page.locator('input[name="username"]').fill(creds.username);
    await page.locator('input[name="new-password"]').fill(creds.password);
    await page.locator('input[name="confirm-password"]').fill(creds.password);
    await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
    await expect(page.getByRole('heading', { name: 'احفظ رموز الاسترداد' })).toBeVisible();
    await expect(page.locator('.ml-codes__list li')).toHaveCount(10);
    const proceed = page.getByRole('button', { name: 'متابعة إلى MedLevo' });
    await expect(proceed).toBeDisabled();
    await page.getByRole('checkbox').check();
    await proceed.click();
    await expect(home).toBeVisible();
    return 'setup';
  }
  if (await loginButton.isVisible()) {
    await expect(page).toHaveURL(/\/login/);
    await page.locator('input[name="username"]').fill(creds.username);
    await page.locator('input[name="password"]').fill(creds.password);
    await loginButton.click();
    await expect(home).toBeVisible();
    return 'login';
  }
  return 'already';
}

/**
 * Open the study workspace for a source and wait until the first page is really rendered
 * (pdf.js canvas for PDFs, page image or text sections otherwise).
 */
export async function openWorkspace(page: Page, sourceId: string, opts: { versionId?: string; pageIndex?: number } = {}): Promise<void> {
  const params = new URLSearchParams();
  if (opts.versionId) params.set('v', opts.versionId);
  if (opts.pageIndex !== undefined) params.set('page', String(opts.pageIndex));
  const qs = params.toString();
  await page.goto(`/study/${sourceId}${qs ? `?${qs}` : ''}`);
  await waitForWorkspace(page);
}

/** Wait until the workspace shows a rendered page (after `openWorkspace` or an in-app navigation to /study/…). */
export async function waitForWorkspace(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/study\//);
  await expect(page.locator('.wk-canvas-slot canvas, .wk-page-image, .wk-textsheet').first()).toBeVisible({ timeout: 45_000 });
}

/**
 * Baseline checks for any screen: Arabic RTL document (ARCHITECTURE §4), no error state on screen, no horizontal
 * page overflow (no sideways scrolling at 390 px).
 */
export async function expectHealthyScreen(page: Page, name = page.url()): Promise<void> {
  await expect(page.locator('html'), `${name}: <html lang="ar" dir="rtl">`).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('.ml-state--error'), `${name}: an error state is shown`).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${name}: horizontal overflow of the page`).toBeLessThanOrEqual(1);
}

/**
 * Screenshot into e2e/.artifacts/screenshots/<project>/<name>.png (git-ignored) and attach it to the report.
 * Runs `expectHealthyScreen` first (opt out with `healthy: false` for screens that show an expected error).
 */
export async function screenshot(page: Page, testInfo: TestInfo, name: string, opts: { fullPage?: boolean; healthy?: boolean } = {}): Promise<string> {
  const dir = join(E2E_ARTIFACTS_DIR, 'screenshots', testInfo.project.name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  if (opts.healthy !== false) await expectHealthyScreen(page, name);
  await page.screenshot({ path, fullPage: opts.fullPage ?? false });
  await testInfo.attach(name, { path, contentType: 'image/png' });
  return path;
}
