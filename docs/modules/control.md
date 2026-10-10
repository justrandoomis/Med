# Personal Control Center (track D2)

Owns `apps/server/src/modules/control/**`, migration `0700_control.sql` (range 0700–0749), `apps/server/test/control/**`,
`apps/web/src/features/control/**` (the placeholder was replaced), the new shared contract
`packages/shared/src/control-api.ts` (exported by one appended line in `packages/shared/src/index.ts`) and this file.
The only edit outside these paths is a link to the Control Center in `apps/web/src/features/settings/SettingsScreen.tsx`
(+ 2 rules appended to `settings.css`).
Spec: §48, §51, §53, §56, §18, §47; AC-03, AC-26.

There is one owner and one calm center: no roles, no admin console, no counter dashboard. Each section says in one
sentence what is true now and what is waiting for the owner. Every number on these pages is a real count from the
database. Every cost is labelled «تقديري».

## 1. Server: `/api/control` (owner session; mutations need the CSRF header like every `/api` route)

| Route | What it returns / does |
|---|---|
| `GET /overview` | one line of real state per section: open review items (by kind), open content alerts, active / failed (30 days) jobs, versions with incomplete coverage, AI configured + estimated spend |
| `GET /review?status=&kind=&source_id=&origin=&limit=&cursor=` | Review Queue across all 15 kinds, with keyset cursor, counts per kind and a sources facet. Items of a source in the trash are hidden, and they come back on restore |
| `GET /review/:id` | original location (source, version, page label, region box, a render of the original PDF/image page), structured data per type (region / page / question / classification / claim / note / generic), the specific reason, the allowed actions with their effect in words, and the correction history |
| `POST /review/:id/resolve` | `{action: accept\|correct\|reject\|dismiss, text?, lecture_kind?, note?}` (strict). 400 with `details.allowed` for an action this item does not allow; 409 when the item is not open or its source is in the trash |
| `GET /processing` | jobs with stage, real progress («12 من 40 صفحات»), Arabic explanation, `can_retry` / `can_cancel` + what each does; versions `partial` / `failed` / `needs_review` page by page with the specific reason and whether you corrected the page (AC-03) |
| `GET /intelligence` | AI status per task and per model role, budget, usage per month (owner time zone) by task and by model — **ESTIMATED** |
| `POST /impact/preview` | `{change}` → which stored generated content a new request would no longer reuse. Nothing is written (the dry run runs in a transaction that is rolled back) |
| `POST /impact/apply` | `{change, confirm_token}` → applied only with the token of a fresh preview (409 when the state changed since the preview). **Never regenerates anything** |
| `GET /sources` | per-task source-type priority from the settings + every source with its priority and selection reason |
| `GET /storage` | data directory measured by category (database + WAL, source files, display PDFs, page images, figure crops, other), backups, OCR models, temporary files |
| `GET /history?entity_type=&entity_id=&limit=&before=` | the audit log in words: who (you / a background job / the system), what, when, before → after values with Arabic labels, a link to the thing |

Job retry/cancel uses the existing `/api/jobs/:id/retry|cancel`. Page re-processing uses `/api/sources/versions/:id/reprocess`.
The control module adds no second path for these.

### Data (`0700_control.sql`, no existing migration edited)
* `control_region_correction`: one row per owner decision on extracted text (`correct`, `accept`, `reject`,
  `owner_text`), with the text, origin, status and confidence **before**, the text/origin/status **after**, the
  review item, the content alert it created, and the note. It is append-only: the previous text is never lost.
  A permanent delete of a source prunes its rows (at start-up and on each list), so purged text does not survive
  in history.
* Two indexes on `review_queue_item` for the list (status + created_at, source + status).

