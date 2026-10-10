// Local FSRS parity (§43, AC-23, AC-24): the web fold gives EXACTLY the server's schedule for the same events.
// The fixture (fixtures/srs-parity.json) is produced by the SERVER's fold (apps/server/src/modules/learning/srs.ts,
// regenerate with fixtures/make-srs-fixture.ts): learning steps, lapses + relearning, duplicate ids, same-ms ties,
// relearn markers, another desired retention and a long history.
import { describe, expect, it } from 'vitest';
import type { ReviewRating, SrsConfigView, SrsParams } from '@medlevo/shared';
import { checkParity, foldReviews, intervalLabelAr, previewIntervals, stateOf, type FoldEvent } from '../../src/features/review/local/srs';
import fixture from './fixtures/srs-parity.json';

interface FixtureCase {
  name: string;
  retention: number;
  created_at: number;
  events: FoldEvent[];
  resets: number[];
  at: number;
  params: SrsParams;
  expected: { state: string; due_at: number; stability: number | null; difficulty: number | null; reps: number; lapses: number; last_review_at: number | null; retrievability: number | null };
  preview: Record<string, number>;
  event_count: number;
  first_review_at: number | null;
}
const cases = (fixture as { cases: FixtureCase[] }).cases;

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe('local FSRS fold = server fold (fixture from the server algorithm)', () => {
  it('has the cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(7);
    expect((fixture as { library: string }).library).toMatch(/ts-fsrs v5\.4\.2/);
  });

  for (const c of cases) {
    it(`same state, due time and button previews: ${c.name}`, () => {
      const fold = foldReviews(c.params, c.created_at, c.events, c.resets);
      const v = stateOf(c.params, fold, c.at);
      expect(v.state).toBe(c.expected.state);
      expect(v.due_at).toBe(c.expected.due_at);
      expect(v.reps).toBe(c.expected.reps);
      expect(v.lapses).toBe(c.expected.lapses);
      expect(v.last_review_at).toBe(c.expected.last_review_at);
      expect(v.stability).toBe(c.expected.stability);
      expect(v.difficulty).toBe(c.expected.difficulty);
      if (c.expected.retrievability === null) expect(v.retrievability).toBeNull();
      else expect(v.retrievability).toBeCloseTo(c.expected.retrievability, 12);
      expect(fold.eventCount).toBe(c.event_count);
      expect(fold.firstReviewAt).toBe(c.first_review_at);
      const prev = previewIntervals(c.params, fold.card, c.at);
      for (const r of [1, 2, 3, 4] as ReviewRating[]) expect(prev[r]).toBe(c.preview[String(r)]);
    });

    it(`arrival order never changes the schedule: ${c.name}`, () => {
      const base = stateOf(c.params, foldReviews(c.params, c.created_at, c.events, c.resets), c.at);
      for (let seed = 1; seed <= 12; seed++) {
        const v = stateOf(c.params, foldReviews(c.params, c.created_at, shuffled(c.events, seed), shuffled(c.resets, seed + 7)), c.at);
        expect(v).toEqual(base);
      }
    });
  }

  it('a re-sent event (same id) is folded once', () => {
    const c = cases.find((x) => x.events.length >= 3)!;
    const once = stateOf(c.params, foldReviews(c.params, c.created_at, c.events, c.resets), c.at);
    const twice = stateOf(c.params, foldReviews(c.params, c.created_at, [...c.events, ...c.events], c.resets), c.at);
    expect(twice).toEqual(once);
  });
});

describe('parity check against the live server sample (GET /srs-config)', () => {
  const c = cases.find((x) => x.name === 'lapse and relearning')!;
  const cfg: Pick<SrsConfigView, 'params' | 'parity_check'> = {
    params: c.params,
    parity_check: { created_at: c.created_at, events: c.events, resets: c.resets, at: c.at, expected: c.expected as SrsConfigView['parity_check']['expected'] },
  };
  it('passes when the device fold reproduces the server sample', () => {
    expect(checkParity(cfg)).toEqual({ ok: true, mismatches: [] });
  });
  it('fails (and names the fields) when the server folds differently — the device then does not schedule on its own', () => {
    const bad = { ...cfg, parity_check: { ...cfg.parity_check, expected: { ...cfg.parity_check.expected, due_at: cfg.parity_check.expected.due_at + 60_000, reps: 99 } } };
    const r = checkParity(bad);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual(expect.arrayContaining(['due_at', 'reps']));
  });
  it('different params (another desired retention) are detected', () => {
    const other = cases.find((x) => x.retention !== c.retention)!;
    expect(checkParity({ ...cfg, params: other.params }).ok).toBe(false);
  });
});

describe('interval labels (same wording as the server buttons)', () => {
  it('Arabic plural forms', () => {
    expect(intervalLabelAr(60_000)).toBe('بعد دقيقة');
    expect(intervalLabelAr(10 * 60_000)).toBe('بعد 10 دقائق');
    expect(intervalLabelAr(2 * 86_400_000)).toBe('بعد يومين');
    expect(intervalLabelAr(15 * 86_400_000)).toBe('بعد 15 يومًا');
    expect(intervalLabelAr(400 * 86_400_000)).toBe('بعد سنة');
  });
});
