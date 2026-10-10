# Document processing (track A2)

Scope: `apps/server/src/modules/processing/**`, migration `0200_processing.sql`, `apps/server/test/processing/**`,
one additive change in `apps/server/src/db/db.ts` (SQL function registration), and the new shared contract
`packages/shared/src/processing.ts` (+ one export line in `packages/shared/src/index.ts`).
Spec: §07, §13, §14, §15, §16 (lecture kind only), §17, §52, §53, §55, §57; AC-02, AC-03, AC-04, AC-08, AC-25.

## Contract with the sources module

* The sources module creates `source`, `source_version`, `stored_file` (and `source_page` rows for `image` /
  `image_set`, with `render_file_id` = the image and `section_key` = the file name) and enqueues
  `process_source_version` (`PROCESS_JOB_KIND`) with `ProcessJobInput { version_id, page_indexes?, reason? }`.
  Everything after that is this module. The input is validated with a strict zod schema at enqueue time.
* Legacy `.doc/.ppt`: `format='pdf'`, `file_id = NULL`, `original_file_id` = the OLE2 file. Processing converts it.
* `source_version.display_file_id` (column added by the sources migration 0150) is written here:
  PDFs → the PDF itself; PPTX → a LibreOffice PDF rendering (best effort); legacy DOC/PPT → the converted PDF.
* Processing WRITES: `source_page` (upsert, never duplicated), `source_region`, `image_asset`,
  `document_chunk` (+ `chunk_fts` through triggers), `review_queue_item` (kinds `ocr_error`, `unreadable_page`,
  `classification_suggestion`, all with `details_json.origin = 'processing'`), and on `source_version` /
  `source`: `processing_status`, `processing_summary_json`, `page_count` (paged formats only), `file_id`
  (legacy conversion only, never overwritten), `display_file_id`, `lecture_kind` (+ origin `'auto'`).
  An owner-set printed label (`printed_label_origin='owner'`) and an owner-set lecture kind are never overwritten.

## Pipeline (`pipeline.ts`, job version `process-v1`, max 3 attempts, 60 min timeout, concurrency 1)

`inspect` → per page `extract / OCR / layout / persist` → `layout` (cross-page links) → `structure` → `index` → `validate`.

* **Progress**: `run.progress({stage, done, total, unit:'pages'})` with real counts; the version summary
  (`ProcessingSummary`) is rewritten after every page so ready pages can be read early (§13).
* **Checkpoints** (AC-25): `inspect`, `page:<i>:ocr` (render file id, OCR words, quality), `page:<i>:regions`.
  A page step REPLACES the page's previous regions / image assets / open processing review items in one
  transaction, so a crash between "rows written" and "checkpoint recorded" never duplicates anything on retry.
* **Page failures** (AC-03): any non-retryable error inside a page marks only that page `failed` with an
  Arabic `error_detail`; the version becomes `partial`; failures are not checkpointed, so a re-run retries them.
  Retryable `JobError`s and aborts (timeout, cancel, shutdown) propagate to the queue (retry/resume).
* **Re-processing** `page_indexes`: only those pages are replaced; chunks are rebuilt as a DIFF
  (unchanged chunks keep their ids; chunks of the re-processed pages get the new region ids). Regions already
  cited by `evidence` (or image assets used by overlays) are never dropped: the replace fails with
  `REGIONS_IN_USE` and the page keeps its previous content (re-processing should then create a corrected version).
* **Status** (`summary.ts`): `ready` = every page ready; `needs_review` = all processed, some need review;
  `partial` = some failed or never processed (`coverage_complete=false`); `failed` = nothing readable / fatal
  file error (invalid or password-protected PDF, missing converter, unreadable OOXML, missing file).
  The source mirrors the version the owner studies (`frozen_version_id ?? current_version_id`).

### Formats