### Review decisions (§48, AC-26)
* **Extracted text** (OCR / text region, page-level problems):
  * `correct`: the owner text replaces the extracted text (`text_origin = 'owner'`, status `owner_reviewed`). The
    previous text is kept in `control_region_correction` and in the audit log, and the version's chunks are
    re-indexed (diff re-index). The evidence dependency service (`onSourceVersionChanged`) creates one content alert
    for everything that depends on that page: explanations, questions, cards. **Nothing is regenerated automatically
    and no attempt changes.**
    * **Cited text is never changed in place (review fix).** Evidence rows quote a region verbatim and the evidence
      service reuses a row by (region, offsets): a region's text is immutable for its id. When evidence already quotes
      the region, the region row keeps its text verbatim and becomes `rejected` (out of search and new evidence), and
      the corrected text becomes a **successor** region in the same place (same page, box, reading order, parent;
      `locator_json.supersedes_region_id`). Old citations keep showing exactly what they quoted, marked «مستبعد»; new
      evidence can only quote the corrected text. The same applies to a cited table whose cell is corrected (the
      successor table takes the cells) and to a cited owner transcription. Uncited regions are corrected in place.
      Open review items about a replaced region move to its successor; the review desk shows the region that holds
      the text now, and its correction history covers the whole chain.
  * `accept`: no text change, status `owner_reviewed`, no alert.
  * `reject`: the text stays stored but leaves search and new evidence. Dependents get an alert.
  * `dismiss`: closes the item; nothing else changes.
  * A table cell correction also updates the parent table's structure and text. Tables, figures and diagrams
    themselves offer only accept / close.
  * A page with no usable text can be transcribed by the owner (`owner_text`): an owner region with **no box
    claimed**, searchable, and the page becomes ready.
  * After each decision the page and version readiness are recomputed with the same rule processing uses. A later
    re-processing never replaces owner text (the processing pipeline keeps `owner_reviewed` / owner regions).
* **Classification suggestions** go through the sources service (`lecture_kind`, origin `owner`).
* **Questions** (truncated question, missing option, conflicting key, unofficial mark, uncertain lecture link,
  duplicate, validation failed) deep-link to the questions side-by-side review. Only «close» is offered here, so
  attempts and question versions stay tied to that screen's decisions.
* **Generated question candidates** → exams; they can be kept unpublished, never published from here.
* **Notes to re-anchor** and **unsupported claims** → workspace. Only «close» is offered here. The note is never
  deleted.
* Each resolution writes `resolution_json = {by: 'owner', via: 'control', action, note, effects_ar, correction_id,
  alert_id}` and an audit entry `review_<status>`. Other open items about the same region that a decision closes
  get their own `resolution_json` (`decided_with`) and their own audit entry (review fix: they were closed silently).

### Intelligence and impact preview (§51, §53)
* Without a provider every AI task reports `requires_configuration` with the Arabic reason. The deterministic
  features keep working, and the page says so.
* Usage comes from the real usage records only, grouped per month / task / model. Costs are labelled estimated
  (token counts × the price table, not the provider's invoice).
* Impact preview for a change of explanation settings (level, dialect, custom instruction, socratic, check-question
  density, answer style), owner-level rules, folder-level rules (or removing them), source priority, or a model:
  * Rules / settings: each published or partial artifact's rules are rebuilt (verified against its stored
    `rules_version`) and compared with the rules after the change: affected / unaffected / not comparable.
  * Source priority is **not** part of the cache key, so nothing becomes stale. Content whose scope mixes source
    types is counted «قد يختلف لو أُعيد توليده».
  * Model: artifacts generated by that role's model are listed. Deterministic content is not.
* Apply: settings through the settings service; rules overrides through the studybook rules routes **in-process
  with the owner's session** (this module never writes another module's table); audited as `apply_change` with the
  impact counts. A model is a server setting (`MEDLEVO_MODEL_*`): preview only, apply → 409 with the reason.

## 2. Web: `/control` (Arabic, RTL, 390 px → desktop, light / dark)

Layout: a sticky section list at ≥ 60rem (with the open review count), a stacked index on phones. The index has two
groups, «ما ينتظر قرارك» and «الإعدادات والحالة», with one real-state sentence per section.

* **قائمة المراجعة** (`/control/review`, `/control/review/:itemId`): filters kept in the URL; items with kind,
  specific reason, page label; «load more» by cursor. The item page is a desk: **الأصل** (the original region cut
  out of the PDF page or scan at reading size, toggle to the full page with the region framed, link to the study
  workspace) next to **النسخة المنظمة** (structured data). Below: the decision as radio choices, each with its
  effect in words, a correction editor, then what happened (alert, kept previous text) and «سجل التصحيحات».
