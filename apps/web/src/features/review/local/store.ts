// Local-first flashcards & review events (§43, §47, AC-23, AC-24) — the device copy the review session works from.
//
//  * Cards and review events live in Dexie (`flashcards`, `reviewEvents`); the server copies arrive through the sync
//    pull (appliers below) and through the HTTP answers of the card screens (putServerCards).
//  * A rating is an append-only `review_event` with a client ULID, written together with its outbox op in ONE
//    transaction (writeAndEnqueue) — it never waits for the network; the server counts an id once.
//  * Undo removes the event and its op ONLY while the op is still pending and has never been handed to the network
//    (no `sentAt`). Once it was sent it may already be in the server's log, which is never edited — the UI says so.
//  * Suspend / bury / edit / delete of a card are upserts (full card state, base_rev) or a tombstone; the server keeps
//    both copies on a concurrent edit (never a silent overwrite).
//  * The SRS configuration (params, owner timezone, daily new-card limit, parity sample) is cached in kv for offline use.
import {
  clozeIndexes,
  newId,
  richTextToPlain,
  type CardEvidenceSnapshot,
  type CardImpactView,
  type FlashcardDTO,
  type FlashcardKind,
  type FlashcardView,
  type ReviewEventDTO,
  type ReviewRating,
  type ReviewStateView,
  type RichText,
  type SrsConfigView,
} from '@medlevo/shared';
import { kvGet, kvSet, type FlashcardRow, type MedLevoDB, type ReviewEventRow } from '../../../lib/localdb';
import { enqueue, writeAndEnqueue, type SyncApplier, type SyncEngine } from '../../../lib/sync';

/** Dexie row of a card: the indexed fields of localdb.ts + the server view's other fields (non-indexed). */
export interface LocalCardRow extends FlashcardRow {
  noteId?: string | null;
  clozeIndex?: number | null;
  image?: FlashcardDTO['image'];
  conceptId?: string | null;
  topicId?: string | null;
  originRef?: Record<string, unknown> | null;
  buriedUntil?: number | null;
  /** owner relearn markers (folded as `forget`) */
  scheduleResets?: number[];
  /** the server's schedule at the last pull — shown when this device cannot compute the schedule itself */
  serverState?: ReviewStateView | null;
  evidence?: CardEvidenceSnapshot[];
  impacts?: CardImpactView[];
  needsReview?: boolean;
  originLabelAr?: string;
  kindLabelAr?: string;
  conflictOfId?: string | null;
  mergedIntoId?: string | null;
}

export type LocalEventRow = ReviewEventRow & { deviceId?: string | null };

const CONFIG_KEY = 'learning.srs-config';

export interface CachedSrsConfig {
  config: SrsConfigView;
  fetchedAt: number;
}

export async function cachedSrsConfig(db: MedLevoDB): Promise<CachedSrsConfig | null> {
  return (await kvGet<CachedSrsConfig>(db, CONFIG_KEY)) ?? null;
}

export async function storeSrsConfig(db: MedLevoDB, config: SrsConfigView, now = Date.now()): Promise<void> {
  await kvSet(db, CONFIG_KEY, { config, fetchedAt: now } satisfies CachedSrsConfig);
}

// ───────── server copies → rows ─────────
export function rowFromView(v: FlashcardView, prev?: LocalCardRow): LocalCardRow {
  return {
    ...(prev ?? {}),
    id: v.id,
    kind: v.kind,
    front: v.front,
    back: v.back,
    sourceId: v.source_id,
    sourceVersionId: v.source_version_id,
    evidenceIds: v.evidence_ids,
    origin: v.origin,
    suspended: v.suspended,
    buriedUntil: v.buried_until,
    noteId: v.note_id,
    clozeIndex: v.cloze_index,
    image: v.image ?? null,
    conceptId: v.concept_id,
    topicId: v.topic_id,
    originRef: v.origin_ref,
    scheduleResets: v.schedule_resets ?? [],
    serverState: v.review_state ?? null,
    evidence: v.evidence ?? [],
    impacts: v.impacts ?? [],
    needsReview: v.needs_review,
    originLabelAr: v.origin_label_ar,
    kindLabelAr: v.kind_label_ar,
    conflictOfId: v.conflict_of_id,
    mergedIntoId: v.merged_into_id,
    rev: v.rev,
    createdAt: v.created_at,
    updatedAt: Math.max(prev?.updatedAt ?? 0, v.updated_at),
    deletedAt: v.deleted_at,
    syncState: prev?.syncState ?? 'synced',
  };
}

