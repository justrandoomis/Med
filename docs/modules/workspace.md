# Module notes — Reader workspace + annotations/sessions server module (track B1)

Owns: `apps/server/src/modules/annotations/**`, migration `0250_annotations.sql` (range 0250–0299),
`apps/server/test/annotations/**`, `apps/web/src/features/workspace/**` except `ink/**` (ink engine track,
see [`ink.md`](ink.md)), this file. Spec: §11, §23–§26, §30, §45–§47, §55, AC-04, AC-21, AC-22, AC-24.

## 1. Server — `/api/annotations`

### Sync entity handlers (`modules/annotations/sync.ts`, ARCHITECTURE §3.4)
Registered with `ctx.sync.registerEntity` for `annotation`, `note`, `note_page`, `study_session`. Payloads are the
shared DTOs (`AnnotationDTO`, `NoteDTO`, `NotePageDTO`, `StudySessionDTO`), validated with zod (`schemas.ts`);
server-managed fields a client sends (rev, timestamps, conflict ids) are ignored. Invalid payloads are **rejected**
(recorded, with an Arabic reason naming up to three fields). Every write touches the change feed in the same
transaction.

| entity | op | policy |
|---|---|---|
| annotation | `append` | insert if absent, else `duplicate` (strokes by id) |
| | `upsert` | absent → insert · `base_rev == rev` → apply (rev+1) · tombstoned → the edit **restores** it (`merged`; an edit concurrent with a delete keeps the edited stroke; also an undo of an erase) · identical content → `duplicate` · stale `base_rev` → **keep both**: the incoming edit is stored as a NEW annotation with `conflict_of_id` → `conflict_kept_both` (entity = the server version) |
| | `delete` | tombstone (`deleted_at`, rev+1) · stale `base_rev` (edited elsewhere since) → not deleted, `conflict_kept_both` |
| note | `upsert` / `delete` | as annotation; a stale edit becomes a separate note with `conflict_of_id` (`conflict_kept_both`); text kept in `owner_content_fts` (normalized search key only; removed on delete); bidi control characters stripped |
| note_page | `upsert` / `delete` | upsert with rev; a stale metadata edit is **rejected with the server copy** (the owner decides; ink lives in annotations); stale delete keeps the page |
| study_session | `upsert` only | `base_rev == rev` → apply; otherwise **rejected with the newer server copy** (§46: never overwritten silently) |

* `annotation_target` is written for every annotation from its anchor (`source_page` / `note_page` / `artifact_block`).
* A page anchor whose page does not exist in that version is **kept** with `anchor_status = needs_reanchor` and
  `previous_anchor` (detail says so) — never dropped, never moved (§25).
* Missing library folders / sources referenced by notes or note pages are not FK errors (which would make the
  client retry forever): the row is kept without the dangling reference and the result says why (`merged`).
* A session for an unknown source, or a version of another source, is rejected with an Arabic reason.

### Read APIs (types in `packages/shared/src/workspace.ts`, added by this track)
| route | returns |
|---|---|
| `GET /by-targets?keys=source_page:<id>,note_page:<id>,…[&include_deleted=1]` | live annotations of up to 200 targets |
| `GET /source/:sourceId?version_id=` | everything written on a document (page annotations of the version(s), note pages + their annotations, notes) — offline download / seeding |
| `GET /notes?source_id=&node_id=&page_id=` | notes (a filter is required) |
| `GET /needs-reanchor?source_id=` | annotations flagged `needs_reanchor` with source title and the previous location in Arabic |
| `GET /sessions/latest?source_id=` | newest session of a source |
| `GET /sessions/recent?limit=` | Continue Studying: latest session per source (trashed sources skipped) with title, version (and whether it is the active one), page `label_ar` («ص 13 (الصفحة 3 في الملف)»), reading progress |
| `POST /progress {source_id, version_id, page_index \| page_indexes}` | adds viewed pages (a set) for one version; `reading_progress = viewed / total` |
| `GET /progress/:sourceId` | the same view |

