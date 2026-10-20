# Test log (§58, §61)

The full suites, run on 2026-10-10 in the integration and acceptance round, with the exact commands, counts,
durations and failures as they happened. A test that needs something this environment does not have is listed under
**Not run** with the reason — never as passed (§58).

> **Latest full verification:** «Round 7 — final verification» (2026-10-20) at the end of this file — `npm test`
> 2 409 passed, full E2E 123 passed / 0 failed on phone + desktop, typecheck / lint / build / evaluation gate green.

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
| ~~ESLint (`npm run lint`)~~ | ~~the repository has no `eslint.config.*`~~ — runs since track F5 (see «Track F5» below) | TypeScript strict checks (`npm run typecheck`) |
| A deployment behind a real reverse proxy with TLS | not available here | the E2E servers run the production path (`NODE_ENV=production`, built app) on loopback; since track F5 `apps/server/test/deploy/tls-proxy.test.ts` runs the real entry point behind a local TLS-terminating Node proxy with a self-signed certificate (not nginx / Caddy, not a public certificate) |
| Embeddings, speech-to-text, external image / evidence search | the providers are not built | the features report their state with a reason (`GET /api/capabilities`) |

## Track F5 — quality ops (2026-10-10, run in this container; another track was editing the tree in parallel)

| command | result |
|---|---|
| `npm test -w @medlevo/shared` | 7 files · **55 passed** |
| `npm test -w @medlevo/server` | 112 files passed, 7 skipped · **1257 passed**, 7 skipped (first run: 1 failure — AC-30 found that the evaluation catalogue sync rewrote `evaluation_case` at every boot, so a restored database was no longer row-for-row identical; fixed: an unchanged catalogue writes nothing, with a regression test; second run green) |
| `npm test -w @medlevo/web` | 105 files passed, 1 skipped · **713 passed**, 1 skipped |
| `npx tsc -p packages/shared --noEmit` · `-p apps/server` · `-p apps/web` · `-p e2e` | exit 0 · 0 · 0 · 0 |
| `npm run build -w @medlevo/web` | exit 0 (PWA: 265 precache entries) |
| `npm run lint` (`eslint . --max-warnings 0`) | exit 0 — the first run of the new config found 55 problems, all fixed in code |
| `npx playwright test e2e/f5-quality-ops.spec.ts` | **6 passed** (3 tests × phone + desktop; the first run failed on a real overflow of the four-format export control at 390 px — fixed — and on two test assumptions) |
| `npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record` (the CI command) | exit 0 — regression 79 / 80 (95% CI 93%–99%), no case stopped passing |
| `.github/workflows/ci.yml` | **not run** on a GitHub runner (none here); YAML parsed, each command run locally |

Not run in this track: the full E2E suite (only the new spec), the live-model evaluation (`--mode=live`, no key), opening
the DOCX files in Microsoft Word (LibreOffice only), the deployment on a real host / certificate.

## Adversarial review of track F5 (2026-10-10, run in this container; another track was editing the tree in parallel)

| command | result |
|---|---|
| ReDoS probe of `redactStack` (tsx script: a stack line «at» + 15 000 spaces) | **~27 700 ms** before the fix (one line; the route accepts 20 × 16 000-character stacks) · 0 ms after |
| `npm test -w @medlevo/shared` | 7 files · **57 passed** (+2: Bearer / curly-quote redaction, hostile stacks in linear time) |
| `npx vitest run test/control/evaluation.test.ts test/control/quality-ops.test.ts` | 30 passed (+3: not-compared comparisons, CLI exit 6 for a filtered run and for another catalogue hash, rate limit 429, hostile stacks through the route) |
| `npm test -w @medlevo/server` | 112 files passed, 7 skipped · **1260 passed**, 7 skipped |
| `npm test -w @medlevo/web` | 105 files passed, 1 skipped · **715 passed**, 1 skipped (+2 in `quality.test.tsx`) |
| `npx tsc -p packages/shared` · `-p apps/server` · `-p apps/web` · `-p e2e` `--noEmit` | exit 0 · 0 · 0 · 0 |
| `npm run build -w @medlevo/web` | exit 0 (PWA: 265 precache entries) |
| `npm run lint` | exit 0 |
| `npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record` (the CI gate) | exit 0 — regression 79 / 80 (95% CI 93%–99%), `no_regressions` |
| `npx playwright test e2e/f5-quality-ops.spec.ts` | **6 passed** (phone + desktop) |

