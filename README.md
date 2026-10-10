# MedLevo AI 🩺

منصة دراسة طبية شخصية لمستخدم واحد: **Book First · Source First · Arabic First**.
A personal, source-grounded, book-first, Arabic-first medical study platform (single owner).

**بالعربية.** MedLevo مكتبتك الطبية وكتابك ومساحة كتابتك في مكان واحد. ترفع محاضراتك ومراجعك ومصادر أسئلتك، فيعالجها
النظام صفحةً صفحة ويحفظ أصل كل معلومة. تقرأ المحاضرة ككتاب وتكتب عليها بالقلم، وتحل أسئلة مصادرك مرتبطةً بصفحات
المحاضرة، ثم تراجع ببطاقات متباعدة وفق أخطائك. الشرح العربي والأسئلة المولدة تعمل فقط عند ضبط مزود ذكاء اصطناعي على
الخادم، وكل ادعاء طبي فيها يجب أن يستند إلى دليل من مصادرك. المنصة تعليمية، لا تقدّم تشخيصًا ولا خطة علاج لمريض حقيقي.

**In English.** MedLevo is one owner's medical library, study book and notebook. You upload lectures, references and
question sources; the server processes them page by page (text, OCR, layout, tables, figures) and keeps where every
piece of text came from. You read a lecture as a book, write on it with a pen, practise the questions of your own
sources linked to the lecture pages, and review with spaced-repetition cards driven by your mistakes. Arabic
explanations, the Study Book and generated questions run only when an AI provider is configured on the server, and
every medical claim they make must cite evidence from your own sources. MedLevo is for study; it does not diagnose or
plan treatment for a real patient.

- Product spec (Arabic): [`docs/spec/MedLevo_AI_Master_Prompt_AR.txt`](docs/spec/MedLevo_AI_Master_Prompt_AR.txt)
- What is built, tested or blocked, section by section: [`docs/REQUIREMENTS_MATRIX.md`](docs/REQUIREMENTS_MATRIX.md)
- Architecture & engineering contract: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · decisions: [`docs/adr/`](docs/adr)

## Features and what they need

Everything in the first table works without an AI key. The app never shows a feature as working when it is not: the
Control Center («مركز التحكم» → «القدرات») lists each feature's live state and the reason, read from
`GET /api/capabilities`.

| works now (no AI key) | |
|---|---|
| Library | notebooks with covers, nested folders, drag & drop, tags, favorites, recent, archive, restorable trash with impact preview, study templates |
| Upload & processing | PDF (digital, scanned, mixed), DOCX, PPTX, images, ZIP of images; DOC/PPT through LibreOffice; offline OCR (Arabic + English); tables, figures, captions; printed page numbers vs file pages; real progress per page; failed pages shown, never hidden |
| Reader & writing | book canvas (continuous, single, two-page), search in the document, highlights, notes, bookmarks; pens, highlighter, erasers, lasso, shapes, text, sticky notes; everything saved on the device first |
| Evidence & Source Lock | citations that open the exact page and region; Lecture Only / References / Lecture + References enforced on the server |
| Search | keyword and exact-phrase search over sources, questions, notes, generated content and transcripts (Arabic-normalized) |
| Question Vault | extraction of questions, options and keys from your files and photos, separate key states (source key, missing, AI-derived, conflicting, unresolved), automatic linking to lecture pages, duplicates kept with every occurrence |
| Practice & exams | practice with hints, exams with a fixed timer policy and no answer leaks, results by lecture and concept |
| Learning | flashcards (basic, cloze, image occlusion, from mistakes) with FSRS, Weakness Center, Mistake Genome, planner, one-tap revision, Exam DNA, Anki-compatible text export |
| Cases & media | owner-written clinical cases, OSCE checklists and viva; image explorer with non-destructive overlays and image quiz; audio playback with manual / VTT / SRT transcripts |
| Devices & data | offline downloads, sync between devices without losing writing, backup + verified restore, export to Markdown / print-ready HTML / JSON |

| needs `ANTHROPIC_API_KEY` on the server | shown as «تحتاج إعدادًا على الخادم» until then |
|---|---|
| Explanations (explain, simplify, translate, explain the figure), contextual chat, Study Book, summaries, comparisons | all generated text passes server-side evidence checks; unsupported sentences are removed, never softened |
| Generated hard MCQs, answer check for keyless questions, written-answer grading, AI case generation and viva judge | nothing is published or scored unless its evidence is verified |

| not available in this version | why |
|---|---|
| Semantic search, automatic transcription, external image / evidence search | they need an embeddings, speech-to-text or search provider that is not built |
| Handwriting recognition, native iPad layer (PencilKit, double tap, squeeze) | not built; the web ink records pressure / tilt when the browser sends them, but no real Apple Pencil was tested |
| DOCX export, server-side PDF export | not built; PDF = print the HTML export from the browser |