/** Server-derived fields only (used while a local edit of the card is still on its way). */
function refreshDerived(prev: LocalCardRow, v: FlashcardView): LocalCardRow {
  return {
    ...prev,
    scheduleResets: v.schedule_resets ?? prev.scheduleResets ?? [],
    serverState: v.review_state ?? prev.serverState ?? null,
    evidence: v.evidence ?? prev.evidence,
    impacts: v.impacts ?? prev.impacts,
    needsReview: v.needs_review,
    originLabelAr: v.origin_label_ar,
    kindLabelAr: v.kind_label_ar,
  };
}

async function hasPendingOps(db: MedLevoDB, entityType: string, id: string): Promise<boolean> {
  const n = await db.outbox
    .where('[entity_type+entity_id]')
    .equals([entityType, id])
    .filter((o) => o.status === 'pending')
    .count();
  return n > 0;
}

/** Writes server card views into Dexie without overwriting an unsynced local edit. */
export async function putServerCards(db: MedLevoDB, views: readonly FlashcardView[]): Promise<void> {
  await db.transaction('rw', [db.flashcards, db.outbox], async () => {
    for (const v of views) {
      if (!v || typeof v !== 'object' || !v.id) continue;
      const prev = (await db.flashcards.get(v.id)) as LocalCardRow | undefined;
      const pending = await hasPendingOps(db, 'flashcard', v.id);
      await db.flashcards.put(pending && prev ? refreshDerived(prev, v) : rowFromView(v, prev));
    }
  });
}

export function eventRowFromDTO(e: ReviewEventDTO, prev?: LocalEventRow): LocalEventRow {
  return {
    ...(prev ?? {}),
    id: e.id,
    cardId: e.card_id,
    rating: e.rating,
    reviewedAt: e.reviewed_at,
    durationMs: e.duration_ms,
    deviceId: e.device_id,
    createdAt: prev?.createdAt ?? e.reviewed_at,
    updatedAt: Math.max(prev?.updatedAt ?? 0, e.reviewed_at),
    syncState: prev?.syncState ?? 'synced',
  };
}

const flashcardApplier: SyncApplier = async (change, { db, localOps }) => {
  const v = change.entity as FlashcardView | null;
  if (!v || typeof v !== 'object' || !v.id) return;
  const prev = (await db.flashcards.get(v.id)) as LocalCardRow | undefined;
  const pending = localOps.some((o) => o.status === 'pending');
  await db.flashcards.put(pending && prev ? refreshDerived(prev, v) : rowFromView(v, prev));
};

const reviewEventApplier: SyncApplier = async (change, { db, localOps }) => {
  const e = change.entity as ReviewEventDTO | null;
  if (!e || typeof e !== 'object' || !e.id) return;
  if (localOps.some((o) => o.status === 'pending')) return; // the local copy is on its way (append-only)
  const prev = (await db.reviewEvents.get(e.id)) as LocalEventRow | undefined;
  // the server may have kept a future-dated review at its own time: its copy is the one the schedule uses
  await db.reviewEvents.put(eventRowFromDTO(e, prev));
};

const registered = new WeakSet<SyncEngine>();
/** Registers the learning appliers once per engine (called by the home and review screens). */
export function registerLearningAppliers(engine: SyncEngine): void {
  if (registered.has(engine)) return;
  registered.add(engine);
  engine.registerApplier('flashcard', flashcardApplier);
  engine.registerApplier('review_event', reviewEventApplier);
}

// ───────── reads ─────────
export async function allCards(db: MedLevoDB): Promise<LocalCardRow[]> {
  return (await db.flashcards.toArray()) as LocalCardRow[];
}

export async function eventsByCard(db: MedLevoDB, cardIds?: readonly string[]): Promise<Map<string, LocalEventRow[]>> {
  const rows = (cardIds ? await db.reviewEvents.where('cardId').anyOf([...cardIds]).toArray() : await db.reviewEvents.toArray()) as LocalEventRow[];
  const map = new Map<string, LocalEventRow[]>();
  for (const r of rows) {
    const list = map.get(r.cardId) ?? [];
    list.push(r);
    map.set(r.cardId, list);
  }
  return map;
}

// ───────── review events ─────────
export interface RatingInput {
  cardId: string;
  rating: ReviewRating;
  reviewedAt: number;
  durationMs?: number | null;
  /** client ULID (tests); generated otherwise */
  id?: string;
}

