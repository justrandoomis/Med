# Data: offline downloads, backup & restore, export, hardening (track D1)

Owns `apps/server/src/modules/data/**`, `apps/server/src/cli/{backup,restore-verify}.ts` (the Round-4 stubs were
replaced), migration `0750_data.sql` (range 0750–0769), `apps/server/test/data/**`, `apps/web/src/features/offline/**`,
`apps/web/src/lib/offline.ts`, the new shared contract `packages/shared/src/data-api.ts`, this file and
`docs/BACKUP_RESTORE.md` (the operator guide: commands, what is in or out of an archive, restore semantics).
Spec: §11 (offline citations), §46–§49; AC-23 (offline), AC-30 (backup & restore).

## 1. Server

### Data (`0750_data.sql`, no existing migration edited)
* `data_server_epoch`: one row per sync epoch (`id` random 128-bit hex, `base_seq` = change-feed position the
  epoch starts from, `reason` `initial|restore`, `backup_id`, `backup_created_at`, `is_current` with a unique partial
  index → exactly one current epoch). The migration inserts the initial epoch.
* `data_backup`: backups made by the API job or the CLI (`status` running / completed / completed_with_warnings /
  failed, size, sha256, summary, warnings, error, verification status + report, soft delete).

### Offline package (`offline.ts`): `GET /api/data/offline/:sourceId/{manifest,bundle,learning}`
* The manifest (`OfflineManifestResponse`, format `medlevo-offline-1`) lists **exactly** what the reader needs for
  one version (default: the active one; `?version=` another version of the same source):
  files (display PDF, page images, thumbnails) with real sizes and sha256, and data entries (source detail, pages,
  per-page regions, annotations, notes, needs-reanchor list, latest session, reading progress, Study Book status and
  book when its scope contains this version, linked questions per lecture/page, question details, learning cards and
  review events). Each entry has its exact byte size and sha256.
* Data entries are produced by calling the app's own GET routes **in-process with the owner's cookie** (`app.inject`).
  The stored answers are therefore byte-identical to what the online app reads. No second serializer can drift.
* `contents` = honest counts (pages, notes, marks, Study Book version, questions with solutions, cards, reviews),
  `not_included_ar` = what does **not** work offline (AI, external search, references a Study Book cites, the
  original question-source files).
* `include_solutions=0` leaves question details (keys, explanations) out. Entries carrying solutions are flagged
  `contains_solutions`, and `totals.solution_bytes` is reported.
* `content_hash` (stable over the manifest content) lets the client say «مطابق لما في الخادم الآن» or «تغيّر المحتوى»
  without downloading again.
* Failure paths: unknown source 404, version of another source 404, trashed source 409, no session 401.

### Sync epoch (`epoch.ts`, additive changes in `modules/sync`)
* `ensureEpoch` at boot. `startRestoreEpoch` (used by restore) creates a new current epoch whose `base_seq` = the
  change-feed head of the restored database.
* Pull answers now also carry `server_epoch`, `epoch_base_seq` and `head_seq`. Push results carry `server_seq` (the
  change-feed head after the op; a duplicate returns the original value). All fields are optional in
  `packages/shared/src/api.ts`, so older clients ignore them.
* (review fix) A push may carry `server_epoch`, the epoch the device last pulled from. When the server's current epoch
  differs, the whole push is refused **before anything is applied**: 409 `CONFLICT` with
  `details.server_epoch_changed` and the current id. No op is recorded, so the same op ids are accepted later. A
  push without the field behaves as before.
* `GET /api/data/epoch`.

### Backup (`backup.ts`, `backups.ts`, `tar.ts`, CLI `npm run backup`)
* `createBackup`: `VACUUM INTO` snapshot (consistent while the server writes) → secret-looking `owner_setting` rows
  are stripped from the snapshot with a warning → every `stored_file` row's blob is streamed into the archive. Each
  blob is opened with `O_NOFOLLOW`, its storage key must match `aa/bb/<sha256>`, and its sha256 is re-computed and
  compared. A missing or damaged blob is recorded in `files_missing` with a warning and never silently skipped →
  `manifest.json` is written last → the `.partial` file is renamed, and a `.sha256` sidecar is written.
* Archive format: plain ustar `.tar.gz` (GNU base-256 sizes ≥ 8 GiB), written by our own streaming writer (no new
  dependency). The extractor refuses symlinks, hardlinks, devices, pax headers, `..`, absolute names, duplicates,
  bad checksums and truncation. It measures entry-count, total-size, per-entry and compression-ratio limits **while
  inflating**. Entry names use the same normalizer as the upload ZIP guard (`lib/safe-zip`).