The full, evidence-based list (with the tests behind each line) is the [Requirement Matrix](docs/REQUIREMENTS_MATRIX.md).

## Requirements

- **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; tested on 22.22) and npm.
- **poppler-utils** (`pdftoppm`) — page rendering for OCR, figure crops and damaged-page checks.
- **LibreOffice** (`soffice`), optional — converts `.doc` / `.ppt` and renders PPTX as fixed pages. Without it those
  formats are refused with a reason (`MEDLEVO_SOFFICE_AVAILABLE` overrides the detection).
- OCR models for Arabic and English are installed by `npm install` (`@tesseract.js-data/ara`, `/eng`); OCR runs
  locally and no file leaves the machine for it.
- For the end-to-end tests only: a Chromium binary (default `/opt/pw-browsers/chromium`, or set `PW_CHROMIUM_PATH`).

## Setup

```bash
npm install
cp .env.example .env     # optional — every value has a safe default; edit it on the server only
npm run dev              # API on http://127.0.0.1:8787, web app on http://127.0.0.1:5173 (proxies /api)
```

Open http://127.0.0.1:5173. The first visit shows «إنشاء حساب المالك»: create the single owner account and keep the
ten recovery codes it shows once. A second account can never be created. When the server listens on a non-loopback
address, trusts a proxy or has a non-loopback `MEDLEVO_ORIGIN`, setup also asks for a **setup token**: set
`MEDLEVO_SETUP_TOKEN` yourself, or copy the one-time token the server prints to its log at boot.

## Configuration

All configuration is environment variables on the server, documented in [`.env.example`](.env.example) (a test fails
if the server reads a variable the example does not name, or if the example carries a secret). The server loads
`.env` from its working directory or the repository root.

| variable | default | what it does |
|---|---|---|
| `MEDLEVO_DATA_DIR` | `./data` | database, private files, backups. A relative path is resolved against the server's working directory — `apps/server/` when started through `npm run dev` / `npm start`. Use an absolute path in production |
| `MEDLEVO_HOST`, `MEDLEVO_PORT` | `127.0.0.1`, `8787` | where the API (and, in production, the web app) listens |
| `MEDLEVO_ORIGIN` | `http://localhost:5173` | the exact public origin of the web app; mutations from any other `Origin` are refused (CSRF) |
| `MEDLEVO_COOKIE_SECURE` | `true` when the origin is `https://` | session cookie `Secure` flag |
| `MEDLEVO_SETUP_TOKEN` | empty (a one-time token is printed when required) | protects claiming the owner account on an exposed server |
| `ANTHROPIC_API_KEY` | empty | enables the AI features. **Server only**: never sent to the browser, stored in the database, logged, exported or backed up |
| `MEDLEVO_MODEL_GENERATION` / `_VERIFICATION` / `_VISION` | adapter defaults | per-role model overrides (impact preview in «مركز التحكم» → «الذكاء الاصطناعي») |
| `MEDLEVO_AI_MONTHLY_BUDGET_USD` | `20` | estimated monthly budget; `0` blocks every AI call |
| `MEDLEVO_ALLOW_EXTERNAL_FETCH` | `false` | external fetching stays off (no external provider is built) |
| `MEDLEVO_TIMEZONE` | `Asia/Baghdad` | display timezone (storage is always UTC) |
| `MEDLEVO_MAX_UPLOAD_MB`, `MEDLEVO_MAX_ZIP_*` | 200 MB, 500 entries, 1 GB | upload and archive limits |
| `MEDLEVO_TRUST_PROXY` | `false` | set to `true` only behind your own reverse proxy |
| `MEDLEVO_WEB_DIST` | `apps/web/dist` in production | the built web app the server serves |

Secrets belong in the server's environment or its `.env` file — never in the repository (`.env` is git-ignored), the
browser or an export. What is sent to the AI provider, and what is not, is stated in «مركز التحكم» → «الذكاء
الاصطناعي»: excerpts of your sources inside the chosen Source Lock, your question or selection, a written answer when
you ask for grading, a figure crop when you ask about a figure, your custom instructions, and your notes only if you
include them. Never the original files, passwords or keys; the model gets no tools and no internet access. The
provider reads this content to answer, so there is no end-to-end encryption. OCR and search run on your server.

## Running

**Development:** `npm run dev` runs `tsx watch` for the API and the Vite dev server together (`npm run dev:server`,
`npm run dev:web` run one of them).

**Production (one process serves the API and the built web app):**

```bash
npm ci
npm run build                                   # apps/web/dist (PWA)
NODE_ENV=production MEDLEVO_DATA_DIR=/srv/medlevo/data \
  MEDLEVO_ORIGIN=https://medlevo.example MEDLEVO_TRUST_PROXY=true npm start
```

- The server listens on `MEDLEVO_HOST:MEDLEVO_PORT` (loopback by default). Put a TLS-terminating reverse proxy you
  control in front of it, forward to `127.0.0.1:8787`, and set `MEDLEVO_ORIGIN` to the exact `https://` origin users
  open (the `Secure` cookie follows from it). Keep `MEDLEVO_TRUST_PROXY=false` when nothing sits in front.
