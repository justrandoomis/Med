// Offline review (§43, §47, AC-23, AC-24): a rating is written to IndexedDB with its outbox op in one transaction and
// never waits for the network; it survives a reload; the local queue reschedules from it; undo is possible only while
// the op was never sent; the server copies (pull / push results) land without clobbering unsynced local writes.
import { beforeEach, describe, expect, it } from 'vitest';
import { newId, type FlashcardView, type ReviewEventDTO, type SrsParams, type SyncOpResult, type SyncPullResponse, type SyncPushRequest } from '@medlevo/shared';
import { MedLevoDB } from '../../src/lib/localdb';
import { setFetchImpl } from '../../src/lib/api';
import { SyncEngine, type SyncTransport } from '../../src/lib/sync';
import {
  UNDO_SENT_AR,
  createCardsLocal,
  eventsByCard,
  putServerCards,
  recordRating,
  registerLearningAppliers,
  setSuspendedLocal,
  undoCheck,
  undoRating,
  type LocalCardRow,
} from '../../src/features/review/local/store';
import { computeQueue, tomorrowStart } from '../../src/features/review/local/queue';
import { facesOf } from '../../src/features/review/local/render';
import { richTextFromPlain, richTextToPlain } from '@medlevo/shared';
import fixture from './fixtures/srs-parity.json';

const params = (fixture as { cases: Array<{ params: SrsParams }> }).cases[0]!.params;
const cfg = { params, daily_new_limit: 20, timezone: 'Asia/Baghdad' };
const T0 = Date.UTC(2026, 9, 10, 6, 0, 0); // 09:00 in Baghdad

class FakeTransport implements SyncTransport {
  pushes: SyncPushRequest[] = [];
  pullQueue: SyncPullResponse[] = [];
  respond: (req: SyncPushRequest) => SyncOpResult[] = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied' }));
  async push(req: SyncPushRequest) {
    this.pushes.push(JSON.parse(JSON.stringify(req)) as SyncPushRequest);
    return this.respond(req);
  }
  async pull(since: number) {
    return this.pullQueue.shift() ?? { changes: [], next_since: since, has_more: false };
  }
}

function view(id: string, over: Partial<FlashcardView> = {}): FlashcardView {
  return {
    id,
    kind: 'basic',
    front: richTextFromPlain('What is the most common cause of acute appendicitis?'),
    back: richTextFromPlain('Luminal obstruction (fecalith).'),
    image: null,
    concept_id: null,
    topic_id: null,
    source_id: 'S1',
    source_version_id: 'V1',
    evidence_ids: ['EV1'],
    origin: 'from_selection',
    origin_ref: null,
    suspended: false,
    buried_until: null,
    rev: 1,
    device_id: null,
    created_at: T0 - 86_400_000,
    updated_at: T0 - 86_400_000,
    deleted_at: null,
    note_id: null,
    cloze_index: null,
    conflict_of_id: null,
    merged_into_id: null,
    schedule_resets: [],
    review_state: { card_id: id, algorithm: 'x', state: 'new', due_at: T0 - 86_400_000, stability: null, difficulty: null, reps: 0, lapses: 0, last_review_at: null, retrievability: null },
    estimated_mastered: false,
    needs_review: false,
    impacts: [],
    evidence: [{ evidence_id: 'EV1', source_id: 'S1', source_title: 'Acute Appendicitis', version_id: 'V1', locator_label_ar: 'ص 3', quote: 'Luminal obstruction…', available: true }],
    origin_label_ar: 'بطاقة من نص حددته في المصدر',
    kind_label_ar: 'سؤال وجواب',
    ...over,
  };
}

let db: MedLevoDB;
let name: string;
beforeEach(async () => {
  name = `medlevo-learning-${newId()}`;
  db = new MedLevoDB(name);
  await db.open();
  // any network call in these tests is a bug: the write path is local-first
  setFetchImpl(() => Promise.reject(new Error('network must not be used')));
});

