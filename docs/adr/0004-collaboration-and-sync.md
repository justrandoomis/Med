# ADR-0004 — Collaboration and sync: layer ownership, op-log + Yjs, version vectors, hashing, resumable transfer

- **Status:** Accepted for design, 2026-10-20; revised the same day after the design review (transient rejections not
  recorded, server-side validation of CRDT updates, stable followed-copy ids with diff-only updates, server-issued
  device ids in version vectors, base64 sizes quoted). Not implemented. Owner questions use the numbers of PRD §11.
- **Extends, does not replace:** the sync protocol of ARCHITECTURE §3.4 (`apps/server/src/modules/sync/*`,
  `apps/web/src/lib/sync.ts`) and its merge policies (`apps/server/src/modules/annotations/sync.ts`,
  `learning/store.ts`, exams handlers).
- **Depends on:** ADR-0003 (vaults, spaces, system DB). **Used by:** ADR-0005 (rooms and nearby transport) and
  [ARCHITECTURE_DELTA](../academic-os/ARCHITECTURE_DELTA.md) §6 (fork graph and layers) and §8 (sync protocol v2).

## 1. Context

### 1.1 What exists and works (single owner, several devices)

* **Ops.** Every client-originated entity has a client ULID. An op is
  `{op_id, device_id, entity_type, entity_id, op: upsert|delete|append, base_rev?, payload, client_ts}`. The push
  results are `applied | merged | conflict_kept_both | duplicate | rejected`, and a repeated `op_id` returns
  `duplicate` with the original result. Limits: `MAX_PUSH_OPS` 500, `MAX_PULL_LIMIT` 1,000, payload ≤ 2 MiB.
* **Merge policies** never use blind last-write-wins:
  * Append-only entities (strokes, review events, attempts) are inserted if absent.
  * An annotation edit with a stale `base_rev` is kept as a *new* annotation with `conflict_of_id`.
  * An edit concurrent with a delete keeps the edited stroke. Deletion is a tombstone.
  * A stale note edit becomes a conflict copy. A stale `note_page` edit or `study_session` save is rejected with the
    server copy.
* **Feed.** `sync_change` keeps one row per entity at its latest sequence. A server data epoch handles restores.
* **Registered entity types:** `annotation`, `note`, `note_page`, `study_session`, `flashcard`, `review_event`,
  `question_attempt`, `exam_attempt`.
* **Web.** IndexedDB first, then the outbox. Exponential backoff (1 s × 2^(n−1) ±20 %, capped at 5 min). Ops are never
  dropped.

### 1.2 What breaks if several people write (gap analysis)

* **Co-editing turns into duplicate copies.** Two students moving the same strokes produce `conflict_kept_both`
  copies, and everyone sees «تعارض» (conflict) (AOS-1.11, AOS-4.4).
* **Undo overwrites collaborators.** Undo replays full before/after item states, so it would overwrite a
  collaborator's later edit (AOS-1.24).
* **Erasing is unscoped.** Any erase tombstones any row on the page (AOS-1.6).
* **Identity is client-asserted.** `device_id` comes from the payload, and there is no author (AOS-11.17, AOS-21.29).
* **The pull feed is global** (AOS-5.22).
* **No edit history.** An upsert overwrites `data_json`, so there is no history and no time machine (AOS-4.15,
  AOS-13.12).
* **No peer-to-peer merging.** Merges happen only on the server, so peers cannot converge in an offline room
  (AOS-11.18). Causality is a scalar `rev` plus the server sequence, with no version vectors (AOS-11.19).

### 1.3 What the spec asks

Spec §4:

* independent forks, followed copies, collaborative copies and layers;
* preview of upstream changes, version history and a time machine;
* stable anchors and attribution;
* «ممنوع فقدان الملاحظات الشخصية» — personal notes must never be lost.

Spec §11:

* a CRDT or operation log;
* version vectors, content hashing, retry, chunked transfer and resumption.

Spec §22: Scenario 2 (followed copy), Scenario 3 (offline room, a connection drops, resume with no duplicates or
losses), and «تضارب التعديلات», «انقطاع النقل في منتصف الملف», «إعادة تشغيل التطبيق أثناء المزامنة» (conflicting
edits, a transfer cut mid-file, an app restart during sync).

### 1.4 Measured (spike 1, `…/scratchpad/spikes/crdt`)

