# Pen / ink capability matrix (spec §27, AC-28)

> Owner of this file: ink engine track (`apps/web/src/features/workspace/ink`).
> Last updated: 2026-10-09.
> Rule (§27): *mouse or simulated input does not validate Apple Pencil quality or palm rejection.*
> Nothing in this table was tested with a real stylus. Every cell that says "tested" names the
> environment it was tested in.

The app also shows a **live** version of this table on the device itself: toolbar → «المزيد من
أدوات الكتابة» → «قدرات القلم على هذا الجهاز». That panel only reports what the current browser
actually delivered in Pointer Events on that device (a capability is «مدعوم ورُصد هنا» only after an
event carried it), plus a test area to write/hover in. It never infers capabilities from the device
name. Offline writing is reported as supported only after the panel actually opened the local
IndexedDB database on that device (the `indexedDB` global alone is not proof: private modes expose it
and then refuse to open).

## Status values

| status | meaning |
|---|---|
| **Implemented & tested (env)** | the code path exists and an automated test exercised it in the named environment (headless Chromium 1194 on Linux via Playwright with **mouse** input, or jsdom + fake-indexeddb) |
| **Implemented, not tested on device** | the web code exists and its logic is unit-tested with synthetic events, but no real device/pen of that platform was available |
| **Not available on web (requires native)** | the platform does not expose it to web pages; it needs a native iPad layer (UIKit / PencilKit) |

## Matrix

| capability | Desktop Chrome / Edge | Desktop Firefox | Desktop Safari (macOS) | iPadOS Safari / installed PWA | Android Chrome (stylus) | Native iPad layer (future) |
|---|---|---|---|---|---|---|
| **Pressure** (`PointerEvent.pressure`) → variable width; `pressure_available` recorded per stroke | Implemented, not tested on device (pen tablets). Mouse verified to record `pressure_available: false` — Implemented & tested (env) | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device | Not built (would use `UITouch.force` / PencilKit) |
| **Tilt** (`tiltX/tiltY`, or derived from `altitudeAngle/azimuthAngle`) — stored with points, not used for rendering yet | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device | Not built |
| **Hover** (pen `pointermove` with `buttons = 0`) — detected for the capability panel and to switch the layer to `touch-action: none` before contact | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device; **not verified** that iPadOS Safari delivers Pencil hover as pointer events | Implemented, not tested on device | Not built (`UIHoverGestureRecognizer`) |
| **Palm / finger rejection** | Heuristic (see below): Implemented, not tested on device. Logic unit-tested (jsdom) | same | same | Heuristic implemented, not tested on device. **System palm rejection: Not available on web (requires native)** | Heuristic implemented, not tested on device | Native system palm rejection — not built |
| **Low-latency ink** — `getContext('2d', { desynchronized: true })` for the live stroke layer | Implemented, not tested on device (BCD: Chrome 81+ on ChromeOS/Windows only). Latency never measured | Not supported by the browser (BCD: no) → normal canvas path | Implemented, not tested on device (BCD: Safari 15+) | Implemented, not tested on device. **PencilKit-level latency: Not available on web (requires native)** | Implemented, not tested on device; BCD lists only ChromeOS and Windows for Chrome, so expect the normal path | PencilKit — not built |
| **Coalesced events** (`getCoalescedEvents()`) — every digitizer sample is captured | Implemented & tested (env): the code path runs in headless Chromium with mouse input; multi-sample delivery from a pen digitizer not tested | Implemented, not tested on device (BCD: Firefox 59+) | Implemented, not tested on device (BCD: Safari 18.2+) | Implemented, not tested on device (BCD: iOS Safari mirrors 18.2+) | Implemented, not tested on device | n/a |
| **Predicted events** (`getPredictedEvents()`) — drawn only on the live layer, never saved | Implemented, not tested on device (BCD: Chrome 77+) | Implemented, not tested on device (BCD: Firefox 89+) | Implemented, not tested on device (BCD: Safari 18.2+) | Implemented, not tested on device | Implemented, not tested on device | n/a |
| **Pencil double tap** | n/a | n/a | n/a | **Not available on web (requires native)** — `UIPencilInteraction` is UIKit-only | n/a | Not built |
| **Pencil squeeze** (Apple Pencil Pro) | n/a | n/a | n/a | **Not available on web (requires native)** | n/a | Not built |
| **Scribble** (handwriting → text) | n/a | n/a | n/a | On the ink canvas: **Not available on web (requires native)**. In ordinary text fields (our text box / sticky note editors are `<textarea>`): a system feature of iPadOS Safari — **not tested** | n/a | Not built |
| **Pen eraser end / eraser button** (`button = 5`, `buttons & 32`) → erases while held | Implemented, not tested on device (Surface Pen, Wacom) | Implemented, not tested on device | Implemented, not tested on device | n/a (Apple Pencil has no eraser end) | Implemented, not tested on device | n/a |
| **Stylus vs. finger scrolling** (pen-only mode: fingers scroll natively, the stylus writes) | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device (`Touch.touchType === 'stylus'` → `preventDefault` on the stylus touch sequence) | Implemented, not tested on device | n/a |
| **Handwriting recognition** (§28) | Built (track F4): the lasso's «تحويل إلى نص» sends only the selected strokes, drawn black on white, to a vision provider on the SERVER; a derived, correctable reading with uncertain words marked. Requires configuration here (no vision provider) — **quality never measured**, server path tested with the test-only fake provider; the original ink is always kept | same (server-side, browser-independent) | same | same | same | Scribble / PencilKit recognition not built |
| **Offline ink** (IndexedDB first, outbox, sync later) | **Implemented & tested (env)**: headless Chromium (Playwright) — strokes written with no server reached IndexedDB + outbox and survived reload; jsdom + fake-indexeddb — offline write, later push, idempotent re-send, conflict keeps both, a failed local write retried with the current state, every engine payload accepted by the server's schema | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device; storage eviction policy on iPadOS not verified here | Implemented, not tested on device | n/a |
| **Position fidelity across zoom / rotation / DPR / reload** (AC-21) | **Implemented & tested (env)** with mouse input: zoom 1, 1.25, 1.5, 2; rotation 0/90/180/270; DPR 1 and 2; reload | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device | Implemented, not tested on device | — |

