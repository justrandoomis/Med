# MedLevo AI — Architecture & Engineering Contract

> This document is the binding contract for everyone (human or agent) building MedLevo.
> The product requirements live in [`docs/spec/MedLevo_AI_Master_Prompt_AR.txt`](spec/MedLevo_AI_Master_Prompt_AR.txt)
> (cited below as §NN). When this document and the spec disagree, the spec wins — fix this document.

## 0. Non-negotiables (from §03, §12, §62)

1. **No evidence → no unsupported medical claim.** Medical claims in generated content carry evidence ids
   that the *server* validated. The model may only choose evidence ids that were placed in its context.
2. **No verified source link → no claim of attribution.** Citations are rows (`citation → evidence → region → page → version → source`), never free text.
3. **Original stays original; generated stays visibly generated.** (source question vs generated question, source key vs AI-derived answer, source image vs generated illustration).
4. **Source Lock is enforced server-side** in retrieval, generation, verification and cache keys.
5. **Abstain with a specific reason** (unreadable page, out of scope, missing key, conflict, not found within searched scope) instead of guessing.
6. **Never lose the owner's writing or attempts** (ink, notes, attempts, review events) — sync is idempotent and conflict-preserving.
7. **Honesty in the product and in reporting**: no fake progress %, no "AI Verified" badge, no "100% accurate", no feature shown as working when it is not. Unfinished features are disabled with a reason via the capability registry. No demo/fake data in production paths — fixtures live only in tests.
8. **Single owner.** No organizations, roles, cohorts, subscriptions, multi-tenancy, public sharing.

## 1. Stack (see ADR-0001)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | one type system across server, web, shared contracts |
| Server | Node.js ≥ 22.13, **Fastify 5**, run with `tsx` | modular monolith; light; good plugin set (multipart, cookie, rate-limit, helmet) |
| Database | **SQLite via built-in `node:sqlite`** (WAL), hand-written SQL migrations, FTS5 | single owner → embedded relational DB is the right size; zero native build; FTS5 for keyword search; trivially backed up with `VACUUM INTO` |
| Files | content-addressed private store under `DATA_DIR/files` | never public; served only through authenticated routes / short-lived tokens |
| Jobs | SQLite-backed in-process job queue with checkpoints | durable, resumable, idempotent; no external broker for one user |
| PDF | `pdfjs-dist` (text + positions, page labels, operator list for images) + poppler `pdftoppm` (raster for OCR/thumbnails) | robust, verified in this environment |
| OCR | `tesseract.js` 7 with bundled `eng`+`ara` traineddata (offline) | runs locally; no file leaves the machine |
| DOCX / PPTX | `mammoth` (paragraph locators) / `jszip` + XML (slide numbers) | DOCX has no stable pages → paragraph locators (§07) |
| DOC / PPT | LibreOffice headless conversion in an isolated temp dir with timeout | only through a real converter (§13) |
| Spaced repetition | `ts-fsrs` (FSRS) — schedules derived by replaying `review_event`s | documented, versioned, testable algorithm (§43) |
| AI | Provider abstraction; Anthropic adapter (`@anthropic-ai/sdk`) when `ANTHROPIC_API_KEY` is set on the server | AI is optional; everything deterministic works without it |
| Web | **React 19 + Vite 8 + React Router 7**, PWA via `vite-plugin-pwa` | typed SPA, installable, offline app shell |
| Local-first | **Dexie (IndexedDB)** for ink, notes, attempts, review events, sessions, outbox, offline blobs | writing never waits for the network (§26, §47) |
| Rendering | `pdfjs-dist` in the browser (canvas + text layer), SVG/canvas ink layer | selectable text, accessible text layer |
| Icons / fonts | `lucide-react`; IBM Plex Sans Arabic + Noto Naskh Arabic via `@fontsource` (bundled, offline) | consistent Arabic/Latin typesetting |
| Validation | `zod` 4 schemas in `packages/shared` (request bodies, settings, AI output contracts) | one contract for server, web and model output |
| Tests | Vitest 5 (unit/integration; web with jsdom + fake-indexeddb), Playwright 1.64 (E2E against the real server serving the built app; Chromium projects `phone` 390×844 and `desktop` 1280×800; tablet widths only in layout unit tests) | see `docs/TEST_LOG.md` |