Workload: 5,000 strokes per page (1,116,404 points, 50–400 points per stroke), points rounded exactly like `model.ts`
`roundPoint`. Three offline peers. VM with 4 vCPU under load average 10–14, so times are upper-end. All runs are Node
in-process, not phones.

| | **Yjs 13.6.33, each stroke one immutable value with packed points** | Yjs, nested `Y.Map` per stroke | Yjs, points as JSON arrays | Automerge 3.5.0, points as bytes | today's op-log, JSON |
|---|---|---|---|---|---|
| build of 5,000 strokes, mean per stroke (per-commit p50 where measured) | 0.20 ms (per commit p50 0.039 → 0.026 ms) | 0.28 ms | 0.45 ms | 5.59 ms (per commit p50 1.47 ms → **5.61 ms** at strokes 4,501–5,000) | — |
| delta per stroke (p50) | **1,350 B** | 1,394 B | 6,822 B | 1,571 B | 6,531 B JSON (gzip 2,554 B) |
| whole page | 6.67 MB (gzip 4.95 MB); load 195 ms | 6.88 MB; load 301 ms | **33.8 MB**; load 2.4 s; max RSS 2.3 GB | 5.10 MB; load 2.3 s | 31.6 MB JSON (gzip 10.6 MB) |
| merging two offline peers' deltas (~813 KB) | **8.7–20.8 ms** | 26–101 ms | 193–214 ms | 1.6–2.5 s | server only |
| 3-peer convergence | yes (same hash on 3/3) | yes | yes | yes | n/a |
| concurrent move vs delete | **edit wins** (same as today's handler) | delete wins | — | delete wins | edit wins |
| two inserts at the same text position | each insert contiguous, not interleaved | — | — | contiguous | n/a |
| per-user undo | `UndoManager` tracking only the local origin: own work undone, the peer's stroke untouched, redo works | — | — | none built in; history never shrinks | n/a |

* **Packed points.** A lossless zigzag-delta varint codec stores 5.28 B/point, against 29.1 B/point for today's JSON.
  The CRDT overhead on top of packed points is ≈ 0.16 KB per stroke (id, style, bbox, z, tx, clock).
* **Bulk delete.** Deleting 2,050 strokes took 11 ms and shrank the document to 3.99 MB after Yjs GC. While an
  `UndoManager` tracked the delete, the deleted content was retained (6.68 MB).
* **Existing push throughput** (docs/PERFORMANCE.md, not re-run): ink push 1,629 ops/s; a 5,000-stroke page GET takes
  298 ms and returns 7.5 MB uncompressed. The server has no HTTP compression.

## 2. Decision

### 2.1 Every item belongs to exactly one layer, and every layer has exactly one write model

The existing `annotation.layer` column (`ink|highlight|text|media`) stays as the **render class**. A new
`annotation_layer` table and `annotation.layer_id` / `note.layer_id` columns carry **authorship and visibility**
(ARCHITECTURE_DELTA §4.3). `layer_id IS NULL` means «the default personal layer of this document in this vault». Legacy
rows therefore need no rewrite, and old clients keep working.

| layer kind | lives in | who writes | write path | merge | undo |
|---|---|---|---|---|---|
| `personal` | vault | the vault's user (all their devices) | op-log (§2.2), unchanged | today's rules | today's local history (single writer) |
| `explanation` (draft of something to publish) | author's vault | author | op-log | today's rules | local |
| `answers` (hidden in «امتحن نفسك» self-test mode; parity G23) | vault | user | op-log | today's rules | local |
| `published_snapshot` | space | nobody (frozen at publish) | created by the publish job | — | — |
| `followed` | follower's vault | **the server only**, from the author's publication feed | server job (§2.4) | replace-by-version | — |
| `forked` | forker's vault | the forker (it starts as a copy of a snapshot) | op-log | today's rules | local |
| `group_comments` | space | each member, own items only | op-log in the space; each item has one author | per item, today's rules | own items only |
| `suggestion` | space | the suggester, own items only | op-log in the space | today's rules | own items only |
| `collaborative` | space | every member with `edit` on the collaborative copy | **Yjs** (§2.3) | CRDT | `Y.UndoManager` on the local origin only |

The rules follow from the table and are enforced on the server in the entity handlers:

* **R1. Single-writer layers keep the op-log.** One writer with several devices is exactly what today's policies were
  designed for. Spike 1b showed that their semantics (idempotent `op_id`, insert-if-absent, keep-both on a stale rev,
  edit beats delete, tombstones) match the y-flat-packed CRDT shape.
* **R2. An op on a layer the actor cannot write is `rejected` (recorded, not retryable).** It returns the Arabic reason
  and `detail_code: 'layer_read_only' | 'layer_forbidden'`.
  * The **client never drops the stroke**: it re-creates the item, under a new id, in the actor's personal layer of the
    same document and tells the user why. This keeps ARCHITECTURE §0 rule 6 («never lose the owner's writing») for
    every user.
  * The same applies to an item on a `followed` layer (read-only to followers, AOS-4.3) or on a `published_snapshot`.
* **R3. Conflict copies stay with their author.** A `conflict_kept_both` copy is always written to the **actor's own**
  layer. In a single-writer layer, that is the same layer. It is never written into someone else's layer.
* **R4. Annotation ops cannot target a `collaborative` layer.** Writes there go through `crdt_update` (§2.3). The
  `annotation` rows of a collaborative layer are a **derived projection** (§2.3.4), and the annotation handler refuses
  ops on them with `detail_code: 'use_crdt'`.
* **R5. The eraser and lasso respect layers.** The engine applies a visibility and editability predicate (the parity
  plan's N1 Wave 0 `setVisibility(fn)` seam) in render, hit-test, eraser and lasso. Items of read-only layers can be
  selected for copying but cannot be moved, recoloured or erased.
* **R6. Undo is per user.** Single-writer layers keep today's history. Collaborative layers use
  `Y.UndoManager({trackedOrigins: {localOrigin}})`, measured to leave the peer's work untouched.

### 2.2 The op-log is extended, not replaced

These are all **additive**. The wire format of v1 stays valid (ARCHITECTURE_DELTA §8 has the full protocol).

* **Routing.** The op format is unchanged. `POST /api/sync/push` binds the caller's vault, and
  `POST /api/spaces/:spaceId/sync/push` binds a space after the membership check.
* **Identity.**
  * The server takes the actor from the **session**, never from the payload. `sync_operation` gains
    `actor_user_id`, and spaces gain an author on every row.
  * `device_id` stays as an attribution hint, but authorization never trusts it. It must belong to the session's user
    in the system `device` table; otherwise the op is rejected with `device_unknown`.
  * **Transient rejections are never recorded.** Today's registry records every handler rejection in `sync_operation`
    and answers a retry of the same `op_id` with `duplicate` + the original `rejected` (`sync/registry.ts` lines
    104–145), so a recorded transient rejection would lose the write for good. `device_unknown`, `not_a_member`,
    `quota_exceeded` and `op_id_taken` are answered `retryable: true` and **not** recorded, like unknown entity types
    today (lines 108–111); the client fixes the cause (registers the device, waits for approval or quota) and retries —
    for `op_id_taken` under a new `op_id`. Only final rejections (`layer_read_only`, `layer_forbidden`, `use_crdt`) are
    recorded. The owner migration also seeds the legacy devices (ADR-0003 §5 step 5).
* **A replayed `op_id` from another user gets nothing back.** `sync_operation`'s primary key stays `op_id` (`0001`).
  In a space, a repeated `op_id` whose recorded `actor_user_id` differs from the caller is answered
  `rejected` / `detail_code: 'op_id_taken'`, not recorded and retryable under a new `op_id`. It returns **no** stored
  result and **no** entity. Today `duplicateOf()` returns both, which would leak another user's row. A vault has one
  user, so its behaviour is unchanged.
* **Layer field.** Payloads of `annotation`, `note` and `note_page` gain an optional `layer_id`. Absent means the
  default personal layer.
* **Pull** is per database. In a space, `sync_change` gains `visibility_key`, and the pull returns only rows whose key
  the viewer holds (ARCHITECTURE_DELTA §8.4).
* **New entity types:**
  * `annotation_layer` (upsert, rev; single writer);
  * `crdt_update` (append, insert-if-absent by content hash; spaces only);
  * `timeline_event` (append; ARCHITECTURE_DELTA §9);
  * `discussion_thread` and `discussion_post` (upsert, rev, author-only edits; spaces);
  * `room_event` (append; spaces).
* **The results set is unchanged.** New reasons travel in `detail` (Arabic) and `detail_code` (machine-readable). Old
  clients ignore `detail_code`.

### 2.3 Multi-writer layers use Yjs

#### 2.3.1 Document shape

One `Y.Doc` per collaborative layer, per document (lecture version):

* `items`: a `Y.Map<itemId, ItemValue>`. **Each item is one immutable plain value**:
  `{kind, style, bbox, z, anchor, data_packed: Uint8Array, created_by, tx}`. Points use the packed codec (§2.5). An
  edit (move, recolour, resize) **replaces the whole value**. Measured semantics: a concurrent edit beats a concurrent
  delete, and concurrent edits resolve deterministically, last writer by Yjs client order. This matches today's
  «edit beats delete» rule. Nested `Y.Map`s are **not** used: they flip the semantics to «delete wins» and cost more
  (26–101 ms merges).
* `notes`: a `Y.Map<noteId, Y.Text>` for co-typed text. Inserts at the same position stay contiguous (measured). Text
  stays in logical order with no bidi control characters, as today's `richtext.ts` rule requires.
* `meta`: a `Y.Map` for title and page list (rare edits).

#### 2.3.2 Why Yjs and not Automerge

Both converged. Automerge 3's per-commit latency grows with page size (p50 5.6 ms at 5,000 strokes — a visible pen
hitch at 120 Hz). Its merges take 1.6–2.5 s, it has no undo manager, and its history never shrinks. Yjs is two orders
of magnitude faster on this workload. Automerge native lists for points (33 s to load 1,000 strokes) and plain JSON
arrays in Yjs (2.3 GB peak RSS) are disqualified.

#### 2.3.3 Transport

* An update is a `crdt_update` sync entity:
  `{op: 'append', entity_id: sha256hex(updateBytes), payload: {doc_id, bytes_b64}}`.
* The server inserts it if absent, so the content hash *is* the idempotency key — but only after validating it
  (§2.3.6); an invalid update is kept in quarantine and never applied.
* The same bytes travel over every transport: HTTP push/pull, the realtime WebSocket (ARCHITECTURE_DELTA §8.5) and
  peer-to-peer bundles (ADR-0005). Any order, any duplication and any path converge.
* A reconnecting peer uses the Yjs state-vector exchange (`step1` / `step2`). Measured: 813,311 B in 4 messages and
  83 ms per pair after offline work; 292 B per pair when already converged.

#### 2.3.4 Server side

* **Compaction.** A job folds updates into a snapshot with `Y.mergeUpdates` (`collab_doc.snapshot_blob`) and marks the
  folded updates `compacted_into`. They are kept for the time machine until the retention policy prunes them (§2.8).
* **Projection.** The same job **materialises** the doc into `annotation` rows on the collaborative layer
  (`layer_id = <collab layer>`, `origin = 'crdt_projection'`). These rows are derived and rebuildable, like FTS, so
  the existing read paths work unchanged: page loads, export, PDF flattening, handwriting recognition, re-anchoring,
  search and replay.
* **Dependencies.** The server needs `yjs` (pure JS, no native build) and `@fastify/websocket`. Both are new
  dependencies and are added only when Phase 4 starts (ARCHITECTURE_DELTA §2).

#### 2.3.5 Client side

* Yjs runs in a **Web Worker**. The ink engine keeps its own store and render path (no React render per pointer move,
  dirty rectangles; docs/PERFORMANCE.md).
* Remote items enter through the same applier used for pulled annotations. They are redrawn through the
  dirty-rectangle path, never with a full repaint.
* Transient in-progress strokes of other users (live rooms) are sent as awareness messages and never stored. Only the
  committed stroke becomes an update.

#### 2.3.6 Validation — the server never trusts CRDT bytes

Accepting updates as opaque bytes would let one malicious or buggy editor wipe or corrupt a shared document for every
member: delete every item, forge `created_by`, reuse another device's Yjs clientID (Yjs assumes unique clientIDs, and
duplicates make replicas diverge), or upload bytes that throw in `Y.applyUpdate` on every peer and in the projection job.
So:

* **Decode and validate before accepting**, in a worker thread, against the current doc state: the update must apply
  cleanly; every inserted or replaced item value must match the `ItemValue` schema and the size caps; for an inserted
  item `created_by` must equal the uploading actor (or the verified origin of a relay bundle); deletions and edits of
  other members' items are allowed only to roles that may (writers may edit, per the room or ACL policy; a viewer's
  update is rejected).
