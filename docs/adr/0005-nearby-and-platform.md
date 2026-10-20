# ADR-0005 — Nearby classroom sync and the client platform (PWA + native shell, not a rewrite)

- **Status:** Accepted for design, 2026-10-20; revised the same day after the design review (per-joiner QR pairing,
  server-signed offline credentials, room key never in a QR, peer files quarantined, native work right after Phase 1).
  Nothing here is implemented. Owner questions use the numbers of PRD §11; timing follows PRD §5.3.
  * **Part A** (transports): the parts marked «ships first» can be built and partly tested in this container (headless
    Chromium only).
  * **Part B** (native shell): this container cannot build or test it. It needs cloud CI on macOS runners,
    TestFlight / Google Play internal testing, and real devices.
- **Depends on:** ADR-0003 (users, devices, spaces), ADR-0004 (layers, CRDT updates, relay bundles, version vectors).
- **Spec:** Academic OS §11 (nearby offline classroom sync), §12 (rooms), §20 (tablet-first, e-ink), §21 («Flutter,
  KMP or native may be studied, native modules where needed»), §22 («Android ↔ iPad when the transport is supported»,
  «do not assume P2P behaves the same on every system»). Owner clarifications 1–4: no computer; store apps; iPad +
  Apple Pencil first, then one Android app for Samsung S Pen and BOOX; e-ink mode.

## 1. Context — what was measured and what is only documented

Labels used below: **TESTED** = run in this container; **DOC** = public documentation or registry metadata only, not
tested; **?** = unknown.

* **Spike 2a — WebRTC DataChannel with manual (QR-style) signaling and `iceServers: []`.** TESTED, but only
  Chromium 141 ↔ Chromium 141 on one host.
  * The DataChannel connected in every mode (two contexts, two separate processes, raw-IP mode) using host candidates
    only. RTT ≈ 1 ms; `maxMessageSize` 262,144.
  * By default Chromium hides local IPs behind `<uuid>.local` mDNS names. These names resolved even between two
    processes.
  * The answerer finished gathering in 7–20 ms. The **offerer never reached `iceGatheringState: 'complete'`** within
    30 s (3/3 runs).
  * 5 MiB arrived intact in 0.4–1.4 s (28/28 sha256 matches); the first, cold run took ≈ 3.4 s.
  * The SDP is 557–586 B, or ≈ 402–428 B after deflate-raw: a version 13–16 QR code at error-correction level L.
* **Spike 2b — LAN «classroom hub» (the existing server on a laptop, plain http to a LAN IP).** TESTED in Chromium.
  * The page is not a secure context. There is no service worker (so no offline install), no `crypto.subtle`, no
    `crypto.randomUUID` and no `navigator.mediaDevices` (so no recording).
  * IndexedDB and `RTCPeerConnection` work.
  * A self-signed https certificate gives a secure context once the error is bypassed, but **service-worker
    registration still fails**.
  * The server binds `127.0.0.1` by default. A hub needs `MEDLEVO_HOST=0.0.0.0`, and the LAN origin added to
    `MEDLEVO_ORIGIN`.
* **Spike 2c — native transports.** DOC only.
  * **Web Bluetooth:** Chrome on Android, ChromeOS, macOS and Windows; not Safari (macOS or iOS) and not Firefox. It is
    central-only, so two browsers can never pair. TESTED here: absent in headless Linux Chromium.
  * **Android Nearby Connections:** offline P2P over Bluetooth, BLE and Wi-Fi through Google Play services; strategies
    STAR, CLUSTER and POINT_TO_POINT. The docs list a Swift library; Android↔iOS interop is not verified.
  * **Apple MultipeerConnectivity:** iOS and macOS only. It disconnects all sessions when the app goes to the
    background.
  * **npm plugins:** `@capacitor-community/bluetooth-le` 8.3.0 (maintained); `@capacitor-trancee/nearby-connections`
    0.2.6 (last release 2025-03, stale); no Multipeer or PencilKit Capacitor plugin was found.
