# Practice & Exams (track C4)

Owns `apps/server/src/modules/exams/**` (incl. `generation/`), migration `0550_exams.sql` (range 0550–0599),
`apps/server/test/exams/**`, `apps/web/src/features/exams/**`, the shared contract `packages/shared/src/exams-api.ts`
(new file of this track, exported from `index.ts`) and this file.
Spec: §37, §38, §39, §41, §44 (attempt signals only); AC-14, AC-17, AC-18, AC-19, AC-26, AC-27.
Contracts consumed exactly: `shared/questions.ts` (`ExamConfig`, `ExamPolicy`, `ExamItemView`, `QuestionAttemptInput`,
`AttemptFeedback`, `ExamResultView`), `evidence.ts`, `scope.ts`, `enums.ts`, `features.ts`, `api.ts`.
Services used: questions (`listForExam`, `createQuestion`, `getQuestion`, `scorability`, `validateQuestion`),
evidence (`resolveScope`, `retrieve`, `abstainFor`, `packFromCandidates`, `validateClaims`, `getClaimViews`,
`recordDependencies`), `ctx.ai.generateStructured`, `ctx.sync.registerEntity`, `ctx.jobs`.

> Resume note: the first attempt of this track (interrupted by a container restart) had written the migration, the
> builder, delivery, attempts, hints, feedback, mistakes, results and the generation schema/validation files. They
> were reviewed, kept and completed; routes, the generation pipeline, written grading, all tests and the whole web
> feature were written in this run.

## 1. Server

### Data (migration `0550_exams.sql`, no existing migration edited)
* `exam` + `build_json` (the `ExamBuildReport`), `seed`. `items_json` = `[{question_id, question_version_id,
  option_order:[option ids], display_labels, scored, unscored_reason_ar, origin_type}]` — versions are **pinned**
  (a version placed in an exam is locked by the questions module), the policy is stored once (`policy_json`).
* `exam_attempt` + `answers_json` (`{"<index>": ExamAnswerState}`), `flags_json`, `rev`, `device_id`.
* `question_attempt` + `exam_item_index`, `unscored_reason`, `key_status_at_answer`, `key_at_answer_json` (the key
  used for grading — snapshot), `time_budget_ms`, `auto_mistake_type`/`auto_mistake_reason`, `rev`, `updated_at`;
  unique `(exam_attempt_id, exam_item_index)`.
* `exam_item_event` (hint_1 / hint_2 / solution_viewed served by the server; `hints_used` can never be lower).
* `question_generation_run`, `generated_question_candidate` (failed candidates stay here, never in the vault).
* `written_attempt` + `status`, `graded_at`, `rubric_json`, `scope_json`, `model`, `error_json`, `updated_at`.

### Builder (`builder.ts`, §39, AC-14, AC-17)
* Scope: question sources (occurrences), lectures (lecture links; «من محاضرتي فقط» = links with
  `answerable_from_lecture`), courses, explicit question ids; nothing chosen = whole vault. A `/practice` deep link
  always gets its question first.
* Filters: MCQ types (written types go to the written flow, reported), question type, a figure that cannot be
  delivered, estimated difficulty (question estimate, else personal accuracy with ≥ 2 scored attempts — «تقديرية»),
  origin mix (source + owner vs generated ratios), «أخطائي» (latest scored attempt wrong) first.
* **Assessed modes** (`exam`, `time_pressure`, `simulation`) take only scorable questions
  (`SCORABLE_ANSWER_STATUSES` + correct ids + no blocking validation = `validation.publishable`); practice/revision
  include unresolved keys, delivered with `scored: false` and the Arabic reason (AC-14).
* **One question once** (AC-17): exact duplicates are already one question with several occurrences; confirmed
  duplicates share `duplicate_group`; translations/paraphrases are grouped with their origin. Within a group the
  scorable member wins.
* Option order: stable option ids; shuffled only when the policy and the version allow it and nothing depends on the
  order («all/none of the above», «A and B», «كل ما سبق»); pinned options keep their place; seeded (reproducible).
  Display labels are positional (A–E, or أ–هـ when the source used Arabic labels).