/** One rating = one append-only review_event (client ULID) + its outbox op, in one transaction. Never awaits the network. */
export async function recordRating(db: MedLevoDB, input: RatingInput, now = Date.now()): Promise<LocalEventRow> {
  const id = input.id ?? newId(now);
  const row: LocalEventRow = {
    id,
    cardId: input.cardId,
    rating: input.rating,
    reviewedAt: input.reviewedAt,
    durationMs: input.durationMs ?? null,
    createdAt: now,
    updatedAt: now,
    syncState: 'pending_sync',
  };
  await writeAndEnqueue(db, db.reviewEvents, row, {
    entity_type: 'review_event',
    op: 'append',
    payload: { card_id: input.cardId, rating: input.rating, reviewed_at: input.reviewedAt, duration_ms: input.durationMs ?? null },
    client_ts: now,
  });
  return row;
}

export type UndoCheck = { possible: true } | { possible: false; reason_ar: string };

export const UNDO_SENT_AR = 'أُرسل هذا التقييم إلى الخادم، فلا يمكن التراجع عنه: سجل المراجعات لا يُعدَّل بعد المزامنة.';
export const UNDO_GONE_AR = 'لم يعد هذا التقييم موجودًا على هذا الجهاز.';
/** the send was attempted but failed (no answer): the server may or may not have it — undo stays refused */
export const UNDO_ATTEMPTED_AR = 'بدأ إرسال هذا التقييم إلى الخادم ولم يصل جواب بعد؛ ربما حُفظ هناك، فلا يمكن التراجع عنه: سجل المراجعات لا يُعدَّل بعد المزامنة. سيُعاد إرساله تلقائيًا (ولا يُحتسب مرتين).';

/** Whether a rating can still be withdrawn: only while its op is pending and has never been on the wire. */
export async function undoCheck(db: MedLevoDB, eventId: string): Promise<UndoCheck> {
  const ops = await db.outbox.where('[entity_type+entity_id]').equals(['review_event', eventId]).toArray();
  if (!(await db.reviewEvents.get(eventId))) return { possible: false, reason_ar: UNDO_GONE_AR };
  if (ops.length > 0 && ops.every((o) => o.status === 'pending') && ops.some((o) => !!o.sentAt && (o.attempts ?? 0) > 0 && !!o.lastError))
    return { possible: false, reason_ar: UNDO_ATTEMPTED_AR };
  if (ops.length === 0 || ops.some((o) => o.status !== 'pending' || !!o.sentAt)) return { possible: false, reason_ar: UNDO_SENT_AR };
  return { possible: true };
}

/** Withdraw an unsynced rating (event row + its never-sent op), atomically. Refused once the op was sent. */
export async function undoRating(db: MedLevoDB, eventId: string): Promise<UndoCheck> {
  return db.transaction('rw', [db.reviewEvents, db.outbox], async () => {
    const check = await undoCheck(db, eventId);
    if (!check.possible) return check;
    const ops = await db.outbox.where('[entity_type+entity_id]').equals(['review_event', eventId]).toArray();
    for (const o of ops) if (o.seq != null) await db.outbox.delete(o.seq);
    await db.reviewEvents.delete(eventId);
    return check;
  });
}

// ───────── card writes (local-first) ─────────
/** Full device payload of a card (the server keeps fields a payload does not carry, e.g. its evidence). */
export function cardPayload(row: LocalCardRow): Record<string, unknown> {
  const p: Record<string, unknown> = {
    kind: row.kind,
    front: row.front,
    back: row.back,
    suspended: !!row.suspended,
    buried_until: row.buriedUntil ?? null,
  };
  if (row.kind === 'cloze' && row.clozeIndex != null) p.cloze_index = row.clozeIndex;
  // a card the server has never acknowledged: its creation op may be coalesced with this one, so the payload must
  // still carry everything the insert needs (origin, creation time, note, source)
  if (row.rev == null) {
    if (row.origin !== 'generated') p.origin = row.origin;
    if (row.createdAt != null) p.created_at = row.createdAt;
    p.note_id = row.noteId ?? null;
    if (row.sourceId) p.source_id = row.sourceId;
    if (row.sourceVersionId) p.source_version_id = row.sourceVersionId;
  }
  return p;
}

/** Unsynced local ops for a card (its local edits must go through the outbox, not around it). */
export async function hasPendingCardOps(db: MedLevoDB, id: string): Promise<boolean> {
  return hasPendingOps(db, 'flashcard', id);
}