* API: `GET/POST /api/data/backups` (one running job at a time, 409 otherwise; progress = real phases), `GET
  /api/data/backups/:id`, `POST /api/data/backups/:id/verify` (runs the full restore verification as a job),
  `GET /api/data/backups/:id/download` (authenticated, `application/gzip` attachment, audited), `DELETE
  /api/data/backups/:id` (removes the archive, audited). Interrupted `running` backups are marked failed at boot.
* Excluded, always: `secret.key`, environment / `.env` / API keys, `tmp`, OCR caches, earlier backups,
  unreferenced blobs (`BACKUP_EXCLUDED`, listed in every manifest).

### Restore (`restore.ts`, CLI `npm run restore:verify`)
* `verifyBackup` extracts into a **separate temporary directory** and runs the checks listed in
  `docs/BACKUP_RESTORE.md` (archive safety, manifest, layout, database and per-file hashes, `integrity_check`,
  `foreign_key_check`, migrations vs this build, row counts, file completeness, FTS, relational samples, a real
  boot of the app on the copy). FTS note: `chunk_fts` indexes `ml_norm(...)` text from an external-content table,
  so SQLite's `integrity-check` with rank 1 always reports a mismatch on a healthy index. The check uses the
  structural rank 0, the docsize/rowid mapping and real `MATCH` probes instead.
* `applyRestore` refuses a non-empty target or the live data directory (`RestoreTargetError`; real paths are compared,
  so a symlink to the live directory is refused too). It verifies in a sibling staging directory and, only when every
  check passes, starts a restore epoch, revokes all sessions, fails running backup rows, writes a `restore` change-log
  entry and renames staging → target. The row of the backup being restored is the exception: it was «running» in its
  own snapshot, so it is marked completed with a note. There is no overwrite mode.
* (review fix) A backup that recorded `files_missing` (a blob already missing or damaged on disk at backup time)
  fails `files_complete`, and the report says how to proceed. `acceptMissingFiles` (CLI `--accept-missing-files`)
  restores everything else. It passes only when every absent file is one the manifest listed at backup time. The
  report names those files. Damaged bytes that travelled in the archive are removed from the restored file store, so
  they are never served under a verified content address.
* (review fix) An unreadable `manifest.json` or a database file that is not SQLite gives a failed report (`manifest`
  / `integrity_check`), never an exception.

### Export (`export.ts`, `render.ts`): `GET /api/data/export/...`
* `source/:sourceId` (page by page with «ص 12 (الصفحة 14 في الملف)» labels, OCR notes, highlights, notes, ink as
  a count), `artifact/:id` (Study Book / explanations), `notes` (by source or node; origin labels; conflict copies
  marked), `questions` (by question source or lecture; `include_solutions`, with who stands behind each key), `all`
  (full JSON, no secrets), `formats`.
* Formats: **Markdown** (citations as text «المصدر — ص 12 (الصفحة 14 في الملف) — الإصدار 1» + the quote, numbered
  footnotes, «لم يُتحقق منه بعد» / «تعارض» status labels, generated content labelled «محتوى مولَّد…»; text is
  escaped so owner text cannot inject links or HTML), **JSON** (data + manifest of ids, versions and sha256),
  **print-ready HTML** (RTL document, English runs isolated with `<bdi dir="ltr">`, escaped, no scripts, print CSS).
  **PDF = print the HTML from the browser**, and the API and UI say so (`export.pdf` is available on that basis).
  `export.docx` is `not_implemented` with an Arabic reason. Anki TSV belongs to the learning track
  (`export.anki_tsv`, shown with its own state).
* Responses: `Content-Disposition: attachment` (RFC 5987 file name), `no-store`, `nosniff`.

### Hardening
* **First-run setup token** (`modules/auth/setup-token.ts`, wired in `modules/auth/index.ts`): required when the
  server listens on a non-loopback address, trusts a proxy, has a non-loopback web origin (`MEDLEVO_ORIGIN`: a proxy,
  tunnel or port-forward in front of a loopback listener, added in review), or `MEDLEVO_SETUP_TOKEN` is set. Without the env var, a
  one-time token (20 base32 characters in 5 groups, 100 bits, no I/O/0/1) is printed to the server log at boot.
  Only its sha256 is held, in memory, never in the database, and it is forgotten after setup. Wrong or missing
  token → 403 with an Arabic reason. Failures count toward the login limiter (5 per minute per address → 429).
  `GET /api/auth/status` reports `setup_token_required`.
