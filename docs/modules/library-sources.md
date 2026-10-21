# Library & Sources (track A1)

Owner of: `apps/server/src/modules/{library,sources}/**`, migrations `0100–0199`, `apps/server/test/{library,sources}/**`,
`apps/web/src/features/{library,upload,sources}/**`, this file. Spec: §02, §05, §06, §07, §13 (upload), §18, §23, §49,
AC-01, AC-03 (status display), AC-04 (labels display). Contracts: `packages/shared/src/sources.ts` (consumed exactly) and
`packages/shared/src/library.ts` (added by this track: tags, topics, templates, cover tokens, request bodies,
`UploadInfoResponse`, `NodeLinksResponse`, `ProcessingStatusResponse`).

## 1. Server

### Migrations
* `0100_library_trash.sql` — `library_node.trash_root_id` + indexes (deleted_at, trash root, topic_link entity).
* `0150_sources_registry.sql` — `source.trash_root_id`, `source.source_type_origin` ('auto' = upload suggestion,
  'owner' = chosen/confirmed), `source_version.display_file_id` (the fixed-page PDF rendering written by processing),
  indexes (content_hash, last_opened_at, page/version, link target).

### `/api/library`
| route | notes |
|---|---|
| `GET /tree?include=archived,trash` | `LibraryTreeResponse` (nodes + SourceSummary with tags). Archived subtrees and trash only on request. |
| `GET/POST/PATCH /nodes[/:id]` | kind, parent, title, description, cover (`{style, color token, symbol token}`), colour/icon tokens, template key, sort_mode, favorite. Raw hex/unknown tokens/unknown kinds → 400. Rename keeps the id (links/citations survive); audited as `rename`. |
| `POST /nodes/:id/move {parent_id, before_id?\|after_id?}` | cycle prevention (into itself or a descendant → 400 «لا يمكن نقل المجلد إلى داخله…»), fractional `sort_order`, siblings renumbered when gaps < 1e-6; subject/course of every source inside is recomputed. |
| `POST /nodes/:id/archive \| unarchive` | archive is a view filter (no cascade, nothing hidden from other modules). |
| `POST /nodes/:id/trash \| restore {parent_id?}` | trash marks the node AND every not-yet-trashed descendant node/source (`deleted_at`, `trash_root_id` = the node), so every module keeps filtering on `deleted_at IS NULL`. Restore clears exactly what it trashed; items trashed on their own earlier stay in the trash. Restoring a child that went with its parent → 409 `trashed_with_parent`; parent still in the trash → 409 `parent_in_trash` (send `parent_id`). |
| `GET /nodes/:id/impact?mode=purge\|trash` | `ImpactReport` (nodes, sources, versions, pages, annotations, notes, questions, flashcards, artifacts + Arabic lines, incl. «N items outside cite these sources»). `purge` adds a `confirm_token` (HMAC, 15 min, bound to kind+id+a fingerprint of the counts). |
| `DELETE /nodes/:id?confirm_token=` | permanent purge — only from the trash, only with a valid token; a token issued before the content changed → 409 (re-confirm). |
| `GET /nodes/:id/links` | every `source_link` among the sources inside the subtree (course view). |
| `POST /nodes/from-template`, `GET /templates` | 12 optional study templates (anatomy, physiology, biochemistry, pathology, pharmacology, microbiology, internal medicine, surgery, pediatrics, obgyn, radiology, community medicine) with an `explanation_template` key and an editable skeleton (Arabic-first folder names). |
| `GET /recent`, `GET /favorites` | by `last_opened_at`; favorite nodes + sources. |
| tags | `GET/POST /tags`, `PATCH/DELETE /tags/:id` (case-insensitive unique; deleting a tag never deletes items), `POST /tags/:id/links`, `DELETE /tags/:id/links?entity_type&entity_id`. |
| topics | `GET/POST /topics`, `PATCH/DELETE /topics/:id` (parent cycles refused), `GET /topic-links`, `POST /topics/:id/links` (owner → accepted), `PATCH /topic-links/:id {status}`, `DELETE /topic-links/:id` (an auto link is marked rejected, not deleted). Service `suggestTopicLink(ctx, …)` (for other modules) never overrides an existing owner decision. |

