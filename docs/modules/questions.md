# My Question Vault (track C3)

Scope: `apps/server/src/modules/questions/**`, migration `0500_questions.sql`, `apps/server/test/questions/**`,
`apps/web/src/features/questions/**`, `apps/web/src/features/workspace/panels/QuestionsTab.tsx`, the new shared
contract `packages/shared/src/questions-api.ts` (+ one export line in `packages/shared/src/index.ts`) and ONE
guarded hook in `apps/server/src/modules/processing/pipeline.ts`.
Spec: §16 (concept candidates, minimal), §33, §34, §35, §36, §48 (question review items); AC-10 … AC-17, AC-26.

Everything here is deterministic. There is no AI path in this module: no AI-derived answers, no semantic matching,
no vision on figures (see «Not done»). The `questions.*` capabilities are reported `available` because the
deterministic features they name are implemented. Exam/practice belongs to the exams track (`exams` capability).

## Flow

```
upload (sources) → process_source_version (processing)
   └─ hook: question_source / previous_exam → extract_questions {version_id}
            lecture                       → match_questions  {version_id}
extract_questions: parse regions → questions, occurrences, keys, validation, review items, FTS
   → near-duplicate suggestions for new questions → match_questions {version_id} (the source vs its course's lectures)
match_questions: {version_id} of a lecture (all question sources of its course) or of a question source,
                 or {question_ids} (quick add / owner edits)
```

* **Hook** (`pipeline.ts`, `enqueueQuestionFollowUp`): runs after the processing run's final status is written,
  unless the status is `failed`. Guarded by `ctx.jobs.isRegistered(kind)` (nothing happens when the questions
  module is absent, tested), wrapped in try/catch (a failure here never fails processing), idempotency key
  `<kind>:<version_id>:<process job id>`, `parentJobId` = the processing job.
* **Jobs** (`index.ts`): `extract_questions` (version `qparse-v1`, 2 attempts, 10 min, concurrency 1, strict zod
  input, checkpoint `extract`), `match_questions` (version `qmatch-v1`, `version_id` XOR `question_ids`).
* `POST /api/questions/extract {version_id}` and `POST /api/questions/match {version_id | question_ids}` enqueue
  the same jobs manually (`JobStartedResponse`).

## Data model (migration `0500_questions.sql`)

The base tables (`question`, `question_version`, `question_option`, `question_occurrence`, `answer_key_entry`,
`question_lecture_link`, `question_duplicate`, `question_fts`, `concept*`) come from the foundation schema. 0500:

* **`answer_key_entry` rebuilt** (table copy, no data loss on an empty/early DB): adds `key_block`, `binding`
  (`bound` / `ambiguous_section` / `no_matching_question` / `unofficial`), `section_title`, `raw_text`;
  `UNIQUE(source_version_id, section_key, printed_number, mark_kind, key_block)`.
* `question_occurrence` + `item_key` (`<printed number>` or `u<n>` for unnumbered items), `section_title`,
  `option_labels_json`, `raw_text`, `boxes_json` (per-page normalized boxes), `content_hash`, `ord`,
  `status` (`current` / `not_found`), `parse_json`; **UNIQUE (source_version_id, section_key, item_key)** — the
  identity used by idempotent re-extraction.
* `question_version` + `fingerprint` (sha256 of the normalized stem + sorted normalized options), `note`.
* `question` + `retired_reason`; `question_lecture_link` + `lecture_version_id`, `matcher_version`;
  `question_duplicate` + `decision_reason`, `decided_at`.
* New `question_extraction` (one row per question-source version: status `completed` / `needs_review` /
  `nothing_found`, `summary_json`, `job_id`, `parser_version`) — FK CASCADE to version and source.
* Indexes on tables owned by others, needed by this module's queries: `concept_mention(region_id)`,
  `concept_mention(version_id)`, `review_queue_item(entity_type, entity_id)` (all `IF NOT EXISTS`).
* **Trigger `question_region_refs_bd`** (BEFORE DELETE ON `source_region`): nulls `question_option.region_id` /
  `answer_key_entry.region_id` and deletes `candidate*` concept mentions of that region. Without it, page
  re-processing (which replaces a page's regions) would be blocked by FKs from question rows. Occurrences keep
  their own `boxes_json` + `page_ids`, so the original location survives a re-processing.

## Extraction (`parser.ts`, `regions.ts`, `extract.ts`)

Input: the version's processed regions in reading order (`regions.ts` drops header/footer and child regions,
keeps table rows/cells). Uploaded text is untrusted data: it is only parsed, never interpreted as instructions.

* **Numbering**: `1.` `1)` `1-` `(1)` `Q1` `Q.1` `Question 1`, `سؤال 1` / `السؤال رقم 1`, Arabic-Indic digits
  (`١.`), unnumbered items (`u<n>`). A number right after the delimiter is a value, not numbering («3.5 mmol»,
  «10 - 15 mg/kg»), except an age opening («3. 60-year-old woman …», «12- 45 years old …») and the numeric-option
  form «1- 25 mg» (review fix R4). **Options**: `A.` `A)` `A]` `A:` `a)` `(a)` `(a `, Arabic `أ.` `ب)` `ج-` `د:`
  (أ ب ج د ه/هـ و; bare ا accepted as أ), and numeric options (`1)` under a `1.` stem — told apart by a different
  numbering style than the stems).
