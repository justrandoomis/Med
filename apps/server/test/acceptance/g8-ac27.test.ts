// G8 / AC-27 — learning memory (§44): «a correct answer by guessing or with the help of a hint does not raise mastery
// as an independent, confident attempt does. I can see why a recommendation was made and edit the mistake type.»
// Through the REAL HTTP routes and sync (practice exams on a G8-only question source processed by the real pipeline:
// upload → processing → extraction → matching with the Golden Set appendicitis lecture). No AI is involved.
// Adversarial paths: a client that LIES about hints / the solution (the server served them), a guessed answer given
// after a hint (more help must never earn more credit), unknown confidence, re-labelling a guess as «confident» after
// seeing the correction (exam-attempt state + sync), mistake-type edits through all three paths (learning, exams,
// sync) and after a profile reset of the mistake types, and every recommendation carrying its reason in Arabic.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MASTERY_WEIGHTS,
  masterySignal,
  type AttemptFeedbackView,
  type ExamCreateResponse,
  type ExamResultDetail,
  type ExamSessionView,
  type HomeDetail,
  type MistakeGenomeView,
  type RevisionSessionDetail,
  type SourceProgressDetail,
  type SyncPushResponse,
  type WeaknessListResponse,
} from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { api, createNode, uploadAndProcess } from '../questions/helpers';
import { acc, g8App, gold, type G8App } from './g8-helpers';

let t: G8App;
let bank: { sourceId: string; versionId: string };
let lecture: { sourceId: string; versionId: string };

beforeAll(async () => {
  t = await g8App();
  const course = (await createNode(t, 'G8 AC-27 course')).id;
  lecture = await uploadAndProcess(t, course, 'lecture_appendicitis.pdf', gold('lecture_appendicitis.pdf'), 'lecture', 'Appendicitis G8-27');
  bank = await uploadAndProcess(t, course, 'g8_key_bank.pdf', acc('g8_key_bank.pdf'), 'question_source', 'G8 Revision Bank');
  await t.ctx.jobs.drain();
}, 240_000);

afterAll(async () => {
  await t?.close();
});

