# Academic OS — Architecture delta over MedLevo

> **What this is.** This document is the engineering delta that turns MedLevo (single owner, ARCHITECTURE.md) into the
> multi-user Academic OS of [`docs/spec/Academic_OS_Master_Prompt_AR.md`](../spec/Academic_OS_Master_Prompt_AR.md),
> following ADR-0003 … ADR-0006.
>
> **Status:** design, 2026-10-20. Nothing in this document is implemented. Every number quoted comes from the spikes
> named in the ADRs.
>
> **Binding rules.** [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) stays the binding contract. This delta lists exactly
> what changes in it and what is added. Where the two disagree on a *mechanism*, implementation follows this delta, and
> ARCHITECTURE.md is edited in the same PR that lands the change, as ADR-0003 §3.9 lists. **Scope and timing are not
> mechanisms:** what is built in which phase, its priority and its exit criteria follow [`PRD.md`](PRD.md) §5 and §7, and
> the build order follows [`BUILD_PLAN.md`](BUILD_PLAN.md). Owner questions use the PRD §11 numbers.
>
> **Revision.** v2 after the adversarial design review of 2026-10-20. Every finding, what changed and where, and the two
> partial acceptances are in the [Review log](#review-log) at the end of this document.
>
> **Conventions kept unchanged:** AppContext and module plugins (§3.1), «a module writes only its own tables»,
> migrations in number ranges that are never edited after shipping, zod contracts in `packages/shared`, `AppError` with
> Arabic messages, the evidence contract (§3.6), Source Lock and cache keys (§3.7), normalised unrotated page
> coordinates (§3.8), local-first web writes (§4), and the testing rules (§5).

## Contents

0. [Reading guide](#0-reading-guide)
1. [Topology and request binding](#1-topology-and-request-binding)
2. [The 17 modules of spec §21 mapped onto MedLevo](#2-the-17-modules-of-spec-21-mapped-onto-medlevo)
3. [Databases and migration ranges](#3-databases-and-migration-ranges)
4. [Data model (all §21 entities)](#4-data-model-all-21-entities)
5. [Permission model](#5-permission-model)
6. [Fork graph, layers, versions and anchors](#6-fork-graph-layers-versions-and-anchors)
7. [API contracts](#7-api-contracts)
8. [Sync protocol v2](#8-sync-protocol-v2)
9. [Timeline model](#9-timeline-model)
10. [AI orchestration additions](#10-ai-orchestration-additions)
11. [Search and vector indexing](#11-search-and-vector-indexing)
12. [Notifications](#12-notifications)
13. [Moderation and audit](#13-moderation-and-audit)
14. [Quotas, limits and cost controls](#14-quotas-limits-and-cost-controls)
15. [Existing features preserved — checklist](#15-existing-features-preserved--checklist)
16. [Delivery order and tests](#16-delivery-order-and-tests)
17. [Open questions (owner) with assumed defaults](#17-open-questions-owner-with-assumed-defaults)
18. [Review log](#18-review-log)

## 0. Reading guide

| term | meaning |
|---|---|
| **system DB** | `DATA_DIR/system.sqlite`. Identity, channels, memberships, roles, ACLs, the social graph, the publication index, notifications, moderation, consent, quotas, blob reference counts and the job index (ADR-0003 §3.1) |
| **vault** | `DATA_DIR/vaults/<vault_id>.sqlite`. One per user, today's schema plus additive base migrations. Everything private |
| **space** | `DATA_DIR/spaces/<space_id>.sqlite`. **One per subject**, from Phase 1 (ADR-0003 §3.1). Same base schema plus space commons migrations. The subject's official content and shared community content. Moderators' powers, the Course Brain namespace and bm25 statistics stop at the file |
| **stub** | a vault copy of an official lecture's `source`, `source_version` and page skeleton, under the space's ids. Chunks and FTS stay in the space |
| **viewer** | the authenticated user making the request: `{ userId, deviceId, isPlatformAdmin }`, plus memberships and roles loaded lazily |
| **platform operation** | anything that acts on the whole deployment rather than on one user's data (AI provider, global budget, evaluation runs, health, client errors, the global processing queue, whole-instance backup/restore/export). Platform admin only (§5.8) |
| **base schema** | `apps/server/src/db/migrations/*` (today's directory), applied to every vault **and** every space |
| ⚠ BREAK | an existing behaviour that would leak or lose data if reused naively. Each one names its fix |

## 1. Topology and request binding

```
                     ┌──────────────────────── one Node process (Render, persistent disk) ────────────────────────┐
 browser / app ──►   │  Fastify ─ guard (session → viewer) ─ binding hook ─ module routes                         │
  cookie + CSRF      │                                     │                                                      │
                     │        ┌────────────────────────────┼────────────────────────────┐                         │
                     │        ▼                            ▼                            ▼                         │
                     │   system.sqlite            vaults/<id>.sqlite (LRU pool ≈500)   spaces/<id>.sqlite         │
                     │   (viewer-scoped repos)    today's schema + base additions       base + commons            │
                     │        └──────────── blob_ref ──────► files/aa/bb/<sha256> (CAS; R2 later) ◄──────┘        │
                     │   job worker: system job_index → bind DB → handler (checkpoints in that DB)                │
                     │   heavy jobs (copies, fan-out, projection, page maps, FTS rebuilds): worker threads with    │
                     │   their own connections, never on the request event loop                                  │
                     └────────────────────────────────────────────────────────────────────────────────────────────┘
        ASR worker (separate Render background worker, Phase 3b): reads audio from R2, writes results through the job API
```

**Capacity is not measured.** Every `node:sqlite` call is synchronous on Node's single event loop, so any heavy job run
in the request process blocks every user's HTTP and WebSocket traffic, live rooms and the copilot included. Heavy jobs
therefore run in worker threads (or the separate ASR worker), each with its own database connections, and no capacity
figure is stated before the NFR-OP2 load test (PRD §6). Render runs a service that has a persistent disk as **one
instance**, without zero-downtime deploys, and that disk is reachable by that instance only (Render docs, DOC — not
tested); a second service therefore reads blobs from R2, never from the disk.

### 1.1 AppContext delta (`apps/server/src/context.ts`)

```ts
export interface AppContext {
  // unchanged, process-wide
  config: AppConfig; clock: Clock; log: FastifyBaseLogger;
  ai: AiOrchestrator;                 // + per-user allowance through ctx.quota (§14)
  jobs: JobQueue;                     // one worker; claims from the system job_index, then binds the job's DB
  capabilities: CapabilityRegistry;   // + per-viewer view (consent, quota, device probes)

  // CHANGED: AsyncLocalStorage-bound proxies. Unbound access throws NO_TENANT_BOUND (also from timers).
  db: Db; files: FileStore; sync: SyncRegistry; audit: AuditLog; settings: SettingsService;

  // NEW
  speech: SpeechOrchestrator;         // ADR-0006
  system: SystemRepos;                // repositories whose every method takes `viewer` (or is an internal job API)
  authz: Authz;                       // §5.5
  quota: QuotaService;                // §14 (atomic reservations in the system DB)
  binding: {
    current(): Binding | null;
    run<T>(b: Binding, fn: () => T): T;                     // used by the onRequest hook and the job worker
  };
  /** explicit second handle for the copy services only (allow-listed modules, lint-enforced) */
  dbs: { vault(vaultId: string): Db; space(spaceId: string): Db };
}

export type Binding =
  | { kind: 'vault'; vaultId: string; viewer: Viewer }
  | { kind: 'space'; spaceId: string; subjectNodeId: string; viewer: Viewer;
      // computed from membership / role on THIS subject node (or an ancestor) — never from another subject
      access: 'member' | 'moderator' | 'guest_publication'; route: SpaceRouteGrant }
  | { kind: 'root' };   // the job worker loop, heartbeats and timers: no database at all

/** One entry of the space-route allow-list (§5.5): a route may be mounted under /api/spaces/:s only if listed. */
export interface SpaceRouteGrant { module: string; method: string; path: string; minAccess: 'member' | 'moderator' | 'guest_publication' }

export interface Viewer { userId: string; deviceId: string | null; isPlatformAdmin: boolean }
```

**Rules**

* `ctx.dbs` (a second database in the same request) may be used only by `forks` (publish, stub, fork and follow
  copies), `channels` (course-follow fan-out), `social` (feed assembly from the system DB), `search` (federation),
  `evidence` (reading space chunks for a stub lecture), `studybook` (reading or storing a shared official-only
  artifact in the space, §10.6) and `data` (per-user export).
* An ESLint rule with an allow-list enforces this. Every cross-database write uses a job with an idempotency key,
  because there is no transaction across files.
* **Space binding is per subject.** `/api/spaces/:spaceId/…` binds only when the viewer has an approved membership or a
  role on the subject node whose `space_id` is that space (or an ancestor of it), and only for a route on the allow-list
  of §5.5 with at least that route's `minAccess`. A Subject Moderator of subject A is a plain non-member in subject B.
* `guest_publication` binding: a signed-in non-member opening a **public** publication. Only publication read routes
  accept it, items are redacted for them (§5.2), and `authz` refuses everything else in that space (§5.3).
* **No inherited binding in background work.** The job worker loop, its heartbeat, `poke()` and every timer run inside
  an explicit empty root context (`AsyncLocalStorage.exit()` around the loop, or an `AsyncResource` created at boot).
  Today `jobs/queue.ts` `poke()` calls `setImmediate(tick)` from inside `enqueue`, so without this the claim loop would
  inherit the binding of whichever request enqueued the job and silently use that user's vault. The worker binds each
  job's own database explicitly before its handler runs (`binding.run`). Test: a job enqueued from user A's request and
  run for user B never touches A's vault, and an unbound access from the loop throws `NO_TENANT_BOUND`.
* Tests: `createTestApp()` = system DB + one user + one vault. Requests are bound by the hook; **direct database access
  from test code** (today: hundreds of `ctx.db.get|all|run|exec|tx` calls in 73 server test files, plus `jobs.drain()`
  and `jobs.enqueue` calls outside any request) goes through an explicit helper, `withTestBinding(app, fn)`, which the
  test harness applies around each test body by default. `test/helpers/app.ts` checks `SELECT … FROM owner` (line 105);
  that check moves to the system DB. The claim is therefore not «no test changes» but «only mechanical binding
  changes»: the Phase 1 report lists every test file edited beyond the harness, with its reason.
  `createMultiUserTestApp({ users, spaces })` serves the new suites.

## 2. The 17 modules of spec §21 mapped onto MedLevo

Legend: **extend** = an existing server module or web feature gains code, tables or routes; **new** = a new folder
under `apps/server/src/modules/` or `apps/web/src/features/`.

| # | §21 module | server | web | database |
|---|---|---|---|---|
| 1 | Document Rendering & Ink Engine | **extend** `annotations` (ink v2 packed points codec, layer checks) | **extend** `features/workspace` (reader, `ink/`: tile cache, layer visibility predicate, e-ink mode); **new** `apps/native/` Capacitor shell with ink plugins (ADR-0005 Part B) | vault, space |
| 2 | Annotation Layers & Anchoring | **extend** `annotations` (`annotation_layer`, `layer_id`, `annotation_revision`, re-anchor-to-version job, manual move UI API) | **extend** `features/workspace/ink` (layers panel, active layer, «ملاحظات على إصدار سابق» on earlier versions) | vault, space |
| 3 | Document Versioning & Fork Graph | **extend** `sources` (lecture number and date, stub columns, `page_fingerprint`, `version_page_map`); **new** `forks` (document copies, stubs, publish/fork/follow copy jobs, upstream preview and apply, layer copy and merge) | **new** `features/copies` (Start Studying chooser, update preview, compare two copies) | vault, space, system |
| 4 | Academic Content Management | **new** `channels` (system: tree, membership, class codes, invite links, invitations, roles, course follow); **new** `lectures` (space: official lectures, approval, publish version, page maps; reuses `sources` upload and `processing` inside the space) | **new** `features/channels` (directory, subject page, join flows, QR), **new** `features/admin` (channel administration), **new** `features/lectures` (lecture page with «الرسمي» and «الشروحات», publication page) | system, space |
| 5 | Community & Social Graph | **new** `social` (follows, reactions, ratings, ranking job, feed, profiles; the publication index `2150` is written by `forks` from Phase 1 and read here); **new** `discussions` (space: anchored threads, posts, votes, accepted answers, suggestions) | **new** `features/profile`, `features/feed`, `features/discussions`; marketplace list inside `features/channels` | system, space |
| 6 | Realtime Collaboration | **new** `collab` (`crdt_update` entity, compaction and projection jobs, WebSocket gateway `/live`); **new** `rooms` (space: rooms, sessions, participants, events, exam rooms) | **new** `lib/collab/` (Yjs worker), `features/rooms` | space |
| 7 | Offline Local Database | — | **extend** `lib/localdb.ts` (per-user database name, appended `LOCAL_SCHEMA` versions), `lib/offline.ts` (resumable downloads) | device |
| 8 | Nearby P2P Connectivity | **new** `nearby` (device keys, pairing tickets, relay bundle intake and verification) | **new** `lib/nearby/` (WebRTC, QR encode/decode, bundles, version vectors) | system, space |
| 9 | Sync & Conflict Resolution | **extend** `sync` (actor from the session, per-DB feeds, `visibility_key`, new entity types, replayed `op_id` guard) | **extend** `lib/sync.ts` (one outbox per user and per target DB, space feeds) | all |
| 10 | Audio Recording & Streaming ASR | **extend** `media` (speech orchestrator and providers, transcription runs, vocabulary, VAD intervals, consent and share scope) | **extend** `features/workspace/audio`, `features/media` (live captions, skip silence, speed) | vault, space |
| 11 | Transcript–PDF–Ink Timeline | **new** `timeline` (`timeline_event` entity, merged read model) | **new** `features/timeline` (replay player, time machine view) | vault, space |
| 12 | AI Orchestration & Retrieval | **extend** `ai` (new tasks, per-user allowance), `evidence` (viewer scope, stub retrieval, ASR evidence), `studybook` (course-wide tutor, generated cards); **new** `copilot` (Exam Radar, live copilot sessions) | **new** `features/copilot` (calm side panel, radar dashboard) | vault (+ space reads) |
| 13 | Search, OCR & Vector Indexing | **extend** `search` (federation, scoped FTS in spaces, community FTS, image query, embeddings when configured), `processing` (page fingerprints) | **extend** `features/search` (image, slide-photo and voice query; origin and database labels) | all |
| 14 | Flashcards & Learning Analytics | **extend** `learning` (study time, goals, smart collections, copy-on-use community cards) | **extend** `features/review`, `home`, `planner`, `weakness` | vault |
| 15 | Notifications & Permissions | **new** `notifications`; **new** `authz` (policy library, no routes; roles and ACL routes live in `channels`) | **new** `features/notifications` | system |
| 16 | File Conversion & Background Processing | **extend** `processing` (DOCX → display PDF, fingerprints), `jobs` (job index and binding), `files` (chunked resumable uploads, blob refcount, R2 adapter later) | **extend** `features/upload` (batch with resume, subject and number suggestions) | all |
| 17 | Security, Moderation & Audit | **extend** `auth` (multi-user, registration, devices), `audit` (`actor_user_id`); **new** `accounts` (profile, export and delete my data, quota view), **new** `moderation` | **extend** `features/auth`, `features/settings`; moderation queue and scoped audit in `features/admin` | system, per DB |

### 2.1 New server modules (registered in `apps/server/src/modules/index.ts`)

| module | prefix | binding | owns (DB) |
|---|---|---|---|
| `accounts` | `/api/accounts` | system (+ own vault for export and delete) | `user_profile`, `device` (system) |
| `channels` | `/api/channels` | system | `channel_node`, `channel_closure`, `channel_membership`, `join_code`, `channel_invitation`, `course_follow`, `role_assignment`, `acl_grant`, `space`, `vault` (system) |
| `lectures` | `/api/spaces/:spaceId/lectures`, `/api/spaces/:spaceId/subject` | space | `official_lecture`, `official_version_publish`, `subject_attachment`, `subject_exam_date`, `subject_event` (space) |
| `forks` | `/api/copies`, `/api/spaces/:spaceId/publications` | vault / space | `document_copy`, `attribution`, `pinned_region` (base); `publication_version`, `publication_item`, `suggestion` (space); `lecture_copy` (system, written only by the copy and stub services) |
| `social` | `/api/social` | system | `follow`, `publication`, `publication_series`, `publication_copy`, `reaction`, `rating` (system) |
| `discussions` | `/api/spaces/:spaceId/discussions` | space | `discussion_thread`, `discussion_post`, `discussion_vote`, `community_fts` (space) |
| `collab` | `/api/spaces/:spaceId/collab`, WebSocket `/api/spaces/:spaceId/live` | space | `collab_doc`, `crdt_update` (space) |
| `rooms` | `/api/spaces/:spaceId/rooms` | space | `study_room`, `room_session`, `room_participant`, `room_event`, `relay_receipt` (space) |
| `nearby` | `/api/nearby` | system + target DB | (uses `device`, `relay_receipt`) |
| `timeline` | `/api/timeline` (vault), `/api/spaces/:spaceId/timeline` | vault / space | `timeline_event` (base) |
| `copilot` | `/api/copilot` (vault), WebSocket `/api/copilot/live` | vault | `exam_highlight`, `copilot_session` (base) |
| `notifications` | `/api/notifications` | system | `notification`, `notification_pref`, `push_subscription` (system) |
| `moderation` | `/api/moderation` | system (+ the target's space) | `moderation_report`, `moderation_action` (system). Phase 1: reports → hide / restore / dismiss; Phase 2: approval queue, request changes, «راجعه مشرف المادة», appeals |
| `platform` | `/api/platform` | system (+ whole-instance files) | no new tables: mounts today's whole-deployment operations (AI provider and models, budget, evaluation, health, client errors, global processing, backups, restore, `/export/all`) behind `isPlatformAdmin` (§5.8) |
| `authz` | — (library + module for capability wiring) | — | — |

**Space-bound routes.** All routes under `/api/spaces/:spaceId/…` pass through the binding hook (membership check,
then space binding) before the module handler runs.

**Shared contracts.** New contract files go in `packages/shared/src/academic/`:
`accounts-api.ts`, `channels-api.ts`, `lectures-api.ts` (official lectures, attachments, exam dates, updates feed),
`copies-api.ts`, `layers.ts`, `publications-api.ts`, `platform-api.ts`,
`social-api.ts`, `discussions-api.ts`, `rooms-api.ts`, `collab.ts`, `timeline-api.ts`, `copilot-api.ts`,
`notifications-api.ts`, `moderation-api.ts`, `nearby.ts`, `visibility.ts`, `ink-codec.ts`. They are re-exported from
`index.ts`. Existing files are only appended to: `features.ts` keys, `errors.ts` codes, `annotations.ts` (`layer_id`,
`InkData v2`) and `media-api.ts`.

**New dependencies, added only in the phase that needs them:**

* `yjs` (server + web, Phase 4);
* `@fastify/websocket` (server, Phase 2 notifications and live, or Phase 4 at the latest);
* a QR encoder and decoder (web, Phase 1 for class codes);
* `@capacitor/*` (native shell, Part B).

## 3. Databases and migration ranges

### 3.1 Three migration sets

| set | directory | applied to | number band |
|---|---|---|---|
| base | `apps/server/src/db/migrations/` (existing) | every vault **and** every space | the existing module ranges (ARCHITECTURE §2) plus the new ranges below |
| system | `apps/server/src/db/migrations-system/` (new) | `system.sqlite` | **2000–2999** |
| space commons | `apps/server/src/db/migrations-space/` (new) | every space, after the base set | **3000–3999** |

**Runner changes.** `migrate(db, { sets: ['base'] | ['base','space'] | ['system'] })`. The existing checksum, «edited
migration» and «unknown migration» checks apply per set, recorded in each file's own `schema_migration` table. Because
the bands are disjoint, a file name never means two different migrations.

**Opening a vault.** Opening a vault runs pending base migrations. The «already migrated?» check costs 0.03 ms (S5).
A new vault is a copy of a migrated template (8.9 ms).

### 3.2 Number assignment — no collision with existing files or reserved numbers

The tables below avoid every number already shipped (`0001` … `0801`) and every number reserved by the clean-room
parity plan (`docs/research/NOTE_APP_FEATURE_PARITY.md` §B.3): annotations 0280–0299 (N1–N4), library 0110–0119,
search 0350–0359, learning 0610–0619, auth 0010–0014, media 0670–0679, data 0760–0769, connector 0850–0859.

**Re-check before each migration lands.** On 2026-10-20 the Round 7 work in progress adds `0280_annotation_image_release`,
`0290_reanchor` (manual re-anchoring: `annotation.detached_at`, `note.previous_anchor_json`, `note.detached_at`),
`0670_visual_source_registry` and `0810_brain_algorithms_statements` (untracked in the working tree). None collides with
the numbers below, but `0280`, `0290` and `0670` sit inside ranges the parity plan reserved for N1, N3 and N5, so those
tracks must pick the next free number. Every track lists `ls apps/server/src/db/migrations` in its first commit and takes the next free
number in its own range (BUILD_PLAN §2).

**Base set (vault + space):**

| file | module (range) | content | notes |
|---|---|---|---|
| `0041_sync_actor_visibility.sql` | sync (0040–0049) | `sync_operation.actor_user_id`, `sync_change.visibility_key` + index | — |
| `0050_change_log_actor.sql` | audit (**new range 0050–0059**) | `change_log.actor_user_id`, `actor_role` | ARCHITECTURE §2 gains the audit range |
| `0160_lecture_identity.sql` | sources (0150–0199) | `source.lecture_no`, `lecture_no_origin`, `held_on`, `origin_space_id`, `origin_lecture_id`, `is_stub` | — |
| `0161_page_map.sql` | sources | `page_fingerprint`, `version_page_map` | — |
| `0162_region_text_origin_ext.sql` | sources | `source_region.text_origin_ext` (`'asr'`) | additive: a rebuild of `source_region` is unsafe (ADR-0006 §2.9) |
| `0163_pinned_region.sql` | sources | `pinned_region` (lazily pinned space regions with their content hash, §6.7) | vault side of lazy pinning |
| `0271_annotation_layers.sql` | annotations (0250–0279) | `annotation_layer`; `layer_id`, `author_user_id`, `migrated_from_id`, `origin` on `annotation` and `note` | **coordination:** the parity plan's N4 G23 «owner layers» uses this table. N4 keeps 0295–0299 for tape only |
| `0272_annotation_revision.sql` | annotations | `annotation_revision` (history / time machine) | — |
| `0273_annotation_audio_index.sql` | annotations | expression index on `data_json.$.audio_link.recording_id` | — |
| `0361_embedding_meta.sql` | search (0360–0369) | `embedding_index` metadata | — |
| `0620_study_time_goals.sql` | learning (0620–0629) | `study_time_event`, `study_goal` | — |
| `0621_smart_collections.sql` | learning | `smart_collection` | — |
| `0680_asr.sql` | media (0680–0689) | `transcription_run`, `asr_vocabulary`, `audio_interval`, `transcript_segment` columns | — |
| `0681_recording_share.sql` | media | `audio_recording.author_user_id`, `share_scope`, `consent_json` | — |
| `0860_document_copy.sql` | forks (**new range 0860–0869**) | `document_copy` | — |
| `0861_attribution.sql` | forks | `attribution` | — |
| `0870_timeline_event.sql` | timeline (**new range 0870–0879**) | `timeline_event` | — |
| `0880_exam_highlight.sql` | copilot (**new range 0880–0889**) | `exam_highlight` | — |
| `0881_copilot_session.sql` | copilot | `copilot_session` | — |

New base ranges for later work: `files` 0060–0069, `accounts` 0890–0899 (vault side, if ever needed).

**System set:**

| file | module | content |
|---|---|---|
| `2000_identity.sql` | auth / accounts | `user_account`, `user_profile`, `auth_session`, `login_attempt` |
| `2010_devices.sql` | accounts | `device` |
| `2040_registry.sql` | accounts / system (P1-T1) | `space`, `vault` (the registry the owner migration writes, R1-b) |
| `2050_directory.sql` | channels (P1-T4) | `channel_node`, `channel_closure`, `join_code`, `channel_membership`, `channel_invitation`, `course_follow` |
| `2060_lecture_copy.sql` | forks | `lecture_copy` (who holds a stub or personal items of an official lecture; jobs only, §6.3) |
| `2100_permissions.sql` | channels / authz | `role_assignment`, `acl_grant` |
| `2150_publications.sql` | forks (P1-T5) | `publication_series`, `publication`, `publication_copy` |
| `2160_social.sql` | social (P2-T1) | `follow`, `reaction`, `rating` |
| `2200_notifications.sql` | notifications | `notification`, `notification_pref`, `push_subscription` |
| `2250_ops.sql` | files / jobs / ai | `blob`, `blob_ref`, `blob_mark`, `job_index`, `upload_session`, `user_quota`, `space_quota`, `ai_budget_ledger` |
| `2300_security.sql` | audit (P1-T1) | `security_audit`, `consent_record` |
| `2310_moderation.sql` | moderation (P1-T4) | `moderation_report`, `moderation_action` |

Bands for later work: identity and registry 2000–2049, channels 2050–2149, publications and social 2150–2199,
notifications 2200–2249, ops 2250–2299, security and moderation 2300–2349. Files are split by the track that owns them
(BUILD_PLAN Appendix B), so two tracks of one wave never edit one migration, and the owner-migration release (R1-b)
carries only `2000`, `2010`, `2040`, `2250`, `2300`. A table is created in the same file as, or a later file than, every
table its foreign keys name: SQLite refuses an insert into a child whose parent table does not exist, even with a NULL
key, which is why `publication_series` stays beside `publication`.

**Space commons set:**

| file | module | content |
|---|---|---|
| `3000_official_lectures.sql` | lectures (3000–3049) | `official_lecture`, `official_version_publish` |
| `3010_subject_content.sql` | lectures | `subject_attachment`, `subject_exam_date`, `subject_event` |
| `3050_publications.sql` | forks (3050–3099) | `publication_version`, `publication_item` (delta-stored items with stable ids), `suggestion` |
| `3100_discussions.sql` | discussions (3100–3149) | `discussion_thread`, `discussion_post`, `discussion_vote`, `community_fts` |
| `3150_collab.sql` | collab (3150–3199) | `collab_doc`, `crdt_update` (with validation state), `collab_client` |
| `3200_rooms.sql` | rooms (3200–3249) | `study_room`, `room_session`, `room_participant`, `room_event`, `relay_receipt` |
| `3300_scoped_fts.sql` | search (3300–3349) | `chunk_scope_fts` (contentless, version and source tokens) + triggers |

## 4. Data model (all §21 entities)

### 4.0 Entity map

Columns: «where» = system / vault / space. «status» = **exists** (shipped table, unchanged), **extend** (shipped table
plus additive columns), **new**.

| §21 entity | table(s) | where | status | notes |
|---|---|---|---|---|
| Users | `user_account`, `user_profile` | system | new | user #1 = the migrated owner (ADR-0003 §5) |
| Universities | `channel_node` kind `university` | system | new | one typed tree; level rules in §4.1 |
| AcademicYears | `channel_node` kind `academic_year` (`starts_on`, `ends_on`) | system | new | |
| Stages | `channel_node` kind `stage` (`ordinal`) | system | new | |
| Courses | `channel_node` kind `course` (the Semester/Course level, with term dates) | system | new | a user's personal `library_node` kind `course` stays in the vault, untouched |
| Subjects | `channel_node` kind `subject` (+ `space_id`, one space per subject) | system | new | where official content and communities live |
| Subject attachments (spec §2: summaries, past-year questions, references) | `subject_attachment` | space | new | AOS-2.5; typed, versioned, with visibility and rights |
| Exam dates (moderator-published) | `subject_exam_date` | space | new | AOS-17.9; suggested in Exam Mode (IA J6) |
| Subject updates feed | `subject_event` | space | new | AOS-2.9; one row per new lecture, version, attachment or exam date |
| Lectures | `official_lecture` + the space's `source` (`source_type 'lecture'`) | space | new + exists | stable Lecture Identity (§19H); vaults hold stubs (`source.is_stub`) |
| LectureVersions | `source_version` + `official_version_publish` + `version_page_map` | space (stubs in vaults) | exists + new | versions stay immutable |
| Files | `stored_file` (per DB) + `blob`, `blob_ref`, `blob_mark` (system) + `upload_session` (system) | all | extend | a per-DB `stored_file` row is the authorisation; deletion is decided by a **mark-and-sweep** over every vault and space, with refcounts as a hint only, and goes through a quarantine (§4.1 2250) |
| Assets | `image_asset`, `audio_asset`, `annotation_image` | vault / space | exists | access follows the parent resource |
| AnnotationLayers | `annotation_layer` | vault / space | new | `annotation.layer` stays the render class |
| InkStrokes | `annotation` (kind `ink`) + `crdt_update` for collaborative layers | vault / space | extend | `layer_id`, `author_user_id`; ink v2 packed points |
| PageAnchors | `annotation.anchor_json`, `annotation_target`, `page_fingerprint` | vault / space | exists + new | cross-version mapping via `version_page_map` |
| DocumentForks | `document_copy` (vault), `publication_copy` and `lecture_copy` (system), `attribution` | vault / system | new | `lecture_copy` lets jobs find stub holders without scanning vaults (§6.3) |
| Follows | `follow`, `course_follow` | system | new | «Subscribe to Course» is named `course_follow`: it is not a payment feature |
| Publications | `publication` (index, system) + `publication_version` + `publication_item` (immutable, delta-stored, stable item ids; space) + `publication_series` | system / space | new | §6.4 |
| Comments | `discussion_thread`, `discussion_post`, `discussion_vote` | space | new | also used for comments on publications |
| Permissions | `role_assignment`, `acl_grant`, `channel_membership`, visibility columns | system | new | policy in `authz` (§5) |
| StudyRooms | `study_room` | space | new | |
| RoomSessions | `room_session`, `room_participant`, `room_event` | space | new | |
| AudioRecordings | `audio_recording` | vault / space | extend | consent and share scope |
| TranscriptSegments | `transcript_segment`, `transcript_revision`, `transcription_run` | vault / space | extend | `lang`, `words_json`, `run_id`, `normalized_text` |
| TimelineEvents | `timeline_event` (+ stroke `audio_link` + segments, merged on read) | vault / space | new | |
| ExamHighlights | `exam_highlight` | vault / space | new | |
| Questions | `question`, `question_version`, … (bank) + `discussion_thread` kind `question` | vault / space | exists + new | discussion questions are not bank questions until a user adds them |
| Answers | `answer_key_entry`, `question_attempt` + `discussion_post` (+ `accepted_post_id`) | vault / space | exists + new | |
| Flashcards | `flashcard` | vault | exists | community cards are copy-on-use into the vault (§10.4) |
| Reviews | `review_event` (SRS log) + `rating` (reviews of explanations) | vault / system | exists + new | the spec's «Reviews» covers both; both are listed |
| SyncOperations | `sync_operation`, `sync_change`, `crdt_update`, `relay_receipt` | vault / space | extend + new | |
| Devices | `device` (+ `auth_session.device_id`) | system | new | Ed25519 public keys for relay bundles |
| Notifications | `notification`, `notification_pref`, `push_subscription` | system | new | |
| Provenance | `evidence`, `claim`, `citation`, `verification_result`, `artifact_dependency` + `attribution` | vault / space | exists + new | human authorship is never evidence |
| AuditLogs | `change_log` (per DB, `actor_user_id`) + `security_audit` (system) | all | extend + new | |

**Spec §21: keep large files separate from metadata and sync operations.** This already holds (blobs in the CAS;
sync ops carry metadata only; images uploaded by `image_key`; recordings uploaded separately). It is kept: CRDT
updates carry packed points (≈ 1.35 KB per stroke), never images or audio.

### 4.1 System DB DDL (`migrations-system/`)

```sql
-- ═══ 2000_identity.sql ══════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE user_account (
  id TEXT PRIMARY KEY,                               -- ULID
  username TEXT NOT NULL,
  username_norm TEXT NOT NULL UNIQUE,                -- NFKC + lower-case; the login key. On deletion renamed to 'deleted:<id>'
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,                       -- scrypt$N$r$p$salt$hash (same format as owner.password_hash)
  recovery_codes_json TEXT NOT NULL DEFAULT '[]',    -- scrypt hashes; used codes removed
  password_changed_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deletion_pending','deleted')),
  is_platform_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_platform_admin IN (0,1)),
  legacy_owner INTEGER NOT NULL DEFAULT 0 CHECK (legacy_owner IN (0,1)),   -- the migrated single owner
  timezone TEXT NOT NULL DEFAULT 'Asia/Baghdad',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE UNIQUE INDEX idx_user_account_legacy_owner ON user_account(legacy_owner) WHERE legacy_owner = 1;

CREATE TABLE user_profile (
  user_id TEXT PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
  bio TEXT,
  avatar_sha256 TEXT,                                -- blob in the CAS
  academic_json TEXT NOT NULL DEFAULT '{}',          -- {university_node_id?, college_node_id?, department_node_id?, stage_node_id?} (channel_node ids)
  field_visibility_json TEXT NOT NULL DEFAULT '{}',  -- per field: 'only_me' | 'followers' | 'members' | 'public'
  -- private by default (PRD N1, AOS-5.1): others see only display_name until the user opens fields; a test asserts the default
  profile_visibility TEXT NOT NULL DEFAULT 'only_me' CHECK (profile_visibility IN ('only_me','followers','members','public')),
  follow_requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (follow_requires_approval IN (0,1)),
  updated_at INTEGER NOT NULL
) STRICT;

-- same names as the vault's legacy auth tables ON PURPOSE (different file): auth/sessions.ts and limiter.ts move to the
-- system DB with minimal change; the legacy copies stay unused in vault #1 (ADR-0003 §5 step 5)
CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_account(id),
  token_hash TEXT NOT NULL UNIQUE,                   -- sha256 of the cookie token (unchanged scheme)
  device_id TEXT,
  device_label TEXT,
  user_agent TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX idx_auth_session_user ON auth_session(user_id, revoked_at);

CREATE TABLE login_attempt (
  id TEXT PRIMARY KEY,
  ip TEXT,
  username_norm TEXT,
  succeeded INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_login_attempt_user ON login_attempt(username_norm, created_at);
CREATE INDEX idx_login_attempt_ip ON login_attempt(ip, created_at);
-- limiter: per account a PROGRESSIVE DELAY (1 s, 2 s, 4 s … capped at 60 s between attempts after 5 failures), never a
-- hard lockout that a classmate who knows the username could trigger before an exam; a valid recovery code always
-- signs in and resets the delay. Per IP only a high ceiling (e.g. 300 failures/hour), because a campus NAT puts a whole
-- class behind one IP (today's limiter is per IP only)

-- ═══ 2010_devices.sql ═══════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE device (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  device_id TEXT NOT NULL,                           -- client ULID; per user on the web (per-user localStorage key)
  device_uid TEXT NOT NULL UNIQUE,                   -- SERVER-issued ULID, globally unique: the identity used in relay
                                                     -- receipts, version vectors and CRDT client bindings (§8.6, ADR-0004 §2.6)
  label TEXT,
  platform TEXT CHECK (platform IN ('web','ios','android','other')),
  public_key TEXT,                                   -- Ed25519, base64url; signs relay bundles (ADR-0004 §2.6, ADR-0005 §A.2)
  key_registered_at INTEGER,
  shared_device INTEGER NOT NULL DEFAULT 0 CHECK (shared_device IN (0,1)),  -- clear local data on sign-out
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (user_id, device_id)
) STRICT;

-- ═══ 2040_registry.sql (P1-T1) ══════════════════════════════════════════════════════════════════════════════════
CREATE TABLE space (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  db_file TEXT NOT NULL UNIQUE,                      -- relative to DATA_DIR/spaces/
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','read_only','migrating','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE vault (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES user_account(id),
  db_file TEXT NOT NULL UNIQUE,                      -- relative to DATA_DIR/vaults/
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','deleting','deleted')),
  bytes_db INTEGER NOT NULL DEFAULT 0,
  bytes_files INTEGER NOT NULL DEFAULT 0,            -- blobs referenced by this vault (quota)
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER
) STRICT;

-- ═══ 2050_directory.sql (P1-T4) ═════════════════════════════════════════════════════════════════════════════════
-- University → College → Department → Stage → Academic Year → Course (Semester/Course) → Subject.
-- Kinds must strictly descend in this order; skipping a level is allowed (e.g. a college without departments).
-- Enforced in channels/service.ts (zod + parent-kind check), tested.
CREATE TABLE channel_node (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES channel_node(id),
  kind TEXT NOT NULL CHECK (kind IN ('university','college','department','stage','academic_year','course','subject')),
  title TEXT NOT NULL,                               -- Arabic display title
  title_en TEXT,
  ordinal INTEGER,                                   -- stage number / manual order
  starts_on TEXT,                                    -- academic_year and course: YYYY-MM-DD
  ends_on TEXT,
  space_id TEXT REFERENCES space(id),                -- subject (optionally course): where official content and communities live
  join_policy TEXT NOT NULL DEFAULT 'approval' CHECK (join_policy IN ('closed','approval','open_with_code')),
  rights_json TEXT NOT NULL DEFAULT '{"official_files":"members_only"}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by TEXT NOT NULL REFERENCES user_account(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX idx_channel_node_parent ON channel_node(parent_id, ordinal);
CREATE INDEX idx_channel_node_space ON channel_node(space_id) WHERE space_id IS NOT NULL;

-- closure table: «is X inside Y» in one indexed lookup (membership and role inheritance down the tree)
CREATE TABLE channel_closure (
  ancestor_id TEXT NOT NULL REFERENCES channel_node(id),
  descendant_id TEXT NOT NULL REFERENCES channel_node(id),
  depth INTEGER NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
) STRICT;
CREATE INDEX idx_channel_closure_desc ON channel_closure(descendant_id);

CREATE TABLE join_code (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES channel_node(id),
  kind TEXT NOT NULL CHECK (kind IN ('class_code','invite_link')),   -- the QR encodes the invite link
  secret_hash TEXT NOT NULL UNIQUE,                  -- sha256 of the normalised code / link token; the plaintext is shown once
  hint TEXT NOT NULL,                                -- last 2 characters, for the admin list
  requires_approval INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval IN (0,1)),
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_by TEXT NOT NULL REFERENCES user_account(id),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_join_code_node ON join_code(node_id, revoked_at);

CREATE TABLE channel_membership (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES channel_node(id),   -- membership applies to the node AND its descendants
  user_id TEXT NOT NULL REFERENCES user_account(id),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','left','removed')),
  join_method TEXT NOT NULL CHECK (join_method IN ('class_code','qr','invite_link','invitation','added_by_admin','legacy_owner')),
  join_code_id TEXT REFERENCES join_code(id),
  decided_by TEXT REFERENCES user_account(id),
  decided_at INTEGER,
  decision_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (node_id, user_id)
) STRICT;
CREATE INDEX idx_membership_user ON channel_membership(user_id, status);
CREATE INDEX idx_membership_node ON channel_membership(node_id, status);

CREATE TABLE channel_invitation (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES channel_node(id),
  invitee_user_id TEXT NOT NULL REFERENCES user_account(id),
  invited_by TEXT NOT NULL REFERENCES user_account(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
) STRICT;
CREATE INDEX idx_invitation_invitee ON channel_invitation(invitee_user_id, status);

-- «Subscribe to Course»: new official lectures are added to the student's library as stubs (links, not copies)
CREATE TABLE course_follow (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  subject_node_id TEXT NOT NULL REFERENCES channel_node(id),
  add_new_lectures INTEGER NOT NULL DEFAULT 1 CHECK (add_new_lectures IN (0,1)),
  library_folder_id TEXT,                            -- the vault library_node the user chose (plain TEXT: it lives in the vault)
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (user_id, subject_node_id)
) STRICT;

-- ═══ 2060_lecture_copy.sql (forks) ══════════════════════════════════════════════════════════════════════════════
-- who holds a copy of which official lecture, so jobs never scan vaults (§6.3): stub fan-out of new versions, withdrawal
-- notices, «refuse purge while personal items exist», takedown. Written ONLY by the copy / stub / reanchor services in the
-- same job that changes the vault, keyed for idempotency; read ONLY by jobs; moderators see counts (minimum group 5).
-- A cross-user dataset by necessity: it holds no content, titles or item ids — only that a user has a copy and how many
-- personal items sit on each version.
CREATE TABLE lecture_copy (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  space_id TEXT NOT NULL REFERENCES space(id),
  lecture_id TEXT NOT NULL,                          -- official_lecture.id in that space
  version_id TEXT NOT NULL,                          -- a version the user's vault holds a stub of
  personal_items INTEGER NOT NULL DEFAULT 0,         -- personal annotations + notes on that version (refreshed by the vault job)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, space_id, lecture_id, version_id)
) STRICT;
CREATE INDEX idx_lecture_copy_lecture ON lecture_copy(space_id, lecture_id, version_id);

-- ═══ 2100_permissions.sql ═══════════════════════════════════════════════════════════════════════════════════════
-- 'student' is not a row here: it is an approved channel_membership. Roles inherit down the tree (channel_closure).
CREATE TABLE role_assignment (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES channel_node(id),
  user_id TEXT NOT NULL REFERENCES user_account(id),
  role TEXT NOT NULL CHECK (role IN ('admin','assistant','subject_moderator','contributor')),
  granted_by TEXT NOT NULL REFERENCES user_account(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE UNIQUE INDEX idx_role_active ON role_assignment(node_id, user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX idx_role_user ON role_assignment(user_id) WHERE revoked_at IS NULL;

-- «Shared with specific users» and per-resource grants
CREATE TABLE acl_grant (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('publication','collab_doc','recording_share','room')),
  resource_db TEXT NOT NULL,                         -- 'system' or the id of the space holding the resource
  resource_id TEXT NOT NULL,
  grantee_user_id TEXT NOT NULL REFERENCES user_account(id),
  permission TEXT NOT NULL CHECK (permission IN ('view','comment','suggest','edit','manage')),
  granted_by TEXT NOT NULL REFERENCES user_account(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE UNIQUE INDEX idx_acl_active ON acl_grant(resource_type, resource_db, resource_id, grantee_user_id, permission) WHERE revoked_at IS NULL;
CREATE INDEX idx_acl_grantee ON acl_grant(grantee_user_id) WHERE revoked_at IS NULL;

-- ═══ 2150_publications.sql (P1-T5) ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE publication_series (
  id TEXT PRIMARY KEY,
  author_user_id TEXT NOT NULL REFERENCES user_account(id),
  subject_node_id TEXT NOT NULL REFERENCES channel_node(id),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- index row of a publication; its immutable content (versions) lives in the space (publication_version)
CREATE TABLE publication (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES space(id),
  lecture_id TEXT NOT NULL,                          -- official_lecture.id in that space (plain TEXT: cross-DB)
  subject_node_id TEXT NOT NULL REFERENCES channel_node(id),
  author_user_id TEXT NOT NULL REFERENCES user_account(id),
  kind TEXT NOT NULL CHECK (kind IN ('explanation','voice_explanation','crowd_notes')),
  title TEXT NOT NULL,
  summary TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('specific_users','followers','course','public')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden_by_moderator','withdrawn','author_deleted')),
  moderator_review TEXT NOT NULL DEFAULT 'none' CHECK (moderator_review IN ('none','reviewed','changes_requested')),
  reviewed_by TEXT REFERENCES user_account(id),      -- «راجعه مشرف مخوّل» (§19I) names the role and the date, never «verified»
  reviewed_role TEXT,
  reviewed_at INTEGER,
  head_version_no INTEGER NOT NULL,                  -- the live head; versions are immutable
  quick_review_tag INTEGER NOT NULL DEFAULT 0 CHECK (quick_review_tag IN (0,1)),   -- the author's own tag
  series_id TEXT REFERENCES publication_series(id),
  series_ord REAL,
  signals_json TEXT NOT NULL DEFAULT '{}',           -- recomputed by the ranking job, never typed in (§7.8)
  rank_score REAL,
  rank_version TEXT,
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_publication_lecture ON publication(space_id, lecture_id, status);
CREATE INDEX idx_publication_author ON publication(author_user_id, published_at);
CREATE INDEX idx_publication_subject ON publication(subject_node_id, published_at);

-- who holds a fork / followed copy (fan-out of updates, honest counts). The user's own truth is document_copy in the vault.
CREATE TABLE publication_copy (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  publication_id TEXT NOT NULL REFERENCES publication(id),
  mode TEXT NOT NULL CHECK (mode IN ('independent','followed')),
  applied_version_no INTEGER NOT NULL,
  pending_version_no INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (user_id, publication_id)
) STRICT;
CREATE INDEX idx_publication_copy_pub ON publication_copy(publication_id, mode) WHERE ended_at IS NULL;

-- ═══ 2160_social.sql (P2-T1) ════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE follow (
  follower_id TEXT NOT NULL REFERENCES user_account(id),
  followee_id TEXT NOT NULL REFERENCES user_account(id),
  subject_scope TEXT NOT NULL DEFAULT '',            -- '' = everything; else a channel_node id of kind 'subject' (§5 «follow in one subject only»)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id, subject_scope),
  CHECK (follower_id <> followee_id)
) STRICT;
CREATE INDEX idx_follow_followee ON follow(followee_id, status);

CREATE TABLE reaction (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  publication_id TEXT NOT NULL REFERENCES publication(id),
  kind TEXT NOT NULL CHECK (kind IN ('like','save')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, publication_id, kind)
) STRICT;

-- ONE rating per user per publication: re-rating after a republish replaces the user's rating (and records the version
-- rated), so a rating ring cannot rate again on every version; rankings read only this latest row (§7.8)
CREATE TABLE rating (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  publication_id TEXT NOT NULL REFERENCES publication(id),
  version_no INTEGER NOT NULL,                       -- the version the latest rating was given on
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  good_for_quick_review INTEGER NOT NULL DEFAULT 0 CHECK (good_for_quick_review IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, publication_id)
) STRICT;

-- ═══ 2200_notifications.sql ═════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE notification (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_account(id),
  kind TEXT NOT NULL,                                -- §12
  actor_user_id TEXT,
  subject_db TEXT,                                   -- 'system' | space id | 'vault'
  subject_type TEXT,
  subject_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',           -- titles and counts only; never private note text
  dedupe_key TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  dismissed_at INTEGER
) STRICT;
CREATE INDEX idx_notification_user ON notification(user_id, created_at);
CREATE UNIQUE INDEX idx_notification_dedupe ON notification(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE notification_pref (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  kind TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_app','push')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  PRIMARY KEY (user_id, kind, channel)
) STRICT;

CREATE TABLE push_subscription (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_account(id),
  device_id TEXT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  revoked_at INTEGER
) STRICT;

-- ═══ 2250_ops.sql ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE blob (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  storage TEXT NOT NULL DEFAULT 'local' CHECK (storage IN ('local','r2')),
  storage_key TEXT NOT NULL,                         -- aa/bb/<sha256> (unchanged layout)
  created_at INTEGER NOT NULL,
  orphaned_at INTEGER,                               -- first sweep that found NO stored_file row anywhere
  quarantined_at INTEGER                             -- moved to quarantine/<sha256>; deleted only after a later sweep agrees
) STRICT;

-- HINT ONLY. Kept for quota display and fast checks; never the reason a blob is deleted, because it lives in another file
-- than the stored_file rows it counts (no shared transaction) and per-file restores make it drift.
CREATE TABLE blob_ref (
  sha256 TEXT NOT NULL REFERENCES blob(sha256),
  db_id TEXT NOT NULL,                               -- vault id | space id | 'system'
  ref_count INTEGER NOT NULL CHECK (ref_count >= 0),
  PRIMARY KEY (sha256, db_id)
) STRICT;

-- MARK-AND-SWEEP GC (the only deletion path). A sweep: (1) mark — enumerate stored_file.sha256 (and upload sessions in
-- flight) in EVERY registered vault and space, plus the system DB, into blob_mark; (2) a blob with no mark and created
-- before the sweep started is set orphaned_at; (3) a blob orphaned in two consecutive sweeps ≥ 7 days apart is moved to
-- quarantine; (4) a quarantined blob is deleted after 30 more days only if a fresh mark still misses it, else restored.
-- A mark pass runs after ANY restore (vault, space, system or whole instance), and restore-verify rebuilds blob_ref from
-- it. Test: crash between a vault's stored_file insert and the blob_ref increment → the next sweep keeps the blob.
CREATE TABLE blob_mark (
  sweep_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  db_id TEXT NOT NULL,
  PRIMARY KEY (sweep_id, sha256, db_id)
) STRICT;
-- ⚠ BREAK fixed: sources/purge.ts removeStoredFileIfUnreferenced() today deletes the blob when no row in THIS DB uses it.
--   It becomes «delete my stored_file row and decrement my blob_ref hint»; only the sweep above deletes bytes.

CREATE TABLE job_index (
  db_kind TEXT NOT NULL CHECK (db_kind IN ('vault','space')),
  db_id TEXT NOT NULL,
  job_id TEXT NOT NULL,                              -- processing_job.id inside that DB (checkpoints stay there)
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  run_after INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (db_id, job_id)
) STRICT;
CREATE INDEX idx_job_index_due ON job_index(status, run_after);

CREATE TABLE upload_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_account(id),
  target_db TEXT NOT NULL,                           -- the DB that will receive the stored_file row
  expected_sha256 TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  mime TEXT,
  original_name TEXT,
  received_json TEXT NOT NULL DEFAULT '[]',          -- indexes of verified chunks
  status TEXT NOT NULL CHECK (status IN ('open','completed','expired','failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE user_quota (
  user_id TEXT PRIMARY KEY REFERENCES user_account(id),
  storage_bytes_limit INTEGER,
  ai_monthly_usd_limit REAL,                         -- default 0 for new users (§14)
  asr_monthly_minutes_limit INTEGER,
  asr_monthly_cpu_minutes_limit INTEGER,             -- server-local engines cost CPU, not money (ADR-0006 §2.13)
  live_session_usd_cap REAL,
  rooms_concurrent_limit INTEGER,
  updated_by TEXT REFERENCES user_account(id),
  updated_at INTEGER NOT NULL
) STRICT;

-- per subject space (PRD Q22: 20 GB; shared Study Books and shared transcripts are charged here, not to one student)
CREATE TABLE space_quota (
  space_id TEXT PRIMARY KEY REFERENCES space(id),
  storage_bytes_limit INTEGER,
  ai_monthly_usd_limit REAL,
  asr_monthly_cpu_minutes_limit INTEGER,
  updated_by TEXT REFERENCES user_account(id),
  updated_at INTEGER NOT NULL
) STRICT;

-- atomic budget reservations (fixes the non-atomic pre-check noted in docs/modules/core-server.md)
CREATE TABLE ai_budget_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_account(id),
  month TEXT NOT NULL,                               -- YYYY-MM in the user's timezone
  kind TEXT NOT NULL CHECK (kind IN ('ai','asr')),
  reserved_usd REAL NOT NULL,                        -- worst-case estimate (outputTokenCeiling / minutes)
  actual_usd REAL,                                   -- ESTIMATED cost from the usage record
  status TEXT NOT NULL CHECK (status IN ('reserved','settled','released')),
  usage_ref TEXT,                                    -- usage_record id in the user's vault
  created_at INTEGER NOT NULL,
  settled_at INTEGER
) STRICT;
CREATE INDEX idx_ai_budget_user_month ON ai_budget_ledger(user_id, month, status);

-- ═══ 2300_security.sql (P1-T1) ══════════════════════════════════════════════════════════════════════════════════
CREATE TABLE security_audit (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_role TEXT,                                   -- e.g. 'subject_moderator@<node_id>' | 'platform_admin' | 'self'
  scope_node_id TEXT,
  action TEXT NOT NULL,                              -- login | role_grant | role_revoke | membership_decide | code_create | code_revoke |
                                                     -- lecture_publish | lecture_withdraw | publication_hide | account_export | account_delete | ...
  target_db TEXT,
  target_type TEXT,
  target_id TEXT,
  summary TEXT NOT NULL,                             -- Arabic, no private content
  details_json TEXT,                                 -- redacted like audit.ts (secret-looking keys removed)
  ip TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_security_audit_scope ON security_audit(scope_node_id, created_at);
CREATE INDEX idx_security_audit_actor ON security_audit(actor_user_id, created_at);

CREATE TABLE consent_record (
  id TEXT PRIMARY KEY,
  -- §5.6. lecturer_recording_policy: per subject, attested by a Subject Moderator; scope_json names the allowed share
  --   scopes, whether external processing is allowed, and that a hall notice is shown. recording_share: the recorder,
  --   per share. recording_attestation: the recorder, per recording outside any subject. ai_processing: per user, names
  --   the AI providers private notes, handwriting crops or transcripts may be sent to.
  kind TEXT NOT NULL CHECK (kind IN ('recording_share','lecturer_recording_policy','recording_attestation','room_recording',
                                     'cloud_asr','ai_processing','progress_share','relay_participation')),
  subject_user_id TEXT NOT NULL REFERENCES user_account(id),   -- whose consent it is
  recorded_by TEXT NOT NULL REFERENCES user_account(id),       -- the same user, or a moderator attesting a lecturer's written policy
  resource_db TEXT,
  resource_type TEXT,
  resource_id TEXT,
  scope_json TEXT NOT NULL,                          -- e.g. {"audience":"course","download":false} | {"provider":"azure"}
  text_version TEXT NOT NULL,                        -- version of the exact Arabic consent text shown
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX idx_consent_resource ON consent_record(resource_db, resource_type, resource_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_consent_subject ON consent_record(subject_user_id, kind) WHERE revoked_at IS NULL;

-- ═══ 2310_moderation.sql (P1-T4) ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE moderation_report (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES user_account(id),
  target_db TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('publication','publication_version','discussion_thread','discussion_post',
                                                   'suggestion','profile','room','official_lecture')),
  target_id TEXT NOT NULL,
  scope_node_id TEXT NOT NULL REFERENCES channel_node(id),     -- routes the report to the moderators of that subtree
  reason TEXT NOT NULL CHECK (reason IN ('wrong_content','copyright','harassment','spam','privacy','patient_identifiers','other')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
) STRICT;
CREATE INDEX idx_report_scope ON moderation_report(scope_node_id, status, created_at);
CREATE UNIQUE INDEX idx_report_once ON moderation_report(reporter_user_id, target_db, target_type, target_id) WHERE status = 'open';

CREATE TABLE moderation_action (
  id TEXT PRIMARY KEY,
  report_id TEXT REFERENCES moderation_report(id),
  moderator_user_id TEXT NOT NULL REFERENCES user_account(id),
  role TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('hide','restore','request_changes','mark_reviewed','remove_post','lock_thread',
                                         'warn_user','suspend_user','dismiss')),   -- mark_reviewed: Subject Moderator only (§5.3)
  target_db TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason_ar TEXT NOT NULL,                           -- shown to the author
  created_at INTEGER NOT NULL
) STRICT;
```

### 4.2 Base additions (vault and space; `apps/server/src/db/migrations/`)

```sql
-- ═══ 0041_sync_actor_visibility.sql (sync) ══════════════════════════════════════════════════════════════════════
ALTER TABLE sync_operation ADD COLUMN actor_user_id TEXT;      -- NULL in a vault = the vault's user
ALTER TABLE sync_change ADD COLUMN visibility_key TEXT;        -- NULL = every reader of this DB; spaces set it (§8.4)
CREATE INDEX idx_sync_change_visibility ON sync_change(visibility_key, seq) WHERE visibility_key IS NOT NULL;

-- ═══ 0050_change_log_actor.sql (audit, new range 0050–0059) ═════════════════════════════════════════════════════
ALTER TABLE change_log ADD COLUMN actor_user_id TEXT;          -- `actor` keeps owner|system|job semantics; 'owner' now means «the acting user»
ALTER TABLE change_log ADD COLUMN actor_role TEXT;

-- ═══ 0160_lecture_identity.sql (sources) ════════════════════════════════════════════════════════════════════════
ALTER TABLE source ADD COLUMN lecture_no INTEGER;
ALTER TABLE source ADD COLUMN lecture_no_origin TEXT CHECK (lecture_no_origin IN ('detected','owner','moderator'));
ALTER TABLE source ADD COLUMN held_on TEXT;                    -- YYYY-MM-DD, the lecture's session date
ALTER TABLE source ADD COLUMN origin_space_id TEXT;            -- stub: the space holding the official lecture
ALTER TABLE source ADD COLUMN origin_lecture_id TEXT;          -- stub: official_lecture.id in that space
ALTER TABLE source ADD COLUMN is_stub INTEGER NOT NULL DEFAULT 0 CHECK (is_stub IN (0,1));  -- chunks/FTS/regions stay in the space
CREATE UNIQUE INDEX idx_source_origin_lecture ON source(origin_space_id, origin_lecture_id) WHERE origin_lecture_id IS NOT NULL;

-- ═══ 0161_page_map.sql (sources) ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE page_fingerprint (
  page_id TEXT PRIMARY KEY REFERENCES source_page(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  text_norm_hash TEXT,                               -- sha256 of the page's normalised logical text (null: no text)
  text_minhash BLOB,                                 -- 64 × u32 MinHash over word 3-shingles
  image_dhash TEXT,                                  -- 64-bit dHash of the thumbnail, hex
  algo TEXT NOT NULL,                                -- fingerprint scheme version
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_page_fingerprint_version ON page_fingerprint(version_id);
CREATE INDEX idx_page_fingerprint_text ON page_fingerprint(text_norm_hash) WHERE text_norm_hash IS NOT NULL;

CREATE TABLE version_page_map (
  from_version_id TEXT NOT NULL,
  to_version_id TEXT NOT NULL,
  from_page_id TEXT NOT NULL,
  to_page_id TEXT,                                   -- NULL: no safe counterpart (page removed or rewritten)
  method TEXT NOT NULL CHECK (method IN ('identical','text_similarity','image_similarity','moderator','owner')),
  text_score REAL,
  image_distance INTEGER,
  layout_safe INTEGER NOT NULL DEFAULT 0 CHECK (layout_safe IN (0,1)),  -- 1 → normalised coordinates may be reused (§6.2)
  status TEXT NOT NULL CHECK (status IN ('safe','uncertain','none','confirmed','rejected')),
  algo TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_version_id, to_version_id, from_page_id)
) STRICT;
-- the sources purge deletes both tables' rows for purged versions (added to its purge list, docs/modules/library-sources.md)

-- ═══ 0162_region_text_origin_ext.sql (sources) ══════════════════════════════════════════════════════════════════
-- ASR transcript regions: text_origin stays NULL (its CHECK cannot change without an unsafe rebuild); the engine kind lives here.
ALTER TABLE source_region ADD COLUMN text_origin_ext TEXT CHECK (text_origin_ext IN ('asr'));

-- ═══ 0163_pinned_region.sql (sources) ═══════════════════════════════════════════════════════════════════════════
-- Lazy pinning (ADR-0003 §3.3) copies a space region into the vault when a vault artifact cites it. The pin records the
-- content hash it copied, so a later difference between space and vault text is detectable and never silent; a pin is
-- refreshed only by an explicit user action after a content alert (§6.7). Published official regions are immutable, so
-- for them the hash never changes.
CREATE TABLE pinned_region (
  region_id TEXT PRIMARY KEY,                        -- the space's source_region.id (same id in the vault)
  space_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,                        -- sha256 of the region text + locator at pin time
  pinned_at INTEGER NOT NULL,
  refreshed_at INTEGER
) STRICT;

-- ═══ 0361_embedding_meta.sql (search) ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE embedding_index (
  model TEXT PRIMARY KEY,
  dims INTEGER NOT NULL,
  quantization TEXT NOT NULL CHECK (quantization IN ('f32','int8')),
  chunk_count INTEGER NOT NULL,
  index_version TEXT NOT NULL,
  built_at INTEGER NOT NULL
) STRICT;

-- ═══ 0620_study_time_goals.sql (learning) ═══════════════════════════════════════════════════════════════════════
CREATE TABLE study_time_event (
  id TEXT PRIMARY KEY,                               -- client ULID; append-only; sync entity 'study_time_event'
  source_id TEXT,
  page_id TEXT,
  activity TEXT NOT NULL CHECK (activity IN ('reading','writing','reviewing','exam','listening','room')),
  started_at INTEGER NOT NULL,                       -- ACTIVE time only: page visible + focused; idle cut-off 120 s
  ended_at INTEGER NOT NULL,
  device_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK (ended_at >= started_at)
) STRICT;
CREATE INDEX idx_study_time_started ON study_time_event(started_at);

CREATE TABLE study_goal (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL CHECK (period IN ('week','month')),
  metric TEXT NOT NULL CHECK (metric IN ('active_minutes','cards_reviewed','lectures_completed','questions_answered')),
  target INTEGER NOT NULL CHECK (target > 0),
  starts_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- ═══ 0621_smart_collections.sql (learning) ══════════════════════════════════════════════════════════════════════
-- Collections are computed views; this table stores the user's pinned built-ins and custom rules. Each rule states
-- its basis and denominator in Arabic (no opaque scores).
CREATE TABLE smart_collection (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('important_for_exam','need_revision','most_difficult','unanswered_questions',
                                     'saved_explanations','custom')),
  title TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 1 CHECK (pinned IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- ═══ 0680_asr.sql (media) ═══════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE transcription_run (
  id TEXT PRIMARY KEY,
  audio_id TEXT NOT NULL REFERENCES audio_asset(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  location TEXT NOT NULL CHECK (location IN ('device','server_local','cloud')),
  mode TEXT NOT NULL CHECK (mode IN ('batch','streaming')),
  language_hints_json TEXT NOT NULL,
  vocab_id TEXT,
  vocab_version TEXT,
  vad TEXT NOT NULL CHECK (vad IN ('engine','external','none')),
  diarization INTEGER NOT NULL DEFAULT 0 CHECK (diarization IN (0,1)),
  denoise INTEGER NOT NULL DEFAULT 0 CHECK (denoise IN (0,1)),
  consent_record_id TEXT,                            -- system consent_record (cloud engines)
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','partial','failed','cancelled','waiting_for_input')),
  segments_created INTEGER NOT NULL DEFAULT 0,
  billed_seconds INTEGER,
  estimated_cost_usd REAL,
  job_id TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE INDEX idx_transcription_run_audio ON transcription_run(audio_id, created_at);

ALTER TABLE transcript_segment ADD COLUMN run_id TEXT;
ALTER TABLE transcript_segment ADD COLUMN lang TEXT CHECK (lang IN ('ar','en','mixed'));
ALTER TABLE transcript_segment ADD COLUMN words_json TEXT;        -- [{text,start_ms,end_ms,confidence?,script,vocab_match?}]
ALTER TABLE transcript_segment ADD COLUMN normalized_text TEXT;   -- vocabulary post-correction (derived); `text` is never touched
ALTER TABLE transcript_segment ADD COLUMN speaker_origin TEXT CHECK (speaker_origin IN ('imported','diarized','owner'));

CREATE TABLE asr_vocabulary (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('subject','lecture','personal')),
  scope_id TEXT NOT NULL,
  version TEXT NOT NULL,                             -- sha256 of the sorted terms
  terms_json TEXT NOT NULL,                          -- [{term, weight, from:'concept'|'alias'|'medical_term'|'lecture_text'|'moderator'|'owner'}]
  created_at INTEGER NOT NULL,
  UNIQUE (scope_type, scope_id, version)
) STRICT;

CREATE TABLE audio_interval (
  audio_id TEXT NOT NULL REFERENCES audio_asset(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('speech','silence')),
  start_ms INTEGER NOT NULL,                         -- ORIGINAL recording time
  end_ms INTEGER NOT NULL,
  detector TEXT NOT NULL,                            -- 'silero@sherpa-onnx' | 'whisper-vad' | 'energy-v1'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (audio_id, detector, start_ms),
  CHECK (end_ms > start_ms)
) STRICT;

-- ═══ 0681_recording_share.sql (media) ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE audio_recording ADD COLUMN author_user_id TEXT;       -- set on copies in spaces; NULL in a vault (= the vault's user)
ALTER TABLE audio_recording ADD COLUMN share_scope TEXT NOT NULL DEFAULT 'private' CHECK (share_scope IN ('private','listen_only','download'));
ALTER TABLE audio_recording ADD COLUMN consent_json TEXT;          -- {recorder:<consent id>, lecturer_policy?:<id>, attestation?:<id>, room?:[<ids>]}
-- A recording shared to a subject is COPIED into the space (one shared official recording per lecture session where the
-- lecturer policy allows it); its transcript is produced ONCE there and reused by every member (ADR-0006 §2.13).

-- ═══ 0860_document_copy.sql (forks, new range 0860–0869) ════════════════════════════════════════════════════════
-- A user's study copy of a lecture (vault). Unused in spaces.
CREATE TABLE document_copy (
  id TEXT PRIMARY KEY,                               -- client ULID allowed (Start Studying works offline for a downloaded stub)
  source_id TEXT NOT NULL REFERENCES source(id),     -- the stub (or a private upload)
  origin_space_id TEXT,                              -- NULL for private uploads
  origin_lecture_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('personal','independent_fork','followed','collaborative')),
  publication_id TEXT,                               -- fork / followed: the system publication id
  applied_version_no INTEGER,                        -- fork: pinned forever; followed: last applied
  pending_version_no INTEGER,                        -- followed: an update waiting for preview
  update_policy TEXT NOT NULL DEFAULT 'preview' CHECK (update_policy IN ('preview','auto')),
  personal_layer_id TEXT NOT NULL REFERENCES annotation_layer(id),
  copied_layer_id TEXT REFERENCES annotation_layer(id),   -- forked (writable) or followed (read-only) layer
  collab_doc_ref TEXT,                               -- collaborative: collab_doc id in the space
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX idx_document_copy_source ON document_copy(source_id);
CREATE UNIQUE INDEX idx_document_copy_pub ON document_copy(publication_id) WHERE publication_id IS NOT NULL AND deleted_at IS NULL;

-- ═══ 0861_attribution.sql (forks) ═══════════════════════════════════════════════════════════════════════════════
-- Human authorship of copied content. Never evidence; shown as «مأخوذ من شرح … (الإصدار n)».
CREATE TABLE attribution (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('annotation','note','note_page','annotation_layer','publication_version')),
  entity_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  author_display TEXT NOT NULL,                      -- the name at copy time: an offline FALLBACK only. Online, names are rendered at read
                                                     -- time from the system user_account (a deleted account renders «طالب سابق» everywhere
                                                     -- at once), so no other user's vault is ever written to change a name (PRD Q14)
  derived_from_json TEXT NOT NULL,                   -- [{space_id, publication_id, version_no, item_id}] — appended on every hop
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
) STRICT;

-- ═══ 0870_timeline_event.sql (timeline, new range 0870–0879) ════════════════════════════════════════════════════
CREATE TABLE timeline_event (
  id TEXT PRIMARY KEY,                               -- client ULID; append-only; sync entity 'timeline_event'
  clock_kind TEXT NOT NULL CHECK (clock_kind IN ('recording','room_session')),
  clock_id TEXT NOT NULL,                            -- audio_recording.id (= the client recording id) | room_session.id
  t_ms INTEGER NOT NULL CHECK (t_ms >= 0),           -- ORIGINAL time from the clock start (paused time excluded, like audio_link)
  dur_ms INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('page_view','zoom','highlight','photo','note','question','bookmark','chapter','ai_mark','room_event')),
  ref_type TEXT,                                     -- annotation | note | exam_highlight | question | image | room_event
  ref_id TEXT,
  source_id TEXT,
  version_id TEXT,
  page_id TEXT,
  payload_json TEXT,                                 -- page_view: {page_index, zoom}; chapter: {title, origin}; ...
  origin TEXT NOT NULL CHECK (origin IN ('device','owner','derived','ai')),
  device_id TEXT,
  author_user_id TEXT,                               -- NULL in a vault
  skew_ms INTEGER,                                   -- room sessions: the device's measured clock offset
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX idx_timeline_clock ON timeline_event(clock_id, t_ms);
CREATE INDEX idx_timeline_ref ON timeline_event(ref_type, ref_id);

-- ═══ 0880_exam_highlight.sql (copilot, new range 0880–0889) ═════════════════════════════════════════════════════
CREATE TABLE exam_highlight (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL,                        -- audio_recording.id
  audio_id TEXT,                                     -- audio_asset.id once uploaded
  t_start_ms INTEGER NOT NULL,
  t_end_ms INTEGER NOT NULL,
  segment_ids_json TEXT NOT NULL DEFAULT '[]',
  source_id TEXT,
  version_id TEXT,
  page_id TEXT,
  page_origin TEXT NOT NULL CHECK (page_origin IN ('page_view_log','stroke','manual','none')),
  cue_kind TEXT NOT NULL CHECK (cue_kind IN ('explicit_exam','emphasis','always_in_exam','may_ask','question_form','repetition','context_ai')),
  cue_quote TEXT NOT NULL,                           -- the exact transcript words that triggered it
  detector TEXT NOT NULL,                            -- 'phrase-v1' | 'repetition-v1' | provider:model
  question_text TEXT,
  question_status TEXT NOT NULL CHECK (question_status IN ('stated','not_stated','unclear')),
  lecturer_answer_text TEXT,                         -- verbatim from the transcript; NEVER an answer key
  lecturer_answer_status TEXT NOT NULL CHECK (lecturer_answer_status IN ('stated','not_stated','unclear')),
  generated_answer_artifact_id TEXT,                 -- separate, evidence-checked AI answer (artifact + claims)
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','accepted','rejected')),
  question_id TEXT,                                  -- after «أضف إلى بنك الأسئلة»
  flashcard_id TEXT,                                 -- after «أنشئ بطاقة»
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_exam_highlight_recording ON exam_highlight(recording_id, t_start_ms);
CREATE INDEX idx_exam_highlight_source ON exam_highlight(source_id, status);

-- ═══ 0881_copilot_session.sql (copilot) ═════════════════════════════════════════════════════════════════════════
CREATE TABLE copilot_session (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL,
  source_id TEXT,
  scope_json TEXT NOT NULL,                          -- pinned Source Lock (default lecture_only)
  features_json TEXT NOT NULL,                       -- {transcribe, translate, summarize, detect_questions, answer, topics, slide_sync, card_suggestions}
  budget_cap_usd REAL NOT NULL,
  spent_usd_est REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running','paused_budget','ended','failed')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;
```

### 4.3 Annotation layers and history (base; `0271`, `0272`, `0273`)

```sql
-- ═══ 0271_annotation_layers.sql (annotations) ═══════════════════════════════════════════════════════════════════
CREATE TABLE annotation_layer (
  id TEXT PRIMARY KEY,                               -- client ULID for personal layers; server-derived otherwise
  document_key TEXT NOT NULL,                        -- 'source:<source_id>' (a stub or private source; all its versions) | 'notebook:<library_node_id>'
  kind TEXT NOT NULL CHECK (kind IN ('personal','explanation','answers','published_snapshot','followed','forked',
                                     'group_comments','suggestion','collaborative')),
  title TEXT NOT NULL,
  owner_user_id TEXT,                                -- NULL in a vault (= the vault's user); set in spaces
  writable INTEGER NOT NULL DEFAULT 1 CHECK (writable IN (0,1)),   -- 0: followed / published_snapshot (enforced by the handlers)
  frozen INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0,1)),       -- 1: immutable snapshot
  origin_json TEXT,                                  -- {space_id, publication_id, version_no, author_user_id, author_display}
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),     -- default visibility; per-session overrides in study_session.location_json
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),       -- owner lock (parity G23)
  color TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  device_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX idx_annotation_layer_doc ON annotation_layer(document_key, sort_order);

-- layer_id NULL = the default personal layer of the document in this vault → no legacy row is rewritten
ALTER TABLE annotation ADD COLUMN layer_id TEXT REFERENCES annotation_layer(id);
ALTER TABLE annotation ADD COLUMN author_user_id TEXT;            -- NULL in a vault = the vault's user
ALTER TABLE annotation ADD COLUMN migrated_from_id TEXT;          -- the original item a re-anchor / layer copy came from
ALTER TABLE annotation ADD COLUMN origin TEXT NOT NULL DEFAULT 'device' CHECK (origin IN (
  'device','crdt_projection','publish_copy','follow_copy','fork_copy','layer_copy','reanchor_copy'));
CREATE INDEX idx_annotation_layer ON annotation(layer_id) WHERE layer_id IS NOT NULL;
CREATE INDEX idx_annotation_migrated ON annotation(migrated_from_id) WHERE migrated_from_id IS NOT NULL;

ALTER TABLE note ADD COLUMN layer_id TEXT REFERENCES annotation_layer(id);
ALTER TABLE note ADD COLUMN author_user_id TEXT;
ALTER TABLE note ADD COLUMN migrated_from_id TEXT;

-- ═══ 0272_annotation_revision.sql (annotations) ═════════════════════════════════════════════════════════════════
-- Append-only before-images (version history, restore, Study Time Machine). Written in the same transaction as the change.
CREATE TABLE annotation_revision (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('annotation','note','annotation_layer')),
  entity_id TEXT NOT NULL,
  rev INTEGER NOT NULL,                              -- the rev the before-image had
  action TEXT NOT NULL CHECK (action IN ('update','delete','restore','followed_update','layer_restore')),
  snapshot_json TEXT NOT NULL,                       -- the full stored row before the change
  actor_user_id TEXT,
  device_id TEXT,
  op_id TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, rev)
) STRICT;
CREATE INDEX idx_annotation_revision_time ON annotation_revision(at);
-- the sources purge and note-page purge delete revisions of the items they delete (purge preview lists the count)

-- ═══ 0273_annotation_audio_index.sql (annotations) ══════════════════════════════════════════════════════════════
CREATE INDEX idx_annotation_audio_recording ON annotation(json_extract(data_json, '$.audio_link.recording_id'))
  WHERE json_extract(data_json, '$.audio_link.recording_id') IS NOT NULL;
```

### 4.4 Space commons DDL (`migrations-space/`)

```sql
-- ═══ 3000_official_lectures.sql (lectures) ══════════════════════════════════════════════════════════════════════
-- Stable Lecture Identity (§19H): survives renames and re-uploads; versions are source_version rows of `source_id`.
CREATE TABLE official_lecture (
  id TEXT PRIMARY KEY,
  subject_node_id TEXT NOT NULL,                     -- system channel_node id (plain TEXT: cross-DB)
  source_id TEXT NOT NULL UNIQUE REFERENCES source(id),
  title TEXT NOT NULL,
  lecture_no INTEGER,
  lecture_no_origin TEXT CHECK (lecture_no_origin IN ('detected','moderator')),
  held_on TEXT,                                      -- YYYY-MM-DD
  status TEXT NOT NULL CHECK (status IN ('draft','in_review','published','withdrawn')),
  head_version_id TEXT REFERENCES source_version(id),   -- the published official version students see
  uploaded_by TEXT NOT NULL,                         -- user id (contributor / moderator)
  approved_by TEXT,
  approved_at INTEGER,
  withdrawn_reason TEXT CHECK (withdrawn_reason IN ('replaced','error','rights_takedown','other')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  withdrawn_at INTEGER
) STRICT;
CREATE INDEX idx_official_lecture_subject ON official_lecture(subject_node_id, status, lecture_no, held_on);

CREATE TABLE official_version_publish (
  version_id TEXT PRIMARY KEY REFERENCES source_version(id),
  lecture_id TEXT NOT NULL REFERENCES official_lecture(id),
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  change_note TEXT,
  previous_version_id TEXT REFERENCES source_version(id),
  page_map_status TEXT NOT NULL DEFAULT 'pending' CHECK (page_map_status IN ('pending','ready','failed'))
) STRICT;
-- Once a version is published, its source_page / source_region rows are IMMUTABLE: a correction creates a new version
-- (§6.7). Drafts may still be corrected in place.

-- ═══ 3010_subject_content.sql (lectures) ════════════════════════════════════════════════════════════════════════
-- Spec §2: «ملفات إضافية وملخصات وأسئلة السنوات السابقة», «آخر التحديثات وإصدارات المحاضرات»; spec §17 exam dates.
CREATE TABLE subject_attachment (
  id TEXT PRIMARY KEY,
  subject_node_id TEXT NOT NULL,                     -- system channel_node id (plain TEXT: cross-DB)
  lecture_id TEXT REFERENCES official_lecture(id),   -- optional: attached to one lecture
  kind TEXT NOT NULL CHECK (kind IN ('summary','previous_exam','reference','other')),
  title TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source(id),     -- processed like any source in the space (versions = source_version)
  uploaded_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','withdrawn')),   -- contributor uploads start as draft
  visibility TEXT NOT NULL DEFAULT 'course' CHECK (visibility IN ('course','moderators')),
  rights_json TEXT NOT NULL DEFAULT '{"members_only":true}',
  approved_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_subject_attachment ON subject_attachment(subject_node_id, kind, status);

CREATE TABLE subject_exam_date (
  id TEXT PRIMARY KEY,
  subject_node_id TEXT NOT NULL,
  title TEXT NOT NULL,                               -- e.g. «الامتحان النهائي — الدور الأول»
  exam_on TEXT NOT NULL,                             -- YYYY-MM-DD
  starts_at TEXT,                                    -- HH:MM, local
  lecture_ids_json TEXT NOT NULL DEFAULT '[]',       -- lectures the moderator says are included (optional)
  published_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','changed','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- the subject updates feed (AOS-2.9): appended by the lectures module in the same transaction as the change it reports
CREATE TABLE subject_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_node_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lecture_published','version_published','lecture_withdrawn','attachment_published',
                                     'exam_date_published','exam_date_changed')),
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  title TEXT NOT NULL,                               -- Arabic display line; never private content
  visibility_key TEXT,                               -- NULL = all members; 'mod' for moderator-only events
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_subject_event ON subject_event(subject_node_id, seq);

-- ═══ 3050_publications.sql (forks) ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE publication_version (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,                      -- system publication.id
  version_no INTEGER NOT NULL,
  lecture_id TEXT NOT NULL REFERENCES official_lecture(id),
  lecture_version_id TEXT NOT NULL REFERENCES source_version(id),   -- the official version the explanation was written on
  author_user_id TEXT NOT NULL,
  change_note TEXT,
  item_count INTEGER NOT NULL,
  pages_covered INTEGER NOT NULL,                    -- honest completeness numerator
  pages_total INTEGER NOT NULL,                      -- denominator: pages of lecture_version_id
  audio_recording_id TEXT,                           -- voice explanation: a copied audio_recording with consent_json
  content_hash TEXT NOT NULL,                        -- sha256 over the canonical item list
  derived_from_json TEXT,                            -- attribution chain when built from others' items
  created_at INTEGER NOT NULL,
  UNIQUE (publication_id, version_no)
) STRICT;
CREATE INDEX idx_publication_version_lecture ON publication_version(lecture_id);

-- Delta storage with STABLE item ids (§6.4, ADR-0004 §2.4). An item keeps id = deriveId(publication_id, author_item_id)
-- in every version; a row covers the versions [valid_from, valid_to) in which that content was current. Version n =
-- rows with valid_from <= n AND (valid_to IS NULL OR valid_to > n). A republish writes rows only for added or changed
-- items and closes rows of changed or removed ones; unchanged items cost nothing.
CREATE TABLE publication_item (
  publication_id TEXT NOT NULL,
  item_id TEXT NOT NULL,                             -- stable across versions
  valid_from INTEGER NOT NULL,                       -- first version_no with this content
  valid_to INTEGER,                                  -- first version_no without it (NULL = still current)
  entity_type TEXT NOT NULL CHECK (entity_type IN ('annotation','note','note_page')),
  content_hash TEXT NOT NULL,                        -- sha256 of the canonical row (anchor + data) — diff and integrity
  row_json TEXT NOT NULL,                            -- the canonical row, ink v2 packed points
  source_crop INTEGER NOT NULL DEFAULT 0 CHECK (source_crop IN (0,1)),   -- image cut from the official page («لقطة»)
  PRIMARY KEY (publication_id, item_id, valid_from)
) STRICT;
CREATE INDEX idx_publication_item_current ON publication_item(publication_id, valid_to);

-- «Suggest a correction or addition» without editing the author's work
CREATE TABLE suggestion (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,
  target_version_no INTEGER NOT NULL,
  suggester_user_id TEXT NOT NULL,
  layer_id TEXT NOT NULL REFERENCES annotation_layer(id),   -- kind 'suggestion': the proposed items
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','partially_accepted','rejected','withdrawn')),
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  accepted_item_ids_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_suggestion_publication ON suggestion(publication_id, status);

-- ═══ 3100_discussions.sql (discussions) ═════════════════════════════════════════════════════════════════════════
CREATE TABLE discussion_thread (
  id TEXT PRIMARY KEY,                               -- client ULID (offline drafting through the outbox)
  kind TEXT NOT NULL CHECK (kind IN ('question','comment')),
  lecture_id TEXT REFERENCES official_lecture(id),
  version_id TEXT REFERENCES source_version(id),
  anchor_json TEXT,                                  -- AnnotationAnchor (page_norm box / region / block) — same model as ink
  target_type TEXT CHECK (target_type IN ('lecture_page','region','publication_item','publication','recording_moment','room')),
  target_id TEXT,
  recording_ref_json TEXT,                           -- {recording_id, offset_ms} — «ربط النقاش بالتسجيل»
  audience TEXT NOT NULL CHECK (audience IN ('course','room','publication_audience')),
  audience_ref TEXT,                                 -- room id / publication id
  title TEXT,
  author_user_id TEXT NOT NULL,
  accepted_post_id TEXT,
  accepted_by TEXT,
  accepted_role TEXT CHECK (accepted_role IN ('question_author','moderator')),
  accepted_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','locked','hidden')),
  rev INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX idx_thread_lecture ON discussion_thread(lecture_id, version_id, created_at);
CREATE INDEX idx_thread_target ON discussion_thread(target_type, target_id);

CREATE TABLE discussion_post (
  id TEXT PRIMARY KEY,                               -- client ULID
  thread_id TEXT NOT NULL REFERENCES discussion_thread(id),
  parent_post_id TEXT REFERENCES discussion_post(id),   -- threaded replies
  author_user_id TEXT NOT NULL,
  body_json TEXT NOT NULL,                           -- RichText (no bidi control characters)
  helpful_count INTEGER NOT NULL DEFAULT 0,          -- denormalised from discussion_vote
  moderation_state TEXT NOT NULL DEFAULT 'visible' CHECK (moderation_state IN ('visible','hidden','removed')),
  rev INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                                 -- tombstone: «حُذف هذا الرد» keeps the thread readable
) STRICT;
CREATE INDEX idx_post_thread ON discussion_post(thread_id, created_at);

CREATE TABLE discussion_vote (
  post_id TEXT NOT NULL REFERENCES discussion_post(id),
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
) STRICT;

-- scope tokens: 'lec<id>' 'aud_course' | 'room<id>' | 'pub<id>' — the visibility filter goes INSIDE the MATCH (§11)
CREATE VIRTUAL TABLE community_fts USING fts5(
  entity_type UNINDEXED, entity_id UNINDEXED, scope, text,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ═══ 3150_collab.sql (collab) ═══════════════════════════════════════════════════════════════════════════════════
CREATE TABLE collab_doc (
  id TEXT PRIMARY KEY,
  layer_id TEXT NOT NULL UNIQUE REFERENCES annotation_layer(id),   -- kind 'collaborative'
  lecture_id TEXT REFERENCES official_lecture(id),
  lecture_version_id TEXT REFERENCES source_version(id),
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('invited','course','room')),   -- 'course' only by a subject moderator
  snapshot_blob BLOB,                                -- Y.mergeUpdates of compacted updates
  snapshot_state_vector BLOB,
  projection_state_vector BLOB,                      -- state the annotation projection was built from
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
) STRICT;

-- Every update is DECODED and VALIDATED in a worker against the current doc before it is accepted (ADR-0004 §2.3.6):
-- schema of every inserted or replaced item, size caps, created_by = the uploading actor for inserted items, and every
-- Yjs clientID in the update bound to (doc, author, device) in collab_client. Invalid updates are kept in quarantine,
-- never applied, never relayed, and reported to the doc's moderators.
CREATE TABLE crdt_update (
  id TEXT PRIMARY KEY,                               -- sha256 hex of `bytes` (= idempotency key)
  doc_id TEXT NOT NULL REFERENCES collab_doc(id),
  author_user_id TEXT NOT NULL,                      -- the session's user (or the verified origin of a relay bundle)
  device_uid TEXT NOT NULL,                          -- server-issued device id
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  seq INTEGER NOT NULL,                              -- arrival order (per doc)
  state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted','quarantined')),
  reject_reason TEXT,                                -- quarantined: schema | size | foreign_created_by | foreign_client_id | decode_error
  compacted_into TEXT,                               -- snapshot marker once folded
  received_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_crdt_update_doc ON crdt_update(doc_id, seq);

-- a Yjs clientID belongs to exactly one (user, device) per doc; first use binds it; any other user's update using it is
-- quarantined (duplicate clientIDs make replicas diverge)
CREATE TABLE collab_client (
  doc_id TEXT NOT NULL REFERENCES collab_doc(id),
  client_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  device_uid TEXT NOT NULL,
  bound_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, client_id)
) STRICT;

-- ═══ 3200_rooms.sql (rooms) ═════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE study_room (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('silent','group','teaching','exam')),
  title TEXT NOT NULL,
  subject_node_id TEXT NOT NULL,
  lecture_id TEXT REFERENCES official_lecture(id),
  lecture_version_id TEXT REFERENCES source_version(id),   -- everybody studies the same base version
  host_user_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('course','invited')),
  settings_json TEXT NOT NULL,                       -- pomodoro, navigation (group|independent), write policy, max participants, break alerts
  collab_doc_id TEXT REFERENCES collab_doc(id),      -- shared board (group / teaching)
  exam_definition_json TEXT,                         -- exam rooms: frozen items (question_version ids) + policy (timing, solutions hidden until end)
  created_at INTEGER NOT NULL,
  closed_at INTEGER
) STRICT;

CREATE TABLE room_session (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES study_room(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  clock_origin TEXT NOT NULL CHECK (clock_origin IN ('server','host_device')),
  recording_id TEXT,                                 -- audio_recording in this space, only with every participant's consent
  offline_origin INTEGER NOT NULL DEFAULT 0 CHECK (offline_origin IN (0,1))   -- created on devices (nearby) and uploaded later
) STRICT;

CREATE TABLE room_participant (
  session_id TEXT NOT NULL REFERENCES room_session(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('host','writer','viewer')),
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  progress_share_consent_id TEXT,                    -- silent rooms: opt-in summary sharing
  recording_consent_id TEXT,                         -- required before a recorded session includes this participant
  PRIMARY KEY (session_id, user_id)
) STRICT;

CREATE TABLE room_event (
  id TEXT PRIMARY KEY,                               -- client ULID; append-only; sync entity 'room_event'
  session_id TEXT NOT NULL REFERENCES room_session(id),
  author_user_id TEXT NOT NULL,
  t_ms INTEGER NOT NULL,                             -- offset on the session clock
  kind TEXT NOT NULL CHECK (kind IN ('join','leave','page_follow','hand_raise','hand_lower','question','write_grant',
                                     'write_revoke','timer','break','exam_start','exam_end','recording_start','recording_stop')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_room_event_session ON room_event(session_id, t_ms);

-- store-and-forward intake (ADR-0005 §A.4): one row per relay bundle; dedupe by (origin user, server-issued device id, seq)
CREATE TABLE relay_receipt (
  bundle_id TEXT PRIMARY KEY,                        -- sha256 of the canonical bundle bytes
  room_id TEXT,
  origin_user_id TEXT NOT NULL,
  origin_device_uid TEXT NOT NULL,                   -- server-issued, globally unique (system device.device_uid)
  origin_seq INTEGER NOT NULL,
  credential_id TEXT NOT NULL,                       -- the server-signed offline room credential the bundle was made under
  uploaded_by_user_id TEXT NOT NULL,                 -- may be a relay
  verified INTEGER NOT NULL CHECK (verified IN (0,1)),
  result TEXT NOT NULL CHECK (result IN ('applied','partially_applied','rejected')),
  detail TEXT,
  received_at INTEGER NOT NULL,
  UNIQUE (origin_user_id, origin_device_uid, origin_seq)
) STRICT;

-- ═══ 3300_scoped_fts.sql (search) ═══════════════════════════════════════════════════════════════════════════════
-- Contentless index (text is read back from document_chunk by rowid). Scope tokens make Source Lock part of the MATCH
-- (measured 8.1–13.8 ms vs 85.8–241.9 ms post-filter over 246k chunks, identical results; ADR-0003 §2).
CREATE VIRTUAL TABLE chunk_scope_fts USING fts5(
  text, heading_path, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER chunk_scope_fts_ai AFTER INSERT ON document_chunk BEGIN
  INSERT INTO chunk_scope_fts(rowid, text, heading_path, scope)
  VALUES (new.rowid, ml_norm(new.text), ml_norm(coalesce(new.heading_path, '')), 'v' || new.version_id || ' s' || new.source_id);
END;
CREATE TRIGGER chunk_scope_fts_ad AFTER DELETE ON document_chunk BEGIN
  DELETE FROM chunk_scope_fts WHERE rowid = old.rowid;
END;
-- (update trigger mirrors 0200's chunk_fts_au; the same Arabic normalisation as chunk_fts)
```

### 4.5 Web local database (`apps/web/src/lib/localdb.ts`)

* **Name.** `LOCAL_DB_NAME` becomes `medlevo:<userId>`. The legacy `medlevo` database is claimed only by user #1
  (ADR-0003 §5, step 7).
* **New `LOCAL_SCHEMA` entries** (appended, never edited):
  * `layers` — `annotation_layer` rows;
  * `crdtUpdates` — `[docId+seq]`, with unsent updates flagged;
  * `relayBundles` — outgoing and incoming, `[roomId+originDevice+originSeq]`;
  * `timelineEvents`, `studyTime`;
  * `spaceCursors` — the pull cursor and epoch **per DB**;
  * `deviceKeys` — a non-extractable Ed25519 key where WebCrypto supports it, else a JS fallback stored encrypted
    (DOC: WebCrypto Ed25519 support differs by browser; probe first).
* **Outbox rows** gain `target: 'vault' | 'space:<id>'`. One outbox per user, with ordered delivery per target.
* **Logout guard.** `lib/auth.ts`: the outbox of the user who logged out is frozen and never pushed under another
  session. «Clear this device» deletes `medlevo:<userId>` and the user's `localStorage` keys.
* **Every `localStorage` key is per user** (`<userId>:` prefix through one `lib/userStorage.ts` helper). Inventory by
  grep on 2026-10-20 — 13 non-test files: `design/ThemeProvider.tsx`, `features/cases/CaseRunner.tsx`,
  `features/cases/CaseEditor.tsx` (case drafts), `features/library/useLibrary.ts` (sort), `features/workspace/panels/MineTab.tsx`,
  `features/workspace/ink/prefs.ts`, `features/workspace/data/noteDrafts.ts` (crash-recovery note drafts),
  `features/workspace/WorkspaceScreen.tsx` (back stack), `features/workspace/notebook/NotebookScreen.tsx`,
  `lib/settings.ts` (pending settings), `lib/capabilities.tsx`, `lib/auth.ts`, `lib/deviceId.ts`. A lint rule bans raw
  `localStorage` outside the helper. Theme may stay device-wide by choice; everything else is per user.
* **Drafts belong to their writer.** `app/layouts.tsx` runs `recoverNoteDrafts(getDb())` on every signed-in mount, and
  `noteDrafts.ts` turns every `medlevo.note-draft.*` backup into a saved note plus an outbox op in the *current*
  database. Drafts are tagged with the user id when written and recovered only for that user; untagged legacy drafts are
  recovered only by the legacy owner (user #1).
* **Old clients are refused.** Every request carries `x-medlevo-client: <app version>`. Today's build sets
  `registerType: 'prompt'`, `skipWaiting: false`, `clientsClaim: false` (`vite.config.ts`) and sends no version, so a
  pre-upgrade tab can keep running and push the owner's single-database outbox under someone else's session. The server
  answers `426 CLIENT_TOO_OLD` to a request without the header or below the multi-user version for every user except the
  legacy owner's own sessions (whose outbox is theirs anyway), and the first multi-user sign-in forces the service-worker
  update (`updateServiceWorker(true)` after the outbox of the previous user is frozen).

## 5. Permission model

### 5.1 Principals and roles

| principal | how obtained | scope |
|---|---|---|
| **platform admin** | `user_account.is_platform_admin` (user #1 after migration) | the whole deployment: creates universities, assigns channel Admins, sets quotas, runs the platform operations of §5.8. **No product route reads a vault.** That is a property of the application, not of the host: whoever operates the server (Render shell, disk, backups) can technically reach every file, and the privacy page says so in Arabic (PRD NFR-S3); backups leave the host only encrypted |
| **Admin** | `role_assignment(role='admin')` on a node | that node's subtree: nodes, codes, invitations, join approvals, role assignment below Admin, scoped audit and statistics, plus every moderator power |
| **Assistant** | `role_assignment(role='assistant')` | subtree: join approvals, codes and invitations, moderation (hide, restore, request changes, decide reports); **not** «راجعه مشرف المادة»; no node deletion, no role assignment |
| **Subject Moderator** | `role_assignment(role='subject_moderator')` on a subject (or above) | official lectures (approve, publish versions, correct, withdraw), page-map review, moderation of publications, discussions and reports, accepting answers, «reviewed by a moderator» marks, course-wide collaborative copies, duplicate review |
| **Contributor** | `role_assignment(role='contributor')` | uploads official lecture **drafts** and proposes corrections to official lectures; a moderator approves both |
| **Student (member)** | approved `channel_membership` on the node or an ancestor | read published official content; Start Studying; publish explanations; discuss; vote; rate; report; create silent and group rooms, and teaching and exam rooms for an invited audience |
| **author** | owns the resource (`author_user_id`) | edit and withdraw own publications, threads and posts; decide suggestions on own publications; accept answers in own question threads |
| **grantee** | `acl_grant` | the granted permission on one resource |
| **follower** | active `follow` (scoped or not) | sees `followers` publications of the followee (in that subject when scoped) |
| **signed-in user** | any active `user_account` | sees `public` publications (PRD Q2), redacted as in §5.2, and public profile fields; cannot rate |
| anonymous | none | only today's `PUBLIC_ROUTES` + registration |

Roles **inherit down the tree** (`channel_closure`). A role on a university applies to every subject under it.
Membership inherits the same way.

### 5.2 Visibility scopes

| scope | who sees it | applies to |
|---|---|---|
| `private` (default) | only the owner: the data stays in the vault | everything a user creates (layers, notes, uploads, recordings, cards, attempts, plans) |
| `specific_users` | `acl_grant` grantees | publications, collaborative copies, recording shares, rooms |
| `followers` | active followers, or scoped followers when the publication's subject matches | publications |
| `course` | approved members of the publication's subject (or of an ancestor node) | publications, discussions, rooms, official lectures (`published`) |
| `public` | every signed-in user of the deployment | publications only |

**Rights of the official file.** An explanation's audience never widens access to the **official lecture file**:

* `official_files: 'members_only'` is the default in `channel_node.rights_json` (PRD Q5).
* A non-member who opens a `public` explanation sees the explanation's items over page placeholders that show the page
  labels, plus the reason «الملف الأصلي متاح لأعضاء المادة فقط» (the original file is for subject members only).
* **Items are redacted for viewers without access to the lecture**, because items can carry the official page's text:
  text-highlight anchors hold `TextQuote {exact, prefix, suffix}` copied from the page (`packages/shared/src/annotations.ts`),
  and «انسخ لقطة» puts printed page content into image annotations. For a `guest_publication` binding (and any viewer
  who is not a member of the lecture's subject) `publications/:id/versions/:n/items` serialises items **without**
  `anchor.quote`, highlight `quote` or `region_ids` text, and omits image items with `source_crop = 1` (replaced by a
  placeholder «صورة من الملف الأصلي — لأعضاء المادة»). Text the author typed stays (it is the author's own work; the
  publish preview reminds authors not to paste slide text into public explanations). AC-01b and X9 assert it.

### 5.3 Resources × actions × roles (server-enforced)

Legend: ✓ allowed · A = author of the resource only · M = only after a moderator's approval · — = denied.
Columns: S = student, C = contributor, Mod = subject moderator, As = assistant, Ad = admin, PA = platform admin.

| resource : action | S | C | Mod | As | Ad | PA |
|---|---|---|---|---|---|---|
| channel node: create / edit / archive | — | — | — | — | ✓ (subtree) | ✓ |
| join code / invite link: create / revoke | — | — | — | ✓ | ✓ | ✓ |
| membership: approve / reject / remove | — | — | — | ✓ | ✓ | ✓ |
| role: assign / revoke | — | — | — | — | ✓ (below Admin) | ✓ |
| official lecture: upload draft | — | ✓ | ✓ | — | ✓ | ✓ |
| official lecture: approve / publish version / withdraw / correct | — | M (propose) | ✓ | — | ✓ | ✓ |
| official lecture (published): view / Start Studying | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| publication: create (publish) in subject | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| publication: edit / republish / withdraw | A | A | A | A | A | A |
| publication: hide / restore / request changes | — | — | ✓ | ✓ | ✓ | ✓ |
| publication: mark reviewed («راجعه مشرف المادة») | — | — | ✓ | — | only with a Subject Moderator role there | only with a Subject Moderator role there |
| publication: view | per visibility (§5.2) | ← | ← | ← | ← | ← |
| publication: fork / follow / like / save / comment | if it can view (comment: course members or grantees with `comment`) | ← | ← | ← | ← | ← |
| publication: rate | approved member of its subject for ≥ 7 days who opened its items (§7.8); never a non-member | ← | ← | ← | ← | ← |
| suggestion: create | if it can view the publication | ← | ← | ← | ← | ← |
| suggestion: accept / reject | A (publication author) | A | A | A | A | A |
| discussion thread / post: create | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| discussion: edit / delete own | A | A | A | A | A | A |
| discussion: accept answer | A (question author) | A | ✓ | ✓ | ✓ | ✓ |
| discussion: hide / lock / remove | — | — | ✓ | ✓ | ✓ | ✓ |
| collaborative copy: create (invited) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| collaborative copy: create (course-wide) | — | — | ✓ | ✓ | ✓ | ✓ |
| collaborative copy: write | grantee `edit` / room `writer` | ← | ← | ← | ← | ← |
| room: create silent / group | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| room: create teaching / exam | ✓ (invited audience) | ✓ (invited audience) | ✓ (course) | ✓ | ✓ | ✓ |
| room: grant / revoke write, end, start recording | host | host | host | host | host | host |
| recording share to subject | A + consents (§5.6) | ← | ← | ← | ← | ← |
| reports: create (Phase 1) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| reports: decide (Phase 1: hide / restore / dismiss) | — | — | ✓ | ✓ | ✓ | ✓ |
| subject attachment / exam date: publish | — | d (approval) | ✓ | — | ✓ | ✓ |
| platform operations (§5.8) | — | — | — | — | — | ✓ |
| scoped audit / usage statistics | — | — | own subject (aggregates) | subtree | subtree | all |
| quotas | own (view) | own | own | own | own | set for anyone |
| **any user's vault content** | — | — | — | — | — | — (no route; the binding hook only binds the session's own vault) |

Every moderator power applies **to one subject**: the binding for `/api/spaces/:s` computes the role on that subject
node (or an ancestor), so a Subject Moderator of A has no power in B.

### 5.4 Layer-level permissions

| layer kind | read | write | copy out | notes |
|---|---|---|---|---|
| personal / answers / explanation / forked | owner's devices | owner | owner | vault only |
| followed | follower | **server only** (updates feed) | follower (into own layers, attribution kept) | an op on it is `rejected` / `layer_read_only`, and the client re-homes the item (ADR-0004 R2) |
| published_snapshot | per publication visibility | nobody (frozen) | viewers who may fork | |
| group_comments | course members (or room) | each member, own items only | members | |
| suggestion | suggester + publication author (+ moderators) | suggester, own items | the author, when accepting | |
| collaborative | grantees (`view`+) / room participants | grantees with `edit` / room `writer` | readers | writes only through `crdt_update` |

The ink engine applies the same table on the client through the N1 seams (visibility and editability predicate in
render, hit-test, eraser and lasso). The server remains the authority.

### 5.5 Enforcement points (one policy, many gates)

```ts
// apps/server/src/modules/authz/policy.ts — the ONLY place that decides
export type Action =
  | 'view' | 'list' | 'create' | 'edit' | 'delete' | 'publish' | 'approve' | 'withdraw' | 'moderate'
  | 'fork' | 'follow' | 'comment' | 'suggest' | 'vote' | 'rate' | 'write_layer' | 'manage_members' | 'manage_codes'
  | 'assign_role' | 'record' | 'share_recording' | 'view_audit' | 'view_stats' | 'set_quota';
export type Resource =
  | { type: 'channel_node'; id: string }
  | { type: 'space'; id: string }
  | { type: 'official_lecture'; spaceId: string; id: string; status: string; subjectNodeId: string }
  | { type: 'publication'; id: string }                     // loaded from the system index
  | { type: 'layer'; db: string; id: string; kind: LayerKind; ownerUserId: string | null }
  | { type: 'discussion'; spaceId: string; threadId: string; audience: string; audienceRef: string | null }
  | { type: 'collab_doc'; spaceId: string; id: string }
  | { type: 'room'; spaceId: string; id: string }
  | { type: 'recording'; db: string; id: string }
  | { type: 'file'; db: string; fileId: string };
export interface Decision { allowed: boolean; reason?: { code: ErrorCode; messageAr: string; hide: boolean } }   // hide → 404
export interface Authz {
  can(viewer: Viewer, action: Action, resource: Resource): Decision;   // synchronous (system DB reads are sync)
  assert(viewer: Viewer, action: Action, resource: Resource): void;    // throws AppError (404 when hide, else 403)
  visibilityKeys(viewer: Viewer, spaceId: string): string[];           // for sync pull and FTS scope tokens (§8.4, §11)
}
```

| # | gate | what it checks |
|---|---|---|
| 1 | guard (`auth/guard.ts`) | session → viewer (`user_id` from the session, never from the request) |
| 2 | binding hook | `/api/*` binds the viewer's **own** vault. `/api/spaces/:id/*` binds only (a) a route on the allow-list below, (b) for a viewer with an approved membership or a role on **the subject node that owns that space** (or an ancestor), at the route's minimum access, or `guest_publication` for public publication reads. Anything else is `404` |
| 3 | repositories | every system and space repository method that returns shared rows takes `viewer` and calls `authz` |
| 4 | SQL filters | search (scope tokens inside `MATCH`), sync pull (`visibility_key IN (…)`), feed and marketplace queries (visibility predicates **before** ordering and limiting) |
| 5 | files | a token encodes `{db, file_id, user_id, exp}`. `GET /api/files/:id` resolves only in the bound DB. `listen_only` recordings get a Range stream but no download token — a **social control** (the UI offers no download), not a technical one: a stream can be saved, and the UI says «استماع فقط» rather than promising protection |
| 6 | jobs | the job index stores `db_id` and the actor. Cross-DB copy jobs re-check `authz` when they run, not only when they are enqueued |
| 7 | AI | scope resolution (`evidence/scope.ts`) takes the viewer; cache keys include the viewer scope hash (§10.6) |
| 8 | realtime | WebSocket `subscribe` re-checks `authz`. A membership or ACL revocation pushes `revoked` and closes the subscription |
| 9 | P2P | peers enforce room roles; the server re-verifies signature, membership and layer permission when a relayed bundle is uploaded (§8.6) |

**Space-route allow-list (gate 2).** Existing modules run unchanged against a space only through these routes; any
route not listed is never mounted under `/api/spaces/:s`. The list is a constant in `authz/spaceRoutes.ts`, and a test
enumerates Fastify's route table and fails on any unlisted space route.

| existing module | mounted under `/api/spaces/:s`? | routes | minimum access (in **this** subject) |
|---|---|---|---|
| `sources` (read) | yes | `GET` source, versions, pages, regions, page images, outline; `GET /files/:id` and `POST /files/:id/token` for official files | member (published versions only; drafts: moderator) |
| `sources` (write: upload, rename, metadata, purge) | **no** — replaced by `lectures` routes (upload, approve, publish, withdraw); a purge is a platform job that first checks `lecture_copy` (§6.3) | — | — |
| `processing` | partly | `GET` status and progress; `POST` re-process | read: moderator · re-process: moderator |
| `control` corrections | **no** — replaced by `lectures/:id/corrections`, which create a new version for published versions (§6.7) | — | — |
| `questions` (the subject's official bank) | yes | `GET` list, detail, keys; writes | read: member · write: moderator |
| `brain` (Course Brain of the subject) | yes | `GET` concepts, relations, maps; corrections | read: member · corrections: moderator |
| `studybook` (shared official-only artifacts) | read only | `GET` shared artifacts; generation happens only from a vault-bound request whose scope is official-only (§10.6) | member |
| `annotations` (space layers) | sync only | items of `group_comments` and `suggestion` layers through the space sync push/pull (author-only edits) | member |
| `media` (shared official recordings) | read only | `GET` recordings, transcripts, stream (listen-only per scope) | member, per the recording's share scope |
| `data` (export, `/export/all`, backups, restore, offline packages), `settings`, `control` (storage, AI, evaluation, health, client errors, jobs), `auth`, `library`, `learning`, `exams`, `cases` | **never** | official offline packages come from `lectures/:id/offline-package` instead | — |

New space modules (`lectures`, `forks` publications, `discussions`, `collab`, `rooms`, `timeline`) declare their routes
in the same list with their minimum access.

**404 vs 403.**

* Anything the viewer may not **see** answers `404 NOT_FOUND`, with the same body as a missing id, so existence never
  leaks.
* `403 FORBIDDEN` is used only when the viewer can see the resource but not perform the action. Example: a student
  trying to approve a lecture they can read.
* A pending membership answers `403` with `MEMBERSHIP_PENDING`.

### 5.6 Consent rules (recordings, rooms, progress)

| action | consents required (rows in `consent_record`) |
|---|---|
| record for oneself (today's feature) | none beyond today's explicit start and visible indicator; local processing on the deployment (server-local ASR, the deterministic radar) needs nothing more, because nothing leaves the deployment |
| share a recording or its transcript with a subject, followers or named users | **both**: the subject's `lecturer_recording_policy` allowing that scope (attested by a Subject Moderator from the lecturer's written or recorded agreement; its `scope_json` records the allowed scopes, whether external processing is allowed, and that a notice is shown in the hall) **and** the recorder's `recording_share` for that share (PRD Q8). A recording outside any subject needs the recorder's `recording_attestation` per recording instead of the policy |
| send lecture audio, or a transcript of it, to an external provider (cloud ASR, or an LLM in the copilot, radar AI, summaries, fusion) | the subject's lecturer policy must allow external processing (or, outside any subject, the recorder's attestation), **and** the user's own `cloud_asr` / `ai_processing` consent naming the provider. Without them the feature is disabled with the reason «لا تسمح سياسة المادة بمعالجة التسجيل خارج المنصة» |
| send my private notes, handwriting crops or my transcripts to an AI provider under the deployment's key | `ai_processing` by the user, naming the providers (shown on `/me/privacy`, revocable); AI features that need it are disabled with the reason until it exists |
| record a room session | `room_recording` from **every** participant present. Late joiners are asked first; anyone who declines leaves the recording or blocks it (host's choice, stated in the UI) |
| show my progress in a silent room | `progress_share`, per room, revocable; a summary only, never raw data |
| relay other students' bundles | `relay_participation` (ADR-0005 §A.4) |

A revoked consent stops further distribution at once. Copies already downloaded on other devices are a documented
limit, never a claim of erasure.

### 5.7 Permission tests (all runnable here)

A generated matrix test covers **each resource type × each action × each role, visibility and membership state**. It
asserts allow or deny, and 404 vs 403. Further tests:

* `AC-01b` leak suite (§15): two users in **two subjects of two universities** in one deployment; private data never
  visible through any route, pull, search, export, file or AI path; a moderator of subject A gets nothing of subject B;
  a non-member reading a public explanation gets no quote or source crop of the official page.
* Space-route allow-list test: Fastify's route table has no unlisted route under `/api/spaces/:s`.
* Platform-operation cases (§5.8): every route in that table answers `404` for every role except the platform admin,
  including the existing `/api/data/backups*`, `/api/data/export/all` and the AI, evaluation, health and client-error
  routes.
* Revocation tests: unfollow, membership removal, ACL revoke, room kick; gaining access backfills (§8.4).

### 5.8 Operational features: per user or platform admin only

Today's single-owner features act on the whole deployment in several places. With many users, each Control Center
section and each data route is either **per user** (it reads and writes only the bound vault) or a **platform
operation** (platform admin only, mounted under `/api/platform/…` or guarded in place). Nothing here is ever mounted under
a space. PRD §15 rows 48, 56, 57 and 61 follow this table.

| today (module · route or Control Center section) | after | why |
|---|---|---|
| Control Center «مراجعة» review queue, alerts (`content_alert`), sync conflicts | per user | vault data |
| «المصادر والأولويات» source priority; explanation rules defaults | per user | vault settings |
| «التخزين ودون اتصال» (`control/storage.ts`) | per user, **rescoped**: today it walks `filesDir` and `DATA_DIR/backups` for the whole instance; it becomes «blobs my vault references (deduplicated) + my offline downloads» | otherwise every user would see deployment-wide sizes and backup counts |
| «الذكاء الاصطناعي»: status, usage of *my* allowance | per user | |
| «الذكاء الاصطناعي»: provider key, models per role, deployment budget, model-change preview | platform admin | one deployment configuration |
| «المعالجة»: my jobs (my uploads, my transcriptions) | per user (filtered by `job_index.db_id` = my vault) | |
| «المعالجة»: the global queue, retry/cancel of others' jobs | platform admin (subject moderators see their space's jobs) | |
| «القدرات» | per user view (consent, quota, device) of the global registry | |
| «السجل» history (`change_log`) | per user | vault data |
| «تقييم الجودة» evaluation runs (`/api/control/evaluation*`, `npm run eval`, ASR evaluation of ADR-0006) | platform admin | global tables, deployment cost |
| «صحة النظام» health (`/api/control/health`) | platform admin | deployment metrics |
| client errors (`/api/control/client-errors`) | `POST` per user (own errors, rate-limited); `GET`/`DELETE` platform admin | global sink |
| `data`: `GET/POST /backups`, `/backups/:id`, `/verify`, `/download`, `DELETE /backups/:id` (`data/index.ts`), `npm run backup` / `restore` | platform admin (whole instance); a user gets **«نسخة من بياناتي»** = per-vault export instead | `data/backups.ts` keeps one `DATA_DIR/backups` for the instance |
| `data`: `GET /export/all` (`exportAll` = `SELECT *` per table) | platform admin; users get `POST /api/accounts/me/export` (own vault + own publications) | |
| `data`: per-format exports of my sources, notes, questions; offline packages of my sources | per user | vault data |
| per-vault and per-space restore | platform admin (a user can request a restore of their own vault; the admin runs it) | restores move files |

Tests: the authz matrix gains one row per platform route × role (all `404` except the platform admin), and one per-user
route test showing that user A's Control Center never reports user B's numbers (storage, jobs, alerts, history).

## 6. Fork graph, layers, versions and anchors

### 6.1 Identities

```
system   publication P ──(index: author, visibility, head n)──────────────┐
           ▲ publication_copy (who forked / follows P, for fan-out)        │
space S  official_lecture L ── source ── source_version v1 ─┬─ v2 (+ version_page_map v1→v2)
                                                             │
         publication_version P@1 … P@n ─ frozen annotation_layer ─ annotation rows (snapshot items)
         suggestion ─ suggestion layer ─ items          collab_doc ─ crdt_update* ─ projection rows
vault U  source (stub of L, same ids as S) ── document_copy(mode) ─┬─ personal layer        (op-log, U only)
                                                                    ├─ forked layer (P@k)    (op-log, U only, attributed)
                                                                    └─ followed layer (P@head, read-only, server feed)
```

* **Lecture identity** = `official_lecture.id`. It survives file renames and re-uploads, because a re-upload is a new
  `source_version` of the same `source`.
* **Spotting a likely new version.** When an upload's page fingerprints match ≥ 60 % of an existing lecture's pages,
  the moderator is offered «هذا إصدار جديد من المحاضرة X؟» (is this a new version of lecture X?) through the review
  queue (§19H). It is never applied automatically.
* **Vault stubs** reuse the space's `source`, `source_version` and `source_page` ids (ADR-0003 §3.3).
  `annotation.anchor_json` therefore names the same `version_id` and `page_id` in the vault and in the space. A
  publish copy and a fork copy need **no anchor rewriting**.

### 6.2 Page mapping between versions (Scenario 4)

When `POST /lectures/:id/versions/:versionId/publish` runs, it enqueues `page_map(from = previous head, to = new)`:

1. **Fingerprints.** `page_fingerprint` for every page of both versions: normalised text hash, MinHash, thumbnail dHash.
2. **Candidates.** Each page's candidates are pages with an identical text hash, MinHash Jaccard ≥ 0.85, or dHash
   distance ≤ 6/64 for pages without text.
3. **Order-preserving alignment.** Matches are aligned like a longest-common-subsequence over page order, so inserted
   pages (Scenario 4), removed pages and moved blocks resolve to one counterpart each. A page with two near-equal
   candidates is `uncertain`.
4. **Status.** Each pair gets one of:
   * `safe` + `layout_safe = 1`: identical text hash, or dHash ≤ 6. Normalised coordinates may be reused.
   * `safe` + `layout_safe = 0`: same text, re-laid-out. Text-anchored items may move; ink may not.
   * `uncertain`, or `none`.
5. **Moderator confirmation.** The moderator sees the map (thumbnails side by side, AOS-3.12) and can confirm or reject
   pairs (`method = 'moderator'`).

Thresholds are versioned in `algo` and tuned on Golden Set fixtures before release. The numbers above are starting
points, not measured results.

### 6.3 Re-anchoring personal notes on a new official version — copy, never move

When a new official version is published, the fan-out job reads the system `lecture_copy` index (never a scan of
vaults) and gives each vault holding a copy of L a version stub, a `content_alert` (existing, `source_replaced`) and the
action «انقل ملاحظاتي إلى الإصدار الجديد» (move my notes to the new version), with a preview of what will move. It runs
automatically only if the user enabled «انقل ملاحظاتي تلقائيًا» (PRD Q35). The job
`reanchor_copy(source_id, from_version, to_version)` runs in the vault and refreshes that user's `lecture_copy` rows:

| item kind | copied to the new page when | how |
|---|---|---|
| ink, shape, text box, sticky, image, link (page anchor) | the page map is `safe` **and** `layout_safe = 1` (or confirmed) | same normalised coordinates on the new `page_id` |
| text highlight / underline | the page is `safe` (any layout) **and** the quote is found again on the new page (exact match + prefix/suffix, the existing `TextQuote` model) | new rectangles from the new page's region boxes |
| bookmark, page-anchored note | the page is `safe` | page anchor only |
| Study Book block anchors | — | the existing `computeReanchor` (`studybook/book.ts`, AC-22), unchanged |

**Invariants** (each with a test):

1. **The original item is never changed.** It stays on the old version and remains visible when that version is
   opened. Copies get:
   * a **deterministic id**, `deriveId(old_id, to_version_id)`, so retries and a second device never duplicate;
   * `migrated_from_id = old_id`, `previous_anchor_json = old anchor`, `anchor_status = 'reanchored'`,
     `origin = 'reanchor_copy'`;
   * the **same layer** as the original. A followed layer is never re-anchored by the follower: it follows the
     author's republish.
2. **Items that cannot be copied safely are not guessed.** They are listed in «تحتاج مراجعة» (needs review), which
   extends today's needs-reanchor list (`GET /annotations/needs-reanchor`), with the old place shown. The user can:
   * «انقل يدويًا» (move manually): pick the target page or region. Round 7 (H3-2) shipped a manual re-anchoring UI and
     route for one version (`POST /api/annotations/reanchor`, `ReanchorSection.tsx`, migration `0290_reanchor`); the
     cross-version review list **reuses** it, with one difference: on a new official version the result is a **copy**
     on the new version (the original stays on the old one), never a move;
   * «اتركها على الإصدار السابق» (leave it on the earlier version).
3. **Report.** Before and after: «نُقل 41 عنصرًا إلى 12 صفحة؛ 6 تحتاج مراجعتك؛ 3 بقيت على الإصدار السابق» (41 items
   moved to 12 pages; 6 need your review; 3 stayed on the earlier version).
   * Undo tombstones the copies only.
   * Citations, evidence, Source Lock pins and artifacts stay on their versions. Content alerts and
     `artifact_dependency` handle them as today.
4. **Other people's actions never delete personal notes.** Withdrawing or deleting an official lecture in a space never
   touches vaults; they are different files. ⚠ BREAK fixed: today's purge deletes annotations on purged pages. In a
   space it now deletes only space rows.
   * A withdrawal notifies stub holders, found through `lecture_copy`.
   * The stub, its pages and the user's items stay readable, unless the withdrawal reason is `rights_takedown`. In that
     case the job, per vault and in one transaction: (1) sets `source_version.file_id` and `original_file_id` of the
     **stub** rows to `NULL` — they `REFERENCES stored_file(id)` (`0001_core.sql`) and `foreign_keys = ON`, so the delete
     would otherwise fail; stub rows are server-maintained copies, not the user's content; (2) deletes the vault's
     `stored_file` rows for the official blobs; (3) decrements the `blob_ref` hint. The mark-and-sweep GC removes the
     bytes later. Ink and notes stay, over placeholders that state the reason.
   * **Purge of an official version** is refused while `lecture_copy` shows personal items on it (a count, never names);
     otherwise it deletes only space rows.

### 6.4 Publications: immutable snapshots and a live head

1. **Publish.** `POST /api/spaces/:s/publications` with `{lecture_id, layer_ids (author's vault layers), title, kind,
   visibility, …}`. The server:
   * checks that every item is anchored on an **official** version page of L (or on the author's note pages inserted
     into L, which are copied as `note_page` rows). Notes written on a *private* upload of the same file become eligible
     after «اربط بالمحاضرة الرسمية» (§6.9) has copied them onto the official version;
   * checks size limits, and consent records for voice explanations;
   * shows a «لا معرّفات مرضى» reminder (no patient identifiers; old §49 rule) — a reminder only, not a detector;
   * runs the copy job. Its idempotency key is the hash of the user, the layer ids and the layer revs. The job:
     * computes each item's **stable id** `deriveId(publication_id, author_item_id)` — the same in every version;
     * diffs the author's items against the head (`publication_item` rows with `valid_to IS NULL`, compared by
       `content_hash`) and writes rows **only** for added or changed items, closing (`valid_to = n`) the rows of changed
       and removed ones; an unchanged item costs nothing;
     * writes `attribution` rows;
     * writes `publication_version` with the version's `content_hash` (over the canonical item list) and the
       completeness counts;
     * upserts the system `publication` index (`head_version_no`);
     * notifies followers and copy holders (§12).
2. **Live head.** `publication.head_version_no` is the head. Versions never change: version *n* is the set of
   `publication_item` rows valid at *n*. A republish with the same `content_hash` as the head is a no-op that returns
   the head.
   * **Followed copies apply the diff** (ADR-0004 §2.4): changed items are upserted under their stable id (rev + 1, with
     an `annotation_revision` before-image), removed items are tombstoned, unchanged items are untouched. Every follower
     note, link, card, recognition row or timeline reference to an unchanged item therefore keeps its target, and a
     one-stroke change moves one stroke's bytes, not the whole layer.
   * **Forks** copy version *k* once with fork-local ids `deriveId(document_copy_id, item_id)` and never change again.
   * **Reads** (`…/versions/:n/items`) return the items valid at *n*, redacted for viewers without lecture access
     (§5.2), in ink v2 for clients that send `accept-ink: 2`.
3. **Withdraw.** The publication leaves listings and searches. Existing forks keep their copies, and followed copies
   stop receiving updates and say why.
4. **Student content is never evidence.** It is labelled «شرح طالب — ليس مصدرًا» (a student's explanation — not a
   source). Retrieval for AI claims never turns it into `evidence` rows. With explicit consent of the asking user it
   can be shown as low-assurance context, like `my_notes` today (§10.5).

### 6.5 Copy modes created by «Start Studying» (§2) and the marketplace (§5)

| mode | creates in the vault | updates |
|---|---|---|
| personal (blank) | stub (if absent) + personal layer + `document_copy(mode='personal')` | official versions: §6.3 |
| independent fork of P@k | the above + `forked` layer (writable, copy of P@k items, attribution) + system `publication_copy(independent)` | never from P; official versions: §6.3 on all owned layers |
| followed copy of P | the above with a `followed` layer (read-only, stable item ids) + `publication_copy(followed)` | P's republish → preview → apply the diff (ADR-0004 §2.4); the personal layer is untouched |
| collaborative | stub + personal layer + `document_copy(mode='collaborative', collab_doc_ref)` | the CRDT doc in the space; the user's private notes stay in the personal layer next to it |

Offline: a student whose lecture was downloaded can create a personal copy offline (client ULIDs). Forks and follows
need the server once to copy the snapshot.

### 6.6 Layer operations

* **Show or hide** any layer per session (`study_session.location_json.layers`). The renderer filters through the
  visibility predicate. Budget: the docs/PERFORMANCE.md 5,000-stroke page still passes with 5 layers.
* **Copy a layer, or merge several** (AOS-4.11 — Phase 1: copy **one** personal layer between copies of the same
  lecture, the «انقل ملاحظاتي من نسختي إليها» of the Start Studying sheet; Phase 2: merge several, kind and page
  filters): `POST /api/annotations/layers/copy` with `{from_layer_ids, kinds?, page_ids?, into}`.
  * A preview counts the items per kind and page.
  * A job copies with new derived ids and appends `attribution` per item. It never deletes the source layers.
  * «Drawings from A, notes from B» is two copies with kind filters: `ink` + `shape` from A; `text` + `sticky` + `note`
    from B.
* **Compare two copies side by side** (AOS-4.13). The split pane shows the same lecture page twice, with layer set A
  on one side and B on the other, and synchronised paging. A diff marks items only in A, only in B, or changed,
  matched by `migrated_from_id` or attribution origin ids.
* **History and restore.** `annotation_revision` (§4.3) supports «سجل الإصدارات» (version history) per layer — the
  list ships in Phase 1 — and «استعد هذه الحالة» (restore this state, Phase 2 with the time machine). A restore writes a
  new state; history is never rewritten.

### 6.7 Suggested corrections

1. A viewer of P writes items in a `suggestion` layer in the space, addressed to `P@n`, with a note.
2. The author gets a notification and a preview.
3. The author accepts all or some items. Accepted items are copied into the author's **vault** explanation layer (the
   author's own write, with attribution to the suggester), and the author republishes.
4. A rejection closes the suggestion with a note. Everything is audited.
5. Accepted suggestions count in the publication's quality signals (§7.8).
6. **Corrections to official lectures** (§18). The existing pattern cannot be reused as is: `control/corrections.ts`
   (lines 443–450) rewrites an **uncited** region's text in place, and creates a successor *region* (not a version) for
   a cited one. In a space the citations and pinned copies live in vaults, so `isCited` sees none and the official text
   would be rewritten under the same region id — vaults that pinned it earlier would hold different text for one id, and
   no content alert would reach them (alerts are per database). Therefore:
   * the regions of a **published** official version are immutable; a correction creates a **new official version**
     (`source_version.kind = 'owner_correction'`, `derived_from_version_id` = the corrected one) with the corrected
     regions, published through the normal flow: page map (identical pages map `safe`), stub fan-out through
     `lecture_copy`, `source_replaced` alerts, and the one-tap note migration of §6.3;
   * a **draft** version (not yet published) may still be corrected in place with today's code;
   * vault pins store a content hash (`pinned_region`, §4.2) and are refreshed only by an explicit user action after the
     alert, so a citation never changes text silently;
   * contributors' corrections go to the moderators' review queue first, as today's review items do.

### 6.8 Tests (runnable here)

* Scenario 2 end to end, with two users.
* Scenario 4 with a fixture that inserts 3 pages and edits 1:
  * `safe` copies at the right new page indexes;
  * the edited page ends in review;
  * the old items' bytes are unchanged (hash compare);
  * a second run is a no-op (deterministic ids).
* Withdrawal and takedown keep ink; the takedown nulls the stub's file references before deleting `stored_file` rows
  (with `foreign_keys = ON`).
* A correction of a published version creates a new version; a pinned citation keeps its text and hash until the user
  refreshes it.
* Republish with one changed stroke out of 5,000: one `publication_item` row written; the follower's other item ids and
  every reference to them unchanged; bytes pulled by the follower ≈ one stroke.
* «اربط بالمحاضرة الرسمية» (§6.9): every private item ends on the official version or in the review list, and the
  private source's rows are byte-identical before and after.
* A republish with the same content is a no-op.
* Every layer rule in §5.4.

### 6.9 Linking an existing private lecture to an official lecture (AOS-19H.3, 19H.4)

The owner's library holds years of ink on private uploads, and other users will upload a lecture before (or besides)
its official copy. A private upload has its own ids, so without a bridge those notes could never sit on the official
lecture or become a published explanation (spec §23 «حافظ على الميزات والبيانات الحالية», §3 content hash, §19H lecture
identity).

1. **Detect.** When a vault source and an official lecture the user can see share the file sha256, or ≥ 60 % of page
   fingerprints (§6.2), the library row and the lecture page show «هذه المحاضرة موجودة رسميًا في مادة Anatomy — اربطها؟».
   The match is computed in the vault from the space's fingerprints (read through `ctx.dbs`), so nothing about the
   private file leaves the vault.
2. **«اربط بالمحاضرة الرسمية».** `POST /api/copies/link` `{source_id, space_id, lecture_id, to_version_id}` creates (or
   reuses) the stub and a `document_copy(mode='personal')`, then runs `reanchor_copy` with the private source's version
   as `from` and the official version as `to`, using a page map computed between them (`version_page_map` rows in the
   vault with `method` as in §6.2). Everything is **copied**, never moved: deterministic ids, `migrated_from_id`,
   previous anchors kept, uncertain items in «تحتاج مراجعة». The private source and its rows are untouched; the user may
   delete it later (normal trash).
3. **«انشر كمحاضرة رسمية»** (Subject Moderator or a platform admin holding that role): `POST /api/spaces/:s/lectures/
   from-vault` `{source_id, title, lecture_no?}` registers the blob in the space by sha256 (a new `stored_file` row in the
   space, no byte copy), creates the official lecture and version (processed in the space), then runs step 2 for the
   uploader so their ink sits on the official version, still private. Publishing that ink as an explanation is the
   normal §6.4 flow, chosen by the uploader.
4. **Owner migration.** Both are on the X8 checklist (PRD §9): after the migration the owner can link or promote each
   existing lecture, and the counts reconcile.

## 7. API contracts

### 7.1 Conventions (all routes)

* **Auth and CSRF are unchanged.**
  * Session cookie `medlevo_session` (HttpOnly, SameSite=Strict).
  * Every non-GET/HEAD/OPTIONS request carries `x-medlevo-csrf: 1`, with Origin ∈ configured origins and
    `sec-fetch-site ≠ cross-site`. No CORS.
  * WebSocket upgrades check the session cookie, and Origin must be one of the configured origins (a guard against
    cross-site WebSocket hijacking); SameSite=Strict keeps the cookie off cross-site requests. The first message is
    `{t:'hello', device_id}`.
  * **Client version.** Every request carries `x-medlevo-client: <app version>`; a missing or older version answers
    `426 CLIENT_TOO_OLD` (except the legacy owner's own sessions during the transition, §4.5).
* **Binding.**
  * `/api/<module>/…` binds the caller's vault.
  * `/api/spaces/:spaceId/<module>/…` binds that space (§5.5 gate 2).
  * System modules (`auth`, `accounts`, `channels`, `social`, `notifications`, `moderation`, `admin`) use
    `ctx.system` with the viewer.
* **Validation.** zod everywhere (`parseBody`, `parseQuery`, `parseParams`). Bodies are capped by today's limits.
* **Pagination** is cursor-based. The cursor is opaque base64url of `(sort key, id)`, stable under inserts:

  ```ts
  export interface PageQuery { cursor?: string; limit?: number }        // limit 1..100, default 30
  export interface Page<T> { items: T[]; next_cursor: string | null }
  ```

* **Idempotency.** Create endpoints for client-originated objects (copies, layers, threads, posts, rooms, room events)
  accept a client `id` (ULID). The same id with the same body returns the existing object with `200`. The same id with
  a different body returns `409 CONFLICT`. Server-generated creations accept `Idempotency-Key`.
* **Errors.** `ApiErrorBody` is unchanged: `{ error: { code, message (Arabic), details? } }`. New codes appended to
  `ErrorCode` in `packages/shared/src/errors.ts`:

  | code | HTTP | when |
  |---|---|---|
  | `MEMBERSHIP_REQUIRED` | 403 | a visible channel the viewer has not joined (join flow offered) |
  | `MEMBERSHIP_PENDING` | 403 | the join request is waiting for approval |
  | `LAYER_READ_ONLY` | 409 | a write to a followed or snapshot layer (REST); sync uses `detail_code` |
  | `PUBLICATION_FROZEN` | 409 | an edit of a published version (republish instead) |
  | `CONSENT_REQUIRED` | 409 | a missing consent record (§5.6); `details.kind` names it |
  | `QUOTA_EXCEEDED` | 409 | storage, AI, ASR or room quota; `details` = {kind, used, limit, resets_at} (same family as `AI_BUDGET_EXCEEDED`) |
  | `JOIN_CODE_INVALID` | 400 | wrong, expired, revoked or exhausted code. One generic Arabic message; rate-limited per account and IP |
  | `SPACE_UNAVAILABLE` | 503 | the space is `migrating` or `read_only` for writes |
  | `CLIENT_TOO_OLD` | 426 | a pre-multi-user client (§4.5); the app shows «حدّث التطبيق» and updates the service worker |
  | `LOGIN_SLOWED` | 429 | progressive per-account delay after failed sign-ins; `details.retry_after_s`; a recovery code bypasses it |
  | `NO_TENANT_BOUND` | 500 | an internal bug: never user-facing; logged with the route |

* **Visibility errors.** Hidden resources answer `404 NOT_FOUND` (§5.5). Lists filter before paginating.
* **Rate limits.** Today's presets (`RATE_LIMITS`) are keyed by **user id** for signed-in routes, with a coarser
  per-IP ceiling set high enough for a whole class behind one campus NAT. New presets: `social` (likes, ratings,
  follows), `reports`, `join` (code attempts), `publish`. Sign-in uses a progressive per-account delay, never a hard
  lockout (§4.1 `login_attempt`).

Shared types:

```ts
// packages/shared/src/academic/visibility.ts
export type Visibility = 'private' | 'specific_users' | 'followers' | 'course' | 'public';
export type PublicationVisibility = Exclude<Visibility, 'private'>;
export interface UserRef { id: string; display_name: string; avatar_url: string | null; former?: boolean }   // former = «طالب سابق»
export type ChannelKind = 'university' | 'college' | 'department' | 'stage' | 'academic_year' | 'course' | 'subject';
export type ChannelRole = 'admin' | 'assistant' | 'subject_moderator' | 'contributor';
export type LayerKind = 'personal' | 'explanation' | 'answers' | 'published_snapshot' | 'followed' | 'forked'
  | 'group_comments' | 'suggestion' | 'collaborative';
export type ContentOrigin = 'source' | 'lecturer_said' | 'generated' | 'external_reference'
  | 'student_contribution' | 'moderator_reviewed' | 'my_notes';
```

### 7.2 Auth and accounts (system)

| method | path | body → response | notes |
|---|---|---|---|
| GET | `/api/auth/status` | → `{ setup_required, signed_in, user?: MeLite }` | public (unchanged route) |
| POST | `/api/auth/setup` | `{username, display_name, password, setup_token?}` → `RegisterResponse` | public; only while no user exists; creates the platform admin |
| POST | `/api/auth/register` | `RegisterRequest` → `RegisterResponse` | **new public route** (g8 list +2 with the join preview, ADR-0003 §3.10); requires a valid join code, invite token or invitation |
| POST | `/api/auth/login` · `/logout` · `/recover` · `/password` · `/recovery-codes` | unchanged shapes | per-account progressive delay (`LOGIN_SLOWED`), high per-IP ceiling; `/recover` with a valid recovery code is never slowed |
| GET | `/api/auth/sessions` · DELETE `/api/auth/sessions/:id` | unchanged | the user's own sessions only |
| GET | `/api/accounts/me` | → `MeResponse` | |
| PATCH | `/api/accounts/me/profile` | `ProfilePatch` → `ProfileView` | per-field visibility |
| GET | `/api/accounts/users/:id/profile` | → `ProfileView` | filtered by the profile and field visibility |
| GET · DELETE | `/api/accounts/me/devices` · `/api/accounts/me/devices/:deviceId` | → `DeviceView[]` | revoking a device also revokes its key |
| POST | `/api/accounts/me/devices` | `{device_id, label, platform}` → `DeviceView` (with the server-issued `device_uid`) | first sync of a device; idempotent per (user, device_id); a `device_id` already registered to another user still gets its own `device_uid` |
| PUT | `/api/accounts/me/devices/:deviceId/key` | `{public_key, alg: 'Ed25519'}` → `DeviceView` | needed for relay bundles |
| POST | `/api/accounts/me/export` | → `{ job_id }` | per-user export: vault + own publications (job) |
| POST | `/api/accounts/me/delete` | `{preview: true}` → `DeletionPreview`; `{confirm_token, password}` → `{ job_id }` | PRD Q14 (ADR-0003 §7) |
| GET | `/api/accounts/me/quota` | → `QuotaView` | |

```ts
// packages/shared/src/academic/accounts-api.ts
export interface RegisterRequest {
  username: string; display_name: string; password: string;
  join: { code: string } | { invite_token: string } | { invitation_id: string };
}
export interface RegisterResponse { user: MeLite; recovery_codes: string[] /* shown once */; membership: MembershipView | null }
export interface MeLite { id: string; username: string; display_name: string; is_platform_admin: boolean }
export interface MeResponse extends MeLite {
  vault_id: string; timezone: string;
  memberships: MembershipView[]; roles: RoleView[];
  quota: QuotaView; legacy_owner: boolean;
}
export interface ProfileView {
  user: UserRef; bio: string | null;
  academic: { university?: NodeRef; college?: NodeRef; department?: NodeRef; stage?: NodeRef } | null;  // only visible fields
  counts: { followers: number; publications: number } | null;   // real counts; null when hidden
  subjects_published_in: NodeRef[]; series: SeriesRef[];
  viewer_follows: { scope: '' | string }[];
}
export interface QuotaView {
  storage: { used_bytes: number; limit_bytes: number | null };
  ai: { month: string; used_usd_est: number; limit_usd: number | null };
  asr: { month: string; used_minutes: number; limit_minutes: number | null };
}
export interface DeletionPreview {
  vault: { sources: number; annotations: number; notes: number; recordings: number; bytes: number };
  publications: { total: number; forked_by_others: number };
  policy_ar: string;  confirm_token: string;  expires_at: number;
}
```

### 7.3 Channels, membership, roles (system)

| method | path | body → response | who |
|---|---|---|---|
| GET | `/api/channels/tree?root=&depth=` | → `ChannelTreeResponse` | any signed-in user (titles only; `join_policy` shown) |
| GET | `/api/channels/nodes/:id` | → `ChannelNodeView` (+ the viewer's membership and roles) | |
| POST | `/api/channels/nodes` | `CreateNodeRequest` → `ChannelNodeView` | Admin of the parent / platform admin |
| PATCH | `/api/channels/nodes/:id` · POST `/:id/archive` | | Admin |
| POST | `/api/channels/join` | `{ code }` → `JoinResponse` | rate-limited (`join`) |
| GET | `/api/channels/join/preview?token=` | → `{ title_ar: string; kind: ChannelKind; requires_approval: boolean }` | **public** (g8 list, ADR-0003 §3.10); rate-limited per IP; reveals only the channel title for a valid, unexpired invite token, and the same generic 404 otherwise |
| POST | `/api/channels/join/link` | `{ token }` → `JoinResponse` | the QR encodes this link |
| POST | `/api/channels/invitations/:id/decision` | `{ accept: boolean }` → `JoinResponse` | the invitee |
| GET | `/api/channels/nodes/:id/members?status=&cursor=` | → `Page<MemberView>` | Admin / Assistant |
| POST | `/api/channels/nodes/:id/members/:userId/decision` | `{ decision: 'approve' \| 'reject' \| 'remove', reason? }` → `MemberView` | Admin / Assistant |
| POST | `/api/channels/nodes/:id/codes` | `CreateJoinCodeRequest` → `CreateJoinCodeResponse` | Admin / Assistant |
| GET · DELETE | `/api/channels/nodes/:id/codes` · `/api/channels/codes/:id` | → `JoinCodeView[]` | Admin / Assistant |
| POST | `/api/channels/nodes/:id/invitations` | `{ user_ids: string[] }` → `InvitationView[]` | Admin / Assistant |
| POST · DELETE | `/api/channels/nodes/:id/roles` · `/api/channels/roles/:id` | `{ user_id, role }` → `RoleView` | Admin (below Admin), platform admin |
| PUT · DELETE | `/api/channels/subjects/:id/follow` | `{ add_new_lectures, library_folder_id? }` → `CourseFollowView` | members |

```ts
// packages/shared/src/academic/channels-api.ts
export interface NodeRef { id: string; kind: ChannelKind; title: string }
export interface ChannelNodeView extends NodeRef {
  parent_id: string | null; title_en: string | null; ordinal: number | null;
  starts_on: string | null; ends_on: string | null; has_space: boolean;
  join_policy: 'closed' | 'approval' | 'open_with_code';
  viewer: { membership: MembershipView | null; roles: ChannelRole[]; inherited_from: NodeRef | null };
}
export interface ChannelTreeResponse { nodes: ChannelNodeView[]; truncated: boolean }
export interface CreateNodeRequest { parent_id: string | null; kind: ChannelKind; title: string; title_en?: string;
  ordinal?: number; starts_on?: string; ends_on?: string; create_space?: boolean; join_policy?: ChannelNodeView['join_policy'] }
export interface MembershipView { node: NodeRef; status: 'pending' | 'approved' | 'rejected' | 'left' | 'removed';
  join_method: string; decided_at: number | null; reason_ar: string | null }
export interface JoinResponse { membership: MembershipView; message_ar: string }   // e.g. «طلبك بانتظار موافقة مشرف المادة»
export interface CreateJoinCodeRequest { kind: 'class_code' | 'invite_link'; expires_in_hours: number; max_uses?: number; requires_approval: boolean }
export interface CreateJoinCodeResponse {
  view: JoinCodeView;
  code?: string;          // class_code: base32 groups «ABCD-EFGH», shown ONCE
  link?: string;          // invite_link: https://<origin>/join/<token>, shown ONCE
  qr_payload?: string;    // the same link, for the QR renderer
}
export interface JoinCodeView { id: string; kind: string; hint: string; requires_approval: boolean;
  max_uses: number | null; use_count: number; expires_at: number; revoked_at: number | null }
export interface RoleView { id: string; node: NodeRef; role: ChannelRole; granted_by: UserRef; created_at: number }
```

### 7.4 Official lectures (space)

| method | path | body → response | who |
|---|---|---|---|
| GET | `/api/spaces/:s/lectures?subject_id=&cursor=` | → `Page<OfficialLectureView>`, ordered by `lecture_no`, then `held_on`, then title | members (drafts: moderators) |
| GET | `/api/spaces/:s/lectures/:id` | → `OfficialLectureDetail` (versions, head, page count, the viewer's copy if any) | |
| POST | `/api/spaces/:s/lectures` | `{ subject_id, title, lecture_no?, held_on? }` → `OfficialLectureView` (draft) | contributor / moderator |
| POST | `/api/spaces/:s/lectures/:id/upload` | multipart, or `{ upload_id }` (§7.12) → `{ version_id, job_id }` | reuses `sources` upload + `processing` in the space |
| POST | `/api/spaces/:s/lectures/:id/approve` | `{}` → view | moderator |
| POST | `/api/spaces/:s/lectures/:id/versions/:versionId/publish` | `{ change_note }` → `{ head_version_id, page_map_job_id }` | moderator. Notifies stub holders |
| GET | `/api/spaces/:s/lectures/:id/versions/:a/compare/:b` | → `VersionCompareResponse` | members |
| POST | `/api/spaces/:s/lectures/:id/page-map/decisions` | `{ decisions: {from_page_id, to_page_id \| null, decision: 'confirm' \| 'reject'}[] }` | moderator |
| POST | `/api/spaces/:s/lectures/:id/withdraw` | `{ reason: 'replaced' \| 'error' \| 'rights_takedown' \| 'other', note_ar }` | moderator |
| POST | `/api/spaces/:s/lectures/:id/corrections` | the existing control correction body → `{ version_id }` | moderator (contributor → review queue). On a published version it creates a **new official version** (§6.7); on a draft it corrects in place |
| POST | `/api/spaces/:s/lectures/from-vault` | `{ source_id, title, lecture_no? }` → `OfficialLectureView` | moderator of this subject (or platform admin holding that role); §6.9 |
| GET · POST · PATCH | `/api/spaces/:s/subject/attachments` · `/:id` | `SubjectAttachmentView` / `{ kind, title, lecture_id?, upload_id }` / `{ status }` | read: member · write: moderator (contributor → draft) |
| GET · PUT · DELETE | `/api/spaces/:s/subject/exam-dates` · `/:id` | `SubjectExamDateView[]` / `{ title, exam_on, starts_at?, lecture_ids? }` | read: member · write: moderator |
| GET | `/api/spaces/:s/subject/events?cursor=` | → `Page<SubjectEventView>` | member (the subject updates feed, AOS-2.9) |

```ts
// packages/shared/src/academic/lectures-api.ts
export interface OfficialLectureView {
  id: string; subject: NodeRef; title: string; lecture_no: number | null; lecture_no_origin: 'detected' | 'moderator' | null;
  held_on: string | null; status: 'draft' | 'in_review' | 'published' | 'withdrawn';
  head_version: { id: string; version_no: number; page_count: number | null; processing_status: string } | null;
  counts: { explanations: number; discussions: number };            // visible to the viewer only
}
export interface PageMapEntry { from_page: PageRef; to_page: PageRef | null; method: string;
  status: 'safe' | 'uncertain' | 'none' | 'confirmed' | 'rejected'; layout_safe: boolean; text_score: number | null }
export interface PageRef { page_id: string; page_index: number; label_ar: string /* «ص 12 (الصفحة 14 في الملف)» */ }
export interface VersionCompareResponse {
  from_version_id: string; to_version_id: string; entries: PageMapEntry[];
  summary: { identical: number; changed: number; inserted: number; removed: number; uncertain: number };
}
```

### 7.5 Copies and layers (vault)

| method | path | body → response |
|---|---|---|
| POST | `/api/copies` | `StartStudyingRequest` → `DocumentCopyView` (idempotent by client id) |
| GET | `/api/copies/link-candidates?source_id=` | → `{ matches: { space_id, lecture_id, title, version_id, basis_ar: string[] }[] }` (sha256 or page-fingerprint match, §6.9) |
| POST | `/api/copies/link` | `{ id, source_id, space_id, lecture_id, to_version_id }` → `{ copy: DocumentCopyView; job_id }` → `ReanchorReport` (copy, never move) |
| GET | `/api/copies?source_id=` · `/api/copies/:id` | → `DocumentCopyView[]` / view |
| GET | `/api/copies/:id/upstream` | → `UpstreamPreview` (followed copies) |
| POST | `/api/copies/:id/upstream/apply` | `{ version_no, skip?: boolean }` → `DocumentCopyView` |
| PATCH | `/api/copies/:id` | `{ update_policy }` |
| GET | `/api/copies/:id/reanchor?to_version_id=` | → `ReanchorPreview` |
| POST | `/api/copies/:id/reanchor` | `{ to_version_id }` → `{ job_id }` → `ReanchorReport` (via the job) |
| POST | `/api/copies/:id/reanchor/undo` | `{ report_id }` → `ReanchorReport` |
| GET | `/api/annotations/layers?document_key=` | → `LayerView[]` |
| POST · PATCH | `/api/annotations/layers` · `/:id` | `{ id, document_key, title, kind: 'personal' \| 'answers' \| 'explanation' }` / `{ title?, visible?, locked?, color?, sort_order? }` (also syncable as entity `annotation_layer`) |
| POST | `/api/annotations/layers/copy` | `CopyLayersRequest` → `{ preview: CopyPreview }` or `{ job_id }` |
| GET | `/api/annotations/layers/:id/history?before=&limit=` | → `Page<LayerHistoryEntry>` |
| POST | `/api/annotations/layers/:id/restore` | `{ at: number }` → `{ job_id }` (writes a new state) |

```ts
// packages/shared/src/academic/copies-api.ts
export type CopyMode = 'personal' | 'independent_fork' | 'followed' | 'collaborative';
export interface StartStudyingRequest {
  id: string;                                   // client ULID
  space_id: string; lecture_id: string; mode: CopyMode;
  publication_id?: string; version_no?: number; // fork: pinned version (default head); followed: head
  collab_doc_id?: string;                       // join an existing collaborative copy
  library_folder_id?: string;                   // where the stub appears in «مكتبتي»
}
export interface DocumentCopyView {
  id: string; mode: CopyMode; source_id: string; lecture: { space_id: string; id: string; title: string } | null;
  publication: { id: string; title: string; author: UserRef; applied_version_no: number; head_version_no: number } | null;
  personal_layer_id: string; copied_layer_id: string | null; collab_doc_id: string | null;
  update_policy: 'preview' | 'auto'; pending_version_no: number | null;
}
export interface UpstreamPreview {
  from_version_no: number; to_version_no: number; change_note: string | null;
  counts: { added: number; removed: number; changed: number };
  pages: { page: PageRef; added: number; removed: number; changed: number }[];
  personal_items_affected: 0;                   // always 0 by construction — shown so the user sees the guarantee
}
export interface ReanchorPreview {
  to_version_id: string;
  will_copy: { page: PageRef; items: number }[]; needs_review: number; stays_on_previous: number;
}
export interface ReanchorReport extends ReanchorPreview { id: string; copied: number; created_at: number; undone_at: number | null }
export interface LayerView {
  id: string; document_key: string; kind: LayerKind; title: string; writable: boolean; frozen: boolean;
  visible: boolean; locked: boolean; color: string | null; item_count: number;
  origin: { publication_id: string; version_no: number; author: UserRef } | null;
}
export interface CopyLayersRequest {
  from_layer_ids: string[];
  kinds?: ('ink' | 'shape' | 'highlight' | 'text_highlight' | 'text' | 'sticky' | 'image' | 'link' | 'bookmark' | 'note')[];
  page_ids?: string[];
  into: { layer_id: string } | { new_title: string };
  preview?: boolean;
}
export interface CopyPreview { items: number; by_kind: Record<string, number>; pages: number; attributions: UserRef[] }
```

### 7.6 Publications and suggestions (space, index in system)

| method | path | body → response |
|---|---|---|
| POST | `/api/spaces/:s/publications` | `PublishRequest` → `PublicationView` (job-backed; `Idempotency-Key`) |
| POST | `/api/spaces/:s/publications/:id/versions` | `{ layer_ids, change_note }` → `PublicationView` (republish) |
| PATCH | `/api/spaces/:s/publications/:id` | `{ title?, summary?, visibility?, quick_review_tag?, series_id? }` |
| POST | `/api/spaces/:s/publications/:id/withdraw` | `{}` |
| GET | `/api/spaces/:s/publications/:id` | → `PublicationView` (accepts `guest_publication` binding) |
| GET | `/api/spaces/:s/publications/:id/versions/:n/items?page_id=` | → `{ items: AnnotationDTO[], notes: NoteDTO[], note_pages: NotePageDTO[] }` |
| GET | `/api/spaces/:s/publications/:id/diff?from=&to=` | → `UpstreamPreview` |
| GET | `/api/spaces/:s/lectures/:id/publications?sort=&cursor=` | → `Page<PublicationCard>` (the **Lecture Marketplace**) |
| POST | `/api/spaces/:s/publications/:id/suggestions` | `{ id, target_version_no, layer_items: AnnotationDTO[], note }` → `SuggestionView` |
| GET | `/api/spaces/:s/publications/:id/suggestions?status=` | → `Page<SuggestionView>` (author, moderators, the suggester's own) |
| POST | `/api/spaces/:s/suggestions/:id/decision` | `{ decision: 'accept' \| 'partial' \| 'reject', item_ids?, note }` → `SuggestionView` |

```ts
// packages/shared/src/academic/publications-api.ts
export interface PublishRequest {
  lecture_id: string; layer_ids: string[]; note_page_ids?: string[];
  title: string; summary?: string; kind: 'explanation' | 'voice_explanation' | 'crowd_notes';
  visibility: PublicationVisibility; grantees?: string[];      // specific_users
  recording_id?: string;                                       // voice explanation: consents checked (§5.6)
  quick_review_tag?: boolean; series_id?: string;
}
export interface PublicationView {
  id: string; space_id: string; lecture: { id: string; title: string }; subject: NodeRef; author: UserRef;
  kind: string; title: string; summary: string | null; visibility: PublicationVisibility;
  status: 'active' | 'hidden_by_moderator' | 'withdrawn' | 'author_deleted';
  head_version_no: number; versions: { no: number; created_at: number; change_note: string | null; lecture_version_no: number }[];
  completeness: { pages_covered: number; pages_total: number };     // numbers, never a bare percentage
  moderator_review: { state: 'none' | 'reviewed' | 'changes_requested'; role_ar: string | null; at: number | null };
  origin_label_ar: 'شرح طالب — ليس مصدرًا';
  viewer: { liked: boolean; saved: boolean; rating: number | null; copy: CopyMode | null; can_edit: boolean };
}
export type MarketplaceSort = 'most_used' | 'top_rated' | 'newest' | 'most_complete' | 'quick_review' | 'most_documented';
export interface PublicationCard extends Pick<PublicationView, 'id' | 'title' | 'author' | 'kind' | 'completeness' | 'moderator_review'> {
  signals: { active_copies: number; ratings: { count: number; mean: number | null }; accepted_corrections: number;
             evidence_links: number; quick_review_votes: number; updated_at: number };
  rank_why_ar: string[];                                        // «لماذا هنا؟» — the signals that ranked it (§7.8)
}
export interface SuggestionView { id: string; publication_id: string; target_version_no: number; suggester: UserRef;
  item_count: number; note: string | null; status: string; decided_by: UserRef | null; decision_note: string | null }
```

### 7.7 Social, profile, feed (system)

| method | path | body → response |
|---|---|---|
| PUT · DELETE | `/api/social/follows/:userId` | `{ subject_scope?: string }` → `FollowView` (pending when the followee requires approval) |
| POST | `/api/social/follows/requests/:followerId/decision` | `{ accept }` |
| GET | `/api/social/users/:id/followers` · `/following` | → `Page<UserRef>` (subject to profile visibility) |
| PUT · DELETE | `/api/social/publications/:id/reactions/:kind` | `kind ∈ like \| save` |
| PUT | `/api/social/publications/:id/rating` | `{ version_no, stars, good_for_quick_review }` → `{ mean, count }` (replaces the caller's earlier rating; members of the subject ≥ 7 days who opened the items only) |
| GET | `/api/social/users/:id/publications?subject_id=&cursor=` | → `Page<PublicationCard>` |
| GET | `/api/social/feed?cursor=` | → `Page<FeedItem>` |
| GET · POST · PATCH | `/api/social/series` · `/:id` | publication series |

```ts
export type FeedItem =
  | { kind: 'publication_new' | 'publication_updated'; at: number; publication: PublicationCard; version_no: number }
  | { kind: 'official_lecture'; at: number; space_id: string; lecture: OfficialLectureView }
  | { kind: 'official_version'; at: number; space_id: string; lecture: OfficialLectureView; change_note: string | null }
  | { kind: 'discussion_answered'; at: number; space_id: string; thread_id: string; title: string };
// The feed comes only from: subjects the user is a member of or follows, and users they follow (scoped). Visibility is
// filtered in SQL before ordering. No engagement-bait ordering: newest first, with followed authors first within a day.
```

### 7.8 Marketplace ranking and anti-manipulation (spec §5)

* **Each sort is explainable** (`rank_why_ar`):

  | sort | ordered by |
  |---|---|
  | `newest` | `published_at` / `updated_at` |
  | `most_used` | **active copies**: forks plus followed copies still open after 14 days, not raw opens or downloads |
  | `top_rated` | Bayesian mean `(C·m + Σstars)/(C + n)`, with prior `m` = the subject mean and `C = 5`. The real count is shown |
  | `most_complete` | `pages_covered / pages_total`, shown as «يغطي 31 من 40 صفحة» (covers 31 of 40 pages) |
  | `quick_review` | raters' `good_for_quick_review` votes only; the author's own tag is shown as a label, never counted |
  | `most_documented` | accepted suggestions + `evidence_links` (items that link a lecture region), **capped at one per page** so an author cannot inflate it + moderator review |

  The default listing (`rank_score`, `rank_version`) combines these normalised signals with documented, versioned
  weights.
* **Anti-manipulation rules.**
  * One like and save per account (primary keys), and **one rating per account per publication**: re-rating a new
    version replaces the earlier one, and every sort reads only that latest rating.
  * Raters must be approved members of the subject for ≥ 7 days and must have opened the publication's items, recorded
    server-side when items are fetched. Non-members never rate, even a `public` publication (§5.3).
  * `most_used` counts follows only when the copy is still open after 14 days, so a burst of free follows does not
    move it.
  * No self-reactions.
  * Per-user rate limits.
  * A nightly job flags reciprocal rating rings (pairs or cliques that rate each other far above their base rates) and
    accounts created in bursts with the same join code. Flags go to the moderation queue, not to automatic penalties.
  * Every signal change is recomputable from the raw rows.
* **No inflated numbers.** Counts are real. Below 3 ratings, «تقييمات قليلة» (few ratings) is shown instead of a mean.

### 7.9 Discussions (space)

| method | path | body → response |
|---|---|---|
| GET | `/api/spaces/:s/discussions?lecture_id=&version_id=&page_id=&cursor=` | → `Page<ThreadView>` |
| POST | `/api/spaces/:s/discussions` | `CreateThreadRequest` → `ThreadView` (also syncable: entity `discussion_thread`) |
| GET | `/api/spaces/:s/discussions/:id` | → `ThreadDetail` (posts as a tree, accepted answer first) |
| POST | `/api/spaces/:s/discussions/:id/posts` | `{ id, parent_post_id?, body: RichText }` → `PostView` (entity `discussion_post`) |
| PATCH · DELETE | `/api/spaces/:s/posts/:id` | author only; delete = tombstone |
| POST | `/api/spaces/:s/discussions/:id/accept` | `{ post_id }` (question author or moderator) |
| PUT · DELETE | `/api/spaces/:s/posts/:id/vote` | helpful vote |
| POST | `/api/spaces/:s/posts/:id/to-question-bank` | `{}` → `{ question_id }` in the **caller's vault** |
| POST | `/api/spaces/:s/posts/:id/to-flashcard` | `{ front?, back? }` → `{ card_id }` in the caller's vault |

```ts
export interface CreateThreadRequest {
  id: string; kind: 'question' | 'comment'; lecture_id: string; version_id: string;
  anchor: AnnotationAnchor;                                    // page_norm box / region / block — the same model as ink
  target?: { type: 'publication_item' | 'recording_moment'; id: string; offset_ms?: number };
  title?: string; body: RichText; audience: 'course' | 'room' | 'publication_audience'; audience_ref?: string;
}
export interface ThreadView { id: string; kind: string; author: UserRef; title: string | null; excerpt: string;
  anchor: AnnotationAnchor; page: PageRef | null; posts: number; accepted: boolean; status: string; created_at: number;
  version_note_ar: string | null }   // e.g. «سُئل على الإصدار 2؛ مكانه في إصدارك: ص 14» (cross-version, via version_page_map)
export interface PostView { id: string; author: UserRef; parent_post_id: string | null; body: RichText; helpful: number;
  viewer_voted: boolean; accepted: boolean; deleted: boolean; origin_label_ar: 'إجابة طالب — ليست مصدرًا' }
```

* **Into the question bank.** «أضف إلى بنك الأسئلة» creates an **owner** question (`origin_type 'owner'`) in the
  caller's vault, with `answer_status 'unresolved'` and `key_details_json.origin = 'community_answer'` plus a link back
  to the thread. A community answer is never a source key (AC-13).
* **Into a flashcard.** «أنشئ بطاقة» creates a card with `origin 'owner'`, `origin_ref_json {thread_id, post_id}` and
  no evidence ids, unless the user links a lecture region. It is shown as «من نقاش المادة — ليس مصدرًا» (from the
  subject's discussion — not a source).
* **Jumping to the place on another version** (spec §6, «a second student lands on the same page and place»). The
  viewer's copy may be on another lecture version, so the anchor is mapped through `version_page_map`. When the
  mapping is not `safe`, the old version is opened with a notice instead.

### 7.10 Rooms, collaboration, nearby (space / system)

| method | path | body → response |
|---|---|---|
| POST | `/api/spaces/:s/rooms` | `CreateRoomRequest` → `RoomView` |
| GET | `/api/spaces/:s/rooms?subject_id=&kind=` | → `Page<RoomView>` |
| POST | `/api/spaces/:s/rooms/:id/join` | `{ device_id }` → `JoinRoomResponse` |
| POST | `/api/spaces/:s/rooms/:id/sessions` · `/sessions/:sid/end` | host |
| POST | `/api/spaces/:s/rooms/:id/sessions/:sid/consent` | `{ kind: 'room_recording' \| 'progress_share', granted: boolean }` |
| POST | `/api/spaces/:s/rooms/:id/sessions/:sid/participants/:userId/role` | `{ role: 'writer' \| 'viewer' }` (host) |
| POST | `/api/spaces/:s/collab` | `{ id, lecture_id, version_id, title, audience, grantees? }` → `CollabDocView` |
| GET | `/api/spaces/:s/collab/:id/state?sv=<b64 state vector>` | → `{ update: b64 }` (Yjs step 2), `{ snapshot: b64 }` when `sv` is absent |
| GET (WS) | `/api/spaces/:s/live` | realtime channel (§8.5) |
| POST | `/api/nearby/rooms/:roomId/credential` | `{ device_id }` → `RoomCredential` (fetched while online, before going offline; ≤ 24 h; revoked memberships stop being issued and the server rejects bundles made under a credential issued after the revocation) |
| POST | `/api/nearby/bundles` | `RelayUploadRequest` → `RelayUploadResponse` (§8.6) |

```ts
// packages/shared/src/academic/rooms-api.ts
export interface CreateRoomRequest { id: string; kind: 'silent' | 'group' | 'teaching' | 'exam'; title: string;
  subject_id: string; lecture_id?: string; version_id?: string; audience: 'course' | 'invited'; invitees?: string[];
  settings: { pomodoro?: { focus_min: number; break_min: number }; navigation?: 'group' | 'independent';
              write_policy?: 'host_only' | 'granted' | 'everyone'; break_alerts?: boolean; max_participants?: number };
  exam?: { question_version_ids: string[]; minutes?: number; reveal: 'after_end' } }
export interface JoinRoomResponse { session_id: string; role: 'host' | 'writer' | 'viewer'; live_url: string;
  collab_doc_id: string | null; server_time: number; consents_needed: ('room_recording' | 'progress_share')[] }
// Offline room credential, fetched while online (ADR-0005 §A.2): signed by the server's key (Ed25519), verified offline
export interface RoomCredential { v: 1; credential_id: string; room_id: string; space_id: string; subject_node_id: string;
  user_id: string; display_name: string; device_uid: string; device_key: string; role_max: 'host' | 'writer' | 'viewer';
  issued_at: number; expires_at: number /* ≤ 24 h */; server_sig: string }
// packages/shared/src/academic/nearby.ts — per-joiner QR pair (ADR-0005 §A.2). NO room key in any QR.
export interface QrOffer { v: 1; room_id: string; room_name: string; joiner_slot: string; sdp: string /* deflate-raw, base64url */;
  host_key_fp: string; exp: number }
export interface QrAnswer { v: 1; room_id: string; joiner_slot: string; sdp: string; device_key_fp: string }
// after DTLS is up: joiner → host { credential: RoomCredential } ; host verifies server_sig, expiry, room, device key;
// only then host → joiner { room_key: <wrapped to the joiner's device key> }
```

* **Exam rooms.** Each participant's attempt is an ordinary `exam_attempt` in **their own vault**. The room keeps the
  frozen exam definition and, with consent, aggregates scores. Participants know each other, so a small group lets
  colluders derive one person's scores: aggregates appear only with **≥ 10 participants** (PRD Q15), **exclude the
  viewer's own answers**, use coarse buckets (four bands, no exact percentages), and the **per-concept table is shown to
  the host only**. Solutions stay hidden until the room ends (existing exam policy, AC-19).

### 7.11 Timeline, radar, copilot, ASR (vault)

| method | path | body → response |
|---|---|---|
| GET | `/api/timeline/:clockId?from_ms=&to_ms=` | → `TimelineResponse` (§9) |
| POST | `/api/media/recordings/:id/transcribe` | `{ engine?: string, language_hints?, vocabulary?: 'subject' \| 'lecture' \| 'none', diarization?, denoise? }` → `{ run_id, job_id }` (`CONSENT_REQUIRED` for cloud) |
| GET | `/api/media/transcription-runs/:id` | → `TranscriptionRunView` |
| GET | `/api/media/audio/:id/intervals?kind=silence` | → `{ intervals: {start_ms, end_ms}[] }` |
| GET | `/api/copilot/radar?source_id=&recording_id=` | → `RadarDashboard` |
| PATCH | `/api/copilot/radar/:id` | `{ status: 'accepted' \| 'rejected', question_text?, lecturer_answer_text? }` |
| POST | `/api/copilot/radar/:id/to-question` · `/to-card` · `/to-mcq` | → `{ question_id }` · `{ card_id }` · `{ run_id }` (MCQ: AI-gated) |
| POST | `/api/copilot/radar/:id/answer` | `{}` → `{ artifact_id }` (evidence-checked generated answer, AI-gated) |
| POST | `/api/copilot/sessions` | `{ recording_id, source_id, features, budget_cap_usd? }` → `CopilotSessionView` (`features` may include `translate` and `card_suggestions`; any feature that sends audio or transcript outside the deployment needs the consents of §5.6, else `CONSENT_REQUIRED`) |
| POST | `/api/copilot/sessions/:id/card-suggestions/:sid/accept` | `{}` → `{ card_id }` (server-side, evidence-validated card; the user accepts each one) |
| GET (WS) | `/api/copilot/live?session_id=` | audio frames up; partials, finals, detections and suggestions down (§10.3) |

```ts
// packages/shared/src/academic/copilot-api.ts
export interface ExamHighlightView {
  id: string; t_start_ms: number; t_end_ms: number; page: PageRef | null; page_origin: string;
  cue_kind: string; cue_quote: string;                              // exact words, origin 'lecturer_said'
  question: { text: string | null; status: 'stated' | 'not_stated' | 'unclear' };
  lecturer_answer: { text: string | null; status: 'stated' | 'not_stated' | 'unclear' };   // NEVER an answer key
  generated_answer: { artifact_id: string; verification: 'linked' | 'needs_review' | 'abstained' } | null;
  status: 'suggested' | 'accepted' | 'rejected';
  indicator_note_ar: 'مؤشر من كلام الدكتور، وليس توقعًا مؤكدًا لأسئلة الامتحان';
}
export interface RadarDashboard { source_id: string; recordings: { id: string; started_at: number }[];
  highlights: ExamHighlightView[]; counts: { suggested: number; accepted: number; with_lecturer_answer: number };
  transcript_status: 'none' | 'partial' | 'complete'; requires_ar: string | null }   // e.g. «يحتاج تفريغًا للتسجيل أولًا»
```

### 7.12 Search, notifications, moderation, admin, files

| method | path | body → response |
|---|---|---|
| GET | `/api/search?q=&mode=keyword\|exact\|semantic&scope=mine\|subjects\|all&types=&cursor=` | → `FederatedSearchResponse` (existing shape + `db` and `origin` per hit) |
| POST | `/api/search/by-image` | multipart image (or `upload_id`) + `{ scope }` → `ImageSearchResponse` (Scenario 6) |
| GET | `/api/notifications?cursor=&unread=` · POST `/api/notifications/read` `{ ids \| all }` | inbox |
| GET · PUT | `/api/notifications/prefs` | per kind × channel |
| POST · DELETE | `/api/notifications/push-subscriptions` | Web Push (VAPID) |
| POST | `/api/moderation/reports` | `{ target_db, target_type, target_id, reason, note? }` → `ReportView` (Phase 1) |
| GET | `/api/moderation/queue?scope_node_id=&status=&cursor=` | → `Page<ReportView>` (moderators of that scope; Phase 1) |
| POST | `/api/moderation/actions` | `{ report_id?, target…, action, reason_ar }` → `ModerationActionView` (Phase 1: `hide`, `restore`, `dismiss`; Phase 2: the rest; `mark_reviewed` by a Subject Moderator only) |
| GET | `/api/admin/audit?scope_node_id=&cursor=` | → `Page<SecurityAuditView>` (scoped) |
| GET | `/api/admin/stats?scope_node_id=&period=` | → aggregates with minimum group sizes (§13) |
| PUT | `/api/admin/quotas/:userId` · `/api/admin/space-quotas/:spaceId` | platform admin |
| * | `/api/platform/…` | platform admin only: AI provider and models, deployment budget, evaluation runs (incl. ASR, ADR-0006 §2.10), health, client-error list, global processing queue, whole-instance backups, restore, `/export/all` (§5.8) |
| POST | `/api/files/uploads` | `{ size, sha256, mime, name, target: 'vault' \| {space_id} }` → `{ upload_id, chunk_size, received: number[] }` |
| PUT | `/api/files/uploads/:id/chunks/:n` | raw body + `x-content-sha256` → `{ received: number[] }` |
| POST | `/api/files/uploads/:id/complete` | → `{ file_id }` (whole sha256 verified, then `ctx.files.put`, refcount +1) |
| GET | `/api/files/:id` · POST `/api/files/:id/token` | unchanged shape; resolved in the bound DB; the token carries `{db, user}` |

```ts
export interface FederatedHit {
  db: { kind: 'vault' } | { kind: 'space'; space_id: string; subject: NodeRef };
  origin: ContentOrigin | 'owner_note' | 'recognized' | 'imported' | 'owner_typed';   // existing origins + new ones
  is_evidence: boolean;                         // false for student content, discussions and generated text
  type: string; id: string; title: string; snippet: string; location: { page?: PageRef; t_ms?: number } | null;
  open_url: string;                             // jumps to the exact place
}
export interface FederatedSearchResponse { hits: FederatedHit[]; next_cursor: string | null;
  searched: { vault: boolean; spaces: number; semantic: 'used' | 'unavailable'; reason_ar?: string } }
export interface ImageSearchResponse {
  ocr: { status: 'ok' | 'failed'; text_chars: number; reason_ar?: string };
  matches: { lecture: { space_id: string; id: string; title: string }; page: PageRef;
             confidence: 'high' | 'medium' | 'low'; basis_ar: string[] }[];       // e.g. «تطابق 38 كلمة من 44»، «تشابه بصري»
  abstained: { reason_ar: string } | null;      // never invents a match
}
```

## 8. Sync protocol v2

Sync v2 **extends** ARCHITECTURE §3.4 and keeps its v1 wire format. The decisions behind it are in ADR-0004.

### 8.1 Endpoints

| target | push | pull |
|---|---|---|
| my vault | `POST /api/sync/push` (unchanged path) | `GET /api/sync/pull?since=&limit=` (unchanged) |
| a space | `POST /api/spaces/:spaceId/sync/push` | `GET /api/spaces/:spaceId/sync/pull?since=&limit=` |

* Each database has its **own** `sync_change` sequence and `data_server_epoch`.
* The client keeps a cursor and epoch per target (`spaceCursors`).
* A vault restore resets only that user's devices. A space restore resets every member's cursor for that space only.

### 8.2 Op format (v1 plus optional fields)

```ts
export interface SyncOp {                       // unchanged required fields
  op_id: string; device_id: string; entity_type: string; entity_id: string;
  op: 'upsert' | 'delete' | 'append'; base_rev?: number | null; payload: unknown; client_ts?: number;
}
// optional, additive:
//  payload.layer_id         annotation / note / note_page (absent → the default personal layer)
//  payload.data.v = 2       packed points (ADR-0004 §2.5), only when the client sent `accept-ink: 2` capability
// request headers:  accept-ink: 2   (pull serialises v2 only to clients that send it)
export interface SyncOpResult { op_id: string; result: SyncResult; server_seq?: number; entity?: unknown; detail?: string;
  original_result?: SyncResult; retryable?: boolean;
  detail_code?: 'layer_read_only' | 'layer_forbidden' | 'use_crdt' | 'device_unknown' | 'op_id_taken'
              | 'not_a_member' | 'quota_exceeded' }   // NEW, optional; old clients ignore it
```

**Transient vs final rejections.** `sync/registry.ts` records every handler rejection (`AppError`) in `sync_operation`
(lines 118–145) and answers any retry of the same `op_id` with `duplicate` and the original `rejected` (lines 104–105).
A rejection whose cause can go away must therefore **never be recorded**, or a queued write is lost for good:

| `detail_code` | recorded? | `retryable` | the client |
|---|---|---|---|
| `device_unknown` | **no** | true | registers the device (`POST /api/accounts/me/devices`) and retries the same op |
| `not_a_member` (e.g. membership still pending) | **no** | true | keeps the op; retries after the membership changes |
| `quota_exceeded` | **no** | true | keeps the op, shows the quota state, retries when there is room |
| `op_id_taken` (a space op_id recorded for another actor) | **no** | true | re-issues the op under a **new** `op_id` (same entity and payload) |
| `layer_read_only`, `layer_forbidden` | yes | false | re-homes the item under a new id in the personal layer (ADR-0004 R2) |
| `use_crdt` | yes | false | sends the change as a CRDT update instead |

This is the same rule `registry.ts` already applies to unknown entity types (lines 108–111: not recorded, retryable).

### 8.3 Server processing order (each op, in its own transaction as today)

1. **Actor.** Taken from the session (`viewer.userId`). `device_id` must be in `device(user_id, device_id)` and not
   revoked; otherwise `rejected/device_unknown`, **not recorded**, `retryable: true` — the client registers the device
   and retries. The owner migration seeds `device` rows for every legacy device (ADR-0003 §5 step 5), so the owner's
   pre-upgrade outbox never meets this case.
2. **Idempotency.**
   * An `op_id` already seen **by the same actor** returns `duplicate` with the original result, as today.
   * In a space, an `op_id` seen **for another actor** returns `rejected/op_id_taken` with **no entity and no stored
     result**, not recorded, and the client re-issues the op under a new `op_id`.
3. **Handler.** The handler also enforces:
   * that the layer is writable by the actor (§5.4);
   * author-only edits for discussions and posts;
   * quota (storage) for image-bearing payloads.
4. **Record.** `sync_operation` with `actor_user_id`. `ctx.sync.touch(type, id, visibilityKey?)` writes the feed row
   with its `visibility_key`.
5. **Fan-out.** For spaces, after commit, the realtime gateway receives `{seq, entity_type, entity_id, visibility_key}`
   and notifies subscribers who hold that key.

**Entity types after v2**

* Existing, unchanged: `annotation`, `note`, `note_page`, `study_session`, `flashcard`, `review_event`,
  `question_attempt`, `exam_attempt`.
* New in vaults: `annotation_layer`, `timeline_event`, `study_time_event`, `copy_intent`. A `copy_intent` is an
  offline-queued «Start Studying» that the server turns into a `document_copy`.
* New in spaces: `crdt_update`, `discussion_thread`, `discussion_post`, `room_event`, `annotation` (items of
  `group_comments` and `suggestion` layers, author-only).

### 8.4 Pull filtering in spaces

* `sync_change.visibility_key` values: `NULL` (all members), `pub:<id>` (a publication's audience), `collab:<id>`,
  `room:<id>`, `thread:<id>` (restricted threads), `mod` (moderators only: drafts, reports).
* `authz.visibilityKeys(viewer, spaceId)` returns the viewer's key set when the space is bound. The pull query is
  `… WHERE seq > ? AND (visibility_key IS NULL OR visibility_key IN (…)) ORDER BY seq LIMIT ?`.
* A viewer who loses access stops receiving changes. Data already on the device stays there. That is a documented
  limit, never presented as erasure. The client hides the content of a revoked resource on its next pull, using
  `revoked_keys` in the pull response.
* **Gaining access backfills.** `sync_change` keeps one row per entity at its latest `seq`, so rows below the viewer's
  cursor would never be sent after a new ACL grant, room join or thread access. The pull response therefore also
  carries `granted_keys` (keys the viewer holds now but did not at its previous pull, tracked per device in the system
  DB), and for each one the client runs a **backfill pull** `GET …/sync/pull?key=<k>&since=0` that returns every live row
  with that key; afterwards the normal cursor continues. Test: a user granted access to a collaborative copy created
  earlier receives all of its items.
* `serialize()` is called **only** for rows that passed the filter. The handler also re-checks
  `authz.can(view, entity)` as a second gate, and returns `entity: null` with `detail_code: 'hidden'` when the check
  fails.

### 8.5 Realtime channel (`/api/spaces/:s/live`, WebSocket)

Messages are JSON frames, except Yjs payloads, which are base64. Every frame has `t` (type) and `id`; acks carry the
`id`.

| direction | `t` | payload | notes |
|---|---|---|---|
| C→S | `hello` | `{device_id, accept_ink}` | first frame; the server answers `welcome {server_time, keys}` |
| C→S | `sub` / `unsub` | `{doc?: id, room?: id, lecture?: id}` | `authz` checked; denial → `error {code}` |
| C→S | `y_sync1` | `{doc, sv}` | Yjs step 1 |
| S→C | `y_sync2` | `{doc, update}` | Yjs step 2 |
| C↔S | `y_update` | `{doc, update}` | also persisted as `crdt_update` (insert-if-absent by sha256) |
| C↔S | `aware` | `{doc \| room, state}` | presence, cursors, page positions, **in-progress strokes** (transient, never stored; batched, see limits) |
| C→S | `room_event` | `RoomEventDTO` | persisted (append) and fanned out |
| S→C | `feed` | `{seq, entity_type, entity_id}` | a hint to pull; the pull stays the source of truth |
| S→C | `revoked` | `{keys}` | access removed; the client closes views and purges local caches of those keys |
| C↔S | `ping` / `pong` | `{t0}` / `{t0, server_time}` | clock skew estimate for room sessions (NTP-style, median of 5) |

* Backpressure: the server drops `aware` frames first.
* **Limits per role**, so live strokes fit: in-progress strokes are sent as point batches at most every 100 ms
  (≤ 10 batches/s per writer), coalescing the frames in between. A room host or writer may send up to 1,200 frames per
  minute; a viewer 120 (presence, hand, questions); 256 KiB per frame; the server fans out at most 10 batches/s per
  writer to each subscriber and drops stale `aware` frames first. The CRDT doc size cap is in §14. The 200-participant
  online room of §14 is **unmeasured** until the NFR-OP2 load test.
* **Voice in online teaching rooms is not designed.** It needs TURN/SFU servers with a running cost (PRD Q30). Until the
  owner decides, online rooms carry pen, presence and text live, and voice only as a recording; peer rooms on one
  network can carry WebRTC audio directly (ADR-0005 A.2).
* **Compression.** JSON responses ≥ 1 KiB are compressed (gzip or br) over HTTP, and WebSocket frames use
  permessage-deflate; packed ink is base64 inside JSON (+33 %), so a 5,000-stroke page meets the PRD NFR-P3 budget only
  with compression or a binary endpoint (ADR-0004 §2.5).
* Reconnect: the client re-subscribes and runs `y_sync1` again. Persisted updates make any gap recoverable.

### 8.6 P2P store-and-forward (ADR-0005 §A.2–A.4)

```ts
// packages/shared/src/academic/nearby.ts
export interface RelayBundle {
  v: 1;
  bundle_id: string;                // sha256 of the canonical encoding of everything below except `sig`
  room_id: string; space_id: string;
  origin_user_id: string; origin_device_uid: string;   // server-issued device id (never the client's own id)
  origin_seq: number;               // per (origin user, device), contiguous from 1
  credential_id: string;            // the RoomCredential (§7.10) the bundle was made under — the authorization basis
  created_at: number;
  body:
    | { kind: 'ops'; ops: SyncOp[] }                       // only entity types allowed in rooms (§8.3); never vault entities of other users
    | { kind: 'crdt'; doc_id: string; updates: string[] }  // base64 Yjs updates — EVERY peer-to-peer CRDT update travels signed in a bundle
    | { kind: 'room_events'; events: RoomEventDTO[] }
    | { kind: 'file_manifest'; files: { sha256: string; size: number; mime: string; name: string; chunks: string[] }[] };
  enc?: { alg: 'A256GCM'; room_key_id: string; nonce: string };   // body encrypted with the room key (relay-blind rooms)
  sig: string;                      // Ed25519 by the origin device key (registered in the system `device` table)
}
export type VersionVector = Record<string /* `${origin_user_id}:${origin_device_uid}` */, number /* highest contiguous origin_seq */>;
export interface RelayUploadRequest { bundles: RelayBundle[] }       // ≤ 2 MiB per request; files go through upload sessions
export interface RelayUploadResponse { results: { bundle_id: string; result: 'applied' | 'partially_applied' | 'duplicate' | 'rejected'; detail_ar?: string }[];
  vector: VersionVector }           // the server's vector for the room → peers can drop what the server has
```

**Rules**

1. **Peers exchange vectors first, then only the missing bundles.**
   * Files move as verified 1 MiB chunks (64 KiB DataChannel messages) with a chunk bitmap, so a cut transfer resumes.
   * `sources/sniff.ts` and `lib/safe-zip.ts` are server-only, so a received file is **quarantined on the device**:
     its sha256 is checked, it is stored but never opened, previewed, indexed or forwarded as content until it has been
     uploaded and has passed the server's checks; until then the UI says «لم يُفحص بعد».
2. **Peers apply only what peers can resolve.**
   * CRDT updates and room events are applied locally at once.
   * Op-log ops from other users are **shown** as pending room content, never merged into another user's layer.
   * The server stays the only resolver of op-log conflicts.
3. **What may be relayed.**
   * Only bundles whose `body` targets the room's shared layer or doc, the room's discussions, or room events. A
     client never puts vault entities into a bundle except the user's own items they explicitly chose to share.
   * Nothing private is sent automatically (spec §11).
4. **When any member reconnects,** they upload every bundle they hold that the server's vector lacks, including other
   members' bundles if they are a consenting relay. The server:
   * verifies the signature with the key registered for `(origin_user_id, origin_device_uid)`;
   * checks the bundle's `credential_id`: a credential the server issued to that user and device for that room, valid
     at issue time, issued **before** any server-side revocation of the user's membership or room role, and not expired
     when the bundle's room session started (the session epoch the host recorded, itself checked against the host's
     credential). `created_at` is client-chosen and signed, so it is **never** the authorization basis — a removed
     member cannot backdate;
   * applies each op as that origin actor; every CRDT update is validated as in §4.4 before it is accepted;
   * records a `relay_receipt`.

   An unverifiable bundle is rejected and reported to the room host. No bundle can impersonate another user, because
   the actor is the signed origin and never the uploader.
5. **Duplicates.** The same bundle arriving through several relays is deduplicated by `bundle_id` and by
   `(origin_user_id, origin_device_uid, origin_seq)`. Device ids are server-issued and globally unique, so one user
   cannot register another user's device id and pre-empt their sequence numbers; op ids seen while relaying cannot be
   squatted either (`op_id_taken` is never recorded and the victim re-issues, §8.2).
6. **Encryption.** Bundles are signed always and encrypted when the room is relay-blind. The room key is **never in a
   QR**: the host sends it over the DTLS link, wrapped to the joiner's device key, only after verifying the joiner's
   `RoomCredential` (§7.10).

### 8.7 Several users and devices on the web

* One outbox per user, ordered per target DB.
* On sign-out, the outbox is frozen. It is pushed again only when the same user signs in (ADR-0003 §3.7).
* A device id is generated per user per device, so two users on one tablet are two `device` rows, each with its own
  server-issued `device_uid`.
* Every `localStorage` key and every crash-recovery draft is per user (§4.5); pre-multi-user clients are refused by
  version.

### 8.8 Guarantees (each with a test, §16)

* **No lost writes.** An op that fails transiently stays in the outbox. Rejected ops on read-only layers are re-homed
  to the personal layer. A conflict always keeps both.
* **No duplicates.** `op_id`, CRDT update hashes, `bundle_id`, origin sequences, deterministic copy ids and chunk
  hashes deduplicate.
* **Restart mid-sync.** The outbox, chunk bitmaps and relay stores are persisted in IndexedDB before acknowledgement.
  Jobs resume from checkpoints.
* **Cut mid-file.** Chunk bitmaps resume from the last verified chunk. The whole-file sha256 is verified at the end.

### 8.9 Limits (configurable)

| limit | value |
|---|---|
| ops per push | 500 (unchanged) |
| pull page size | 1,000 (unchanged) |
| sync payload | 2 MiB (unchanged) |
| chunk size | 4 MiB (8 MiB route limit) |
| CRDT doc size before compaction is forced | 16 MiB |
| relay store per device | 256 MiB, TTL 24 h |
| room participants offline (star topology) | 30 (PRD Q27) — **untested** beyond two peers; each joiner pairs by its own QR exchange |

## 9. Timeline model

### 9.1 One clock, original time

* **The clock** is either an in-app recording (`audio_recording.id`, the client recording ULID) or a room session
  (`room_session.id`).
* **Offsets** are milliseconds from the clock start in **original time**, with paused time excluded. This is exactly
  what `InkAudioLink.offset_ms` already uses (`ink/audioLink.ts`, `recorder.ts`).
* **No compressed time is ever stored.** Skip-silence playback maps original ↔ compressed time on the fly (ADR-0006
  §2.6).

### 9.2 Tracks and where each one comes from (one source of truth per track; merged on read)

| # | spec §7 track | source | status today |
|---|---|---|---|
| 1 | lecturer speech | the audio file (`audio_asset`), `audio_interval` (speech/silence) | audio exists; intervals new |
| 2 | transcript | `transcript_segment` (`start_ms`/`end_ms`, run, `lang`, words) | exists (manual / VTT); ASR new |
| 3 | open page | `timeline_event(kind='page_view')`, logged by the reader while a recording runs: debounced 1 s, with page id/index and zoom | new |
| 4 | pen, drawings, highlights | `annotation` rows with `data.audio_link` (ink, shape — exist) **plus** `text_highlight`, text box, sticky and image annotations get `audio_link` too (`audioLinkAt` extended); index `0273` | partial → complete |
| 5 | photos | image annotations or camera captures with `audio_link` + `timeline_event(kind='photo')` | new |
| 6 | questions and notes | typed notes, quick-add questions and chat questions while recording → `timeline_event(kind='note' \| 'question', ref)` | new |
| 7 | AI marks | `exam_highlight` + `timeline_event(kind='chapter' \| 'ai_mark', origin='ai' \| 'derived')`, labelled generated | new |
| — | room events | `room_event` on the session clock | new |

### 9.3 Read model

```ts
// packages/shared/src/academic/timeline-api.ts
export interface TimelineResponse {
  clock: { kind: 'recording' | 'room_session'; id: string; started_at: number; duration_ms: number | null;
           audio: { audio_id: string; stream_url: string; seekable: boolean | 'unknown' } | null };
  tracks: {
    pages: { t_ms: number; dur_ms: number | null; page: PageRef; source_id: string }[];
    strokes: { t_ms: number; annotation_id: string; kind: string; page_id: string | null; layer_id: string | null }[];
    transcript: { segment_id: string; start_ms: number; end_ms: number; text: string; corrected: boolean; lang: string | null;
                  speaker: string | null }[];
    events: { id: string; t_ms: number; kind: string; ref: { type: string; id: string } | null; label_ar: string; origin: string }[];
    highlights: ExamHighlightView[];
    chapters: { t_ms: number; title: string; origin: 'derived' | 'ai' | 'owner' }[];
    silence: { start_ms: number; end_ms: number }[];
  };
  completeness: { transcript: 'none' | 'partial' | 'complete'; page_log: boolean; reason_ar?: string };
}
```

### 9.4 Interactions

* **Tap a transcript sentence → time and page.** The page is the last `page_view` at or before `start_ms`, labelled
  «تلقائي» (automatic). If there is none, the page of the nearest stroke. If there is none, a manual
  `media_region_link`. If there is none, no page, with «لم تُسجَّل الصفحة» (the page was not recorded).
  `AUTOLINK_AR` stops saying «غير مبني» (not built) only when this is built.
* **Tap writing → audio.** The existing `audio_link` play-at-moment (tested in `e2e/f4-handwriting-audio.spec.ts`) is
  extended to the new item kinds.
* **Replay player** (spec §13).
  * It draws strokes progressively on the page canvases: stroke start = `audio_link.offset_ms`, and the point times
    `InkPoint[2]` (ms since stroke start) pace the points. It reuses `render.ts` painters and the dirty-rectangle
    path.
  * The audio clock drives it. Speed applies to `playbackRate` and to the animation clock together. Audio and writing
    can each be hidden.
  * The transcript stays in sync, with the current segment highlighted. Jumps go to chapters and exam highlights.
  * «انسخ لقطة» (copy a snapshot) captures a region of the page, including printed content, into the user's own note
    page as an image annotation. Attribution is added when the content comes from someone else's publication.
* **Study Time Machine.** The state of a document at time T is:
  * current rows;
  * minus items created after T;
  * with `annotation_revision` before-images applied in reverse for changes after T;
  * plus CRDT updates up to T for collaborative layers.

  It opens read-only. «استعد هذه الحالة» (restore this state) writes a new state (§6.6).
* **Several devices in one room.** Each device stores `t_ms` corrected by its measured skew (`skew_ms`, from
  `ping`/`pong`) on the room session clock. Personal recordings stay on their own device clock (unchanged).

## 10. AI orchestration additions

### 10.1 Tasks and policy

* **New `AiTask` values:**
  * `radar_extract` — question and answer span extraction around a cue, from transcript windows given as untrusted
    content;
  * `chapterize` — topic segmentation from transcript plus page log plus PDF headings;
  * `live_summarize`;
  * `live_translate` — spec §9 Live Translation: final transcript segments → a translation labelled «ترجمة مولّدة»
    that keeps Latin-script terms verbatim (the same term-preservation check as AOS-10.22); never stored as transcript
    text;
  * `suggest_cards` — spec §9 Live Flashcard Suggestions: from a detected question and its lecture regions, card
    suggestions shown quietly in «المباشر»; a card is created server-side, evidence-validated, only when the user
    accepts it (`POST …/card-suggestions/:sid/accept`);
  * `generate_cards` — server-side, evidence-validated flashcards; today sync refuses device-created `generated` cards,
    and that rule stays.
* **`transcribe` moves to the speech orchestrator** (ADR-0006). The AI task keeps its name for capability display.
* Everything else reuses existing tasks: tutor answers (`chat`, `explain`, `summarize`, `compare`,
  `generate_questions`), copilot answers (`chat`) and image explanations (`vision_figure`).
* **Policy is unchanged**: Source Lock check, delimiting of untrusted content, schema validation plus one repair,
  `usage_record`, abstention. **Additions:**
  * the per-user allowance through an atomic reservation (§14);
  * the viewer dimension in scope and cache (§10.6);
  * a per-session cap for live features.

### 10.2 Exam Radar (spec §8)

1. **Detector `phrase-v1`** (deterministic, testable here on manual or VTT transcripts):
   * Arabic, Iraqi-dialect and English cue patterns over normalised segment text (`ml_norm` rules):
     * «هذا سؤال امتحاني», «ركزوا على», «مهم جدًا», «دائمًا يجي بالامتحان» / «يجي بالامتحان» / «راح يجي»;
     * «ممكن أسألكم عن»;
     * English interrogatives such as «what is the most common cause of», «what are the branches of».
   * Each hit becomes an `exam_highlight` with `cue_quote` = the exact words and `t` from the segment.
2. **Detector `repetition-v1`.** A term repeated in ≥ 3 segments within 10 minutes, plus a heading match → `repetition`
   cue, labelled as repetition, never as «exam question».
3. **Optional AI scorer** (`radar_extract`, AI-gated). Over a window of ±60 s it extracts `question_text` and
   `lecturer_answer_text` spans **only as substrings of the transcript**; the server checks containment and drops
   anything else. Otherwise it returns `not_stated` or `unclear`, never invented text (spec §8 last line).
4. **Page.** From the page-view log at `t` (`page_origin`).
5. **Separate origins.**
   * The lecturer's answer is stored **verbatim** in `exam_highlight.lecturer_answer_text`. It is **never** written to
     `answer_key_entry` or `question_version.correct_option_ids_json` as a source key. This is the AC-13 rule.
   * «أضف إلى بنك الأسئلة» creates an **owner** question with `answer_status 'unresolved'`, unless the user adopts the
     lecturer's answer as their **own** key (`owner_key`, `key_details_json.origin = 'lecturer_said'` with the
     recording time). The UI labels it «إجابة الدكتور في التسجيل (الدقيقة m:ss)» (the lecturer's answer in the
     recording, minute m:ss).
   * A generated answer is a separate artifact with claims and evidence: the existing pipeline, `lecture_only` by
     default.
6. **Honesty.**
   * Every radar surface carries «مؤشر من كلام الدكتور، وليس توقعًا مؤكدًا» (an indicator from the lecturer's words,
     not a certain prediction). This is the Exam DNA pattern.
   * **Exam DNA never counts radar items.** It still counts only `question_source` / `previous_exam` (AC-27 / §40
     unchanged).
7. **Suggested review list.** Accepted highlights appear as a «مقترح للمراجعة» (suggested for review) group in the
   revision builder and planner. The user adds them explicitly; plans are never changed automatically.
8. **Dashboard** (`RadarDashboard`): per lecture, with counts and denominators («3 إشارات من 2 تسجيل، 1 منها مع
   إجابة الدكتور» — 3 cues from 2 recordings, 1 of them with the lecturer's answer).

### 10.3 Live copilot (spec §9)

```
mic ─► MediaRecorder (saved, 4 s chunks → IndexedDB)   ← unchanged, never depends on the copilot
  └──► AudioWorklet (16 kHz) ─► Worker ─► WS /api/copilot/live ─► SpeechStream (ADR-0006)
                                                    finals ─► transcript_segment (run: streaming)
                                                           ─► phrase-v1 detector ─► exam_highlight (suggested)
                                                           ─► [AI, budgeted] chat pipeline (lecture_only) for a detected question
                                                           ─► [AI] live_summarize every N minutes; topic → Course Brain concept match
                                                           ─► [AI] live_translate per final segment (opt-in feature)
                                                           ─► [AI] suggest_cards from detected questions (accept → server-side card)
   every [AI] arrow and any cloud ASR need the subject's lecturer policy to allow external processing plus the user's
   own consent (§5.6); otherwise those features are off with the reason and only local work runs
  side panel (calm, StudyRail slot / bottom sheet on phones) ◄── partials (draft style), detections, answers with chips
```

* **Isolation.**
  * The worklet and worker are off the ink thread, so the pen path gets no extra work (docs/PERFORMANCE.md budgets
    re-run).
  * A copilot failure shows a quiet notice and stops the copilot only. Recording and writing continue
    (ADR-0006 §2.3).
* **Budget.**
  * `copilot_session.budget_cap_usd` comes from the user's allowance.
  * Translation and card suggestions draw on the same session budget; translation is the first feature paused when
    the budget passes 80 %.
  * At 80 % the panel says so. At 100 % the session goes to `paused_budget`: live transcription may continue if the
    engine is server-local and the user's **CPU-minute** quota has room (local is not free: it costs CPU, ADR-0006
    §2.13); AI answers stop.
  * Estimates only.
* **One-tap «أضف إلى ملاحظاتي»** (add to my notes) reuses `saveAnswerAsNote` (`studybook/chat.ts`): origin
  `ai_answer`, idempotent.
* **Slide sync** is a suggestion only: «الدكتور غالبًا في ص 12» (the lecturer is probably on p. 12), from transcript ↔
  page text similarity, or from a camera photo match (§11.4). It never flips the student's page automatically.
* **Offline.** The recording continues. The copilot shows «يعمل عند الاتصال» (works when connected). After upload, the
  batch transcription and radar run as jobs (spec §9 «no claim that everything works offline»).

### 10.4 Tutor (spec §14)

* **Per-user Source Lock.** `scope.resolve(viewer, SourceScope)`. Stubs resolve to space versions. Retrieval reads
  space chunks through `ctx.dbs.space()` (allow-listed, §1.1) with the scope tokens inside `MATCH`. Evidence rows used
  by vault artifacts are **pinned lazily** into the vault (ADR-0003 §3.3), so citations stay rows
  (ARCHITECTURE rule 2).
* **Course-wide tutor thread.** Scope = the lectures of a subject the user has copies of, plus their references. The
  existing `contextual_thread` gets a course anchor. Multi-file summaries extend `SummaryRequest` to several
  `source_id`s, with AC-03 coverage per source.
* **«USMLE style»** is a named preset over existing `GENERATED_ITEM_TYPES` (vignette, next_step, …) for medical subjects.
  Non-medical subjects get generic presets. No claim of official style.
* **Generated cards** (`generate_cards`) are created server-side with evidence ids. Sync still refuses device-created
  `generated` cards.
* **Community cards** (a publication's deck) are copy-on-use into the vault. Each user keeps their own FSRS state
  (`review_event` is per vault).

### 10.5 Origins kept separate (spec §14 «فصل كلام الدكتور عن الشرح المولد وعن المرجع الخارجي»)

| origin | where from | can be evidence for a medical claim? | label |
|---|---|---|---|
| `source` | lecture or reference regions (digital / OCR) | yes (OCR-only → `needs_review`, H1-3) | existing source chips |
| `lecturer_said` | ASR or manual transcript regions (`text_origin_ext='asr'` or manual) | yes, as a machine reading. ASR regions start as `status='needs_review'`, so the existing `claims.ts` rule (G3/H1-3) keeps claims at **needs_review**. A segment the user corrected or confirmed becomes `owner_reviewed`, like reviewed OCR | «قال الدكتور (الدقيقة m:ss)» |
| `generated` | model output | no (it *carries* claims) | existing «مولَّد» |
| `external_reference` | an **uploaded reference source** (a book or article in the user's vault or the subject's attachments, `source_type` reference/book) — the spec's «المعلومة المستمدة من مرجع خارجي»; evidence from the open web stays `external.evidence` = `not_implemented` and is not required | yes, as any source region | «مرجع» (distinct from «رسمي»), with title and page |
| `student_contribution` | publications, posts, suggestions, crowd notes | **no** | «شرح طالب — ليس مصدرًا» |
| `moderator_reviewed` | a publication with `moderator_review = 'reviewed'` | **no** (a review is not evidence; rule 7: no «verified» badge) | «راجعه مشرف المادة بتاريخ …» |
| `my_notes` | the user's notes | only with `include_my_notes`, low assurance (unchanged) | existing |

### 10.6 Scope and cache keys with a viewer

* `ResolvedScope` gains `viewer_user_id` and `private_parts`: `include_my_notes`, private uploads and personal
  recordings.
* The cache key (`evidence/cache.ts`) adds `viewer_scope_hash`:
  * `hash(user_id)` **only** when `private_parts` is non-empty;
  * otherwise a constant.

  So an artifact built purely from official content of a space can be reused by every member. It is stored **in the
  space** («shared cached study books», ADR-0003). An artifact that touched private content is stored in the vault and
  is never served to anyone else.
* **⚠ BREAK fixed.** Today `findReusable` reuses any artifact with the same key. With the viewer dimension and
  storage location, a lecture-only request still never hits a wider-scope artifact (§3.7 unchanged), and a user never
  hits another user's private artifact.

### 10.7 Lecture Fusion, Professor-vs-Reference, AI pen

* **AI Lecture Fusion** (§19B) is a sectioned artifact. Its inputs are the lecture file, transcript regions
  (`lecturer_said`), the user's handwriting readings (low assurance, explicit), accepted radar highlights and photos
  (as figures). Each block keeps its origin chips. The existing AC-03 coverage and AC-22 anchors apply.
* **Professor vs Reference** (§19D) uses a scope of `lecture_audio` + chosen references. Statements are compared with
  the existing `compare` task. A conflict is reported only when the verifier confirms it; otherwise it is
  `needs_review`, with «تعارض محتمل — لم يُتحقق منه» (possible conflict — not verified). The scope is never widened
  silently.
* **AI pen** (§10).
  * A lasso over printed text resolves the regions under the path and opens the same selection actions.
  * Handwriting actions first need a reading (existing recognition).
  * Read Aloud and Pronunciation use `speechSynthesis` after probing for voices, and are labelled as generated audio.
    The capability is `requires_native` / `not_available` when there are no Arabic or English voices.

## 11. Search and vector indexing

### 11.1 Federation

1. **Plan.** The vault plus the spaces where the viewer has an approved membership, limited by `scope` (`mine` |
   `subjects` | `all`).
2. **Query.**
   * In the vault, run today's queries unchanged (`chunk_fts`, `question_fts`, `owner_content_fts`).
   * In each space, use `chunk_scope_fts` with `scope` tokens for the **allowed versions** (published heads plus the
     versions the viewer's copies pin; drafts for moderators), and `community_fts` with visibility tokens from
     `authz.visibilityKeys`. A visibility set larger than 500 tokens falls back to a post-filter on a capped candidate
     set, flagged in `searched`.
3. **Merge** with reciprocal-rank fusion (k = 60). Ties are ordered source before owner before generated before
   community (the existing ordering idea: generated ranked after sources).
4. **Label.** Every hit carries `db`, `origin` and `is_evidence` (§7.12). Community hits say «شرح طالب — ليس مصدرًا».

Measured basis: per-user FTS takes 0.09–0.16 ms (vault); a space with the scope inside `MATCH` takes 8–14 ms over 246k
chunks (ADR-0003 §2). bm25 statistics in a space contain only space content, so there is no cross-tenant side channel
from private data.

### 11.2 Semantic search (when an embeddings provider exists)

* `chunk_embedding` (exists, unused) gets rows per database. Its metadata goes in `embedding_index`.
* **Retrieval:** the Source Lock pre-filter by version, then brute-force cosine over the remaining chunks, capped at
  20,000 chunks per query. Above the cap, semantic search is offered only inside a narrower scope, and the UI says so.
* A library-wide ANN index (for example `sqlite-vec`) is a later decision that needs measurement first.
* **Similarity is never support.** Claims still go through `validateClaims` (ARCHITECTURE §3.6).
* **Today:** no provider → `search.semantic` stays `requires_configuration` (`FEATURE_DISABLED` on `mode=semantic`,
  unchanged). A local multilingual embedding model is a candidate only after measurement on Arabic medical text.

### 11.3 Handwriting, transcripts, discussions

* **Handwriting.** Readings (`ink_recognition`) stay in the vault's `owner_content_fts`. Background recognition of all
  ink is a later, AI-gated option with per-user quota.
* **Transcripts.** Index both `text` and `normalized_text`. Hits offer «شغّل من m:ss» (play from m:ss), plus the page
  from the timeline (§9.4).
* **Discussions and publications.** `community_fts` in spaces. «Search all students' questions of the subject» (§6) is
  `types=discussion` with `scope=subjects`.

### 11.4 Image and slide-photo search (Scenario 6)

1. The upload stays in tmp and **never becomes a source**. The EXIF orientation and rotation detection of Round 7 H2
   are reused.
2. Run tesseract `ara+eng` OCR (bundled).
3. If OCR fails, abstain with the existing `OCR_FAILED` reason.
4. Search FTS over the allowed scopes with the OCR tokens. Take the top 20 candidate pages.
5. Rerank with the dHash of the page thumbnail (`page_fingerprint`) against the perspective-corrected query.
6. Report the confidence as `high` / `medium` / `low` **with its basis** («تطابق 38 كلمة من 44»، «تشابه بصري قوي» —
   38 of 44 words matched, strong visual similarity). These are never fake percentages.
7. With no candidate above the threshold, return `abstained` with the reason. Nothing is invented.

Testable here with synthetic slide photos (rotated, skewed, low light). This matcher ships in **Phase 2** (Scenario 6,
PRD §5); the Phase 3 lecture camera (AOS-19A.2) reuses it unchanged.

## 12. Notifications

| kind | trigger | recipients | dedupe |
|---|---|---|---|
| `join_requested` / `join_decided` (Phase 1) | membership pending / decided | moderators of the node / the requester | per membership |
| `invitation` | channel invitation | invitee | per invitation |
| `official_lecture_new` | lecture published | members with `course_follow` (and stubs auto-added when `add_new_lectures`) | per lecture |
| `official_version` (Phase 1) | new head version | holders of a stub of that lecture, found through `lecture_copy` (§6.3) | per version |
| `subject_update` (Phase 1) | a `subject_event` (attachment, exam date) | members of the subject who follow it | per event |
| `publication_new` | publish | followers (scope-matched) within its visibility | per publication |
| `publication_updated` | republish | followed and forked copy holders, followers | per version |
| `suggestion_received` / `suggestion_decided` | suggestion created / decided | author / suggester | per suggestion |
| `reply` / `answer_accepted` / `mention` | discussion activity | thread author, post author, mentioned users (members only) | per post |
| `room_invite` / `room_starting` | rooms | invitees / participants | per session |
| `moderation` (Phase 1) | hide / restore / request changes on your content; a report you filed was decided | the author; the reporter | per action |
| `report_received` (Phase 1) | a new report in your subject | the subject's moderators and assistants | per report |
| `reanchor_ready` | a re-anchor report finished | the user | per report |
| `quota_warning` | 80 % / 100 % | the user | per month and kind |

* **Fan-out** is a job that writes `notification` rows in the system DB in batches of 500, with `dedupe_key`. The
  payload holds titles and counts only.
* **Inbox.** `GET /api/notifications` (in-app, Arabic, grouped per day). Preferences per kind × channel.
* **Push** is opt-in per device, using Web Push (VAPID) on the PWA.
  * DOC, untested: iOS supports Web Push only for a PWA installed to the Home Screen (iOS 16.4+).
  * Native push comes with the shell (ADR-0005).
  * The capability `notifications.push` is probed per device and never assumed.
* **No dark patterns.** No streak nags, digest batching for busy threads, and quiet hours that follow the user's
  timezone.

## 13. Moderation and audit

* **Phase 1 minimum** (course-only publications go live at once, so something must stand behind them): reports on
  publications → the subject's moderators' queue → hide / restore / dismiss with an Arabic reason; author and reporter
  notified; audit entry. Phase 2 adds the approval queue for «عام», request changes, «راجعه مشرف المادة», appeals and
  reports on every other target.
* **Reports.** Any member can report a publication, version, thread, post, suggestion, profile, room or official
  lecture. The `reason` list includes `patient_identifiers` (medical privacy) and `copyright`.
  * Reports go to the moderators of `scope_node_id`, and only one open report per reporter per target is allowed.
* **«راجعه مشرف المادة»** is given only by a Subject Moderator of that subject (or an Admin holding that role there);
  the badge names that role and the date. Assistants hide, restore and request changes, but never mark reviewed.
* **Actions:** hide, restore, request changes, mark reviewed, remove a post (tombstone), lock a thread, warn or suspend
  a user.
  * Every action needs an Arabic reason that the author sees.
  * Authors can ask for re-review through a new report kind, `appeal`, handled by a different moderator when one
    exists.
* **What moderators can see:** published content of **their subject**, the reports and the reporter's note. **Never**
  vault content. No route exists for it, and the binding hook cannot bind another user's vault. (The operator of the
  host is a different matter: see §5.1 and the privacy page.)
* **Audit.**
  * Per DB, `change_log` (existing) gains `actor_user_id` and `actor_role`. It stays the user-visible history (vault)
    or the space history (official lecture corrections, page-map decisions).
  * The system `security_audit` holds security and administrative actions (§4.1), with scoped views for Admins
    (`/api/admin/audit`).
  * `before_json` / `after_json` of shared objects never include another user's private content.
* **Usage and quality statistics** (§18).
  * Aggregates per subject: active members, lectures opened, publications, reports, accepted corrections.
  * Computed by a nightly job from system and space rows.
  * Any cell under **5 users** is suppressed: «أقل من 5». Exam-room aggregates use the stricter rule of §7.10 (≥ 10,
    viewer excluded, coarse buckets, per-concept table for the host only).
  * Statistics never reach into vaults, except through opt-in events (ADR-0003 §4).

## 14. Quotas, limits and cost controls

| limit | default (configurable env / admin) | enforcement |
|---|---|---|
| storage per user (vault DB + referenced blobs, deduplicated per blob) | 2 GB (PRD Q22; ≈ 69 h of recording at 64 kbps, PRD §6.2) | upload sessions and annotation images; `QUOTA_EXCEEDED` with used / limit |
| storage per subject space (official lectures, attachments, shared recordings, shared artifacts) | 20 GB (PRD Q22), `space_quota` | moderator uploads; warnings at 80 % to the subject's moderators |
| single file | `MEDLEVO_MAX_UPLOAD_MB` (existing, 200) | unchanged; long recordings use chunked uploads |
| AI allowance per user per month | **0 USD for new users**; user #1 = today's `MEDLEVO_AI_MONTHLY_BUDGET_USD` | atomic reservation in `ai_budget_ledger` before every provider call; settle with the estimated cost after; release on failure |
| deployment AI ceiling | `MEDLEVO_AI_MONTHLY_BUDGET_USD` | checked inside the same reservation transaction |
| ASR minutes per user per month | 0 until an engine is enabled (ADR-0006) | cloud engines: reservation by minutes × the engine's estimated price |
| ASR **CPU-minutes** per user per month (server-local engines) | 120 once an engine is enabled (PRD §6.2; ≈ 2.4 h of audio with the smallest measured model) | reservation by audio minutes × the engine's measured CPU-minutes per audio minute; the shared transcript of a shared official recording is charged to the space, not to students |
| ASR CPU-minutes per subject space per month | set by the platform admin (`space_quota`) | the same reservation, for shared recordings |
| AI allowance per subject space per month | set by the platform admin (`space_quota`); used by shared official-only Study Books | atomic reservation as for users |
| live copilot session cap | 0.50 USD estimate per session (PRD Q10) | `copilot_session.budget_cap_usd` |
| rate limits | today's presets keyed by **user id** + per-IP ceilings high enough for a class behind one campus NAT | `@fastify/rate-limit` keyGenerator = `viewer.userId ?? ip` |
| failed sign-ins | per account: progressive delay (1 s doubling to 60 s after 5 failures), **no hard lockout**; a recovery code always works; per IP: 300 per hour | `LOGIN_SLOWED` with `retry_after_s` |
| join-code attempts | 10 per hour per account; per IP 1,000 per hour (a whole class joins from one NAT on day one); codes are 8 base32 characters (40 bits), so guessing stays impractical at that rate | `JOIN_CODE_INVALID` + backoff |
| publications | 20 per day per user | `RATE_LIMITED` |
| ratings, likes, follows | 100 per hour per user | `RATE_LIMITED` |
| rooms | 3 concurrent hosted rooms per user; 200 participants per online room (**unmeasured** until the NFR-OP2 load test); 30 offline (**untested** beyond two peers) | `QUOTA_EXCEEDED` |
| recording retention | subject recordings: until the recorder or a moderator deletes them; room recordings: one academic year unless pinned (PRD Q24) | a nightly retention job deletes expired room recordings (stored_file rows; the GC removes bytes) and notifies the host 14 days before |
| CRDT doc | 16 MiB before forced compaction; 64 MiB hard cap → new strokes ask for a new page | `collab` |
| relay storage | 256 MiB per device, TTL 24 h | client |

**Cost honesty.**

* The UI shows **estimated** costs and the remaining allowance (existing «تقدير» wording).
* A request that would exceed the allowance fails **before** the call with `QUOTA_EXCEEDED` / `AI_BUDGET_EXCEEDED`.
  It is never silently degraded.
* Shared space artifacts (§10.6) let a class reuse one Study Book instead of paying for one per student, and one shared
  transcript per shared official recording replaces one per student (ADR-0006 §2.13).
* **Operational costs and capacity** (hosting tiers, R2, AI and ASR envelopes) are in PRD §6.2, updated in every phase
  report; no capacity figure is stated before the NFR-OP2 load test.

## 15. Existing features preserved — checklist

### 15.1 Method

A user who never joins a channel must get **exactly today's MedLevo**: their vault is today's database. The proof is
mechanical:

1. **The full existing suites run against one bound vault.** About 2,030 tests: 1,260 server, 715 web, 57 shared
   (`docs/TEST_LOG.md`), plus the e2e specs. `createTestApp()` binds system + user + vault, and the harness wraps every
   test body in `withTestBinding` (§1.1), because hundreds of tests touch `ctx.db` and the job queue outside any
   request. That mechanical change is expected. Any **other** edit to an existing test is a regression unless the row
   below says the section is superseded (fully or partly); the Phase 1 report lists every such edit with its row.
2. **The rows marked «+ space» rerun the same acceptance group with the lecture held as a stub of an official
   lecture.** This proves the evidence contract, Source Lock and anchors across the vault–space boundary.
3. **The owner-migration test.**
   * Take a fixture database built with today's schema from the Golden Set (sources, ink, notes, questions, cards,
     recordings, backups).
   * Run `migrate:multi-user --apply`.
   * Check that the vault file's sha256 is unchanged **before the first boot**; after the first boot record the new
     checksum and the per-table row counts again (base migrations may run then, ADR-0003 §5); login works with the old
     password, the recovery code validates, and a pull continues with the same cursor and epoch.
   * Replay a legacy IndexedDB outbox queued before the upgrade: every op is applied exactly once and none stays
     `rejected` (the legacy devices were seeded, §8.3).
   * Inject a crash after every step of the migration journal: each run resumes to the same end state, and the server
     never enters setup mode while a legacy database or vault files exist.
   * Link and promote existing lectures (§6.9): counts reconcile.

Legend for «impact»:

* **=** unchanged: runs in the user's vault.
* **+** extended: additive; the old behaviour is kept and guarded by the listed tests.
* **S** superseded by ADR-0003: the replacement is named.

### 15.2 Spec sections §00–§62 (`docs/REQUIREMENTS_MATRIX.md` part A)

| § | requirement (short) | impact | how it stays intact / guard |
|---|---|---|---|
| 00 | Skills audit | = | documentation |
| 01 | Personal medical study system | = | it *is* the vault; AC-01a |
| 02 | Single owner; Control Center instead of an admin panel | **S** | ADR-0003: multi-user, private by default. Kept: a personal Control Center per user (vault), auth, file protection, history. Whole-instance backup and the other platform operations move to the platform admin (§5.8). The admin area is separate and never reads vaults |
| 03 | Non-negotiables (evidence, original vs generated, no «100 %») | + | unchanged, plus «student content is never evidence» (§10.5); g2 suites + space rerun |
| 04 | Core journey | = | stubs bring official lectures into the same journey; f-track e2e specs unchanged |
| 05 | Library | = | `library_node` untouched; course follow only *adds* stubs into a folder the user chose |
| 06 | Source registry, suggested types | = | stubs are `source` rows with `is_stub = 1`; `source_type_origin` and the review rule unchanged |
| 07 | Source → Version → Page → Region | = | stubs reuse space ids; regions pinned lazily (`foreign_key_check` = 0, spike S5) |
| 08 | Source Lock | + | the same semantics; space scope tokens inside `MATCH`; viewer dimension. AC-05/AC-29 + space |
| 09 | Per-task source priority | = | — |
| 10 | Provenance chain, claim citations | = | citations stay rows (lazy pinning). AC-06 + space |
| 11 | Source chips, Evidence Peek, Open Source | = | «Open Source» on a stub opens the space page through the stub ids |
| 12 | Three axes, precise statuses | + | ASR evidence = machine reading → `needs_review` (like H1-3 OCR) |
| 13 | Upload pipeline | + | vault unchanged; official uploads use the same pipeline inside a space; chunked uploads are additive |
| 14 | Layout analysis | = | — |
| 15 | Explain the Figure | = | AI-gated as today |
| 16 | Course Brain | + | per database. ⚠ global concept tables stop being shared across users: the vault holds personal corrections, the space holds community ones (no cross-user renames). f2 suites unchanged |
| 17 | Compile once, study many | + | shared cached artifacts in spaces only for official-only scope (§10.6) |
| 18 | Artifact versioning, Source Freeze, content alerts | = | a new official version raises `source_replaced` in stub vaults; AC-26 unchanged |
| 19 | Explanation Rules Engine | = | per user |
| 20 | Teaching engine | = | — |
| 21 | Term dictionary, bidi | = | per database; ASR vocabulary *reads* it |
| 22 | Design system | + | new screens use tokens; e-ink mode extends the motion and contrast tokens |
| 23 | Workspace layout and navigation | **S (part)** | **Partly superseded:** the app shell goes from four destinations to five (IA §3.1: «القنوات» and «أنا» added; «الإعدادات» moves under «أنا»). Specs that change: `e2e/smoke.spec.ts` (clicks `nav('الإعدادات')`, line 158) and `e2e/g1-ac01-personal-library.spec.ts` (asserts exactly الرئيسية/المكتبة/المراجعة/الإعدادات, line 103 — superseded by AC-01a/01b anyway); web tests that open Settings by its nav label are re-checked. The workspace part is extended only: layers panel and copilot slot in the existing rail and sheet; visual checks at 390 / 1280 unchanged |
| 24 | Lecture Twin | = | — |
| 25 | Page and semantic anchors | + | unchanged within a version; cross-version rules **copy, never move** (§6.3). AC-21, AC-22 + Scenario 4 suite |
| 26 | Reader tools | = | — |
| 27 | Pencil capability matrix, honest web vs native | + | native shell rows added; mouse never validates Pencil (AC-28 unchanged) |
| 28 | Handwriting | = | the recognition crop still holds only the user's own strokes (layer filter applies) |
| 29 | Lecture audio, voice notes | + | ASR, timeline and consent added; explicit start, original kept, speakers never guessed |
| 30 | Study rail selection actions | + | AI pen (lasso over printed text) is additive |
| 31 | Summaries, compare, knowledge map | + | multi-file summaries additive; AC-03 coverage per source |
| 32 | Medical Image Explorer | = | — |
| 33 | Question Vault | = | discussions and radar only *add* owner questions; keys never changed |
| 34 | Extraction verification | = | — |
| 35 | Lecture ↔ question matching | + | stub lectures match through space chunks (read path); AC-16 + space |
| 36 | Duplicates, coverage | = | per database |
| 37 | Generated MCQs | = | AI-gated |
| 38 | SBA validation | = | — |
| 39 | Study modes, exam builder, no leaks | + | exam rooms reuse the policy; AC-19 + exam-room test |
| 40 | Exam DNA | = | **radar items excluded** (§10.2); AC-27 / Exam DNA suites unchanged |
| 41 | Written questions | = | — |
| 42 | Clinical cases | = | — |
| 43 | Flashcards / FSRS | = | per vault; community cards copy-on-use |
| 44 | Learning profile, weakness | = | per vault |
| 45 | Home, planner, one-tap revision | + | dashboard additions (study time, goals, collections) are additive |
| 46 | Universal search | + | federation; vault queries unchanged; e2e search specs unchanged for a no-channel user |
| 47 | Offline-first, sync | + | ADR-0004: v1 ops unchanged; merge policies unchanged; AC-23, AC-24 + two-users-one-device test |
| 48 | Personal Control Center | **+ / S (part)** | per-user sections stay (review queue, alerts, sync conflicts, source priority, explanation rules, own storage and usage); the storage report is rescoped to the user's own blobs; AI provider and models, deployment budget, evaluation, health, client-error list and the global processing queue move to the platform admin (§5.8). Channel administration is separate |
| 49 | Security (auth, private files, validation) | + | multi-user auth; every check kept; AC-01b leak suite + permission matrix; g8 public list +1 route |
| 50 | Modular monolith stack | + | the same stack; three database kinds |
| 51 | AI adapters, per-call records | + | per-user allowance, atomic reservation; ADR-0002 tests unchanged |
| 52 | Hybrid RAG | = | semantic search still needs a provider |
| 53 | Jobs (states, checkpoints, idempotency) | + | job index + binding; `jobs.test.ts` and `jobs-crash.test.ts` unchanged + a two-vault job test |
| 54 | Data model without University / Organization | **S** | the channel tree lives in the **system DB**; the vault schema still has no institution tables |
| 55 | Performance, accessibility | = | docs/PERFORMANCE.md budgets must still pass (5,000-stroke page with layers) |
| 56 | Observability | + / S (part) | `actor_user_id` in logs and audit; secrets never logged; health and client-error views are platform-admin only; a user can still post their own client errors (§5.8) |
| 57 | Golden Set, evaluation | + / S (part) | new fixtures: inserted-page version, slide photos. ASR audio is never committed. Evaluation runs (`npm run eval`, Control Center «تقييم الجودة») become a platform operation, started from the platform section (no terminal needed, PRD AOS-OC.10) |
| 58 | Tests, build, lint | = | — |
| 59 | Requirement status | + | AOS rows are added to the matrix as built |
| 60 | 30 acceptance scenarios | + | kept; AC-01 split (§15.3) |
| 61 | Deliverables, ADRs, backups | + / S (part) | ADR-0003 … 0006; whole-instance backups, restore and `/export/all` are platform operations; each user gets «نسخة من بياناتي» (per-vault export) instead (§5.8) |
| 62 | Final rules | = | — |

### 15.3 Acceptance scenarios AC-01 … AC-30

| AC | impact | guard after the change |
|---|---|---|
| AC-01 | **S → AC-01a + AC-01b** | AC-01a: every step of today's AC-01 (notebook, course, lecture, reference, question source) passes for a user with no channel, with no channel UI on those screens. AC-01b: two users in **two subjects of two universities** in one deployment, and nothing of user A visible to user B through any route, pull, search, export, file, token, AI scope, notification or WebSocket; a moderator of one subject gets nothing of the other; a non-member gets no official quote through a public explanation. Both are Phase 1 exit criteria (PRD §5) |
| AC-02, AC-03, AC-04 | = (+ space) | unchanged in a vault; rerun for an official upload in a space |
| AC-05, AC-06, AC-07, AC-29 | = (+ space) | rerun with a stub lecture whose chunks live in the space |
| AC-08, AC-09 | = | — |
| AC-10 … AC-17 | = | questions per database; AC-16 + space |
| AC-18 | = | — |
| AC-19 | + | plus exam rooms: solutions hidden until the room ends |
| AC-20 | + | new editors (discussions, profiles) pass the same mixed-text checks |
| AC-21 | + | the native ink surface must produce byte-identical normalised `InkPoint`s (device test) |
| AC-22 | + | plus Scenario 4: copies on the new version, originals untouched |
| AC-23 | + | plus a per-user local database |
| AC-24 | + | plus layer re-homing and two users on one device |
| AC-25 | + | plus jobs bound to two vaults resume independently |
| AC-26, AC-27, AC-28 | = | — |
| AC-30 | + | per-vault and per-space backups restore verifiably; restoring one vault does not revoke other users' sessions; whole-instance restore still verified |

## 16. Delivery order and tests

**The phase plan is PRD §5, and only PRD §5.** This section used to carry its own table, which disagreed with the PRD
(where Scenario 2, notifications, history and the slide matcher landed, and an extra «Phase 0»). The tenancy foundation
is now **Phase 1, Wave 1** of [BUILD_PLAN.md](BUILD_PLAN.md); there is no Phase 0. The summary below repeats PRD §5 for
orientation only; BUILD_PLAN Appendix A checks every PRD §7 row against the phase of the track that builds it.

| phase (PRD §5) | engineering content (this document) | exit scenarios | testable here |
|---|---|---|---|
| **1** | system DB, ALS binding with a root context for background work, vault pool, job index, mark-and-sweep blob GC, per-user web database, keys and drafts, client-version gate, journaled owner migration (§1–§4, ADR-0003 §5); authz with the space-route allow-list and §5.8 split; channel tree, codes, QR, invites, approvals, roles; notifications; minimal moderation; official lectures in **per-subject** spaces with attachments, exam-date table and updates feed; page map; stubs, Start Studying, `lecture_copy`; layers, one-layer copy, per-layer history; course-only publications with stable-id delta storage, fork and follow with update preview; note migration; linking private lectures (§6.9); ink v2 codec, e-ink, tile cache | Scenarios 2 and 4; AC-01a, AC-01b, X8, X9; minimal moderation flow | yes, except device runs (PL-0 dry run, iPad latency) |
| **2** | profiles, follows, public / followers / specific users with redaction (§5.2); marketplace ranking (§7.8); discussions; suggestions; full moderation; layer merge; history views, time machine, compare copies; federated search; image and **slide-photo search** (§11.4); AI pen menu; dashboard; exam dates in use; equations; *platform track:* iPad shell, native ink, TestFlight | Scenario 6 | yes; Web Push to iOS, TestFlight and iPad latency need devices |
| **3a** | chunked recording upload, consent and shared recordings; speech orchestrator with a fake engine; evaluation-only runs and the in-app evaluation flow; timeline, replay; radar `phrase-v1` on typed or VTT transcripts; copilot without ASR; lecture camera (reuses the Phase 2 matcher); Exam Mode; *platform track:* Android app, recorder plugin | Scenario 5; Scenario 1 variant A | partly: no real microphone |
| **3b** | an engine evaluated and enabled on the owner's set (floors per stratum); streaming; ASR worker reading audio from R2; shared transcripts; CPU-minute quotas | Scenario 1 variant B; X10 meets the floors | no: real lecture audio and an engine |
| **4** | WebSocket gateway; Yjs collaborative layers with server-side validation, projection, compaction, undo; rooms; WebRTC per-joiner QR pairing with signed offline credentials; relay bundles, vectors, resume | Scenario 3 (Chromium contexts); X3–X7 | partly: Chromium only, one host |
| **5** | course-wide tutor, generated cards, adaptive path, cross-course graph, crowd notes, catch-up, fusion, professor-vs-reference, read-aloud, on-device models | per item | deterministic parts yes; AI parts with fake providers only |

**New test suites** (each one named in docs/TEST_LOG.md when it lands):

* `tenancy-leak` (AC-01b, two subjects in two universities), `authz-matrix` (generated, incl. platform routes and the
  space-route allow-list), `owner-migration` (journal crash points, legacy outbox replay, post-boot checksums).
* `background-binding`: a job enqueued from user A's request and run for user B never touches A's vault.
* `blob-gc`: crash between `stored_file` insert and `blob_ref` increment; restore of one vault from an older backup; the
  sweep keeps every referenced blob and quarantines before deleting.
* `multiuser-sync`: two users × two devices, read-only layer re-homing, replayed `op_id` guard, transient rejections not
  recorded, backfill on newly granted keys.
* `crdt-convergence`: three peers, property test with a fixed seed, restart mid-sync; `crdt-validation`: forged
  `created_by`, foreign clientID, oversized and undecodable updates are quarantined.
* `publish-follow` (Scenario 2, incl. stable ids and the minimal moderation variant), `version-reanchor` (Scenario 4),
  `link-private-lecture` (§6.9), `room-offline` (Scenario 3 in Playwright contexts, incl. credentials and backdated
  bundles), `image-search` (Scenario 6), `radar-phrases` (Scenario 1, deterministic part).
* `transfer-resume`: upload, download and DataChannel.
* Performance reruns (PRD AOS-23.2): 5,000 strokes with 5 layers; CRDT merge ≤ 50 ms in the CI container; page transfer
  ≤ 8 MB on the wire with compression; from Phase 2 the NFR-OP2 load test.

**Never reported as passed without the real thing:** stylus latency and palm rejection, Iraqi-Arabic ASR quality,
real-Wi-Fi P2P, Android ↔ iPad interop, battery, iOS push, store review, and real AI output. Each is recorded as «Not
run (reason)» (ARCHITECTURE §5), and a phase with such a `M` row closes only as «closed with blocked Musts» (PRD §5.2).

## 17. Open questions (owner) with assumed defaults

The owner questions are numbered **only in PRD §11**; this table maps the engineering view onto those numbers, with the
same defaults.

| topic | PRD | where it matters here |
|---|---|---|
| Meaning of «Public» | Q2 | §5.2, §7.2 (public routes: registration and join preview only) |
| Who may create an account | Q3 | §7.2 |
| Space granularity | Q36 (decided: one space per subject) | §0, §1.1, §5.5 |
| Who creates universities and channels | Q4 | §5.1 |
| Rights of official lecture files | Q5 | §5.2 |
| Moderation before publications go live | Q6 | §13 |
| Account deletion vs others' forks | Q14 | ADR-0003 §7; names rendered at read time (§4.3 `attribution`) |
| Shared-device sign-out | Q26 | §4.5 |
| Recording consent and external processing | Q8 | §5.6 |
| Minimum group sizes | Q15 | §7.10, §13 |
| Storage quotas per user and per space | Q22 | §14 |
| AI allowances and the copilot cap | Q10 | §14 |
| Followed-copy update policy (flagged inversion of the spec wording) | Q25 | §6.5, ADR-0004 §2.4 |
| History retention | Q29 | §4.3, ADR-0004 §2.8 |
| Collaborative copy permissions | Q31 | §5.3 |
| Offline room size | Q27 | §8.9 |
| Relay mode | Q32 | §8.6 |
| Native apps and store accounts (dated decisions D-A, D-G) | Q19 | §16 |
| First ASR engine; cloud audio | Q9 | §10.3, §14 |
| ASR absolute floors | Q28 | ADR-0006 §2.10 |
| Reference transcripts | Q33 | ADR-0006 §2.10 |
| Withdrawal with `rights_takedown` | Q34 | §6.3 |
| Automatic note migration to a new official version | Q35 | §6.3 |
| Online room voice (TURN/SFU cost) | Q30 | §8.5 |
| Recording retention | Q24 | §14 |

**Engineering decision (not an owner question).** One `annotation_layer` table (`0271`) serves both this design and the
parity plan's N4 G23 «owner layers»; N4 keeps 0295–0299 for tape only.

## 18. Review log

Design review of 2026-10-20 (55 findings: 3 blockers, 26 major, 26 minor) against PRD, this document, IA and
ADR-0003…0006. Each finding was checked against the repository before the documents changed (code read only; Round 7
was editing code at the same time, so nothing was built or run against the repository). **Outcome: 54 applied, 1
partially applied, none rejected outright.** «Checked» names the code or document evidence that confirmed the finding.
The delivery plan that turns the result into build tracks is [BUILD_PLAN.md](BUILD_PLAN.md).

### 18.1 Blockers

| # | finding | checked | outcome | where |
|---|---|---|---|---|
| 1 | Phase plan in §16 contradicted PRD §5 (Scenario 2, notifications, history, slide matcher, «Phase 0») while claiming precedence | both tables side by side | applied | PRD §5 is the only phase table (§5.1–§5.3); §16 is a summary that points to it; «Phase 0» folded into Phase 1 Wave 1; BUILD_PLAN Appendix A checks every PRD row against the phase of its track (516 rows, OK) |
| 29 | One space per deployment + modules «unchanged» in a space + moderator scope = no isolation between subjects, moderators acting everywhere | `apps/server/src/modules/data/index.ts` (backups 147–182, `/export/all` 255), `control/storage.ts` 72–97, `auth/guard.ts` `PUBLIC_ROUTES` | applied | one space per subject from Phase 1 (ADR-0003 §3.1, Q36 decided); space binding only through membership or role on that subject; route allow-list `authz/spaceRoutes.ts` with the minimum role per route (§5.5); data export/backup, settings, control storage and purge never mounted in a space (§5.8) |
| 30 | Owner migration never registers existing devices; new sync rejections are recorded and replayed forever | `sync/registry.ts` 104–145 (handler rejections recorded, retries answered with the original result) | applied | ADR-0003 §5 step 5 seeds `device` from `auth_session.device_id` and `sync_operation.device_id`; `device_unknown`, `not_a_member`, `quota_exceeded`, `op_id_taken` are `retryable: true` and never recorded (§8.2, ADR-0004 §2.2); test: legacy outbox replayed exactly once |

### 18.2 Major

| # | finding | checked | outcome | where |
|---|---|---|---|---|
| 2 | Course-only publications live in Phase 1 with no report/hide flow | PRD Q6, AOS-18.7/18.8 phases | applied | report → hide/restore, moderation notification and audit entry are Phase 1 `M` (AOS-18.7/18.8 Phase 1 parts), in the Phase 1 exit; track P1-T4 |
| 3 | «Must blocks the phase» yet phases close with untestable Musts; Phase 3 closes without ASR | PRD §3 legend, §5 exits | applied | PRD §5.2 «complete» vs «closed with blocked Musts» (owner sign-off); Phase 3 split into 3a (no ASR) and 3b (engine evaluated and enabled; spec §23 Phase 3 met only by 3b); AOS-23.1 phase report |
| 4 | ASR criteria only report numbers | PRD §7.7 rows | applied | absolute floors per stratum (PRD §7.7 table, Q28): CER ≤ 0.20 Iraqi / ≤ 0.15 MSA, term preservation ≥ 0.90, glossary recall ≥ 0.80, no deletion run ≥ 10 words; rows stay «not met» until met; ADR-0006 §2.10 |
| 5 | Evaluation gate cannot be run by a phone-only owner; reference bootstrapping contradiction | ADR-0006 §2.10, owner clarification 1 | applied | in-app evaluation flow from an iPad (AOS-OC.10, IA §4.22): evaluation-only engine runs, correction screen, server job, report in the platform section; corrected drafts are labelled «مرجع مصحَّح من مسودة آلية» because they bias toward that engine (Q33) |
| 6 | Native ink and stores placed last; three different start times | PRD §5, ADR-0005 §8, §16 | applied | one default (PRD §5.3): iPad shell + native ink right after Phase 1, parallel to Phase 2; Android with Phase 3; OC.3/OC.4/OC.9 `M`; dated decisions D-A (Apple account) 2026-12-15 and D-G (Google) 2027-02-15; same text in ADR-0005 §B.5/§8, §16, BUILD_PLAN §8 |
| 7 | Recording-share consent defaults differ between documents | PRD Q8 vs §5.6 vs IA §4.12 | applied | one rule: subject lecturer policy (attested by a Subject Moderator) **and** the recorder's per-share attestation; `recording_attestation` outside subjects; `consent_record` kinds updated (§4.1 2300); Q8, AOS-21.39, IA, §5.6, §17 aligned; owner questions now numbered only in PRD §11 |
| 8 | Owner-only operational features declared «unchanged, per user» though they act on the whole deployment | `data/index.ts` 147–182, 255; `control/storage.ts` 72–97; `data/backups.ts` | applied | §5.8 table: each Control Center section and data route is per user or platform admin only; AOS-21.47 |
| 9 | No way to connect an existing private lecture (the owner's library) to an official one | `control/corrections.ts`, reanchor job, `annotations/reanchor.ts` (Round 7) | applied | §6.9 link (copy, never move, with a review list) and moderator «publish my lecture as official» without copying bytes; AOS-19H.3/19H.4; IA §4.15; X8; track P1-T5 |
| 10 | Subject attachments, exam dates and updates feed have no entity or API | spec §2, AOS-2.5/2.9/2.17 | applied | space `3010_subject_content.sql` (`subject_attachment`, `subject_exam_date`, `subject_event`), routes §7.4, authz rows, notifications; Phase 1 (P1-T5) |
| 11 | Layer copy and history deferred though spec Phase 1 includes copies and layers | IA Phase 1 screens | applied | one-layer copy with attribution (AOS-4.11 Phase 1 part) and read-only per-layer history (AOS-4.15 Phase 1 part, IA §4.17) in Phase 1 (P1-T2); merge, time machine and compare stay Phase 2 |
| 12 | IA misses whole spec sections | IA §4 | applied | IA §4.15–§4.22 (link to official, AI pen menu, history/time machine/compare, tutor, cross-course graph, 19A–19L placement, exam room, ASR evaluation) and the matching components |
| 13 | No operational cost estimate; class-scale ASR capacity not analysed | — | applied | PRD §6.2 (Render tiers and disk, R2, AI per user, ASR CPU, sources and date), NFR-OP2 load test; ADR-0006 §2.13 capacity arithmetic; AOS-23.4 |
| 31 | Rollback and «byte for byte» false after first boot; boot step not crash-safe | `db/migrate.ts` 62–68 (refuses unknown migrations) | applied | ADR-0003 §5: release rule (no base migration in the migration release; BUILD_PLAN R1-a/R1-b/R1-c), journaled resumable state machine, boot guard that never enters setup mode, rollback after a base-migration release = restore the step-0 backup |
| 32 | Blob refcounts in another file without a shared transaction; restores drift; GC can delete live blobs | `files` module, `data/backups.ts` | applied | mark-and-sweep over every vault and space, refcounts as a hint, quarantine before delete, re-mark after restore (§4.0, §4.1 2250); test with a crash between the two writes (§16) |
| 33 | Moderator corrections in a space break the evidence contract | `control/corrections.ts` 443–450 (rewrites uncited regions in place) | applied | published official regions are immutable; corrections create a new official version or a successor region with a content alert; `pinned_region` with a content hash, refreshed only explicitly (§4.2 0163, §6.7) |
| 34 | Stub fan-out, purge refusal and takedown need an index of who holds copies; takedown order breaks FKs | `0001_core.sql` 172–173 (`source_version.file_id` FK) | applied | system `lecture_copy` read only by jobs, moderators see counts with minimum group 5 (§4.1 2060, §6.3); takedown nulls `file_id` / `original_file_id` before deleting `stored_file` |
| 35 | Followed-copy updates re-id every item | ADR-0004 §2.4 | applied | stable ids `deriveId(publication_id, item_id)`; diff only (upsert changed, tombstone removed); `publication_item` delta storage with `valid_from`/`valid_to` (§4.4 3050, §6.4) |
| 36 | CRDT updates accepted as opaque bytes; authorship client-asserted | ADR-0004 §2.3 | applied | server-side decode and validation in a worker, `created_by == actor`, size and schema limits, quarantine; `collab_client` binds clientIDs to (user, device); overflow moves to a new page (ADR-0004 §2.3.6, §4.4 3150) |
| 37 | Relay dedupe keyed by device id alone; backdated bundles bypass revocation | §8.6 | applied | receipts and vectors keyed by (origin_user_id, origin_device_uid, origin_seq) with server-issued `device_uid`; authorization checked against server revocation time and room-session epochs (§4.4 3200, §8.6) |
| 38 | Offline QR pairing does not scale; host cannot verify joiners; room key in the QR | ADR-0005 §A.2 | applied | a fresh offer per joiner, «30 per host» labelled untested; server-signed `RoomCredential` (≤ 24 h) fetched before going offline; room key over DTLS after the check, never in the QR; host backgrounding in the test list (ADR-0005 §A.2) |
| 39 | «Existing tests unchanged» unchecked; background work inherits a request's vault | `jobs/queue.ts` 441–442 (`poke()` → `setImmediate`), `test/helpers/app.ts` 105 (reads `owner`) | applied | worker loop, heartbeat, `poke()` and timers run in an explicit empty root context (§1.1, ADR-0003 §3.2); `background-binding` suite (§16); test-binding helper and «no test changes» no longer claimed (ADR-0003 §3.10). Count note: our grep found 304 direct `ctx.db` calls in 73 server test files against the reviewer's 775 in 113 (a broader pattern); either way the harness binding, not per-test edits, carries them |
| 40 | Capacity claim unmeasured; synchronous DB on one event loop | ADR-0003 §4 | applied | capacity labelled not measured; heavy jobs in worker threads or a separate process; NFR-OP2 load test before any capacity statement; Render disk limits recorded as public documentation (one instance with a disk, no zero-downtime deploys) |
| 41 | Server-local ASR cannot keep up with one class | ADR-0006 §2.2 | applied | one consented shared recording and transcript per official lecture reused by members; separate ASR worker reading audio from R2; CPU-minute quotas; local transcription no longer called free (ADR-0006 §2.2, §2.12, §2.13) |
| 42 | «Public» explanations leak members-only official content | §5.2 | applied | for viewers without access to the lecture: no `anchor.quote`, no `source_crop` images (§5.2, §7.6); AC-01b case; P2-T1 tests |
| 43 | Third-party voices and private data go to external providers without consent | §5.6 | applied | external processing of lecture audio or transcripts needs the lecturer policy to allow it plus the user's `ai_processing` consent naming the provider; disclosed on the privacy page (§5.6, PRD Q8) |
| 44 | Shared device: drafts and old outbox saved into another account; old clients keep running | `apps/web/src/app/layouts.tsx` 53, `features/workspace/data/noteDrafts.ts`, `vite.config.ts` | applied | per-user IndexedDB and user-prefixed `localStorage` keys (`lib/userStorage.ts`), drafts recovered only for the tagged user, `x-medlevo-client` version gate, forced service-worker update (§4.5, §7.1, ADR-0003 §5 step 8) |

### 18.3 Minor

| # | finding | outcome | where |
|---|---|---|---|
| 14 | Students cannot create teaching rooms | applied | PRD §4.2 roles: teaching and exam rooms for an invited audience; course-wide rooms need a moderator |
| 15 | Assistants can mark «reviewed» | applied | only a Subject Moderator of that subject; badge names role and date (AOS-19I.4, §4.1 `reviewed_role`, §13) |
| 16 | Profile visibility default not private | applied | `profile_visibility DEFAULT 'only_me'` with a test (§4.1 2000) |
| 17 | Scenario 4 skips the student's tap; «نُقلت تلقائيًا» | applied | preview and «انقل ملاحظاتي» tap inserted; status «نُقلت بأمان»; automatic variant (PRD Scenario 4, Q35) |
| 18 | Followed-copy default inverts the spec wording; J3 phase labels | applied | Q25 flagged as an inversion for the owner; J3 heading «Phase 1 preview, Phase 2 per-change accept» |
| 19 | Spec §23 not itemised | applied | AOS-23.1–23.5 (phase report, performance gate, no decorative controls, operational costs, inspect first) |
| 20 | Gap analysis and per-row evidence missing | **partially applied** | the gap-analysis working file is not in the repository and not available to this review, so it cannot be committed. Instead PRD Appendix D maps every §7 section to the `REQUIREMENTS_MATRIX` part A rows that hold today's evidence, and AOS-23.5 / BUILD_PLAN §2 item 1 make each track re-verify its rows' `Now` value with file and test evidence before building |
| 21 | External-reference origin not separated | applied | «مرجع» origin distinct from «رسمي» (§10.5, PRD K3, IA origin badges) |
| 22 | Equations have no track (parity study rules math out) | applied (in these documents) | PRD AOS-1.21 and Appendix C state that the newer spec overrides the parity study; built by BUILD_PLAN P2-T5. `docs/research/NOTE_APP_FEATURE_PARITY.md` itself was not edited: it is outside the files this review may write |
| 23 | Live translation and live card suggestions not designed | applied | §10.1 tasks and §10.3 copilot, with budget handling |
| 24 | Preservation checklist vs navigation change | applied | §15.2 row 23 «partly superseded» naming `e2e/smoke.spec.ts` line 158 and `e2e/g1-ac01-personal-library.spec.ts` line 103; AC-01a in the Phase 1 exit |
| 25 | Join landing page shows the channel name before sign-in | applied | rate-limited public join preview (channel title only) in §7.2, Q2 and ADR-0003 (g8 list change via ADR) |
| 26 | Owner defaults differ between documents | applied | one numbered list (PRD §11, Q1–Q36); §17 and the ADRs map to it; per-space quotas and recording retention in §14 |
| 27 | Account deletion in Phase 1 but fork policy in Phase 2 | applied | Q14 policy in the Phase 1 part of AOS-21.44, with a test (P1-T1 and P1-T5) |
| 28 | No honest web latency statement | applied | PRD §6.1 web latency chain as a range «from public documentation, not measured», next to the native target; used in Q19 |
| 45 | Ranking manipulation claims overstated | applied | one rating per account per publication (latest only), author's own tag excluded, evidence links capped (§4.1 2160 `rating`, §7.8) |
| 46 | Gaining access never backfills | applied | `granted_keys` in the pull response and a backfill pull from `seq 0` (§8.4) |
| 47 | Live-room limits vs voice transport | applied | batching (≤ 10 batches/s per writer), per-role frame limits; online voice «not designed» until Q30 (ADR-0005 §A.1, AOS-12.11) |
| 48 | Wire sizes quoted as binary | applied | base64 sizes for the JSON path, compression, re-check against the 8 MB budget (ADR-0004 §2.5, PRD §6) |
| 49 | Phases, budgets and pairing payload disagree | applied | one phase plan (PRD §5), one merge budget, one pairing payload (ADR-0005 §A.2, §8.6) |
| 50 | Login and join limits allow targeted lockouts and NAT blocks | applied | progressive per-account delay with recovery-code bypass, high per-IP ceilings (§7.1, §7.2, §4.1 2000) |
| 51 | Privacy wording overstates isolation from the operator | applied | operator access stated (§5.1, PRD NFR-S3), encrypted backups off the host, storage report scoped to referenced blobs, `listen_only` described as a social control (§5.5 row 5) |
| 52 | Peer-received files not checked in the browser | applied | sha256 check and quarantine until uploaded and checked by the server (ADR-0005 §A.2) |
| 53 | Account-deletion default contradicts vault and layer rules | applied | names rendered at read time from `user_account`; erasure = withdrawal + name removal; existing forks not erased and the preview says so (ADR-0003 §7, Q14) |
| 54 | One deployment-wide engine from a small single-source sample | applied | ≥ 10 minutes per stratum with intervals; «لم يُقيَّم على محاضرات هذه المادة» per subject until that subject has samples (ADR-0006 §2.10) |
| 55 | Exam-room minimum of 5 does not protect individuals | applied | ≥ 10 participants, viewer's own answers excluded, coarse bands, per-concept table to the host only (Q15, IA §4.21) |

### 18.4 Found during the review (not in the finding list)

* **Round 7 changed the baseline** while this review ran: migrations `0280`, `0290` (manual re-anchoring), `0670`,
  `0810` and `POST /api/annotations/reanchor` exist now. §6.3 and P1-T2 reuse that manual re-anchoring UI for the
  «تحتاج مراجعة» list instead of designing a second one, and every track re-reads `ls apps/server/src/db/migrations`
  before taking a number (BUILD_PLAN §1.4).
* **Migration files were split by owning track** (§3.2): `2040_registry` / `2050_directory`, `2150_publications` /
  `2160_social`, `2300_security` / `2310_moderation`, so two tracks of one wave never edit one file and the
  owner-migration release carries only `2000`, `2010`, `2040`, `2250`, `2300`. The DDL of §4.1 was executed in order in
  SQLite 3.45 (the R1-b subset, the Phase 1 set and the full set): every statement parses and every foreign key
  names a table that already exists. `publication_series` stays in `2150` because SQLite refuses inserts into a child whose
  parent table does not exist, even with a NULL key.
* **A Render persistent disk attaches to one service only**, so an ASR or job worker running as its own service cannot
  read `DATA_DIR`; the worker reads audio from R2 instead (ADR-0006 §2.13, PRD §6.2).