* Policy (fixed at creation, never changes): assessed → hints off, solutions at the end, pause off unless chosen at
  creation (time pressure: never), shuffle on; practice → progressive hints, solution after each, pause on, optional
  Anti-shortcut. A policy sent later in a sync payload is ignored; a pause the policy forbids is rejected.
* `ExamBuildReport`: requested, matched, scorable / unscorable, duplicates removed, selected (scored / unscored),
  by origin, my mistakes, exclusions `{code, reason_ar, count, question_ids}`, notes. Nothing matching → 409 with
  the report (no empty exam). Create is idempotent by the client `attempt_id`.

### Delivery (`delivery.ts`, AC-19)
`ExamItemView` only: stem / options rich text **sanitized to presentation** (no claim / evidence / term ids), negation
flags, `scored`. No key, explanation, distractor explanations, lecture links or reasons, section / topic titles,
source names, page labels. Media: short-lived HMAC exam-media tokens (`/api/exams/media/:token`, 2 h, bound to
attempt + file and checked against the exam's items), neutral alt «الصورة 1 المرفقة بالسؤال», served with
`Content-Disposition: inline` and **no file name**. A question whose figure has no file is not delivered.

### Attempts (sync, `attempts.ts`)
* `question_attempt` — append-only, idempotent by client id (`applied` / `duplicate`); camelCase Dexie payloads
  accepted. Graded **once at insertion** against the pinned version's key (snapshotted); scored only if the version
  was scorable at answer time and the item counts; solution viewed before answering → recorded, not scored. One
  attempt per exam item (a second, different one → `rejected`, the first stays). During an exam whose solutions come
  at the end, per-question appends are refused (graded when the attempt is finished). `upsert` may only change the
  owner's mistake type; `delete` is refused.
* `exam_attempt` — `upsert` with the full state (status, elapsed, current index, answers, flags, timer). Per-item
  merge by each answer's own timestamp, submitted answers locked, invalid options dropped (reported), elapsed and
  item times never decrease and are capped by wall-clock time, pause only if the policy allows it, a finished
  attempt is immutable (a repeated identical finish → `duplicate`). Finishing materializes one `question_attempt`
  per answered item with the client's ids (idempotent with the client's own appends) — in practice too, a chosen but
  unchecked answer becomes an attempt. An item whose pinned question was purged with its source is skipped (reported
  in the op detail, shown unscored with the reason) — finishing is never rejected half-way (review fix).
* AC-26: a key correction after an attempt creates a new version (questions module); the attempt keeps its version,
  result and key snapshot; feedback shows «تغيّر مفتاح هذا السؤال بعد محاولتك … لم يُعَد تقييمها». When the
  correction came BEFORE the answer (the exam had pinned the older version) the note says so: graded on the pinned
  version's key, a new exam uses the corrected one (review fix).

### Practice: hints, solution, feedback, mistakes
* Hint 1 (`hints.ts`): the lecture pages of the question's links (in page order) and the page heading only if it
  shares no word with any option, plus the asked item type — never a link reason or the key. Hint 2: the stem with
  clue words bold (negation, first-line/next/best, age, sex/group, values+units, time course) and why each matters.
  Hint 2 needs hint 1; hints off in assessed modes.
* Solution before answering: recorded (`solution_viewed_before_answer`), refused in Anti-shortcut mode until an
  answer is chosen.
* Feedback (`AttemptFeedbackView`) after answering (practice) or after finishing (exam): result or the unscored
  reason, key + who stands behind it, explanation and distractor explanations keyed by option id with their claims
  (`ClaimView`s → evidence chips), origin label + every occurrence, lecture links and pages, AC-27 mastery signal,
  learning objective / estimated difficulty for generated questions, newer-key note.
* Mistake type (`mistakes.ts`, §44): deterministic suggestion for wrong scored answers — over the per-question budget →
  `time_pressure` (worded «قد يكون … وقد لا يكون»), negation question → `misread`, investigation first-line wording →
  `first_line_vs_confirmatory`, next-step wording → `step_order`, confident wrong → `misunderstanding` /
  `concept_confusion` (diagnosis), otherwise `knowledge_gap`. Stored `mistake_origin='auto'`, editable by the owner
  (`PATCH /question-attempts/:id/mistake` or sync upsert → `owner`), the auto suggestion stays visible.

