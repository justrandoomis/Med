# MedLevo — performance & resilience (integration round I2)

Spec §55 («test large files, dense pages, high-resolution images and thousands of notes; do not infer production
performance from a three-page test file», «do not promise 60/120 FPS or a latency before measuring») and §58 (reload,
crashed session, network loss). Everything below was **measured in this container** with large synthetic fixtures
generated at test time. Nothing here is a device claim: there was no iPad, no Apple Pencil, no phone, no GPU — only
headless Chromium on a shared 4-CPU VM. Numbers are single runs unless a percentile says otherwise.

## Environment

| item | value |
|---|---|
| machine | Linux 6.18 VM, 4 vCPU «Intel(R) Xeon(R) Processor @ 2.80GHz», 16 GB RAM, no swap |
| server | Node.js v22.22.0, `node:sqlite` (WAL, `synchronous=NORMAL`), poppler `pdftoppm`, tesseract.js 7 (`eng+ara` best_int) |
| browser | Chromium 141 headless (`/opt/pw-browsers/chromium`, Playwright 1.64), desktop project 1280×800 @1×, service worker blocked |
| load | other agents were running test suites on the same VM during parts of the browser runs (load average 1–7, recorded per run below); server-side runs were sequential |

## Fixtures (generated, never committed)

`apps/server/test/perf/fixtures.ts` — cached in `$TMPDIR/medlevo-perf-fixtures` (`MEDLEVO_PERF_CACHE` to move it).
Every document is labelled «TEST FIXTURE — synthetic performance document. Not a medical reference.»; the sentences
are structural filler (numbers, units, NOT/EXCEPT, Arabic + English), not medical statements.

| fixture | how | size |
|---|---|---|
| 300-page lecture | Chromium prints HTML to PDF (real text layer, Arabic shaped by the browser): header + printed page number on every page, Arabic/English paragraphs, a dense **two-column** page every 5th page, a ruled table every 10th, a raster flowchart figure every 25th | 2.48 MB, 300 pages |
| dense two-column set | same generator, every page two-column, 8.4 pt, 18 paragraphs | 40 pages, ≈ 6 800 characters/page |
| scanned pages | Chromium screenshots (1240×1754) embedded as full-page images → image-only PDF (OCR path) | 8 pages |
| high-resolution photo | streamed zlib PNG encoder, scan-like content | **6000×8000 RGB (48 MP)**, 0.5 MB |
| question bank | 2 000 MCQs in 20 sections (numbering restarts per section), A–D / أ–د options, NOT/EXCEPT stems, answer key per section | 240 pages |
| learning records | 3 000 flashcards + 12 000 review events (4 per card over 120 days), pushed through `POST /api/sync/push` | — |
| ink | 5 000 pen strokes × 40 samples on ONE page, pushed through the sync API | 7.5 MB as JSON |

## How to run

```bash
# server (vitest; each scenario in its own file = its own process, so memory high-water marks are per scenario)
cd apps/server
MEDLEVO_PERF=1 NODE_OPTIONS='--disable-warning=ExperimentalWarning' npx vitest run test/perf --no-file-parallelism
#   results: $TMPDIR/medlevo-perf-results/<scenario>.json  (MEDLEVO_PERF_OUT to move)
#   sizes: MEDLEVO_PERF_PAGES, MEDLEVO_PERF_QUESTIONS, MEDLEVO_PERF_CARDS, MEDLEVO_PERF_STROKES, MEDLEVO_PERF_IMAGE_W/_H …

# browser (Playwright against the real server + built web app)
MEDLEVO_PERF=1 npx playwright test e2e/perf.spec.ts --project=desktop      # results: e2e/.artifacts/perf/desktop.json

# the device's review-queue fold alone (Node, no IndexedDB/rendering)
cd apps/web && MEDLEVO_PERF=1 npx vitest run test/learning/queue.perf.test.ts
```

Without `MEDLEVO_PERF=1` every perf file is **skipped** (the normal `npm test` / `npm run e2e` stay fast). The
regression tests for the fixes below are NOT gated — they run in the normal suites.

## Results — server

Final run with the final code: `npx vitest run test/perf --no-file-parallelism`, 2026-10-10 06:42–06:45 UTC, load
average 2.8 → 1.4. Earlier runs during the pass (used for the «before» columns) gave the same numbers within ±10 %.