### The web palm-rejection heuristic (what it actually does)

1. **Pen-only mode** (default on devices with a fine pointer): `pointerType === 'touch'` never writes;
   the layer keeps `touch-action: pan-x pan-y pinch-zoom` so fingers scroll and zoom natively.
2. A stylus touch sequence is cancelled (`preventDefault` on `touchstart/touchmove`) when iPadOS
   reports `Touch.touchType === 'stylus'`, when a stroke is active, or while a pen hovers — so the
   page does not scroll or flip under the pen.
3. With pen-only off (finger writing), contacts wider/taller than 44 css px are treated as a palm,
   touches within 400 ms after the pen lifted are ignored, and a second finger right after the first
   cancels a fresh stroke (it was a pinch/scroll).
4. One pointer at a time: while a stroke is in progress every other pointer is ignored.

This is an approximation. Only a native layer gets the system's palm rejection.

## Official sources checked (2026-10-09)

* W3C **Pointer Events Level 3** — https://www.w3.org/TR/pointerevents3/ : `pressure` "MUST be 0.5 when
  in the active buttons state and 0 otherwise" for hardware without pressure (so a constant 0.5 is
  never treated as real pressure); `tiltX/tiltY` ranges and the `altitudeAngle/azimuthAngle`
  conversion; `altitudeAngle` defaults to π/2 when not reported; pen hover has `buttons = 0`;
  "User agents can trigger panning or zooming through multiple pointer types (such as touch and
  pen)" (why the stylus touch sequence is cancelled explicitly); `getCoalescedEvents()` /
  `getPredictedEvents()`.
* MDN — `PointerEvent.getCoalescedEvents()` (secure contexts; limited availability),
  `PointerEvent.getPredictedEvents()` (Baseline 2024), `PointerEvent.pressure`, CSS `touch-action`,
  `HTMLCanvasElement.getContext()` (`desynchronized` is a latency **hint** the browser may ignore).
* MDN browser-compat-data (`api/PointerEvent.json`, `api/Touch.json`, `api/HTMLCanvasElement.json`):
  `getCoalescedEvents` Chrome 58 / Firefox 59 / Safari 18.2; `getPredictedEvents` Chrome 77 /
  Firefox 89 / Safari 18.2; `pressure`, `tiltX/tiltY` Chrome 55 / Firefox 59 / Safari 13;
  `altitudeAngle/azimuthAngle` Chrome 86 / Firefox 131 / Safari 18.2; `Touch.touchType` Safari on iOS
  only (10+); 2D `desynchronized` Chrome 81 (ChromeOS and Windows), Firefox no, Safari 15.