* **Spike 4a — the current web ink renderer.** TESTED with headless Chromium and SwiftShader software raster, using the
  real `render.ts`.
  * A live stroke frame costs 2.5–4.4 ms median, so the live path is not the bottleneck.
  * **Full-page repaints are the bottleneck.** A realistic page with 5,000 strokes (1.13 M points) took 3.8 s for a warm
    repaint and 3.0 s for a zoom step.
  * The docs/PERFORMANCE.md fixture of 40-point strokes takes 0.7–1.0 s.
  * Headless software raster is not a device: no pen-latency or FPS figure is claimed.
* **Spike 4b — rewrite or shell.**
  * A rewrite would re-implement ≈ 60.7k lines of web client in 339 files, ≈ 14k lines of CSS and 8.6k lines of shared
    contracts, and port 110 web test files. The built `dist` is 5.6 MB.
  * Tooling: no Android SDK, emulator or KVM; no Xcode, Swift or macOS; no Flutter, Dart or kotlinc; no Docker daemon.
    Present: Java 21, Gradle 8.14.3, cmake, g++ and ffmpeg.

## 2. Decision A — Transports for rooms and nearby sync, in this order

### A.1 Online rooms through the server (ships first; testable here)

Rooms (§12) first work over the internet through the space:

* a WebSocket at `/api/spaces/:spaceId/live` (ADR-0004 §2.3.3, ARCHITECTURE_DELTA §8.5);
* presence, in-progress strokes as transient awareness messages, `crdt_update`s, room events and the room timer;
* clocks use server time, with a measured skew per device.

This covers group study, teaching and exam rooms whenever a connection exists. It is the baseline the nearby paths
must match.

* **Live strokes** are batched (≤ 10 batches per second per writer) inside per-role frame limits (ARCHITECTURE_DELTA
  §8.5); the 200-participant online room is unmeasured until the PRD NFR-OP2 load test.
* **Voice is not designed for online rooms.** Relaying audio between browsers across networks needs TURN servers or an
  SFU, which cost money to run (PRD Q30). Until the owner decides, online teaching rooms carry pen, presence and text
  live and voice only as a recording; offline peer rooms on one network can carry WebRTC audio directly (A.2).

### A.2 WebRTC DataChannel on the same Wi-Fi or hotspot, QR-paired (ships first in the PWA; partly testable here)

**Why this is the main nearby path.** The PWA is installed from the **https cloud origin**. When that installed PWA is
opened with no internet, it runs from its service-worker cache and is still a **secure context**, so `crypto.subtle`,
`mediaDevices` and IndexedDB stay available. That is unlike the http LAN hub of A.3. WebRTC needs no internet: host
candidates on the classroom Wi-Fi or a phone hotspot are enough (measured, same host).

**Before going offline: a server-signed credential.** Offline, nobody can ask the server who a joiner is: a
self-asserted name proves nothing, and device keys live only in the system DB. So while online (when the room is
scheduled, or when the app opens a subject with a room planned), each participant's device fetches a short-lived
**`RoomCredential`** (ARCHITECTURE_DELTA §7.10): user id and display name, server-issued device id and device key,
subject membership and maximum room role, expiry ≤ 24 h, signed with the server's Ed25519 key, whose public key every
client caches. Peers verify credentials offline. A device without a valid credential cannot join an offline room, and
members-only lecture packages (AOS-11.9) never reach a non-member.

**Pairing — one QR exchange per joiner.** A WebRTC offer belongs to one `RTCPeerConnection`, so one host QR cannot serve
several joiners. For each joiner the host shows a **fresh offer QR**; the joiner scans it and shows an answer QR that the
host scans: two scans **per joiner**, and the UI says so («امسح رمز كل زميل بدوره»). Thirty joiners therefore mean sixty
scans; that is slow but honest, and a room that size should use the online server or a hub (A.3).