| scenario | size | measured | notes / limits |
|---|---|---|---|
| Upload + process a digital lecture (real API, real pipeline) | 300 pages, 2.48 MB | upload 0.39 s; processing **22.4 s** (13.4 pages/s); per page p50 **33 ms** (text 28 ms · table 30 ms · two-column **85 ms** · figure 139 ms p50, 743 ms max = crop render + sparse OCR) | 300/300 `ready`, 4 692 regions, 1 030 chunks, 245/300 printed labels detected. Memory: RSS 265 → 652 MB peak (high-water 663 MB), sampled heap peak 388 MB — but in a separate run with forced GC every 50 pages **the live heap stayed flat at ≈ 149 MB from page 50 to page 300** (no retention; the peaks are garbage V8 had not collected yet). |
| Dense two-column pages | 40 pages, 6 774 chars/page | per page p50 **81 ms**, p95 123 ms; 5.6 s total | layout path only (digital text) |
| Scanned (image-only) pages → OCR | 8 pages, 200 dpi | per page p50 **7.2 s** (7.0–7.9 s) | OCR-bound: one tesseract worker, recognitions serialized → a 300-page scan would take ≈ 36 min on this VM; pages become readable one by one (summary rewritten after each page). All 8 `needs_review` (some words below the OCR confidence threshold). Not parallelized (see limits). |
| High-resolution photo as an image source | 6000×8000 RGB (48 MP) | **before fix: 2.6 s, process high-water 226 → 793 MB (+568 MB); after: 11 ms, +1 MB** | above `MAX_OCR_PIXELS` (40 MP) the page is kept as a figure with `IMAGE_TOO_LARGE` + review item (never «empty»). Fix #1 below. The photo is NOT OCR'd (no downscaling library) — limit. |
| Keyword search (FTS5, normalized) over the lecture's chunks | 1 030 chunks, 9 queries × 100 | scoped `searchChunks` p50 **0.4–1.5 ms**, p95 ≤ 2.8 ms (Arabic and English) | `GET /api/search` (universal: chunks + questions + notes + generated + transcripts) p50 **35 ms**, p95 61 ms |
| Page list of a 300-page version | `GET /api/sources/:id/versions/:v/pages` | p50 5.5 ms | |
| Question bank: processing → extraction → matching | 2 000 MCQs, 240 pages | processing **10.7 s**; `extract_questions` **21.8 s** (≈ 11 ms/question); matching 42 ms | 2 000 questions, 8 000 options, 2 000 FTS rows. Answer keys: see the limit «wrapped key lines». |
| Question Vault API on that bank | 2 000 questions | list first page p50 52 ms; last page 54 ms; **filtered by source: before fix 1 953 ms, after 54 ms**; FTS search 50 ms; detail 1.7 ms; universal search (questions) 9 ms | fix #2 below |
| Sync push: flashcards | 3 000 cards, 6 requests | 4.5 s (**667 ops/s**), slowest request 0.93 s (500 ops) | |
| Sync push: review events | 12 000 events, 24 requests | 6.4 s (**1 865 ops/s**) | each op is its own transaction (idempotent by op id) |
| Sync push: ink strokes on one page | 5 000 strokes × 40 samples | 3.1 s (**1 629 ops/s**) | |
| Learning reads with 3 000 cards / 12 000 events | — | review queue p50 **119 ms**; home 118 ms; **forecast 467 ms**; weakness 3.5 ms; card list 7 ms; full SRS rebuild 331 ms | forecast is the slowest learning read (replays every card) — acceptable for a screen opened on demand, not optimized |
| One page with 5 000 strokes | `GET /api/annotations/by-targets` | p50 **298 ms**, payload **7.5 MB** JSON (document download `GET /api/annotations/source/:id` 271 ms) | no HTTP compression in the server (limit) |
| Fresh device: full initial pull | 20 000 changes (cards, events, strokes) | 1.15 s server side, 20 pages × 1 000, 14.5 MB | the browser side of a first sync is much slower — see the browser table |
| **Crash: SIGKILL mid-processing, restart** (real process) | 300-page lecture, killed after page 100 | **before fix: resumed 61.6 s after the restart; after: 1.8 s** (boot 1.6 s), completed 13.9 s after the restart | integrity, before and after: job `completed` on attempt 2; 300 page checkpoints; the 100 checkpointed pages NOT redone (200 written after the crash = 199 pending + 1 in flight); 4 692 regions / 1 030 chunks — identical to an uninterrupted run; 0 duplicated reading orders, review items or image assets; every page's regions equal its checkpoint |

## Results — browser (headless Chromium 141, desktop 1280×800)

