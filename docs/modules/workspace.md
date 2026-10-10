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

* ~~**AI actions, Study Book, Question Vault panels**: disabled with reasons (later rounds).~~ Built: the «الشرح
  والسؤال» tab and the Study Book view (track C2, `panels/ExplainTab.tsx`, `studybook/`), the questions tab (track C3);
  without an AI key the AI actions report `requires_configuration` with the reason. *(reconciled, track F5)*
* **Manual re-anchoring** UI: the «إعادة ربط» list shows items and their previous place («اذهب إلى الصفحة»); moving
  them is still not built.
* ~~**Download Manager**: nothing writes the `blobs` yet.~~ Track D1's download manager writes them (`lib/offline.ts`);
  the reader opens downloaded sources offline (AC-23, `e2e/g7-ac23-offline.spec.ts`). *(reconciled, track F5)*
* Search hits are not drawn inside DOCX/slide-text sections (navigation to the section works); search over large
  documents fetches each page's text once per open (pdf.js text / regions), with real progress counts.
* ~~Note pages (paper pages after a source page) are synced and returned by `GET /source/:id` but not rendered in the
  reader yet.~~ Built in track F1 (inserted note pages in the reader sequence + notebooks) — see «Track F1» below.
* Text highlights in DOCX sections are disabled with a reason (no fixed page geometry); copy and notes work.
* ~~The secondary pane in Split Study is read-only (no ink, no session autosave beyond its page index).~~ Writable since
  track F1 (ink + notes; its zoom kept in the session) — see «Track F1» below.
* Keyboard-only text selection (caret browsing) reaches the selection toolbar after the panels in tab order.
* Not run: real iPad/iPhone Safari, Apple Pencil, VoiceOver/NVDA passes, axe/Lighthouse (no axe in the repo). Very
  large documents were measured in Chromium since round I2 (300-page lecture, `e2e/perf.spec.ts`,
  docs/PERFORMANCE.md) — still not on a device. *(reconciled, track F5)*
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

## Track F1 — notebook pages & writing surfaces (2026-10-10; §26, §25, §05)

### Server (`modules/annotations`, migration `0260_note_pages_links_images.sql`)
* `note_page` gains `page_kind` (`page` | `divider`), `color` (one of the library cover colours, for dividers) and
  `after_page_id` (the source page a page is inserted after; the index stays as the fallback). `annotation_image`
  (`image_key` → `stored_file`, mime, bytes, size, `referenced`) holds pictures inserted with the ink image tool; an
  expression index finds the annotations that show a picture.
* Sync (`sync.ts`, `schemas.ts`): a note page must belong to a notebook / folder or follow a page of a source
  (Arabic reasons); placement without a source, unknown colours and absurd sizes are rejected; a page id of another
  source is dropped and the page is kept by its index (`merged`, said in the detail). Annotation kinds `link`
  (`{v:1, box, target: source_page{source_id, version_id, page_id, page_index, bbox?, region_id?} | note_page{note_page_id, bbox?}, label?}`)
  and `image` (`{v:1, image_key, box, mime, natural_w/h, bytes, alt?}`) are validated (`ANNOTATION_IMAGE_MIMES`:
  png / jpeg / webp / gif, ≤ 10 MB, ≤ 12 000 px a side); a link that cannot be followed is never stored.
* Routes: `GET /note-pages?node_id=|source_id=[&include_deleted=1]`, `GET /notebook/:nodeId` (pages + what is written
  on them — seeds a device), `POST /images` (multipart `image_key` + file; upload rate limit; the type is **sniffed**
  — SVG / HTML / TIFF / text are refused whatever the client says, 415; too big 413; idempotent by key: the same bytes
  again → `duplicate`, other bytes → 409), `GET /images/:key/meta`, `GET /images/:key` (nosniff; before the upload
  arrives: 404 «لم تصل هذه الصورة إلى الخادم بعد…»).
* An image annotation may arrive before its picture or after it (both orders tested). Purge: a picture another page
  still shows is kept; once no annotation — live or tombstoned (undo may bring it back) — refers to it, the row and the
  file go (`pruneAnnotationImages`, called after `executePurge`). An upload no annotation has claimed yet is kept for
  7 days (its annotation may still be queued on a device). Backups carry the files (every `stored_file`).

