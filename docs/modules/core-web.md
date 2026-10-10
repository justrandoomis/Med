# Module notes — web core (`apps/web`)

Track: **Web core + design system**. Owns `apps/web/**` (config, `src/main.tsx`, `src/app/`, `src/design/`,
`src/lib/`, `src/features/{auth,settings,shell}`, placeholder route files for other features),
`docs/design-system.md` and this file. Design rules and component catalogue: [`docs/design-system.md`](../design-system.md).

## 1. What is implemented

| area | files | notes |
|---|---|---|
| Build / PWA | `vite.config.ts`, `index.html`, `public/icons/*`, `scripts/render-icons.mjs` | React plugin; `vite-plugin-pwa` with `registerType: 'prompt'` (never auto-reloads), Arabic RTL manifest (`MedLevo AI` / `MedLevo`, `lang: ar`, `dir: rtl`, standalone), SVG icons + rendered PNG fallbacks (192/512/maskable/apple-touch). Workbox precaches the app shell (JS/CSS/HTML/woff2/icons); **no runtime caching** and `/api/` is excluded from the navigation fallback — offline data is explicit (IndexedDB). Dev/preview proxy `/api → http://127.0.0.1:8787`. `index.html`: `lang="ar" dir="rtl"`, `viewport-fit=cover`, light/dark `theme-color`, no external resources. |
| Tests config | `vitest.config.ts`, `test/setup.ts` | jsdom + fake-indexeddb + Testing Library cleanup. |
| Design system | `src/design/**` | tokens, base, components (see design-system.md), `ThemeProvider` + `appearanceStore`. |
| API client | `src/lib/api.ts` | `api.get/post/put/patch/del`, same-origin credentials, `x-medlevo-csrf: 1` on every mutation, JSON, `ApiError` (`code`, `status`, Arabic `message`, `details`, `offline`), `errorMessage()`, `fieldErrors()` (maps `VALIDATION_FAILED` issues), global 401 handler, timeouts. **Background requests** (sync push/pull, capabilities refresh, settings load/flush) pass `skipAuthRedirect` — a 401 there never navigates away from what the owner is doing; route navigation (the owner gate) and owner-initiated actions still redirect to `/login`. |
| Auth client | `src/lib/auth.ts` | status (30 s in-memory cache), setup/login (sends `device_id` + Arabic `device_label`), logout (forgets the local signed-in state only once the server confirmed it, or answered 401), recover, sessions, revoke, change password, regenerate recovery codes. Remembers "this device was signed in" locally so the app opens **offline** from local data. |
| Settings store | `src/lib/settings.ts` | `useSettings()`; changes apply immediately, persist as a pending patch on the device, `PATCH /api/settings`, retried on `online`. Offline → `pending_offline`; 401 → `pending_auth` (kept, sent by `load()` after sign-in); 5xx → `error` but kept; a 4xx validation error drops only the keys that request sent (edits made meanwhile are still sent) and rolls those back to the server value. Pushes appearance keys into `appearanceStore`, timezone into `time.ts`. |
| Capabilities | `src/lib/capabilities.tsx` | `useCapabilities()` (`feature(key)` → `{available, state, reason}`), cached last answer, "needs connection" overlay while offline for network-bound features, `<FeatureGate feature>` (inert + reason, or render-prop). |
| Local DB | `src/lib/localdb.ts` | Dexie DB `medlevo`, versioned `LOCAL_SCHEMA` (see §3). |
| Sync engine | `src/lib/sync.ts` | outbox + push/pull per ARCHITECTURE §3.4 (see §4). |
| Device id | `src/lib/deviceId.ts` | ULID in IndexedDB `kv` (mirrored to localStorage), `describeDevice()` → «Safari على iPad». |
| Time | `src/lib/time.ts` | owner timezone (default `Asia/Baghdad`) via `Intl`, Latin digits; `formatDate/DateTime/Time/Weekday/Relative`, `dayKey()`, `listTimeZones()`. Storage stays epoch ms. |
| PDF | `src/lib/pdf.ts` | `loadPdfjs()` lazily imports `pdfjs-dist` and sets `GlobalWorkerOptions.workerSrc` from `pdf.worker.min.mjs?url` (same-origin, precached once a feature imports it); `openPdf({data}|{url})`. |
| Misc hooks | `src/lib/useOnline.ts`, `src/lib/usePageTitle.ts` | |
| Router & shell | `src/app/*` | `createBrowserRouter`; route table `routes.tsx`; owner gate loader; `AppShell` (phone bottom tabs / wide slim top bar, search entry, offline indicator, global save status with details popover, skip link, focus-on-navigate, `/` and Ctrl/⌘K → search); PWA update prompt; route error + 404 screens. |
| Auth screens | `src/features/auth/*` | Setup (owner account, password checklist from the server's `password_min_length`, 10 recovery codes shown once with copy / print / download, required confirmation, unload guard), Login (expired / recovered notices, offline notice), Recover (one-time code → new password → all sessions revoked → login). |
| Settings screen | `src/features/settings/*` | Appearance (theme, text size, paper texture, reduce motion, live bidi preview), Reading & explanation defaults (level, dialect, answer style, Socratic, check-question density, margin density, custom instruction) with the real AI capability reason, Time (timezone + live preview), Security (sessions with revoke + impact confirmation, change password, regenerate recovery codes behind password + impact text, logout), About (versions, AI provider state, real storage estimate). |
| Placeholders | (removed in the integration round I1) | Round 1 shipped honest «هذه الشاشة قيد البناء» screens; every feature track replaced its `routes.tsx` with real screens, and the unused `features/shell/PlaceholderScreen.tsx` (+ its CSS) was deleted. `test/no-placeholders.test.ts` guards that none comes back; unfinished parts are disabled with a reason through capabilities. |
| Dev tooling | `dev/gallery.html` (+`.tsx/.css`), `scripts/visual-check.mjs`, `scripts/gallery-check.mjs`, `scripts/real-server-check.mjs` | Dev-only component gallery (served by `vite`, not built). Screenshot/E2E scripts (Playwright; mocks live only in the scripts). |

## 2. Contracts for other tracks

### Routes
Each feature exports `routes: FeatureRoutes` from `src/features/<feature>/routes.tsx` (`src/app/routeTypes.ts`):

```ts
export const routes: FeatureRoutes = {
  shell: [{ path: 'library/*', lazy: () => import('./LibraryScreen').then((m) => ({ Component: m.LibraryScreen })) }],
  fullBleed: [/* '/study/…' etc. — no shell */],
  // public: only auth
};
```
Paths are relative to `/`; home is `{ index: true }`. Register a new feature by adding one import line to
`src/app/routes.tsx` (`FEATURES`). Owner info: `useRouteLoaderData('owner') as OwnerGateData`
(`mode` online/offline, `username`, `remainingRecoveryCodes`, `sessionId`, `passwordMinLength`).
Use `usePageTitle()` and an `h1` per screen (focus moves to it after navigation), the `.ml-page` scaffolding,
and `<FeatureGate>` for anything whose capability is not `available`.

### Local-first writes (never await the network)
```ts
import { getDb } from '../../lib/localdb';
import { writeAndEnqueue, enqueue } from '../../lib/sync';
const db = getDb();
// one entity + its op, atomically:
await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert', base_rev: row.rev ?? null });
// several writes: your own transaction, enqueue() inside it (it throws outside a rw transaction incl. db.outbox)
await db.transaction('rw', [db.annotations, db.outbox], async () => { await db.annotations.put(a); await enqueue(db, {...}); });
```
* Entity ids are client ULIDs (`newId()` from `@medlevo/shared`); `op_id`s are generated by `enqueue`.
* Ops: `upsert` (with `base_rev` = the server rev the edit is based on), `delete` (tombstone), `append`
  (strokes, review events, attempts).
* **An `upsert` payload is the entity's FULL current state, never a partial patch**: unsent upserts of the same
  entity are coalesced and the latest payload *replaces* the earlier one (a partial patch would drop the earlier
  edit's fields).
* Register how server entities land in your Dexie table (called for pulls **and** for entities returned by push):
  `getSyncEngine().registerApplier('note', async (change, { db, localOps, source }) => { … })`.
  Appliers must be **idempotent** and must not overwrite rows that still have `localOps`.
  Changes that arrive before your (lazy) feature registers are parked in `syncInbox` and delivered on registration.
* Save indicator for an entity: `useEntitySyncState(type, id)` → `<SaveStatus state={…} />`.
* Owner actions on problems: `engine.openIssues()`, `engine.acknowledge(op_id)`, `engine.retry(op_id)`
  (UI for this belongs in the Control Center track). `retry()` queues a **new** op (fresh `op_id`, same entity /
  payload / `base_rev` / `client_ts`, `retryOf` = old op_id) and marks the old one acknowledged with
  `supersededBy` — the server answers a repeated op_id with `duplicate` + the original verdict, so re-sending the
  same op_id could never succeed. It returns the new op, or `null` if there is nothing to retry.

### Local schema migrations
`LOCAL_SCHEMA` in `localdb.ts` is append-only: a change adds `{ version: N+1, stores: {changed tables}, upgrade }`.
Upgrades are idempotent and never delete unsynced rows or non-synced outbox ops; test them with fake-indexeddb
(open at N, write, reopen at N+1). Current: **v1** — `annotations [id, targetKey, updatedAt, syncState]`, `notes`,
`notePages`, `flashcards`, `reviewEvents`, `questionAttempts`, `examAttempts`, `studySessions`,
`outbox [++seq, &op_id, entity_type, entity_id, status, [entity_type+entity_id]]`, `syncInbox`, `kv`,
`offlineSources`, `blobs`, `apiCache`. Row interfaces are a baseline — feature tracks may extend them (with a new
schema version if an index is needed).

### Server contract consumed
Exactly the shapes in `packages/shared/src/api.ts` (written by the server track): `/api/auth/{status,setup,login,
logout,sessions,sessions/:id,password,recover,recovery-codes}`, `GET/PATCH /api/settings`, `GET /api/capabilities`,
`POST /api/sync/push {ops}` → `{results, server_seq}`, `GET /api/sync/pull?since&limit`. Verified live (§6).

## 3. Sync engine behaviour (`src/lib/sync.ts`)

* **Outbox statuses:** `pending` → `synced` (applied / merged / duplicate-of-applied) | `conflict`
  (conflict_kept_both, or rejected *with* a server copy, or a duplicate whose original result was a conflict) |
  `rejected` (rejected without a copy). Per-op `retryable: true` or a missing result keeps the op `pending`.
* **Never drops ops on failure.** Network/server failures: `attempts++`, `nextAttemptAt = now + backoff`
  (1 s × 2^(n−1), ±20 % jitter, cap 5 min). Offline failures are not "errors"; their backoff is cleared when the
  `online` event fires. 401 pauses sync (`authRequired`) without touching ops and **without** the global
  redirect (the owner may be mid-stroke, §55); the save-status panel explains it and offers «تسجيل الدخول». Only `synced` ops are pruned (after 7 days).
* **Ordering & batching:** ≤ 100 ops per push (server max 500); at most one op per entity per batch; later ops of
  an entity wait behind an earlier op in backoff. Unsent pending upserts of the same entity are coalesced; an op
  that has been on the wire (`sentAt`) is never modified. When an op is acknowledged with `entity.rev`, later
  pending ops built on the same base are rebased to that rev.
* **Pull:** cursor `sync.pull.since` in `kv`; pages until `has_more` is false; all applier calls run through one
  serial chain (no double delivery, strict order); a newer parked change wins over an older late one.
* **State:** `useSyncSnapshot()` → `{pending, conflicts, errors, online, lastSyncedAt, lastError, nextRetryAt,
  authRequired, pullFailed, state}`. Aggregate: conflict > error (rejections, ≥ 3 server failures, failing pull) >
  pending (`ينتظر المزامنة` online / `محفوظ محليًا` offline or signed out) > `خطأ` when signed out with nothing
  pending (a pull is impossible, so never `تمت المزامنة`) > `تمت المزامنة`. Per-entity state derives from that
  entity's outbox ops; rows mirror it in their `syncState` index.
* **Triggers:** start (after sign-in), local writes (debounced 400 ms), `online`, tab becoming visible, every 60 s
  while visible, retry timer at the earliest `nextAttemptAt`, «مزامنة الآن». Calls made while a run is in flight
  coalesce into one re-run, which pulls if *any* of them asked for a pull.
* **Multi-tab:** push/pull run under a Web Locks lock (`medlevo-sync`, `ifAvailable`); without Web Locks the
  server's op_id idempotency makes concurrent pushes safe. A Dexie `liveQuery` keeps counts live across tabs and
  pushes ops enqueued by other tabs.

## 4. Tests (`apps/web/test/`, 60 tests, all passing)

* `richtext.test.tsx` — `<bdi dir="ltr" lang="en">` for LTR runs in Arabic paragraphs; logical text preserved
  (textContent and a real DOM selection equal the stored string; no bidi control characters) for the §21 samples;
  marks, opposite-direction islands, list grouping, heading levels; `<Bidi>`.
* `api.test.ts` — CSRF header + JSON + same-origin on POST; CSRF on every mutation and never on GET; `ApiErrorBody`
  → `ApiError` (code/status/Arabic message/details); validation issues → field errors; network failures → offline
  (`NETWORK_ERROR` / `OFFLINE` with the Arabic offline message); Arabic message for non-JSON 502; 401 handler
  (and `skipAuthRedirect`); 204.
* `sync.test.ts` — enqueue persisted with the entity (survives reopen), refused outside a transaction, rolled back
  together; coalescing vs. sent ops; push marks synced and sends op_id/device_id; duplicate = success; duplicate of
  a conflict = conflict; failures keep ops queued with exact exponential backoff, never dropped, server recovery;
  offline = «محفوظ محليًا» + backoff reset; retryable result; conflict_kept_both → conflict state until
  acknowledged (+ applier receives the server copy); rejected → error, kept, retry; one op per entity per batch +
  rebase on acknowledged rev; pull cursor; inbox parking + delivery on registration; pull failure → error state;
  applier receives local unsynced ops; retry against an **idempotent server model** (same op_id → duplicate +
  original result) succeeds with a new op_id; 401 pauses without touching ops; the HTTP transport never fires the
  global redirect; a pull requested during a push-only run is not lost.
* `stores.test.ts` — logout failure keeps the device signed in (also offline); 401 on logout = signed out;
  settings 401 keeps pending changes (no redirect) and sends them after sign-in; a validation error drops only the
  keys that were sent.
* `settings-screen.test.tsx` — Settings renders with an unknown server timezone (display falls back to
  Asia/Baghdad) and autosaves the custom instruction without blur.
* `components.test.tsx` — Tabs RTL (ArrowLeft = next, skip disabled, wrap, Home/End) and LTR; roving tabindex +
  ARIA links; SegmentedControl RTL; Dialog focus trap / Escape / focus return; ConfirmDialog impact + Cancel focus;
  SaveStatus text + icon for all five states; appearance attributes on `<html>`; nested focus traps; Popover and
  Menu Tab order; search shortcut ignored while typing / under a modal.
* `lib.test.ts` — capability reasons and offline overlay; Baghdad timezone day keys, Latin digits, relative days;
  device labels; `safeNext` (no open redirects); backoff curve; global save state never «تمت المزامنة» while
  signed out.

## 5. Commands run (results at the time of writing)

| command | result |
|---|---|
| `npm test -w @medlevo/web` | 5 files, **47/47 passed** (builder); after the independent review: 7 files, **60/60 passed** |
| `npx tsc -p apps/web --noEmit` | no errors (includes `src`, `test`, `dev`, configs) |
| `npm run build -w @medlevo/web` | success; PWA precache 39 entries (~1.1 MB incl. fonts); main chunk ≈ 610 kB (≈ 192 kB gzip) |
| `node apps/web/scripts/render-icons.mjs` | wrote 4 PNG icons |
| `node apps/web/scripts/visual-check.mjs` (preview :4173, mocked API) and against the dev server (:5173) | 36 screenshots each run; no console errors; no horizontal overflow |
| `node apps/web/scripts/gallery-check.mjs` (dev server) | gallery + menu / sheet / confirm / toast / tooltip at both sizes and themes; only a favicon 404 (fixed) |
| `node apps/web/scripts/real-server-check.mjs` against the **real server** (`apps/server`, throwaway data dir, port 18787) | 10/10 steps passed (setup → codes → home → sync pull → settings PATCH → sessions → logout/login → wrong-password message → recovery → capabilities) |

## 5a. Independent review (fixes applied)

An adversarial review of this track found and fixed (each with a regression test that fails on the old code):
`SyncEngine.retry()` re-sent the same op_id (could never succeed against the real, idempotent server — the old
test used a fake transport without op_id memory); background sync / capabilities / settings requests answering
401 navigated to `/login`, unmounting the workspace mid-writing; a failed logout (offline) stopped sync and erased
the device's signed-in state while the session cookie stayed valid; the settings store discarded *all* pending
preferences on any non-offline error (incl. 401); a pull requested while a push-only run was in flight was lost;
the global indicator said «تمت المزامنة» while signed out; nested modals' focus traps fought (Tab always jumped
to the first control); Popover and Menu Tab order (both portaled to `<body>`); `/` / Ctrl+K navigated away under an open modal;
LTR paragraphs in RichTextView inherited `lang="ar"`; the offline pill used `aria-label` on a generic span and hid
its explanation from assistive tech; Settings crashed on an unknown server timezone; the custom instruction saved
only on blur. Verified in Chromium (Playwright, mocked API, 390×844 + 1280×800, light + dark): a background 401
keeps the owner on the page, the panel offers «تسجيل الدخول», no console errors, no horizontal overflow.

## 6. Visual review (what was checked and fixed)

Screens at 390×844 and 1280×800, light and dark: setup, setup filled, recovery codes, login (expired notice), home
shell (placeholder), sync popover, offline shell, settings (full page), session-revoke confirmation, component
gallery. Fixed after looking at them: recovery codes wrapping mid-code on phones (now one per line, `nowrap`);
`§45، §23` and «25 KB من 1 GB» scrambled by bidi (now isolated with `<Bidi dir="ltr">`); LTR timezone select whose
chevron covered the text; brand name hidden at 390 px (now only hidden when the offline pill needs the room, or
below 360 px); info icon on the «هذا الجهاز» pill; duplicate logout button; settings save indicator far from the
title on desktop; fontsource subset files without `unicode-range` (both subsets were downloaded for all text —
now per-weight files, verified: only Arabic + Latin subsets load).

## 7. Not done / limitations (honest list)

* **Bundle size:** the main chunk is ~192 kB gzip (react-dom, react-router, zod pulled in by `@medlevo/shared`,
  Dexie). Settings is lazy; feature tracks should use `lazy` routes. Splitting zod out of the shared index would help.
* **No background sync while the app is closed** (Background Sync API is not used — unsupported on iOS); sync
  runs while the app is open (stated in the UI copy).
* ~~**Conflict / rejection review UI** is not built~~ — built in the Control Center («المزامنة»,
  `features/control/SyncScreen.tsx`, track D2) on the engine's `openIssues/acknowledge/retry`. *(reconciled, track F5)*
* ~~**Download Manager UI** not built~~ — built in track D1 (`lib/offline.ts`, «بياناتك» → «التنزيلات»,
  `features/offline`). `requestPersistentStorage()` is still never called at startup: only from an owner action
  (`requestPersistence()`, Firefox would prompt). *(reconciled, track F5)*
* ~~The pdf.js worker is emitted/precached only once a feature imports `lib/pdf.ts` (none does yet).~~ The reader
  (`features/workspace/reader`), the figure picker and the Control Center's original view import it. *(reconciled, track F5)*
* Text size is stepped (90–150 %), not continuous. The UI is Arabic only (`ui_language: 'en'` is stored but not rendered).
* Tested in Chromium only (Playwright, desktop + mobile emulation). **Not run:** real iPad/iPhone Safari, VoiceOver /
  NVDA screen-reader passes, axe/Lighthouse audits. ESLint now runs (track F5 — see «Lint» below).
* ~~Server-side entity handlers don't exist yet, so `/api/sync/push` was exercised only with mocked transports.~~ The
  handlers exist (core-server.md) and real pushes run end to end in the browser suites (`e2e/g7-ac24-two-devices.spec.ts`,
  `e2e/g7-ac23-offline.spec.ts`). *(reconciled, track F5)*

## 8. Acceptance round G7 — AC-23 (2026-10-10)
* `resolveFeature` (`lib/capabilities.tsx`): offline, a network-bound feature that the server last reported as
  `requires_configuration` (e.g. AI without a key) is now `requires_connection` with «تحتاج هذه الميزة اتصالًا بالإنترنت.
  آخر ما عرفه هذا الجهاز من الخادم: …» — before, the offline reader said only «needs a server setting», which is stale
  information the device cannot check offline. `not_implemented` / `disabled_by_owner` / `requires_native` are unchanged.
  Tests: `test/lib.test.ts`, `e2e/g7-ac23-offline.spec.ts`.

## 9. Track F5 — client error reporter and lint (2026-10-10)

* **Error reporter** (`src/lib/errorReporter.ts`, installed once in `main.tsx`; `RouteErrorScreen` reports route errors
  other than 404 / offline): `error` and `unhandledrejection` events are redacted in the browser with the shared
  `redactClientError` (no document / note text, no query, no secret), grouped by fingerprint with a count, at most 20
  pending and 30 distinct per page session, flushed every 5 s and on page hide (`keepalive`), sent only while
  `lastKnownAuthenticated()` (new in `lib/auth.ts`); 5xx / offline keep the batch (bounded), other 4xx drop it; benign
  noise (ResizeObserver loop, «Script error.», AbortError) is ignored; it never writes to the console. Viewer: Control
  Center «صحة النظام» (`docs/modules/control.md` §7). Tests: `test/error-reporter.test.ts` (7), E2E
  `e2e/f5-quality-ops.spec.ts`.
* **Lint** (`eslint.config.js` at the repo root, `npm run lint` = `eslint . --max-warnings 0`): @eslint/js +
  typescript-eslint recommended everywhere, `react-hooks/rules-of-hooks` (error) and `react-hooks/exhaustive-deps`
  (warning — and warnings fail the run) for the web app, unused disable directives are errors. The React Compiler rule
  set of eslint-plugin-react-hooks 7 (`set-state-in-effect`, `refs`, `purity`, …) is **not** enabled: the app does not
  use the React Compiler and those rules describe compiler-optimizable code rather than bugs (171 findings measured
  when tried). The first run found 55 problems; all were fixed in code — e.g. the focus trap and outside-pointer hooks
  read their options / refs through a ref instead of omitting dependencies, `SourcesTab` keys its effect on the page id,
  `BookCanvas` captures its visibility map for the cleanup, Search / Terms memoize their derived lists, unused imports
  and variables removed, 6 stale disable comments removed. The disables that remain are single-line, single-rule and say
  why (deliberately keyed effects in Settings and NodeDialog, the ink summary's change counter, control-character
  regexes on the server).
* `ExportPanel`: the format choice wraps on a phone now that there are four formats (DOCX) — found by the F5 browser
  test at 390 px.

