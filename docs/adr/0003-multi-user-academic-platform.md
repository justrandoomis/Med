# ADR-0003 — From a single owner to a multi-user academic platform («Vault + Spaces + System»)

- **Status:** Accepted for design, 2026-10-20; **revised the same day after the adversarial design review** (one space
  per subject, a space-route allow-list, a journaled owner migration that seeds devices, mark-and-sweep blob GC, a root
  context for background work, an unmeasured-capacity label). Nothing in this ADR is implemented yet. The *direction*
  (several users, channels, publishing, private by default) is required by the owner's newer specification. The
  *tenancy design* below is the engineering decision for Phase 1. Owner questions use the numbers of PRD §11.
- **Supersedes:** `docs/ARCHITECTURE.md` §0 rule 8 («Single owner …») and the bans of the original spec §02
  (institutions, roles, invitations, public sharing, admin panel), as described in «Contract changes» below.
  Every other rule of ARCHITECTURE §0 stays.
- **Related:** ADR-0001 (stack), ADR-0002 (AI provider), ADR-0004 (collaboration & sync), ADR-0005 (nearby & client
  platform), ADR-0006 (speech recognition), [`docs/academic-os/ARCHITECTURE_DELTA.md`](../academic-os/ARCHITECTURE_DELTA.md)
  (data model, permissions, API, sync v2).

## 1. Context

### 1.1 Two specifications

* **Original spec** ([`docs/spec/MedLevo_AI_Master_Prompt_AR.txt`](../spec/MedLevo_AI_Master_Prompt_AR.txt)). MedLevo
  is built for one owner. §02 forbids universities, colleges, classes, roles, invitations, a content marketplace, public
  sharing and an admin panel. ARCHITECTURE §0 rule 8 repeats this: «Single owner. No organizations, roles, cohorts,
  subscriptions, multi-tenancy, public sharing.»
* **Newer spec** ([`docs/spec/Academic_OS_Master_Prompt_AR.md`](../spec/Academic_OS_Master_Prompt_AR.md), 2026-10-20).
  It adds:
  * academic channels (University → College → Department → Stage → Academic Year → Semester/Course → Subject → Lecture)
    joined by class code, QR or invite link (§2);
  * independent forks, followed copies and collaborative copies, with layers and attribution (§4);
  * profiles, follows, publishing and a lecture marketplace (§5); contextual discussions (§6);
  * rooms (§12), nearby offline classroom sync (§11), administration with five roles (§18);
  * a §21 data model starting with Users, Universities, … and permissions at file, layer, room and channel level,
    with «every file private by default».

  Where the two conflict, the newer spec wins. Its §23 also says: inspect the existing repository first, **preserve
  existing features and data**, and do not rebuild randomly.

### 1.2 What the code assumes today

The tenancy evaluation (read-only audit plus six measured spikes, 2026-10-20) found the single-owner assumption in the
schema, the code and the tests. The main points:

* **Schema.** `owner` allows exactly one row (`CHECK (id = 'owner')`, `0001_core.sql`). `auth_session` has no user
  column. `owner_setting` is one settings set. `change_log.actor` is `owner|system|job`. No personal table has an owner
  or author column (annotations carry only `device_id`).
* **Global uniqueness.** These columns are unique across the whole database: `stored_file.sha256`, `tag.name`,
  `medical_term.term_en`, `concept_alias.alias_norm` and `weakness.key`. `learning_profile` has `CHECK (id = 'owner')`.
* **Global indexes and feeds.** `chunk_fts`, `question_fts` and `owner_content_fts` have no owner or scope column.
  `sync_change` is one pull feed for everything. `processing_job` is one queue. `usage_record` is one AI budget.
* **Lookups by client id only.** The sync handlers find rows by the id the client sends
  (`annotations/sync.ts:230,408`, `learning/store.ts:121`), and `sync_operation`'s primary key is `op_id` alone.
* **Auth and files.** The guard treats any session as full access. `GET /api/files/:id` and `POST /api/files/:id/token`
  check only that the file exists, and file tokens are bound to the file id, not to a user.
* **Leaks across the library.**
  * `findDuplicate()` (`sources/upload.ts:370,514`) returns the title of *any* source with the same bytes.
  * The purge deletes a blob when no row in *this* database references it (`sources/purge.ts:762`).
  * The purge also deletes every annotation and note on purged pages.
  * `exportAll` is `SELECT * FROM <table>`. Backup and restore cover the whole instance, and a restore revokes every
    session.
* **Web client.**
  * There is one IndexedDB database per browser origin (`LOCAL_DB_NAME = 'medlevo'`).
  * Logout keeps local data. The next person on a shared device would push the previous user's outbox under their own
    session.
  * `localStorage` keys (pending settings, capabilities, library sort, device id) are not per user.
