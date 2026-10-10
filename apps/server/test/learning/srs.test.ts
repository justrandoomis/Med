// Spaced repetition (§43, AC-24): FSRS fold determinism, arrival-order independence, duplicates applied once,
// review_state as a rebuildable cache, srs-config parity with an independent ts-fsrs fold, rejected events for
// unknown / deleted cards (never silently dropped), settings change → explicit rebuild.
import { createEmptyCard, fsrs, generatorParameters, type Grade } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardQueueResponse, FlashcardView, SrsConfigView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { foldReviews, sortHistory, srsParams, toStateView, type FoldEvent } from '../../src/modules/learning/srs';
import { api, createLearningApp, DAY, HOUR, jump, MIN, ok, push, shuffled, type LApp } from './helpers';

const T0 = Date.UTC(2026, 9, 1, 6, 0, 0);

function events(): FoldEvent[] {
  return [
    { id: '01EV0000000000000000000001', rating: 3, reviewed_at: T0 + 1 * MIN },
    { id: '01EV0000000000000000000002', rating: 3, reviewed_at: T0 + 12 * MIN },
    { id: '01EV0000000000000000000003', rating: 1, reviewed_at: T0 + 2 * DAY },
    { id: '01EV0000000000000000000004', rating: 3, reviewed_at: T0 + 2 * DAY + 11 * MIN },
    { id: '01EV0000000000000000000005', rating: 2, reviewed_at: T0 + 5 * DAY },
    { id: '01EV0000000000000000000006', rating: 4, reviewed_at: T0 + 12 * DAY },
    // same instant as the next one: the id breaks the tie deterministically
    { id: '01EV0000000000000000000008', rating: 3, reviewed_at: T0 + 30 * DAY },
    { id: '01EV0000000000000000000007', rating: 1, reviewed_at: T0 + 30 * DAY },
  ];
}

describe('FSRS fold (pure)', () => {
  const p = srsParams(0.9);

  it('gives the same state for the same events in any order (AC-24)', () => {
    const base = foldReviews(p, T0, events());
    for (let seed = 1; seed <= 25; seed++) {
      const other = foldReviews(p, T0, shuffled(events(), seed));
      expect(toStateView('c', p, other, T0 + 40 * DAY)).toEqual(toStateView('c', p, base, T0 + 40 * DAY));
    }
    expect(base.eventCount).toBe(8);
    expect(base.card.lapses).toBeGreaterThanOrEqual(1);
  });

  it('applies a duplicated event id once', () => {
    const evs = events();
    const dup = foldReviews(p, T0, [...evs, evs[2]!, { ...evs[5]! }, evs[0]!]);
    const once = foldReviews(p, T0, evs);
    expect(dup.eventCount).toBe(evs.length);
    expect(toStateView('c', p, dup, T0)).toEqual(toStateView('c', p, once, T0));
  });

  it('orders ties by id and relearn markers after events at the same ms', () => {
    const order = sortHistory(
      [
        { id: 'b', rating: 3, reviewed_at: 10 },
        { id: 'a', rating: 1, reviewed_at: 10 },
      ],
      [10, 5],
    ).map((i) => (i.kind === 'event' ? i.e.id : `reset@${i.at}`));
    expect(order).toEqual(['reset@5', 'a', 'b', 'reset@10']);
  });

  it('matches an independent ts-fsrs fold with the documented params', () => {
    const f = fsrs(generatorParameters({ ...p, w: [...p.w], learning_steps: p.learning_steps as never, relearning_steps: p.relearning_steps as never }));
    let card = createEmptyCard(new Date(T0));
    for (const e of [...events()].sort((a, b) => a.reviewed_at - b.reviewed_at || (a.id < b.id ? -1 : 1))) card = f.next(card, new Date(e.reviewed_at), e.rating as Grade).card;
    const ours = foldReviews(p, T0, events()).card;
    expect(ours.due.getTime()).toBe(card.due.getTime());
    expect(ours.stability).toBeCloseTo(card.stability, 10);
    expect(ours.difficulty).toBeCloseTo(card.difficulty, 10);
    expect(ours.reps).toBe(card.reps);
    expect(ours.lapses).toBe(card.lapses);
    expect(ours.state).toBe(card.state);
  });

  it('a relearn marker restarts the schedule without dropping the history', () => {
    const r = foldReviews(p, T0, events(), [T0 + 31 * DAY]);
    expect(r.eventCount).toBe(8);
    expect(r.card.state).toBe(0); // New again
    expect(r.card.reps).toBe(foldReviews(p, T0, events()).card.reps); // reset_count=false keeps the counts
  });
});