### Results (`results.ts`)
`ExamResultDetail`: correct / **scored items** (denominator note), answered / unanswered, active time, hints, AC-27
signals (correct guesses, after a hint, solution viewed, confident wrong), by lecture and by concept, strong / weak
(groups with ≥ 2 scored items, shown as «n من m»), unscored reasons, time budget split (with «لا يعني أن الخطأ سببه
ضغط الوقت»), deterministic review suggestions (lecture pages, retry, check unscored), items with mastery signal and
mistake type, `missing_on_server` (answers still on a device). Assessed results only after finishing (409 before).
History: newest first, scores hidden for unfinished assessed attempts.

### Generated hard MCQs (`generation/`, §37–§38, AC-18; capability `ai.generate_questions`)
`POST /api/exams/generate` → run + job `exams.generate_questions`:
1. Request needs pages or a topic; default scope = **lecture only**; a wider scope only `lecture_plus_references` by
   explicit choice; `references_only` / another lecture / pages of another version → 409; unknown keys → 400.
   Generator **and** independent validator must be available, else 409 `AI_NOT_CONFIGURED` with the reason.
2. C1 retrieval inside the stored resolved scope → `abstainFor` → pack. Fewer distinct citable excerpts than the
   difficulty needs (medium 2, hard 3, very hard 4) → **abstained** with a suggestion (lower the difficulty, more
   pages, or widen the scope explicitly); the generator is not called. G3 (AC-08): the pack is built with
   `fixedAnswer: true` — excerpts whose region is an uncertain reading (diagram labels read by OCR) or flagged for
   review (low OCR confidence, suspected extraction defect) are never handed to the generator (said in the run summary
   / abstention); the written-answer rubric uses the same rule.
3. `generate_questions` with the evidence as delimited untrusted blocks; a model abstention → abstained.
4. Per question: server-side normalization (keys, NOT/EXCEPT capitalized) → deterministic checks (4–5 distinct
   options, one best answer key, no «all/none of the above», length / absolute-word / «an» / stem-repeat clues,
   complete vignette with a patient and a question, explanation + **every** distractor explanation present,
   non-generic, evidence-bearing) + the vault's own `validateQuestion` → **independent `validate_question`** (sees
   stem + options + evidence, never the key or explanations: chosen answer must equal the key, exactly one
   defensible option, answerable from evidence, no clue issues) → C1 `validateClaims` on the explanation and each
   distractor explanation (aliases handed out only, scope, critical tokens, independent `verify_support`): no
   rejected / conflicting / **unconfirmed** (`needs_review`, e.g. a «partial» verdict) medical sentence — every
   medical sentence must be `linked` (review fix) — and at least one linked claim for the answer and each distractor.
5. Failure → repair call with the failed checks listed (max 2 repairs, 3 rounds) → still failing → candidate
   `needs_review` + `review_queue_item` (`question_validation_failed`, `entity_type='generated_question_candidate'`,
   `details.origin='exams'`), **never published**. No verifier available → straight to review (repairs cannot help).
6. Passing → `createQuestion` (origin `generated`, «سؤال مولد بواسطة MedLevo من المصادر المحددة», `ai_derived`
   key, explanation / distractor explanations with claim ids, learning objective, item type, estimated difficulty,
   model, lecture link with the cited pages) + `recordDependencies` (replacement alerts reach it). Candidate keeps
   option → evidence ids, regions, lecture pages, concepts. Claims are owned by `('generated_question', candidate)`.
Run status: completed / partial / needs_review / abstained / failed (non-retryable errors), with an Arabic summary.

### Written answers (`written.ts`, §41; capability `ai.grade_written`)
Typed answers saved append-only (idempotent id; MCQ questions refused; recognized text is graded only after the
owner confirmed it). Grading: the question's rubric, or a rubric generated from evidence retrieved in the scope
(request scope, else the best linked lecture, lecture only) and validated point by point. ≥ 2 verified points (or a
question rubric of ≥ 2 points) → `rubric_score` with an **estimated** score; otherwise `qualitative_only` (no number).
Only generated rubric points the verifier confirmed (`linked`) enter the rubric and the score; wrong statements are
kept only when their «why» is `linked` (review fix); the improved answer keeps verified sentences with claim ids. No rubric and no linked lecture → qualitative only without calling the model. Graded once (asking
again returns the stored assessment). Label «تقييم تعليمي آلي، ليس تصحيحًا رسميًا».