* **تنبيهات المحتوى**: the existing `ContentAlertsPanel` (evidence feature).
* **التعارضات والمزامنة**: open outbox issues of this device (conflict / rejected / error) described in words with
  a safe payload preview. «أبقِ الاثنين» acknowledges and keeps both versions. «أعد الإرسال» re-sends as a **new**
  operation and keeps the old one marked superseded. Each action has a confirmation dialog explaining its effect,
  and nothing is deleted. (Review fix: when the server kept its NEWER copy and refused the change — reading
  position, note-page settings, exam attempt state — the page no longer claims «النسختان باقيتان» on the server,
  and offers no «أعد الإرسال»: a re-send carries the same old base and can only be refused again.)
* **المعالجة**: active and recent jobs with real progress, retry / cancel with their effect, versions needing
  attention page by page, re-process.
* **المصادر والأولويات**: per-task source-type order (up / down / remove / add) previewed through the impact review
  before saving; each source's priority and selection reason editable.
* **الذكاء الاصطناعي**: status (grouped reasons, not one line per task), budget, models per role with their server
  setting, model-change impact preview, usage per month (estimated), default explanation rules with impact review
  before apply. A stale preview (409) asks for a new preview.
* **التخزين ودون اتصال**: measured sizes per category; link to `/offline`.
* **ملف التعلّم**: link to `/review/profile`.
* **القدرات**: what works on this server and why not (from `/api/capabilities` and `/api/processing/status`), plus a
  summary of the pen capability matrix.
* **السجل**: audit history grouped by day, filter by kind, «older» by cursor.

Settings has a «مركز التحكم» row that links to `/control`.

## 3. Tests (real results, 2026-10-10)

```
cd apps/server && NODE_OPTIONS='--disable-warning=ExperimentalWarning' npx vitest run test/control
  → Test Files 3 passed (3), Tests 32 passed (32)
cd apps/web && npx vitest run src/features/control
  → Test Files 1 passed (1), Tests 9 passed (9)
```

* `review.test.ts` (15): listing across kinds with real counts; filters + cursor; trash hides / restore brings back;
  original location + region box; **region correction → owner text, previous text kept, audit, re-index, content
  alert for dependents, nothing regenerated**; refuse double resolve; re-processing keeps owner text; validation
  (unchanged / empty text, unknown action, bidi controls stripped); accept (no alert); reject (kept, excluded,
  alert); dismiss; owner transcription; classification through the sources service; question items → questions
  screen; re-anchor / generated / claim routing; auth (401 without session, 403 without CSRF).
* `impact.test.ts` (8): preview lists exactly what would not be reused and writes nothing; apply only with a fresh
  token, audited, no regeneration; invalid / non-content settings rejected; owner-level and folder-level rules
  (incl. removal) applied through the studybook route; source priority not in the cache key (mixed scope «could
  differ»); without provider: honest preview, cannot apply; with `FakeAiProvider` (test only): generated content of
  the role listed, deterministic content not.
* `overview.test.ts` (9): partial version page by page with reasons (AC-03); failed job explained, retry through the
  jobs API resumes it, cancel stops a queued one without deleting anything; unregistered job kind explained;
  usage by month (owner time zone) / task / model, estimated; no-provider status; storage by category; sources and
  priorities; history in words with filter; overview.
* `control.test.tsx` (9): review desk shows original + structured + reason + every action with its effect;
  correcting shows what happened and the kept previous text; refused correction keeps the owner text and shows the
  server reason; question item links out with only «close»; queue filters go to the server; impact first, apply
  with token, stale token → new preview; sync issues: explanations and «keep both» / «send again» never delete;
  sync descriptions and safe payload preview; status lines use real counts only.

Real server + browser check (Playwright chromium at `/opt/pw-browsers/chromium`, real server serving the built
`apps/web/dist`, fresh data directory, real PDFs processed):

```
npm run build -w @medlevo/web
node apps/web/src/features/control/real-server-check.mjs <out-dir>
  → 71 PASS, 0 FAIL
```