* **Bind clientIDs** to (doc, user, device) in `collab_client` at first use; an update that uses a clientID bound to
  someone else is rejected.
* **Quarantine, never drop silently.** An invalid update is stored with `state = 'quarantined'` and a reason, never
  applied, compacted or relayed, and the doc's moderators and the author are told.
* **Attribution needs this.** Scenario 3's «a viewer's write is rejected by peers» assumes an update can be tied to a
  user; clientIDs alone cannot do that, so every peer-to-peer CRDT update travels inside a **signed relay bundle**
  (§2.6), and peers apply only bundles whose signature and credential they verified.
* **Peers that re-encode.** Peers relay the original update bytes inside bundles (never a merged re-encoding), so hashes
  stay stable and attribution survives.
* **Size cap overflow.** At the 64 MiB hard cap new strokes go to a **new page** of the collaborative copy with a notice
  («امتلأت هذه الصفحة — تابِع في صفحة جديدة»); an offline backlog that would cross the cap is accepted onto the new page,
  never dropped.
* **Restore to time T.** A moderator (or the creator) can restore a collaborative layer to its state at T, written as a
  new update that removes later items — history is kept (§2.8).

### 2.4 Followed copies: a one-way feed with preview, never touching personal layers (Scenario 2)

1. **Start.** A follower's «Start Studying with X's explanation (followed)» creates in their vault:
   * a stub of the lecture (ADR-0003 §3.3);
   * a `personal` layer;
   * a `followed` layer holding a copy of publication version *n*, read-only and with `origin_json` naming the
     publication and its version.
