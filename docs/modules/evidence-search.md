# Evidence, Source Lock, Search, Source Inspector (track C1)

Owns `apps/server/src/modules/{evidence,search}/**`, migration `0300_evidence.sql` (range 0300–0399),
`apps/server/test/{evidence,search}/**`, `apps/web/src/features/{evidence,search}/**`, this file.
Spec: §03, §08, §09, §10, §11, §12, §17 (cache keys), §18, §46, §52; AC-05, AC-06, AC-07, AC-26 (alerts), AC-29.
Contracts consumed exactly: `packages/shared/src/{evidence,scope,search,sources,richtext,enums,api,features}.ts`.
Contracts added by this track (written by the interrupted first attempt, reviewed and completed here):
`packages/shared/src/evidence-api.ts` (scope preview, evidence batch, ribbon, retrieval report, content alerts) and
`packages/shared/src/search-api.ts` (search request/response, bidi-safe highlight helpers), exported from `index.ts`.

## 1. Server — services for other tracks (`apps/server/src/modules/evidence/services.ts`)

Import everything from `../evidence/services`. All functions are synchronous unless marked `async`; the
synchronous ones are safe inside `ctx.db.tx(...)`.

```ts
import { resolveScope, retrieve, abstainFor, packFromCandidates, validateClaims, recordDependencies, cacheKey, canReuse } from '../evidence/services';

const scope = resolveScope(ctx, req.scope);                 // SourceScope → ScopeReport (a ResolvedScope + origins/sources/excluded)
const key = cacheKey(ctx, { kind: 'explanation', scope, rulesVersion, generatorVersion, verifierVersion, level, language, dialect, params });
// reuse only: same key AND canReuse(ctx, 'artifact', id).usable
const r = retrieve(ctx, { scope, query: question, anchor: { region_ids }, k: 8, purpose: 'lecture_explanation' });
const abstain = abstainFor(ctx, r, scope);                   // null, or { reason, reason_ar, detail, suggest_scope? }
const pack = packFromCandidates(ctx, scope, r.candidates);   // { forModel: EvidenceForModel[] (E1…En), aliasMap, views, refused }
// … generator call with pack.forModel (untrusted quotes) → GeneratedContent …
const v = await validateClaims(ctx, { ownerType: 'content_block', ownerId: blockId, sentences, aliasMap: pack.aliasMap, scope });
// v.sentences[i]: { claim_id, status, keep, evidence_ids, issues, reason_ar } — drop !keep, list v.removed
recordDependencies(ctx, 'artifact', artifactId, scope.versionIds, regionIdsUsed);
```

