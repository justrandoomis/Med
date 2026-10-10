# Test log (§58, §61)

The full suites, run on 2026-10-10 in the integration and acceptance round, with the exact commands, counts,
durations and failures as they happened. A test that needs something this environment does not have is listed under
**Not run** with the reason — never as passed (§58).

## Environment

| item | value |
|---|---|
| machine | Linux 6.18 VM (container), 4 vCPU, 16 GB RAM; other agents were working in the same repository at the time |
| Node / npm | v22.22.0 / 10.9.4 (`NODE_OPTIONS='--disable-warning=ExperimentalWarning'` for `node:sqlite`) |
| tools | poppler `pdftoppm` 24.02.0 · LibreOffice 24.2.7.2 · tesseract.js 7 with bundled `eng` + `ara` models |
| browser | Chromium 141.0.7390.37 at `/opt/pw-browsers/chromium` (Playwright 1.64; never `playwright install`) |
| AI | **no AI key** (`ANTHROPIC_API_KEY` empty). Server tests use the test-only `FakeAiProvider` / `ScriptedAi`; the E2E servers run with an empty key and the specs assert `requires_configuration` / `AI_NOT_CONFIGURED` |
| code under test | `HEAD` a3f7ce9 plus the uncommitted work of the acceptance round (186 changed / new paths at the start of the run) |

## 1. Full run (2026-10-10, 10:25 → 10:45 UTC)

Run as one script, in this order, from the repository root, with `NODE_OPTIONS='--disable-warning=ExperimentalWarning'`.

| # | command | exit | duration | result |
|---|---|---|---|---|
| 1 | `npm test` | 0 | 227 s | **shared** 6 files, **48 passed** (1.2 s) · **server** 97 files passed, 6 skipped; **1098 passed, 6 skipped** (160.0 s) · **web** 85 files passed, 1 skipped; **565 passed, 1 skipped** (63.5 s) |
| 2 | `npm run typecheck` (`tsc -p packages/shared`, `-p apps/server`, `-p apps/web`, `-p e2e`, all `--noEmit`) | 0 | 44 s | no type errors |
| 3 | `npm run build` (`vite build` of `@medlevo/web`) | 0 | 5 s | built in 2.0 s; PWA `generateSW`, **230 precache entries** (4 183 KiB) |
| 4 | `npm run e2e -- --output=e2e/.artifacts/testlog-results` | **1** | 921 s (15.3 min) | 98 tests: **86 passed, 2 failed, 10 skipped** |

**Skipped, by design:** the 6 server files and 1 web file skipped by `npm test` are the performance suites
(`apps/server/test/perf/*.perf.test.ts`, `apps/web/test/learning/queue.perf.test.ts`), and the 10 skipped E2E tests are
`e2e/perf.spec.ts` (5 tests × 2 projects). All of them run only with `MEDLEVO_PERF=1` (see «Not run»).

**Expected stderr noise (not failures):** `libpng error: Read Error` / `Error in pixRead…` lines in the server run come
from tesseract reading deliberately damaged images (e.g. the truncated PNG of the AC-03 test); `Not implemented:
navigation to another Document` is jsdom's notice when a web test triggers a page navigation.

### E2E results per spec (run 1; each spec runs on both projects: `phone` 390×844 and `desktop` 1280×800)