async function upsertCard(db: MedLevoDB, row: LocalCardRow, now: number): Promise<LocalCardRow> {
  const next: LocalCardRow = { ...row, updatedAt: now, syncState: 'pending_sync' };
  await writeAndEnqueue(db, db.flashcards, next, { entity_type: 'flashcard', op: 'upsert', base_rev: row.rev ?? null, payload: cardPayload(next), client_ts: now });
  return next;
}

export async function setSuspendedLocal(db: MedLevoDB, row: LocalCardRow, suspended: boolean, now = Date.now()): Promise<LocalCardRow> {
  return upsertCard(db, { ...row, suspended }, now);
}

export async function setBuriedLocal(db: MedLevoDB, row: LocalCardRow, until: number | null, now = Date.now()): Promise<LocalCardRow> {
  return upsertCard(db, { ...row, buriedUntil: until }, now);
}

export async function editCardLocal(db: MedLevoDB, row: LocalCardRow, content: { front: RichText; back: RichText }, now = Date.now()): Promise<LocalCardRow> {
  return upsertCard(db, { ...row, front: content.front, back: content.back }, now);
}

/** Tombstone (the review history stays on the server under the card's id). */
export async function deleteCardLocal(db: MedLevoDB, row: LocalCardRow, now = Date.now()): Promise<void> {
  await writeAndEnqueue(db, db.flashcards, { ...row, deletedAt: now, updatedAt: now }, { entity_type: 'flashcard', op: 'delete', base_rev: row.rev ?? null, payload: { id: row.id }, client_ts: now });
}

export interface LocalCreateInput {
  kind: Extract<FlashcardKind, 'basic' | 'cloze'>;
  front: RichText;
  back: RichText;
  sourceId?: string | null;
  sourceVersionId?: string | null;
}

/**
 * Offline creation of the owner's own cards (basic, or cloze → one card per {{cN::}} index sharing a note id).
 * Each card is a full upsert the server inserts on sync. Cards that need the server (from a selection, from a
 * mistake, image occlusion) are created online only.
 */
export async function createCardsLocal(db: MedLevoDB, input: LocalCreateInput, now = Date.now()): Promise<LocalCardRow[]> {
  const indexes = input.kind === 'cloze' ? clozeIndexes(richTextToPlain(input.front)) : [null];
  if (input.kind === 'cloze' && indexes.length === 0) throw new Error('بطاقة الإكمال تحتاج فراغًا واحدًا على الأقل بالصيغة {{c1::الجواب}}.');
  const noteId = input.kind === 'cloze' ? newId(now) : null;
  const rows: LocalCardRow[] = indexes.map((idx, i) => ({
    id: newId(now + i),
    kind: input.kind,
    front: input.front,
    back: input.back,
    sourceId: input.sourceId ?? null,
    sourceVersionId: input.sourceVersionId ?? null,
    evidenceIds: [],
    origin: 'owner',
    suspended: false,
    buriedUntil: null,
    noteId,
    clozeIndex: idx,
    image: null,
    conceptId: null,
    topicId: null,
    originRef: null,
    scheduleResets: [],
    serverState: null,
    evidence: [],
    impacts: [],
    needsReview: false,
    originLabelAr: 'بطاقة كتبتها بنفسك',
    rev: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    syncState: 'pending_sync',
  }));
  await db.transaction('rw', [db.flashcards, db.outbox], async () => {
    for (const r of rows) {
      await db.flashcards.put(r);
      const payload: Record<string, unknown> = cardPayload(r);
      await enqueue(db, { entity_type: 'flashcard', entity_id: r.id, op: 'upsert', base_rev: null, payload, client_ts: now });
    }
  });
  return rows;
}

// ───────── occlusion images kept on this device (explicit, never the HTTP cache) ─────────
export const cardImageBlobId = (imageAssetId: string) => `flashcard-image:${imageAssetId}`;

export async function storedCardImage(db: MedLevoDB, imageAssetId: string): Promise<Blob | null> {
  const row = await db.blobs.get(cardImageBlobId(imageAssetId));
  return row?.data ?? null;
}

export async function storeCardImage(db: MedLevoDB, imageAssetId: string, blob: Blob, sourceId: string | null): Promise<void> {
  await db.blobs.put({ id: cardImageBlobId(imageAssetId), sourceId, versionId: null, kind: 'flashcard_image', mime: blob.type || 'application/octet-stream', size: blob.size, data: blob, storedAt: Date.now() });
}