describe('offline rating', () => {
  it('writes the event and its append op atomically, without the network, and survives a reload', async () => {
    await putServerCards(db, [view('C1')]);
    const ev = await recordRating(db, { cardId: 'C1', rating: 3, reviewedAt: T0, durationMs: 4200 }, T0);
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity_type: 'review_event', entity_id: ev.id, op: 'append', status: 'pending', payload: { card_id: 'C1', rating: 3, reviewed_at: T0, duration_ms: 4200 } });
    expect(ops[0]!.sentAt ?? null).toBeNull();
    db.close();
    const again = new MedLevoDB(name);
    await again.open();
    expect(await again.reviewEvents.get(ev.id)).toMatchObject({ cardId: 'C1', rating: 3, reviewedAt: T0, syncState: 'pending_sync' });
    expect(await again.outbox.count()).toBe(1);
    again.close();
  });

  it('the local queue reschedules from the local event (same fold as the server)', async () => {
    await putServerCards(db, [view('C1'), view('C2', { created_at: T0 - 50_000 })]);
    let q = computeQueue(cfg, (await db.flashcards.toArray()) as LocalCardRow[], await eventsByCard(db), T0);
    expect(q.items.map((i) => [i.card.id, i.reason])).toEqual([
      ['C1', 'new'],
      ['C2', 'new'],
    ]);
    await recordRating(db, { cardId: 'C1', rating: 3, reviewedAt: T0 }, T0);
    q = computeQueue(cfg, (await db.flashcards.toArray()) as LocalCardRow[], await eventsByCard(db), T0 + 1000);
    expect(q.items.map((i) => i.card.id)).toEqual(['C2']); // C1 is learning, due in 10 minutes
    expect(q.counts.new_introduced_today).toBe(1);
    expect(q.next_due_at).toBe(T0 + 10 * 60_000);
    const later = computeQueue(cfg, (await db.flashcards.toArray()) as LocalCardRow[], await eventsByCard(db), T0 + 11 * 60_000);
    expect(later.items[0]).toMatchObject({ reason: 'learning' });
    expect(later.items[0]!.card.id).toBe('C1');
  });

  it('the daily new-card limit counts the OWNER day (Asia/Baghdad), not the device day', async () => {
    await putServerCards(db, [view('A', { created_at: 1 }), view('B', { created_at: 2 }), view('C', { created_at: 3 })]);
    const limited = { ...cfg, daily_new_limit: 2 };
    await recordRating(db, { cardId: 'A', rating: 3, reviewedAt: T0 }, T0);
    const q = computeQueue(limited, (await db.flashcards.toArray()) as LocalCardRow[], await eventsByCard(db), T0 + 1000);
    expect(q.counts.new_available).toBe(1);
    // 23:30 UTC = 02:30 next day in Baghdad: a new owner day, the limit is fresh again
    const nextDay = Date.UTC(2026, 9, 10, 23, 30);
    const q2 = computeQueue(limited, (await db.flashcards.toArray()) as LocalCardRow[], await eventsByCard(db), nextDay);
    expect(q2.day).toBe('2026-10-11');
    expect(q2.counts.new_available).toBe(2);
  });

  it('suspended and buried cards are not asked; bury defaults to the next owner day', async () => {
    await putServerCards(db, [view('C1'), view('C2')]);
    const c1 = (await db.flashcards.get('C1')) as LocalCardRow;
    await setSuspendedLocal(db, c1, true, T0);
    const op = (await db.outbox.toArray()).find((o) => o.entity_id === 'C1')!;
    expect(op).toMatchObject({ entity_type: 'flashcard', op: 'upsert', base_rev: 1, payload: { kind: 'basic', suspended: true, buried_until: null } });
    const q = computeQueue(cfg, (await db.flashcards.toArray()) as LocalCardRow[], await eventsByCard(db), T0);
    expect(q.items.map((i) => i.card.id)).toEqual(['C2']);
    expect(q.counts.suspended).toBe(1);
    expect(tomorrowStart(T0, 'Asia/Baghdad')).toBe(Date.UTC(2026, 9, 10, 21, 0)); // 00:00 Baghdad = 21:00 UTC
  });
});