| spec | acceptance | passed | failed | skipped |
|---|---|---|---|---|
| `smoke.spec.ts` | journey, CSRF | 4 | | |
| `critic-screens.spec.ts` | 47 screens × light / dark | 4 | | |
| `g1-ac01-personal-library.spec.ts` | AC-01 | 4 | | |
| `g1-ac02-mixed-pdf.spec.ts` | AC-02 | 2 | | |
| `g1-ac03-partial-failure.spec.ts` | AC-03 | 2 | | |
| `g1-ac04-printed-page.spec.ts` | AC-04 | 4 | | |
| `g2-ac05-source-lock.spec.ts` | AC-05 | 2 | | |
| `g2-ac06-invalid-citation.spec.ts` | AC-06 | 2 | | |
| `g2-ac29-injection.spec.ts` | AC-29 | 2 | | |
| `g3-ac08-diagram.spec.ts` | AC-08 | 2 | | |
| `g3-ac09-image-match.spec.ts` | AC-09 | 2 | | |
| `g3-ac13-circled-option.spec.ts` | AC-13 | 2 | | |
| `g4-ac10-ac11-extraction.spec.ts` | AC-10, AC-11 | 2 | | |
| `g4-ac12-ac14-ac15-keys.spec.ts` | AC-12, AC-14, AC-15 | 2 | | |
| `g5-ac16-late-linking.spec.ts` | AC-16 | 6 | | |
| `g5-ac17-ac19-exam.spec.ts` | AC-17, AC-18, AC-19 | 6 | | |
| `g6-ac20-mixed-text.spec.ts` | AC-20 | 4 | | |
| `g6-ac21-ink-position.spec.ts` | AC-21 | 4 | | |
| `g6-ac22-font-size.spec.ts` | AC-22 | 6 | | |
| `g6-ac28-pencil.spec.ts` | AC-28 | 6 | | |
| `g7-ac23-offline.spec.ts` | AC-23 | | **2** | |
| `g7-ac24-two-devices.spec.ts` | AC-24 | 4 | | |
| `g7-ac30-restore.spec.ts` | AC-30 | 2 | | |
| `g8-ac26-correction.spec.ts` | AC-26 | 2 | | |
| `g8-ac27-mastery.spec.ts` | AC-27 | 2 | | |
| `g8-security.spec.ts` | §49 sweep | 8 | | |
| `perf.spec.ts` | §55 (opt-in) | | | 10 |
| **total** | | **86** | **2** | **10** |

### The failure and its fix

`g7-ac23-offline.spec.ts`, both projects, step «offline: the review session opens, rates a card…»:

```
Error: expect(received).toContain(expected)
Expected value: "01M4JNSCMNW9WF0GND0NYH9PQ5"
Received array: ["1B614D3B55B8402CA5D0CC9AE0", "273D6D904A434C9DB2A535AD78"]
```

**Cause — a test-isolation defect in the spec, not in the product.** In the full run every spec of a project shares one
server. `g1-ac04-printed-page.spec.ts` runs earlier and leaves a due card («G1 AC-04 — where is the marker NUTMEG?»).
The AC-23 spec started the review from the hub («ابدأ المراجعة», all due cards) and asserted that the first card
rated was one of its own two cards; the session correctly showed the G1 card first. The G7 group had only run this
spec next to `smoke.spec.ts`, where no other card exists, so it had always passed. It broke the harness rule in
`e2e/README.md` («specs must stay re-runnable on a used server»).

**Reproduced in isolation** (before the fix):
`npx playwright test e2e/g1-ac04-printed-page.spec.ts e2e/g7-ac23-offline.spec.ts --output=e2e/.artifacts/testlog-ac23-before`
→ exit 1, **4 passed, 2 failed** (the same assertion on phone and desktop), 58 s.

**Fix** (`e2e/g7-ac23-offline.spec.ts`): the step still checks that the review hub opens offline («ابدأ المراجعة»
visible), then opens the session focused on the spec's own cards with the session's supported parameter
(`/review/session?cards=<its two ids>&back=/review`). Nothing in the product changed.

**Regression check** (the same pair, after the fix):
`npx playwright test e2e/g1-ac04-printed-page.spec.ts e2e/g7-ac23-offline.spec.ts --output=e2e/.artifacts/testlog-ac23-after`
→ exit 0, **6 passed**, 61 s. `npx tsc -p e2e --noEmit` → exit 0.

## 2. Full E2E run after the fix