* **Tests that actively forbid the new vocabulary.**
  * `apps/server/test/acceptance/g1-ac01.test.ts` applies a regex over routes, tables and capability keys:
    `user|member|role|tenant|organi[sz]ation|universit|faculty|college|subscri|…|invit|admin|team|seat|account`.
  * `e2e/g1-ac01-personal-library.spec.ts` checks Arabic UI words and probes `/admin`, `/invite` and `/api/users`.
  * `apps/server/test/acceptance/g8-security.test.ts` asserts the exact `PUBLIC_ROUTES` list.

The full list, with file and line references, is in the tenancy evaluation (`single_owner_touchpoints`). It is
summarised again in ARCHITECTURE_DELTA §2.

### 1.3 Constraints

* **Preserve.** About 2,030 passing tests (1,260 server + 715 web + 57 shared, `docs/TEST_LOG.md`), 31 shipped
  migrations (never edited), the verified backup and restore (AC-30), the evidence contract (§3.6), Source Lock (§3.7)
  and conflict-preserving sync (§3.4).
* **Synchronous database layer.** `ctx.db.tx(fn)` refuses async callbacks (ARCHITECTURE §3.1). All 1,510 `ctx.db`
  call sites assume one synchronous handle.
* **Operations.** The owner has no computer (spec clarification 1). The server runs as one long-lived process with a
  persistent disk on Render, deployed from GitHub, with off-site backups to Cloudflare R2 (clarification 5).
  Operations must be manageable from a phone.
* **Privacy must not depend on every query being right.** A student's notes must not leak because one of about 1,720
  SQL statements forgot a filter.

## 2. Options considered (measured)

All numbers come from the spikes in
`/tmp/claude-0/-home-user-Med/fdc9726f-76f2-5fe4-bc9a-a6111fd68f1b/scratchpad/spikes/tenancy`. The environment was
Node 22.22 with `node:sqlite` (SQLite 3.50.4, FTS5) on 4 vCPU under load average ≈12, with a synthetic vocabulary.
The FTS figures are therefore worst cases.

