// Local-first store (IndexedDB via Dexie) — ARCHITECTURE §4, spec §26, §47.
//
// Writing (ink, notes, attempts, review events, sessions) goes here FIRST and never waits for the
// network. Each client-originated write enqueues a sync op in the SAME Dexie transaction
// (see lib/sync.ts → enqueue / writeAndEnqueue), so an entity can never be saved without its op.
//
// ─── Local schema migrations ───────────────────────────────────────────────────────────────
// Every schema change appends a NEW entry to LOCAL_SCHEMA (never edit a shipped entry):
//   { version: N+1, stores: { changed tables only }, upgrade?: (tx) => … }
// `stores` uses Dexie syntax: first key = primary key ('++' auto-increment, '&' unique,
// '[a+b]' compound). Only indexed fields are listed; rows may hold any other fields.
// Upgrades must be idempotent and must NEVER delete unsynced data (rows whose syncState is not
// 'synced', or any outbox op that is not 'synced'). Test the upgrade with fake-indexeddb by opening
// a DB at the previous version, writing rows, then opening at the new version.
//
// History
//   v1 (2026-10) — initial schema: entity tables, outbox, syncInbox, kv, offline content, apiCache.
//   v2 (2026-10, I2 performance pass) — annotations: indexes [targetKey+kind] and anchorStatus (index-only, no data
//        change). Highlight / bookmark / re-anchor views read only their own rows instead of every stroke of the page,
//        and Dexie no longer re-runs them on every ink write (5 000 strokes on a page: see docs/PERFORMANCE.md).
//   v3 (2026-10, Academic OS P1-T1 step 0) — the whole Phase 1 bump (ARCHITECTURE_DELTA §4.5, BUILD_PLAN §3.2): new
//        tables `layers` (annotation_layer rows), `copies` (document_copy rows) and `spaceCursors` (pull cursor + epoch
//        per target database); index `layerId` on annotations and notes. Index-only, no upgrade function: no row is
//        rewritten. A legacy row has no layerId = the default personal layer of its document (PRD AOS-4.6); a legacy
//        outbox op has no target = the user's vault. Repositories in the feature folders use these tables.
import Dexie, { type EntityTable, type Table, type Transaction } from 'dexie';
import type { LayerKind, SyncOpKind, SyncOpResult, SyncResult, SyncState } from '@medlevo/shared';
import { legacyClaimHolder, recordLegacyClaim, storageAccount } from './userStorage';

export type { SyncOpKind, SyncResult };

/** Today's database name: the single owner's, and later the legacy database only user #1 may claim (ADR-0003 §5). */
export const LOCAL_DB_NAME = 'medlevo';

/**
 * One local database per signed-in user (ADR-0003 §3.7): `medlevo:<userId>`. `null`/`undefined` = the legacy single
 * owner, whose data stays in `medlevo`. Since P1-T1 step 3 getDb() opens the signed-in account's database
 * (currentLocalDbName); user #1 claims the legacy one (claimLegacyLocalData).
 */
export function localDbNameFor(userId: string | null | undefined): string {
  if (userId == null) return LOCAL_DB_NAME;
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new Error('localDbNameFor: invalid user id');
  return `${LOCAL_DB_NAME}:${userId}`;
}

/**
 * Drafts belong to their writer (ARCHITECTURE_DELTA §4.5): a crash-recovery draft is tagged with the user id when it is
 * written and recovered only for that user; an untagged draft (written before accounts existed) is recovered only by
 * the legacy owner (user #1). Rule only (P1-T1 step 0); noteDrafts.ts and the case-editor drafts adopt it in step 3.
 */
export function draftBelongsTo(tagUserId: string | null | undefined, viewer: { userId: string; isLegacyOwner: boolean }): boolean {
  if (tagUserId == null) return viewer.isLegacyOwner;
  return tagUserId === viewer.userId;
}

// ─── row types ──────────────────────────────────────────────────────────────────────────────
/** Fields every locally-written, synced entity row carries. */
export interface SyncedRowBase {
  /** client-generated ULID (idempotent sync) */
  id: string;
  /** epoch ms of the last local change */
  updatedAt: number;
  /** denormalised mirror of the outbox state for this entity (index for "unsynced" queries) */
  syncState: SyncState;
  /** server revision this row is based on (null until the server acknowledged it) */
  rev?: number | null;
  /** tombstone (soft delete) — never hard-delete owner writing */
  deletedAt?: number | null;
  createdAt?: number;
}

