# Learning — web (track L2)

Owns `apps/web/src/features/{review,weakness,planner,home}/**`, `apps/web/test/learning/**` and this file. Small,
marked edits outside: `features/workspace/model/aiActions.ts` + `features/workspace/selection/SelectionToolbar.tsx`
(wire «أنشئ بطاقة مراجعة» and «أضف إلى المراجعة») and `features/exams/FeedbackPanel.tsx` (the «أنشئ بطاقة من هذا
الخطأ» link). No server, shared-contract, Dexie-schema or migration change.
Server contract consumed as is: `docs/modules/learning.md` (track L1), `@medlevo/shared` `learning.ts` +
`learning-api.ts`. Spec: §23, §30, §43, §44, §45, §55; AC-23, AC-24, AC-27.

## 1. What is implemented

### Local SRS engine (`features/review/local/*`) — the review session works offline
* **`srs.ts`** — the same FSRS-6 fold as the server, with the same library (`ts-fsrs` 5.4.2, fuzz off): history
  sorted by `(reviewed_at, id)`, a re-sent event id folded once, relearn markers (`schedule_resets`) applied as
  `forget` after the events of the same millisecond, previews per button, retrievability, state view rounded like
  the server. `checkParity(cfg)` replays the server's `parity_check` sample from `GET /api/learning/srs-config` and
  names the mismatching fields. **If the sample does not reproduce, the device does not schedule** («جدولة هذا
  الجهاز لا تطابق الخادم»); without a saved configuration and offline it says it cannot schedule (no guessed
  schedule).
* **`store.ts`** — cards (`flashcards`) and events (`reviewEvents`) in Dexie; the config cached in `kv`
  (`learning.srs-config`). Sync appliers for `flashcard` and `review_event` (registered once per engine); pulled
  rows never overwrite a row with an unsynced local op. `recordRating` = one `writeAndEnqueue` (event row + `append`
  op with a client ULID) — never awaits the network. `undoRating` only while the op is still `pending` and not
  handed to the network (`sentAt` unset); otherwise it refuses and says why (owner history is not edited after
  sync). Local edit / suspend / bury (to the next owner day) / delete / offline creation (basic, or one card per
  cloze index sharing a note); a never-synced card's coalesced op carries the insert fields.
* **`queue.ts`** — mirrors the server queue: learning → due → new up to the daily new-card limit counted on the
  **owner's day** (plan timezone, not the device's), suspended/buried skipped; explicit card lists bypass the new
  limit.
* **`render.ts`** — cloze faces (only the asked index hidden, same rule as the server), card previews.
  **`occlusion.ts`** — normalized geometry (draw / move / resize / clamp / minimum size / keyboard steps /
  spoken description). **`time.ts`** — owner-day helpers with an explicit IANA timezone (DST-safe), day keys shown
  as calendar dates independent of the device timezone, Arabic plural helpers.
* **`revisionMarks.ts`** — «أضف إلى المراجعة» = a page **bookmark annotation** (local-first, synced like every
  annotation) whose data is `{v:1, label:'للمراجعة', revision:true, quote, page_label, source_title}`.