| export | what it does |
|---|---|
| `resolveScope(ctx, SourceScope)` | Source Lock (ARCHITECTURE §3.7). `lecture_only` → the focal lecture's version (`version_pins ?? frozen ?? current`); `references_only` → the chosen references; `lecture_plus_references` → both, origin marked (no explicit list → the lecture's INCOMING `reference_for` links «R reference_for lecture», listed in the preview; a source the lecture is itself a reference *for* is never added); `external` → `FEATURE_DISABLED` while external evidence is not enabled (no such owner setting exists yet, capability `external.evidence` is not implemented). `include_my_notes` adds «ملاحظاتي» sources only when requested (low assurance). Trashed/purged sources are excluded with an Arabic reason; a trashed/missing focal lecture → `OUT_OF_SCOPE`; a pin of another source → 400. `hash = sha256(stableStringify({mode, sorted source ids, sorted version ids, include_my_notes, allow_external}))`; `describeAr`. Unknown request keys are stripped (a document/body cannot smuggle `versionIds`). |
| `retrieve(ctx, {scope, query, anchor?, k?, purpose, neighbours?})` | `scope` required. Anchor regions (scope-checked; outside ones → `dropped_anchor_region_ids`, an outside anchor page → `dropped_anchor_page_id`; model-written `vision` region text is never a candidate) + reading-order neighbours + prev/next chunks; then chunk_fts keyword search with `c.version_id IN (scope)` **in the same statement as MATCH** (filter before bm25/LIMIT). AND first, then OR hits that cover ≥ 50 % of the query terms. Synonyms/abbreviations only from the owner's `medical_term` rows (nothing seeded). Owner `source_priority[purpose]` orders the tiers (where search starts); every source with a hit keeps its best one (priority never decides a conflict); My Notes last. Returns `searched: SearchedReport` (versions, pages ready / unreadable / not processed, Arabic summary, `semantic: {used: false, reason_ar}`, expansions). |
| `abstainFor(ctx, result, scope)` | `unreadable_source` when nothing readable was searched; else `not_found_in_scope` with «بُحث في N صفحة…» and, for lecture-only with linked references, `suggest_scope` (applied only by an explicit owner action). |
| `fromRegion(ctx, regionId, {start?, end?})` | evidence row; quote = `region.text.slice(start,end)` (UTF-16, never splitting a surrogate pair), explicit offsets → idempotent per region+offsets. Refuses header/footer, text-less, rejected regions, model-written (`text_origin = 'vision'`) text and trashed sources. |
| `fromChunk(ctx, chunkId)`, `evidenceFromCandidates`, `buildEvidencePack(ctx, scope, ids)`, `packFromCandidates` | evidence for retrieval results; the pack gives aliases only to in-scope, non-deleted evidence whose region extraction is not rejected (others → `refused`). |
| `getViews / getViewsWithMissing / getView(ctx, ids, {pinnedVersionIds})` | `EvidenceView` with `locator_label_ar` («ص 12 (الصفحة 14 في الملف)», «شريحة 3», «فقرة 7», «الدقيقة 12:05») and `availability` (`source_deleted`; `version_replaced` when the version is not the active one unless pinned/frozen). |
| `async validateClaims(ctx, {ownerType, ownerId, sentences, aliasMap, scope, entailment?, jobId?, signal?, persist?})` | VERIFICATION_CHECKS `schema`, `evidence_exists` (unknown alias / raw id / fabricated id → rejected, AC-06), `in_scope` (foreign version, deleted source, region rejected/model-written since the pack was built, externally supplemented without an external scope → rejected, AC-05), `critical_tokens` (negations EN+AR incl. dropped NOT judged on what the NOT governs, dropped exceptions, numbers with Arabic-Indic digits / decimal commas / thousands, units incl. ×10⁹/L, %, °C, mmHg, IU, mL, Arabic unit words, number+unit quantities, thresholds >,<,≥,≤ and their EN/AR words checked as comparator+value PAIRS, populations, exceptions, Latin terms in Arabic claims, abbreviations — AC-07), `quote_containment` (original quotes verbatim; directly-stated ≥ 80 % content-word coverage, same language), `entailment` = an independent `ctx.ai` `verify_support` call (batched by 12, schema `{results:[{index, verdict, reason}]}`). Status: `linked` only if all deterministic checks pass AND the verifier says supported; verifier unavailable/failed/missing → `needs_review`; partial → `needs_review` (`partially_supports`); contradicted → `conflict` (`contradicts` + a `claim_unsupported` review item); failures → `rejected` (Arabic reasons). A sentence the GENERATOR labels `contradicted` goes to the verifier too: `conflict` only when the verifier confirms, otherwise `needs_review` cited as `context` (never shown as a confirmed conflict). A claim-less sentence that carries a value/threshold, or that is marked `original_quote`, is rejected. Persists `claim`, `verification_result` per check, and `citation` only for kept claims and only for valid in-scope evidence. |
| `getClaimViews / getClaimView / claimIdsForOwner / ribbonFor(ctx, ownerType, ownerId)` | `ClaimView`s (citations with current availability, failed checks as issues); ribbon = linked/owner-reviewed claims per source (an `artifact` owner includes its content blocks). |
| `recordDependencies(ctx, type, id, versionIds, regionIds?)` | idempotent `artifact_dependency` rows (regions resolved to their version). |
| `onSourceVersionChanged(ctx, {sourceId, fromVersionId, toVersionId, kind, pageIndexes?, jobId?, noteAr?})` | one `content_alert` + `content_alert_item` per dependent with impact `still_valid` / `needs_regeneration` (generated content whose cited text changed) / `needs_review` (questions, cards, or not comparable yet); non-frozen artifacts → `stale` with an Arabic reason; frozen ones (artifact frozen or Source Freeze on their version) keep their version and are listed with a warning. Same version + pages = re-processing. Called by the sources module on replacement upload. |
| `reconcileAlerts(ctx)` | lazy & idempotent (called by `GET /alerts`): completes pending comparisons once the new version is processed (text identical → `layout_changed`, severity `info`, items `still_valid`, artifacts stale only because of the pending comparison restored), and turns finished `reason: 'reprocess'` processing jobs into alerts (`ocr_corrected` / `source_updated`) via `content_alert_job`. |
| `compareVersions(ctx, from, to)` | deterministic `VersionChangeSummary` (pages changed, values/negations added/removed, text identical). |
| `cacheKey(ctx, input)` / `canReuse(ctx, type, id)` | §17 key = sha256 of kind + versions with content hashes + `scope.hash` + rules/generator/verifier versions + level/language/dialect/settings/params; reuse only if published, every dependency version exists, its source is not trashed and every cited region still exists (a re-processed page → not reusable even before its alert is reconciled). |
| `listAlerts / getAlert / setAlertStatus` | alert views (alerts written by other modules, e.g. purge, are shown from `affected_json`). |