export interface AnnotationRow extends SyncedRowBase {
  /** where the annotation lives: `${target_type}:${target_id}` (source_page / note_page / artifact_block) */
  targetKey: string;
  /** authorship layer (v3); absent = the default personal layer of the document («ملاحظاتي») */
  layerId?: string | null;
  kind: string;
  tool?: string | null;
  anchor: unknown;
  data: unknown;
  layer?: 'ink' | 'highlight' | 'text' | 'media';
  z?: number;
  locked?: boolean;
  anchorStatus?: 'ok' | 'needs_reanchor' | 'reanchored';
  input?: unknown;
}

export interface NoteRow extends SyncedRowBase {
  nodeId?: string | null;
  /** authorship layer (v3); absent = the default personal layer */
  layerId?: string | null;
  /** optional anchor key for notes attached to a page/block */
  anchorKey?: string | null;
  title?: string | null;
  body: unknown; // RichText
  anchor?: unknown;
  origin?: 'owner' | 'ai_answer' | 'handwriting_recognition';
  conflictOfId?: string | null;
}

export interface NotePageRow extends SyncedRowBase {
  nodeId?: string | null;
  sourceId?: string | null;
  afterPageIndex?: number | null;
  title?: string | null;
  template: 'blank' | 'ruled' | 'dotted' | 'grid';
  width: number;
  height: number;
  sortOrder: number;
}

export interface FlashcardRow extends SyncedRowBase {
  kind: 'basic' | 'cloze' | 'image_occlusion' | 'mistake';
  front: unknown;
  back: unknown;
  sourceId?: string | null;
  sourceVersionId?: string | null;
  evidenceIds?: string[];
  origin: 'owner' | 'generated' | 'from_mistake' | 'from_selection';
  suspended?: boolean;
}

export interface ReviewEventRow extends SyncedRowBase {
  cardId: string;
  rating: 1 | 2 | 3 | 4;
  reviewedAt: number;
  durationMs?: number | null;
}

export interface QuestionAttemptRow extends SyncedRowBase {
  questionId: string;
  questionVersionId: string;
  examAttemptId?: string | null;
  selectedOptionIds?: string[];
  confidence?: 'guess' | 'unsure' | 'confident' | null;
  hintsUsed?: number;
  timeMs?: number | null;
  answeredAt: number;
}

export interface ExamAttemptRow extends SyncedRowBase {
  examId: string;
  status: 'in_progress' | 'paused' | 'completed' | 'abandoned';
  startedAt: number;
}

/** An authorship layer on a document (v3; server `annotation_layer`, ARCHITECTURE_DELTA §4.3). */
export interface LayerRow extends SyncedRowBase {
  /** 'source:<source_id>' (all versions of a source) | 'notebook:<library_node_id>' */
  documentKey: string;
  kind: LayerKind;
  title: string;
  /** false: followed / published snapshot — writes are refused by the server (`layer_read_only`) */
  writable: boolean;
  /** true: an immutable snapshot */
  frozen: boolean;
  /** default visibility; per-session overrides live in the study session's location */
  visible: boolean;
  /** the owner locked the layer against accidental edits */
  locked: boolean;
  color?: string | null;
  sortOrder: number;
  /** where a copied layer came from: {space_id, publication_id, version_no, author_user_id, author_display} */
  origin?: unknown;
}

/** A user's study copy of a lecture (v3; server `document_copy`, ARCHITECTURE_DELTA §4.2 `0860`). */
export interface CopyRow extends SyncedRowBase {
  /** the stub (or a private upload) */
  sourceId: string;
  originSpaceId?: string | null;
  originLectureId?: string | null;
  mode: 'personal' | 'independent_fork' | 'followed' | 'collaborative';
  /** fork / followed: the publication it came from */
  publicationId?: string | null;
  appliedVersionNo?: number | null;
  pendingVersionNo?: number | null;
  updatePolicy: 'preview' | 'auto';
  personalLayerId: string;
  copiedLayerId?: string | null;
  collabDocRef?: string | null;
}

