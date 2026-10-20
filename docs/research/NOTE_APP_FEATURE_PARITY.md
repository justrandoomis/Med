# Note-taking feature parity — MedLevo AI vs a public notes-app feature inventory

> Research note for the owner. Written 2026-10-20 from the code in this repository and a public feature inventory of
> one widely used notes app (GoodNotes). It compares capabilities only; it is not a plan to reproduce that product.

> **Update 2026-10-20 (after this report was written):** the owner's newer spec
> `docs/spec/Academic_OS_Master_Prompt_AR.md` supersedes the original single-owner rule (§02). Entries marked
> **out of scope** here because of sharing, collaboration, classes or a marketplace are now **in scope** and are
> planned by the Academic OS design (`docs/academic-os/`, ADR-0003…0006), not by tracks N1–N5 below. Rule 3 of
> «B.2 Definition of done» («Single owner») is replaced there by «private by default, shared only by explicit
> scope». Native iPad / Android (Samsung S Pen, BOOX e-ink) ink surfaces move from **blocked** to **planned**
> (owner clarifications at the top of that spec); they still need real devices to verify.

## 1. Clean-room statement

* **Public sources only.** The inventory was built from the vendor's public help-centre articles, blog posts, pricing
  and store listings, and from public reviews and feedback boards (the URLs are kept in the inventory that drove this
  report). No application binaries were downloaded, decompiled or inspected, no network traffic was captured, and no
  account was used.
* **Nothing copied.** No code, assets, icons, templates, stickers, fonts, screenshots, UI layouts or text from that
  product are copied into MedLevo. Feature descriptions here are paraphrased in neutral words; every plan below is
  MedLevo's own design on its own data model (`AnnotationDTO`, `RichText`, evidence ids, FSRS review events).
* **No affiliation.** MedLevo AI is not affiliated with, endorsed by or connected to the vendor of that app. The
  product name appears only to identify the reference inventory (nominative use); it is never used in MedLevo's UI,
  assets or marketing. This follows spec §01: «استلهم جودة التنظيم والتدوين … دون نسخ واجهة أو محتوى أو ادعاء الانتماء».
* **Assets MedLevo would add are original or the owner's own.** Stamps, templates and element collections proposed
  below are drawn for MedLevo or made by the owner from their own files; none are bundled third-party packs.

## 2. Method and legend

Every one of the **347 inventory entries** (four research passes; several features appear more than once under
slightly different names and are judged consistently) was checked against the code, the module notes
(`docs/modules/{ink,workspace,core-web,learning,learning-web,cases-media,data}.md`), `docs/ARCHITECTURE.md`,
`docs/REQUIREMENTS_MATRIX.md`, `docs/CAPABILITY_MATRIX.md` and spec §01, §02, §05, §24–§29, §43, §46, §47.

| status | meaning |
|---|---|
| **have** | MedLevo has it, equal or better for its purpose (notes say where it is better or where a minor sub-part differs) |
| **partial** | part exists in code; the gap is named and planned |
| **missing** | nothing usable exists; planned |
| **out of scope** | excluded by the spec (reason cited: §01 personal medical study, §02 single owner — no sharing, classes, plans or market, §22 calm surface, §49 no unnecessary external services) |
| **blocked** | code may exist, but it needs something not available here: a native iPad layer / real stylus, or a provider key (vision, speech-to-text, embeddings, ANTHROPIC_API_KEY) |

*Tier* is the reference app's plan tier as reported by the inventory (`free` / `paid` / `both` / `unknown`). MedLevo has
no tiers (§02).

**Path legend:** `ink/` = `apps/web/src/features/workspace/ink/` · `ws/` = `apps/web/src/features/workspace/` ·
`web/` = `apps/web/src/` · `srv/` = `apps/server/src/modules/` · `shared/` = `packages/shared/src/` · `CAPABILITY_MATRIX.md`
= `docs/CAPABILITY_MATRIX.md`. **Effort:** S ≈ ≤ 2 days in one module · M ≈ a week across web + server + tests · L ≈ several
weeks / a new subsystem. **Priority:** P1 = biggest gain for medical study, P2 = notebook parity, P3 = comfort / later.

## 3. Summary

| status | entries |
|---|---|
| have | 68 |
| partial | 113 |
| missing | 71 |
| out of scope | 68 |
| blocked | 27 |
| **total** | **347** |

Per area:

| area | have | partial | missing | out of scope | blocked | total |
|---|---|---|---|---|---|---|
| pens & ink | 7 | 11 | 19 | 0 | 3 | 40 |
| eraser | 1 | 3 | 5 | 0 | 0 | 9 |
| lasso | 5 | 4 | 4 | 0 | 0 | 13 |
| shapes | 4 | 5 | 6 | 0 | 0 | 15 |
| tape | 0 | 0 | 1 | 0 | 0 | 1 |
| text | 2 | 6 | 3 | 0 | 1 | 12 |
| elements/stickers | 1 | 0 | 4 | 3 | 0 | 8 |
| images | 0 | 6 | 1 | 1 | 0 | 8 |
| paper templates | 1 | 7 | 3 | 1 | 0 | 12 |
| notebooks & covers | 3 | 7 | 7 | 2 | 0 | 19 |
| folders/library | 6 | 5 | 1 | 0 | 2 | 14 |
| outline & links | 4 | 8 | 1 | 0 | 0 | 13 |
| search & handwriting OCR | 0 | 3 | 0 | 3 | 5 | 11 |
| AI features | 1 | 5 | 9 | 13 | 9 | 37 |
| audio recording | 4 | 5 | 3 | 2 | 5 | 19 |
| meetings | 0 | 0 | 0 | 3 | 1 | 4 |
| presentation/laser | 2 | 3 | 0 | 0 | 0 | 5 |
| PDF annotation & import | 3 | 4 | 2 | 5 | 0 | 14 |
| export & sharing | 0 | 5 | 1 | 0 | 0 | 6 |
| sync & backup | 8 | 3 | 0 | 0 | 0 | 11 |
| security | 1 | 5 | 0 | 3 | 0 | 9 |
| collaboration | 0 | 2 | 0 | 11 | 0 | 13 |
| study tools (flashcards) | 3 | 9 | 1 | 0 | 0 | 13 |
| education | 0 | 0 | 0 | 8 | 0 | 8 |
| integrations | 0 | 1 | 0 | 2 | 1 | 4 |
| platforms | 5 | 3 | 0 | 9 | 0 | 17 |
| marketplace | 0 | 0 | 0 | 1 | 0 | 1 |
| UI/customization | 3 | 2 | 0 | 0 | 0 | 5 |
| accessibility | 4 | 1 | 0 | 1 | 0 | 6 |

Of the 279 in-scope entries, 68 are already covered, 113 are partial,
71 are missing and 27 wait for a device or provider. The partial and missing entries
collapse into **71 distinct gaps** (§6), because the inventory lists many features several times.

### Where MedLevo is already ahead

* Every annotation is anchored in normalized, unrotated page space (AC-21) and PDF-text highlights keep their quote and region ids — they survive zoom, rotation, another device and a new source version (§25).
* Imports are processed, not just displayed: pages, regions and Arabic + English OCR, so scanned lectures are searchable and citable; the reference app does not OCR imported PDFs.
* Flashcards use a documented FSRS schedule derived from immutable review events, identical offline and on the server, with Anki-compatible export and change-impact flags when a source changes (§43).
* Local-first writing with an outbox, keep-both conflict handling, a Download Manager and verified restores (§47, AC-23/24/30).
* Audio: strokes carry editable time links to in-app recordings, recordings survive crashes and refusals, transcripts can be imported, corrected and searched (§29).
* Arabic-first right-to-left UI with bidi-correct medical terms; the reference app has open requests for RTL handwriting search and auto-advance.
* The study layer the reference app does not have: Question Vault from the owner's own past papers, Exam DNA, Weakness Center, clinical cases / OSCE, Course Brain, evidence-checked AI with Source Lock (AI paths need a key).

### Where it is behind (highest-value gaps)

* **G18 Lasso → card / question / element / screenshot** (M) — Cards keep the page, region and evidence ids, so «افتح المصدر» lands on the exact place; handwritten answers on the back are reviewed with FSRS — spaced review of the owner's own handwriting.
* **G24 Cover-and-reveal tape for active recall** (M) — Every tape is a recall item: revealing asks Again/Hard/Good/Easy and records a `review_event` on a page-anchored card, so taped answers on lecture pages join the FSRS schedule; «امتحن نفسك» re-covers all tapes.
* **G56 PDF export with ink (flattened / editable)** (L) — A «revision pack»: chosen lecture pages + my ink + linked cards/questions + a citation index; an «exam-clean» variant without the answers layer and with tapes covered.
* **G32 Custom and clinical page templates** (L) — Clinical templates: SOAP note, history taking (HPI / PMH / DH / FH / SH / ROS), OSCE station checklist (linked to the cases module checklist), drug card (class, mechanism, indications, contraindications, ADRs, dose), lab-values sheet, ECG grid. Handwriting inside a field is searchable by field («كل حقول موانع الاستعمال»).
* **G23 Owner layers (show / hide / lock / active layer)** (L) — Anatomy tracing layers: trace bones, muscles, nerves and vessels on separate layers over an atlas figure, hide one to self-test; an «إجابات» layer is hidden automatically in «امتحن نفسك» mode (`ws/modes/arrangement.ts`).
* **G45 Search typed page items and note-page titles** (M) — Synonym and abbreviation expansion from the Terms dictionary (MI ↔ myocardial infarction ↔ احتشاء العضلة القلبية); handwriting search across all lectures once recognition is configured, grouped by lecture and concept.
* **G61 Flashcards with handwritten faces** (L) — Draw-from-memory cards (e.g. draw the brachial plexus) graded by comparing with the source figure side by side; the recognised text keeps them searchable.
* **G38 Page management: duplicate, rotate, multi-select, move to another notebook** (M) — «نسخة فارغة للاختبار»: duplicate a page keeping template and printed content but dropping the answers layer, to redo a drawing from memory.
* **G37 Quick note (one tap, file later)** (M) — Ward-round / clinic quick note opening on a SOAP template with a «no patient identifiers» reminder, and topic suggestions from Course Brain to file it.
* **G25 Rich formatting in text boxes and notes** (M) — Chemical and lab notation typed correctly inside Arabic lines (CO₂, HCO₃⁻, 10⁹/L) with the existing bidi isolation; term runs link to the Terms dictionary.
* **G16 Image crop and cut a region from a page** (M) — A cut region stays a citable excerpt: it can become an image-occlusion card, an «اشرح الصورة» request or a figure reading with the exact source link (AC-08 rules for uncertain labels).

## 4. Feature-by-feature tables