### Web
| area | files | what it does |
|---|---|---|
| Paper | `model/paper.ts` | blank / ruled / dotted / grid drawn as CSS gradients in page units (follows zoom exactly) with token colours `--wk-paper-bg` / `--wk-paper-rule` — dark mode keeps the contrast of the ink; ruled paper has a header band and an RTL-aware margin. |
| Local-first rows | `data/notePages.ts`, `data/local.ts` | create / rename / paper / move / trash / restore = IndexedDB row + outbox op in one transaction (no network). Edits to a still-queued create coalesce into one full-state op; once the server acknowledged rev n the next edit names `base_rev` n; trash is a tombstone + `delete`, restore an upsert. Server seeding never overwrites a row with unsynced changes. |
| Reader sequence | `model/sequence.ts`, `notes/readerNotePages.tsx`, `reader/BookCanvas.tsx`, `reader/NotePageView.tsx` | the Book Canvas renders `ReaderSheet[]` (source pages + note pages inserted after a page id / index, in sort order; trashed pages and dividers are not in the reader). The URL keeps the source page and `?note=`; the session stores `note_page_id` + offset; Home / End / flips / go-to work in sheet space; a note page has a folio menu (rename, paper, move across source pages, new page after, trash with «تراجع»). «صفحة ملاحظات بعد هذه الصفحة…» in the top bar's menu; «ملاحظاتي» lists the source's note pages and the trashed ones (restore). |
| Notebook | `notebook/NotebookScreen.tsx`, `NotePagesList.tsx`, `NotebookSection.tsx`, route `/notebook/:nodeId?page=` | the folder's cover (library `Cover`), section tabs from dividers («أقسام الدفتر»), the pages on the same Book Canvas with the ink engine (`note_page` anchors), «صفحة N من M», a page list panel (docked ≥ 1024 px, a sheet below) with move / rename / paper / trash and the trash with restore. The library node page shows a «دفتر الملاحظات» section (open, new page, compact list). |
| Page links | `notes/NotePageDialogs.tsx` (`LinkTargetDialog`), ink `link` tool, `ink/host.tsx` | drag a box with «رابط إلى صفحة» → «إلى أين يقود الرابط؟» (a page of this source by printed label / file position, or a note page) → a `link` annotation. With the hand tool the box is a labelled button («رابط: … يفتح …») that navigates and pushes a back entry (`BackEntry.route` for notebook pages, `ReaderPosition.notePageId`); while writing it lets the pen through and is hidden from the accessibility tree. |
| PDF links | `reader/pdfLinks.tsx` | pdf.js link annotations as buttons over the page: internal destinations (named / explicit / Next / Prev / First / Last) go to the page and push a back entry; external URLs (http / https / mailto only) open after «فتح رابط خارجي؟» in a new window (`noopener`); the server never fetches them. Inert while writing. |
| Pictures | ink `image` tool, `ink/images.ts` | file picker («إدراج صورة هنا») or paste; the bytes are stored on the device first (`blobs`, `annimg:<key>`), the annotation is appended locally, uploads retry with backoff (2 s … 10 min; refused bytes are kept with the reason; nothing is uploaded while offline). Shown from the device copy, else the server; a badge says «بانتظار الرفع» / why it was refused. Moved / resized with the lasso (aspect kept), undo removes only the annotation. |
| Split Study | `split/SplitPane.tsx` | the second pane is writable: the same ink engine (one toolbar, undo covers both), its own inserted note pages, a notes panel for its pages; its page and zoom live in the split state, so neither pane loses its place when the other changes. |

