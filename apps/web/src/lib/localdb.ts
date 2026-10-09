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
import Dexie, { type EntityTable, type Table, type Transaction } from 'dexie';
import type { SyncOpKind, SyncResult, SyncState } from '@medlevo/shared';

export type { SyncOpKind, SyncResult };

export const LOCAL_DB_NAME = 'medlevo';

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
];

export type EntityTableName =
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
};

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

  constructor(name: string = LOCAL_DB_NAME) {
    super(name);
    for (const v of LOCAL_SCHEMA) {
      const ver = this.version(v.version).stores(v.stores);
      if (v.upgrade) ver.upgrade(v.upgrade);
    }
  }
}

let shared: MedLevoDB | null = null;

/** The app-wide database (lazily opened). Tests create their own `new MedLevoDB(uniqueName)`. */
export function getDb(): MedLevoDB {
  if (!shared) shared = new MedLevoDB();
  return shared;
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