Load average on the VM during the final desktop run: 2.9 at start, 7.5 at the end (other agents' test suites) —
times are therefore upper-end; canvas counts and heap sizes do not depend on load. JS heap = CDP
`Performance.getMetrics` JSHeapUsedSize after `HeapProfiler.collectGarbage`. Long task = main thread blocked > 50 ms
(PerformanceObserver `longtask`).

| scenario | size | measured | notes / limits |
|---|---|---|---|
| Open the reader on a long lecture | 300 pages | navigation → first page canvas **1.13 s** (goto → canvas visible 1.40 s; DOMContentLoaded 49 ms); JS heap 10.3 MB | phone project (390×844, DPR 2): 2.5 s / 3.0 s, heap 27.2 MB |
| Scroll through every page, one page at a time | 300 pages | scroll → that page's canvas painted: p50 **365 ms**, p95 670 ms, max 1.18 s (quieter earlier run: p50 309 ms, p95 563 ms); 143 long tasks in ≈ 2 min, longest **126 ms** | phone: p50 79 ms (the next pages are already rendered inside the ±1-viewport window), p95 853 ms, longest task 148 ms |
| Virtualization (canvases in the DOM) | 300 page elements | **≤ 3 page canvases** at any time on desktop (≤ 5 on phone), canvas backing stores ≤ 12.4 MP; after a fling to the top: 2 page canvases, first page painted 300 ms after the fling | 3 ink canvases per rendered page (highlight / ink / live) |
| Memory after visiting all pages | 300 pages | JS heap after GC **20.8 MB** (before fix #4: 125.4 MB); samples during the scroll 21–43 MB (uncollected garbage) | phone: 34.7 MB |
| Ink: 5 000 strokes on one page, fresh browser profile | 5 000 × 40 samples (7.5 MB JSON) | open → all 5 000 strokes loaded and painted **10.6 s** (download + 5 000 IndexedDB rows + paint); 7 long tasks during open, longest 393 ms; before fix #6: 377 strokes shown after 120 s | the number is dominated by the 7.5 MB download and the IndexedDB writes of a first visit |
| Ink: a new stroke on that page (mouse) | 30 move events | committed **65 ms** after pointerup; **0 long tasks** during the stroke | mouse through Playwright — says nothing about Pencil latency |
| Ink: zoom in with 5 000 strokes | one zoom step | 1 long task of **397 ms** (every stroke repainted at the new scale) | not optimized (no cached ink bitmap per zoom level) |
| Review hub, first visit on a new device | 3 000 cards + 12 000 events | sync + fold until the hub shows the due count: **146 s** under load 6–8; CPU profile under load ≈ 1.3: ≈ 55 events/s before fix #7, ≈ 250 events/s after (main thread mostly idle) | 283 long tasks, longest 639 ms; bounded by one IndexedDB transaction set per pulled change (limit) |
| Review hub, later visits (fold from IndexedDB) | same | hub with «1089 بطاقة مستحقة الآن» **1.05 s** after reload; 5 long tasks, longest 181 ms | the FSRS fold alone (Node, `test/learning/queue.perf.test.ts`): 3 000 cards / 12 000 events → 1 089 due, **64–70 ms** median of 5 runs (first, cold run 165–174 ms), load 0.7 |
| Reload with a stroke in flight + a note typed just before | 3 strokes + 1 note | 3/3 completed strokes in IndexedDB after the reload; note recovered **141 ms** after the reload was ready (49 ms in an earlier run), then on the server | before fix #5 the note was lost |
| Offline → online | 2 strokes + 1 note written offline | 4 pending outbox ops, 0 on the server while offline; on the server **262 ms** after the network returned (fresh server) | **39.5 s** when the same test ran on a server already holding ≈ 20 000 records of the other scenarios: the new profile was still in its first pull and the queued push waited for that pull (limit) |

## Hot spots found and fixed (each with a regression test that fails on the old code)

| # | what was measured | cause | fix | before → after | test |
|---|---|---|---|---|---|
| 1 | 48 MP photo processing | full RGBA decode (raw + unfiltered + RGBA buffers) for quality metrics of an image that is never OCR'd | `pipeline.ts processImagePage`: pixel count first; no decode above `MAX_OCR_PIXELS` | 2.6 s / +568 MB → 11 ms / +1 MB | `apps/server/test/processing/large-image.test.ts` |
| 2 | Question Vault filtered by source (and exam candidates by source, universal search with a source filter) | correlated `o.question_id = q.id AND o.source_id = ?` driven through the single-column source index: O(questions × occurrences) | migration `0510_question_occurrence_lookup.sql`: index `(question_id, source_id)` | 1 953 ms → 55 ms (vault page); 1 084 → 2.7 ms; 794 → 8.4 ms (statements) | `apps/server/test/questions/occurrence-lookup.test.ts` (query plans) |
| 3 | resume after SIGKILL + restart | the crashed job's heartbeat was fresh, so the new process waited for the 60 s stale window | `processing_job.worker_id` (migration `0030_job_worker.sql`); a claimer that is provably gone (same host, pid gone, or own pid with another boot nonce) is re-queued at once; unknown/live owners keep the heartbeat rule | 61.6 s → 1.8 s | `apps/server/test/jobs-crash.test.ts` + `test/perf/crash-resume.perf.test.ts` |
| 4 | reader memory while scrolling 300 pages | pdf.js keeps operator lists + decoded objects per rendered page until `cleanup()`; the reader cached every page proxy | `reader/pdfDoc.ts`: clean up pages outside the 16 most recently used | JS heap after GC 125.4 MB → 20.9 MB after visiting all 300 pages | `apps/web/src/features/workspace/reader/pdfDoc.test.ts` |
| 5 | note text typed right before a reload | the editor saves 600 ms after the last keystroke or on unmount; a reload/crashed tab does neither | synchronous localStorage draft per keystroke (`data/noteDrafts.ts`), recovered into IndexedDB + outbox on the next load (same note id → no duplicate; changed elsewhere → kept as a new note) | old build: note lost; new build: in IndexedDB 49 ms after the reload, then on the server | `apps/web/src/features/workspace/data/noteDrafts.test.tsx` + `e2e/perf.spec.ts` |
| 6 | 5 000 strokes on one page | (a) highlight / bookmark / re-anchor live queries scanned all strokes and re-ran on every ink write — O(n²) while the pull delivered strokes one by one; (b) the reader's download at open did not tell the open ink layer; (c) the pull rewrote strokes already held at the same revision | local schema v2: `[targetKey+kind]`, `anchorStatus` indexes + indexed queries; one page reload after `mergeServerAnnotations`; applier skips same-rev synced rows | 377 of 5 000 strokes shown after 120 s → all 5 000 (see browser table) | `apps/web/src/features/workspace/data/annotationsAtScale.test.tsx` |
| 7 | first sync of 3 000 cards + 12 000 events in a fresh browser | `useLocalCards` whole-table live queries re-read both tables and every consumer re-folded all cards after nearly every pulled change (> 50 % of the main thread in a CPU profile) | `review/local/hooks.ts`: Dexie `storagemutated` + leading/trailing coalescing (≤ 1 re-read per 400 ms during a burst; a single write after a quiet period is immediate) | ≈ 55 → ≈ 250 events/s reaching IndexedDB | `apps/web/test/learning/local-cards-burst.test.tsx` (old: 153 re-reads for 300 writes) |

## Resilience (§58)

| scenario | result |
|---|---|
| Server killed with SIGKILL mid-processing, restarted on the same data dir | resumes from page checkpoints, nothing duplicated or lost (table above); resume latency fixed (#3) |
| Graceful stop (SIGTERM) mid-job | running job re-queued with its attempt given back (existing behaviour, `test/jobs.test.ts`) |
| Browser reload with a pen stroke in flight | the 3 completed strokes are in IndexedDB after the reload and reach the server; only the stroke in flight (pen still down) is lost |
| Browser reload right after typing a note (before the 600 ms save) | **was lost; fixed (#5)** — recovered on load, then synced |
| Offline → online | writing (2 strokes + a note) stays on the device with 4 pending outbox ops while offline, server has 0; everything on the server **262 ms** after the network returns, outbox drained |

## Limits and what was NOT measured (honest)

* **No device numbers.** No iPad / iPhone / Android, no Apple Pencil, no Safari, no Firefox, no GPU. Headless
  Chromium on a VM is not a device: no FPS, pen-latency or battery claim is made anywhere in the product or here.
  Ink input was the mouse through Playwright. Long tasks are reported where the claim would otherwise be «smooth».
* **OCR throughput** is ≈ 7.6 s per A4 page at 200 dpi with one tesseract worker on this VM; scanned books are slow
  (≈ 36 min for 300 pages). Parallel OCR workers / per-page job fan-out are not built.
* **Photos above 40 MP are not OCR'd** (kept as a figure with a reason); there is no image library to downscale them.
* **Answer keys printed as long wrapped lines** (one key line continued on the next lines without a section label)
  are kept as `ambiguous_section` with a review item in multi-section banks instead of being bound — safe abstention,
  lost recall (965 of 2 000 keys in the perf bank, none bound). Recorded in `docs/modules/questions.md`.
* **First sync of a large deck on a new device** is bounded by one IndexedDB transaction set per pulled change in the
  sync engine (≈ 250 changes/s here after fix #7): 15 000 learning records ≈ 1 minute. Batched appliers are not built.
* **No HTTP compression**: a page with 5 000 strokes is a 7.5 MB JSON answer.
* `GET /api/learning/forecast` replays every card (430 ms for 3 000 cards); not optimized.
* Server RSS peaks of 800–900 MB during the 300-page run and the 20 000-change pull are mostly collectable garbage
  (V8 grows its heap lazily); a small server should set `--max-old-space-size` — not tested on a 1 GB machine.
* Memory figures are process-level (`process.memoryUsage`, `getrusage maxrss`) sampled every 20 ms; the sampler cannot
  run while the event loop is blocked, so sampled peaks can be under-estimates (the maxrss figures are exact).