describe('undo only before sync', () => {
  it('withdraws an unsent rating (row + op) and restores the queue', async () => {
    await putServerCards(db, [view('C1')]);
    const ev = await recordRating(db, { cardId: 'C1', rating: 1, reviewedAt: T0 }, T0);
    expect(await undoCheck(db, ev.id)).toEqual({ possible: true });
    expect(await undoRating(db, ev.id)).toEqual({ possible: true });
    expect(await db.reviewEvents.get(ev.id)).toBeUndefined();
    expect(await db.outbox.count()).toBe(0);
  });

  it('is refused once the op was handed to the network, and after the server acknowledged it', async () => {
    const transport = new FakeTransport();
    const engine = new SyncEngine({ db, transport, now: () => T0, random: () => 0.5, locks: null, deviceId: 'D1', isOnline: () => true });
    await putServerCards(db, [view('C1')]);
    const ev = await recordRating(db, { cardId: 'C1', rating: 3, reviewedAt: T0 }, T0);
    // the op is on the wire (sentAt set) but has no verdict yet
    const op = (await db.outbox.toArray())[0]!;
    await db.outbox.update(op.seq!, { sentAt: T0 });
    expect(await undoCheck(db, ev.id)).toEqual({ possible: false, reason_ar: UNDO_SENT_AR });
    expect(await undoRating(db, ev.id)).toMatchObject({ possible: false });
    expect(await db.reviewEvents.get(ev.id)).toBeDefined();
    // acknowledged by the server
    await engine.pushOnce();
    expect((await db.outbox.toArray())[0]).toMatchObject({ status: 'synced' });
    expect(transport.pushes[0]!.ops[0]).toMatchObject({ entity_type: 'review_event', entity_id: ev.id, op: 'append' });
    expect(await undoCheck(db, ev.id)).toMatchObject({ possible: false });
    expect(await db.reviewEvents.get(ev.id)).toBeDefined();
  });
});

describe('appliers', () => {
  it('pulled cards and events land in IndexedDB; an unsynced local edit is not overwritten', async () => {
    const transport = new FakeTransport();
    const engine = new SyncEngine({ db, transport, now: () => T0, random: () => 0.5, locks: null, deviceId: 'D1', isOnline: () => true });
    registerLearningAppliers(engine);
    await putServerCards(db, [view('C1')]);
    const local = (await db.flashcards.get('C1')) as LocalCardRow;
    await setSuspendedLocal(db, local, true, T0); // pending local change
    const ev: ReviewEventDTO = { id: 'E1', card_id: 'C2', rating: 4, reviewed_at: T0 - 5000, duration_ms: null, device_id: 'D2' };
    transport.pullQueue.push({
      changes: [
        { seq: 1, entity_type: 'flashcard', entity_id: 'C1', entity: view('C1', { rev: 2, suspended: false, back: richTextFromPlain('edited on another device'), needs_review: true }) },
        { seq: 2, entity_type: 'flashcard', entity_id: 'C2', entity: view('C2') },
        { seq: 3, entity_type: 'review_event', entity_id: 'E1', entity: ev },
      ],
      next_since: 3,
      has_more: false,
    });
    transport.respond = (req) => req.ops.map((o) => ({ op_id: o.op_id, result: 'applied', retryable: true }) as SyncOpResult); // keep local op pending
    await engine.syncNow();
    const c1 = (await db.flashcards.get('C1')) as LocalCardRow;
    expect(c1.suspended).toBe(true); // the local change is kept until the server answers it
    expect(richTextToPlain(c1.back as never)).toMatch(/Luminal/);
    expect(c1.needsReview).toBe(true); // server-derived fields still refresh
    expect(await db.flashcards.get('C2')).toBeDefined();
    expect(await db.reviewEvents.get('E1')).toMatchObject({ cardId: 'C2', rating: 4, syncState: 'synced' });
  });
});

describe('offline card creation and cloze faces', () => {
  it('a cloze text becomes one card per index (shared note), each a full upsert the server inserts on sync', async () => {
    const front = richTextFromPlain('The {{c1::appendix}} arises from the {{c2::caecum::bowel part}}.');
    const rows = await createCardsLocal(db, { kind: 'cloze', front, back: richTextFromPlain('') }, T0);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.noteId)).size).toBe(1);
    const ops = await db.outbox.toArray();
    expect(ops.map((o) => (o.payload as { cloze_index: number }).cloze_index)).toEqual([1, 2]);
    expect(ops.every((o) => (o.payload as { origin: string }).origin === 'owner')).toBe(true);
    const f2 = facesOf(rows[1]!);
    expect(richTextToPlain(f2.front)).toBe('The appendix arises from the [bowel part].');
    expect(richTextToPlain(f2.back)).toContain('caecum');
    const f1 = facesOf(rows[0]!);
    expect(richTextToPlain(f1.front)).toBe('The […] arises from the caecum.');
  });
});
