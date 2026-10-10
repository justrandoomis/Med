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
| `run.ts` | the `extract_knowledge` job body: replaces the version's stated mentions (idempotent), finds concepts by name / alias (merges followed), creates new suggestions, joins two undecided candidate halves of a bilingual heading, records `concept_extraction` (counts, roles, sections, objectives), then recomputes the course's inferred relations and the topic suggestions. |
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

## Not done / limits (honest)

* Extraction is pattern-based: it finds what the text states with recognizable structure (headings, definitions,
  section keywords, tables, enumerations). Mechanisms or relations written in free prose are not extracted; nothing is
  guessed. Arabic subject extraction is limited to explicit definition / classification / copula patterns.
* Inferred relations are only the two rules above; «causes / treats / part of» are owner-made only.
* A merge cannot be undone from the UI (the dialog says so); the merged concept is kept as a pointer and its names as
  aliases.
* Topic links to a region whose page was re-processed keep pointing at the old region id and show «لم يعد موجودًا».
* The profile signal reset has no «case attempts» part: resetting MCQ / card signals does not reset case signals.
* The knowledge map is capped (60 concepts / 40 questions) with the totals shown; the concepts page lists all.
* Stated mentions are capped at 1 500 per source version (reported, see above). Concepts whose only mentions were in a
  purged source keep their NAMES (shared concept rows, like the questions module's candidates); their mentions,
  extraction records and relation reasons are removed.
* The relation recompute is still in-process and synchronous: ≈ 0.9 s on a 30-lecture × 20-page synthetic course
  (`docs/PERFORMANCE.md`-style numbers from `srv:perf/brain-course.perf.test.ts`); much larger courses block the server
  proportionally while an extraction job finishes.
* The coverage «attempted» count and the case / OSCE / viva signals ignore learning-profile resets.