// ───────── helpers ─────────
async function practice(questionIds: string[], hints: 'off' | 'progressive' = 'progressive'): Promise<ExamSessionView> {
  const res = await api(t).post('/api/exams', { title: '', mode: 'practice', count: questionIds.length, question_ids: questionIds, policy: { hints, shuffle_options: false }, seed: newId(t.clock.now()) });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as ExamCreateResponse).session;
}
function keyOf(versionId: string): string[] {
  return JSON.parse(t.ctx.db.get<{ k: string }>('SELECT correct_option_ids_json AS k FROM question_version WHERE id = ?', [versionId])!.k) as string[];
}
function itemFor(s: ExamSessionView, questionId: string) {
  const it = s.items.find((i) => i.question_id === questionId);
  if (!it) throw new Error(`question ${questionId} not in the session`);
  return it;
}
async function answer(s: ExamSessionView, questionId: string, o: { correct: boolean; confidence: 'guess' | 'unsure' | 'confident' | null; hints_used?: number; solution_viewed_before_answer?: boolean; id?: string }) {
  const item = itemFor(s, questionId);
  const key = keyOf(item.question_version_id);
  const chosen = o.correct ? key : [item.options.find((x) => !key.includes(x.id))!.id];
  t.clock.advance(5_000);
  const res = await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/${item.index}/answer`, {
    id: o.id ?? newId(t.clock.now()),
    selected_option_ids: chosen,
    confidence: o.confidence,
    hints_used: o.hints_used ?? 0,
    solution_viewed_before_answer: o.solution_viewed_before_answer ?? false,
    time_ms: 20_000,
    answered_at: t.clock.now(),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AttemptFeedbackView;
}
const row = (attemptId: string) =>
  t.ctx.db.get<{ confidence: string | null; hints_used: number; solution_viewed_before_answer: number; scored: number; is_correct: number | null; mistake_type: string | null; mistake_origin: string | null; auto_mistake_type: string | null }>(
    'SELECT confidence, hints_used, solution_viewed_before_answer, scored, is_correct, mistake_type, mistake_origin, auto_mistake_type FROM question_attempt WHERE id = ?',
    [attemptId],
  )!;
const bankQuestions = () =>
  t.ctx.db
    .all<{ question_id: string; printed_number: string }>(`SELECT question_id, printed_number FROM question_occurrence WHERE source_id = ? ORDER BY CAST(printed_number AS INTEGER)`, [bank.sourceId])
    .map((r) => r.question_id);
async function push(ops: Array<{ entity_type: string; entity_id: string; op: 'upsert' | 'append'; payload: unknown }>): Promise<SyncPushResponse> {
  const res = await api(t).post('/api/sync/push', { ops: ops.map((o) => ({ ...o, op_id: newId(t.clock.now()), device_id: 'g8-device', client_ts: t.clock.now() })) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SyncPushResponse;
}

describe('G8 AC-27 — mastery: assisted or guessed correct answers raise it less than independent confident ones', () => {
  it('the bank is real: five questions extracted with their printed keys', () => {
    expect(bankQuestions()).toHaveLength(5);
  });

  it('every kind of help is recorded by the SERVER (a client that hides a hint or the solution is not believed) and earns less', async () => {
    const [q1, q2, q3, q4, q5] = bankQuestions() as [string, string, string, string, string];
    const s = await practice([q1, q2, q3, q4, q5]);
    // q1: independent and confident
    const f1 = await answer(s, q1, { correct: true, confidence: 'confident', id: 'g8a27-q1' });
    // q2: the server served hint 1, the client claims no hint
    const i2 = itemFor(s, q2);
    expect((await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/${i2.index}/hint`, { level: 1 })).statusCode).toBe(200);
    const f2 = await answer(s, q2, { correct: true, confidence: 'confident', hints_used: 0, id: 'g8a27-q2' });
    // q3: a guess
    const f3 = await answer(s, q3, { correct: true, confidence: 'guess', id: 'g8a27-q3' });
    // q4: the solution was opened first, the client claims it was not
    const i4 = itemFor(s, q4);
    expect((await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/${i4.index}/solution`, {})).statusCode).toBe(200);
    const f4 = await answer(s, q4, { correct: true, confidence: 'confident', solution_viewed_before_answer: false, id: 'g8a27-q4' });
    // q5: a hint AND a guess — more help must never earn MORE than a plain guess
    const i5 = itemFor(s, q5);
    expect((await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/${i5.index}/hint`, { level: 1 })).statusCode).toBe(200);
    const f5 = await answer(s, q5, { correct: true, confidence: 'guess', hints_used: 0, id: 'g8a27-q5' });

    expect(row('g8a27-q2').hints_used).toBe(1);
    expect(row('g8a27-q4')).toMatchObject({ solution_viewed_before_answer: 1, scored: 0 });
    expect(f1.mastery_signal).toBe('correct_confident_independent');
    expect(f2.mastery_signal).toBe('correct_after_hint');
    expect(f3.mastery_signal).toBe('correct_guess');
    expect(f4.mastery_signal).toBe('correct_after_solution_viewed'); // and not scored at all: the solution was seen first
    expect(f4.unscored_reason_ar).toMatch(/[\u0600-\u06FF]/);
    const w = (sig: AttemptFeedbackView['mastery_signal']) => (sig ? MASTERY_WEIGHTS[sig] : 0);
    for (const f of [f2, f3, f4, f5]) expect(w(f.mastery_signal)).toBeLessThan(w(f1.mastery_signal));
    // a guess helped by a hint earns no more than a guess alone (and never more than a hint with real confidence)
    expect(w(f5.mastery_signal)).toBeLessThanOrEqual(w(f3.mastery_signal));
    expect(w(f5.mastery_signal)).toBeLessThanOrEqual(w(f2.mastery_signal));
  });

  it('the shared rule is monotone: adding help or lowering confidence never raises the weight; unknown confidence is not «confident»', () => {
    const conf = ['confident', 'unsure', null, 'guess'] as const;
    const weight = (c: (typeof conf)[number], hints: number, sol: boolean) => MASTERY_WEIGHTS[masterySignal({ is_correct: true, confidence: c, hints_used: hints, solution_viewed_before_answer: sol })!];
    for (const c of conf) {
      expect(weight(c, 1, false), `${c}: a hint never adds`).toBeLessThanOrEqual(weight(c, 0, false));
      expect(weight(c, 2, false)).toBeLessThanOrEqual(weight(c, 1, false));
      expect(weight(c, 0, true), `${c}: the solution never adds`).toBeLessThanOrEqual(weight(c, 1, false));
    }
    for (let i = 1; i < conf.length; i++) for (const h of [0, 1]) expect(weight(conf[i]!, h, false)).toBeLessThanOrEqual(weight(conf[i - 1]!, h, false));
    expect(weight(null, 0, false)).toBeLessThan(weight('confident', 0, false));
    expect(weight('confident', 0, false)).toBe(1);
  });

  it('the mastery estimate and the weakness status rise with independent answers, not with guesses or hints', async () => {
    const [q1, q2] = bankQuestions() as [string, string];
    // the bank's estimate after the mixed run above is far below an all-independent one
    const p = (await api(t).get(`/api/learning/progress/${bank.sourceId}`)).json() as SourceProgressDetail;
    expect(p.mastery_estimate).not.toBeNull();
    expect(p.mastery_estimate!).toBeLessThan(0.7);
    expect(p.mastery.basis_ar).toMatch(/[؀-ۿ]/);

    // q2: wrong, then two guessed / hint-helped correct answers → still ACTIVE; then three independent → RESOLVED
    const wrong = await practice([q2]);
    await answer(wrong, q2, { correct: false, confidence: 'confident' });
    const statusOf = async () => {
      const list = (await api(t).get('/api/learning/weakness?status=all')).json() as WeaknessListResponse;
      return list.items.find((x) => x.signal_views.some((s) => s.question_id === q2 && s.correct === false));
    };
    expect((await statusOf())?.status).toBe('active');
    for (let i = 0; i < 2; i++) await answer(await practice([q2]), q2, { correct: true, confidence: 'guess' });
    const s3 = await practice([q2]);
    await api(t).post(`/api/exams/attempts/${s3.attempt.id}/items/0/hint`, { level: 1 });
    await answer(s3, q2, { correct: true, confidence: 'confident' });
    const afterAssisted = await statusOf();
    expect(afterAssisted?.status, 'guesses and a hint do not make a weak point «improving»').toBe('active');
    expect(afterAssisted?.reasons_ar.join(' ')).toMatch(/تخمين|تلميح/);
    for (let i = 0; i < 3; i++) await answer(await practice([q2]), q2, { correct: true, confidence: 'confident' });
    expect((await statusOf())?.status).toBe('resolved');
    // q1 stays a confident independent answer; the estimate counts only scored answers
    expect(q1).toBeTruthy();
  });

  it('a guess cannot be re-labelled «confident» after the correction was seen (exam-attempt state and question-attempt sync)', async () => {
    const [, , q3] = bankQuestions() as [string, string, string];
    const s = await practice([q3]);
    const item = itemFor(s, q3);
    const f = await answer(s, q3, { correct: true, confidence: 'guess', id: 'g8a27-relabel' });
    expect(f.mastery_signal).toBe('correct_guess');
    const fresh = (await api(t).get(`/api/exams/attempts/${s.attempt.id}`)).json() as ExamSessionView;
    const a = fresh.attempt.answers[String(item.index)] ?? { attempt_id: 'g8a27-relabel', selected_option_ids: keyOf(item.question_version_id), at: t.clock.now(), submitted: true };
    t.clock.advance(60_000);
    await push([
      {
        entity_type: 'exam_attempt',
        entity_id: s.attempt.id,
        op: 'upsert',
        payload: { ...fresh.attempt, answers: { [String(item.index)]: { ...a, confidence: 'confident', submitted: true, at: t.clock.now() } } },
      },
      { entity_type: 'question_attempt', entity_id: 'g8a27-relabel', op: 'upsert', payload: { mistake_type: null, confidence: 'confident' } },
    ]);
    expect(row('g8a27-relabel').confidence).toBe('guess');
    const fb = (await api(t).get(`/api/exams/attempts/${s.attempt.id}/items/${item.index}/feedback`)).json() as AttemptFeedbackView;
    expect(fb.mastery_signal).toBe('correct_guess');
  });
});