* **Sections**: headers (`Section A`, `Part 2`, `Unit II`, `Paper`, `Block`, `القسم الأول`, `الجزء الثاني`,
  `المجموعة ب`; Arabic ordinals up to «السادس») or a numbering reset to 1. An empty implicit section is replaced
  by the first real header.
* **Continuation across pages**: a question (stem or options) continuing on the next page stays one question with
  `page_ids` of both pages and one box per page (AC-10).
* **Option continuation** (review fix R3): a line after the last option is joined to it only when it cannot stand
  alone (lower-case / bracket / comma start, or the option stops mid-phrase «… 3.5 to» — also across a page break)
  or when it is a short line of the same region. Any other line is NOT glued into the option: the question gets an
  `options_complete` warning quoting it, and the next question reports the unattached text (`stem_complete`
  warning; a **blocker** when it reads like a shared case introduction «The following case relates to questions
  2–3» / «الحالة التالية»). An option paragraph that swallowed such an introduction is a blocker.
* **Answer keys**: key headings (`Answer key(s)`, `Answers`, `Correct answers`, `Answer sheet`, `Model answers`,
  `Key`, `مفتاح الإجابة` / `الإجابات`, `الأجوبة`, `الحلول`, `مفتاح`); per-section key
  lines (`Section A: 1-B 2-C …`), runs (`1B 2C 3A`), whole-line pairs (`1. B`), key tables (header Q/Answer columns
  or header-less two-column tables), inline keys (`Answer: B`, «الإجابة: ب»). A number repeated inside one key
  block starts a new block (two adjacent printed tables are two blocks, never a silent overwrite). Blocks are
  numbered 1..n per version.
