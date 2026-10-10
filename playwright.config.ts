// Playwright end-to-end configuration (§57, §58). Runs against the REAL MedLevo server serving the built web app:
// `e2e/support/global-setup.ts` builds `apps/web/dist` when needed, starts one throwaway server per project
// (own data dir, free port, NODE_ENV=production, no AI key) and stops it afterwards. See e2e/README.md.
import { defineConfig } from '@playwright/test';

/** The only Chromium available in this environment (never `playwright install`). Override with PW_CHROMIUM_PATH. */
const executablePath = process.env.PW_CHROMIUM_PATH || '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'e2e',
  // traces and screenshots of failed tests (git-ignored)
  outputDir: 'e2e/.artifacts/test-results',
  globalSetup: './e2e/support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // a real upload → processing → extraction run takes a while; individual waits carry their own timeouts
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // the PWA service worker would cache the app shell between runs and hide real network behaviour
    serviceWorkers: process.env.E2E_SERVICE_WORKERS === 'allow' ? 'allow' : 'block',
    locale: 'ar-IQ',
    timezoneId: 'Asia/Baghdad',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    launchOptions: { executablePath },
  },
  projects: [
    {
      name: 'phone',
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } },
    },
  ],
});