* QR 1 (host → one joiner) carries the room id and name, a joiner slot id, the deflated SDP offer and the fingerprint of
  the host's device key — **never the room key**:

  ```json
  { "v": 1, "room_id": "…", "room_name": "…", "joiner_slot": "…", "sdp": "<deflated base64>",
    "host_key_fp": "<sha256 of the host's Ed25519 key>", "exp": 1234567890 }
  ```

  One compressed SDP fits a version 13–16 QR at level L (measured).
* QR 2 (joiner → host) carries the deflated answer, the slot id and the fingerprint of the joiner's device key.
* **After DTLS is up**, the joiner sends its `RoomCredential`; the host checks the server signature, the expiry, the
  room, and that the device key matches the fingerprint in QR 2. Only then does the host send the room key, wrapped to
  the joiner's device key. Anyone who photographs a QR gets neither the room key nor access.
* **Trickle rule.** The offer is taken after the **first host candidate plus a 300 ms grace period**. The app never
  waits for `icegatheringcomplete`, because the offerer never reached it in 30 s.
* **Session codes need a server or a hub.** A browser cannot listen for incoming connections, so a short session code
  (base32 in 4-character groups, hashed, expiring and rate-limited — the `setup-token.ts` format) replaces the QR
  exchange **only** when the cloud server or a LAN hub (A.3) is reachable to carry the signaling. Offline without a hub,
  pairing is by QR only, and the UI never shows a code as working offline.
* **Topology.** A star around the host. The host relays CRDT updates and room events to the others. Full mesh is not
  attempted: the risk grows with the number of peers and it was not measured. The default room size of 30 (PRD Q27) is
  **untested**: spike 2a used two peers.

**Security.**

* **Transport.** WebRTC uses DTLS. The SDP inside the QR carries each side's DTLS certificate fingerprint, and the QR is
  shown face to face, so a man in the middle cannot swap fingerprints without also replacing the QR.
* **Application layer.**
  * Every relay bundle (ADR-0004 §2.6) is signed with the origin device's Ed25519 key. The key is registered in the
    system `device` table when the device is online.
  * Room payloads are encrypted with a per-room AES-256-GCM key from the QR. Relays and the host can forward ciphertext
    they cannot read when the room is configured that way (A.4).
* **Consent.**
  * Joining requires an explicit «انضم» (join) tap that shows the room name and the host's display name.
  * Nothing from a vault is sent automatically. Only items the user explicitly shares into the room, and the room's
    own shared layer, travel.
  * Received files are untrusted. The content-sniffing and safe-zip checks (`sources/sniff.ts`, `lib/safe-zip.ts`)
    exist only on the server, so a file received from a peer is checked by sha256 and then **quarantined** on the
    device: stored but never opened, previewed, indexed or forwarded as content until it has been uploaded and has
    passed the server's checks («لم يُفحص بعد»). Porting a subset of the checks to `packages/shared` is a later option.

**What is honestly unknown.**

* The installed PWA opened with no internet, then paired over WebRTC. The secure-context rules lead us to expect it
  to work, but it was not run.
* Real Wi-Fi between phones.
* Safari/WebKit and Firefox WebRTC with `iceServers: []` and mDNS candidates.
* Android WebView.
* Campus networks with **AP/client isolation** or multicast filtering, which can block both host candidates and mDNS.
* Throughput over real Wi-Fi.
* **The host going to the background.** iOS suspends a locked or backgrounded PWA (and Multipeer drops sessions when the
  app leaves the foreground, DOC). The host is the star's only relay, so a host whose screen locks may stall the room.
  Mitigations to test on devices: the host keeps the screen awake while hosting, any participant can take over as host,
  and peers keep writing locally meanwhile.
* Rooms larger than two peers (30 is the untested default).

The capability `nearby.webrtc` becomes `available` only after the device's own probe has opened a test DataChannel;
the CAPABILITY_MATRIX ink-panel pattern applies. Until then it is `not_implemented` (before the build) and then
`requires_connection`, with the reason «لم يُختبر هذا الجهاز بعد» (not tested on this device yet).

### A.3 Classroom hub on a laptop (optional, after A.2)

