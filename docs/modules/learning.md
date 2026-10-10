# Learning — server (track L1)

Owns `apps/server/src/modules/learning/**`, migration `0600_learning.sql` (range 0600–0649), `apps/server/test/learning/**`,
the new shared contract `packages/shared/src/learning-api.ts` (exported from `index.ts` — one appended line) and this
file. `packages/shared/src/learning.ts` was used as is (no edit was needed).
Spec: §40, §43, §44, §45, §47 (idempotent events, timezone); AC-23 (server side), AC-24, AC-26, AC-27.
Services used: evidence (`fromRegion`, `getViews`, `getViewsWithMissing`, `getClaimViews`, `recordDependencies`; the
replacement alerts written by `onSourceVersionChanged`), exams (`setMistakeType`, `questionAttemptDTO`), questions
(`createQuestion` in tests only), annotations (`AnnotationsService.recentSessions` / `progress`), settings
(`ctx.settings.get/patch`), files (`sendStoredFile`), processing (`decodePng` / `encodePng` for the Anki export).

There is no web UI in this track: the screens (`features/review`, `features/weakness`, `features/planner`, home) are
for the web track and consume `learning-api.ts` + `learning.ts`.

## 1. Data (migration `0600_learning.sql`; no existing migration edited)
* `flashcard` + `note_id` (cards made together: one cloze text → one card per index; one image → one card per mask),
  `cloze_index`, `image_json` (`{image_asset_id, masks:[{id, box normalized on the ORIGINAL image, label}],
  active_mask_id}` — non-destructive), `conflict_of_id` (keep-both copy), `merged_into_id` (owner merge),
  `evidence_snapshot_json` (citations as they were: source title, locator, version, quote — a citation that later
  disappears is shown «unavailable», never silently dropped).
* `review_state` (cache) + `params_key`, `event_count`, `learning_steps`, `scheduled_days`, `first_review_at`.
* New: `review_reset` (owner «relearn» markers, append-only), `flashcard_impact` (AC-26 causes per card with
  `active` / `resolved_at` / `resolution`), `flashcard_duplicate_decision`, `learning_profile` (subjects, pace,
  per-part signal reset times), `revision_session`.
* `weakness` + `key` (unique group key), `kind`, `source_ids_json`, `actions_json`, `details_json`, owner fields
  (`owner_label`, `owner_note`, `excluded_refs_json`, `status_origin`, `status_changed_at`).
* `study_plan` + `timezone`, `feasibility_json`, `report_json`, `generator_version`; `plan_task` + `title_ar`, `ord`,
  `priority`, `done_at`.
* Indexes: `flashcard(source_id|note_id|updated_at)`, `review_event(reviewed_at)`, `review_reset(card_id, at)`,
  `plan_task(plan_id, status, day)`, `question_attempt(answered_at)` (`IF NOT EXISTS`, read path only).

## 2. Spaced repetition (`srs.ts`, `store.ts`, `review.ts`) — §43, AC-24
* **Algorithm**: FSRS-6 via the installed `ts-fsrs` (`FSRSVersion` = «v5.4.2 using FSRS-6.0», README + `.d.ts`
  read). Fixed params: default 21 weights, `request_retention` = owner `desired_retention`, `maximum_interval`
  36500, **fuzz off** (fuzz is random — a re-sent event must never move a due date), short-term steps `1m,10m`,
  relearning `10m`. Recorded string on every `review_state` row, e.g.
  `FSRS-6 · ts-fsrs v5.4.2 using FSRS-6.0 · w=default(21) · desired_retention=0.90 · learning_steps=1m,10m ·
  relearning_steps=10m · max_interval=36500d · fuzz=off · short_term=on · order=(reviewed_at,id)`.
* **Derived, never authored**: state = fold of `createEmptyCard(card.created_at)` over the card's `review_event`s
  sorted by `(reviewed_at, id)` (relearn markers folded as `forget(card, at, false)`, after events at the same ms).
  Duplicate ids fold once. `review_state` is a cache recomputed inside the transaction of every event insert; a row
  whose `params_key` (sha256 of the params AND the ts-fsrs version — an upgraded library recomputes) differs is
  recomputed on read; `POST /srs/rebuild` recomputes all (after
  a retention change) and touches changed cards for pull.
* **`GET /srs-config`**: params, `params_key`, algorithm, daily new limit, owner timezone, replay rules and a
  **live parity sample** (events + expected state computed by the server now) so an offline client can verify its own
  ts-fsrs fold gives the same result.