| | (a) `owner_id` on every table, one DB | (b) one vault per user + shared DB via ATTACH | (c) PostgreSQL + row-level security | **(d) Vault + Spaces + System (chosen)** |
|---|---|---|---|---|
| **Isolation of private data** | Depends on every statement. A forgotten filter returned **575,998 rows** from 2,000 users (S3). The bm25 score of user u7 moved from −20.59 to −7.64 after another user wrote 5,000 rows, which is a cross-tenant side channel | By construction for the vault. Cross-schema foreign keys and triggers are **refused** by SQLite (S1) | Enforced by the database when configured. The table owner sees all 100,000 rows; app role without `app.user_id` sees 0, with u7 sees 200 (S4). A pooled connection that keeps a stale `app.user_id` leaks | By construction. **0** cross-tenant reads in 200 interleaved Fastify requests; unbound access refused (`NO_TENANT_BOUND`) (S6) |
| **Search cost** | Filtering after `MATCH`: 236–546 ms p50. Owner token inside `MATCH`: 7–26 ms (S3) | Per-user FTS 0.09–0.16 ms. A shared corpus filtered after `MATCH`: 85–321 ms (S1) | `tsvector`/GIN. No built-in Arabic configuration | Vault 0.09–0.16 ms. Space with the scope token inside `MATCH`: **8.1–13.8 ms** vs 85.8–241.9 ms post-filter, identical result sets (S1b) |
| **Migration cost** | Review about 1,720 SQL literals in 139 files. Rebuild tables for UNIQUE/PK/CHECK changes. Change 8 triggers, 3 FTS tables, 8 sync handlers and 273 raw test writes | Medium. The «ATTACH everywhere» variant needs a fragile rewrite of about 500 `source*` statements; TEMP union views fail on every write | Rewrite the synchronous data layer as async (1,496 db call sites, 166 transactions), 93 FTS5/bm25 uses, the `ml_norm` UDF, `VACUUM INTO` backups, the test harness | **Medium and incremental.** Existing modules run unchanged against a vault or a space |
| **Per-user backup / export / delete** | Filtered dumps. Deleting one user took 597 ms for 2 tables; text stays in free pages until VACUUM | File operations | Filtered dumps; AC-30 rebuilt | File operations (today's code with a parameterised path) |
| **Verdict** | Rejected: too many leak vectors in existing code | Its sound core is kept in (d). Rejected as «ATTACH or mirror everything»: mirroring costs ≈ 649 KB per 40-page lecture, ≈ 487 GB for 5,000 students × 150 lectures | Rejected for now. Revisit only for the system DB and spaces if several app nodes are ever needed | **Chosen** |

## 3. Decision

Adopt option (d), «**Vault + Spaces + System**», on SQLite, and replace rule 8 with:

> **8. Private by default.** Each user's data lives in that user's own vault. Content becomes visible to anyone else only
> through an explicit act — publishing a snapshot, joining a channel, sharing with named users, or writing in a shared
> room or collaborative copy. Every shared object records its visibility, and the server checks it. Private data is never
> reachable through a query that merely forgot a filter.

### 3.1 Three kinds of database file

All three kinds share one content-addressed blob store: `DATA_DIR/files/aa/bb/<sha256>`, unchanged. R2 becomes the
object store later (ADR-0005 §B.5, ARCHITECTURE_DELTA §3.5).

1. **System DB** (`DATA_DIR/system.sqlite`, new, small). It is the only file that knows that several users exist. It
   holds:
   * identity: users (credentials moved from `owner`), sessions with `user_id`, devices (with P2P public keys);
   * channels: the channel tree (University … Subject), memberships, class codes and invite links, role assignments,
     ACL grants;
   * social: follows, the publication index with visibility, reactions and ratings;
   * notifications, moderation reports, the security audit and the consent registry;
   * operations: the vault and space registry, a job index, blob reference counts, per-user quotas and the AI budget
     ledger.

   Code reaches it only through repositories that take the **viewer** as a mandatory argument. This is the same pattern
   as today's mandatory `ResolvedScope` in retrieval.
2. **Personal vault**, one per user (`DATA_DIR/vaults/<vault_id>.sqlite`). The schema is today's, built by the
   existing migrations in `apps/server/src/db/migrations/` plus additive vault migrations (ARCHITECTURE_DELTA §3).
   Everything private lives here: library, private uploads, ink, notes, layers, flashcards, review events, attempts,
   plans, chats, recordings, settings and the personal Control Center. Today's `DATA_DIR/medlevo.sqlite` becomes the
   vault of user #1, **byte for byte** (§5).
3. **Space**, **one per subject, from Phase 1.** A single space for the whole deployment was rejected in review: with
   existing modules running «unchanged» against a space and a binding that checks only membership, a member of any
   subject could read every other subject's members-only official content, a Subject Moderator would act as owner of
   every subject (corrections, withdrawals, purges), federated search would return every subject's heads, and
   `concept_alias.alias_norm UNIQUE` (`0800`) would make one Course Brain namespace across subjects and universities.
   With one file per subject those boundaries hold by construction, as they do for vaults; and there is no later «split
   by moving files», which would have had to rewrite `origin_space_id` in every vault stub, `publication.space_id`,
   `acl_grant.resource_db`, `notification.subject_db` and the clients' per-space cursors and epochs. A space uses the
   **same MedLevo schema** for official content: lectures, versions, pages/regions/chunks/FTS, evidence, question bank,
   Course Brain and shared cached Study Books. A moderator's powers apply **only to their subject's space and only
   through the allow-listed routes** of §3.4. Commons tables are added for:
   * official lecture identity;
   * publication snapshots and suggested corrections;
   * discussions and votes;
   * rooms and room sessions;
   * CRDT update logs of collaborative copies (ADR-0004).

### 3.2 Binding requests and jobs to a database

* `ctx.db`, `ctx.files`, `ctx.sync`, `ctx.audit` and `ctx.settings` become proxies bound through `AsyncLocalStorage`.
  There is **no default database**: an unbound access throws `NO_TENANT_BOUND`, including from timers.
* **Background work runs in an explicit empty root context.** Spike S6 tested only a timer created *outside* any
  context. The reverse is the dangerous case and exists today: `jobs/queue.ts` `poke()` calls `setImmediate(tick)` from
  inside `enqueue` (lines 441–442), so the claim loop would inherit the enqueuing request's binding and quietly use that
  user's vault. The worker loop, heartbeat, `poke()` and all timers are started under `AsyncLocalStorage.exit()` (or an
  `AsyncResource` captured at boot), and the worker binds each job's own database explicitly. Test: a job enqueued from
  user A's request and run for user B never touches A's vault.
* An `onRequest` hook resolves session → user → vault. Routes under `/api/spaces/:spaceId/…` bind the space after a
  membership check.
* The job worker binds the database named in the job index before it runs the handler.
* Measured cost: 6.85 → 7.10 µs per statement (S6). The 1,510 existing `ctx.db` call sites and the 22 modules stay as
  they are. `ctx.ai`, `ctx.jobs`, `ctx.capabilities` and `ctx.clock` stay process-wide.