It covers every section at 390×844 and 1280×800, light and dark, with no horizontal overflow. It also corrects the
real OCR-flagged region of a Golden Set lecture from the review desk (the original is painted from the PDF; afterwards
the region is owner text, the item is corrected and the previous text is in «سجل التصحيحات»). It applies an
explanation-rule change only after its impact preview. With a seeded sync conflict + rejection, «send again» queues a
new op and keeps the old one superseded. (The content alert on correction is asserted in the server tests.) Screenshots were reviewed and the issues they showed were fixed (crop size, Arabic value labels in
history and impact, grouped AI reasons, wrapping model settings at 390 px).
The screenshots go to the given directory (default `apps/web/test-screenshots/control`). They are not committed.

Final runs:

```
npm test -w @medlevo/server   → Test Files 55 passed (55); Tests 765 passed | 1 expected fail (766)
npm test -w @medlevo/web      → Test Files 59 passed (59); Tests 470 passed (470)
                                (one earlier full run failed 1 test in test/learning/review-session.test.tsx,
                                 a file the parallel learning track was editing at that moment; it passed in
                                 isolation and in the re-run)
npx tsc -p apps/server --noEmit → ok
npx tsc -p apps/web --noEmit    → ok
npm run build -w @medlevo/web   → built (PWA precache 204 entries)
```

After the adversarial review's fixes (§6), re-run on 2026-10-10:

```
cd apps/server && NODE_OPTIONS='--disable-warning=ExperimentalWarning' npx vitest run test/control
  → Test Files 4 passed (4), Tests 36 passed (36)      (+ cited-correction.test.ts: 4 tests)
cd apps/web && npx vitest run src/features/control
  → Test Files 1 passed (1), Tests 10 passed (10)      (+ 1 sync-explanation test)
npm test -w @medlevo/server     → Test Files 56 passed (56); Tests 769 passed | 1 expected fail (770)
npm test -w @medlevo/web        → Test Files 59 passed (59); Tests 471 passed (471)
npx tsc -p apps/server --noEmit → ok
npx tsc -p apps/web --noEmit    → ok
npm run build -w @medlevo/web   → built (PWA precache 205 entries)
node apps/web/src/features/control/real-server-check.mjs <scratchpad>/shots → 71 PASS, 0 FAIL
```

`cited-correction.test.ts` was checked against the previous code: with the cited-region path disabled, both of its
correction tests fail (the next evidence request returns the old quote).

## 4. Not done / limits

* **Models cannot be switched from the UI**: they are server settings (`MEDLEVO_MODEL_GENERATION|VERIFICATION|VISION`).
  The impact preview works; apply returns 409 with the reason; the change applies after editing the setting and
  restarting.
* No real AI provider in this environment: AI behaviour was tested only with the test-only `FakeAiProvider`; the
  real path reports `requires_configuration`.
* Costs are estimates from token counts × the price table; there is no reconciliation with the provider's invoice.
* Applying a rule or priority change never regenerates content; the owner regenerates from the content itself.
  Source priority changes make nothing stale (not part of the cache key); affected content is counted «could differ».
* Whole tables / figures / diagrams cannot be re-typed from the review desk (accept / close only); cells and captions
  are corrected as their own items.
* Question, generated-question, claim and re-anchor decisions are made in their own screens; the control center
  shows them, links there and can only close them.
* Sync conflicts shown are this device's outbox only; other devices' unsent changes are not visible.
* Storage is measured, not managed: no clean-up actions here (offline packages are managed in `/offline`, backups via
  the data module).
* The PDF crop shows a long line at a legible minimum scale (1.6×); on a phone a wide region scrolls inside its frame
  rather than shrinking.
* **Replaced (cited) regions in the reader** — open follow-up for the workspace track: the reader's OCR text layer
  over page images and its text sheet for DOCX / slide text (`features/workspace/reader/PageView.tsx`, `ImageSheet` /
  `TextSheet`) list every region with text, including `rejected` ones. A region the owner rejected was already shown
  there; a corrected *cited* region now also appears next to its successor (the old text marked excluded on the
  server, but not filtered by the reader). Search, evidence, the Study Book, exports and question generation all skip
  `rejected` regions. The fix belongs to the reader (skip `status === 'rejected'`), outside this track's paths.
* References other modules keep to a replaced region (question options / answer-key entries, concept mentions,
  figure assets) stay on the old row; those modules hold their own copies of the text and the content alert marks
  their dependents for review.

## 5. Deviations