### pens & ink

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Pen tool with three nib styles | both | **partial** | Three nibs exist (`ink/math.ts` curves); tip sharpness, pressure floor and smoothing are not adjustable. | **G01** Pen feel tuning (stabilisation, taper, pressure floor) — effort S, P3 (see [G01](#g01)) |
| Pencil tool | unknown | **missing** | `INK_TOOLS` = pen, fountain, ball, highlighter (`shared/annotations.ts`); no textured nib. | **G06** Pencil nib with graphite texture — effort M, P2 (see [G06](#g06)) |
| Highlighter | both | **have** | `ink/InkLayer.tsx` (separate highlight canvas, multiply/screen blend), `ink/palette.ts` `HIGHLIGHTER_COLORS`, `ws/selection/SelectionToolbar.tsx` (`text_highlight` / underline) | Better for study: besides freehand highlighter, PDF-text highlights snap to the text and store the quote + region ids, so they survive re-anchoring and stay legible in dark mode. |
| Custom colors and color picker | both | **partial** | 6 pen + 5 highlighter tokens and one custom `#rrggbb` (`ink/palette.ts`, `ink/InkToolbar.tsx`); one preset per tool kept in `localStorage` only (`ink/prefs.ts`). | **G03** Per-tool colour slots, synced presets and a meaning legend — effort M, P2 (see [G03](#g03)) |
| Stroke stabilization and low-latency ink | both | **partial** | Low-latency path exists (predicted + coalesced events, `desynchronized` canvas — never measured on a device); smoothing is fixed. | **G01** Pen feel tuning (stabilisation, taper, pressure floor) — effort S, P3 (see [G01](#g01)) |
| Handwriting sensitivity and palm rejection | both | **partial** | Web heuristic in `ink/input.ts` (pen-only mode, contact > 44 px = palm, 400 ms after pen lift, second pointer cancels); system palm rejection needs native (CAPABILITY_MATRIX). | **G02** Palm-rejection settings — effort S, P3 (see [G02](#g02)) |
| Stylus hardware integrations | both | **blocked** | `CAPABILITY_MATRIX.md` (double tap, squeeze, Scribble on canvas, PencilKit latency: «Not available on web (requires native)»); hover + eraser button implemented in `ink/input.ts`, untested on a device | Needs a native iPad layer (UIKit/PencilKit) or a real stylus to verify; §27 forbids claiming it from simulated input. |
| Shape recognition and hold-to-straighten | both | **have** | `ink/shapes.ts`, `ink/layerController.ts` (`HOLD_MS = 600`), `ShapeData.recognized_from` in `shared/annotations.ts`, lasso «إلغاء تحسين الشكل» | Hold-to-shape for line, arrow, rectangle (incl. rotated) and ellipse; the original stroke is kept and the enhancement can be undone (§28). |
| Smart Ink handwriting editing (reflow, straighten, align, insert space) | both | **missing** | No ink layout tools; recognition lines exist only as a derived reading (`srv/annotations/recognition.ts`). | **G10** Handwriting editing: insert space, straighten, reflow — effort L, P3 (see [G10](#g10)) |
| Restyle handwriting | free | **missing** | Ink is always rendered as written (`ink/render.ts`); §28 requires the original ink to be kept. | **G11** Neat-copy view of handwriting — effort L, P3 (see [G11](#g11)) |
| Handwriting word autocomplete (experimental) | unknown | **missing** | No completion in text boxes / notes (`ink/InkLayer.tsx`, `ws/panels/MineTab.tsx`). | **G12** Medical-term completion while typing — effort S, P3 (see [G12](#g12)) |
| Pen tool with three pen styles | both | **have** | `ink/types.ts` (`pen`·`fountain`·`ball` tools), `ink/math.ts` (per-nib pressure curves), `ink/InkToolbar.tsx` (thickness + `<input type="color">` custom `#rrggbb`), `CAPABILITY_MATRIX.md` | Three nibs: pressure pen, strongly pressure-sensitive fountain, near-constant ballpoint; pressure is recorded only when the device really reports it (`pressure_available`). |
| Stroke presets: line pattern and thickness | both | **partial** | Thickness presets thin/medium/thick in `ink/SelectionOverlay.tsx`; `InkStyle` has no dash field (`shared/annotations.ts`). | **G04** Dashed / dotted stroke styles — effort S, P3 (see [G04](#g04)) |
| Ink response tuning | both | **partial** | Nibs and curves are fixed: `ink/math.ts` `smoothPoints(points, radius = 2)`, pressure curves per nib; predicted + coalesced events and a `desynchronized` live canvas exist (`ink/layerController.ts`). | **G01** Pen feel tuning (stabilisation, taper, pressure floor) — effort S, P3 (see [G01](#g01)) |
| Pencil tool (graphite texture) | both | **missing** | `INK_TOOLS` = pen, fountain, ball, highlighter (`shared/annotations.ts`); no textured nib. | **G06** Pencil nib with graphite texture — effort M, P2 (see [G06](#g06)) |
| Highlighter tool | both | **have** | `ink/InkLayer.tsx` (separate highlight canvas, multiply/screen blend), `ink/palette.ts` `HIGHLIGHTER_COLORS`, `ws/selection/SelectionToolbar.tsx` (`text_highlight` / underline) | Better for study: besides freehand highlighter, PDF-text highlights snap to the text and store the quote + region ids, so they survive re-anchoring and stay legible in dark mode. |
| Typed-text highlighting | both | **missing** | `RichText` marks are `b i u sup sub em` only (`shared/richtext.ts`); text boxes are plain `<textarea>` (`ink/InkLayer.tsx`). | **G05** Highlight inside typed text — effort S, P3 (see [G05](#g05)) |
| Per-tool color presets with custom colors | both | **partial** | 6 pen + 5 highlighter tokens and one custom `#rrggbb` (`ink/palette.ts`, `ink/InkToolbar.tsx`); one preset per tool kept in `localStorage` only (`ink/prefs.ts`). | **G03** Per-tool colour slots, synced presets and a meaning legend — effort M, P2 (see [G03](#g03)) |
| Eyedropper color picker | both | **missing** | No sampler in `ink/InkToolbar.tsx`. | **G07** Eyedropper colour picker — effort S, P3 (see [G07](#g07)) |
| Ruler tool | both | **missing** | `InkToolId` has no ruler (`ink/types.ts`). | **G08** Ruler and measuring guide — effort M, P2 (see [G08](#g08)) |
| Zoom Window with auto-advance | both | **missing** | No magnified writing strip; the ink engine already stores points in zoom-independent page space (`ink/math.ts`, AC-21). | **G09** Zoom writing window with auto-advance — effort M, P2 (see [G09](#g09)) |
| Advanced stylus hardware integration | both | **blocked** | `CAPABILITY_MATRIX.md` (double tap, squeeze, Scribble on canvas, PencilKit latency: «Not available on web (requires native)»); hover + eraser button implemented in `ink/input.ts`, untested on a device | Needs a native iPad layer (UIKit/PencilKit) or a real stylus to verify; §27 forbids claiming it from simulated input. |
| Palm rejection settings | both | **partial** | Web heuristic in `ink/input.ts` (pen-only mode, contact > 44 px = palm, 400 ms after pen lift, second pointer cancels); system palm rejection needs native (CAPABILITY_MATRIX). | **G02** Palm-rejection settings — effort S, P3 (see [G02](#g02)) |
| Mouse/trackpad annotation and stylus disconnect | both | **have** | `ink/input.ts` (pen-only mode, mouse writes, finger writing with palm heuristic), `CAPABILITY_MATRIX.md` | Mouse, trackpad, pen tablet and finger input; pen-only toggle (pen tablets implemented but not tested on a device). |
| Multi-finger undo/redo gestures | both | **missing** | Only hold-to-shape exists (`ink/layerController.ts` `HOLD_MS`); undo/redo via buttons and Ctrl/⌘ Z (`ink/InkProvider.tsx`). | **G14** Ink gestures: scribble-to-erase, circle-to-select, multi-finger undo — effort M, P2 (see [G14](#g14)) |
| Handwriting spellcheck in your own handwriting | both | **missing** | No spellcheck; recognised text and owner corrections are stored in `ink_recognition` (`srv/annotations/recognition.ts`). | **G13** Medical spellcheck for notes and recognised handwriting — effort M, P3 (see [G13](#g13)) |
| Edit Handwriting / handwriting reflow | both | **missing** | No ink layout tools; recognition lines exist only as a derived reading (`srv/annotations/recognition.ts`). | **G10** Handwriting editing: insert space, straighten, reflow — effort L, P3 (see [G10](#g10)) |
| Restyle handwriting (Smart Ink) | unknown | **missing** | Ink is always rendered as written (`ink/render.ts`); §28 requires the original ink to be kept. | **G11** Neat-copy view of handwriting — effort L, P3 (see [G11](#g11)) |
| Apple Scribble in text fields | both | **blocked** | `CAPABILITY_MATRIX.md` row «Scribble»; no speech-to-text provider (`docs/ARCHITECTURE.md` §1) | Scribble on the canvas needs native code; dictation needs a speech-to-text provider. iPadOS Scribble in ordinary text fields is a system feature, untested here. |
| Customizable pens | both | **have** | `ink/types.ts` (`pen`·`fountain`·`ball` tools), `ink/math.ts` (per-nib pressure curves), `ink/InkToolbar.tsx` (thickness + `<input type="color">` custom `#rrggbb`), `CAPABILITY_MATRIX.md` | Three nibs: pressure pen, strongly pressure-sensitive fountain, near-constant ballpoint; pressure is recorded only when the device really reports it (`pressure_available`). |
| Highlighter tool | both | **partial** | Freehand + PDF-text highlighter exist; highlighting typed text in text boxes does not. | **G05** Highlight inside typed text — effort S, P3 (see [G05](#g05)) |
| Stroke stabilization and smoothing | both | **partial** | Nibs and curves are fixed: `ink/math.ts` `smoothPoints(points, radius = 2)`, pressure curves per nib; predicted + coalesced events and a `desynchronized` live canvas exist (`ink/layerController.ts`). | **G01** Pen feel tuning (stabilisation, taper, pressure floor) — effort S, P3 (see [G01](#g01)) |
| Low-latency inking and pen ergonomics | both | **partial** | Predicted events + `desynchronized` canvas and finger zoom while the pen writes exist; Pencil Pro squeeze needs native (blocked). | **G01** Pen feel tuning (stabilisation, taper, pressure floor) — effort S, P3 (see [G01](#g01)) |
| Ink gestures | both | **missing** | Only hold-to-shape exists (`ink/layerController.ts` `HOLD_MS`); undo/redo via buttons and Ctrl/⌘ Z (`ink/InkProvider.tsx`). | **G14** Ink gestures: scribble-to-erase, circle-to-select, multi-finger undo — effort M, P2 (see [G14](#g14)) |
| Handwriting spellcheck and suggestions | both | **missing** | No spellcheck; recognised text and owner corrections are stored in `ink_recognition` (`srv/annotations/recognition.ts`). | **G13** Medical spellcheck for notes and recognised handwriting — effort M, P3 (see [G13](#g13)) |
| Handwriting word completion/prediction | both | **missing** | No completion in text boxes / notes (`ink/InkLayer.tsx`, `ws/panels/MineTab.tsx`). | **G12** Medical-term completion while typing — effort S, P3 (see [G12](#g12)) |
| Restyle (handwriting beautification) | free | **missing** | Ink is always rendered as written (`ink/render.ts`); §28 requires the original ink to be kept. | **G11** Neat-copy view of handwriting — effort L, P3 (see [G11](#g11)) |
| Smart Ink handwriting editing (reflow, straighten, space) | both | **missing** | No ink layout tools; recognition lines exist only as a derived reading (`srv/annotations/recognition.ts`). | **G10** Handwriting editing: insert space, straighten, reflow — effort L, P3 (see [G10](#g10)) |
| Zoom/magnified writing area | unknown | **missing** | No magnified writing strip; the ink engine already stores points in zoom-independent page space (`ink/math.ts`, AC-21). | **G09** Zoom writing window with auto-advance — effort M, P2 (see [G09](#g09)) |
| Stylus-only drawing vs finger-input modes | both | **have** | `ink/input.ts` (pen-only mode, mouse writes, finger writing with palm heuristic), `CAPABILITY_MATRIX.md` | Mouse, trackpad, pen tablet and finger input; pen-only toggle (pen tablets implemented but not tested on a device). |

### eraser

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Eraser with scribble-to-erase gesture | both | **partial** | Stroke + point erasers and the pen eraser end exist (`ink/eraser.ts`); no scribble gesture. | **G14** Ink gestures: scribble-to-erase, circle-to-select, multi-finger undo — effort M, P2 (see [G14](#g14)) |
| Selective / precision eraser | both | **partial** | Precision (point) eraser exists; no content-type filter. | **G15** Selective eraser, clear page and delete by type — effort M, P2 (see [G15](#g15)) |
| Bulk delete by content type | unknown | **missing** | Point and stroke erasers act on all strokes and shapes (`ink/eraser.ts`, `ink/layerController.ts`); no type filter, no clear-page action. | **G15** Selective eraser, clear page and delete by type — effort M, P2 (see [G15](#g15)) |
| Three eraser modes | both | **have** | `ink/eraser.ts` (point eraser splits strokes and keeps exact cut points; stroke eraser), pen eraser end in `ink/input.ts` | Point (precision) and whole-stroke erasers plus the pen's eraser end; a separate segment-to-intersection mode is not built. |
| Erase filter by stroke type | both | **missing** | Point and stroke erasers act on all strokes and shapes (`ink/eraser.ts`, `ink/layerController.ts`); no type filter, no clear-page action. | **G15** Selective eraser, clear page and delete by type — effort M, P2 (see [G15](#g15)) |
| Clear page and auto-deselect | both | **missing** | Point and stroke erasers act on all strokes and shapes (`ink/eraser.ts`, `ink/layerController.ts`); no type filter, no clear-page action. | **G15** Selective eraser, clear page and delete by type — effort M, P2 (see [G15](#g15)) |
| Scribble-to-erase pen gesture | both | **missing** | Only hold-to-shape exists (`ink/layerController.ts` `HOLD_MS`); undo/redo via buttons and Ctrl/⌘ Z (`ink/InkProvider.tsx`). | **G14** Ink gestures: scribble-to-erase, circle-to-select, multi-finger undo — effort M, P2 (see [G14](#g14)) |
| Eraser with Selective Eraser mode | both | **partial** | Eraser is on the toolbar with two modes; no selective (by type) mode. | **G15** Selective eraser, clear page and delete by type — effort M, P2 (see [G15](#g15)) |
| Clear Page / Delete Specific Items | both | **missing** | Point and stroke erasers act on all strokes and shapes (`ink/eraser.ts`, `ink/layerController.ts`); no type filter, no clear-page action. | **G15** Selective eraser, clear page and delete by type — effort M, P2 (see [G15](#g15)) |

### lasso

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Lasso selection and editing | both | **have** | `ink/SelectionOverlay.tsx`, `ink/store.ts` (move, uniform resize, rotate with 15° snap, recolour, width, duplicate, copy/paste, front/back, lock, delete), `ink/selectionActions.tsx` | Freehand loop or tap selection with an in-place action bar and menu. |
| Contextual object menu | both | **have** | `ink/SelectionOverlay.tsx`, `ink/store.ts` (move, uniform resize, rotate with 15° snap, recolour, width, duplicate, copy/paste, front/back, lock, delete), `ink/selectionActions.tsx` | In-place selection bar + «المزيد» menu (`ink/SelectionOverlay.tsx`). |
| Image crop / cut-out | both | **missing** | Images insert with aspect-kept resize but no crop (`ink/images.ts`, `docs/modules/ink.md` F1 limits); no region screenshot. | **G16** Image crop and cut a region from a page — effort M, P1 (see [G16](#g16)) |
| Lasso selection with type filter | both | **partial** | Freehand loop + tap with fixed membership rules (`ink/store.ts`, `test/ink/lasso.test.ts`). | **G17** Lasso type filter and rectangle mode — effort S, P3 (see [G17](#g17)) |
| Universal object menu actions | both | **partial** | Lasso menu has copy, order, lock, recognise, ask (`ink/SelectionOverlay.tsx`); card / question from a lasso is Not Started (§28 row in `docs/REQUIREMENTS_MATRIX.md`). | **G18** Lasso → card / question / element / screenshot — effort M, P1 (see [G18](#g18)) |
| Smart alignment guides | both | **missing** | Only rotation snaps (15°) in `ink/SelectionOverlay.tsx`. | **G22** Snapping and alignment guides — effort M, P2 (see [G22](#g22)) |
| Circle-to-lasso pen gesture | both | **missing** | Only hold-to-shape exists (`ink/layerController.ts` `HOLD_MS`); undo/redo via buttons and Ctrl/⌘ Z (`ink/InkProvider.tsx`). | **G14** Ink gestures: scribble-to-erase, circle-to-select, multi-finger undo — effort M, P2 (see [G14](#g14)) |
| Region screenshot | both | **missing** | Images insert with aspect-kept resize but no crop (`ink/images.ts`, `docs/modules/ink.md` F1 limits); no region screenshot. | **G16** Image crop and cut a region from a page — effort M, P1 (see [G16](#g16)) |
| Move/copy content across pages and documents | both | **have** | `ink/store.ts` (module-level clipboard, paste onto any page with new ids, one undo step), shortcuts Ctrl/⌘ C/V/D in `ink/InkProvider.tsx` | Copy/paste across pages and open documents (including the writable split pane). |
| Object scaling/resizing/rotation model and quick selection | both | **partial** | Uniform resize only; text boxes and pictures move their centre when rotated (`docs/modules/ink.md` limits); no keyboard nudge (ink review «still open»). | **G19** Free resize, rotation for text/images, keyboard nudge — effort M, P2 (see [G19](#g19)) |
| Lock objects | both | **have** | `AnnotationDTO.locked` (`shared/annotations.ts`), SelectionOverlay «قفل» / «فك القفل», `ink/eraser.ts` skips locked items | Locked items cannot be moved or erased. |
| Layers | paid | **partial** | Items carry `layer` (ink / highlight / text / media) and `z` (`shared/annotations.ts`); highlights draw on their own canvas; no owner-managed layers. | **G23** Owner layers (show / hide / lock / active layer) — effort L, P1 (see [G23](#g23)) |
| Lasso selection and object menu | both | **have** | `ink/SelectionOverlay.tsx`, `ink/store.ts` (move, uniform resize, rotate with 15° snap, recolour, width, duplicate, copy/paste, front/back, lock, delete), `ink/selectionActions.tsx` | Freehand loop or tap selection with an in-place action bar and menu. |

### shapes

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Shapes tool | both | **partial** | `ShapeData.shape` = line \| arrow \| rect \| ellipse with colour/width/rotation (`shared/annotations.ts`); no fill, labels or rounded corners. | **G20** Shape fill, corners, labels and more shapes — effort M, P2 (see [G20](#g20)) |
| Connectors and quick diagramming | unknown | **missing** | Owner shapes have no anchors; generated flowcharts/timelines exist only as AI artifacts (`srv/studybook/diagrams.ts`, `web/features/studybook/diagrams/layout.ts`). | **G21** Connectors and quick diagramming — effort L, P2 (see [G21](#g21)) |
| Object snapping and alignment guides | unknown | **missing** | Only rotation snaps (15°) in `ink/SelectionOverlay.tsx`. | **G22** Snapping and alignment guides — effort M, P2 (see [G22](#g22)) |
| Object locking | unknown | **have** | `AnnotationDTO.locked` (`shared/annotations.ts`), SelectionOverlay «قفل» / «فك القفل», `ink/eraser.ts` skips locked items | Locked items cannot be moved or erased. |
| Layers | paid | **partial** | Items carry `layer` (ink / highlight / text / media) and `z` (`shared/annotations.ts`); highlights draw on their own canvas; no owner-managed layers. | **G23** Owner layers (show / hide / lock / active layer) — effort L, P1 (see [G23](#g23)) |
| Ruler | both | **missing** | `InkToolId` has no ruler (`ink/types.ts`). | **G08** Ruler and measuring guide — effort M, P2 (see [G08](#g08)) |
| Shape tool with automatic cleanup | both | **have** | `ink/shapes.ts`, `ink/layerController.ts` (`HOLD_MS = 600`), `ShapeData.recognized_from` in `shared/annotations.ts`, lasso «إلغاء تحسين الشكل» | Hold-to-shape for line, arrow, rectangle (incl. rotated) and ellipse; the original stroke is kept and the enhancement can be undone (§28). |
| Draw-and-hold shape recognition | both | **have** | `ink/shapes.ts`, `ink/layerController.ts` (`HOLD_MS = 600`), `ShapeData.recognized_from` in `shared/annotations.ts`, lasso «إلغاء تحسين الشكل» | Hold-to-shape for line, arrow, rectangle (incl. rotated) and ellipse; the original stroke is kept and the enhancement can be undone (§28). |
| Shape styling | both | **partial** | `ShapeData.shape` = line \| arrow \| rect \| ellipse with colour/width/rotation (`shared/annotations.ts`); no fill, labels or rounded corners. | **G20** Shape fill, corners, labels and more shapes — effort M, P2 (see [G20](#g20)) |
| Diagramming: connectors, quick diagram, text in shapes | both | **missing** | Owner shapes have no anchors; generated flowcharts/timelines exist only as AI artifacts (`srv/studybook/diagrams.ts`, `web/features/studybook/diagrams/layout.ts`). | **G21** Connectors and quick diagramming — effort L, P2 (see [G21](#g21)) |
| Shapes tool and automatic shape recognition | both | **partial** | Recognition exists (`ink/shapes.ts`); labelled / fill-only / rounded shapes do not. | **G20** Shape fill, corners, labels and more shapes — effort M, P2 (see [G20](#g20)) |
| Smart connectors and Quick Diagramming | both | **missing** | Owner shapes have no anchors; generated flowcharts/timelines exist only as AI artifacts (`srv/studybook/diagrams.ts`, `web/features/studybook/diagrams/layout.ts`). | **G21** Connectors and quick diagramming — effort L, P2 (see [G21](#g21)) |
| Snapping, alignment guides, smart spacing | both | **missing** | Only rotation snaps (15°) in `ink/SelectionOverlay.tsx`. | **G22** Snapping and alignment guides — effort M, P2 (see [G22](#g22)) |
| Object transform, arrange and lock | both | **have** | `ink/SelectionOverlay.tsx` (rotate handle, «إحضار إلى الأمام» / «إرسال إلى الخلف», «تكرار», «قفل»), `ink/history.ts` | Rotate, order, duplicate and lock, all undoable (200 steps). |
| Layers | paid | **partial** | Items carry `layer` (ink / highlight / text / media) and `z` (`shared/annotations.ts`); highlights draw on their own canvas; no owner-managed layers. | **G23** Owner layers (show / hide / lock / active layer) — effort L, P1 (see [G23](#g23)) |

### tape

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Tape tool for active recall | both | **missing** | No tape tool (`ink/types.ts`); image occlusion exists for cards (`srv/learning/cards.ts`, `web/features/review/local/occlusion.ts`). | **G24** Cover-and-reveal tape for active recall — effort M, P1 (see [G24](#g24)) |

### text

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Text boxes with rich formatting | both | **partial** | `RichText` supports bold/italic/underline/sup/sub, headings, lists, quotes and term/unit/formula runs (`shared/richtext.ts`), but the editors are plain `<textarea>`s converted by `richTextFromPlain` (`ink/InkLayer.tsx`, `ws/panels/MineTab.tsx`). | **G25** Rich formatting in text boxes and notes — effort M, P1 (see [G25](#g25)) |
| Sticky notes | both | **have** | `StickyData` (`color`, `collapsed`) in `shared/annotations.ts`, sticky editor in `ink/InkLayer.tsx` | Movable, collapsible coloured sticky notes, synced local-first. |
| Mixed handwriting and typing on one page | both | **have** | `ink/InkLayer.tsx` (ink, shapes, text boxes, stickies, images, page links on one page), `AnnotationKind` in `shared/annotations.ts` | All item kinds share one page layer and one undo history. |
| Dictation and Scribble input | both | **blocked** | `CAPABILITY_MATRIX.md` row «Scribble»; no speech-to-text provider (`docs/ARCHITECTURE.md` §1) | Scribble on the canvas needs native code; dictation needs a speech-to-text provider. iPadOS Scribble in ordinary text fields is a system feature, untested here. |
| Text boxes with rich formatting | both | **partial** | `RichText` supports bold/italic/underline/sup/sub, headings, lists, quotes and term/unit/formula runs (`shared/richtext.ts`), but the editors are plain `<textarea>`s converted by `richTextFromPlain` (`ink/InkLayer.tsx`, `ws/panels/MineTab.tsx`). | **G25** Rich formatting in text boxes and notes — effort M, P1 (see [G25](#g25)) |
| Full-page typing | both | **missing** | Notes are RichText (headings, lists, quotes in the model) but edited as plain text (`ws/panels/MineTab.tsx` `NoteEditor`); Study Book blocks are generated (`srv/studybook`); no typed page. | **G36** Typed document / full-page typing (block editor) — effort L, P2 (see [G36](#g36)) |
| Auto lists and nesting | both | **missing** | `RichText` supports bold/italic/underline/sup/sub, headings, lists, quotes and term/unit/formula runs (`shared/richtext.ts`), but the editors are plain `<textarea>`s converted by `richTextFromPlain` (`ink/InkLayer.tsx`, `ws/panels/MineTab.tsx`). | **G25** Rich formatting in text boxes and notes — effort M, P1 (see [G25](#g25)) |
| Custom fonts | both | **missing** | Bundled IBM Plex Sans Arabic + Noto Naskh Arabic only (`docs/ARCHITECTURE.md` §1). | **G26** Font choice in text boxes — effort S, P3 (see [G26](#g26)) |
| Comments | both | **partial** | Notes anchor to a page / quote / block (`AnnotationAnchor` in `shared/annotations.ts`); stickies sit on the page; no anchoring to an ink or image item, no resolve state. | **G27** Notes pinned to objects, with open / resolved state — effort M, P2 (see [G27](#g27)) |
| Text boxes and sticky notes | both | **partial** | Sticky notes are fine; text-box formatting, lists and pinned text tool are missing. | **G25** Rich formatting in text boxes and notes — effort M, P1 (see [G25](#g25)) |
| Text Documents (typed docs) | both | **partial** | Notes are RichText (headings, lists, quotes in the model) but edited as plain text (`ws/panels/MineTab.tsx` `NoteEditor`); Study Book blocks are generated (`srv/studybook`); no typed page. | **G36** Typed document / full-page typing (block editor) — effort L, P2 (see [G36](#g36)) |
| Scientific and technical formatting in Text Documents | both | **partial** | The RichText model and renderer already handle sup/sub, code, quotes and unit/formula runs bidi-correctly; the editors cannot set them. | **G25** Rich formatting in text boxes and notes — effort M, P1 (see [G25](#g25)) |

### elements/stickers

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Elements library (reusable content) | both | **missing** | No element store; copy/paste only within the session (`ink/store.ts` clipboard). | **G28** Owner element library (reusable content and stamps) — effort M, P2 (see [G28](#g28)) |
| Built-in sticker, stamp and mind-map shape collections | both | **missing** | Bundled third-party sticker packs are not planned (§02 no content market); owner-made stamp collections are. | **G28** Owner element library (reusable content and stamps) — effort M, P2 (see [G28](#g28)) |
| GIFs, animated stickers and GIPHY search | both | **out of scope** | spec §22, §49; GIF accepted by `ink/images.ts` | §22 asks for a calm study surface without decorative motion; an external GIF service would also send queries off-device (§49). The owner's own GIF files can already be inserted with the image tool. |
| Washi tape patterns | both | **out of scope** | spec §22, §49; GIF accepted by `ink/images.ts` | §22 asks for a calm study surface without decorative motion; an external GIF service would also send queries off-device (§49). The owner's own GIF files can already be inserted with the image tool. |
| Elements (reusable content library) | both | **missing** | No element store; copy/paste only within the session (`ink/store.ts` clipboard). | **G28** Owner element library (reusable content and stamps) — effort M, P2 (see [G28](#g28)) |
| Animated GIF search and insert | both | **out of scope** | spec §22, §49; GIF accepted by `ink/images.ts` | §22 asks for a calm study surface without decorative motion; an external GIF service would also send queries off-device (§49). The owner's own GIF files can already be inserted with the image tool. |
| Sticky notes | both | **have** | `StickyData` (`color`, `collapsed`) in `shared/annotations.ts`, sticky editor in `ink/InkLayer.tsx` | Movable, collapsible coloured sticky notes, synced local-first. |
| Elements, stickers, stamps, washi tape | both | **missing** | Washi tape itself stays out of scope (§22); owner elements and stamps are the gap. | **G28** Owner element library (reusable content and stamps) — effort M, P2 (see [G28](#g28)) |

### images

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Insert images and camera photos | both | **partial** | Image tool accepts files and paste (`ink/images.ts`, `accept="image/png,image/jpeg,image/webp,image/gif"`); image sources become pages with OCR; no in-app camera, no picture-as-note-page. | **G29** Camera capture and photo as a page — effort M, P3 (see [G29](#g29)) |
| Document scanner with OCR | unknown | **partial** | Photos / scans upload as sources and get Tesseract `ara+eng` OCR, so their text is searchable (`srv/processing/ocr.ts`); no capture-time edge detection or multi-page scan. | **G30** Document scanner flow — effort M, P3 (see [G30](#g30)) |
| Insert, paste and crop images | both | **partial** | Insert from file and paste exist (`ink/images.ts`); crop does not. | **G16** Image crop and cut a region from a page — effort M, P1 (see [G16](#g16)) |
| Image or photo as a full page | both | **partial** | Image tool accepts files and paste (`ink/images.ts`, `accept="image/png,image/jpeg,image/webp,image/gif"`); image sources become pages with OCR; no in-app camera, no picture-as-note-page. | **G29** Camera capture and photo as a page — effort M, P3 (see [G29](#g29)) |
| In-app camera capture onto page | both | **missing** | Image tool accepts files and paste (`ink/images.ts`, `accept="image/png,image/jpeg,image/webp,image/gif"`); image sources become pages with OCR; no in-app camera, no picture-as-note-page. | **G29** Camera capture and photo as a page — effort M, P3 (see [G29](#g29)) |
| Document scanning with searchable text | unknown | **partial** | Photos / scans upload as sources and get Tesseract `ara+eng` OCR, so their text is searchable (`srv/processing/ocr.ts`); no capture-time edge detection or multi-page scan. | **G30** Document scanner flow — effort M, P3 (see [G30](#g30)) |
| Images tool | both | **partial** | Insert / paste / move / resize exist; crop does not; Apple image generation is native-only. | **G16** Image crop and cut a region from a page — effort M, P1 (see [G16](#g16)) |
| GIFs and built-in GIPHY search | both | **out of scope** | spec §22, §49; GIF accepted by `ink/images.ts` | §22 asks for a calm study surface without decorative motion; an external GIF service would also send queries off-device (§49). The owner's own GIF files can already be inserted with the image tool. |

### paper templates

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Paper templates with adjustable size and color | both | **partial** | Four patterns blank / ruled / dotted / grid (`NOTE_PAGE_TEMPLATES` in `shared/annotations.ts`, `ws/model/paper.ts`), changeable per page; every page is A4 portrait (`NOTE_PAGE_SIZE` in `ws/data/notePages.ts`). | **G31** Paper size, orientation, colour and more patterns — effort M, P2 (see [G31](#g31)) |
| Premium templates and digital stationery | paid | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02 forbids subscriptions, payment, plans and a content market; MedLevo is a single-owner tool (AI cost is tracked per call with a budget cap instead of credits). |
| Custom templates and covers from PDF or image | both | **missing** | No custom templates; library «templates» are folder structures for 12 subjects (`srv/library/templates.ts`). | **G32** Custom and clinical page templates — effort L, P1 (see [G32](#g32)) |
| Whiteboard templates | unknown | **missing** | Pages are fixed-size sheets (`ws/reader/BookCanvas.tsx`); the ink engine has a spatial index that could back tiling (`ink/spatial.ts`). | **G35** Infinite canvas (concept / case board) — effort L, P2 (see [G35](#g35)) |
| Planner with calendar event sync | paid | **partial** | Deterministic planner with owner days and rebalancing (`srv/learning/planner.ts`, `web/features/planner`); no calendar sync. | **G33** Planner ↔ calendar files — effort M, P3 (see [G33](#g33)) |
| Notebook creation with template library | both | **partial** | Four patterns blank / ruled / dotted / grid (`NOTE_PAGE_TEMPLATES` in `shared/annotations.ts`, `ws/model/paper.ts`), changeable per page; every page is A4 portrait (`NOTE_PAGE_SIZE` in `ws/data/notePages.ts`). | **G31** Paper size, orientation, colour and more patterns — effort M, P2 (see [G31](#g31)) |
| Change template per page | both | **partial** | Paper pattern changes per page (`ws/notebook/NotePagesList.tsx`); size, orientation and colour do not. | **G31** Paper size, orientation, colour and more patterns — effort M, P2 (see [G31](#g31)) |
| Custom templates and covers | both | **missing** | No custom templates; library «templates» are folder structures for 12 subjects (`srv/library/templates.ts`). | **G32** Custom and clinical page templates — effort L, P1 (see [G32](#g32)) |
| Paper templates and custom paper | both | **partial** | Four patterns blank / ruled / dotted / grid (`NOTE_PAGE_TEMPLATES` in `shared/annotations.ts`, `ws/model/paper.ts`), changeable per page; every page is A4 portrait (`NOTE_PAGE_SIZE` in `ws/data/notePages.ts`). | **G31** Paper size, orientation, colour and more patterns — effort M, P2 (see [G31](#g31)) |
| Planners and journaling | both | **partial** | Planner days and task check-off exist (`web/features/planner`); no writable planner pages. | **G34** Handwritten study log per plan day — effort S, P3 (see [G34](#g34)) |
| Dynamic (resizable, recolorable) templates and creator template format | unknown | **partial** | Patterns are already vector/token based; a creator template format for a market is out of scope (§02). | **G31** Paper size, orientation, colour and more patterns — effort M, P2 (see [G31](#g31)) |
| Dark paper color | both | **have** | `web/design/tokens.css` (light/dark), `ink/palette.ts` (every ink token has light + dark values), `ws/model/paper.ts` (`--wk-paper-bg`) | Better: ink colours resolve per paper tone, so black ink stays readable on dark note paper while original PDF pages stay white. |

### notebooks & covers

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Notebooks | both | **have** | `ws/notebook/NotebookScreen.tsx`, `ws/notebook/NotebookSection.tsx` (section tabs from dividers), `ws/model/sequence.ts` (note pages inserted after a lecture page), `shared/library.ts` covers | Better for study: note pages can also live inside a lecture, right after the page they discuss (§26). |
| Whiteboards (infinite canvas) | both | **missing** | Pages are fixed-size sheets (`ws/reader/BookCanvas.tsx`); the ink engine has a spatial index that could back tiling (`ink/spatial.ts`). | **G35** Infinite canvas (concept / case board) — effort L, P2 (see [G35](#g35)) |
| Text Documents (block editor) | both | **partial** | Notes are RichText (headings, lists, quotes in the model) but edited as plain text (`ws/panels/MineTab.tsx` `NoteEditor`); Study Book blocks are generated (`srv/studybook`); no typed page. | **G36** Typed document / full-page typing (block editor) — effort L, P2 (see [G36](#g36)) |
| Quicknotes | both | **missing** | New pages are created inside a chosen notebook or after a lecture page (`ws/notebook/NotebookScreen.tsx`, top-bar menu); no inbox, no PWA `shortcuts` / share target in `apps/web/vite.config.ts`. | **G37** Quick note (one tap, file later) — effort M, P1 (see [G37](#g37)) |
| Page management | both | **partial** | Add, rename, change paper, reorder, trash / restore note pages (`ws/notebook/NotePagesList.tsx`, `ws/data/notePages.ts`); no duplicate, rotate, multi-select or cross-notebook move. | **G38** Page management: duplicate, rotate, multi-select, move to another notebook — effort M, P1 (see [G38](#g38)) |
| Document tabs and multiple windows | both | **partial** | One document + a writable split pane (`ws/split/SplitPane.tsx`); several browser tabs stay consistent via BroadcastChannel (`ink/events.ts`); no in-app tab strip. | **G39** Document tabs and windows — effort M, P3 (see [G39](#g39)) |
| Zoom window | both | **missing** | No magnified writing strip; the ink engine already stores points in zoom-independent page space (`ink/math.ts`, AC-21). | **G09** Zoom writing window with auto-advance — effort M, P2 (see [G09](#g09)) |
| Covers as first page | both | **partial** | Covers are tokens: 8 colours × 4 styles × medical icons (`shared/library.ts`), shown on the notebook (`NotebookScreen.tsx`). | **G68** Picture covers — effort S, P3 (see [G68](#g68)) |
| QuickNote | both | **missing** | New pages are created inside a chosen notebook or after a lecture page (`ws/notebook/NotebookScreen.tsx`, top-bar menu); no inbox, no PWA `shortcuts` / share target in `apps/web/vite.config.ts`. | **G37** Quick note (one tap, file later) — effort M, P1 (see [G37](#g37)) |
| Whiteboard document (infinite canvas) | both | **missing** | Pages are fixed-size sheets (`ws/reader/BookCanvas.tsx`); the ink engine has a spatial index that could back tiling (`ink/spatial.ts`). | **G35** Infinite canvas (concept / case board) — effort L, P2 (see [G35](#g35)) |
| Text Document (block editor) | both | **partial** | Notes are RichText (headings, lists, quotes in the model) but edited as plain text (`ws/panels/MineTab.tsx` `NoteEditor`); Study Book blocks are generated (`srv/studybook`); no typed page. | **G36** Typed document / full-page typing (block editor) — effort L, P2 (see [G36](#g36)) |
| Smart Textbooks | both | **have** | `srv/questions` lecture ↔ question links, `ws/panels/QuestionsTab.tsx`, `ws/session/useReadingProgress.ts`, `ws/split/SplitPane.tsx` | For the owner's own material: reading progress, questions linked to the pages they test, original page beside the answer, split view. |
| Marketplace content | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02 forbids subscriptions, payment, plans and a content market; MedLevo is a single-owner tool (AI cost is tracked per call with a budget cap instead of credits). |
| Calendar-linked planner and meeting notes | both | **out of scope** | spec §01 | Event-linked meeting notes with attendees are out of scope; the planner ↔ calendar-file gap is tracked under G33. |
| Notebooks with covers | both | **have** | `ws/notebook/NotebookScreen.tsx`, `ws/notebook/NotebookSection.tsx` (section tabs from dividers), `ws/model/sequence.ts` (note pages inserted after a lecture page), `shared/library.ts` covers | Better for study: note pages can also live inside a lecture, right after the page they discuss (§26). |
| Page management | both | **partial** | Add, rename, change paper, reorder, trash / restore note pages (`ws/notebook/NotePagesList.tsx`, `ws/data/notePages.ts`); no duplicate, rotate, multi-select or cross-notebook move. | **G38** Page management: duplicate, rotate, multi-select, move to another notebook — effort M, P1 (see [G38](#g38)) |
| Whiteboards (infinite canvas) | both | **missing** | Pages are fixed-size sheets (`ws/reader/BookCanvas.tsx`); the ink engine has a spatial index that could back tiling (`ink/spatial.ts`). | **G35** Infinite canvas (concept / case board) — effort L, P2 (see [G35](#g35)) |
| QuickNotes | both | **missing** | New pages are created inside a chosen notebook or after a lecture page (`ws/notebook/NotebookScreen.tsx`, top-bar menu); no inbox, no PWA `shortcuts` / share target in `apps/web/vite.config.ts`. | **G37** Quick note (one tap, file later) — effort M, P1 (see [G37](#g37)) |
| Per-document details and settings | both | **partial** | Per-device session restore (page, zoom, layout, rail, mode) in `ws/session/useStudySession.ts`; source details in `web/features/sources/SourceScreen.tsx`; no per-document recognition language or defaults. | **G69** Per-document settings — effort S, P3 (see [G69](#g69)) |

### folders/library

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Nested folders with custom colors | both | **partial** | Nested folders, colour tokens, icons and sorting exist (`shared/library.ts`); bulk multi-select actions do not. | **G40** Library multi-select and bulk actions — effort M, P3 (see [G40](#g40)) |
| Favorites and page bookmarks | both | **have** | `web/features/library/LibraryScreen.tsx` (views favorites / recent / archive / trash), bookmarks in `ws/panels/MineTab.tsx` `BookmarksSection` and `ws/panels/LeftPanel.tsx` | Favourite notebooks/folders and per-page bookmarks with a bookmarks tab. |
| AI title suggestion and auto-organization | unknown | **partial** | Source type suggestion and topic link suggestions with reasons exist (`srv/sources`, `/api/brain/topics/suggest`); no title suggestion for notebooks / note pages. | **G42** Title and filing suggestions — effort S, P3 (see [G42](#g42)) |
| Folders with colors and icons | both | **have** | `shared/library.ts` (`COVER_COLORS`, `COVER_STYLES`, medical `LIBRARY_ICONS`, `SORT_MODES`), `web/features/library/dnd.tsx`, cycle prevention in `srv/library/service.ts` | Nested folders/notebooks with colour tokens, cover styles, medical icons, manual + automatic sort, drag & drop (colours are design tokens by choice, §22). |
| Library views, filter, search and bulk actions | both | **partial** | Single-item move / archive / trash with impact (`web/features/library`); no multi-select; folder colours are 8 tokens by design. | **G40** Library multi-select and bulk actions — effort M, P3 (see [G40](#g40)) |
| Favorites and page bookmarks | both | **have** | `web/features/library/LibraryScreen.tsx` (views favorites / recent / archive / trash), bookmarks in `ws/panels/MineTab.tsx` `BookmarksSection` and `ws/panels/LeftPanel.tsx` | Favourite notebooks/folders and per-page bookmarks with a bookmarks tab. |
| Trash bin with recovery | both | **have** | `web/features/library/TrashView.tsx`, `srv/library/service.ts` (trash / restore / impact), note-page trash + restore in `ws/data/notePages.ts`, purge impact in `srv/sources/purge.ts` | Restorable trash with an impact report before anything is deleted for good. |
| Home-screen widgets | both | **blocked** | no native shell exists (`docs/REQUIREMENTS_MATRIX.md` §27: native layer Not Started — needs macOS/Xcode) | OS widgets / Siri Shortcuts need a native app. A PWA manifest `shortcuts` entry is the web substitute (see G37). |
| Document tabs and multiple windows | both | **partial** | One document + a writable split pane (`ws/split/SplitPane.tsx`); several browser tabs stay consistent via BroadcastChannel (`ink/events.ts`); no in-app tab strip. | **G39** Document tabs and windows — effort M, P3 (see [G39](#g39)) |
| Folders, nested folders, colours, sorting | both | **have** | `shared/library.ts` (`COVER_COLORS`, `COVER_STYLES`, medical `LIBRARY_ICONS`, `SORT_MODES`), `web/features/library/dnd.tsx`, cycle prevention in `srv/library/service.ts` | Nested folders/notebooks with colour tokens, cover styles, medical icons, manual + automatic sort, drag & drop (colours are design tokens by choice, §22). |
| Favorites widget | both | **blocked** | no native shell exists (`docs/REQUIREMENTS_MATRIX.md` §27: native layer Not Started — needs macOS/Xcode) | OS widgets / Siri Shortcuts need a native app. A PWA manifest `shortcuts` entry is the web substitute (see G37). |
| Document tabs and multi-window | both | **partial** | One document + a writable split pane (`ws/split/SplitPane.tsx`); several browser tabs stay consistent via BroadcastChannel (`ink/events.ts`); no in-app tab strip. | **G39** Document tabs and windows — effort M, P3 (see [G39](#g39)) |
| Duplicate documents | both | **missing** | No duplicate or merge for notebooks (`srv/library`, `srv/annotations`). | **G41** Duplicate and merge notebooks — effort M, P3 (see [G41](#g41)) |
| Recently opened documents list | both | **have** | `LibraryScreen.tsx` view `recent`, Home «تابع الدراسة» (`/api/annotations/sessions/recent`, `web/features/home`) | Better: Continue Studying resumes the exact page, zoom, mode and panels, also from another device (§46). |

### outline & links

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Outlines (table of contents) | both | **partial** | Outline from the PDF outline or detected heading regions (`ws/panels/LeftPanel.tsx`) — deterministic, no AI; the owner cannot add, nest or rename entries. | **G43** Owner-built outlines — effort M, P2 (see [G43](#g43)) |
| Hyperlinks | both | **partial** | Page links to a lecture page (+ region) or a note page with back navigation (`LinkData` in `shared/annotations.ts`, `ws/notes/NotePageDialogs.tsx`); no owner URL links; not from text-box text. | **G44** Owner web links and links to study objects — effort M, P2 (see [G44](#g44)) |
| Document sidebar | both | **have** | `ws/panels/LeftPanel.tsx` (thumbnails, outline from `getOutline()` or heading regions, bookmarks), `ws/panels/StudyRail.tsx` | Page panel plus the contextual Study Rail (notes, questions, sources, cases). |
| Page management | both | **partial** | Add, rename, change paper, reorder, trash / restore note pages (`ws/notebook/NotePagesList.tsx`, `ws/data/notePages.ts`); no duplicate, rotate, multi-select or cross-notebook move. | **G38** Page management: duplicate, rotate, multi-select, move to another notebook — effort M, P1 (see [G38](#g38)) |
| Merge notebooks | both | **missing** | No duplicate or merge for notebooks (`srv/library`, `srv/annotations`). | **G41** Duplicate and merge notebooks — effort M, P3 (see [G41](#g41)) |
| Document outlines | both | **partial** | Outline from the PDF outline or detected heading regions (`ws/panels/LeftPanel.tsx`) — deterministic, no AI; the owner cannot add, nest or rename entries. | **G43** Owner-built outlines — effort M, P2 (see [G43](#g43)) |
| AI-generated outline | paid | **partial** | Lectures without a PDF outline already get one from detected heading regions — deterministic, no AI credits; handwritten notebooks get none. | **G43** Owner-built outlines — effort M, P2 (see [G43](#g43)) |
| Internal and external hyperlinks | both | **partial** | Page links to a lecture page (+ region) or a note page with back navigation (`LinkData` in `shared/annotations.ts`, `ws/notes/NotePageDialogs.tsx`); no owner URL links; not from text-box text. | **G44** Owner web links and links to study objects — effort M, P2 (see [G44](#g44)) |
| Follow PDF hyperlinks (planners) | both | **have** | `ws/reader/pdfLinks.tsx` (internal destinations push a back entry; external http/https/mailto only after «فتح رابط خارجي؟») | Better: safe external-link confirmation (punycode / bidi-safe address) and «العودة إلى موضعك». |
| Read-only mode | both | **have** | `InkToolId` `hand` / `select_text` in `ink/types.ts` (layer becomes `pointer-events: none`), focus mode in `ws/chrome/TopBar.tsx` | Hand tool = read-only reading; links and stickies stay usable. |
| Navigation: scroll direction, zoom, pan | both | **have** | `ws/reader/BookCanvas.tsx` (continuous / single / two-page RTL spread, fit-width, zoom presets, pinch, Ctrl+wheel, rotation), `ws/chrome/GoToPage.tsx` (printed labels) | Better: go-to by printed page label («ص ١٢») or file position (AC-04). |
| Outlines / table of contents | both | **partial** | Outline from the PDF outline or detected heading regions (`ws/panels/LeftPanel.tsx`) — deterministic, no AI; the owner cannot add, nest or rename entries. | **G43** Owner-built outlines — effort M, P2 (see [G43](#g43)) |
| Hyperlinks and bookmarks | both | **partial** | Page links and bookmarks exist; owner web links do not. | **G44** Owner web links and links to study objects — effort M, P2 (see [G44](#g44)) |

### search & handwriting OCR

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Library-wide search | both | **partial** | Universal search covers sources (incl. OCR), notes, questions, transcripts, recognised handwriting, generated content and chats (`srv/search/service.ts`); text boxes, stickies, link labels and note-page titles on pages are not indexed (`owner_content_fts` writers). | **G45** Search typed page items and note-page titles — effort M, P1 (see [G45](#g45)) |
| Handwriting-to-text conversion | both | **blocked** | `srv/annotations/recognition.ts` (job `ink.recognize`, derived reading, per-word uncertainty, owner correction, search index), `ws/handwriting/*`; capability `workspace.handwriting_recognition` = `requires_configuration` | Built (track F4) and tested with the test-only fake provider; needs a vision provider key. Designed for ar / en / mixed (the reference app lists no RTL languages). |
| AI-powered semantic search | unknown | **blocked** | capability `search.semantic`; table `chunk_embedding` created but never written (`docs/ARCHITECTURE.md` §2) | Needs an embeddings provider; keyword + exact Arabic-normalised search works today. |
| Unified search | both | **partial** | Universal search covers sources (incl. OCR), notes, questions, transcripts, recognised handwriting, generated content and chats (`srv/search/service.ts`); text boxes, stickies, link labels and note-page titles on pages are not indexed (`owner_content_fts` writers). | **G45** Search typed page items and note-page titles — effort M, P1 (see [G45](#g45)) |
| Handwriting recognition languages | both | **blocked** | `srv/annotations/recognition.ts` (job `ink.recognize`, derived reading, per-word uncertainty, owner correction, search index), `ws/handwriting/*`; capability `workspace.handwriting_recognition` = `requires_configuration` | Built (track F4) and tested with the test-only fake provider; needs a vision provider key. Designed for ar / en / mixed (the reference app lists no RTL languages). |
| Convert handwriting to typed text | both | **blocked** | `srv/annotations/recognition.ts` (job `ink.recognize`, derived reading, per-word uncertainty, owner correction, search index), `ws/handwriting/*`; capability `workspace.handwriting_recognition` = `requires_configuration` | Built (track F4) and tested with the test-only fake provider; needs a vision provider key. Designed for ar / en / mixed (the reference app lists no RTL languages). |
| Handwritten math to typeset math + LaTeX | both | **out of scope** | spec §01 | §01 scope is medical study; general math solving / graphing is not part of the spec (unit- and dose-aware text runs exist in `shared/richtext.ts`). |
| Handwriting-to-text conversion | both | **blocked** | `srv/annotations/recognition.ts` (job `ink.recognize`, derived reading, per-word uncertainty, owner correction, search index), `ws/handwriting/*`; capability `workspace.handwriting_recognition` = `requires_configuration` | Built (track F4) and tested with the test-only fake provider; needs a vision provider key. Designed for ar / en / mixed (the reference app lists no RTL languages). |
| Math conversion to typeset/LaTeX | both | **out of scope** | spec §01 | §01 scope is medical study; general math solving / graphing is not part of the spec (unit- and dose-aware text runs exist in `shared/richtext.ts`). |
| Universal search (handwriting, typed, PDF, titles) | both | **partial** | Universal search covers sources (incl. OCR), notes, questions, transcripts, recognised handwriting, generated content and chats (`srv/search/service.ts`); text boxes, stickies, link labels and note-page titles on pages are not indexed (`owner_content_fts` writers). | **G45** Search typed page items and note-page titles — effort M, P1 (see [G45](#g45)) |
| Opt-in handwriting and math sample contribution | both | **out of scope** | spec §02, §49 | §02/§49: no data is collected for a vendor; recognition corrections already stay with the owner (`ink_recognition.corrected_text`). |

### AI features

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Handwriting spellcheck | both | **missing** | No spellcheck; recognised text and owner corrections are stored in `ink_recognition` (`srv/annotations/recognition.ts`). | **G13** Medical spellcheck for notes and recognised handwriting — effort M, P3 (see [G13](#g13)) |
| AI assistant chat (Ask mode) with citations | both | **blocked** | `srv/studybook/chat.ts`, `ws/studybook/ChatPanel.tsx`, evidence aliases + claim validation in `srv/evidence/*` | Built: chat bound to the selection, page, version and Source Lock with claim-level citations (stricter than page references); needs ANTHROPIC_API_KEY. |
| AI summaries | both | **blocked** | `ws/studybook/SummaryPanel.tsx`, `srv/studybook/generate.ts` (summary types, coverage tracking) | Built with coverage tracking (§31: never «complete» when pages are missing); needs ANTHROPIC_API_KEY (audio summaries also need speech-to-text). |
| Explain, simplify and translate | both | **blocked** | `srv/studybook/explain.ts` (explain / simplify / translate / explain_image), `ws/model/aiActions.ts` | Built with Source Lock and a real-patient guard; needs ANTHROPIC_API_KEY. |
| AI writing tools for typed text (Edit AI) | both | **missing** | No rewrite / proofread action for owner text; `ai_answer` notes exist (`NoteDTO.origin`). | **G46** Note polishing as a labelled derived note — effort M, P3 (see [G46](#g46)) |
| Quiz / practice-question generator from notes | both | **blocked** | `srv/exams` generation pipeline (distractor validation, evidence), `ws/panels/CreateMcqPanel.tsx` | Built: evidence-checked MCQ generation from the lecture or a selection (unsupported items go to review, not to the owner); needs ANTHROPIC_API_KEY. |
| Create Mode (AI that edits the document) | paid | **partial** | Generated content lives in Study Book artifacts, diagrams and saved AI answers labelled «مولَّد» (`srv/studybook/*`); nothing generated is placed on a note page; all AI needs the key. | **G47** Insert generated content onto a page (labelled) — effort M, P3 (see [G47](#g47)) |
| AI diagram and mind-map generation | unknown | **partial** | Deterministic knowledge map (`srv/brain`, `web/features/brain/KnowledgeGraph.tsx`); evidence-checked AI flowcharts / timelines from lecture pages (`srv/studybook/diagrams.ts`, needs the key); nothing from owner notes. | **G48** Diagrams and mind maps from the owner's notes — effort M, P3 (see [G48](#g48)) |
| AI image and doodle generation | paid | **missing** | No image generation; the media module already labels «رسم توضيحي مولَّد» and AC-09 never accepts generated images as real cases (`srv/media/validate-image.ts`). | **G49** Labelled schematic illustrations — effort L, P3 (see [G49](#g49)) |
| AI template generation | paid | **missing** | No templates yet; an AI-tailored checklist is the optional (key-gated) step of the clinical-template plan. | **G32** Custom and clinical page templates — effort L, P1 (see [G32](#g32)) |
| AI for Math: Solve and Teach Me | paid | **out of scope** | spec §01 | §01 scope is medical study; general math solving / graphing is not part of the spec (unit- and dose-aware text runs exist in `shared/richtext.ts`). |
| Math Assist (on-device) | both | **out of scope** | spec §01 | §01 scope is medical study; general math solving / graphing is not part of the spec (unit- and dose-aware text runs exist in `shared/richtext.ts`). |
| Equation graphing | unknown | **out of scope** | spec §01 | §01 scope is medical study; general math solving / graphing is not part of the spec (unit- and dose-aware text runs exist in `shared/richtext.ts`). |
| AI credits and AI Pass add-on | paid | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02 forbids subscriptions, payment, plans and a content market; MedLevo is a single-owner tool (AI cost is tracked per call with a budget cap instead of credits). |
| AI on shared documents | unknown | **out of scope** | spec §02; `docs/ARCHITECTURE.md` §0.8 «Single owner» | §02 forbids public sharing, invitations and multi-user accounts: MedLevo is single-owner. The owner's own devices already sync (see sync rows). |
| ChatGPT app and Claude connector | both | **missing** | No external connector; generated content is always labelled (`NoteDTO.origin = ai_answer`). | **G50** Owner connector for an external assistant — effort M, P3 (see [G50](#g50)) |
| AI language support and privacy stance | both | **have** | `srv/ai` orchestrator (`usage_record` per call, budget cap), handwriting picture limited to the selected strokes (`ws/handwriting/raster.ts`), §49 row in `docs/REQUIREMENTS_MATRIX.md` | Arabic-first explanation rules (§19) with dialect / level settings; AI optional and server-side. |
| In-document AI assistant | paid | **blocked** | `srv/studybook/chat.ts`, `ws/studybook/ChatPanel.tsx`, evidence aliases + claim validation in `srv/evidence/*` | Built: chat bound to the selection, page, version and Source Lock with claim-level citations (stricter than page references); needs ANTHROPIC_API_KEY. |
| Q&A with page references, summaries, practice questions, translation | both | **blocked** | `srv/studybook/chat.ts`, `ws/studybook/ChatPanel.tsx`, evidence aliases + claim validation in `srv/evidence/*` | Built: chat bound to the selection, page, version and Source Lock with claim-level citations (stricter than page references); needs ANTHROPIC_API_KEY. |
| Create mode (AI writes into the document) | paid | **partial** | Generated content lives in Study Book artifacts, diagrams and saved AI answers labelled «مولَّد» (`srv/studybook/*`); nothing generated is placed on a note page; all AI needs the key. | **G47** Insert generated content onto a page (labelled) — effort M, P3 (see [G47](#g47)) |
| AI for math: Solve and Teach Me | paid | **out of scope** | spec §01 | §01 scope is medical study; general math solving / graphing is not part of the spec (unit- and dose-aware text runs exist in `shared/richtext.ts`). |
| Math Assist (inline handwritten calculation) | both | **out of scope** | spec §01 | §01 scope is medical study; general math solving / graphing is not part of the spec (unit- and dose-aware text runs exist in `shared/richtext.ts`). |
| AI for meetings/lectures: live summary and generated notes | paid | **blocked** | `srv/media/transcripts.ts`, `srv/media/subtitles.ts` (manual segments, VTT/SRT import, corrections with history, transcript search) | Automatic transcription needs a speech-to-text provider; manual / imported transcripts, corrections and search already work. |
| AI credits and on-device AI | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02 forbids subscriptions, payment, plans and a content market; MedLevo is a single-owner tool (AI cost is tracked per call with a budget cap instead of credits). |
| External chatbot integration | both | **missing** | No external connector; generated content is always labelled (`NoteDTO.origin = ai_answer`). | **G50** Owner connector for an external assistant — effort M, P3 (see [G50](#g50)) |
| Ask Goodnotes (Q&A over own notes, with citations) | both | **blocked** | `srv/studybook/chat.ts`, `ws/studybook/ChatPanel.tsx`, evidence aliases + claim validation in `srv/evidence/*` | Built: chat bound to the selection, page, version and Source Lock with claim-level citations (stricter than page references); needs ANTHROPIC_API_KEY. |
| AI writing tools | both | **missing** | No rewrite / proofread action for owner text; `ai_answer` notes exist (`NoteDTO.origin`). | **G46** Note polishing as a labelled derived note — effort M, P3 (see [G46](#g46)) |
| AI quiz / practice questions (Quiz Me) | both | **blocked** | `srv/exams` generation pipeline (distractor validation, evidence), `ws/panels/CreateMcqPanel.tsx` | Built: evidence-checked MCQ generation from the lecture or a selection (unsupported items go to review, not to the owner); needs ANTHROPIC_API_KEY. |
| Create Mode / Edit AI | paid | **partial** | Generated content lives in Study Book artifacts, diagrams and saved AI answers labelled «مولَّد» (`srv/studybook/*`); nothing generated is placed on a note page; all AI needs the key. | **G47** Insert generated content onto a page (labelled) — effort M, P3 (see [G47](#g47)) |
| AI diagrams and mind maps from notes | both | **partial** | Deterministic knowledge map (`srv/brain`, `web/features/brain/KnowledgeGraph.tsx`); evidence-checked AI flowcharts / timelines from lecture pages (`srv/studybook/diagrams.ts`, needs the key); nothing from owner notes. | **G48** Diagrams and mind maps from the owner's notes — effort M, P3 (see [G48](#g48)) |
| AI image generation | paid | **missing** | No image generation; the media module already labels «رسم توضيحي مولَّد» and AC-09 never accepts generated images as real cases (`srv/media/validate-image.ts`). | **G49** Labelled schematic illustrations — effort L, P3 (see [G49](#g49)) |
| AI in shared documents | both | **out of scope** | spec §02; `docs/ARCHITECTURE.md` §0.8 «Single owner» | §02 forbids public sharing, invitations and multi-user accounts: MedLevo is single-owner. The owner's own devices already sync (see sync rows). |
| AI credits and AI Pass add-on | paid | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02 forbids subscriptions, payment, plans and a content market; MedLevo is a single-owner tool (AI cost is tracked per call with a budget cap instead of credits). |
| Claude connector | unknown | **missing** | No external connector; generated content is always labelled (`NoteDTO.origin = ai_answer`). | **G50** Owner connector for an external assistant — effort M, P3 (see [G50](#g50)) |
| Math Assist (inline calculation) | both | **out of scope** | spec §01 | §01 scope is medical study; general math solving / graphing is not part of the spec (unit- and dose-aware text runs exist in `shared/richtext.ts`). |
| Graphing from equations | both | **out of scope** | spec §01 | §01 scope is medical study; general math solving / graphing is not part of the spec (unit- and dose-aware text runs exist in `shared/richtext.ts`). |
| AI math tutor (Solve / Teach Me) | both | **out of scope** | spec §01 | §01 scope is medical study; general math solving / graphing is not part of the spec (unit- and dose-aware text runs exist in `shared/richtext.ts`). |

### audio recording

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Audio recording synced to notes | both | **have** | `ink/audioLink.ts` (stroke `audio_link` with offset), `ws/audio/recorder.ts`, `ws/audio/AudioUi.tsx` (player at the moment), `srv/media/recordings.ts` | Strokes written while recording carry an automatic, editable time link; selecting a stroke offers «استمع من m:ss». |
| Stroke replay modes | unknown | **missing** | Points carry time (`InkPoint` t) and strokes carry `audio_link.offset_ms` (`ink/audioLink.ts`); the player only seeks to one stroke's moment (`ws/audio/AudioUi.tsx`). | **G51** Stroke replay with the recording — effort M, P2 (see [G51](#g51)) |
| Transcription (on-device and cloud) | both | **blocked** | `srv/media/transcripts.ts`, `srv/media/subtitles.ts` (manual segments, VTT/SRT import, corrections with history, transcript search) | Automatic transcription needs a speech-to-text provider; manual / imported transcripts, corrections and search already work. |
| Playback controls and audio cleanup | both | **partial** | Native `<audio controls>` (`ws/audio/AudioUi.tsx`, `web/features/media/AudioScreen.tsx`); seek to segments / strokes; no speed memory, skip-silence or noise reduction. | **G52** Playback speed, skip, silence skip, noise reduction — effort M, P2 (see [G52](#g52)) |
| Audio summaries and linked timestamps | both | **blocked** | `ws/studybook/SummaryPanel.tsx`, `srv/studybook/generate.ts` (summary types, coverage tracking) | Built with coverage tracking (§31: never «complete» when pages are missing); needs ANTHROPIC_API_KEY (audio summaries also need speech-to-text). |
| Audio export | both | **have** | recordings become `my_audio_note` sources (`srv/media/recordings.ts`), streamed with Range (`/api/media/audio/:id/stream`), included in backups (`srv/data/backup.ts`) | Each recording is its own source: playable, downloadable from the player, renamed/trashed like any source, and in every backup. |
| Audio recording synced with ink (note replay) | both | **partial** | Time links per stroke and seek to a stroke's moment exist (`ink/audioLink.ts`); replaying the notes with the sound does not. | **G51** Stroke replay with the recording — effort M, P2 (see [G51](#g51)) |
| Replay display modes | both | **missing** | Points carry time (`InkPoint` t) and strokes carry `audio_link.offset_ms` (`ink/audioLink.ts`); the player only seeks to one stroke's moment (`ws/audio/AudioUi.tsx`). | **G51** Stroke replay with the recording — effort M, P2 (see [G51](#g51)) |
| Background recording | both | **partial** | Recording starts from the reader's view menu and stops when leaving the reader (`ws/WorkspaceScreen.tsx` `recorder.abandon()`). | **G53** Recording control and recording across navigation — effort M, P2 (see [G53](#g53)) |
| Live transcription (on-device or cloud) | both | **blocked** | `srv/media/transcripts.ts`, `srv/media/subtitles.ts` (manual segments, VTT/SRT import, corrections with history, transcript search) | Automatic transcription needs a speech-to-text provider; manual / imported transcripts, corrections and search already work. |
| Noise reduction on playback | both | **missing** | Native `<audio controls>` (`ws/audio/AudioUi.tsx`, `web/features/media/AudioScreen.tsx`); seek to segments / strokes; no speed memory, skip-silence or noise reduction. | **G52** Playback speed, skip, silence skip, noise reduction — effort M, P2 (see [G52](#g52)) |
| Manage, export and back up recordings | both | **have** | recordings become `my_audio_note` sources (`srv/media/recordings.ts`), streamed with Range (`/api/media/audio/:id/stream`), included in backups (`srv/data/backup.ts`) | Each recording is its own source: playable, downloadable from the player, renamed/trashed like any source, and in every backup. |
| Audio recording synced to ink with stroke replay | both | **partial** | Recording + stroke time links exist; stroke replay does not. | **G51** Stroke replay with the recording — effort M, P2 (see [G51](#g51)) |
| One-tap recording | both | **partial** | Starts from the reader menu «سجّل ملاحظة صوتية…» (two taps); no toolbar button. | **G53** Recording control and recording across navigation — effort M, P2 (see [G53](#g53)) |
| Transcription (live, 99 languages) | both | **blocked** | `srv/media/transcripts.ts`, `srv/media/subtitles.ts` (manual segments, VTT/SRT import, corrections with history, transcript search) | Automatic transcription needs a speech-to-text provider; manual / imported transcripts, corrections and search already work. |
| AI audio/lecture summaries and timestamps | both | **blocked** | `ws/studybook/SummaryPanel.tsx`, `srv/studybook/generate.ts` (summary types, coverage tracking) | Built with coverage tracking (§31: never «complete» when pages are missing); needs ANTHROPIC_API_KEY (audio summaries also need speech-to-text). |
| AI Meeting Assistant | paid | **out of scope** | spec §01 | §01 defines a personal medical study system, not a meeting tool; the lecture-recording equivalents are tracked in the audio rows. |
| On-device offline meeting assistant (HP laptops) | paid | **out of scope** | spec §01 | §01 defines a personal medical study system, not a meeting tool; the lecture-recording equivalents are tracked in the audio rows. |
| Recording reliability indicators and recovery | both | **have** | `ws/audio/recorder.ts` (4 s chunks in IndexedDB, Web Lock), `ws/audio/recordings.ts` (`recoverInterruptedRecordings`, refusal list), `e2e/f4-handwriting-audio.spec.ts` | Better for data safety: crash recovery, a recording the server refused is never invisible, explicit discard only. |

### meetings

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| AI Meeting Assistant | paid | **out of scope** | spec §01 | §01 defines a personal medical study system, not a meeting tool; the lecture-recording equivalents are tracked in the audio rows. |
| Calendar integration and meeting notes | both | **out of scope** | spec §01 | §01 defines a personal medical study system, not a meeting tool; the lecture-recording equivalents are tracked in the audio rows. |
| Offline on-device Meeting Assistant (HP laptops) | paid | **out of scope** | spec §01 | §01 defines a personal medical study system, not a meeting tool; the lecture-recording equivalents are tracked in the audio rows. |
| Multilingual live summary with translated view | paid | **blocked** | `srv/media/transcripts.ts`, `srv/media/subtitles.ts` (manual segments, VTT/SRT import, corrections with history, transcript search) | Automatic transcription needs a speech-to-text provider; manual / imported transcripts, corrections and search already work. |

### presentation/laser

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Presentation mode | both | **partial** | Laser pointer and focus mode exist (`ink/layerController.ts`, `ws/chrome/TopBar.tsx`); no audience-only view. | **G54** Presentation / teach-back mode — effort M, P3 (see [G54](#g54)) |
| Laser pointer | both | **have** | `InkToolId` `laser`, `ink/layerController.ts` (`LASER_FADE_MS = 900`, never saved) | Fading laser trail, never stored. |
| Laser pointer | both | **have** | `InkToolId` `laser`, `ink/layerController.ts` (`LASER_FADE_MS = 900`, never saved) | Fading laser trail, never stored. |
| Presentation mode on external display | both | **partial** | Laser pointer and focus mode exist (`ink/layerController.ts`, `ws/chrome/TopBar.tsx`); no audience-only view. | **G54** Presentation / teach-back mode — effort M, P3 (see [G54](#g54)) |
| Presentation mode with laser pointer | both | **partial** | Laser pointer and focus mode exist (`ink/layerController.ts`, `ws/chrome/TopBar.tsx`); no audience-only view. | **G54** Presentation / teach-back mode — effort M, P3 (see [G54](#g54)) |

### PDF annotation & import

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| PDF annotation, signing and form filling | both | **partial** | Writing, text boxes and pen signatures over PDF pages work; AcroForm fields are not read (pdf.js link annotations only in `ws/reader/pdfLinks.tsx`). | **G55** PDF form fields and saved signature — effort M, P3 (see [G55](#g55)) |
| Multi-format import | both | **have** | `web/features/upload/UploadScreen.tsx` (`ACCEPT`: PDF, DOCX, PPTX, DOC, PPT, images, TIFF, ZIP, audio), `srv/processing/*` (pdf.js text, Tesseract `ara+eng` OCR, LibreOffice conversion) | Better: every import is processed into pages + regions with OCR (Arabic + English), so scanned PDFs become searchable and citable. |
| Email-to-Goodnotes inbox | unknown | **missing** | Upload screen only (`web/features/upload/UploadScreen.tsx`); no Web Share Target in the PWA manifest; no inbox address. | **G71** Send files to MedLevo from other apps — effort M, P3 (see [G71](#g71)) |
| Cloud drive round-trip (Google Drive, OneDrive, Dropbox, Box) | paid | **out of scope** | spec §49 | §49: no third-party integration that is not needed; files stay private on the owner's server. The OS file picker (e.g. iPadOS Files) already reaches cloud drives for import. |
| Multi-format import | both | **have** | `web/features/upload/UploadScreen.tsx` (`ACCEPT`: PDF, DOCX, PPTX, DOC, PPT, images, TIFF, ZIP, audio), `srv/processing/*` (pdf.js text, Tesseract `ara+eng` OCR, LibreOffice conversion) | Better: every import is processed into pages + regions with OCR (Arabic + English), so scanned PDFs become searchable and citable. |
| PDF text actions | both | **partial** | Selection toolbar: highlight, underline, copy, note, explain / simplify / translate / ask / compare / MCQ / card / revision (`ws/selection/SelectionToolbar.tsx`, `ws/model/aiActions.ts`). | **G70** Strike-out, define and read aloud on PDF text — effort S, P3 (see [G70](#g70)) |
| Email-to-app PDF import | paid | **missing** | Upload screen only (`web/features/upload/UploadScreen.tsx`); no Web Share Target in the PWA manifest; no inbox address. | **G71** Send files to MedLevo from other apps — effort M, P3 (see [G71](#g71)) |
| Direct cloud-drive integration with save-back | paid | **out of scope** | spec §49 | §49: no third-party integration that is not needed; files stay private on the owner's server. The OS file picker (e.g. iPadOS Files) already reaches cloud drives for import. |
| Web page to clean PDF | both | **out of scope** | spec §49; `apps/server/src/lib/ssrf-guard.ts` | §49: the server never fetches arbitrary URLs (SSRF guard, external fetch off by default); a page saved as PDF by the browser can be uploaded. |
| Publisher eBook import (EBS) | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02: no publisher partnerships or content market; the owner uploads their own books as sources. |
| PDF import and annotation | both | **have** | `web/features/upload/UploadScreen.tsx` (`ACCEPT`: PDF, DOCX, PPTX, DOC, PPT, images, TIFF, ZIP, audio), `srv/processing/*` (pdf.js text, Tesseract `ara+eng` OCR, LibreOffice conversion) | Annotations become searchable once handwriting recognition is configured (blocked: vision provider). |
| Multi-format import and email-in | both | **partial** | Multi-format import exists (`UploadScreen.tsx`); email-in does not (Web Share Target planned instead). | **G71** Send files to MedLevo from other apps — effort M, P3 (see [G71](#g71)) |
| PDF form completion by overlay (interactive fields not kept) | both | **partial** | Writing, text boxes and pen signatures over PDF pages work; AcroForm fields are not read (pdf.js link annotations only in `ws/reader/pdfLinks.tsx`). | **G55** PDF form fields and saved signature — effort M, P3 (see [G55](#g55)) |
| Partner textbook delivery (Korean eBook stores) | free | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02: no publisher partnerships or content market. |

### export & sharing

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Export, print and share | both | **partial** | Markdown, print HTML, JSON with manifest, DOCX and Anki TSV exist (`srv/data/export.ts`, `docx.ts`, `srv/learning/anki.ts`), but ink is only counted: «لا تُصدَّر الكتابة بالقلم» (`export.ts` lines ~447/468/487); PDF = browser print. | **G56** PDF export with ink (flattened / editable) — effort L, P1 (see [G56](#g56)) |
| Export formats and scopes | both | **partial** | Markdown, print HTML, JSON with manifest, DOCX and Anki TSV exist (`srv/data/export.ts`, `docx.ts`, `srv/learning/anki.ts`), but ink is only counted: «لا تُصدَّر الكتابة بالقلم» (`export.ts` lines ~447/468/487); PDF = browser print. | **G56** PDF export with ink (flattened / editable) — effort L, P1 (see [G56](#g56)) |
| Editable vs flattened PDF with searchable handwriting | both | **missing** | Markdown, print HTML, JSON with manifest, DOCX and Anki TSV exist (`srv/data/export.ts`, `docx.ts`, `srv/learning/anki.ts`), but ink is only counted: «لا تُصدَّر الكتابة بالقلم» (`export.ts` lines ~447/468/487); PDF = browser print. | **G56** PDF export with ink (flattened / editable) — effort L, P1 (see [G56](#g56)) |
| Export content toggles | both | **partial** | Only `include_solutions` exists (questions); ink, backgrounds and layers cannot be toggled because ink is not exported. | **G56** PDF export with ink (flattened / editable) — effort L, P1 (see [G56](#g56)) |
| Print with page exclusion | both | **partial** | Print-ready HTML exists (`srv/data/render.ts`); no page picker and no ink. | **G56** PDF export with ink (flattened / editable) — effort L, P1 (see [G56](#g56)) |
| Export and print | both | **partial** | Markdown, print HTML, JSON with manifest, DOCX and Anki TSV exist (`srv/data/export.ts`, `docx.ts`, `srv/learning/anki.ts`), but ink is only counted: «لا تُصدَّر الكتابة بالقلم» (`export.ts` lines ~447/468/487); PDF = browser print. | **G56** PDF export with ink (flattened / editable) — effort L, P1 (see [G56](#g56)) |

### sync & backup

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| iCloud sync | both | **have** | `web/lib/sync.ts`, `srv/sync`, `srv/annotations/sync.ts` (append / rev-checked upsert / keep-both conflicts), `e2e/g7-ac24-two-devices.spec.ts` | Equivalent through MedLevo's own sync (not iCloud). |
| Cross-platform cloud sync | paid | **have** | `web/lib/sync.ts`, `srv/sync`, `srv/annotations/sync.ts` (append / rev-checked upsert / keep-both conflicts), `e2e/g7-ac24-two-devices.spec.ts` | Own server sync across every browser/device; no blind last-write-wins, conflicting edits are kept as copies (§47). |
| Automatic backup to third-party storage | both | **partial** | Backups via API/CLI with verified restore (`srv/data/backup.ts`, `restore.ts`); scheduling is left to cron (`docs/BACKUP_RESTORE.md`). | **G57** Scheduled automatic backups — effort M, P2 (see [G57](#g57)) |
| Offline use | both | **have** | `web/lib/localdb.ts` (Dexie), `web/lib/sync.ts` (outbox), `web/lib/offline.ts` (Download Manager, sha256-verified), `srv/data/offline.ts`, `e2e/g7-ac23-offline.spec.ts` | Better: explicit Download Manager with sizes and content list; writing never waits for the network (§47). |
| iCloud sync between Apple devices | both | **have** | `web/lib/sync.ts`, `srv/sync`, `srv/annotations/sync.ts` (append / rev-checked upsert / keep-both conflicts), `e2e/g7-ac24-two-devices.spec.ts` | Equivalent through MedLevo's own sync (not iCloud). |
| Cross-platform cloud sync | paid | **have** | `web/lib/sync.ts`, `srv/sync`, `srv/annotations/sync.ts` (append / rev-checked upsert / keep-both conflicts), `e2e/g7-ac24-two-devices.spec.ts` | Own server sync across every browser/device; no blind last-write-wins, conflicting edits are kept as copies (§47). |
| Offline editing with preload status | both | **have** | `web/lib/localdb.ts` (Dexie), `web/lib/sync.ts` (outbox), `web/lib/offline.ts` (Download Manager, sha256-verified), `srv/data/offline.ts`, `e2e/g7-ac23-offline.spec.ts` | Better: explicit Download Manager with sizes and content list; writing never waits for the network (§47). |
| Automatic one-way backup to cloud storage | both | **partial** | Backups via API/CLI with verified restore (`srv/data/backup.ts`, `restore.ts`); scheduling is left to cron (`docs/BACKUP_RESTORE.md`). | **G57** Scheduled automatic backups — effort M, P2 (see [G57](#g57)) |
| Manual full-library backup and restore | both | **have** | `srv/data/backup.ts`, `srv/data/restore.ts`, `apps/server/src/cli/backup.ts`, `docs/BACKUP_RESTORE.md` | Better: full-library backup with a restore that is verified on a separate copy before it is applied (AC-30). |
| Cross-device sync | both | **have** | `web/lib/sync.ts`, `srv/sync`, `srv/annotations/sync.ts` (append / rev-checked upsert / keep-both conflicts), `e2e/g7-ac24-two-devices.spec.ts` | Own server sync across every browser/device; no blind last-write-wins, conflicting edits are kept as copies (§47). |
| Auto Backup to third-party clouds | both | **partial** | Backups via API/CLI with verified restore (`srv/data/backup.ts`, `restore.ts`); scheduling is left to cron (`docs/BACKUP_RESTORE.md`). | **G57** Scheduled automatic backups — effort M, P2 (see [G57](#g57)) |

### security

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Document password and biometric lock | both | **partial** | The whole app is behind the owner login with session management (`srv/auth`, `web/features/settings`); no per-notebook lock; no WebAuthn. | **G58** Locked «sensitive» notebooks — effort M, P2 (see [G58](#g58)) |
| Enterprise identity, device management and AI controls | paid | **out of scope** | spec §02, §49 | §02 forbids organisations, admin consoles and tenants (security itself is covered by §49: owner auth, sessions, CSRF, private files, tested backups). |
| Compliance and trust center | both | **out of scope** | spec §02, §49 | §02 forbids organisations, admin consoles and tenants (security itself is covered by §49: owner auth, sessions, CSRF, private files, tested backups). |
| Password-protected documents | both | **partial** | The whole app is behind the owner login with session management (`srv/auth`, `web/features/settings`); no per-notebook lock; no WebAuthn. | **G58** Locked «sensitive» notebooks — effort M, P2 (see [G58](#g58)) |
| Password-locked notebooks | unknown | **partial** | The whole app is behind the owner login with session management (`srv/auth`, `web/features/settings`); no per-notebook lock; no WebAuthn. | **G58** Locked «sensitive» notebooks — effort M, P2 (see [G58](#g58)) |
| Teams/Enterprise admin and security | paid | **out of scope** | spec §02, §49 | §02 forbids organisations, admin consoles and tenants (security itself is covered by §49: owner auth, sessions, CSRF, private files, tested backups). |
| AI data-handling and privacy controls | both | **have** | `srv/ai` orchestrator (`usage_record` per call, budget cap), handwriting picture limited to the selected strokes (`ws/handwriting/raster.ts`), §49 row in `docs/REQUIREMENTS_MATRIX.md` | AI is optional and server-side; every call is recorded; only the minimum crop leaves the device; uploaded text is treated as untrusted. |
| Account deletion, data erasure and inactive-account policy | both | **partial** | Full JSON export, backups and per-source purge with impact exist (`srv/data/export.ts`, `srv/sources/purge.ts`); no «erase all my data» action. | **G59** Erase-everything and per-category erase — effort S, P3 (see [G59](#g59)) |
| Passwordless sign-in, provider-bound accounts and session limits | both | **partial** | Password + recovery codes + session list with revoke + setup token (`srv/auth`, `web/features/settings`) — the reference app has no session screen; no passwordless option. | **G60** Passkeys — effort M, P3 (see [G60](#g60)) |

### collaboration

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Real-time co-editing with live cursors | paid | **out of scope** | spec §02; `docs/ARCHITECTURE.md` §0.8 «Single owner» | §02 forbids public sharing, invitations and multi-user accounts: MedLevo is single-owner. The owner's own devices already sync (see sync rows). |
| Link sharing with permissions | both | **out of scope** | spec §02; `docs/ARCHITECTURE.md` §0.8 «Single owner» | §02 forbids public sharing, invitations and multi-user accounts: MedLevo is single-owner. The owner's own devices already sync (see sync rows). |
| Comments anchored to content | both | **partial** | Notes anchor to a page / quote / block (`AnnotationAnchor` in `shared/annotations.ts`); stickies sit on the page; no anchoring to an ink or image item, no resolve state. | **G27** Notes pinned to objects, with open / resolved state — effort M, P2 (see [G27](#g27)) |
| Team administration | paid | **out of scope** | spec §02, §49 | §02 forbids organisations, admin consoles and tenants (security itself is covered by §49: owner auth, sessions, CSRF, private files, tested backups). |
| Workspaces for separate clients or teams | unknown | **out of scope** | spec §02, §49 | §02 forbids organisations, admin consoles and tenants (security itself is covered by §49: owner auth, sessions, CSRF, private files, tested backups). |
| Public share link | paid | **out of scope** | spec §02; `docs/ARCHITECTURE.md` §0.8 «Single owner» | §02 forbids public sharing, invitations and multi-user accounts: MedLevo is single-owner. The owner's own devices already sync (see sync rows). |
| Private invite sharing with access control | paid | **out of scope** | spec §02; `docs/ARCHITECTURE.md` §0.8 «Single owner» | §02 forbids public sharing, invitations and multi-user accounts: MedLevo is single-owner. The owner's own devices already sync (see sync rows). |
| Real-time co-editing with live cursors | paid | **out of scope** | spec §02; `docs/ARCHITECTURE.md` §0.8 «Single owner» | §02 forbids public sharing, invitations and multi-user accounts: MedLevo is single-owner. The owner's own devices already sync (see sync rows). |
| Change tracking and follow mode | paid | **out of scope** | spec §02; `docs/ARCHITECTURE.md` §0.8 «Single owner» | §02 forbids public sharing, invitations and multi-user accounts: MedLevo is single-owner. The owner's own devices already sync (see sync rows). |
| Classroom/education tools | unknown | **out of scope** | spec §02 | §02 forbids institutions, classes, cohorts and Student/Instructor roles. |
| Link sharing (public/private) | both | **out of scope** | spec §02; `docs/ARCHITECTURE.md` §0.8 «Single owner» | §02 forbids public sharing, invitations and multi-user accounts: MedLevo is single-owner. The owner's own devices already sync (see sync rows). |
| Real-time co-editing | paid | **out of scope** | spec §02; `docs/ARCHITECTURE.md` §0.8 «Single owner» | §02 forbids public sharing, invitations and multi-user accounts: MedLevo is single-owner. The owner's own devices already sync (see sync rows). |
| Comments | both | **partial** | Notes anchor to a page / quote / block (`AnnotationAnchor` in `shared/annotations.ts`); stickies sit on the page; no anchoring to an ink or image item, no resolve state. | **G27** Notes pinned to objects, with open / resolved state — effort M, P2 (see [G27](#g27)) |

### study tools (flashcards)

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Tape tool (cover and reveal) | both | **missing** | No tape tool (`ink/types.ts`); image occlusion exists for cards (`srv/learning/cards.ts`, `web/features/review/local/occlusion.ts`). | **G24** Cover-and-reveal tape for active recall — effort M, P1 (see [G24](#g24)) |
| Study Sets (flashcards) | unknown | **partial** | Basic, cloze, image-occlusion and from-mistake cards with FSRS (`srv/learning/cards.ts`, `web/features/review/CardEditor.tsx`); faces are text/images only; no lasso drag into cards. | **G61** Flashcards with handwritten faces — effort L, P1 (see [G61](#g61)) |
| Practice mode and Smart Learn spaced repetition | unknown | **have** | `srv/learning/srs.ts` (FSRS-6 via `ts-fsrs`, replay of `review_event`s), `web/features/review/local/srs.ts` (same fold offline, parity-tested), `web/features/review/ReviewSession.tsx` | Better: documented FSRS schedule derived from immutable review events, works offline, never double-counts a review (§43). |
| AI-generated flashcards from notes | unknown | **partial** | Deterministic cards from a selection (exact excerpt + evidence) and from mistakes (`/learning/cards/from-selection`, `/from-mistake`); no generated card suggestions. | **G62** Card suggestions from a page or notes — effort M, P3 (see [G62](#g62)) |
| Time Keeper (timer and stopwatch) | both | **partial** | Exam timers (time pressure, simulation) in `web/features/exams/RunnerScreen.tsx`; no timer in the reader / notebook. | **G65** Study timer and stopwatch — effort M, P2 (see [G65](#g65)) |
| Exam-prep practice content with hints | unknown | **have** | `web/features/exams/RunnerScreen.tsx` (progressive hints, timers, policies), `srv/exams/attempts.ts` (`hints_used`), Question Vault (`srv/questions`) | Built on the owner's own past papers and question sources, with hints, assessed mode and Exam DNA. |
| Time Keeper (timer and stopwatch) | both | **partial** | Exam timers (time pressure, simulation) in `web/features/exams/RunnerScreen.tsx`; no timer in the reader / notebook. | **G65** Study timer and stopwatch — effort M, P2 (see [G65](#g65)) |
| Study Sets (flashcard decks) | both | **partial** | Basic, cloze, image-occlusion and from-mistake cards with FSRS (`srv/learning/cards.ts`, `web/features/review/CardEditor.tsx`); faces are text/images only; no lasso drag into cards. | **G61** Flashcards with handwritten faces — effort L, P1 (see [G61](#g61)) |
| Spaced-repetition study mode | both | **have** | `srv/learning/srs.ts` (FSRS-6 via `ts-fsrs`, replay of `review_event`s), `web/features/review/local/srs.ts` (same fold offline, parity-tested), `web/features/review/ReviewSession.tsx` | Better: documented FSRS schedule derived from immutable review events, works offline, never double-counts a review (§43). |
| Practice mode, read-aloud and study keyboard shortcuts | both | **partial** | Keyboard flow and review-ahead exist (`web/features/review/ReviewSession.tsx`); no read-aloud. | **G63** Read-aloud for cards and selected text — effort S, P3 (see [G63](#g63)) |
| Flashcard import/export (CSV/TSV/TXT, Anki, Quizlet) | both | **partial** | Anki-compatible TSV/ZIP export exists (`srv/learning/anki.ts`); no import route in `srv/learning/routes.ts`. | **G64** Flashcard import (CSV / TSV / Anki text) — effort M, P2 (see [G64](#g64)) |
| Study Sets (flashcards with spaced repetition) | both | **partial** | FSRS scheduling is stronger than the reference; handwriting/GIF card faces are missing. | **G61** Flashcards with handwritten faces — effort L, P1 (see [G61](#g61)) |
| Flashcards generated from notes | unknown | **partial** | Deterministic cards from a selection (exact excerpt + evidence) and from mistakes (`/learning/cards/from-selection`, `/from-mistake`); no generated card suggestions. | **G62** Card suggestions from a page or notes — effort M, P3 (see [G62](#g62)) |

### education

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Class Folders and document distribution | free | **out of scope** | spec §02 | §02 forbids institutions, classes, cohorts and Student/Instructor roles. |
| Live lessons and student screen monitoring | free | **out of scope** | spec §02 | §02 forbids institutions, classes, cohorts and Student/Instructor roles. |
| Class Navigator and showing student work | free | **out of scope** | spec §02 | §02 forbids institutions, classes, cohorts and Student/Instructor roles. |
| AI answer clustering and grading assistance | free | **out of scope** | spec §02 | §02 forbids institutions, classes, cohorts and Student/Instructor roles. |
| Teacher-approved AI hints | free | **out of scope** | spec §02 | §02 forbids institutions, classes, cohorts and Student/Instructor roles. |
| Interactive worksheets, progress by question, feedback mode | free | **out of scope** | spec §02 | §02 forbids institutions, classes, cohorts and Student/Instructor roles. |
| Goodnotes Education (classroom) | free | **out of scope** | spec §02 | §02 forbids institutions, classes, cohorts and Student/Instructor roles. |
| Built-in exam prep courses | unknown | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02: no bundled commercial courses; exam prep is built from the owner's own past papers (Question Vault, Exam DNA). |

### integrations

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Calendar integration | both | **out of scope** | spec §01 | §01 defines a personal medical study system, not a meeting tool; the lecture-recording equivalents are tracked in the audio rows. |
| Calendar events inside planners | paid | **partial** | Deterministic planner with owner days and rebalancing (`srv/learning/planner.ts`, `web/features/planner`); no calendar sync. | **G33** Planner ↔ calendar files — effort M, P3 (see [G33](#g33)) |
| Cloud file integrations (Box, Dropbox, Drive, OneDrive) | paid | **out of scope** | spec §49 | §49: no third-party integration that is not needed; files stay private on the owner's server. The OS file picker (e.g. iPadOS Files) already reaches cloud drives for import. |
| Apple Shortcuts / Siri action for QuickNote | both | **blocked** | no native shell exists (`docs/REQUIREMENTS_MATRIX.md` §27: native layer Not Started — needs macOS/Xcode) | OS widgets / Siri Shortcuts need a native app. A PWA manifest `shortcuts` entry is the web substitute (see G37). |

### platforms

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Cross-platform apps | both | **have** | PWA (`apps/web/vite.config.ts`), responsive layouts tested at 390 px and desktop (`e2e/*`), `docs/ARCHITECTURE.md` §4 | One web/PWA code base for iPad, Android, Windows, macOS, Linux browsers — no per-platform feature drift (native-only pen features are listed as blocked). |
| Customizable and floating toolbar | both | **partial** | Priority-based overflow by measured width (`ink/InkToolbar.tsx` `visibleSlots`); no reorder/hide/dock, no recent-tool slot. | **G66** Toolbar customisation — effort M, P2 (see [G66](#g66)) |
| Keyboard shortcuts and gesture undo/redo | both | **partial** | Keyboard shortcuts exist (`ink/InkProvider.tsx`, `ws/WorkspaceScreen.tsx`); multi-finger undo/redo does not. | **G14** Ink gestures: scribble-to-erase, circle-to-select, multi-finger undo — effort M, P2 (see [G14](#g14)) |
| Marketplace (templates, planners, stickers) | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02 forbids subscriptions, payment, plans and a content market; MedLevo is a single-owner tool (AI cost is tracked per call with a budget cap instead of credits). |
| Plans and tier structure | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02 forbids subscriptions, payment, plans and a content market; MedLevo is a single-owner tool (AI cost is tracked per call with a budget cap instead of credits). |
| In-app support assistant | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02: no vendor support organisation; diagnostics for the owner live in the Control Center (client error sink, `srv/control`). |
| Cross-platform apps and themes | both | **have** | PWA (`apps/web/vite.config.ts`), responsive layouts tested at 390 px and desktop (`e2e/*`), `docs/ARCHITECTURE.md` §4 | Theme follows the system or the owner setting (`appearanceStore` in `web/design/ThemeProvider.tsx`). |
| Platform coverage | both | **have** | PWA (`apps/web/vite.config.ts`), responsive layouts tested at 390 px and desktop (`e2e/*`), `docs/ARCHITECTURE.md` §4 | One web/PWA code base for iPad, Android, Windows, macOS, Linux browsers — no per-platform feature drift (native-only pen features are listed as blocked). |
| Feature parity gaps on Android/Windows/Web | both | **have** | PWA (`apps/web/vite.config.ts`), responsive layouts tested at 390 px and desktop (`e2e/*`), `docs/ARCHITECTURE.md` §4 | One web code base: the same features on every platform (only native pen features are blocked). |
| Plans and one-time Special Edition | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02 forbids subscriptions, payment, plans and a content market; MedLevo is a single-owner tool (AI cost is tracked per call with a budget cap instead of credits). |
| Drawing-tablet input and session restore on Mac | both | **have** | `ink/input.ts` (pen-only mode, mouse writes, finger writing with palm heuristic), `CAPABILITY_MATRIX.md` | Pen tablets via Pointer Events (not tested on a device); session restore across devices (§46, `ws/session/useStudySession.ts`). |
| Page long-press quick menu and touch selection gestures | both | **partial** | Pinch zoom, swipe page turns and finger scrolling exist (`ws/reader/swipe.ts`, `ws/reader/BookCanvas.tsx`); no long-press menu on blank space. | **G67** Long-press page menu — effort S, P3 (see [G67](#g67)) |
| Apple Family Sharing of plans | paid | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02 forbids subscriptions, payment, plans and a content market; MedLevo is a single-owner tool (AI cost is tracked per call with a budget cap instead of credits). |
| Legacy GoodNotes 5 mode and plan fallback rules | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02 forbids subscriptions, payment, plans and a content market; MedLevo is a single-owner tool (AI cost is tracked per call with a budget cap instead of credits). |
| Goodnotes Lite (mainland China edition) | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02: one owner, one deployment; regional editions do not apply. |
| Device-maker bundles and pen-button shortcuts | paid | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | Commercial bundles are out of scope (§02); pen eraser buttons are already handled (`ink/input.ts`). |
| Public idea board, beta program and learning resources | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02: a single-owner tool has no vendor community; feedback loops are the Control Center and evaluation store (`srv/control`). |

### marketplace

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Marketplace | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | §02 forbids subscriptions, payment, plans and a content market; MedLevo is a single-owner tool (AI cost is tracked per call with a budget cap instead of credits). |

### UI/customization

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Toolbar customization and floating toolbar | both | **partial** | Priority-based overflow by measured width (`ink/InkToolbar.tsx` `visibleSlots`); no reorder/hide/dock, no recent-tool slot. | **G66** Toolbar customisation — effort M, P2 (see [G66](#g66)) |
| Keyboard shortcuts and Mac menu actions | both | **have** | `ink/InkProvider.tsx` (P/H/E/L/T/S, Ctrl/⌘ Z/Y/C/V/D), `ws/WorkspaceScreen.tsx` (page keys, Ctrl/⌘ F, `[` `]`, F), `web/app` (Ctrl/⌘ K search) | Shortcuts use `KeyboardEvent.code`, so they work on an Arabic keyboard layout. |
| Dark mode and OS design adoption | both | **have** | `web/design/tokens.css` (light/dark), `ink/palette.ts` (every ink token has light + dark values), `ws/model/paper.ts` (`--wk-paper-bg`) | §22 rules out glassmorphism everywhere, so OS «glass» styling is not copied. |
| Persistent vs one-shot tools with adaptive overflow | both | **partial** | Priority-based overflow by measured width (`ink/InkToolbar.tsx` `visibleSlots`); no reorder/hide/dock, no recent-tool slot. | **G66** Toolbar customisation — effort M, P2 (see [G66](#g66)) |
| Full-screen and distraction-free view | both | **have** | focus mode (Fullscreen API with CSS fallback) in `ws/chrome/TopBar.tsx` / `ws/WorkspaceScreen.tsx` | Focus mode hides chrome and panels (§23). |

### accessibility

| feature | tier | MedLevo status | evidence | gap / plan |
|---|---|---|---|---|
| Dark mode and system design adoption | both | **have** | `web/design/tokens.css` (light/dark), `ink/palette.ts` (every ink token has light + dark values), `ws/model/paper.ts` (`--wk-paper-bg`) | Better: ink colours resolve per paper tone, so black ink stays readable on dark note paper while original PDF pages stay white. |
| Keyboard shortcuts | both | **have** | `ink/InkProvider.tsx` (P/H/E/L/T/S, Ctrl/⌘ Z/Y/C/V/D), `ws/WorkspaceScreen.tsx` (page keys, Ctrl/⌘ F, `[` `]`, F), `web/app` (Ctrl/⌘ K search) | Shortcuts use `KeyboardEvent.code`, so they work on an Arabic keyboard layout. |
| Toolbar customization | both | **partial** | Priority-based overflow by measured width (`ink/InkToolbar.tsx` `visibleSlots`); no reorder/hide/dock, no recent-tool slot. | **G66** Toolbar customisation — effort M, P2 (see [G66](#g66)) |
| Marketplace accessibility support | both | **out of scope** | spec §02; AI cost: `usage_record` + budget in `srv/ai` | No marketplace exists (§02); accessibility is app-wide instead (see «Partial accessibility support»). |
| Languages and accessibility declarations | both | **have** | `docs/ARCHITECTURE.md` §4 (labels, focus traps, aria-live, 44 px targets), `web/design/*`, Arabic UI + `<bdi>` isolation in `shared/richtext.ts` | Better: right-to-left Arabic is first-class (the reference app has open RTL requests). |
| Partial accessibility support | both | **have** | `docs/ARCHITECTURE.md` §4 (labels, focus traps, aria-live, 44 px targets), `web/design/*`, Arabic UI + `<bdi>` isolation in `shared/richtext.ts` | Better: Arabic-first RTL UI, screen-reader labels and keyboard paths across the app; bidi-correct medical terms. |

## 5. Blocked — what unblocks each

| blocker | entries | what exists / what is needed |
|---|---|---|
| native iPad layer / real stylus | Stylus hardware integrations; Advanced stylus hardware integration | Needs a native iPad layer (UIKit/PencilKit) or a real stylus to verify; §27 forbids claiming it from simulated input. Evidence: `CAPABILITY_MATRIX.md` (double tap, squeeze, Scribble on canvas, PencilKit latency: «Not available on web (requires native)»); hover + eraser button implemented in `ink/input.ts`, untested on a device |
| native OS app (widgets, Siri) | Home-screen widgets; Favorites widget; Apple Shortcuts / Siri action for QuickNote | OS widgets / Siri Shortcuts need a native app. A PWA manifest `shortcuts` entry is the web substitute (see G37). Evidence: no native shell exists (`docs/REQUIREMENTS_MATRIX.md` §27: native layer Not Started — needs macOS/Xcode) |
| native Scribble / speech-to-text provider | Dictation and Scribble input; Apple Scribble in text fields | Scribble on the canvas needs native code; dictation needs a speech-to-text provider. iPadOS Scribble in ordinary text fields is a system feature, untested here. Evidence: `CAPABILITY_MATRIX.md` row «Scribble»; no speech-to-text provider (`docs/ARCHITECTURE.md` §1) |
| vision provider (handwriting recognition) | Handwriting-to-text conversion; Handwriting recognition languages; Convert handwriting to typed text; Handwriting-to-text conversion | Built (track F4) and tested with the test-only fake provider; needs a vision provider key. Designed for ar / en / mixed (the reference app lists no RTL languages). Evidence: `srv/annotations/recognition.ts` (job `ink.recognize`, derived reading, per-word uncertainty, owner correction, search index), `ws/handwriting/*`; capability `workspace.handwriting_recognition` = `requires_configuration` |
| embeddings provider | AI-powered semantic search | Needs an embeddings provider; keyword + exact Arabic-normalised search works today. Evidence: capability `search.semantic`; table `chunk_embedding` created but never written (`docs/ARCHITECTURE.md` §2) |
| ANTHROPIC_API_KEY (chat) | AI assistant chat (Ask mode) with citations; In-document AI assistant; Q&A with page references, summaries, practice questions, translation; Ask Goodnotes (Q&A over own notes, with citations) | Built: chat bound to the selection, page, version and Source Lock with claim-level citations (stricter than page references); needs ANTHROPIC_API_KEY. Evidence: `srv/studybook/chat.ts`, `ws/studybook/ChatPanel.tsx`, evidence aliases + claim validation in `srv/evidence/*` |
| ANTHROPIC_API_KEY (+ speech-to-text for audio) | AI summaries; Audio summaries and linked timestamps; AI audio/lecture summaries and timestamps | Built with coverage tracking (§31: never «complete» when pages are missing); needs ANTHROPIC_API_KEY (audio summaries also need speech-to-text). Evidence: `ws/studybook/SummaryPanel.tsx`, `srv/studybook/generate.ts` (summary types, coverage tracking) |
| ANTHROPIC_API_KEY (explain) | Explain, simplify and translate | Built with Source Lock and a real-patient guard; needs ANTHROPIC_API_KEY. Evidence: `srv/studybook/explain.ts` (explain / simplify / translate / explain_image), `ws/model/aiActions.ts` |
| ANTHROPIC_API_KEY (question generation) | Quiz / practice-question generator from notes; AI quiz / practice questions (Quiz Me) | Built: evidence-checked MCQ generation from the lecture or a selection (unsupported items go to review, not to the owner); needs ANTHROPIC_API_KEY. Evidence: `srv/exams` generation pipeline (distractor validation, evidence), `ws/panels/CreateMcqPanel.tsx` |
| speech-to-text provider | Transcription (on-device and cloud); AI for meetings/lectures: live summary and generated notes; Live transcription (on-device or cloud); Transcription (live, 99 languages); Multilingual live summary with translated view | Automatic transcription needs a speech-to-text provider; manual / imported transcripts, corrections and search already work. Evidence: `srv/media/transcripts.ts`, `srv/media/subtitles.ts` (manual segments, VTT/SRT import, corrections with history, transcript search) |

## 6. Gap plans (MedLevo design + going further for medical study)

Each gap lists the inventory entries it covers, what exists today, MedLevo's own design, and the medical-study
extension. All plans keep the non-negotiables of `docs/ARCHITECTURE.md` §0: writing never waits for the network,
ink is never replaced by a derived result, generated content stays labelled, nothing is shown as working before it
works (capability registry), single owner.

### G01

**Pen feel tuning (stabilisation, taper, pressure floor)** — area: pens & ink · status: partial · effort S · priority P3

* **Covers:** Pen tool with three nib styles; Stroke stabilization and low-latency ink; Ink response tuning; Stroke stabilization and smoothing; Low-latency inking and pen ergonomics
* **Today:** Nibs and curves are fixed: `ink/math.ts` `smoothPoints(points, radius = 2)`, pressure curves per nib; predicted + coalesced events and a `desynchronized` live canvas exist (`ink/layerController.ts`).
* **Plan:** Add per-nib settings to `ink/prefs.ts` (smoothing radius 0–6, pressure floor, round/sharp taper, constant-width toggle) and pass them to `render.ts`; two named profiles («كتابة» low smoothing, «رسم دقيق» high). Measure latency per device in the capability panel instead of claiming it.
* **Medical-study extension:** An «تشريح» drawing profile (high stabilisation, thin constant line) for tracing structures, remembered per notebook; latency numbers recorded in `CAPABILITY_MATRIX.md` per real device.

### G02

**Palm-rejection settings** — area: pens & ink · status: partial · effort S · priority P3

* **Covers:** Handwriting sensitivity and palm rejection; Palm rejection settings
* **Today:** Web heuristic in `ink/input.ts` (pen-only mode, contact > 44 px = palm, 400 ms after pen lift, second pointer cancels); system palm rejection needs native (CAPABILITY_MATRIX).
* **Plan:** Expose the heuristic as owner settings (sensitivity low/medium/high mapped to the size and time thresholds; hand side) and show the active values in «قدرات القلم على هذا الجهاز»; keep native palm rejection marked blocked.
* **Medical-study extension:** Default hand posture for Arabic writers (right-to-left line progress means the palm rests on already-written ink) and a quick on-device test page that records whether stray marks occurred.

### G03

**Per-tool colour slots, synced presets and a meaning legend** — area: pens & ink · status: partial · effort M · priority P2

* **Covers:** Custom colors and color picker; Per-tool color presets with custom colors
* **Today:** 6 pen + 5 highlighter tokens and one custom `#rrggbb` (`ink/palette.ts`, `ink/InkToolbar.tsx`); one preset per tool kept in `localStorage` only (`ink/prefs.ts`).
* **Plan:** Up to 12 colour slots per tool (tokens or hex), reorder/remove/reset, stored in owner settings (`/api/settings`) so they follow the owner to every device; keep tokens so dark paper stays readable.
* **Medical-study extension:** A colour legend: the owner names what each slot means (e.g. red = contraindication, blue = mechanism, green = drug). The label travels with the stroke, is read out to screen readers (§55: never colour alone) and powers «show only my contraindication ink» filters and search.

### G04

**Dashed / dotted stroke styles** — area: pens & ink · status: partial · effort S · priority P3

* **Covers:** Stroke presets: line pattern and thickness
* **Today:** Thickness presets thin/medium/thick in `ink/SelectionOverlay.tsx`; `InkStyle` has no dash field (`shared/annotations.ts`).
* **Plan:** Add `InkStyle.dash: 'solid' | 'dash' | 'dot'` (server schema in `srv/annotations/schemas.ts`), render with `setLineDash` scaled to page units, saved per slot.
* **Medical-study extension:** Conventions the owner can adopt: dashed = «to verify against the source», dotted = hidden/deep structures or referred-pain paths on anatomy drawings.

### G05

**Highlight inside typed text** — area: pens & ink · status: missing / partial · effort S · priority P3

* **Covers:** Typed-text highlighting; Highlighter tool
* **Today:** `RichText` marks are `b i u sup sub em` only (`shared/richtext.ts`); text boxes are plain `<textarea>` (`ink/InkLayer.tsx`).
* **Plan:** Add a highlight mark with a highlighter colour token to `runSchema`; render it in text boxes, stickies and notes so it moves with the words.
* **Medical-study extension:** Highlighted runs that are medical terms link to the Terms dictionary (`srv/studybook/terms.ts`) and can be turned into cloze cards in one step.

### G06

**Pencil nib with graphite texture** — area: pens & ink · status: missing · effort M · priority P2

* **Covers:** Pencil tool; Pencil tool (graphite texture)
* **Today:** `INK_TOOLS` = pen, fountain, ball, highlighter (`shared/annotations.ts`); no textured nib.
* **Plan:** Add a `pencil` tool: pressure → opacity + width, a small tiled grain pattern applied in `render.ts`, its own presets; keep the stored data the same `InkData` (points only).
* **Medical-study extension:** Shading for anatomy and histology sketches; combined with tracing layers (G23) the owner can trace a structure over an atlas figure and shade it.

### G07

**Eyedropper colour picker** — area: pens & ink · status: missing · effort S · priority P3

* **Covers:** Eyedropper color picker
* **Today:** No sampler in `ink/InkToolbar.tsx`.
* **Plan:** Use the `EyeDropper` API where available (Chromium), else sample the rendered page canvas under the pointer; save the colour into a slot (G03).
* **Medical-study extension:** Pick a stain colour from a histology image (H&E pink/purple, special stains) to label structures in the matching colour.

### G08

**Ruler and measuring guide** — area: pens & ink · status: missing · effort M · priority P2

* **Covers:** Ruler; Ruler tool
* **Today:** `InkToolId` has no ruler (`ink/types.ts`).
* **Plan:** An on-page ruler overlay (two-finger rotate, angle readout, snap pen strokes to its edge) in normalized page units, never saved as ink.
* **Medical-study extension:** Owner-calibrated measurement on images: set the scale from a scale bar, then measure lengths/angles (e.g. practice cardiothoracic ratio or a Cobb angle) — always labelled «تقدير تعليمي», never a clinical measurement.

### G09

**Zoom writing window with auto-advance** — area: pens & ink · status: missing · effort M · priority P2

* **Covers:** Zoom window; Zoom Window with auto-advance; Zoom/magnified writing area
* **Today:** No magnified writing strip; the ink engine already stores points in zoom-independent page space (`ink/math.ts`, AC-21).
* **Plan:** A docked magnifier that maps its strokes into a small target box on the page, advancing in the writing direction and wrapping lines; size, magnification and line return adjustable.
* **Medical-study extension:** Right-to-left auto-advance for Arabic (a request the reference app has open) and tiny labels on dense anatomy / histology figures.

### G10

**Handwriting editing: insert space, straighten, reflow** — area: pens & ink · status: missing · effort L · priority P3

* **Covers:** Smart Ink handwriting editing (reflow, straighten, align, insert space); Edit Handwriting / handwriting reflow; Smart Ink handwriting editing (reflow, straighten, space)
* **Today:** No ink layout tools; recognition lines exist only as a derived reading (`srv/annotations/recognition.ts`).
* **Plan:** Phase 1: «أفسح مكانًا» tool that pushes every item below a drawn line down (one undo step); straighten/align selected strokes by fitting a baseline. Phase 2: reflow words using recognition line/word boxes when a provider is configured.
* **Medical-study extension:** Make room under a lecture paragraph on an inserted note page without overlapping; re-wrap a handwritten differential list after adding an item.

### G11

**Neat-copy view of handwriting** — area: pens & ink · status: missing · effort L · priority P3

* **Covers:** Restyle handwriting; Restyle handwriting (Smart Ink); Restyle (handwriting beautification)
* **Today:** Ink is always rendered as written (`ink/render.ts`); §28 requires the original ink to be kept.
* **Plan:** A derived, toggleable «نسخة مرتبة» rendering (baseline straightening, size normalisation, smoothing) that never changes stored strokes; offered per page.
* **Medical-study extension:** Neat copy used for exports and revision packs while the original stays the evidence of what was written in the lecture.

### G12

**Medical-term completion while typing** — area: pens & ink · status: missing · effort S · priority P3

* **Covers:** Handwriting word autocomplete (experimental); Handwriting word completion/prediction
* **Today:** No completion in text boxes / notes (`ink/InkLayer.tsx`, `ws/panels/MineTab.tsx`).
* **Plan:** Inline suggestions in typed text from the Terms dictionary and Course Brain concepts (Arabic + English), accepted with Tab; not on ink.
* **Medical-study extension:** Suggests the exact spelling used in the owner's sources (drug and eponym names) and inserts it as a `term` run with correct LTR isolation.

### G13

**Medical spellcheck for notes and recognised handwriting** — area: pens & ink · status: missing · effort M · priority P3

* **Covers:** Handwriting spellcheck; Handwriting spellcheck in your own handwriting; Handwriting spellcheck and suggestions
* **Today:** No spellcheck; recognised text and owner corrections are stored in `ink_recognition` (`srv/annotations/recognition.ts`).
* **Plan:** Check typed notes and the derived recognised text against the Terms dictionary + a personal word list; flags appear on the derived text only, the ink is never rewritten. Handwriting part depends on the recognition provider.
* **Medical-study extension:** Look-alike drug-name and unit warnings (e.g. hydroxyzine / hydralazine, mg / mcg) shown as «تحقّق من هذا», using the same critical-token rules as the evidence checker (`srv/evidence`).

### G14

**Ink gestures: scribble-to-erase, circle-to-select, multi-finger undo** — area: pens & ink · status: missing / partial · effort M · priority P2

* **Covers:** Eraser with scribble-to-erase gesture; Keyboard shortcuts and gesture undo/redo; Multi-finger undo/redo gestures; Scribble-to-erase pen gesture; Circle-to-lasso pen gesture; Ink gestures
* **Today:** Only hold-to-shape exists (`ink/layerController.ts` `HOLD_MS`); undo/redo via buttons and Ctrl/⌘ Z (`ink/InkProvider.tsx`).
* **Plan:** Recognise after commit (like shape recognition): dense zig-zag over strokes → erase them as one undoable step with an announcement; closed loop + hold → lasso selection; two-/three-finger double tap → undo/redo when fingers are not writing (pen-only). Each gesture can be turned off.
* **Medical-study extension:** Circle a printed term + hold → open it in the Terms dictionary / Evidence Peek; a check-mark on a question number marks it for revision («أضف إلى المراجعة»).

### G15

**Selective eraser, clear page and delete by type** — area: eraser · status: missing / partial · effort M · priority P2

* **Covers:** Selective / precision eraser; Bulk delete by content type; Erase filter by stroke type; Clear page and auto-deselect; Eraser with Selective Eraser mode; Clear Page / Delete Specific Items
* **Today:** Point and stroke erasers act on all strokes and shapes (`ink/eraser.ts`, `ink/layerController.ts`); no type filter, no clear-page action.
* **Plan:** Eraser filter (pen / highlighter / shapes / text highlights); «امسح الصفحة» and «احذف كل … في الدفتر» with an impact count, done as tombstones in one undo step (nothing hard-deleted, §47).
* **Medical-study extension:** A non-destructive «نسخة نظيفة للمراجعة» view that hides chosen kinds (e.g. all highlights) to re-read a lecture cold, instead of erasing them.

### G16

**Image crop and cut a region from a page** — area: lasso · status: missing / partial · effort M · priority P1

* **Covers:** Image crop / cut-out; Region screenshot; Insert, paste and crop images; Images tool
* **Today:** Images insert with aspect-kept resize but no crop (`ink/images.ts`, `docs/modules/ink.md` F1 limits); no region screenshot.
* **Plan:** Non-destructive crop box on `ImageAnnotationData`; «قص منطقة» on a lecture page creates an image item that keeps its provenance (source, version, page id, bbox, region ids).
* **Medical-study extension:** A cut region stays a citable excerpt: it can become an image-occlusion card, an «اشرح الصورة» request or a figure reading with the exact source link (AC-08 rules for uncertain labels).

### G17

**Lasso type filter and rectangle mode** — area: lasso · status: partial · effort S · priority P3

* **Covers:** Lasso selection with type filter
* **Today:** Freehand loop + tap with fixed membership rules (`ink/store.ts`, `test/ink/lasso.test.ts`).
* **Plan:** Filter chips (ink / shapes / text / images / links) and a rectangle mode; remembered per document.
* **Medical-study extension:** «Only my ink» selection over a dense annotated lecture page, so printed-text highlights are never moved by accident.

### G18

**Lasso → card / question / element / screenshot** — area: lasso · status: partial · effort M · priority P1

* **Covers:** Universal object menu actions
* **Today:** Lasso menu has copy, order, lock, recognise, ask (`ink/SelectionOverlay.tsx`); card / question from a lasso is Not Started (§28 row in `docs/REQUIREMENTS_MATRIX.md`).
* **Plan:** Add «أنشئ بطاقة», «أنشئ سؤالًا», «احفظ كعنصر», «لقطة» to the lasso menu: the selection's strokes + the printed paragraph beside them (as `ask-context` already finds) become the card/question draft through the existing `/learning/cards` and Create-MCQ flows.
* **Medical-study extension:** Cards keep the page, region and evidence ids, so «افتح المصدر» lands on the exact place; handwritten answers on the back are reviewed with FSRS — spaced review of the owner's own handwriting.

### G19

**Free resize, rotation for text/images, keyboard nudge** — area: lasso · status: partial · effort M · priority P2

* **Covers:** Object scaling/resizing/rotation model and quick selection
* **Today:** Uniform resize only; text boxes and pictures move their centre when rotated (`docs/modules/ink.md` limits); no keyboard nudge (ink review «still open»).
* **Plan:** Per-kind resize handles (free for shapes/text/stickies, proportional for images, Shift/Alt modifiers), real rotation for text boxes and images, arrow-key nudge for the selection (also closes the accessibility gap).
* **Medical-study extension:** Keyboard-only labelling of figures for owners who annotate with a keyboard.

### G20

**Shape fill, corners, labels and more shapes** — area: shapes · status: partial · effort M · priority P2

* **Covers:** Shapes tool; Shape styling; Shapes tool and automatic shape recognition
* **Today:** `ShapeData.shape` = line | arrow | rect | ellipse with colour/width/rotation (`shared/annotations.ts`); no fill, labels or rounded corners.
* **Plan:** Add `fill`, `corner`, `label` (RichText inside the shape) and shape types (triangle, polygon, curved/double arrow); change type from the lasso menu.
* **Medical-study extension:** Pathway arrow heads used in physiology and pharmacology — activation (→), inhibition (⊣), conversion/transport (⇢) — so mechanism diagrams are drawn with the standard notation.

### G21

**Connectors and quick diagramming** — area: shapes · status: missing · effort L · priority P2

* **Covers:** Connectors and quick diagramming; Diagramming: connectors, quick diagram, text in shapes; Smart connectors and Quick Diagramming
* **Today:** Owner shapes have no anchors; generated flowcharts/timelines exist only as AI artifacts (`srv/studybook/diagrams.ts`, `web/features/studybook/diagrams/layout.ts`).
* **Plan:** Connectors attached to shape edge points that follow moves; tap an edge dot to add a connected shape; elbow/curve with control points; reuse `diagrams/layout.ts` for «رتّب تلقائيًا».
* **Medical-study extension:** Typed medical graphs: nodes can be bound to Course Brain concepts and edges to relation types (causes, inhibits, treats, complicates), checked against the knowledge map; a «hide nodes» quiz turns the owner's diagram into recall practice.

### G22

**Snapping and alignment guides** — area: shapes · status: missing · effort M · priority P2

* **Covers:** Object snapping and alignment guides; Smart alignment guides; Snapping, alignment guides, smart spacing
* **Today:** Only rotation snaps (15°) in `ink/SelectionOverlay.tsx`.
* **Plan:** During lasso drags show centre/edge guides to nearby items and to the paper grid pitch (`ws/model/paper.ts`); toggle in settings.
* **Medical-study extension:** Snap to the lecture's processed regions (lines, paragraphs, figure boxes from `source_region`) so labels and boxes align with the printed content.

### G23

**Owner layers (show / hide / lock / active layer)** — area: shapes · status: partial · effort L · priority P1

* **Covers:** Layers; Layers; Layers
* **Today:** Items carry `layer` (ink / highlight / text / media) and `z` (`shared/annotations.ts`); highlights draw on their own canvas; no owner-managed layers.
* **Plan:** Up to 5 named layers per page or notebook (`annotation.layer_id`), active layer for all tools, show/hide/lock, export only visible layers.
* **Medical-study extension:** Anatomy tracing layers: trace bones, muscles, nerves and vessels on separate layers over an atlas figure, hide one to self-test; an «إجابات» layer is hidden automatically in «امتحن نفسك» mode (`ws/modes/arrangement.ts`).

### G24

**Cover-and-reveal tape for active recall** — area: tape · status: missing · effort M · priority P1

* **Covers:** Tape tool (cover and reveal); Tape tool for active recall
* **Today:** No tape tool (`ink/types.ts`); image occlusion exists for cards (`srv/learning/cards.ts`, `web/features/review/local/occlusion.ts`).
* **Plan:** A `tape` item kind (opaque stroke or box) that taps to reveal / re-hide in any tool, including the hand tool; reveal state is a view state, not an edit; exports choose covered or uncovered.
* **Medical-study extension:** Every tape is a recall item: revealing asks Again/Hard/Good/Easy and records a `review_event` on a page-anchored card, so taped answers on lecture pages join the FSRS schedule; «امتحن نفسك» re-covers all tapes.

### G25

**Rich formatting in text boxes and notes** — area: text · status: missing / partial · effort M · priority P1

* **Covers:** Text boxes with rich formatting; Text boxes with rich formatting; Auto lists and nesting; Text boxes and sticky notes; Scientific and technical formatting in Text Documents
* **Today:** `RichText` supports bold/italic/underline/sup/sub, headings, lists, quotes and term/unit/formula runs (`shared/richtext.ts`), but the editors are plain `<textarea>`s converted by `richTextFromPlain` (`ink/InkLayer.tsx`, `ws/panels/MineTab.tsx`).
* **Plan:** A small formatting bar + Markdown-style auto lists (`- `, `1. `) and indent/outdent mapped to the existing RichText model; pinned text tool; text box styles.
* **Medical-study extension:** Chemical and lab notation typed correctly inside Arabic lines (CO₂, HCO₃⁻, 10⁹/L) with the existing bidi isolation; term runs link to the Terms dictionary.

### G26

**Font choice in text boxes** — area: text · status: missing · effort S · priority P3

* **Covers:** Custom fonts
* **Today:** Bundled IBM Plex Sans Arabic + Noto Naskh Arabic only (`docs/ARCHITECTURE.md` §1).
* **Plan:** Offer the bundled families plus one bundled monospace; optional Local Font Access where the browser allows it; never remote fonts (offline-first).
* **Medical-study extension:** A clear Naskh option for long Arabic explanations next to Latin terms.

### G27

**Notes pinned to objects, with open / resolved state** — area: text · status: partial · effort M · priority P2

* **Covers:** Comments anchored to content; Comments; Comments
* **Today:** Notes anchor to a page / quote / block (`AnnotationAnchor` in `shared/annotations.ts`); stickies sit on the page; no anchoring to an ink or image item, no resolve state.
* **Plan:** Anchor type `annotation` (a note follows the stroke/shape/image it comments on); `status: open | resolved`; filter «أسئلتي المفتوحة» per lecture. Single owner, so no usernames or sharing.
* **Medical-study extension:** An open question can be sent to the rail («اسأل عن المحدد» with the paragraph) and, once resolved, turned into a card; unresolved questions surface in One-Tap Revision.

### G28

**Owner element library (reusable content and stamps)** — area: elements/stickers · status: missing · effort M · priority P2

* **Covers:** Elements library (reusable content); Built-in sticker, stamp and mind-map shape collections; Elements (reusable content library); Elements, stickers, stamps, washi tape
* **Today:** No element store; copy/paste only within the session (`ink/store.ts` clipboard).
* **Plan:** «احفظ كعنصر» from the lasso into named collections (synced like annotations, pictures via `/api/annotations/images`); insert by tap or drag; images from the owner's files can seed a collection.
* **Medical-study extension:** Owner-made medical stamps — body/dermatome outlines, ECG strip, drug-card frame, vitals stamp with typed fields (HR, BP, RR, T, SpO₂) that stay searchable. Only the owner's own drawings and files; no bundled third-party assets.

### G29

**Camera capture and photo as a page** — area: images · status: missing / partial · effort M · priority P3

* **Covers:** Insert images and camera photos; Image or photo as a full page; In-app camera capture onto page
* **Today:** Image tool accepts files and paste (`ink/images.ts`, `accept="image/png,image/jpeg,image/webp,image/gif"`); image sources become pages with OCR; no in-app camera, no picture-as-note-page.
* **Plan:** «التقط صورة» (getUserMedia, or `<input capture>` on phones) onto the current page, and «صفحة من صورة» that creates a note page with the picture as its background; same local-first upload path.
* **Medical-study extension:** Capture a lecture whiteboard or a lab-practical specimen with a privacy reminder (§49: no patient identifiers) and an optional blur tool before upload.

### G30

**Document scanner flow** — area: images · status: partial · effort M · priority P3

* **Covers:** Document scanner with OCR; Document scanning with searchable text
* **Today:** Photos / scans upload as sources and get Tesseract `ara+eng` OCR, so their text is searchable (`srv/processing/ocr.ts`); no capture-time edge detection or multi-page scan.
* **Plan:** A scan screen: capture several pages, auto-crop + perspective fix + contrast in the browser (canvas), then one upload as a multi-page source.
* **Medical-study extension:** A scanned past paper goes straight into question extraction (Question Vault, Exam DNA); a scanned handout becomes a lecture with regions and citations.

### G31

**Paper size, orientation, colour and more patterns** — area: paper templates · status: partial · effort M · priority P2

* **Covers:** Paper templates with adjustable size and color; Notebook creation with template library; Change template per page; Paper templates and custom paper; Dynamic (resizable, recolorable) templates and creator template format
* **Today:** Four patterns blank / ruled / dotted / grid (`NOTE_PAGE_TEMPLATES` in `shared/annotations.ts`, `ws/model/paper.ts`), changeable per page; every page is A4 portrait (`NOTE_PAGE_SIZE` in `ws/data/notePages.ts`).
* **Plan:** Page sizes (A4, A5, Letter, landscape), paper tone tokens (warm, grey, dark), Cornell and two-column layouts, defaults remembered per notebook; patterns stay vector/token based so dark mode keeps contrast.
* **Medical-study extension:** A «lecture-matched» size: a note page inserted after a lecture page takes that page's size and orientation, so side-by-side and printed packs line up.

### G32

**Custom and clinical page templates** — area: paper templates · status: missing · effort L · priority P1

* **Covers:** Custom templates and covers from PDF or image; AI template generation; Custom templates and covers
* **Today:** No custom templates; library «templates» are folder structures for 12 subjects (`srv/library/templates.ts`).
* **Plan:** Templates from the owner's own PDF page or image, plus MedLevo-original structured templates whose fields are page regions; an optional AI step may tailor a checklist from the lecture with citations (needs the key).
* **Medical-study extension:** Clinical templates: SOAP note, history taking (HPI / PMH / DH / FH / SH / ROS), OSCE station checklist (linked to the cases module checklist), drug card (class, mechanism, indications, contraindications, ADRs, dose), lab-values sheet, ECG grid. Handwriting inside a field is searchable by field («كل حقول موانع الاستعمال»).

### G33

**Planner ↔ calendar files** — area: paper templates · status: partial · effort M · priority P3

* **Covers:** Planner with calendar event sync; Calendar events inside planners
* **Today:** Deterministic planner with owner days and rebalancing (`srv/learning/planner.ts`, `web/features/planner`); no calendar sync.
* **Plan:** One-way `.ics` export of plan tasks and the exam date, and `.ics` import of a lecture timetable as a file (no OAuth, no external fetch, §49).
* **Medical-study extension:** Lecture and clinical-rotation timetables let the planner schedule pre-reading for tomorrow's lecture/rotation topic and post-lecture review at +1/+3/+7 days.

### G34

**Handwritten study log per plan day** — area: paper templates · status: partial · effort S · priority P3

* **Covers:** Planners and journaling
* **Today:** Planner days and task check-off exist (`web/features/planner`); no writable planner pages.
* **Plan:** A «سجل اليوم» note page per plan day (template with the day's tasks printed in), linked to the tasks; a weekly summary built from real data (no AI needed).
* **Medical-study extension:** Reflection prompts tied to the Weakness Center («ما الذي أخطأت فيه اليوم؟») that can be turned into cards.

### G35

**Infinite canvas (concept / case board)** — area: notebooks & covers · status: missing · effort L · priority P2

* **Covers:** Whiteboard templates; Whiteboards (infinite canvas); Whiteboard document (infinite canvas); Whiteboards (infinite canvas)
* **Today:** Pages are fixed-size sheets (`ws/reader/BookCanvas.tsx`); the ink engine has a spatial index that could back tiling (`ink/spatial.ts`).
* **Plan:** A `board` note kind: unbounded coordinates, tiled canvases, minimap, background pattern; same ink engine, sync and undo.
* **Medical-study extension:** A concept / case board: drop source regions, cards, questions and Course Brain concepts as live linked nodes (citations kept) and draw differential-diagnosis trees or pathophysiology maps around them; every node opens its exact source page.

### G36

**Typed document / full-page typing (block editor)** — area: notebooks & covers · status: missing / partial · effort L · priority P2

* **Covers:** Text Documents (block editor); Full-page typing; Text Document (block editor); Text Documents (typed docs)
* **Today:** Notes are RichText (headings, lists, quotes in the model) but edited as plain text (`ws/panels/MineTab.tsx` `NoteEditor`); Study Book blocks are generated (`srv/studybook`); no typed page.
* **Plan:** A block editor on the RichText model (headings, lists, checklists, tables, quotes, images) with a slash menu, usable as a full-page typed note page and as the rail note editor; DOCX/Markdown export already exist (`srv/data/export.ts`, `docx.ts`).
* **Medical-study extension:** Blocks that embed live evidence (a quote block keeps its evidence id and chip), question and card blocks, and comparison tables checked cell by cell like §31 Compare.

### G37

**Quick note (one tap, file later)** — area: notebooks & covers · status: missing · effort M · priority P1

* **Covers:** Quicknotes; QuickNote; QuickNotes
* **Today:** New pages are created inside a chosen notebook or after a lecture page (`ws/notebook/NotebookScreen.tsx`, top-bar menu); no inbox, no PWA `shortcuts` / share target in `apps/web/vite.config.ts`.
* **Plan:** «ملاحظة سريعة» from Home and the global nav + a PWA manifest shortcut; it lands in a «الوارد» notebook and can later be moved, merged or inserted after a lecture page.
* **Medical-study extension:** Ward-round / clinic quick note opening on a SOAP template with a «no patient identifiers» reminder, and topic suggestions from Course Brain to file it.

### G38

**Page management: duplicate, rotate, multi-select, move to another notebook** — area: notebooks & covers · status: partial · effort M · priority P1

* **Covers:** Page management; Page management; Page management
* **Today:** Add, rename, change paper, reorder, trash / restore note pages (`ws/notebook/NotePagesList.tsx`, `ws/data/notePages.ts`); no duplicate, rotate, multi-select or cross-notebook move.
* **Plan:** Duplicate (new ids, ink copied), rotate, multi-select with bulk move/trash/export, move/copy pages to another notebook or after a lecture page; all local-first and undoable.
* **Medical-study extension:** «نسخة فارغة للاختبار»: duplicate a page keeping template and printed content but dropping the answers layer, to redo a drawing from memory.

### G39

**Document tabs and windows** — area: notebooks & covers · status: partial · effort M · priority P3

* **Covers:** Document tabs and multiple windows; Document tabs and multiple windows; Document tabs and multi-window
* **Today:** One document + a writable split pane (`ws/split/SplitPane.tsx`); several browser tabs stay consistent via BroadcastChannel (`ink/events.ts`); no in-app tab strip.
* **Plan:** A tab strip of open sources/notebooks (each tab restores its study session), «افتح في نافذة جديدة», reopen closed tab.
* **Medical-study extension:** Saved tab sets: lecture + reference + question source pinned together and restored as one study session (§46).

### G40

**Library multi-select and bulk actions** — area: folders/library · status: partial · effort M · priority P3

* **Covers:** Nested folders with custom colors; Library views, filter, search and bulk actions
* **Today:** Single-item move / archive / trash with impact (`web/features/library`); no multi-select; folder colours are 8 tokens by design.
* **Plan:** Multi-select (checkbox mode, Shift-range, keyboard) with bulk move / archive / trash / tag / favourite and one impact preview; grid/list toggle.
* **Medical-study extension:** Bulk tagging by system / rotation with Course Brain topic suggestions.

### G41

**Duplicate and merge notebooks** — area: folders/library · status: missing · effort M · priority P3

* **Covers:** Merge notebooks; Duplicate documents
* **Today:** No duplicate or merge for notebooks (`srv/library`, `srv/annotations`).
* **Plan:** Duplicate a notebook (note pages + ink + pictures, new ids) and merge a notebook or chosen pages into another; impact preview; sources themselves are content-addressed, so a copy is a new study context, not new bytes.
* **Medical-study extension:** «Fork for a new exam cycle»: copy last year's notebook while keeping the original read-only as a reference.

### G42

**Title and filing suggestions** — area: folders/library · status: partial · effort S · priority P3

* **Covers:** AI title suggestion and auto-organization
* **Today:** Source type suggestion and topic link suggestions with reasons exist (`srv/sources`, `/api/brain/topics/suggest`); no title suggestion for notebooks / note pages.
* **Plan:** Suggest a title from the first heading, recognised handwriting or the linked lecture; shown as a suggestion with its reason, never applied silently.
* **Medical-study extension:** Suggest the folder (subject → course → lecture) and Course Brain topic to file a quick note under.

### G43

**Owner-built outlines** — area: outline & links · status: partial · effort M · priority P2

* **Covers:** Outlines (table of contents); Document outlines; AI-generated outline; Outlines / table of contents
* **Today:** Outline from the PDF outline or detected heading regions (`ws/panels/LeftPanel.tsx`) — deterministic, no AI; the owner cannot add, nest or rename entries.
* **Plan:** Owner outline entries (page + optional region, 3 levels, reorder, rename) stored as annotations and merged with the automatic outline; searchable; kept in exports.
* **Medical-study extension:** Outline seeded from Course Brain concepts / lecture objectives per page, with coverage marks (which entries already have cards or linked questions).

### G44

**Owner web links and links to study objects** — area: outline & links · status: partial · effort M · priority P2

* **Covers:** Hyperlinks; Internal and external hyperlinks; Hyperlinks and bookmarks
* **Today:** Page links to a lecture page (+ region) or a note page with back navigation (`LinkData` in `shared/annotations.ts`, `ws/notes/NotePageDialogs.tsx`); no owner URL links; not from text-box text.
* **Plan:** Owner URL links (http/https only, confirmation like `pdfLinks.tsx`, never fetched by the server); links from text runs, stickies and shapes.
* **Medical-study extension:** Deep links to MedLevo objects — a question, card, case station or concept page — so a margin note can open the question that tested it.

### G45

**Search typed page items and note-page titles** — area: search & handwriting OCR · status: partial · effort M · priority P1

* **Covers:** Library-wide search; Unified search; Universal search (handwriting, typed, PDF, titles)
* **Today:** Universal search covers sources (incl. OCR), notes, questions, transcripts, recognised handwriting, generated content and chats (`srv/search/service.ts`); text boxes, stickies, link labels and note-page titles on pages are not indexed (`owner_content_fts` writers).
* **Plan:** Index text boxes, stickies, link labels and note-page titles in `owner_content_fts` from `srv/annotations/sync.ts` (normalised key, removed on tombstone); show them with their page.
* **Medical-study extension:** Synonym and abbreviation expansion from the Terms dictionary (MI ↔ myocardial infarction ↔ احتشاء العضلة القلبية); handwriting search across all lectures once recognition is configured, grouped by lecture and concept.

### G46

**Note polishing as a labelled derived note** — area: AI features · status: missing · effort M · priority P3

* **Covers:** AI writing tools for typed text (Edit AI); AI writing tools
* **Today:** No rewrite / proofread action for owner text; `ai_answer` notes exist (`NoteDTO.origin`).
* **Plan:** «نقّح ملاحظتي»: shorten / structure / proofread produces a NEW note labelled generated; the original stays (§03). Needs ANTHROPIC_API_KEY.
* **Medical-study extension:** Medical safety: negations, numbers, units, doses and laterality must survive the rewrite — checked with the critical-token rules of `srv/evidence` before the result is shown.

### G47

**Insert generated content onto a page (labelled)** — area: AI features · status: partial · effort M · priority P3

* **Covers:** Create Mode (AI that edits the document); Create mode (AI writes into the document); Create Mode / Edit AI
* **Today:** Generated content lives in Study Book artifacts, diagrams and saved AI answers labelled «مولَّد» (`srv/studybook/*`); nothing generated is placed on a note page; all AI needs the key.
* **Plan:** «ضعه في صفحتي»: a generated block/diagram becomes a read-only `generated` item on a note page with its citations and verification status, after a modify-before-insert preview; never mixed into owner ink.
* **Medical-study extension:** Inserted items re-check when the cited source changes (like AC-26 card impacts) and show «يحتاج مراجعة».

### G48

**Diagrams and mind maps from the owner's notes** — area: AI features · status: partial · effort M · priority P3

* **Covers:** AI diagram and mind-map generation; AI diagrams and mind maps from notes
* **Today:** Deterministic knowledge map (`srv/brain`, `web/features/brain/KnowledgeGraph.tsx`); evidence-checked AI flowcharts / timelines from lecture pages (`srv/studybook/diagrams.ts`, needs the key); nothing from owner notes.
* **Plan:** Allow notes and recognised handwriting as input (labelled as owner notes, never as evidence), a mind-map layout, and editable output via G21.
* **Medical-study extension:** Quiz diagrams with hidden nodes feeding FSRS; nodes cite evidence and link to concepts.

### G49

**Labelled schematic illustrations** — area: AI features · status: missing · effort L · priority P3

* **Covers:** AI image and doodle generation; AI image generation
* **Today:** No image generation; the media module already labels «رسم توضيحي مولَّد» and AC-09 never accepts generated images as real cases (`srv/media/validate-image.ts`).
* **Plan:** Prefer deterministic SVG schematics drawn from diagram / knowledge-map relations; if an image provider is ever added, outputs are always labelled generated and excluded from «real example» matching.
* **Medical-study extension:** Schematics with labelled structures can be turned into occlusion cards immediately.

### G50

**Owner connector for an external assistant** — area: AI features · status: missing · effort M · priority P3

* **Covers:** ChatGPT app and Claude connector; External chatbot integration; Claude connector
* **Today:** No external connector; generated content is always labelled (`NoteDTO.origin = ai_answer`).
* **Plan:** An owner-only connector (token-scoped MCP or import endpoint) that saves a conversation as a generated note in a chosen folder — never evidence, never raising trust (§03, §28).
* **Medical-study extension:** Optional read-only search of the owner's library with Source Lock, so an external assistant can cite pages without receiving whole files (§49).

### G51

**Stroke replay with the recording** — area: audio recording · status: missing / partial · effort M · priority P2

* **Covers:** Stroke replay modes; Audio recording synced with ink (note replay); Replay display modes; Audio recording synced to ink with stroke replay
* **Today:** Points carry time (`InkPoint` t) and strokes carry `audio_link.offset_ms` (`ink/audioLink.ts`); the player only seeks to one stroke's moment (`ws/audio/AudioUi.tsx`).
* **Plan:** Replay modes while the recording plays: progressive (draw strokes as written), spotlight (future ink faded), static; stroke markers on the timeline.
* **Medical-study extension:** Replay a lecture page where each stroke is a clickable timestamp; replay a handwritten case work-up to review the reasoning order.

### G52

**Playback speed, skip, silence skip, noise reduction** — area: audio recording · status: missing / partial · effort M · priority P2

* **Covers:** Playback controls and audio cleanup; Noise reduction on playback
* **Today:** Native `<audio controls>` (`ws/audio/AudioUi.tsx`, `web/features/media/AudioScreen.tsx`); seek to segments / strokes; no speed memory, skip-silence or noise reduction.
* **Plan:** Custom controls: 0.75–2× (remembered per recording), ±10 s, skip silence and a simple noise gate via Web Audio on the device, keyboard shortcuts.
* **Medical-study extension:** «Play what belongs to this page»: jump between segments and strokes linked to the page on screen.

### G53

**Recording control and recording across navigation** — area: audio recording · status: partial · effort M · priority P2

* **Covers:** Background recording; One-tap recording
* **Today:** Recording starts from the reader's view menu and stops when leaving the reader (`ws/WorkspaceScreen.tsx` `recorder.abandon()`).
* **Plan:** A record button in the ink toolbar and a global recording dock that survives in-app navigation; strokes in any open document get links, each to its own page.
* **Medical-study extension:** Record a whole lecture while switching between the lecture PDF and a reference; every stroke still points to the right second and page.

### G54

**Presentation / teach-back mode** — area: presentation/laser · status: partial · effort M · priority P3

* **Covers:** Presentation mode; Presentation mode on external display; Presentation mode with laser pointer
* **Today:** Laser pointer and focus mode exist (`ink/layerController.ts`, `ws/chrome/TopBar.tsx`); no audience-only view.
* **Plan:** An audience window (Presentation API / second window) that shows only the page and ink with the laser, while the presenter keeps tools.
* **Medical-study extension:** «اشرحها بصوتك» teach-back: record yourself explaining a page (Feynman method) with stroke links; good for viva and OSCE practice — no sharing involved.

### G55

**PDF form fields and saved signature** — area: PDF annotation & import · status: partial · effort M · priority P3

* **Covers:** PDF annotation, signing and form filling; PDF form completion by overlay (interactive fields not kept)
* **Today:** Writing, text boxes and pen signatures over PDF pages work; AcroForm fields are not read (pdf.js link annotations only in `ws/reader/pdfLinks.tsx`).
* **Plan:** Read form fields from pdf.js, fill them as `form_value` annotations (kept separate from the original, §03), and save a signature as a reusable element (G28).
* **Medical-study extension:** Logbook / competency forms filled offline and exported with the filled values.

### G56

**PDF export with ink (flattened / editable)** — area: export & sharing · status: missing / partial · effort L · priority P1

* **Covers:** Export, print and share; Export formats and scopes; Editable vs flattened PDF with searchable handwriting; Export content toggles; Print with page exclusion; Export and print
* **Today:** Markdown, print HTML, JSON with manifest, DOCX and Anki TSV exist (`srv/data/export.ts`, `docx.ts`, `srv/learning/anki.ts`), but ink is only counted: «لا تُصدَّر الكتابة بالقلم» (`export.ts` lines ~447/468/487); PDF = browser print.
* **Plan:** PDF export of pages with ink, highlights, text boxes and pictures flattened (server render: pdftoppm page + vector ink overlay) and an editable variant with ink as PDF annotations; page ranges; toggles for ink, highlights, backgrounds, layers and tape; recognised text as an invisible text layer; manifest kept.
* **Medical-study extension:** A «revision pack»: chosen lecture pages + my ink + linked cards/questions + a citation index; an «exam-clean» variant without the answers layer and with tapes covered.

### G57

**Scheduled automatic backups** — area: sync & backup · status: partial · effort M · priority P2

* **Covers:** Automatic backup to third-party storage; Automatic one-way backup to cloud storage; Auto Backup to third-party clouds
* **Today:** Backups via API/CLI with verified restore (`srv/data/backup.ts`, `restore.ts`); scheduling is left to cron (`docs/BACKUP_RESTORE.md`).
* **Plan:** An in-app schedule (daily / weekly, keep N generations, verify after create) to a configured local or mounted path (optional WebDAV), status in the Control Center; secrets never included.
* **Medical-study extension:** A reminder to snapshot before exam week, and the last verified restore report shown in the Control Center.

### G58

**Locked «sensitive» notebooks** — area: security · status: partial · effort M · priority P2

* **Covers:** Document password and biometric lock; Password-protected documents; Password-locked notebooks
* **Today:** The whole app is behind the owner login with session management (`srv/auth`, `web/features/settings`); no per-notebook lock; no WebAuthn.
* **Plan:** Mark notebooks sensitive: opening asks for a passkey / platform biometric (WebAuthn) or the password, auto-relock after inactivity; excluded from search results, AI context and offline packages while locked.
* **Medical-study extension:** Meant for clinical notes that might hold patient details (§49): a reminder not to store identifiers and a redaction tool for pictures and text.

### G59

**Erase-everything and per-category erase** — area: security · status: partial · effort S · priority P3

* **Covers:** Account deletion, data erasure and inactive-account policy
* **Today:** Full JSON export, backups and per-source purge with impact exist (`srv/data/export.ts`, `srv/sources/purge.ts`); no «erase all my data» action.
* **Plan:** Export-first «امسح كل بياناتي» with typed confirmation and an impact list, plus per-category erase (recordings, recognitions, chats).
* **Medical-study extension:** Erase recordings older than N months while keeping their transcripts and stroke links (privacy for lecture audio).

### G60

**Passkeys** — area: security · status: partial · effort M · priority P3

* **Covers:** Passwordless sign-in, provider-bound accounts and session limits
* **Today:** Password + recovery codes + session list with revoke + setup token (`srv/auth`, `web/features/settings`) — the reference app has no session screen; no passwordless option.
* **Plan:** WebAuthn passkeys as an additional sign-in method (recovery codes kept); new-device sign-in shown in the sessions list.
* **Medical-study extension:** Same passkey unlocks sensitive notebooks (G58).

### G61

**Flashcards with handwritten faces** — area: study tools (flashcards) · status: partial · effort L · priority P1

* **Covers:** Study Sets (flashcards); Study Sets (flashcard decks); Study Sets (flashcards with spaced repetition)
* **Today:** Basic, cloze, image-occlusion and from-mistake cards with FSRS (`srv/learning/cards.ts`, `web/features/review/CardEditor.tsx`); faces are text/images only; no lasso drag into cards.
* **Plan:** Ink faces: a small ink canvas per card side stored as annotations anchored to the card (same engine and sync); lasso → card (G18).
* **Medical-study extension:** Draw-from-memory cards (e.g. draw the brachial plexus) graded by comparing with the source figure side by side; the recognised text keeps them searchable.

### G62

**Card suggestions from a page or notes** — area: study tools (flashcards) · status: partial · effort M · priority P3

* **Covers:** AI-generated flashcards from notes; Flashcards generated from notes
* **Today:** Deterministic cards from a selection (exact excerpt + evidence) and from mistakes (`/learning/cards/from-selection`, `/from-mistake`); no generated card suggestions.
* **Plan:** A few evidence-checked suggestions per page or lasso (high-yield, §43 «no hundreds of poor cards»), each with its evidence; owner accepts one by one. Needs ANTHROPIC_API_KEY.
* **Medical-study extension:** Suggestions prefer lines linked to past exam questions (Exam DNA) and the owner's weaknesses.

### G63

**Read-aloud for cards and selected text** — area: study tools (flashcards) · status: partial · effort S · priority P3

* **Covers:** Practice mode, read-aloud and study keyboard shortcuts
* **Today:** Keyboard flow and review-ahead exist (`web/features/review/ReviewSession.tsx`); no read-aloud.
* **Plan:** Web Speech `speechSynthesis` with Arabic and English voices, reading runs in their own language (RichText `lang`).
* **Medical-study extension:** Hands-free listening mode for commuting: question → pause → answer → rate by voice later on the screen.

### G64

**Flashcard import (CSV / TSV / Anki text)** — area: study tools (flashcards) · status: partial · effort M · priority P2

* **Covers:** Flashcard import/export (CSV/TSV/TXT, Anki, Quizlet)
* **Today:** Anki-compatible TSV/ZIP export exists (`srv/learning/anki.ts`); no import route in `srv/learning/routes.ts`.
* **Plan:** Import two-column CSV/TSV and Anki text exports (cloze syntax kept), with duplicate detection (existing lexical check) and origin «مستورد».
* **Medical-study extension:** Imported cards are matched to lectures/concepts and show «لا دليل من مصادرك» until linked to evidence — imported decks never pose as sourced.

### G65

**Study timer and stopwatch** — area: study tools (flashcards) · status: partial · effort M · priority P2

* **Covers:** Time Keeper (timer and stopwatch); Time Keeper (timer and stopwatch)
* **Today:** Exam timers (time pressure, simulation) in `web/features/exams/RunnerScreen.tsx`; no timer in the reader / notebook.
* **Plan:** A reader timer (countdown presets, stopwatch with laps) whose sessions are logged to the study session per source and feed the planner's measured pace.
* **Medical-study extension:** OSCE station presets (reading time + station time + 1-minute warning) and MCQ pacing (~1–1.5 min per question) for self-made mocks.

### G66

**Toolbar customisation** — area: UI/customization · status: partial · effort M · priority P2

* **Covers:** Customizable and floating toolbar; Toolbar customization; Toolbar customization and floating toolbar; Persistent vs one-shot tools with adaptive overflow
* **Today:** Priority-based overflow by measured width (`ink/InkToolbar.tsx` `visibleSlots`); no reorder/hide/dock, no recent-tool slot.
* **Plan:** Owner reorder / hide / dock (top, side for left- or right-handed), recent-tool slot, insert tools return to the lasso; stored in settings.
* **Medical-study extension:** Mode-specific toolbars: «تعلّم» shows pens + highlighter, «امتحن نفسك» shows tape + lasso only (`ws/modes/arrangement.ts`).

### G67

**Long-press page menu** — area: platforms · status: partial · effort S · priority P3

* **Covers:** Page long-press quick menu and touch selection gestures
* **Today:** Pinch zoom, swipe page turns and finger scrolling exist (`ws/reader/swipe.ts`, `ws/reader/BookCanvas.tsx`); no long-press menu on blank space.
* **Plan:** Long-press on a blank spot → paste here, text here, sticky here, note page after this page.
* **Medical-study extension:** Long-press on printed text → «عرّف» (Terms dictionary) and «أضف إلى المراجعة».

### G68

**Picture covers** — area: notebooks & covers · status: partial · effort S · priority P3

* **Covers:** Covers as first page
* **Today:** Covers are tokens: 8 colours × 4 styles × medical icons (`shared/library.ts`), shown on the notebook (`NotebookScreen.tsx`).
* **Plan:** Optional cover picture from the owner's files (stored like annotation images), keeping the token cover as the fallback.
* **Medical-study extension:** Cover subtitle with the course's next due revision written as a sentence (no counters, §23).

### G69

**Per-document settings** — area: notebooks & covers · status: partial · effort S · priority P3

* **Covers:** Per-document details and settings
* **Today:** Per-device session restore (page, zoom, layout, rail, mode) in `ws/session/useStudySession.ts`; source details in `web/features/sources/SourceScreen.tsx`; no per-document recognition language or defaults.
* **Plan:** A details sheet per notebook/source: recognition language (ar / en / mixed), default paper, pen-only, layout, last sync state.
* **Medical-study extension:** Default Source Lock and explanation level per lecture, shown in the same sheet.

### G70

**Strike-out, define and read aloud on PDF text** — area: PDF annotation & import · status: partial · effort S · priority P3

* **Covers:** PDF text actions
* **Today:** Selection toolbar: highlight, underline, copy, note, explain / simplify / translate / ask / compare / MCQ / card / revision (`ws/selection/SelectionToolbar.tsx`, `ws/model/aiActions.ts`).
* **Plan:** Add `strike` style to `text_highlight`, «عرّف» from the Terms dictionary (works offline once downloaded), and read-aloud.
* **Medical-study extension:** Definitions come from the owner's own sources with a citation, not from a generic dictionary.

### G71

**Send files to MedLevo from other apps** — area: PDF annotation & import · status: missing / partial · effort M · priority P3

* **Covers:** Email-to-Goodnotes inbox; Email-to-app PDF import; Multi-format import and email-in
* **Today:** Upload screen only (`web/features/upload/UploadScreen.tsx`); no Web Share Target in the PWA manifest; no inbox address.
* **Plan:** PWA Web Share Target that opens the upload flow with the shared files (type suggestion, folder choice); an email inbox is not planned for a self-hosted single owner.
* **Medical-study extension:** Handouts shared from messaging apps land in the right course folder, typed as lecture or question source and queued for processing.

## 7. MedLevo-only extensions (not in the inventory, not counted above)

* **Ink ↔ region binding.** When a stroke is committed on a lecture page, store the ids of the processed `source_region`s it overlaps (`ink/layerController.ts` commit + `srv/annotations/sync.ts`). Then «my writing on this paragraph» can be shown beside the Study Book block that cites the same region, re-anchoring on a new version can move ink with its region or list it under «تحتاج إعادة ربط» (§25), and every handwritten note has an evidence trail.
* **Audio ↔ page alignment from strokes.** §29 leaves automatic audio ↔ page alignment Not Started. Strokes written during a recording already know their page and second, so transcript segments overlapping those seconds can get `auto` page links (labelled «ربط تلقائي — تحقق منه», editable) — alignment with a real basis, not a guess.
* **Spaced review of handwritten notes.** Tapes (G24), ink-faced cards (G61) and lasso cards (G18) all write ordinary `review_event`s, so handwritten material joins the FSRS queue, the forgetting forecast and One-Tap Revision without a second scheduler.
* **Handwriting search across lectures, grouped by concept.** With recognition configured, readings are already indexed (`srv/annotations/recognition.ts`); grouping hits by Course Brain concept and lecture turns «where did I write about X?» into a study map.
* **Clinical templates ↔ cases.** An OSCE checklist template (G32) can be generated from a case definition in `srv/cases`, so practising on paper and in the case runner use the same checklist items.
* **Colour legend as data.** G03 gives ink colours owner-defined meanings that are spoken, searchable and exportable, so colour-coded study habits stay accessible (§55).

## 8. Suggested order

**Phase 1 — study-loop multipliers** (11 gaps): G16 Image crop and cut a region from a page (M), G18 Lasso → card / question / element / screenshot (M), G23 Owner layers (show / hide / lock / active layer) (L), G24 Cover-and-reveal tape for active recall (M), G25 Rich formatting in text boxes and notes (M), G32 Custom and clinical page templates (L), G37 Quick note (one tap, file later) (M), G38 Page management: duplicate, rotate, multi-select, move to another notebook (M), G45 Search typed page items and note-page titles (M), G56 PDF export with ink (flattened / editable) (L), G61 Flashcards with handwritten faces (L).

**Phase 2 — notebook parity** (25 gaps): G03 Per-tool colour slots, synced presets and a meaning legend (M), G06 Pencil nib with graphite texture (M), G08 Ruler and measuring guide (M), G09 Zoom writing window with auto-advance (M), G14 Ink gestures: scribble-to-erase, circle-to-select, multi-finger undo (M), G15 Selective eraser, clear page and delete by type (M), G19 Free resize, rotation for text/images, keyboard nudge (M), G20 Shape fill, corners, labels and more shapes (M), G21 Connectors and quick diagramming (L), G22 Snapping and alignment guides (M), G27 Notes pinned to objects, with open / resolved state (M), G28 Owner element library (reusable content and stamps) (M), G31 Paper size, orientation, colour and more patterns (M), G35 Infinite canvas (concept / case board) (L), G36 Typed document / full-page typing (block editor) (L), G43 Owner-built outlines (M), G44 Owner web links and links to study objects (M), G51 Stroke replay with the recording (M), G52 Playback speed, skip, silence skip, noise reduction (M), G53 Recording control and recording across navigation (M), G57 Scheduled automatic backups (M), G58 Locked «sensitive» notebooks (M), G64 Flashcard import (CSV / TSV / Anki text) (M), G65 Study timer and stopwatch (M), G66 Toolbar customisation (M).

**Phase 3 — comfort, AI-gated and later items** (35 gaps): G01 Pen feel tuning (stabilisation, taper, pressure floor) (S), G02 Palm-rejection settings (S), G04 Dashed / dotted stroke styles (S), G05 Highlight inside typed text (S), G07 Eyedropper colour picker (S), G10 Handwriting editing: insert space, straighten, reflow (L), G11 Neat-copy view of handwriting (L), G12 Medical-term completion while typing (S), G13 Medical spellcheck for notes and recognised handwriting (M), G17 Lasso type filter and rectangle mode (S), G26 Font choice in text boxes (S), G29 Camera capture and photo as a page (M), G30 Document scanner flow (M), G33 Planner ↔ calendar files (M), G34 Handwritten study log per plan day (S), G39 Document tabs and windows (M), G40 Library multi-select and bulk actions (M), G41 Duplicate and merge notebooks (M), G42 Title and filing suggestions (S), G46 Note polishing as a labelled derived note (M), G47 Insert generated content onto a page (labelled) (M), G48 Diagrams and mind maps from the owner's notes (M), G49 Labelled schematic illustrations (L), G50 Owner connector for an external assistant (M), G54 Presentation / teach-back mode (M), G55 PDF form fields and saved signature (M), G59 Erase-everything and per-category erase (S), G60 Passkeys (M), G62 Card suggestions from a page or notes (M), G63 Read-aloud for cards and selected text (S), G67 Long-press page menu (S), G68 Picture covers (S), G69 Per-document settings (S), G70 Strike-out, define and read aloud on PDF text (S), G71 Send files to MedLevo from other apps (M).

AI-gated plans (G46, G47, G48, G62, the handwriting half of G13) can be built and
tested with the scripted provider like the existing AI paths, but stay `requires_configuration` until a key is set.

## 9. Counts check

| status | entries |
|---|---|
| have | 68 |
| partial | 113 |
| missing | 71 |
| out of scope | 68 |
| blocked | 27 |
| total | 347 |

## Build plan

> Written 2026-10-20 from the gap plans in §6. It turns the 71 gaps into **five build tracks (N1–N5)**. Each track can
> be built by one agent and checked by one independent review agent. Everything here is MedLevo's own design on
> MedLevo's own data model. It follows the clean-room rules of §1: no UI, text, icons, templates, stickers or assets
> are copied from any other app, and the reference app's name never appears in the product. The aim is to cover what
> the inventory offers, then go further for medical study, as each gap's «MedLevo-plus» describes.
>
> The order follows what matters most to a medical student who writes by hand on lecture pages every day:
> **(1) writing comfort and speed → (2) organisation → (3) finding things → (4) study integration.** Capture,
> recording, export and safety (N5) run alongside. This order replaces §8 for scheduling. §8 stays as the ranking by
> study-loop impact.

### B.1 Tracks at a glance

| track | theme | gaps (in build order) | size | first wave delivers | needs first |
|---|---|---|---|---|---|
| **N1** | Writing comfort and speed (the ink engine) | Wave 0 seams · G03, G14, G15, G17, G19, G66, G02, G01 · G09, G10, G67, G04, G06, G07 · G20, G22, G08, G21 · G11 | 19 gaps (6 S · 10 M · 3 L) | colour slots that sync to every device, with a meaning legend; gestures; selective eraser; keyboard nudge; a toolbar the owner arranges | — |
| **N2** | Organisation: pages, notebooks, templates, library | G38, G31, G37 · G32, G28 · G40, G41, G39, G42 · G34, G68, G69, G35 | 13 gaps (4 S · 7 M · 2 L) | duplicate / rotate / multi-select / move pages; paper sizes and tones; one-tap quick note | N1 Wave 0 (for G28 and G35) |
| **N3** | Finding things: typed text, terms, search, outlines, links | G25, G05, G26, G12 · G45, G43, G44, G27, G70 · G13, G36, G46 | 12 gaps (4 S · 7 M · 1 L) | rich text in text boxes and notes; medical-term completion | N1 Wave 0 (text-editor slot) |
| **N4** | Study integration: active recall on the owner's own handwriting | G18, G24, G23 · G16, G61, G65 · G64, G63, G33 · G62, G47, G48, G49 | 13 gaps (1 S · 9 M · 3 L) | lasso → card; cover-and-reveal tape in the FSRS schedule; layers with an answers layer | N1 Wave 0 (kinds, tools, visibility, lasso actions) |
| **N5** | Capture, recording, export and safety | G53, G51, G52 · G56 · G29, G30, G71 · G57, G58, G60, G59 · G54, G55, G50 | 14 gaps (1 S · 12 M · 1 L) | recording that keeps going when you change page or document; stroke replay; playback controls | N1 Wave 0 (record tool); N4 G23 / G24 for export toggles |

Each of the 71 gaps belongs to exactly one track. No track contains an out-of-scope entry from §3 (sharing,
collaboration, classes, marketplace, email-in inbox). Sizes use the §2 legend.

### B.2 Definition of done (every feature, every track)

1. **Offline-first (§26, §47).** The owner's action is saved to IndexedDB (Dexie) and the outbox before any network call. The feature works with the network off and syncs later without duplicates: replaying an operation twice changes nothing. Extend `e2e/g7-ac23-offline.spec.ts` style checks.
2. **No data loss (§47).** Deletes, clears, merges and moves are tombstones or copies. Each is one undo step, and bulk actions show an impact count first. Keep-both conflict handling stays as it is. New tables are in the backup and pass `npm run restore:verify`. Ink is never replaced by a derived result: neat copy, reflow, recognition and polishing each produce a separate, labelled view or item.
3. **Single owner (§02).** No share links, usernames, roles, public pages or marketplace. Nothing in this plan needs them.
4. **Honest capabilities (§27, ARCHITECTURE §0.7).** Anything that depends on a browser API, a device or a provider is a capability in `packages/shared/src/features.ts`, marked `available`, `requires_configuration` or `not_available` with an Arabic reason. A disabled control says why. `docs/CAPABILITY_MATRIX.md` gets a row for it. Device numbers (latency, pressure) are recorded only after they are measured on that device.
5. **Arabic RTL.** UI text is in Arabic. Layout uses logical start/end, not left/right. Terms, doses and units are LTR-isolated (`shared/richtext.ts`). Keyboard arrows work correctly in RTL. Each track's e2e spec runs in the Arabic UI.
6. **Accessibility (§55).** Every control has an Arabic accessible name and a keyboard path. Every gesture also has a button or shortcut. Changes are announced through aria-live. Touch targets are at least 44 px. Colour is never the only signal. Light and dark themes are both checked.
7. **Generated stays generated (§03).** AI output is a new item labelled as generated, and its evidence ids are validated on the server. AI paths are tested with `FakeAiProvider` and stay `requires_configuration` until `ANTHROPIC_API_KEY` is set.
8. **Medical safety.** Measurements are labelled «تقدير تعليمي». Clinical capture shows the «لا معرّفات مريض» reminder (§49). Any rewriting is checked with the critical-token rules of `srv/evidence`: negations, numbers, units, doses and laterality.
9. **Performance.** The live stroke path gets no extra work: gestures, snapping hints and recognition run after the stroke is committed or off the pointer path. The 5 000-stroke page and the other budgets in `docs/PERFORMANCE.md` still pass (`e2e/perf.spec.ts`, `apps/server/test/perf`).
10. **Tests and docs.** Each feature has unit tests and, where it touches the server, server tests. Each track has one Playwright spec (`e2e/nN-*.spec.ts`) on the `phone` 390×844 and `desktop` 1280×800 projects. `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and `npm run e2e` must all pass. `docs/TEST_LOG.md`, the module note and `docs/REQUIREMENTS_MATRIX.md` are updated. Only the reviewer changes a gap's §4 rows to **have**, after verifying the feature.

**Review protocol** (as for tracks F1–F5): build → independent adversarial review (offline, two devices, RTL,
screen-reader names, honesty, data loss, performance) → fixes with regression tests → final runs → docs. There is a
review at the end of every wave, so value ships in slices.

### B.3 Shared files, seams and number ranges

The tracks can run in parallel only if they don't edit the same hot files. N1 first lands the **Wave 0 seams**
(about 2–3 days, no visible change). After that, N2–N5 write their own files and register into the seams.

**N1 Wave 0 seams** (all in `ink/`):
* `ink/kinds.ts`: an item-kind registry (`render`, `hitTest`, `bounds`, `selectable`, `erasable`, `exportable`). The built-in kinds move onto it. N4 registers `tape` and N2 registers board nodes, each from its own folder.
* `ink/tools.ts`: a toolbar tool registry (id, icon, Arabic label, shortcut, pointer handler). N4 adds the tape tool and N5 the record button.
* A **visibility predicate** (`setVisibility(fn)`) applied in render, hit-test, eraser and lasso. Layers (N4), the colour-legend filter and «نسخة نظيفة للمراجعة» (N1), and export toggles (N5) use it without touching `render.ts`.
* `InkSelectionActions.extra`: named lasso actions supplied by the host. `ink/selectionActions.tsx` already lets the host supply «تحويل إلى نص» and «اسأل عن المحدد». N2 adds «احفظ كعنصر»; N4 adds «أنشئ بطاقة», «أنشئ سؤالًا» and «لقطة».
* A **text-editor slot** in `InkProvider` (default: today's textarea), so N3's rich editor mounts without editing `InkLayer.tsx`.
* Acceptance: a kind and a tool registered from a test file render, hit-test, erase, undo and sync. All existing `apps/web/test/ink/*` and `e2e/g6-*` tests pass unchanged, and the 5 000-stroke perf budget holds.

**Hot files and their owner.** Other tracks change these files only through the seams or with a one-line, append-only
registration.

| file | owner | other tracks |
|---|---|---|
| `ink/*` (render, store, toolbar, selection, input, layer controller) | N1 | register through the seams only |
| `packages/shared/src/annotations.ts` (`ANNOTATION_KINDS`, `NOTE_PAGE_KINDS`, anchors) | N1, for ink / shape / style types | N2, N3 and N4 append enum values. Their new types go in new files (`shared/templates.ts`, `shared/outline.ts`, `shared/recall.ts`) re-exported from `index.ts` |
| `srv/annotations/schemas.ts`, `srv/annotations/sync.ts` | N1 for ink schemas; N3 for the search-index hooks in `sync.ts` | kind-specific zod schemas go in new files registered in a map. N2's page operations go in a new `srv/annotations/pageOps.ts` |
| `packages/shared/src/settings.ts` | each track adds one nested object | N1 `ink`; N2 `paper` and `library`; N3 `text`; N4 `recall`; N5 `capture`, `backup` and `security` (each appended to `NESTED_SETTING_KEYS`) |
| `ws/reader/*` except `pdfLinks.tsx` | N2 | N1's long-press menu and N4's tape reveal live in the ink layer, not in the reader |
| `ws/reader/pdfLinks.tsx`, `ws/selection/SelectionToolbar.tsx`, `ws/panels/LeftPanel.tsx`, `srv/search/*` | N3 | N5 adds the locked-notebook filter through a hook that N3 provides |
| `ws/modes/arrangement.ts`, `srv/learning/*`, `web/features/review/*`, `web/features/planner/*` | N4 | N1 only reads the active mode, for the per-mode toolbars |
| PWA manifest (`apps/web/vite.config.ts`) | N2 (shortcuts) | N5 appends `share_target` |
| `srv/data/*`, `srv/auth/*`, `ws/audio/*`, recording parts of `srv/media/*` | N5 | — |

**Migration numbers** follow the ranges in ARCHITECTURE §2. A migration that has shipped is never edited.

| track | annotations (0250–0299) | other ranges |
|---|---|---|
| N1 | 0280–0284, only if a column is needed (ink styles live in the annotation JSON) | — |
| N2 | 0285–0289: note-page size, orientation, tone and template; the `board` kind; element collections | library 0110–0119: bookkeeping for bulk actions, duplicate and merge |
| N3 | 0290–0294: comment status, object anchors, outline entries | search 0350–0359, only if needed |
| N4 | 0295–0299: `layer_id`, layers, tape | learning 0610–0619: page-anchored and ink-faced cards, imports, timer sessions |
| N5 | — | auth 0010–0014 (passkeys); media 0670–0679 (playback preferences); data 0760–0769 (backup schedule, sensitive notebooks). A new `connector` module takes 0850–0859 and N5 adds it to ARCHITECTURE §2 |

### B.4 Track N1 — Writing comfort and speed (the ink engine)

**Owns:** `ink/*`, including the new `kinds.ts`, `tools.ts`, `gestures.ts`, `zoomWindow.tsx`, `ruler.ts`, `snap.ts`,
`pencil.ts`, `connectors.ts` and `neatCopy.ts`. Also the ink, shape and style types in `shared/annotations.ts` and
`srv/annotations/schemas.ts`, the `ink` settings object, `docs/modules/ink.md`, and the pen rows of
`docs/CAPABILITY_MATRIX.md`. **Tests:** `apps/web/test/ink/*` (and the harness), `e2e/n1-writing.spec.ts`.
**Reads:** `ws/modes/arrangement.ts`, processed regions from the reader context, `/api/settings`.

**Wave 0: seams** (see B.3).

**Wave 1: every-day writing** (review after this wave)
* **G03 Colour slots that sync, with a meaning legend (M).**
  * Up to 12 slots per tool, tokens or hex, with reorder, remove and reset.
  * Stored in `/api/settings` (`ink.palettes`) and in the local cache, so they work offline. A second device sees the same slots after sync; test this with two browser contexts, as in `g7-ac24`.
  * Token colours resolve per paper tone. On dark paper, the default tokens keep at least 3:1 contrast (WCAG non-text).
  * A slot can carry a meaning label. The label is saved on the stroke (`style.meaning`) and read by screen readers («أحمر — موانع استعمال»). It also drives the filter «اعرض هذا المعنى فقط» through the visibility predicate.
  * Tests: extended `palette-prefs.test.ts`, a server test for settings merge, a unit test for the legend filter, and the two-context e2e.
* **G14 Gestures (M).** Gestures are recognised after the stroke is committed, never on the live path.
  * Scribble-to-erase removes only the strokes it overlaps: at least 2 strokes, or at least 60 % of one stroke's box. It is one undo step, announced as «مُسح ٣ خطوط — تراجع».
  * A corpus test of Arabic and Latin handwriting (س، ش، ممم، m, w, and a hand-drawn ECG strip) causes **no** erasure on empty paper.
  * A closed loop followed by a hold starts a lasso selection.
  * Two-finger double tap undoes and three-finger double tap redoes. These respond to touch only, and are ignored while a pen is down.
  * Each gesture can be turned off in settings, and each already has a button or shortcut.
  * Tests: `gestures.test.ts` (the corpus), and harness e2e for multi-touch.
* **G15 Selective eraser, clear page, delete by type (M).**
  * The eraser can be limited to pen, highlighter, shapes or text highlights.
  * «امسح الصفحة» and «احذف كل … في الدفتر» show the count first, write tombstones, undo in one step and can be restored from trash.
  * Printed PDF content is never affected.
  * Tests: `eraser.test.ts`, a server tombstone test, and an e2e test of undo after reload.
* **G17 Lasso type filter and rectangle mode (S).**
  * Filter chips for ink, shapes, text, images and links, plus a rectangle mode. The choice is remembered per document in the study session.
  * With «حبري فقط», a printed-text highlight inside the lasso is not moved.
  * Tests: `lasso.test.ts`.
* **G19 Resize, rotation, keyboard nudge (M).**
  * Free resize for shapes, text boxes and stickies; proportional resize for images; Shift and Alt as modifiers.
  * Text boxes and images can be rotated. Rotation is stored in page space, so it survives zoom and page rotation (AC-21).
  * Arrow keys move the selection 1 unit (Shift: 10) in the direction pressed on screen. Delete removes it; Escape clears it.
  * The selection frame gets an accessible role and Arabic name. This closes the keyboard gap noted in `docs/modules/ink.md`.
  * Tests: `coords.test.ts`, and keyboard tests in `components.test.tsx`.
* **G66 Toolbar customisation (M).**
  * The owner can reorder and hide tools, and dock the toolbar at the top or on the start or end side (logical sides, so it suits right- and left-handed writers in RTL).
  * A recent-tool slot. Insert tools return to the lasso after use. The layout is stored in settings.
  * Per-mode profiles come from `ws/modes/arrangement.ts`: «تعلّم» shows pens and highlighter; «امتحن نفسك» shows tape and lasso.
  * The toolbar stays one tab stop with RTL arrow keys.
  * Tests: `components.test.tsx`, and the overflow test at 390 px.
* **G02 Palm-rejection settings (S) and G01 Pen feel (S).**
  * Palm sensitivity low, medium or high, mapped to the size and time thresholds in `ink/input.ts`; a hand-side setting; a test page that counts stray marks.
  * Per-nib settings: smoothing 0–6, pressure floor, taper, constant width. Profiles «كتابة», «رسم دقيق» and «تشريح», remembered per notebook.
  * The capability panel measures input-to-frame latency on this device (p50 / p95) and shows only measured numbers.
  * Tests: `input.test.ts`, `math.test.ts`.

**Wave 2: dense lecture pages**
* **G09 Zoom writing window (M).**
  * A docked magnifier writes into a target box on the page. Ink is stored in page space (AC-21).
  * Auto-advance follows the writing direction: right-to-left by default in Arabic notebooks, with a switch for left-to-right. Line return and margins are adjustable.
  * Undo works per stroke. The target box can be moved with the keyboard.
  * Tests: geometry unit tests for window ↔ page mapping in both directions, and harness e2e.
* **G10 Insert space and straighten, phase 1 (L).**
  * «أفسح مكانًا» pushes every owner item below a drawn line down (or sideways) in one undo step. On lecture pages, printed content never moves.
  * «استقم» straightens the selected strokes to a fitted baseline.
  * Phase 2 (word reflow) is in Wave 4.
* **G67 Long-press menu (S).**
  * Long-press on blank space offers: paste here, text here, sticky here, note page after this page.
  * Long-press on printed text offers «عرّف» and «أضف إلى المراجعة». These are host actions from N3 and N4, hidden until they exist.
  * The context-menu key opens the same menu.
* **G04 Dashed / dotted (S), G06 Pencil (M), G07 Eyedropper (S).**
  * `style.dash` is saved per slot and rendered scaled to page units.
  * The pencil maps pressure to width and opacity, with an original grain pattern. It is stored as the same points-only `InkData`.
  * The eyedropper uses `EyeDropper` where the browser has it, and otherwise samples the rendered page canvas. The capability says which path is in use.
  * Tests: `render` snapshot tests and schema tests.

**Wave 3: drawing and diagrams**
* **G20 Shapes (M).**
  * Fill, corner radius, and a label inside the shape (RichText, bidi-correct). New types: triangle, polygon, curved arrow, double arrow.
  * Pathway arrow heads with accessible names: activation → («ينشّط»), inhibition ⊣ («يثبّط»), conversion ⇢ («يتحوّل إلى»).
  * A shape's type can be changed from the lasso menu.
  * Tests: `shapes.test.ts`, and a schema round-trip.
* **G22 Snapping and guides (M).**
  * Guides to item edges and centres, to the paper grid pitch, and to processed `source_region` boxes on lecture pages.
  * Holding Alt disables snapping; a setting turns it off. Guides are computed off the pointer path.
  * Tests: `snap.test.ts`.
* **G08 Ruler and measuring (M).**
  * A ruler overlay with two-finger rotate and an angle readout; strokes snap to its edge. It is never saved as ink.
  * On images, the owner sets the scale from a scale bar, then measures lengths and angles. Results are labelled «تقدير تعليمي — ليس قياسًا سريريًا».
  * Tests: geometry unit tests.
* **G21 Connectors (L).**
  * Connectors attach to shape edge points and follow moves and resizes. Elbow and curved routes have control points.
  * Tapping an edge dot adds a connected shape. «رتّب تلقائيًا» reuses `web/features/studybook/diagrams/layout.ts`.
  * Edges can carry a relation (`causes`, `inhibits`, `treats`, `complicates`) and nodes a `concept_id`. N4 G48 and N2 G35 use these.
  * Tests: `connectors.test.ts`, including that undoing a move keeps the attachments.

**Wave 4: later**
* **G11 Neat copy (L).** A derived view per page («نسخة مرتبة»): straightened baselines, normalised size, smoothing. It never changes stored strokes. It is toggled per page, and N5's export can use it.
* **G10 phase 2 (word reflow).** Available only when handwriting recognition is configured. Tested with the fake provider.

**MedLevo-plus in N1:**
* A meaning legend for ink colours, read aloud, usable as a filter and (via N3) searchable.
* The «تشريح» pen profile.
* Right-to-left advance in the zoom window.
* Scribble-to-erase that is safe on hand-drawn ECG strips.
* The «نسخة نظيفة للمراجعة» view.
* Pathway arrow notation.
* Snapping to printed regions.
* Educational measurement on images.
* Medical relation types on connectors.

**Stays blocked:**
* Native palm rejection, Apple Pencil double-tap and squeeze, PencilKit latency and Scribble on the canvas need a native iPad layer (§27, `CAPABILITY_MATRIX.md`).
* Real pressure, tilt, hover and latency values are recorded only after measuring them on a real iPad and Pencil.
* Word reflow (G10 phase 2) and a word-aware neat copy need a vision provider for handwriting recognition.

### B.5 Track N2 — Organisation: pages, notebooks, templates, library

**Owns:** `ws/notebook/*`, `ws/notes/*`, `ws/data/notePages.ts`, `ws/model/paper.ts`, `ws/reader/*` (note-page
rendering, not `pdfLinks.tsx`), `web/features/library/*`, the Home quick-note entry, the PWA manifest shortcuts,
`srv/library/*`, a new `srv/annotations/pageOps.ts`, a new `shared/templates.ts`, original vector templates under
`apps/web/src/features/workspace/templates/`, the `paper` and `library` settings, `docs/modules/workspace.md` and
`library-sources.md`. **Tests:** `apps/web/test/notebook/*`, `apps/server/test/annotations/page-ops.test.ts`,
`apps/server/test/library/*`, `e2e/n2-organise.spec.ts`.

**Wave 1: pages you can manage**
* **G38 Page management (M).**
  * Duplicate a note page: new ids, with ink and pictures copied by reference (files are content-addressed, so no new bytes).
  * Rotate a note page; ink stays in unrotated page space.
  * Multi-select: checkbox mode, Shift-range, Space on the keyboard. Bulk move, trash and export.
  * Move or copy pages to another notebook, or after a lecture page.
  * Every action works offline, is one undo step and replays from the outbox without duplicates.
  * «نسخة فارغة للاختبار» drops the answers layer (N4 G23). Until G23 exists, it drops all owner ink and keeps the template and printed content.
  * Tests: `pageOps` server tests (replay without duplicates), `notePages.test.ts`, e2e.
* **G31 Paper size, orientation, tone, layouts (M).**
  * A4, A5 and Letter, portrait or landscape. Tones warm, grey and dark, as tokens.
  * Cornell layout, with the cue column on the start side (mirrored for LTR notebooks), and two-column layout. Defaults per notebook.
  * A note page inserted after a lecture page can take that page's size and orientation.
  * Ink stays in place across size, zoom and device; the AC-21 test is extended to A5 landscape.
  * Tests: `noteSheets.test.tsx`, a paper-token contrast test, the extended `e2e/g6-ac21`.
* **G37 Quick note (M).**
  * One tap from Home, the global nav or a PWA manifest shortcut opens a writable page in «الوارد» within 1 s, even offline.
  * The note can later be moved, merged, or inserted after a lecture page.
  * A filing suggestion from `/api/brain/topics/suggest` is shown with its reason and never applied silently.
  * «ملاحظة سريرية» opens on the SOAP template (G32) with the «لا معرّفات مريض» reminder.
  * Tests: e2e quick note offline → sync → move.

**Wave 2: templates and reusable content**
* **G32 Custom and clinical templates (L).**
  * A template can come from the owner's own PDF page or image, stored as an owner file.
  * MedLevo-original vector templates whose fields are page regions: SOAP; history taking (HPI / PMH / DH / FH / SH / ROS); an OSCE checklist generated from a case definition in `srv/cases`; drug card; lab-values sheet; ECG grid.
  * Content inside a field is indexed with the field name (through N3), so a search like «كل حقول موانع الاستعمال» works.
  * Templates are bundled and work offline. Optional AI tailoring is `requires_configuration` without a key.
  * Tests: template schema tests, a server test for the OSCE checklist from a case, and an e2e field search once N3 G45 lands.
* **G28 Owner element library (M).**
  * «احفظ كعنصر» from the lasso (a seam action) saves into named collections that sync like annotations; pictures go through `/api/annotations/images`.
  * Insert by tap, drag or keyboard.
  * Stamps can have typed fields (vitals: HR, BP, RR, T, SpO₂) whose values stay searchable.
  * Only the owner's own drawings and files; nothing is bundled from third parties.
  * Tests: server CRUD and tombstones for collections, and `restore:verify` covering the new tables.

**Wave 3: the library**
* **G40 Library multi-select and bulk actions (M).**
  * Checkbox mode, Shift-range and keyboard selection.
  * Bulk move, archive, trash, tag and favourite, with one impact preview. Grid / list toggle.
  * Topic tags suggested by Course Brain, shown as suggestions.
* **G41 Duplicate and merge notebooks (M).**
  * Duplicate copies note pages, ink and pictures with new ids.
  * Merge moves chosen pages into another notebook, with an impact preview and undo.
  * «فرع لدورة امتحان جديدة» keeps the original read-only.
* **G39 Tabs and windows (M).**
  * A tab strip of open sources and notebooks; each tab restores its own study session.
  * Open in a new window; reopen a closed tab.
  * Saved tab sets (lecture + reference + question source) restore as one study session (§46).
  * Tab state syncs over the existing BroadcastChannel.
* **G42 Title and filing suggestions (S).**
  * Suggestions come from the first heading or the linked lecture, shown with the reason.
  * Suggestions from recognised handwriting appear only when recognition is configured. Nothing is applied silently.

**Wave 4: notebook details and the board**
* **G34 Study log per plan day (S).**
  * A «سجل اليوم» note page with the day's plan tasks printed in (read from the planner API), linked both ways.
  * A weekly summary built only from real data.
  * Reflection prompts linked to the Weakness Center.
* **G68 Picture covers (S) and G69 Per-document settings (S).**
  * A cover picture from the owner's files, with the token cover as fallback. The subtitle states the next due revision as a sentence (no counters, §23).
  * A details sheet per notebook or source: recognition language (ar / en / mixed), default paper, pen-only, layout, last sync state, default Source Lock and explanation level.
* **G35 Concept / case board (L).**
  * A `board` note kind with unbounded coordinates, tiled canvases (the `ink/spatial.ts` index, through the kind registry), a minimap and a background pattern. Same ink engine, sync and undo.
  * Source regions, cards, questions and Course Brain concepts can be dropped on the board as live linked nodes. They keep their citations and open the exact source page.
  * Connectors come from N1 G21.
  * 2 000 items on a board stay within the `docs/PERFORMANCE.md` budget.
  * Tests: unit tests for spatial tiling, a perf test, e2e.

**MedLevo-plus in N2:**
* Clinical templates with searchable fields.
* An OSCE checklist shared with the case runner.
* Note pages that match the size of the lecture page they follow.
* «نسخة فارغة للاختبار».
* Vitals and drug-card stamps.
* Forking a notebook for a new exam cycle.
* Saved tab sets that restore as one study session.
* A concept / case board with live, cited nodes.

**Stays blocked:**
* Home-screen widgets and a Siri / Shortcuts quick note need a native app. The PWA shortcut is the substitute.
* AI-tailored templates need `ANTHROPIC_API_KEY`.
* Titles from handwriting need a vision provider.
* Placing windows on a chosen screen depends on the browser's window-management support (a capability).

### B.6 Track N3 — Finding things: typed text, terms, search, outlines, links

**Owns:** `shared/richtext.ts`; a new `ws/text/*` (rich editor, formatting bar, completion, block editor); a new
`web/lib/speech.ts`; `ws/selection/SelectionToolbar.tsx`; `ws/panels/LeftPanel.tsx` (outline); the note and comment UI
in `ws/panels/*`; `ws/reader/pdfLinks.tsx`; `srv/search/*`; `web/features/search/*`; the search-index hooks in
`srv/annotations/sync.ts`; the `text` settings; `docs/modules/evidence-search.md` and `workspace.md`. **Reads:** the
Terms dictionary (`srv/studybook/terms.ts`), the critical-token rules (`srv/evidence`), Course Brain concepts.
**Tests:** `apps/web/test/text/*`, `apps/server/test/search/*`, `e2e/n3-find.spec.ts`.

**Wave 1: typing that keeps up**
* **G25 Rich formatting (M).**
  * A formatting bar and shortcuts (bold, italic, underline, colour, highlight, subscript, superscript), plus Markdown-style auto lists (`- `, `1. `) with indent and outdent.
  * Works in text boxes, stickies and rail notes, mapped to the RichText model. Mounted through the N1 text-editor slot.
  * CO₂, HCO₃⁻ and 10⁹/L render correctly inside Arabic lines. Shortcuts use `KeyboardEvent.code`.
  * Existing plain notes open unchanged.
  * Tests: a RichText ↔ editor round-trip property test, and bidi tests.
* **G05 Highlight inside typed text (S).**
  * A highlight mark using the highlighter tokens; it moves with the words.
  * A highlighted medical term links to the Terms dictionary. «اجعلها بطاقة فراغ» creates a cloze card through the existing cards route.
* **G26 Fonts (S).** The bundled families, plus Naskh and one monospace font. Local Font Access only where the browser grants it (a capability). Never remote fonts.
* **G12 Medical term completion (S).**
  * Suggestions come from the Terms dictionary and Course Brain concepts, in Arabic and English. Tab accepts.
  * The term is inserted as an LTR-isolated `term` run, with the exact spelling from the owner's sources.
  * Works offline once the dictionary is downloaded.

**Wave 2: search everything you typed**
* **G45 Search typed page items (M).**
  * Indexed in `owner_content_fts` (normalised key, removed on tombstone): text boxes, stickies, link labels, note-page titles, element stamp fields, template field names and colour-legend meanings.
  * `/search` shows each hit with its page and opens it there. Arabic normalisation (hamza forms, taa marbuta, diacritics) is tested.
  * Abbreviations and synonyms expand from the Terms dictionary (MI ↔ myocardial infarction ↔ احتشاء العضلة القلبية). Expanded results are marked «بحث موسّع», and expansion can be turned off.
  * In-document Ctrl/⌘ F finds typed items offline.
  * A hook lets N5 exclude locked notebooks.
  * Tests: server index lifecycle, search ranking, web search tests, and e2e create offline → sync → find → delete → gone.
* **G43 Owner outlines (M).**
  * Owner entries (page plus optional region, three levels, reorder, rename), stored as annotations and merged with the automatic outline.
  * Searchable, and kept in exports.
  * Can be seeded from Course Brain concepts or lecture objectives, marking entries that already have cards or questions.
* **G44 Links (M).**
  * Owner web links from text runs, stickies and shapes. Only http and https; `javascript:`, `data:` and other schemes are rejected. The owner confirms before leaving, and the server never fetches the link.
  * Deep links to a question, card, case station or concept.
  * Tests: a URL-validation security test, and link-navigation e2e.
* **G27 Notes pinned to objects (M).**
  * A note anchored to a stroke, shape or image follows it when it moves. Status is open or resolved.
  * A «أسئلتي المفتوحة» filter per lecture.
  * An open note can be sent to the rail as «اسأل عن المحدد» with its paragraph; a resolved one can become a card.
  * N4's One-Tap Revision can read open questions.
* **G70 Strike-out, define, read aloud (S).**
  * A `strike` style on `text_highlight`.
  * «عرّف» shows the definition from the owner's own sources, with its citation; it works offline once downloaded.
  * Read-aloud through `web/lib/speech.ts` reads each run in its own language. If no Arabic voice is installed, the capability says so.

**Wave 3: checking and long-form typing**
* **G13 Medical spellcheck (M).**
  * Typed notes and the derived recognised text are checked against the Terms dictionary and a personal word list.
  * Look-alike drug names (hydroxyzine / hydralazine) and unit pairs (mg / mcg) are flagged «تحقّق من هذا», using the critical-token rules.
  * Flags appear on derived text only; ink is never rewritten.
* **G36 Block editor (L).**
  * Headings, lists, checklists, tables, quotes and images, with a slash menu, on the RichText model.
  * Usable as a full-page typed note page and as the rail note editor.
  * Quote blocks keep their evidence id and chip. Question and card blocks. Comparison tables.
  * The existing DOCX and Markdown exports include the blocks.
  * Tests: block-model round-trip and export tests.
* **G46 Note polishing (M, AI).**
  * «نقّح ملاحظتي» (shorten, structure or proofread) creates a new note labelled as generated; the original is untouched.
  * If negations, numbers, units, doses or laterality changed, the result is not offered and the difference is shown.
  * `requires_configuration` without a key; tested with `FakeAiProvider`.

**MedLevo-plus in N3:**
* Chemical and lab notation inside Arabic lines.
* Term runs linked to the dictionary.
* Completion with the spelling from the owner's own sources.
* Synonym and abbreviation search across Arabic and English.
* Field-aware search in clinical templates.
* An open-question workflow that ends in cards.
* Definitions from the owner's own sources, with citations.
* Warnings for look-alike drugs and units.
* Blocks that carry evidence.

**Stays blocked:**
* Spellcheck and search on real handwriting need a vision provider (the code uses the existing recognition job).
* Semantic search needs an embeddings provider.
* G46 needs `ANTHROPIC_API_KEY`.
* Dictation needs a speech-to-text provider, and Scribble needs a native layer.
* Local Font Access and installed Arabic voices depend on the browser and OS (a capability per device).

### B.7 Track N4 — Study integration: active recall on the owner's own handwriting

**Owns:** a new `ws/recall/*` (tape kind and tool, layers panel, lasso study actions, ink-face card canvas, study
timer); `ws/modes/arrangement.ts`; `web/features/review/*`; `web/features/planner/*`; `srv/learning/*`;
`shared/learning*.ts`; a new `shared/recall.ts`; the input side of `srv/studybook/diagrams.ts`; the `recall` settings;
`docs/modules/learning.md` and `learning-web.md`. **Tests:** `apps/web/test/recall/*`, `apps/server/test/learning/*`,
`e2e/n4-recall.spec.ts`.

**Wave 1: turn what you wrote into recall**
* **G18 Lasso → card / question / screenshot (M).**
  * «أنشئ بطاقة», «أنشئ سؤالًا» and «لقطة» in the lasso menu (seam actions).
  * The selected strokes and the printed paragraph beside them become a draft through `/learning/cards` and Create-MCQ.
  * The card keeps the page, region and evidence ids. «افتح المصدر» lands on the exact place with the region highlighted.
  * A card made only from owner ink shows «لا دليل من مصادرك» rather than pretending to be sourced.
  * Works offline.
  * Tests: server tests for card provenance, and e2e lasso → card → review → open source.
* **G24 Cover-and-reveal tape (M).**
  * A `tape` kind and tool, registered through the seams.
  * Tapping reveals or re-covers it in any tool, including the hand tool. Revealing is view state, not an edit.
  * Each tape is a page-anchored card. Revealing asks Again / Hard / Good / Easy and writes one `review_event`. FSRS replay gives the same result offline and on the server, and two devices never record the same reveal twice.
  * «امتحن نفسك» re-covers every tape.
  * Keyboard: Tab to a tape, Enter reveals it.
  * Tests: an FSRS replay equality test, and two-context e2e.
* **G23 Layers (L).**
  * Up to 5 named layers per page or notebook (`layer_id`; existing items stay on the default layer).
  * An active layer for all tools; show, hide and lock. Locked items can't be erased or selected.
  * An «إجابات» layer is hidden automatically in «امتحن نفسك» mode.
  * Export respects visibility (N5).
  * The layer panel is fully keyboard-operable.
  * Tests: a migration test; visibility in render, hit-test and eraser; a mode test in `arrangement.test.ts`.

**Wave 2: pictures, handwritten cards, timing**
* **G16 Crop and cut a region (M).**
  * Non-destructive crop on image items.
  * «قص منطقة» on a lecture page creates an image item with its provenance: source, version, page id, bbox, region ids.
  * From it the owner can make an image-occlusion card, ask «اشرح الصورة», or get a figure reading under the AC-08 rules for uncertain labels.
* **G61 Ink-faced cards (L).**
  * Each card side can hold ink: annotations anchored to the card, using the same engine and sync.
  * Draw-from-memory cards show the owner's drawing beside the source figure, and the owner grades it. No automatic similarity score is claimed.
  * When recognition is configured, the recognised text keeps these cards searchable.
* **G65 Study timer (M).**
  * Countdown presets and a stopwatch with laps in the reader.
  * Sessions are logged to the study session per source and feed the planner's measured pace.
  * OSCE presets (reading time + station time + 1-minute warning) and MCQ pacing.
  * Alerts are announced on screen, not by sound alone.

**Wave 3: getting cards into and out of the day**
* **G64 Card import (M).**
  * Two-column CSV / TSV and Anki text exports, keeping cloze syntax.
  * Duplicate detection with the existing lexical check. Origin «مستورد».
  * Cards show «لا دليل من مصادرك» until linked to evidence. Matches to lectures and concepts are offered as suggestions.
* **G63 Read-aloud for cards (S).**
  * Read-aloud on card faces through N3's `web/lib/speech.ts`.
  * A hands-free mode (question → pause → answer), with ratings entered on screen later.
* **G33 Planner ↔ calendar files (M).**
  * `.ics` export of plan tasks and the exam date (UTF-8 Arabic titles, folded lines).
  * `.ics` import of a timetable from a file only: no URL fetch and no OAuth (§49).
  * Imported lectures create pre-reading tasks and review tasks at +1, +3 and +7 days.

**Wave 4: AI-gated** (built and tested with the scripted provider)
* **G62 Card suggestions (M).**
  * A few evidence-checked suggestions per page or lasso, accepted one by one.
  * Prefers lines linked to past questions (Exam DNA) and the owner's weak areas.
* **G47 Generated content on a page (M).**
  * «ضعه في صفحتي» shows a preview the owner can edit, then inserts a read-only `generated` item with its citations and verification status.
  * It is never merged into owner ink. When the cited source changes, it is re-checked and marked «يحتاج مراجعة».
* **G48 Diagrams from notes (M).**
  * Notes and recognised handwriting become input to `srv/studybook/diagrams.ts`, labelled as owner notes (never as evidence).
  * A mind-map layout. Output is editable with N1 G21 connectors.
  * A «اخفِ العُقد» quiz that feeds FSRS.
* **G49 Labelled schematics (L).**
  * Deterministic SVG schematics drawn from diagram and knowledge-map relations.
  * Labelled as generated and excluded from «real example» matching (AC-09).
  * One step turns a schematic into an occlusion card.

**MedLevo-plus in N4:**
* Handwritten material (tapes, lasso cards, ink-faced cards) in the same FSRS queue as every other card.
* «افتح المصدر» that lands on the exact place.
* An answers layer hidden in exam mode.
* Anatomy tracing layers.
* Cut regions that stay citable and become occlusion cards.
* OSCE and MCQ pacing.
* Imported decks that never pose as sourced.
* Pre-reading driven by the timetable.
* Quiz diagrams.

**Stays blocked:**
* Generation in G62, G47 and G48 needs `ANTHROPIC_API_KEY`.
* There is no image-generation provider; G49 is deterministic SVG by design.
* Recognised text on ink-faced cards needs a vision provider.
* Calendar account sync (OAuth) is excluded by §49; files only.

### B.8 Track N5 — Capture, recording, export and safety

**Owns:** `ws/audio/*`; the recording parts of `srv/media/*`; a new `ws/capture/*` (camera, scanner, redaction);
`web/features/upload/*`; the `share_target` block of the PWA manifest; `srv/data/*` (PDF renderer, backup schedule,
erase); the export UI in `web/features/offline/*`; `srv/auth/*` and `web/features/auth/*` (passkeys, sensitive
notebooks); the backup card in `web/features/control/*`; a new `connector` module; the `capture`, `backup` and
`security` settings; `docs/modules/cases-media.md`, `data.md` and `docs/BACKUP_RESTORE.md`. **Tests:**
`apps/server/test/data/*`, `apps/server/test/auth/*`, `ws/audio/*.test.ts`, `e2e/n5-capture-export.spec.ts`.

**Wave 1: lectures with sound**
* **G53 Recording across navigation (M).**
  * A record button in the ink toolbar (tool registry) and a global recording dock that stays when the owner moves to another page or document.
  * Strokes in any open document get time links to their own page.
  * A recording survives a reload (the existing crash safety).
  * When the browser stops recording in the background, the capability says so.
* **G51 Stroke replay (M).**
  * Progressive, spotlight and static modes while the recording plays (point times + `audio_link.offset_ms`).
  * Stroke markers on the timeline; every stroke is a clickable timestamp.
  * Playable from the keyboard.
* **G52 Playback controls (M).**
  * Custom controls: 0.75–2× (remembered per recording), ±10 s, skip silence, a simple on-device noise gate (labelled as simple, not «AI»), and shortcuts.
  * «شغّل ما يخص هذه الصفحة» jumps between the segments linked to the page on screen.

**Wave 2: export what you wrote**
* **G56 PDF export with ink (L).**
  * The server renders pages (`pdftoppm`) with a vector overlay of ink, highlights, text and pictures (flattened), or with ink as PDF annotations (editable).
  * Page ranges. Toggles for ink, highlights, backgrounds, layers and tape (covered or uncovered).
  * Confirmed recognised text as an invisible text layer. The manifest is kept.
  * «حزمة مراجعة»: pages, ink, linked cards and questions, and a citation index. «نسخة امتحان نظيفة»: answers layer hidden, tapes covered.
  * Tests:
    * exported ink positions match the normalised page coordinates on rotated and A5 pages, within a pixel tolerance;
    * text on a hidden layer is absent from `pdftotext` output;
    * Arabic in the index is shaped correctly.
  * The `export.pdf` capability switches to available only after these tests pass.

**Wave 3: capture on the go**
* **G29 Camera and photo as a page (M).**
  * «التقط صورة» (getUserMedia, or `<input capture>` on phones) onto the current page, and «صفحة من صورة».
  * A privacy reminder (§49), and an on-device blur / redaction tool before upload. EXIF is stripped.
  * Works offline; the upload is queued.
* **G30 Scanner flow (M).**
  * Capture several pages, with auto-crop, perspective fix and contrast done on the device.
  * One upload as a multi-page source, then the existing Arabic + English OCR.
  * A scanned past paper goes into question extraction.
* **G71 Share to MedLevo (M).**
  * A PWA Web Share Target opens the upload flow with the shared files, a type suggestion (lecture or question source) and a folder choice.
  * Queued when offline.

**Wave 4: safety**
* **G57 Scheduled backups (M).**
  * Daily or weekly, keeping N generations, verified after each one, to a local or mounted path (optional WebDAV).
  * Status and the last verified restore appear in the Control Center.
  * Secrets are never included (tested). A «لقطة قبل أسبوع الامتحان» reminder.
* **G58 Sensitive notebooks (M).**
  * A notebook marked sensitive asks for the password or a passkey to open, and relocks after inactivity.
  * While locked, the **server** keeps it out of search, AI context and offline packages (API tests).
  * The «لا معرّفات مريض» reminder and the redaction tool are offered.
* **G60 Passkeys (M).**
  * WebAuthn passkeys, in addition to the password and recovery codes.
  * A sign-in from a new device appears in the sessions list.
  * The same passkey unlocks sensitive notebooks.
* **G59 Erase (S).**
  * «امسح كل بياناتي» offers an export first, then asks for a typed confirmation and shows an impact list.
  * Per-category erase: recordings, recognitions, chats.
  * Erase recordings older than N months while keeping their transcripts and stroke links.

**Wave 5: later**
* **G54 Presentation / teach-back (M).**
  * An audience window (Presentation API, or a second window) that shows only the page, ink and laser.
  * «اشرحها بصوتك» records a teach-back with stroke links. Nothing is shared.
* **G55 PDF forms and saved signature (M).**
  * Form fields read with pdf.js and filled as `form_value` annotations, kept apart from the original (§03).
  * A drawn signature saved as an element (N2 G28), labelled as a drawing, not a digital signature.
  * Filled values are exported.
* **G50 External assistant connector (M).**
  * Off by default. Uses an owner-scoped token that can be revoked and is rate-limited.
  * Saves a conversation as a generated note in a chosen folder; never evidence, never raises trust.
  * Optional read-only search with Source Lock that returns page excerpts, not files (§49).

**MedLevo-plus in N5:**
* Every stroke a timestamp, across documents.
* Replay of a handwritten case work-up.
* Playback scoped to the page on screen.
* Revision-pack and exam-clean exports.
* Redaction of clinical photos.
* Scanning a past paper straight into the Question Vault.
* A snapshot reminder before exam week.
* Sensitive notebooks for clinical notes.
* Erasing old recordings while keeping transcripts and links.
* Teach-back for viva and OSCE practice.

**Stays blocked:**
* Automatic transcription and audio summaries need a speech-to-text provider. Manual and imported transcripts already work.
* A web app can't record while the browser is closed or the device is locked; that needs a native layer.
* Presenting on an external display depends on browser support; the fallback is a second window.
* Biometric unlock depends on the device's platform authenticator.
* Backups to cloud vendors through OAuth are excluded by §49.
* No email-in inbox (self-hosted, single owner).
* No legally binding digital signatures.

### B.9 Cross-track dependencies

| needs | from | why | until then |
|---|---|---|---|
| N2 G28, N4 G18 (lasso actions); N4 G24 (tape kind and tool); N4 G23 (visibility); N3 G25 (editor slot); N5 G53 (record tool) | N1 Wave 0 | the seams keep `ink/*` under one owner | start once Wave 0 is merged (about day 3) |
| N2 G35 board; N4 G48 editable diagrams | N1 G21 connectors | edges that follow their nodes | the board ships without connectors; diagrams stay read-only |
| N2 G38 «نسخة فارغة للاختبار»; N5 G56 layer and tape toggles | N4 G23, G24 | the answers layer and tapes | drop all owner ink; export without those toggles |
| N2 G32 field search; N1 G03 legend search | N3 G45 | the `owner_content_fts` producers | fields and legends are saved, and become searchable when G45 lands |
| N4 G63 read-aloud | N3 `web/lib/speech.ts` (G70) | one shared speech helper | N3 builds it in its Wave 2 |
| N4 One-Tap Revision of open questions | N3 G27 | comment status | — |
| N5 G58 search exclusion | N3 search hook | locked notebooks hidden on the server | N5 adds the filter in `srv/search`, reviewed by N3 |
| N1 G67 «عرّف» / «أضف إلى المراجعة» | N3 G70, N4 | host actions | the menu shows only the blank-space items |
| N5 G55 saved signature | N2 G28 | the element library | the signature is kept as an image item |

### B.10 Schedule

1. **Step 0: seams.** N1 Wave 0 (S), reviewed and merged on its own.
2. **Step 1: first waves in parallel.** N1 Wave 1 (every-day writing), N2 Wave 1 (pages), N3 Wave 1 (typing), N4 Wave 1 (recall) and N5 Wave 1 (recording), each ending with its review. After Step 1, a student writes faster, files pages faster, types properly, and reviews their own taped or lassoed handwriting with FSRS.
3. **Step 2: second and third waves**, in the same order of value: N1 Waves 2–3, N2 Waves 2–3, N3 Waves 2–3, N4 Waves 2–3, N5 Waves 2–3.
4. **Step 3: later waves.** N1 Wave 4 (neat copy, reflow), N2 Wave 4 (board), N4 Wave 4 (AI-gated), N5 Waves 4–5. AI-gated features ship disabled, with their reason, until the owner adds a key.
5. **With one agent at a time**, the order is: N1 W0 → N1 W1 → N2 W1 → N3 W1 → N4 W1 → N5 W1, then the second waves in the same order, and so on.
6. **After each track,** the reviewer re-runs this report's checks and changes the §4 rows the track covers. The §3 counts and §9 are recomputed in the same change.

### B.11 Deliberately not built

* Sharing links, collaboration, classes, a template or sticker marketplace, and an email-in inbox (§01, §02).
* Remote fonts and third-party sticker or template packs (offline-first and clean-room).
* AI image generation (G49 is deterministic SVG).
* Any claim about pen hardware or latency that was not measured on a real device (§27).