Versions in use (2026-10-10): Node 22.22, Fastify 5.12, React 19.3, Vite 8.3, React Router 7.18, pdfjs-dist 6.4 (legacy
build in the browser), tesseract.js 7, ts-fsrs 5, Dexie 4.4, vite-plugin-pwa 2, TypeScript 6.0. The Anthropic adapter
exists (`modules/ai/providers/anthropic.ts`, ADR-0002); no embeddings, speech-to-text, vision-for-processing or external
search provider is built.

## 2. Repository layout & module ownership

```
packages/shared/src/        contracts shared by server & web (ids, richtext/bidi, enums, scope, errors, settings, features)
apps/server/src/
  index.ts                  boot (reads config, migrates, starts jobs + HTTP)
  app.ts                    buildApp(ctxOverrides?) → Fastify instance (used by tests)
  config.ts                 env parsing (zod)
  context.ts                AppContext interface + createContext()
  db/db.ts, db/migrate.ts   node:sqlite wrapper, migration runner
  db/migrations/NNNN_*.sql  migrations (0001 core). Module migrations use their range (below)
  lib/                      errors, hashing, http helpers, safe-zip, ssrf-guard, text utils
  modules/<module>/         one folder per module: index.ts (Fastify plugin), service files, routes
                            (21 modules, registered in modules/index.ts)
  cli/                      backup / restore-verify CLIs (`npm run backup`, `npm run restore:verify`)
apps/server/test/           vitest tests; test/helpers/ (createTestApp, fixtures, fake AI provider);
                            test/acceptance/ (AC-01…AC-30 groups G1–G8); test/perf/ (opt-in, MEDLEVO_PERF=1)
apps/web/src/
  main.tsx, app/            router, providers, shell (nav), route table
  design/                   design system (tokens.css + components) — the ONLY place for base UI primitives
  lib/                      api client, localdb (Dexie), outbox/sync engine, offline download manager, capabilities
  features/<feature>/       screens & feature components; each exports `routes` from routes.tsx (18 features)
apps/web/test/              web vitest tests (core, ink, learning) + the ink Playwright harness (test/ink/)
fixtures/golden/            Golden Set fixture files (synthetic structural test documents) + README + expected.json
fixtures/acceptance/        derived synthetic fixtures of the acceptance groups (make_g*_fixtures scripts) + README
tools/fixtures/             Golden Set generator (`npm run fixtures`)
scripts/dev.mjs             runs the API and the Vite dev server together (`npm run dev`)
e2e/                        Playwright specs against the real server; e2e/support/ (global setup, API helpers)
docs/                       architecture, ADRs, module notes, requirement & capability matrices, acceptance,
                            performance, backup/restore, skills audit, test log
```

**Module map** (§50): Library · Sources · Document Processing · Evidence · Study Book · Ink · Questions ·
Learning · Sync · AI Orchestration · Personal Settings · Observability.

All 21 server modules are mounted under `/api/<name>` (`settings` owns `/api/settings` and `/api/capabilities`). The
base schema is `0001_core.sql`; the «files» column lists the migration files that exist (2026-10-10).