### Tested (run 2026-10-10, results at the time of writing)
| command | result |
|---|---|
| `npm test -w @medlevo/server` | 102 files passed, 6 skipped — **1152 passed**, 6 skipped; `test/annotations/notebook.test.ts` 14 tests (notebook pages + dividers order and seeding, rev-checked edits / stale rejection, trash / restore keeps ink, refusals with reasons, page-id placement, GET validation / 404 / 401, links stored and malformed links refused, picture before / after its annotation, content sniffing + limits, purge keeps a shared picture / removes an unused one, backup carries it, prune grace period) |
| `npm test -w @medlevo/web` | 92 files passed, 1 skipped — **616 passed**, 1 skipped; F1: `model/sequence.test.ts` (7), `model/paper.test.ts` (4), `reader/pdfLinks.test.ts` (6), `data/notePages.test.ts` (7), `reader/noteSheets.test.tsx` (4), `model/backStack.test.ts` (+2), `test/ink/notebook-tools.test.tsx` (11: picture geometry / limits, local-first insert + undo, lasso resize keeps aspect, uploader states, toolbar, image and link tools in a layer) |
| `npm test -w @medlevo/shared` | 48 passed |
| `npx tsc -p apps/server --noEmit` · `-p apps/web` · `-p e2e` · `-p packages/shared` | no errors |
| `npm run build -w @medlevo/web` | success |
| `npx playwright test e2e/f1-notebook-pages.spec.ts` (phone + desktop, real server) | **4 passed**: in the library create a ruled notebook page → pen stroke → insert a picture with the image tool → a second (grid) page → link tool box → «الصفحة الثانية» → followed with the hand tool → back; the server has the pages, ink, picture (served 200) and link; reload keeps everything; offline reload, a new dotted page inserted after the current one + a stroke, back online → synced. In the reader a note page inserted after page 1 sits between pages 1 and 2, takes ink, is on the server with `after_page_index` 0 and survives a reload. |

### Not done / limits (honest)
* ~~PDF internal links are unit-tested (`pdfLinks.test.ts`) but no E2E fixture PDF has link annotations.~~ Covered in
  E2E since the F1 review (a generated PDF with real Link annotations — see «Review F1» below).
* An offline download of a source does not include pictures inserted on **another** device (this device's own
  pictures are kept locally until uploaded); offline, a picture that is only on the server says so.
* Undo / redo history is per open session (memory), as for the rest of the ink engine.
* No real iPad / Apple Pencil run (pointer events in Chromium only); no screen-reader pass (labels, roles and
  keyboard paths are in place and asserted by the tests).
* Covers: the notebook shows the folder's library cover (set in the library); there is no per-page cover type.

### Review F1 (independent adversarial review, 2026-10-10)
Every F1 file was re-read against the shared contracts, the sync engine and the spec; candidates were probed with
throw-away server tests, jsdom tests and Playwright runs against the real server before anything was changed. Fixed
(each with a regression test that fails without the fix):