### Screens
| Route | What it does |
|---|---|
| `/` (Home) | **Continue Studying first** (server list merged with this device's recent sessions, works offline), then today's plan (check-off), cards due, exam countdown, the one weakness that needs attention with its reason, important questions (stem as the link, reason under it). Sentences, not counters. |
| `/review` | Today's cards in one sentence + start; offline image prefetch for occlusion cards; **One-Tap Revision** (minutes → `/review/revision?minutes=N`); the «للمراجعة» marks; links to the learning tools. |
| `/review/session` (full-bleed) | The offline reviewer (`CardReviewer`): Space/Enter reveal, 1–4 rate (nothing before the answer), Again/Hard/Good/Easy with interval previews from the local fold, state label New/Learning/Review/Relearning, citation chips (evidence snapshot offline), edit / bury / suspend / open the source, last-rating bar with save status and **undo only before sync** (Ctrl/⌘+Z). Accepts `source_id`, `cards`, `back`. |
| `/review/cards`, `/review/cards/new`, `/review/cards/:id` | Card library (filters, search, duplicate decisions, Anki text export). Editor: basic, cloze (`{{c1::…}}`, one card per index), **image occlusion** (figure picker → mask draw/move/resize with pointer, numbered masks, keyboard alternative: add centred mask, arrows move 1 % / Shift 5 %, Alt+arrows resize, Delete removes), **from selection** (exact excerpt located in the page regions; the server creates the evidence), **from mistake** (server builds it from the attempt). Edit online via PATCH when the server knows the card and no local op is pending, else locally; 409 handled; source-change impacts (keep / relearn / move to current version); suspend, bury, delete with confirmation, restore; history. |
| `/review/revision`, `/review/revision/:id` | One-tap revision: minutes → a list where every item has its reason → run through cards (inline reviewer), questions (practice set) and pages; progress kept on the device. |
| `/review/dna` | Exam DNA: counts with their denominators, sample-size warnings, the relevance note (an indicator inside the owner's archive, **not** a probability). |
| `/review/profile` | Learning Profile: what the platform uses, editable (explanation level, dialect, Socratic mode, new cards per day, desired retention), resets with confirmation, measured pace. |
| `/weakness`, `/weakness/:id`, `/weakness/replay/:questionId` | Weakness Center (reasons in words, transparent score labelled «تقدير», suggested actions, top 5 then all), **Mistake Genome** (accessible bar list + table, denominator in the caption, mistake type editable per answer), **Forgetting Forecast** labelled «تقدير», detail with signals and resolve/dismiss, **Reasoning Replay**. |
| `/planner`, `/planner/new`, `/planner/:id`, `/planner/:id/edit` | Planner: create/edit (exam date, lectures, weekdays, daily minutes, blocked dates) with a required preview before saving, day list or month calendar in the plan timezone (stated on screen), check-off / skip, **rebalance with a visible diff** (moved rows say where they came from) and the infeasibility notice, archive with confirmation. |

### Wiring
* Reader selection toolbar: «أنشئ بطاقة مراجعة» stashes the selection (quote, page, rects) and opens the editor
  with `from=selection`; «أضف إلى المراجعة» saves the «للمراجعة» page mark (works offline). Capability gating as
  before (`flashcards`, `planner`).
* Exam/practice feedback: a wrong, scored answer offers «أنشئ بطاقة من هذا الخطأ» → editor `from=mistake`.

### Charts (dataviz method)
`components/BarList.tsx`: one series → one hue, no legend box (the caption names it), thin bars from the
inline-start baseline, the track is the row's **denominator** («3 من 9», never a bare percentage), values in text
tokens next to the bars, bars `aria-hidden`, a table view with headers holds the same numbers. Mark colour
validated with the dataviz validator: light `#3A47A8`; dark `#7E8AE8` (the dark accent `#A3ADFF` failed the
lightness band, so a feature-level token `--lw-chart-mark` is used).

## 2. How it was tested (commands and real results)

Unit/component tests (vitest + jsdom + fake-indexeddb), `apps/web/test/learning/` — **66 tests, 7 files**:
* `srs-parity.test.ts` — the local fold equals the server fold on a fixture generated **from the server code**
  (`fixtures/make-srs-fixture.mjs` → `srs-parity.json`, 7 cases: new, learning→review, lapse/relearning, duplicate
  ids + ties, reset marker, retention 0.85, months of reviews; state, due time and all four previews; arrival order
  never changes the result); parity check passes / fails with field names / detects other params; Arabic interval
  labels.
* `local-store.test.ts` — offline rating = event + `append` op atomically, no network, survives reload; queue
  reschedules from the local event; daily new limit counts the Baghdad day; suspended/buried skipped; undo
  withdraws row + op only before sync, refused after `sentAt` and after the server ack; appliers don't clobber an
  unsynced edit; cloze → one card per index as full upserts.
* `occlusion-geometry.test.ts` — pointer → normalized coordinates (zoom independent), drag in any direction, click
  draws nothing, move/resize clamped to the image with minimum size, keyboard steps in physical directions (image
  not mirrored in RTL), Alt resize, spoken description.
* `planner-time.test.ts` — the same day key gives the same label under five device timezones; owner day
  boundaries are Baghdad midnights; DST-skipped midnight; grouping, rebalance diff, Saturday-first month grid,
  client checks.
* `review-session.test.tsx` — keyboard flow (Space, 1–4 ignored before reveal, previews «بعد 10 دقائق» for Good on
  a new card, next card follows, only the config request touched the network, Ctrl+Z restores the card), undo
  refused once sent, offline from the saved config, no config offline → «cannot schedule», failing parity refused;
  occlusion front never contains the mask label in text, attributes, alt or URL.
* `home-and-charts.test.tsx` — Home order (Continue Studying first), offline Continue Studying from device sessions,
  merge rule, important question named by its stem; bar list text alternative + table view; Genome estimate note,
  denominator caption, labelled mistake-type selects.
* `editor-and-marks.test.tsx` — occlusion editor keyboard flow, single-mask correction mode, exact excerpt location
  (whitespace tolerant, region choice, no guessing without rects), revision mark saved locally with its op, planner
  day list (timezone shown, check-off).

Real server + browser check (Playwright, Chromium at `/opt/pw-browsers/chromium`, throwaway data dir, Golden Set
uploads `lecture_appendicitis.pdf`, `lecture_cholecystitis.pdf`, `questions_surgery_course1.pdf`,
`questions_previous_exam_2024.pdf`, `histology_images.zip`): `apps/web/test/learning/real-server-check.mjs` —
processing + question extraction + matching, 8 wrong attempts pushed through sync, card from a selection with its
exact evidence excerpt, card from a mistake, occlusion (figure picked from the lecture flowchart page, mask drawn
with the pointer in the editor UI, one card per mask), plan, Home order, hub + revision mark, session (Space, key 3,
rating synced), **offline rating + undo before sync**, one-tap revision within the minutes, Genome/forecast
labelled as estimates, planner timezone, Exam DNA note; no horizontal overflow and ≥ 44 px rating/reveal targets
at 390×844 and 1280×800, light and dark. Screenshots `apps/web/test-screenshots/learning-*.png` were looked at and
the issues found were fixed (Kbd wording, plan bullets, crowded weakness list, bar notes, cloze hint bidi, raw item
type names, misleading «no evidence» on sourced occlusion cards, first-sync empty state).

```
npx vitest run test/learning            (in apps/web)   → 7 files, 66 tests passed (8 consecutive runs green)
npm test -w @medlevo/web                                 → 59 files, 470 tests passed (whole web suite, final run)
npx tsc -p apps/server --noEmit ; npx tsc -p apps/web --noEmit   → exit 0, exit 0
npm run build -w @medlevo/web                            → exit 0
NODE_OPTIONS='--disable-warning=ExperimentalWarning' node apps/web/test/learning/real-server-check.mjs
                                                         → OK: 53 checks passed (after the build)
```

A flaky keyboard test was traced to a real race: a key pressed in the same frame a card appeared reached a
listener holding the previous render's state, and the reveal was reset when the card got pinned. Fixed in the
component (reveal is tracked per card id; the window listener reads the latest state through a ref updated in a
layout effect), not by loosening the test.

## 3. Not done / limits (honest)
* Revision marks pulled from another device appear once the annotations applier is registered (it is, when the
  workspace has been opened on that device in this session); the hub lists marks already in IndexedDB.
* The occlusion figure picker needs a page render or the display PDF; DOCX figures without a bounding box cannot be
  picked; crops of images embedded in PPTX/DOCX pages are approximate.
* Editing a plan creates a new plan and archives the old one (server contract); check-offs stay with the archived
  plan.
* Undo is only possible while the rating is unsent: online that is roughly the push debounce window (≈ 400 ms) —
  in practice undo is an offline feature. The UI says so.
* Performance with thousands of cards was not measured (the local queue refolds every card when its inputs change
  and every 30 s).
* No real-device touch testing and no screen-reader (VoiceOver/NVDA) session; accessibility was checked with
  roles/labels in tests, keyboard flows, contrast-validated chart colours and target sizes in the browser run.
* No AI key exists here: nothing in this track calls a model directly; card-from-selection/-mistake are built by the
  server rules (L1), and anything AI-dependent there reports `requires_configuration` with its Arabic reason.

## 4. Contract deviations
* Feature-level chart token `--lw-chart-mark` (dark `#7E8AE8`) instead of the design-system accent, because the
  accent failed the dataviz lightness band in dark mode.
* «أضف إلى المراجعة» is a bookmark annotation with extra data fields (`revision`, `quote`, `page_label`,
  `source_title`) — the server bookmark schema accepts extra fields; no new entity type.
* Local card rows carry extra non-indexed fields (note id, cloze index, image, evidence, impacts…) in the existing
  `flashcards` table; no Dexie version bump.
* The «أضف إلى المراجعة» action keeps capability `planner` as declared in `aiActions.ts`.

## 5. Independent review (adversarial, after the build) — 2026-10-10

Read every file of the track and the three wiring edits, then probed: a randomized parity probe of the web fold against
the **server** fold (`apps/server/src/modules/learning/srs.ts`) — 3 000 random histories (retention 0.80–0.95, same-ms
ties, relearn markers, up to 14 events): state, due time, stability, difficulty, reps, lapses, retrievability, the four
button previews, event count and first review **all identical (0 mismatches)**; owner-day helpers web vs server for all
418 IANA zones × 134 days (`dayOf` / `dayStartMs` / `dayEndMs`): **0 mismatches**; the real-server Playwright run
(53 checks) re-run after the fixes, plus a probe of the hub's revision marks on the real server. Checked and found
sound: rating = event + `append` op in one Dexie transaction (never awaits the network); undo refused once the op was
selected for a push (selection + `sentAt` happen in one rw transaction, the same store as the undo transaction, so they
cannot interleave); occlusion review front (no label / mask id / file name in text, attributes, alt, URL — blob URLs);
Home order; estimate labels on every percentage; chart text alternatives; no raw HTML; links encoded.

Confirmed and fixed (regression tests in `src/features/review/review-fixes.test.tsx` and
`src/features/planner/planner-fixes.test.tsx`; each fails on the old code):

| Severity | Finding | Fix |
|---|---|---|
| major | A session on an **explicit card list** asked only cards due now. The Weakness Center's «راجع البطاقات التي نسيتها» passes lapsed cards, which after relearning are usually not due → the session ended at once with nothing reviewed (a suggested action that silently did nothing, §0.7). | `computeQueue` counts chosen cards that are not due (`counts.ahead`); the done screen offers «راجعها الآن قبل موعدها» (owner opt-in). Each is asked once (`aheadSince`: a card reviewed after opting in waits for its real due time), labelled «مراجعة مبكرة اخترتها … وتُحسب في جدولتها». The daily queue never offers it. |
| major (a11y) | Planner day list: each day `<section>` and its `<h3>` had the **same id** and `aria-labelledby` pointed at that id → duplicate ids and every day region labelled by itself (its accessible name = all of its tasks). | heading id `day-<date>-h`; a calendar tap on a past day also opens the collapsed «أيام سابقة» before scrolling to it. |
| minor (security) | `/review/session?back=/\host` was accepted (`/\` is `//` for browsers): the «إنهاء الجلسة» link's href pointed to another site (opened that way with a middle-click / new tab). | uses the shared `safeBack` (no `//`, no `\`). |
| minor (honesty) | Editing a plan: if archiving the old plan failed, the toast still said «وأُرشفت السابقة» (both plans stayed active). | the failure is said, as a warning, with what to do. |
| minor (honesty) | After a push **attempt that failed**, undo said «أُرسل هذا التقييم إلى الخادم» although no answer came back. | its own reason: sending was attempted and it may be on the server, it is re-sent automatically and never counted twice (undo stays refused — conservative). |
| minor | Revision marks in the hub showed only the page label — marks from different books were indistinguishable (the toolbar never knows the title). | the book title comes from the library (cached offline), bidi-isolated. |
| minor | Reviewer menu «أجّلها» / «أوقفها» had no error handling (an IndexedDB failure was an unhandled rejection with no feedback). | try/catch + Arabic error toast. |
| minor | After merging duplicate cards, the merged-away card stayed reviewable on this device until the next periodic pull (a rating on it would be rejected by the server). | a sync (push + pull) right after the merge. |
| minor (copy) | Exam DNA: «9 أسئلة فريدًا», «من أصل 9 سؤالًا» (number agreement). Plan view: the timezone was not bidi-isolated. | agreement helper / rephrased denominator note; `<bdi dir="ltr">` around the timezone in the plan view. |

Noted, not changed:
* Home «تابع الدراسة»: when this device's session is newer than the server's, the server's page label is still shown
  (the book itself opens at the device's place — the workspace resumes from the session). The builder's test pins this
  merge rule (`test/learning/home-and-charts.test.tsx`, outside this review's editable paths).
* Day list: the timezone line is not bidi-isolated (the builder's test matches the plain string); it ends the sentence,
  so it renders correctly.
* A card the device knows only from an HTTP answer before its review events were pulled is folded as new until the pull
  delivers its events (the server's schedule is unaffected; normally the pull runs within seconds).
* The flashcard applier and `putServerCards` overwrite a row whose op ended in `conflict`/`rejected` with the server copy
  (the edit survives as the server's conflict copy) — by design of the sync contract.

Commands (repo root unless noted), real results after the fixes:

| Command | Result |
|---|---|
| `npx tsx …/parity-probe.mts` (scratch, server fold vs web fold) | `cases=3000 mismatches=0` |
| `npx tsx …/time-probe.mts` (scratch, server vs web owner days) | `zones 418 cases 56012 mismatch 0` |
| `npx vitest run test/learning src/features/review src/features/planner` (in `apps/web`) | 9 files, 73 tests passed |
| `npm test -w @medlevo/web` | 61 files, 479 tests passed |
| `npx tsc -p apps/server --noEmit` / `npx tsc -p apps/web --noEmit` | exit 0 / exit 0 |
| `npm run build -w @medlevo/web` | exit 0 |
| `node apps/web/test/learning/real-server-check.mjs` (after the build) | OK: 53 checks passed |

## 6. Integration round I1 (2026-10-10)
* **Home «تابع الدراسة» shows this device's place when it is newer.** `mergeContinue` kept the server's page label
  when this device's session was newer, so Home named an older page. Now this device's label and mode win; the
  server's label stays only when the device's session holds no page. The device label comes from the downloaded page
  list when the source is on the device («ص 12 (الصفحة 14 في الملف)», `localSessionPageLabel`), else from the file
  position («الصفحة 14 في الملف») — never a guessed printed number. Tests: `test/learning/home-and-charts.test.tsx`.

## Integration round I2 — 3 000 cards / 12 000 review events on one device (2026-10-10)
* **The first sync of a large deck crawled.** `useLocalCards` read both tables with whole-table live queries, and
  every consumer (review hub, home, session, library) re-folds every card with FSRS on each new set of rows; Dexie
  re-ran both queries after nearly every pulled change. Profiled in Chromium during a first-visit sync of 3 000 cards
  + 12 000 events: > 50 % of the main thread in re-reads and re-folds, ≈ 55 events/s reaching IndexedDB. The hook now
  listens to Dexie's `storagemutated` event and re-reads at most once per `LOCAL_CARDS_RELOAD_MS` (400 ms) during a
  burst, with one re-read after it; the first write after a quiet period (a rating) is still reflected at once.
  After: ≈ 250 events/s, main thread mostly idle (the remaining cost is one IndexedDB transaction set per pulled
  change in the sync engine — not changed here). Test: `test/learning/local-cards-burst.test.tsx` (old code: 153
  re-reads for 300 writes).
* The pure fold (`computeQueue`, 3 000 cards × 4 events) measured in Node: `test/learning/queue.perf.test.ts`
  (`MEDLEVO_PERF=1`); numbers in [`docs/PERFORMANCE.md`](../PERFORMANCE.md).

## F2 Course Brain additions (2026-10-10, §44)
* **Weakness Center** (`features/weakness/parts.tsx`, `WeaknessDetail.tsx`, `WeaknessCenter.tsx`, additive): weakness
  kind `case` («حالة») for a clinical case / OSCE station / viva grouping; signal type `viva` («امتحان شفهي») next to
  `case` / `osce`; the suggested action `retry_case` («أعد محاولة …», icon + text) opens `/cases/:id`; a link
  «خريطتي المعرفية» opens the Student Knowledge Map (`/knowledge`, in `features/brain`). Server side:
  `docs/modules/learning.md` §6. Tests: `apps/web/src/features/brain/brain.test.tsx` (case kind label and the `retry_case` link; the viva label
  is not unit-tested),
  `e2e/f2-course-brain.spec.ts` (an OSCE attempt shows in the Weakness Center as its own type).