A student's laptop runs the existing server bound to the LAN. That is useful when a room has no internet and many
devices, because the hub becomes the sequencer.

* **Limits, measured:** over plain http there is no offline install, no recording and no `crypto.subtle` (the existing
  pure-JS SHA-256 fallback in `offline.ts` covers hashing).
* A self-signed certificate does not restore service workers.
* A certificate the devices trust (an installed CA, or a public DNS name for the hub) is **untested** and, with the
  owner's «no computer» constraint, is not the default path.
* In the multi-user design the hub is a **space replica** for that room only. It later uploads to the real server
  through the same relay-bundle path.

Decision: **design for it, build it after A.2**, and only if classroom trials show A.2 failing on campus Wi-Fi.

### A.4 Store-and-forward and peer relay (studied; off by default)

Store-and-forward spreads updates inside a hall to devices that cannot reach the host directly. The rules:

* **Opt-in** per device («ساعد في نقل التحديثات داخل القاعة» — help relay updates inside the hall) and per room.
* **Ciphertext only.** A relay stores bundles that are already encrypted with the room key it does not hold, when the
  room is created in relay-blind mode. Otherwise the room key is held only by members.
* **Bounded.** TTL 24 h, a size cap, and deletion after the server or host confirms receipt.
* **Version vectors decide what to forward** (ADR-0004 §2.6). A relay never forwards a bundle the receiver's vector
  already covers.
* **The server re-verifies** signature, membership and layer permission before it applies anything a relay uploads
  (ARCHITECTURE_DELTA §8.6). A relay therefore cannot spoof or escalate.

It can be simulated here with several Chromium contexts and dropped links. A realistic test needs several real devices
in a hall.

### A.5 Native accelerators inside the shell (later; needs devices)

Native transports are optional accelerators. They plug into the **same** bundle, CRDT and pairing layer, so the rest of
the app does not change.

* Android: Nearby Connections (STAR strategy).
* Apple devices: MultipeerConnectivity, which is foreground-only (DOC).
* Both: BLE for **discovery only** (advertising the room id). Data still moves over Wi-Fi.

The app never assumes a transport exists. Each one is a capability probed on the device (`nearby.native`).
Android↔iPad interoperability is reported as «لم يُختبر» (not tested) until it has been tested on real devices.

## 3. Decision B — Client platform: keep the PWA and add a native shell; do not rewrite

### B.1 Shell

The existing web app is wrapped in **Capacitor** (or an equivalent shell) for the App Store and Google Play. The same
bundle and code serve the web, the iOS app and the Android app. Reasons:

* The rewrite cost of B (≈ 60.7k lines plus 110 test files) would buy mainly the ink surface, and a native plugin
  provides that anyway.
* Owner clarification 2 asks for exactly this: «a native, low-latency ink surface … inside a native shell that reuses
  the existing web app and the same stroke data model and sync — not a rewrite».

Flutter, Kotlin Multiplatform and fully native rewrites are rejected for now. They would discard tested code and make
two codebases (web and app) diverge.

### B.2 Native plugins, in this order

1. **Ink surface for iPadOS.** Swift, using PencilKit or a custom Metal renderer. A transparent native view sits over the
   web page region being written on and gives:
   * Apple Pencil prediction, pressure, tilt and hover;
   * double-tap and squeeze where the hardware has them;
   * system palm rejection.

   Committed strokes are converted to MedLevo `InkPoint` (normalised to the unrotated page box) and written through the
   **same** IndexedDB outbox and sync ops, so the stroke data model and sync stay the same. The web canvas keeps
   rendering committed strokes.
2. **Android ink surface.** Front-buffered rendering with motion prediction from the Android graphics and ink libraries,
   for Samsung S Pen (pressure, tilt, side button). On BOOX, the vendor's public pen SDK is used when present, falling
   back to the generic path. One Android app covers both.
3. **Recording.** A recorder plugin with the iOS `audio` background mode and an Android microphone foreground service
   (`@independo/capacitor-voice-recorder` exists on npm, DOC). The PWA recorder stays as is, and refuses without a
   secure context (`recorder.ts:57`).