### `/api/sources`
| route | notes |
|---|---|
| `POST /upload` | multipart: `node_id` (required), `source_type?`, `title?` (single file), `on_duplicate?=create`, files. Each file streamed to a private temp file, then inspected **from content** (`sniff.ts`): `%PDF` (pdfjs: password-protected/corrupt → rejected with reason; owner-restricted readable → accepted with a note; page count recorded) · ZIP (`[Content_Types].xml`+`word/` → DOCX paragraphs, `ppt/` → PPTX slides with slide count; xlsx/ODF/EPUB rejected; header-declared bomb check) · other ZIP → image set via `lib/safe-zip` (dir mode, one image ≤ the upload limit), images kept in natural order, every skipped entry reported with an Arabic reason; an archive whose images exceed the total uncompressed limit is rejected WHOLE (never stored truncated) · OLE2 → `.doc`/`.ppt` accepted as convert-only (`format pdf`, `file_id null`, `original_file_id` set) **only if LibreOffice is on PATH**, encrypted OOXML/xls rejected · PNG/JPEG/WebP/GIF/TIFF → image (+ pixel size; TIFF from its first IFD wherever it lies) · MP3/M4A/WAV/OGG → audio (`lecture_audio`/`my_audio_note`), stored with an honest summary «التفريغ النصي غير متاح» and no job · HEIC/AVIF/BMP/SVG/video/RAR/7z/gzip/executables/HTML/RTF/plain text/empty → rejected with a specific reason. Per-file size limit (oversized file rejected, the rest continue). Rejected files are never stored. |
| | duplicates: sha256 of the uploaded bytes against every `source_version.content_hash` → `duplicate` + `duplicate_of` (says when the match is in the trash); nothing is created or deleted unless `on_duplicate=create` (then created, version note flags it). Same bytes are stored once (content-addressed store). |
| | creates source (title = file name without extension; `source_type` = owner's choice or the file-name suggestion with origin `auto`; subject/course from ancestors), version 1 `original` with format/pagination (pdf→pages, pptx→slides, docx→paragraphs, image(_set)→images, audio→timestamps), image pages (`kind image`, natural order, `render_file_id`, `section_key` = entry path), then enqueues `PROCESS_JOB_KIND` with idempotency key `process_source_version:<version>:upload` and an initial honest `ProcessingSummary` (`queued`, real `pages_total`). Without a registered handler the upload still succeeds and the summary says processing is unavailable; `enqueuePendingVersions()` queues such versions on the next boot (`onReady`). Per-route rate limit 300/min (the web sends one file per request). |
| `GET /upload-info` | real max upload size, ZIP entry limit, whether `.doc/.ppt` conversion and processing are available. |
| `GET /:id` | `SourceDetail` (+ `source_type_origin`): versions with parsed summary, links (trashed counterparts hidden), breadcrumb. |
| `GET /:id/versions/:versionId/pages`, `GET /pages/:pageId/regions` | `SourcePagesResponse`, `PageRegionsResponse`. |
| `PATCH /:id` | title, source_type (→ origin owner), node_id (move + context), language, edition, authors, publication_date (YYYY[-MM[-DD]]), original_url (http/https only), lecture_kind (→ origin owner), priority, selection_reason, metadata_status, is_favorite. Bibliographic data entered by the owner moves `unknown → partial`; nothing is ever filled automatically. Unknown keys → 400. |
| `POST /:id/move`, `/open`, `/archive`, `/unarchive`, `/trash`, `/restore {node_id?}` | drag-and-drop ordering, last opened, archive, trash/restore (same semantics as nodes). |
| `POST /:id/freeze {version_id\|null}` | Source Freeze; never changed automatically (a replacement keeps the frozen version active). |
| `POST /:id/versions` | replacement upload → version N `replacement` (`derived_from` previous current), processing enqueued (`replacement`), `content_alert` `source_replaced` listing `artifact_dependency` dependents of earlier versions. Identical content to an existing version of this source → `duplicate`, nothing created. |
| `POST/DELETE /:id/links[/:linkId]` | `reference_for`, `question_source_for`, `audio_for`, `same_topic`; idempotent; no self links. |
| `GET /:id/impact`, `DELETE /:id?confirm_token=` | same purge machinery for one source. |
| `POST /versions/:id/reprocess {page_indexes?}` | always a NEW job (fresh idempotency key); 409 `FEATURE_DISABLED` without a handler or for audio. |
| `GET /versions/:id/processing` | `{summary, job}` (latest job for that version). |

### Permanent purge (`sources/purge.ts`) — policy
One transaction over TEMP purge-set tables (no SQL parameter limits). **Deleted**: the nodes and sources of the subtree,
their versions/pages/regions/chunks/evidence/image & audio assets, artifacts whose primary source is purged (blocks,
claims, citations), questions that occur ONLY in purged versions (versions, options, keys, attempts, links, duplicates,
FTS rows), flashcards made from purged sources (+ review events/state), the owner's annotations on purged pages/note
pages, notes in purged folders or anchored to purged sources, study sessions, threads, progress, tag/topic links,
review-queue items. **Kept but unlinked**: claims outside the purge set that cited purged evidence → `needs_review`;
dependent artifacts → `stale`; one `content_alert` `source_deleted` lists them; questions that also occur elsewhere keep
their other occurrences; sources outside the subtree lose a purged subject/course pointer. Sync clients are told about
every deleted owner entity (`sync.touch`). **Safety net**: every foreign key into the purge set is introspected
(`pragma_foreign_key_list`); a table this module does not know (e.g. added later by another module) that still references
the purge set without `ON DELETE CASCADE/SET NULL` aborts the purge before anything is deleted (409, «لم يُحذف أي شيء»).
**Files**: after the commit, each stored file referenced by the purged rows is deleted (row + blob) only if no foreign key
anywhere still references it (shared/deduplicated blobs stay).

### Capabilities
`library` and `upload` → available; `processing.legacy_office` → available only when `soffice`/`libreoffice` is on PATH
(`MEDLEVO_SOFFICE_AVAILABLE=0|1` overrides), otherwise `requires_configuration` with the reason. Other processing keys
belong to the processing track.

## 2. Web (`features/library`, `features/upload`, `features/sources`)
* **المكتبة** (`/library`, `?view=favorites|recent|archive|trash`): notebooks as covers (cloth colour token, linen/grid/dots
  weave, binding spine on the inline-start edge, paper title label in Noto Naskh) — the one expressive element; lists
  elsewhere stay quiet. Title search (Arabic-normalized, across the tree, shows the path), tag filter, root sort mode
  (per device), «جديد» → notebook dialog (live cover preview, colour/symbol radiogroups with RTL arrow keys) or study
  template picker. Archive view with unarchive. Trash view: restore (asks for a destination when the original parent is
  in the trash) and «حذف نهائي» → ConfirmDialog showing the server's impact lines; typing the title is required when the
  owner's own writing would be deleted; a changed impact (409) is re-fetched and shown.
* **Folder / course** (`/library/:nodeId`): breadcrumbs, mini cover, counts, upload-here, create inside, sort mode (PATCH),
  item menus (rename & cover, move…, move up/down, tags…, favorite, archive, trash with impact). Course nodes group all
  sources of the course subtree into المحاضرات / المراجع / مصادر الأسئلة / ملاحظاتي and show the links between them.
  Drag & drop: pointer (mouse, pen, touch) drag handle → drop on a folder row, cover or the page header; the handle is
  hidden from assistive tech and below 30rem — «نقل…» (folder picker, cycle-unsafe targets disabled with the reason) is
  the keyboard/phone path.
* **رفع مصادر** (`/upload?node=`): destination picker, optional type (default: suggestion per file), drop zone + file
  picker, the server's real limits, per-file rows: real byte progress (XMLHttpRequest upload events), «يفحصه الخادم»,
  accepted (detected type + suggested type, then live processing stage + real page counts by polling
  `/versions/:id/processing`, «التفاصيل والصفحات», «افتح للقراءة» once pages are ready), rejected with the reason and every
  skipped ZIP entry, duplicate with a link to the existing source and «أضفه نسخةً مستقلة», network error with retry.
  One file per request (real per-file progress; one failure never blocks the rest).
* **تفاصيل المصدر** (`/sources/:sourceId`): header (type, format, extent, processing status, «النوع مقترح تلقائيًا»,
  frozen badge), «افتح في مساحة الدراسة» gated by `workspace.reader` (disabled with the reason until the workspace
  exists), tabs: الصفحات (summary + per-page table: printed label vs file position «ص 11 (الصفحة 1 في الملف)», text status,
  OCR confidence, status, failure reason, «إعادة المعالجة» per failed/needs-review page and for the whole version, gated by
  the format's processing capability; DOCX/audio notes instead of invented pages; 100 rows at a time), البيانات (form;
  empty bibliographic fields are shown as «غير معروف»; nothing guessed), النسخ (freeze/unfreeze, replacement upload with
  progress and note), الروابط (add/remove reference / question-source links).
* **Offline**: `useQuery(…, {cache: true})` stores the last good GET answer in Dexie `apiCache`; when the server is
  unreachable the library tree, favorites, recent, templates and source detail are shown read-only with a notice; all
  mutations are disabled.

## 3. Tests & commands (real results, 2026-10-09)
* `npm test -w @medlevo/server` → 17 files, 262 tests passed (this track: `test/library` 17, `test/sources/upload` 17,
  `test/sources/sources` 12). `npm test -w @medlevo/web` → 9 files, 81 passed (this track: 2 files, 21 tests).
  `npm test -w @medlevo/shared` → 37 passed. `npx tsc -p apps/web --noEmit` and `-p packages/shared` → clean;
  `npx tsc -p apps/server --noEmit` → clean for this track's files (errors at the time only in the annotations track's
  in-progress `modules/annotations/repo.ts`). `npm run build -w @medlevo/web` → success.