### Routes (`/api/exams`, owner session + CSRF)
`POST /preview`, `POST /`, `GET /attempts`, `GET /attempts/:id`, `POST /attempts/:id/items/:i/{hint,answer,solution}`,
`GET /attempts/:id/items/:i/feedback`, `GET /attempts/:id/result`, `PATCH /question-attempts/:id/mistake`,
`GET /media/:token`, `POST|GET /generate`, `GET /generate/:runId`, `GET /written/:questionId`,
`POST /written/attempts`, `POST /written/attempts/:id/grade` (AI routes rate-limited). zod on every body / query.
Capabilities: `exams` available; `ai.generate_questions`, `ai.grade_written` available → reported
`requires_configuration` by the registry while no provider is configured.

## 2. Web (`apps/web/src/features/exams`)
| route | screen |
|---|---|
| `/exams` | history (status, «n من m محسوبة» only when allowed, resume) |
| `/exams/new` | builder: mode, count, total time / per-question time, courses, lectures, question sources, «من محاضرتي فقط», «أضف أخطائي», types, estimated difficulty, original/generated mix, fixed policy switches; **live server preview** with real counts and exclusion reasons |
| `/exams/:attemptId` (full-bleed) | the Question Sheet |
| `/exams/:attemptId/results` | results, by lecture, weak / strong, review plan, items with correction + evidence + mistake editor |
| `/exams/generate` | generated MCQs (lecture, pages, topic, count, difficulty, types, language, explicit «المحاضرة + مراجعها»), run status polling, abstention reason + suggestion, candidates with issues |
| `/exams/written/:questionId` | written answer with a local draft, saved attempts, grading (gated), assessment view |
| `/practice?source_id=&question_id=` | the «تدرّب» entry (workspace Questions tab); written questions go to the written screen |

* **Question Sheet**: stem in the reading face with NOT/EXCEPT emphasized + «سؤال منفي» pill, the question in its own
  direction (an English question reads LTR, labels on the left), options as radios (checkboxes for multi-select) with
  display labels, keys **1–9 / A–H / أ ب ج د هـ**, ↑↓ between options, ←→ between questions (RTL aware), flag,
  navigator (state in words: «السؤال 3، مُجاب، مُعلَّم للمراجعة، الحالي»), timer (`role="timer"`, total left or
  elapsed, per-question budget «تجاوزت وقت السؤال» as information only, spoken warnings at 5 and 1 min), pause only
  when the policy allows it (the question is hidden while paused), autosave status (design `SaveStatus` from the
  outbox state), optional confidence (تخمين / غير متأكد / واثق — read-only once a practice answer was checked),
  finish dialog with counts. The total limit finishes the attempt automatically (answers kept). When the fixed policy
  forbids pausing, a hidden tab / another app does not stop the clock (it says so). Generated questions in the set are
  announced in the header («أسئلة مولدة بواسطة MedLevo …», «محاكاة مولدة — ليست نسخة متوقعة من الامتحان»).
* **Practice**: «تلميح» → «تلميح أعمق» → «اعرض الحل» (disabled with the reason in Anti-shortcut mode),
  «تحقّق من إجابتي» → `FeedbackPanel` (result line in words + icon, AC-27 note, key and «اختيارك» tags, explanation
  and distractor explanations with C1 `CitationChip`s, origin and occurrences, lecture pages, mistake editor).
* **Local-first** (`local.ts`): every change is written to Dexie `examAttempts` (state in the row) with a full-state
  `exam_attempt` upsert in the same transaction (coalesced while unsent); a checked practice answer is an append-only
  `question_attempt`; the mistake type is an upsert of the signal only. The delivered session is cached in kv: an
  exam opened online can be taken and resumed offline; a reload merges the local copy with the server copy per item
  (never dropping an answer). Appliers for both entity types never overwrite pending local writes. Creating an exam,
  hints, checking and AI features need the server and say so.