| command | exit | duration | result |
|---|---|---|---|
| `npm run e2e -- --output=e2e/.artifacts/testlog-results-2` (10:47 → 11:02 UTC, fresh servers, web app already built) | 0 | 910 s (15.1 min) | 98 tests: **88 passed, 0 failed, 10 skipped** (`perf.spec.ts`, opt-in) — every spec in the table above passed on both projects, including `g7-ac23-offline.spec.ts` |

## 3. Final checks of this round

Run after the fix and after the documentation of this round was written (11:03 → 11:08 UTC), same environment.

| command | exit | duration | result |
|---|---|---|---|
| `npm test` | 0 | 227 s | shared **48 passed** (6 files) · server **1098 passed, 6 skipped** (97 files + 6 skipped; 158.0 s) · web **565 passed, 1 skipped** (85 files + 1 skipped; 65.1 s) |
| `npx tsc -p apps/server --noEmit` | 0 | 16 s | no type errors |
| `npx tsc -p apps/web --noEmit` | 0 | 22 s | no type errors |
| `npx tsc -p e2e --noEmit` | 0 | 5 s | no type errors |
| `npm run build -w @medlevo/web` | 0 | 5 s | built in 2.2 s; **230 precache entries** (4 183 KiB) |
| `npx playwright test -c apps/web/test/ink/playwright.config.ts` (ink engine harness, Vite dev server, mouse input) | 0 | 26 s | **4 passed**: AC-21 position across zoom / rotation / reload, DPR 2, highlighter under the text + honest capability panel, thousands of strokes on one page |

### Totals of this round

| suite | tests passed | skipped (opt-in perf) | failed in the final runs |
|---|---|---|---|
| shared (vitest) | 48 | 0 | 0 |
| server (vitest) | 1 098 | 6 | 0 |
| web (vitest) | 565 | 1 | 0 |
| E2E (Playwright, real server, phone + desktop) | 88 | 10 | 0 (2 in the first run — the AC-23 spec defect above) |
| ink harness (Playwright, Vite) | 4 | 0 | 0 |

## Not run (and why)

| what | why | what was done instead |
|---|---|---|
| Real iPad / iPhone, Apple Pencil, any real stylus (Surface Pen, Wacom, Android) | no device in this environment | ink tested with mouse input and CDP-simulated pen events in headless Chromium (`e2e/g6-ac21-ink-position.spec.ts`, `g6-ac28-pencil.spec.ts`); the app and `docs/CAPABILITY_MATRIX.md` say that mouse tests do not prove Pencil quality |
| Safari (macOS, iPadOS, iOS), Firefox; installed-PWA and storage-eviction behaviour on iOS | only Chromium is available | Chromium phone (390×844, touch) and desktop projects |
| Screen readers (VoiceOver, NVDA, TalkBack) | no device / screen reader | roles, names, headings, focus and contrast asserted by tests and by `e2e/critic-screens.spec.ts` |
| A live AI provider (Anthropic) | no `ANTHROPIC_API_KEY` — and keys never belong in tests or the repository | every AI path is covered in server tests with the test-only scripted / fake provider; the real-server E2E asserts `requires_configuration`. Real output quality, refusals, latency and cost were never observed |
| A real Anki import of the Anki-compatible TSV export | no Anki installation | the export is parsed back in `apps/server/test/learning/cards.test.ts` |
| Performance and resilience suites (`MEDLEVO_PERF=1`: `apps/server/test/perf/*.perf.test.ts`, `e2e/perf.spec.ts`, `apps/web/test/learning/queue.perf.test.ts`) | opt-in by design (several minutes, a generated 300-page PDF); not re-run in this pass | last measured results, with commands, in [`docs/PERFORMANCE.md`](PERFORMANCE.md) |
| ESLint (`npm run lint`) | the repository has no `eslint.config.*`, so ESLint cannot run | TypeScript strict checks (`npm run typecheck`) |
| A deployment behind a real reverse proxy with TLS | not available here | the E2E servers run the production path (`NODE_ENV=production`, built app) on loopback |
| Embeddings, speech-to-text, external image / evidence search | the providers are not built | the features report their state with a reason (`GET /api/capabilities`) |