* Apple — `UIPencilInteraction` (UIKit) is the API for Pencil double tap and squeeze; it exists only
  for native apps. (The developer.apple.com page is script-rendered and could not be read as text
  here; the statement rests on the API being a UIKit class.)

## What has NOT been tested (and must not be reported as passed)

* Any real stylus: Apple Pencil (any generation) on any iPad, Surface Pen, Wacom, Android stylus.
* Real pressure / tilt / hover streams, palm rejection with a resting hand, perceived latency,
  predicted-point quality, 120 Hz behaviour.
* iPadOS Safari and installed-PWA behaviour of `touch-action`, `touchType`, storage eviction.
* Firefox and Safari at all (only Chromium was available).

When a device is available, the on-device panel («قدرات القلم على هذا الجهاز») plus writing on a
real page is the first check; record the result here with the device, OS and browser versions.

## Academic OS capability keys (ADR-0005 §6) — registered (built ones marked)

Added to `packages/shared/src/features.ts` by P1-T1 step 0 (2026-10-20) so the tracks that build them never edit the
registry file. Each one is answered `not_implemented` («لم تُبنَ هذه الميزة بعد في هذا الإصدار.») by
`GET /api/capabilities`, is not listed in the Control Center's «القدرات» yet, and moves to a per-device probed state
(`requires_native` «يتطلب تطبيق MedLevo على الجهاز», `requires_connection`, or `available` only after the device's own
probe succeeded) when its track builds it. No cell below has been run on any device.

| key | meaning | owning work | state |
|---|---|---|---|
| `ui.eink_mode` | e-ink mode (no motion, grey palette, paging) | P1-T2 | **Built (P1-T2 step 2, 2026-10-21)** — `available`; see the section below. Never run on an e-ink screen |
| `ink.native_surface` | native PencilKit / S Pen / BOOX ink surface in the app shell | PL-2 / PL-3 | Not built (needs devices and a native toolchain) |
| `recording.background` | recording that continues in the background | P3-PL | Not built (needs the native shell) |
| `rooms.online` | online study rooms over WebSocket | P4-T2 | Not built |
| `nearby.webrtc` | same Wi-Fi / hotspot rooms over WebRTC with QR pairing | P4-T3 | Not built |
| `nearby.lan_hub` | classroom hub on a laptop | P4-T3 | Not built |
| `nearby.native` | Nearby Connections / Multipeer / BLE through the shell | P4-PL | Not built (needs devices) |
| `nearby.relay` | store-and-forward between devices | P4-T3 | Not built (off by default) |

## Academic OS P1-T3 — lecture identity and version matching (2026-10-20)

No new capability key (ADR-0005 §6 lists none for this track). What depends on a server tool is answered honestly by the
route itself:

| feature | needs | without it | tested here |
|---|---|---|---|
| Page fingerprints, page maps, compare, «إصدار جديد من …», link candidates | nothing beyond processing (text) | — | yes (server tests, E2E phone + desktop) |
| dHash of pages without text | poppler `pdftoppm` (PDF) or a decodable image | the page has no image signal; text pages are unaffected. Honest consequence (review): without a picture, two low-text pages with the same short caption can only be matched by that caption — with `pdftoppm` present the pictures decide (`review-regressions.test.ts`) | yes (pdftoppm present); the «missing» path is the pure matcher only |
| Page images on the compare screen | poppler `pdftoppm` (PDF pages); image pages need nothing | `409 FEATURE_DISABLED` «عرض صور الصفحات يحتاج أداة poppler…»; the screen shows the text excerpt | yes (pdftoppm present; at most 3 renders at a time since the review); the «missing» path is not run |
| DOCX display PDF | LibreOffice (`soffice`) | rendition `unavailable` with «… يحتاج برنامج LibreOffice …»; the DOCX stays readable as paragraphs | yes, both paths (`test/processing/docx-display-pdf.test.ts`) |

Nothing here was run on a phone, an iPad or any real device beyond Chromium in Playwright (390 × 844 touch, 1280 × 800).