| Format | How |
|---|---|
| PDF | `pdfjs-dist` 6 legacy build in Node (`disableFontFace`, `fontExtraProperties` for bold detection, cMaps/standard fonts/wasm from the package, `maxImageSize` cap). `/PageLabels` → `printed_label` origin `pdf_page_labels`; otherwise page numbers detected in the header/footer bands with a cross-page offset check (≥ 2 agreeing pages, majority) → `detected_text`; never invented. Page size from the unrotated view box (pt), intrinsic `/Rotate` stored. |
| Scanned / image-only PDF pages | Page has < 25 body chars and images/vector drawing (or a non-blank render) → poppler `pdftoppm -cropbox` render (200 dpi, lowered for huge pages to a 36 MP budget) stored as `render_file_id` → tesseract.js OCR. Digital text is kept where it exists (OCR words overlapping digital text are dropped). A page with no text and nothing drawn is verified blank by a 50 dpi render before being called empty. |
| Images / image sets | tesseract.js on each page; PNG scans also get quality metrics. No text → the image itself becomes a `figure` region + `image_asset` (never an "empty page"). Regions carry `locator.file_name`. |
| DOCX | mammoth document model (`transformDocument`): headings (`Heading N`/`Title`/`عنوان N`), numbered paragraphs → `list_item`, tables (colSpan/rowSpan from mammoth), embedded images → `figure` + `image_asset`. Pages are `docx_section` per top-level heading (a single document-title heading does not split), `printed_label` NULL, no bbox; every region has `locator {paragraph_index, heading_path[]}` (paragraph_index = index of the body-level block). |
| PPTX | jszip + a minimal non-validating XML parser (`xml.ts`, rejects DTDs). Slide order from `presentation.xml` `sldIdLst` → rels; slide size from `sldSz` (EMU→pt); shape boxes from `a:off/a:ext` with group transforms; placeholders without `xfrm` inherit layout/master positions; title placeholders (or, if none, the largest-font short shape in the top third) → `heading`; bullets → `list_item`; tables (`gridSpan/rowSpan/hMerge/vMerge`); pictures → `figure` + `image_asset`; speaker notes → `note`. Pages `kind='slide'`, `printed_label` = slide number, origin `slide_number`. Display PDF via LibreOffice when installed (warning otherwise). |
| Legacy DOC / PPT | LibreOffice headless in an isolated temp dir (`-env:UserInstallation=file://<tmp>/profile`, `--norestore`, own HOME/TMPDIR, generated input name, 180 s timeout, process group SIGKILL on timeout/abort, temp dir always removed). The PDF is stored, `file_id`/`display_file_id` set, then processed as PDF. No soffice → version `failed` with a specific reason. |

### Text hygiene (`text.ts`)
Logical order, bidi controls stripped, Arabic presentation forms → base letters, odd spaces normalized, NFC.
* **Reversed lam-alef repair** (known fixture defect «األلم» → «الألم», «اإلنجاب» → «الإنجاب»; LibreOffice exports also give
  «االلتهاب» → «الالتهاب», «االنسداد» → «الانسداد»): a bare alef followed by ANOTHER alef (bare, hamza or madda) + lam at a
  word start, optionally after up to two one-letter proclitics (و ف ب ك) — a sequence Arabic orthography never has.
  Tested against false positives («ألم», «أل», «إلى», «إلا», «الآن», «آلة», «لألم», «سألت», «الالتهاب», «اللاإرادي», «لالتهاب» …).
  A reversed «لا» INSIDE a word («العلاج» → «العالج», «السلام» → «السالم») cannot be told apart from a real «ال»; when the
  document shows the defect (a word-start repair anywhere in its text layer, detected at inspect, or on the page), digital
  regions with such words are flagged `needs_review` + `ocr_error` (`ambiguous_lam_alef`, the words listed in the reason).