/**
 * Where an outbox op is delivered (ARCHITECTURE_DELTA §4.5, §8.1): the user's vault, or one subject space. Ordered
 * delivery per target. A stored op without `target` is a vault op (every op written before v3).
 */
export type SyncTarget = 'vault' | `space:${string}`;

const SPACE_TARGET_RE = /^space:[A-Za-z0-9_-]{1,64}$/;

export function isSyncTarget(v: unknown): v is SyncTarget {
  return v === 'vault' || (typeof v === 'string' && SPACE_TARGET_RE.test(v));
}

/** The pull cursor and server epoch of one target database (v3; ARCHITECTURE_DELTA §8.1). */
export interface SpaceCursorRecord {
  target: SyncTarget;
  /** last change sequence pulled from that database */
  since: number;
  /** that database's data epoch (a restore of it resets this cursor only) */
  epoch: string | null;
  updatedAt: number;
}

export interface StudySessionRow extends SyncedRowBase {
  sourceId?: string | null;
  versionId?: string | null;
  mode: 'learn' | 'understand' | 'practice' | 'review' | 'exam';
  view: 'original' | 'study_book' | 'split';
  location: unknown;
  scope?: unknown;
}

// ─── sync tables ────────────────────────────────────────────────────────────────────────────
export const SYNC_ENTITY_TYPES = [
  'annotation',
  'note',
  'note_page',
  'flashcard',
  'review_event',
  'question_attempt',
  'study_session',
  'exam_attempt',
  // Academic OS (v3): authorship layers sync like the other vault entities (ARCHITECTURE_DELTA §8.3)
  'annotation_layer',
] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];


/**
 * Outbox op lifecycle:
 *   pending  → (push) → synced    applied | merged | duplicate
 *                     → conflict  conflict_kept_both (server kept both copies) or rejected with a server copy
 *                     → rejected  rejected without a server copy (needs the owner's attention)
 *   pending stays pending (attempts++, nextAttemptAt backoff) on network/server failure.
 *   rejected / conflict → (owner: SyncEngine.retry) a NEW pending op with a fresh op_id (`retryOf`); the old
 *   one stays, acknowledged, with `supersededBy` (the server never re-applies an op_id it has answered).
 *   Ops are never deleted on failure; only synced ops are pruned after a retention period.
 */
export type OutboxStatus = 'pending' | 'synced' | 'conflict' | 'rejected';

export interface OutboxRecord {
  seq?: number;
  op_id: string;
  /** (v3) the database the op goes to; absent = 'vault' (never stored for vault ops, so legacy ops are unchanged) */
  target?: SyncTarget;
  entity_type: string;
  entity_id: string;
  op: SyncOpKind;
  base_rev?: number | null;
  payload: unknown;
  client_ts: number;
  status: OutboxStatus;
  attempts: number;
  /** epoch ms before which the op is not retried */
  nextAttemptAt: number;
  /** set when the op was first handed to the network (never coalesce a sent op) */
  sentAt?: number | null;
  lastError?: string | null;
  result?: SyncResult | null;
  resultDetail?: unknown;
  /** server copy returned with the result (conflict / rejected / applied) */
  resultEntity?: unknown;
  resolvedAt?: number | null;
  /** owner acknowledged a conflict / rejection */
  acknowledgedAt?: number | null;
  /** op_id of the new op created by SyncEngine.retry() for this one (the server never re-applies an op_id) */
  supersededBy?: string | null;
  /** op_id of the rejected / conflicting op this op re-sends */
  retryOf?: string | null;
  /**
   * (P1-T1 step 0 review) a FINAL server rejection whose `SyncEngine.onRejected` handlers have not all completed yet:
   * the server's answer (without its copy, which stays in `resultEntity`), stored in the same transaction as the
   * verdict. Cleared once every handler of the entity type succeeded; a handler registered later (a lazily loaded
   * feature, the next page load) receives it. Absent on every other op, so legacy records are unchanged.
   */
  pendingRejection?: Omit<SyncOpResult, 'entity'> | null;
}

/** Server changes waiting for a feature applier (latest change per entity). */
export interface SyncInboxRecord {
  entity_type: string;
  entity_id: string;
  seq: number;
  entity: unknown | null;
  receivedAt: number;
}