Not run in this review: the full E2E suite, `.github/workflows/ci.yml` on a GitHub runner, the live-model evaluation.

## Round 7 — react-hooks `recommended` lint (§58) (2026-10-20, run in this container; another track was editing the tree in parallel)

Change: `eslint.config.js` applies eslint-plugin-react-hooks 7.1.1 `recommended` (React Compiler rules) to `apps/web`;
the 184 findings it raised were fixed in code (`docs/modules/core-web.md` §10). New test file
`apps/web/test/hooks-render-adjust.test.tsx` (8 tests; 5 fail on the old hooks).

| command | result |
|---|---|
| `npx eslint apps/web` with the rules on, before the fixes | **184 problems** (106 `set-state-in-effect`, 50 `refs`, 14 `preserve-manual-memoization`, 7 `purity`, 7 `immutability`) in 92 files |
| `npm test -w @medlevo/web` before the change (baseline) | 129 files passed, 1 skipped · **794 passed**, 1 skipped (1 unhandled rejection from `ReanchorSection.review.h3.test.tsx`, another track's file under edit) |
| `npm test` (root, after) | shared 8 files · **85 passed**; server 143 files passed, 7 skipped · **1513 passed**, 7 skipped; web 130 files passed, 1 skipped · **802 passed**, 1 skipped (+8 = the new file); exit 0, no unhandled errors |
| `npx vitest run test/ink src/features/workspace/ink` (web) | 17 files · **138 passed** |
| `npm run typecheck` | exit 0 |
| `npm run lint` (`eslint . --max-warnings 0`) | exit 0 |
| `npm run build` | exit 0 (PWA: 271 precache entries) |
| `E2E_BUILD=0 npx playwright test` (full suite, phone + desktop, real server, after the build above) | **116 passed**, 11 skipped (perf specs are opt-in; one phone-only check on desktop), **7 failed** (21.1 min) |
| the 2 failing specs on the committed code without this change (`git archive HEAD` copy in the scratch area, its own web build and server): `npx playwright test e2e/g1-ac04-printed-page.spec.ts e2e/g6-ac28-pencil.spec.ts` | 3 passed, **the same 7 failed with the same errors** → not caused by this change |

The 7 E2E failures (pre-existing, not fixed here — outside this task):
* `g6-ac28-pencil.spec.ts` ×3 on each project — the spec's expectations are older than track F4: it expects the ink
  panel's recognition row to say «غير منفّذ بعد» (it now says «يحتاج إعدادًا على الخادم», `ink/capabilities.ts`, F4) and the
  Control Center recognition text not to contain «تعمل» (it now says «كتابتك نفسها تُحفظ وتعمل كاملة دونه»). The product
  is honest (recognition needs a vision provider that is not configured); the spec needs updating.
* `g1-ac04-printed-page.spec.ts` «detected labels» on the **phone** — a real layout defect: with the reader on a page that
  has no printed number, the compact page indicator «الصفحة 1 في الملف» in the phone top bar runs under the save-status
  icon, which takes the tap (Playwright: `ml-save-status … intercepts pointer events`), so «الانتقال إلى صفحة» cannot be
  opened by touching its visible text. Passes on desktop.

Not run: the opt-in perf specs (`MEDLEVO_PERF=1`), `.github/workflows/ci.yml` on a GitHub runner, anything needing
ANTHROPIC_API_KEY.

## Round 7 — final verification (2026-10-20, 19:39 → 21:00 UTC, run in this container)

The whole tree after Round 7 (H1–H4, their reviews and the react-hooks lint track; 127 changed / new paths uncommitted
at the start, on top of `HEAD` deba34e). Same environment as above (Node 22.22, Chromium at
`/opt/pw-browsers/chromium`, no `ANTHROPIC_API_KEY`); `NODE_OPTIONS='--disable-warning=ExperimentalWarning'`. Every
command was run from the repository root; durations are wall-clock.

### 1. First pass (before any change of this task)

| # | command | exit | duration | result |
|---|---|---|---|---|
| 1 | `npm run typecheck` | 0 | 50 s | no type errors (shared, server, web, e2e) |
| 2 | `npm run lint` (`eslint . --max-warnings 0`) | 0 | 62 s | no problems |
| 3 | `npm test` | 0 | 355 s | shared 8 files · **85 passed** (1.3 s) · server 143 files passed, 7 skipped · **1513 passed**, 7 skipped (255.4 s) · web 130 files passed, 1 skipped · **802 passed**, 1 skipped (95.5 s) |

### 2. The two known E2E failures, fixed (each reproduced first)

* `g1-ac04-printed-page.spec.ts` «detected labels» on the **phone** — a real layout defect. Measured in the built app
  on the real server (a throwaway Playwright probe, phone project): the reader's phone bar left the title column
  **60 px** at 390 px (45 at 375, 30 at 360); the compact indicator «الصفحة 1 في الملف 1/14» is 155 px wide and even
  «ص 12 14/14» (94 px) overlapped the save icon by 26 px, which took the tap. Fixed in `chrome/TopBar.tsx`,
  `chrome/GoToPage.tsx`, `workspace.css` (save state on the title line, 4 px icon gaps, the indicator bounded by its
  column, the redundant count dropped) → title column **124 px** at 390 px. New `TopBar.phone.final.test.tsx` (3; 2 fail
  on the HEAD versions of the two components, swapped in and restored for the check); the spec now also asserts on the
  phone that no control of the bar overlaps the indicator (390 px on «ص 12»; 390 / 375 / 360 px on the cover).
* `g6-ac28-pencil.spec.ts` ×3 per project — expectations older than track F4 (recognition is
  `requires_configuration`, not «not built»; the Control Center reason «…وتعمل كاملة دونه» speaks of the owner's
  writing). The spec now asserts the honest states (row «يحتاج إعدادًا على الخادم», the lasso's vision reason, the
  card's state pill «تحتاج إعدادًا على الخادم» + `ANTHROPIC_API_KEY` in its reason). No product change.

| command | exit | duration | result |
|---|---|---|---|
| `npx playwright test e2e/g1-ac04-printed-page.spec.ts e2e/g6-ac28-pencil.spec.ts` | 0 | 64 s | **10 passed** (phone + desktop) |
| `npm run build` | 0 | 5 s | built in 2.0 s; PWA **271 precache entries** (4 587 KiB) |
| `npm run eval -- --label=round7-final --compare=docs/eval/baseline.json` | 0 | 14 s | regression **80 / 80**, tuning **69 / 69**, every axis at its full count; compare `no_regressions` (`eval-20261020T195216-38d50040`) |
| `npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record` (the CI gate) | 0 | 10 s | regression 80 / 80, `no_regressions` |
| `npm run e2e -- --output=e2e/.artifacts/final-results` (full suite, phone + desktop) | 0 | 1 134 s (18.9 min) | 134 tests: **123 passed, 0 failed, 11 skipped** (`perf.spec.ts` ×10 opt-in; one phone-only check of `h3-reader-notes` on desktop) |

### 3. Critic pass (step 2 of the task)

`e2e/critic-screens.spec.ts` (light + dark, 390 and 1280 px, real server, Golden Set data) was extended with the 8
top-level screens added in Rounds 6–7 that it did not open (`/library/topics`, a topic page, `/concepts`, `/knowledge`,
`/exams/simulate`, `/control/visual-sources`, `/control/health`, `/control/evaluation` → 55 screens + login / recover)
and with two probes (an `<li>` whose leading icon sits on a line of its own; raw markdown code in visible text). The
screenshots (`e2e/.artifacts/critic/<project>/`) were looked at; found and fixed, each with a test that failed first:

| finding | fix | test |
|---|---|---|
| «محاكاة مولدة»: each «حدود العينة» warning icon on its own line above its text (both widths) | `exams.css` `.ex-list--icons` (icon as bullet, `role="list"` kept) | the sweep's new icon probe (failed on `exams-simulate` only, then passed) |
| «7 سؤالًا فريدًا», «5 من 7 سؤالًا فريدًا» in Exam DNA / simulation wording | `learning/dna.ts uniqueQuestionsAr` / `partOfUniqueQuestionsAr`, used by `exams/simulation.ts` | `srv:learning/golden.test.ts` «(Round 7 final)» |
| «تقييم الجودة» empty state printed raw backticks, the Arabic paragraph reordered the options / paths | `EvaluationScreen` `CommandText` (`<bdi><code dir="ltr">`), server text marks its paths | `web:src/features/control/EvaluationScreen.final.test.tsx` (2) + the sweep's raw-markdown probe |
| «خريطة معرفتي»: «0 من 1 صفحات يُذكر فيها», «0 محاولة على 1 سؤال»; the reasons «12 أسئلة مرتبطة»، «أجبت 12 مرات» | counted nouns in `KnowledgeScreen.tsx` and `brain/student.ts` | `web:src/features/brain/KnowledgeScreen.final.test.tsx`, `srv:brain/knowledge-counts.final.test.ts` (2) |

Looked at and left as they are (reported, not defects of this round): the full-page screenshots show the fixed bottom
navigation in the middle of tall phone pages (a screenshot artefact of `position: fixed`); breadcrumb links and the skip
link are 24 / 43 px tall on the phone (listed by the probe for a human look; inline text links); the appendicitis
lecture's first page is «تحتاج مراجعة» by design (the tanween glyph mapped to a stray «S» — a Golden Set known defect
that must flag the region); the disabled «ولّد المحاكاة وتحقق منها» button has low contrast because it is disabled
(its reason is shown above it). Known limit added: at 375 / 360 px the phone bar ellipsises the front-matter label
«الصفحة 1 في الملف» (full text in its accessible name and the go-to popover).

| command | exit | duration | result |
|---|---|---|---|
| `npx playwright test e2e/critic-screens.spec.ts` (extended, before the icon probe) | 0 | 262 s | 4 passed |
| `npx playwright test e2e/critic-screens.spec.ts --project=desktop -g "every top-level"` (with the icon probe, before the fix) | **1** | 121 s | **1 failed**: `exams-simulate: list items whose icon sits on a line of its own` (7 items) — reproduced |
| `npx playwright test e2e/critic-screens.spec.ts` (after the fix) | 0 | 265 s | 4 passed (phone + desktop) |
| targeted unit runs while fixing (`vitest run` of the new / touched files, server `test/brain`, `test/learning/golden.test.ts`, `test/f3`, `test/exams`, `test/control/evaluation.test.ts`) | 0 | — | all passed; each new test failed before its fix |

### 4. Final runs (after every change of this task, 20:31 → 20:58 UTC)

| # | command | exit | duration | result |
|---|---|---|---|---|
| 1 | `npm run typecheck` | 0 | 46 s | no type errors |
| 2 | `npm run lint` | 0 | 52 s | no problems |
| 3 | `npm test` | 0 | 319 s | shared 8 files · **85 passed** (1.0 s) · server 144 files passed, 7 skipped · **1516 passed**, 7 skipped (229.8 s) · web 133 files passed, 1 skipped · **808 passed**, 1 skipped (86.2 s) |
| 4 | `npm run build` | 0 | 5 s | built in 1.7 s; PWA **271 precache entries** (4 587 KiB) |
| 5 | `npm run e2e -- --output=e2e/.artifacts/final-results2` (full suite incl. the extended critic sweep) | 0 | 1 180 s (19.7 min) | 134 tests: **123 passed, 0 failed, 11 skipped** — every spec passed on both projects (the 11 skipped are `perf.spec.ts` ×10, opt-in, and the phone-only `h3-reader-notes` item 5 on desktop) |
| 6 | `npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record` | 0 | 10 s | regression **80 / 80**, `no_regressions` (`eval-20261020T205821-5570e552`) |

E2E per spec (run 5; phone + desktop): `critic-screens` 4 · `f1-notebook-pages` 6 · `f2-course-brain` 4 ·
`f3-study-modes` 4 · `f4-handwriting-audio` 6 · `f5-quality-ops` 6 · `g1-ac01` 4 · `g1-ac02` 2 · `g1-ac03` 2 · `g1-ac04` 4 ·
`g2-ac05` 2 · `g2-ac06` 2 · `g2-ac29` 2 · `g3-ac08` 2 · `g3-ac09` 2 · `g3-ac13` 2 · `g4-ac10-ac11` 2 · `g4-ac12-ac14-ac15` 2 ·
`g5-ac16` 6 · `g5-ac17-ac19` 6 · `g6-ac20` 4 · `g6-ac21` 4 · `g6-ac22` 6 · `g6-ac28` 6 · `g7-ac23` 2 · `g7-ac24` 4 · `g7-ac30` 2 ·
`g8-ac26` 2 · `g8-ac27` 2 · `g8-security` 8 · `h3-reader-notes` 5 (+1 skipped) · `h4-exports-sources` 4 · `smoke` 4 — all passed;
`perf` 10 skipped. No flaky test was seen: both full runs (sections 2 and 4) were green with `retries: 0`.

#### Totals of Round 7

| suite | passed | skipped (opt-in / project-specific) | failed in the final run |
|---|---|---|---|
| shared (vitest) | 85 | 0 | 0 |
| server (vitest) | 1 516 | 7 | 0 |
| web (vitest) | 808 | 1 | 0 |
| E2E (Playwright, real server, phone + desktop) | 123 | 11 | 0 (7 in the Round 7 lint run → both causes fixed here) |
| evaluation (scripted mode) | regression 80 / 80 · tuning 69 / 69 | — | 0 |

#### Not run in this task (and why)

| what | why |
|---|---|
| A live AI provider; `npm run eval -- --mode=live` | no `ANTHROPIC_API_KEY` — every AI path stays tested only with the test-only scripted / fake providers, and the real server reports `requires_configuration` (asserted by the E2E specs) |
| `MEDLEVO_PERF=1` suites (`apps/server/test/perf/*.perf.test.ts`, `e2e/perf.spec.ts`, `apps/web/test/learning/queue.perf.test.ts`) | opt-in by design (several minutes, generated 300-page PDF); last numbers in `docs/PERFORMANCE.md` (H4 re-measured the Course Brain recompute) |
| The ink harness `npx playwright test -c apps/web/test/ink/playwright.config.ts` | not re-run in this task (no ink engine change); the ink E2E specs (`g6-ac21`, `g6-ac22`, `g6-ac28`, `f1`, `f4`, `h3`) passed |
| `.github/workflows/ci.yml` on a GitHub runner | no runner here; each of its commands was run locally above |
| Real iPad / iPhone / Apple Pencil, Safari / iPadOS / Firefox, screen readers (VoiceOver / NVDA / TalkBack) | no device or screen reader in this container; Chromium phone (390 × 844, touch, DPR 2) and desktop projects only |
