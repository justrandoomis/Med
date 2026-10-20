# Course Brain — topics, knowledge structure, maps, coverage (track F2)

Spec: §05 (topics, library filter, correctable extracted topics), §16 (Lecture Compilation & Course Brain), §23 (course
page: lectures, references, question sources, **map and progress**), §31 (interactive Knowledge Map), §36 (Question
Coverage Map), §44 (Student Knowledge Map; Weakness Center across MCQ / cards / written / **cases / OSCE**).

Everything in this track is **deterministic — no AI**. Nothing here generates medical text: the knowledge structure is
read from the lecture's own regions, every stated mention points at its region with the exact text, and anything the
text does not state (a prerequisite, «differential of») is stored as `support = 'inferred'` with its reasons and shown
as «مستنتجة — ليست نصًا من المحاضرة».

## Server — module `brain` (`apps/server/src/modules/brain`, mounted at `/api/brain`)

| file | role |
|---|---|
| `extract.ts` | pure extractor (unit-tested): headings → concept + section; definition / classification sentences (EN «is defined as / refers to / is a … / is classified as», AR «يُعرَّف … بأنه», «تُصنَّف … إلى», «… هو / هي»); subjects of statements inside a section («Ultrasound is the first-line …» under «Investigations» → `investigation`); enumerations («includes A, B and C», «يشمل»); short list items in a section; first column of tables (`value` when the row has a number + unit / threshold, a table never inherits the section before it); captions → the concept they are about; learning objectives kept as **objectives** (never concepts); headers / footers / question regions / child cells are never read. Bilingual headings («Acute Appendicitis — التهاب الزائدة الدودية الحاد») name ONE concept with both names. |
| `run.ts` | the `extract_knowledge` job body: replaces the version's stated mentions (idempotent), finds concepts by name / alias (merges followed), creates new suggestions, joins two undecided candidate halves of a bilingual heading, records `concept_extraction` (counts, roles, sections, objectives), then (Round 7 H4) marks the course's relation state stale and enqueues the background `brain.recompute_relations` job (synchronous recompute only when no job runner is registered), and refreshes the topic suggestions. |
| `resolve.ts` | concept identity for BOTH extractors: aliases (old names after a rename, names of merged concepts) and `merged_into_id` chains. The questions module's candidate extractor uses `findConceptByName` too, so an owner rename / merge is never undone by a candidate run. |
| `relations.ts` | inferred relations per course group (same grouping as question matching: course → subject → folder): «defined earlier, used later» (A has a definition / classification in an earlier lecture and appears — stated mention or by name in the text — in a later lecture that does not define it → A *prerequisite* of that lecture's title concept) and «listed under Differential diagnosis» (X *differential_of* the lecture's title concept). Each suggestion carries reasons with exact locations (source, page label, region, quote). Owner relations (`origin owner`, accepted), accept / reject / delete (a deleted suggestion becomes `rejected` and is never suggested again; undecided suggestions whose basis disappeared are removed; decided ones are never touched). Course order = the library's manual order, then upload order. |
| `concepts.ts` | correction view: list (scope course / source / all, status filter, counts of rejected & merged — never hidden silently), detail with every mention, patch (status, rename — old names become aliases, a clashing rename is refused with a pointer to merge —, kind, note), owner-created concept, merge (mentions, relations, names and aliases move; the merged concept stays as a pointer). |
| `lecture-questions.ts` | the questions of a lecture: source questions = `question_lecture_link` (not rejected, not «course_related_only»; pages = the matcher's `lecture_page_ids` of the study version); generated questions = published candidates of generation runs on the lecture (pages from their evidence); concepts per question with their basis (matcher / name in the question text / generated evidence). |
| `coverage.ts` | Question Coverage Map — pure `computeCoverage` (unit-tested) + loader: per page and per concept → source questions, generated questions (separate), attempted, uncovered; `CoverageCount` always carries `total` (denominator). |
| `student.ts` | Student Knowledge Map — pure `classifyKnowledge` (unit-tested): `needs_work` (active weakness or estimate < 0.5) · `strong` (≥ 0.8) · `developing` (≥ 0.5, or an improving weakness) · `practicing` (attempts / card reviews below the AC-27 sample of 3) · `read` (pages of the concept viewed in the reader) · `not_started`. Mastery = `learning/progress.masteryEstimate` over scored attempts on the concept's questions (profile resets honoured); prerequisites with their own state and the inferred label; reasons and a next step per concept. |
| `map.ts` | knowledge map graph: lecture / concept / question nodes, `mentions` (stated, with pages), `covers` (question ↔ concept with basis), `relation` (owner / inferred, never rejected). Large courses are cut to 60 concepts / 40 questions, ranked (accepted, defined, linked to questions, mentioned more) with the totals reported. |
| `topics.ts` | topic suggestions (a topic whose title names a concept → the concept, the sources where it is a heading / definition, those regions, and questions whose text names the topic) through the library's `suggestTopicLink`, which never overrides an owner decision; topic detail with every link resolved (label, page, href, «why»); topic list with counts. |
| `course.ts` | course page status (per lecture: processed, extraction current / older extractor, objectives with page labels, latest job), one-time backfill of sources processed before the module existed, manual re-extraction, relation refresh when the course order / extractions / merges changed. |

### Routes (owner session + CSRF; zod on every input)

| route | |
|---|---|
| `GET /courses/:nodeId` | `CourseBrainResponse` |
| `POST /extract {source_id \| course_node_id}` | enqueue `extract_knowledge` (unprocessed sources skipped with the reason) |
| `GET /concepts?course_node_id=&source_id=&status=&q=` · `POST /concepts` · `GET/PATCH /concepts/:id` · `POST /concepts/:id/merge` | correction view |
| `GET /relations?course_node_id=&concept_id=&status=` · `POST /relations` · `PATCH/DELETE /relations/:id` | relations |
| `GET /map?course_node_id=&source_id=` | knowledge map |
| `GET /coverage?course_node_id= \| source_id=` | Question Coverage Map |
| `GET /knowledge?course_node_id=` | Student Knowledge Map |
| `GET /topics` · `GET /topics/:id` · `POST /topics/suggest {topic_id?}` | topics (CRUD and link decisions stay on `/api/library/topics…`) |

### Data — migration `0800_course_brain.sql` (range 0800–0849)

`concept` + `merged_into_id`, `name_origin`, `kind_origin`, `owner_note`; new `concept_alias` (unique normalized
alias); `concept_mention` + `support` ('stated'), `quote`, `section`, `extractor_version`, index (version, role), trigger
`brain_region_mentions_bd` (a re-processed page's regions can be replaced: stated mentions are derived and re-extracted
by the follow-up job — like the questions trigger for candidate mentions); `concept_relation` + `origin`, `reasons_json`,
`course_node_id`, `note`, `updated_at`, unique (from, to, relation); new `concept_extraction` (one row per version,
`ON DELETE CASCADE` so the sources purge needs no change). Ownership: the brain module owns `concept_alias`,
`concept_extraction`, `concept_relation` and the stated mentions; the questions module keeps writing candidate mentions
(`role 'candidate_*'`) and its matcher reads **only** those, so question matching is unchanged by this track.

**`0801_brain_relation_reasons_purge.sql`** (review F2): trigger `brain_version_relation_reasons_bd` — when a source
version is deleted (the sources purge), every relation reason that points into it is dropped; an undecided suggestion
left without reasons is deleted, a decided one (accepted / rejected / owner) keeps the decision with a neutral
`basis_removed` reason. No sentence, title or location of a purged lecture survives in `concept_relation`.

### Hooks into other modules (all additive)

* processing `pipeline.ts`: `enqueueKnowledgeFollowUp` after a study source is processed (guarded like the question hook).
* questions `concepts.ts`: candidate lookup through `findConceptByName`; `lectureConcepts` restricted to candidate
  mentions and live (not merged) concepts, and one matcher entry per NAME (English, Arabic, names absorbed in a merge)
  so a bilingual join / merge never drops a name question matching used (review F2; the Golden Set links are identical
  with and without the brain module).
* library `tags.ts`: owner topic links validated (known entity type, existing row → 400 / 404).
* learning `weakness.ts`: reads `cases/signals.caseSignals` — each checklist item / viva point of a completed attempt is a
  signal of type `case | osce | viva`, grouped by the case (`WeaknessKind 'case'`, action `retry_case`) and by the
  sources of its evidence (never by a similar name); met = weight 0.6 (a checklist estimate is never a confident
  independent recall), missed = −0.6; excludable like other signals; the input signature covers case attempts / events.
  Merged concept ids in matcher links resolve to their target (`weakness.ts`, `dna.ts`).
* cases `signals.ts`: viva points carry type `viva`.

## Web — `apps/web/src/features/brain`

* **Course page** (`features/library/NodeScreen.tsx` → `CourseBrainTabs`): tabs «المصادر / خريطة المعرفة / التقدم /
  تغطية الأسئلة» (`?tab=`). Map tab: extraction status per lecture (real job states, polling while jobs run, «أعد
  الاستخراج»), objectives, links to the correction view and the Student Knowledge Map, the knowledge graph.
* **`KnowledgeGraph`**: three columns of real `<button>`s (44 px, roving tab stop; ↑/↓ inside a column, ←/→ to the
  linked node of the adjacent column — RTL-aware via `navKeyFor`; Home/End; Enter/Space selects; Esc clears; focus moves
  with `preventScroll` and only the map's own scroller + the window are scrolled), an `aria-live` details panel (pages as
  reader links, question basis, relation labels with «مستنتجة»), and the **text twin** (same lectures, concepts, pages,
  questions, relations) — the default view on phones. Edges: dataviz «emphasis» form — selected links in the accent,
  the rest neutral hairlines; inferred relations dashed AND labelled. Palette check with the dataviz validator: accent
  `#3A47A8` / neutral `#7E848E` on paper `#FFFDF8` (light), `#7E8AE8` / `#807D76` on `#1D1C1A` (dark): contrast ≥ 3:1,
  CVD ΔE ≥ 16; the «chroma floor» FAIL is expected — the neutral is the de-emphasis gray, not a categorical slot.
  Node identity = column + icon + shape (squared lecture, pill concept, rounded question) + words, never colour.
* **`ProgressView`** (GET `/api/learning/progress`): reading, explanation coverage, practice and the mastery ESTIMATE
  as four separate measures (bars only where a denominator exists — `BarList` with its table twin).
* **`CoverageView`**: totals with denominators (pages, non-rejected concepts), page cells and a concept table, statuses
  as icon + words («لها أسئلة من المصادر / أسئلة مولدة فقط / بلا أسئلة»).
* **`/concepts?course=&source=`** (correction view: accept / reject / restore, rename dialog, merge dialog, new concept,
  relations with reasons and links to the defining / using location, accept / reject / delete, new owner relation) and
  **`/concepts/:id`** (every mention with its exact quote, page link, role and section; link the concept or one of its
  places to a topic).
* **`/library/topics`, `/library/topics/:id`**: topic tree with counts; create / edit / delete (impact stated); suggested
  links with «لماذا»; accept / reject / restore / unlink; link a source, a place in a source (source → page → region,
  chosen by its text; headers / footers / table cells / options not offered) or a question (search) by hand; «اعرض المكتبة
  مصفّاة بهذا الموضوع». **Library filter**: `/library?topic=<id>` (`TopicFilterView`) + «تصفية بموضوع» select and a
  «الموضوعات» button on the library screen; suggested links are marked as such.
* **`/knowledge?course=`** — Student Knowledge Map: counts per state (icon + words), per concept: state, reading,
  practice, mastery text («تقدير: 80% (من 3 إجابات)» / «لا تقدير بعد …»), prerequisites with their state and the
  inferred label, «لماذا هذه الحالة؟», next step with a reader link. Linked from the Weakness Center.
* Weakness Center: kind «حالة / OSCE / شفهي», signal type «امتحان شفهي», action «أعد محاولة …» (→ `/cases/:id`).

### Accessibility review of the maps (WCAG 2.1 AA, `design:accessibility-review` checklist)

| criterion | how it is met | checked by |
|---|---|---|
| 2.1.1 Keyboard · 2.4.3 Focus order | one tab stop into the graph, arrows / Home / End / Enter / Esc inside it; dialogs trap and return focus (design `Dialog`) | `brain.test.tsx`, `e2e/f2-course-brain.spec.ts` (keyboard only) |
| 4.1.2 Name, role, value | nodes are `<button>`s named «النوع: الاسم — الوصف — عدد الروابط», `aria-pressed` for the selected one; the graph is a labelled group with instructions (`aria-describedby`) | `brain.test.tsx` |
| 1.3.1 Info and relationships | the text twin and the coverage / progress tables carry everything the drawing shows | `brain.test.tsx` |
| 1.4.1 Use of colour · 1.4.11 Non-text contrast | states and statuses are words + icon; node type = column + shape + icon + words; edge colours ≥ 3:1 on both surfaces (dataviz validator) | validator run, `brain.test.tsx` |
| 2.5.5 Target size | nodes and actions ≥ 44 × 44 px | CSS (`NODE_PX`, design buttons); E2E screenshots at 390 px |
| 4.1.3 Status messages | the details panel is `aria-live="polite"`; toasts for decisions | `brain.test.tsx` |

Not verified: a real screen reader (VoiceOver / NVDA) and 200 % zoom — no device or AT here.

## Review F2 (adversarial review) — fixed

| issue | severity | fix | regression test |
|---|---|---|---|
| heading section words were cut out of the MIDDLE of a heading, so a «stated» name was not in its quote («Cardiac drug toxicity» → «Cardiac toxicity», «Type 2 Diabetes Mellitus» → «2 Diabetes Mellitus», «Drug-induced …» → «induced …») | major | `headingConceptPart` strips section words at the edges only (whole words; «Type / Class + number» kept); `trimStructural` keeps «Type 2 …» | `srv:brain/review.test.ts` (names + an invariant: every name is a contiguous run of its quote) |
| a purged lecture's sentences, title and locations stayed in `concept_relation.reasons_json` (readable at `GET /relations`) | major | migration `0801` trigger (above) | `srv:brain/review.test.ts` (real purge route) |
| large courses: the in-process relation recompute was quadratic with a DB query per mention / pair — ≈ 4.7 s per recompute and ≈ 6 s for the 30th lecture's extraction job on a 30 × 20-page course, and the course page recomputed again after every job (≈ 5.3 s) | major | memoised lookups, regions read once per lecture, an exact substring prefilter before the per-region regex, unchanged reasons not rewritten, the job remembers the state it computed for (`recomputeCourseRelations`) — same result (asserted), recompute ≈ 0.9 s, last extraction ≈ 1.2 s, course page ≈ 0.1 s after the jobs | `srv:perf/brain-course.perf.test.ts` (opt-in `MEDLEVO_PERF=1`; asserts the recompute is idempotent) |
| a merge dropped the moved row's owner decision when the target already had the same relation undecided (a rejected prerequisite came back as «suggested») | major | `mergeCore` keeps the decided row | `srv:brain/review.test.ts` |
| a bilingual join made question matching see only the English name of the joined concept (Arabic question text lost its concept hit) | minor | `lectureConcepts` emits one entry per name | `srv:brain/review.test.ts` |
| the concept page mixed quotes of superseded versions with the study version's | minor | study version only (like the list) | `srv:brain/review.test.ts` |
| the 1 500-mention cap per version was silent (a long textbook's later chapters had no concepts, nothing said so) | minor | `counts.mentions_found`, a course-page note and a «مستخرج جزئيًا» pill | `srv:brain/review.test.ts`, `brain.test.tsx` |
| an accepted inferred prerequisite was labelled «مقترحة»; a prerequisite rejected as a concept was still listed | minor | `prerequisiteLabel` («مستنتجة — قبلتها»); rejected concepts skipped | `brain.test.tsx`, `srv:brain/review.test.ts` |
| owner-added questions were counted as «أسئلة من المصادر» without saying so | minor | a coverage note says so | `srv:brain/review.test.ts` |
| the coverage view crashed when the chosen lecture vanished on refresh; the text twin lacked the basis of question → concept links; the differential reason's location link was called «موضع الاستخدام» | minor | fallback to the whole course; basis shown in the twin; «موضع ذكره» | `brain.test.tsx` |
| an extraction finishing after its source went to the trash failed the job | minor | course follow-ups skipped for a trashed source | `srv:brain/review.test.ts` |
| a topic's merged concept was suggested as the pointer | minor | resolved to the live concept | — (one-line resolve) |

## Tests

* `apps/server/test/brain/extract.test.ts` — extractor rules (EN + AR definitions, classification, sections, enumerations,
  values, tables, captions, objectives, what is never read).
* `apps/server/test/brain/relations.test.ts` — inferred prerequisite with reasons + exact locations, differential_of,
  bilingual heading, Student Knowledge Map prerequisite, Source Lock not widened (`/evidence/scope/resolve`), owner
  decisions on relations and concepts survive re-extraction (reject / accept / owner relation / delete / rename → alias /
  merge / clashing rename refused), the questions candidate extractor resolves renamed names, order change, validation,
  auth / CSRF.
* `apps/server/test/brain/golden.test.ts` — the REAL pipeline on the Golden Set: processing hook → extraction, objectives,
  concepts with roles / pages / exact quotes, DOCX classification EN + AR on one concept with «قسم 2» (no invented page),
  every stated quote really in its region, matching unchanged, re-processing keeps decisions, coverage (denominators,
  generated separate, attempted), knowledge map integrity, Student Knowledge Map states (not started → read → practicing →
  strong; needs work), topic suggestions and decisions, validated owner links, OSCE + viva signals in the Weakness Center
  (own types, case weakness, retry action, exclusion).
* `apps/server/test/brain/math.test.ts` — coverage math and knowledge-state rules.
* `apps/server/test/brain/review.test.ts` — the review F2 regressions (table above).
* `apps/server/test/perf/brain-course.perf.test.ts` — opt-in (`MEDLEVO_PERF=1`) large-course timing + idempotent recompute.
* `apps/web/src/features/brain/brain.test.tsx` — map layout + keyboard model, graph a11y (one tab stop, RTL arrows,
  Enter / live panel / Escape, text twin), correction view decisions, Student Knowledge Map labels, coverage statuses and
  denominators, topic page decisions, linking a region by hand (source → page → region; page furniture not offered),
  the Weakness Center case kind label and `retry_case` link.
* `e2e/f2-course-brain.spec.ts` (phone 390 × 844 + desktop 1280 × 800, real server): course page tabs, the map driven by
  the keyboard, text twin, progress, coverage, a rejected concept surviving re-extraction, topics with suggestions /
  decisions / library filter, Student Knowledge Map, an OSCE attempt in the Weakness Center.

## Round 7 H4 — knowledge links, algorithms, prose relations, background recompute, resets

**1. Topic links for clinical cases, explanations and attempts.** `topic_link.entity_type` (validated in
`library/tags.ts`, labels in `TOPIC_ENTITY_TYPE_LABELS_AR`) gains `clinical_case`, `artifact` (an explanation / chat
answer / summary), `exam_attempt` and `case_attempt`. `brain/topics.ts` resolves each to a title, a kind label, a state
(generated / owner, in the trash, «توجد نسخة أحدث» for a stale explanation, «صحيحة X من Y مُقيَّمة» for an exam attempt,
«تقدير got من max» for a case attempt) and an href; a link to something deleted says so instead of disappearing. Cases
are suggested when the topic's name is in the case title (reason «اسم الموضوع في عنوان الحالة.»), never linked
automatically. `GET /api/brain/topics/:id` adds `attempts` — the owner's past attempts reached through the topic (linked
directly, or through a linked question / case), newest first, capped at 50 with the total. Web: the topic screen shows
«محاولاتي السابقة» and «اربط حالة»; a case page, a case report, an exam result and the new explanation page
(`/explanations/:artifactId`, `features/studybook/ArtifactScreen.tsx`) carry `TopicLinksControl` (link / accept / remove).

**2. Algorithms and flowcharts as knowledge structure** (`brain/algorithms.ts`, `ALGORITHM_EXTRACTOR_VERSION =
'algo-1'`). From the processed regions of a lecture: numbered steps under a procedure heading, «If … then …» / «إذا …
فـ…» rule lists with their printed «Otherwise / وإلا» branch, arrow chains («A → B → C»), decision lists, and flowchart
FIGURES whose labels were read by OCR. Every node is the exact printed text with its region (a link to the place);
certainty is `stated` for digital text, `uncertain` when OCR-only, `owner_reviewed` when the owner reviewed the figure
reading (F3) — only then are the figure's arrows used. A flowchart figure without a reviewed reading lists its labels and
draws NO arrows («الأسهم واتجاهها غير مقروءة»). Nothing is invented: no step, branch or arrow that is not printed.
Stored in `knowledge_algorithm` (migration `0810_brain_algorithms_statements.sql`), shown by `GET /api/brain/algorithms`
(exactly one of `source_id` / `concept_id` / `course_node_id`) on the concept page and the course page
(`AlgorithmList.tsx`: an ordered list for steps, rules with their branch word, figure labels; certainty in words).

**3. Relations stated in prose** (`brain/prose.ts`, `PROSE_EXTRACTOR_VERSION = 'prose-1'`): «X causes / can cause / is
caused by / results from Y», «X is treated with Y», «Y is the treatment of X», «Y is used to treat X», «X is a
complication of Y», «Complications of Y include X, Z», and the Arabic «يسبب / يؤدي … إلى / ينتج عن / يُعالج … بـ / علاج
X هو Y / من مضاعفات / تشمل مضاعفات». Guards: negations and hedges («does not cause», «لا يسبب», «rarely»), objective
sections («Describe …»), generic names («the patient», «this», «المريض») and names that are not exact substrings of the
sentence are skipped. A match is stored in `concept_relation_statement` with the sentence quote, page, region, language
and pattern (OCR text → `uncertain`), and becomes a suggested relation with support **`stated`** and a reason
`stated_in_text` (the exact sentence, «موضع الجملة»). New relation kind `complication_of` («مضاعفة لـ»). Owner decisions
are never overwritten. Tested on synthetic positives / negatives in both languages (negation, «rarely», pronouns,
generic subjects, questions, objectives, clause boundaries, OCR) and on the Golden Set, whose lectures state no relation
in these forms — nothing is extracted there (no false positive; the real pipeline is run in `golden.test.ts`).

**4. Relation recompute as a background, incremental job.** Extraction no longer recomputes the course's inferred
relations inside the request / job: it marks the course's relation state stale and enqueues `brain.recompute_relations`
(idempotent per course + signature; one per course at a time). The recompute keeps per-database caches (facts keyed by the
extraction's `updated_at` + mention ids, a token n-gram index of regions keyed by count / max id / text length /
`updated_at`, usage counts) so a change to one lecture re-reads only that lecture, and runs in ≈ 20 ms slices that yield
to the event loop (the write is one transaction). The course page shows «تُحدَّث العلاقات…» while `relations_state =
refreshing`, and polls. Regex compilation per concept name was the cold-run bottleneck; `occursAsWord` replaces it
exactly (equivalence test). The question ↔ concept name match of `lectureQuestions()` (map, coverage, student
knowledge) compiled the same per-concept regexes: with the recompute no longer warming V8's regexp cache, the FIRST map
after a restart took ≈ 1.5 s on the 30 × 20 course; it now uses `occursAsWord` too (≈ 0.2 s; `srv:brain/map-cold.h4.test.ts`).
Numbers on a 30 × 20 course: `docs/PERFORMANCE.md` → «Course Brain recompute».

**5. Resets reach every signal.** The coverage «attempted» count respects the `mcq_attempts` / `written_attempts`
resets of the learning profile; a new profile part `case_attempts` resets the case / OSCE / viva signals of the
Weakness Center (`caseSignals(..., {since})`). Attempts are never deleted; the topic history still lists them.

Tests: `srv:brain/topic-links.h4.test.ts`, `srv:brain/h4-extractors.test.ts`, `srv:brain/h4-knowledge.test.ts`,
`srv:brain/golden.test.ts` (flowchart figure → uncertain labels, no arrows, no statements), `srv:brain/map-cold.h4.test.ts`,
`srv:learning/h4-resets.test.ts`,
`srv:perf/brain-course.perf.test.ts` (`MEDLEVO_PERF=1`: cold / warm / incremental, slices, incremental = cold),
`web:features/brain/{topics-h4,knowledge-h4}.test.tsx`.

### Independent review of H4 (2026-10-20) — what is shown as stated is what the text states

Each of these was reproduced with a failing test first (`srv:brain/h4-review.test.ts`, `srv:brain/h4-review-topics.test.ts`):
* **Prose relations from hedges / refutations / clause fragments.** «Smoking is thought to cause cancer», «Vaccines were
  wrongly claimed to cause autism», «يُعتقد خطأً أن اللقاحات تسبب التوحد», «من الخطأ القول إن …», «Whether X causes Y remains
  controversial» each became a **stated** relation, and clause fragments became new suggested concepts («Smoking is
  thought to», «Students should know that ischemia», «hypercapnia causes acidosis», «perforation less often than
  cholecystitis», «أحيانًا التهاب الزائدة»). Fix (`prose.ts`): a sentence reporting a belief, claim, debate or refutation
  (EN `thought / believed / claimed / suggested / whether / controversial / falsely / wrongly / formerly …`, AR `يعتقد /
  يقال / يزعم / خطأ / المحتمل / ربما / الجدل / سابقًا …`) is not read; a name may not hold a verb, modal, «that / whether /
  than», a frequency adverb, a relation verb or start with a preposition (hyphenated eponyms such as «May-Thurner
  syndrome» stay names). Plain statements («Gallstones can cause …», «التدخين قد يسبب …») are still read.
* **Algorithms: wrong condition / action splits and invented «otherwise» branches.** «If fever, tachycardia and
  leukocytosis are present, start antibiotics» was read as «fever» → «tachycardia … start antibiotics» (Arabic: «إذا كان
  الطفل مستقرًا، والألم خفيفًا، يُراقب» likewise); «Otherwise healthy children can be discharged» became the «otherwise»
  branch of the rule before it, and an «Otherwise, …» several paragraphs later was attached too. Fix (`algorithms.ts`): a
  printed «then» / arrow / Arabic consequence word is the split; a comma split is used only when no further comma follows
  (and, in Arabic, the action does not start with «و + ال»), otherwise the sentence is not read as a rule; «otherwise /
  else» is a branch word only before «,» «:» or an arrow (a bare «إلا» only before «،» «:»), and only for the rule read
  RIGHT before it; «If not, …» is that rule's branch, never a rule with the condition «not».
* **Arabic arrow direction.** In a right-to-left Arabic line «الألم → الفحص» is displayed «الفحص → الألم» (the arrow
  glyph is not mirrored), so a rightward arrow there does not say which way it was meant: such a line is no longer read
  as a chain (only «←» is, as before).
* **Topic «محاولاتي السابقة» revealed a running exam (AC-19).** For an exam attempt still running in an assessed mode (or
  with solutions «at the end»), the topic page listed each answer as «صحيحة / خاطئة», the linked attempt as «صحيحة X من
  Y مُقيَّمة», and linked to its results — which the exams module itself refuses (409) until the exam is finished. Fix
  (`topics.ts`): the same rule as `exams/results.ts` — «النتيجة بعد إنهاء الامتحان» and a link to the exam itself.

## Not done / limits (honest)

* Extraction is pattern-based: it finds what the text states with recognizable structure (headings, definitions,
  section keywords, tables, enumerations, numbered steps, if-then rules, arrows) and the prose patterns of H4 item 3.
  Mechanisms written in any other prose form are not extracted; nothing is guessed. Arabic subject extraction is limited
  to explicit definition / classification / copula patterns and the H4 relation verbs.
* Inferred relations are the two rules above plus the prose-stated `causes` / `treats` / `complication_of`; «part of» and
  every other relation are owner-made only.
* Algorithms: a flowchart's arrows are used only after the owner reviews the figure reading (vision needs an AI key);
  steps split across pages are two algorithms; nested decision trees are read as flat rule lists.
* A merge cannot be undone from the UI (the dialog says so); the merged concept is kept as a pointer and its names as
  aliases.
* Topic links to a region whose page was re-processed keep pointing at the old region id and show «لم يعد موجودًا».
* The knowledge map is capped (60 concepts / 40 questions) with the totals shown; the concepts page lists all.
* Stated mentions are capped at 1 500 per source version (reported, see above); prose statements at 300 per version.
  Concepts whose only mentions were in a purged source keep their NAMES; their mentions, statements, algorithms,
  extraction records and relation reasons are removed.
* The background recompute still runs in the server process (sliced, not in a worker thread); its write transaction
  (≈ 3 500 relations) is one synchronous slice of ≈ 0.15 s on the 30 × 20 course.

## Round 7 — final verification: «خريطة معرفتي» counts (2026-10-20; §22, §44)

The critic sweep showed every concept row reading «0 من 1 صفحات يُذكر فيها» and «0 محاولة على 1 سؤال». The web row
(`KnowledgeScreen.tsx`) and the server's «لماذا هذه الحالة؟» reasons (`student.ts knowledgeReadingAr` /
`knowledgePracticeAr`) now use counted nouns that agree with their numbers («0 من صفحة واحدة يُذكر فيها», «1 من صفحتين»,
«5 من 12 صفحة», «محاولتان على سؤالين · 3 مراجعات لبطاقة واحدة», «12 سؤالًا مرتبطًا به؛ أجبت 12 مرة»). Same numbers, same
states. Tests (each failed first): `web:src/features/brain/KnowledgeScreen.final.test.tsx`,
`srv:brain/knowledge-counts.final.test.ts`.