* An LRU pool keeps about 500 vault connections open: ≈ 0.5 GB RSS and 2,500 file descriptors. (The 20,000 descriptor
  limit measured is this sandbox's `ulimit`, not Render's; the pool size is a config value checked at boot against the
  real limit.)
  * A cache hit costs 0.24 ms p50 for a read plus a write transaction.
  * A miss costs ≈ 28 ms p50, including eviction and a WAL checkpoint (S2).
  * A new user's vault costs 8.9 ms when copied from a migrated template file. A fresh run of all migrations took
    428 ms (measured with 30 files; 31 ship today).
* A space is attached to a pooled connection, not per request. ATTACH plus query plus DETACH costs 2.0 ms p50 (S5).

### 3.3 Explicit boundaries, never live cross-database foreign keys

SQLite cannot enforce foreign keys or triggers across files (S1). So data crosses between databases only by **explicit
copy**, in jobs or services with idempotency keys:

* **Publish = snapshot copy, vault → space.** The author's layer items are copied into a frozen layer in the space,
  with attribution and a version number (ADR-0004, ARCHITECTURE_DELTA §6). The author keeps editing the private
  original.
* **Start Studying, follow or fork = stub copy, space → vault.** The copy holds the `source`, `source_version` and a
  page skeleton with the **space's ids**: ≈ 10.2 KB and 0.7 ms per 40-page lecture (S5). Chunks and FTS are **never
  copied**; retrieval reads them in the space. Cited regions and their evidence are pinned into the vault lazily when a
  vault artifact cites them (≈ 61 KB and 13 ms per 60 regions; `foreign_key_check`: 0 violations). Citations, Source
  Lock and the evidence contract therefore keep working inside the vault.
* **Collaborative copies live only in the space** (ADR-0004).
* **Blobs are stored once.** Each database has its own `stored_file` row; that row is the authorization for that
  database. Reference counts in the system DB are a **hint only**: they live in another file than the rows they count,
  there is no shared transaction, and per-file backups and restores make them drift. A blob is deleted only by a
  **mark-and-sweep** over `stored_file` in every vault and space, after two sweeps agree and a quarantine period; a mark
  pass runs after every restore, and restore-verify rebuilds the counts (ARCHITECTURE_DELTA §4.1 `2250_ops`).
  `removeStoredFileIfUnreferenced` (`sources/purge.ts:762`) changes to «delete my row and decrement my hint».

### 3.4 Where shared content is checked

Shared content is checked in three places:

1. **Membership or role on the subject.** Checked when a space is bound to the request: an approved membership or a
   role on the subject node that owns the space (or an ancestor). The role is computed for **that** subject only.
2. **The space-route allow-list.** Existing modules are mounted under `/api/spaces/:s` only through an explicit list of
   routes, each with its minimum access (ARCHITECTURE_DELTA §5.5). Data export and backups (`/export/all`, `/backups*`),
   settings, Control Center storage, AI, evaluation, health and client errors, auth, the library, learning, exams,
   cases and the raw `sources` write and purge routes are **never** mounted in a space; a test enumerates the route table
   and fails on any unlisted space route. Whole-deployment operations are platform-admin routes (ARCHITECTURE_DELTA §5.8).
3. **Fine-grained visibility.** Applies only to rows that are visible to some members and not others: publications,
   discussions in restricted rooms, collaborative copies, shared recordings. It is checked through one policy function,
   `authz.can(viewer, action, resource)` (ARCHITECTURE_DELTA §5). It is enforced in SQL before ranking for search, and
   per row for the sync pull feed.

In the worst case, a bug in a space can widen the audience of content that its author already chose to publish, inside
one subject. It cannot expose a vault or another subject.

### 3.5 Search

Search merges the vault FTS with the FTS of each space the viewer may read. Source Lock version ids and visibility go
as **tokens inside the `MATCH`**. Results are merged with reciprocal-rank fusion (ARCHITECTURE_DELTA §11). Spaces get
a scoped FTS table; the existing vault indexes are unchanged.

### 3.6 Backups, restore and the sync epoch

* **Backups.** Each vault, each space and the system DB is backed up with today's `VACUUM INTO` code and the
  parameterised path. A backup includes the blobs it references, is **encrypted by the application before it leaves the
  host** (today's archives are not encrypted, `docs/BACKUP_RESTORE.md`), and is copied to R2. After any restore a blob
  mark pass runs before the next sweep (§3.3).
* **Restore.**
  * Restoring a vault restores one user. It uses that vault's existing `data_server_epoch`, so only that user's devices
    reset their cursor; other users' sessions are not revoked (today's whole-instance restore revokes every session).
  * Restoring the whole instance remains possible for disaster recovery.