2. **Republish.** When the author publishes version *n+1*, a job in the space computes the **item diff** between the
   two snapshots: added, removed and changed item ids, plus a per-page summary.
   * The system DB records a pending update for each follower and sends a notification.
3. **Preview.** The follower sees a preview — «أضاف 14 عنصرًا في 3 صفحات، حذف 2، عدّل 5» (added 14 items on 3 pages,
   removed 2, changed 5) — and can open the changed pages with the new items highlighted.
   * `update_policy = 'preview'` (default): nothing changes until they apply.
   * `update_policy = 'auto'`: the update applies at once.
   * A follower can skip a version and stay pinned.
4. **Apply the diff, with stable ids.** Every followed item has the id `hash(publication_id, item_id)` — the **same**
   in every version (the space stores versions as delta rows with stable ids, ARCHITECTURE_DELTA §4.4
   `publication_item`). Applying *n+1* upserts only the changed items (rev + 1, before-image in `annotation_revision`),
   inserts the added ones and tombstones the removed ones; unchanged items are not touched. Retries are idempotent.
   * Why: the first draft rewrote every item under `hash(publication_id, version_no, item_id)`, so every follower note,
     link, card, recognition row and timeline reference to an *unchanged* item lost its target on every republish, and
     a one-stroke change re-sent the whole layer (≈ 31.6 MB of v1 JSON for a 5,000-stroke explanation, spike 1b) to
     every follower's every device.