* Rate limits per route (offline 60/min, export 30/min, full export 6/min, backup create/verify 3 per 10 min,
  download 20/min, management 60/min). All `/api/data/*` routes require the session (401) and mutations need the CSRF
  header (403). This is tested route by route.
* Path safety: archive entry names are normalized and refused when unsafe, extraction never follows links, blob paths
  come only from validated storage keys, and the CLI resolves relative paths against the directory npm was run from
  (`INIT_CWD`).

## 2. Web

### `lib/offline.ts` (Download Manager core)
* `downloadSource`: manifest → quota check against `navigator.storage.estimate()` (with headroom; refuses instead of
  half-downloading) → each file fetched and **sha256-verified** (WebCrypto, or a pure-JS SHA-256 on insecure `http://`
  LAN origins where `crypto.subtle` does not exist) into `blobs` → the bundle's GET answers into `apiCache` (keys
  from the shared `normalizeOfflinePath`) → the owner's writing is seeded into the entity tables through the
  workspace merge functions (rev-guarded, never over local pending writes) → the `offlineSources` record is written
  **last**, so an interrupted download never looks complete. Progress is real bytes and file counts, not percentages.
  On failure, everything this attempt wrote is removed. An older version's leftovers are dropped after a successful
  re-download.
* `removeDownload`: deletes only this download's blobs and cached answers (shared blobs are ref-counted). It never
  touches the owner's entity tables or the outbox, so unsynced writing is never evicted.
* `offlineAwareFetch` / `installOfflineTransport` (installed once in `app/layouts.tsx`): serves a stored answer **only**
  for `GET /api/...` and only when the browser is offline, the request fails at the network level, or the server
  answers 502/503/504. Mutations are never answered from the cache. Served answers carry `x-medlevo-offline-copy: 1`.
  The workspace reads its PDF blob from `blobs` (key `file:<fileId>`).
* `requestPersistence` only on the owner's button. `storageInfo` reports the browser's estimate, labelled as an
  estimate. `unsyncedCount`. `checkForUpdate` (content hash). `useDownloads` (live query).

### Screens (`features/offline`, route `/offline` «بياناتك»)
* **التنزيلات**: what is on this device (title, version, real size, date, contents, «تحقق من التحديث», «أزل من
  الجهاز» with confirmation), download from the library (search; the dialog lists exactly what will be stored with
  real sizes, «نزّل الأسئلة مع حلولها» choice, what does not work offline, a byte progress bar, «افتح للدراسة»), and
  storage (browser estimate, persistence state with «اطلب التخزين الدائم», unsynced writes count, the policy: «التنزيل
  نسخة مؤقتة… وليس نسخة احتياطية»). After a server restore, a notice says so and how many writes were re-sent.
  Offline, new downloads say «يحتاج التنزيل اتصالًا بالخادم» and existing downloads stay usable.
* **النسخ الاحتياطي**: create, real status, size, sha256, verification report per check, download, delete (confirm),
  what is in and out, and the CLI commands.
* **التصدير**: kind (source / notes / questions / everything), format (Markdown, HTML for printing, JSON), solutions
  toggle, «اطبع / احفظ PDF» (opens the HTML export in a new tab), with honest notes on PDF and DOCX.
* `OfflineDownloadButton` is exported for other screens (library or workspace) to mount. See the not-done list.
* RTL with `Bidi` isolation for English titles and sizes, labelled controls, 390 px without horizontal overflow, and
  dark mode (checked by the E2E screenshots).

### PWA update prompt and SW registration on **all** routes
`PwaUpdatePrompt` moved from `AppShell` to the root layout (`app/layouts.tsx`), so the service worker is registered and
the prompt shows in the shell, the study workspace (`/study/…`) and the sign-in screens. It never reloads by itself.
When writes are still unsynced, the banner (`features/offline/UpdateBanner.tsx`) says so and asks for confirmation
before reloading (nothing is lost: the writes stay in IndexedDB and are sent after the reload).

### Sync after a server restore (`lib/sync.ts`)
Pushes store `ackSeq` (= `server_seq`) on synced outbox records. On the first pull page the engine compares
`server_epoch` with the stored one (and the cursor with `head_seq`). On a change it re-queues this device's writes
acknowledged after the restore point as new ops (`retryOf`, the old op `supersededBy`), resets the cursor to 0 and
records a notice. Appliers never overwrite a row with local ops, so the re-pull cannot replace newer local writing
with the restored server's older rows. A server without epochs changes nothing.