* The settings link is a `ListItem` row at the top of the settings screen (plus two CSS rules) — the only edit
  outside the owned paths, as allowed.
* Rules overrides are written through the studybook routes in-process (cookie + CSRF forwarded) instead of directly,
  to keep table ownership.
* Table ownership is NOT fully kept (stated by the review; the builder's summary said otherwise): the sources module
  has no service for region text / status, so the corrections write `source_region` and `source_page` directly (in
  one transaction with the history row, the re-index through the processing module's `buildChunks` / `writeChunks`
  / `writeSummary`, and the alert through the evidence service). The impact preview applies a rules change to
  `explanation_rule_override` / `owner_setting` inside a transaction that is always rolled back (a dry run; nothing
  persists).

## 6. Adversarial review (2026-10-10)

An independent review read the server and web code, probed suspect paths with throw-away tests, and fixed what it
confirmed (each with a regression test):

| Severity | Finding | Fix |
|---|---|---|
| blocker | Correcting a region that evidence already quoted rewrote its text in place. The evidence service reuses an evidence row by (region, offsets), so a same-length correction (e.g. a digit) made the next request reuse the OLD quote — the very OCR error the owner corrected — as evidence for new generated content, and existing citations showed the uncorrected quote labelled «راجعته شخصيًا». Confirmed with a probe: after correcting «…0 to 10.» → «…0 to 10X», `fromRegion` returned the old row and quote. | Cited regions (and cited tables of a corrected cell, cited owner transcriptions) are replaced by a successor region; the cited row keeps its text, becomes `rejected`; open items move to the successor; the desk follows it. `test/control/cited-correction.test.ts` (fails on the old code). |
| minor | Other open items about the same region were closed by a decision without an audit entry. | Each closed item gets its own `resolution_json` and audit entry (`cited-correction.test.ts`). |
| minor | Sync: for a change the server refused because it kept its newer copy (reading position, note-page settings, exam attempt), «اطّلعت» claimed «تبقى النسختان» and «أعد الإرسال» promised a kept copy, though a re-send with the same old base can only be refused again. | Accurate effect text; no re-send offered for that case (`control.test.tsx`). |
| minor | a11y: the original/full-page toggle used `aria-pressed` while its label also switched; history «before ← after» was read without a separator. | `aria-pressed` removed; a visually hidden «ثم صار» between the values. |

Checked and found sound: auth on every route (now also asserted for `GET /review/:id`, `/impact/preview`,
`/impact/apply`), CSRF on mutations, zod validation (strict bodies, id / cursor formats), parameterized SQL, no
`dangerouslySetInnerHTML` in the feature, no automatic regeneration (apply / correction create no artifact and no job;
the evidence service only marks stale and alerts), costs labelled «تقديري» wherever shown, impact preview is a dry run,
apply needs a fresh token, sync «keep both» / «send again» never delete an outbox record.

## 7. Track F5 — quality ops: evaluation, client errors, daily trends (§56, §57, 2026-10-10)

Migration `0710_quality_ops.sql` (fresh number in 0700–0749; nothing edited): `evaluation_case` gains `set_kind`
(regression | tuning), title, fixture, catalogue version, `retired_at`; new tables `evaluation_run` (one recorded run:
mode, set filter, label, system fingerprint, catalogue version + hash, the report as JSON and Markdown) and
`client_error` (one row per fingerprint with a count, first / last seen); indexes for the trend queries on `claim`,
`verification_result` and `sync_operation`. Shared contract: `packages/shared/src/quality-api.ts` (one appended export
line in `index.ts`).

**Evaluation (§57)** — `modules/control/evaluation/` + `apps/server/src/cli/eval.ts` (`npm run eval`). A THROWAWAY
server (temporary data directory, removed afterwards) receives the synthetic TEST FIXTURE files through the real
upload / quick-add API and the real pipeline; each catalogue case is judged on one axis: text accuracy, negation /
numbers, options completeness, key binding, citation validity, claim support, abstention, over-abstention, image match
(the AC-09 validator), lecture link quality, RTL / bidi. 149 cases: 80 in the frozen **regression** set, 69 **tuning**
examples, always reported apart (`regressionHash` pins the regression set). Rates carry their denominators and a Wilson
95 % interval; a sample under 30 is flagged small and a perfect small sample reads «n / n نجحت — الحد الأدنى …» —
never «100%». The AI axes (claim support, abstention, over-abstention) use an evaluation-only scripted provider
(`EvalScriptedProvider`): they measure the server's guarantees (evidence aliases, verification, abstention), not a
model; `--mode=live` uses the configured provider and reports `not_run` with the Arabic reason without a key. Each
report records the system fingerprint (pipeline / index / parser / matcher / AI-rules / generator / verifier versions,
OCR and pdf.js package versions, git commit) so two runs can be compared (`--compare`, exit 4 on a regression);
the compare-and-rollback procedure is docs/EVALUATION.md. The catalogue is synced into `evaluation_case` at boot; a
run is recorded into the server database when it exists (50 kept). Committed reference run: `docs/eval/baseline.json`
/ `.md` (regression 79 / 80, tuning 69 / 69 at the time of writing; the one failure is a real finding — see below).

**Client error sink (§56)** — `apps/web/src/lib/errorReporter.ts` (installed in `main.tsx`; route error screens
report too): uncaught errors and unhandled rejections are redacted in the browser by the shared `redactClientError`
(no quoted or long Arabic text, no query strings, no tokens / keys / e-mails, stack frames reduced to code locations),
grouped by fingerprint with a count, batched (≤ 20, every 5 s and on page hide, keepalive) and sent only while signed
in; the reporter never logs to the console and never retries forever. The server redacts again
(`modules/control/client-errors.ts`), keeps 30 days and at most 500 rows, stores the browser family instead of the user agent, and rate-limits
the sink (30 / min).

**Daily trends (§56)** — `modules/control/trends.ts`: per owner-timezone day (DST-safe), computed from existing rows:
claims checked, citations rejected, claims the evidence did not establish (entailment failures only), changes received
from devices, changes refused, conflicts kept as both copies. Each failure count is shown next to its denominator.

Routes (owner session; the DELETE and POST need the CSRF header): `GET /api/control/evaluation`,
`GET /evaluation/runs/:id`, `GET /evaluation/runs/:id/report.md`, `GET /health?days=7..60` (default 14),
`GET|POST|DELETE /client-errors` (DELETE is audited).

Web: two new sections, «صحة النظام» (`/control/health`: one sentence per metric with its denominator, a quiet 14-day
strip that is `aria-hidden` because the sentence and the day-by-day table carry the numbers, the redacted error list
with «امسح السجل» behind a confirm dialog) and «تقييم الجودة» (`/control/evaluation`: how to run when nothing is
recorded; else the latest report — regression and tuning apart, per-axis rates with intervals, what did not pass and
why, the comparison with the previous run, earlier runs, the Markdown report download).

Tests (run 2026-10-10): server `test/control/evaluation.test.ts` (17: Wilson / small-sample wording, never 100 %,
regression hash, compare, store sync / retire, a real subset run, scripted AI axes, live mode without a key),
`test/control/quality-ops.test.ts` (9: sink redaction, grouping by fingerprint, the batch cap, auth / CSRF,
retention, the audited clear, browser family instead of the user agent; trends per local day with denominators; the
rate limit itself is configured, not tested); shared `packages/shared/test/quality.test.ts` (7); web
`src/features/control/quality.test.tsx` (5) and `test/error-reporter.test.ts` (7); E2E `e2e/f5-quality-ops.spec.ts`
(3 tests × phone + desktop: a dispatched error and rejection reach «صحة النظام» redacted; clear; the real
`npm run eval` records a report the screen shows with denominators and no «100%»; DOCX export).

Not done / limits:
* **Real finding, not fixed (evidence module):** `overabstain.pregnancy_test` — a lecture-only chat abstains
  («not found in scope») without calling the generator although the lecture states the pregnancy-test sentence: a
  retrieval miss in the evidence module, outside this track. It stays failing in the baseline so a fix shows up as
  «now passes».
* The live-model evaluation never ran (no API key here); the scripted axes measure the server's guarantees only.
* The fixtures are synthetic; no rate is an accuracy claim beyond these cases. Image match covers the AC-09 validator,
  not open-ended figure recognition.
* Client errors are captured only while the app runs and is signed in; errors before sign-in are dropped by design.