| # | severity | defect (confirmed) | fix | regression test |
|---|---|---|---|---|
| 1 | major | **The reading place followed the sheet INDEX, not the sheet.** Note pages reach the reader a moment after the first layout (IndexedDB live query, then the server), and are inserted / trashed / moved / pulled from another device while it is open: every time one landed before the place, the canvas re-anchored to the neighbouring sheet and that wrong page was saved as the session (opened at page 2 with a note page after page 1 → the reader showed and saved the note page). | `reader/BookCanvas.tsx`: when `sheets` changes, the place is remapped to the same sheet by key (a removed sheet leaves the place on the sheet that now follows the last surviving one before it), before the layout effects re-anchor. | `reader/noteSheets.test.tsx` (2 tests); `e2e/f1-notebook-pages.spec.ts` (reader: opened at page 2 → stays, reload restores page 2 — this step failed in the real app with the fix disabled: «1 من 4») |
| 2 | minor | A note page created in the reader was not opened: `goToNote` ran before the live query delivered the new row. | `WorkspaceScreen.tsx`: `onCreated` falls back to `pendingNote` (opened as soon as the page appears). | E2E: after «أضف الصفحة» the top bar shows «صفحة ملاحظات بعدها» |
| 3 | minor (honesty) | «استُعيدت … مع كتابتها» on a device that never had the page's ink (seeding fetches the ink of LIVE pages only): the restored page was blank until the next seeding. | `data/notePages.ts`: `restoreNotePage` fetches `/annotations/by-targets?keys=note_page:<id>` when online and merges it (never over unsynced local rows). | `data/notePages.test.ts` |
| 4 | minor (data reach) | The picture uploader marked a picture «refused» for good on ANY 4xx (a refused origin 403, a proxy's 404, 405 …) — it was never uploaded again, so other devices never saw it. | `ink/images.ts`: only a verdict on the bytes (400 / 409 / 413 / 415 / 422) is final; anything else is retried with backoff. | `test/ink/notebook-tools.test.tsx` |
| 5 | minor (security) | The external-link confirmation printed the PDF's raw URL: a right-to-left override or a look-alike (IDN) host could show a different destination than the one that opens. | `notes/NotePageDialogs.tsx`: the dialog shows the normalized address that would really open (punycode host, percent-encoded bidi / invisible characters). | `reader/noteSheets.test.tsx` («external links of a PDF», 2 tests) + E2E |
| 6 | minor (a11y) | The 44 px touch area of small page links (`::before`) was clipped by `overflow: hidden` on the link button. | `ink/ink.css`: no clipping on the button (the text span ellipsizes); the area grows in both directions. | E2E: `elementFromPoint` just outside the drawn box still hits the link |
| 7 | minor (honesty) | A purge's impact report did not name the owner's note pages it deletes (blank pages were not mentioned at all). | `sources/purge.ts`: `note_pages` count + «صفحات ملاحظاتك الورقية (مع ما كتبته وأدرجته عليها): …» (purge) and counted in «تبقى محفوظة» (trash); part of the confirm-token fingerprint. | `srv:annotations/notebook.test.ts` |
| 8 | test gap | PDF links were unit-tested only. | — | E2E «PDF links»: a PDF generated in the spec with real Link annotations — internal → page 3 and «العودة إلى موضعك» returns; external → «فتح رابط خارجي؟» first, cancel opens nothing and NO request reaches the external host, confirm opens a new window with `window.opener === null` at exactly that URL; the reader does not move. |

Probed and found sound: auth on every new route (401 without a session, 403 without the CSRF header on `POST /images`),
content sniffing (SVG / HTML / TIFF refused, GIF accepted, the file part may come before `image_key`, a second file
part is refused), idempotent uploads and the 409 on a key clash, picture files across purge (shared bytes kept,
unreferenced removed, tombstoned annotations keep theirs) and backup, link targets limited to source / note pages (no
URL type exists; the server never fetches anything), React-escaped labels / alt texts / titles (no HTML injection),
the rev bookkeeping of queued note-page edits, paper patterns as colour tokens with a `prefers-contrast` / forced-colours
variant.

Not fixed (reported):
* **Pre-existing reader issue (B1, not F1):** near the end of a document the reading line slides down
  (`readingLineY`), while a restored offset is re-applied at the fixed line; reopening a source at its second-to-last
  page on a phone lands one page later (reproduced without any note page). Changing it moves every jump near the end
  of a book, so it is left to the reader's owner.
* A note page whose notebook was purged meanwhile and that follows no source is saved with neither (kept on the server
  and in backups, but listed nowhere) — pre-existing B1 behaviour of `notePageFields`.
* The full JSON export (data module) does not list `annotation_image` (key → file); the backup carries everything.
* Prune right after a purge removes a picture whose only annotation on the server was purged, even if a copy (same
  `image_key`) is still queued offline on another device; that copy then shows «لم تصل الصورة إلى الخادم بعد».
* After a server restore (epoch reset), pictures this device had already uploaded are not re-uploaded if the restored
  backup predates them.
* A pasted picture lands on the last page touched (`activeTargetKey`), which may not be the page on screen after a
  scroll; the uploader runs only while a reader / notebook is open.
* `sortOrderBetween` after many moves into the same gap falls back to `prev + 1e-6`, which can pass the next page
  (order only; nothing is lost).

Runs of the review (2026-10-10, this tree):

| command | result |
|---|---|
| `npm test -w @medlevo/server` | 104 files passed, 3 failed, 6 skipped — 1162 passed, 3 failed, 6 skipped. The 3 failures are all in `test/brain/` (`review.test.ts` + two `zz-probe-*` files deleted during the run) — the parallel Course Brain (F2) review's work in progress, not this track. Every `test/annotations`, `test/library` and `test/sources` file passed, incl. the new purge-impact test. |
| `npm test -w @medlevo/web` | 92 files passed, 1 skipped — **628 passed**, 1 skipped (new: `reader/noteSheets.test.tsx` +4, `data/notePages.test.ts` +1, `test/ink/notebook-tools.test.tsx` +1) |
| `npm test -w @medlevo/shared` | 48 passed |
| `npx tsc -p apps/server --noEmit` · `-p apps/web` · `-p e2e` | no errors |
| `npm run build -w @medlevo/web` | success |
| `npx playwright test e2e/f1-notebook-pages.spec.ts` (phone + desktop, real server) | **6 passed** (the two original scenarios with the new assertions + «PDF links») |

## Track F4 — handwriting & recording host in the reader (2026-10-10)

* `WorkspaceScreen` wraps its content in `<HandwritingHost sourceId nodeId online>` (inside `InkHost`, so inside the
  document's `InkProvider`) and adds `<RecordMenuItem />` («سجّل ملاحظة صوتية…») to the top bar's view-options menu. The
  host provides the lasso actions to the ink engine (`InkSelectionActionsProvider`): «تحويل إلى نص» (disabled with the
  server's reason without a vision provider, or offline), «اسأل عن المحدد», playing a stroke's recording moment and
  editing its time link; it renders the recognition dialog, the recording indicator, the player and the link editor
  (`features/workspace/handwriting/*`, `features/workspace/audio/*` — see `docs/modules/ink.md` and
  `docs/modules/cases-media.md` «Track F4»).
* «اسأل عن المحدد» hands its composed question to the rail through the existing selection → rail store: `AiRequest`
  gained an optional `prefill` (additive, `model/aiActions.ts`); `ExplainTab` passes it to `ChatPanel` (new optional
  `prefill` prop), which puts it in the composer with the focus hand-over. Nothing is sent until the owner sends it; the
  chat's own capability still decides whether sending is possible (requires_configuration here).
* Leaving the reader stops and saves a running recording (`recorder.abandon()` on unmount).

## Track F3 — study modes, «حالات», Create MCQ, diagrams and figure readings in the reader (2026-10-10; §30, §31, §39, §13)

* **Study-mode switch** (`modes/StudyModeSwitch.tsx`, in the reading bar — a labelled button on desktop, an icon button
  on the phone row): one menu with the five `STUDY_MODES` (تعلّم / افهم / تدرّب / راجع / امتحن نفسك); the current one
  is named in the trigger («وضع الدراسة: …») and marked in the list in words («الحالي») and with a check. A mode only
  ARRANGES the same tools and data (`modes/arrangement.ts`, pure, unit-tested): the rail section order, the section it
  opens on, which side panels it opens (desktop), how many linked questions are open (this page / the lecture / all),
  the practice policy of a set started from the rail (`practiceHref`: revision for «راجع», anti-shortcut for «تدرّب»,
  an assessed exam with hints off for «امتحن نفسك» — the exams module fixes the policy at creation), and what
  «امتحن نفسك» hides: the «الشرح والسؤال» and «المصادر» sections (named in a note with `EXAM_MODE_HIDDEN_AR`), why a
  question was linked, its original page (a question-source page can carry its printed key), the question details link,
  and «اشرح» on a selection (disabled with the reason). Nothing is duplicated: the same tab components receive the
  arrangement.
* **Persistence**: `useStudySession` keeps `mode` (restored from this device's row or the adopted server copy) and
  `setMode()` writes it AT ONCE with the current place (IndexedDB + outbox → `study_session.mode`, which the server
  already validated: an unknown mode is refused). A reload / another device continues in the same mode.
* **«حالات»** (`panels/CasesTab.tsx`): the cases / OSCE stations / viva of THIS lecture (`GET /api/cases?source_id=` —
  the case's lecture or the lecture of its Source Lock), with kind, origin in words, status and its first reason, the
  last attempt and «افتح الحالة»; in «امتحن نفسك» the reasons are hidden and the link reads «ابدأ الحالة». Creating a
  case stays in the cases screens.
* **Create MCQ from a selection**: the selection toolbar's «أنشئ سؤال اختيار من متعدد» (`aiActions.ts` entry now
  `wired`) puts the selection in `model/mcqRequest.ts`; the workspace opens the rail on «الأسئلة», which shows
  `panels/CreateMcqPanel.tsx` (difficulty, item type, language; the regions under the selection are resolved like the
  explain anchor). It calls the regular generation pipeline with `anchor` + `origin: 'selection'` and polls the run:
  published → labelled generated question with «افتح السؤال» / «تدرّب عليه»; needs review → «لم يُنشر» with the failed
  checks; abstained → the reason and the suggestion. Without a provider the menu item and the panel are disabled with the
  capability's reason.
* **Interactive diagrams** (`features/studybook/diagrams/*`): under the explanation tab, «مخطط تفاعلي من المادة» draws a
  flowchart or a timeline of the current page (or a typed topic) — see `docs/modules/studybook.md` «Track F3».
* **Figure readings** (`panels/FigureReadingPanel.tsx`): a figure / diagram row in «المصادر» has «بنية الشكل (قراءة
  بصرية)» — the vision reading's label, status in words, direction, boxes and arrows each with «مقروء / غير مؤكد», and
  the owner's review (correct labels, keep only the relations seen — uncertain ones start unticked — confirm or reject).
  Without a vision provider the button is disabled with the reason; see `docs/modules/processing.md` «Track F3».
* Shared-file edits (additive): `WorkspaceScreen.tsx` (mode state → rail / panels / selection toolbar / top bar, the
  pending MCQ opens the rail), `chrome/TopBar.tsx` (`modeSwitch` slot), `panels/StudyRail.tsx` (arranged by mode,
  «حالات» tab, diagram panel), `panels/QuestionsTab.tsx`, `panels/SourcesTab.tsx`, `selection/SelectionToolbar.tsx`,
  `questions/PracticeButton.tsx` (`href`, `label`), `exams/PracticeEntry.tsx` (`mode=exam|revision`, `anti_shortcut=1`).
* Tests: `web:src/features/workspace/modes/arrangement.test.ts` (5), `modes/studyModes.test.tsx` (11: switch, Learn vs
  Exam rail, «حالات» incl. Exam hiding, Create MCQ gated / published / review queue / abstained, mode persisted to
  IndexedDB + outbox and restored, figure reading gated and confirmed with only ticked relations),
  `web:src/features/workspace/model/aiActions.critic.test.ts` (MCQ wired), `e2e:f3-study-modes.spec.ts`.
* Tested (run 2026-10-10 for track F3, results at the time of writing): `npm test -w @medlevo/web` 103 files passed,
  1 skipped — 693 passed, 1 skipped; `npm test -w @medlevo/shared` 48 passed; `npm test -w @medlevo/server` 106 files /
  1215 tests passed — the only failures were in the parallel F4 review's work in progress
  (`test/annotations/recognition.test.ts` «(review) a long handwritten answer …» expecting 202, got 400, and
  `test/media/f4-review-probe.test.ts` removed during the run), none in F3 code (`test/f3/*` 31 passed);
  `npx tsc -p apps/server --noEmit`, `-p apps/web`, `-p e2e`: no errors; `npm run build -w @medlevo/web`: success;
  `npx playwright test e2e/f3-study-modes.spec.ts` (phone + desktop, real server, no AI key): **4 passed**;
  `e2e/g3-ac08-diagram.spec.ts` re-run after the «المصادر» change: 2 passed.
* Not done / limits: the AI paths (Create MCQ, diagrams, derived versions, simulations, figure readings) never ran with
  a real model (no key) — they are tested with the scripted provider only; the study mode is per study session (per
  source), not a global preference; diagrams are not part of the offline package; Create MCQ makes one question per
  request.
* **F3 review (2026-10-10)**: «امتحن نفسك» also disables the Study Book views (the view menu names the mode as the
  reason; an open Study Book / split with the book returns to the original — `EXAM_MODE_HIDDEN_AR` said explanations were
  hidden while the Study Book stayed one click away); the disabled «اشرح» on a selection exposes its reason through
  `aria-describedby` (a `title` alone is not announced); a mode switch saves the view in use (a split view was saved as
  «original»). Tests: `web:src/features/workspace/modes/studyModes.test.tsx` (view kept), `e2e:f3-study-modes.spec.ts`
  (Study Book item disabled with the mode's reason on desktop; «اشرح» described). Residual (track F4's area): «اسأل عن
  المحدد» on handwriting still opens the rail in Exam mode, where the explanation section is hidden, so the request
  waits until the mode changes.
* Tested (F3 review run, 2026-10-10): `npm test -w @medlevo/server` 108 files / 1221 passed, 7 skipped (incl.
  `test/f3/review.test.ts`, 5); `npm test -w @medlevo/web` 103 files / 700 passed, 1 skipped; `npm test -w
  @medlevo/shared` 48 passed; `npx tsc -p apps/server|apps/web|e2e --noEmit` clean; `npm run build -w @medlevo/web`
  success; `npx playwright test e2e/f3-study-modes.spec.ts` (phone + desktop, real server, no AI key): 4 passed.