Reading progress is **pages shown on screen** only (§45) — the response has no mastery/coverage fields and the
shared `mastery_estimate` column is never written. Pages of another version are not mixed in
(`source_progress.progress_version_id`, migration 0250).

Capabilities: `workspace.reader` = available; `workspace.ink` = available (the ink engine track verifies the
engine itself; per-device pressure/tilt is reported by the engine, §27).

Migration `0250_annotations.sql`: `annotation.conflict_of_id`, `note.source_id` + `note.anchor_target_key`
(denormalized from the anchor for indexed «ملاحظاتي» queries), `note_page.rev/device_id`,
`source_progress.progress_version_id`, read-path indexes.

## 2. Web — `features/workspace` (route `/study/:sourceId?v=<versionId>&page=<index>`)

| area | files | what it does |
|---|---|---|
| Loading & restore | `WorkspaceScreen.tsx`, `data/useSourceDocument.ts`, `session/useStudySession.ts`, `model/session.ts` | detail → **session decision** (which version/page) → pages + PDF. Precedence: explicit URL place → this device's IndexedDB session → server latest → first page. A newer position from **another device** is never applied silently: a dialog asks («موضع أحدث من جهاز آخر»); a save the server refused (stale rev) lands in `kv` via the applier and asks the same way; a move pulled while reading shows a non-blocking banner. Zoom is restored only from the same device (a desktop zoom is wrong on a phone). URL place params are removed after use so a reload resumes the session. |
| Autosave | `data/local.ts` (`saveSession`), outbox entity `study_session` | page, page offset, zoom/fit, view rotation, layout, rail (open/width/tab), page panel, split — debounced 1.2 s, flushed on hide/leave. |
| Book Canvas | `reader/BookCanvas.tsx`, `reader/geometry.ts`, `reader/PageView.tsx`, `reader/pdfDoc.ts` | pdf.js canvas (DPR-aware, pixel-capped, re-rendered into a fresh canvas so zoom never flashes blank) + pdf.js **TextLayer** (selectable, transparent, in the unrotated page space; `lang` from the source). Pages laid out from known sizes (real PDF boxes override stored sizes once measured) and **virtualized**: only pages within ±1 viewport render; canvases outside are released (`width=0`). Layouts: continuous, single, two-page spread (only when two readable pages fit; RTL order for Arabic books), persisted in owner settings. Zoom: buttons, presets, fit-width, `+`/`-`, Ctrl/⌘+wheel and Safari trackpad gestures and two-finger pinch with a 1:1 transform preview committed around the focal point. View rotation (intrinsic `/Rotate` + view). The place (page + fraction under a reading line at 25 % of the viewport) survives zoom, rotation, layout, resize and re-open. Optional fast flip animation (setting; reduce-motion → fade; off → instant); flips (keys, swipe) are refused **during a pen stroke** (`InkLayer.onStrokeActiveChange`) or a text selection. |
| Non-PDF | `PageView.tsx` | images: `render_file_id` + an OCR text layer from regions (selectable, read by screen readers; alt text when there is no OCR text); DOCX / slide text: paper sections of `RichTextView` paragraphs («قسم n», paragraph locators, no fake page numbers, no ink); PPTX uses `display_file_id` when present. |
| Page identity (AC-04) | `model/pages.ts`, `chrome/GoToPage.tsx` | folio under every page «ص 13 · الصفحة 3 في الملف»; indicator in the bar; go-to accepts printed labels («12», «ص ١٢», «xii») and file positions («#14», «ملف 14», «الصفحة 14 في الملف»), prefers the printed label and offers the other reading. |
| Overlays | `reader/overlays.tsx` | `<RegionHighlight pageId bbox>` (reusable), text highlights/underlines (multiply, never hide text), search hits — all in the unrotated page space so they follow zoom/rotation exactly. |
| Source Jump & Back (§11) | `nav/SourceNavigation.tsx` | context `useSourceNavigation()` → `openSourceLocation({sourceId, versionId, pageId\|pageIndex, bbox, regionId, label})` (scrolls, highlights, records a back entry; another source/version → `/study/…` URL; a version that no longer exists is refused — never swapped silently), `goBack()` restores page, offset, zoom, fit, rotation and layout («العودة إلى موضعك»); the stack survives cross-source jumps (sessionStorage). |
| Ink integration | `WorkspaceScreen.tsx`, `PageView.tsx` | `<InkProvider documentKey>` per source version, `<InkToolbar/>` in the bar, `<InkLayer targetKey anchor view interactive onStrokeActiveChange/>` on every rendered page with the exact transform (page box in pt, css scale, total rotation). Writing tools make the text layer inert (no selection/writing conflict, §26). The workspace renders `text_highlight` and `bookmark`; the ink engine renders the rest and owns the `annotation` applier. |
| Selection toolbar (§26, §30) | `selection/*` | highlight / underline → `text_highlight` annotation (quote `{exact,prefix,suffix}` + normalized rects, local-first: IndexedDB + outbox), remove overlapping highlights, copy (logical text), add an anchored note (quote kept as a quote paragraph), and the AI/learning actions (Explain, Simplify, Translate, Ask, Compare, Create MCQ, Create Flashcard, Add to Revision, Explain Image) **disabled** with the capability reason, or «لم تُربط هذه الأداة بمساحة الدراسة بعد» when the capability exists but the reader is not wired yet. Phones: one-row bar at the bottom (the system menu sits above the selection). |
| Search (§26) | `chrome/SearchPanel.tsx`, `model/search.ts` | all pages (pdf.js text content / OCR / paragraphs) with the shared Arabic search key (harakat, alef forms, ta marbuta, Arabic-Indic digits, case); line ends count as spaces; real progress counts; result list with page identity and snippet; hits highlighted on the page; Enter/Shift+Enter step. |
| Top bar | `chrome/TopBar.tsx` | back to the library folder, title (direction from its own text), page indicator / go-to, view menu «المحاضرة الأصلية» \| «كتاب الدراسة» (disabled: «لم يُنشأ كتاب الدراسة بعد…») \| «جنبًا إلى جنب», search, zoom group, view options (layout, rotation, flip animation), ink toolbar, focus mode, panel toggles, SaveStatus (global outbox state). Phones: condensed bar + «المزيد» menu + ink row. |
| Panels (§23) | `model/layout.ts`, `panels/*` | Study Rail docked on the right (start side), resizable (width → owner setting), or a bottom sheet on phones; page panel on the left (thumbnails rendered lazily via IntersectionObserver / `thumbnail_file_id`, outline from `pdf.getOutline()` or heading regions, bookmarks). Both side panels only when they fit (else the last-opened wins); the page panel starts closed below 1440 px; phones open on the book. Focus mode (Fullscreen API with a CSS fallback) hides chrome and panels. |
| Rail sections (§30) | `panels/StudyRail.tsx`, `SourcesTab.tsx`, `MineTab.tsx` | four tabs, not nine: «الشرح والسؤال» (disabled, with reason), «الأسئلة» (arrives with the Question Vault), «المصادر» (version, printed label + file position, text status, engine OCR confidence labelled as an estimate, processing status, regions with status and «إظهار في الصفحة», linked sources → split), «ملاحظاتي» (notes on this page / other pages with per-note save status and conflict-copy label, create/edit/delete local-first; bookmarks; «تحتاج إعادة ربط» from server + local with the previous location). |
| Split Study (§26) | `split/SplitPane.tsx` | second source (linked references first, then recently studied) side by side with its own page and zoom (kept in the session); disabled with a reason below 1024 px. |
| Reading progress (§45) | `session/useReadingProgress.ts` | a page counts as viewed after ≥ 2 s with ≥ 50 % on screen (IntersectionObserver); batched POST; kept in `kv` while offline. |
| Appliers | `data/local.ts` | `note`, `note_page`, `study_session` (pulled + push results → IndexedDB). Rows with pending / unacknowledged ops are never overwritten; an acknowledged push only advances `rev`. |
| Keyboard (§55) | `WorkspaceScreen.tsx` | ←/→ (RTL: ← next), PageUp/PageDown, Home/End, ↑/↓ (scroll / paged step), `+`/`-`, Ctrl/⌘+F, `[` page panel, `]` rail, `F` focus mode, Escape (selection → search → highlight → focus mode). Composite widgets keep their own arrows; a zoomed canvas pans. Skip link «انتقل إلى الكتاب», polite announcements for explicit navigation. |

### Shared-file changes made by this track (additive / minimal)
* `packages/shared/src/workspace.ts` (new) + one export line in `packages/shared/src/index.ts`.
* `apps/web/src/lib/pdf.ts`: loads pdf.js's **legacy** build (+ legacy worker). pdf.js 6's modern build calls
  `Map.prototype.getOrInsertComputed`, which Chromium 141 (Playwright) and current Safari lack — every page failed to
  render («getOrInsertComputed is not a function»). The legacy build carries the polyfills in the main thread and the worker.
* `apps/server/test/sync.test.ts` / `ai.test.ts`: two assertions assumed no module registers sync entities; the
  "not_implemented until registered" check now uses a core-only module list, and the full app expects `sync` available.

## 3. Tested (commands run, real results)

| command | result |
|---|---|
| `npm test -w @medlevo/server` | 18 files, **290 passed** (incl. `test/annotations/annotations.test.ts`: 28 tests — append/duplicate, duplicate op_id, rev edit, stale edit keeps both, identical re-send, tombstone, edit vs delete both orders, invalid payloads rejected with reasons, text highlight, unresolved page → needs re-anchor, unsupported ops, note conflict copy + FTS (normalized), note delete/stale delete, bidi stripping + missing folder, note_page stale rejected with copy, session stale rejected with the newer copy then applied on the new base, unknown source/version, invalid location, by-targets batch + validation, source download incl. versions + 404s, notes filters, Continue Studying, progress set/ratio/version reset/400/404, zero progress, auth 401 / CSRF 403, capabilities) |
| `npx tsc -p apps/server --noEmit` · `-p apps/web` · `-p packages/shared` | no errors (`npm test -w @medlevo/shared`: 37 passed) |
| `npm test -w @medlevo/web` | 26 files, **223 passed** (workspace: 8 files, 52 tests — page labels/go-to, back stack, session precedence, layout at 390/768/900/1280/1440, text quote + DOM offsets + rotated rect normalization + selection→highlight, search normalization/soft breaks/snippets, geometry anchoring through zoom/rotation + virtualization + spreads, local-first writes + appliers) |
| `npm run build -w @medlevo/web` | success; `WorkspaceScreen` chunk 221 kB (70 kB gzip, incl. the ink engine); pdf.js legacy worker emitted and precached |
| `node apps/web/src/features/workspace/visual-check.mjs http://127.0.0.1:5299` (Vite dev server, mocked API, real Golden Set PDF / PNG; Chromium at `/opt/pw-browsers/chromium`; 390×844 and 1280×800, light + dark) | **66 checks passed, no console errors, no horizontal overflow**: text layer selectable, selection toolbar, highlight drawn + pushed with its quote, go-to printed «13», zoom / rotation / re-open keep the page and rotation, region highlight + back, search, page panel, two-page spread + RTL ← flip, Ctrl+wheel zoom keeps the page, note from a selection saved + pushed, split study, focus mode, newer session from another device → asked, local place kept, «go there» works, DOCX «قسم n» + `bdi dir=ltr` terms, page image + OCR text layer «صورة n» |
| `node apps/web/src/features/workspace/real-server-check.mjs` (REAL server on a throwaway data dir serving `apps/web/dist`) | **16/16 passed**: setup → folder → upload the fixture → processing (printed labels 11–14 from /PageLabels) → reader folio → highlight synced (rev 1, normalized rects) → bookmark synced → real regions listed + highlighted exactly on the text + back → session synced at page index 2 → reading progress → Continue Studying «ص 13 (الصفحة 3 في الملف)» → a second device (phone profile) resumes at ص 13 |

Screenshots: `apps/web/test-screenshots/workspace-*.png` (git-ignored). Looked at and fixed: the rail sheet covering
the book on phones at open; LTR titles truncated from the wrong end; two-row selection bar on phones; overlays in
the dark accent on white pages; search snippets gluing line ends; the go-to landing one page early (rounded
scrollTop); a selection's end boundary quoting the whole page; canvases sharing the scroller's class.

## 4. Not done / known limits (honest)

* **AI actions, Study Book, Question Vault panels**: disabled with reasons (later rounds). The «الشرح والسؤال» tab
  generates nothing.
* **Manual re-anchoring** UI: the list shows items and their previous place; moving them is not built.
* **Download Manager**: the reader reads explicitly downloaded files from IndexedDB `blobs` (`<fileId>` or
  `file:<fileId>`) when present, but nothing writes them yet; offline the reader says the source is not on this device.
* Search hits are not drawn inside DOCX/slide-text sections (navigation to the section works); search over large
  documents fetches each page's text once per open (pdf.js text / regions), with real progress counts.
* Note pages (paper pages after a source page) are synced and returned by `GET /source/:id` but not rendered in the
  reader yet.
* Text highlights in DOCX sections are disabled with a reason (no fixed page geometry); copy and notes work.
* The secondary pane in Split Study is read-only (no ink, no session autosave beyond its page index).
* Keyboard-only text selection (caret browsing) reaches the selection toolbar after the panels in tab order.
* Not run: real iPad/iPhone Safari, Apple Pencil, VoiceOver/NVDA passes, axe/Lighthouse (no axe in the repo),
  very large documents (hundreds of pages) — virtualization logic is unit-tested, not measured on a device.
* Pinch-zoom was implemented for touch and Safari gesture events but only Ctrl+wheel was exercised automatically.

## 5. Independent adversarial review (after the build) — findings, fixes, regression tests

Reviewed by reading the server module, the web feature and the core sync engine it relies on, and by running
the tests, the mocked-API Playwright check and the real-server check. Fixed in place (track paths only):

| # | severity | finding (confirmed) | fix | regression test |
|---|---|---|---|---|
| 1 | major | **A finger ink stroke turned the page** in single / two-page layouts (phones write with fingers by default). The ink layer ends its stroke (`onStrokeActiveChange(false)`) in a native listener that runs *before* the canvas's React `pointerup` handler, so the «stroke active?» guard was already false when the swipe was evaluated. Reproduced in Chromium: a quick horizontal pen stroke moved ص 12 → ص 13. §24 violated. | `reader/swipe.ts` `SwipeTracker`: a touch the ink layer claimed (its events are `defaultPrevented`) or that moved while a stroke was active (a palm) is never a swipe; `flipBlocked()` also refuses a swipe for 500 ms after a stroke ends. | `reader/swipe.test.tsx` (tracker, guard, and a BookCanvas component test that fails on the old logic); Playwright `phone/touch` scenario in `visual-check.mjs` |
| 2 | major | **Swipe page turns never worked on touch** (claimed in §2): the canvas allowed native horizontal panning (`touch-action: pan-x pan-y`), so the browser cancelled the pointer (`pointercancel`) and the swipe never arrived. Touch users of the paged layouts could only change pages through go-to / thumbnails. | paged layouts that fit the width get `touch-action: pan-y` (`.wk-canvas--swipe`); zoomed pages keep native panning. | Playwright `phone/touch`: a finger swipe turns the page (ص 11 → ص 12); the same gesture with the pen tool does not |
| 3 | major | **Note text lost**: the editor saved 600 ms after the last keystroke and *cancelled* that save on unmount — closing the rail / sheet, switching tabs or opening another note right after typing dropped the last words. Two overlapping saves of a new note (debounce + «تم») could create it twice. | `NoteEditor` flushes pending text on unmount, serializes saves (one note, then edits of it), keeps the editor open and says so when the local write fails. | `panels/NoteEditor.test.tsx` (both fail on the old code) |
| 4 | major | **Note conflicts froze the original forever**: after `conflict_kept_both` the applier kept protecting the original (unacknowledged conflict op — nothing in the app acknowledges note conflicts), so this device showed its own text twice (original + server copy), never the other device's text, and every later edit carried the stale rev and spawned *another* conflict copy on the server. | `noteBlockingOps`: only unsent edits and unacknowledged rejections protect a note (the server already saved this device's text as the copy); the original follows the server. An open editor that sees the note change under it continues in a **new** note instead of writing over the other device's text. | `data/local.test.ts` «note conflict kept both», `NoteEditor.test.tsx` «never writes over another device's text» |
| 5 | minor | Highlighting a whole dense page (> 4000 characters) was **rejected for good** by the server's quote limit: the highlight stayed on one device and the save indicator showed an error. | quote `exact` limit 20 000 characters (`MAX_QUOTE_CHARS`). | server test «accepts a text highlight that quotes a whole dense page» |
| 6 | minor | After answering «موضع أحدث من جهاز آخر», a save still queued from before kept the refused `base_rev` (coalesced autosaves inherit it) → refused again → the owner was asked twice; with «go there» a queued older place could be applied. | `rebasePendingSessionOps` moves queued session ops onto the server revision (carrying the other device's place when chosen). | `data/local.test.ts` «session conflict resolution» |
| 7 | minor | Viewing one page of a **non-active** version (e.g. a citation made against an older version) replaced the active version's reading progress. | the active version's set is kept; another version's pages replace it only once that version is the one studied. | server progress test (assertion changed from the old reset behaviour) |
| 8 | minor | Go-to stripped prefixes before matching labels, so printed labels like «preface» / «ص1» were unreachable. | exact label match first. | `model/pages.test.ts` |

Checked and found sound: the server merge policies against §3.4 (append/duplicate, rev edit, stale edit → copy with
`conflict_of_id`, tombstones, edit-vs-delete in both orders, note copies, note_page rejected with copy, study_session
rejected with the newer copy), op-id idempotency (registry), `annotation_target` + `touch` in the same transaction,
zod validation with Arabic reasons, auth on every route (401) and CSRF (403), no raw HTML / XSS sinks in the
workspace, honest disabled AI actions (capability reason or «لم تُربط…»), page labels (AC-04), back stack, panel
decisions at 390 / 768 / 900 / 1280 / 1440.

Still open (not fixed in this review, recorded honestly):
* No on-screen previous / next page buttons in the paged layouts: mouse/trackpad users turn pages with the keyboard,
  go-to, thumbnails or search (touch users now have the swipe).
* Note conflicts stay «تعارض» in the save indicator until a Control Center review exists (nothing in the app
  acknowledges them); both texts are visible in «ملاحظاتي» (the copy is labelled «نسخة محفوظة من تعارض»).
* Two different session rows (two devices that never synced) are compared by `updated_at` across device clocks.
* Real iPad / iPhone Safari, Apple Pencil and screen readers were not available to this review either; touch was
  exercised with Chromium touch emulation (CDP touch events) only.

## 6. Integration round I1 (2026-10-10)
* **Superseded regions are hidden in the reader.** `data/api.ts` `fetchRegions` now passes every answer through
  `readerRegions`, which drops regions with status `rejected` (an owner correction superseded them; the server keeps
  them verbatim for existing citations). Overlays, the OCR text layer (image pages), structured text pages, the
  page-regions list (SourcesTab), the outline, in-page search, ExplainTab and the card editor all read through it, so
  search offsets and the text layer still agree. The Source Inspector's region list hides them too, except the cited
  region itself. Test: `reader/PageView.offline.test.tsx`.
* **Image pages offline.** `ImageSheet`, page thumbnails and the Source Inspector draw downloaded images from IndexedDB
  (`useFileSrc` in `lib/offline.ts`: object URL, revoked on unmount). Same test file.
* **Study Book view offline.** `studybook/useStudyBook.ts` reads the downloaded copy (see `docs/modules/data.md` §4).
  Test: `studybook/StudyBookOffline.test.tsx`.
* **Download from the reader.** The top bar's overflow menu (`TopBar` `extraMenuItems`, phone and desktop) carries
  «نزّل للعمل دون اتصال…» / «على هذا الجهاز — إدارة التنزيلات». Test: `features/offline/entry-points.test.tsx`.

## G1 acceptance fixes (2026-10-10, AC-02 / AC-04) — see `docs/ACCEPTANCE.md`
* **Scanned pages inside a PDF had no text in the reader.** pdf.js finds no text on an image-only PDF page, so the page
  showed an empty text layer (no selection, nothing for screen readers) and the in-document search never found its
  words, although the server had OCR'd it. `model/regionText.ts` + `PdfSheet`: pages with `text_status` `ocr`/`mixed`
  carry the region (OCR) text layer as their text root; `SearchPanel.pageText` searches them from the same runs.
  Tests: `reader/PageView.ocrpdf.test.tsx`, `e2e/g1-ac02-mixed-pdf.spec.ts`.
* **An unnumbered page among numbered ones was called «ص N»** (the printed number of another page). Pages now carry
  `numbered_version` (server, with a client fallback in `data/useSourceDocument.ts`); such a page's folio / indicator is
  «الصفحة N في الملف». Tests: `model/pages.g1.test.ts`, `e2e/g1-ac04-printed-page.spec.ts`.
* **The last page never became current on phones.** A jump (citation, go-to) to the last page of a book left the page
  above it in the indicator, because the last page cannot scroll up to the reading line. `geometry.readingLineY` slides
  the line down to the bottom of the viewport over the last stretch of scrolling. Test: `reader/readingLine.g1.test.ts`.

## Integration round I2 — performance & resilience (2026-10-10)
Measured in headless Chromium against the real server (`e2e/perf.spec.ts`, `MEDLEVO_PERF=1`; numbers and limits in
[`docs/PERFORMANCE.md`](../PERFORMANCE.md)). Fixed:
* **Memory grew with every page visited.** pdf.js keeps a page's operator list and decoded objects after a display
  render until `cleanup()`; `reader/pdfDoc.ts` cached every page proxy and never cleaned up. Scrolling a 300-page
  lecture: JS heap after GC 10.7 → 125.4 MB although only 2–3 page canvases ever existed. The handle now cleans up
  pages outside its 16 most recently used (`PDF_PAGES_KEPT`; pdf.js refuses while a render of that page runs):
  20.9 MB after all 300 pages. Test: `reader/pdfDoc.test.ts`.
* **Note text typed right before a reload / crashed tab was lost** (the editor saves 600 ms after the last keystroke
  or on unmount; a reload does neither). Every keystroke now also writes a synchronous localStorage draft
  (`data/noteDrafts.ts`); the next load (`OwnerLayout`) saves any draft left behind into IndexedDB + outbox, under the
  note id the editor would have used (no duplicate), on top of the note it edited, or as a new note when that note
  changed elsewhere meanwhile (never written over). Chromium: old build lost the note, new build had it in IndexedDB
  49 ms after the reload and on the server after sync. Test: `data/noteDrafts.test.tsx` (fails on the old editor).
* **A page with 5 000 ink strokes showed 377 of them after two minutes.** The text-highlight layer, the bookmarks list
  and the re-anchor list scanned every annotation of the page (all strokes) and Dexie re-ran them on every ink write,
  so each stroke delivered by the sync pull cost a full re-read (O(n²)). Local schema v2 (`lib/localdb.ts`) adds
  `[targetKey+kind]` and `anchorStatus` indexes; the three views read only their own rows and ink writes no longer
  re-run them. The document download at open (`mergeServerAnnotations`) now tells open pages once (whole-page reload)
  instead of leaving the strokes to trickle in through the pull. Test: `data/annotationsAtScale.test.tsx`.
* Verified, unchanged: canvas virtualization (≤ 3 page canvases in the DOM while scrolling 300 pages, 2 after a fling),
  three completed strokes survive a reload mid-stroke (only the stroke in flight is lost), offline writing converges
  262 ms after the network returns.

## G2 acceptance fix (2026-10-10, AC-06)
* A study link naming a place this version does not have (`?page=` past the last page, an unknown `page_id`) was
  silently clamped to the last page — a stale or fabricated citation showed «ص 14» as if it were the cited page.
  `WorkspaceScreen` now opens the first page with a visible notice («الموضع المطلوب غير موجود في هذا الإصدار…؛ لم يُفتح
  موضع آخر على أنه هو»), and no highlight (the in-app jump `openSourceLocation` already refused it). The session
  decision carries the URL's page number, so it is not used for such a link. Test: `e2e/g2-ac06-invalid-citation.spec.ts`.

## G6 acceptance fix (2026-10-10, AC-20) — see `docs/ACCEPTANCE.md`
* **The pdf.js text layer is in reading order** (`reader/textOrder.ts` `logicalTextContent`, used by `PageView` for the
  TextLayer and by `pdfDoc.text()` for the in-document search, so search offsets and DOM text nodes still agree). pdf.js
  emits a page's items in content-stream order; for a mixed Arabic/English line that order can be neither logical nor
  visual (Golden Set ص 11: «حول … عند نقطة», «يبدأ الألم عاد», «McBurney», «.»). Selecting that line from its start to its
  end copied «يبدأ األلم عادMcBurney» — the middle of the sentence was lost — and «نقطة McBurney» was not found. Lines
  with right-to-left text that are not already in a valid order are now reordered by visual position in their base
  direction (an LTR run inside an RTL line read left to right; a run the producer emitted contiguously keeps its emitted
  order), and a space item is placed where the producer left a visual gap without one. Item strings and positions are
  never changed; English-only lines and lines already in order keep their exact items. Tests:
  `reader/textOrder.g6.test.ts` (real pdf.js items of the fixture), `e2e/g6-ac20-mixed-text.spec.ts`.
* Known limit (unchanged): the raw PDF text layer of the Golden Set lecture carries the reversed lam-alef «األلم»; the
  server repairs it in the stored text (search, Study Book, export), the reader's selectable layer still shows the raw
  form when copied.

## Acceptance round G7 — AC-24 sync and conflicts (2026-10-10)

Server sync handlers (`apps/server/src/modules/annotations/sync.ts`), both found by `apps/server/test/acceptance/g7-ac24.test.ts`
and `e2e/g7-ac24-two-devices.spec.ts` (two browser contexts = two devices):
* **A conflicting edit re-sent under a new op id piled up identical copies.** A stale note / annotation edit is kept as a
  copy (`conflict_of_id`); the same edit arriving again with another op id (a «retry» rebuilt on the device) created a
  second, third … identical copy. Now a live copy of the same original with the same content answers `duplicate`
  («… لم تُنشأ نسخة مكررة»). The same op id was already idempotent.
* **Two devices on the same page were asked to choose a reading position.** A `study_session` upsert with a stale base
  revision was always `rejected` with the server copy, so a device that only changed zoom / a rail tab on the page the
  other device was also on showed the «موضع أحدث من جهاز آخر» dialog with two identical places (it blocked the reader in
  the two-device E2E). Same source, version, view and page (by id, else index) / Study Book block → the update is applied
  as `merged` (view preferences are last-write-wins, ARCHITECTURE §3.4). A different page is still never written over.