* **Days**: due times are exact epoch ms (device timezone never matters). «Due today», the daily new-card limit and
  «bury until tomorrow» use the OWNER day (`time.ts`: Intl with an explicit IANA zone; default Asia/Baghdad). A day
  starts at its first local instant — also in zones where a DST jump skips midnight (e.g. America/Santiago).
  ts-fsrs counts elapsed days between reviews by UTC calendar date — documented in `srs-config.replay.note_ar`.
* **Queue** (`GET /review/queue`): learning/relearning due now → review due (oldest first) → new cards up to
  `daily_new_cards − new cards first reviewed today (owner day)`; counts (due now / due today / new available / limit /
  introduced today / suspended / buried / needs review), next due time. «Estimated mastered» = review state with
  stability ≥ 21 days, labelled an estimate (it still comes back).
* **Review payload** (`GET /cards/:id/review`): cloze rendered per index (front hides only the asked index —
  `[…]` or `[hint]`; back reveals it emphasized + «Back Extra»), next due per rating (button previews).
  Image occlusion: an opaque HMAC token bound to the CARD (not the file id or name), 2 h, served by
  `GET /media/:token` with no file name in `Content-Disposition`; masks without labels, with positional ids (`m1`,
  `m2`, … — never the stored mask ids, which a client may name after the answer) and a neutral alt — no answer in file
  name, caption, title, alt or mask id.
* **Events** (`POST /reviews` or sync): append-only, idempotent by id; an event for an unknown or deleted card is
  **rejected with the Arabic reason** (recorded in `sync_operation`, returned to the device — never silently dropped,
  never applied); a review stamped more than 5 min in the future is kept at the server time with the original time
  in `context_json`.
* **Forgetting forecast** (`GET /forecast?days=1,7,30`): average FSRS retrievability now / at horizons and count below
  the desired retention, overall and per source, labelled «تقدير … وليس قياسًا يقينيًا»; cards never reviewed get no
  number.

## 3. Sync entities (`sync.ts`) — §3.4, §47, AC-24
Payloads match the web Dexie rows (`FlashcardRow` / `ReviewEventRow`, camelCase) and the shared DTOs (snake_case).
* `flashcard` upsert: absent → insert · `base_rev == rev` → apply · same content re-sent → `duplicate` · stale or
  missing `base_rev` with different content → **keep both** (the incoming edit becomes a new card with
  `conflict_of_id`, standalone) → `conflict_kept_both` · same content, different suspend / bury → the later change by
  device time wins (`merged`, never an older flag over a newer one) · an edit of a card deleted elsewhere → kept as a
  new card, the delete stays. For an existing card, **fields the payload does not carry keep their stored value**
  (the Dexie row has no cloze index / image / note / concept / topic / evidence fields) and unchanged references are
  kept exactly (no re-resolution to another version, a vanished citation stays in the snapshot). `delete` = tombstone;
  stale delete of an edited card → the card is kept (`conflict_kept_both`); unknown → rejected with reason.
  Devices cannot CREATE `generated` cards (generation is server-side and evidence-checked); a generated card pulled to
  a device can still be suspended / edited (its origin never changes).
* `review_event`: append (or upsert) insert-if-absent; `delete` refused («لا تُحذف المراجعات»).
* Pull serializes `FlashcardView` (DTO + review state + impacts + citation snapshot) and `ReviewEventDTO`; tombstones
  are pulled.

## 4. Cards (`cards.ts`) — §43, AC-26
* `POST /cards` basic / cloze (Anki syntax `{{c1::answer}}` / `{{c1::answer::hint}}`, one card per index, ≤ 50);
  idempotent by client `id`. Unknown evidence / source / concept / topic ids are not attached and the response says so
  (`notes_ar`).
* `POST /cards/from-selection`: source + version + quote + evidence ids, or the region (+ offsets) → an exact excerpt
  through `evidence.fromRegion`; a region / evidence of another version is refused; the back defaults to the excerpt
  as an `original_quote` run with its evidence id.