## 3. Tests and verification (real results, 2026-10-09)
Server (`apps/server/test/exams/`, Golden Set question sources + lecture through the real upload → processing →
extraction → matching pipeline; AI only through a test-only scripted provider):
* `exams.test.ts` (22): AC-17 (exact duplicate in two files = one item with both occurrences; confirmed duplicates
  never both), AC-14 (unresolved key excluded from assessed exams with reason; practice shows it unscored; answer
  recorded with `is_correct = null`), 409 with report, lecture-only answerable, option order (pinned «All of the
  above» never shuffled, stable ids, seeded, practice keeps order), Arabic labels, idempotent create, AC-19 (allowed
  keys only, no key / explanation / source / section / evidence strings; solution, feedback, result, hint refused
  during the exam), media (neutral alt, no file name in payload or headers, forged / expired token 403, refreshed on
  reopen), attempts (append idempotent, duplicate op, second answer rejected, camelCase payload, foreign option,
  delete refused), AC-26 (key correction → new version, attempt result and key unchanged, newer-key note, new exams
  pin the new version), policy immutability (pause refused, smuggled policy ignored, hints never on in assessed),
  time pressure no pause, practice pause/timer/merge/cap/dropped options, exam finish (answers change until finishing,
  per-question appends refused mid-exam, materialization, misread suggestion, duplicate / rejected after finish,
  results with denominators and signals, solutions after finishing), time budget suggestion wording, hints (order,
  hint 1 never names the answer, hint 2 clues, server keeps served hints), solution viewed → unscored, Anti-shortcut,
  mistake type auto + owner edit (HTTP + sync, answer unchanged), history, validation / 404 / 401 / CSRF,
  capabilities and AI refusal without a provider.
* `generation.test.ts` (13): valid question published with verified evidence for the answer and every distractor
  (validator never saw the key, all model calls stayed in the lecture version, vault labels / `ai_derived` /
  validation / dependencies), practice feedback with linked claims and generated label, origin mix; two defensible
  answers → repaired (2 rounds); unsupported alias → 2 repairs → review queue, nothing published; deterministic clue
  caught before any validator call; insufficient evidence → abstained with suggestion, generator not called; model
  abstention; Source Lock on the request; run listing. Written: idempotent save, MCQ / unconfirmed text refused;
  verified rubric → estimated score, points, wrong statement, improved answer with linked claims, graded once;
  rubric failing evidence → qualitative only; no rubric + no lecture → qualitative only without a model call.
* `units.test.ts` (19): option order, order dependence, labels, sanitizing, policy defaults, Arabic counts, mistake
  heuristics, clue words, deterministic generation checks, validator issues, state merge, AC-27 signals.

Web (`apps/web/src/features/exams/`): `model.test.ts` (8), `local.test.ts` (4), `runner.test.tsx` (5: exam keyboard
answering saved to Dexie + outbox, no pause / hints / solution, Arabic letter keys, RTL arrows, navigator words;
resume from the local copy; practice pause hides the question and the clock counts; hint → deeper hint → check with
`hints_used = 2`, feedback, append-only local attempt, locked answer; Anti-shortcut).

Real-server check (`node apps/web/src/features/exams/real-server-check.mjs`, built app, Chromium
`/opt/pw-browsers/chromium`, 1280×800 + 390×844 light/dark, no AI key): **36/36 PASS** — history empty state, AI
gating with the reason, builder preview (6 scorable / 1 unscorable with the reason), exam without hints/pause and
without source/key text in the page, keys «2» and ←, confidence, offline «محفوظ محليًا», reload before sync resumes
the unsynced answer from IndexedDB, finish dialog counts, results with denominator and by-lecture table, correction
after finishing, practice deep link with hints and the «صحيحة بعد تلميح» label, generator and written grading
disabled with reasons, no horizontal overflow at 390 px, option targets ≥ 44 px. Screenshots looked at; fixed after
looking: an English question was laid out RTL (labels right, text left) → the question keeps its own direction; the
confidence control showed «تخمين» as selected before any choice → explicit pressed buttons; hint pages unordered;
duplicated title in the top bar.

Final command results (repo root, `NODE_OPTIONS='--disable-warning=ExperimentalWarning'`, 2026-10-09):