export interface KvRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

/** Explicitly downloaded source versions (Download Manager, §47). */
export interface OfflineSourceRecord {
  sourceId: string;
  versionId: string;
  title?: string;
  sizeBytes: number;
  pageCount?: number;
  downloadedAt: number;
  /** what is stored: pages, images, study_book, questions … */
  parts: string[];
}

export interface BlobRecord {
  id: string;
  sourceId?: string | null;
  versionId?: string | null;
  kind: string; // 'file' | 'page_image' | 'thumbnail' | …
  mime: string;
  size: number;
  data: Blob;
  storedAt: number;
}

/** Explicit, opt-in cache of GET responses used offline (never written by the service worker). */
export interface ApiCacheRecord {
  key: string;
  value: unknown;
  storedAt: number;
  etag?: string | null;
}

export interface LocalSchemaVersion {
  version: number;
  stores: Record<string, string | null>;
  upgrade?: (tx: Transaction) => Promise<void> | void;
}

export const LOCAL_SCHEMA: readonly LocalSchemaVersion[] = [
  {
    version: 1,
    stores: {
      annotations: 'id, targetKey, updatedAt, syncState',
      notes: 'id, nodeId, anchorKey, updatedAt, syncState',
      notePages: 'id, nodeId, sourceId, updatedAt, syncState',
      flashcards: 'id, sourceId, updatedAt, syncState',
      reviewEvents: 'id, cardId, reviewedAt, syncState',
      questionAttempts: 'id, questionId, examAttemptId, answeredAt, syncState',
      examAttempts: 'id, examId, updatedAt, syncState',
      studySessions: 'id, sourceId, updatedAt, syncState',
      outbox: '++seq, &op_id, entity_type, entity_id, status, [entity_type+entity_id]',
      syncInbox: '[entity_type+entity_id], entity_type, seq',
      kv: 'key',
      offlineSources: 'sourceId, versionId, downloadedAt',
      blobs: 'id, sourceId, versionId, kind',
      apiCache: 'key, storedAt',
    },
  },
  {
    version: 2,
    stores: {
      annotations: 'id, targetKey, updatedAt, syncState, [targetKey+kind], anchorStatus',
    },
  },
  {
    version: 3,
    stores: {
      annotations: 'id, targetKey, updatedAt, syncState, [targetKey+kind], anchorStatus, layerId',
      notes: 'id, nodeId, anchorKey, updatedAt, syncState, layerId',
      layers: 'id, documentKey, updatedAt, syncState',
      copies: 'id, sourceId, publicationId, updatedAt, syncState',
      spaceCursors: 'target',
    },
  },
];

export type EntityTableName =
  | 'layers'
  | 'annotations'
  | 'notes'
  | 'notePages'
  | 'flashcards'
  | 'reviewEvents'
  | 'questionAttempts'
  | 'studySessions'
  | 'examAttempts';

/** entity_type → Dexie table holding the local rows (used to mirror syncState). */
export const ENTITY_TABLE: Record<SyncEntityType, EntityTableName> = {
  annotation: 'annotations',
  note: 'notes',
  note_page: 'notePages',
  flashcard: 'flashcards',
  review_event: 'reviewEvents',
  question_attempt: 'questionAttempts',
  study_session: 'studySessions',
  exam_attempt: 'examAttempts',
  annotation_layer: 'layers',
};

/** The target of a stored outbox op (legacy ops have none: they are vault ops). */
export function outboxTarget(op: Pick<OutboxRecord, 'target'>): SyncTarget {
  return op.target ?? 'vault';
}

export class MedLevoDB extends Dexie {
  annotations!: EntityTable<AnnotationRow, 'id'>;
  notes!: EntityTable<NoteRow, 'id'>;
  notePages!: EntityTable<NotePageRow, 'id'>;
  flashcards!: EntityTable<FlashcardRow, 'id'>;
  reviewEvents!: EntityTable<ReviewEventRow, 'id'>;
  questionAttempts!: EntityTable<QuestionAttemptRow, 'id'>;
  examAttempts!: EntityTable<ExamAttemptRow, 'id'>;
  studySessions!: EntityTable<StudySessionRow, 'id'>;
  outbox!: EntityTable<OutboxRecord, 'seq'>;
  syncInbox!: Table<SyncInboxRecord, [string, string]>;
  kv!: EntityTable<KvRecord, 'key'>;
  offlineSources!: EntityTable<OfflineSourceRecord, 'sourceId'>;
  blobs!: EntityTable<BlobRecord, 'id'>;
  apiCache!: EntityTable<ApiCacheRecord, 'key'>;
  layers!: EntityTable<LayerRow, 'id'>;
  copies!: EntityTable<CopyRow, 'id'>;
  spaceCursors!: EntityTable<SpaceCursorRecord, 'target'>;

