// Timezone day boundaries (§45, §47): owner days in Asia/Baghdad, storage in UTC epoch ms, and independence from the
// DEVICE / process timezone (changing TZ never moves a due time or a plan day).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardQueueResponse, FlashcardView, StudyPlanView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { planCore } from '../../src/modules/learning/planner';
import { foldReviews, srsParams } from '../../src/modules/learning/srs';
import { addDays, dayEndMs, dayOf, dayStartMs, daysBetween, isDay, weekdayOf } from '../../src/modules/learning/time';
import { api, createLearningApp, jump, MIN, ok, type LApp } from './helpers';

const BAGHDAD = 'Asia/Baghdad';

describe('owner day helpers', () => {
  it('Asia/Baghdad (UTC+3) day boundaries', () => {
    expect(dayOf(Date.UTC(2026, 9, 9, 20, 59, 59), BAGHDAD)).toBe('2026-10-09');
    expect(dayOf(Date.UTC(2026, 9, 9, 21, 0, 0), BAGHDAD)).toBe('2026-10-10');
    expect(dayStartMs('2026-10-10', BAGHDAD)).toBe(Date.UTC(2026, 9, 9, 21, 0, 0));
    expect(dayEndMs('2026-10-09', BAGHDAD)).toBe(Date.UTC(2026, 9, 9, 21, 0, 0));
    expect(dayStartMs('2026-01-01', BAGHDAD)).toBe(Date.UTC(2025, 11, 31, 21, 0, 0));
  });

  it('calendar arithmetic and weekdays are timezone-free', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-10-09', '2026-11-08')).toBe(30);
    expect(weekdayOf('2026-10-09')).toBe(5); // Friday
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-10-09')).toBe(true);
  });

  it('DST zones still give exact local midnights', () => {
    // 2026-03-08: US DST starts — midnight is still EST (UTC-5)
    expect(dayStartMs('2026-03-08', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 5, 0, 0));
    expect(dayStartMs('2026-03-09', 'America/New_York')).toBe(Date.UTC(2026, 2, 9, 4, 0, 0));
  });

  it('results do not depend on the process / device timezone', () => {
    const run = () => {
      const p = srsParams(0.9);
      const t0 = Date.UTC(2026, 9, 9, 20, 55, 0);
      const fold = foldReviews(p, t0, [
        { id: 'e1', rating: 3, reviewed_at: t0 + MIN },
        { id: 'e2', rating: 3, reviewed_at: t0 + 15 * MIN },
        { id: 'e3', rating: 2, reviewed_at: t0 + 3 * 86_400_000 },
      ]);
      const plan = planCore({
        today: dayOf(t0, BAGHDAD),
        exam_date: '2026-10-20',
        weekdays: [0, 1, 2, 3, 4, 6],
        daily_minutes: 90,
        blocked: ['2026-10-14'],
        include: { learn: true, review: true, mcq: true, flashcards: true, weakness: false },
        lectures: [{ source_id: 's1', title: 'L1', pages: 30, processing: 'ready', question_count: 6 }],
        flashcards_minutes: 10,
        weaknesses: [],
      });
      return JSON.stringify({ due: fold.card.due.getTime(), day: dayOf(t0, BAGHDAD), start: dayStartMs('2026-10-10', BAGHDAD), plan });
    };
    const original = process.env.TZ;
    try {
      const results = ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Baghdad', 'Australia/Lord_Howe'].map((tz) => {
        process.env.TZ = tz;
        return run();
      });
      expect(new Set(results).size).toBe(1);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('owner day in the API', () => {
  let t: LApp;
  // 2026-10-09 20:40 UTC = 23:40 in Baghdad (still the 9th there; also the 9th in UTC)
  const T = Date.UTC(2026, 9, 9, 20, 40, 0);
  beforeEach(async () => {
    t = await createLearningApp({ now: T });
  });
  afterEach(async () => t.close());

  const newCard = async (front: string) => ((await ok(api(t).post('/api/learning/cards', { kind: 'basic', front, back: 'x' }))).cards[0] as FlashcardView);

  it('«due today» ends at Baghdad midnight, not at UTC midnight', async () => {
    const a = await newCard('a');
    const b = await newCard('b');
    // a: Good at 20:40Z → due 20:50Z (23:50 Baghdad, today). b: Good at 20:55Z → due 21:05Z (00:05 Baghdad TOMORROW,
    // but still the 9th in UTC)
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: a.id, rating: 3, reviewed_at: T }));
    t.clock.set(T + 15 * MIN);
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: b.id, rating: 3, reviewed_at: T + 15 * MIN }));
    const q = await ok<CardQueueResponse>(api(t).get('/api/learning/review/queue'));
    expect(q.day).toBe('2026-10-09');
    expect(q.timezone).toBe(BAGHDAD);
    expect(q.counts.due_today).toBe(1);
    expect(q.counts.due_now).toBe(1);
    // after Baghdad midnight the owner day changes even though the UTC date does not
    t.clock.set(Date.UTC(2026, 9, 9, 21, 30, 0));
    const q2 = await ok<CardQueueResponse>(api(t).get('/api/learning/review/queue'));
    expect(q2.day).toBe('2026-10-10');
    expect(q2.counts.new_introduced_today).toBe(0); // yesterday's (Baghdad) introductions do not count today
  });

  it('bury defaults to the start of the next Baghdad day', async () => {
    const c = await newCard('bury me');
    const r = await ok(api(t).post(`/api/learning/cards/${c.id}/bury`, {}));
    expect(r.card.buried_until).toBe(Date.UTC(2026, 9, 9, 21, 0, 0));
  });

  it('changing the owner timezone moves «today», never stored due times or plan days', async () => {
    const c = await newCard('tz');
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: c.id, rating: 3, reviewed_at: T }));
    const before = ((await ok(api(t).get(`/api/learning/cards/${c.id}`))).card as FlashcardView).review_state.due_at;
    // a plan made in Baghdad
    const lecture = newId();
    const nowTs = t.ctx.clock.now();
    t.ctx.db.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES (?, 'Lecture', 'lecture', ?, ?)`, [lecture, nowTs, nowTs]);
    const plan = await ok<StudyPlanView>(
      api(t).post('/api/learning/plans', {
        title: 'Final',
        exam_date: '2026-10-20',
        source_ids: [lecture],
        available_weekdays: [0, 1, 2, 3, 4, 5, 6],
        daily_minutes: 60,
        blocked_dates: [],
        include: { learn: true, review: false, mcq: false, flashcards: false, weakness: false },
      }),
    );
    expect(plan.timezone).toBe(BAGHDAD);
    expect(plan.today).toBe('2026-10-09');
    await ok(api(t).patch('/api/settings', { timezone: 'America/Los_Angeles' }));
    const after = ((await ok(api(t).get(`/api/learning/cards/${c.id}`))).card as FlashcardView).review_state.due_at;
    expect(after).toBe(before);
    const q = await ok<CardQueueResponse>(api(t).get('/api/learning/review/queue'));
    expect(q.day).toBe('2026-10-09'); // 13:40 in Los Angeles
    const again = await ok<StudyPlanView>(api(t).get(`/api/learning/plans/${plan.id}`));
    expect(again.tasks.map((x) => x.day)).toEqual(plan.tasks.map((x) => x.day));
    expect(again.timezone).toBe(BAGHDAD);
    await jump(t, Date.UTC(2026, 9, 9, 22, 0, 0)); // 01:00 Baghdad on the 10th
    expect((await ok<StudyPlanView>(api(t).get(`/api/learning/plans/${plan.id}`))).today).toBe('2026-10-10');
  });
});