* Server tests: AC-01 personal library (no institution routes/capabilities); rename keeps ids + audit; token validation;
  manual ordering + renumbering; cycle prevention; context recompute on move; archive; trash/restore subtree incl.
  independently trashed items and both 409 paths; impact counts on a seeded subtree (annotations, notes, question +
  attempt, flashcard + review, artifacts inside and outside); purge needs trash + token, rejects tampered/foreign/expired/
  stale tokens, deletes exactly the subtree, keeps + flags outside artifacts/claims, removes orphaned blobs from disk,
  keeps a deduplicated blob, announces deletions to sync; unknown referencing table aborts the purge; tags; topic
  decisions persist; templates; recent/favorites; auth + CSRF. Uploads of every Golden Set type (PDF with page count +
  job input/key, DOCX, PPTX, PNG pages, ZIP natural order + the exact rejected entries of `expected.json`), type
  suggestions vs ground truth, owner type wins, password-protected vs owner-restricted PDF, garbage/fake PDF/text/HTML/
  executable/HEIC/BMP/empty/RAR, ZIP traversal/no images/xlsx/ODF/broken DOCX, legacy office with and without
  LibreOffice, audio, per-file size limit, sniffing table, mixed multi-file results, duplicates (never deleted, forced copy,
  in-trash wording), request validation + auth, no processing handler + later boot enqueue. Detail/patch/move/freeze/
  replacement/content alert/reprocess/pages/regions/links/course links/upload-info/source purge.
