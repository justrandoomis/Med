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