describe('G8 AC-27 — the owner sees why a recommendation was made', () => {
  it('weakness, revision, home and exam results: every recommended item carries its reason in Arabic', async () => {
    const list = (await api(t).get('/api/learning/weakness?status=all')).json() as WeaknessListResponse;
    expect(list.items.length).toBeGreaterThan(0);
    for (const w of list.items) {
      expect(w.reasons_ar.length, w.label).toBeGreaterThan(0);
      expect(w.score_formula_ar).toContain('التخمين');
      expect(w.status_reason_ar).toMatch(/[؀-ۿ]/);
      for (const a of w.suggested_actions) expect(a.label_ar).toMatch(/[؀-ۿ]/);
      for (const s of w.signal_views) expect(s.category_label_ar).toMatch(/[؀-ۿ]/);
    }
    const rev = await api(t).post('/api/learning/revision', { minutes: 20 });
    expect(rev.statusCode, rev.body).toBe(200);
    const r = rev.json() as RevisionSessionDetail;
    expect(r.explanation_ar).toMatch(/[؀-ۿ]/);
    for (const it of r.items) expect(it.reason_ar).toMatch(/[؀-ۿ]/);
    const home = (await api(t).get('/api/learning/home')).json() as HomeDetail;
    for (const q of home.important_questions) expect(q.reason_ar).toMatch(/[؀-ۿ]/);
    // assessed results: the AC-27 signals are counted and the suggestions say why
    const [q1, q2, q3] = bankQuestions() as [string, string, string];
    const ex = await api(t).post('/api/exams', { title: '', mode: 'exam', count: 3, question_ids: [q1, q2, q3], seed: 'g8-ac27-results' });
    const session = (ex.json() as ExamCreateResponse).session;
    const answers: Record<string, unknown> = {};
    session.items.forEach((it, i) => {
      const key = keyOf(it.question_version_id);
      answers[String(i)] = { attempt_id: newId(t.clock.now() + i), selected_option_ids: i === 0 ? key : [it.options.find((o) => !key.includes(o.id))!.id], confidence: i === 0 ? 'guess' : 'confident', at: t.clock.now(), submitted: false };
    });
    t.clock.advance(60_000);
    await push([{ entity_type: 'exam_attempt', entity_id: session.attempt.id, op: 'upsert', payload: { ...session.attempt, status: 'completed', answers, finished_at: t.clock.now() } }]);
    const result = (await api(t).get(`/api/exams/attempts/${session.attempt.id}/result`)).json() as ExamResultDetail & Record<string, unknown>;
    expect(JSON.stringify(result)).toMatch(/تخمين/);
  });
});