4. **Nearby transports** (A.5), then the filesystem (`@capacitor/filesystem`, DOC) for large offline packages.

Native ink is tested on devices only. CAPABILITY_MATRIX rule §27 still holds: mouse or simulated input never validates
Pencil quality.

### B.3 Web ink work that ships first (testable here)

Spike 4a shows full repaints of dense pages are the bottleneck. The fix needs no native code:

* cache committed ink as **bitmap tiles per zoom level**;
* during zoom, re-raster lazily from the cached tiles;
* paint new commits incrementally (dirty rectangles already exist);
* decode v2 packed points (ADR-0004 §2.5) off the main thread.

Budget, to be measured in CI with the same harness: a warm repaint of a realistic 5,000-stroke page under 200 ms
after tiling. Device numbers are recorded only when measured on the device.

### B.4 E-ink mode (web now, native later)

E-ink mode is a user setting, and is suggested automatically when the device reports `(update: slow)` or the user picks
BOOX. It means:

* no animations or transitions (it builds on the existing `data-reduce-motion`);
* high contrast and a black/grey ink palette;
* paging instead of smooth scrolling;
* minimal repaint: no live-stroke prediction overlay on the web.

### B.5 Builds and hosting without a computer

* **Store builds** come from GitHub Actions: macOS runners for iOS, Linux for Android. TestFlight and Play internal
  testing are triggered from the GitHub web UI.
* **Signing material** lives in GitHub encrypted secrets.
* **Accounts.** The owner needs an Apple Developer account and a Google Play developer account (PRD Q19), decided by
  the dated decision points D-A (2026-12-15) and D-G (2027-02-15) of PRD §5.3.
* **Timing (PRD §5.3, the one timing statement).** Pen latency is first-class and the iPad comes first (owner
  clarifications 2 and 4), so native work does **not** wait for the web phases: the Capacitor skeleton and CI files ship
  in Phase 1; the signed iPad shell (PL-1) and the iPad native ink surface (PL-2) start **immediately after Phase 1, in
  parallel with Phase 2**; the Android app for S Pen and BOOX (PL-3) and the recorder plugin run in parallel with Phase
  3; native nearby transports with Phase 4; the App Store listing at the end of the Phase 2 window and Google Play with
  Phase 3.
* **Server.** The server stays on Render with a persistent disk. Cloudflare R2 holds off-site backups now and becomes
  the blob store later, behind `ctx.files` with the same content-addressed keys (owner clarification 5).

## 4. Platform matrix (honest)

| capability | Android Chrome | iPhone / iPad Safari, PWA | desktop Chrome | desktop Safari / Firefox | Capacitor shell, iOS | Capacitor shell, Android |
|---|---|---|---|---|---|---|
| Online rooms over WebSocket (A.1) | DOC (standard API); untested | DOC; untested | will be TESTED in CI (headless Chromium) | DOC; untested | ? | ? |
| WebRTC DataChannel, QR signaling, no STUN/TURN (A.2) | ? same engine, never run on a device or over Wi-Fi | DOC (WebKit supports DataChannel); untested; in-page QR scanning needs a JS decoder (untested) | **TESTED** headless, one host: 2 contexts and 2 processes; 5 MiB in 0.4–1.4 s; offerer never «complete» | DOC; untested | ? | ? |
| LAN hub over http (A.3) | — | — | **TESTED**: not a secure context; no SW, `crypto.subtle` or `mediaDevices`; self-signed https: SW registration fails | spec-level, expected the same; untested | app-local pages avoid it (DOC) | same (DOC) |
| Web Bluetooth | DOC shipped | DOC **not supported** | DOC shipped (Windows/macOS/ChromeOS); Linux behind a flag; TESTED absent in headless Linux | DOC not supported | native BLE plugin (DOC) | native BLE plugin (DOC) |
| Nearby Connections | native only | — | — | — | Swift library listed (DOC); interop unverified | plugin 0.2.6, stale (DOC) |
| MultipeerConnectivity | — | native only | — | macOS native only | custom Swift (DOC; backgrounding drops sessions) | — |
| Low-latency stylus | Pointer Events (measured with a mouse only) | Pointer Events; system palm rejection **requires native** | Pointer Events | Pointer Events | PencilKit/Metal plugin (DOC; not buildable here) | front-buffered + prediction; BOOX SDK (DOC) |
| Background recording | — | iOS PWA background behaviour ? | — | — | `audio` background mode (DOC) | microphone foreground service (DOC) |
| Offline storage | IndexedDB | IndexedDB; eviction behaviour ? | IndexedDB TESTED | ? | filesystem plugin (DOC) | filesystem plugin (DOC) |

