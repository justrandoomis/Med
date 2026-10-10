# End-to-end tests (Playwright, real server)

The E2E suite drives the **built web app served by the real MedLevo server** — real auth, real uploads, the real
processing pipeline (pdf.js / poppler / OCR), real question extraction and matching. Nothing is mocked and no AI
provider exists here: AI features must show `requires_configuration` with their reason, and the smoke test asserts
exactly that (§58: a test that needs a key that is not available is never reported as passed).

```bash
npm run e2e                                  # both projects (phone 390×844, desktop 1280×800)
npx playwright test --project=desktop        # one project
npx playwright test e2e/smoke.spec.ts -g API # one test
npx playwright show-report                   # HTML report (playwright-report/)
npx playwright show-trace e2e/.artifacts/test-results/<test>/trace.zip   # trace of a failed test
npx tsc -p e2e --noEmit                      # typecheck the harness (also part of `npm run typecheck`)
```

Requirements: `npm install`, Node ≥ 22.13, poppler (`pdftoppm`), and Chromium at `/opt/pw-browsers/chromium`
(set `PW_CHROMIUM_PATH` elsewhere). Never run `playwright install` in this environment.

## What happens on a run

1. **Build** (`e2e/support/global-setup.ts`): `apps/web/dist` is built with `npm run build -w @medlevo/web` when it is
   missing or older than the web/shared sources (log: `e2e/.artifacts/web-build.log`).
2. **One server per project**: `apps/server/src/index.ts` is started with `NODE_ENV=production`, a free loopback port,
   `MEDLEVO_ORIGIN` = that exact origin (so the CSRF Origin check matches and first-run setup needs no token), a
   throwaway `MEDLEVO_DATA_DIR` under `e2e/.tmp/run-*/<project>`, `MEDLEVO_WEB_DIST=apps/web/dist`, and
   `ANTHROPIC_API_KEY=''` (an empty value also wins over a developer's `.env`). Each project therefore begins from
   an empty install, including the first-run setup screen. Server logs: `e2e/.artifacts/server-<project>.log`.
3. **Tests** run with `workers: 1`, `retries: 0`, the service worker blocked, `ar-IQ` locale, `Asia/Baghdad` timezone;
   traces and screenshots are kept for failures only.
4. **Teardown** stops the servers gracefully (SIGTERM → jobs re-queued, DB closed) and deletes the data dirs.

| variable | effect |
|---|---|
| `E2E_BUILD=1` / `E2E_BUILD=0` | always rebuild the web app / never build (use `apps/web/dist` as it is) |
| `E2E_BASE_URL=http://127.0.0.1:8787` | use an already running server for every project (nothing is built or started; the specs are re-runnable on a used server) |
| `E2E_KEEP_DATA=1` | keep `e2e/.tmp/run-*` (database, files) for inspection |
| `E2E_SERVER_LOG_LEVEL=debug` | server log level (default `info`) |
| `E2E_SERVICE_WORKERS=allow` | run with the PWA service worker registered |
| `PW_CHROMIUM_PATH` | another Chromium binary |

Git-ignored outputs: `e2e/.tmp/` (data), `e2e/.artifacts/` (screenshots, server/build logs, `test-results`),
`playwright-report/`.

## Writing a spec

Import everything from `./support`:

```ts
import { apiAs, expect, openWorkspace, screenshot, setupOwner, test } from './support';

test('my flow', async ({ page, api }, testInfo) => {
  await setupOwner(page);                                       // first-run setup through the screens, or login
  const { course } = await api.createNotebookAndCourse();       // unique titles per call
  const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
  await api.waitForProcessing(up.version_id);                   // { questions: true } also waits for question extraction
  await openWorkspace(page, up.source_id);                      // waits for a rendered page
  await screenshot(page, testInfo, '01-reader');                // e2e/.artifacts/screenshots/<project>/01-reader.png
});
```

| helper | what it does |
|---|---|
| `test` fixtures | `baseURL` = this project's server · `api` = `apiAs(page.request)` (shares the browser's session cookie) · `consoleGuard` (automatic) fails the test on any `console.error`, uncaught page error or 5xx `/api` answer; tolerate a specific message only with `test.use({ allowedConsoleErrors: [/…/] })` and say why |
| `setupOwner(page \| request)` | page: `/setup` (fills the form, checks the 10 recovery codes, confirms) or `/login`, ends on Home; request: `POST /api/auth/setup` or `/login`. Returns `'setup' \| 'login' \| 'already'` |
| `apiAs(request)` | `get/post/patch/put/del` with the `x-medlevo-csrf: 1` header, throws `ApiCallError` (method, path, status, body) on non-2xx; `call()` returns the raw response |
| `api.uploadFixture(nodeId, fileName, opts?)` | multipart upload of `fixtures/golden/<fileName>`; must be `accepted` (`onDuplicate: 'create'` keeps identical bytes as a new source) |
| `api.waitForProcessing(versionId, opts?)` | polls `/api/sources/versions/:id/processing` until the job is terminal (and `/api/questions/extractions/:id` with `questions: true`) |
| `api.createNotebookAndCourse(opts?)` | notebook + course inside it |
| `openWorkspace(page, sourceId, { versionId?, pageIndex? })` / `waitForWorkspace(page)` | open `/study/:id` (or wait after an in-app navigation) until a page canvas / image / text sheet is visible |
| `screenshot(page, testInfo, name)` / `expectHealthyScreen(page)` | `<html lang="ar" dir="rtl">`, no error state, no horizontal overflow; then a screenshot attached to the report |