| Module (server dir) | Owns tables | Migration range · files | Web feature dirs |
|---|---|---|---|
| `auth` | owner, auth_session, login_attempt | 0010–0019 · — | `features/auth` |
| `settings` | owner_setting | 0020–0029 · — | `features/settings`, `features/control` |
| `audit` | change_log | — | (control center history) |
| `files` | stored_file | — | — |
| `jobs` | processing_job (+ `worker_id`), job_checkpoint | 0030–0039 · `0030_job_worker` | (control → processing) |
| `sync` | sync_operation, sync_change | 0040–0049 · — | `lib/sync.ts`, `features/offline` |
| `library` | library_node, tag, tag_link, topic, topic_link | 0100–0149 · `0100_library_trash` | `features/library`, `features/home` |
| `sources` | source, source_link, source_version, source_page, source_region | 0150–0199 · `0150_sources_registry` | `features/upload`, `features/sources` |
| `processing` | document_chunk, chunk_fts, image_asset | 0200–0249 · `0200_processing` | (processing status: sources page, control → processing) |
| `annotations` | note_page, annotation, annotation_target, note, ink_recognition, study_session, source_progress | 0250–0299 · `0250_annotations` | `features/workspace` |
| `evidence` | evidence, claim, citation, verification_result, artifact_dependency, content_alert, content_alert_item, content_alert_job, concept*, medical_term | 0300–0349 · `0300_evidence` | `features/evidence` (Source Inspector) |
| `search` | (chunk_fts, question_fts, owner_content_fts, chunk_embedding) | 0350–0399 · — | `features/search` |
| `ai` | usage_record | 0400–0449 · — | (control → intelligence) |
| `studybook` | artifact, artifact_section, content_block, contextual_thread, message, explanation_rule_override, artifact_reanchor | 0450–0499 · `0450_studybook` | `features/studybook`, `features/workspace/studybook` |
| `questions` | question*, answer_key_entry(_v2), answer_evidence, question_lecture_link, question_duplicate, question_extraction, question_fts | 0500–0549 · `0500_questions`, `0510_question_occurrence_lookup` | `features/questions` |
| `exams` | exam, exam_attempt, question_attempt, written_attempt, exam_item_event, question_generation_run, generated_question_candidate | 0550–0599 · `0550_exams` | `features/exams` |
| `learning` | flashcard, review_event, review_state, review_reset, flashcard_impact, flashcard_duplicate_decision, weakness, learning_profile, study_plan, plan_task, revision_session | 0600–0649 · `0600_learning` | `features/review`, `features/weakness`, `features/planner`, `features/home` |
| `media` | media_overlay, audio_asset, transcript_segment, transcript_revision, transcript_import, media_region_link, image_meta, image_quiz, image_quiz_answer | 0650–0699 · `0650_media` | `features/media` |
| `control` | review_queue_item, control_region_correction, evaluation_case | 0700–0749 · `0700_control` | `features/control` |
| `data` (offline packages, export, backup / restore) | data_server_epoch, data_backup | 0750–0769 · `0750_data` | `features/offline`, `lib/offline.ts` |
| `cases` | clinical_case, clinical_case_version, case_attempt, case_event | 0770–0799 · `0770_cases` | `features/cases` |

Shared writers (documented in the module notes): `review_queue_item` rows are written by processing, evidence,
questions, studybook and exams with their own `kind`; `concept` / `concept_mention` candidates are written by questions; the
sources purge deletes rows of other modules in one transaction (`docs/modules/library-sources.md`). Created but never
written yet: `chunk_embedding` (no embeddings provider), `evaluation_case` (§57 store not built), `concept_relation`
(Course Brain not built) — see `docs/REQUIREMENTS_MATRIX.md`.

A module may READ any table. It WRITES only its own tables, or calls the owning module's service
functions. Adding a column/table → new migration file in the module's range (never edit 0001 after it ships).

## 3. Server conventions

### 3.1 AppContext (implemented in `apps/server/src/context.ts`)

```ts
export interface AppContext {
  config: AppConfig;                 // from config.ts
  db: Db;                            // db/db.ts
  files: FileStore;                  // modules/files/store.ts
  jobs: JobQueue;                    // modules/jobs/queue.ts
  audit: AuditLog;                   // modules/audit/audit.ts → change_log
  sync: SyncRegistry;                // modules/sync/registry.ts
  ai: AiOrchestrator;                // modules/ai/orchestrator.ts
  capabilities: CapabilityRegistry;  // modules/settings/capabilities.ts
  clock: { now(): number };          // injectable for tests
  log: FastifyBaseLogger;            // structured logs (pino); never log secrets or full document text
}
```

* `Db`: `get<T>(sql, params?)`, `all<T>(sql, params?)`, `run(sql, params?) → {changes}`, `tx<T>(fn)` (BEGIN IMMEDIATE,
  nested → SAVEPOINT), `raw` (DatabaseSync). Statements are cached. Params: positional array or named object.
  JSON helpers: `toJson(v)`, `fromJson<T>(s)`. WAL mode, `foreign_keys=ON`, `busy_timeout`.
* Every module is a Fastify plugin `export default async function register(app, opts: { ctx: AppContext })`
  mounted with prefix `/api/<module>`; listed in `apps/server/src/modules/index.ts`.