Rule: a cell moves to TESTED only with the device, OS, browser or app version and the date recorded in
`docs/CAPABILITY_MATRIX.md`.

## 5. What ships first (testable here) vs later (needs devices)

| testable in this container (Phases 1–4) | needs devices, cloud CI or native toolchains (timing per PRD §5.3) |
|---|---|
| Online rooms over WebSocket; presence; room timer; CRDT relay through the server (Playwright, 3 contexts) | Nearby Connections, Multipeer and BLE discovery (native plugins) |
| WebRTC DataChannel rooms with QR and session-code pairing, chunked transfer with resume, signed and encrypted bundles (Chromium contexts; QR encode/decode from images) | Real classroom Wi-Fi trials (AP isolation, mDNS), Android ↔ iPad interop |
| Device keys, relay bundle verification, version-vector catch-up, store-and-forward simulation with dropped links | Store-and-forward with real devices in a hall |
| Web ink tiling and incremental repaint, e-ink mode, capability probes | iPad PencilKit/Metal ink surface, Android front-buffered surface, BOOX SDK, latency measurements |
| Capacitor project skeleton and CI workflow files (static checks only) — Phase 1 | Signed iPad build and TestFlight right after Phase 1 (parallel with Phase 2); Android build and Play internal testing with Phase 3 |
| — | Battery and thermal measurements while recording and writing (§22) |

## 6. Capability registry additions (`packages/shared/src/features.ts`)

New keys:

* `rooms.online`, `nearby.webrtc`, `nearby.lan_hub`, `nearby.native`, `nearby.relay`;
* `ink.native_surface`, `recording.background`, `ui.eink_mode`.

Each key is `not_implemented` until it is built, then probed per device. The existing states cover the rest:
`requires_native` with the Arabic reason «يتطلب تطبيق MedLevo على الجهاز» (needs the MedLevo app on the device),
`requires_connection`, and `available` only after the device's own probe succeeded.

## 7. Consequences

* **One codebase** for web and app. Native work is limited to plugins with narrow contracts (ink points in, files and
  bundles out).
* **The nearby story is honest.** Same Wi-Fi or hotspot plus QR is the common path. Every native radio is optional and
  probed.
* **Risks.**
  * Campus Wi-Fi isolation could block A.2. Mitigation: the hotspot path (a host phone's hotspot), then A.3.
  * WebKit WebRTC differences are untested.
  * The native ink plugin must keep the overlay view in sync with web scrolling and zoom. This is its hardest problem
    and the first device test.

## 8. Open questions (owner) — with defaults

1. **Room size limit for the offline star topology** (PRD Q27). Default: 30 devices per host — **untested** beyond two
   peers, each paired by its own QR exchange. Above that, the room requires the online server or a hub.
2. **Relay mode** (Q32). Default: off. Rooms are created «relay-blind» (relays cannot read) when the host enables
   relaying.
3. **Store accounts and native timing** (Q19). Default (PRD §5.3): the iPad shell and native ink start right after
   Phase 1, in parallel with Phase 2, and Android with Phase 3; the Apple account is decided by 2026-12-15 (D-A) and the
   Google account by 2027-02-15 (D-G). Without an account the dependent rows are reported «Not run (no account)».
4. **Online room voice** (Q30). Default: not designed until the owner accepts the TURN/SFU running cost.