5. **Personal layers are never touched.** «Never lose personal notes» holds by construction: the personal layer is a
   different layer with a different writer.
   * A note attached to an unchanged or changed item keeps pointing at it (stable id).
   * If the follower had attached a note to a followed item that version *n+1* removed, the note stays. Its anchor is a
     page anchor, so it stays on the page; the note is marked `needs_review` with the item's last place.
6. **Independent forks** copy a snapshot once into a `forked` layer that the forker owns. They are pinned, never
   updated, and keep `attribution` rows (AOS-4.18).

### 2.5 Packed points (ink data v2)

`InkData` gains `v: 2` with `points_packed` (base64 of zigzag-delta varints for x, y, t, pressure, tilt, using the same
rounding as `roundPoint`). This cuts a stroke from ≈ 6.5 KB of JSON to ≈ 1.2–1.35 KB **binary** (spike 1b) — the size the
CRDT path and a binary endpoint carry. **Inside JSON the packed points travel as base64, +33 %:** ≈ 1.6–1.8 KB per
stroke, and the spike's 5,000-stroke page (5,899,202 B of packed points) becomes ≈ 7.9 MB of base64 alone, before
per-stroke metadata — over the PRD NFR-P3 budget of 8 MB on the wire. Therefore:

* JSON responses ≥ 1 KiB are compressed (gzip or br; the server has no HTTP compression today), or
* page loads use a binary endpoint for packed points (`application/octet-stream`, one length-prefixed record per item);
* the budget is re-measured on the wire in CI, and every size quoted says «binary» or «base64».

