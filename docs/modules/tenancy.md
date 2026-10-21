# Module notes — tenancy core (Academic OS, track P1-T1)

Track **P1-T1 — Tenancy core, identity and owner migration** (`docs/academic-os/BUILD_PLAN.md` §3.3). Design:
`docs/adr/0003-multi-user-academic-platform.md`, `docs/academic-os/ARCHITECTURE_DELTA.md` §1, §3, §4.5, §7.1, §8.
This note grows with each step; today only **step 0** has landed.

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