* Web: `src/features/library/model.test.ts` (tree, sorting, cycles, search, tags, trash roots, course groups, Arabic
  counts, extents) and `src/features/upload/upload.test.tsx` (result presentation, byte progress, rendered rows for
  rejected ZIP/duplicate/accepted with live processing/error, XHR uploader with a fake XHR, OCR confidence label,
  metadata patch builder).
* Visual: `node apps/web/src/features/library/visual-check.mjs <server> <outdir>` against the REAL server (throwaway
  data dir, built web served by the server, real processing track running): 56 screenshots at 390×844 and 1280×800 in
  light and dark + an offline (cached, read-only) check; fails on console/page errors and horizontal overflow (none).

## 4. Deviations & known limits (honest list)
* **Purge writes other modules' tables** (claims, artifacts, questions, flashcards, annotations, notes, alerts…). There is
  no owning service for most of them yet; doing it here in one transaction is the only way to keep a permanent delete
  atomic. The FK safety net blocks unknown references. Owners of those tables should review the policy in §1.
* Stored files are removed by deleting the `stored_file` row + blob directly (FileStore has no delete API).
* `tests`: core's `apps/server/test/ai.test.ts` asserted `library` was `not_implemented`; updated that one line to
  `available` (the module now exists).
* Web trash roots are derived from `deleted_at` timestamps (the shared `LibraryNodeView` does not expose
  `trash_root_id`); an item trashed in the same millisecond as its parent would be grouped with it.
* Sources have no `sort_order` in `SourceSummary`, so «manual» order of sources = server order (upload order or
  `POST /sources/:id/move`); the web offers move-up/down only for folders.
* DOCX/PPTX zip-bomb check at upload uses header-declared sizes; real inflation limits are the processing track's job.
  M4A accepted by brand (`M4A`/`M4B`); MP4 video, HEIC, AVIF are rejected with reasons.
* Audio: stored only; transcription is not implemented (`workspace.audio` untouched).
* Legacy `.doc/.ppt`: accepted only when LibreOffice exists; the conversion itself is done by the processing track.
* Uploads are sequential, one file per request, not resumable.
* Root sort mode is stored per device (localStorage); folder sort modes are synced (server).
* `POST /sources/:id/open` is called when the owner opens a source from the source screen; the workspace should call it
  as well.
* **Not run**: real iPad/iPhone Safari, VoiceOver/NVDA passes, axe/Lighthouse audits.

## 5. Independent review (2026-10-09) — fixes and remaining risks
Reviewed adversarially (server + web), probed against the real modules, then fixed with a regression test each
(`apps/server/test/sources/review.test.ts`, `apps/web/src/features/library/review.test.tsx`, additions in
`apps/web/src/features/upload/upload.test.tsx`).

**Fixed**
* Purge returned 500 (FK violation, nothing deleted) when a question version OUTSIDE the purge set was derived from a
  purged one — `question_version.derived_from_version_id` was listed as «handled» but never cleared. Now the outside
  version is kept, its lineage pointer cleared, and it is listed as an external dependent in the `source_deleted` alert.
* Purge left the processing jobs of purged versions queued (they later ended as «failed: version not found»). They are
  now cancelled right after the commit.
* Purge deleted contextual study conversations (threads + messages) without listing them in the impact. They are now
  counted (`threads` in the removed counts / fingerprint) and get their own impact line.
* An image ZIP over the total uncompressed limit was accepted TRUNCATED (only the first images, note hidden in the
  version). It is now rejected whole with the reason; per-image size is capped at the upload limit (also bounds memory).
* A registration that failed after the blobs were stored (folder/source trashed or purged while uploading) left orphaned
  blobs and answered «خطأ داخلي». The blobs are removed again (shared/deduplicated ones stay) and the owner gets a specific
  Arabic 409 reason. A replacement upload now also re-checks that the source is not in the trash inside the transaction.
* TIFF pages had no pixel size (the IFD usually lies after the pixel data, beyond the sniffed head). `tiffSize()` reads the
  first IFD at its offset; image pages get width/height (also used by processing as the geometry fallback).
* Web: restoring a folder whose original parent is in the trash could not be confirmed to the library root (the
  preselected root counted as «unchanged»). `MoveDialog` has `requireChange` (false for restore).
* Web: after «إعادة المعالجة» the status view kept showing the finished job (polling had stopped); it now follows the new job.
* Web: the upload screen used a stale `?node=` (trashed/deleted folder) while showing «لم تختر مجلدًا بعد»; it now needs a
  real destination (archived folders are valid destinations, as on their folder screen).
* Web: «افتح للقراءة» on the upload screen is gated by `workspace.reader` like the source screen.
* Web: typed confirmation of a permanent delete now also applies when question attempts / flashcards (review history)
  would go, not only ink and notes.
* Web copy/a11y: byte sizes are isolated LTR runs («B 8» → «8 B»); failed-page count uses Arabic number agreement
  («11 صفحة»); accessible names contain the visible label (label-in-name) for «استعادة», «حذف نهائي», «إعادة المعالجة».