  constructor(name: string = LOCAL_DB_NAME) {
    super(name);
    for (const v of LOCAL_SCHEMA) {
      const ver = this.version(v.version).stores(v.stores);
      if (v.upgrade) ver.upgrade(v.upgrade);
    }
  }
}

let shared: MedLevoDB | null = null;

/**
 * The page's local database (P1-T1 step 3): the signed-in account's own `medlevo:<userId>`; the legacy `medlevo` for
 * user #1 once it claimed it on this device, and before the sign-in state is known (exactly today's behaviour).
 */
export function currentLocalDbName(): string {
  const a = storageAccount();
  return a && !a.legacy ? localDbNameFor(a.userId) : LOCAL_DB_NAME;
}

/** The app-wide database of the page's account (lazily opened). Tests create their own `new MedLevoDB(uniqueName)`. */
export function getDb(): MedLevoDB {
  const name = currentLocalDbName();
  if (!shared || shared.name !== name || shared.hasBeenClosed()) {
    // another account in this page: the previous account's database is closed, never written under the new one
    shared?.close();
    shared = new MedLevoDB(name);
  }
  return shared;
}

/** The local database this page has opened so far (null: none) — an account switch reloads the page when it differs. */
export function openedLocalDbName(): string | null {
  return shared && !shared.hasBeenClosed() ? shared.name : null;
}

/** Tests: forget the page's database instance (a fresh page). */
export function resetSharedDb(): void {
  shared?.close();
  shared = null;
}

/** kv key in the legacy database `medlevo`: the account that claimed it (ADR-0003 §5 step 8) */
export const LEGACY_OWNER_KV = 'owner_user_id';

/**
 * User #1 claims the data this device kept from before accounts (ADR-0003 §5 step 8): the IndexedDB database
 * `medlevo` and the un-prefixed localStorage keys STAY where they are and become user #1's namespace on this device
 * (zero copy: nothing can be lost on the way; a rollback still finds them). The claim is refused when another account
 * already claimed this device's legacy data, or the legacy database carries another account's mark (a deployment set
 * up again from scratch on the same address: its new user #1 is not the owner of these writes). Returns whether
 * `userId` owns the legacy namespace now. Only the server's `owns_legacy_device_data` (user #1) may lead here.
 */
export async function claimLegacyLocalData(userId: string): Promise<boolean> {
  const holder = legacyClaimHolder();
  if (holder !== null && holder !== userId) return false;
  try {
    if (await Dexie.exists(LOCAL_DB_NAME)) {
      // a short-lived connection of its own (the page's instance may belong to another account or be closed)
      const db = new MedLevoDB(LOCAL_DB_NAME);
      try {
        const mark = await kvGet<string>(db, LEGACY_OWNER_KV);
        if (typeof mark === 'string' && mark !== userId) return false;
        if (mark === undefined) await kvSet(db, LEGACY_OWNER_KV, userId);
      } finally {
        db.close();
      }
    }
  } catch {
    // IndexedDB unavailable: no claim — the account's own database is used and nothing legacy is touched
    return false;
  }
  recordLegacyClaim(userId);
  return true;
}

// ─── kv helpers ─────────────────────────────────────────────────────────────────────────────
export async function kvGet<T>(db: MedLevoDB, key: string): Promise<T | undefined> {
  const row = await db.kv.get(key);
  return row?.value as T | undefined;
}

export async function kvSet(db: MedLevoDB, key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value, updatedAt: Date.now() });
}

/** Asks the browser not to evict local data under storage pressure (best effort, §47). */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

/** Real usage/quota numbers from the browser (for the Download Manager / Control Center). */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}