### Routes (`/api/evidence`, owner session + CSRF like every `/api` route)
| route | |
|---|---|
| `POST /scope/resolve` | `ScopeResolveResponse {scope, sources[{origin, version_no, pinned, frozen, newer_version_exists, processing_status, low_assurance}], excluded[{reason_ar}]}` |
| `GET /alerts?status=active\|open\|acknowledged\|resolved\|all&source_id=&limit=` · `GET /alerts/:id` · `POST /alerts/:id/ack` · `POST /alerts/:id/resolve` | content change alerts (audited) |
| `GET /claims/:id` | `{claim: ClaimView}` |
| `GET /ribbon?owner_type=&owner_id=` | `EvidenceRibbonResponse` (+ «تغطية وليست مقياسًا للصحة الطبية») |
| `POST /batch {ids, pinned_version_ids?}` | `{evidence, missing}` (missing ids are never shown as citations) |
| `POST /from-region {region_id, start?, end?}` | `{evidence: EvidenceView}` (idempotent) |
| `GET/POST /terms`, `PATCH/DELETE /terms/:id` | the owner's medical term dictionary (`MedicalTermView`; synonyms/abbreviations used by retrieval and search; empty by default, audited) |
| `GET /:id?pinned_version_ids=` | `{evidence: EvidenceView}` |

### Migration `0300_evidence.sql`
`content_alert.from_version_id / acknowledged_at / details_json`, `content_alert_item` (per-dependent impact, frozen,
reason, versions), `content_alert_job` (re-processing jobs already turned into alerts), read indexes on evidence,
dependencies, claims, alerts. No existing migration edited.

### Search (`/api/search`, `apps/server/src/modules/search/`)
`GET /api/search?q=&mode=exact|keyword|semantic&types=chunks,questions,notes,generated,transcripts&source_type=&node_id=&source_id=&version_id=&limit=&cursor=` → `SearchResponse`.
* **chunks**: `chunk_fts` restricted (in the MATCH statement) to the active version (`frozen ?? current`) of live sources
  passing the filters (source type, library subtree incl. subject/course pointers, source, or an explicit version).
* **questions**: `question_fts` (one normalized row per question, filled by the questions track); trashed-only questions
  hidden; origin `source` / `generated` / owner → `owner_note`; snippet from `stem_raw`; location = first occurrence.
* **notes**: `owner_content_fts` entity `note` (normalized key written by annotations); snippet/title from the note;
  origin `owner_note`, `recognized` (handwriting), `generated` (saved AI answer).
* **generated**: `owner_content_fts` rows `entity_type ∈ {artifact, content_block, message}` with `origin = 'generated'`
  (contract for the study-book track: store the **normalized** key, like notes); snippet from the entity's RichText.
* **transcripts**: `owner_content_fts` entity `transcript_segment` (no producer yet → honest notice).
* exact mode = FTS phrase prefilter + `findExactPhrase` on the ORIGINAL text (`exact_rejected` counts the rest); no
  dictionary expansion is applied in exact mode, so `expansions` is empty there;
  highlights are UTF-16 ranges on the original text; FTS operators in input are quoted (data, not syntax).
* order: source results → owner notes / recognized → generated (labelled, `is_evidence: false`); opaque offset cursor.
* `mode=semantic` → 409 `FEATURE_DISABLED` with the reason; capabilities: `search.keyword` available,
  `search.semantic` `requires_configuration` (no embeddings provider/index), `evidence.citations` available.

## 2. Web