* **Suspicious extraction → `needs_review` + `ocr_error` item with a specific Arabic reason**: a single Latin letter glued
  to an Arabic word (tanween/damma mapped by the font's ToUnicode table: fixture «عادةS», «يPعد»), a diacritic before
  its base letter (seen in LibreOffice-converted PDFs), U+FFFD, private-use glyphs, control characters.
  The text is stored as extracted (not "fixed" by guessing).
* **Mixed-direction lines** (`layout/lines.ts`): runs are ordered by visual position; in an RTL line consecutive LTR
  runs form islands read left→right (neutrals join an island only between two LTR runs); LTR lines mirror this.
  Paragraph direction of mixed lines comes from alignment (flush-left vs flush-right), else script majority.

### Layout (`layout/page.ts`, `layout/tables.ts`)
* Layout runs in the page's DISPLAY space (intrinsic `/Rotate` applied: what the reader sees) and every box is mapped back
  to the unrotated page box before it is stored (`pdf.ts pageView`, `pipeline.ts regionsToPageSpace`).
* Rows → segments (split at large gaps and at vertical ruling lines) → blocks (line spacing, overlap, size, weight).
  OCR words are grouped by the engine's own line ids and sized by tesseract's row height.
* Header/footer: band lines (top/bottom 8 %) repeated on ≥ 2 pages and ≥ 40 % of pages (digits ignored), or a lone page
  number → `header`/`footer` (excluded from chunks and from search).
* Reading order: column-aware XY-cut — a vertical gutter whose two sides overlap vertically splits columns (ordered by
  page direction), otherwise split at horizontal gaps next to full-width elements, otherwise top-to-bottom.
* Headings by font size (≥ 1.15 × document body size; OCR ≥ 1.3 × page median and confident ≥ 70) or bold short lines;
  heading `locator {font_size}` (PDF/OCR) or `{heading_level}` (office); levels are ranked per version at index time.
* Lists (bullets, `1.`, `a)`, `أ.`), captions (`Figure/Fig./شكل/صورة/…` and `Table/جدول` + number).
* **Tables**: ruled grids from the operator list (stroked lines, thin filled rectangles, stroked rectangles; CTM tracked);
  a missing inner separator = merged cell; header rows = bold rows (or a top title row merged across all columns).
  Borderless tables from ≥ 3 rows of short segments aligned on column anchors (prose never qualifies).
  `TableStructure {rows, cols, cells[{r,c,rowspan,colspan,header,text,bbox}], caption_region_id}` + one `table_cell`
  child region per non-empty cell (`locator {r,c,rowspan,colspan,header}`); units verbatim.
* **Figures**: image placements from `paintImageXObject` / inline / mask ops with the current transform (images
  < 50 % of the page; 50–90 % only on pages with digital text and when ≤ 30 % of the body text sits on top of the
  picture — otherwise it is a background/template; ≥ 90 % is a scan/background). Caption linked on the page (nearest figure caption below,
  else above) and across adjacent pages in the version pass; paragraphs mentioning "Figure N"/«الشكل N» →
  `referenced_by_region_ids`. `image_asset` (origin `source`) with a PNG crop rendered by pdftoppm at 200 dpi;
  `image_kind='diagram'` only when the caption says so (flowchart/algorithm/pathway/diagram/مخطط), else `unknown`.
* **Diagrams (AC-08)**: without a vision model the crop is OCR'd (sparse mode); labels become a `diagram` child region
  with `DiagramStructure {nodes[certainty:'uncertain'], edges: [], understanding:'labels_ocr_only'}`, status `uncertain`.
  Connector glyphs read as single letters are dropped; edges/relations are never inferred.

### OCR (`ocr.ts`)
tesseract.js 7, `eng+ara` `4.0.0_best_int` from `@tesseract.js-data/*`, copied once into `DATA_DIR/tessdata`
(cache `DATA_DIR/tessdata-cache`); one lazily created worker per app, recognitions serialized, terminated on close.
Region `confidence` is stored on a **0–1 scale** (page `ocr_confidence` too). A region needs review when its weakest
word is < 60 % (the reason lists the weak words). Scan quality (`png.ts`, PNG only): contrast (paper vs darkest 0.2 %)
< 90 or edge sharpness < 0.4 → page `needs_review`, `error_code LOW_QUALITY_SCAN`, one page-level `ocr_error` item.
OCR finding nothing on a PDF page → `no_text_found` + `unreadable_page` item (never "empty").
**Coverage check (G3, `coverage.ts`)**: on image pages and pure scans (PNG), text-like ink that no OCR word covers is
found (line bands → ink segments; pictures, rules, borders ignored). Then the page is read again as one block (PSM 6)
and only the words that fall where the first reading read nothing are added; writing still unread → page
`needs_review`, `error_code TEXT_NOT_READ`, an `ocr_error` item with the places (`details.not_read`). Found by AC-13:
PSM 3 read the stem of an Arabic question photo and silently dropped its four options. Not done for JPEG (no decoder).

### Index (`chunks.ts`, `chunk-v1`) and search
* Chunks: paragraph/list groups under one heading path (≤ ~1200 chars), each table (serialized with header context:
  `Header: value | …`), each figure (caption + uncertain labels), speaker notes. Header/footer, cells and diagrams are
  not separate chunks. Image/slide pages never flow into each other. `prev/next` links, `token_estimate`.
* **Normalized FTS** (migration 0200): `chunk_fts` stays external-content, but the triggers index
  `ml_norm(text)` / `ml_norm(heading_path)`; `ml_norm` = `normalizeForSearch` from `@medlevo/shared`, registered as a
  deterministic SQL function on every connection in `db/db.ts`. The migration rebuilds the index with `delete-all` +
  normalized re-insert. The update trigger only fires on `text`/`heading_path` changes.
* `search.ts → searchChunks(db, scope: {versionIds}, query)`: scope is required; the version filter is in the same
  SQL statement as `MATCH`, so out-of-scope chunks never reach ranking/LIMIT.

### Structure (`structure.ts`)
Lecture kind (only `source_type='lecture'`, only for the studied version, never over `origin='owner'`): keyword
families (clinical / practical / theoretical, Arabic + English, normalized) → kind or `mixed`, with Arabic reasons;
weak signal → no suggestion. Writes `lecture_kind` + origin `auto`, an audit entry, and a `classification_suggestion`
review item with the reasons. Concept/term extraction is out of scope (not built).

### API & capabilities
* `GET /api/processing/status` → `ProcessingToolsStatusResponse` (pdftoppm / LibreOffice / tesseract availability with
  Arabic purpose and reason, live `processing.*` feature states, pipeline + index versions). Owner session required.
* Capabilities set at registration: `processing.pdf`/`docx` available; `pptx` available (reason when no display PDF
  possible); `images`/`zip` need the OCR models; `ocr` needs models + pdftoppm; `legacy_office` needs LibreOffice;
  `vision` `not_implemented` (shown as `requires_configuration` while no AI provider).
* Module options (`createProcessingModule({ tools, ocr, hooks })`): tool overrides and test-only fault-injection hooks;
  the default export uses auto-detection from `PATH` and no hooks.

## Tested (2026-10-09, real results)

`apps/server/test/processing/`:
* `golden.test.ts` (22 tests) — every Golden Set fixture through the real pipeline: page counts; labels 11–14
  (`pdf_page_labels`) and 31–32 (`detected_text`); mixed_scanned page 2 OCR'd with `pylori` / `urea breath test` and the
  Arabic OCR line in logical order without bidi marks; two-column reading order; table 10×3 with the merged
  «Alvarado score (MANTRELS)» header (colspan 3, header) and `> 10 ×10⁹/L` in the right cell; figure ↔ «Figure 1»
  caption, reference paragraph, PNG crop asset, uncertain diagram labels with no edges; Arabic must-contain strings
  after lam-alef repair and no reversed forms stored; the «عادةS» region flagged with an `ocr_error` item; header/footer
  excluded from chunks; summary/status/lecture kind; question sources keep NOT/EXCEPT and units; question photo OCR with
  the hand-marked option flagged; low_quality_scan → `needs_review`; zip pages in natural order 01, 02, 10 with file
  names; DOCX paragraph locators/headings/heading paths and no page numbers; PPTX 3 slides with titles, slide labels,
  shape boxes and (with LibreOffice) a display PDF; normalized search «الالم» → «الألم».
* `pipeline.test.ts` (16 tests) — crash after page 2's rows are written (retryable error, before its checkpoint) →
  resume on attempt 2, pages 0–1 not re-run, identical regions/chunks/review items/assets to a clean run (AC-25);
  forced failure on page 1 → version/source `partial`, failed page listed with Arabic reason, others readable and
  indexed (AC-03); re-processing only that page keeps other pages' region ids and unchanged chunk ids, and repeating it
  is idempotent; evidence-cited regions are not dropped (`REGIONS_IN_USE`); no pdftoppm/LibreOffice/OCR → honest
  capabilities + `/api/processing/status` (401 without session), scanned page `needs_ocr` + `unreadable_page`, image kept
  as figure, legacy `.doc` → `CONVERTER_MISSING`; invalid PDF → `PDF_INVALID`, not retried; missing version; malformed
  input rejected; owner lecture kind preserved; real progress; normalized + scope-filtered search (filter before
  ranking/LIMIT, abstains outside scope, FTS integrity after re-index); real `.doc` → PDF conversion with LibreOffice
  (the converted Arabic paragraph's misplaced damma is flagged).
* `units.test.ts` (28 tests) — lam-alef repair and its false positives, suspicion rules, run cleanup, bidi line
  assembly, direction from alignment, segment splitting, line joining, page-number parsing and cross-page consistency,
  header/footer signatures, captions/references/lists, XY-cut order (LTR/RTL, no false columns), ruled tables incl.
  merged title row and serialization, PNG round trip/crop/quality/blank/decompression-bomb refusal, XML DTD refusal,
  lecture-kind suggestion, tool timeout kill and converter failure.

Commands run:
* `npm test -w @medlevo/server` → **17 files, 261 tests passed** (includes the other tracks' tests).
* `npx tsc -p apps/server --noEmit` → exit 0; `npx tsc -p packages/shared --noEmit` → exit 0;
  `npm test -w @medlevo/shared` → 4 files, 37 passed; `npx tsc -p apps/web --noEmit` → exit 0;
  `npm run build -w @medlevo/web` → exit 0 (shared index gained one export).
* ESLint not run: the repository has no `eslint.config.*`. `tsc --noUnusedLocals --noUnusedParameters` reports nothing
  in this module.

## Not done (and why)
* **Vision understanding of figures/diagrams** (`processing.vision`): needs an AI vision provider; only OCR labels,
  explicitly uncertain. No arrows/edges are ever produced.
* **Concept / term candidate extraction** (§16): out of scope for this track.
* **Page thumbnails** (`thumbnail_file_id`) are not generated (the web reader renders PDFs itself).
* **Vector-drawn figures** (flowcharts made of paths, no image): not detected as figures; their digital text stays as
  ordinary text blocks.
* **OCR table detection**, multi-column OCR beyond the generic XY-cut, and OCR rotation detection (OSD) are not built.
* **JPEG/TIFF quality metrics**: the quality check decodes PNG only (no image library); other formats rely on OCR
  confidence alone.
* **Legacy PPT slide numbers**: converted PPT pages are `kind='slide'` but get no printed label (hidden slides may be
  skipped by the converter, so the PDF page order cannot be trusted as the slide number).
* No dedicated reprocess route here: the sources module already exposes `POST /api/sources/versions/:id/reprocess`.

## Known limits
* The lam-alef rule repairs only the word-initial pattern; mid-word reversed ligatures cannot be told apart from real words
  (they are flagged for review in documents that show the defect, so such documents produce many review items).
* Scan-quality thresholds were calibrated on the Golden Set renders (crisp pages: contrast ≈ 238, sharpness ≥ 0.65;
  the low-quality fixture: 52 / 0.27); unusual scans may need tuning.
* `ml_norm` is a connection-level function: a tool that opens the database without `db/db.ts` (e.g. the `sqlite3` CLI)
  cannot write `document_chunk` (trigger error). If `normalizeForSearch` ever changes, a new migration must rebuild
  `chunk_fts` (the delete entries must match what was indexed).
* JSZip/mammoth inflate OOXML parts in memory; declared part sizes are capped (64 MB per XML part, 400 MB media) but a
  package lying about sizes relies on the upload-time archive checks of the sources module.
* Re-processing creates new region ids for the re-processed pages; anchors held by other modules must re-anchor
  (cited regions are protected, see `REGIONS_IN_USE`).
* The job runs one version at a time (`concurrency: 1`); a 500-page scanned PDF takes roughly 1–2 s per page for OCR.

## Independent review (2026-10-09)

An adversarial review re-read the module, ran every fixture plus hand-made variants (rotated pages, CropBox, LibreOffice
Arabic export, large figures, cancel/failure paths) and fixed what it confirmed. Each fix has a regression test in
`apps/server/test/processing/review.test.ts` that was checked to FAIL with the fix reverted. Derived fixtures are in
`apps/server/test/processing/fixtures/` (synthetic, TEST FIXTURE; regenerate with `make_fixtures.py`: pypdf, reportlab,
LibreOffice).

Fixed:
* **Major — pages with an intrinsic `/Rotate` were laid out sideways.** Rows, columns, bands and tables ran in the
  unrotated user space, where the text of a `/Rotate 90/180/270` page runs vertically or upside down: reading order
  scrambled («2scannedPage—(imageonly)page» from OCR), header/footer swapped, a 10 × 3 table read as 3 × 10, and the
  stray-«S» tanween defect split into its own region and passed silently. Layout (and the inspect bands/page numbers)
  now run in display space; boxes are mapped back to the unrotated page box. Test: `rotated_lecture.pdf` (rotations
  90/270/180/90) gives the same regions, kinds, order, flags and table as the upright original, with boxes equal to the
  exact inverse rotation (tolerance 0.003).
* **Major — OCR boxes and figure crops were offset when CropBox ≠ MediaBox.** pdftoppm rendered the media box while
  pdfjs reports the crop box. Now `pdftoppm -cropbox`. Test: `rotated_cropped_scan.pdf` (rotated scan with a crop box):
  OCR text in order and boxes within 0.01 of the expected crop-box coordinates.
* **Major — common reversed lam-alef words were stored silently.** Only the hamza forms were repaired; LibreOffice
  exports also reverse the plain «لا» after the article («االلتهاب», «االنسداد», «واالختبار», «بااللتهاب»), and mid-word
  reversals («العالج» for «العلاج») passed as `extracted`. Word-start double alef is now repaired; ambiguous mid-word
  words are flagged in documents that show the defect. Tests: unit (repairs + false positives) and `arabic_lam_alef.pdf`.
* **Major — a failed/cancelled re-processing left chunks citing deleted regions.** Replacing a page deleted its regions,
  but chunks were only rebuilt at the end of a successful run. Now a page replace drops that page's chunks in the same
  transaction, and the final failure path (cancel, fatal error, last attempt) re-links figures and rebuilds the index.
  Test: re-processing that fails 3 times leaves 0 chunk→region dangling references and the page searchable.
* **Major — a caption printed on the next page blocked re-processing that page** (`image_asset.caption_region_id` FK)
  and reported the misleading `REGIONS_IN_USE` ("evidence cites it"). The cross-page link is now released and re-linked
  by the version pass; stale caption ids in figure structures are dropped. Test at the persist/structure level.
* **Major — a large figure (≥ 50 % of a digital page) was dropped silently** (no figure region, no asset, orphaned
  caption, page `ready`). Pictures of 50–90 % on pages with digital text are figures unless the text sits on top of
  them (background). Test: `large_figure.pdf` (64 % diagram kept with its «Figure 3» caption; a full-page background
  under ten text lines is not a figure and all lines stay text).
* **Minor — resource limits:** page renders are capped at a 36 MP budget (`renderDpi`); images over 40 MP are not sent
  to OCR (kept as figure, `IMAGE_TOO_LARGE`, needs review); one OCR recognition is limited to 5 min and a hung worker is
  replaced (a terminated tesseract.js worker is never reused: its async `send` would raise an unhandled rejection).
* **Minor — a cancelled/timed-out last attempt left the current page `processing` forever.** It is now `failed` with
  `PROCESSING_INTERRUPTED` and an Arabic reason (previous content kept). Test: cancel during the OCR render.
* **Minor — owner-reviewed/corrected regions** (`status='owner_reviewed'` or `text_origin='owner'`) are never replaced by
  a re-extraction (`OWNER_REVIEWED_REGIONS`, page kept). No module writes such regions yet; future-proofing.
* **Minor — honesty of the summary label:** a version whose pages could not be read (no OCR / OCR found nothing) now says
  «منها N لم يُقرأ نصها» instead of only "needs your review".

Verified without change: Golden Set assertions are real (structure, labels, OCR text, table merges, links); FTS
normalization and scope-before-ranking; checkpoint resume without duplicates; page failure isolation; `/api/processing/status`
requires the session; tool runs use argument arrays (no shell), generated input names, isolated LibreOffice profile,
process-group kill and temp-dir removal; pdfjs 6 (no eval), XML parser rejects DTDs.

Still open (not fixed):
* JPEG EXIF orientation is not applied before OCR: a phone photo stored sideways is OCR'd (and its boxes are stored) in
  raw pixel orientation while browsers display it rotated. Needs an image decoder/rotator.
* A scanned page that also carries ≥ 25 characters of digital body text (e.g. a watermark line) is treated as digital and
  its picture is not OCR'd (heuristic `MIN_BODY_CHARS`); it is not shown as empty, but the scan's text is missing.
* LibreOffice runs without network isolation: a document with linked (remote) images/OLE objects could make it fetch
  URLs during conversion. Leftover temp dirs after a hard crash are not swept at boot.
* Re-processed pages get new region ids; other modules' JSON anchors to old region ids (annotations, study-book blocks)
  must re-anchor (cited evidence/overlays are protected by foreign keys).
* A protected page (`REGIONS_IN_USE` / `OWNER_REVIEWED_REGIONS`) is marked `failed` although its previous content is
  intact, so the version shows `partial` until a corrected version is made.

Commands (real results, after the fixes):
* `npx vitest run test/processing` (apps/server) → 4 files, 84 tests passed (66 builder + 18 review).
* `npm test -w @medlevo/server` → 20 files, 314 tests passed (all tracks).
* `npx tsc -p apps/server --noEmit` → exit 0; `--noUnusedLocals --noUnusedParameters` → nothing in processing/db.ts.
* `npx tsc -p packages/shared --noEmit` → exit 0; `npm test -w @medlevo/shared` → 37 passed; `npx tsc -p apps/web --noEmit` → exit 0;
  `npm run build -w @medlevo/web` → exit 0.

## G1 acceptance fix (2026-10-10, AC-02 / AC-03)
* **A PDF page with damaged content was stored as a «ready» empty page.** A page whose content stream cannot be decoded
  (or references a missing image object) renders blank, so the blank-page check called it empty: page `ready`, version
  `ready`, `coverage_complete=true` — the stumble was invisible. Poppler reports the damage on stderr while exiting 0.
  `tools.ts`: `renderPdfPage({ onDiagnostics })` + `popplerReportsDamage(stderr)` (errors count, warnings do not);
  `pipeline.ts`: such a page is `needs_review`, `text_status='no_text_found'`, `error_code='PAGE_CONTENT_DAMAGED'`, an
  `unreadable_page` review item and a specific Arabic reason. A genuinely blank page stays `ready`.
  Tests: `apps/server/test/acceptance/g1-ac03.test.ts` (fixture `fixtures/acceptance/g1_damaged_page.pdf`), also the
  real image-set failure path (`g1_partial_images.zip`, truncated PNG → `OCR_FAILED`, version `partial`). See `docs/ACCEPTANCE.md`.

## Integration round I2 — performance & resilience (2026-10-10)
Measured with generated large fixtures (see [`docs/PERFORMANCE.md`](../PERFORMANCE.md); suite `apps/server/test/perf/`,
`MEDLEVO_PERF=1`). One hot spot fixed here:
* **A page photo above the OCR pixel budget was still fully decoded** for quality metrics it never uses (the metrics
  only qualify OCR text, and such a page is never OCR'd): a 6000×8000 RGB PNG cost 2.6 s and +568 MB of process memory
  (high-water 226 → 793 MB). `processImagePage` now checks the pixel count first and skips the decode above
  `MAX_OCR_PIXELS` (13 ms, +1 MB). Outcome unchanged (`IMAGE_TOO_LARGE`, figure region, review item).
  Test: `test/processing/large-image.test.ts` (fails on the old code).
* Measured, not changed: 300-page digital lecture 22.7 s (≈ 31 ms per text page, ≈ 87 ms per dense two-column page),
  live heap flat at ≈ 149 MB after GC from page 50 to 300; scanned pages ≈ 7.6 s each (tesseract eng+ara, one worker);
  a SIGKILL of the server mid-run resumes from the page checkpoints with no duplicated rows (see core-server notes).

## Acceptance round G4 — AC-11 (2026-10-10)

Three text-layer defects found with `fixtures/acceptance/g4_*.pdf` (reportlab and Word → LibreOffice exports) and fixed;
regressions in `apps/server/test/acceptance/g4-ac11.test.ts` (8 of its 12 tests fail with the fixes disabled):

* **Super/subscripts typed as font effects** (`layout/lines.ts attachScripts`, called by `groupRows` for digital runs):
  pdf.js gives «10<sup>9</sup>» / «PaCO<sub>2</sub>» as separate smaller runs on a raised / lowered baseline. They were stored
  as «11.5 × 109/L» (another value) and «PaCO 52 mmHg» + a stray «2» paragraph. A run of ≤ 4 characters, ≤ 85 % of the
  size of the run it touches (gap ≤ 0.3 × size), ending ≥ 30 % of the host size above its bottom (raised) or starting
  ≥ 40 % below its top (lowered), is written with Unicode super/subscripts when every character has one (digits, + − = ( ) n)
  and joins its host's line. A smaller run on the same baseline is untouched.
* **«×» / «÷» were strong LTR** (`text.ts STRONG_LTR_RE` covered U+00C0–U+024F, which includes U+00D7 / U+00F7): inside an
  Arabic line «11.5 ×10⁹/L.» was stored «11.5 L/10⁹× .». They are neutral now.
* **Reversed negation words** (`text.ts fixReversedLamAlef`): the stand-alone «لا» came out as «ال» and «إلا» / «ألا» as
  «إال» / «أال» (reversed lam-alef ligature) — the negation vanished without any flag. Whole-word repair: «ال» / «وال»
  followed by an Arabic word → «لا» / «ولا»; «إال» / «أال» → «إلا» / «ألا». Counts as a ligature fix (the document is then
  treated as reversing ligatures, so ambiguous inner «ال» words are flagged as before).


## G8 acceptance fixes (security, 2026-10-10)
* **LibreOffice never reaches the network** (`tools.ts convertToPdf`, `officeEnv`): a PPTX (fixed slide rendering) or a
  legacy .doc / .ppt (conversion) whose picture is only a LINK (`r:link` / `TargetMode="External"` / INCLUDEPICTURE) made
  LibreOffice fetch that URL — any host, internal addresses included (an SSRF from an uploaded file; confirmed with a
  local trap: 3 requests per conversion). Every conversion now runs with a pre-seeded profile
  (`registrymodifications.xcu`: `BlockUntrustedRefererLinks`, macros off, manual HTTP/HTTPS proxy on the closed
  loopback port 1, empty no-proxy list) and the same proxy in its environment. Tests:
  `apps/server/test/acceptance/g8-security.test.ts` (PPTX + DOC → zero requests to the trap, the rendering / conversion
  still produced), `e2e/g8-security.spec.ts` (real server). Fixtures: `fixtures/acceptance/g8_linked_image.{pptx,doc}`.

## Track F3 — the vision step for figures: `analyze_figure` (2026-10-10; §13, §14, AC-08)

* **On demand only** (never part of the upload pipeline): `POST /api/processing/figures/:regionId/analyze` (rate-limited)
  queues job `processing.analyze_figure` for a figure region (a diagram child resolves to its parent figure; any other
  kind → 400; a figure without a crop → 409). The job sends the figure crop with its caption and OCR blocks to the AI
  task `vision_figure` (lecture-only scope pinned to the region's version) and stores the result in `figure_reading`
  (migration `0210_figure_reading.sql`) — a DERIVED reading beside the region: `source_region`, its OCR text and its
  `DiagramStructure` are never modified.
* **Certainty** (`readingStructure`, exported and unit-tested): a box is `read` only when the model is clear AND its label
  is confirmed by the OCR text; an arrow is `read` only when the model is clear and both ends are read; arrows to unknown
  boxes are dropped with a note; `unreadable` → failed. The reading is `uncertain` until the owner reviews it and
  `usable_as_fixed_answer` is true only for an `owner_reviewed` reading whose region still exists — nothing (exams, image
  quiz, generation) consumes an unreviewed reading (AC-08).
* **Review**: `POST /api/processing/figure-readings/:id/review` `{decision: 'confirm' | 'reject', nodes?, edges?, note?}` —
  confirm stores the owner's version (corrected labels, the kept relations; everything confirmed becomes `read`) in
  `reviewed_structure_json`, the model reading stays as it was; audited in `change_log`. Reads:
  `GET /api/processing/figures/:regionId/readings` (with `can_analyze` and its reason), `GET
  /api/processing/figure-readings/:id`.
* **Capability**: `processing.vision` is now registered (`available` from the module) and gated by the AI task
  `vision_figure` (`settings/capabilities.ts FEATURE_AI_TASK`): without a provider it is `requires_configuration` with
  «… تسميات الرسوم تُقرأ دونه بالـOCR فقط وتبقى «غير مؤكدة»، ولا تُستنتج الأسهم.»; the API answers 409 before touching
  the region.
* **Web**: «المصادر» → a figure / diagram row → «بنية الشكل (قراءة بصرية)» (`features/workspace/panels/FigureReadingPanel.tsx`).
* Tests: `srv:f3/ai-tools.test.ts` (scripted vision: uncertain reading with the image sent, region unchanged, confirm with
  a label correction → usable, reject, unreadable → failed, confirming a failed reading 409, paragraph 400),
  `srv:f3/unconfigured.test.ts` (requires_configuration + 409; `readingStructure` units),
  `web:src/features/workspace/modes/studyModes.test.tsx` (panel gated; confirm keeps only ticked relations),
  `e2e:f3-study-modes.spec.ts` (page 14 flowchart of the Golden Set lecture: panel disabled with the reason, API 409,
  region status unchanged).
* Not run: a real vision model (no key). Arrow direction quality on real figures is therefore unmeasured.