* Test hygiene: the «random bytes» rejection case had fixed first bytes added (random ones could look like an MP3 frame
  or a JPEG and make the test flaky).

**Remaining risks (not changed here)**
* Policy: notes anchored to a purged source are deleted even when they live in a folder outside the purged subtree
  (listed in the impact and covered by the typed confirmation). Keeping them with the anchor cleared would be gentler;
  it touches the annotations track's note anchoring.
* TIFF images are accepted and OCR'd, but Chrome/Firefox cannot display TIFF; the reader shows «تعذّر تحميل صورة هذه
  الصفحة» (Safari displays them). A PNG rendering for display belongs to processing/workspace.
* Two concurrent uploads of identical bytes can both be accepted (duplicate check and insert are not one transaction);
  the web uploads sequentially, so only parallel clients hit it.
* An offline device that later pushes edits for annotations of a purged page could re-create them (annotations track).
* More than 50 files in ONE request answers 413 with a size message (the web always sends one file per request).

## G5 acceptance fix (2026-10-10, AC-16)
* `service.ts enqueueQuestionRefresh`: moving a processed source to another folder / course (PATCH `node_id`, `move`,
  `restore` into another folder) or changing its `source_type` queues the questions module's `match_questions` (or
  `extract_questions` when it became a question source / previous exam). Guarded by `ctx.jobs.isRegistered`, wrapped in
  try/catch (never fails the edit), skipped while the version is still processing (the processing hook does it then).
  Test: `apps/server/test/acceptance/g5-ac16.test.ts`.


## G8 acceptance fix (zip bombs, 2026-10-10)
* **OOXML containers are measured, not trusted** (`upload.ts inspectZip`, `lib/safe-zip.ts` mode `measure`): a DOCX / PPTX
  passed the upload check on the sizes its zip headers DECLARE; a package that lies (a 40 MB part declared as 4 KB, a
  ~50 KB upload) was accepted and would have been inflated whole by the parser (mammoth / JSZip check the size only
  after inflating everything). Every office upload is now inflated once under the zip limits (total, per entry,
  measured ratio), keeping nothing, before it is accepted; lying, bombed or corrupt packages are refused with an Arabic
  reason and no processing job. Test: `apps/server/test/acceptance/g8-security.test.ts`.

## F2 Course Brain additions (2026-10-10, §05 topics)
* **Topic link validation** (`tags.ts ownerLinkTopic`): `POST /topics/:id/links` now refuses an unknown `entity_type`
  (400, the supported list is `TOPIC_ENTITY_TYPES` in `packages/shared/src/brain-api.ts`: source, source_region,
  question, library_node, concept, image_asset, flashcard, note) and a missing entity (404). Before, any string was
  stored. Test: `apps/server/test/brain/relations.test.ts`.
* **Suggested topic links**: the `brain` module calls `suggestTopicLink` after each knowledge extraction (concept /
  lecture / region / question suggestions with their reason); an owner decision (accepted, rejected, deleted auto
  link) is never overridden — see `docs/modules/course-brain.md`.
* **Web**: «الموضوعات» button in the library header opens `/library/topics` (topic list, create / rename / reparent /
  delete, topic page with linked sources, regions, questions, concepts; accept / reject suggestions; link a source, a
  place in a source (source → page → region by its text) or a question). The library takes `?topic=<id>` as a filter (a chip with the topic's linked items replaces the tabs; a
  «موضوع» select sits in the tools row). Screens live in `apps/web/src/features/brain/` (`TopicsScreen.tsx`,
  `TopicFilter.tsx`); `LibraryScreen.tsx` was changed additively. Course pages (`NodeScreen.tsx`) render the course
  content inside `CourseBrainTabs` (المصادر / خريطة المعرفة / التقدم / تغطية الأسئلة); the sources tab is the existing
  course view unchanged.

## Round 7 — H1: the one page label of the server (AC-04, 2026-10-20)
* `apps/server/src/modules/sources/pagelabel.ts`: `pageLabelAr(db, page)` — the label every server module uses to name
  a page («ص 12» / «ص 12 (الصفحة 14 في الملف)» / «الصفحة 1 في الملف» for an unnumbered page in a numbered version /
  «شريحة 3»…). It derives `numbered_version` (some page of kind «page» in the version has a printed number — the same
  rule as the pages endpoint) from the page's `version_id`, its id, or a flag the caller already has; the `LabelPage`
  type requires one of them. `pageLabelKnown` + `versionNumberedSql(alias)` serve list queries. A guard test fails if any
  server file other than this one calls `pageDisplayLabel(` or builds «ص ${…}» by hand.
* Shared `withNumberedVersion(pages)` fills the flag on a version's page list on the web (cached / older answers).
* Tests: `srv:sources/page-labels.h1.test.ts` (guard, helper, one test per producer family), `sh:page-label.test.ts`,
  `web:test/learning/home-page-label.h1.test.tsx`. Details: `evidence-search.md` «Round 7».

## Academic OS P1-T3 — lecture identity, version matching and import intelligence (2026-10-20)