* **Marks**: a circled option / handwritten mark recognized on a photo (`circled_option`, `handwritten`) is an
  `unofficial` key entry (`key_block 0`), never an official key (AC-13) → review item `unofficial_mark`. G3: the
  Arabic twin of «(A …» — «(ب. …», an opening bracket not closed by «)» — is recorded as a circled mark too.
* **Binding** (`keys.ts`): by **(version, section_key, printed_number)**, never by number alone (AC-12). A key
  block with section labels binds to those sections — unless the label was printed for more than one section
  («Part A» of two papers → `ambiguous_section`, review fix R5); an unlabeled block binds only when the file has one section
  or the block sits right after a single section; otherwise `ambiguous_section` → review item, the questions stay
  `missing_key`. Option labels are mapped across scripts (A ↔ أ) with a note.
* **Answer status** per question (`resolveAnswer`): one official key value → `source_key`; none → `missing_key`
  (AC-14, kept as a source question, unscored practice only); different official values → `conflicting_key`
  with an Arabic explanation listing each block's value; both entries kept, original untouched (AC-15).
  An owner key (`owner_key`) is never replaced by extraction.

## Validation (`validate.ts`, `lifecycle.ts`)

Per question version (`QuestionValidation.issues[]`, each with `check`, `severity`, `reason_ar`):

| check | blocks auto-approval when |
|---|---|
| stem complete | stem missing / looks truncated (shorter than 8 characters, ends on a dangling word such as «the» / «of», or on `,` `،` `-` `(`) → `truncated_question` |
| options ≥ 2 | fewer than two options for an MCQ → `missing_option` |
| sequential labels | a gap or out-of-order labels (A, B, D) → `missing_option` |
| merged questions | a second numbered stem inside one question |
| negation preserved | NOT / EXCEPT / LEAST / FALSE / INCORRECT / UNTRUE / NEVER / ليس / عدا / باستثناء / خطأ … in the raw text missing from the structured stem (and always flagged + emphasized in the UI, AC-11) |
| numbers & units | the multiset of number/unit tokens (`11.5`, `×10⁹/L`, `mmol/L`, `%`, ranges, separators) differs from the raw text (AC-11) |
| images | the stem names or points at a picture («image», «figure», «this ECG», «shown below», «الصورة») but no figure region is attached (blocker; a bare «below» / «shown» no longer triggers it — review fix) |
| key status | `conflicting_key` blocks; `missing_key` is a warning; a source key read by OCR with low confidence (or a key region processing marked uncertain) blocks until the owner reviews the field `key` (review fix R7) |
| version in force (`scope`) | a source question no longer contained in the version in force of its replaced question source blocks scoring until the owner reviews it (review fix R6) |

Blocking issues keep the question in `needs_review` (`question_validation_failed` / specific kinds above) and
make it non-scorable. Fields listed in `owner_reviewed_fields` downgrade the related blocker to a warning (the
owner looked at it). Low OCR confidence of the occurrence's regions adds a `question_validation_failed` reason.

## Persistence, idempotency and owner corrections

* Re-running extraction (manual or after re-processing a page) matches occurrences by
  `(source_version_id, section_key, item_key)`; unchanged items touch nothing; changed text on a question the owner
  never touched → new `raw_extraction` version; **a question the owner corrected or reviewed is never overwritten**
  (review item `question_validation_failed` code `extraction_changed` with the new raw text instead); occurrences
  that vanished → `status='not_found'` (never deleted). Review items are synced by `(code, signature)`: a resolved
  item with the same signature is not re-opened, stale open items are removed.
* **Exact duplicates** (same fingerprint, any version of any question) attach as another occurrence of the existing
  question (AC-17: one question, many occurrences). The fingerprint keeps comparison signs and arrows
  (`< > ≤ ≥ ± ↑ ↓ =`), so «Na < 120» and «Na > 120» are never merged (review fix R1); a question that depends on
  a picture (figure attached, or the stem names / points at an image) is never merged automatically — it can only
  be a duplicate suggestion with the blocker «يعتمد على صورة» (review fix R2).
* **Replaced question source** (§18, review fix R6): the occurrences of the source version *in force*
  (`frozen_version_id ?? current_version_id`, once that version was extracted with ≥ 1 question) are the only ones
  whose keys vote. A key corrected in the new version is therefore a key change (new version + `key_corrected`
  alert with the impact when the old version was attempted), not a «conflicting key»; the previous printing is
  reported in `key_details.notes_ar`. Questions the version in force no longer contains are kept with their
  occurrences and attempts, flagged (`scope` blocker + review item) and not scored until the owner reviews them.
  Changing Source Freeze afterwards is picked up at the next extraction / refresh of those questions.
* `PATCH /api/questions/:id` → new `owner_correction` version (`created_by='owner'`), previous versions untouched.
* `POST /:id/key` (owner key or clearing it) → new version; if the current version is locked (attempted or placed
  in an exam: `isVersionLocked`) the change is ALWAYS a new version, attempts stay on their version, the response
  reports the impact (`KeyChangeImpact`: attempts on the old version whose result would differ) and a
  `content_alert` (`kind='key_corrected'`, `severity='answer_change'`) + `content_alert_item` per affected attempt
  is written. **No silent re-grading** (AC-26).
* `POST /:id/review {decision: accept|reject, reviewed_fields, acknowledge_blockers}`: accept with open blockers →
  409 `CONFLICT` with `details.blockers` unless `acknowledge_blockers`; reject → question `retired` (kept, with
  `retired_reason`), never deleted.
* `question_fts` holds the normalized (`normalizeForSearch`) stem + options of the current version.
* Dependencies: `recordDependencies(ctx, 'question_version', …)` (evidence module service) records the source
  versions/regions each version depends on, so source replacement alerts reach questions.

## Duplicates (`duplicates.ts`)

Prefilter with FTS on the stem, then token Jaccard: **near** (stem ≥ 0.7 and combined ≥ 0.6) or **paraphrase**
(options ≥ 0.75, stem ≥ 0.35) → `question_duplicate` suggestion + review item `duplicate_suggestion` with blockers
(different key / numbers / negation shown). The owner confirms or rejects (`POST /duplicates/:id/decision`);
decisions are never overridden by later detection. Confirmed duplicates share a `duplicate_group` in the exam
service.

## Concept candidates (§16, minimal — `concepts.ts`)

From a processed lecture's headings (split on «—»), table first columns / merged headers, captions, capitalized
term sequences and abbreviations (generic heading words EN + AR filtered): `concept` rows origin `auto`,
status `suggested`, kind `candidate`, `concept_mention` role `candidate_*` with the region. Listed with
`GET /concepts?source_id=`, accepted/renamed/rejected with `PATCH /concepts/:id`. Used by the matcher as topical
terms.

Since track F2 (`brain` module, `docs/modules/course-brain.md`): a candidate name is looked up with
`findConceptByName` from `brain/resolve.ts`, which follows `merged_into_id` and owner aliases (a concept the owner
renamed or merged is reused, never re-created); the matcher's lecture concepts read only `candidate*` mentions of
non-merged concepts, so the brain's `stated` mentions do not change matching (matching stays deterministic). Each
lecture concept is offered to the matcher once per NAME (English, Arabic, names absorbed in a merge — review F2): when
the brain joins the two candidates of a bilingual heading, Arabic question text still hits the concept by its Arabic
name (the Golden Set links are identical with and without the brain module). Concept correction (merge, relations,
rename with alias) is in the brain module; `PATCH /concepts/:id` here is unchanged.

## Lecture ↔ question matching (`match.ts`, AC-16)

Scope: lectures and question sources of the same course (`course_node_id`, else subject, else parent node), plus
explicit `source_link` `question_source_for`. Never across courses (tested). Works whichever arrives first.

* For each question: content tokens of the stem/options/answer, generic words removed, FTS over
  `document_chunk` **restricted to the lecture's current version** in the same SQL (`c.version_id = ?`), concept
  candidates of the lecture as topical terms, pages located from the chunk regions (max 3 pages cited).
* Relations: `directly_covered` (the correct answer — or for NOT/EXCEPT ≥ 2 distractors — is found co-located
  with the topic; `answerable_from_lecture=1`), `strongly_related` (≥ 2 topical terms), `partially_covered`
  (≥ 1), `course_related_only` (generic / options only). Each link stores an Arabic reason with the lecture
  pages («الإجابة الصحيحة … مذكورة في ص 3 مع …»), `reason_json` (terms, pages), `lecture_version_id`,
  `matcher_version`.
* `strongly_related` / `partially_covered` → review item `uncertain_lecture_link`. Owner decisions
  (`POST /links/:id/decision`, `POST /:id/links` for an owner link) persist and are never overridden by re-matching.

## Quick add (`quickadd.ts`)

* **Image / screenshot** (`POST /quick-add`, multipart): stored through the sources module's `registerUpload` as a
  `question_source` (title default «سؤال مضاف سريعًا»), then the normal processing (OCR) → extraction path.
  A circle on the photo is an unofficial mark (tested through the UI in the real-server check).
* **Text** (`POST /quick-add`, JSON `QuickAddTextRequest`): one owner question; a key typed by the owner (or an
  inline «Answer: B») is an `owner_key`, never a source key; optional lecture → owner link; matching enqueued.

## HTTP API (`/api/questions`, owner session + CSRF on mutations)

| Route | Purpose |
|---|---|
| `GET /` | list: `source_id`, `course_node_id`, `lecture_source_id`, `answer_status`, `extraction_status`, `status`, `origin_type`, `qtype`, `has_negation`, `needs_review`, `q` (normalized FTS), offset cursor; ordered by creation, then occurrence order |
| `GET /:id` | `QuestionDetailResponse`: current version, versions, occurrences with `origin_label_ar` «سؤال من مصدر الأسئلة — <المصدر> — ص <x> — رقم السؤال <n>» (the section is appended in parentheses when the file has sections), key entries, links, duplicates, review items, `attempts_by_version`, `occurrence_boxes`, `scorable` / `unscorable_reason_ar` |
| `GET /:id/original` | pages + boxes of the occurrence(s) for the side-by-side review |
| `GET /:id/duplicates` | duplicate suggestions/decisions |
| `GET /for-lecture/:sourceId?page_id=` | lecture's questions grouped (this page / other pages / course-only), matching state `done` / `pending` / `not_processed` / `no_question_sources` |
| `PATCH /:id` | owner correction → new version |
| `POST /:id/key` | owner key / clear → new version + impact + alert |
| `POST /:id/review` | accept / reject (409 with blockers unless acknowledged) |
| `POST /:id/links` | owner link to a lecture |
| `POST /links/:linkId/decision` | accept / reject a suggested link (with reason) |
| `POST /duplicates/:dupId/decision` | confirm / reject a duplicate suggestion |
| `GET /review-queue`, `POST /review-queue/:itemId/resolve` | question review items (`origin='questions'`) |
| `GET /extractions/:versionId` | extraction summary of a question source version |
| `POST /extract`, `POST /match` | enqueue the jobs |
| `POST /quick-add` | image (multipart) or text (JSON) |
| `GET /concepts`, `PATCH /concepts/:id` | concept candidates |

Errors are `AppError` with Arabic messages; validation errors list Arabic per-field messages (tested).

## Service for the exams track (`apps/server/src/modules/questions/service.ts`)

```ts
import { createQuestion, createVersion, listForExam, dedupeCandidates, getQuestion, scorability,
         isVersionLocked, getVersionRow, practiceUrl } from '../questions/service';
```

* `createQuestion(ctx, CreateQuestionInput)` — origin `generated` (label «سؤال مولد بواسطة MedLevo من المصادر
  المحددة», answer `ai_derived` / `unresolved`; a `source_key` is refused) or `owner`. Optional lecture link,
  translation/paraphrase of an existing version (`derivedFromVersionId`). Validated, FTS-indexed,
  near-duplicates detected.
* `createVersion(ctx, questionId, CreateVersionInput)` — always appends; re-validates; becomes current.
* `listForExam(ctx, ExamCandidateFilter)` → `ExamCandidate[]` with `scorable` + Arabic `unscorable_reason_ar`
  (scorable = `source_key` / `owner_key` / `ai_derived` with correct options and no blocking check) and
  `duplicate_group` (confirmed duplicates share it; exact duplicates are already one question).
  Filters: sources, courses, question ids, `lectureOnlyAnswerable` («من محاضرتي فقط»), lecture links, types,
  origins, `onlyScorable`. `dedupeCandidates` keeps one item per group.
* Before grading against a version, call `isVersionLocked` / record attempts on `question_version_id`; never
  rewrite an attempted version — use `createVersion`.
* The web «تدرّب» button links to `practiceUrl(sourceId, questionId)` = `/practice?source_id=&question_id=`
  when the `exams` capability is available; until then it is disabled with the capability's reason.

## Web (`apps/web/src/features/questions/**`)

* `/questions` — vault list: filters in the URL (source, course, statuses, type, origin, negation, search), a
  collapsible filter panel on phones, separate pills for key status and extraction status (text, never colour
  alone), origin icon + label, negation pill, offset paging.
* `/questions/:id` — detail: stem with NOT/EXCEPT emphasized, options with the answer marked by who stands behind it
  (source key / your key / unresolved / conflicting), occurrences (origin label + «افتح في المصدر» to the page and
  region), key entries per block, lecture links with reasons and accept/reject, duplicates, checks, versions
  (with attempt counts), review items, key dialog (native radios/checkboxes, impact shown before saving).
* `/questions/:id/review` — side by side: the original page rendered (pdf.js canvas, `dir="ltr"`; images) with the
  region highlighted ‖ an editable form; accept as is / save as new version / reject (confirm dialog);
  reviewed fields; 409 blockers listed with an explicit acknowledgement checkbox.
* `/questions/review` — review queue with specific reasons; `/questions/add` — quick add (image or text).
* Workspace `QuestionsTab` — the lecture's questions: this page first, other pages, course-only links collapsed;
  jump to the original source location; reason details with lecture page buttons; accept/reject a link;
  «تدرّب» disabled with the shared reason (shown once); honest empty states (no question source in the course,
  lecture not processed, matching pending).
* Mixed Arabic/Latin text uses `MixedText` (isolates LTR runs; «ص 1–2» renders correctly).
* Accessibility: labelled controls, `aria-describedby` for disabled reasons, focus return after dialogs, 44 px
  targets on coarse pointers, 390 px → desktop without horizontal scroll (self-audit with the
  accessibility-review checklist; no screen-reader run).

## Tests and verification (real results, 2026-10-09)

Server (`apps/server/test/questions/`, through the real upload → processing → hook → extraction pipeline on the
Golden Set: `questions_surgery_course1.pdf`, `questions_previous_exam_2024.pdf`, `question_photo_circled.png`,
`lecture_appendicitis.pdf`, `lecture_cholecystitis.pdf`, plus local fixtures `conflicting_keys.pdf` and
`ambiguous_keys.pdf` generated by `fixtures/make_fixtures.py`):

* `parser.test.ts` (27): numbering styles, Arabic options, numeric options, sections, continuation, key
  lines/runs/tables/inline, adjacent tables, unofficial marks, merged questions, negation and number checks.
* `golden.test.ts` (22): AC-10, AC-11 (×2), AC-12 (×2), AC-13, AC-14, AC-15, AC-16 (lecture after sources),
  AC-17, page-first ordering, course scoping, link decisions persist, concept rejection, idempotent re-extraction
  (manual + page re-processing), owner corrections not overwritten, AC-26 (attempt + key correction → impact +
  alert, no re-grading), review accept 409 / acknowledge / reject retires, quick add text (owner key), filters +
  normalized search, auth (401 / CSRF 403 / 404).
* `service.test.ts` (7): generated labels, `createVersion` appends, `listForExam` duplicate groups, owner link,
  review-queue resolve once, Arabic validation errors, processing hook guard without the questions module.

Web: `model.test.ts` (5), `questions.test.tsx` (4: workspace tab, empty state, detail negation/answer origin,
review blockers). `real-server-check.mjs` (real server + built web app, Chromium at 390×844 and 1280×800, light
and dark): vault, detail, review with the rendered original, review queue, workspace tab, quick add of the circled
photo through the UI, key dialog keyboard/Escape, phone filter toggle, touch targets, no horizontal overflow, no
console errors.

### Final verification (repo root, `NODE_OPTIONS='--disable-warning=ExperimentalWarning'`)

| Command | Result |
|---|---|
| `npm test -w @medlevo/server` | 29 files, 440 tests passed (whole server, shared tree with the parallel track) |
| `npx vitest run test/questions` (in `apps/server`) | 3 files, 56 tests passed |
| `npm test -w @medlevo/web` | 37 files, 311 tests passed |
| `npx vitest run src/features/questions` (in `apps/web`) | 2 files, 9 tests passed |
| `npx tsc -p apps/server --noEmit` | exit 0 |
| `npx tsc -p apps/web --noEmit` | exit 0 |
| `npm run build -w @medlevo/web` | exit 0 |
| `node apps/web/src/features/questions/real-server-check.mjs` | 72 checks PASS, «OK: real-server Question Vault check passed.» |

## Not done

* ~~AI-derived answers and `answer_evidence`~~ — added by the G4 acceptance round as the **answer check** (see «G4» below);
  without an AI provider it is `requires_configuration` and questions without a key stay `missing_key`, unscored.
* Semantic / embedding matching and AI explanation of links (deterministic lexical matching only).
* Answer keys in a separate file (keys are bound within the same version only); manual binding of an unbound
  key entry to a question (the owner sets an owner key instead).
* Splitting / merging occurrences from the UI (merged questions are flagged, not split interactively).
* Question Coverage Map / Exam DNA here (the Coverage Map is in the brain module since F2; Exam DNA in learning).
* Course Brain concept relations here (built in the brain module since F2; this module writes candidates only).
* Vision on figures (figures are attached as regions; their content is not read).
* Screen-reader and real-device testing.

## Limits and decisions

* The parser is rule-based (`qparse-v1`): unusual layouts (two-column question sheets mixed with keys, options on
  one line without separators, keys as images) can yield truncated/merged items — they are flagged for review,
  never silently approved.
* OCR quality bounds what photos give; low-confidence regions add a review reason.
* Matching precision is lexical; `strongly_related` / `partially_covered` links always go through review.
* `content_alert` + `content_alert_item` for `key_corrected` are written directly by this module
  (`lifecycle.ts`, with a comment explaining why); move to an evidence-module helper if one is added for key corrections.
* This module writes `concept` / `concept_mention` (candidates only) and `review_queue_item` rows with
  `details_json.origin='questions'`; added indexes on `concept_mention` / `review_queue_item` and the
  `source_region` trigger described above.
* Re-processing a lecture re-runs matching; re-processing a question source re-runs extraction (idempotent).

## Independent review (2026-10-09)

An adversarial review of this track read every server/web file of the module, ran probes through the real
pipeline (reportlab-generated PDFs → upload → processing → hook → extraction) and fixed what it confirmed. Every
fix has a regression test in `apps/server/test/questions/review-fixes.test.ts` (13 tests; fixtures
`lookalike_x.pdf`, `lookalike_y.pdf`, `replace_v1.pdf`, `replace_v2.pdf` added to `fixtures/make_fixtures.py`).

| # | Finding (confirmed) | Severity | Fix |
|---|---|---|---|
| R1 | The exact-duplicate fingerprint dropped `<` / `>` / `≤` / `≥` / arrows: «sodium < 120» and «sodium > 120» from two files became ONE question with two occurrences | major | `normPhrase` keeps comparison signs and arrows |
| R2 | Picture questions with the same words («Which structure is shown in the image below?») from two files were merged as one question | major | no automatic exact merge for questions that depend on an image; duplicate suggestion with an image blocker |
| R3 | Any short line after the last option was glued into it silently («D. PET scan The following case relates to questions 2 and 3»), status `checks_passed`, scorable; the AC-11 check could not see it (its raw reference is built from the same lines) | major | strict continuation rule; unattached text reported on both neighbours; shared-case text and options that swallowed it are blockers |
| R4 | «3. 60-year-old woman …» was not a question start (glued into the previous question); «10 - 15 mg/kg …» on a stem line WAS one (split the question) | major | age openings accepted, value ranges/decimals rejected; `rawContent` now strips labels with the parser's own rules (no false numbers blocker) |
| R5 | A key labelled with a section label printed for two sections («Part A» of two papers) was bound to the first one; two ambiguous labels in one key block overwrote each other | minor | ambiguous → `ambiguous_section`, printed label kept in the entry identity; review reason no longer tells the owner to «bind manually» (no such UI) |
| R6 | Replacing a question source (new version): old-version keys voted against the corrected key (false `conflicting_key`), and questions the new version no longer contains stayed `ready` and scorable with the old key | major | keys of the version in force only; superseded-only questions flagged + not scored (kept, never deleted); AC-26 alert on attempted versions |
| R7 | A printed key read by OCR with low confidence became a trusted, scorable `source_key` | major | `key_bound` blocker until the owner reviews the field `key` (review screen checkbox «مفتاح الإجابة») |
| R8 | A key-correction alert listed the affected attempts only in `affected_json`; the alert view lists `content_alert_item` rows, so attempts were invisible (this doc claimed one item per attempt) | minor | one `question_attempt` item per attempt whose result would change, with «was … / would be …» |
| W1 | Vault count «2 سؤالًا» / «3 سؤالًا» (wrong Arabic agreement) | minor | `questionCountAr` (tested) |
| W2 | Quick add (text): the course picker listed folders too, and a chosen folder was silently dropped | minor | courses only |

Verified and found sound: AC-10…AC-17 assertions of `golden.test.ts` are not weakened (A3 pages 0–1 with 5 options,
NOT/EXCEPT/«11.5 ×10⁹/L», per-section keys, circled option unofficial, B3 `missing_key`, two disagreeing key
tables, lecture after sources, exact vs near duplicate); keys never bind by number alone; circled / ticked marks
never become official; owner corrections and key changes always append a version and attempts keep theirs;
re-extraction idempotent; owner link / duplicate decisions persist; every route is behind the owner session and
CSRF; zod validation on every body/query; FTS input is quoted; no `dangerouslySetInnerHTML` in the web feature.

Not fixed (documented risks):

* Processing can merge the paragraph after a list item into that item's region (seen in a probe:
  «D. PET scan The following case relates to questions 2 and 3» as ONE region). The parser cannot split a region;
  the R3 blocker catches the case-introduction form, other merged text cannot be detected here (processing module).