* The server accepts v1 and v2 and stores what it receives.
* `GET` and pull return v1 JSON unless the client sends `accept-ink: 2`, so old clients never see v2.
* Re-anchoring, recognition and export decode both versions through one shared codec in `packages/shared`.

### 2.6 Version vectors — three kinds of causality, each where it fits

| data | causality | why |
|---|---|---|
| op-log entities (single-writer layers, notes, cards, attempts, sessions) | unchanged: per-row `rev` with the server as sequencer, plus the server `seq` for the feed | one writer; the server decides keep-both or reject; peers **never** resolve op-log conflicts |
| CRDT docs (collaborative layers, room boards) | **Yjs state vectors** (a per-client clock), which *are* version vectors | peers converge without a server |
| store-and-forward bundles (ADR-0005) | a **device version vector** `{(origin_user_id, origin_device_uid): highest contiguous origin_seq}` per room, keyed by the **server-issued** globally unique device id | peers exchange vectors and send each other only the bundles the other lacks; the server keeps the same vector per room to deduplicate later uploads. Keying by a client-chosen device id alone would let one user register another user's device id and pre-empt their sequence numbers, so the victim's genuine bundles would be dropped as duplicates |

Peers in an offline room exchange op-log ops only as **signed, opaque relay bundles** that the server applies later
(ADR-0005 §A.4). This keeps the server the only place where op-log conflicts are resolved, so today's rules stay
correct. Room data that must converge offline (the shared board) is a CRDT doc.

### 2.7 Content hashing, retry and chunked, resumable transfer

* **Content hashing.**
  * **Blobs:** sha256, content-addressed (unchanged).
  * **CRDT updates:** sha256 of the bytes = the id.
  * **Relay bundles:** sha256 of the canonical bytes = the id; signed with Ed25519 by the origin device.
  * **Offline packages:** manifests with a sha256 per entry (unchanged; `data/offline.ts`).
  * **Publication versions:** `content_hash` over the canonical item list, to detect identical republishes and for
    integrity.
* **Retry.** One policy everywhere: today's outbox backoff (1 s × 2^(n−1) ±20 %, cap 5 min, never drop), reused for
  uploads, peer transfers and relays.
* **Chunked, resumable uploads.**
  * Upload sessions: `POST /api/files/uploads` → `{upload_id, chunk_size}`, then `PUT …/chunks/:n` with
    `x-content-sha256`, then `POST …/complete` (verifies the whole sha256, then `ctx.files.put`).
  * `GET …/:id` lists the chunks already received, so the client resumes after a restart.
  * Chunk size 4 MiB. Chunks use their own route with an 8 MiB body limit, separate from the 2 MiB sync payload cap.
    The hosting proxy's request-size limit is not measured; the chunk size is a config value so it can be lowered.
  * This replaces the single 200 MB multipart request for long recordings (AOS-7.1) and large lectures.
* **Resumable downloads.** Offline downloads (`lib/offline.ts`) use the existing HTTP `Range` support per file and keep
  verified partial files. Today an interrupted package restarts from zero.
* **Peer transfer** (ADR-0005): 64 KiB DataChannel messages grouped into 1 MiB chunks, each with a sha256. Backpressure
  uses `bufferedAmount`. The receiver keeps a chunk bitmap so a dropped connection resumes from the last verified
  chunk. Measured: 5 MiB intact in 0.4–1.4 s, 28/28 hash matches, same host.

### 2.8 History and Time Machine

* **`annotation_revision`** (vault and space; ARCHITECTURE_DELTA §4.3) is an append-only before-image of every update,
  delete and restore of an annotation, a note or a layer, and of every followed-layer update. It is written in the same
  transaction by the handler. Re-anchored copies are *new* rows (`migrated_from_id`), so the original never needs a
  before-image.
* Together with the current rows, the CRDT update log and `timeline_event`, it rebuilds a layer **as of time T**:
  * version history (AOS-4.15);
  * restore of earlier versions (AOS-4.16, as a **new** state; history is never rewritten);
  * the Study Time Machine (AOS-13.12).