Review fixes. `syncNow` pushes **before** it pulls. Before the fix, the first sync after a restore sent writes made
during the outage straight to the restored server, on top of revisions it lacked, which created false conflict
copies. The re-queue then re-sent writes the restored server had just acknowledged, so they were applied twice. Now:
* every push carries the stored epoch, and a restored server refuses the push untouched (409
  `server_epoch_changed`); the engine then pulls (reset + re-queue) and pushes again in the same run;
* writes still waiting for an entity that gets re-queued copies are moved **after** those copies (same op ids and
  payloads), so each row's history reaches the restored server in order.
Regression: `features/offline/epoch.test.ts` → «writes made while the server was being restored…». It failed before
the fix with 2 conflict ops.

### Setup screen (`features/auth/SetupScreen.tsx`)
When `setup_token_required`, a «رمز الإعداد» field (LTR) appears with a hint to look in the server log or at
`MEDLEVO_SETUP_TOKEN`. Submit stays disabled until the field is filled, and the token is sent as `setup_token`.

## 3. Tests

Builder's final run: server 51 files / 718 tests, of which `test/data` had 5 files / 50 tests; web 51 files / 393
tests. Review run: see §6.

Server, `apps/server/test/data/`:
* `backup-restore.test.ts` (AC-30, 9 tests): the protected data really exists (Golden Set lecture + question source
  processed, ink, highlight, note, session, flashcards + review events, practice attempt, Study Book); API backup job
  → list → download = the archive (sha256 matches); secret.key, planted API key, setup token, password text and a
  planted secret setting are absent from the archive; `verifyBackup` in a separate temp dir passes every check
  including boot; `applyRestore` into another directory gives deep-equal key tables, equal file hashes, the restored
  app serves the source with its annotations, the old cookie gets 401, and there is a new epoch; non-empty and live
  targets are refused; damaged, truncated, traversal and symlink archives fail with the exact reason and write
  nothing outside; the CLI path works while the server keeps writing and records a missing blob honestly.
* `epoch-tar.test.ts` (15): tar round trip (readable by system `tar`), base-256 sizes, unsafe names, each refused entry
  type, checksum, ratio bomb, size and count limits, non-gzip; pull/push epoch fields; restore epoch.
* `export.test.ts` (10): Markdown citations and labels, HTML isolation, escaping and no scripts, JSON manifest, 404,
  400 and 401 paths, source page labels, hostile notes text, questions with and without solutions, full export
  without secrets, formats endpoint honesty, bidi rendering.
* `offline.test.ts` (7): exact sizes and hashes, honest contents, `include_solutions=0`, the bundle = the real GET
  answers, `content_hash` stability, learning data scoping, failure paths.
* `security.test.ts` (9): setup token (loopback, non-loopback, proxy, env), never stored in the database, 429 on
  guessing, every `/api/data` route 401 / CSRF 403, backup 404 / 409, capabilities.
* `test/sync.test.ts` and `test/ai.test.ts`: one assertion each adapted (pull answer gained fields; backup is now
  honestly `available`).

Web (`apps/web/src/features/offline/`, plus `features/auth/setup-token.test.tsx`):
* `offline.test.ts` (9): hash-verified download with real byte progress, record written last, hash mismatch → nothing
  kept, quota refusal, removal never touches writing or the outbox, shared files, transport only for GET and only
  when unreachable, owner writing seeded, SHA-256 fallback = WebCrypto.
* `epoch.test.ts` (4): first contact, restore with re-send (nothing overwritten or lost, no conflicts, the op inside
  the backup not re-sent), cursor above head, legacy server.
* `citations.test.tsx` (3): with a real download record, the evidence feature's chip to the downloaded lecture
  stays openable offline. A chip to a non-downloaded source, or to another version, says «هذه الصفحة غير محمّلة على
  هذا الجهاز…» and cannot be opened.
* `screens.test.tsx` (6): the Download Manager, dialog, backups, export and update banner (unsynced warning + confirm).
* `setup-token.test.tsx` (2).

