// Round 7 H4 item 5 — learning-profile resets (§44 «resettable per part») must reach every place that reads the owner's
// attempts as a SIGNAL: (a) the Question Coverage Map's «attempted» counts (an MCQ attempt before the mcq_attempts reset,
// a written attempt before the written_attempts reset, no longer marks a question «attempted»); (b) the case / OSCE /
// viva signals of the Weakness Center (a new part `case_attempts`). Attempts themselves are never deleted, and the topic
// history still lists them (history ≠ signal). Before H4: (a) counted every attempt; (b) had no reset at all.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoverageResponse, LearningProfileView, WeaknessListResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { brainApp, call, createCourse, extract, insertLecture, type BApp } from '../brain/helpers';
import { createCase, evOk, osceHistoryStation, start } from '../cases/helpers';

let t: BApp;
beforeAll(async () => {
  t = await brainApp();
});
afterAll(async () => t.close());

describe('coverage «attempted» respects the mcq_attempts / written_attempts resets', () => {
  it('an attempt older than the reset no longer marks the question attempted; a newer one does; the attempt rows stay', async () => {
    const course = (await createCourse(t, 'Reset coverage (TEST)')).id;
    const l = insertLecture(t, course, 'Gout (TEST)', [[{ kind: 'heading', text: 'Gout' }, { kind: 'paragraph', text: 'Gout is defined as a TEST crystal arthropathy.' }]]);
    await extract(t, l.sourceId);
    const q = await call(t).ok<{ question_id: string }>('POST', '/api/questions/quick-add', { text: '1. Which crystal is seen in gout (TEST)?\nA. Urate\nB. Calcium\nC. Cystine', key_label: 'A' });
    const qv = t.ctx.db.get<{ v: string }>('SELECT current_version_id AS v FROM question WHERE id = ?', [q.question_id])!.v;
    const now = t.ctx.clock.now();
    t.ctx.db.run(
      `INSERT OR REPLACE INTO question_lecture_link (id, question_id, lecture_source_id, relation, score, reason, reason_json, origin, status, created_at, updated_at)
       VALUES (?, ?, ?, 'directly_covered', 1, 'TEST', ?, 'owner', 'accepted', ?, ?)`,
      [newId(now), q.question_id, l.sourceId, JSON.stringify({ lecture_page_ids: [l.pageIds[0]] }), now, now],
    );
    const attempt = (at: number) =>
      t.ctx.db.run(`INSERT INTO question_attempt (id, question_id, question_version_id, is_correct, scored, answered_at, created_at) VALUES (?, ?, ?, 1, 1, ?, ?)`, [newId(at), q.question_id, qv, at, at]);
    attempt(now - 60_000);
    const cov = async () => (await call(t).ok<CoverageResponse>('GET', `/api/brain/coverage?source_id=${l.sourceId}`)).lectures[0]!;
    let c = await cov();
    expect(c.totals.questions.attempted_source).toBe(1);
    expect(c.pages[0]!.attempted_question_ids).toEqual([q.question_id]);
    // reset the MCQ signal: the old attempt is history, not a signal
    t.clock.advance(1000);
    expect((await call(t).post('/api/learning/profile/reset', { part: 'mcq_attempts' })).statusCode).toBe(200);
    c = await cov();
    expect(c.totals.questions.attempted_source).toBe(0);
    expect(c.pages[0]!.attempted_question_ids).toEqual([]);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM question_attempt WHERE question_id = ?', [q.question_id])!.n).toBe(1);
    // a new attempt after the reset counts again
    t.clock.advance(1000);
    attempt(t.ctx.clock.now());
    c = await cov();
    expect(c.totals.questions.attempted_source).toBe(1);
    // written attempts follow their own part
    t.clock.advance(1000);
    expect((await call(t).post('/api/learning/profile/reset', { part: 'mcq_attempts' })).statusCode).toBe(200);
    t.ctx.db.run(`INSERT INTO written_attempt (id, question_id, question_version_id, answer_text, answered_at, created_at) VALUES (?, ?, ?, 'TEST', ?, ?)`, [
      newId(t.ctx.clock.now()),
      q.question_id,
      qv,
      t.ctx.clock.now() - 10,
      t.ctx.clock.now() - 10,
    ]);
    expect((await cov()).totals.questions.attempted_source).toBe(1);
    t.clock.advance(1000);
    expect((await call(t).post('/api/learning/profile/reset', { part: 'written_attempts' })).statusCode).toBe(200);
    expect((await cov()).totals.questions.attempted_source).toBe(0);
  });
});

describe('case / OSCE / viva signals respect a «case_attempts» reset', () => {
  it('after the reset, completed OSCE attempts before it are not weakness signals (the attempts stay); new ones are', async () => {
    const osce = await createCase(t, t.h, osceHistoryStation());
    let run = await start(t, t.h, osce.id);
    run = await evOk(t, t.h, run.attempt.id, { type: 'utterance', text: 'متى بدأ الألم؟' });
    await evOk(t, t.h, run.attempt.id, { type: 'finish' });
    const caseItems = async () => (await call(t).ok<WeaknessListResponse>('GET', '/api/learning/weakness?status=all')).items.filter((i) => i.kind === 'case' && i.status !== 'resolved');
    expect((await caseItems()).length).toBeGreaterThanOrEqual(1);

    t.clock.advance(1000);
    const res = await call(t).post('/api/learning/profile/reset', { part: 'case_attempts' });
    expect(res.statusCode, res.body).toBe(200);
    const profile = res.json() as LearningProfileView;
    const part = profile.signals.find((s) => s.part === 'case_attempts')!;
    expect(part).toMatchObject({ count: 0 });
    expect(part.label_ar).toContain('الحالات');
    expect(part.reset_at).toBe(t.ctx.clock.now());
    expect(await caseItems()).toEqual([]);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM case_attempt WHERE case_id = ? AND status = 'completed'`, [osce.id])!.n).toBe(1);

    // a new completed attempt after the reset is a signal again
    t.clock.advance(1000);
    let r2 = await start(t, t.h, osce.id);
    r2 = await evOk(t, t.h, r2.attempt.id, { type: 'utterance', text: 'هل عندك غثيان؟' });
    await evOk(t, t.h, r2.attempt.id, { type: 'finish' });
    const after = await caseItems();
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after.flatMap((i) => i.signal_views).every((s) => s.ref.includes(r2.attempt.id))).toBe(true);
    const p2 = await call(t).ok<LearningProfileView>('GET', '/api/learning/profile');
    expect(p2.signals.find((s) => s.part === 'case_attempts')!.count).toBe(1);
  });
});