describe('G8 AC-27 — the owner can edit the mistake type (every path, also after a reset)', () => {
  it('learning PATCH, exams PATCH and sync upsert agree: a wrong answer can be classified, a correct one cannot; the auto suggestion stays', async () => {
    const [, , , q4] = bankQuestions() as [string, string, string, string];
    const s = await practice([q4]);
    await answer(s, q4, { correct: false, confidence: 'confident', id: 'g8a27-wrong' });
    const auto = row('g8a27-wrong');
    expect(auto.mistake_origin).toBe('auto');
    expect(auto.auto_mistake_type).not.toBeNull();

    const e1 = await api(t).patch('/api/learning/mistakes/g8a27-wrong', { mistake_type: 'misread' });
    expect(e1.statusCode).toBe(200);
    expect(row('g8a27-wrong')).toMatchObject({ mistake_type: 'misread', mistake_origin: 'owner', auto_mistake_type: auto.auto_mistake_type });
    const e2 = await api(t).patch('/api/exams/question-attempts/g8a27-wrong/mistake', { mistake_type: 'concept_confusion' });
    expect(e2.statusCode).toBe(200);
    expect(row('g8a27-wrong').mistake_type).toBe('concept_confusion');
    const g = (await api(t).get('/api/learning/mistakes/genome')).json() as MistakeGenomeView;
    const rec = g.recent.find((x) => x.attempt_id === 'g8a27-wrong')!;
    expect(rec).toMatchObject({ mistake_type: 'concept_confusion', mistake_origin: 'owner', auto_mistake_type: auto.auto_mistake_type });
    expect(g.estimate_note_ar).toContain('ليس تشخيصًا');

    // a CORRECT answer is never classified as a mistake — by any of the three paths
    expect((await api(t).patch('/api/learning/mistakes/g8a27-q1', { mistake_type: 'knowledge_gap' })).statusCode).toBe(409);
    expect((await api(t).patch('/api/exams/question-attempts/g8a27-q1/mistake', { mistake_type: 'knowledge_gap' })).statusCode).toBe(409);
    const pushed = await push([{ entity_type: 'question_attempt', entity_id: 'g8a27-q1', op: 'upsert', payload: { mistake_type: 'knowledge_gap' } }]);
    expect(pushed.results[0]!.result).toBe('rejected');
    expect(row('g8a27-q1').mistake_type).toBeNull();
  });

  it('after a reset of the mistake types, a type the owner sets AGAIN on an older mistake counts (genome and weakness)', async () => {
    t.clock.advance(60_000); // the reset happens after the earlier answers (a cut-off time)
    const reset = await api(t).post('/api/learning/profile/reset', { part: 'mistake_types' });
    expect(reset.statusCode).toBe(200);
    t.clock.advance(1_000);
    let g = (await api(t).get('/api/learning/mistakes/genome')).json() as MistakeGenomeView;
    expect(g.recent.find((x) => x.attempt_id === 'g8a27-wrong')!.mistake_type).toBeNull(); // the old classification is hidden
    const e = await api(t).patch('/api/learning/mistakes/g8a27-wrong', { mistake_type: 'step_order' });
    expect(e.statusCode).toBe(200);
    g = (await api(t).get('/api/learning/mistakes/genome')).json() as MistakeGenomeView;
    expect(g.recent.find((x) => x.attempt_id === 'g8a27-wrong')).toMatchObject({ mistake_type: 'step_order', mistake_origin: 'owner' });
    expect(g.distribution.find((d) => d.type === 'step_order')!.by_owner).toBeGreaterThanOrEqual(1);
    const list = (await api(t).get('/api/learning/weakness?status=all')).json() as WeaknessListResponse;
    const sig = list.items.flatMap((w) => w.signal_views).find((s) => s.ref === 'mcq:g8a27-wrong');
    expect(sig?.mistake_type).toBe('step_order');
  });
});