* **Cost.** Each edit stores one extra copy of the item; with packed points that is ≈ 1.2 KB per stroke edit.
* **Retention** is an owner setting (PRD Q29).
* **Purge** deletes the history of the purged items with them, and the purge preview lists it.

### 2.9 Compatibility

* Old web clients (v1 payloads, no `layer_id`, no `accept-ink`) keep working against their own vault. They cannot open
  collaborative copies. Those screens require the new client, and the capability registry says so.
* No existing entity handler changes behaviour for ops without `layer_id`. `annotations.test.ts` (28 tests), AC-24 and
  the g7 groups must pass unchanged.

## 3. Consequences

* **Positive.**
  * The hard multi-writer problem is confined to the layers that need it.
  * Personal data keeps the proven op-log semantics and tests.
  * Yjs costs ≈ 0.03 ms per committed stroke and 9–21 ms per peer merge on the measured workload.
* **Negative.**
  * Two write models to maintain.
  * A derived projection for collaborative layers.
  * New dependencies (`yjs`, `@fastify/websocket`).
  * A worker on the client.
  * History grows storage (§2.8).
* **Risks.**
  * **Projection drift.** The projection job is idempotent, keyed by the doc's state vector, and a test rebuilds it
    from scratch and compares hashes.
  * **Untested environments.** Yjs memory on low-end phones (the 6.7 MB page document was measured on Node only) and
    behaviour across Safari and WebKit are untested.

## 4. Test plan (all runnable in this container unless marked)

1. **Op-log regression.** All existing sync, annotation, learning and exams tests pass unchanged against one bound
   vault.
2. **Layer rules.**
   * An op on a followed or snapshot layer is rejected with `layer_read_only`, and the client re-homes the item into
     the personal layer (web unit and e2e).
   * Conflict copies land in the actor's layer.
   * An annotation op on a collaborative layer is rejected with `use_crdt`.
3. **Followed copy (Scenario 2).**
   * Republish n → n+1; the follower's preview counts are right.
   * Apply; personal layer rows are byte-identical before and after (hash).
   * Skip and pin.
4. **CRDT convergence.**
   * In process: 3 peers with random interleaving, duplication, reordering and drops (property test with a seed), and a
     restart mid-sync. Assert identical canonical hashes.
   * Same in Playwright with 3 browser contexts and a server relay.
5. **Undo.** Each user's undo never changes another user's items.
6. **Transfer.**
   * Cut an upload at a random chunk, restart the client, resume, and compare the sha256.
   * Same for an offline package download and a DataChannel transfer.
7. **Time machine.** Rebuild a layer at T from history and compare with a recorded snapshot.
8. **Performance.**
   * The 5,000-stroke budgets in docs/PERFORMANCE.md still pass with v2 points.
   * Merge latency stays ≤ 50 ms on the 5,000-stroke page in the CI container (the single budget, also PRD NFR-P4).
   * A 5,000-stroke page transfers in ≤ 8 MB on the wire with compression or the binary endpoint.
9. **CRDT validation.** Updates with a forged `created_by`, a foreign clientID, an oversized item or undecodable bytes
   are quarantined and never reach another peer or the projection; a viewer's update is rejected; restore-to-T writes a
   new state.
10. **Transient rejections.** `device_unknown`, `not_a_member`, `quota_exceeded` and `op_id_taken` are not recorded; the
    same op succeeds after the cause is fixed; a legacy outbox replays after the owner migration.
   * *Not run here:* phone and tablet memory and latency (needs devices).

## 5. Open questions (owner) — with defaults

1. **Default update policy for followed copies** (PRD Q25). Default: `preview` — nothing changes without the follower's
   tap. **Flagged as an inversion of the spec's literal wording** (§4: updates «تصل إليها», with «خيار معاينة
   التغييرات»); if the owner prefers the literal default, `update_policy` defaults to `auto` with a visible change
   summary and an undo, and nothing else changes.
2. **History retention** (Q29) for `annotation_revision` and compacted CRDT updates. Default: keep everything until the
   user's storage quota is reached, then thin to one snapshot per day for items older than 180 days, and tell the user
   before thinning.
3. **Collaborative copy permissions** (Q31). Default: the creator invites named members with `edit` or `view`.
   Course-wide collaborative copies are allowed only by a Subject Moderator.
