# Study Book, explanations, contextual chat, summaries, terminology + AI provider (track C2)

Owns `apps/server/src/modules/ai/providers/**` (+ two documented additions in `modules/ai/{types,orchestrator}.ts`),
`apps/server/src/modules/studybook/**`, migration `0450_studybook.sql` (range 0400–0499; 0400–0449 stays the `ai`
module's), `apps/server/test/{studybook,ai-provider}/**`, `apps/web/src/features/studybook/**`,
`apps/web/src/features/workspace/studybook/**`, the workspace slots `panels/ExplainTab.tsx`, `model/aiActions.ts`,
`selection/SelectionToolbar.tsx`, the Study Book view parts of `WorkspaceScreen.tsx` / `chrome/TopBar.tsx`,
`packages/shared/src/studybook-api.ts` (new, exported from `index.ts`), this file and `docs/adr/0002-ai-provider.md`.
Spec: §12, §15, §16, §17, §18, §19, §20, §21, §24, §28, §30, §31, §51, §52; AC-05, AC-06, AC-07, AC-08, AC-22, AC-25,
AC-26, AC-29. Built on track C1's evidence services (`modules/evidence/services.ts`) and web components
(`features/evidence`) — nothing of theirs is duplicated.

> Resume note: this round was interrupted once. The first attempt left the provider, the server module, its tests
> and parts of the web on disk (committed as WIP). This attempt re-read them, ran their tests (60/60 passing), and
> completed what was missing: the terminology path, the workspace integration (the `studybook.css` the rail
> imported did not exist — the web build would have failed), the Study Book view switch / split / Lecture Twin,
> notes on Study Book paragraphs, the terms and rules screens, web tests, the browser check and this document.

## 1. AI provider — Anthropic adapter (ADR-0002)

`providers/anthropic.ts` (`AnthropicProvider`) on `@anthropic-ai/sdk`, created by `createProviderFromConfig()` only
when `ANTHROPIC_API_KEY` is set (`config.secrets.anthropicApiKey()`; key in a private `#client`, never logged /
serialized; SDK logger off; `authToken: null`). Without a key the factory returns `null` and every AI feature is
`requires_configuration` with the reason «تتطلب ضبط مزود ذكاء اصطناعي على الخادم (ANTHROPIC_API_KEY)».

* Models per role (defaults `claude-opus-5-5`, from the claude-api skill): generation / verification / vision,
  overridable with `MEDLEVO_MODEL_GENERATION|_VERIFICATION|_VISION`. `embed` / `transcribe` → unsupported.
* Requests: streaming `beta.messages.stream(...).finalMessage()`; structured output `output_config.format =
  json_schema` converted from the orchestrator's zod schema (`toStructuredOutputSchema`: `additionalProperties:false`,
  unsupported constraints moved into descriptions; records → prompt-only JSON); `output_config.effort` (`high`,
  `low` for classify) only for models that accept it; adaptive thinking (never disabled / budgeted); reasoning
  headroom added to `max_tokens` and used by the orchestrator's worst-case budget check (`outputTokenCeiling`);
  server-side refusal fallback `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) for Opus 5.x / Fable 5.x
  / Sonnet 5.5; no tools, no sampling parameters; vision = PNG/JPEG base64 `image` blocks before the text.
* Results: `stop_reason` `refusal` / `max_tokens` / `model_context_window_exceeded` → `ProviderError` (partial output
  never returned); typed SDK errors → `ProviderError(kind)` with the provider request id; bounded SDK retries
  (2, max 4); abort / timeout via the orchestrator's signal (a job cancel propagates unchanged).
* Usage → `usage_record` (served model, tokens incl. cache, latency, request id, source versions, rules version, no
  prompt text); cost is an **estimate** from a static price table (list prices cached 2026-10-06; unknown model →
  highest known rate).
* Orchestrator additions (documented in ADR-0002): optional `cacheCreation/ReadInputTokens`, `ProviderError` with a
  specific Arabic reason per kind (`AI_PROVIDER_ERROR`, 502, `details.provider_error`), budget pre-check with the
  provider's output ceiling.

## 2. Server — `/api/studybook` (`modules/studybook/`)

| file | role |
|---|---|
| `rules.ts` | Explanation Rules Engine (§19): settings → owner extras (`explanation_rule_override` owner) → library node template (`library_node.template` mapped to the shared `EXPLANATION_TEMPLATES`) and node overrides (nearest wins) → request overrides. `rules_version = r-<sha256 of the effective rules + engine version>`. Prompt builder (evidence contract, level, answer style, dialect — Iraqi teaching tone for connective text only —, template sections «only if the evidence covers them», optional blocks, Explain-Until-Understood strategies, Socratic, owner terminology, owner preference sanitized). |
| `generate.ts` | the single evidence pipeline: `resolveScope` → `retrieve` (scope-filtered in SQL before ranking) → nothing usable → **abstain without calling the model** (`abstainFor`: `not_found_in_scope` + `suggest_scope`, or `unreadable_source`) → `packFromCandidates` (aliases E1…) → `ctx.ai.generateStructured` (`GeneratedContent` zod schema; Source Lock re-checked by the orchestrator) → `processGenerated` → publish (artifact + `content_block` rows + dependencies + search index) in one transaction. `requireAi` maps not-configured / budget to the server's own reason. |
| `publish.ts` | rules post-filter (disabled block kinds dropped; LITERAL keeps verbatim quotes only); `validateClaims` (C1) per block incl. comparison-table cells; failing sentences removed and listed in `removed` (never softened); RichText runs carry claim ids (chips); template post-check drops headings left empty and reports them «not covered»; server labels for «مثال تعليمي مولد», memory hooks, self-check questions; `block_key = b<sha256(section | sorted region ids | kind | ordinal)>`; dependencies (`artifact_dependency`, block + artifact); `owner_content_fts` row (`entity_type 'artifact'`, origin `generated`, normalized text). |
| `explain.ts` | `POST /explain` (explain / simplify / translate / explain_image): anchor must be the locked version (`OUT_OF_SCOPE` otherwise, never widened); anchor regions must belong to it; real-patient detector (AR + EN patterns) → `real_patient_request` with the educational notice (no retrieval, no model); cache key per ARCHITECTURE §3.7 (C1 `cacheKey`: scope hash + version ids/hashes + rules_version + level + language + dialect + style + generator/verifier versions + anchor/instruction/strategy) reused only via `findReusable` (exact key, published, `canReuse`); Explain Until Understood = new version of the lineage with `parent_artifact_id` and a different strategy (prerequisites / diagram / comparison / clinical example / analogy / smaller steps), the previous explanation passed as NON-evidence. Figures (§15, AC-08): with vision the crop (`image_asset` PNG/JPEG) goes to `vision_figure`; output = cited caption/text claims + model-read `visual_items`, rendered as a labelled «قراءة بصرية مولَّدة … ليست دليلًا» block, items `uncertain` unless clear AND the label is OCR-readable, `not_for_exam_answer` when anything is uncertain; without vision → explained from caption / OCR labels only, with a warning block that says so. `POST /compare` (§31): retrieval per item, one `comparison_table` with a claim per cell, «غير مذكور في المصادر المسموحة» cells, items not found listed in `coverage.missing_ar`. Page explanations are titled with the page label («شرح: ص 12»). |
| `chat.ts` | threads bound to anchor + source + version + **pinned** resolved scope (`scope_hash`; a changed lock → 409, never a silent drift); history from the thread only; every answer = the same pipeline (`draft → verifying → final | abstained | rejected`; drafts carry no content); styles simple/short/detailed/expert/literal; Socratic = hint + guiding question; answers indexed for search. `POST /messages/:id/save-note` → note (origin `ai_answer`, `ai_record` {question, context, evidence ids/labels, claim ids, verification counts, model, rules version, dates, source versions}) through the annotations sync handler (idempotent per note id), labelled «إجابة مولَّدة … ليست مصدرًا مستقلًا». |
| `book.ts` | Study Book (§24) and summaries (§31) as sectioned artifacts + job `generate_study_book` / `generate_summary` (version `sections-1`). Sections from heading regions (else pages; long sections split at page boundaries); each section generated, validated and written **in one transaction together with `status='complete'`**, then checkpointed — an interrupted section is reset and regenerated, never half-published, finished sections never regenerated (AC-25); statuses pending/generating/complete/abstained/failed with real counts; artifact `generating → published | partial | failed`; regeneration = new lineage version (older non-frozen published → `superseded`); `computeReanchor` → `artifact_reanchor` matched / needs_reanchor + `review_queue_item` (owner writing never modified, AC-22); freeze; scope change since the request → job fails with the reason. Summaries: preview before (pages selected / ready / unreadable / unprocessed, `will_be_complete`, selection types labelled) and coverage after (never «complete» with missing pages, AC-03). |
| `artifacts.ts` | `StudyArtifactView` (blocks with `meta`, claims via C1, versions of the lineage, abstain, removed), `findReusable`, freeze. |
| `terms.ts` | owner dictionary entries present in the texts → «OWNER TERMINOLOGY» line of the trusted instruction (never inside an evidence quote; source text never edited). |
| `index.ts` | routes + capabilities (`ai.explain/chat/study_book/summaries/figure_explain` from the provider's task support; figure explain says «caption / OCR only» when the provider lacks vision). |

Routes (owner session + CSRF like every `/api` route; AI routes rate-limited):
`POST /explain` · `POST /compare` · `GET /artifacts?source_id=&kind=` · `GET /artifacts/:id` · `POST /artifacts/:id/freeze`
· `GET /books?source_id=` (default version: frozen > published > latest, + `can_generate` with reason) · `POST /books`
(`regenerate`) · `GET /books/:id` · `POST /books/:id/resume|cancel|freeze` · `POST /summaries/preview` · `POST /summaries`
· `GET /summaries/:id` · `POST /threads` · `GET /threads?source_id=&page_id=` · `GET /threads/:id` ·
`POST /threads/:id/messages` · `POST /threads/:id/archive` · `POST /messages/:id/save-note` ·
`GET /rules?source_id=&node_id=` · `PUT /rules/owner` · `PUT|DELETE /rules/nodes/:nodeId` ·
`GET|POST /terms`, `PATCH|DELETE /terms/:id`.

**Terminology path.** `medical_term` belongs to the evidence module (ARCHITECTURE §2), which already implements its
CRUD at `/api/evidence/terms` (validation, case-insensitive uniqueness, audit; used by retrieval and search
expansion). `/api/studybook/terms` forwards the request (same cookie / CSRF / Origin headers, via `app.inject`) to that
single implementation, so there is no second write path to the table; status and body pass through unchanged.

Migration `0450_studybook.sql`: columns on `artifact` (abstain, removed, anchor, parent, scope hash), `content_block`
(table, meta), `contextual_thread` (page, socratic, resolved scope, scope hash, archived), `message` (style, reply,
detail); tables `artifact_section`, `explanation_rule_override`, `artifact_reanchor`. No existing migration edited.

## 3. Web

### Workspace (`/study/:sourceId`)
* **«الشرح والسؤال» rail tab** (`panels/ExplainTab.tsx`): the selection (or the page when nothing is selected), the
  Source Lock (C1 `ScopeBadge` / `ScopePicker`, nothing changes until «طبّق النطاق»), level and answer style,
  شرح / سؤال / مقارنة; اشرح · بسّط · ترجم إلى العربية · اشرح الشكل; results through C1 `ArtifactContent`
  (generated label, chips → Evidence Peek → open source → back, unverified claims marked, removed sentences on demand,
  coverage gaps); abstentions with reason/detail and an explicit «وسّع النطاق»; specific error titles
  (not configured / budget / out of scope); «لم أفهم — اشرح بطريقة أخرى» (strategies); explanation history of the page;
  links to the rules and terms screens. Without a provider the actions are disabled and the server's reason is shown
  (`aria-describedby`).
* **Chat** (`studybook/ChatPanel.tsx`): threads of the page, a new selection starts a new thread, Socratic switch,
  answers shown only when final/abstained (drafts show a status, never text), «احفظ الإجابة كملاحظة».
* **Selection toolbar**: «اشرح» and the «المزيد» menu (Explain / Simplify / Translate / Ask / Compare / Explain Image)
  hand the selection anchor (quote + rectangles → region ids) to the rail through `aiRequestStore`; the workspace
  opens the tab. Create MCQ / Flashcard / Add to Revision stay disabled with specific reasons.
* **Views** (top bar «طريقة العرض»; phone «خيارات القراءة»): المحاضرة الأصلية · كتاب الدراسة · المحاضرة + كتاب الدراسة
  · جنبًا إلى جنب مع مصدر آخر. The Study Book items are enabled when a version exists (readable without AI) or one can
  be generated; otherwise disabled with the server's reason. **Lecture Twin**: opening the Study Book scrolls it to the
  block nearest the lecture page (`nearestBlock`); while reading the book the rail follows the page of the block on
  top; switching back opens the lecture at that page; a citation chip opened from the book shows the original and
  «العودة إلى موضعك» returns to the book. **Split** lecture | Study Book with optional synchronized scrolling (toggle,
  `aria-pressed`, no feedback loop). The full view hides the ink tools and the selection toolbar (no lecture on screen);
  page keys do not flip an invisible lecture. The full view is a per-device preference (localStorage, guarded); the
  split is part of the synced study session (`split.mode = 'study_book'`). Scrolling never moves the page around the
  pane (phones keep the reading bar).
* **Study Book pane** (`studybook/StudyBookPane.tsx`): design `Tabs` كتاب الدراسة / الملخصات; generation panel with the
  lock shown first; real section progress («3 من 7 أقسام», `LoadingState done/total`, no %); section list with status
  text + icon and «open in the lecture»; book body with chips, clinical notes, pearls, mini questions, labelled
  examples; freeze / new version (confirmation states that notes are never moved); versions list; stale → «ما الذي
  تغيّر في المصدر؟» with C1 `ContentAlertsPanel`; vanished anchors «ملاحظات تحتاج إعادة ربط»; **notes on paragraphs**
  (`BlockNotes.tsx`): local-first `saveNote` with a semantic block anchor `{lineage_id, block_key}` on the paragraph at
  the top of the view, listed per book, a note whose block is not in the shown version marked «تحتاج إعادة ربط (لم
  تُنقل)».
* **Summaries** (`studybook/SummaryPanel.tsx`): type, pages (whole lecture / current page), custom instruction; scope
  and what will not be covered BEFORE generating; coverage AFTER; history.

### Screens (`features/studybook`, shell routes)
* `/terms` — the owner's dictionary: empty by default (nothing seeded), add / edit (dialog, client validation that
  mirrors the server's: required, length, case-insensitive duplicate) / delete (impact stated), local filter
  (normalized Arabic), LTR terms isolated, origin shown for non-owner entries.
* `/explanation-rules[?node_id=|?source_id=]` — effective rules with the layer each value comes from, the template's
  sections with the «only if your sources state it» note, `rules_version`; editing the owner layer (template default,
  English terms, optional parts; level / dialect / Socratic / instruction link to `/settings`) or a folder's rules
  (inherit unless set; remove with confirmation).

## 4. Tested (commands run, real results — 2026-10-09)

| command | result |
|---|---|
| `npm test -w @medlevo/server` | **38 files, 577 passed** (all tracks). This track: `test/ai-provider/anthropic.test.ts` 14, `test/studybook/explain.test.ts` 17, `rules.test.ts` 13, `chat.test.ts` 9, `book.test.ts` 8, `terms.test.ts` 3 = 64. |
| `npm test -w @medlevo/web` | **45 files, 362 passed** (all tracks). This track: `features/studybook/{model.test.ts (13), screens.test.tsx (4)}`, `features/workspace/studybook/{ExplainTab.test.tsx (6), StudyBookPane.test.tsx (3), BlockNotes.test.tsx (2)}` = 28. |
| `npx tsc -p apps/web --noEmit` | exit 0 |
| `npx tsc -p apps/server --noEmit` | 3 errors, all in `apps/server/test/exams/exams.test.ts` (parallel track C4's test file, `confidence: string`); none in this track. |
| `npm run build -w @medlevo/web` | success (`RulesScreen`, `TermsScreen` lazy chunks; Study Book code inside the workspace chunk). One intermediate build failed only because the parallel track's `features/exams/exams.css` did not exist yet; the final build succeeds. |
| `node apps/web/src/features/workspace/studybook/real-server-check.mjs <dir>` | **46/46 checks passed** (Chromium `/opt/pw-browsers/chromium`, 1280×800 and 390×844, light + dark). Phase A = production entry WITHOUT a key: capabilities `requires_configuration` with the key reason, Explain tab disabled with the reason, «كتاب الدراسة» disabled with the reason, selection → «اشرح» opens the rail with the selected text, terms CRUD through `/api/studybook/terms`, rules saved → `rules_version` changed, no horizontal overflow. Phase B = the real app with the TEST-ONLY grounded fake provider (`apps/server/test/studybook/browser-server.ts`, copies evidence sentences verbatim; not a model): page explanation with real chips («محاضرة ص11»), selection «بسّط», chat answer saved as an `ai_answer` note, Study Book generated through the real job queue (6 sections, 28 blocks, no %), a block note synced and `matched` after a regeneration (v2), Lecture Twin back to the page of the last block read, split with sync on, phone Study Book / rail sheet without overflow and with the reading bar kept on screen. Screenshots looked at; fixed after looking: the chat thread title (a nowrap pill) widened the rail and clipped answers; Lecture Twin scrolled the whole page on phones (reading bar off screen) → the pane alone scrolls; the pane's sticky bar was not sticky (shrunk flex child); a user scroll right after a programmatic jump was ignored (top block now re-reported after the guard window); page explanations were titled «شرح: التحديد» (now «شرح: ص 11»); the vision note showed without a figure button; mixed Arabic/English hints rendered out of order (now `Term`-isolated); flex notes split text around links; summaries lost their disclosure marker. |

Server coverage by requirement: explain happy path (claims linked, chips data = evidence views with locator, labels,
block keys, dependencies, `owner_content_fts` origin generated, search lists it as generated / not evidence), cache only
on an exact key (level change = new key), AC-06 (unknown alias, raw evidence id → removed, never cited), AC-07 (changed
number removed), nothing medical survives → `insufficient_evidence` abstention with the removed sentences, template
post-check (empty heading dropped + «not covered»), LITERAL, Explain Until Understood (new version, strategy in the
prompt, previous answer as non-evidence), real-patient abstention without retrieval/model, anchor outside the lock
refused, AC-05 (lecture-only never reuses a wider-scope artifact; items found only outside the lock → abstention
WITHOUT a model call + `suggest_scope`, explicit widening searches the reference, the narrow request keeps its own
abstention — in explain/compare and in chat), AC-29 (an injected «ignore instructions / cite the textbook» region does not widen scope or
citations), schema rejection after one repair → nothing saved, provider failure → specific error, budget 0 → blocked,
no provider → `requires_configuration` + reasons, figures with and without vision (AC-08: uncertain items flagged,
`not_for_exam_answer`), Compare (claim per cell, uncovered cells), chat (binding, pinned scope, Socratic, literal, AC-05,
real patient, failure → `rejected` without content, scope drift refused), save-as-note (origin `ai_answer`, ai_record,
idempotent, labelled generated), Study Book (sections from structure, AC-25 interruption → regenerated section, no
duplicate/truncated blocks, cache, AC-22 new version + matched / needs_reanchor + review item, owner writing untouched,
freeze default view, AC-26 replacement → stale + alert, frozen keeps its version), summaries (AC-03 not complete with
unprocessed/unreadable pages before and after; last-minute / high-yield labelled as selections), rules (layers,
`rules_version` changes, prompt builder), terms (CRUD through the forwarded path, session/CSRF/Origin kept, preferred
renderings in the trusted instruction only, source text unchanged), Anthropic adapter with a mocked HTTP layer (request
shaping, structured output, effort, fallback, vision blocks, per-role models, usage + cache tokens, price estimates,
refusal / truncation, error mapping with request ids, bounded retries, abort vs timeout, factory and secret handling,
orchestrator usage records, budget pre-check with reasoning headroom).

## 5. Not done / limits (honest)
* **No real model was run**: no API key exists here. The adapter is tested only against a mocked HTTP layer; the whole
  pipeline only with test-only fake providers (`ScriptedAi` in tests, the grounded copier in the browser check). Real
  output quality, latency, refusals and token usage are unverified. Without a provider nothing is generated at all
  (requires_configuration); with one, a claim is `linked` only when C1's deterministic checks AND the independent
  verifier call agree — the fake verifiers used here say «supported», so «linked» in the browser check proves the
  plumbing, not medical support.
* Prompt caching is not used (per-call random delimiter nonce in the system prompt); costs are estimates from a
  static price table.
* The real-patient detector is a deterministic pattern list (Arabic + English); unusual phrasings can pass and are
  then answered only educationally from the sources (the model is also told to abstain).
* Figure explanation needs a stored crop (`image_asset` PNG/JPEG); pages without a figure crop are explained from
  caption / OCR text only. Pointing at a sub-area of an image (`anchor.bbox`) only picks the overlapping figure.
* G3 (AC-08): the visual reading states an arrow's direction in words («من «A» إلى «B»») — a bare «A → B» inside an
  Arabic paragraph is displayed pointing backwards whenever a label is Arabic (bidi: «→» is not mirrored); items beyond
  the 40 shown are counted and said («… و6 عناصر أخرى …», treated as uncertain), never dropped silently. A sentence
  whose only support is a diagram's OCR labels (region `uncertain`) is `needs_review`, never `linked` (C1
  `validateClaims`). `GENERATOR_VERSION` → `studybook-gen-3`.
* Study Book sections follow heading regions; a document with no headings gets one section per page. Very large
  sections are split at page boundaries (7 000 characters), not semantically.
* Chat answers are not streamed token by token (the request returns when verified); the UI shows the running state.
* «Save answer as note» stores the answer text without chips (the evidence ids/labels are in `ai_record` and listed in
  the note body).
* Notes on Study Book paragraphs anchor to the block at the top of the view (no per-paragraph button inside C1's
  `ArtifactContent`); highlights/ink on Study Book blocks are not offered in the UI (the server re-anchors them if they
  exist).
* The full Study Book view preference is per device (localStorage) because the session hook's `view` type
  (`'original' | 'split'`, track B1's file) has no `'study_book'`; the split is in the synced session.
* `GET /api/studybook/terms` forwards in-process (`app.inject`), so the evidence module's audit entries are the record;
  a session refresh cookie from the forwarded call is not passed back (the original request's cookie is still valid).
* Not run: real iPad/iPhone Safari, VoiceOver/NVDA, axe/Lighthouse.

## 6. Independent review (adversarial, 2026-10-09)

An independent review of this track read the server module, the adapter, the web parts and the tests, and ran
them. A first review attempt was cut off by a container restart. It left `test/studybook/review.test.ts` with
9 regression tests (7 failing) and one fix in `publish.ts`. This pass checked each of those findings again, fixed
the ones still open, and added its own. Every fix has a regression test. Each test was run against the pre-fix code
(the files were swapped temporarily and then restored) and **failed there**: 9 server tests and 2 web tests.

| # | sev. | finding | fix |
|---|---|---|---|
| 1 | major | A claim-less sentence in a medical block was kept as «connective text» unless it had a digit or a Latin letter. A short Arabic statement («الزائدة الملتهبة لا تحتاج جراحة.») was published **uncited**. The first fix (≤ 6 words, no Latin, no digit) still let it through. | `publish.ts isConnectiveText`: without a claim, a sentence is kept only if it is a question to the learner, the prescribed «غير مذكور في المصادر المسموحة» placeholder, or ≤ 6 words that are **all** in a small connective lexicon (no medical words, no negation). Anything else is removed and listed in `removed`. Headings, mini questions, memory hooks and coverage notes stay exempt (see limits). |
| 2 | major | Save-as-note accepted any client `note_id`. An existing note was then upserted through the sync handler: a deleted note of the owner (in the trash) was **overwritten and brought back** with the AI answer; a live note produced a conflict copy and the owner's note was returned as «saved». | `chat.ts saveAnswerAsNote`: an existing note id is accepted only if it is this same answer saved before (idempotent `duplicate`). Any other existing id → 409; nothing is written. |
| 3 | major | Study Book job: a non-retryable provider failure was re-thrown, so the whole job retried (×3). A refusal was **billed 3 times**, and a bad key failed every section, one call each. | `book.ts`: refusal, truncation and too-large fail **that section only**, with the specific reason, and the other sections continue. Auth, permission, unknown model or a bad request fail the **job at once**: one call, every remaining section failed with the reason, no retries. Retryable failures still retry. |
| 4 | major | AC-29: a section title (the text of a **document heading**, i.e. untrusted) was put inside the *trusted* task text of the Study Book prompt. | The title now goes to the model only as a delimited `SECTION TITLE` untrusted block. The trusted task refers to that block. Summaries were changed the same way. |
| 5 | major | The cache key (§3.7) did not include the owner dictionary, which the prompt and the retrieval expansion both use, nor the generator / verifier models. An explanation made with an old dictionary or an older `MEDLEVO_MODEL_*` was served as current. | `generate.ts keySettings` adds `terms` (a fingerprint of the dictionary, `terms.ts terminologyVersion`) and `generator_model` / `verifier_model` to the keys of explanations, figures, comparisons, the Study Book and summaries. |
| 6 | major | Explain Until Understood accepted any `retry_of`: an explanation of another source joined the wrong lineage. An explanation made under a **wider** scope was fed back to a lecture_only request as model context, so out-of-lock text leaked in. | `explain.ts assertRetryInLineage`: the retry must target an explanation of the same source and version (400 otherwise), and the versions it was built from must lie inside the current lock (409 `OUT_OF_SCOPE`). Both checks run before any model call. The web retries the explanation's **own** passage and action (`ExplainTab retryActionOf / retryContextOf`), not the current selection. |
| 7 | minor | Figure without vision: when every sentence failed verification, the result was **published as an explanation** containing only the «explained from the caption only» warning. | `generate.ts publishGenerated`: a warning alone is not content. The result is now an `insufficient_evidence` abstention, and the removed sentences can be shown on demand. |
| 8 | minor | A chat thread could be bound to regions of another version (only the anchor's version was checked). A `block` anchor was not checked at all. | `chat.ts createThread`: the anchor regions must belong to the anchor version, and a block anchor must belong to a Study Book of that source (409 otherwise). |
| 9 | minor | A chat answer left `draft` / `verifying` by a server restart showed «being written» forever. | `chat.ts messageView`: after 30 minutes it shows as `rejected`, with no content. |
| 10 | minor | `section_keys` (progressive generation, shared contract) created a new lineage version holding **only** those sections. Once published it superseded the complete book, and it opened needs-reanchor review items for notes on all the other sections. | `book.ts`: the version keeps every section. Only the requested sections run, the others stay `pending`, and the version is `partial`, so it never supersedes a complete one. «resume» generates the rest. |
| 11 | minor | Re-anchoring: notes on paragraphs of sections that were not finished yet (pending / failed) were reported as gone. A `needs_reanchor` review item stayed open after a later version brought the paragraph back. | `computeReanchor` skips sections that are not finished yet. When a note is `matched`, the server closes the open item it made (`dismissed`, with a server resolution). The owner's note is never touched. |
| 12 | minor | Selection longer than 6000 characters: the toolbar sent the full quote, and the server refused it (400). | `SelectionToolbar`: the quote is capped to what the server accepts. |
| 13 | minor | Arabic counting in coverage: «غطّى صفحتان», «11 من 12 أقسام». | `model.ts sectionsOfAr`, accusative «صفحتين». |

Checked with no change needed:
- The Anthropic adapter against the `claude-api` skill: `claude-opus-5-5`; thinking omitted (adaptive, never disabled); `output_config.effort` high/low; structured output through `output_config.format`; streaming `finalMessage()`; `fallbacks: "default"` with the 2026-07-01 beta; typed SDK errors, most specific first; request ids; price table, labelled as an estimate.
- The key is never logged, returned or serialized (`toJSON`, SDK logger off).
- Every route sits behind the global owner session and CSRF check; bodies are validated with strict zod schemas.
- No `dangerouslySetInnerHTML` / `innerHTML` in the track's web code.
- Drafts never render content in chat; Study Book sections appear only when complete.

### Verification of this review
| command | result |
|---|---|
| `npx vitest run --root apps/server test/studybook test/ai-provider` | 7 files, 92 passed (`review.test.ts` 28, of which 13 are the `isConnectiveText` table) |
| `npm test -w @medlevo/server` | 40 files, **611 passed** |
| `npx tsc -p apps/server --noEmit` / `npx tsc -p apps/web --noEmit` | exit 0 / exit 0 |
| `npm test -w @medlevo/web` | 46 files, 368 passed, **1 failed**: `test/settings-screen.test.tsx`, which this review did not touch. It took 4.5 s under load in the full run; re-run alone, it **passes**, so it is a timing flake |
| `npm run build -w @medlevo/web` | success |
| the same tests against the pre-fix files | the 9 new server tests and 2 new web tests **failed** there |

The Playwright browser check (`real-server-check.mjs`) was **not re-run** in this review.

### Residual risks (not fixed)
- `memory_hook`, `heading`, `mini_question` and `coverage_note` blocks may still hold claim-less sentences. They carry visible labels, and a value, threshold or dose without a claim is still removed by the evidence module. A mnemonic that restates a fact without a citation is not detectable deterministically.
- The connective lexicon is conservative. A legitimate transition outside it is removed and listed as unsupported, which can be noisy but never publishes an uncited fact.
- Comparison-table header cells and first-column aspect labels (≤ 6 words, no digit) are not claim-checked.
- The real-patient detector is still a pattern list. No real model has been called in this environment.

## G2 acceptance fixes (2026-10-10, AC-05 / AC-06; see docs/ACCEPTANCE.md)
* **Abstention offers the wider scope on the realistic path** (generate.ts): a model abstention
  (`not_found_in_scope` / `insufficient_evidence`), an answer whose every medical sentence failed verification, and a
  pack whose evidence was all refused now carry `suggest_scope` («المحاضرة + المراجع», explicit owner action) under
  «Lecture Only» — before, only a retrieval that found nothing did (§08). Test: `test/acceptance/g2-ac05.test.ts`.
* **No page / alias «citations» in generated text** (publish.ts): a sentence (claim or not) that writes a page, slide
  or alias reference its own cited excerpt does not contain is removed and listed in `removed` with the reason;
  table headers / aspect labels, coverage notes and abstention details are stripped of such references. A faithful
  quote of a source that itself says «page 14» keeps it. The generator contract says so explicitly;
  `GENERATOR_VERSION` → `studybook-gen-2` (cached artifacts of the old rule are not served). Test:
  `test/acceptance/g2-ac06.test.ts` (regression: `g1-ac04.test.ts` quote with «file page 14»). This closes the first
  residual risk listed above for page references (other claim-less facts remain as described there).
* **Rail chat follows the visible lock** (web `ChatPanel` + `ExplainTab`, `studybook/model.ts threadMatchesScope`):
  widening from a chat abstention now moves the rail's lock too; a changed lock starts a new conversation; a question
  is only ever sent to a thread pinned to the lock the rail shows; the open thread shows its own lock badge. Before,
  after «وسّع النطاق» the conversation continued in the wider thread while the rail read «المحاضرة فقط», and after
  narrowing back the next question was still answered from the reference. Test:
  `apps/web/src/features/workspace/studybook/ChatScope.g2.test.tsx` (failed before the fix).

## G6 acceptance fix (2026-10-10, AC-22) — see `docs/ACCEPTANCE.md`
* **A note is never reported «matched» to a different paragraph.** Block keys are hash(section, regions, kind, ORDINAL):
  a regeneration that writes fewer paragraphs about a region, or reorders them, hands a key to another paragraph, and the
  note / highlight was shown «على» it. `computeReanchor` now also requires that the paragraph holding the key is still the
  paragraph the anchor was written on — its block in the anchored version (`artifact_version`), else the quote the anchor
  kept — via `samePassage` (`@medlevo/shared` search.ts: identical after search normalization, or a light rewording, word-
  set Dice ≥ 0.6). Otherwise: `needs_reanchor`, owner rows untouched, review item «تغيّر نصها … لم تُنقل إليها». Web:
  `BlockNotes` shows a note as «فقرتها تغيّرت في هذه النسخة — تحتاج إعادة ربط» when the server report lists it, or when its
  kept quote no longer matches (offline). Tests: `apps/server/test/acceptance/g6-ac22.test.ts` (2 failed before),
  `studybook/BlockNotes.g6.test.tsx` (2 failed before).

## Track F3 — interactive timelines & flowcharts (2026-10-10; §31)

* **Server** (`modules/studybook/diagrams.ts`, migration `0460_study_diagram.sql`, table `study_diagram`; claims with
  `owner_type 'study_diagram'` are deleted with their row by a trigger). `POST /api/studybook/diagrams`
  `{kind: 'flowchart' | 'timeline', source_id, scope?, page_ids? (≤ 12), anchor?, topic?, force?}` (rate-limited, AI);
  `GET /api/studybook/diagrams?source_id=`, `GET /api/studybook/diagrams/:id`. The scope defaults to lecture-only and
  is resolved like every explanation (Source Lock; pages / anchor must belong to the locked version); retrieval → evidence
  pack → task `summarize` with a STRUCTURED output (`abstain`, `title`, nodes `N1…` with kind / order / time label /
  one-sentence statement, edges with an optional condition and a statement). Deterministic structure checks
  (`diagramStructureIssues`, exported and unit-tested: duplicate / unknown keys, self loops, duplicate edges, fewer than
  two nodes, flowchart without edges or with isolated nodes, a decision with fewer than two labelled branches, timeline
  orders missing or repeated) → `failed` with the reason. Every node and edge statement is a claim validated against the
  evidence (`validateClaims`); a node whose claim fails is removed WITH its edges, an edge whose claim fails is removed,
  both listed in `removed` (shown on demand, never as supported); fewer than two nodes left (or a flowchart without
  edges) → `abstained`. A published diagram is cached by (kind, scope hash, pages / anchor / topic, versions, rules
  version) and reused unless `force`; a newer source version marks it stale with the reason. Capability: `ai.summaries`
  + task `summarize`; without a provider → 409 `AI_NOT_CONFIGURED`.
* **Web** (`features/studybook/diagrams/`): `layout.ts` (pure: longest-path layers that survive cycles, timeline by
  `order`, RTL placement — the first branch at the reading start, RTL-aware arrow keys, node names and relation
  sentences in words «من «A» إلى «B» — الشرط: …»); `StudyDiagram.tsx` (always labelled «مخطط أُعيد تنظيمه تعليميًا من
  مصادرك — ليس صورة من المصدر» with the scope; nodes are 44 px buttons with one roving tab stop, Enter / Space selects,
  Esc clears; the edges are a decorative SVG — the selected node's relations in the accent, the rest a neutral hairline,
  «يحتاج مراجعة» dashed AND in words; a live details region with the verified statement, its citation chips and the
  relations; a text twin with the same steps, relations, statements and chips); `DiagramPanel.tsx` (in the rail under
  the explanation tab: kind, optional topic, «ارسم المخطط», «أعد الرسم» for a cached one, abstention / rejection with the
  reason, earlier diagrams of the source; disabled with the capability reason without a provider).
* Tests: `srv:f3/ai-tools.test.ts` (scripted provider: flowchart published with linked claims and cached; a node citing a
  bad alias removed with its edges; a decision with one branch → failed; timeline order; model abstention; Source Lock
  409), `srv:f3/unconfigured.test.ts` (409 / 400 on the real configuration, structure checks),
  `web:src/features/studybook/diagrams/{layout.test.ts,StudyDiagram.test.tsx}`, `e2e:f3-study-modes.spec.ts`
  (requires_configuration in the rail, API 409).
* Not run: a real model drawing a diagram (no key). Diagrams are not part of the Study Book offline package.
* **F3 review (2026-10-10)**: node labels, time labels, edge conditions and the title are generated text shown OUTSIDE the
  verified statement, so `labelIssues` (exported, unit-tested) checks each against its verified statement and the
  evidence it cites (`checkCriticalTokens` families: numbers, units, quantities, comparators / thresholds, populations,
  exceptions, negation incl. a flipped one; plain wording and abbreviations are not checked — a label is short by
  design). A failing node is removed with its edges, a failing edge is removed, both listed («التسمية «…» تقول ما لا
  تقوله عبارتها المتحقق منها …»); a title with an unsupported value falls back to «<النوع> — <المصدر>».
  `DIAGRAM_GENERATOR_VERSION` → `diagram-2026.10-2`, so no diagram cached before the check is reused
  (`srv:f3/review.test.ts`).