* The AC-11 numbers/negation check compares the structured version with the text of the lines the parser assigned
  to the question; text the layout put in another region is not part of that reference.
* A handwritten «Answer: B» read by OCR with HIGH confidence is indistinguishable from a printed inline key.
* Two unofficial marks on the same question: only the first is stored (the entry identity has no option label).
* Changing Source Freeze does not re-run the in-force check until the next extraction / refresh of the affected
  questions.

Commands run by the review (repo root, `NODE_OPTIONS='--disable-warning=ExperimentalWarning'`):

| Command | Result |
|---|---|
| `npx vitest run test/questions` (in `apps/server`) | 4 files, 69 tests passed |
| `npm test -w @medlevo/server` | 30 files, 473 tests passed |
| `npx tsc -p apps/server --noEmit` | exit 0 (an earlier run during the review failed only in the parallel C2 track's in-progress `test/ai-provider/anthropic.test.ts`) |
| `npm test -w @medlevo/web` | 37 files, 317 tests passed |
| `npx tsc -p apps/web --noEmit` | exit 0 |
| `npm run build -w @medlevo/web` | exit 0 |
| `node apps/web/src/features/questions/real-server-check.mjs` | 72 PASS, «OK: real-server Question Vault check passed.» |


## Integration round I2 — performance (2026-10-10)
* **«Questions of this source» was O(questions × occurrences).** With only single-column indexes SQLite drove
  `o.question_id = q.id AND o.source_id = ?` through `idx_question_occurrence_source`, rescanning every occurrence of
  the source for each question: on a 2 000-question bank `GET /api/questions?source_id=` took 1.95 s p50 (count + page),
  exam candidates by source 1.08 s, universal search with a source filter 0.79 s. Migration
  `0510_question_occurrence_lookup.sql` adds `(question_id, source_id)`: 55 ms p50 for the vault page (2.7 ms / 8.4 ms
  for the two statements). Test: `test/questions/occurrence-lookup.test.ts` (query plans; fails without the index).
* Measured, not changed: 2 000 MCQs (240 pages) — processing 10.3 s, `extract_questions` 22.7 s, matching 67 ms.
* **Found, not fixed (recorded honestly):** an answer key printed as a long line that WRAPS
  («Section 10: 1. B … 35. D» then «36. C 37. B …» on the next lines) is read as separate key lines; the continuation
  lines carry no section label, so in a multi-section bank they are kept as `ambiguous_section` with a review item
  instead of being bound (965 of 2 000 keys in the perf bank, none bound). Safe abstention, but recall is lost;
  carrying the section label across a key block's wrapped lines is future work.

## Acceptance round G4 — AC-10, AC-11, AC-12, AC-14, AC-15 (2026-10-10)

Verified adversarially on derived fixtures (`fixtures/acceptance/make_g4_fixtures.py`); results and verdicts in
[`docs/ACCEPTANCE.md`](../ACCEPTANCE.md) («G4»). Changes made to this module (each with a regression test in
`apps/server/test/acceptance/g4-*.test.ts`):

* **Merged per-section key lines** (`parser.ts splitSectionKeyRuns`): «Section B: 1. C 2. B 3. A Section A: 1. B 2. D» in
  one region (the layout joins short key lines) was dropped whole — every question «no key». Each run is now its own key
  line; a «Section N: …» key run longer than 90 characters is accepted as a header when the rest is key pairs.
* **Key layouts** (`KEY_PAIR`): «Q1: B», «Question 1: B», «1 → B», «1 = B», «س1: ب» are read; «Q1: B Q2: D» no longer
  becomes a bogus question «B Q2: D».
* **Unreadable key lines are reported, never guessed** (`ParseResult.unreadKeyLines`, `extract.ts`): a line under an
  answer-key heading holding only numbers and option letters in an unknown layout («Q1 is C, …») → a review item
  (`question_validation_failed`, source-version scope `keys`) and «سطر مفتاح لم تُقرأ صيغته» in the extraction summary
  (status `needs_review`); the questions stay `missing_key`.
* **Answer check against the material** (`answercheck.ts`, `POST /api/questions/:id/answer-check`, capability
  `ai.answer_check`, rate-limited like the other AI routes): Source Lock «Lecture Only» on a linked lecture (explicit
  `include_references` widens to «المحاضرة + المراجع»); the linked pages are the anchor, retrieval purpose
  `source_question_practice`, evidence packed with `fixedAnswer: true` (no uncertain readings). An independent solver
  (task `validate_question`) sees only the evidence and the question with neutral letters — never the key — and returns a
  choice + 1–4 support sentences; every sentence goes through `validateClaims` (aliases, scope, critical tokens,
  `verify_support`). A conclusion needs ≥ 1 `linked` medical sentence, no unconfirmed one, exactly one defensible
  option and `answerable_from_evidence`; otherwise `unresolved` / `abstained` (recorded, nothing changes). Outcomes:
  `agrees` (recorded on the version + `answer_evidence supports_answer`), `conflicts` with a SOURCE key → a new version
  `conflicting_key` «مفتاح المصدر يختار A لكن الأدلة المختارة تشير إلى B …» (`answer_evidence contradicts_key`; printed key
  entries and the checked version untouched; `keyChangeImpact(…, 'evidence')` alert listing earlier attempts, never
  re-graded), with an owner key / earlier derived answer → reported next to it only, `derived` for `missing_key` /
  `unresolved` → a new version `ai_derived` (created_by `generation`, «AI-derived Answer — لا يوجد مفتاح في المصدر»,
  evidence linked) — the question stays a SOURCE question; for printed keys that disagree with each other the evidence is
  shown as help and the conflict is never resolved automatically. The check is stored in `key_details.answer_check`
  (`AnswerCheckView`); its claims come back as `answer_check_claims` in `GET /:id`.
* **`refreshQuestion` keeps a material conflict** (`lifecycle.ts`): while the source key is the one that was checked, a
  re-extraction / refresh never silently restores it (it did immediately — the conflict vanished); a check of the same
  key is carried over to the refreshed key details.
* Web: `AnswerCheck.tsx` on the detail screen — the button disabled with the server's reason without a provider or a
  linked lecture; the last check with its outcome, reason and evidence chips (`ClaimChips`).

Known limits (not changed): Part 2's trailing unlabeled key after per-part keys stays `ambiguous_section` (safe, review
item); «Paper I/II» sections vs a «Paper 1/2» key → `no_matching_question` (roman ↔ digit not mapped); a LibreOffice
line wrap inside «38.4 °C» is stored «38.4 ° C»; the answer check's judgement is a model's (no key here — exercised only
with the test-only scripted provider).


