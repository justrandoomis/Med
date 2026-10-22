// ESLint flat config (track F5, §58): `npm run lint` = `eslint . --max-warnings 0`.
//   * @eslint/js recommended + typescript-eslint recommended for every TS / JS file of the repository;
//   * react-hooks for the web app: the whole `recommended` set of eslint-plugin-react-hooks 7 — the rules of hooks and
//     exhaustive dependencies (warning — and warnings fail the run) plus the React Compiler rules (set-state-in-effect,
//     refs, purity, immutability, preserve-manual-memoization, …). Enabled in Round 7 after the 184 findings were fixed
//     in the code (see docs/modules/core-web.md §10);
//   * unused eslint-disable directives are errors, so a disable can never outlive the problem it excused. Every
//     remaining disable is targeted (one rule, one line) and says why.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import medlevo from './tools/eslint/module-boundaries.mjs';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/dev-dist/',
    '**/coverage/',
    'playwright-report/',
    'test-results/',
    'e2e/.artifacts/',
    'e2e/.tmp/',
    'eval-reports/',
    'apps/web/test-screenshots/',
    '/data/',
    'apps/server/data/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      // `_name` marks a value that is deliberately unused (a destructured-away field, a required callback parameter)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // the web app, its tests and dev scripts run in the browser (scripts drive a browser through Playwright)
    files: ['apps/web/**/*.{ts,tsx,js,mjs}', 'e2e/**/*.ts', 'tools/**/*.mjs', 'fixtures/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.flat.recommended.rules },
  },
  {
    // P1-T1 step 3 (ARCHITECTURE_DELTA §4.5): every browser-storage key belongs to the signed-in account — or,
    // explicitly, to the device — so only lib/userStorage.ts touches localStorage / sessionStorage (tests may set keys)
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/lib/userStorage.ts', 'apps/web/src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'Use userStorage / deviceStorage from lib/userStorage.ts (per-user keys, P1-T1).' },
        { name: 'sessionStorage', message: 'Use userSession from lib/userStorage.ts (per-user keys, P1-T1).' },
      ],
      'no-restricted-properties': [
        'error',
        ...['window', 'globalThis', 'self'].flatMap((object) => [
          { object, property: 'localStorage', message: 'Use userStorage / deviceStorage from lib/userStorage.ts (per-user keys, P1-T1).' },
          { object, property: 'sessionStorage', message: 'Use userSession from lib/userStorage.ts (per-user keys, P1-T1).' },
        ]),
      ],
    },
  },
  {
    // AOS-21.47 (ARCHITECTURE_DELTA §1.1, §5.5): cross-database access stays inside the allow-listed modules and space
    // routes inside the space-route allow-list — tools/eslint/module-boundaries.mjs holds the allow-lists
    files: ['apps/server/src/**/*.ts'],
    plugins: { medlevo },
    rules: { 'medlevo/module-boundaries': 'error' },
  },
  {
    // Playwright fixtures that need no other fixture are declared as `async ({}, use) => …`
    files: ['e2e/**/*.ts', 'playwright.config.ts', 'apps/web/test/ink/**/*.ts'],
    rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
  },
);