* Validation: zod schemas for every body/query/params (`parseBody(schema, req)` helper in `lib/http.ts`).
* Errors: throw `new AppError(code, messageAr, httpStatus, details?)` (`lib/errors.ts`). Global handler emits
  `{ error: { code, message, details } }` (`ApiErrorBody`). Never leak stack traces, file paths, SQL, or secrets.
* Auth: every `/api/*` route requires the owner session except `GET /api/auth/status`, `POST /api/auth/setup`
  (only while no owner exists), `POST /api/auth/login`, `POST /api/auth/recover`, `GET /api/health`.
  Session = opaque random token in an `HttpOnly; SameSite=Strict; Path=/` cookie (`Secure` when configured),
  stored hashed (sha256). Passwords: `scrypt` (node:crypto) with per-password salt.
* CSRF: every non-GET/HEAD `/api` request must carry `x-medlevo-csrf: 1` and, when an `Origin` header is
  present, it must equal the configured origin. No CORS is enabled.
* Rate limits: login/recover/setup strictly limited; uploads and AI endpoints limited.
* Audit: `ctx.audit.record({entityType, entityId, action, summary, before?, after?, actor?})` for owner-visible
  history (moves, renames, trash, corrections, key changes, reviews).
* Time: store epoch ms UTC. Display in owner timezone (default `Asia/Baghdad`).

### 3.2 Files (`ctx.files`)

`put(buffer|stream, {mime, originalName}) → StoredFile` (dedup by sha256) · `path(id)` (internal only) ·
`read(id)` · `stat(id)` · `createToken(id, ttlMs)` / `verifyToken(token)`.
Routes: `GET /api/files/:id` (session, Range support, `Content-Disposition: inline`, correct MIME,
`X-Content-Type-Options: nosniff`, `Cache-Control: private`), `GET /api/files/t/:token` (short-lived signed).

### 3.3 Jobs (`ctx.jobs`)

```ts
jobs.register<I, O>(kind, { version, maxAttempts = 3, timeoutMs, handler: (run: JobRun<I>) => Promise<O | { partial: true; output: O }> })
jobs.enqueue(kind, input, { idempotencyKey?, runAfter?, parentJobId? }) → JobRow   // same key → existing job
jobs.cancel(id) · jobs.retry(id) · jobs.get(id) · jobs.list(filter) · jobs.start() · jobs.stop() · jobs.drain() // drain: tests
JobRun<I> = { id, input, attempt, signal: AbortSignal, log,
  checkpoint<T>(stepKey, fn): Promise<T>   // runs fn once; persisted in job_checkpoint; on retry returns stored result
  progress({ stage, done?, total?, unit? }) // real counts only; no fake percentages
  isCancelled(): boolean }
throw new JobError(code, messageAr, { retryable })  // retryable → backoff (exponential, capped); not retryable → failed
```
States: `queued → running → (completed | partial | failed | cancelled | waiting_for_input)`. `partial` ≠ `completed`.
Cancel never deletes completed checkpoints/outputs. On boot, `running` jobs with stale heartbeat are re-queued; a job whose
claiming process (`processing_job.worker_id` = host/pid/boot nonce) is provably gone is re-queued at once (docs/PERFORMANCE.md).

### 3.4 Sync (`ctx.sync`, routes under `/api/sync`)

* Every client-originated entity (annotation, note, note_page, flashcard, review_event, question_attempt,
  study_session, exam_attempt) has a **client-generated ULID**.
* Client op: `{ op_id, device_id, entity_type, entity_id, op: 'upsert'|'delete'|'append', base_rev?, payload, client_ts }`.
* `POST /api/sync/push {ops}` → per-op `{ op_id, result: 'applied'|'merged'|'conflict_kept_both'|'duplicate'|'rejected', entity?, detail? }`.
  An op_id seen before returns `duplicate` + the original result (idempotent). Recorded in `sync_operation`.
* `GET /api/sync/pull?since=<seq>&limit=` → `{ changes: [{ seq, entity_type, entity_id, entity | null }], next_since, has_more }`
  from `sync_change` (modules call `ctx.sync.touch(entityType, id)` inside the same transaction as the write).