### `features/evidence` (import from `features/evidence/index.ts`)
| component | |
|---|---|
| `<CitationChip evidence context? onInspect?>` | design `SourceChip` labelled with `sourceChipLabel` («محاضرة ص12»); accessible name = chip text + source + both numberings; a real button: click / Enter / Space or a touch long-press opens the **Evidence Peek** (never hover-only), `aria-haspopup="dialog"`/`aria-expanded`; offline without a downloaded copy or deleted source → the chip says unavailable. |
| `<EvidencePeek evidence context? onInspect? onOpened?>` | quote in the reading face with the ink margin rule, source name / type / version, page label (printed + file page), support type, relation, extraction & verification status (`STATUS_LABELS_AR`, never «AI Verified»), availability; «افتح المصدر» → `openSourceLocation` inside the workspace (Source Jump & Back; a refusal is shown) or `/study/:id?v=&page=&page_id=&region=&bbox=` elsewhere; never a substitute page. Shown in a non-modal anchored panel (`AnchoredPanel`: focus moves in, Escape / Tab-out / outside click close, focus returns to the chip; docked to the bottom on phones). |
| `<SourceInspector evidence open onClose>` | Sheet with the peek + the page render: PDF via pdf.js (downloaded copy first, through the workspace's `loadPdfHandle`), page images, or the regions of unpaginated sources (DOCX) — with the cited region box drawn in the unrotated-page geometry (`normBoxToView`). |
| `<EvidenceRibbon items? owner?>` | sources used here with «جملتان مرتبطتان» counts + the coverage note; no percentages. |
| `<ArtifactContent artifact onWidenScope?>` | generated label, scope badge, frozen/stale/partial/draft status, blocks (headings, paragraphs, lists, labelled asides, original quotes, comparison tables) rendered run-by-run with bidi isolation; chips right after each claim's runs; `needs_review` / `conflict` / `rejected` / `pending` / unknown claims marked with text + icon + underline style; rejected blocks not rendered; coverage gaps; «جمل حُذفت…» disclosure; abstention with reason/detail and «وسّع النطاق» (owner action only); Source Inspector from a chip. |
| `<ScopeBadge scope detailed?>`, `<ScopePicker value onApply lectureSourceId? references?>` | Source Lock badge; picker = radio list of the four modes (external disabled with the capability reason), references, «ملاحظاتي» switch, live server preview (origins, versions, frozen/pinned/newer, exclusions with reasons); nothing changes until «طبّق النطاق». |
| `<ContentAlertsPanel sourceId? status?>` | alerts with severity (icon + text), kind, summary, changed file pages and values, affected items with impact and frozen warning; «اطّلعت عليه» / «تمت المعالجة». |
| `BidiText`, `BidiLines` | mixed text with highlights: runs are segmented on the whole text first, so a highlight never splits an LTR island. |

### `features/search` — `/search` (shell route, lazy)
Field (focused on open and with `/`), modes كلمات / مطابقة حرفية / دلالي (disabled with the server's reason), filters
(result types, source type, subject/course from the library tree), URL-driven state, results grouped by type with
origin badges («من المصدر» / «ملاحظتي» / «مقروء آليًا» / «مولَّد — ليس دليلًا»), page labels and links to the exact
version/page/region, notices, expansions, «نتائج أخرى». Offline → local search over this device's Dexie notes
(`normalizeForSearch` key) with «يُبحث في ملاحظاتك المحفوظة على هذا الجهاز فقط…».

## 3. Tested (commands run, real results, 2026-10-09)

| command | result |
|---|---|
| `npm test -w @medlevo/server` | builder run: **28 files, 434 passed** (all tracks). After the review (§6): **28 files, 446 passed**; this track `critical.test.ts` 20, `scope-retrieval.test.ts` 19, `claims.test.ts` 14, `evidence-alerts.test.ts` 13, `search.test.ts` 9 — Golden Set fixtures processed by the real pipeline. |
| `npx tsc -p apps/server --noEmit` | exit 0 |
| `npm test -w @medlevo/web` | **35 files, 302 passed** (this track: `features/evidence/{model,ArtifactContent,EvidencePeek}.test.*`, `features/search/search.test.tsx` — 37 tests) |
| `npx tsc -p apps/web --noEmit` | 1 error, **not in this track**: `src/features/questions/QuestionDetailScreen.tsx(71,35)` (`message` not in `ToastOptions`) — the parallel questions track's in-progress file. No errors in `features/evidence` / `features/search`. |
| `npm run build -w @medlevo/web` | success (`SearchScreen` chunk 12 kB / 4.9 kB gzip) |
| `node apps/web/src/features/search/real-server-check.mjs <out>` (REAL server on a throwaway data dir serving `dist`, plus the Vite dev server for the evidence harness; Chromium `/opt/pw-browsers/chromium`; 390×844 and 1280×800, light + dark) | **52/52 checks passed**: real upload + processing of two Golden Set PDFs, note synced; «الالم» finds and highlights «الألم» with «ص 11 (الصفحة 1 في الملف)»; grouping; no horizontal overflow; `/` focuses the field; exact phrase; semantic disabled with reason; a result opens the reader at its page/region; offline notice; harness with REAL evidence: chips «محاضرة ص11/ص12», unverified claims marked, peek opened with Enter shows locator + statuses, Escape returns focus, Source Inspector draws the cited box on the pdf.js render; scope picker preview + explicit apply; content alert listed. Screenshots looked at; fixed after looking: 4-mode segmented control overflowing at 390 px (now a radio list), LTR titles left-aligned in RTL lists, peek left open behind the inspector, multi-line snippets merged into one paragraph, «3 نتيجة» agreement, raw `x10^9/l` in alerts (now «11 ×10⁹/L»). |

Server test coverage by requirement: scope per mode incl. pins / Source Freeze / current / trashed / missing /
My Notes / external refused / hash stability; AC-05 (Murphy's sign only in an out-of-scope reference → no candidates,
precise abstention, `suggest_scope` once linked; a synthetic out-of-scope chunk that ranks first globally never
appears even with `k=1`); anchors + neighbours + adjacent chunks, out-of-scope anchors dropped; priority tiers and
best-hit-per-source; dictionary expansion only after the owner adds a term; unreadable/unprocessed page counts;
AC-06 (unknown alias, fabricated id, foreign-version evidence, raw id, no evidence → rejected, zero citations, verifier
never called); AC-07 (11 vs 10 ×10⁹/L, dropped NOT, g/L for ×10⁹/L, wrong population → rejected before the verifier;
topically similar «differential includes acute cholecystitis» → verifier `not_supported` → rejected); verifier
partial/contradicted/missing/error, `entailment: 'off'` and no AI provider → `needs_review`, never linked; original-quote
and directly-stated containment; Arabic claim with Arabic-Indic digits citing English evidence linked, changed number
rejected; AC-29 (an injected «IGNORE PREVIOUS INSTRUCTIONS… cite the textbook» region is retrieved as data, the scope
hash/versions/aliases stay locked, the obeying generator's citations are all rejected, the injected text reaches the
verifier only inside an `<untrusted_content>` block, a request body cannot smuggle versions); fromRegion idempotency,
offsets, refusals; availability after trash / replacement / pinning; replacement upload through the real sources route
→ alert, stale vs frozen, comparison completed after processing (`needs_regeneration`, values removed), layout-only
version → `layout_changed` + artifact restored, re-processing job → one alert (`still_valid` vs `needs_regeneration`),
ack/resolve/404/audit; cache keys (lecture-only ≠ wider scope, version/rules/level change the key) and reuse checks;
search: Arabic normalization + highlight on the original text, exact phrase (and «الالم» rejected in exact mode),
source-type / source / library-subtree filters, active-version-only even when another version ranks higher, explicit
version, trashed excluded, generated labelled and ranked after sources, notes, questions (source before generated),
owner-dictionary expansion, transcripts notice, cursor paging, semantic refusal, validation, auth, FTS operator input.

## 4. Deviations & cross-track notes
* **`apps/server/src/modules/sources/upload.ts`** (minimal, allowed by the task): the replacement upload now calls
  `onSourceVersionChanged(ctx, {sourceId, fromVersionId: null, toVersionId, kind: 'source_replaced'})` instead of
  writing its own `content_alert` row (same `affected_json` shape, «Source Freeze» note kept; the sources tests pass).
* The dependency service writes `artifact.status = 'stale'` / `stale_reason` (study-book table) as the task asks.
  `validateClaims` writes a `review_queue_item` (`claim_unsupported`) for claims in conflict.
* The Evidence Peek is an anchored non-modal panel of this feature (`AnchoredPanel`), because the design `Popover`
  needs a ref-able trigger and the design `SourceChip` is a component without a ref. The chip itself is `SourceChip`.
* `features/evidence/dev/harness.{html,tsx}` is a dev-only page (Vite dev server); it is not in the production build.
* No owner setting for external evidence exists in `shared/settings.ts` (not this track's file), so `external` is always
  refused with the reason; `externalEvidenceEnabled()` reads a future `external_evidence_enabled` key unchanged.

## 5. Not done / known limits (honest)
* **Semantic retrieval/search** (embeddings) — not built; reported as not used / `requires_configuration`.
* **Entailment** needs an AI provider (none in this environment): every claim is `needs_review` until one exists; the
  verifier path is tested only with the test-only `FakeAiProvider` (no real model was run).
* Critical-token rules are deterministic heuristics (EN + AR word lists, unit table): they refuse obvious mismatches, they
  do not prove support. Cross-language negation/paraphrase is left to the verifier (only presence is checked); unusual
  units or Arabic phrasings outside the lists are not recognized.
* `directly_stated` containment is checked only between same-language texts; translations go to the verifier.
* Version comparison is text-level (normalized region texts per page): a re-flowed but identical text is a layout change;
  a moved sentence across pages is reported as a page change. Re-processed pages get new region ids, so dependents on
  those pages are flagged (we cannot compare against the replaced text).
* Retrieval candidates carry whole chunks/regions; there is no reranker. OR hits need ≥ 50 % term coverage (a very short
  query with one rare term can miss a paraphrased passage).
* Search ranks across FTS tables by bm25 within each origin group (scores of different tables are not comparable); the
  cursor is an offset (results inserted meanwhile can shift a page).
* The Universal Search filters are server-side for chunks/questions; notes/generated are filtered after the FTS query,
  so a heavily filtered page may return fewer than `limit` items.
* The web components are integrated only in `/search` and the dev harness; mounting `ArtifactContent`, `ScopePicker`,
  `ContentAlertsPanel` in the study workspace / Study Book / Control Center belongs to those tracks.
* Not run: real iPad/iPhone Safari, VoiceOver/NVDA, axe/Lighthouse.

## 6. Independent adversarial review (2026-10-09)

A second agent re-read every file of this track, probed the checks with adversarial inputs (scratch scripts and
a scratch Golden-Set test, removed afterwards) and fixed what it could confirm. Each fix has a regression test
named «review regressions (C1 adversarial review)» in the test file listed.

| severity | finding (confirmed) | fix | test |
|---|---|---|---|
| major | Arabic thresholds containing ى/ئ/أ («أعلى من», «على الأقل», «على الأكثر», «يزيد على») and the Arabic units «درجة مئوية» / «بالمئة» never matched: the text is normalized (ى→ي, ئ→ي) but the patterns were not, so «الحرارة أعلى من 38» citing «أقل من 38» passed `critical_tokens`. | every Arabic pattern is rewritten to the normalized letter forms (`arRe`, units too); «دون + number» = below | `critical.test.ts` |
| major | thresholds were compared as a SET of comparators: «WBC > 11 and CRP < 10» passed on evidence «WBC < 11 and CRP > 10». | comparator+value pairs (`thresholds: ['gt 11', …]`) must occur in the evidence | `critical.test.ts` |
| major | dropped-NOT false positives removed valid sentences: «Ultrasound, not CT, is first-line» or «Antibiotics alone, without surgery, may be used» made the plain affirmative claim fail as «the evidence negates it». | a negated clause counts only when the claim asserts what the NOT governs (≤ 3 words after it up to punctuation; before it for postfix «absent»); consistent EN stemming (exclude/excludes/excluded); «ولا/فلم…» handled as negations | `critical.test.ts` |
| major | an `original_quote` sentence with `claim: null` was kept as plain text — a fabricated «original quote» was never checked against any source. | rejected (`quote_containment`) and listed in `removed` | `claims.test.ts` |
| major | a sentence the GENERATOR labelled `contradicted` skipped every check and the verifier and was stored as `conflict` with a `contradicts` citation — an unverified attribution («the source contradicts this»). | goes to the independent verifier: `conflict` only when it confirms; otherwise `needs_review`, cited as `context` | `claims.test.ts` |
| major | default references of «المحاضرة + المراجع» (and `suggest_scope`) used `reference_for` links in BOTH directions, so a source the lecture is a reference *for* (another lecture) entered the lock. | only incoming links «R reference_for lecture» | `scope-retrieval.test.ts` |
| minor | the schema allows model-written region text (`text_origin = 'vision'`); `fromRegion`/retrieval would have turned it into evidence (no producer yet — latent). | refused by `fromRegion`/`fromChunk`, excluded from retrieval candidates | `evidence-alerts.test.ts` |
| minor | evidence whose region was rejected after the pack was built could still be cited. | pack refuses it; `validateClaims` rejects it under `in_scope` | `claims.test.ts` |
| minor | `canReuse` ignored deleted cited regions (page re-processed) until someone opened the alerts list. | region-level dependencies must still exist | `evidence-alerts.test.ts` |
| minor | content-block dependents: never marked frozen through their frozen artifact in the alert, and a layout-only change never restored their artifact (restore matched block ids against artifact ids). | frozen via the parent artifact; restore per artifact when it and all its listed blocks are still valid | `evidence-alerts.test.ts` |
| minor | dropped exception («All are risk factors» citing «… except obesity») passed. | clause-level check like the dropped NOT (scope = what is excepted) | `critical.test.ts` |
| minor | an out-of-scope anchor PAGE was silently ignored. | `dropped_anchor_page_id` | `scope-retrieval.test.ts` |
| minor | exact search reported dictionary expansions it did not apply. | `expansions: []` in exact mode | `search.test.ts` |
| minor (web a11y/honesty) | why a claim needs review (e.g. «لم يُجرَ التحقق المستقل… ANTHROPIC_API_KEY») was only in a hover `title`. | «لماذا؟» button (`aria-expanded`/`aria-controls`, 44 px hit area) reveals the reason as a note | `ArtifactContent.test.tsx`, browser check |
| minor (web) | «إعادة المحاولة» after a search error did nothing (same URL → effect not re-run). | retry counter | `search.test.tsx` |
| minor (web) | offline exact mode searched notes with keyword rules. | `searchNotesLocally(…, 'exact')` uses `findExactPhrase` | `search.test.tsx` |
| minor (web) | overlapping highlight ranges printed text twice in `BidiText`. | cursor-clamped cuts | `search.test.tsx` |
| minor (web hardening) | `RunNode` turned any `marks` string of stored content into an element. | only the RichText contract marks (b, i, u, sup, sub, em) | `ArtifactContent.test.tsx` |

Checked and found sound (no change): Source Lock in every retrieval statement (the version filter is in the
same SQL statement as MATCH; anchors, neighbours and adjacent chunks are version-filtered), alias validation
(own-property lookups only; unknown alias / raw id / fabricated id / foreign version never become citations),
entailment unavailable/failed/missing → never `linked`, availability (`source_deleted`, `version_replaced`),
search highlights on the original text (harakat, lam-alef presentation forms, full-width Latin probed), FTS
operator input quoted, auth/CSRF on every route, no `dangerouslySetInnerHTML`/`innerHTML` in the web parts.

Review commands (real results): `npm test -w @medlevo/server` → 28 files, **446 passed**; `npm test -w @medlevo/web`
→ 37 files, **316 passed** (this track 42); `npx tsc -p apps/server --noEmit` → exit 0; `npx tsc -p apps/web --noEmit`
→ exit 0; `npm run build -w @medlevo/web` → success; `node apps/web/src/features/search/real-server-check.mjs <dir>`
(real server + Chromium `/opt/pw-browsers/chromium`, 390×844 and 1280×900, light/dark) → **60/60** (52 earlier checks
plus the new «لماذا؟» reason and no-overflow checks); screenshots looked at.

Remaining risks after the review (not fixed):
* A medical sentence that the generator marks `claim: null` and that carries no value/threshold is kept as
  connective text — the server cannot decide «medical» reliably; generators must follow the contract.
* The critical-token rules stay heuristics: number words («eleven», «أحد عشر»), unusual units, cross-language
  negation/exception and paraphrased polarity are left to the verifier (without one every claim is `needs_review`).
* `/batch` and `/:id` accept caller-supplied `pinned_version_ids`, which make a replaced version read as available
  (display only; artifacts pass their own frozen versions).