describe('review events through sync and HTTP (AC-24)', () => {
  let t: LApp;
  beforeEach(async () => {
    t = await createLearningApp({ now: T0 });
  });
  afterEach(async () => t.close());

  async function card(front = 'What is the most common site of the appendix?', back = 'Retrocaecal') {
    const r = await ok(api(t).post('/api/learning/cards', { kind: 'basic', front, back }));
    return r.cards[0] as FlashcardView;
  }

  it('the same events pushed in different orders (and twice) give identical schedules', async () => {
    const a = await card();
    const b = await card('Second card', 'Answer');
    await jump(t, T0 + 40 * DAY);
    const evs = events();
    const pushAll = async (cardId: string, tag: string, list: FoldEvent[]) =>
      push(t, list.map((e) => ({ entity_type: 'review_event', entity_id: `${tag}${e.id.slice(1)}`, op: 'append' as const, payload: { cardId, rating: e.rating, reviewedAt: e.reviewed_at, durationMs: 4000 } })));
    const ra = await pushAll(a.id, 'A', evs);
    expect(ra.every((r) => r.result === 'applied')).toBe(true);
    // card b: reversed order, then the whole batch again with NEW op ids (a device that lost the responses)
    const rb1 = await pushAll(b.id, 'B', [...evs].reverse());
    const rb2 = await pushAll(b.id, 'B', shuffled(evs, 7));
    expect(rb1.every((r) => r.result === 'applied')).toBe(true);
    expect(rb2.every((r) => r.result === 'duplicate')).toBe(true);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event WHERE card_id = ?', [b.id])!.n).toBe(evs.length);
    const va = (await ok(api(t).get(`/api/learning/cards/${a.id}`))).card as FlashcardView;
    const vb = (await ok(api(t).get(`/api/learning/cards/${b.id}`))).card as FlashcardView;
    const strip = (v: FlashcardView) => ({ ...v.review_state, card_id: '' });
    expect(strip(vb)).toEqual(strip(va));
    // the cache equals a from-scratch fold
    const pure = toStateView(a.id, srsParams(0.9), foldReviews(srsParams(0.9), a.created_at, evs), t.ctx.clock.now());
    expect(va.review_state).toEqual(pure);
  });

  it('a re-sent op id is a duplicate with the original result; HTTP submit is idempotent too', async () => {
    const c = await card();
    const op = { op_id: newId(), entity_type: 'review_event', entity_id: newId(), op: 'append' as const, payload: { card_id: c.id, rating: 3, reviewed_at: T0 + MIN } };
    const [first] = await push(t, [op]);
    const [again] = await push(t, [op]);
    expect(first!.result).toBe('applied');
    expect(again!.result).toBe('duplicate');
    expect(again!.original_result).toBe('applied');
    const body = { id: newId(), card_id: c.id, rating: 3, reviewed_at: T0 + 20 * MIN };
    const r1 = await ok(api(t).post('/api/learning/reviews', body));
    const r2 = await ok(api(t).post('/api/learning/reviews', body));
    expect(r1.result).toBe('applied');
    expect(r2.result).toBe('duplicate');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event WHERE card_id = ?', [c.id])!.n).toBe(2);
  });

  it('an event for an unknown or deleted card is rejected with the reason and never applied', async () => {
    const c = await card();
    const [unknown] = await push(t, [{ entity_type: 'review_event', entity_id: newId(), op: 'append', payload: { card_id: 'NO_SUCH_CARD', rating: 3, reviewed_at: T0 } }]);
    expect(unknown!.result).toBe('rejected');
    expect(unknown!.detail).toMatch(/غير موجودة/);
    await ok(api(t).del(`/api/learning/cards/${c.id}`));
    const opId = newId();
    const [deleted] = await push(t, [{ op_id: opId, entity_type: 'review_event', entity_id: newId(), op: 'append', payload: { card_id: c.id, rating: 3, reviewed_at: T0 } }]);
    expect(deleted!.result).toBe('rejected');
    expect(deleted!.detail).toMatch(/محذوفة/);
    // recorded (not silently dropped) — the device gets the same answer on retry
    expect(t.ctx.sync.operation(opId)?.result).toBe('rejected');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event')!.n).toBe(0);
    const del = await api(t).post('/api/learning/reviews', { id: newId(), card_id: c.id, rating: 3, reviewed_at: T0 });
    expect(del.statusCode).toBe(409);
    // delete of a review event is refused
    const [d] = await push(t, [{ entity_type: 'review_event', entity_id: newId(), op: 'delete', payload: {} }]);
    expect(d!.result).toBe('rejected');
  });

  it('keeps a review from a device clock ahead of the server, at the server time, recording the original', async () => {
    const c = await card();
    const id = newId();
    await push(t, [{ entity_type: 'review_event', entity_id: id, op: 'append', payload: { card_id: c.id, rating: 3, reviewed_at: T0 + 3 * HOUR } }]);
    const row = t.ctx.db.get<{ reviewed_at: number; context_json: string }>('SELECT reviewed_at, context_json FROM review_event WHERE id = ?', [id])!;
    expect(row.reviewed_at).toBe(T0);
    expect(JSON.parse(row.context_json).client_reviewed_at).toBe(T0 + 3 * HOUR);
  });

  it('GET /srs-config: params + algorithm + a live parity sample reproducible with ts-fsrs', async () => {
    const cfg = await ok<SrsConfigView>(api(t).get('/api/learning/srs-config'));
    expect(cfg.algorithm).toMatch(/FSRS-6/);
    expect(cfg.algorithm).toMatch(/ts-fsrs v5\.4\.2/);
    expect(cfg.algorithm).toMatch(/desired_retention=0\.90/);
    expect(cfg.params.enable_fuzz).toBe(false);
    expect(cfg.params.w).toHaveLength(21);
    expect(cfg.daily_new_limit).toBe(20);
    expect(cfg.timezone).toBe('Asia/Baghdad');
    // an independent client fold with ONLY the returned config reproduces the expected state
    const f = fsrs(generatorParameters({ ...cfg.params, learning_steps: cfg.params.learning_steps as never, relearning_steps: cfg.params.relearning_steps as never }));
    let c = createEmptyCard(new Date(cfg.parity_check.created_at));
    for (const e of [...cfg.parity_check.events].sort((a, b) => a.reviewed_at - b.reviewed_at || (a.id < b.id ? -1 : 1))) c = f.next(c, new Date(e.reviewed_at), e.rating as Grade).card;
    expect(c.due.getTime()).toBe(cfg.parity_check.expected.due_at);
    expect(c.reps).toBe(cfg.parity_check.expected.reps);
    expect(c.lapses).toBe(cfg.parity_check.expected.lapses);
    expect(c.stability).toBeCloseTo(cfg.parity_check.expected.stability!, 6);
    expect(f.get_retrievability(c, new Date(cfg.parity_check.at), false)).toBeCloseTo(cfg.parity_check.expected.retrievability!, 6);

    // parity on real data: a client fold of a card's events with the config equals the server state
    const card1 = await card();
    await jump(t, T0 + 20 * DAY);
    for (const e of events().slice(0, 5)) await ok(api(t).post('/api/learning/reviews', { id: e.id, card_id: card1.id, rating: e.rating, reviewed_at: e.reviewed_at + 0 }));
    const server = ((await ok(api(t).get(`/api/learning/cards/${card1.id}`))).card as FlashcardView).review_state;
    let cc = createEmptyCard(new Date(card1.created_at));
    for (const e of events().slice(0, 5)) cc = f.next(cc, new Date(e.reviewed_at), e.rating as Grade).card;
    expect(server.due_at).toBe(cc.due.getTime());
    expect(server.algorithm).toBe(cfg.algorithm);
  });

  it('settings change → schedules are recomputed (explicit rebuild + lazy), the review log is untouched', async () => {
    const c = await card();
    await jump(t, T0 + 3 * DAY);
    for (const e of events().slice(0, 4)) await ok(api(t).post('/api/learning/reviews', { id: e.id, card_id: c.id, rating: e.rating, reviewed_at: e.reviewed_at }));
    const before = ((await ok(api(t).get(`/api/learning/cards/${c.id}`))).card as FlashcardView).review_state;
    await ok(api(t).patch('/api/settings', { desired_retention: 0.8 }));
    const rebuilt = await ok(api(t).post('/api/learning/srs/rebuild', {}));
    expect(rebuilt.cards).toBe(1);
    expect(rebuilt.changed).toBe(1);
    expect(rebuilt.algorithm).toMatch(/desired_retention=0\.80/);
    const after = ((await ok(api(t).get(`/api/learning/cards/${c.id}`))).card as FlashcardView).review_state;
    expect(after.algorithm).toMatch(/desired_retention=0\.80/);
    expect(after.due_at).toBeGreaterThan(before.due_at); // lower retention → longer interval
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event WHERE card_id = ?', [c.id])!.n).toBe(4);
    // lazily: a stale cache row (other params_key) is recomputed on read
    t.ctx.db.run(`UPDATE review_state SET params_key = 'old', due_at = 0 WHERE card_id = ?`, [c.id]);
    const lazy = ((await ok(api(t).get(`/api/learning/cards/${c.id}`))).card as FlashcardView).review_state;
    expect(lazy.due_at).toBe(after.due_at);
  });

  it('queue: due learning/review cards first, new cards limited by the daily limit of the OWNER day', async () => {
    await ok(api(t).patch('/api/settings', { daily_new_cards: 2 }));
    const cards: FlashcardView[] = [];
    for (let i = 0; i < 4; i++) cards.push(await card(`Q${i}`, `A${i}`));
    let q = await ok<CardQueueResponse>(api(t).get('/api/learning/review/queue'));
    expect(q.counts.new_available).toBe(2);
    expect(q.counts.new_limit).toBe(2);
    expect(q.items.map((i) => i.reason)).toEqual(['new', 'new']);
    // reviewing introduces new cards for TODAY (Asia/Baghdad); the limit is per owner day
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: cards[0]!.id, rating: 3, reviewed_at: T0 + MIN }));
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: cards[1]!.id, rating: 1, reviewed_at: T0 + MIN }));
    t.clock.set(T0 + 20 * MIN);
    q = await ok<CardQueueResponse>(api(t).get('/api/learning/review/queue'));
    expect(q.counts.new_introduced_today).toBe(2);
    expect(q.counts.new_available).toBe(0);
    expect(q.items.every((i) => i.reason === 'learning')).toBe(true);
    expect(q.items.length).toBe(2);
    expect(q.algorithm).toMatch(/FSRS-6/);
  });
});