## Acceptance round G5 — AC-16, AC-17 (2026-10-10)

* **Exact-duplicate identity keeps meaning-bearing symbols** (`text.ts fingerprint`, AC-17): «base excess −8» (U+2212,
  also NFKC's form of a superscript «⁻») merged with «base excess 8», «♀» with «♂», «A → B» with «A ← B» — two medically
  different questions from two files became ONE question with a false «conflicting key». The fingerprint now spells
  these out before `normPhrase` (a dash used as a sign is a minus; «5–10» stays a range); `normPhrase` itself (also used
  by lecture matching) is unchanged. Fingerprints stored earlier for texts with these symbols differ from new ones: such
  a question uploaded again becomes a near-duplicate suggestion instead of attaching (safe direction).
* **Re-matching after a move or a type change** (AC-16): moving a source to another course (PATCH `node_id`, drag & drop
  `move`, restore into another folder) or changing its type never re-ran matching — a lecture moved into the course got
  no questions and the tab said «لم يُعثر على أسئلة…»; a question source first uploaded as «lecture» was never
  extracted. `sources/service.ts enqueueQuestionRefresh` (guarded like the processing hook) queues `match_questions`
  (or `extract_questions` for a source re-typed as a question source / previous exam). The matcher drops its OWN stale
  suggestions out of scope (`staleAutoLinks`: origin `auto`, status `suggested`, `matcher_version` set); owner decisions
  and generated questions' links are never touched.
* **The lecture tab shows the question from this lecture's course** (`routes.ts for-lecture`): a question printed in the
  banks of two courses showed the other course's file and page as its origin.
* Tests: `apps/server/test/acceptance/g5-ac16.test.ts`, `g5-ac17.test.ts`; `e2e/g5-ac16-late-linking.spec.ts`.
  Known limit seen there (processing, not fixed here): LibreOffice PDFs reverse plain lam-alef in the text layer
  («العلامة» → «العالمة»); matching still links (both sides carry it) but the owner reads the wrong spelling.

## Acceptance round G7 — AC-25 (2026-10-10)
* **Near-duplicate suggestions were lost after an interrupted extraction.** The extraction runs in one transaction and its
  result is checkpointed afterwards; a power loss between the two re-ran the extraction on retry, which found every
  question already in the vault (`created = []`) and skipped near-duplicate detection — the previous exam's near-duplicate
  of A2 was never suggested. The job now also takes the questions whose first version THIS job created
  (`question_version.job_id`, `version_no = 1`, `created_by = 'extraction'`). Test:
  `apps/server/test/acceptance/g7-ac25.test.ts` (an interrupted run's vault equals an uninterrupted run's: questions,
  versions, options, occurrences, keys, lecture links, duplicate suggestions, open review items).


## G8 acceptance fixes (AC-26, 2026-10-10)
* **A key correction names every affected tool** (`lifecycle.ts questionTools / addToolItems`): besides the old version
  and the attempts whose result would change, the `key_corrected` alert lists the cards made from mistakes on the
  question and the exams that pin the old version (unfinished → needs review; finished → still valid, result kept).
* **A corrected FACT in the question text** (`PATCH /:id`, options / stem / explanation) now raises an alert
  (`questionCorrectionAlert`, kind `source_updated`, severity `fact_change`) when anything was built on the previous
  version: the old version, its attempts (kept, not re-graded), cards from mistakes, exams that pin it. Before, only a
  key change was announced.
* **Evidence-backed answers depend on their lecture passages** (`answercheck.ts insertAnswerEvidence` →
  `recordDependencies`): a later correction / replacement of the lecture text that an answer check relied on now flags
  that question version in the content alert (before, only the question's own source was a dependency).
* Tests: `apps/server/test/acceptance/g8-ac26.test.ts`, `e2e/g8-ac26-correction.spec.ts`.

## Track F3 — translations & paraphrases as DERIVED question versions (2026-10-10; §35, §37)

* **Model**: a derivation is a request row in `question_derivation` (migration `0520_question_derivation.sql`: question,
  source version, kind `translation | paraphrase`, language, status, issues, job, derived version); the published result
  is a new `question_version` of the SAME question with `kind` `translation` / `paraphrase`, `derived_from_version_id` =
  the original version, `created_by 'translation'`, the same option keys, display labels and pinned flags, and the
  original's correct option keys. It is NEVER made current: attempts, keys, exams and the vault keep using the original;
  the view maps every derived option to the ORIGINAL option id (`DerivedOptionView.id`), so an answer can only ever
  reference the original. A newer original version marks the derived text «قد لا يطابق النسخة الحالية». Feedback's
  «changed since» ignores derived versions (`exams/feedback.ts`).
* **Pipeline** (`modules/questions/derived.ts`, job `questions.derive_version`): the model (task `generate_questions`)
  receives ONLY the question's own text (no lecture evidence, an explicit empty scope — a translation adds nothing) and
  returns stem + options by option key; then deterministic checks (`derivedIssues`, exported and unit-tested): every
  option present exactly once, numbers and units of the stem and of each option preserved (Western and Arabic-Indic
  digits), a negation kept as a negation, the requested language, a paraphrase that really differs; then the independent
  validator (task `validate_question`: same meaning, options equivalent, negation and numbers / units preserved). Any
  failure → `needs_review` with the reasons and a review-queue item (`question_derivation`), no version is written.
  Requests are idempotent per (version, kind, language) while queued / running / published; a translation into the
  question's own language → 400.
* **API**: `GET /api/questions/:id/derived` (derivations + `can_derive` with its reason), `POST /api/questions/:id/derived`
  `{kind, lang?}` (409 `AI_NOT_CONFIGURED` without a provider), `GET /api/questions/derivations/:derivationId`.
* **Web** (`features/questions/DerivedVersions.tsx`, on the question screen before «النسخ»): translate into the other
  language / paraphrase (disabled with the server's reason), each derivation with its status in words and its failed
  checks; a published one is shown only on demand, labelled «نسخة مشتقة … ليست نص السؤال الأصلي», with the answer marked
  «الإجابة (مفتاح الأصل نفسه)» on the original key.
* Tests: `srv:f3/ai-tools.test.ts` (translation published with the original ids / keys while the original stays current
  and a new exam pins the original; idempotent; a dropped «NOT» → needs_review + review item, no version; the validator
  rejecting a changed meaning), `srv:f3/unconfigured.test.ts` (409, `can_derive` reason, units of `derivedIssues` /
  `equivalenceIssues`), `web:src/features/questions/DerivedVersions.test.tsx`, `e2e:f3-study-modes.spec.ts`.
* Not run: real translations (no key).
* **F3 review (2026-10-10)**: the derived view reads the key and the answer status from the ORIGINAL version
  (`derivedVersionView`) — a derived row kept its own copy, which went stale when the lifecycle refresh changed an
  unattempted original's key in place (the derived version then showed a different «الإجابة»); a published derived
  version's `fingerprint` is cleared, so extraction's «same question, any version» lookup can never attach a source
  occurrence to a question through generated text (`srv:f3/review.test.ts`). Residual (outside F3's files): the
  question screen's «سجل النسخ» lists the derived row with its own stored key mark; «النسخ المشتقة» shows the original's.