**AC-23 end-to-end** (`node apps/web/src/features/offline/offline-e2e.mjs` after `npm run build -w @medlevo/web`; real
server serving the built app with its service worker, Chromium at `/opt/pw-browsers/chromium`, the studybook track's
test-only grounded fake provider; screenshots in `apps/web/test-screenshots/offline-*.png`). Final run: **21 PASS, 0
FAIL, 1 not exercised**:
setup → Golden Set lecture + course reference uploaded and processed → linked → note + ink synced → Study Book
generated by the real job (25 claims, 3 citing the reference) → the download dialog lists PDF, Study Book and what
needs a connection → downloaded through the UI → listed with its real size → service worker controls the page →
`context.setOffline(true)` → the lecture opens and renders from the download (ص 11), page 13 reached, pages drawn →
the owner's note is shown, the ink row is on the device → «الشرح والسؤال» says «تحتاج هذه الميزة اتصالًا», with no
busy or progress indicator → the Study Book is stored on the device → a non-downloaded source says «هذا المصدر غير
محمّل على هذا الجهاز للقراءة دون اتصال» → 390 px offline: the manager lists the download, says new downloads need a
connection, and has no horizontal overflow.
**Not exercised:** the Study Book view offline with its citation chips. See the follow-up below. The chip behaviour
itself is covered by `citations.test.tsx`.

A real CLI round trip was also run by hand (server running → `npm run backup` → `sha256sum -c` →
`npm run restore:verify` all 18 checks PASS → restore into an empty target → non-empty and live targets refused
with exit 2 → server started on the restored directory: old cookie 401, login 200, new epoch with reason `restore`).

## 4. Not done / limits / follow-ups for other tracks

* ~~Study Book view offline~~ — **fixed in the integration round I1**: `useStudyBook` / `useStudyBookAvailability`
  read the downloaded answers straight from `apiCache` (`readOfflineAnswer`) when offline or when the server cannot
  be reached, mark the view «تقرأ النسخة المحمّلة على هذا الجهاز» and offer no action that needs the server. A source
  that was not downloaded, or whose Study Book is built on another version, says so.
* ~~Image-only pages offline~~ — **fixed in I1**: page images, thumbnails and the Source Inspector's page image use
  `useFileSrc` (object URL from `blobs`, revoked on unmount; the file route otherwise). An image that is not on the
  device says «صورة هذه الصفحة غير محمّلة على هذا الجهاز» while offline.
* ~~Navigation~~ — **fixed in I1**: «على هذا الجهاز» badge on library rows, «نزّل للعمل دون اتصال…» in the row menu
  and in the workspace overflow menu (`features/offline/OnDevice.tsx`), `OfflineDownloadButton` on the source screen,
  and «بياناتك» linked from Settings (the Control Center storage section already linked it). Global nav unchanged.
* ~~`.env.example` lacks `MEDLEVO_SETUP_TOKEN`~~ — **fixed in I1** (with a test that every variable the server reads
  is documented).
* No DOCX export. PDF only via browser printing. No server-side PDF.
* Question-source files (the PDF a question was extracted from) are not part of a lecture download. Download the
  question source itself.
* Re-send after a restore covers only writes still in the outbox history (7 days) and acknowledged by a client with
  this version (`ackSeq`). Another device's writes come back only when that device syncs.
* `VACUUM INTO` in the API job blocks the event loop briefly on a large database. The CLI does not affect the server.
* A killed verification can leave a `.medlevo-restore-*` temp directory.
* Backups are not encrypted and not incremental.

## 5. Edits outside the owned paths (all minimal, additive, allowed by the track brief)
* `packages/shared/src/index.ts`: appended `export * from './data-api'`. `packages/shared/src/api.ts`: optional
  `setup_token_required`, `setup_token`, `server_seq`, `server_epoch`, `epoch_base_seq`, `head_seq`.
* `apps/server/src/modules/sync/{index,registry}.ts`: epoch fields on pull, `server_seq` on push results.
* `apps/server/src/modules/auth/index.ts` + new `setup-token.ts`.
* `apps/web/src/lib/sync.ts` (epoch reset and re-send), `apps/web/src/app/{AppShell,layouts,PwaUpdatePrompt}.tsx`
  (prompt and SW on every route, transport installed), `apps/web/src/features/auth/SetupScreen.tsx` (+ test).
* `apps/server/test/sync.test.ts`, `apps/server/test/ai.test.ts`: one assertion each, adapted to the new honest
  behaviour (failures caused by this track).
* Review (all inside the allowed list): `packages/shared/src/api.ts` gains the optional `SyncPushRequest.server_epoch`;
  `modules/sync/index.ts` adds the push epoch guard; `lib/sync.ts` sends the epoch, handles the 409 and re-orders
  waiting ops; `modules/auth/setup-token.ts` adds the origin rule; `features/auth/SetupScreen.tsx` shows the token
  field after a 403.