Specs must stay re-runnable on a used server (`E2E_BASE_URL`, `--repeat-each`): create their own notebooks, use
`onDuplicate: 'create'` for fixtures, and never assume an empty library. Fixtures are synthetic **TEST FIXTURE**
documents (`fixtures/golden/README.md`); never present them as medical content.

## `smoke.spec.ts`

On both projects: first-run setup through the screens → notebook + course (API) → library → course → upload the
lecture through the upload screen (`lecture_appendicitis.pdf`, type suggested `lecture`) and the question source
through the API (`questions_surgery_course1.pdf`) → real processing + extraction → printed labels `11–14` from
`/PageLabels` → source page «ص 11 (الصفحة 1 في الملف)» → workspace from the source page and by deep link (folio and
indicator «ص 11», selectable text layer) → study rail: «الشرح غير متاح الآن» with the server's reason and a disabled
«اشرح», «الأسئلة» lists the linked questions after matching (lecture first, questions later, AC-16) → Question Vault
filtered to the source: 7 questions with origin, stems as printed (NOT kept) → Review hub via the main navigation →
Control Center via Settings, AI «غير مهيأ». A second test signs in through the API on a fresh cookie jar and checks
that a mutation without the CSRF header gets 403 and an anonymous request gets 401.

Not covered here (and not claimed): real iPad/iPhone Safari, Apple Pencil, screen readers, AI-backed features (no
key; they are exercised in server tests with the test-only `FakeAiProvider`), offline mode in the browser.

## `perf.spec.ts` (performance & resilience, opt-in)

Skipped unless `MEDLEVO_PERF=1` (it takes several minutes and uploads a generated 300-page PDF). Results go to
`e2e/.artifacts/perf/<project>.json`; the numbers and their limits are written up in
[`docs/PERFORMANCE.md`](../docs/PERFORMANCE.md).

```bash
MEDLEVO_PERF=1 npx playwright test e2e/perf.spec.ts --project=desktop
```

300-page lecture (open time, render time per page while scrolling, page canvases in the DOM, JS heap after GC), 5 000
ink strokes on one page (load + paint, a new stroke, zoom repaint, long tasks), review hub with 3 000 cards + 12 000
review events (first sync + fold, then the fold from IndexedDB), reload mid-stroke and right after typing a note
(nothing lost beyond the stroke in flight), offline → online convergence. Fixtures are generated at test time by
`apps/server/test/perf/fixtures.ts` (cached in the OS temp dir, labelled TEST FIXTURE). Headless Chromium in this
container only — never a device FPS / pen-latency claim.

## `critic-screens.spec.ts` (screen sweep)

On both projects: sets up an owner, uploads the Golden Set lecture + question source, creates a card and an exam, then
opens **every top-level screen** (47 shell / full-bleed routes + login / recover signed out) in the light AND the dark
colour scheme. Each screen must pass `expectHealthyScreen`, have exactly one visible `<h1>`, no control without an
accessible name, no `<img>` without `alt`, no honesty red flags in the visible text (accuracy / «100%» claims, «AI
Verified», raw `undefined` / `NaN` / JSON) and no text under 3:1 contrast; on the phone the segmented options, switches
(transparent 45px ring), the brand link and the save-status button must keep a 44px touch target. Full-page screenshots
and a probe report (`report.json`, also listing 3–4.5:1 contrast and smaller touch targets for a human look) go to
`e2e/.artifacts/critic/<project>/`. Screenshots are for review; they are not pixel-compared.
