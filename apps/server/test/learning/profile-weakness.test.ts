// AC-27 mastery weighting (unit), learning profile (GET / PATCH / reset per part — data never deleted), and auth +
// CSRF on every learning route.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MASTERY_WEIGHTS, type LearningProfileView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { masteryEstimate } from '../../src/modules/learning/progress';
import { scoreSignals } from '../../src/modules/learning/weakness';
import { CSRF } from '../helpers/app';
import { api, createLearningApp, ok, type LApp } from './helpers';

describe('AC-27: guessed / hint-assisted correct answers count less than confident independent ones', () => {
  const att = (is_correct: boolean, confidence: 'guess' | 'unsure' | 'confident' | null, hints = 0, solution = false) => ({ is_correct, confidence, hints_used: hints, solution_viewed_before_answer: solution });

  it('mastery estimate', () => {
    const confident = masteryEstimate([att(true, 'confident'), att(true, 'confident'), att(true, 'confident')]);
    const guessed = masteryEstimate([att(true, 'guess'), att(true, 'guess'), att(true, 'guess')]);
    const hinted = masteryEstimate([att(true, 'confident', 1), att(true, 'confident', 2), att(true, 'confident', 1)]);
    const unknownConfidence = masteryEstimate([att(true, null), att(true, null), att(true, null)]);
    const solution = masteryEstimate([att(true, 'confident', 0, true), att(true, 'confident', 0, true), att(true, 'confident', 0, true)]);
    expect(confident.value).toBe(1);
    expect(guessed.value).toBe(MASTERY_WEIGHTS.correct_guess);
    expect(hinted.value).toBe(MASTERY_WEIGHTS.correct_after_hint);
    expect(unknownConfidence.value).toBe(MASTERY_WEIGHTS.correct_unsure); // unknown confidence is never «confident»
    expect(solution.value).toBe(0);
    expect(guessed.value!).toBeLessThan(confident.value!);
    expect(hinted.value!).toBeLessThan(confident.value!);
    expect(masteryEstimate([att(true, 'confident'), att(false, 'confident')]).value).toBeNull(); // sample too small
    expect(masteryEstimate([att(true, 'confident'), att(false, 'confident'), att(false, 'guess')]).value).toBe(0);
  });

  it('weakness score: the same mistakes weigh more when the correct answers were only guesses', () => {
    const wrong = { correct: false, weight: MASTERY_WEIGHTS.wrong, category: 'wrong' };
    const withConfident = scoreSignals([wrong, { correct: true, weight: 1, category: 'correct_confident_independent' }]);
    const withGuess = scoreSignals([wrong, { correct: true, weight: MASTERY_WEIGHTS.correct_guess, category: 'correct_guess' }]);
    const withHint = scoreSignals([wrong, { correct: true, weight: MASTERY_WEIGHTS.correct_after_hint, category: 'correct_after_hint' }]);
    expect(withGuess.score).toBeGreaterThan(withHint.score);
    expect(withHint.score).toBeGreaterThan(withConfident.score);
    expect(withConfident.score).toBe(Math.round((0.6 / 1.6) * 100) / 100);
    expect(withGuess.correctAssisted).toBe(1);
    expect(withConfident.correctIndependent).toBe(1);
    // unscored signals never enter the score
    const ns = scoreSignals([wrong, { correct: null, weight: null, category: null }]);
    expect(ns.notScored).toBe(1);
    expect(ns.score).toBe(1);
  });
});

describe('learning profile', () => {
  let t: LApp;
  beforeEach(async () => {
    t = await createLearningApp();
  });
  afterEach(async () => t.close());

  it('GET / PATCH: preferences go to owner settings, subjects and pace to the profile; facts note', async () => {
    const p0 = await ok<LearningProfileView>(api(t).get('/api/learning/profile'));
    expect(p0.preferences).toEqual({ explanation_level: 'medium', dialect: 'fusha_simple', socratic: false });
    expect(p0.facts_note_ar).toMatch(/لا يغيّران الحقائق الطبية/);
    expect(p0.used_signals_ar[0]).toMatch(/لا توجد بيانات/);
    const p1 = await ok<LearningProfileView>(
      api(t).patch('/api/learning/profile', { self_level: 'سنة رابعة', subjects_studied: ['Surgery', 'Surgery', ' Medicine '], preferences: { explanation_level: 'simple', socratic: true }, pace_minutes_per_day: 120 }),
    );
    expect(p1.self_level).toBe('سنة رابعة');
    expect(p1.subjects_studied).toEqual(['Surgery', 'Medicine']);
    expect(p1.preferences).toEqual({ explanation_level: 'simple', dialect: 'fusha_simple', socratic: true });
    expect(p1.pace_minutes_per_day).toBe(120);
    expect((await ok(api(t).get('/api/settings'))).settings.explanation_level).toBe('simple');
    expect(p1.used_signals_ar[0]).toMatch(/سنة رابعة/);
    expect((await api(t).patch('/api/learning/profile', { preferences: { explanation_level: 'genius' } })).statusCode).toBe(400);
    expect((await api(t).patch('/api/learning/profile', { unknown: 1 })).statusCode).toBe(400);
  });

  it('reset of a signal part hides older signals from personalisation, the reviews themselves stay', async () => {
    const c = (await ok(api(t).post('/api/learning/cards', { kind: 'basic', front: 'Q', back: 'A' }))).cards[0];
    for (let i = 0; i < 6; i++) await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: c.id, rating: 3, reviewed_at: t.ctx.clock.now() - i * 60_000, duration_ms: 20_000 }));
    let p = await ok<LearningProfileView>(api(t).get('/api/learning/profile'));
    expect(p.signals.find((s) => s.part === 'card_reviews')!.count).toBe(6);
    expect(p.measured_pace.median_seconds_per_card).toBe(20);
    t.clock.advance(1000);
    p = await ok<LearningProfileView>(api(t).post('/api/learning/profile/reset', { part: 'card_reviews' }));
    expect(p.signals.find((s) => s.part === 'card_reviews')!.count).toBe(0);
    expect(p.signals.find((s) => s.part === 'card_reviews')!.reset_at).toBe(t.ctx.clock.now());
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event')!.n).toBe(6);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE action = 'reset_signals'`)!.n).toBe(1);
    expect((await api(t).post('/api/learning/profile/reset', { part: 'everything' })).statusCode).toBe(400);
  });

  it('capabilities report the learning features as available', async () => {
    const caps = await ok(api(t).get('/api/capabilities'));
    for (const k of ['flashcards', 'weakness', 'planner', 'exam_dna', 'export.anki_tsv']) expect(caps.features[k].state).toBe('available');
  });
});

