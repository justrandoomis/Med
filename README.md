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
| Reader & writing | book canvas (continuous, single, two-page), search in the document, highlights, notes, bookmarks; pens, highlighter, erasers, lasso, shapes, text, sticky notes, pictures, links; note pages between lecture pages and notebooks of their own; split study (lecture + another source, its Study Book, its questions or the explanations); undo / redo kept on the device across a reload; manual re-anchoring of notes whose place changed; in-app voice notes linked to the strokes written meanwhile; everything saved on the device first |
| Evidence & Source Lock | citations that open the exact page and region; Lecture Only / References / Lecture + References enforced on the server |
| Search | keyword and exact-phrase search over sources, questions, notes, generated content and transcripts (Arabic-normalized) |
| Question Vault | extraction of questions, options and keys from your files and photos, separate key states (source key, missing, AI-derived, conflicting, unresolved), automatic linking to lecture pages, duplicates kept with every occurrence, version history with labelled derived versions |
| Course Brain | concepts, relations stated in your lectures (with the quoted sentence), algorithms / flowcharts read from numbered steps and figures, topics that gather lectures, questions, cases and your attempts, course coverage and knowledge maps |
| Study modes | تعلّم / افهم / تدرّب / راجع / امتحن نفسك: the same workspace re-arranged; «امتحن نفسك» hides explanations, solutions and evidence previews |
| Practice & exams | practice with hints, exams with a fixed timer policy and no answer leaks, results by lecture and concept |
| Learning | flashcards (basic, cloze, image occlusion, from mistakes) with FSRS, Weakness Center, Mistake Genome, planner, one-tap revision, Exam DNA, Anki-compatible text export |
| Cases & media | owner-written clinical cases, OSCE checklists and viva; image explorer with non-destructive overlays and image quiz; audio playback with manual / VTT / SRT transcripts |
| Devices & data | offline downloads, sync between devices without losing writing, backup + verified restore, export to Markdown / print-ready HTML / JSON / Word (DOCX) / PDF (the original PDF with your writing drawn on it; other exports through LibreOffice when it is installed) |
| Quality & control | Personal Control Center: live capabilities with reasons, processing and review queues, sync conflicts, client error log and failure trends, the evaluation runs (`npm run eval`), the allowed external visual-source registry |
| Academic OS preview (release R1-a, single owner) | writing layers on every document (show / hide per study session, «اكتب هنا», read-only layers that are never changed — writing on one is re-created in «ملاحظاتي» with the reason shown), a per-layer history, copying one layer; lecture numbers, names and dates read from the file and only **proposed**; «إصدار جديد من …» when an upload matches a lecture you have, with a side-by-side page comparison before you confirm; «انقل ملاحظاتي إلى الإصدار الجديد» — a **copy, never a move**: preview, one tap, a report, one-step undo and a review list for what changed; e-ink, high-contrast and lite display modes kept per device. Nothing of it was run on an iPad, S Pen or e-ink device ([`docs/CAPABILITY_MATRIX.md`](docs/CAPABILITY_MATRIX.md)) |
| Writing comfort (parity N1, release R1-b) | up to 12 colour slots per tool with a meaning saved on each stroke and «اعرض هذا المعنى فقط»; scribble-to-erase, circle + hold → lasso, two- / three-finger tap undo / redo (each switchable); eraser by type, «امسح الصفحة» with counts first and one undo; lasso chips; free resize and rotation; an arrangeable toolbar per study mode; palm-rejection levels and pen feel per nib (latency measured in this browser, never assumed); dashed / dotted lines, a pencil, an eyedropper, a zoom writing window that advances right to left, insert space and straighten, a long-press page menu, filled / rounded / labelled shapes with pathway heads (activation, inhibition, conversion — always spoken), connectors that follow their shapes, snapping guides, a ruler and a labelled **educational** measurement, a neat-copy view that never changes the stored ink. Headless Chromium only — **no iPad, S Pen or BOOX was used** ([`docs/modules/ink.md`](docs/modules/ink.md)) |
| Accounts foundation (release R1-b) | one database («vault») per account beside a system database; on the first boot of this release an R1-a server shows an upgrade page (`/api/maintenance`) and, only after the owner confirms with the current password, moves the existing database **byte for byte** into account #1 (journaled, resumable, with a verified backup first and a rollback); per-account storage on each device; encrypted backups (`npm run backup -- --encrypt`), storage and AI allowances per account; «نسخة من بياناتي» and deleting an account exist as server APIs only (no screen yet). There is **no sign-up screen yet**: in this release the owner is the only account (channels and other users arrive with R1-c) — see [Updating](#deploy-from-a-phone-no-computer) |
| Hosting from a phone | a Render Blueprint (`render.yaml` + `Dockerfile`) deployed from GitHub with a persistent disk, nightly **encrypted** off-site backups to Cloudflare R2 that are verified before upload, a one-command restore, status in «مركز التحكم» → «النسخ الاحتياطي خارج الخادم» — see [Deploy from a phone](#deploy-from-a-phone-no-computer) |

| needs `ANTHROPIC_API_KEY` on the server | shown as «تحتاج إعدادًا على الخادم» until then |
|---|---|
| Explanations (explain, simplify, translate, explain the figure), contextual chat, Study Book, summaries, comparisons, timelines / flowcharts from a selection | all generated text passes server-side evidence checks; unsupported sentences are removed, never softened. A streamed answer is shown as «مسودة لم تُتحقق بعد» until the checked result replaces it |
| Handwriting recognition, reading a figure's structure | need a provider that reads images (vision); the result is labelled derived, shows what is uncertain and can be corrected; your ink and the original figure are never replaced |
| Generated hard MCQs and full simulations, Create MCQ from a selection, answer check for keyless questions, written-answer grading, AI case generation and viva judge | nothing is published or scored unless its evidence is verified |

| not available in this version | why |
|---|---|
| Semantic search, automatic transcription, external image / evidence search | they need an embeddings, speech-to-text or search provider that is not built |
| Native iPad layer (PencilKit, double tap, squeeze, Scribble on the page) | needs a native app; the web ink records pressure / tilt when the browser sends them, but no real Apple Pencil was tested |
| Recognition and lasso actions on a notebook's own page screen, automatic audio ↔ page alignment | not built yet (in the reader they exist; see the matrix) |

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
| `MEDLEVO_TRUST_PROXY`, `MEDLEVO_CLIENT_IP_HEADER` | `false`, empty | `true` only behind your own reverse proxy; a hop count or an address list for a platform (Render uses `1` + `cf-connecting-ip`, [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §8.2) |
| `MEDLEVO_R2_*`, `MEDLEVO_BACKUP_ENCRYPTION_KEY`, `MEDLEVO_BACKUP_SCHEDULE`, `MEDLEVO_BACKUP_KEEP_*` | empty (off-site backups off), `03:15`, 7 / 4 / 1 | encrypted off-site backups to Cloudflare R2 (or any S3-compatible store): bucket, keys, the encryption key (**keep a copy outside the server** — without it no copy can be restored), schedule and retention ([`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md) §6) |
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
  The production setup behind a TLS-terminating reverse proxy (Secure cookie, `MEDLEVO_TRUST_PROXY`, Origin / CSRF
  checks, setup token) is exercised by `apps/server/test/deploy/tls-proxy.test.ts` with a self-signed certificate made
  at test time — not on a real host. Reverse proxy examples, backups on a schedule and the update plan:
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Deploy from a phone (no computer)

**بالعربية.** لا تحتاج حاسوبًا: كل خطوة تتم من متصفح الهاتف أو الآيباد. اتبع الدليل
[`docs/DEPLOY_PHONE_AR.md`](docs/DEPLOY_PHONE_AR.md) خطوة بخطوة: مكان النسخ الاحتياطية في Cloudflare R2، ثم تشغيل
الخادم على Render من مستودع GitHub، ثم حفظ مفتاح التشفير، وإنشاء حساب المالك، وتثبيت التطبيق على الشاشة الرئيسية،
والتأكد من وصول النسخ إلى R2، والاستعادة بأمر واحد.

**In English.** The supported hosted setup needs only a phone or tablet browser:

1. **Cloudflare R2** — create a bucket and an API token for it (the guide's step 1).
2. **Render** — «New → Blueprint» on this repository: `render.yaml` builds the root `Dockerfile` (Node 22, poppler,
   LibreOffice, Arabic fonts) and runs it with a persistent disk at `/var/data`. Render asks for the R2 values (and
   `ANTHROPIC_API_KEY`, which may stay empty); the setup token and the backup encryption key are generated by Render.
3. **Copy the encryption key from Render → Environment and keep it outside Render** (the guide's step 3) — without it
   no off-site copy can be restored.
4. Open the `onrender.com` address, create the owner account with the setup token, and add the app to the home screen.
5. «مركز التحكم» → «النسخ الاحتياطي خارج الخادم» → «نسخ احتياطي الآن» checks the first encrypted copy reaches R2; then
   it runs every night (each copy is verified by a full restore before it is uploaded).
6. Restore: one command in the Render Shell (`medlevo-restore-offsite --latest`) restores beside the live data, and one
   variable switches to it — the guide's «الاستعادة» section.

Technical record: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §8 (image, proxy trust on Render, disk layout) and
[`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md) §6 (encryption format, retention, restore). The Docker image was
built and run in this development container, and the off-site path was tested against a signature-checking S3 fake.
**Not run:** a real Render or Cloudflare account, and a real phone or iPad (none available here) — where the providers'
screens differ from the guide, what you see wins. Prices in the guide were read from the public pages on 2026-10-20.

**Updating** (code, schema, models, sources):

0. **First update from release R1-a to R1-b (accounts):** follow
   [`docs/DEPLOY_PHONE_AR.md`](docs/DEPLOY_PHONE_AR.md) «التحديث الأول إلى نظام الحسابات المتعددة» (Render) or
   [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §6.1 (your own server): back up first, then open `/api/maintenance` after
   the deploy and confirm with your current password; the steps and the rollback order are summarised in
   [`docs/academic-os/BUILD_PLAN.md`](docs/academic-os/BUILD_PLAN.md) §1.3 «Release R1-b». Never start a rollback with
   Render's «Rollback» button.
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
server on it with `MEDLEVO_DATA_DIR`. Local archives are **not encrypted** unless you run
`npm run backup -- --encrypt` (needs `MEDLEVO_BACKUP_ENCRYPTION_KEY`; keeps only the encrypted `….tar.gz.mlenc`, which
`restore:verify` accepts) — store plain ones accordingly. Off-site copies
(when `MEDLEVO_R2_*` is set) are encrypted on the server before upload and verified by a full restore first. The offline
copy on a device is not a backup. Details: [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md).

## Tests

| command | what it does |
|---|---|
| `npm test` | unit and integration tests of all workspaces (shared, server, web) |
| `npm run typecheck` | TypeScript checks for shared, server, web and the E2E harness |
| `npm run build` | production build of the web app (PWA) |
| `npm run e2e` | Playwright end-to-end tests against the real server (phone + desktop; see [`e2e/README.md`](e2e/README.md)) |
| `npm run lint` | ESLint (flat config at the root: typescript-eslint recommended + react-hooks), zero warnings allowed |
| `npm run eval` | per-axis accuracy evaluation on the Golden Set and acceptance fixtures, JSON + Markdown report ([`docs/EVALUATION.md`](docs/EVALUATION.md)) |
| `MEDLEVO_PERF=1 …` | opt-in performance and resilience suites ([`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)) |

AI paths are tested only with a test-only fake provider (no key is used in tests); with no key the E2E suite checks
that every AI feature honestly reports that it needs configuration. The latest full run, with exact commands, counts
and what was not run (real iPad / Apple Pencil, Safari, screen readers, a live AI provider, a real Anki import), is in
[`docs/TEST_LOG.md`](docs/TEST_LOG.md). CI (`.github/workflows/ci.yml`) runs typecheck, lint, the unit tests, the web
build and the evaluation regression set (compared with `docs/eval/baseline.json`) on every push and pull request; the
E2E job is optional (manual dispatch). The workflow has not run on a GitHub runner yet; each of its commands was run
locally.

## Project layout

```
packages/shared/    typed contracts shared by server and web (zod schemas, enums, rich text / bidi, page labels)
apps/server/        Fastify API: src/modules/<module>/ (23 modules), db/migrations/, cli/ (backup, restore-verify, restore-offsite, eval), test/
apps/web/           React PWA: src/app (shell, routes), src/design (design system), src/lib (api, sync, offline),
                    src/features/<feature>/ (20 features), test/
apps/native/        Capacitor shell skeleton for the later store apps (static checks only; nothing built or signed yet)
e2e/                Playwright specs against the real server
deploy/, Dockerfile, render.yaml   container image and the Render Blueprint (hosting from a phone)
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
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | production setup: reverse proxy + TLS, environment, setup token, backup schedule, update and rollback plan; §8 Render + R2 |
| [`docs/DEPLOY_PHONE_AR.md`](docs/DEPLOY_PHONE_AR.md) | (Arabic) step-by-step deploy, off-site backup and restore from a phone or iPad only |
| [`docs/academic-os/`](docs/academic-os) | the Academic OS design (PRD, IA and journeys, architecture delta, build plan with its releases — R1-a and R1-b in §1.3) and the second owner spec in [`docs/spec/`](docs/spec) |
| [`docs/EVALUATION.md`](docs/EVALUATION.md) | the accuracy evaluation (axes, regression vs tuning sets, honest rates) and the compare-and-rollback procedure |
| [`docs/design-system.md`](docs/design-system.md) | tokens, components, accessibility rules |
| [`docs/SKILLS_AUDIT.md`](docs/SKILLS_AUDIT.md) | skills actually used to build MedLevo, and the capabilities still needed |
| [`docs/modules/`](docs/modules) | per-module notes: what is implemented, tested, not done, and why |
| [`docs/adr/`](docs/adr) | architecture decisions (stack, AI provider) |
| [`e2e/README.md`](e2e/README.md) | how the end-to-end suite runs and how to write a spec |