- On an exposed server the setup token is required until the owner exists (see Setup).
- `SIGTERM` / `SIGINT` stop gracefully: running jobs are re-queued and resume from their checkpoints at the next boot.
- The E2E suite starts the server exactly this way (`NODE_ENV=production`, built app, throwaway data dir) on loopback.
  A deployment behind a real reverse proxy with TLS has **not** been exercised here.

**Updating** (code, schema, models, sources):

1. Make a backup and verify it (next section).
2. `git pull && npm ci && npm run build`, then restart. Database migrations run automatically at boot, in order, each
   in its own transaction; an already-applied migration that was edited, or a database newer than the code, stops the
   server with a clear message instead of starting on a mismatched schema.
3. Model changes are environment variables (restart needed); preview their impact first in the Control Center. Nothing
   already generated is regenerated automatically.
4. A new edition of a source is uploaded as a **new version** of that source («النسخ» on the source page): the old
   version, its citations and your attempts stay; content alerts list what may be affected. «تثبيت هذه النسخة للدراسة»
   (Source Freeze) keeps the version you study on until you change it.

## Backup and restore

```bash
npm run backup                                              # <MEDLEVO_DATA_DIR>/backups/medlevo-backup-….tar.gz + .sha256
npm run restore:verify -- /path/to/backup.tar.gz            # restore into a temporary directory and check everything
npm run restore:verify -- /path/to/backup.tar.gz -- --target /srv/medlevo/data-restored   # restore for real
```

Backups are safe while the server runs (SQLite `VACUUM INTO` + the content-addressed file store) and can also be made
and verified in the app («بياناتك» → «النسخ الاحتياطي»). A restore always goes into a new, empty directory; start the
server on it with `MEDLEVO_DATA_DIR`. Archives are **not encrypted** — store them accordingly. The offline copy on a
device is not a backup. Details: [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md).

## Tests

| command | what it does |
|---|---|
| `npm test` | unit and integration tests of all workspaces (shared, server, web) |
| `npm run typecheck` | TypeScript checks for shared, server, web and the E2E harness |
| `npm run build` | production build of the web app (PWA) |
| `npm run e2e` | Playwright end-to-end tests against the real server (phone + desktop; see [`e2e/README.md`](e2e/README.md)) |
| `MEDLEVO_PERF=1 …` | opt-in performance and resilience suites ([`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)) |

AI paths are tested only with a test-only fake provider (no key is used in tests); with no key the E2E suite checks
that every AI feature honestly reports that it needs configuration. The latest full run, with exact commands, counts
and what was not run (real iPad / Apple Pencil, Safari, screen readers, a live AI provider, a real Anki import), is in
[`docs/TEST_LOG.md`](docs/TEST_LOG.md). ESLint is listed in `package.json` but has no configuration yet.

## Project layout

```
packages/shared/    typed contracts shared by server and web (zod schemas, enums, rich text / bidi, page labels)
apps/server/        Fastify API: src/modules/<module>/ (21 modules), db/migrations/, cli/ (backup, restore-verify), test/
apps/web/           React PWA: src/app (shell, routes), src/design (design system), src/lib (api, sync, offline),
                    src/features/<feature>/ (18 features), test/
e2e/                Playwright specs against the real server
fixtures/           Golden Set and acceptance fixtures (synthetic TEST FIXTURE documents, not medical references)
tools/, scripts/    fixture generator, dev runner
docs/               documentation (below)
```

## Documentation

| document | contents |
|---|---|
| [`docs/REQUIREMENTS_MATRIX.md`](docs/REQUIREMENTS_MATRIX.md) | every spec section and acceptance scenario → status, screens, API, tables, tests, blockers |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | non-negotiables, stack, module map, server / web conventions, testing rules |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | adversarial verification of AC-01 … AC-30, defects found and fixed, the completeness critique |
| [`docs/TEST_LOG.md`](docs/TEST_LOG.md) | the latest full test run: commands, counts, durations, failures, what was not run |
| [`docs/CAPABILITY_MATRIX.md`](docs/CAPABILITY_MATRIX.md) | pen / ink capabilities per platform and what was (not) tested |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | measured performance and resilience, with limits |
| [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md) | backup, verification and restore |
| [`docs/design-system.md`](docs/design-system.md) | tokens, components, accessibility rules |
| [`docs/SKILLS_AUDIT.md`](docs/SKILLS_AUDIT.md) | skills actually used to build MedLevo, and the capabilities still needed |
| [`docs/modules/`](docs/modules) | per-module notes: what is implemented, tested, not done, and why |
| [`docs/adr/`](docs/adr) | architecture decisions (stack, AI provider) |
| [`e2e/README.md`](e2e/README.md) | how the end-to-end suite runs and how to write a spec |