* `.gitignore` (append-only): the unanchored `data/` rule also matched the **source** directories
  `apps/server/src/modules/data/`, `apps/server/test/data/` and `apps/web/src/features/workspace/data/`, so none of
  them could be committed (the tracked `modules/index.ts` already imports `./data`, and the committed workspace imports
  `./data/local`). Three negation lines re-include exactly these directories. Runtime data (`data/`, `*.sqlite`,
  `backups/`) stays ignored.

## 6. Independent adversarial review (after the builder)

Final review run: `npm test -w @medlevo/server` had 55 files / 732 tests, 731 passing. The one failure is
`test/learning/zz-probe4.test.ts`, a probe file from the parallel learning review that needs `PROBE_OUT`; it is not
this track's. `test/data` alone: 5 files / 55 tests passing. `npm test -w @medlevo/web`: 51 files / 395 tests
passing. Both `tsc --noEmit` exit 0, and `npm run build -w @medlevo/web` exits 0.

Re-verified by reading the code and running it: tests, typecheck, web build, the AC-23 E2E (21 PASS, 0 FAIL, 1 not
exercised, the same as the builder), and a CLI round trip on a throwaway directory (backup exit 3 with a missing
blob, `restore:verify --target` exit 1 with the hint, then `--accept-missing-files` exit 0, and a non-empty target
refused with exit 2).

Fixed, each with a regression test:
1. **Major, sync after a restore** (`lib/sync.ts`, `modules/sync/index.ts`, shared `SyncPushRequest.server_epoch`):
   the push-before-pull order produced false conflict copies and double-applied re-sent writes. Fixed with the
   push-epoch guard and re-ordering described above. Tests: web `epoch.test.ts` (new case) and server
   `epoch-tar.test.ts` («a push naming an older epoch is refused untouched…»).
2. **Major, restore availability** (`restore.ts`, CLI): one blob already missing at backup time made the whole backup
   unrestorable, including all of the owner's writing, with no way forward. Fixed with the explicit
   `--accept-missing-files`, which allows only what the manifest recorded, names the files and removes damaged bytes
   from the restored file store. Test: `backup-restore.test.ts` («files already missing or damaged at backup time…»).
3. **Major, setup token bypass** (`auth/setup-token.ts`): a loopback listener behind a proxy, tunnel or port-forward
   without `MEDLEVO_TRUST_PROXY` needed no token, so anyone reaching the proxy could claim the owner. A non-loopback
   `MEDLEVO_ORIGIN` now requires the token. Test: `security.test.ts`.
4. Minor, the restored-from backup row read «interrupted» after a restore. It now reads completed with a note.
   Asserted in the AC-30 restore test.
5. Minor, `verifyBackup` threw on an unreadable manifest or a non-SQLite database instead of reporting. Test added.
6. Minor, the questions JSON export without solutions still carried `review_items`, which can quote a key conflict.
   They are now dropped. The full export now also drops `owner_setting` rows with a secret-looking **value** (same rule
   as the backup). Assertions added in `export.test.ts`.
7. Minor, hardening: exported HTML carries its own CSP (`default-src 'none'`), since the app opens it from a
   same-origin `blob:` URL for printing. Asserted.
8. Minor: the offline `learning` entry was built through a forwarded call to a rate-limited route (60/min per
   address), so it could fail a download. It is now built directly with byte-identical JSON. The offline test now
   checks the byte size and sha256 of **every** data entry against the real GET, not the first 12.
9. Minor, UI: the setup screen now shows the token field when the server answers 403 `setup_token_required` (status
   unreadable at mount). Test in `setup-token.test.tsx`. Remove-download and delete-backup confirmations now handle
   failures.

Not changed (noted):
* «تحقّق من التحديث» reports «تغيّر المحتوى» whenever the owner's own writing or reading position changed on the
  server, because those answers are part of the content hash. This is accurate (the stored answers are older), but it
  is not specific about what changed.
* The manifest and the bundle are built by two requests. If data changes in between, the stored record's sizes come
  from the manifest and the content from the bundle.
* Signing out does not clear downloaded copies from IndexedDB (the local-first design keeps writing there too).
* Double restore while a device stays offline, and conflict copies only the old server created: see
  `docs/BACKUP_RESTORE.md` §3 limits.