| Command | Result |
|---|---|
| `npx vitest run test/exams` (in `apps/server`) | 3 files, 54 tests passed |
| `npm test -w @medlevo/server` | 38 files, 577 tests passed (whole server, shared tree with the parallel track) |
| `npx vitest run src/features/exams` (in `apps/web`) | 3 files, 17 tests passed |
| `npm test -w @medlevo/web` | 362 tests passed (whole web) |
| `npx tsc -p apps/server --noEmit` | exit 0 |
| `npx tsc -p apps/web --noEmit` | exit 0 |
| `npm run build -w @medlevo/web` | exit 0 |
| `node apps/web/src/features/exams/real-server-check.mjs` | 36 PASS, «OK: 36 checks passed.» |

## 4. Not done / limits (honest)
* **Translations of questions** (§37 «ترجمة مساعدة … نسخة مشتقة»): not built. The questions service can only create a
  translation as a new *generated/owner* question (wrong origin label and no way to keep a `source_key`) or as the
  new current version of the same question (would replace the original). Generated questions can be requested in
  Arabic. The builder already groups translation/paraphrase lineages as one item.
* `answer_evidence` rows are not written for generated questions (table of the questions module, no service); the
  option → evidence mapping lives in `generated_question_candidate.evidence_json` and the claims/citations.
* No owner action to publish or edit a generated candidate from the review queue (by design: failing items are never
  published; the owner can request a new run).
* Clinical cases / OSCE / viva (§42) and Exam DNA / generated simulation by question-source distribution (§40) are
  not built (`is_generated_simulation` is only set when a simulation contains generated questions).
* Handwriting recognition for written answers is not available (owner types the text); written attempts are online
  (a local draft is kept on the device).
* Difficulty is an estimate (generated estimate or personal accuracy), never a standard; concepts per item come from
  generated candidates and lecture-link concept ids only.
* Offline: exams created online can be taken offline; creating exams, hints, checking, solutions, results and AI
  need the server. Media of an offline exam load only if the browser still has them.
* Active time is persisted every 5 s and on navigation / hide; a hard crash can lose a few seconds of timer (never an
  answer — answers are written immediately).
* No real AI provider was run: every AI path is tested with the test-only scripted provider; without a key all AI
  features report `requires_configuration` and the UI shows the reason.
* Navigation entry: `/exams` is reached from the workspace Questions tab («تدرّب» → `/practice`), the result /
  history links and by URL; a link in the app shell navigation (core-web, `app/AppShell.tsx`) or on the home screen
  belongs to those owners and was not added by this track.
* Not run: real iPad/iPhone Safari, VoiceOver/NVDA, axe/Lighthouse.

## 5. Independent adversarial review (2026-10-09)
A second agent reviewed this track by reading the code and running probes (regression tests written first, seen
failing on the original code, then fixed). Files touched: `exams/{attempts,delivery,feedback,results,routes,store,
written}.ts`, `exams/generation/pipeline.ts`, `test/exams/review.test.ts` (new), web `RunnerScreen.tsx`,
`ResultsScreen.tsx`, `WrittenScreen.tsx`, `model.ts`, `useExamSession.ts`, `exams.css`, `model.test.ts`,
`review.test.tsx` (new), this file. No shared contract, migration or other track's file was changed.