* Handlers: `ctx.sync.registerEntity(entityType, { apply(op, tx) → result, serialize(id) → entity|null })`.
* Merge policy (no blind last-write-wins, §47):
  * append-only (review_event, question_attempt, ink strokes by id): insert if absent, else `duplicate`.
  * annotation edits: `base_rev == rev` → apply; otherwise keep both (the edit becomes a new annotation copy) → `conflict_kept_both`.
    Deletion is a tombstone (`deleted_at`); an edit concurrent with a delete keeps the edited stroke.
  * note text: `base_rev == rev` → apply; otherwise the incoming body is saved as a new note with `conflict_of_id` → `conflict_kept_both`.
  * study_session: newer `updated_at` on server is never overwritten silently → `rejected` with the server copy; client asks the owner.
  * UI/preferences: last-write-wins by `client_ts` is acceptable.

### 3.5 AI orchestrator (`ctx.ai`) — §51

```ts
type AiTask = 'explain' | 'study_book' | 'chat' | 'summarize' | 'compare' | 'verify_support' | 'generate_questions'
  | 'validate_question' | 'vision_figure' | 'grade_written' | 'case_sim' | 'classify' | 'embed' | 'transcribe';
ai.status() → { configured, provider?, tasks: Record<AiTask, { available, model?, reason_ar? }>, budget }
ai.isAvailable(task) → boolean
ai.generateStructured<T>({ task, schema /* zod */, system, input /* untrusted content clearly delimited */,
  scope: ResolvedScope, sourceVersionIds, jobId?, images?, maxOutputTokens? }) → { output: T, model, usageId }
```
* Not configured → throws `AppError('AI_NOT_CONFIGURED', …, 409)`; UI shows the reason; nothing pretends to work.
* Every call writes a `usage_record` (task, provider, actual model, tokens, **estimated** cost, latency, status, source
  versions, rules version). Budget exceeded → `AI_BUDGET_EXCEEDED` (never a silently degraded result).
* Output is schema-validated; invalid → `SCHEMA_REJECTED` (one bounded repair attempt max).
* Uploaded content is untrusted data (§49): wrapped in delimiters, system prompt states it cannot change instructions,
  scope, or tools. The model has no tools that can exfiltrate data. Fallbacks keep the same scope/privacy constraints.
* Tests inject a deterministic `FakeAiProvider` (test-only; never registered in production).

### 3.6 Evidence contract — §10, §12, AC-05/06/07

* Evidence is created ONLY from existing regions: `evidence.fromRegion(regionId, {start?, end?})` → exact quote.
* Generators receive evidence under **short aliases** (`E1`, `E2`, … — `EvidenceForModel` in `shared/evidence.ts`) that
  already passed the scope filter. The server keeps the alias → evidence_id map; an alias it did not hand out is rejected
  (AC-06). Generated content follows `GeneratedContent` (sentences; every medical sentence carries a claim).
* Output claims: `{ text, support_type, evidence_ids[] }`. `evidence.validateClaims(ownerType, ownerId, claims, scope)`:
  1. **exists** — every evidence id exists → else reject claim (AC-06). Invalid ids never become visible citations.
  2. **in scope** — every evidence version ∈ `scope.versionIds` → else reject (AC-05).
  3. **critical tokens** — negations, numbers, units, doses, thresholds, ages in the claim must appear in cited evidence;
     a `directly_stated` claim must be substantially contained in the quote; topical similarity alone fails (AC-07).
  4. **entailment** (when AI verify is available) — independent verifier call, separate from the generator.
  Results → `verification_result` rows; claim `verification_status` = `linked` | `needs_review` | `conflict` | `rejected`.
* Claims that fail are not shown as supported; blocks with unsupported medical claims are not published as verified.
  Unverified drafts while streaming are visibly marked as drafts.

### 3.7 Source Lock & cache keys — §08, §17

* `scope.resolve(SourceScope) → ResolvedScope` (server). Retrieval functions REQUIRE a `ResolvedScope` argument
  (no default) and filter by `versionIds` in SQL **before** ranking.
* `lecture_only`: only the focal lecture's pinned version. `references_only`: chosen references. `lecture_plus_references`:
  both, with origin marked. `external`: only if the owner enabled external evidence.
* Cache key = sha256(stableStringify({kind, source version ids+hashes, scope.hash, rules_version, level, language,
  dialect, settings that affect output, generator_version, verifier_version})). A cached artifact is reused only if its
  key matches exactly AND its dependencies still exist and are not stale. A lecture_only request can never hit an
  artifact produced with a wider scope.

