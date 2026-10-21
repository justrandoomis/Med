# Module notes — ink engine (`apps/web/src/features/workspace/ink`)

Track **B2 — Ink engine (web)**. Owns `apps/web/src/features/workspace/ink/**`, `apps/web/test/ink/**`,
this file and [`docs/CAPABILITY_MATRIX.md`](../CAPABILITY_MATRIX.md).
Spec: §25, §26, §27, §28 (basics; recognition disabled), §47, §55, AC-21, AC-22, AC-24, AC-28.

The exported contract in `ink/types.ts` / `ink/index.ts` is unchanged (`InkProvider`, `useInk`,
`InkToolbar`, `InkLayer`, all types). `index.ts` additionally exports `registerAnnotationApplier`,
`onAnnotationRowsChanged`, `CapabilityPanel`, `CapabilityDialog`.

## 1. Architecture

| file | role |
|---|---|
| `types.ts` | contract with the reader (unchanged) |
| `InkProvider.tsx` | per-document context: tool state + per-tool presets, keyboard shortcuts, registers the `annotation` sync applier, Arabic live announcements |
| `InkLayer.tsx` | one page: 3 canvases (highlights · committed ink · live), DOM text boxes / sticky notes, editors, selection overlay |
| `layerController.ts` | imperative Pointer-Events controller + canvas painter for one page (no React render per `pointermove`) |
| `SelectionOverlay.tsx` | lasso selection frame, move / uniform resize / rotate handles, action bar |
| `InkToolbar.tsx`, `CapabilityPanel.tsx` | toolbar (overflow by measured width), «قدرات القلم على هذا الجهاز» |
| `store.ts` | in-memory model of an open document (pages, spatial index, selection, clipboard, undo history); write-through queue to IndexedDB |
| `persistence.ts` | `persistChanges` (Dexie row + outbox op in one transaction via `writeAndEnqueue`), `expectedServerRev`, `loadTarget`, sync applier |
| `events.ts` | notifications for rows written by the applier / other tabs (BroadcastChannel) |
| `model.ts` | `InkItem` = `AnnotationDTO`; constructors, geometry cache, transforms, row ⇄ item ⇄ payload |
| `math.ts`, `spatial.ts`, `eraser.ts`, `shapes.ts`, `history.ts`, `input.ts`, `render.ts`, `palette.ts`, `prefs.ts`, `capabilities.ts` | pure logic (unit-tested) |
| `ink.css` | layer / toolbar / panel styles (design tokens only) + ink colour tokens |

