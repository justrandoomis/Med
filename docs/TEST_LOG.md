# Test log (§58, §61)

The full suites, run on 2026-10-10 in the integration and acceptance round, with the exact commands, counts,
durations and failures as they happened. A test that needs something this environment does not have is listed under
**Not run** with the reason — never as passed (§58).

> **Latest full verification:** «Release R1-a — final verification» (2026-10-21) at the end of this file — `npm test`
> 2 784 passed (shared 109, server 1 765, web 910), full E2E 133 passed / 0 failed on phone + desktop, typecheck / lint /
> build / evaluation gate (80 / 80) green. The previous one: «Round 7 — final verification» (2026-10-20).

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

## Academic OS P1-T1 step 0 — Wave 1 seams (2026-10-20, run in this container; the PL-0 deploy track was editing the tree in parallel)

Seams only, no behaviour change for the single owner (`docs/modules/tenancy.md`). Each new test was run first and failed
before the change (missing module / column / export), then passed.

| new test file | tests | what it proves |
|---|---|---|
| `packages/shared/test/academic-step0.test.ts` | 10 | error codes and capability keys appended only (Round 7 lists unchanged in place); HTTP status of each Phase 1 code; `academic/` barrel re-exported; visibility vocabulary, Arabic labels without bidi controls, zod schemas; sync `detail_code`; client-version header name |
| `apps/server/test/tenancy/migrations-0041-0050.test.ts` | 4 | fresh DB; a Round 7 owner database **with rows** upgrades with every row unchanged and new columns NULL, nothing else in the schema moved, re-run is a no-op, feed head continues; partial index used by the space pull filter; the server boots on an upgraded data directory and sync push/pull and the audit list keep working |
| `apps/server/test/tenancy/purge-extension.test.ts` | 7 | without an extension an unknown referencing table still aborts the purge; an extension counts in the preview, binds the confirm token (409 after a change), deletes in the purge transaction and is announced to sync; a failing extension rolls the whole purge back; `fill` adds ids to a core set; today's preview / purge answer shape unchanged with none registered; per-app registry; blob deletion delegated to `files/blobs.ts` |
| `apps/server/test/tenancy/capabilities-step0.test.ts` | 2 | the 8 ADR-0005 §6 keys answer `not_implemented` with an Arabic reason; today's keys keep their states |
| `apps/server/test/tenancy/binding-harness.test.ts` | 5 | `withTestBinding` is a pass-through (values, promises, errors) |
| `apps/web/test/tenancy/localdb-phase1-schema.test.ts` | 6 | Dexie v3 appended; a v2 database holding a row in every table (unsynced rows and pending / rejected outbox ops included) opens at v3 with every row identical; new tables and indexes work; `annotation_layer → layers`; per-user name seam; draft ownership rule |
| `apps/web/test/tenancy/sync-onrejected.test.ts` | 10 | `onRejected` fires once per final rejection after it is stored (also with the server copy and for a duplicate reporting an original rejection), never for a retryable answer; a failing handler never breaks sync; unregister; no handler = today's behaviour; vault ops keep today's shape; space ops are never pushed to the vault; coalescing per target; malformed target refused |
| `apps/web/test/tenancy/capabilities-screen-step0.test.tsx` | 1 | the Control Center «القدرات» still lists exactly today's rows |

One existing test was edited (outside the harness): `apps/web/src/features/workspace/data/annotationsAtScale.test.tsx`
pinned `verno` to 2; it now accepts a later local schema version (v3 opens the same database).

Final runs (after the last change of this step):