describe('auth and CSRF on every learning route', () => {
  let t: LApp;
  beforeEach(async () => {
    t = await createLearningApp();
  });
  afterEach(async () => t.close());

  const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string]> = [
    ['GET', '/api/learning/srs-config'],
    ['POST', '/api/learning/srs/rebuild'],
    ['GET', '/api/learning/cards'],
    ['POST', '/api/learning/cards'],
    ['POST', '/api/learning/cards/from-selection'],
    ['POST', '/api/learning/cards/from-mistake'],
    ['POST', '/api/learning/cards/occlusion'],
    ['GET', '/api/learning/cards/duplicates'],
    ['POST', '/api/learning/cards/duplicates/decide'],
    ['GET', '/api/learning/cards/X1'],
    ['PATCH', '/api/learning/cards/X1'],
    ['DELETE', '/api/learning/cards/X1'],
    ['POST', '/api/learning/cards/X1/restore'],
    ['POST', '/api/learning/cards/X1/suspend'],
    ['POST', '/api/learning/cards/X1/bury'],
    ['POST', '/api/learning/cards/X1/unbury'],
    ['POST', '/api/learning/cards/X1/impact/resolve'],
    ['GET', '/api/learning/cards/X1/review'],
    ['GET', '/api/learning/review/queue'],
    ['POST', '/api/learning/reviews'],
    ['GET', '/api/learning/media/abcdefghijklmnop'],
    ['GET', '/api/learning/export/anki'],
    ['GET', '/api/learning/forecast'],
    ['GET', '/api/learning/weakness'],
    ['GET', '/api/learning/weakness/X1'],
    ['PATCH', '/api/learning/weakness/X1'],
    ['POST', '/api/learning/weakness/X1/revision'],
    ['GET', '/api/learning/mistakes/genome'],
    ['PATCH', '/api/learning/mistakes/X1'],
    ['GET', '/api/learning/reasoning/X1'],
    ['GET', '/api/learning/profile'],
    ['PATCH', '/api/learning/profile'],
    ['POST', '/api/learning/profile/reset'],
    ['GET', '/api/learning/plans'],
    ['POST', '/api/learning/plans'],
    ['POST', '/api/learning/plans/preview'],
    ['GET', '/api/learning/plans/X1'],
    ['POST', '/api/learning/plans/X1/rebalance'],
    ['PATCH', '/api/learning/plans/X1/tasks/X2'],
    ['POST', '/api/learning/plans/X1/archive'],
    ['POST', '/api/learning/revision'],
    ['GET', '/api/learning/revision/X1'],
    ['GET', '/api/learning/home'],
    ['GET', '/api/learning/exam-dna'],
    ['GET', '/api/learning/exam-dna/relevance'],
    ['GET', '/api/learning/progress'],
    ['GET', '/api/learning/progress/X1'],
  ];

  it('401 without a session on every route', async () => {
    for (const [method, url] of routes) {
      const r = await t.app.inject({ method, url, headers: { ...CSRF }, payload: method === 'GET' ? undefined : {} });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('403 for a write without the CSRF header, even with a session', async () => {
    for (const [method, url] of routes.filter(([m]) => m !== 'GET')) {
      const r = await t.app.inject({ method, url, headers: { cookie: t.h.cookie }, payload: {} });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('404 / 400 with a session (no stack traces)', async () => {
    const r = await api(t).get('/api/learning/cards/NOPE');
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toMatch(/at .*\.ts/);
    expect((await api(t).get('/api/learning/weakness/NOPE')).statusCode).toBe(404);
    expect((await api(t).get('/api/learning/reasoning/NOPE')).statusCode).toBe(404);
    expect((await api(t).get('/api/learning/exam-dna/relevance')).statusCode).toBe(400);
    expect((await api(t).post('/api/learning/revision', { minutes: 1 })).statusCode).toBe(400);
    expect((await api(t).get('/api/learning/review/queue?limit=9999')).statusCode).toBe(400);
  });
});