## Academic OS P1-T2 — layers, packed ink, tile cache, display modes, native skeleton (2026-10-21)

What this track adds to the pen / screen picture. «Tested (env)» = headless Chromium in Playwright (desktop 1280 × 800
and phone 390 × 844 touch emulation, **mouse** input) or jsdom unit tests. No iPad, Apple Pencil, S Pen, BOOX or any other
real device was available: every device cell is «Not run (no device)».

| capability | web (any browser) | iPad + Pencil | Android + S Pen | BOOX (e-ink) | native shell |
|---|---|---|---|---|---|
| **Layers** — show / hide per study session, «اكتب هنا», read-only layers never changed from a device (server rules R1–R6), re-homing of refused writing to «ملاحظاتي» | Implemented & tested (env): server suite + `test/ink/{layers-visibility,rehome}.test.ts` + `e2e/aos-p1-layers.spec.ts` | Not run (no device) | Not run (no device) | Not run (no device) | n/a (same web code) |
| **Packed ink v2** (`accept-ink: 2`) — zigzag-delta varint points, base64 in JSON; lossless or not used | Implemented & tested (env): `packages/shared/test/ink-codec.test.ts`, `apps/server/test/annotations/ink-v2.test.ts` (5 000 strokes: 19.86 MB → 7.84 MB JSON on the wire, no HTTP compression) | n/a | n/a | n/a | n/a |
| **Dense-page tile cache** (bitmap tiles per zoom level and visible-layer set, cold tiles in raster-timed slices) | Implemented & tested (env): `test/ink/tiles.test.ts` + the before / after harness in `e2e/perf.spec.ts` (docs/PERFORMANCE.md) — headless software raster only | Not run (no device) | Not run (no device) | Not run (no device) | n/a |
| **Live-stroke prediction overlay** (`getPredictedEvents()`) | unchanged (above); **off in e-ink mode** (fewer refreshes) | — | — | Not run (no device) | — |
| **E-ink display mode** (`data-eink`: no animation or transition, black / grey palette and ink — custom pen colours, text boxes and sticky notes included since the review — paging scroll-snap instead of smooth scrolling; dense pages redraw their tiles in greys) — a per-device setting | Implemented & tested (env): `src/design/themeDisplay.test.tsx`, `test/ink/tiles.test.ts` «display modes and tiles», `e2e/aos-eink.spec.ts` (390 + 1280) | Not run (no device) | Not run (no device) | **Not run (no device)** — refresh behaviour, ghosting and pen latency on a real e-ink panel are unknown (OC.5 `[dev]`) | — |
| **E-ink suggestion** — only from `@media (update: slow)`; never from a device name | Implemented & tested (env): the signal is absent in headless Chromium, so nothing is suggested there (asserted) | — | — | Not run (no device): whether BOOX browsers report `(update: slow)` is not known | — |
| **High contrast / lite modes** (`data-contrast`, `data-lite`) | Implemented & tested (env) | Not run (no device) | Not run (no device) | Not run (no device) | — |
| **Copy my notes to a newer version** («انقل ملاحظاتي إلى الإصدار الجديد», step 3 — copy, never move: preview, one tap, report, one-step undo, review list through Round 7's re-anchoring as a copy; no capability key: it needs no provider or tool beyond P1-T3's page map) | Implemented & tested (env): `apps/server/test/annotations/reanchor-copy.test.ts`, `panels/noteMigration.test.tsx`, `e2e/aos-p1-note-migration.spec.ts` (390 + 1280; TEST FIXTURE lecture with pages inserted and reordered) — online only | Not run (no device) | Not run (no device) | Not run (no device) | n/a (same web code) |
| **Native shell** (Capacitor skeleton, `apps/native/`; manual `native-ios.yml` / `native-android.yml`) | Static checks pass here (`node apps/native/scripts/check-native.mjs`, `node --test apps/native/test/static-checks.test.mjs`) | **Not run (no macOS runner, no Xcode, no Apple account)** — nothing was built or signed | **Not run (no Android SDK / device / Play key)** | Not run | `ink.native_surface` stays not built (PL-2 / PL-3) |

Pen-to-pixel latency (NFR-P1), stray-touch rates and a BOOX e-ink check (OC.5, OC.8 `[dev]`) are blocked here — «Not run
(no device)». A mouse in Playwright never validates pen quality (§27).