Track P1-T3 of [BUILD_PLAN §3.5](../academic-os/BUILD_PLAN.md) (release R1-a, single owner). Design:
[ARCHITECTURE_DELTA §4.2 (0160, 0161), §6.1, §6.2, §6.9](../academic-os/ARCHITECTURE_DELTA.md). Covers PRD AOS-2.4, 3.2,
3.3, 3.4, 3.5, 3.7, 3.9, 3.11, 3.12, 3.14, 3.18, 19H.2, 21.13. All three steps are built and were **adversarially
reviewed on 2026-10-21** (findings and fixes in «Review» at the end of this section).

### What it does
* **Lecture identity** (`source.lecture_no`, `held_on` + their `*_origin`). After every processing run the versions
  module's background job `analyze_version` reads the file name and the first two pages: «Lecture 5», «Lec 05»,
  «lec5», «محاضرة ٥» (Arabic-Indic digits), «المحاضرة الخامسة / الحادية عشرة / الحادية والعشرون» (ordinal words),
  «lecture five», «5th lecture»; dates with month names (English, Levantine and Egyptian Arabic), ISO and day-first
  numeric dates. A **certain** value (every strong mention agrees, no mention names two lectures: «Lectures 5 & 6»,
  «Lecture 5-6», «Lec 5, 6», «05 + 06», «5 to 7», «المحاضرة الأولى والثانية», «المحاضرتان …»; a date after the number,
  «Lecture 5 - 12.10.2026», is not a second lecture) is stored with origin `detected`; anything else is an **open
  suggestion with no downstream effect** (AOS-3.18). A stored `detected` value that a later analysis contradicts is
  withdrawn (audited) until the owner confirms one; one the later analysis is merely unsure of stays shown as
  «اكتُشف تلقائيًا» with that doubt, and rejecting it clears it. A value the owner set (`owner`) or rejected is never
  changed or proposed again.
* **Import suggestions** (`import_suggestion`, the uploader's review queue): number, date, title (first heading of the
  first page, else the file name without «final (1)», «copy», «v2», «نهائي», «نسخة» …; the original file name stays on
  the version), subject placement (subject/course folders named in the file name or the cover text, bilingual synonyms
  such as Anatomy ↔ تشريح), and «إصدار جديد من …». Titles, subjects and new versions are **always** held for
  confirmation. `(source, field, value)` is unique, so a rejected value is remembered.
* **Page fingerprints** (`page_fingerprint`, processing/fingerprint.ts): sha256 of the normalised logical page text
  (headers, footers and printed page numbers left out), 64 × u32 MinHash over word 3-shingles, the hash of the
  text AND figure / diagram region geometry (`lay50f`), and a 64-bit dHash of the page image only for pages with little
  or no text. Scheme `FINGERPRINT_ALGO = fp2:norm1:sh3:mh64:dh64:lay50f`.
* **Page map** (`version_page_map`, `page_map_run`; versions/pagemap.ts): candidates by identical hash, MinHash
  Jaccard ≥ 0.85, or dHash ≤ 6/64; a maximum-weight order-preserving alignment (weighted LIS); gaps paired as
  «changed» (uncertain); crossing identical pages «moved» (uncertain); near-equal alternatives inside one gap
  uncertain. A page with little text is identified by its picture: the same short caption («Figure 1») on a different
  picture is never `safe`. `safe` + `layout_safe` when the region geometry (or the image) is the same. Owner decisions
  (`confirmed`, `rejected`, method `owner`) survive recomputation and constrain it: a decided page never gets an
  automatic counterpart, and two confirmed pairs that cross (a swap the owner confirmed) are both kept. Thresholds are
  versioned in `PAGE_MAP_ALGO` (`pm2:…`).
* **«إصدار جديد من …»**: a first upload whose pages match ≥ 60 % of another live lecture's pages (candidates found
  through the page-hash index, never a scan of all pairs) is proposed, with the matched / inserted / changed counts and
  «رقم المحاضرة نفسه» when the numbers agree. Accepting adds a `replacement` version to the existing lecture **from the
  same stored file** (no byte copy), processes it, and moves the upload to the trash (restorable) only when nothing of
  the owner's is on it — no writing, note, note page, flashcard or recording made while it was open. Every earlier
  version and note stays as it was. A proposal that names a lecture which is later purged is closed with it.
* **Link candidates** (versions/candidates.ts `matchLinkCandidates`): a pure function — sha256 or ≥ 60 % of the
  candidate's pages — reused by P1-T5; `GET /api/versions/sources/:id/link-candidates` runs it inside this database.
* **Printed contents → page links** (versions/toc.ts): a «Contents» / «الفهرس» page among the first 12 pages is parsed
  (dotted leaders, Arabic-Indic digits, number-first RTL lines); each entry is resolved by the page's printed number,
  then by a heading carrying the entry title, and only as a labelled estimate by file order. Computed on request.
* **Ordering** «حسب الرقم» / «حسب التاريخ» (shared `orderLectures`, natural-title fallback, stable ties): shown on
  `/lectures/order/:nodeId`; applying it is an explicit owner action that writes it as the folder's manual order.
* **Original vs converted files** and the **DOCX display PDF** (`version_rendition`, see
  [processing.md](processing.md)).