* `POST /cards/from-mistake`: from a `question_attempt`: front = stem + options with their printed labels, back =
  «الإجابة: …» + the question's explanation (claim ids kept → chips) + «اخترتَ: …»; evidence = answer evidence + the
  explanation's citations; one card per attempt (a retry returns it); an unresolved key → 409 (no card with an uncertain
  answer). `origin = from_mistake`. Provenance stays on the card (§0.3): the back says «مصدر الإجابة: …» (source key /
  owner key / «حل مولد من الأدلة (AI-derived) — ليست مفتاحًا من ملفاتك»), a generated question's front ends with
  «(مولد بواسطة MedLevo — ليس من ملفاتك)»; `origin_ref` keeps `question_origin` and `answer_status`.
* `POST /cards/occlusion`: `image_asset` with a stored file + normalized masks (validated) → one card per mask.
* Edit (`PATCH`, `base_rev` required; stale → 409 with the server copy), null unlinks a concept/topic, cloze edits
  reach every card of the note (new index → new card, removed index → tombstoned card, history kept), mask
  corrections reach the note's cards; suspend; bury (default: start of the next owner day); delete = tombstone;
  restore. Every owner mutation is audited.
* **Duplicates**: same normalized front, or ≥ 80 % token overlap inside the same source — suggestions only (also
  returned when creating). `not_duplicate` is remembered; `merge` (explicit `keep_id`) tombstones the other with
  `merged_into_id`; its review history stays under its own id and it can be restored.
* **AC-26 impacts** (`flashcard_impact`, recomputed when a cause changed — memoized by a signature of alerts, sources,
  evidence, question versions and cards): `source_changed` (the content alert item the evidence module wrote for the
  card on a replacement / correction, with its reason; resolved when the owner resolves the alert), `newer_version`
  (no alert, but the source moved on), `source_trashed`, `evidence_unavailable` (cited evidence gone or its source in
  the trash — the saved quote is shown), `question_changed` (a mistake card whose question got a new version: key /
  explanation / stem correction). `needs_review` = an active unresolved impact. Resolution (`POST
  /cards/:id/impact/resolve`): `keep`, `relearn` (a `review_reset` marker: schedule restarts, every earlier event
  kept), `move_to_current_version`; an owner edit resolves as `edited`. The review log is never touched. A cause that
  happens AGAIN after the owner resolved it (the source restored and trashed again, cited evidence unavailable again)
  flags the card again; deleting / restoring the card itself is not a new cause.

## 5. Anki-compatible export (`anki.ts`, `GET /export/anki?source_id=&deck=&include_suspended=`)
Anki's documented TEXT import with file headers — **not .apkg** (not produced, not claimed):
`#separator:tab`, `#html:true`, `#notetype:Basic|Cloze`, `#deck:<deck>`, `#tags:medlevo`,
`#columns:GUID\tFront\tBack\tSource\tTags` (Cloze: `GUID\tText\tBack Extra\tSource\tTags`), `#guid column:1`,
`#tags column:5`. One Cloze NOTE per cloze text (Anki makes one card per index; syntax identical, no spans inside the
markup); indexes whose card is not exported (deleted, suspended without `include_suspended`) become plain text so Anki
does not re-create them. The Source column is HTML-escaped like every field (`#html:true`); tags keep letters / digits /
`_` / `-` only. Fields are HTML (escaped text, `<div dir=rtl|ltr>` per paragraph, LTR runs isolated, unquoted attribute values
so no raw `"` reaches the TSV). The citation is in the Source column AND appended to the back. Only basic cards →
`medlevo-basic.txt`; cloze or images → ZIP with both files, `media/` and a README (Arabic + English: how to import,
copy `media/` into `collection.media`; skipped cards with reasons). Occlusion cards (PNG only): a question image with
every mask filled (the asked one in the accent colour) and an answer image revealing it; file names carry the card id
only. Non-PNG / interlaced images are skipped and listed. Capability `export.anki_tsv` → available.

## 6. Weakness Center, Mistake Genome, Reasoning Replay (`weakness.ts`, `mistakes.ts`) — §44, AC-27
* **Signals**: MCQ attempts (`masterySignal` → `MASTERY_WEIGHTS`; unscored answers listed but not scored; confidence
  / mistake types before a profile reset are ignored), card reviews in review state (Again = lapse −0.6, Hard 0.6,
  Good/Easy 1 — from the same fold as the schedule), graded written answers (estimated score < 50 % wrong, 50–80 %
  partial 0, ≥ 80 % 0.6; qualitative-only not scored). **Case / OSCE / viva attempts (since track F2)**: read from
  `cases/signals.ts` (`caseSignals`) — one signal per checklist item / viva point of a COMPLETED attempt, typed
  `case` | `osce` | `viva` (never folded into `mcq`); met = a hesitant correct (`MASTERY_WEIGHTS.correct_unsure`, a
  checklist estimate is never a confident recall), missed = wrong; grouped by the case itself (weakness kind `case`,
  label «حالة سريرية / OSCE / امتحان شفهي: <title>») and by the sources its evidence cites (never by a similar name);
  `reasons_ar` counts missed items; actions add `retry_case` (→ `/cases/:id`); `excluded_refs` accept
  `case|osce|viva:<id>`; the input signature includes `case_attempt`, `case_event`, `clinical_case`. Said in
  `sources_note_ar`. Merged concepts (Course Brain) are resolved to the surviving concept when grouping.