Confirmed and fixed:
| # | Severity | Defect | Fix + regression test |
|---|---|---|---|
| 1 | major | Generated MCQ published although a medical sentence of its explanation / a distractor explanation was only `needs_review` (verifier verdict «partial»): `checkClaims` only failed rejected / conflicting sentences and required ONE linked sentence per part | every medical sentence must be `linked`; `review.test.ts` «partial claim is never published» + control |
| 2 | major | Finishing an exam whose pinned question was purged meanwhile: `materializeAnswers` threw → the sync engine recorded the op `rejected` but the `completed` state written just before stayed committed (the engine catches `AppError` inside its transaction) → remaining answers never graded, attempt immutable, client told «rejected» | materialization never throws per item (skips + counts, op detail explains); purged items delivered / scored as unscored with the reason; `missing_on_server` ignores them; `review.test.ts` (verified on the old code: op `rejected`, server status `completed`) |
| 3 | major | Practice: answers chosen but not checked before «إنهاء التدريب» were never attempts, yet the result counted them in `missing_on_server` → a permanent false «لم تصل الخادم بعد» | finishing materializes every answered item (practice too); `review.test.ts` |
| 4 | major | Practice: the confidence of a CHECKED answer stayed editable; the change only altered this device's copy (the recorded append-only attempt kept the old value) and allowed re-labelling a guess after seeing the correction (AC-27 data). `model.test.ts` asserted this behaviour | `setConfidence` refuses submitted answers; the picker becomes a read-only line; tests updated + `review.test.tsx` |
| 5 | major | A hidden tab / another app stopped the clock even when the FIXED policy forbids pausing (timed exam / time-pressure) — an implicit pause the policy does not allow (§39) | time counts while hidden when `pause_allowed` is false (cap 120 s per tick for throttled background timers) and the runner says so; `review.test.tsx` (+ control: practice still stops) |
| 6 | minor | Written grading: generated rubric points that the verifier did not confirm (`needs_review`) entered the rubric and the estimated score; «wrong statement» notes were shown with an unconfirmed reason | only `linked` points / reasons; `review.test.ts` |
| 7 | minor | Anti-shortcut: «اعرض الحل» right after choosing an answer was refused (409) because the outbox push is debounced and the server checks its own copy | the runner sends the state before asking; `review.test.tsx` |
| 8 | minor | Results page of a still-running attempt said «أنهيت المحاولة على هذا الجهاز» | says the attempt is still running + «أكمل الاختبار»; `review.test.tsx` |
| 9 | minor | Generated questions were not labelled as generated anywhere in the runner (the contract's `ExamItemView` has no origin) | header line with the generated count from the build report («محاكاة مولدة — ليست نسخة متوقعة من الامتحان» for generated simulations); `review.test.tsx` |
| 10 | minor | AC-26 note said «تغيّر مفتاح هذا السؤال بعد محاولتك» also when the key was corrected BEFORE the answer (exam pinned the older version) | wording by timing; `review.test.ts` |
| 11 | minor | Written answer save used a new client id on every click → a retry after a lost response stored the answer twice | stable pending id until success; Arabic agreement «سؤال واحد مُعلَّمة» fixed; «removed» count wording |

Checked and found correct (no change): no key / explanation / source / section / evidence / media name in the
delivery payload or media headers; hints, feedback, solution and result refused during assessed attempts; unresolved
keys never scored and excluded from assessed modes; pinned versions + key snapshot (no silent re-grade); one attempt
per item (unique index), append idempotency by client id, `duplicate` on retried ops; policy cannot be changed by sync
payloads; generation never publishes a failing candidate, the validator never sees the key, scope / pages locked to
the lecture version, abstention before the generator is called; auth + CSRF via the global guard, zod on bodies.

Not fixed — reported (outside this track's paths or a contract decision):
* core-server `SyncRegistry.applyOne` catches `AppError` from a handler INSIDE its transaction, so writes a handler
  made before throwing are committed while the op is recorded `rejected` (a SAVEPOINT around `handler.apply` would
  fix it for every module). The exams handlers no longer throw after writing.
* `ExamItemView` carries no origin: generated items can only be announced per set, not per question, during the
  attempt (they are labelled per question after answering / in the results). A contract field would be needed.
* `masterySignal` (shared) treats a correct answer with NO confidence given as «صحيحة بثقة ودون مساعدة»; confidence is
  optional in the runner, so independent mastery may be over-counted by the learning track unless it handles `null`.
* A practice / exam attempt pinned to a superseded version is still graded on that version's (corrected) key; the
  feedback says so, but the attempt counts. Changing this is a product decision (AC-26 only requires preservation).
* `wantedTypes` (question-type filter of the builder) drops questions without an exclusion entry (no
  `ExamExclusionCode` for it in the shared contract).

Commands after the fixes (repo root, `NODE_OPTIONS='--disable-warning=ExperimentalWarning'`):
| Command | Result |
|---|---|
| `npx vitest run test/exams` (in `apps/server`) | 4 files, 60 tests passed |
| `npm test -w @medlevo/server` | 40 files, 611 tests passed |
| `npx vitest run src/features/exams` (in `apps/web`) | 4 files, 23 tests passed |
| `npm test -w @medlevo/web` | 46 files, 369 tests passed |
| `npx tsc -p apps/server --noEmit` / `npx tsc -p apps/web --noEmit` | exit 0 / exit 0 |
| `npm run build -w @medlevo/web` | exit 0 |
| `node apps/web/src/features/exams/real-server-check.mjs` | «OK: 36 checks passed.» |

## 6. Integration round I1 (2026-10-10)
* **Origin per delivered item.** `ExamSessionView.items` are now `ExamItemDeliveryView` (shared `exams-api.ts`,
  additive: `ExamItemView` + `origin_type` + `origin_label_ar`). The label is the generic kind only
  (`EXAM_ITEM_ORIGIN_LABELS_AR`: «سؤال من مصادر أسئلتك» / «سؤال مولد بواسطة MedLevo من المصادر المحددة» / «سؤال
  أضفته بنفسك»), never a question source's name, year or page (AC-19). The origin is the one pinned in `items_json`
  at creation (the question row for older records). The runner shows the generated label on each generated item
  during the attempt; source items show nothing extra. Tests: server `exams.test.ts` (AC-19 key set + no source
  name), `generation.test.ts` (mixed exam: generated vs source item), web `runner.test.tsx`.
* `runner.test.tsx` «keyboard answering…» was flaky under a loaded machine (about 1 run in 3 with the whole exams
  folder in parallel): the key was pressed before the passive effect re-attached the keyboard listener with the loaded
  state. The test now flushes effects (`await act(async () => {})`) before the key press; 5/5 runs pass.

## G2 acceptance fix (2026-10-10, AC-06)
* `generation/validate.ts deterministicIssues`: a generated stem or option that writes a page / slide / alias
  reference into its text («(see lecture p. 12)», «(ص 99)», «[E3]») is a blocking `evidence_supported` issue — repaired
  or sent to review, never published (citations are evidence links only). Shared detector:
  `evidence/textcite.ts`. Test: `apps/server/test/acceptance/g2-ac06.test.ts`.

## G5 acceptance fixes (2026-10-10, AC-18, AC-19)
* **AC-19 — answer marks never delivered** (`delivery.ts withoutAnswerMarks`): a tick «✓» printed next to the keyed
  option (the parser records it as an unofficial mark but keeps the text), a lone «*», «(correct)» or an «Answer: B» glued
  to the last option were delivered as option text during assessed exams and practice. The item delivered for answering
  drops them; the vault keeps the original text.
* **AC-19 (practice) — the pre-answer reason never names the key** (`delivery.ts unscoredReasons`): an item unscorable
  because its source key was read with doubt carried «مفتاح المصدر («B» في …) … بثقة منخفضة» next to the question
  before answering. Key-check blockers now show `KEY_UNDER_REVIEW_AR`; the full reason comes with the feedback.
* **AC-18 — no knowledge from outside the material without a claim** (`generation/validate.ts deterministicIssues`): the
  evidence module keeps a claim-less sentence as connective text unless it carries a value, so a generated explanation
  or distractor explanation could publish «In pregnant women CT abdomen is the first test to order.» or «الزائدة
  الملتهبة لا تحتاج جراحة …» by omitting its claim. As in the Study Book (`studybook/publish.ts isConnectiveText`), only a
  question to the learner or a short connective phrase may stand without evidence; anything else is a blocking
  `evidence_supported` issue (repair → review, never published).
* Tests: `apps/server/test/acceptance/g5-ac18.test.ts`, `g5-ac19.test.ts`; `e2e/g5-ac17-ac19-exam.spec.ts`.


## G8 acceptance fixes (AC-27, 2026-10-10)
* **More help never earns more credit** (`shared/exams-api.ts masterySignal`): a guessed correct answer given AFTER a hint
  weighed 0.35 («after a hint») against 0.2 for the same guess without the hint. A guess is now a guess with or without
  hints (weights are monotone: help or lower confidence never raises the weight).
* **Only a wrong answer has a mistake type — on every path** (`attempts.ts setMistakeType`): the learning PATCH refused a
  type on a correct answer, but `PATCH /question-attempts/:id/mistake` and the sync `upsert` accepted it. All three
  refuse now (409 / sync `rejected` with the Arabic reason).
* Tests: `apps/server/test/acceptance/g8-ac27.test.ts`.