### API (`/api/versions`, all owner-authenticated)
| route | notes |
|---|---|
| `GET /sources/:id/identity` · `PATCH` | identity + suggestions + analysis state; PATCH stores the owner's number / date (origin `owner`) |
| `POST /sources/:id/analyze` | re-run the analysis of the current version (a lecture uploaded before this track) |
| `GET /sources/:id/link-candidates` | `LinkCandidatesResponse` (this database only) |
| `GET /suggestions?status=` · `POST /suggestions/:id/decide {action}` | the review queue; accept applies (number, date, title through `SourcesService.patch`, subject through `SourcesService.move`, new version), reject is remembered |
| `GET /compare?from=&to=` · `POST /maps/decide` | `VersionCompareResponse`: rows in the new order, removed pages where they were, a bounded word diff; `state: pending` (with the analysis job) until both versions have fingerprints — the request never renders |
| `GET /versions/:id/toc` · `GET /versions/:id/files` · `POST /versions/:id/docx-display` | printed contents; original / rendered / display files with downloads; re-make the DOCX display PDF |
| `GET /pages/:id/thumbnail` | a PDF page rendered by poppler (child process, 36 dpi; at most 3 renders at a time, the rest wait in order) or a redirect to an image page's own file |
| `GET /order?node_id=&mode=` · `POST /order/apply` | lecture order view / apply |

**THE page-map service for P1-T2 step 3:** `getPageMap(ctx, fromVersionId, toVersionId)` in
`apps/server/src/modules/versions/pagemap.ts` → `VersionPageMap` (`packages/shared/src/academic/versions.ts`). Copy an
item of `entry.from_page_id` to `entry.to_page_id` only when `isCopyTarget(entry)` (status `safe` or `confirmed` with a
target); coordinate-anchored items (ink, shapes, boxes) additionally need `entry.layout_safe` or a `confirmed` entry.
Everything else goes to «تحتاج مراجعة». The service computes missing fingerprints and a stale map, keeps the owner's
decisions, and never moves, copies or deletes anything else. `readPageMap()` is the synchronous read of a stored map.