| command | result |
|---|---|
| `npm run typecheck` · `npm run lint` | exit 0 · exit 0 |
| shared (vitest) | **95 passed** (85 + 10) |
| server (vitest, full suite, re-run once) | **1 601 passed, 7 skipped, 1 failed** — the failure is `g8-security` «only the SSRF guard … may open outbound connections», which flags `apps/server/src/lib/proxy.ts`, a new file of the PL-0 deploy track still in progress (first run also failed `env-example` on PL-0's `MEDLEVO_CLIENT_IP_HEADER`; fixed by PL-0 before the re-run). All 18 step-0 server tests pass |
| web (vitest, full suite) | **825 passed, 1 skipped** (808 + 17). The first full run reported one unhandled rejection from `ReanchorSection.review.h3.test.tsx` (a `setBusy` after jsdom teardown; that test mocks the sync engine): passed 5/5 alone and the full re-run was clean — a pre-existing timing race |
| `npm run build` | exit 0; PWA 271 precache entries |
| `npx playwright test` (full E2E, phone + desktop) | **123 passed, 0 failed, 11 skipped** (19.9 min) |
| `npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record` | regression **80 / 80**, `no_regressions` |

Not run: nothing device- or account-dependent belongs to step 0.

## Academic OS P1-T1 step 0 — adversarial review (2026-10-20, run in this container; PL-0 still editing the tree)

Every changed file of step 0 was read. Three findings were reproduced by tests that failed before the fix (details and
severities in `docs/modules/tenancy.md`, «Step 0 review»):

| new test file | tests | failed before the fix | what it proves |
|---|---|---|---|
| `apps/web/test/tenancy/sync-onrejected.review.test.ts` | 5 | 3 | a final rejection pushed while no handler of its type is registered (lazily mounted workspace, another tab) or across a reload reaches the handler registered later exactly once; a handler that threw gets it again on its next registration, never after success; a retried (superseded) op is not handed over; a push and a registration racing deliver once |
| `apps/server/test/tenancy/purge-extension.review.test.ts` | 5 | 4 | `fill()` removing ids from a core set is refused (preview and purge, nothing deleted); `apply()` removing or adding core-set ids after the token check rolls the purge back; the new `afterCore()` step deletes rows that purged core rows referenced (a layer referenced by `note.layer_id`), which `apply()` cannot (foreign key) |
| `apps/web/test/tenancy/localdb-old-tab.review.test.ts` | 1 | — (confirms a claim) | a tab still on schema v2 opens the upgraded v3 database and its target-less outbox op is pushed to the vault by the new code (fake-indexeddb; not run with two real builds in a browser) |

Final runs after the review fixes:

| command | result |
|---|---|
| `npm run typecheck` · `npm run lint` | exit 0 · exit 0 |
| `npm test` | shared **95 passed**; server **1 609 passed, 7 skipped, 0 failed** (157 files; PL-0's `g8-security` / `.env.example` failures of the step-0 run are gone); web **834 passed, 1 skipped** (139 files), no unhandled error; exit 0 |
| `npm run build` | exit 0; PWA 274 precache entries |
| `npx playwright test` — `smoke`, `g7-ac23-offline`, `g7-ac24-two-devices`, `g7-ac30-restore`, `h3-reader-notes`, `f1-notebook-pages`, `g1-ac01-personal-library` (phone + desktop, `/opt/pw-browsers/chromium`, `E2E_BUILD=0` on the fresh build) | **27 passed, 1 skipped, 0 failed** (6.9 min) |

Not run in this review: the full E2E suite (the specs above are the ones that exercise sync, the outbox, the Dexie
schema, notes and the library; no E2E spec reaches the purge confirm flow), the evaluation regression (no AI, search or
evidence code changed), and anything device- or account-dependent.

## Academic OS P1-T3 — lecture identity, version matching and import intelligence (2026-10-20 → 21, run in this container; P1-T2 and PL-0 were editing the tree and running their own suites in parallel)

New tests of this track (all on labelled TEST FIXTURES, `apps/server/test/fixtures/versions/`):

| test file | tests | what it proves |
|---|---|---|
| `apps/server/test/versions/numbering.test.ts` | 26 | number / date / title / subject detection (Arabic-Indic digits, ordinal words, noisy names); certain → `detected`, uncertain → open suggestion with no effect; owner values never overridden; rejected values remembered |
| `apps/server/test/versions/page-map.test.ts` | 9 | normalisation, the order-preserving matcher (inserted / removed / changed / moved, ambiguity → uncertain, owner decisions fixed); Scenario 4 exact map; re-export all safe; compare API; purge of maps |
| `apps/server/test/versions/new-version-detect.test.ts` | 3 | «إصدار جديد من …» proposed for the renamed v2, nothing applied until accepted; reject remembered; unrelated deck never proposed; an upload with writing stays |
| `apps/server/test/versions/link-candidates.test.ts` | 3 | pure `matchLinkCandidates` (sha256 / ≥ 60 %), threshold, route inside this database |
| `apps/server/test/versions/import-intelligence.test.ts` | 7 | subject top-1 precision on the fixture set (**22/22 = 1.000, recall 22/24 = 0.917**), placement only on accept, lecture order (pure + apply), printed contents → page links, fixtures byte-identical to the generator |
| `apps/server/test/processing/docx-display-pdf.test.ts` | 3 | DOCX display PDF (fonts embedded, page count stable over two runs, locators untouched), «unavailable» without LibreOffice, purge releases it |
| `apps/web/src/features/sources/versions.test.tsx` | 6 | words not colours, suggestion card decide flow, compare rows / review buttons / pending state, and (fix during the gates) the upload screen's suggestions never throw on an answer without a list |
| `e2e/aos-p1-versions.spec.ts` | 1 × 2 projects | Scenario 4 steps 2–3 on the real server: proposal → compare (42 rows, 2 inserted, 1 changed «تحتاج تأكيدك») → confirm → version 2; identity tab; structural a11y probe; light + dark screenshots |

Found and fixed while running the gates: the first full `npm test` reported an **unhandled error** from this track's
`ImportSuggestions.tsx` (`upload.test.tsx` answers every request with a processing status, so the identity answer had no
`suggestions` list and the component threw). Reproduced by the new web test above (failed: «Cannot read properties of
undefined (reading 'filter')»), then fixed by treating a missing list as empty. `e2e/aos-p1-versions.spec.ts` had one
type error (`source_id` possibly undefined) — fixed.

Final runs (after the last change of this track):

| command | result |
|---|---|
| `npm test` — shared | **109 passed** (11 files) |
| `npm test` — server | **1 695 passed, 7 skipped, 0 failed** (175 files) |
| web (vitest, full suite, re-run after the fix above) | **856 passed, 1 skipped, 1 failed** — the failure is P1-T2's in-progress `test/ink/layers-visibility.test.ts` («new writing goes to the active layer…»); the first run's failure was P1-T2's `test/ink/persistence.test.ts` (`layer_id`), which passed on the re-run. No unhandled errors. |
| `npm run typecheck` (each project) | shared ✓, web ✓, e2e ✓; server **2 errors, both in P1-T2's `apps/server/test/annotations/ink-v2.test.ts`** (TS2352). Re-run once: unchanged. |
| `npm run lint` | **1 error in P1-T2's `apps/server/src/modules/annotations/sync.ts`** (unused `InkData`); the first run also had a parse error in P1-T2's `workspace/ink/layers/useLayerView.ts`, gone on the re-run. No finding in this track's files. |
| `npm run build` | exit 0; PWA 281 precache entries |
| `npx playwright test` (full E2E, phone + desktop, `/opt/pw-browsers/chromium`) | **124 passed, 1 failed, 11 skipped** (20.7 min). The failure — `g5-ac16-late-linking` «AC-16 (Arabic)» desktop — is `ENOENT` writing its trace file: P1-T2 started its own Playwright run at the same time, which cleared the shared `e2e/.artifacts/test-results`. Re-run of that spec with a separate `--output`: **6 passed** (phone + desktop). `aos-p1-versions` passed in the full run (phone + desktop). |
| `npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record` | regression **80 / 80**, `no_regressions` |

Not run (and why): anything on a real device (no iPad / phone / e-ink here), real course files (none in this
container — precision is on the fixture set only), a real axe-core audit (not in the repository; the E2E uses a
structural probe), DOCX fidelity beyond the one Arabic/English fixture.

## Academic OS P1-T3 — adversarial review (2026-10-21, run in this container; P1-T2 and its reviewer were editing the tree and running their own suites in parallel)

Every changed file of P1-T3 was read (shared `academic/versions.ts`, migrations `0160` / `0161` / `0164`,
`sources/classify.ts`, `processing/fingerprint.ts`, `modules/versions/*`, the seam lines in `pipeline.ts` and
`modules/index.ts`, the web screens and the tests). Each finding was reproduced by a probe test or script before the fix
(probes kept outside the repository; scratch script for detection); the regression tests below fail without their fix:

| new / changed test | tests | what it proves (failed before the fix) |
|---|---|---|
| `apps/server/test/versions/review-regressions.test.ts` (new) | 25 | **page map:** two confirmed pairs that cross (a swap the owner confirmed) are both kept, the 2nd «نفس الصفحة» answers 200 (was 500 `UNIQUE constraint failed`, and every later recomputation failed), a confirmed page that no longer exists does not break recomputation; **collisions:** the same short caption on a different picture is not `safe` / `layout_safe` (was), two different pictures paired by place read «changed» (were «لم تتغير»), a moved figure on a text-identical page clears `layout_safe` (verified failing with the old `LAYOUT_KINDS`); 300 × 302 identical pages aligned within a loose bound (415 ms → ≈150 ms); **detection:** «Lecture 5-6», «Lec 5, 6», «05 + 06», «5 to 7», «المحاضرة الأولى والثانية», «المحاضرتان …», «محاضرة 5 الى 6» are uncertain (were stored as certain), a date after the number is not a second lecture; **identity:** a stored number the latest analysis doubts stays visibly applied and rejecting it clears it (it stayed 5), a contradicted one is withdrawn (stayed 5 «detected»), owner values untouched; **new version:** an upload carrying the owner's flashcard is not trashed (was); **DOCX:** re-making releases the previous display PDF (orphan before), a failed re-run keeps the previous one; **purge:** a proposal naming a purged lecture is closed (stayed open); **page images:** the render limiter never exceeds 3 and 12 concurrent thumbnails all arrive |
| `apps/server/test/versions/page-map.test.ts` | 9 | expectation updated to the new scheme `fp2:` (fingerprints now include figure / diagram geometry) |
| `apps/web/src/features/sources/versions.test.tsx` | 11 (was 6) | a decision whose page is gone says so (it read «أكّدت أنها ليست نفسها»); identity form sends only the changed field (it sent `held_on: null` with the number, answering an open date suggestion and stopping date detection) and accepts «٥» (was refused); a stored-but-doubted value says so; the compare breadcrumb names the source it links to (named the upload); the lecture-order screen (no test before): looking changes nothing, switching mode asks again, applying posts `{node_id, mode}` |

Final runs after the review fixes:

| command | result |
|---|---|
| `npm run typecheck` (each project) | shared ✓, server ✓, web ✓, e2e ✓ (exit 0 each) |
| `npm run lint` | exit 0 (`--max-warnings 0`) |
| `npm test` — shared | **109 passed** (11 files) |
| `npm test` — server (full) | **1 737 passed, 7 skipped, 0 failed** (171 files passed, 7 skipped) |
| web (vitest, full) | **884 passed, 1 skipped, 1 failed** — the failure is P1-T2's in-progress `test/ink/tiles.test.ts` («switching e-ink on … redraws a dense page …»; P1-T2's `workspace/ink/{palette,render}.ts` were being edited at the time); re-run once: unchanged; not this track's files, not edited. This track's `versions.test.tsx` and `upload.test.tsx` pass |
| `npm run build` | exit 0; PWA 282 precache entries |
| `npx playwright test e2e/aos-p1-versions.spec.ts e2e/smoke.spec.ts` (phone + desktop, `/opt/pw-browsers/chromium`, `E2E_BUILD=0` on the fresh build, own `--output`) | **6 passed, 0 failed** (50 s) |
| `npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record` | regression **80 / 80**, `no_regressions` |

Measured here (container, not a device): 300 → 302 text pages — `getPageMap` 30 ms, compare 26 ms, pure alignment
20 ms; dHash rendering ≈ 27 ms per text-less page (60 pages: 1.65 s, background job). Not run (and why): anything on a
real device (no iPad / phone / e-ink), real course files (none here; precision stays fixture-only), axe-core (not in the
repository), the full E2E suite (the track's spec and the smoke spec were run, as the review asks).

## PL-0 — phone-only deploy (Render + R2 off-site backups): adversarial review (2026-10-21, run in this container; P1-T2 and P1-T3 were editing the tree in parallel)

Every changed file of PL-0 was read (Dockerfile, `.dockerignore`, `render.yaml`, `deploy/docker/*`, `config.ts` / `app.ts`
hunks, `lib/proxy.ts`, `lib/objectstore/*`, migration `0751`, `modules/data/offsite*.ts`, the restore CLI, the Control
Center screen and row, the three guides, `.env.example`, the CI job). Render's Blueprint spec and Infrastructure-as-Code
pages were read on 2026-10-21 (plan ids `0.5c-512mb` / `1c-2g`, `generateValue` = base64 of 256 bits, `sync: false`
prompted only at creation, and «the next Blueprint sync overwrites» dashboard edits of variables the Blueprint defines).
Findings reproduced by tests or scripts that failed before the fix:

| new / changed test | tests | failed before the fix | what it proves |
|---|---|---|---|
| `apps/server/test/deploy/render-blueprint.test.ts` (new) | 3 | 1 | `render.yaml` pinned `MEDLEVO_DATA_DIR` (and `MEDLEVO_ORIGIN`, `MEDLEVO_TIMEZONE`, schedule, retention) — the restore switch done in the dashboard was undone by the next Blueprint sync, moving the server back to the pre-restore data; the image and `config.ts` now carry the defaults; secrets stay `sync: false` / `generateValue` |
| `apps/server/test/data/offsite-review.test.ts` (new) | 10 | 9 | three failed runs left three full archives on the disk the live database is on (now: the newest one stays); a finally failed run left its multipart upload open (now aborted); a download still receiving bytes failed after `maxAttempts` per-request timeouts (now only rounds without progress count); a completion whose answer was lost failed the run although R2 held the object (now accepted by its exact size); a job killed on its last attempt left the run «running» for good — 409 for «نسخ احتياطي الآن» and every scheduled slot skipped (now healed on status / start / tick, twice tested); a run whose verification failed no longer displaces the newest verified local archive (not yet in R2); the status notes no longer put two English words around an arrow (RTL reversal); the owner-wait of the scheduler (claimed, untested before) holds |
| `apps/server/test/data/fake-s3.ts` | — | — | gains a `lostAnswer` fault (the request is carried out, the answer is cut) and `clearFaults()` |
| `apps/web/src/features/control/offsite.test.tsx` | 3 | 1 | the restore steps say to ADD `MEDLEVO_DATA_DIR`; «Render ← خدمة MedLevo ← Shell» and «Render ← Environment» were un-isolated LTR runs whose arrows read reversed on the phone (seen in the probe screenshot) — every English step is now its own `<bdi>` |
| `.dockerignore` (script, BuildKit `--output type=local` of a `FROM scratch` / `COPY . /` context, scratch dockerd) | — | yes | with the builder's root-only `.env` patterns, `apps/web/.env.local` and `apps/server/.env` reached the build context (and the web build stage); with `**/.env*` they do not |

Final runs after the review fixes:

| command | result |
|---|---|
| `npm run typecheck` · `npm run lint` | exit 0 · exit 0 (re-run on the final tree) |
| `npm test` (full, before the last two refinements) | shared **109 passed**; server **1 710 passed, 7 skipped** (177 files); web **876 passed, 1 skipped** (145 files); exit 0. A first full run was killed from outside («Terminated», exit 143, while P1-T2 / P1-T3 were running their own suites) and is not counted |
| targeted re-runs on the final tree | server `test/data` + `test/deploy` + `acceptance/g8-security` + `acceptance/g7-ac30` + `app.test.ts`: **23 files, 202 passed**; then `test/data/offsite{,-review}`: **26 passed**; web `src/features/control`: **6 files, 28 passed** |
| `npm run build` | exit 0; PWA 282 precache entries |
| `npx playwright test` — `smoke`, `f5-quality-ops`, `g8-security`, `critic-screens` (phone + desktop, `/opt/pw-browsers/chromium`, `E2E_BUILD=0` on the fresh build) | **22 passed, 0 failed** (6.0 min), run twice (before and after the RTL fix) |
| scratch probe (outside the repo; the critic sweep does not visit the new screen): `/control` and `/control/offsite`, not configured, light + dark, phone + desktop | **2 passed**: healthy RTL screen, exactly one h1, no unnamed control, no sideways scroll, text contrast ≥ 4.5:1 in both schemes, 44 px targets on the phone, button disabled with its reason; screenshots checked by eye |


Not run (reason): Render, Cloudflare R2, a phone or an iPad (no account, no device); the CI `docker` job on GitHub (no
runner access); a full image rebuild by the reviewer (the Dockerfile and entrypoint did not change; the builder's local
image build stands); the evaluation regression (no AI, search or evidence code changed).

## Academic OS P1-T2 steps 1–2 — layers, history, packed ink, tile cache, display modes, native skeleton (2026-10-20 → 21, run in this container; P1-T3, PL-0 and the PL-0 review were editing the tree and running their own suites in parallel)

New tests of this track. Each was run first and failed before the change it covers (missing module / column / export,
or the wrong behaviour), then passed.

| test file | tests | what it proves |
|---|---|---|
| `packages/shared/test/layers.test.ts` | 5 | document keys; the derived, stable id of «ملاحظاتي»; the access table (own kinds write, followed / snapshot read-only, collaborative CRDT-only, space kinds refused in a vault); which kinds a client may create (titles trimmed, bidi controls refused); Phase 1 copies exactly one layer |
| `packages/shared/test/ink-codec.test.ts` | 9 | packed points round-trip losslessly (exact floats, negative coordinates, mixed arity); points it cannot carry exactly → `null` (the stroke stays v1); corrupt data rejected; `accept-ink: 2` negotiation (no header → v1); engine rounding |
| `apps/server/test/annotations/layers-migration.test.ts` | 2 | `0271` on a Round 7 database with writing: every annotation and note byte for byte, all on «ملاحظاتي» (`layer_id` NULL); the upgraded server lists and serves it unchanged and an old client keeps editing it |
| `apps/server/test/annotations/layers.test.ts` | 16 | R1–R6 on the real sync path: a stroke, a raw delete (eraser), a move / recolour / re-layer or a note on a followed or snapshot layer `rejected/layer_read_only` with the server copy back; collaborative layers `use_crdt`; space kinds, unknown and other documents' layers, another author's item `layer_forbidden`; R3 conflict copies on the actor's own layer; the layers list, create / hide / delete rules, REST 409 `LAYER_READ_ONLY`; the exact payload the web client sends is applied |
| `apps/server/test/annotations/history.test.ts` | 6 | `0272` before-images for update / delete / restore of strokes, notes and layers (none for a create or a refused op) and for manual re-anchoring; history newest first with paging, per layer, unknown layer 404; purge preview counts and deletes revisions, attribution and the document's layers |
| `apps/server/test/annotations/layer-copy.test.ts` | 9 | preview counts per kind and page (nothing written), then derived ids, attribution (`0861`) and an unchanged source; re-run no-op (an erased copy is not brought back); kind / page filters; a followed explanation copied with its author kept, or credited to the layer origin's author; page matching into another copy of the lecture or skipped with a reason; never into a read-only layer, no merge; small sort order for a new layer; 5 000-stroke copy timing |
| `apps/server/test/annotations/ink-v2.test.ts` | 5 | a v2 client's packed points stored as v1 and answered in v2, an old client reads v1 exactly as before; an off-grid stroke stays v1; corrupt or out-of-range packed points refused with a reason; 19.86 MB → 7.84 MB on a 5 000-stroke page |
| `apps/web/test/ink/layers-visibility.test.ts` | 13 | layer list and session hidden set; editable / active-layer rules; new writing on the active layer; the split pane's other document exempt; selection edits skip read-only items; «انسخ إلى طبقتي»; hiding a layer drops it from the selection; render, hit-test and eraser honour the predicate; `createLayer` gets a small sort order |
| `apps/web/test/ink/rehome.test.ts` | 6 | a refused stroke is re-created on «ملاحظاتي» under a derived id once (also on a second delivery); a refused edit keeps the server's original and the edit lives on in «ملاحظاتي»; a refused erase shows the item again; notes the same; other rejections unchanged |
| `apps/web/test/ink/tiles.test.ts` | 12 | tiles ↔ page boxes; warm repaint draws no stroke; light pages unchanged; tiles off switch; cold tiles in slices, never one long task; writing keeps the grid warm; off-screen change → only those tiles stale; reload redraws all; per-visible-set grids (5 layers); lock-only change repaints nothing; LRU eviction keeps the grid on screen; zoom back is warm |
| `apps/web/src/design/themeDisplay.test.tsx` | 5 | `data-eink` / `data-contrast` / `data-lite`, kept on this device only; e-ink forces light colours / reduced motion / no grain without changing the stored appearance; suggestion only from `(update: slow)` |
| `apps/native/test/static-checks.test.mjs` (`node --test`) | 4 | the committed config, package and workflows pass; refused: a remote app URL, cleartext, mixed content, a bad id; a workspace shell or mixed Capacitor majors; push triggers, write tokens, unpinned actions, literal keys |
| `e2e/aos-p1-layers.spec.ts` | desktop flow + phone panel | a followed layer (seeded on the real server) is read-only everywhere (UI refuses, a raw delete is refused); hide / show kept across a reload; lasso copy; «انسخ الطبقة…» with attribution; «سجل الطبقة»; re-homing of a refused stroke; phone: RTL, 44 px targets, no sideways scroll |
| `e2e/aos-eink.spec.ts` | 2 × phone + desktop | e-ink: no transition / animation, black-grey palette, paging reader, grey ink, kept after a reload, off again; no suggestion without the signal; contrast and lite independent |
| `e2e/perf.spec.ts` «dense page, 5 layers» | 1 (MEDLEVO_PERF=1, desktop) | before / after numbers in `docs/PERFORMANCE.md` from the same harness and build |

One existing test of another track was changed minimally: `apps/server/test/tenancy/capabilities-step0.test.ts` (P1-T1)
listed `ui.eink_mode` as `not_implemented`; the key is now set to `available` by this track's module, so it moved out
of that list into a new test (smallest change; the P1-T1 owner may want to review it).

Found and fixed while running the gates (each reproduced first):

* the active-layer stamp created a new object for items with `layer_id` NULL, which broke `persistence.test.ts`'s
  identity check → items are stamped only when a non-default layer is active;
* the first tile design built 400+ ms long tasks (canvas raster is deferred) → cold tiles drawn into CPU surfaces with a
  1 px read-back per chunk (`docs/PERFORMANCE.md` #10); a whole-page reload marked every off-screen grid stale (#11);
* a layer created on the web was rejected by the server (`sort_order` = `Date.now()` > 1e12) → small ordinals on the
  client and for the server's copy target;
* the attribution line named «كاتب آخر» instead of the origin author → the server uses the layer origin's author name;
* server typecheck TS2352 in `ink-v2.test.ts` and an unused `InkData` import in `sync.ts` (both reported by P1-T3's
  gate run above) → fixed.

**Incident (honest).** While stopping a stuck test run of this track, `pkill -f vitest` was run once. It ended this
track's own background gate shell (exit 144) and **may also have ended a vitest process of another track running at
that moment** (P1-T3 / PL-0). The gates of this track were re-run from the start afterwards; other tracks may want to
re-run any suite that ended unexpectedly around that time.

Final runs (after the last code change of this track):

| command | result |
|---|---|
| `npm run typecheck` · `npm run lint` | exit 0 · exit 0 |
| `npm test` — shared | **109 passed** (11 files) |
| `npm test` — server | **1 711 passed, 7 skipped, 0 failed** (170 files passed, 7 skipped, of 177) |
| `npm test` — web | first run **875 passed, 1 failed** — `src/features/exams/runner.test.tsx` (not this track's; failed once while three tracks' suites shared the VM); alone 6 / 6 passed; full web re-run **876 passed, 1 skipped, 0 failed** (144 files passed, 1 skipped) |
| `node --test apps/native/test/static-checks.test.mjs` · `node apps/native/scripts/check-native.mjs` | 4 / 4 passed · exit 0 |
| `npm run build` | exit 0; PWA 282 precache entries |
| `npx playwright test` (full E2E, phone + desktop, `/opt/pw-browsers/chromium`, `E2E_BUILD=0` on the fresh build, own `--output` so a parallel run's artifacts are not touched) | **131 passed, 0 failed, 15 skipped** (20.9 min; Round 7 baseline 123 passed, the rest are this wave's new specs). Both `aos-eink` tests and `aos-p1-layers` (desktop flow, phone panel) passed; the perf spec is skipped without `MEDLEVO_PERF=1` (its dense-page run is in `docs/PERFORMANCE.md`) |
| `npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record` | regression **80 / 80**, `no_regressions` |

Not run (and why): anything on a device — iPad / Apple Pencil latency, S Pen, BOOX refresh, a low-end Android phone
(none here; e-ink is checked as what the app does, not how a panel refreshes); any iOS or Android build, signature,
store upload or install (no macOS runner, no Xcode, no Android SDK, no store accounts; only static checks of the shell
files ran); `npm install` of the Capacitor packages (not a workspace of this repository); Safari / Firefox; GPU-backed
canvases; step 3 of the track (`reanchor_copy`) — not built in this round.

## Academic OS P1-T2 steps 1–2 — adversarial review (2026-10-21, run in this container; P1-T3's review and PL-0 were editing the tree and running their own suites in parallel)

Every changed file of the track was read (migrations `0271` / `0272` / `0861`; server `annotations/{layers,history,
layerCopy,purgeExtension,sync,repo,schemas,service,index}.ts` and the seams in `reanchor.ts`, `sync/registry.ts`,
`sync/index.ts`, `data/export.ts`; shared `annotations.ts`, `academic/{layers,ink-codec}.ts`; web `ink/layers/*`,
`ink/tiles/*`, `ink/{codec,store,layerController,model,persistence,InkLayer,SelectionOverlay,host,ink.css}`,
`panels/{LeftPanel,LayersTab}.tsx`, `design/{themeDisplay.ts,ThemeProvider.tsx,tokens.css}`, `settings/DisplayModes.tsx`;
`apps/native/*`, the two workflows; the E2E specs). Each finding was reproduced by a test that failed before the fix
(probes outside the repository under the session scratchpad); the regression tests below fail without their fix:

| new / changed test | what it proves (failed before the fix) |
|---|---|
| `apps/web/test/ink/tiles.test.ts` «display modes and tiles» (new) | switching e-ink on (ink tokens turn grey, paper tone unchanged) redraws a dense page in the new palette; before, the coloured warm tiles were copied (0 strokes drawn) — e-ink mode left dense pages in colour. Both palettes' grids stay warm afterwards. Re-verified failing with the fix locally removed |
| `apps/web/src/design/themeDisplay.test.tsx` «e-ink ink colours» (2 new) | in e-ink a custom pen colour from the colour picker becomes a grey of its lightness (pale pens stay ≤ #4a4a4a, highlighters #b0b0b0–#d6d6d6), and tokens resolved without the ink layer's CSS (text boxes, sticky notes) use the e-ink greys — they stayed in colour; `ink.css` and `palette.ts` declare the same greys |
| `apps/web/test/ink/text-highlights-layers.test.tsx` (new) | the reader's text highlights follow the layer view: a hidden layer's highlights (a layer copy copies them) and, with «ملاحظاتي» hidden, the legacy ones are not drawn; a split pane's other source is left alone — before, every highlight stayed on the page |
| `apps/web/test/ink/rehome.test.ts` (6 → 11) | a stroke drawn offline on a layer the server no longer has, then moved: the re-homed copy carries the MOVE (it kept the first position — the later edit was lost); drawn then erased: nothing is brought back; the notice names the real reason («للقراءة فقط» only for `layer_read_only`; a gone layer said «للقراءة فقط»); a refused layer delete shows the layer again; `countLayerItems` counts a layer's items on every page this device holds |
| `apps/server/test/annotations/layers.test.ts` (16 → 17) | two devices: a stale lock / recolour from the phone (whole row, old title) no longer puts back the name the iPad just gave the layer — three-way merge with the before-image of the op's base rev; when both changed the same field the later one wins and the earlier value stays in the layer's history |
| `apps/server/test/annotations/layer-copy.test.ts` (9 → 10) | a copy into a document that does not exist answers 404 and writes nothing — it created an orphan layer row (200) that no purge would ever remove, with a misleading «note pages» skip reason |
| `e2e/aos-p1-layers.spec.ts` (phone) | the layers panel's text measured ≥ 4.5:1 against its background in light AND dark (PRD AOS-20.2 asks new screens to pass both; only light was screenshotted), no sideways scroll in either |

Probed and found sound (no change): the 0271 migration on a Round-7-shaped database (the builder's test seeds every
kind, tombstones, conflict copies, notes — zero loss confirmed); R2–R5 on the server for annotations, notes, the REST
layer routes and the manual re-anchor; replay / idempotency of layer ops, layer copy (derived ids, erased copies never
revived) and revisions (`INSERT OR IGNORE` on `(entity, id, rev)`); purge of revisions, attribution and layers; export
includes the three new tables; image bytes shared by copies are kept by the prune (it counts every referring row); the
ink v2 codec under a 3 000-stroke fuzz (1–400 points, 3–6 channels, edge coordinates, hour-long times): every stroke
round-trips exactly, none refused, packed size 0.40 × the points' v1 JSON; malformed / oversized packed data is refused
before any allocation beyond the 20 000-point cap; old clients without `accept-ink: 2` get v1 on push answers, pulls and
duplicates; native skeleton files say «Not run» wherever nothing ran, and its static checks pass.

Measured (not fixed — recorded in `docs/PERFORMANCE.md`): one lasso move of 1 000 strokes (120 points, pressure) adds
**3.58 MB** of before-images (3.58 KB per stroke edit, 1.2 × the stroke) — ADR-0004 §2.8's «≈ 1.2 KB» assumed packed
snapshots; retention / thinning is Phase 2 (PRD Q29).

Final runs after the review fixes:

| command | result |
|---|---|
| `npm run typecheck` | exit 0 (shared, server, web, e2e) |
| `npm run lint` | exit 0 (`--max-warnings 0`) |
| `npm test` — shared | **109 passed** (11 files) |
| `npm test` — server | **1 739 passed, 7 skipped, 0 failed** (171 files passed, 7 skipped) |
| `npm test` — web | first full run 888 passed, 1 failed — `test/settings-screen.test.tsx` (autosave timing while other tracks' suites loaded the VM; 3 / 3 alone); second run 889 passed, 1 failed — this review's new tiles test counted only its own repaint while the controller's animation-frame repaint had already drawn the grey tiles under load (test hardened to count from the switch; still fails without the fix); final full run **890 passed, 1 skipped, 0 failed** (145 files passed, 1 skipped) |
| `node apps/native/scripts/check-native.mjs` · `node --test apps/native/test/static-checks.test.mjs` | exit 0 · 4 / 4 passed |
| `npm run build` | exit 0; PWA 282 precache entries |
| `npx playwright test e2e/aos-p1-layers.spec.ts e2e/aos-eink.spec.ts e2e/smoke.spec.ts e2e/g6-ac21-ink-position.spec.ts e2e/g6-ac28-pencil.spec.ts` (phone + desktop, `/opt/pw-browsers/chromium`, `E2E_BUILD=0` on the fresh build, own `--output`) | **20 passed, 2 skipped** (the layers flow is desktop-only, its panel check phone-only), 2.5 min; after the last web fix, rebuilt and re-ran `aos-p1-layers`, `aos-eink`, `smoke`: **10 passed, 2 skipped** |
| `MEDLEVO_PERF=1 npx playwright test e2e/perf.spec.ts --project=desktop -g "dense page, 5 layers"` | passed (1.5 min). Same harness, this build: before — repaints 1.52–1.67 s in single long tasks of 1.86–2.43 s; after — warm zoom back **4.7 ms** (6 / 6 tiles warm, 0 strokes), layer shown again **0.2 ms**; cold zoom 6.7 s / 5.2 s, hide a layer 4.3 s, in slices; writing during a re-raster: longest task **88 ms**. One long task of 71 ms during the warm zoom (the page's own re-render, not ink: the ink took 4.7 ms) — the builder's table said 0 there |
| `npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record` | regression **80 / 80**, `no_regressions` |

Not run (and why): anything on a device — iPad / Apple Pencil, S Pen, BOOX (refresh, ghosting, whether its browser
reports `(update: slow)`), a low-end Android phone (no device here); any iOS / Android build, signature or install (no
macOS runner, Xcode, Android SDK or store accounts); the full E2E suite (the track's specs, the ink AC specs and the smoke
spec were run, as the review asks); Safari / Firefox; GPU-backed canvases; step 3 (`reanchor_copy`) — not built.

## Academic OS P1-T2 step 3 — «انقل ملاحظاتي إلى الإصدار الجديد» (`reanchor_copy`, 2026-10-21, run in this container; other tracks may have been editing the tree in parallel)

Copy, never move, along P1-T3's page map (BUILD_PLAN §3.4 step 3; ARCHITECTURE_DELTA §6.3; Scenario 4, note side). New
tests — each was run first and failed before the code it covers existed (missing module, 404 route, missing table or
export), then passed:

| test file | tests | what it proves |
|---|---|---|
| `apps/server/test/annotations/reanchor-copy.test.ts` | 22 | pure `planItem` (safe + same layout → every kind; re-laid-out page → page anchors and found quotes only; confirmed pair → coordinates reused; uncertain / moved / removed / rejected → review with the candidate), letter-only quote matching with prefix for repeats, deterministic `rc_` ids; **Scenario 4 (TEST FIXTURE)**: the preview writes nothing (row counts and a sha256 of the v1 rows unchanged) and says «سيُنقل 2 · يحتاج مراجعة 1 · يبقى على الإصدار 1: 0»; the tap copies ink p.5 → v2 p.5 and the highlight p.12 → v2 p.14 (same data, previous anchor, same layer, `origin = 'reanchor_copy'`, in the sync feed), lists the p.30 note with candidate p.32, v1 rows byte-identical; a second tap copies and records nothing; a map changed since the preview → 409; review copy through `POST /reanchor` `action: 'copy'` (duplicate → 409, its own undo); keep on the earlier version and «review again»; undo tombstones the copies only and keeps a copy the owner edited, a new tap revives the same ids; an erased copy is never revived; refusals (same / backwards / unknown version, other lecture, unknown run); **pages inserted and reordered**: p.36 moved to p.27 listed `page_moved` with p.27 suggested, copied on the owner's one tap, and an owner confirmation in the page map turns the moved page into a copy target for ink; a followed (read-only) layer's item kept and refused; a pending version → «pending» and 409; full JSON export; purge removes runs, items, decisions; the tables come from `0274` and `0273` stays free for P3-T2; `0274` additive on an existing database; 5 000-stroke timing |
| `apps/web/src/features/workspace/panels/noteMigration.test.tsx` | 10 | model (newest version, pending, grouping, page rows); the banner: nothing posted before the tap, the tap sends the previewed map, report and one-step undo, «راجع العناصر»; offline / single version shows nothing; an earlier version opens the newest; the review list: old and candidate pages side by side, one-tap copy to the candidate (merged locally), the place dialog worded as a copy with the candidate preselected, keep and «أعدها إلى المراجعة»; a review copy's toast «تراجع» undoes that copy only and a refused undo says why |
| `e2e/aos-p1-note-migration.spec.ts` | phone + desktop | the real server and built app: v1 with ink p.5, highlight p.12, notes p.30 / p.36; a renamed v2 with 2 pages inserted, p.30 rewritten and p.36 moved, accepted as version 2; banner → preview (v1 state compared before / after: identical) → one tap → report «نُقل عنصران إلى صفحتين؛ عنصران يحتاجان مراجعتك؛ لا شيء بقي على الإصدار السابق», 4 = 2 + 2 + 0; review list: the moved note copied to p.27 with one tap, the rewritten one placed by the owner on p.33; undo from the banner's report tombstones the tap's copies only; a new tap revives, a second is a no-op; the earlier version's banner opens v2; 44 px touch targets and named controls on the phone; screenshots light / dark (`e2e/.artifacts/screenshots/<project>/aos-p1-note-migration-*.png`) |

Found and fixed while building (each reproduced first):

* `last_run` returned the latest review copy instead of the latest tap, so the banner's undo targeted the wrong run →
  only `kind = 'run'` (server test «undo tombstones the copies only…» failed before).
* The `Write` tool decoded `\uXXXX` escapes in a regex into literal zero-width / bidi characters (lint
  `no-irregular-whitespace`) → escapes restored; the same artifact in `academic/layers.ts` (step 1's layer-title check)
  converted back to escapes (same behaviour; shared suite green).
* The E2E first read the review list while the place dialog made the page inert (a false «list gone») and, on the
  phone, tried the banner behind the open study sheet → the spec waits for the dialog to close and closes the sheet
  first, as a user would.
* **Cross-talk found by the first full E2E run:** the first version of this spec uploaded Scenario 4's v1 bytes to the
  per-project server that `e2e/aos-p1-versions.spec.ts` runs on next, so P1-T3's upload came back `duplicate` (both
  projects, 1.2 s). Fixed in this spec only (P1-T3's spec untouched): the E2E lecture has Scenario 4's structure with
  its own text (`ownLectureV1/V2` in `test/fixtures/note-migration/build.ts`) and a per-run tag, so it can neither
  duplicate nor be proposed as a version of the other spec's lecture; both specs then run back to back on both projects
  (below).
* **Resumed after a container restart (2026-10-21):** the partial work in the WIP snapshot was verified (server 21/21,
  web 9/9) and kept. Two more defects, each reproduced first:
  * the bookkeeping migration was numbered `0273`, which BUILD_PLAN appendix B and ARCHITECTURE_DELTA §3.2 reserve for
    P3-T2's `0273_annotation_audio_index.sql` (a later collision would stop a vault from booting, since the runner
    refuses an applied file that is missing) → renamed `0274_reanchor_copy.sql` before any release (content unchanged;
    R1-a not shipped). Test «the note-migration tables come from 0274…» failed before (file missing), passes now.
  * the review copy's toast «تراجع» called the undo without a failure path: a refused undo (409 / offline) was an
    unhandled rejection and the owner saw nothing → a danger toast «لم يُنفَّذ التراجع» with the server's reason. Web test
    «the copy toast's «تراجع» undoes that copy only…» failed before (unhandled rejection, no message), passes now.

Seam changes outside this track's own files (smallest, reported): `apps/server/src/modules/annotations/reanchor.ts`
(Round 7) — `export` added to `boxOf`, `bboxOf`, `translateData`, nothing else; `apps/server/src/modules/data/export.ts`
— three `FULL_TABLES` rows for the new tables.

Performance (one run, server suite): 5 000 strokes — preview 97 ms, tap 487 ms, second tap 83 ms, undo 379 ms
(`docs/PERFORMANCE.md`).

Final gates (after every change of this step, including the resume fixes; 2026-10-21, this container):

| gate | result |
|---|---|
| `npm run typecheck` | pass (shared, server, web, e2e) |
| `npm run lint` | pass (0 warnings) |
| `npm test` | shared 109 passed; server 1761 passed, 7 skipped (tool-conditional, unchanged); web 900 passed, 1 skipped — exit 0 |
| `npm run build` | pass (PWA precache 282 entries) |
| `npx playwright test e2e/aos-p1-note-migration.spec.ts` | 2 passed (phone + desktop, 48 s) |
| `npx playwright test` (full E2E) | 133 passed, 15 skipped (the existing project-conditional skips in perf, layers, g8, h3, f5 specs), 0 failed — 21.2 min |
| 5 000-stroke timing (re-run) | preview 94 ms, tap 484 ms, second tap 86 ms, undo 352 ms (server suite, not a device) |

Not run: any device (iPad + Pencil, S Pen, BOOX) — no device here; the automatic variant (Q35 «انقل ملاحظاتي
تلقائيًا») and the follower fan-out of official versions (P1-T5) — not built; `npm run eval` — not re-run (no change
touches evidence, search or AI paths).

## Academic OS P1-T2 step 3 — adversarial review (2026-10-21, run in this container; other tracks may have been editing the tree in parallel)

Reviewer (BUILD_PLAN §1.2) of `reanchor_copy`: every changed file read (`reanchorCopy.ts`, `0274_reanchor_copy.sql`,
`purgeExtension.ts`, the routes in `annotations/index.ts`, the shared contract in `academic/layers.ts`,
`NoteMigration.tsx`, `noteMigration.ts`, the `ReanchorSection.tsx` extension, the tests, the E2E spec and the docs) and
the sync handlers it relies on (`annotations/sync.ts`). Scope: copy-never-move, idempotency (twice, two devices), undo,
removed pages, changed quotes, sync of the copies, the review-list reuse, Scenario 4 E2E. Each defect was reproduced
with a failing test first.

| # | severity | finding | fix and regression test |
|---|---|---|---|
| 1 | **major (data loss)** | After an undo, a device's queued edit of a copy brings it back (sync «merged»: an edit concurrent with a delete is kept, for notes even a plain autosave). Its item row was already marked undone, so the original was offered again and the next tap (or a review copy) went through `writeCopy`'s revive branch and **overwrote the owner's edited copy with the original's content** (only a before-image in `annotation_revision` kept it; history has no restore). Probe: the second tap reported `copied: 2` instead of `1` and the copy's `data_json` reverted. | a live row under the deterministic id counts as carried (`liveCopiesOf`, one batched PK query per 400 ids) in the planner, in the preview's `earlier.pending` and in the review copy (409); `writeCopy` refuses any live row (the transaction rolls back). `reanchor-copy.test.ts` «undo, then a device's queued edit brings the copy back…» and «a review copy brought back by a device's note edit after its undo… (409)» — failed before, pass now. |
| 2 | minor | A copy the owner erased before an undo of its run had its item row marked undone, so the next tap revived it — against the stated invariant «a copy the owner erased is never revived». | the undo leaves an erased copy's item row as it is (carried). «a copy the owner erased stays erased through an undo of its run and a new tap» — failed before (copied 2), passes now. |
| 3 | minor | `earlier[].pending` counted read-only (followed-layer) items that can never be carried, and so could pick a default «from» version with nothing to do. | pending = not carried, not live-copied, not kept, writable. Assertion added to «a copy keeps its layer; an item of a read-only layer…» — failed before (`pending: 1`), passes now. |
| 4 | minor (honesty / offline) | Going offline reset the preview to `null`: the banner and the cross-version review list vanished, so the documented «controls disabled with the reason» path was dead code (and the web test named «offline: the preview button is disabled with the reason» actually asserted that nothing is shown). | `usePreview` keeps what was loaded when going offline; the banner shows «يحتاج اتصالًا» as text. New web test «(review) going offline keeps the banner…» failed before, passes; the old test renamed to what it checks («offline from the start: nothing is fetched…»). |
| 5 | minor | The tap did not send this device's unsent writing first (the review decisions did), so a stroke drawn just before the tap was left behind and the banner reappeared. | `runMigration` → `syncNow()` before the POST. Web test «(review) the tap sends this device's unsent writing first» failed before, passes. |
| 6 | minor | A tap that copied nothing new (a retry, or another device was first) returned a report without an id; its report showed no undo although the copies of the earlier run were live. | the report offers the undo of `preview.last_run` when the tap recorded nothing. Web test «(review) a tap that copied nothing new… still offers the undo» failed before, passes. |
| 7 | minor (UX) | While P1-T3's analysis ran («pending») the banner said «يجري تحليل…» until the reader was reopened. | `usePreview` fetches again every 5 s (online, at most 10 minutes). Web test «(review) while the page analysis runs…» failed before, passes. |
| 8 | minor (comment) | `purgeExtension.ts` said a run left without items is deleted; the code (rightly — it must match the counted impact bound into the confirm token) deletes only the purged lecture's / versions' runs. | comment corrected; no behaviour change. |
| — | coverage | `translateRects` (highlight rectangles on a re-laid-out page) had no test. | pure cases added: moved paragraph translated; duplicated, re-flowed, edited paragraph or a rectangle outside every paragraph → review; Arabic tatweel / bidi mark / lam-alef presentation form ignored by the quote match. Passed first time (no defect). |

Checked and found sound (no change): the originals are never written (v1 rows hashed before / after in every flow,
including the new ones); a second tap and a second device's tap are no-ops (one transaction, deterministic ids, PK);
undo is idempotent and keeps edited copies; removed / rejected / unmapped pages and changed quotes go to review with
the candidate (pure `planItem` tests); copies are in the sync feed and the pull does not filter by device; image
copies keep their picture referenced (`pruneAnnotationImages` counts every annotation); the review route re-checks
revision, layer access, source, page and region; migration `0274` additive on an existing database.

Not changed, reported: the preview `GET` may store P1-T3's page-map cache and queue its analysis job (derived data,
none of the owner's items — docs now say so); a page note with a `node_id` appears twice in its notebook (copy, never
move — documented limit); the review list is bounded at 500 items; one earlier version's review list at a time.

Final gates (after every change of this review; 2026-10-21, this container):

| gate | result |
|---|---|
| `npm run typecheck` | pass (shared, server, web, e2e) |
| `npm run lint` | pass (0 warnings) |
| `npm test` | shared 109 passed; server 1765 passed, 7 skipped (tool-conditional, unchanged); web 903 passed, **1 failed**, 1 skipped — the failure was `test/settings-screen.test.tsx` «…autosaves the custom instruction without blur» (not this track's file), while the build, lint and typecheck ran at the same time; it passed 3/3 alone and the whole web suite re-run alone passed: **904 passed, 1 skipped, exit 0** |
| `npm run build` | pass (PWA precache 282 entries) |
| `npx playwright test e2e/aos-p1-note-migration.spec.ts e2e/smoke.spec.ts` | 6 passed (phone + desktop, 1.0 min); screenshots `e2e/.artifacts/screenshots/{phone,desktop}/aos-p1-note-migration-*.png` |
| 5 000-stroke timing (after the live-copy check) | preview 122 ms, tap 498 ms, second tap 136 ms, undo 371 ms (server suite, not a device) |

Not run: the full E2E suite (only this track's spec and the smoke spec, as the review task asks); `npm run eval` (no
change touches evidence, search or AI paths); any device (iPad + Pencil, S Pen, BOOX) — no device here.

## Release R1-a — final verification (2026-10-21, 04:33 → 06:45 UTC, run in this container)

The whole tree at the end of Academic OS Phase 1 Wave 1 — release R1-a «single-owner preview»: P1-T1 step 0, PL-0,
P1-T3, P1-T2 steps 1–3, each built and reviewed adversarially (entries above). `HEAD` 258ecad plus the uncommitted
P1-T2 step 3 work and its review (12 changed / new paths at the start). Same environment as above (Node 22.22, Chromium
at `/opt/pw-browsers/chromium`, no `ANTHROPIC_API_KEY`, `NODE_OPTIONS='--disable-warning=ExperimentalWarning'`); no
other track was editing the tree. Release checks only — no new feature. What shipped and what is «Not run» is
summarised in `docs/academic-os/BUILD_PLAN.md` §1.3, «Release R1-a».

### 1. First pass (before any change of this task)

| # | command | exit | duration | result |
|---|---|---|---|---|
| 1 | `npm run typecheck` | 0 | 46 s | no type errors (shared, server, web, e2e) |
| 2 | `npm run lint` (`eslint . --max-warnings 0`) | 0 | 54 s | no problems |
| 3 | `npm test` | 0 | 387 s | shared 11 files · **109 passed** · server 172 files passed, 7 skipped · **1 765 passed**, 7 skipped · web 146 files passed, 1 skipped · **904 passed**, 1 skipped |
| 4 | `npm run build` | 0 | 4 s | built in 1.8 s; PWA **282 precache entries** (4 718 KiB) |
| 5 | `npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record` | 0 | 9 s | regression **80 / 80** (95 % CI lower bound 95 %), `no_regressions` (`eval-20261021T044408-30d58a2d`) |
| 6 | `npx playwright test` (full suite, phone + desktop) | 0 | 1 252 s (20.9 min) | 148 tests: **133 passed, 0 failed, 15 skipped** |

The 15 skipped are the existing project-conditional skips: `perf.spec.ts` 6 tests × 2 projects (opt-in
`MEDLEVO_PERF=1`), `aos-p1-layers` ×2 (its full flow is desktop-only, its panel check phone-only) and one phone-only
check of `h3-reader-notes` on desktop.

### 2. Critic pass of the new screens (390 and 1280 px; light, dark and e-ink)

A scratch Playwright spec (outside the repository, run with the repository's `e2e/support` harness and its real-server
global setup) opened every screen R1-a added or changed, on a fresh server with the TEST FIXTURE lecture of
`apps/server/test/fixtures/note-migration/build.ts` (v1 with ink p.5, a highlight p.12, notes p.30 / p.36; a renamed v2
with pages inserted and reordered): Settings → display modes, the Control Center row and «النسخ الاحتياطي خارج
الخادم», `/upload/suggestions`, the compare screen (proposal and v1 ↔ v2), `/lectures/order/:node`, the lecture's
«النسخ» and «المحاضرة» tabs, the reader's migration banner, preview dialog, report, review list, the layers panel and
version 2 with the copied ink — 15 screens × 3 modes × 2 projects = 90 screenshots, each probed (one h1, named
controls, images with alt, no sideways overflow, no honesty red flags, text contrast ≥ 4.5:1, an icon never alone on
its line, `data-eink` on only in e-ink mode; on the phone 44 px targets and switch touch rings) and looked at.

Found and fixed (each reproduced by a test that failed first):

| # | finding | fix | regression test |
|---|---|---|---|
| 1 | Opened directly (a link, a reload), the lecture's «النسخ» tab had no padding and no separators, and the «المحاضرة» tab's contents list and the compare screen's action rows were unstyled: their rows use `.ml-upload__*`, defined in `features/upload/upload.css`, which only the upload screens import (the code-split CSS loaded only after visiting `/upload`, as the P1-T3 E2E does) | `SourceScreen.tsx` and `CompareScreen.tsx` import `../upload/upload.css` (screens import the stylesheets of what they render, as they already did for `library.css`) | `apps/web/test/route-chunk-css.critic.test.ts` (3): for every lazily loaded module (71), each feature class it renders through its static import graph is defined in global CSS, CSS of the eager app graph, or CSS that graph imports — failed on `SourceScreen` and `CompareScreen` only, passes now |
| 2 | Settings → «وضع العرض على هذا الجهاز»: the icon sat on a line of its own above the subhead (light, dark, e-ink; both widths) — `ml-settings__subhead` and `ml-settings__note-actions` had no rule | rules in `features/settings/settings.css` (flex row; the e-ink suggestion's buttons wrap with a gap under its text) | `apps/web/test/settings-css.critic.test.ts` (2) — failed before (2 classes without a rule), passes now |
| 3 | At 1280 px the page panel is ≈ 260 px wide: a layer's name was cut to «ملا…» and its meta line broke inside «ملاحظاتي» | `ink/layers/layers.css`: the text column keeps ≥ 7.5 rem, names wrap instead of an ellipsis, and a container query moves «اكتب هنا» and the menu to a second line when the panel is narrower than 20 rem | `e2e/aos-p1-layers.spec.ts` (desktop flow): every layer name whole and its text column ≥ 110 px — failed before («ملاحظاتي» cut, then «شرح سارة (TEST FIXTURE)» cut), passes now; phone panel test unchanged and passing |

Looked at and left (reported, not defects of R1-a): on the phone the probe lists the breadcrumb links (24 px) and skip
links (43 px) already reported in Round 7, the design system's password-reveal button (40 × 40) and toast close
button (32 × 32), a visually hidden file input and the layers radio (20 px, inside a 44 px `<label>`); the switch is
31 px with its 45 px ring (the touch-ring probe passes); at 390 px the migration banner's summary can leave its last
number alone on a line; the full-page screenshots show the fixed bottom bar mid-page (a screenshot artefact); the date
field shows Chromium's own `MM/DD/YYYY` format of the test browser. The «تنزيل» links inside the closed «ملفات هذه
النسخة» list were reported as unnamed by the first probe — they are hidden from the accessibility tree while closed (a
probe false positive; the probe now skips closed `<details>`).

### 3. A real race found by the final re-run

The first full re-run after the critic fixes failed one web test, `test/settings-screen.test.tsx` «… autosaves the
custom instruction without blur» (it had failed once in the P1-T2 review too, put down to load). Measured: about 1 run in
4 under load, sometimes alone. A traced copy (scratch) showed the cause: when the change came **before the screen's mount
effects had run** (the router commits the screen in a transition, so its passive effects run in a later task), the
textarea read `""` right after the change and nothing was saved. The draft-sync effect in `SettingsScreen.tsx` compared
the server value with the draft **of the render that scheduled it** (empty) and set it back, overwriting the owner's
first keystrokes — the same would happen if a server value arrived while the owner typed. Fixed with a functional
update (compare with the latest draft). New test «(R1-a final) text typed before the screen's effects have run is kept
and saved»: a `MutationObserver` callback types the moment the textarea exists — failed on the `HEAD` component (swapped
in and restored for the check), passes now; under the same load (16 parallel runs × 2 tests) **32 / 32 passed**, where
the old test had failed 1 in 4.

### 4. Final runs (after every change of this task)

| # | command | exit | duration | result |
|---|---|---|---|---|
| 1 | `npm run typecheck` | 0 | 51 s | no type errors (shared, server, web, e2e) |
| 2 | `npm run lint` | 0 | 59 s | no problems |
| 3 | `npm test` | 0 | 435 s | shared 11 files · **109 passed** · server 172 files passed, 7 skipped · **1 765 passed**, 7 skipped · web 148 files passed, 1 skipped · **910 passed**, 1 skipped (904 + the 6 new tests) |
| 4 | `npm run build` | 0 | 5 s | built in 1.9 s; PWA **282 precache entries** (4 718 KiB) |
| 5 | `npm run eval -- --set=regression --compare=docs/eval/baseline.json --no-record` | 0 | 11 s | regression **80 / 80**, `no_regressions` (`eval-20261021T061141-ccd3c9bf`) |
| 6 | `npx playwright test` (full suite, phone + desktop) | 0 | 1 343 s (22.4 min) | 148 tests: **133 passed, 0 failed, 15 skipped** (the same project-conditional skips as in section 1) |
| 7 | critic spec re-run on the final build (scratch, 2 tests) | — | 3.4 min | desktop: all 45 screen × mode checks clean; phone: every check clean except the 44 px list of known items above (the scratch spec asserts it softly, so it reports that test as failed) |

Between section 1 and this table, one intermediate full `npm test` (after the critic fixes) failed one web test — the
race of section 3; targeted runs while fixing: `npx playwright test e2e/aos-p1-layers.spec.ts --project=desktop`
1 failed before the layers fix (reproduced), `e2e/aos-p1-layers.spec.ts e2e/aos-eink.spec.ts` 6 passed, 2 skipped
after it; the three new web test files failed before their fixes and pass now.

E2E per spec (run 6; phone + desktop): `aos-eink` 4 · `aos-p1-layers` 2 (+2 skipped) · `aos-p1-note-migration` 2 ·
`aos-p1-versions` 2 · `critic-screens` 4 · `f1-notebook-pages` 6 · `f2-course-brain` 4 · `f3-study-modes` 4 ·
`f4-handwriting-audio` 6 · `f5-quality-ops` 6 · `g1-ac01` 4 · `g1-ac02` 2 · `g1-ac03` 2 · `g1-ac04` 4 · `g2-ac05` 2 ·
`g2-ac06` 2 · `g2-ac29` 2 · `g3-ac08` 2 · `g3-ac09` 2 · `g3-ac13` 2 · `g4-ac10-ac11` 2 · `g4-ac12-ac14-ac15` 2 · `g5-ac16` 6 ·
`g5-ac17-ac19` 6 · `g6-ac20` 4 · `g6-ac21` 4 · `g6-ac22` 6 · `g6-ac28` 6 · `g7-ac23` 2 · `g7-ac24` 4 · `g7-ac30` 2 · `g8-ac26` 2 ·
`g8-ac27` 2 · `g8-security` 8 · `h3-reader-notes` 5 (+1 skipped) · `h4-exports-sources` 4 · `smoke` 4 — all passed; `perf` 12
skipped (opt-in). No retry was needed (`retries: 0`).

### 5. The AOS rows' named tests, file by file (final tree, `vitest --reporter=json`)

For `docs/REQUIREMENTS_MATRIX.md` (AOS part): every count matches the one the row states.

| suite | files and passed tests |
|---|---|
| server (27 files, 244 passed, 0 failed) | `annotations/` layers-migration 2 · layers 17 · history 6 · layer-copy 10 · ink-v2 5 · reanchor-copy 26; `versions/` numbering 26 · page-map 9 · new-version-detect 3 · link-candidates 3 · import-intelligence 7 · review-regressions 25; `processing/docx-display-pdf` 3; `deploy/` render-blueprint 3 · paas-config 14 · client-ip 8 · objectstore-sigv4 7; `data/` offsite 16 · offsite-cli 3 · offsite-review 10 · objectstore 11 · offsite-schedule 6; `tenancy/` binding-harness 5 · capabilities-step0 3 · migrations-0041-0050 4 · purge-extension 7 · purge-extension.review 5 |
| shared (3 files, 24 passed) | academic-step0 10 · ink-codec 9 · layers 5 |
| web (16 files, 103 passed) | `test/ink/` layers-visibility 13 · rehome 11 · tiles 13 · text-highlights-layers 1; `design/themeDisplay` 7; `panels/noteMigration` 14; `sources/versions` 11; `control/offsite` 3; `test/tenancy/` sync-onrejected 10 · sync-onrejected.review 5 · localdb-phase1-schema 6 · localdb-old-tab.review 1 · capabilities-screen-step0 1; new: route-chunk-css.critic 3 · settings-css.critic 2 · settings-screen 2 |

### Files changed by this task

`apps/web/src/features/sources/{SourceScreen,CompareScreen}.tsx` (one CSS import each),
`apps/web/src/features/settings/settings.css`, `apps/web/src/features/settings/SettingsScreen.tsx` (the draft-sync
effect), `apps/web/src/features/workspace/ink/layers/layers.css`; tests `apps/web/test/{route-chunk-css,settings-css}.critic.test.ts`
(new), `apps/web/test/settings-screen.test.tsx` (+1), `e2e/aos-p1-layers.spec.ts` (+1 assertion block); docs: this entry,
`README.md`, `docs/REQUIREMENTS_MATRIX.md` (AOS part), `docs/CAPABILITY_MATRIX.md`, `docs/academic-os/BUILD_PLAN.md`
(§1.3 «Release R1-a», Appendix B migration rows, status line).

### Not run in this verification (and why)

| what | why |
|---|---|
| Any device: iPad + Apple Pencil, Samsung S Pen, BOOX e-ink, a low-end Android phone | no device in this container — Chromium phone (390 × 844, touch, DPR 2) and desktop projects with mouse input only |
| Render, Cloudflare R2, a phone-only dry run of `docs/DEPLOY_PHONE_AR.md` | no account and no phone; the off-site path is tested against the signature-checking S3 fake |
| Native iOS / Android builds and store steps | no macOS runner, Xcode, Android SDK or accounts |
| A live AI provider; `npm run eval -- --mode=live` | no `ANTHROPIC_API_KEY`; nothing in R1-a changes an AI path |
| `MEDLEVO_PERF=1` suites, the ink harness config, a Docker image rebuild, the CI workflows on GitHub | not re-run: no change to the measured paths, the ink engine or `Dockerfile` / `deploy/` since their track reviews; no GitHub runner |
| Safari, Firefox, screen readers, axe-core | not available here (axe-core is not in the repository; structural probes instead) |