* **Groups**: concept and lecture via the question's lecture links (accepted or directly / strongly / partially
  covered) and their concepts, topic links, the card's concept / topic / source; a question with REPEATED mistakes and
  no group is its own weakness.
* **Score** (shown with its formula): Σ|wrong weights| ÷ (Σ|wrong| + Σ correct weights). Guessed / hint-assisted
  correct answers add much less than confident independent ones (AC-27). `reasons_ar`: wrong of scored, assisted
  correct, lapses, repeated mistakes, low written estimates, most frequent (estimated) mistake type, unscored count.
* **Lifecycle**: active → improving (≥ 2 good answers since the last mistake) → resolved (≥ 3 confident independent);
  the owner can dismiss / resolve / reactivate, rename, add a note, exclude signals (the attempts are untouched); an
  owner status holds until NEW mistakes arrive after it («أخطاء جديدة بعد أن جعلتها …»). Weaknesses whose signals
  disappeared are kept, resolved, with the reason — unless the owner set the status (a dismissed one stays dismissed). Recompute is memoized by a signature of every input.
* **Suggested actions**: pages to re-read (lecture-link pages of the wrong questions), cards to review (lapsed) or to
  create from mistakes, questions to retry, a simplified explanation — **AI-gated** (`ref.available` + the capability
  reason; the generation itself is the studybook explain flow, evidence-checked).
* **Dedicated revision** for repeated mistakes: `POST /weakness/:id/revision` → a one-tap session focused on its
  questions, cards and pages.
* **Mistake Genome** (`GET /mistakes/genome`): distribution of the mistake types of wrong scored answers with its
  denominator, unclassified count, owner vs auto counts, recent list with the auto reason — «تصنيف تقديري … ليس
  تشخيصًا نفسيًا». Edit: `PATCH /mistakes/:attemptId` → exams' exported `setMistakeType` (origin `owner`, the auto
  suggestion stays, the answer never changes) + audit. No direct update of `question_attempt` from this track.
* **Reasoning Replay** (`GET /reasoning/:questionId?attempt_id=`): built ONLY from the question version (explanation,
  distractor explanations keyed by option id or option key, their claims → `ClaimView`s, answer evidence → evidence
  views), the learner's choice marked; `content_source` = `question_explanation` | `evidence_only` | `none`; every
  missing part said («لا يوجد … شرح لسبب استبعاد الخيار C»); unresolved key → no option presented as better; labelled
  «… وليس سجلًا لتفكير داخلي لأي نموذج». Completing a missing part is AI-gated (`ai.needed/available/reason_ar`) and
  routed to the evidence-checked explain flow — this track does not generate medical text.

## 7. Learning profile (`profile.ts`, `GET|PATCH /profile`, `POST /profile/reset`) — §44
Self level, explanation level, dialect, Socratic default go through `ctx.settings.patch` (validated, audited); subjects
and pace in `learning_profile`. `signals` lists each part (MCQ, card reviews, written, mistake types, confidence,
pace) with what it is used for, its count and reset time; `used_signals_ar` in words; measured pace (median, ≥ 5
samples, estimate). A reset is a cut-off time — the data is kept. «تفضيلاتك … لا يغيّران الحقائق الطبية ولا مصادرها».