### Purge and backup
`page_fingerprint` (→ `source_page`), `import_suggestion` (→ `source`) and `version_rendition` (→ `source_version`) cascade
with their parents. The versions module registers its purge extension (`versions/purgeExtension.ts`): it deletes the
`version_page_map` / `page_map_run` rows of purged versions on either side, closes («superseded») the open «إصدار جديد من
…» proposals of other uploads that name a purged lecture or version, adds «مقارنات صفحات بين النسخ (N)» and «نسخ
عرض PDF … (N)» to the purge preview (bound into the confirm token), and queues `versions_release_files` inside the purge
transaction so DOCX display PDFs are released through `files/blobs.ts` after the commit. Backups copy the whole database,
so the new tables are in them; the JSON export (`data/export.ts`, not this track's file) does not list them —
fingerprints and maps are derived and recomputed, the identity columns travel with `source`.

### Web
* Source screen: a new tab **«المحاضرة»** (`IdentityPanel.tsx`): number and date with «اكتُشف تلقائيًا / حددته أنت»,
  an edit form, the suggestions with their reasons and the stated effect of «أكّد», past decisions, «حلّل هذا الملف
  الآن» for older lectures, the printed contents as links into the reader, and the link to the lecture order.
* **«النسخ»**: per version «ملفات هذه النسخة» (original / rendered / display PDF with downloads, the DOCX display PDF
  state, fonts, «أعد إنشاء نسخة العرض») and «قارن مع النسخة N».
* **`/sources/:id/compare?from=&to=`** (`CompareScreen.tsx`): both versions, the open proposal with its confirmation,
  counts, rows with page images (lazy), the change in words («صفحة جديدة», «تغيّرت», «نُقلت من مكانها», «حُذفت»),
  «تحتاج تأكيدك» for uncertain pairs with «نفس الصفحة» / «ليست نفس الصفحة» / «تراجع عن قراري», and the word diff.
* Upload: after processing each accepted file shows its suggestions (bounded polling); **`/upload/suggestions`** lists
  every open suggestion across files.
* Arabic UI, logical properties, colours from tokens (light / dark / e-ink follow the theme), no motion, 44 px touch
  targets (checked by the E2E probe on the phone project).

### Tests (labelled TEST FIXTURES only)
`apps/server/test/versions/{numbering,page-map,new-version-detect,link-candidates,import-intelligence}.test.ts`,
`apps/server/test/processing/docx-display-pdf.test.ts`, `apps/web/src/features/sources/versions.test.tsx`,
`e2e/aos-p1-versions.spec.ts`. Fixtures: `apps/server/test/fixtures/versions/` (`build.ts` generates
`scenario4-v1.pdf` (40 pages) and `scenario4-v2.pdf` (42 pages), checked byte-identical to a fresh build;
`subject-suggestions.json`, 30 synthetic cases).

**Precision, on the labelled fixture set only:** (the 30 cases were written by the builder alongside the rules, so the
number is an optimistic upper bound, not an estimate for real libraries) subject suggestions top-1 precision **22 / 22 = 1.000**, recall
**22 / 24 = 0.917** (misses: «Pediatric cardiology» — singular «pediatric» is not a synonym; «Path lec 2» — «path» is not
an abbreviation we accept). This says nothing about real course files: **Not run (no real course files in this
container; the owner's library was not available)**. Page-map thresholds were tuned on the Scenario 4 fixtures only.

### Deviations and limits (honest list)
* Two tables beyond the design DDL: `import_suggestion` (in 0160; the Control Center review queue cannot apply these
  decisions, so the suggestions have their own queue and screen) and `page_map_run` (in 0161); columns `held_on_origin`
  (0160) and `layout_hash`, `text_len` (0161); and migration **`0164_version_rendition.sql`** (the next free number in
  the sources range; 0162 / 0163 are reserved for P3-T2 / P1-T5).
* The Control Center «قائمة المراجعة» does not list these suggestions; they are on the source's «المحاضرة» tab, after the
  upload and on `/upload/suggestions`.
* The DOCX display PDF is for reading and printing; **the reader still shows DOCX as paragraphs** — choosing the
  displayed file (AOS-3.14, «moderator chooses the displayed file») needs a change in the workspace reader (P1-T2 / P1-T5
  files) and is not offered (no decorative control).
* Versions processed before this track get fingerprints once in the background (`fingerprint_backfill`, queued on boot
  only when such versions exist) but **no suggestions** — the owner asks for them per lecture («حلّل هذا الملف الآن»).
* New-version detection compares with the lecture's current (or frozen) version only, proposes at most one lecture, and
  only for a first upload (a manual replacement is already a version).
* Not run: anything on a real device, real course files, a PDF over a few hundred pages with many image-only pages
  (dHash rendering is per page).
* Online only: identity edits, suggestion decisions, page-map decisions and «اعتمد هذا الترتيب» are server actions (no
  outbox); offline they fail with the network error and change nothing.
* A page with plenty of text is compared by its text and region geometry only (no dHash): a picture REPLACED inside the
  same box on an otherwise identical page is not detected (a moved / resized figure is, since `lay50f`).

### Review (2026-10-21, adversarial, BUILD_PLAN §1.2)
Each fix has a regression test in `apps/server/test/versions/review-regressions.test.ts` (25 tests) or
`apps/web/src/features/sources/versions.test.tsx` («(review)» blocks), each failing before its fix:
* **Major — owner decisions crashed the map.** Confirming two pages whose pairs cross (e.g. a swap of two slides, both
  confirmed «نفس الصفحة»), or a confirmed page that no longer exists, made every recomputation fail with `UNIQUE
  constraint failed` (HTTP 500 on «نفس الصفحة», a map stuck for `getPageMap`). Every decided page is now fixed outside the
  automatic alignment, crossing confirmed pairs are both kept, and the insert never collides with a human row.
* **Major — fingerprint collision on short captions.** Two picture slides with the same short caption («Figure 1») were
  `safe` + `layout_safe` even with completely different images (ink would be copied onto another picture). The images
  now decide for pages with little text. An uncertain pair of two different pictures no longer reads «لم تتغير».
* **Major — a file naming two lectures was stored as certain.** «Lecture 5-6», «Lec 5, 6», «05 + 06», «5 to 7»,
  «المحاضرة الأولى والثانية» were stored automatically as lecture 5 / 1. They are now uncertain suggestions.
* **Major — an uncertain or rejected number kept its effect.** When a later analysis became unsure of (or contradicted) a
  stored `detected` number, the number stayed in effect, and rejecting the (now «open») suggestion left it stored. Now
  contradicted values are withdrawn, doubted ones stay visibly «applied», and reject clears whatever is stored.
* **Minor:** figure / diagram regions now count for `layout_safe` (`fp2`, `lay50f`; old fingerprints are re-made by the
  backfill job); re-making a DOCX display PDF released nothing (orphan blob) and a failed re-run hid the good PDF — now
  the replaced file is released and a failed re-run keeps the previous one; the upload of an accepted «new version» was
  trashed although it carried the owner's flashcards / recordings; proposals naming a purged lecture stayed open and
  failed on accept; page images had no render bound; the identity form sent the date when only the number changed
  (silently answering an open date suggestion and stopping date detection) and refused Arabic-Indic digits typed on an
  Arabic keyboard; the compare breadcrumb named the upload but linked to the lecture; a decision whose page is gone read «أكّدت أنها ليست
  نفسها»; the lecture-order screen had no
  test (now `web:versions.test` «LectureOrderScreen»).
* **Measured here (container, not a device):** 300 → 302 text pages: `getPageMap` 30 ms, compare 26 ms, pure alignment
  20 ms; worst case 300 × 302 identical pages 415 ms before → ≈ 150 ms after the per-page candidate index; dHash
  rendering ≈ 27 ms per image-only page in the background job (60 pages: 1.65 s).
* **Not fixed (not this track's files, reported):** the JSON export (`data/export.ts`) does not carry
  `import_suggestion` and the owner's `version_page_map` decisions (backups do); an image page's «thumbnail» is the full
  stored image (no downscaled preview exists); the LibreOffice output's font check (`pdf-lib`) runs on the job's event
  loop.