### Data model
* In memory and on the wire an item **is** an `AnnotationDTO` (`kind` `ink` | `shape` | `text` | `sticky`).
  Ink data = `InkData` with `InkPoint [x, y, t, pressure?, tiltX?, tiltY?]` in **normalized, unrotated
  page space**; shapes = `ShapeData` (`from/to` corners of the unrotated box + `rotation` radians;
  `recognized_from` keeps the original stroke); `TextBoxData` (`font_scale` = font size as a fraction
  of the page width); `StickyData`. Other kinds (the reader's `text_highlight`, bookmarks) are stored by
  the same applier but not drawn by this engine.
* Points are stored as `[x, y, t]` unless the device reported pressure variation (`[x, y, t, p]`) or
  tilt (`[x, y, t, p, tiltX, tiltY]`). `pressure_available` / `tilt_available` are decided from what
  the events carried — a constant 0.5 (W3C value for pressure-less hardware) or a mouse never counts.
  `annotation.input = { pointer_type, pressure, tilt }`.
* Coordinates are rounded to 1e-5 of the page (≈ 0.006 pt on A4). Samples closer than 0.0004 page
  widths are dropped (the lift point is always kept). Strokes longer than 19 000 samples continue as a
  new stroke (server limit 20 000), nothing is truncated.

### Writing path (never waits for network or storage — §26, §55)
1. `pointerdown` → client ULID (`newId()`), `setPointerCapture`, `onStrokeActiveChange(true)`.
2. `pointermove` → every sample of `getCoalescedEvents()`; `getPredictedEvents()` only for the live
   layer (never saved); painting in `requestAnimationFrame`.
3. `pointerup` (or `pointercancel` — a cancelled stroke is still the owner's writing and is kept) →
   `store.commit()` updates memory **synchronously** (the page shows it) and queues
   `persistChanges()`; `onStrokeActiveChange(false)`.
4. `persistChanges` writes, per change and inside **one** Dexie transaction, the row and its outbox
   op with `writeAndEnqueue` (lib/sync.ts):
   * no local row yet → `append` (server inserts once by id);
   * edit / restore → `upsert` with `base_rev = expectedServerRev()` (full state, never a patch);
   * removal → `delete` + local tombstone (`deletedAt`), never a hard delete.
5. A failed IndexedDB write keeps the change in memory, shows «تعذّر حفظ الكتابة على هذا الجهاز…» with
   «إعادة الحفظ» in the toolbar, and is retried with the next write. The retry writes the item's
   **current** in-memory state (or its tombstone), and a later successful write of the same item
   supersedes the failed one — a stale retried change can never overwrite a newer edit (review fix).
6. Stored coordinates are clamped to the range the server accepts (x, y ∈ [-1, 2]; box w/h ≤ 3):
   with pointer capture a pen can leave the page by several page sizes, and an out-of-range op would
   be rejected and never sync. Only the invisible part more than one page beyond the edge is affected;
   the lasso resize stops at that limit instead of flattening the selection (review fix).

`expectedServerRev`: the last rev the server acknowledged (row or op results) advanced by every op
still queued (append → 1, upsert/delete → +1). Without it, an edit made while the stroke's `append` is
still queued would carry `base_rev = null` and the server would keep it as a conflict copy.

### Sync applier (`registerAnnotationApplier`, registered by `InkProvider`)
Handles **all** `annotation` entities (pulls and push results). Rules (tested):
* a local op still **pending**, an unacknowledged **rejection**, or an unacknowledged **conflict whose
  verdict is not `conflict_kept_both`** (a rejection that came with a server copy, or a duplicate whose
  original verdict is unknown) means the row holds writing the server does not have → the row is left
  untouched (the queued op carries it; the server merges). The outbox is **re-read inside the write
  transaction**, so an owner edit that lands after the engine snapshotted the local ops is never
  overwritten (review fix);
* after a resolved `conflict_kept_both` the server copy is accepted (the server stored the owner's
  version as its own annotation, which arrives separately);
* older revs are ignored; tombstones are stored as tombstones; an entity the server no longer has is
  tombstoned locally (never hard-deleted);
* open documents refresh only the affected page (ids in flight or unsaved are never overwritten from
  IndexedDB); other tabs refresh through a BroadcastChannel.

### Rendering (AC-21)
* Paths are built once per item in **page units** and cached; every view (zoom, rotation 0/90/180/270,
  DPR) is just a canvas transform (`pageMatrix`, tested equal to `normToView` × DPR). Backing stores
  are capped at 16 M pixels (huge zooms lower the effective DPR instead of failing).
* Constant width: one smoothed path (symmetric moving average that keeps both endpoints + quadratic
  midpoints). Pressure: per-segment widths from the tool curve, grouped into ≤ 6 % width buckets → a
  handful of `stroke()` calls per stroke.
* Curves (factor 1 at p = 0.5): pen `0.4 + 1.2p`; fountain `0.2 + 0.8·(2p)^1.5` (≤ 2.2); ballpoint
  `0.85 + 0.3p`; highlighter constant.
* Committed strokes repaint inside **dirty rectangles** found through a uniform-grid spatial index;
  a change covering > 50 % of the page repaints all.
* **Highlights** are on their own canvas below the ink with `mix-blend-mode: multiply` (light paper) /
  `screen` (dark paper), so text under them keeps its contrast. If a wrapper between the page and the
  layer forms a stacking context, the blend cannot reach the page; the layer detects that
  (`data-blend-isolated`) and draws highlights at 35 % instead of 85 % so text stays legible.
* **Paper tone** is read from the first opaque background behind the layer (an original PDF page that
  stays white in the dark theme keeps light ink values); `data-ink-paper="light|dark"` on an ancestor
  forces it. Ink colours are tokens (`ink-black` …, `hl-yellow` …) declared in `ink.css` and
  `palette.ts` (a test keeps them equal), or a custom `#rrggbb`.

### Tools
Pen / fountain / ballpoint, highlighter, stroke eraser, point eraser (splits into NEW strokes with new
ids and tombstones the original; one undo step restores it; the pieces keep the owner's original
samples plus one exact cut point at each end — never thousands of interpolated points), lasso (tap = topmost item; loop = strokes
≥ 50 % inside, text/sticky entirely inside) with move / uniform resize / rotate (15° snap near
multiples) / recolour / width / delete / duplicate / copy-paste across pages / bring to front / send to
back / lock-unlock / «إلغاء تحسين الشكل»; shapes (line, arrow, rectangle, ellipse); shape recognition
after holding still 600 ms at the end of a pen stroke (line, arrow, rectangle incl. rotated, ellipse;
moving on cancels it; `recognized_from` keeps the stroke); text box; sticky note; laser pointer
(fades in 0.9 s, never saved); the pen's eraser end erases while held. Disabled with a reason in the
lasso menu: «تحويل إلى نص» (needs recognition), «اسأل عن المحدد» (study rail).

### Toolbar & shortcuts
`role="toolbar"` (one tab stop, RTL arrows), Arabic accessible names, tooltips with the shortcut, and
a priority-based overflow («المزيد من أدوات الكتابة») computed from the measured width — at 390 px the
pen, options, undo, eraser, highlighter and hand tools stay visible. Shortcuts use
`KeyboardEvent.code` (work on an Arabic layout) and are ignored while typing or under a modal:
**P** pen (last variant) · **H** highlighter · **E** eraser (again: stroke ⇄ point) · **L** lasso ·
**T** text · **S** shapes (again: next shape) · **Ctrl/⌘ Z** undo · **Shift Ctrl/⌘ Z** / Ctrl Y redo ·
Ctrl/⌘ C / V / D copy / paste / duplicate the selection · Delete / Backspace delete · Escape deselect.
Presets (colour + width per tool, last pen/eraser/shape, pen-only, shape recognition) are stored in
`localStorage` (every access in try/catch); the last tool per document likewise.

### Undo / redo
Per document, command stack of `{before, after}` item states (create, delete, move, resize, rotate,
recolour, width, split, restack, lock, paste, enhancement, text edits), 200 steps. It survives
switching tabs / remounting `InkProvider` while the app is open (module registry by `documentKey`).
~~**After a reload the ink is all there but the history starts fresh** — the undo tooltip says so.~~ Since Round 7 H3
the history is kept on the device and survives a reload or closing the app — see «Round 7 — H3» below.

## 2. Integration notes for the reader (features/workspace)
* `InkLayer` positions itself at the top-left of the page box (`position:absolute; top:0; left:0`,
  `direction:ltr` inside) and sizes itself to `viewSize(view)`. Its root never creates a stacking
  context. The current reader wraps it in `.wk-ink-slot { z-index: 3 }`, which **isolates** the
  highlight blend; the engine detects this and falls back to lighter highlights. For the full
  multiply look, the slot should drop `z-index` (DOM order already puts it above the page) — that file
  belongs to the reader track.
* `interactive` should be `useInk().isWritingTool` (plus the reader's own conditions). When false the
  layer has `pointer-events: none` (text selection works); sticky notes stay clickable.
* `onStrokeActiveChange(true)` fires synchronously in `pointerdown` (before the event bubbles to the
  reader) and also while a lasso handle is dragged; page flips / scroll gestures must wait for `false`.
* `documentKey` should identify document **and version** (the reader uses `${sourceId}:${versionId}`).
* Rows for text highlights written by the reader go through the same applier; listen with
  `onAnnotationRowsChanged` to refresh.

## 3. Tests (all passing)

| file | what it proves |
|---|---|
| `test/ink/math.test.ts` | pressure curves (factor 1 at 0.5, monotonic, tool ranges differ, highlighter constant, clamping), constant width without pressure, pressure-variation detection (mouse / constant 0.5 never count), smoothing keeps endpoints and t/pressure, RDP, densify, point-in-polygon, affine compose/invert |
| `test/ink/eraser.test.ts` | point-eraser split (two pieces, cut follows radius + half width, nothing under the eraser, re-timed pieces, end-erase, full erase), session accumulation keeps the original object, locked strokes untouched, stroke-eraser hit-test incl. shape outlines |
| `test/ink/shapes.test.ts` | recognition of line, axis-aligned rectangle (started mid-side), rotated rectangle, ellipse, circle, single-stroke arrow; rejection of zig-zag, check mark, spiral, tiny strokes; reject-enhancement restores the exact original stroke (same id) |
| `test/ink/lasso.test.ts` | lasso membership rules for strokes/shapes/text/sticky, concave and self-crossing lassos, spatial index equals brute force on 2 000 strokes and stays correct after updates |
| `test/ink/coords.test.ts` | normalized ⇄ view round trip for 5 zooms × 4 rotations; canvas matrix = `normToView` × DPR (1/2/3); the same page spot captured at any zoom/rotation stores the same points; lasso translation lands on the same page spot |
| `test/ink/input.test.ts` | pointer policy (pen-only finger, palm size, touch after pen, second pointer, secondary button, pen eraser end), stroke capture formats and flags, minimum step, tilt from altitude/azimuth, honest capability report (no pen → not observed; mouse never validates pen; constant pressure → not reported; native-only features always «يتطلب تطبيق iPad أصليًا»; recognition not implemented) |
| `test/ink/palette-prefs.test.ts` | `ink.css` tokens = `palette.ts` for both tones, token resolution, css colour parsing, presets round trip, invalid stored values rejected, storage throwing |
| `test/ink/persistence.test.ts` | stroke → Dexie row + outbox `append` with the same id and no `fetch`; reload restores; edit while the append is queued → `upsert` with `base_rev 1` and full payload; coalescing; delete = tombstone + `delete` op; same id twice in one batch; failed write kept and retried; undo/redo create, point-eraser split as one step; recolour/move/redo clearing; registry; copy/paste across pages; applier: pending local edit not clobbered, synced write + open page refresh, stale rev ignored, tombstones, server-gone → local tombstone, resolved conflict accepted; **end to end with `SyncEngine` and a fake server following the B1 rules**: offline write then sync, edit after ack applied (rev 2), edit queued behind its append applied in order, two devices → `conflict_kept_both` keeps both and the pull brings the copy, re-sent op = duplicate, erase + undo → restore wins |
| `test/ink/components.test.tsx` | toolbar Arabic names / pressed state / disabled undo, shortcuts by `code` on an Arabic layout and not while typing, Ctrl+Z / Shift+⌘+Z, overflow fits 300–1280 px, capability dialog content; InkLayer with synthetic Pointer Events: mouse stroke → store → IndexedDB + outbox, rotated+zoomed view stores the same page spot, pen-only finger ignored and pen pressure recorded, stroke eraser + undo, point eraser split, lasso tap + Delete, text box saved when the next tap replaces the editor, sticky note create/reopen/no empty save |
| `test/ink/e2e/ink-position.pw.ts` (Playwright, Chromium 1194 headless, **mouse**) | AC-21 web part: stroke at zoom 1 → stored where the mouse touched (±1 px) → reload at zoom 2 / 90° → pixels at `normToView(stored)`; second stroke written rotated/zoomed; reloads at 1.5 / 180°, 1 / 270°, 1 / 0° render both at their normalized positions; outbox `append`; `onStrokeActiveChange` [true, false]; DPR 2 backing store; highlighter uses `multiply` and is not isolated in the harness; toolbar fits 390 px; capability panel says «رُصدت فأرة فقط»; 3 000-stroke page |

Harness: `apps/web/test/ink/harness.html` (served by the Vite dev server, not part of the build).

Measured (headless Chromium in this container, 3 000 strokes on one page; not a device promise):
full repaint ≈ 76 ms; reload + IndexedDB load + paint ≈ 0.8 s (includes navigation); one more stroke
including the IndexedDB flush ≈ 250 ms (mostly the scripted mouse movement).

## 4. Commands run (results at the time of writing)

| command | result |
|---|---|
| `npx vitest run test/ink` (in `apps/web`) | 9 files, **90/90 passed** |
| `npm test -w @medlevo/web` | 26 files, **223/223 passed** (includes other tracks' tests present in the tree) |
| `npx tsc -p apps/web --noEmit` | no errors |
| `npx tsc -p apps/web --noEmit --noUnusedLocals --noUnusedParameters` (ink files only) | no findings |
| `npm run build -w @medlevo/web` | success; ink code is in the lazy `WorkspaceScreen` chunk |
| `npx playwright test -c apps/web/test/ink/playwright.config.ts` (repo root) | **4/4 passed** (Chromium at `/opt/pw-browsers/chromium`, mouse input) |
| ad-hoc screenshot pass (harness, 1280×800 light and 390×844 dark, DPR 2: options popover, lasso selection) | reviewed; fixed: action bar covered the rotate handle; toolbar swatches showed dark-paper colours over a white page; custom-colour control styling. No page errors. |

## 5. Not done / known limits (honest list)

* **No real-pen testing at all** (no iPad, Apple Pencil, Surface Pen, Wacom or Android stylus here).
  Pressure, tilt, hover, palm rejection, latency and predicted points are implemented from the specs
  and tested with synthetic events only. See `docs/CAPABILITY_MATRIX.md`.
* Only Chromium was available; Firefox and Safari are untested.
* ~~Handwriting recognition (§28) is not implemented (the lasso menu shows «تحويل إلى نص» disabled with
  the reason; the capability panel says «غير منفّذ بعد»).~~ Built in track F4 (below); requires a vision provider.
* Double tap, squeeze, Scribble on the canvas and PencilKit latency need a native iPad layer; not built.
* Text boxes do not rotate (rotation moves their centre); the shape tool has no Shift constraints;
  «bring forward / backward» are implemented as bring to front / send to back (one step at a time is
  not); ~~no image insertion tool~~ (built in track F1, below); no multi-page selection.
* The text-box editor uses the box's font size, so on an iPhone a small font may make Safari zoom into
  the field while typing.
* ~~Undo history is memory-only (by design): it does not survive a reload or a crash; the ink does.~~ Kept in IndexedDB
  since Round 7 H3 (size-capped; per device).
* Pasting / seeding thousands of items at once writes one IndexedDB request pair per item inside one
  transaction (several seconds for 3 000); normal writing is one stroke per transaction.
* Canvas backing stores are capped at 16 M pixels: at extreme zoom on a large page the effective DPR is
  lowered (slightly softer strokes) rather than failing. Only the visible page box is drawn; there is
  no tiling.
* `touch-action` switching on pen hover and cancelling the stylus touch sequence are implemented per
  the W3C note but unverified on iPadOS / Android.
* The reader's `.wk-ink-slot` z-index isolates the multiply blend (detected; lighter fallback is used).
* No ESLint config exists in the repo, so ESLint was not run.

## 6. Independent review (2026-10-09) — findings fixed, with regression tests

An adversarial review of this track re-read every ink file against `packages/shared`, the server's
annotation sync handler (`apps/server/src/modules/annotations/sync.ts` / `schemas.ts`) and
`lib/sync.ts`, then wrote failing tests first. Each fix below has a regression test in
`test/ink/review-regressions.test.ts` (logic, IndexedDB, server schema) or
`test/ink/review-layer.test.tsx` (InkLayer input path); all failed before the fix.

| # | defect (confirmed) | fix |
|---|---|---|
| 1 | **Stale retry overwrote newer ink**: a failed IndexedDB write (create) was retried later with its *old* state after a newer write (move) had succeeded → the row, the outbox and therefore the server reverted the move; after a reload the owner saw the old position. | `store.ts`: failed writes are tracked by id; the retry writes the item's current in-memory state (or tombstone), and a later successful write clears the failure. |
| 2 | **Ops the server rejects forever**: points/boxes outside the server's accepted range ([-1, 2]) — reachable with a pen dragged off the page (pointer capture), a lasso resize up to ×20, or a far move — failed `annotationPayloadSchema` → `rejected`, never synced. | `model.ts`: stored coordinates are clamped (`COORD_MIN/MAX`); `limitScaleToRange` stops the lasso resize at the limit. Test validates engine payloads against the **real server schema**. |
| 3 | **Point-eraser pieces could exceed the 20 000-point server limit**: pieces were the densified copy (measured: 52 301 and 41 343 points for a 19 000-sample stroke) and carried interpolated, not recorded, samples. | `eraser.ts`: pieces keep the original samples + the two exact cut points. |
| 4 | **Applier race**: local ops were judged from the engine's snapshot taken before the applier ran; an owner edit landing in between was overwritten in IndexedDB (and on screen). | `persistence.ts`: the applier re-reads the outbox inside one `rw` transaction with the row write. |
| 5 | **Applier replaced writing the server did not keep**: an op answered `rejected` *with* a server copy (or a `duplicate` of a rejected op after a lost response) is stored with status `conflict`; the applier treated every `conflict` as `conflict_kept_both` and replaced the owner's row. | `holdsUnsyncedWriting()`: only `conflict_kept_both` (or an acknowledged op) lets the server copy in. |
| 6 | **Stroke lost when the page layer unmounts mid-stroke** (the reader only mounts layers of "near" pages; a finger can scroll the page away while the pen writes in pen-only mode): `destroy()` discarded the gesture. | `layerController.ts`: teardown commits the stroke like a `pointercancel`; the stroke's page anchor is captured at `pointerdown`. |
| 7 | **Stale layout while the page scrolls under the pen**: the layer rect was cached for the whole gesture, so samples after a scroll were stored at the wrong page spot (AC-21). | Any `scroll` (capture) / `resize` during a gesture invalidates the cached rect. |
| 8 | **Interrupted lasso drag hid the selection for good**: Escape / Delete / a tool shortcut during a drag unmounted the overlay with the items still hidden (they vanished until reload) and left the reader's "stroke active" flag `true` (page flips blocked). | `SelectionOverlay.tsx`: unmount cancels the drag (unhide, clear preview, `onStrokeActiveChange(false)`). |
| 9 | **Screen-reader summary was stale**: «لا توجد كتابة على هذه الصفحة» after strokes were written (it only refreshed for text boxes / sticky notes). | `PageSummary` re-renders on committed changes only (never per `pointermove`). |
| 10 | **Capability panel over-claimed offline writing**: «مدعوم ورُصد هنا» from the mere presence of `indexedDB` (private modes expose it and refuse to open). | The panel opens the local database first: `not_observed` while checking, `not_reported` when it fails. |
| 11 | Sticky-note text had no length limit while the server rejects > 20 000 characters. | `maxLength` on the editor. |

Also added (tests only, no defect): `pointercancel` keeps the stroke exactly once and a following
`lostpointercapture` adds nothing; `lostpointercapture` alone ends and keeps the stroke.

Checked and found sound: `pageMatrix` = `normToView` × DPR for all rotations (re-derived by hand);
`viewToNorm` with the CSS-scaled rect; client ULID at `pointerdown`, one `append` per stroke, `upsert`
with `expectedServerRev` (matches the server's `base_rev == rev` rule, including coalesced upserts and
restore-after-tombstone); tombstones only (no hard delete anywhere); undo of a point-erase restores
the original id; pen-only finger handling; no React state touched per `pointermove`; no
`innerHTML`/`dangerouslySetInnerHTML`; colours from storage only reach CSS/canvas through
`resolveInkColor` (unknown values fall back to a token); the capability panel and
`CAPABILITY_MATRIX.md` never claim real-pen testing.

Still open (not fixed in the review, honest list):
* Selection move / resize / rotate need a pointer (no keyboard nudge); the selection frame is
  `aria-hidden` (its action bar is accessible).
* Pens without hover on Chrome/Android in pen-only mode: `touch-action: pan-x pan-y` may let the
  browser pan on pen contact (then `pointercancel` keeps a short stroke). Unverifiable without a device.
* A rejected op leaves the local row and the server diverged after the owner acknowledges it, until
  the server copy changes again (by design: the owner's writing is never silently replaced).
* Still no real-device / real-pen testing; Firefox and Safari still untested.

Commands run for the review (results at the time of writing): see the review report; summary —
`npx vitest run test/ink` 11 files / 108 tests passed; `npm test -w @medlevo/web` all passed;
`npx tsc -p apps/web --noEmit` clean; `npm run build -w @medlevo/web` success;
`npx playwright test -c apps/web/test/ink/playwright.config.ts` 4/4 passed (Chromium, mouse).

## Integration round I2 — 5 000 strokes on one page (2026-10-10)
* The pull applier no longer rewrites a stroke this device already holds at the same server revision (synced, same
  rev, same deletion state): after the reader's download seeded the page, the pull re-delivered every stroke and each
  rewrite cost a repaint and a notification. Newer revisions, tombstones and conflict rows are applied as before.
  Test: `src/features/workspace/data/annotationsAtScale.test.tsx`. Related workspace fixes (indexed highlight /
  bookmark views, one page reload after the download) and the browser numbers: `docs/modules/workspace.md`,
  [`docs/PERFORMANCE.md`](../PERFORMANCE.md). Still mouse input in headless Chromium only — no Pencil latency claim.

## G6 acceptance (2026-10-10, AC-21 / AC-28) — see `docs/ACCEPTANCE.md`
* AC-21 verified in the REAL app against the real server (`e2e/g6-ac21-ink-position.spec.ts`, phone + desktop): a pen
  stroke written by mouse across a printed word stays on that word (painted pixels vs the word's text-layer box) after
  zoom ×2, view rotation 90°, close/reopen, reload, and on a second browser context with another viewport and pixel
  density (empty local storage — the ink comes from the server); a second stroke written zoomed AND rotated lands on its
  line on the other device; the same on a page with an intrinsic `/Rotate 90` (`fixtures/acceptance/g6_rotated_page.pdf`).
  Stored points lie inside the processed region of the word (unrotated page space). Mouse input only.
* AC-28 (`e2e/g6-ac28-pencil.spec.ts`): the panel with mouse input and with a CDP-simulated pen (constant 0.5 pressure)
  never reports pressure / tilt / hover as supported; a mouse stroke is stored with `input.pointer_type = 'mouse'`,
  `pressure_available: false` and 3-value points. The Control Center pen summary no longer says pressure / tilt / hover
  «تعمل» (they only ran with simulated events).

## Track F1 — image and link tools, note pages, host (2026-10-10)

* **New item kinds** (`model.ts`): `image` (layer `media`, drawn as a `<figure>` UNDER the canvases so ink stays on
  top; never captures input) and `link` (layer `text`, a button above the ink). Both are box items: lasso hit-testing,
  bounding boxes, move and uniform resize (`transformItem` keeps a picture's aspect ratio) and undo work as for text
  boxes. `makeImageItem` / `makeLinkItem`; `isImage` / `isLink` / `isBoxItem` / `boxOf`.
* **Image tool** («إدراج صورة», `images.ts`): a tap opens «إدراج صورة هنا» with a file input («اختر صورة من الجهاز»);
  `InkHost` also inserts pasted pictures on the active / current page. `checkImageFile` refuses what the server would
  (type, 10 MB) with a reason; `imageBoxAt` places the picture centred on the tap at its natural size (96 dpi), capped
  to 60 % of the page in both directions, kept inside the page. The bytes go to IndexedDB `blobs` first
  (`annimg:<key>`, `uploadState: pending`), the annotation is a normal local-first `append`; `kickImageUploads` uploads
  due pictures once per run (backoff 2 s → 10 min; a refusal of the bytes themselves — 400 / 409 / 413 / 415 / 422 —
  is kept with its reason, any other answer (403, 404, 5xx …) is retried (review F1); offline / 401 stop the run;
  bytes the browser lost are marked, never uploaded as garbage); `startImageUploader` retries on `online` and every
  minute. `useImageSource` shows the device copy (object URL) or the server route, with an honest badge.
* **Link tool** («رابط إلى صفحة», `link_box` gesture in `layerController.ts`): a dragged box asks the host
  (`InkLinkHost.pickTarget`) where it leads; a cancelled choice adds nothing. The link is followable only when the
  current tool is not a writing tool (hand), then it is a labelled button («رابط: <label> — يفتح <where>»); while
  writing it is `aria-hidden`, untabbable and lets the pen through. The tool is in the toolbar only where a host can
  open pages (`InkHost links`).
* **Host** (`host.tsx`): `<InkHost links currentPage notify>` — the reader / notebook / split pane provide link
  targets and navigation; the engine stays independent of routes.
* **Note pages**: `InkLayer` with a `note_page` anchor (`targetKey note_page:<id>`) — same engine, same sync.
* Toolbar: `visibleSlots` keeps the pen, options, undo, eraser, highlighter and hand visible at 390 px with the two
  new families; the options button of non-preset tools uses a sliders icon (two «…» icons were confusing).
* Tests: `test/ink/notebook-tools.test.tsx` (11, passing — geometry and limits, insert + undo, lasso resize keeps the
  aspect, uploader states with a stub table because jsdom's `Blob` does not survive fake-indexeddb's structured clone,
  toolbar families, image and link tools in a mounted layer); `e2e/f1-notebook-pages.spec.ts` (phone + desktop, real
  server: picture inserted with the tool, uploaded and served; link drawn, followed, back).
* Limits: no crop for pictures, and the lasso's rotate moves a picture's centre without turning it (as for text
  boxes); a picture inserted on another device is fetched from the server when shown (not part of offline downloads).
* Review F1 (2026-10-10): a page link keeps its 44 px touch area (the button no longer clips its `::before` with
  `overflow: hidden`; the area grows in both directions — E2E checks `elementFromPoint` at the edge); the uploader no
  longer marks a picture «refused» for answers that do not judge its bytes (regression test in
  `notebook-tools.test.tsx`). See `docs/modules/workspace.md` «Review F1».

## Track F4 — handwriting recognition and recording time links (2026-10-10)

Spec §28 (recognition, lasso «تحويل إلى نص» / «اسأل عن المحدد»), §29 (pen ↔ recording time), §41 (handwritten answers),
§46 (search in handwriting). Server side: `apps/server/src/modules/annotations/recognition.ts` (table
`ink_recognition`, migration `0270_ink_recognition.sql`); recordings: `docs/modules/cases-media.md` «Track F4»;
handwritten answers: `docs/modules/exams.md` «Track F4».

### What the engine does (and does not)
* **The ink is never replaced.** Recognition is a DERIVED reading stored beside the strokes (`ink_recognition`), never
  written into an annotation; deleting a reading deletes only the reading. A correction is stored next to the machine
  reading (which stays as returned); search and «اسأل» use the owner's text when there is one.
* **Lasso actions come from the host** (`ink/selectionActions.tsx`): `InkSelectionActionsProvider` gives the selection
  bar `convert` / `ask` (each with `reason: string | null` → disabled with that reason) and the recording hooks
  `playAudio` / `editAudioLink`. Without a host both items stay disabled with a reason (`NO_RECOGNITION_HOST_AR`,
  `NO_ASK_HOST_AR`); a selection without pen writing (only a text box / picture) also disables them with a reason.
  The reader's host is `features/workspace/handwriting/HandwritingHost.tsx` (mounted in `WorkspaceScreen` inside
  `InkHost`).
* **The picture sent to the reader** (`handwriting/raster.ts`): only the selected writing — ink strokes (highlighters
  left out) and shape outlines — re-drawn black on white, cropped to its own bounds with 16 px padding, ≈ 4000 px per
  page width for normal writing and never more than 1568 px on the long edge, line width 2–10 px. Never a screenshot of
  the page: no printed text, colours, highlights or other notes leave the device. The owner sees exactly that picture
  in the dialog before «اقرأ الخط».
* **Time links** (`ink/audioLink.ts`): while the recorder runs (`setActiveRecording`, set only by
  `features/workspace/audio/recorder.ts` after an explicit start), `layerController.commitStroke` stores
  `data.audio_link = { recording_id, offset_ms, origin: 'auto' }` on the stroke — and, for a stroke straightened into a
  recognized shape, on the shape item itself as well as on the original kept inside it (review fix: before, only the kept
  original carried it, so the lasso offered no «استمع» and the audio screen did not list the shape); the offset is the stroke's start (commit time − its last sample's t) minus the recording start,
  excluding paused time; nothing is linked while paused or outside a recording. Point-eraser pieces keep the
  original's link. The link is part of the stroke's `data`: same IndexedDB row, same outbox op, same server merge rules
  (validated by `audioLinkSchema` in the server's `annotations/schemas.ts`). Selecting a linked stroke shows «استمع من
  m:ss في التسجيل (رابط تلقائي|يدوي)» in the selection bar and «الرابط الزمني (تلقائي|يدوي)…» in its menu; an edit is one
  `store.commit` (undoable) that changes only `audio_link` (origin → `manual`) or removes it.
* **Capability panel**: the recognition row is «مدعوم ورُصد هنا» only when the server's
  `workspace.handwriting_recognition` is available; otherwise the new state «يحتاج إعدادًا على الخادم»
  (`requires_configuration`) with the server's reason — never «غير منفّذ» any more, and never a claim about accuracy.

### Tests (all passing, 2026-10-10)
| file | what it proves |
|---|---|
| `test/ink/audio-links.test.tsx` | time formats (Arabic-Indic digits); a stroke written while recording carries an AUTOMATIC link that reaches IndexedDB and the outbox payload, strokes before / after the recording and during a pause carry none; the selection bar's «استمع من 1:05 …(رابط تلقائي)» calls the host with the link, the menu's link editor and «تحويل إلى نص» call the host; a manual link changes only the link (points identical); without a host both actions are disabled |
| `test/ink/input.test.ts` (updated) | recognition row: `requires_configuration` without the server capability, `supported` with it |
| `src/features/workspace/handwriting/handwriting.test.tsx` | the picture holds only pen writing (highlighter excluded, shape outline included), cropped, ≤ 1568 px, points inside the padding; a reading is reused only for exactly the same strokes; uncertain words: dotted underline + «؟» + spoken label + alternatives in the title, words isolated by direction; dialog: exact picture shown, read → request body (ids, page anchor, language, PNG), pending writing pushed first, uncertain summary, correction saved beside the machine reading; disabled with the server reason without a vision provider; an earlier reading of the same strokes shown; abstention reason + «اكتب ما كتبته»; «اسأل»: composed question with the paragraph, edited, handed over (anchor + quote + question) — never sent; typed text instead of a reading; the chat composer receives the question with no message posted |
| `src/features/workspace/audio/recorder.test.ts`, `AudioUi.test.tsx` | see `docs/modules/cases-media.md` «Track F4» |
| `apps/server/test/annotations/recognition.test.ts` (15) | without a vision provider: `requires_configuration` with the Arabic reason, a request refused (409 `AI_NOT_CONFIGURED`), nothing stored — also when a configured provider cannot read pictures; with the test-only FakeAiProvider: a DERIVED reading (strokes untouched, uncertain words, the sent picture kept, transcription-only prompt), idempotent by the client id, search in handwriting with its origin, a correction keeps the machine reading and becomes the owner text (audit), erased strokes / a deleted reading drop the hit, abstention / failure / retry, PNG and context validation, note pages, «اسأل» context (paragraph beside the writing), handwritten written answers (confirmed text, reading id), the full JSON export carries readings and corrections without the picture |
| `e2e/f4-handwriting-audio.spec.ts` (2 × 2 projects, passing) | real server without a key: capability `requires_configuration`, API 409; lasso «تحويل إلى نص» disabled with the reason; «اسأل عن المحدد»: the exact picture shown, the owner types the text, the paragraph beside it is found, the question lands in the rail composer and nothing is sent; recording with a fake microphone (see cases-media) |

### Limits (honest list)
* Recognition quality is **not measured**: no vision provider exists here; the server path ran only with the test-only
  `FakeAiProvider`. No claim about Arabic / English accuracy is made anywhere in the UI.
* Readings are online-only (the reader is on the server); corrections are saved through the API (an offline correction
  stays in the field with an error, it is not queued).
* Readings are not re-run automatically when the strokes change: an edited / moved stroke keeps its earlier reading
  until the owner reads it again (the dialog matches readings to the exact set of stroke ids).
* Note pages: «تحويل إلى نص» works (the note page must have reached the server — the dialog pushes pending writing
  first and the server says so when it has not); «اسأل عن المحدد» needs a lecture paragraph and explains that on a note
  page. The notebook screen (`/notebook/:id`) has no host yet: there both items stay disabled with their reason.
* A tap on a stroke plays its moment only with the lasso (the hand tool reads the page and does not hit-test ink).
* The full JSON export (`/api/data/export/all`) carries `ink_recognition` rows (reading, lines, correction, anchor,
  stroke ids) without the PNG that was sent (it is re-made from the strokes in `annotation`) and `audio_recording`.
* Found by the phone E2E run: the reader's «خيارات العرض» menu ran past the bottom of a 390 × 844 screen, so its last
  items could not be reached; `.ml-menu` (design system) now has `max-height: 100dvh − 16px` and scrolls inside itself.

### Independent adversarial review of F4 (2026-10-10)
Fixed (each with a regression test that fails on the code before the fix):
* **Recognized shapes lost their time link** — a stroke held still until it became a line / shape while recording kept
  `audio_link` only inside `recognized_from`, so `audioLinkOf(shape)` and the server's `$.audio_link.recording_id`
  query saw nothing. `layerController.commitStroke` now sets it on the shape too (`test/ink/audio-links.test.tsx`
  «a shape drawn while recording…»).
* **«رجوع» from the composed question lost the reading** — the dialog went back to «اقرأ الخط», inviting a second reading
  of the same strokes; the ask phase now remembers the reading (`handwriting.test.tsx` ««رجوع» from the composed
  question…»).
* **The composed question erased an unsent chat draft** — `ChatPanel`'s prefill replaced the composer text; it now joins
  the draft (`handwriting.test.tsx` «joins an unsent draft…»).
* **A misleading timeout message** said the result would be «في ملاحظاتي» (readings are not listed there); it now says
  to select the same writing again and open «تحويل إلى نص».
* Server: a handwritten answer's pad may now hold up to 4000 strokes (was 500 — an Arabic essay is many short strokes),
  with an Arabic reason past the bound (`recognition.test.ts` «a long handwritten answer…»).
Checked and found sound: the ink is never written by recognition (rows compared before / after), corrections keep the
machine text, search origin labels, the grading prompt carries only the confirmed text plus the no-deduction rule,
every new route sits behind the global session + CSRF guard, the PNG is magic-checked and size-bounded and served with
`nosniff`, recognized text is rendered as text (no HTML).

## Round 7 — H1 (2026-10-20): recognition and «اسأل عن المحدد» hardening
* **«اسأل عن المحدد» is disabled in «امتحن نفسك»** with the mode as its reason (`HandwritingHost.tsx` prop
  `askHiddenReason`, passed by `WorkspaceScreen.tsx` in exam mode — the same reason text as the other hidden helpers);
  the lasso action is disabled with that reason, and opening / sending the ask dialog is refused with an announcement.
  «تحويل إلى نص» stays available. Test: `web:test/ink/ask-exam-mode.h1.test.tsx`.
* **Server checks on a recognition request** (`annotations/recognition.ts`): every `annotation_ids` entry must be a
  stroke anchored to the requested page / note page — not yet synced → 409 «لم تصل إلى الخادم بعد» (wait for sync),
  deleted → 409 «…حُذفت…», on another page → 400 `VALIDATION_FAILED` «…على صفحة أخرى غير الصفحة المطلوبة…» with the
  offending ids; nothing is stored. A retried
  create with the id of a soft-deleted reading is a 409 «هذه القراءة حُذفت…» — it never resurrects or returns it — and a
  same-id retry for another target is a 409 (never the other reading).
* **A failed reading is labelled and retryable**: the dialog prefers a non-failed reading of the same strokes, and a
  failed one is shown as «<status label>: <reason>» in the error state with «أعد المحاولة» (`RecognitionDialog.tsx`).
* Tests: `srv:annotations/recognition.test.ts` «H1 hardening — recognition requests» (5, FakeAiProvider),
  `web:src/features/workspace/handwriting/handwriting.test.tsx` «H1 — a FAILED earlier reading».

## Round 7 — H3 (2026-10-20): undo that survives a reload; lasso → card / question
* **Persistent undo / redo (§26 «سجل تراجع حتى بعد إغلاق التطبيق»).** `history.ts` gained `peekUndo` / `peekRedo` /
  `drop` / `snapshot` / `restore`; `historyLog.ts` stores the per-document stacks in the `kv` table (key
  `ink.history.v1:<document>`), newest steps first under `HISTORY_MAX_CHARS` (2 MB; an older step that does not fit is
  dropped with everything older), saved 400 ms after a change and on `pagehide` / dispose, loaded when the document
  opens (`store.historyReady`). A step is checked against what is there NOW before it runs (`store.undoStep()` /
  `redoStep()` → `done | empty | confirm | checking`): pages not loaded are read from IndexedDB; changes already in
  place are skipped; a step that would bring back writing deleted since (the server's tombstone pulled from another
  device, the trash) or overwrite a newer edit is not applied silently — `InkProvider` asks «التراجع عن «…»» with
  «نفّذها وأعِد الكتابة» / «نفّذها» or «تخطَّ هذه الخطوة» (`PendingStepDialog`). The toolbar's history note says the
  history is kept on this device and size-capped. Limits: per device; two tabs on one document → the last writer's log
  wins. Tests: `test/ink/history-persist.h3.test.ts` (6 — write + move, close, reopen: both undo and redo; writing erased
  on another device (server tombstone) → the step asks and «skip» keeps it erased; «bring it back» restores it on
  purpose; an item edited elsewhere is not overwritten without a question; a step on a page not on screen is checked
  against this device's copy; the size cap keeps the newest steps),
  `test/ink/history-dialog.h3.test.tsx` (1).
* *Independent review (2026-10-20).* A change skipped because its item was already as the step wanted it (e.g. undo
  «كتابة» of a stroke another device had erased: nothing to remove) used to stay in the step that moved to the redo
  stack, so **redo then brought the erased stroke back without asking** (an upsert the server applies over its
  tombstone). The step that moves to the other stack now keeps only the changes that were really applied
  (`InkHistory.narrowTop`, called from `store.apply`; a step left with none leaves the stack). Test:
  `test/ink/history-review.h3.test.ts` (3 — the erased stroke stays erased after undo + redo, also for a page not on
  screen; a partly skipped step redoes exactly its applied part); failed before the fix.
* **Lasso → card / question (§28/§29).** `selectionActions.tsx` gained `card` / `question`; `SelectionOverlay` shows
  «اصنع بطاقة من المحدد…» and «اكتب سؤالًا من المحدد…» under «المزيد» (disabled with a reason where no host provides
  them). The host (`handwriting/HandwritingHost.tsx` → `LassoCardDialog.tsx`) does the rest: a basic card whose front can
  come from the reading of exactly those strokes (gated honestly on the vision provider), an image-occlusion card from
  the source-page area the server cuts under the selection, or an owner-written question saved in the vault and linked
  to the lecture. See `docs/modules/workspace.md` «Round 7 — H3» item 4. Tests:
  `src/features/workspace/handwriting/LassoCardDialog.h3.test.tsx` (7), `srv:annotations/h3-lasso-card.test.ts` (7),
  `e2e/h3-reader-notes.spec.ts`.

## Round 7 — React Compiler lint rules (2026-10-20; §58)

`InkLayer`, `InkProvider`, `SelectionOverlay` and the ink host write their latest-value refs (view, anchor, tool,
host, callbacks, the text editor's commit function) in `useInsertionEffect` — before any layout effect, so the layer's
own layout effect and every pointer handler see the same values as before. The selection overlay's handles call
`begin(mode, e)` from inline handlers (no curried handler built during render). The paper tone for ink text, sticky
notes and the selection swatches comes from the new `usePaperTone(ref)` (measured in a layout effect; before it was
read from the ref during render, so the first paint used the theme until a later re-render). Details:
`docs/modules/core-web.md` §10. Ink unit tests (`test/ink` + `src/features/workspace/ink`: 17 files, 138 tests) pass
unchanged; in the full E2E run the ink specs `g6-ac21-ink-position`, `g6-ac22-font-size`, `f1-notebook-pages`,
`f4-handwriting-audio` and `h3-reader-notes` pass. `g6-ac28-pencil` fails (3 tests × 2 projects) — identically on the
committed code without these changes: its expectations predate track F4 (it expects recognition «غير منفّذ بعد», the
panel now says «يحتاج إعدادًا على الخادم», and the Control Center text «…وتعمل كاملة دونه» trips its «not تعمل» check).
The spec was not changed here (`docs/TEST_LOG.md`, Round 7 lint).

## Round 7 — final verification: `g6-ac28-pencil` brought up to date (2026-10-20; AC-28)

The spec's three expectations that predated track F4 now assert what the product honestly says: the capability panel's
recognition row is «يحتاج إعدادًا على الخادم» (`requires_configuration` — built in F4, no vision provider here; never
«مدعوم ورُصد هنا»), the lasso's disabled «تحويل إلى نص» carries the server's reason (it names the missing vision
provider), and in the Control Center the recognition card's state pill is «تحتاج إعدادًا على الخادم» (not «تعمل» /
«تعمل بحدود») with a reason naming `ANTHROPIC_API_KEY`. The old «not تعمل anywhere in the card» check matched the
reason's «كتابتك نفسها تُحفظ وتعمل كاملة دونه», which speaks of the owner's writing, not of recognition. No product
code changed. `npx playwright test e2e/g6-ac28-pencil.spec.ts`: 6 passed (3 × phone + desktop); also green in the full
run (`docs/TEST_LOG.md`, Round 7 final verification).

## Academic OS P1-T2 — layers, packed ink, tile cache, e-ink (2026-10-21; steps 1 and 2)

BUILD_PLAN §3.4, ADR-0004 R1–R6, ADR-0005 B.3–B.4. Step 3 (`reanchor_copy` between versions) is the next section.

### Layers in the engine (`ink/layers/*`, store seams)

* **Model.** `annotation.layer` stays the render class; `layer_id` is authorship. No `layer_id` = the document's
  «ملاحظاتي» (default personal layer, derived id `defaultPersonalLayerId(documentKey)`, `pl_…`). Document keys:
  `source:<id>` / `notebook:<id>`. Layers live in Dexie `layers` (T1's v3 schema) and sync as `annotation_layer`.
* **Store seams (the N1 Wave 0 equivalents):** `setVisibility(fn, key)` — the key names the visible-layer set so the
  tile cache can reuse grids; `setEditability(fn)`; `setActiveLayer(id, scope)` — new writing is stamped with the active
  layer only when it is not «ملاحظاتي» and only for items of the reader's own document (the split pane's second source
  keeps its own default); `setWriteToHiddenLayerHandler` (writing on a hidden layer shows it again);
  `copySelectionToActiveLayer`, `selectionHasReadOnly`. A visibility change emits a page event `view` (no content
  change: grids stay valid).
* **Predicates** (`layers/model.ts`): `visible` — not hidden in this study session; `editable` — the owner's writable,
  unlocked layer and no other author. Applied in render, hit-test, the stroke and point erasers (candidates must be
  visible AND editable; point-erase pieces keep the original layer), lasso (hidden items never selected; read-only
  items selectable for «انسخ إلى طبقتي» only), DOM objects (text / sticky edit only if editable) and the screen-reader
  page summary (counts what is shown, and says how many items sit on hidden layers). The reader's text highlights
  (`reader/overlays.tsx`) use the same predicate since the review.
* **Session.** `LayerViewProvider` (mounted by the reader inside `InkProvider`) keeps the predicates in step with the
  session's `{ hidden, active }`, which the reader saves with its place (`StudyLocation.layers`).
* **Re-homing** (`layers/rehome.ts`, through the sync engine's `onRejected` hook): a stroke or note the server refuses
  with `layer_read_only` / `layer_forbidden` / `use_crdt` is re-created on «ملاحظاتي» under `rh_<id>` (idempotent:
  delivery is at least once), the original is put back as the server has it (or the local-only copy is tombstoned), the
  op is settled, and the owner is told why. A refused ERASE simply shows the item again. (Review 2026-10-21) The copy is
  built from the owner's LAST pending op of the item (drawn, then moved offline → the moved stroke is kept; drawn, then
  erased → nothing is re-homed), and the notice names the real reason: «للقراءة فقط» only for `layer_read_only`, «لم
  تعد موجودة أو لا يُكتب فيها من هذا الجهاز» for a layer that is gone (`layer_forbidden`) or CRDT-only.

### Packed ink v2 (`ink/codec.ts`, shared `academic/ink-codec.ts`)

The transport sends `accept-ink: 2`; the applier decodes v2 to v1 (memory and IndexedDB keep v1); pushes use v2 only
after a v2 entity was received in this page lifetime (an old server never sees v2). The codec refuses a lossy
encoding (stays v1).

### Dense-page tile cache (`ink/tiles/*`)

* **When:** a page with ≥ `TILE_MIN_ITEMS` (400) committed items repaints its committed layer through tiles; lighter
  pages paint stroke by stroke exactly as before. `localStorage['medlevo.ink.tiles'] = 'off'` turns tiles off (the
  harness measures «before» this way).
* **Grids** of 512 px tiles per page × view (canvas size, transform, paper tone, **resolved ink palette**) ×
  visible-layer set; a tile holds a
  highlight and an ink bitmap (or none). Warm repaint = copy the tiles. Cold tiles are drawn in **raster-timed slices**
  (≈ 8 ms per frame, a 1 px read-back after each chunk so the clock includes the rasterization) into the tile's own CPU
  surface, then copied onto the page; during a zoom step the previous picture, scaled, stands in.
* **Correctness:** the grid on screen follows every dirty-rectangle repaint (the touched valid tiles are refreshed from
  the page canvases; a tile being drawn restarts); grids not on screen follow the store's page events (stale where
  changed, dropped on a reload); unchanged rows of a whole-page reload are no longer reported as changes. (Review
  2026-10-21) The view key includes `paletteSignature()` — the computed value of every colour token plus the e-ink flag
  — because a tile is a bitmap of resolved colours: before the fix, switching e-ink (or high contrast) on with the paper
  tone unchanged copied the previous palette's warm tiles, so a dense page kept coloured ink in e-ink mode
  (`test/ink/tiles.test.ts` «display modes and tiles»).
* **Memory:** LRU by bytes, 96 MB (48 MB when the device reports ≤ 4 GB, 24 MB in «خفيف»); grids on screen stay.
* **Measured** (docs/PERFORMANCE.md, Academic OS P1-T2): realistic 1.13 M-point page over 5 layers — warm repaint
  8 ms / 0.1 ms (was 1.6–1.7 s in one 2–2.6 s long task); cold re-raster in slices with no ink long task > 100 ms.

### E-ink mode (`design/themeDisplay.ts`, tokens.css, ink.css)

`<html data-eink="on">`: black / grey tokens, ink tokens in greys (`--ml-ink-c-*` overridden; the same greys are the
`eink` value of each token in `palette.ts`, for text boxes and sticky notes that resolve without the layer's CSS, and a
**custom pen colour** becomes a grey of its lightness — pens #000…#4a4a4a, highlighters #b0b0b0…#d6d6d6, `einkGreyOf`;
review 2026-10-21: before, custom colours and DOM objects stayed in colour), no animation or
transition, `scroll-behavior: auto`, the reader's `.wk-canvas` snaps per page (paging instead of smooth scrolling), and
no live-stroke prediction overlay (`getPredictedEvents()` ignored). It is a per-device setting (Settings → المظهر),
suggested only when the browser reports `(update: slow)`. High contrast (`data-contrast`) and lite (`data-lite`) modes
sit next to it.

### Tests (all passing)

`test/ink/layers-visibility.test.ts` (13), `test/ink/rehome.test.ts` (11 after the review), `test/ink/tiles.test.ts`
(13 after the review), `src/design/themeDisplay.test.tsx` (7 after the review); e2e `aos-p1-layers.spec.ts`, `aos-eink.spec.ts`, and the dense-page scenario of
`perf.spec.ts` (MEDLEVO_PERF=1).

### Limits (honest)

* Layer «lock» is a client-side guard (the server does not know it); read-only layers (followed, snapshot, frozen) are
  enforced by the server.
* Notes and text highlights created from the reader go to «ملاحظاتي» (the active layer applies to ink items).
* A lasso copy of a followed item becomes the owner's own writing with no attribution row (the server-side «انسخ الطبقة»
  writes attribution).
* Cross-layer paint order is still the items' z order (layers are not separate composited sheets); hidden layers'
  highlights are simply not drawn.
* Cold tile re-raster takes 3–4× the old wall time on the realistic page (the frame stays responsive meanwhile); a
  GPU-backed page canvas was not available to measure.
* Nothing here was run on an iPad, S Pen tablet or BOOX (NFR-P1, OC.5, OC.8 «Not run (no device)»).
* The layers panel's per-layer counts cover the pages of the current version in view; «احذف الطبقة» checks every item
  of the layer this device holds (`countLayerItems`, all versions and note pages) before it asks, and the server still
  refuses a layer with items this device never loaded (the device then shows the layer again as the server has it).
* Undo / redo is not checked against a layer the owner locked after the change (lock is a guard against accidental
  writing, not a permission).
* Text boxes and sticky notes resolve their colour when they render: switching e-ink on while a page is open recolours
  ink at once, DOM objects at their next render (Settings is another screen, so in practice on return).

## Academic OS P1-T2 step 3 — «انقل ملاحظاتي إلى الإصدار الجديد» (`reanchor_copy`, 2026-10-21)

BUILD_PLAN §3.4 step 3; ARCHITECTURE_DELTA §6.3; PRD AOS-3.13, 4.17, 4.20, Q35; Scenario 4 (the note side, inside one
vault). **Copy, never move**: the owner's items on an earlier version stay there unchanged; copies are written on the
new version where P1-T3's page map says the page is the same; everything else waits for the owner's decision.

### Server (`modules/annotations/reanchorCopy.ts`, migration `0274_reanchor_copy.sql`; `0273` stays reserved for P3-T2's `0273_annotation_audio_index.sql`, BUILD_PLAN appendix B)

* **What is copied without asking** (pure `planItem`, over P1-T3's `PageMapEntry`; nothing is guessed):

  | item | copied to `to_page_id` when | how |
  |---|---|---|
  | ink, pen highlight / underline, shape, text box, sticky, picture, page link | `isCopyTarget(entry)` **and** (`layout_safe` **or** the owner confirmed the pair) | same normalised coordinates on the new page |
  | text highlight / underline (`text_highlight`) | `isCopyTarget(entry)` **and** the quote is found again on the new page (letters only — spacing, line breaks, bidi marks and tatweel ignored; a repeated quote needs its prefix / suffix unless the layout is identical) | same rectangles on an identical layout; on a re-laid-out page only when every rectangle sits in a paragraph found once, identical and of the same size, on the new page (translated with it); otherwise review |
  | bookmark, page note | `isCopyTarget(entry)` | page anchor only |

  Anything else — page `uncertain` (rewritten: «page_changed»; crossing move: «page_moved»), `none` / `rejected`
  («page_removed»), a re-laid-out page for coordinate items («layout_changed»), a quote not found — is listed for
  review with the page map's candidate page. Items of a read-only layer (a followed copy) and items the owner chose to
  keep are counted «بقيت على الإصدار السابق» and never copied.
* **A copy** = a new row with the deterministic id `reanchorCopyId(old_id, to_version_id)` (`rc_` + sha256), the same
  layer, author, kind and data; `migrated_from_id` = the original, `previous_anchor_json` = the old anchor,
  `anchor_status = 'reanchored'`, `origin = 'reanchor_copy'` (notes: the same columns that exist on `note`); an
  attribution row only when the original has one (its chain + this hop); pictures' `annotation_image` marked referenced;
  the sync feed is touched, so every device receives the copies. The original row is never written (tests hash it).
* **Bookkeeping (0274, additive):** `reanchor_copy_run` (one row per tap — kind `run` — or per review copy — kind
  `manual`: versions, algorithm, counts, undo), `reanchor_copy_item` (original → copy, the copy's rev when written,
  `undone_at`), `reanchor_copy_decision` («اتركها على الإصدار السابق»). An original with a live item row is «carried
  forward» and never copied twice (a second tap copies nothing and records nothing).
* **Routes** (`/api/annotations`):
  * `GET /reanchor-copy?source_id=&from_version_id=&to_version_id=` → `ReanchorCopyPreview` — writes none of the owner's
    items (it may store P1-T3's page-map cache and queue its analysis job, both derived data). Defaults: the newest
    version, and the newest earlier version with items still waiting (never counting carried, kept or read-only ones). The map is read or computed from stored
    fingerprints (cheap); missing fingerprints answer `pending` and queue P1-T3's analysis job (never rendering on the
    request). Counts: `total = already_moved + copy + needs_review + kept`; the will-copy pages, the review list (≤ 500)
    with old page and candidate, kept items, every earlier version with items, the last tap.
  * `POST /reanchor-copy {source_id, from_version_id, to_version_id, map_computed_at?}` → `{ report }` — the tap: one
    transaction; a map that changed since the preview → 409 and nothing copied; a version still processing → 409.
  * `POST /reanchor-copy/undo {run_id}` — tombstones that run's copies only (a before-image in `annotation_revision`
    each); a copy the owner changed since is kept and reported (`kept_edited`); idempotent. A later tap revives the same
    ids; a copy the owner erased is never revived — also across an undo of its run (review fix: the erased copy stays
    «carried»).
  * **A live copy is never written over** (review fix): after an undo, a device's queued edit of a copy brings it back
    (sync «merged» — an edit concurrent with a delete is kept). Such a copy counts as carried (`already_moved`), is not
    listed for review, a review copy of its original is refused (409), and `writeCopy` refuses any live row under the
    deterministic id (the transaction rolls back) — before the review a later tap overwrote the owner's edit with the
    original's content.
  * `POST /reanchor` (Round 7's route, reused AS A COPY) with `action: 'copy'` (to a page — optionally a paragraph — of
    the newer version; Round 7's group geometry; the revision the list saw is checked; refused for read-only layers),
    `'keep_on_previous'` or `'review_again'`. `move` / `keep_detached` are unchanged (`reanchor.ts`, Round 7; this step
    only exported its three geometry helpers).
* **Purge** (`purgeExtension.ts`, `annotations.reanchor_copy`): runs of a purged lecture / version, item rows and
  decisions of purged originals or copies; the preview line names them. **Export:** the three tables are in the full
  JSON export (seam lines in `data/export.ts`); backups copy the whole database.

### Web (`features/workspace/panels/NoteMigration.tsx`, `noteMigration.ts`, `noteMigration.css`)

* **Banner** in the reader (`WorkspaceScreen.tsx`, one mount) when the lecture has a newer version and personal items
  wait on an earlier one: «يوجد إصدار أحدث من المحاضرة. لديك ملاحظات على الإصدار 1: سيُنقل 2 · يحتاج مراجعة 1 · يبقى على
  الإصدار 1: 0» → «معاينة النقل…» opens the preview (nothing changes before the tap) → **one tap** «انقل ملاحظاتي إلى
  الإصدار 2» → the report («نُقل … إلى … صفحات؛ … يحتاج مراجعتك؛ … بقي على الإصدار السابق», the three counts and their sum)
  with «تراجع عن النقل» and «راجع العناصر». On an earlier version the banner says so and opens the newest one. Online
  only: going offline keeps what was loaded, its controls disabled and the reason shown (review fix — the banner and the
  list used to vanish); offline from the start nothing is known, so nothing is shown. The tap first sends this device's
  unsent writing (review fix), and the copies arrive through the sync pull right after it. While P1-T3's analysis runs
  («pending») the preview is fetched again every 5 s (at most 10 minutes) instead of waiting for the reader to reopen.
  A tap that copied nothing new (a retry, or another device was first) offers the undo of the run that did copy.
* **Review list** — the top of «ملاحظاتي ← إعادة ربط» (`ReanchorSection.tsx`, extended): each item with its old page
  and the candidate page side by side (page images from P1-T3's thumbnail route) and the reason; «انسخها إلى ص …» (one
  tap on the candidate — a moved page follows only this way), «اختر مكانها…» (Round 7's place dialog, worded as a copy:
  «انسخها هنا»), «اتركها على الإصدار 1»; kept items can go back to review. A review copy's toast offers «تراجع» (that
  copy only, `POST /reanchor-copy/undo` with its own run); a refused undo says why. A link opens P1-T3's compare screen.
* **Default (Q35):** one tap with a preview. The automatic variant («انقل ملاحظاتي تلقائيًا») is **not built**.

### Tests

`apps/server/test/annotations/reanchor-copy.test.ts` (26 after the review: the pure planner, quotes, re-derived highlight
rectangles, deterministic ids; Scenario 4 —
preview writes nothing, the tap, v1 rows hashed byte-identical, the sync feed, second tap no-op, a changed map → 409,
review copy / keep / review again, undo keeps an edited copy and a new tap revives, an erased copy is never revived,
refusals; inserted + reordered fixture — moved page suggested, owner confirmation turns it into a copy target; layers,
read-only layer kept, a pending version, export, purge, 0274 on an existing database and 0273 left free for P3-T2; review:
a copy brought back by a device after an undo is never overwritten by a tap or a review copy, an erased copy stays erased
across undo + tap, read-only items never count as waiting),
`apps/web/src/features/workspace/panels/noteMigration.test.tsx` (14 after the review), `e2e/aos-p1-note-migration.spec.ts`
(phone + desktop). Fixture: `apps/server/test/fixtures/note-migration/build.ts` (TEST FIXTURE, built from P1-T3's generator).

### Limits (honest)

* The automatic migration (Q35 variant) and the follower fan-out of an official version (`lecture_copy`, P1-T5) are
  not built; here the owner taps.
* Rectangles of a highlight on a re-laid-out page are re-derived only from an identical, same-size paragraph; anything
  else goes to review. Page notes carry no paragraph, so a page note on a safe page is copied to the page only.
* Inserted note pages (`note_page`) are not version-anchored and are not touched; Study Book anchors keep their own
  re-anchoring (`computeReanchor`); citations, evidence and Source Lock pins stay on their version.
* Decisions are online, audited server calls (like Round 7's re-anchoring); offline the banner and list stay as last
  loaded with their controls disabled and the reason shown.
* The review list is bounded (500 items; its heading shows the full count); a dense re-laid-out page with more pen
  strokes than that is reviewed 500 at a time.
* A page note that belongs to a notebook keeps its `node_id`: the notebook then lists the original and its copy (copy,
  never move).
* The reader's review list shows one earlier version at a time (the newest with items waiting); the preview's `earlier`
  lists all of them.


## Parity N1 wave 1 — writing comfort and speed, part 1 (2026-10-21; `docs/research/NOTE_APP_FEATURE_PARITY.md` B.4)

Gaps G03, G14, G15, G17, G19, G66, G02, G01 on top of the «Wave 0» seams. No migration: everything new is optional
fields of existing JSON (`InkStyle`, `TextBoxData`, `ImageAnnotationData`, append-only; `layer_id` and InkData v2
untouched) and one more part of the owner's settings (`ink`). A stroke written with the classic feel and no colour
meaning is byte for byte what the engine wrote before N1.

### Wave 0 seams (for N2…N5)

* `ink/kinds.ts` — item-kind registry: built-in kinds plus kinds other tracks register (`selectable`, `erasable`,
  `exportable`, `contentType`, optional `geometry` / `bounds` / `draw` / `transform`). The lasso, the eraser, «امسح الصفحة»,
  the page summary and the renderer ask the registry instead of hard-coded lists. Reader kinds (`text_highlight`) are
  erasable but never held in the engine's page memory.
* `ink/tools.ts` — toolbar tool registry (`registerInkTool`: id, Arabic name, icon, shortcut by `KeyboardEvent.code`,
  options panel, pointer session). Registered tools appear after the built-in ones and in the toolbar layout.
* Visibility: P1-T2's predicate is reused; `store.setViewFilter(name, fn, key)` adds named filters (colour legend,
  clean review view, N5 exports) ANDed with the layers' predicate (tile cache keyed by them); new writing that a filter
  would hide lifts the filter (the owner always sees what they write).
* Lasso actions: `InkSelectionActions.extra` (named actions with id / label / icon / disabled reason), merged across
  nested providers. Text editor slot: `<InkProvider textEditor={…}>` (N3 mounts a rich editor; default plain textarea).

### What was built

* **G03 colour slots + meanings** (`inkSettings.ts`, `InkSettingsDialog.tsx` «الألوان ومعانيها», `InkDialogs.tsx`
  «دليل الألوان ومعانيها»): up to 12 slots per tool (tokens or `#rrggbb`), reorder / remove / reset, saved as the WHOLE
  `ink` object through `/api/settings` (offline: the settings store keeps the change and sends it later). A slot's
  meaning (≤ 60 chars, one line, no bidi controls — validated on the server) is saved in each new stroke
  (`style.meaning`), named with the colour on the options button, the selection frame and the page summary («never
  colour alone»), follows a lasso recolour, and drives «اعرض «…» فقط» (a session view filter, nothing deleted).
* **G14 gestures** (`gestures.ts`): recognised only after the stroke is committed (off the pointer path).
  Scribble-to-erase: ≥ 5 reversals, erases strokes it touches whose box it covers ≥ 60 % and only when ≥ 40 % of the
  scribble lies over them — the scribble and the erased strokes are ONE undo step («مسح بالخربشة»), announced. The
  highlighter never erases; locked / hidden / read-only items are kept; on empty paper it stays ink; a normal hand's
  letters and an ECG strip are not scribbles (review: a very cramped «سسس», a small cursive «vvv» or a column of ticks in
  one stroke can pass the shape test, but they erase nothing unless the zig-zag lies mostly over the strokes); shading or
  filling inside a closed outline drawn before (a nucleus, a hand-drawn box, a rectangle or ellipse shape) never erases
  that outline (review fix). Circle + hold (600 ms) → lasso selection of what
  the loop encloses (the loop is not ink), Escape returns to the pen. Two-finger double tap = undo, three = redo
  (fingers only; a moved finger, a pen touch or a cancelled pointer voids it). Each gesture can be turned off in
  «إعدادات الكتابة» → «الإيماءات»; buttons and Ctrl/⌘ Z stay.
* **G15 selective erasing** (`bulk.ts`, `InkDialogs.tsx`): the eraser's type chips (pen / highlighter / shapes / the
  reader's text highlights — the last off by default); «امسح الصفحة» and «احذف كل نوع في الدفتر» show the count per type
  first (reaching pages that are not open, read from this device's storage), then remove as tombstones in ONE undo step
  (also after a reload: the H3 history); «المحذوف بالجملة» lists those removals on this device and restores them
  (items changed since are left alone). «نسخة نظيفة للمراجعة» hides chosen kinds for the session (nothing erased).
* **G17 lasso** (`kinds.ts` `lassoAllows`, `prefs.ts` `LassoPrefs`): chips ink / shapes / text / images / links,
  «حبري فقط», rectangle mode; remembered per document on this device. Reader text highlights are never selected or
  moved by the lasso.
* **G19 resize / rotate / keyboard** (`model.ts`, `SelectionOverlay.tsx`): corner drags stretch shapes, strokes and text
  boxes (Shift keeps the proportions, Alt resizes about the centre; a text box's letters keep their size); pictures and
  links keep their proportions; the far side stops at the storable range (`limitStretchToRange`). Text boxes and
  pictures turn with the rotate handle — `rotation` (radians, clockwise, page space) so zoom and page rotation never
  change it (AC-21). The frame is a focusable group with an Arabic name and help; a new selection takes the keyboard;
  arrows move it 1 page point (Shift: 10) in the direction pressed ON SCREEN (rotated views included), presses within a
  second are one undo step; Delete removes; Escape clears; arrows are left alone while typing.
* **G66 toolbar** (`toolbarLayout.ts`, `InkToolbar.tsx`, «شريط الأدوات»): order, hidden tools, dock top / start side /
  end side (a vertical floating bar rendered at the app root), previous-tool slot, «insert returns to the lasso», per
  study-mode profiles (the mode read from `InkHost.studyMode` or the reader's mode switch) with suggested profiles for
  «تعلّم» / «امتحن نفسك». The active tool is never hidden; the fit keeps «المزيد», options, undo and redo; when the
  options button has no room, «المزيد» opens the same options in a dialog.
* **G02 palm rejection** (`input.ts` `PALM_LEVELS`, «راحة اليد»): low / medium / high map to the contact size and the
  quiet time after the pen; the writing hand's zone (beside and below the pen on the hand's side — where the hand rests
  on Arabic ink already written) for a while after the pen lifts; the values in force are shown in the settings and in
  «قدرات القلم على هذا الجهاز»; a test pad counts rejected touches and would-be stray marks and records the result on this
  device. System palm rejection stays «requires native».
* **G01 pen feel** (`feel.ts`, `render.ts`): smoothing 0–6, pressure floor, round / sharp taper, constant width; profiles
  كلاسيكي / كتابة / رسم دقيق / تشريح (steady, thin, constant) / مخصّص (the owner's values, synced); the profile is
  remembered per notebook / document on this device and saved INTO each stroke's style (only what differs from the
  classic drawing), so every device draws a stroke the same way. Latency: from the oldest pointer sample not drawn yet
  (coalesced samples included — review fix) until the live layer draws it in the next animation frame, measured in THIS
  browser (`latencyProbe`, p50 / p95 per pointer type, ≥ 20 samples) and shown in the capability panel; compositing,
  presenting the frame and the display's own delay are not included (said in the row); nothing is shown until measured.

### Tests (all passing)

Server `apps/server/test/annotations/n1-ink.test.ts` (8: style / meaning / rotation validation, round trips, restore of a
tombstone). Web `apps/web/test/ink/`: `gestures.test.ts` (15), `n1-seams.test.tsx` (8), `n1-colours.test.tsx` (11),
`n1-gestures-erase.test.tsx` (14), `n1-select-resize.test.tsx` (14), `n1-toolbar-palm-feel.test.tsx` (18) — counts after
the review below (it added 3 + 1 + 4 + 1 + 1 regression tests).
E2E `e2e/n1-writing.spec.ts` (phone 390 × 844 + desktop 1280 × 800, Arabic UI): meaning synced to a second browser
profile and back; offline scribble / clear page / one undo after reconnect + reload; on the phone two- and three-finger
double taps (CDP touches); docked bar, hidden tool, 44 px targets, no sideways scroll; lasso chips and rectangle; e-ink
greys in «إعدادات الكتابة»; arrow nudge; «تشريح» saved in the stroke; palm values and measured latency in the panel.
5 000-stroke budget re-run (`MEDLEVO_PERF=1`, desktop, headless Chromium in this container, two runs): open → 5 000
strokes painted 12.6 s under load from the parallel track / 8.3 s at load ≈ 2 (I2 baseline 10.6 s); a new stroke
164 / 63 ms pointer-up → committed with 0 long tasks; zoom repaint longest task 106 / 55 ms. The dense-page tile run
passed once (warm layer show 0.2 ms, 6/6 warm tiles; writing during re-rasters: longest task 74 ms) and failed twice
before measuring because the 4 layers seeded through sync were not yet listed in «الطبقات» after 15 s (layers / sync
code, not this track).

### Limits (honest)

* Device behaviour is **Not run (no device)**: iPad + Apple Pencil, S Pen, BOOX, a real palm, perceived latency. The only
  latency numbers are headless Chromium with a mouse in this container (desktop: p50 8.7 ms, p95 23.1 ms, 45 samples) —
  not a device figure, not recorded as one in `CAPABILITY_MATRIX.md`.
* The clean review view hides the engine's kinds only; the reader's own text highlights are hidden from «الطبقات»
  (`reader/overlays.tsx` is not part of this track).
* The lasso choice and the pen-feel profile are remembered per document on this device (not in the study session /
  synced); per-mode toolbars are opt-in profiles (nothing hidden by default); the study mode is read from the reader's
  switch when the screen does not pass `InkHost.studyMode`.
* Sticky notes stay fixed-size widgets (moved, never resized). Links stay upright (a rotation moves their centre).
* G14's medical extensions (circle a printed term → dictionary, a check-mark on a question number → revision) and
  searching by colour meaning are not built.
* On a desktop reader with the study rail open, the reader's top bar (`workspace.css` `.wk-topbar__center { flex: none }`)
  let the writing bar measure its own content width: after a reload the bar could show every tool and lie under the zoom
  group. **Fixed in the R1-b final verification** (see «Review of N1 wave 1» below).

### Review of N1 wave 1 (2026-10-21, independent adversarial review)

Found and fixed, each with a regression test that failed before the fix:

| # | severity | what was wrong | fix | test |
|---|---|---|---|---|
| R1 | major | Scribble-to-erase (on by default) took shading or filling INSIDE a small outline drawn before — the nucleus of a sketched cell, a hand-drawn check box — for a scratch-out: the outline was erased, and the shading too (an undo brought the outline back, never the shading) | a scribble lying ≥ 80 % inside a closed outline (a stroke that closes on itself, a rectangle or an ellipse) never erases that outline (`gestures.ts` `closedOutline`, candidate `outline`; `layerController.ts` `outlineOf`); a scratch-out that runs over a small loop still erases it | `gestures.test.ts` «shading inside a small drawn outline …», «a scratch-out that runs over a small loop …»; `n1-gestures-erase.test.tsx` «shading inside a small circle drawn before stays ink …» |
| R2 | major | «امسح الصفحة» cleared the page written on LAST, not the page in view, and did not say which page: after writing on page 3 and scrolling to page 10 it removed page 3's writing | the page the reader shows comes first (the page written on last only without a host); the dialog names the page («الصفحة التي تُمسح: الصفحة ١٠») and the announcement too | `n1-gestures-erase.test.tsx` «… acts on the page in view (named in the dialog) …»; e2e G14 / G15 step |
| R3 | minor | With a selection on the page, the arrow keys moved the owner's ink even while a slider, a radio group or a check box elsewhere had the keyboard (and that control lost its arrows) | the arrows move the selection only when the keyboard is on the selection, on a page's ink layer or on nothing in particular | `n1-select-resize.test.tsx` «the arrows are left alone while another control …» |
| R4 | minor | A failed IndexedDB write of a restore (undo) of an item the engine does not hold in memory — a reader text highlight, an item on a page that is not open (delete by type, undo after a reload) — was retried as a tombstone: the restore was lost silently and the save status went back to «saved» | the store keeps the state each failed write meant to store (`failedIntent`) and retries such items with it | `n1-gestures-erase.test.tsx` «a restore (undo) whose write failed is written again …» |
| R5 | minor | With finger writing on (pen-only off), the first finger of a two-finger double tap with the eraser (or the lasso) acted before the tap was recognised: the «undo» then undid that erase instead of the owner's last step | a second finger within 200 ms of a fresh touch eraser / lasso gesture cancels it (as a second finger already did for a fresh stroke) | `n1-gestures-erase.test.tsx` «with finger writing on, a two-finger double tap with the eraser …» |
| R6 | minor | Latency was counted from the dispatching event's time stamp (the newest coalesced sample), understating it, and the row said «إلى رسم الإطار» although presenting the frame is not included | counted from the oldest coalesced sample; the row says «حتى يرسمه التطبيق … لا يشمل عرض الإطار على الشاشة ولا تأخر الشاشة نفسها» | `n1-toolbar-palm-feel.test.tsx` «latency is counted from the oldest coalesced sample …» |
| R7 | minor | On e-ink every pen colour becomes a near-black grey and the colour picker showed only swatches: the slots (and their meanings) could not be told apart by sight | each slot carries a visible name (its meaning, else its colour), shown only in e-ink mode (the radio's accessible name is unchanged) | `n1-colours.test.tsx` «the colour picker carries a visible name …»; e2e G66 e-ink step |
| R8 | minor | «امسح الصفحة»'s type check boxes grouped a registered kind by its kind name, the counts by its content type | both use `contentTypeOf` | covered by the clear-page tests |
| R9 | minor | On desktop the new previous-tool slot («الأداة السابقة: اليد (قراءة وتمرير)») gave the AC-30 spec a third button whose name contains «تم» (as the hand tool's «وتمرير» does): `e2e/g7-ac30-restore` failed on desktop with a strict-mode violation (found by P1-T1's reviewer, reproduced here) | the spec's «تم» click is exact (`e2e/g7-ac30-restore.spec.ts`, one line; test-only, the product names are right) | `e2e:g7-ac30-restore` phone + desktop pass |

Open (not fixed here, with the reason):

* **The `ink` settings object is one last-writer-wins unit between devices.** It is sent whole (the web settings store,
  `lib/settings.ts` — P1-T1's file — spreads a pending patch over the cached settings at the TOP level, so a partial `ink`
  would show defaults offline after a reload). Consequence: a toolbar change made offline on one device can, when it is
  sent, put back colour meanings renamed meanwhile on another device. Remedy: the settings store merges pending patches
  with `mergeSettingsPatch` (as the server does), then `updateInkSettings` sends only the parts it changed.
* **Circle + hold pre-empts hold-to-shape for a loop drawn around writing**: holding still after circling a handwritten
  word selects it (the loop is not saved) instead of turning the loop into a neat ellipse; an empty loop still becomes a
  shape. As designed by G14; turn «دائرة ثم توقّف = تحديد» off in «الإيماءات» to keep the ellipse.
* **Undo of a scribble does not bring the scribble back** (it was a gesture). After R1 the known misfire (shading inside
  an outline) no longer erases; any other misfire still costs the zig-zag itself, never the strokes under it.
* **On a desktop reader with the study rail open the writing bar lies over the zoom group** (`workspace.css`
  `.wk-topbar__center { flex: none }` lets the bar size itself from its own content; seen in the AC-30 desktop screenshot:
  redo over the zoom-out button). Reported by the builder as pre-existing; the previous-tool slot makes the bar one button
  wider. Not fixed here (`workspace.css` is outside `ink/*`); the fix belongs to the reader's top bar (bound the centre
  slot, e.g. `flex: 0 1 auto; min-width: 0`). **Fixed in the R1-b final verification:** the critic pass found the zoom
  group, the page chip and «المزيد من أدوات الكتابة» covered at 1280 px after a few tools had been used and the page
  reloaded. The middle slot now gives way (`flex: 0 1 auto; min-width: 0` — the writing bar folds what does not fit into
  «المزيد»), the title slot keeps `16rem` (back button, page chip, part of the title) and the end slot its content
  (`min-width: max-content`). Test: `e2e/r1b-final-critic.spec.ts` (desktop; 1280 / 1180 / 1024 px, study rail open and
  closed: every top-bar control can be hit at its centre — failed before at 1280 px, rail open).
* Device behaviour (palm, latency, S Pen / Pencil / BOOX) — **Not run (no device)**, as above.


## Parity N1 wave 2 — writing comfort and speed, part 2 (2026-10-21; `docs/research/NOTE_APP_FEATURE_PARITY.md` B.4)

No base migration: every new field is optional JSON inside the existing annotation `data` (ink style, shape data) or a
new part of the `ink` settings object; old rows load and save byte for byte. Old clients draw the new shape kinds
(triangle, polygon, curved / double arrow) as ellipses and a pencil stroke as a pen stroke; an old client that MOVES a
curved / double arrow or a polygon would damage it — since the R1-b final verification the server refuses that edit and
sends its own copy back (review finding R10 below).

### What was built

* **G04 line patterns** — `style.dash: 'dash' | 'dot'` on strokes, shapes and colour slots (a slot can carry its pattern:
  «متقطع = للتحقق»). Dashes are cut by arc length in PAGE units scaled to the width (`ink/pencil.ts` `dashPieces`), so
  the pattern is the same at every zoom and cached with the stroke's paths. Highlighters are never dashed.
* **G06 pencil** — a points-only stroke stored as `style.tool: 'pen'` + `style.texture: 'graphite'` (`InkData` keeps its
  six keys). Pressure changes width AND opacity; the graphite grain is MedLevo's own seeded noise tile (no image from
  anywhere) laid in page units. Own palette slots and feel (`ink.palettes.pencil`, `ink.feel.pencil`).
* **G07 eyedropper** — the browser's `EyeDropper` where it exists; elsewhere the next tap on the page reads the colour
  MedLevo itself drew there (page canvas / picture / ink, highlight canvas composited with multiply). The colour becomes
  the tool's colour and is added to its slots when there is room (synced). The capability panel names the path
  («eyedropper» row: supported / heuristic). Pictures from another origin cannot be read (none exist in MedLevo).
* **G09 zoom writing window** (tool «نافذة الكتابة المكبّرة») — a tap places a box on the page; a docked strip shows it
  magnified (×N shown); strokes written in the strip are mapped into the box and stored in PAGE space, one undo step
  each. Direction: `ink.zoom.direction` auto = right to left unless the page's text is English; a stroke reaching the far
  third of the strip moves the box on by 60 % of its width (LEFT for Arabic), and past the margin it wraps to the start
  of the next line (`zoomGeometry.ts`). Line height, margins, gap, strip size and auto-advance are owner settings
  («المحاذاة والتكبير»). The box and the strip move with the arrow keys.
* **G10 phase 1** — «أفسح مكانًا»: a drag down from a line moves every visible, editable, unlocked engine item whose top
  is below it by the distance dragged (sideways: the rest of THAT written line only, LEFT for Arabic — review fix R1), in
  ONE undo step; never past the page's edge (the room made is what the page has left, and the announcement says so —
  review fix R2); printed text and the reader's highlights never move; items that cross the line stay (counted in the
  announcement). «استقم» (lasso
  menu): each written line is turned about its centre to a level fitted baseline (rotation only; 0.6°–25°).
  **Phase 2 (word reflow)** is offered only when `workspace.handwriting_recognition` is available (else the menu item is
  disabled with the reason): the selection is read by the server's recognition (a derived reading), and the words move
  — whole, translation only — only when the reading has the same number of words as the gaps in the writing; preview
  first, one undo step. Tested only with a fake reader (`reflow.ts` `setReflowReader`, the shape the server's fake
  provider returns).
* **G67 page menu** — a finger held still 550 ms on blank space (pen-only mode or a non-writing tool), a right click, or
  the context-menu key / Shift+F10 on the page in view: «الصق هنا» (disabled with the reason when nothing is copied),
  «نص هنا», «ملاحظة لاصقة هنا», «صفحة ملاحظات بعد هذه الصفحة» (note pages: the reader's own actions; lecture pages: a
  one-prop seam in `WorkspaceScreen.tsx`), the neat copy toggle; on printed text «عرّف» / «أضف إلى المراجعة» appear
  only when a host provides them (`InkHost.pageMenu`, for N3 / N4). The click a lifted long press may fire is swallowed
  (only that one).
* **G20 shapes** — new kinds triangle, polygon (tapped corner by corner; Enter / first corner closes; Escape cancels),
  curved arrow (control point), double arrow; `fill` (a highlighter token, drawn translucent), rounded corners, text
  inside a shape (RichText `label`, bidi-correct DOM text read by screen readers); pathway heads for physiology /
  pharmacology: activation (solid head, «ينشّط»), inhibition (bar ⊣, «يثبّط»), conversion (dashed shaft, «يتحوّل إلى»)
  — always spoken, never a glyph alone. One geometry for web and server PDF export (`shared/annotations.ts`
  `shapeParts` / `shapeOutlineIso`); old shapes give exactly the old outline.
* **G22 snapping** — a moving selection or a shape being drawn snaps (within 8 px) to other items' edges and centres,
  the note paper's grid / ruled lines and the processed source regions of a lecture page; guides are drawn while
  dragging; Alt turns it off; each source can be turned off (`ink.snap`).
* **G08 ruler and measurement** — the ruler (toolbar «المسطرة») is moved by drag or arrows, turned by its handle, two
  fingers, «[ / ]» or 15° buttons (settles on multiples of 15°), shows centimetre marks of the page; a stroke that STARTS
  on its writing edge is projected onto it (time / pressure kept). It is session state, never saved. «قياس تعليمي»:
  calibrate from a scale bar on a picture (or the page), then lengths and angles; every result carries
  «تقدير تعليمي — ليس قياسًا سريريًا»; the scale is remembered per picture on this device (`localGet/localSet`), the
  lines are never ink.
* **G21 connectors** — the «موصِّل» tool draws an arrow from a shape's edge point to another's (`attach.from/to` = id +
  side; the end sits a small gap outside the edge, so a head — the inhibition bar ⊣ above all — is not lost in the
  outline); when an attached shape moves, is resized or turned, its connectors are re-routed INSIDE the same commit
  (`store.commit` → `followConnectors`), so one undo restores both with the attachments. Routes straight / elbow /
  curved; medical relations causes / inhibits / treats / complicates (spoken sentence «Insulin يسبّب GLUT4»); edge dots
  «أضف شكلًا متصلًا من …» (one undo step); «رتّب تلقائيًا» (the study diagrams' flowchart layout, right to left);
  a node can be bound to a Course Brain concept (search `GET /api/brain/concepts`, needs the connection; the id and name
  are stored, the name becomes the label); «تحقّق من العلاقات» reads `GET /api/brain/relations` and says found /
  missing («لا يعني أنها خطأ») / no such kind («يثبّط») — a read, nothing changes.
* **G11 neat copy** — «النسخة المرتبة لهذه الصفحة (عرض فقط)» draws a DERIVED copy (lines straightened, sizes evened
  ±25 % about the line start, stronger smoothing) over the hidden pen canvas, with a banner saying the original ink is
  kept unchanged; nothing is written (unit + e2e check the stored rows byte for byte).

### Tests (all passing)

Server `apps/server/test/annotations/n1-wave2.test.ts` (9: dash / texture round trip incl. ink v2, refusals with Arabic
reasons, new shape fields, shared geometry equals the PDF export's for old shapes, pathway heads, connector attach /
relation / concept round trip, settings defaults and part-by-part PATCH). Web `apps/web/test/ink/`: `n1w2-logic.test.ts`
(22: dashes, pencil, shapes, zoom geometry both directions, insert space / straighten / reflow, neat copy, ruler,
measurement, snapping, connectors, eyedropper, settings), `n1w2-layer.test.tsx` (13: through the real layer and store),
`n1w2-shapes.test.tsx` (6: heads, fill, polygon, labels, concepts and the relation check with a mocked API, the
eyedropper's tap path). E2E `e2e/n1-writing.spec.ts` «N1 wave 2» (2 tests × phone + desktop: pencil + dash saved, filled
rounded shapes, connector attached / following / one undo, zoom window right to left, insert space, reflow reason, page
menu + neat copy unchanged rows, ruler straight stroke, measurement label; full suite 145 passed, see `docs/TEST_LOG.md`).

Bugs found by these tests and fixed before shipping: the dash cutter could loop forever on a float remainder a hair
under the period (it hung the renderer); connector ends and «أفسح مكانًا» used the last pointermove instead of where the
pen lifted; the click left by a long press swallowed the first tap on the page menu; with several pages on screen every
page showed its own measurement panel (now one: the page measured last; found by the e2e run).

### Limits (honest)

* Device behaviour — **Not run (no device)**: the pencil grain and pressure opacity on a real stylus, the zoom window with
  an Apple Pencil / S Pen, the two-finger ruler, long-press timing on iPad / Android, the eyedropper on iPad Safari (tap
  path) — only jsdom and headless Chromium with a mouse here.
* Word reflow was never run against a real recognition provider (none configured here); only the fake reader.
* The PDF export (server) draws the new shapes' outlines and heads with the shared geometry but not fill, dashes, the
  pencil grain or shape labels (`pdf-export.ts` belongs to another track; a 1-line seam routes new shapes to the shared
  geometry).
* Concept search and the relation check need the server (offline: the reason is shown; bound concepts stay).
* The eyedropper's tap path reads only what MedLevo drew (not the screen outside the page).
* Snapping to processed regions uses the regions the reader fetched for the page (`fetchRegions`); a page without
  processing has none.

### Review of N1 wave 2 (2026-10-21, independent adversarial review)

Scope: zoom window coordinates and right-to-left auto-advance, insert space (only the owner's items, one undo),
connectors following moves and surviving undo, snapping performance, measurement never stored and labelled, the neat copy
never changing strokes, pencil / dashes through ink v2 and old clients, e-ink drawing of every new kind, keyboard and
screen-reader paths. Every changed file was read. Found and fixed, each with a regression test that failed before the
fix (`apps/web/test/ink/n1w2-review.test.tsx`, `n1w2-review-neat.test.tsx`):

| # | severity | what was wrong | fix | test |
|---|---|---|---|---|
| R1 | major | «أفسح مكانًا» sideways («between words») moved the writing of EVERY line of the page left (or right) of the press, not only the line pressed — the tool's own help says «يزيح ما بعد النقطة على السطر» | the written line at the press is found (`handwritingLayout.ts` `lineBandAt`: the line's top and bottom with its dots) and only items whose middle lies in it move | «sideways: only the line pressed makes room …» |
| R2 | major | «أفسح مكانًا» pushed writing past the page's bottom (or side) edge, where nothing draws it and no tool (lasso, eraser) can reach it — only an undo while the history lasts could bring it back | the distance is cut to the room the page has left (`insertSpacePlan` → `delta`, `limited`); with no room nothing moves and the announcement says why («بلغت … أسفل الصفحة … لا يُدفع شيء خارج الصفحة») | «down: the writing at the bottom never leaves the page …» |
| R3 | major | Paste / duplicate («تكرار») / «انسخ إلى طبقتي» of a diagram kept each connector attached to the ORIGINAL shapes: moving an original pulled the copy's connector away from the copied shapes onto the original (and the relation check named the originals) | `connectors.ts` `reattachCopy`: a pasted connector is attached to the pasted copies of its shapes; an end whose shape was not copied with it is left free (`store.paste`) | «a duplicated diagram is attached to its own copies …», «a connector copied without its shapes is pasted free …» |
| R4 | major | The zoom window's box lost the strip's proportions when the strip is wider than 12 : 1 (a wide screen with the small strip), when the line is wider than 0.9 of the page (large line height on an iPad in landscape) or when narrow margins cut its width: the strip draws at one scale but mapped the pen per axis, so the ink was saved up to ~20 % away (vertically) from where the pen wrote in the strip | `zoomGeometry.ts` `boxSize` / `lineStartBox` / `boxAt` keep the strip's proportions (a too-wide line is made less tall); the strip maps the pen with the SAME single scale it draws with, inside its border (`zoomWindow.tsx` `toNorm`, measured `clientWidth/Height`); the page picture under it uses that scale too | «the box keeps the strip proportions …», «… inside narrow margins …», «a stroke written in a measured strip is saved where it was drawn there» (1 348 × 152 strip, line height 0.12) |
| R5 | minor | Auto-advance (and «سطر جديد») on the last line of the page «wrapped» onto the same last line, so the next word was written over the line just finished | `advanceBox` returns `end` when no line fits below; the box stays and the owner is told («بلغت النافذة آخر سطر في الصفحة …») | «on the last line of the page the window stops …» |
| R6 | minor (performance) | Drawing a shape rebuilt every snap line of the page (every item's box, sorted) on EVERY pointer move — the module said «collected once» | collected once per shape at its first point (again at most every 200 ms only while the page's processed regions are still loading — `SnapTargets.partial`; the selection drag does the same) | «the snap targets are collected once per shape …» (33 collections for one rectangle before, 1 after) |
| R7 | minor (a11y) | Closing the page menu with Escape / Tab dropped the keyboard focus to the document | the focus goes back to where it was when the menu opened | «closing the page menu with Escape gives the focus back …» |
| R8 | minor (a11y) | A diagram's connections were spoken once, when drawn; afterwards they existed only as canvas paths (labels are DOM text, the arrows were not) | the page summary read by screen readers lists them in words («المخطط: «Insulin» يسبّب «GLUT4»؛ …», up to 20) | «the page summary … says what each connector of a diagram connects» |
| R9 | minor (performance) | The neat copy was derived again (every line regrouped, every point transformed) on every zoom / pinch frame | derived once per change of the page's writing or of the layers shown; a zoom only redraws it | `n1w2-review-neat.test.tsx` (5 derivations for 4 zoom steps before, 1 after) |

Verified and kept (guards added): every new kind (pencil grain, dashes, fill, activation / conversion heads) draws only
greys under e-ink («guard: e-ink …»); a pencil / dotted stroke round-trips through ink v2 on the wire byte for byte
(«guard: a pencil / dashed stroke through ink v2 …»; the server side is `n1-wave2.test.ts`); the measurement and the
ruler write nothing (`n1w2-layer.test.tsx`); the neat copy leaves stored rows byte for byte (unit + e2e); insert space moves
only visible, editable, unlocked engine items in one undo step, and connectors follow in that step.

Open (not fixed here, with the reason):

* **R10 (major — fixed in the R1-b final verification, server side).** An R1-a app (the owner's own un-updated tab: the client gate lets user
  #1's old client keep writing) draws the new shape kinds as ellipses in their frame and, if the owner MOVES one there,
  keeps only that frame: a curved or double arrow comes back normalised from its top-left to its bottom-right corner —
  its direction (and with it a pathway head ⊣ / →) can flip — and its control point stays behind; a polygon's corners do
  not move at all (reproduced by running the R1-a `transformItem` shape branch — `git show d0c8ab4:apps/web/src/features/workspace/ink/model.ts` — on these shapes; review report). Not fixable
  inside the old client. Remedy options, a contract decision for the N1 owner before any row of these kinds exists: store
  the curved / double arrow as `shape: 'arrow'` + `route: 'curve'` + a tail flag (an old client then moves both ends and
  keeps the direction; it draws a straight arrow), and fit a polygon's corners into its frame when they disagree; or a
  server refusal of shape writes without the client-version header. Until then: update every device before drawing these
  shapes (CAPABILITY_MATRIX / release note).
  **Fix (R1-b final verification):** the server answers such an edit with `rejected` and its own copy — the third
  option above, chosen because it needs no change to the stored representation and protects rows that already exist.
  `POST /api/sync/push` marks a request without a supported `x-medlevo-client` (an R1-a app; only user #1 passes the
  client gate) and `annotations/sync.ts` refuses, from such a client, an upsert that changes the geometry (`shape`,
  `from`, `to`, `points`, `control`, `rotation`) of a polygon, curved arrow or double arrow — including a stale edit
  that would otherwise become a damaged conflict copy. The R1-a app files the answer as a conflict and applies the
  server's copy, so the shape is put back as stored; the Arabic detail tells the owner to update that device.
  Deleting such a shape, restoring it unchanged, recolouring it and moving any shape R1-a knows (line, arrow, rect,
  ellipse, triangle) still go through. Test: `apps/server/test/annotations/r1b-old-client-shapes.test.ts` (6; the
  three kinds and the stale case failed before the fix). Remaining: on the R1-a app itself the shapes are still drawn
  as ellipses until it updates.
* Shift-constrained shapes (AOS-1.7) were not built; the ruler turns with «[ / ]» (Shift 10°) and the 15° buttons — the
  arrows move it (AOS-1.8 names arrows 1°, Shift 15°).
* The connector relation check, concept search and word reflow need the server (and reflow a recognition provider:
  never run with a real one here).
* Device behaviour (stylus in the zoom strip, two-finger ruler, long-press timing, pencil grain on e-ink panels) —
  **Not run (no device)**.

### Release R1-b final verification — writing screens (2026-10-21)

The release critic pass (390 and 1280 px; light, dark and e-ink; screenshots outside the repository) found four
defects in the N1 screens, each fixed with a test that failed first:

| finding | fix | test |
|---|---|---|
| «التقط لونًا من الصفحة» (G07) showed its pipette icon on a line of its own (the link style is not a flex row) | `.ml-ink-eyedropper` is a centred inline flex row | `web:test/ink/ink-css.critic` «every .ml-ink-linkbtn that starts with an icon…» |
| Dark theme: a shape's label (G20) inherited the theme's light text colour on the white PDF page — contrast 1.2:1, invisible | `.ml-ink-shape-label { color: var(--ml-ink-c-ink-black) }`: the paper tone's ink colour, like a text box (greys in e-ink) | `web:test/ink/ink-css.critic` «a shape label is drawn in an ink colour…»; critic contrast probe clean in dark |
| Phone: the colour-meaning fields of «إعدادات الكتابة» and every writing slider (width, pen feel, alignment / zoom) were 40 px tall | 44 px under `(pointer: coarse)` | `web:test/ink/ink-css.critic` «on a coarse pointer…» |
| Desktop / iPad landscape: the top bar let the writing bar cover the zoom group and «المزيد» (above) | `workspace.css` top-bar slots | `e2e/r1b-final-critic.spec.ts` |

R10 (old-client edits of the new shape kinds) was closed in the same verification on the server (above).