## 8. Planner (`planner.ts`) — §45
`StudyPlanConfig` → deterministic owner days (plan timezone stored; device and later setting changes never shift its
days). The exam date must be within 1100 days (≈ 3 years) of today — a day-by-day plan is never built for an unbounded
horizon (a typo like 2206 used to build ~66 000 days of tasks in one request). Study days = available weekdays minus blocked dates, up to the day before the exam. Learn: lectures in the
owner's order, 4 min per page (estimate), an unprocessed lecture 45 min «الحجم تقديري», split into ≥ 15-min chunks with
page ranges. MCQ where the lecture has linked questions (1.5 min / question, ≤ 20). Spaced reviews +1/+3/+7 days.
Daily flashcards (≤ ¼ of the day, sized from due + new cards × measured pace). Weakness revisions every third day. A
light closing review only with the room left. **No day exceeds the daily minutes**; what does not fit is listed in
`feasibility.unfit_ar` with the summary (never squeezed into the last day). Rebalance when behind: past flashcards are
skipped (today's review contains everything due), other unfinished tasks are re-placed from today in priority order
(learn → MCQ → review → flashcards → weakness, learning order kept, learn blocks split when needed); moved rows keep
status `moved`, new rows carry `moved_from_day`; what no longer fits is `skipped` AND reported
(`PlanRebalanceReport` + `moved_items_ar`). Task check-off (`todo|done|skipped`, audited), archive.

## 9. One-tap revision, Home, Exam DNA, progress
* **Revision** (`POST /revision {minutes, course_node_id?, source_ids?}`): due cards (weakest recall first), recent
  mistakes (latest scored answer wrong, 30 days), questions of active weak points not answered confidently and
  independently in 7 days, lecture pages behind the mistakes; per-item estimate (measured pace, else labelled
  defaults) and reason; shares then fill; **total ≤ minutes**; deterministic; stored (`GET /revision/:id`). No AI.
* **Home** (`GET /home`): Continue Studying first (annotations' recent sessions), today's tasks of the nearest active
  plan, due / new cards, exam countdown, top weakness, important questions with reasons (repeated across the owner's
  files and not yet answered independently — «مؤشر أهمية … وليس احتمال»; recent mistakes).
* **Exam DNA** (`GET /exam-dna?course_node_id=&source_ids=`): owner question sources only (`question_source`,
  `previous_exam`, active version, current occurrences); sample (files, unique, occurrences, KNOWN date range from the
  publication date only), by concept (unique + occurrences, `denominator_unique`), by item type (`denominator`), by
  lecture, unclassified counts, counting note, warnings (small < 30, one file, unknown / partial dates, newest ≥ 5 years
  old, > half unclassified, no teacher/department attribution, absent topics may still come).
  **Relevance** (`GET /exam-dna/relevance?question_id=|concept_id=`): `high` (in ≥ 2 files, or the concept in ≥ max(3,
  10 %) of unique questions), `medium` (concept in ≥ 2), `low`, `not_in_sample`; capped at medium for samples < 10;
  reasons (repeats, concept frequency with denominator, mentions in the owner's lectures/references); note «… وليس
  احتمال ظهور السؤال».
* **Progress** (`GET /progress/:sourceId`, `GET /progress?course_node_id=`): reading (annotations' pages viewed ÷
  pages), explanation coverage (Study Book sections complete ÷ sections), practice (attempts on linked / occurring
  questions + card reviews), mastery estimate (mean AC-27 weight clamped to [0,1], ≥ 3 scored answers else `null`,
  with its basis). «فتح الملف أو التمرير لا يُعد إتمامًا … ولا إتقانًا». Nothing is written to `source_progress`
  (annotations' table).

## 10. Routes (`/api/learning`, owner session + CSRF via the global guard, zod everywhere)
See the header of `routes.ts` (≈ 45 routes). Capabilities set at registration: `flashcards`, `weakness`, `planner`,
`exam_dna`, `export.anki_tsv` → `available` (deterministic; no AI needed).

## 11. Tests and verification (real results, 2026-10-10)
`apps/server/test/learning/` — 6 files, **56 tests**:
* `srs.test.ts` (12): fold identical for 25 shuffled orders; duplicate ids once; tie order; equality with an
  independent ts-fsrs fold; relearn marker keeps history; sync: same events in forward / reverse / shuffled order on two
  cards → identical state, re-sent events `duplicate`, cache = pure fold; op-id duplicate with original result; HTTP
  idempotent; unknown / deleted card → `rejected` with reason, recorded, nothing inserted, delete refused; future clock
  kept at server time; `srs-config` parity (client fold with only the returned params reproduces the sample and a real
  card); settings change → rebuild (explicit + lazy), log untouched; queue order + daily new limit per owner day.
* `time.test.ts` (7): Baghdad boundaries, calendar arithmetic, DST midnights, identical results under five process
  `TZ` values; «due today» ends at Baghdad midnight (UTC date unchanged); bury → next Baghdad day; changing the owner
  timezone moves «today» but not due times or plan days.
* `cards.test.ts` (12): basic (idempotent, rev 409 with server copy, validation), unknown refs reported, cloze
  (per-index front/back, hint, sibling edits / tombstone), occlusion (no label / caption / title / file name / file id in
  the payload, mask keys, media headers without file name, forged + expired token 403), suspend / bury / delete /
  restore with history and audit, duplicates (suggested, not-duplicate remembered, merge keeps history), sync
  (camelCase create, duplicate, rev apply, stale → keep both, flags by device time, stale delete kept, tombstone, edit
  after delete kept, pull tombstone, generated create refused, cloze index required), Dexie-shaped upsert keeps cloze
  index / note / concept / vanished citation, generated card suspend from a device, null unlinks a concept, Back Extra
  propagation, Anki export parsed back (headers, columns, GUIDs, HTML text equal, LTR span, ZIP with one cloze note,
  occlusion question/answer images checked pixel by pixel, README), HTML escaping, forecast labelled and no number for
  unreviewed cards.
* `golden.test.ts` (10, Golden Set through upload → processing → extraction → matching): weakness groups (lecture /
  concept / repeated question), AC-27 weights per signal and the exact score, reasons, actions with the AI-gated
  explanation; owner rename / exclude / dedicated revision ≤ minutes / dismiss → reactivated by a new mistake; genome
  denominator + owner edit through exams (audit, answer unchanged, correct answer refused); reasoning replay (source
  question → `none` + missing + AI-gated reason; owner question with explanations → `question_explanation`; unresolved
  key → no best option); mistake card (front/back, idempotent, unresolved key 409, key correction → `question_changed`,
  history kept, keep); progress separation; Exam DNA (2 files, 9 unique, 10 occurrences, denominators 9, warnings,
  relevance medium-capped with reasons, not a probability, owner question `not_in_sample`); revision for 5 / 12 / 45
  minutes (sum ≤ minutes, deterministic, all three kinds), planner sized by the real page count with no day over 60 min,
  Home; selection card (exact excerpt, dependency) → replacement upload → `source_changed` with alert id, history kept,
  relearn + move to the current version; cited evidence whose source is trashed → `evidence_unavailable` (saved quote
  shown), cleared after restore.
* `planner.test.ts` (7): study days, determinism + capacity + page ranges + reviews/MCQ/weakness/flashcards/exam marker,
  short time → unfit listed and no overloaded last day, rebalance core, API preview = create, rebalance after missed
  days (moved history rows, capacity, behind 0), late rebalance drops + reports, moved row 409, validation, archive.
* `profile-weakness.test.ts` (8): AC-27 mastery estimate (confident > unsure/unknown > hint > guess > solution), score
  ordering, unscored excluded; profile GET/PATCH/validation, reset hides older signals (data kept, audited),
  capabilities; **401 on all 47 routes without a session, 403 on every write without CSRF**, 404/400 without stack
  traces.

Commands (repo root, `NODE_OPTIONS='--disable-warning=ExperimentalWarning'`):

| Command | Result |
|---|---|
| `npx vitest run test/learning` (in `apps/server`) | 6 files, 56 tests passed |
| `npm test -w @medlevo/server` | 51 files, 718 tests passed (whole server, shared tree with the parallel track D1) |
| `npm test -w @medlevo/web` | 51 files, 393 tests passed (no web file changed by this track; shared contract added) |
| `npx tsc -p apps/server --noEmit` | exit 0 |
| `npx tsc -p apps/web --noEmit` | exit 0 |
| `npm run build -w @medlevo/web` | exit 0 |

An earlier full server run during this track had 1 failure outside this track (`test/ai.test.ts` expected capability
`backup` = `not_implemented` while the parallel data track had just made it available); the final run above is green.
Rough timing probe (3 000 cards × 4 reviews, in-process): first queue 0.8 s (cache fill), then ~0.2 s; home 0.1–0.4 s;
create card with duplicate check 0.1 s.

## 12. Independent review (code-review skill, medium, on this track's paths) — fixed
| Finding | Fix + regression test |
|---|---|
| Sync upserts missing `cloze_index` / `image` (Dexie rows have neither) were rejected for multi-cloze / occlusion cards | absent fields keep the stored values; `cards.test.ts` Dexie-shaped upsert |
| A rev-matched upsert nulled absent fields, re-resolved the source version and dropped vanished citations (then auto-resolved AC-26 impacts) | absent / unchanged references kept exactly; same test (snapshot `GONE1` kept, unavailable) |
| `concept_id: null` could not unlink | explicit null unlinks; `cards.test.ts` |
| Stale flag-only upsert overwrote a newer suspend/bury | later device time wins, older is not applied; sync test |
| Cloze «Back Extra» edits did not reach siblings | front or back edits sync the note; `cards.test.ts` |
| Device suspend of a pulled generated card was rejected | `generated` refused only on create; Dexie test |
| Impacts / weaknesses recomputed for everything on every read | signature-memoized recompute; batched relearn / evidence lookups for lists |
| Duplicate check on create compared all pairs | only pairs involving the new cards |
| Lapse detection duplicated the fold | `foldReviews(…, onEvent)` shared by schedule and weakness |

## 13. Not done / limits (honest)
* ~~**No web screens** in this track.~~ Built in track L2 (`features/review`, `features/weakness`,
  `features/planner`, home): the local card model carries `noteId` / `clozeIndex` / `image` / `conceptId`, offline
  schedules use `GET /srs-config` and fold `schedule_resets` like the server (`features/review/local/`).
  *(reconciled, track F5)*
* **No AI generation** in this track: no generated cards, the reasoning-replay completion and the simplified
  explanation are AI-gated pointers to the evidence-checked explain flow (studybook). Nothing here produces medical text.
* Case / OSCE / viva attempts are collected by the Weakness Center since track F2 (see §6). The Student Knowledge Map
  and the prerequisite graph (§44) live in the `brain` module (`docs/modules/course-brain.md`), not here. A case
  attempt has no per-part reset yet (profile resets apply to MCQ confidence / mistake types only).
* Image occlusion export draws masks only on non-interlaced PNG images (others are skipped and listed); native Anki
  Image Occlusion notes are not produced; media must be copied into `collection.media` by hand (Anki's text import
  does not copy media) — the README says so. Anki notetype names may be localized in the owner's Anki; the README says
  to pick Basic / Cloze in the import dialog. The export was verified by parsing the files back, **not by importing into
  a real Anki** (not available here).
* ts-fsrs counts elapsed days by UTC calendar date; the owner day is used only for «today» / limits / bury.
* Duplicate detection is lexical (same normalized front, or ≥ 80 % token overlap within a source) — a heuristic.
* Exam DNA classification depends on lecture links / concept candidates from the questions track; dates come only from
  `source.publication_date` (never parsed from titles).
* Planner minute estimates are fixed heuristics (labelled); flashcards per day come from the current due load; plans
  are not edited in place (archive + new plan); weakness tasks reference weaknesses that may later resolve.
* Mastery estimate uses MCQ answers only (card retrievability is the separate forecast).
* `export.anki_tsv` is declared available by this module; the data module (D1) only reads it.
* Not run: a real Anki import, real devices, load beyond the in-process probe above.

## 14. Independent review (adversarial, after the build) — 2026-10-10
Read every file of this track, then probed with throw-away scripts / tests (randomized planner invariants over 400
configurations incl. rebalance; owner-day starts for all 418 IANA zones × 730 days; Anki export parsed with a strict CSV
reader; sync payload edge cases; source purge with learning rows). Confirmed and fixed (regression tests in
`test/learning/review-fixes.test.ts`):

| Severity | Finding | Fix |
|---|---|---|
| major | A card from a mistake presented a **generated question** and an **AI-derived key** exactly like a question / key from the owner's files («الإجابة: …», also in the Anki export) — §0.3 | front of a generated question ends «(مولد بواسطة MedLevo — ليس من ملفاتك)»; back adds «مصدر الإجابة: <key status>» (AI-derived: «— ليست مفتاحًا من ملفاتك»); `origin_ref` keeps `question_origin` / `answer_status` |
| major | Planner accepted any exam date: one request with `2126-…` built ~36 500 days (6.5 MB preview; `POST /plans` inserts every task row), `9999-…` would block the single-process server | exam date ≤ 1100 days ahead, 400 with an Arabic reason |
| minor | Occlusion review payload exposed the stored mask ids, which a client may name after the answer (`id: 'Caecum'`) | positional ids `m1…` |
| minor | A weakness the owner **dismissed** was silently turned into `resolved` (auto) when its signals disappeared | owner-set statuses are kept |
| minor | AC-26: an impact the owner resolved (`keep`) was never raised again for the same cause (source restored, then trashed again) | a cause that happens after the resolution flags the card again (`occurred_at`); card delete/restore is not a new cause |
| minor | `dayStartMs` returned an instant of the PREVIOUS day on days where DST skips midnight (America/Santiago, America/Havana…) | first local instant of the day (binary search when midnight does not exist); verified for all zones × 2 years |
| minor | `params_key` covered the params only — an upgraded ts-fsrs with the same params would reuse stale cached schedules | key = params + library version |
| minor | Sync `review_event`: a payload `id` different from the op's entity id was accepted silently; `flashcard` accepted a negative `buried_until` | both rejected with an Arabic reason |
| minor | Anki export: the Source column was not HTML-escaped although the file is `#html:true`; tags carried markup characters from titles; a cloze note re-created deleted / suspended siblings (their `{{cN::}}` stayed in the note) | escaped Source, sanitized tags, non-exported indexes exported as plain text |
| minor | A new cloze index added to a `generated` note was relabelled `owner` («كتبتها بنفسك») | keeps the note's origin |
| minor | Weakness reason called weight-0 correct answers (after viewing the solution, partial written) «بتردد أو بالتخمين أو بعد تلميح» | wording covers them; the profile now says card-review resets never change schedules / the forecast |

**Purge × learning rows — FIXED (integration round):** `flashcard_impact` and `review_reset` rows of purged cards are
now deleted by the sources purge (`modules/sources/purge.ts`: both FKs listed in `HANDLED_FKS`, rows deleted before
`DELETE FROM flashcard`). The former `it.fails` marker in `review-fixes.test.ts` is now a normal regression test.

Also noted, not changed: an index on exams' `question_attempt(answered_at)` is created by this module's migration (read
path only); a review stamped > 5 min in the future is stored at the server arrival time (documented — arrival-TIME
dependent, not order dependent); events for a deleted card are rejected as the contract requires (the device keeps
them and can re-send after a restore — the web retry uses a new op id); the occlusion image itself is the original
(masks are drawn by the client, as in Anki); no web UI exists in this track, so there was no RTL / a11y surface to review.

Commands (repo root unless noted, `NODE_OPTIONS='--disable-warning=ExperimentalWarning'`), real results after the fixes:

| Command | Result |
|---|---|
| `npx vitest run test/learning` (in `apps/server`) | 7 files, 67 passed (the former purge-blocker marker now passes) |
| `npm test -w @medlevo/server` | 52 files, 733 passed + 1 expected fail |
| `npm test -w @medlevo/web` | 51 files, 395 passed |
| `npx tsc -p apps/server --noEmit` / `npx tsc -p apps/web --noEmit` | exit 0 / exit 0 |
| `npm run build -w @medlevo/web` | exit 0 |


## 15. Acceptance round G7 — AC-24 (2026-10-10)
* `flashcard` sync (`sync.ts`): a stale card edit re-sent under a new op id no longer creates a second identical
  conflict copy (`existingConflictCopy`; a copy's `note_id` is not compared because a copy stands alone). Test:
  `apps/server/test/acceptance/g7-ac24.test.ts` («concurrent card edits …»). Review events sent twice (same op id, a
  new op id, and the REST `POST /reviews`) stay one event — verified there and in `e2e/g7-ac24-two-devices.spec.ts`
  (push answer lost after the server applied it → re-sent → `duplicate`, reps = 1).


## G8 acceptance fixes (AC-26, AC-27, 2026-10-10)
* **Re-classifying after a reset** (`mistakes.ts classificationVisible`, used by the genome and the weakness signals):
  after «reset the mistake types» an owner who classified an OLDER mistake again saw the edit accepted but ignored
  (hidden by the cut-off). A type the owner sets after the reset now counts (`mistake_origin = 'owner'`,
  `updated_at ≥ reset`).
* **Option corrections reach cards from mistakes** (`store.ts questionChange`): the card's front lists the options and its
  back names the answer by its text, but only key / explanation / stem changes flagged it (`question_changed`). An
  option-only correction now does too. Alerts about a corrected question (key / text) are not turned into a second
  `source_changed` impact for the same card.
* Tests: `apps/server/test/acceptance/g8-ac27.test.ts`, `g8-ac26.test.ts`; `e2e/g8-ac27-mastery.spec.ts`.
