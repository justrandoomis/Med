// ESLint flat config (track F5, §58): `npm run lint` = `eslint . --max-warnings 0`.
//   * @eslint/js recommended + typescript-eslint recommended for every TS / JS file of the repository;
//   * react-hooks for the web app: the rules of hooks (error) and exhaustive dependencies (warning — and warnings
//     fail the run). The React Compiler rule set of eslint-plugin-react-hooks 7 (`recommended`: set-state-in-effect,
//     refs, purity, …) is NOT enabled: the app does not use the React Compiler, and those rules describe code the
//     compiler can optimize, not bugs (measured: 171 findings; see docs/modules/core-web.md);
//   * unused eslint-disable directives are errors, so a disable can never outlive the problem it excused. Every
//     remaining disable is targeted (one rule, one line) and says why.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Playwright fixtures that need no other fixture are declared as `async ({}, use) => …`
    files: ['e2e/**/*.ts', 'playwright.config.ts', 'apps/web/test/ink/**/*.ts'],
    rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
  },
);
