// Playwright config for the ink engine's browser checks (AC-21 web part, mouse input only).
// Run from the repo root:  npx playwright test -c apps/web/test/ink/playwright.config.ts
// Chromium comes from /opt/pw-browsers (never `playwright install`).
import { defineConfig } from '@playwright/test';

const PORT = 5188;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.pw\.ts$/,
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../../../node_modules/.cache/ink-playwright',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: '../..',
    url: `http://127.0.0.1:${PORT}/test/ink/harness.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
