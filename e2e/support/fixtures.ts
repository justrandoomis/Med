// The `test` every E2E spec imports. Adds:
//   * baseURL → the real server global setup started for this project (phone / desktop each have their own);
//   * consoleGuard (auto) → fails the test on any browser console error, uncaught page error or 5xx /api answer;
//   * api → an owner API client bound to the page's cookie jar (`apiAs(page.request)`).
import { test as base, expect } from '@playwright/test';
import { apiAs, type E2eApi } from './api';
import { serverFor } from './paths';

export interface ConsoleGuard {
  /** problems collected so far (console errors, page errors, 5xx API answers) */
  readonly problems: string[];
}

interface E2eFixtures {
  api: E2eApi;
  consoleGuard: ConsoleGuard;
  /** console error texts matching one of these are tolerated (per spec/describe via `test.use`) — keep it empty by default */
  allowedConsoleErrors: RegExp[];
}

export const test = base.extend<E2eFixtures>({
  baseURL: async ({}, use, testInfo) => {
    await use(serverFor(testInfo.project.name).baseURL);
  },

  allowedConsoleErrors: [[], { option: true }],

  consoleGuard: [
    async ({ page, allowedConsoleErrors }, use, testInfo) => {
      const problems: string[] = [];
      const allowed = (text: string) => allowedConsoleErrors.some((re) => re.test(text));
      page.on('console', (msg) => {
        if (msg.type() !== 'error' || allowed(msg.text())) return;
        const loc = msg.location();
        problems.push(`console.error: ${msg.text()}${loc.url ? ` (${loc.url}:${loc.lineNumber})` : ''} [at ${page.url()}]`);
      });
      page.on('pageerror', (err) => problems.push(`pageerror: ${err.message} [at ${page.url()}]`));
      page.on('response', (res) => {
        if (res.status() >= 500 && new URL(res.url()).pathname.startsWith('/api/')) {
          problems.push(`HTTP ${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
        }
      });
      await use({ problems });
      if (problems.length) await testInfo.attach('console-problems', { body: problems.join('\n'), contentType: 'text/plain' });
      expect(problems, 'browser console errors / page errors / server 5xx during the test').toEqual([]);
    },
    { auto: true },
  ],

  api: async ({ page }, use) => {
    await use(apiAs(page.request));
  },
});

export { expect };
