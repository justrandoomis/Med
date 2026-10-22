# Module notes — tenancy core (Academic OS, track P1-T1)

Track **P1-T1 — Tenancy core, identity and owner migration** (`docs/academic-os/BUILD_PLAN.md` §3.3). Design:
`docs/adr/0003-multi-user-academic-platform.md`, `docs/academic-os/ARCHITECTURE_DELTA.md` §1, §3, §4.5, §7.1, §8.
This note grows with each step; **step 0** (R1-a) and **steps 1–3** (R1-b, below) have landed.

## Step 0 — seams for Wave 1 (2026-10-20)

Step 0 lands only what P1-T2 (layers, history, ink) and P1-T3 (lecture identity, versions) build on, so they never
edit a P1-T1 file. **Nothing changes for today's single owner**: no new route, screen, control, background work or
stored-data rewrite. Ships in release R1-a (BUILD_PLAN §1.3) together with T2 and T3.

| seam | where | how other tracks use it | proof |
|---|---|---|---|
| Purge-extension registry | `apps/server/src/modules/sources/purge.ts` — `registerPurgeExtension(ctx, ext)`, `purgeExtensions(ctx)`, types `PurgeExtension`, `PurgeSetView`, `PurgeSetName` | a module registers its own purge step **from its own plugin** (T2: layers, revisions; T3: fingerprints, page maps). An extension names the foreign keys it handles, may add ids to a core set (`fill`), adds counts and Arabic lines to the preview (`count`, `linesAr`; the counts are bound into the confirm token), and deletes its rows in the purge transaction: before the core deletes (`apply`, rows that point at core rows) and, optionally, after them (`afterCore`, rows that core rows point at — P1-T2's `annotation_layer`, referenced by `annotation.layer_id` / `note.layer_id` without a cascade); both return the `[entity_type, id]` pairs announced to sync. The core purge sets are checked around every extension step: `fill` may only **add** ids, `apply` / `afterCore` may not change them (a violation aborts the purge before anything is deleted), so an extension can neither skip a core step nor delete what the owner did not confirm. Throwing rolls the whole purge back. One registry per app context; the same name replaces the earlier registration | `apps/server/test/tenancy/purge-extension.test.ts`, `purge-extension.review.test.ts` |
| Blob deletion in the files module | `apps/server/src/modules/files/blobs.ts` — `removeStoredFileIfUnreferenced(ctx, fileId)` (moved unchanged; `sources/purge.ts` re-exports it for existing callers) | every caller that drops a stored file goes through it. Step 2 replaces its body with «delete my row and decrement my `blob_ref` hint» (mark-and-sweep GC) without touching callers | same file, «blob deletion delegated» |
| Phase 1 error codes | `packages/shared/src/errors.ts` — 11 codes appended (ARCHITECTURE_DELTA §7.1) and `ACADEMIC_ERROR_HTTP_STATUS` | read-only imports; T4 appends in Wave 2 | `packages/shared/test/academic-step0.test.ts` |
| Capability keys | `packages/shared/src/features.ts` — the 8 keys of ADR-0005 §6 appended | the server registers them `not_implemented` (with the Arabic reason) until the owning track builds and probes them; the Control Center's «القدرات» does not list them yet (they are in no group) | `apps/server/test/tenancy/capabilities-step0.test.ts`, `apps/web/test/tenancy/capabilities-screen-step0.test.tsx` |
| `academic/` barrel | `packages/shared/src/academic/{index.ts, visibility.ts}`, exported from `packages/shared/src/index.ts` | each track appends its own files to `academic/index.ts` **only in its own step 0**. `visibility.ts`: `Visibility`, `PublicationVisibility`, `UserRef`, `ChannelKind`, `ChannelRole`, `LayerKind`, `ContentOrigin` (+ const lists, Arabic labels, zod schemas) | `academic-step0.test.ts` |
| Sync `detail_code`, client-version header | `packages/shared/src/api.ts` — `SyncOpResult.detail_code?`, `SYNC_DETAIL_CODES`; `CLIENT_VERSION_HEADER_NAME` (not sent or checked yet) | T2 matches `layer_read_only` in its rejection handler | `academic-step0.test.ts` |
| Phase 1 Dexie schema (v3) | `apps/web/src/lib/localdb.ts` — tables `layers`, `copies`, `spaceCursors`; index `layerId` on annotations and notes; `annotation_layer → layers` in `ENTITY_TABLE`; outbox `target` (`SyncTarget`, absent = vault); `localDbNameFor(userId)`; `draftBelongsTo(tag, viewer)` | repositories in each feature folder read and write these tables. Index-only bump, no upgrade function: no row is rewritten; a legacy row without `layerId` is in the document's default personal layer (PRD AOS-4.6). The app still opens `medlevo` (per-user name is wired in step 3) | `apps/web/test/tenancy/localdb-phase1-schema.test.ts` (upgrade of a v2 database holding a row in every table, unsynced ones included) |
| Sync rejection hook and targets | `apps/web/src/lib/sync.ts` — `SyncEngine.onRejected(entityType, handler)`, `RejectedOp`; `enqueue({ …, target })` | T2 re-homes a stroke refused as `layer_read_only` into «ملاحظاتي» (ADR-0004 R2). Handlers run after the verdict is stored, for every final rejection (with or without the server copy, also a duplicate reporting an original rejection), never for a retryable answer; a failing handler never breaks sync. Delivery is **at least once**: the verdict is stored together with a `pendingRejection` mark, cleared only after every handler of the type succeeded; a rejection that arrived while no handler of its type was registered (the ink applier and handlers mount with the workspace, the push may run from any screen or tab) or whose handler threw or whose page closed is handed over when a handler of that type registers — so handlers must be idempotent (e.g. re-home under an id derived from the rejected op). An op the owner already retried is not handed over. Space ops (`space:<id>`) wait in the outbox and are never pushed to the vault endpoint | `apps/web/test/tenancy/sync-onrejected.test.ts`, `sync-onrejected.review.test.ts` |
| `withTestBinding(app, fn)` | `apps/server/test/helpers/binding.ts` (re-exported by `helpers/app.ts`) | **no-op** in step 0 (one owner database): runs `fn`, returns its value or promise, lets errors through. Step 1 gives it a body (bind the test user's vault); new suites already use the final form | `apps/server/test/tenancy/binding-harness.test.ts` |
| Base migrations `0041`, `0050` | `apps/server/src/db/migrations/0041_sync_actor_visibility.sql` (`sync_operation.actor_user_id`, `sync_change.visibility_key` + partial index), `0050_change_log_actor.sql` (`change_log.actor_user_id`, `actor_role`) — exactly ARCHITECTURE_DELTA §4.2 | additive `ALTER TABLE … ADD COLUMN`; on the owner's existing database they apply after `0810` (the runner applies missing files in name order) and every row is kept with the new columns NULL («the vault's user», «every reader of this DB»). Nothing writes them yet | `apps/server/test/tenancy/migrations-0041-0050.test.ts` (fresh DB; upgrade of a Round 7 database with rows; server boot on an upgraded data directory with sync and audit still working) |

**Rollback note (R1-a).** After `0041`/`0050` are applied, an older build refuses the database («migration … not
present in this build»), as for every migration so far; roll back by restoring the pre-upgrade backup.

**Not in step 0** (steps 1–3): the system database, request binding (`NO_TENANT_BOUND`), accounts, authz, the
platform routes, blob registry and GC, quotas, per-user IndexedDB and `localStorage`, the client-version gate and the
owner migration.

## Step 0 review (2026-10-20, adversarial reviewer)

Read every changed file; each finding below was reproduced by a test that failed before the fix.

| finding | severity | fix | test |
|---|---|---|---|
| `onRejected` delivered a final rejection only to the handlers registered at the moment of the push, at most once: a `layer_read_only` stroke pushed from the library screen (the workspace, which registers ink handlers lazily, not mounted), from another tab, or interrupted by a closed page between storing the verdict and running the handler was never re-homed; a handler that threw was never retried | major (data loss path for P1-T2's re-homing, ADR-0004 R2) | `pendingRejection` stored with the verdict in the same transaction, cleared only after all handlers succeeded; `onRejected()` delivers the pending rejections of its type on registration; deliveries are serialized (a push and a registration never hand one op over twice); superseded (retried) ops are skipped | `apps/web/test/tenancy/sync-onrejected.review.test.ts` (5) |
| The purge-extension seam had only a «before the core deletes» step, so P1-T2 could not purge `annotation_layer` rows (parents of `annotation.layer_id` / `note.layer_id`, no cascade): deleting them first fails the foreign key, and leaving them orphans the layers of a purged source — T2 would have had to edit `purge.ts`, which it does not own | major (seam gap) | optional `afterCore(ctx, set)` step inside the same transaction after the core deletes, with sync announcements | `purge-extension.review.test.ts` «afterCore() …» |
| An extension could remove ids from a core purge set (in `fill`, so the preview and the purge silently skipped a core step, e.g. leaving a note anchored on a purged source) or change the sets in `apply` after the confirm token was checked (skipping rows, or deleting rows the owner never saw in the preview) | minor (contract hardening; no extension exists yet) | the sets are snapshotted around every extension step; `fill` may only add, `apply` / `afterCore` may not change them; a violation throws and the whole purge rolls back. Only runs when an extension is registered (today's purge is unchanged) | `purge-extension.review.test.ts` (3) |

Checked and found correct: migrations `0041` / `0050` match ARCHITECTURE_DELTA §4.2 byte for byte in content, are additive
and apply after `0810` on a Round 7 database with every row kept (the restore path reports them as «pending» for an older
backup, then applies them at boot); no code inserts positionally into `sync_operation`, `sync_change` or `change_log`, and
the audit API maps fields explicitly (no new field leaks); the 11 error codes and HTTP statuses match §7.1 and the 8
capability keys match ADR-0005 §6, all answered `not_implemented` and hidden from «القدرات»; the Dexie v3 bump is
index-only, and an old tab still running the v2 code reopens the upgraded database (Dexie 4 opens a newer installed
version) and keeps writing target-less outbox ops that the new code pushes to the vault
(`apps/web/test/tenancy/localdb-old-tab.review.test.ts`, fake-indexeddb in jsdom; not run in a real browser with two
builds); `files/blobs.ts` is the same query as before.


**Forward notes for step 1 (not defects today).** The purge-extension registry is keyed by the `AppContext` object
(`WeakMap`); request binding must keep handing modules and routes the same root context (or move the registry onto it),
otherwise registered steps would be silently skipped. `fill()` does not recompute sets derived from the one it adds to
(documented on the interface): an extension that adds a source must add its versions, pages and items too, or the core
delete fails on the foreign keys and nothing is deleted. The builder's definition-of-done item 1 (re-verify the PRD
`Now` baseline of every covered row) and the Phase report draft were not part of step 0 and remain open
(`docs/REQUIREMENTS_MATRIX.md`, part AOS).


## Step 1 — system database, request binding, vault pool, accounts, authz core (2026-10-21, release R1-b)

BUILD_PLAN §3.3 step 1, ADR-0003 §3.1–§3.3, ARCHITECTURE_DELTA §1.1, §4.1, §5.5, §5.8, §7.2. **Steps 2–3 are not
part of it, and the owner is NOT migrated**: a single-owner data directory (`medlevo.sqlite`) is refused at boot with
nothing changed (see «Boot guard»), so this build must not be deployed over the owner's data before step 3 ships the
owner migration in the same release (BUILD_PLAN §1.3).

### What landed

| area | files | proof |
|---|---|---|
| System DB + its own migration set (bands: base 0001–1999, system 2000–2999, space 3000–3999; a file outside its band is refused) | `src/db/migrations-system/{2000_identity,2010_devices,2040_registry,2250_ops,2300_security}.sql` (ARCHITECTURE_DELTA §4.1; one addition: `job_index.actor_user_id`, §5.5 gate 6), `src/db/migrations-space/` (empty), `src/db/migrate.ts` (`sets`, bands, `migrationsFingerprint`) | `test/tenancy/migrations-system.test.ts` |
| Boot guard / layout | `src/system/layout.ts`: fresh dir → `system.sqlite` (tmp + rename) then marker `.multi-user`; `medlevo.sqlite`, a migration journal, or vault files / a marker without their system DB → `DataDirRefusedError` (Arabic + English), **nothing created or changed** — the guard now runs before anything else touches DATA_DIR | `test/tenancy/layout-and-tokens.test.ts` (byte-for-byte snapshot before/after, through `prepareDataDir` and a full `buildApp`) |
| Request / job binding (AsyncLocalStorage) | `src/system/binding.ts` (`TenantBinding`, `createBoundDb`, root context, `NO_TENANT_BOUND`), `src/modules/authz/hook.ts` (onRequest binds; preValidation re-enters after the body parser; the pool lease is released on response/close) | `test/tenancy/isolation.test.ts` |
| Vault pool | `src/system/pool.ts`: LRU with leases (a leased or in-transaction connection is never evicted, nor the one being handed out), WAL, pool size clamped to the open-file limit (`/proc/self/limits`, 4 fds per DB, 256 kept free; `MEDLEVO_DB_POOL_SIZE`, default 500), a missing file is an error (never a fresh empty DB), new vaults copied from a migrated template with their own sync epoch, `onOpen` hooks (first open per process) replace boot-time work | `test/tenancy/pool.test.ts` |
| Repositories, accounts | `src/system/repos.ts` (users, vault/space registry, devices, job index, security audit; user-facing methods take the viewer), `src/system/tenancy.ts` (`createAccount`: vault file first, then one system transaction; `vaultBindingFor(viewer)`; file-token scope) | `isolation`, `accounts`, `platform-routes` tests |
| Auth on the system DB | `modules/auth/{index,guard,sessions,limiter}.ts`: setup creates user #1 (platform admin) with its vault; sessions carry `user_id`; per-account progressive delay `LOGIN_SLOWED` (1, 2, 4 … 60 s after 5 failures; a valid recovery code always works) + per-address ceiling `MEDLEVO_LOGIN_IP_FAILURES_PER_HOUR` (300); setup keeps 5/min per address; `JoinTokenVerifier` interface only (no register route) | `test/auth.test.ts`, `test/deploy/client-ip.test.ts` |
| Accounts & devices API | `modules/accounts/index.ts`, `packages/shared/src/academic/accounts-api.ts`: `GET /api/accounts/me`, `GET/POST /me/devices` (idempotent per user + client id, server-issued `device_uid`), `DELETE /me/devices/:id` (revokes, clears the key; never revived), `PUT /me/devices/:id/key` (Ed25519, 32 bytes); security-audit rows | `test/tenancy/accounts.test.ts` |
| Authz core + space allow-list | `modules/authz/policy.ts` (deny by default, self-registering rules, any deny wins, a throwing rule hides, 404 when hidden / 403 otherwise; core rules: platform admin only, own vault only — admin included; membership provider skeleton = nobody; visibility-key providers), `routes.ts` + `spaceRoutes.ts` (`SPACE_ROUTES = []`; an unlisted `/api/spaces/…` route stops the boot) | `test/tenancy/authz.test.ts` |
| Platform-only routes (§5.8) | `PLATFORM_ROUTES` (16: evaluation, health, client-error list/clear, backups, off-site, `/export/all`) guarded in place + `/api/platform/status` (`modules/platform`, counts only) — a non-admin gets exactly the body of a missing route; the storage report shows a user their own vault and files only | `test/tenancy/platform-routes.test.ts` |
| Jobs across vaults | `modules/jobs/queue.ts`: the job stays in its database; system `job_index` (written first) lets the worker find due work; worker / heartbeat / poke / start run in the root context and bind each job's own database | `isolation.test.ts` «jobs», `jobs*.test.ts`, kill -9 resume (below) |
| Files | `modules/files/{store,index}.ts`: tokens carry `{f, e, d: 'v:<vault>', u: user}`; the public token route binds that vault only while it is active, still that user's and the user active. `files/blobs.ts`: bytes deleted only while ONE database exists (shared content-addressed store; step 2 GC) | `layout-and-tokens.test.ts`, `isolation.test.ts` «one blob store» |
| Backup / restore | `modules/data/{backup,backups,restore}.ts`, `cli/backup.ts`: a multi-user archive holds `system.sqlite` + `vaults/<file>` (manifest `layout: 'multi_user'`, `system`, `vaults[]`, `db` = the primary vault); restore writes a full data dir with the marker, revokes every session, gives every vault a new sync epoch; single-owner archives still restore to `medlevo.sqlite` (boot check on a sandbox copy) | `test/data/*`, `test/acceptance/g7-ac30.test.ts` |
| Import boundaries | system DB handle, `*Internal` methods, `ctx.dbs`, opening DB files by path, caches keyed by the proxy | `test/tenancy/import-boundary.test.ts` |

### Measured (this container, Node 22, `apps/server/test/tenancy/isolation.test.ts`, `MEDLEVO_MEASURE_OUT` writes JSON)

* **Per-statement binding overhead**: keyed `SELECT … WHERE key = ?` on a vault, 15 rounds × 5,000 statements:
  direct connection p50 4.37 µs, bound proxy p50 4.47 µs → **overhead p50 130 ns** (p95 1.37 µs) per statement.
* **Pool miss** (12 vaults, 4 slots, every access a miss): re-open p50 3.23 ms, **p95 3.67 ms** (NFR-P6 ≤ 50 ms);
  first open in the process (open hooks included) p50 3.54 ms, p95 3.87 ms.
* **Isolation**: 200 interleaved requests of two users (library tree, node by id — own and the other's —, binding
  probe, a request-scoped timer): **0 cross reads**; the other user's id is 404.
* **kill -9 mid-processing, restart, resume** (`test/perf/crash-resume.perf.test.ts`, `MEDLEVO_PERF=1`,
  `MEDLEVO_PERF_PAGES=60` — the 300-page default was not run): resumed 2.95 s after the restart, no duplicate reading
  orders / review items / image assets.

### Defects found by the step-1 tests (each failed before its fix)

| defect | fix | test |
|---|---|---|
| The pool could evict the connection it was handing out when every older one was leased → «database is not open» on the first statement of a request when the pool is full | `evict(keep)` never closes the entry just opened | `pool.test.ts` «a leased connection …» |
| The boot created `DATA_DIR/tmp` before the guard ran, so a refused single-owner directory was not left exactly as it was | the guard runs first; `tmp` is created after it | `layout-and-tokens.test.ts` (4 refusal cases) |
| One user removing a file deleted blob bytes another vault still used (same content → same blob) | bytes are kept while more than one database exists (step-2 GC deletes them) | `isolation.test.ts` «one blob store» |
| Three memos/caches were keyed by the proxy `ctx.db` (one object for every vault): brain relation caches, card-impact memo, weakness memo — one user's signature could skip another's recompute | keyed by `ctx.db.raw` (the bound connection) | `import-boundary.test.ts` «per-database memory», `isolation.test.ts` |
| A non-admin on a platform route got «العنصر غير موجود» instead of the missing-route body | the hook answers with the missing-route error | `platform-routes.test.ts` |
| The Control Center pruned the correction history of purged sources once at module registration; with no database bound at boot it failed (logged warning) and never ran — found in the E2E server log | a pool open hook (`control.prune-orphan-history`) | `layout-and-tokens.test.ts` «per-database work …» (production-like boot: no unbound access except the AI budget's intentional one) |
| (test hygiene) `offsite.test.ts` asserted on the shared OS temp directory, where `offsite-cli.test.ts` (another worker) restores too — failed once in the full run | each off-site test app gets its own parent directory | `test/data/offsite.test.ts` |

### Edits outside P1-T1-owned files (smallest seam-compatible changes)

* boot-time work moved to `ctx.pool.onOpen` (no database exists at boot): `modules/questions/index.ts`
  (refingerprint), `modules/sources/index.ts` (enqueue pending versions), `modules/versions/index.ts` (fingerprint
  backfill), `modules/control/quality.ts` (catalogue sync, platform vault only), `modules/control/index.ts` (prune of
  the correction history), `modules/data/index.ts`;
* `modules/control/evaluation/harness.ts`: a single-account tool process (`singleTenantTool`);
* `modules/ai/orchestrator.ts`: `budget()` reads 0 spent when nothing is bound (status at registration);
* `modules/brain/relations.ts`, `modules/learning/{store,weakness}.ts`: memo keys `ctx.db` → `ctx.db.raw`;
* `modules/control/storage.ts`, `modules/sync/index.ts`, `modules/data/{offsite,backup,backups,restore}.ts`,
  `cli/{backup,eval}.ts`: multi-user layout;
* `e2e/aos-p1-layers.spec.ts`: finds the owner's vault through `system.sqlite` instead of `medlevo.sqlite`.

### Tests changed (ADR-0003 §3.10)

Mechanical (paths and tables of the multi-user layout): `test/data/{backup-restore,export,offsite,offsite-cli,security}.test.ts`,
`test/acceptance/g7-ac30.test.ts` (the vault differs only in `change_log` and `data_server_epoch`; sessions are revoked in
`system.sqlite`), `test/perf/crash-resume.perf.test.ts`, `test/studybook/browser-server.ts`; old-schema boots
(`test/tenancy/migrations-0041-0050.test.ts`, `test/annotations/layers-migration.test.ts`) now load the old database as
the account's vault (`bootOnVaultFile`). By design: `test/auth.test.ts` (accounts/sessions/limiter on the system DB;
limiter tests rewritten for the per-account delay), `test/deploy/client-ip.test.ts` (per-address ceiling set to 5),
`test/data/offsite-review.test.ts` (the real scheduler: no vault before the first account), `test/acceptance/g1-ac01.test.ts`
(AC-01a; the route vocabulary ban removed, AC-01b = `test/tenancy/isolation.test.ts`). Harness: `test/helpers/{app,binding,template,tenancy}.ts`.

### Not done in step 1

Steps 2–3 (blob registry + GC, quotas, export/delete my account, per-user IndexedDB / `localStorage`, the client-version
gate, **the owner migration** and the boot guard's resume / maintenance page); the register route (only the
`JoinTokenVerifier` interface — T4); memberships and roles tables (T4: `2050_directory`, `2100_permissions`);
`RATE_LIMITS` of other routes are still keyed by address; the «200 sign-ins from one address» load test;
`brain/course.ts` `running` and `media/recordings.ts` `inflight` are keyed by ids without the vault (they only serialize
work, no data crosses; noted for step 2); no device, phone, pen or provider was used — every result above is from this
container.

## Step 1 review (2026-10-21, adversarial reviewer)

Read every file step 1 changed (system/*, authz/*, accounts, platform, auth, jobs, files, data backup/restore, control
storage, context/app/config/index, migrations, the harness and the edited tests) and probed binding under concurrency
with scratch tests before calling anything a defect. Each finding below was reproduced by a test that failed before its
fix; the regression tests are in `apps/server/test/tenancy/step1.review.test.ts`.

| finding | severity | fix | test |
|---|---|---|---|
| A valid session whose vault cannot be used right now (locked for a restore or migration, being deleted, missing) was a dead end: EVERY request — `/api/auth/status`, sign-out, even signing in as another student on that browser — answered 401 «سجّل الدخول مرة أخرى», and signing in again could not help. A shared browser could neither sign out nor be handed over (nothing sets `locked` yet in step 1; steps 2–3 do) | minor (latent until steps 2–3; privacy on shared browsers) | the binding hook binds no database for such a session: sign-out and sign-in work (they retire that session), the public routes answer as for someone signed out (`authenticated: false`, so the web client shows the sign-in screen instead of looping), everything else is 401 with the reason (`ACCOUNT_UNAVAILABLE_AR`); sign-in with the right password for such an account says why instead of creating a useless session | «a session whose vault is not usable right now» (2) |
| The job index (system DB) could lose sight of a queued job: a job enqueued between the system-DB snapshot and the vault snapshots of a whole-instance backup has no index entry after a restore, and an entry met while its vault was locked was parked «unavailable» forever — in both cases the job never ran and nothing reconciled the two files (`sources.enqueue-pending` returns the existing job by idempotency key without re-indexing it) | major (work silently stuck after a restore; no data lost) | `JobQueue.reconcileIndex(ref)`: the job rows are the truth; every unfinished job is (re)indexed and finished / parked entries corrected. It runs when the pool first opens a database in the process (context.ts open hooks, registered before the modules') and, for «unavailable» entries, from the heartbeat. It never drops an entry whose job row is merely absent (that is an enqueue in progress: the index row is written first and the open happens inside that enqueue's INSERT — the first version of this fix had exactly that race, caught by `test/jobs.test.ts`) | «the job index never loses a queued job of a vault» (2, incl. the first-open race) |
| The platform admin's storage report called other accounts' files «غير مسجّلة في قاعدة البيانات (بقايا عمليات سابقة)؛ لا تدخل في النسخ الاحتياطية» — false: they are other users' files and every whole-instance backup includes them | minor (honesty) | with more than one database the note says the store is shared and includes other accounts' files (`Tenancy.sharesFileStore()`) | «storage report honesty with several accounts» |

Checked and found correct (probes kept in the review's scratchpad, not in the repository):

* **Binding under concurrency**: 300 interleaved requests of 10 users on a pool of 4 (constant eviction) — no error,
  0 cross reads, 0 leaked leases, pool back at ≤ 4; 28 SSE streams (`sendStudyStream`) interleaved with request-scoped
  timers that fire after the response, after the lease was released and the vault evicted — every write landed in the
  requester's own vault; 20 interleaved multipart uploads of two users — each source in its uploader's vault. Event
  listeners (`reply.raw.on('close')`, stream `data`) touch no database; every server timer is created in the root
  context; no module-level cache keyed by something two vaults share returns another vault's data (the quiz-render
  cache is keyed by the file's sha256 after an own-vault lookup; `brain/course.ts running` and `media/recordings.ts
  inflight` only serialize).
* **Sync and SRS per account** (no test existed): a two-account pull never returns the other's note, card or review; the
  same client `op_id` used by both accounts gives each its own result; each vault holds only its own cards and review
  events — `step1.review.test.ts` «sync feeds, op replay and spaced repetition stay per account».
* **Unbound access**: public routes and unauthenticated requests bind the strict root context (also in tests); boot work
  is open hooks; `NO_TENANT_BOUND` maps to the generic 500 body.
* **Platform routes**: every whole-deployment route of §5.8 that exists today is in `PLATFORM_ROUTES` (compared with the
  route table: backups ×6, off-site ×3, `/export/all`, evaluation ×3, health, client-errors GET/DELETE); the check
  uses the route pattern, so URL spelling, trailing slashes and HEAD cannot bypass it.
* **Sessions**: a fresh random token on every sign-in (an existing cookie is retired, never adopted); suspended users'
  sessions are no session; every listing / revocation is the user's own.
* **Measured again** (this container): binding overhead p50 83 ns, p95 2.1 µs per statement; pool miss p50 3.75 ms,
  p95 5.6 ms (NFR-P6 ≤ 50 ms); first open with hooks (now including the index reconciliation) p95 6.5 ms.

Open after the review (not fixed here, with reason):

* **Release gating (major, process):** Render redeploys on every commit (`render.yaml` `autoDeployTrigger: commit`) and a
  service with a disk stops the old instance first. Merging step 1 to the branch the owner's service tracks would stop
  the owner's server (it refuses `medlevo.sqlite`, data unchanged) until step 3 ships. R1-b must reach that branch only
  with step 3 (BUILD_PLAN §1.3); `docs/DEPLOYMENT.md` §6 says so in English, the Arabic phone guide does not.
* `RATE_LIMITS.auth` (30 sign-ins per minute per address, `lib/http.ts`) still caps a class behind one campus NAT
  (AOS-21.45 «IP ceilings high enough for a class»); no register route exists yet, so only one account can sign in today.
* The AI budget is read per vault (`ai/orchestrator.ts budget()`): each account would get the whole deployment budget —
  per-user allowance and atomic reservation are step 2 (latent: one account in R1-b step 1).
* Platform views that read base tables (client-error list, health, evaluation, backups list) show the platform admin's
  own vault (the interim home of platform records); accurate while one account exists.
* `POST /api/accounts/me/devices` has no per-user cap; a whole-instance backup lists vaults in status `locked` /
  `deleting` too and would open a missing file by path (creating an empty one) — both latent until steps 2–3.
* A `system.sqlite` that exists but is empty, next to existing vault files, is not refused (it gets migrated and offers
  first-run setup; the vault files are left untouched, so nothing is lost). Refusing it needs to tell a crashed first
  setup (one empty template vault) from real data — left to step 3's boot guard.

## Step 2 — uploads, blob registry + GC, R2 blobs, encrypted and per-vault backups, export / delete my account, quotas, AI allowance (2026-10-21, release R1-b, builder; reviewed below)

BUILD_PLAN §3.3 step 2; ADR-0003 §3.4–§3.7, §7 Q10 / Q14 / Q22 (owner defaults); ARCHITECTURE_DELTA §4.1 `2250_ops`,
§7.2, §7.12. **The owner is still NOT migrated** (step 3): the boot guard keeps refusing `medlevo.sqlite`, so this build
must not reach the branch the owner's service deploys from before step 3 (BUILD_PLAN §1.3; step-1 review «release
gating»). `2250_ops.sql` was extended in place — it has never been released (no new base migration).

### What landed

| area | files | proof |
|---|---|---|
| Ops tables (unreleased `2250_ops` extended) | `blob_sweep` (each mark pass / sweep: status `running·completed·incomplete·failed`, counts), `upload_session.file_id` + `updated_at` + `(user_id, status)` index, `ai_budget_ledger.space_id` (+ space / time indexes); repositories in `src/system/ops.ts` (`BlobRegistry`, `QuotaRepo`, `AiBudgetLedger`, `UploadSessionRepo`) | `migrations-system.test.ts`, the tests below |
| Blob registry — bytes are deleted only through it | `modules/files/blobs.ts` (`BlobService`): every `stored_file` registers its blob and a per-database hint (`blob_ref`, a hint only — the rows are the truth); one database → the last row removes the bytes at once (exact, as before); several → hint dropped, bytes left to the GC | `blob-gc.test.ts` «blob registry and hints» (3) |
| Mark-and-sweep GC | `modules/files/gc.ts` (`BlobGc`): reads every live database read-only (vaults not deleted + spaces; avatars, upload sessions in flight), yields between databases, marks live references DURING the sweep, adopts files the registry never knew; orphan → (≥ 7 days, next sweep) quarantine `DATA_DIR/quarantine/` → (30 days, a fresh mark still misses it) delete (remote copy first, then local); a quarantined blob referenced again is put back; any unreadable database → `incomplete`, nothing decided (fail-closed); a mark pass at boot (30 s after listen) and after every restore rebuilds the hints; daily sweep at `MEDLEVO_BLOB_GC_SCHEDULE` (default 04:20 local); single-flight | `blob-gc.test.ts` «mark-and-sweep» (10) |
| Platform view | `GET /api/platform/blobs` (counts and the last sweeps only), `POST /api/platform/blobs/sweep` (202) | `blob-gc.test.ts` «platform view» |
| Chunked resumable uploads | `modules/files/uploads.ts`, `packages/shared/src/academic/files-api.ts`: `POST /api/files/uploads` (size, sha256, mime; resumes the user's open session for the same bytes; completes at once when the vault already holds them; checks the quota with open sessions counted), `PUT …/:id/chunks/:n` (`application/octet-stream`, exact size, `x-content-sha256` per chunk, fsync + rename), `POST …/:id/complete` (missing chunks → 409 with the list; the assembled file must match the announced sha256, else `failed` and nothing stored), `DELETE …/:id`; sessions are the user's own (404 for anyone else); 24 h expiry, maintenance removes chunks; a space target is refused until R1-c | `uploads.test.ts` (8) |
| R2 for blobs (optional) | `modules/files/r2.ts` (`R2BlobStore` over PL-0's SigV4 `S3Client` / `uploadObject`): `MEDLEVO_BLOB_STORE=r2` copies each blob once, MLVENC01-encrypted, under `blobs/aa/bb/<sha256>.mlenc` (HEAD size check, `medlevo-sha256` metadata); a lost local copy is fetched back, decrypted and verified (sha256 + size) before it is served; a damaged copy is never served; only the registry deletes a remote copy. Local disk stays the default and keeps every file (no eviction). r2 without complete R2 settings + key refuses to start | `blob-r2.test.ts` (5) — **against the local S3 fake only (signature-verifying), never a real R2 bucket** |
| Encrypted backups | `modules/data/archive-crypto.ts` (reuses `lib/crypto` MLVENC01 streams); `npm run backup -- --encrypt` keeps only `.tar.gz.mlenc` + `.sha256` (no key → exit 2, nothing kept); `restore:verify` decrypts with `MEDLEVO_BACKUP_ENCRYPTION_KEY` (new `decrypt` check); the whole-instance download with several accounts is MLVENC01 only (no key → 409 with the Arabic reason); one account keeps the plain archive (AC-30) | `encrypted-cli.test.ts` (real processes), `vault-backup.test.ts` «whole-instance archive download» (2) |
| Per-vault backup / restore | `modules/data/vault-backup.ts`, platform routes `GET/POST /api/platform/vaults/:id/backups`, `POST …/restore` (202, background): a vault-layout archive (`manifest.layout = 'vault'`, `account`; encrypted when the key is set — the plain archive never stays); restore verifies on a sandbox, must match that vault / user / file, locks the vault, waits for it to be idle (gives up and unlocks otherwise), keeps `pre-restore-<time>.sqlite`, gives the vault a new sync epoch, revokes only that user's sessions, reconciles its jobs, runs a mark pass; any failure rolls back | `vault-backup.test.ts` (5) |
| «نسخة من بياناتي» (export) | `modules/accounts/export.ts`: `POST /api/accounts/me/export` (a job in the user's own vault; one at a time), `GET /me/exports`, `GET /me/exports/:job/download` — the per-vault archive of the user's vault and the files it references only, newest 3 kept | `test/accounts/export-delete.test.ts` «نسخة من بياناتي» |
| Delete my account (Q14 default) | `modules/accounts/deletion.ts`: `POST /me/delete {preview}` → counts + policy text + a 15-min HMAC token; `{confirm_token, password}` → `deletion_pending`, vault `deleting`, every session revoked in one system transaction; finishing (now, then every minute and at boot until done; waits while the vault is leased) calls the deletion participants (seam for publications R1-d), removes the vault file, its exports, its backups, its chunk dirs and blob hints, deletes devices, and leaves an anonymous row (`deleted:<id>`, «طالب سابق»); the last platform admin cannot delete; audit `account_delete` / `account_deleted` | `export-delete.test.ts` «account deletion» (4) |
| Storage quotas (Q22) | `src/system/quota.ts` (`QuotaService`): used = the vault's logical size (`page_count × page_size`) + its files; 2 GB per student vault (`MEDLEVO_USER_STORAGE_QUOTA_MB`), user #1 unlimited, spaces 20 GB (recorded, not enforced before R1-c); checked before a NEW file of a signed-in user is written (`files.put` hook, uploads at start) → `QUOTA_EXCEEDED` 409 `{kind, used, limit, wanted}` with the Arabic reason; background work is counted, never refused; `GET /api/accounts/me/quota`, `quota` in `/me`; `GET/PUT /api/platform/quotas/users/:id`, `PUT …/spaces/:id` (null = default; audited) | `storage-quota.test.ts` (4), `accounts.test.ts` |
| AI allowance + atomic reservation (Q10) | `modules/ai/budget.ts` + `ai_budget_ledger`; `ai/orchestrator.ts` reserves the estimated cost before each provider call in one `BEGIN IMMEDIATE` (user or space allowance AND the deployment ceiling), settles with the estimated cost after it, releases on a call that never reached the provider; usage recorded before the ledger counts (max of the two); stale reservations released at boot; user #1 = deployment budget, others and spaces 0 until set («غير مُفعّل لحسابك») | `test/ai/allowance.test.ts` (8, incl. 12 concurrent reservations against an allowance of 3) |
| Device cap (step-1 review) | `modules/accounts/index.ts`: at most 50 active devices per account; re-registering a known device always works | `accounts.test.ts` «device cap» |
| Platform storage report | `modules/control/storage.ts`: quarantine and exports shown to the platform admin | `platform-routes.test.ts` |

### Measured (this container, Node 22; scratch measurement, not in the repository)

* **Mark pass** over 41 vaults holding 2,000 blobs: ≈ 275–310 ms; **full sweep** (mark + adopt + decide) ≈ 284–297 ms,
  yielding between databases.
* **`files.put` of 1 KB** for a signed-in user (quota check + registry + hint): p50 4.1 ms, p95 13.5 ms; the same
  without the quota (background work): p50 3.3 ms, p95 12.2 ms.

### Defects found by the step-2 tests (each failed before its fix)

| defect | fix | test |
|---|---|---|
| (step-1 latent) A whole-instance backup of a registered vault whose file is missing created an EMPTY database in the data directory and archived it as if it were the account's data | `vacuumInto` refuses a missing source (`WRITE_FAILED` with the reason); nothing is created | `vault-backup.test.ts` «a registered vault whose file is missing …» |
| (step-1 latent) A vault being deleted was still put in whole-instance backups and their manifests | backups (server + CLI) and the restore registry check read only `active` / `locked` vaults | `vault-backup.test.ts` «a vault being deleted is left out …» |
| (step-1 open) The AI budget was read per vault: every account would get the whole deployment budget, and two concurrent calls could both pass a nearly spent budget | the system ledger with an atomic reservation | `allowance.test.ts` «concurrent reservations never exceed …» |
| (step-1 open) No per-user device cap | 50 active devices | `accounts.test.ts` «device cap» |
| (found while building) The storage quota measured the vault FILE before opening it: WAL growth from the user's own writes pushed an account over its limit | logical size through the pooled connection (`page_count × page_size`) | `storage-quota.test.ts` «… background work and the same bytes again pass» |

### Edits outside P1-T1-owned files (smallest seam-compatible changes)

* `modules/ai/orchestrator.ts`: optional `charge` (reservation / settle / release) — behaviour unchanged without it;
* `modules/files/store.ts`: `FileStoreHooks` (`beforeNewFile`, `referenced`, `ensureLocal`) and `localPath(id)`;
* `modules/data/{backup,backups,restore,index}.ts`, `cli/{backup,restore-verify}.ts`: vault layout, encryption,
  `active|locked` filter, missing-file refusal;
* `modules/control/storage.ts`: two «other» categories;
* shared contracts: `packages/shared/src/academic/{files-api (new),accounts-api,platform-api,index}.ts`,
  `packages/shared/src/data-api.ts` (`BackupManifest.layout/account`);
* nothing in `apps/web` (the writing track's `apps/web/src/features/workspace/ink/*` untouched).

### Tests changed (ADR-0003 §3.10)

* `test/acceptance/g7-ac30.test.ts` «EVERY table comes back row for row»: the restore's boot check now runs one blob mark
  pass on the restored directory, so `blob_sweep`, `blob_mark` and `blob_ref` differ from the live system DB on
  purpose; the test asserts it precisely (one new `mark` sweep, completed, nothing orphaned / quarantined / deleted;
  its marks are exactly the hints; the hints equal the live ones as a set — only their row order changed).
* `test/tenancy/accounts.test.ts` (quota in `/me`, step-2 routes in the 401 list, device cap),
  `test/tenancy/import-boundary.test.ts` (the new modules allowed to use `*Internal` / open DB files by path),
  `test/helpers/app.ts` (`gc` and `blobStore` overrides).

### Not done in step 2 (with reason)

* **Owner migration and per-user web storage** — step 3.
* **Web UI** for quota, export, deletion and the chunked-upload client (step 3 web lib). Note for the writing track:
  `apps/web/src/features/workspace/ink/images.ts` treats any 409 as final; a `QUOTA_EXCEEDED` there is final by design
  (not retryable) — no change needed, but its message should show `error.message` (N1-owned, not edited).
* Per-user keys for the remaining `RATE_LIMITS` (uploads/AI keyed by address) and the «200 sign-ins from one address»
  load test; ASR minutes quota; space storage enforcement (R1-c); `ai_processing` consent (AOS-21.42) and space
  cache keys with viewer scope (AOS-14.1) — R1-c/R1-d.
* R2 local-cache eviction (every blob stays on local disk too); a real R2 bucket was **not run** (no account in this
  container) — only the local S3 fake.
* Platform records (client errors, health, evaluation) still live in user #1's vault (step-1 open item).
* No phone, tablet, pen, Render, R2 or AI provider was used — every result above is from this container.

## Step 2 review (2026-10-21, adversarial reviewer)

Read every file step 2 changed (system/ops.ts, quota.ts, repos.ts; files/{blobs,gc,uploads,r2,store,index}.ts;
accounts/{export,deletion,index}.ts; ai/{budget,orchestrator}.ts; data/{archive-crypto,vault-backup,backup,backups,restore,
index}.ts; platform; the CLIs; `2250_ops.sql`; the shared contracts and the eight step-2 test files) and probed the
scope (refcount races and the GC, upload resume, R2 error paths, encryption reuse, export completeness, account
deletion, quota bypass, AI reservations under concurrency). Each finding below was reproduced by a test that failed
before its fix; the regression tests are in `apps/server/test/tenancy/step2.review.test.ts` (12).

| finding | severity | fix | test |
|---|---|---|---|
| A provider call STOPPED after it reached the provider — the student closes the stream (`studybook/stream.ts` aborts the call), a job is cancelled, the call times out — released its whole reservation and recorded 0: any account with a cap could exceed it without limit by closing streams just before they end (the provider bills what it generated) | major (cost control; Q10 allowance bypass) | `ai/orchestrator.ts`: such a call keeps its reservation at the worst-case ESTIMATE (`settled`); only a failure the provider reports without billing (HTTP 4xx/429/5xx, connection refused) or a call aborted before it was sent releases it | «review 1» (2) |
| Account deletion left personal data in the system DB: the account's sessions (IP addresses, browser strings, device labels), its sign-in attempts under the OLD login name (the policy says the login name does not remain), and its upload sessions (file names, e.g. «تقريري الطبي الخاص.pdf»); and the policy text implied the files' bytes go at once although the GC removes them (and their R2 copies) only after ≈ 6 weeks | major (AOS-21.44 «removes … sessions»; private data) + minor (honesty) | `finalizeDeletionInternal` deletes `auth_session` rows and `login_attempt` rows under the old `username_norm`; `upload_session` rows are deleted (`deleteAllInternal`, replaces `failAllInternal`); two policy lines say when file content leaves the store and that sessions, devices and sign-in attempts go | «review 2» |
| «نسخة من بياناتي» with `MEDLEVO_BLOB_STORE=r2` left out every file whose local copy was missing (a new disk) although the object store had it, and the export still said «completed» with nothing about the missing files (the job dropped `files_missing`) | major (export completeness, honesty) | `createBackup` takes an `ensureLocal` hook — the export, the per-vault backup and the whole-instance backup fetch a missing blob back from the object store first; the export output records `missing_files` and `AccountExportView` carries `missing_files` + `warning_ar` (`EXPORT_MISSING_AR`) | «review 3» (2) |
| The replicator always took the 200 OLDEST pending blobs; blobs it must skip (local copy lost, orphaned — orphaned ones were not even excluded by the query) kept the head of the queue, so newer blobs never got their off-site copy | major (silent stall of off-host protection, AOS-OC.7) | `pendingReplicationInternal(limit, afterSha)` excludes orphaned blobs and is read from a cursor that continues each pass and wraps around | «review 4–6» first |
| A damaged local copy (bit rot, same size) was uploaded and recorded `storage = 'r2'` — the «confirmed» remote copy could never be restored (`get()` verifies and would refuse it) | minor (false assurance) | `R2BlobStore.put` hashes the local file first and refuses a mismatch (counted `failed`, logged) | «review 4–6» second |
| A blob quarantined (or deleted) while its copy was uploading kept that remote object forever: the registry stayed `local`, so neither the GC nor deletion would ever remove it (an encrypted copy of a deleted account's file left in R2) | minor (privacy / storage) | the replicator deletes the copy it just made when the blob was quarantined or forgotten meanwhile | «review 4–6» third |
| Two «complete» calls of one upload session at once (a phone that times out on a large recording retries) both assembled and stored the whole file; the second could fail half-way when the first removed the chunks | minor (double work and disk; a spurious 500) | single-flight per session: a concurrent «complete» waits for the running one and gets the same answer | «review 7» |
| A vault restore while a sweep runs: the sweep had read the vault's OLD file, the restore swapped the file (its `mark` request just returned the running sweep), and the sweep then quarantined a blob the restored vault uses — the restored file read failed (ENOENT) until the next sweep | major (data unavailable after a restore; no loss — the next sweep puts it back) | `restoreVault` copies the restored DB beside the live file, then waits for `gc.idle()` before the swap; nothing awaits between the swap and the mark pass | «review 8» |
| Two restores of one vault at once both swapped the file (the second kept the first's result as its «rollback» copy) | minor (platform admin only) | one restore per vault at a time (`CONFLICT`) | «review 9» |
| A whole-instance archive made while a second account existed was downloadable in CLEAR again once only one account remained — with the deleted account's vault inside | major (private data of a deleted account) | the encrypted-only rule now asks «has this deployment EVER had more than one database» (`Tenancy.hasHadSeveralDatabases`, deleted vaults counted) | «review 10» |
| The GC's adoption of unregistered files walked the whole store without yielding (≈ 65,536 directory reads + one registry lookup per file on a large store) | minor (event-loop block once a day, NFR-OP2) | yields after each top-level folder (1/256 of the store) | covered by `blob-gc.test.ts` |

Checked and found correct (no change):

* **GC never deletes a referenced blob**: only `FileStore.put` inserts `stored_file` rows (grep), and it registers and
  live-marks them in the same synchronous step; deletion needs two complete sweeps ≥ 7 days apart, 30 days of quarantine
  and a fresh mark; an unreadable or missing database (not `deleting`) makes a sweep `incomplete`; the single-database
  path deletes only after a transaction proved no row references the blob (R1-a behaviour); `deleteQuarantined` re-checks
  the mark after its remote delete and keeps bytes that came back.
* **Upload resume**: a lost `start`, chunk or `complete` answer is idempotent (same session, same chunk, same file);
  sessions are per user and per vault; expiry extends with each chunk; open sessions count toward the quota.
* **Encryption reuse**: every MLVENC01 stream gets a fresh 32-byte salt (HKDF file key, counter nonces); the R2 blob
  upload reuses its salt only to re-create byte-identical ciphertext of the same (now verified) plaintext on a retry.
* **Export contents**: the vault snapshot and the files it references only, each verified by sha256 (another user's
  bytes cannot enter: content addressing + hash check); client errors are stored in each user's own vault.
* **Quota**: the check and the row insert run in one synchronous step after the bytes are streamed, so concurrent
  uploads cannot both pass; deduplicated bytes in the same vault add nothing; chunks are bounded by the announced size.
* **AI reservations**: single process, synchronous `BEGIN IMMEDIATE` — 8–12 concurrent calls never exceed a cap
  (builder's test re-run); stale reservations are released only when older than an hour.

Open after the review (not fixed here, with reason):

* **Exports are not counted in the quota** and the newest 3 are kept per account: a 2 GB vault can hold ≈ 6 GB of
  export archives on the server disk (rate limit 3 per 10 min). Owner decision (keep 1, expire after N days, or count
  them) — recommended before many students join.
* Work done for a user in the background (page renders, images extracted from DOCX/PPTX) and vault growth through sync
  (notes, ink) are counted but never refused (by design, §14); only uploads and annotation images are refused.
* The deployment ceiling counts user #1's pre-ledger usage only on user #1's own calls (another account's call sees the
  ledger alone) — bounded by that month's pre-ledger spending, first month after the migration only.
* `pre-restore-<time>.sqlite` rollback copies are never pruned (removed with the account); a rollback older than ~5
  weeks may reference blobs the GC has since deleted.
* With `MEDLEVO_BLOB_STORE` switched from `r2` back to `local`, remote copies are never deleted any more (the GC needs the
  adapter); the CLI backup (`npm run backup`) cannot fetch blobs back from R2 (no context) and lists them as missing.
* `security_audit` rows keep the IP of a deleted account's own security events (retained as the platform's security
  record; no content).
* Real Cloudflare R2, Render, devices and AI providers: **Not run** (no accounts or devices in this container).

## Step 3 — owner migration, boot guard, client-version gate, per-user web storage, AC-01a server part (2026-10-21, release R1-b, builder)

BUILD_PLAN §3.3 step 3 and §1.3 (owner-migration rule: **no new base migration** in the release that migrates the
owner — `srv:tenancy/owner-migration` «release rule» pins the shipped base set to R1-a's, last `0861_attribution.sql`);
ADR-0003 §5 (journaled migration), §3.7 (per-user web storage); ARCHITECTURE_DELTA §4.5, §8.7. Operator runbook:
`docs/DEPLOYMENT.md` §6.1; owner's Arabic guide: `docs/DEPLOY_PHONE_AR.md` «التحديث الأول إلى نظام الحسابات المتعددة»;
backup and rollback: `docs/BACKUP_RESTORE.md` §8.

### What landed

| area | files | proof |
|---|---|---|
| Journaled owner migration | `src/system/ownerMigration.ts`: journal `DATA_DIR/migration-journal.json` (fsync'd JSON lines; a torn last line is ignored); steps `begin → freeze → safety → system_db → move_vault → commit → verify → complete`, `first_boot` recorded by `index.ts`; every step re-checks its own result on resume (a rename that already happened, a temp system DB already written); pre-move non-retryable errors abort with nothing changed (`migration-journal.aborted-<ts>.json`); `planOwnerMigration` (dry run), `rollbackOwnerMigration` (resumable; refuses when other accounts exist, a base migration was applied since, or both `medlevo.sqlite` and the vault exist), `migrationStatus`; `DATA_DIR/server.lock` so the CLI never moves files under a running server | `srv:tenancy/owner-migration` (37) |
| What user #1 gets | the owner row verbatim (username, scrypt hash, recovery-code hashes, `created_at`), platform admin + `legacy_owner`; active sessions with the same token hashes (devices stay signed in); devices from sessions and the sync log (cursors and epoch continue); blob rows + hints; job index of unfinished jobs; a security audit line | same, «user #1 verbatim», «first boot», «cursor / epoch», «outbox replayed exactly once» |
| Boot guard + maintenance page | `src/system/maintenance.ts` (`planBoot`, `startMaintenance`), `src/index.ts`: legacy → page waits (or `MEDLEVO_OWNER_MIGRATION=apply`); unfinished journal → resume at once; `rollback` → rollback; refused layouts (`orphan_vaults`, new `legacy_beside_multi_user`) → a page that says why; then the app boots on the same port. Page: Arabic, RTL, no JavaScript, strict CSP, 44 px targets, light / dark / high contrast; owner credentials (current password or an unused recovery code, not consumed), explicit confirmation, Origin / `Sec-Fetch-Site` checks, 10 failures / 15 min per address; `/api/health` 200 `{maintenance:true}`, `/api/auth/status` signed out, other `/api` 503 `FEATURE_DISABLED` naming the page | `srv:tenancy/maintenance` (12, incl. a real `src/index.ts` process: page → start → app on the same port, the R1-a cookie still valid, `first_boot` recorded) |
| CLI | `src/cli/migrate-multi-user.ts` (`npm run migrate:multi-user -- --dry-run|--apply|--resume|--rollback|--status`), Docker wrapper `deploy/docker/medlevo-migrate-multi-user` (runs as `node`, takes the running server's `MEDLEVO_DATA_DIR`) | `srv:tenancy/owner-migration` «SIGKILL …», «refuses to run twice» (exit 2) |
| Client-version gate | `packages/shared/src/api.ts` (`MIN_CLIENT_VERSION` 0.1.0, `USER_HEADER_NAME`, `compareClientVersions`, `isSupportedClientVersion`); `modules/auth/clientGate.ts` + `guard.ts`: a missing / older `x-medlevo-client` → 426 `CLIENT_TOO_OLD` (`details.min_version`) for writes and JSON reads, except for user #1 (the first account); sign-in from an old client only as user #1; exempt: health, status, logout, recover, file tokens, maintenance; `x-medlevo-user` ≠ the session's user → 401 `session_user_changed` | `srv:tenancy/client-gate` (7) |
| Who owns a device's R1-a data | `MeLite.owns_legacy_device_data` in `/api/auth/status` and `/api/accounts/me` (true only for user #1) | `client-gate` «who owns the data …» |
| Per-user web storage | `apps/web/src/lib/userStorage.ts` (`userStorage`, `userSession`, `deviceStorage`, the page's account, the device-level legacy-claim record, `clearAccountKeys`); `localdb.ts` (`getDb()` follows the account: `medlevo:<id>`, or `medlevo` for user #1 after `claimLegacyLocalData` — zero copy, marked in the database's `kv` and on the device); `sync.ts` (the engine rebinds to the page's database, per-database lock); `auth.ts` (`activateAccount` → `same|activated|reload`, `activateCachedAccount` offline, the device pointer keyed by account, no device id borrowed by another account); `guards.ts` (reload when the page held another account's data); `api.ts` / `uploadXhr.ts` / `errorReporter.ts` (headers; 426 → `PwaUpdatePrompt` applies the waiting update, also when another account signs in); drafts tagged with their writer (`noteDrafts.ts`); every `localStorage` / `sessionStorage` call site moved to the helper (settings, capabilities, device id, theme / display, library, cases, workspace, notebook, selection draft, back stack, ink prefs, ink tiles flag); ESLint `no-restricted-globals` / `no-restricted-properties` + a source scan keep it there | `web:test/tenancy/{userStorage (9), localdb-per-user (7), noteDrafts-per-user (4), client-headers (5)}` |
| AC-01a server part | `test/acceptance/ac01a.test.ts`: every step of AC-01 for user #1 and for another account with no channel; institution kinds refused; no channel route / capability; each library its own; the gate never blocks a current client | `srv:acceptance/ac01a` (7) |

**Decisions to know (deviations from the letter of ADR-0003 §3.7 / §5 step 8, each for data safety):**

* **User #1 claims the R1-a local data in place** instead of copying it to `medlevo:<id>` / `<id>:` keys: no copy of a
  possibly large IndexedDB (ink tiles, offline packages), the unsent outbox stays where the R1-a app left it (pushed
  once, under user #1's session), and a rollback to R1-a finds its database unchanged. The claim is recorded twice (the
  database's `kv.owner_user_id`, the device's `medlevo.legacyClaim.v1`) and refused to anyone else; another account
  never opens `medlevo`.
* **«User #1» is the first account** (`created_at`, then id): the migrated owner, or the first-run account of a new
  deployment. Both the legacy claim and the old-client exemption use it.
* The 503 of the maintenance server uses the existing `FEATURE_DISABLED` code (no new error code: `academic-step0`
  pins the list).
* A page without an account (sign-in screens) uses the legacy namespace for device-level reads only; the account is
  activated before any account data is read.

### Defects found by the step-3 tests (each failed before its fix)

| defect | fix | test |
|---|---|---|
| (found while building) A read-only SQLite connection on the legacy database left empty `-wal` / `-shm` files behind, which changed the file set that the sha256 reference and the rollback compare | the maintenance credential check and the dry run read on a normal connection | `srv:tenancy/maintenance` «a wrong password, a foreign origin or a missing confirmation start nothing; the data stays byte for byte» |
| (found while building) `claimLegacyLocalData` reused a closed shared Dexie instance after the page switched account | the claim always opens its own connection; `getDb()` re-creates a closed instance | `web:test/tenancy/localdb-per-user` «user #1 claims …» |
| (found by the full web suite) Moving the device pointer write into `activateAccount` stopped a signed-in status from refreshing it, so a failed sign-out could leave the device unable to open offline | a status without `user` refreshes the pointer as R1-a did, keeping the account it names | `web:test/stores.test.ts` «keeps the device signed in …» (existing, unchanged) |
| (found by the full server suite) Public-route registration check in `g8-security` only knew module routes | it also asks Fastify (`hasRoute`) for app-level routes (`/api/maintenance`) | `srv:acceptance/g8-security` |

### Edits outside P1-T1-owned files (smallest seam-compatible changes)

* Writing track (N1) — **only the one-line storage replacements**: `apps/web/src/features/workspace/ink/prefs.ts`
  (`localGet` / `localSet` bodies → `userStorage.get/set`, + import), `ink/tiles/index.ts` (the tiles flag →
  `deviceStorage.get`, + import). Nothing else in `ink/*`.
* Other web call sites moved to the helper (behaviour unchanged for the single owner): `design/{ThemeProvider.tsx,
  themeDisplay.ts}` (device keys), `features/cases/{CaseRunner,CaseEditor}.tsx`, `features/library/useLibrary.ts`,
  `features/workspace/{WorkspaceScreen.tsx, notebook/NotebookScreen.tsx}`, `features/review/selectionDraft.ts`,
  `features/workspace/model/backStack.ts`, `features/workspace/data/noteDrafts.ts`, `features/upload/uploadXhr.ts`
  (headers), `app/{guards.ts, PwaUpdatePrompt.tsx}`; `eslint.config.js` (the storage rule).
* Server: `app.ts` (`GET /api/maintenance` → 303 `/` once the app runs), `modules/auth/{guard,index}.ts`,
  `modules/accounts/index.ts`, `system/{layout,repos}.ts`, `config.ts` (`MEDLEVO_OWNER_MIGRATION`), `.env.example`,
  `package.json` + `apps/server/package.json` (script), `Dockerfile` (the wrapper), shared `api.ts`,
  `academic/accounts-api.ts`.

### Tests changed (ADR-0003 §3.10)

* `test/helpers/app.ts`: `CSRF` also carries `x-medlevo-client` (every existing suite runs as a current client).
* `test/acceptance/g8-security.test.ts`: `GET` / `HEAD /api/maintenance` added to the public list (it answers 303 once
  the app runs); the registration check also accepts app-level routes.
* `test/tenancy/import-boundary.test.ts`: `auth/clientGate.ts` may use `*Internal`; `system/{ownerMigration,maintenance}.ts`
  may open database files by path.

### Not done in step 3 (with reason)

* **`e2e/aos-p1-two-users-one-browser.spec.ts`** — needs a second account in the running server; there is no register
  route until P1-T4 (the web unit tests above cover the same storage rules in jsdom + fake IndexedDB).
* **A real R1-a → R1-b upgrade of an installed PWA** (service-worker update, the claim on a real device), Render, R2 and
  any phone / iPad: **Not run** (no accounts or devices in this container). The legacy data directory is built from the
  current code with R1-a's exact base migration set, not by running the R1-a release.
* Rolling the deploy back to R1-a **before** the data rollback makes R1-a create a new empty `medlevo.sqlite` (R1-a
  does not know the layout): documented loudly in both runbooks; R1-b then refuses that directory and the rollback
  refuses to overwrite (`BOTH_PRESENT`). A tombstone file that would make R1-a refuse to start was not added (it would
  change the step-1 layout detection late in the release). **Superseded by the review: the tombstone was added** («Step 3
  review» below).
* Web UI for quota, export, deletion and devices; sign-out clearing of local account data (kept on purpose,
  offline-first).

## Step 3 review (2026-10-21, adversarial reviewer)

Read every file step 3 changed (system/{ownerMigration,maintenance,layout,testHooks}.ts, cli/migrate-multi-user.ts,
index.ts, config.ts, auth/{clientGate,guard,index}.ts, the Docker wrapper; web lib/{userStorage,localdb,sync,auth,api,
settings,capabilities,deviceId,errorReporter}.ts, app/{guards.ts,PwaUpdatePrompt.tsx}, noteDrafts.ts, the call-site moves,
the two one-line ink edits; the runbooks) and the R1-a client code the gate must not break (`git show d0c8ab4:apps/web/
src/lib/{api,sync,auth}.ts`, `app/guards.ts`). Scope probed: zero loss (every file and every row), a crash at every
journal step, double runs, rollback, the boot guard, the legacy browser-database claim on a shared device, a second
account never seeing user #1's local data, the client-version gate and an old tab's outbox, the Arabic runbook from a
phone. Each finding was reproduced by a test that failed before its fix: server `test/tenancy/owner-migration.review.test.ts`
(11), web `test/tenancy/auth-switch.review.test.ts` (3); the builder's crash list gained `move_vault:tombstone`.

| finding | severity | fix | test |
|---|---|---|---|
| A double tap on «أعد المحاولة» (or «أعد المحاولة» and «تراجع» together) after a stop started TWO runners — or a runner and a rollback — on the same data directory in the same process: the routes checked the phase only before the (slow, scrypt) password check, and `assertNoOtherServer` ignores the server's own pid. Reproduced: three POSTs → `[303, 303, 303]`; a concurrent `resume` ran the whole migration while the first run was paused. («ابدأ» was already caught by its re-plan: the journal exists by then — pinned too.) | major (two writers on the owner's files: a temp system DB removed under the other run, a rollback moving the vault mid-run) | every route re-checks the phase AFTER the password check (nothing can interleave before `run()` sets it); `runOwnerMigration` / `rollbackOwnerMigration` take an in-process single-operation guard (`BUSY`, retryable, never journaled; the page ignores it) | «review 2» (3) |
| A data rollback brought back, in `medlevo.sqlite`, every session revoked under R1-b — a password change after a lost phone, «sign out this device»: the previous release accepted the stolen device's cookie again | major (security) | the rollback revokes, in the vault's `auth_session`, every session that is no longer valid in the system DB (and extends the expiry of those still valid), in the same transaction as the password copy-back | «review 3» |
| «Rollback» in Render BEFORE the data rollback (the natural reaction on a phone when something looks wrong): R1-a found no `medlevo.sqlite`, created an EMPTY database, offered first-run setup over the migrated data and would back that empty database up every night; R1-b then refused the directory and the runbook's way out («move the empty file aside») needs a shell command it never gave — not followable from a phone | major (runbook not followable; risk of a second owner account and of empty nightly backups; the vault itself was never touched) | `move_vault` leaves a text **tombstone** at `medlevo.sqlite` (`layout.ts` `isLegacyTombstone` / `isLegacyDb`): SQLite refuses it («file is not a database»), so R1-a stops at boot and writes nothing (checked with `node:sqlite`: refused, file unchanged); this build treats it as «no single-owner data» (layout, dry run, page credentials, BOTH_PRESENT / NEITHER_PRESENT); a tombstone alone is `orphan_vaults`, never `fresh`; the rollback sets it aside before moving the vault back (crash-safe; new hook points `move_vault:tombstone`, `rollback:tombstone_aside`); runbooks say what the failed deploy looks like and that redeploying the latest commit fixes it | «review 4» (3); builder crash list (+1 point) |
| An empty or torn `migration-journal.json` (a crash between creating the file and the fsync of its first line, `begin`, written before any other action) left the server «blocked» forever — `--resume` / `--rollback` refused (`NO_JOURNAL`), the page offered nothing | minor (no loss; stuck without a shell) | such a journal beside the owner's database, with no system DB, temp file or marker, is «nothing started» (`journalNeverStarted`): the page waits, the dry run can apply, `apply` sets the file aside as `migration-journal.aborted-<time>-empty.json` | «review 5» (2) |
| A boot-time rollback (`MEDLEVO_OWNER_MIGRATION=rollback`) refused after a COMPLETE migration (another account exists) showed «بياناتك ما زالت في مكانها القديم» (false: they are in the vault) and a «أعد المحاولة» form that can only fail (`ALREADY_MIGRATED`) | minor (honesty) | the failed page says the migration is complete, the data is in user #1's vault, and that removing the variable lets the app start; no retry form | «review 6» |
| After «تسجيل الخروج» the page kept its storage account (a sign-out does not reload), so signing in as ANOTHER account in the same page sent user #1's device id with the new account's sign-in | minor (cross-account device link the design forbids) | `deviceFields(username)` sends the device id only when the account signing in is the page's own account (login name normalised like the server); the same account re-signing in keeps naming its device | `web:auth-switch.review` (2) |
| The capability store read its cache once at module load — from the legacy namespace (user #1's) — so another account starting offline on a shared device (or online until the first refresh) was shown user #1's capabilities | minor (honesty of capabilities) | the store re-reads the cache on `onStorageAccountChange`; an answer that arrives after the page switched account is dropped | `web:auth-switch.review` (1) |

Checked and found correct (no change): **zero loss** — on the realistic R1-a fixture, every file of the data directory
before the migration is present afterwards with the same sha256 (the database as `vaults/<id>.sqlite`), still after the
first boot, and every row of every table of the vault after the first boot equals the owner's database (`dumpTables`,
FTS shadow tables included) — «review 1»; the **R1-a client**: it sends `Accept: application/json` on every API call, so
the gate catches its pulls; on 426 / 503 it keeps its outbox pending with backoff (`recordFailure`) and on 401 pauses —
nothing is dropped; its 409 epoch path is not triggered (the vault keeps the epoch); **legacy claim**: only the server's
`owns_legacy_device_data` (first account) leads to `claimLegacyLocalData`; another account never opens `medlevo`, before
or after sign-in (the sync engine starts in `OwnerLayout`, after the gate activated the account; no other IndexedDB
database or runtime cache exists); **two tabs**: the page header `x-medlevo-user` stops a tab from pushing under
another account's session (401, outbox kept); drafts are tagged and read per namespace; the settings store resets on an
account change.

**Cross-release check with the real R1-a release** (session scratchpad `review-p1t1s3/r1a/cross-release.sh`; the R1-a
server and its `packages/shared` taken with `git archive d0c8ab4`, nothing in the repository changed): the real R1-a
server set up an owner and stored a note → this build's CLI `--apply` migrated it (vault sha256 = the reference, verified
backup) → the real R1-a started on the migrated directory refused at boot («MedLevo failed to start: Error: file is not a
database») and the data directory was byte for byte unchanged → `--rollback` → the real R1-a started, the old password
signed in, the note was there and the session cookie from before the migration was still valid. (This also answers part of
the builder's caveat that the fixture is built by the current code: a directory written by the real R1-a release migrates
and rolls back.) The first attempt of this script showed one more gap: its R1-a process was still running while the CLI
migrated — the CLI cannot see an R1-a server (R1-a writes no `server.lock`); the migration saw no write and completed, but
the docs now say to stop R1-a first (on Render the deploy replaces it).

Open after the review (not fixed here, with reason):

* The CLI cannot detect a running **R1-a** server (no lock file in R1-a); a write by it after the move would go to a
  renamed file — documented («stop it first»); on Render it cannot happen (the R1-b deploy replaces the process).
* While the maintenance page is up the R1-a app is told «signed out» (`/api/auth/status`), so it forgets its device
  pointer and shows the sign-in screen; its outbox stays, but opening the app OFFLINE needs one online contact after the
  migration. Emulating R1-a's signed-in status from the maintenance server is more code in the riskiest path; the
  runbook says what the owner sees.
* R1-a's own 401 handler clears the device-level pointer even when it names another account (R1-a code, cannot change).
* The pre-migration copy in R2 follows the normal backup retention (it is pruned like a nightly backup); the verified
  local copy in `DATA_DIR/migration/` stays until deleted.
* The CLI takes no lock of its own: two `--apply` processes started at once on a stopped server are not excluded (the
  in-process guard is per process; on Render the CLI refuses anyway because the server runs).
* `/api/maintenance` and `status.json` are public: they show the phase, the step names and, after a refused start, the
  reasons (disk sizes, migration names) — no account data.
* A whole-instance restore into a new directory has no tombstone (R1-a deployed on it would create an empty database).
* `e2e/aos-p1-two-users-one-browser.spec.ts` still needs a register route (P1-T4); Render, R2, the Docker image, any
  device and a real R1-a PWA updating itself: **Not run**.

## Release R1-b final verification (2026-10-21)

Release checks only (`docs/TEST_LOG.md` «Release R1-b + N1 — final verification»; BUILD_PLAN §1.3 «Release R1-b»).

* **The maintenance page's forms did not work in a real browser — fixed.** The release critic pass drove
  `/api/maintenance` in Chromium (phone and desktop): username, current password, «نعم، ابدأ», «ابدأ الترقية» → «رُفض
  الطلب لأنه صادر من أصل غير مسموح.» (403), every time. The page was served with `Referrer-Policy: no-referrer`; under that
  policy a browser posts a form with `Origin: null` (Fetch, «append a request `Origin` header»), and `guardPost` refuses
  any origin that is not the configured one. Every earlier test posted with a hand-written `Origin` header, so none could
  see it; the owner's main upgrade path (the Arabic guide's «ابدأ الترقية») would have failed, leaving only the
  `MEDLEVO_OWNER_MIGRATION=apply` variable. Now `Referrer-Policy: same-origin` (a same-origin form keeps its Origin; a
  cross-site post still sends `null` and is refused; no referrer leaves for another site). Tests:
  `srv:tenancy/maintenance-form.r1b` (the policy check failed before) and the real-browser critic run (the start form
  answered 403 before, and now starts the migration, the rollback page is reached and shot in light / dark).
* **Two layout defects of the same page on a phone (390 px) — fixed.** The «blocked» page's reason ran off the screen:
  `(MEDLEVO_OWNER_MIGRATION=rollback)` is one unbreakable word wider than a phone → `main { overflow-wrap: anywhere }`;
  the «نعم، ابدأ» checkbox was squeezed to 14 × 24 px beside its two-line label (a shrinking flex item) →
  `flex: none`, 24 × 24 inside the 44 px label. Tests: `srv:tenancy/maintenance-form.r1b` (4 in all; each of these two
  failed before) and the critic re-run (no overflow on any maintenance state; the checkbox 24 × 24).
* **End to end with the real R1-a release** (scratch script, nothing in the repository): a fresh copy of the realistic
  R1-a data directory of `legacy-fixture.ts` → the REAL R1-a server (`git archive d0c8ab4`) boots on it and accepts more
  writes (a note and an ink stroke through its own sync) → snapshot through R1-a's API (13 feed entities: annotations on
  two layers, notes, a study session, exam attempts, a question attempt, the layer; library tree, settings, recordings,
  cards, exam attempts, the lecture's detail; every file of the store) → this build boots into the maintenance page
  (never setup), a wrong password starts nothing, «ابدأ الترقية» with the owner's password → the app answers on the same
  port in under 1 s → as user #1 (platform admin): every feed entity identical, epoch and head unchanged, every read API
  equal (settings gain only the defaults of N1's `ink` part), the recording and the lecture PDF stream the same bytes,
  the store byte for byte, the vault sha256 equal to the database before the first R1-b boot, `medlevo.sqlite` is the
  tombstone, the R1-a iPad session cookie still valid (old app and updated app), the expired session still refused, the
  two devices' queued outbox ops applied once (a re-send is a duplicate) → `MEDLEVO_OWNER_MIGRATION=rollback` → the real
  R1-a boots again: the old password, all 13 entities, the replayed outbox ops and a note written under R1-b are there,
  same files, the iPad still signed in. 38 / 38 checks passed.
* **Old clients and the new shape kinds** (N1 wave-2 review R10) are protected on the server: `POST /api/sync/push` marks
  a request without a supported `x-medlevo-client` (an R1-a app; only user #1 passes the gate) and the annotation handler
  refuses, from such a client, a geometry change of a polygon, curved or double arrow, answering with the server's copy
  (`docs/modules/ink.md`, R10).

## GATE-1 — Phase 1 exit gate (2026-10-22)

Two defects of this module were found by the gate and fixed with tests that failed first (PHASE1_REPORT §4):

* **R1-c on an R1-a data directory (owner migration precheck).** Since release R1-c the build ships base migrations
  0163 / 0860, and `planOwnerMigration` / `runOwnerMigration` compared the legacy database with *this build's* base
  set — so a real R1-a database was reported «أقدم من الإصدار R1-a … ثبّت R1-a وشغّله مرة واحدة أولًا», which is wrong
  and loops. `ownerMigration.ts` now holds the frozen list of R1-a's 44 base migrations (`R1A_BASE_MIGRATIONS`): a
  database missing one of those is still `DB_OLDER_THAN_R1A`; a database that has all of them but not this release's
  later base migrations is refused with `MULTI_USER_RELEASE_FIRST` and the Arabic way that works — deploy the
  multi-user release R1-b first, finish its upgrade, then this release. Nothing changes on disk (ADR-0003 §5 release
  rule: the release that moves the owner adds no base migration). The unit suites had missed it because
  `legacy-fixture.ts` writes its «R1-a» database with the current build. Test: `test/tenancy/owner-migration.gate1.test.ts`;
  end to end against the real `d0c8ab4` / `514f356` builds: PHASE1_REPORT §2.1 (R1-a → R1-b → R1-c 43 / 43 checks,
  R1-a → R1-c refused 8 / 8, R1-b refuses to start on R1-c data).
* **Test template directory leak.** `test/helpers/template.ts` created one `/tmp/medlevo-vault-template-*` per test
  worker and never removed it (≈ 17 GB, `ENOSPC` in the P1-T5 step-3 review). A Vitest global setup
  (`test/global-setup.ts`) now creates one directory per `vitest run`, provides it to the workers and removes it at the
  end; the helper falls back to the old per-process directory only outside Vitest. Test:
  `test/tenancy/template-dir.gate1.test.ts`. The stale directories left by earlier runs were not removed (shared
  `/tmp`; the environment's permission policy refused it).