* **Export and delete.**
  * `exportAll` becomes «export my vault», plus the publications the user authored.
  * Account deletion removes the vault file and decrements its blob references. Publications that others forked follow
    the attribution policy (§7, PRD Q14).

### 3.7 Web client

* **One IndexedDB database per user**, named `medlevo:<userId>`, holding the outbox, entities, offline blobs and
  `apiCache`. **Every `localStorage` key is per user** — not only pending settings, capabilities, library sort and the
  device id, but also the crash-recovery note drafts (`noteDrafts.ts`, recovered on every signed-in mount by
  `app/layouts.tsx`), case-editor drafts, the selection draft and the workspace back stack (13 files by grep; inventory
  in ARCHITECTURE_DELTA §4.5). Drafts are recovered only for the user who wrote them.
* **Pre-multi-user clients are refused.** Today's PWA updates only on the user's prompt and sends no version; a stale tab
  could push the owner's single-database outbox under another user's session. Requests carry `x-medlevo-client`, the
  server answers `426 CLIENT_TOO_OLD` to older clients (except the legacy owner's own sessions), and the first
  multi-user sign-in forces the service-worker update.
* On logout, the outbox of the user who logged out is never pushed under another session. The legacy `medlevo`
  database is claimed by user #1 only (§5, step 7).
* An optional «clear this device on sign-out» setting covers shared devices. Today's behaviour of keeping data on the
  device stays the default for a user's own device.

### 3.8 AI cost and quotas

* The single monthly budget (`MEDLEVO_AI_MONTHLY_BUDGET_USD`) becomes:
  * a deployment ceiling;
  * per-user allowances in the system DB;
  * per-session caps for live features (ADR-0006).
* The budget pre-check becomes an **atomic reservation** in the system DB (`BEGIN IMMEDIATE`). This also closes the
  core-server open item that the pre-check «is not atomic across concurrent calls».
* `usage_record` stays in the vault (per user by construction). The system ledger aggregates usage.
* AI cache keys gain the viewer's scope hash, so an artifact built from one user's private notes is never served to
  another user (ARCHITECTURE_DELTA §10).

### 3.9 Contract changes (to apply to `docs/ARCHITECTURE.md` when implementation starts)

| ARCHITECTURE section | today | after this ADR |
|---|---|---|
| §0 rule 8 | single owner | private by default (text above) |
| §0 rules 1–3 | evidence only from sources | unchanged, plus: **student content (published explanations, discussion answers, suggestions, crowd notes) is never evidence.** It can be shown as labelled context, like `my_notes` today (`evidence/scope.ts`, low assurance, explicit only) |
| §1 Database | one SQLite file | SQLite files: system + one vault per user + spaces; the same schema for vaults and spaces |
| §2 module map | 22 modules | new modules and migration ranges in ARCHITECTURE_DELTA §2–§3 |
| §3.1 AppContext | one `db` | ALS-bound `db/files/sync/audit/settings`, plus `ctx.system` (system DB repositories) and `ctx.authz` |
| §3.1 Auth | owner session | the session resolves to a user and a vault; first-run setup creates the platform admin (user #1) |
| §3.2 Files | session = access | the token carries `{db, file_id, user_id, exp}`; `GET /api/files/:id` resolves only in the bound DB; blob deletion by mark-and-sweep only |
| §3.1 Routes | every route under the owner session | vault routes bind the caller's vault; space routes only through the allow-list (§3.4); platform operations platform-admin only |
| §3.4 Sync | one feed | one feed per DB; the space feed is filtered per viewer; rules from ADR-0004 |
| §3.5 AI | one budget | per-user allowance plus atomic reservation |
| §5 Testing | `createTestApp` | `createTestApp` = system DB + one user + one vault bound for every request (existing tests unchanged); `createMultiUserTestApp` for the new suites |

### 3.10 Tests that change

| test | change |
|---|---|
| `g1-ac01.test.ts` (server) and `e2e/g1-ac01-personal-library.spec.ts` | Their purpose («the personal library works without any institution») stays and is kept as **AC-01a: the personal library still works for a user who never joins a channel**. The vocabulary bans are removed. **AC-01b — no cross-user leakage** replaces them (ARCHITECTURE_DELTA §15) |
| `g8-security.test.ts` exact `PUBLIC_ROUTES` | Gains exactly two routes: `POST /api/auth/register`, which requires a valid join token or invite (PRD Q3), and `GET /api/channels/join/preview`, rate-limited, which reveals only a channel title for a valid invite token (PRD Q2, AOS-2.13). «Public» visibility otherwise means **all signed-in users** of the deployment |
| `e2e/smoke.spec.ts` (`nav('الإعدادات')`) | Updated for the five-destination navigation (IA §3.1); ARCHITECTURE_DELTA §15.2 row 23 marks this part superseded |
| All other ~2,030 tests | Run against one bound vault with the test-binding helper (`withTestBinding`, ARCHITECTURE_DELTA §1.1), applied by the harness, because hundreds of tests use `ctx.db` and the job queue outside a request, and `test/helpers/app.ts` reads the `owner` table. Any edit beyond that mechanical binding is listed with its reason in the Phase 1 report; «no test changes» is not claimed |

## 4. Consequences

**Positive**

* Private data is isolated by construction. A missing `WHERE` in a vault cannot cross users.
* Existing modules, tests and the backup/restore machinery keep their meaning.
* Official content reuses the whole processing, evidence, questions and Course Brain stack: «one owner's world» maps
  1:1 onto «one course community's world».
* Per-user backup, export, delete and restore are file operations.
* **Storage** projection for 5,000 students and 1,800 lectures: shared processed content ≈ 1.1 GB once, stubs
  ≈ 1.5 MB per student, about 500 active vaults in memory. **Capacity (concurrent users, rooms, jobs) is not measured.**
  The spikes S1–S6 were database micro-benchmarks; every `node:sqlite` call is synchronous on Node's single event loop,
  so a heavy job in the request process (a publish copy, follower fan-out, a Yjs projection of a 5,000-stroke document,
  a page map, an FTS rebuild, or a 5,000-stroke page GET, which takes 298 ms today) blocks every user's HTTP and
  WebSocket traffic. Heavy jobs therefore run in worker threads or a separate process with their own connections, and
  no capacity figure is stated before the PRD NFR-OP2 load test. Render runs a service with a persistent disk as one
  instance without zero-downtime deploys (Render docs, DOC — not tested).

**Negative / costs**

* New moving parts, each a new single point that needs tests: the system DB, connection pool, job index, blob
  reference counts, per-user IndexedDB, and the copy paths (publish, stub, lazy pinning).
* Cross-vault analytics («how many students struggle with X») need opt-in event export to a space or the system DB,
  with minimum group sizes. They are never SQL over vaults.
* A cache miss costs an open (≈ 28 ms p50 under load).
* Evidence retrieval for an official lecture must read chunks in the space while citations live in the vault. Lazy
  pinning is new code on the most safety-critical path, so it gets its own acceptance tests: AC-05/06/07 rerun with a
  stub lecture.
* One process and one disk mean a single write lock per file. Different users no longer contend (separate files), and
  with one space per subject only the members of one subject share a space's lock.

**Risks and mitigations**

| risk | mitigation |
|---|---|
| A route reads the system DB without the viewer | System repositories have no unscoped methods. A lint rule bans importing `system/db` outside `modules/*/repo.system.ts` |
| A job runs unbound or bound to the wrong DB | The job index stores `db_id`, and the worker binds it before the handler. A test enqueues jobs for two users and asserts each one sees only its own rows |
| The legacy owner data is lost during migration | §5: verified backup first, rename instead of rewrite, a journaled and resumable migration, sha256 and row-count checks before and after the first boot, legacy devices seeded so the queued outbox replays, refuse to boot rather than fall into setup mode |
| Background work inherits a request's vault | §3.2: root context for the worker, `poke()` and timers; test with two users |
| Blob reference counts drift and a used blob is deleted | §3.3: mark-and-sweep with quarantine; mark after every restore; crash test |
| A moderator acts outside their subject | §3.1 and §3.4: one space per subject, role computed per subject, route allow-list |
| One heavy job stalls everyone | §4: worker threads / separate process; load test before capacity claims |
| Shared-device leakage on the web | Per-user IndexedDB, logout guard, e2e test with two users on one browser profile |

## 5. Migration of the existing owner to user #1 (zero loss)

The rule: **the existing database file becomes vault #1 byte for byte. No row is rewritten.** The design review found
three ways the first draft could still lose data: queued writes rejected forever, a rollback promise that stops being
true at the first boot, and a crash window that leaves the server in first-run setup. The procedure below closes them.

**Release rule.** The release that performs this migration contains **no new base migration** (`apps/server/src/db/
migrations/`). Base additions (`0041`, `0050`, `0160`–`0163`, `0271`–`0273`, …) ship either earlier (in the
single-owner build, where they are ordinary additive migrations) or in the next release, after a fresh verified backup.
So the first boot after the move really opens the vault unchanged, and moving the file back is a valid rollback until
the next release. `apps/server/src/db/migrate.ts` (lines 62–68) refuses to start an older build on a database that has
a migration the build does not know, so **after any release that adds base migrations, rollback means restoring the
step-0 backup**, losing the writes made since; the runbook says so in Arabic.

**A journaled, resumable state machine.** The migration writes `DATA_DIR/migration-journal.json` (fsync'd, one step
per line with its result) and can be re-run at any point; each step is idempotent and checks the journal first.

0. **Safety first.**
   * Enter maintenance mode.
   * Run `npm run backup` and `npm run restore:verify` (AC-30 machinery) on a separate copy.
   * Encrypt the archive and copy it and its sha256 to R2.
   * Record the sha256 of `DATA_DIR/medlevo.sqlite` and the per-table row counts (`countableTables` in
     `data/backup.ts`) in the journal.
1. **Freeze.**
   * Run `PRAGMA wal_checkpoint(TRUNCATE)` and close all connections.
   * Run `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.
2. **Create the system DB** as `system.sqlite.tmp` from the new system migrations (`apps/server/src/db/migrations-system/`).
   `0001_core.sql` is never edited.
   * Insert user #1 from the `owner` row verbatim: `username`, `password_hash` (the same scrypt string, so the same
     password works), `recovery_codes_json` (the same unused codes), `password_changed_at`, `created_at`.
   * Mark user #1 `is_platform_admin = 1, legacy_owner = 1`.
   * Insert the vault registry row for vault #1 with status `migrating`.
3. **Register vault #1.**
   * Rename `DATA_DIR/medlevo.sqlite` (and `-wal`/`-shm` once empty) to `DATA_DIR/vaults/<vault_id>.sqlite` on the
     same filesystem.
   * Check that the sha256 of the moved file equals the step-0 reference.
   * Ids, `schema_migration` rows, the `sync_change` sequence, `sync_operation`, `data_server_epoch`, `owner_setting`,
     `usage_record` and `change_log` all stay as they are.
4. **Blobs.**
   * `DATA_DIR/files` stays where it is and becomes the shared store; storage keys are unchanged.
   * Insert one `blob` row per stored file and the `blob_ref` hints for vault #1; a first mark pass records every
     referenced blob, so nothing can be swept.
   * `secret.key` stays server-level. Existing signed links expire as today, and new tokens also carry the database id.
5. **Sessions and devices.**
   * Copy active `auth_session` rows into the system `auth_session` with `user_id = #1`. `token_hash` is unchanged, so
     logged-in devices keep working.
   * **Seed the `device` table for user #1** from every distinct `auth_session.device_id` and every distinct
     `sync_operation.device_id` in the vault, each with a server-issued `device_uid`. Without this, the first push of a
     device's pre-upgrade outbox would be answered `device_unknown`; and since today's registry records handler
     rejections and answers retries with the original result (`sync/registry.ts` lines 104–145), those writes would stay
     rejected forever. (The transient codes are also never recorded any more — ARCHITECTURE_DELTA §8.2 — so a device the
     seed missed only needs to register once.)
   * Drop `login_attempt` history (it is ephemeral).
   * The legacy `owner`, `auth_session` and `login_attempt` tables stay unused in the vault file. A later vault
     migration may drop them after a verified release.
6. **Commit.** Rename `system.sqlite.tmp` to `system.sqlite`, set the vault status `active`, write the marker file
   `DATA_DIR/.multi-user` last.
7. **Sync continuity.**
   * The feed, op log and epoch live inside the vault, so devices continue with the same cursor and epoch.
   * Queued outbox ops replay idempotently against the same `sync_operation` table from seeded devices: no duplicates,
     no losses. **Test:** a legacy IndexedDB outbox queued before the upgrade is replayed after it, and every op is
     applied exactly once.
8. **Web clients.**
   * On the first login after the upgrade, the legacy IndexedDB `medlevo` is claimed by user #1. `kv.owner_user_id` is
     set, and the database is used as (or copied into) `medlevo:<user1Id>`; untagged note drafts are recovered for
     user #1 only.
   * If a *different* user signs in on that device, the legacy database and drafts are never pushed or saved under
     their session; they get a fresh per-user database.
   * Legacy `localStorage` keys are moved to user-scoped keys the same way, and the service worker is updated.
9. **Settings and AI.**
   * `owner_setting` stays in the vault as personal settings.
   * The deployment's monthly budget becomes user #1's allowance and the deployment ceiling.
   * `usage_record` history stays in the vault.
10. **Visibility.** Everything in vault #1 stays private. Nothing is published automatically. Afterwards the owner can
    link existing lectures to official ones or promote them (ARCHITECTURE_DELTA §6.9); both are on the X8 checklist.
11. **Verify.**
    * Boot the new build. The vault opens through the unchanged migration runner, so checksums match.
    * Compare the per-table row counts with step 0, **record the vault checksum and row counts again after the first
      boot**, and run the restore-verify boot check.
    * Log in with the old password; validate one recovery code without consuming it; push and pull from a device.
    * Run the full existing suites (they bind one vault).
12. **Rollback.**
    * Before the release that adds base migrations: stop the server, move the vault file back to
      `DATA_DIR/medlevo.sqlite`, remove the marker, the system DB and the journal; the old build reads it unchanged.
      Writes made under the new build are kept (they are in that same file).
    * After a release that added base migrations: restore the verified backup from step 0 (stated in the runbook).

**Boot guard (never fall into setup mode).** At boot, before anything else:

| what is in `DATA_DIR` | the server |
|---|---|
| `medlevo.sqlite`, no marker, no journal | refuses to serve the app; shows the maintenance page «الترقية لم تكتمل بعد» and offers the migration (CLI or the platform-admin web shell) |
| a journal without the marker | resumes the migration from the last completed step, or refuses to serve if it cannot |
| `vaults/*.sqlite` without a `system.sqlite` registry | refuses to serve; never runs first-run setup |
| marker + system DB | normal start |
| nothing at all | first-run setup (a fresh deployment) |

The crash window of the first draft — a crash after the rename of step 3 and before the system DB commits, which left no
`medlevo.sqlite`, an empty system DB and therefore **setup mode**, letting anyone create a new platform admin over an
unregistered vault — cannot happen: the system DB is committed by rename in step 6, and the guard above refuses to start
while vault files exist without it. **Test:** crash after every journal step; every run resumes to the same end state.

The migration ships as a CLI (`npm run migrate:multi-user -- --dry-run|--apply|--resume`) and as a one-time boot step
guarded by the marker and the journal. Both can be triggered from Render's web shell or a deploy hook, so the owner never
needs a computer. The dry run prints the checks above without changing anything.

## 6. Rejected alternatives (short)

* **(a) `owner_id` everywhere.** Leak vectors already exist in today's code (sync handlers, upload de-duplication,
  global FTS with a bm25 side channel). It also needs a review of about 1,720 statements and table rebuilds.
* **(b) ATTACH or union views everywhere.** Cross-schema foreign keys and triggers fail, and union views cannot be
  written to. Mirroring each lecture into every vault costs ≈ 487 GB at the target scale.
* **(c) PostgreSQL with RLS.** It needs a rewrite of the synchronous data layer, FTS (no Arabic configuration) and the
  verified backup/restore, and its isolation still depends on role configuration. Revisit only for the system DB and
  spaces if several app nodes are ever needed.
* **One space for the whole deployment in Phase 1.** Rejected in review (§3.1): no isolation between subjects or
  universities, moderators acting everywhere, one Course Brain namespace, and a later split that rewrites ids in every
  vault.
* **Keep single-owner and add «sharing» as export/import files.** This does not meet spec §2/§4/§5/§6/§12
  (followed copies, discussions, rooms) and is rejected.

## 7. Open questions (owner) — numbered as in PRD §11, same defaults

1. **What does «Public» mean?** (PRD Q2) Default: all signed-in users of this deployment. There are no anonymous web
   pages, so `PUBLIC_ROUTES` gains only registration and the join-link preview.
2. **Who can create an account?** (Q3) Default: only with a valid class code, invite link or an account created by an
   admin. There is no open sign-up.
3. **Space granularity.** (Q36) Decided by the design review: one space per subject from Phase 1.
4. **Who creates universities and channels?** (Q4) Default: the platform admin (user #1), who can delegate an Admin role
   per channel subtree.
5. **Rights of official files.** (Q5) Default: members-only. Official lecture files are never public, even when an
   explanation layered on them is public; quotes and source crops from them are withheld from non-members.
6. **Account deletion and forks.** (Q14) Default: the user's vault and private data are deleted. Their publications are
   withdrawn from listings. Author names are rendered at read time from the system account, so they show «طالب سابق»
   everywhere at once without writing into anyone's vault. Forks that others already made are **not** erased — no one,
   moderators included, can modify another user's personal layer (PRD K6) — and the deletion preview says so plainly.
   «Full removal» therefore means withdrawal plus name removal.
7. **Shared device policy.** (Q26) Default: keep local data on sign-out (as today), plus an explicit «امسح بيانات هذا
   الجهاز عند الخروج» (clear this device's data on sign-out) option. Devices registered as shared always clear.