### 3.8 Pages, regions, coordinates — §07, §25

* `source_page.page_index` = 0-based order in file; `printed_label` = printed number (from PDF /PageLabels or detected);
  UI shows both when they differ: «ص 12 (الصفحة 14 في الملف)». Citations store page_id, never just a number.
* `bbox_json` is normalized `{x,y,w,h}` ∈ [0,1] relative to the **unrotated** page box, origin top-left.
  Viewers transform by zoom/rotation/crop; ink uses the same normalized space → DPI/zoom independent (AC-21).
* DOCX: `pagination='paragraphs'`, locator `{paragraph_index, heading_path}`; PPTX: slide number; audio: `{start_ms,end_ms}`;
  images: file name + region. Never invent page numbers for unpaginated sources.

## 4. Web conventions

* Arabic-first: `<html lang="ar" dir="rtl">`. All UI copy in natural Arabic with correct English terms.
  Mixed text renders through `<RichTextView>` / `<Bidi>` from `design/` (runs isolated with `<bdi dir>`); never rely on
  `dir="auto"` alone; never insert invisible bidi characters.
* Design system (`apps/web/src/design/`): tokens in `tokens.css` (spacing 4/8/12/16/24/32/48, radius, type scale,
  colors as CSS variables for light/dark, motion tokens honoring reduce-motion), and components. Feature code uses
  these primitives; no ad-hoc colors/spacing. Calm, Apple-inspired, book-first: neutral background, warm paper,
  one accent; no dashboards of counters, no cards-in-cards, no glassmorphism everywhere, no decorative motion.
* Accessibility: every control keyboard reachable, visible focus, `aria-label` on icon buttons, roles for menus/tabs/dialogs,
  focus trap in dialogs/sheets, `aria-live` for toasts and save status, status never conveyed by color alone (text/icon too),
  touch targets ≥ 44px on touch devices, hover never required.
* Responsive: phone (≥ 360/390px: book first, rail as bottom sheet, bottom nav: الرئيسية/المكتبة/المراجعة/الإعدادات),
  tablet portrait/landscape, laptop, desktop. Workspace is full-bleed.
* Data: `lib/api.ts` (`api.get/post/put/patch/del` add CSRF header, parse `ApiErrorBody` → `ApiError`).
  Capabilities from `GET /api/capabilities` via `useCapabilities()`; disabled features show the reason.
* Local-first: `lib/localdb.ts` (Dexie) + `lib/sync.ts` (outbox → `/api/sync/push`, pull loop, online/offline state,
  per-entity sync state for the save indicator: محفوظ محليًا / ينتظر المزامنة / تمت المزامنة / تعارض / خطأ).
  Writing ink/notes/attempts/review events goes to IndexedDB first (never awaits the network).
* PWA: app shell precached; update flow is prompt-based (never auto-reload while writing); offline content is stored
  explicitly in IndexedDB by the Download Manager, not implied by the HTTP cache.

## 5. Testing conventions — §57, §58

* Server: `apps/server/test/**/*.test.ts`. `createTestApp({ ai?: FakeAiProvider, now? })` → isolated temp DATA_DIR,
  migrated DB, Fastify `inject`, helper `login()` returning cookie+csrf headers. Jobs are drained synchronously in tests.
* Fixtures: `fixtures/golden/*` are synthetic structural documents generated by `scripts/build-fixtures.mjs`
  (LibreOffice / pdf tools). They are clearly labelled TEST FIXTURE and contain no claims presented as medical reference.
* Web: vitest + jsdom for logic (bidi, geometry, anchors, merge, outbox). E2E: Playwright (`e2e/`).
* Report honestly: a test that needs an iPad, a real Pencil, or an API key that is not available is recorded as
  **Not run (reason)**, never as passed.

## 6. Definition of done for a module

1. Real data flow end-to-end (DB ↔ API ↔ UI), no placeholder data in production paths.
2. Tests for core logic + API (incl. failure/abstention paths) passing: `npm test`, `npm run typecheck`.
3. Capability registry reflects the module's real state; disabled/unconfigured features explain why.
4. Arabic UI copy, RTL correct, keyboard accessible, responsive at 390px and desktop.
5. Module notes appended to `docs/modules/<module>.md`: what's implemented, tested, not done, and why.
