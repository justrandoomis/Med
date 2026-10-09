// Practice & exams on the Golden Set through the REAL pipeline (question sources + lecture processed, extracted and
// matched): builder (AC-14, AC-17, lecture-only answerable, option order), delivery without leaks (AC-19, media
// names), attempts via sync (idempotent, pinned versions, AC-26), policy immutability, timer/pause, hints and
// confidence signals (AC-27 data), mistake types (auto + owner edit), results with denominators, history.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AttemptFeedbackView,
  ExamAttemptDTO,
  ExamAttemptListResponse,
  ExamResultDetail,
  ExamSessionView,
  HintResponse,
  QuestionAttemptDTO,
} from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { createQuestion } from '../../src/modules/questions/service';
import { api, createExam, createExamApp, push, questionAt, type ExamApp } from './helpers';

let t: ExamApp;
const q = (sec: string, n: string, src: 'qs' | 'prev' = 'qs') => questionAt(t, t[src].sourceId, sec, n);

beforeAll(async () => {
  t = await createExamApp();
}, 300_000);

afterAll(async () => {
  await t?.close();
});

const session = async (attemptId: string): Promise<ExamSessionView> => {
  const res = await api(t).get(`/api/exams/attempts/${attemptId}`);
  expect(res.statusCode).toBe(200);
  return res.json() as ExamSessionView;
};

function stateOf(s: ExamSessionView, patch: Partial<ExamAttemptDTO> = {}) {
  const a = { ...s.attempt, ...patch };
  return { status: a.status, elapsed_ms: a.elapsed_ms, current_index: a.current_index, answers: a.answers, flagged: a.flagged, timer: a.timer };
}

describe('builder (§39, AC-14, AC-17)', () => {
  it('AC-17: a question that appears in two files is ONE item (both occurrences kept)', async () => {
    const a1 = q('A', '1');
    expect(q('', '1', 'prev')).toBe(a1);
    const r = await createExam(t, { mode: 'exam', count: 50, source_ids: [t.qs.sourceId, t.prev.sourceId], seed: 's1' });
    const ids = r.session.items.map((i) => i.question_id);
    expect(ids.filter((x) => x === a1)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    const fb = r.session.exam.build!;
    expect(fb.selected).toBe(ids.length);
    // the vault keeps both places it appeared
    const detail = (await api(t).get(`/api/questions/${a1}`)).json().question;
    expect(detail.occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('AC-17: confirmed duplicates (two different questions) never both appear', async () => {
    const a2 = q('A', '2');
    const p2 = q('', '2', 'prev');
    expect(a2).not.toBe(p2);
    const dup = t.ctx.db.get<{ id: string }>('SELECT id FROM question_duplicate WHERE (question_a_id = ? AND question_b_id = ?) OR (question_a_id = ? AND question_b_id = ?)', [a2, p2, p2, a2]);
    if (dup) {
      const res = await api(t).post(`/api/questions/duplicates/${dup.id}/decision`, { status: 'confirmed', reason: 'test' });
      expect(res.statusCode).toBe(200);
    } else {
      t.ctx.db.run(`INSERT INTO question_duplicate (id, question_a_id, question_b_id, kind, similarity, status, created_at) VALUES (?, ?, ?, 'near', 0.9, 'confirmed', ?)`, [newId(), a2, p2, t.ctx.clock.now()]);
    }
    const r = await createExam(t, { mode: 'practice', count: 50, question_ids: [a2, p2], seed: 'dup' });
    expect(r.session.items).toHaveLength(1);
    expect(r.session.exam.build!.duplicates_removed).toBe(1);
    expect(r.session.exam.build!.exclusions.find((e) => e.code === 'duplicate')?.count).toBe(1);
    // restore: other tests use A2 and P2 independently
    t.ctx.db.run(`UPDATE question_duplicate SET status = 'rejected' WHERE (question_a_id = ? AND question_b_id = ?) OR (question_a_id = ? AND question_b_id = ?)`, [a2, p2, p2, a2]);
  });

  it('AC-14: an unresolved key is never in an assessed exam; in practice it is visible and unscored with its reason', async () => {
    const b3 = q('B', '3');
    const preview = (await api(t).post('/api/exams/preview', { title: '', mode: 'exam', count: 50, source_ids: [t.qs.sourceId] })).json().report;
    expect(preview.exclusions.find((e: { code: string }) => e.code === 'unscorable').question_ids).toContain(b3);
    const exam = await createExam(t, { mode: 'exam', count: 50, source_ids: [t.qs.sourceId] });
    expect(exam.session.items.map((i) => i.question_id)).not.toContain(b3);
    expect(exam.session.items.every((i) => i.scored)).toBe(true);
    const practice = await createExam(t, { mode: 'practice', count: 50, question_ids: [b3] });
    const item = practice.session.items[0]!;
    expect(item.scored).toBe(false);
    expect(practice.session.unscored_reasons['0']).toMatch(/مفتاح|غير محسوب|التدريب/);
    // answering it is recorded but never scored
    const fb = (await api(t).post(`/api/exams/attempts/${practice.session.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [item.options[0]!.id], confidence: 'confident', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb.scored).toBe(false);
    expect(fb.is_correct).toBeNull();
    expect(fb.correct_option_ids).toBeNull();
    expect(fb.unscored_reason_ar).toBeTruthy();
    expect(fb.suggested_mistake_type).toBeNull();
  });

  it('nothing matching → 409 with the build report (no empty exam)', async () => {
    const res = await api(t).post('/api/exams', { title: '', mode: 'exam', count: 5, question_ids: [q('B', '3')] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.report.exclusions[0].code).toBe('unscorable');
  });

  it('«من محاضرتي فقط» uses the answerable flag of the lecture links', async () => {
    const answerable = t.ctx.db.all<{ question_id: string }>(
      `SELECT question_id FROM question_lecture_link WHERE lecture_source_id = ? AND answerable_from_lecture = 1 AND status <> 'rejected'`,
      [t.lecture.sourceId],
    ).map((r) => r.question_id);
    expect(answerable.length).toBeGreaterThan(0);
    const r = await createExam(t, { mode: 'practice', count: 50, source_ids: [t.lecture.sourceId], lecture_only_answerable: true });
    expect(r.session.items.length).toBeGreaterThan(0);
    for (const i of r.session.items) expect(answerable).toContain(i.question_id);
    expect(r.session.items.map((i) => i.question_id)).not.toContain(q('B', '1'));
  });

  it('option order: stable ids, shuffle only when allowed, «all of the above» never shuffled, deterministic by seed', async () => {
    const pinned = createQuestion(t.ctx, {
      origin: 'owner',
      qtype: 'sba',
      stem: 'Which of the following features belong to the Alvarado score components?',
      options: [{ text: 'Anorexia' }, { text: 'Nausea' }, { text: 'Rebound tenderness' }, { text: 'Leukocytosis' }, { text: 'All of the above', pinned_position: true }],
      correctOptionIndexes: [4],
      answerStatus: 'owner_key',
    });
    const free = createQuestion(t.ctx, {
      origin: 'owner',
      qtype: 'sba',
      stem: 'Which investigation is first-line imaging in children with suspected appendicitis?',
      options: [{ text: 'Ultrasound' }, { text: 'CT abdomen' }, { text: 'MRI pelvis' }, { text: 'Plain X-ray' }],
      correctOptionIndexes: [0],
      answerStatus: 'owner_key',
    });
    const optIds = (vid: string) => t.ctx.db.all<{ id: string }>('SELECT id FROM question_option WHERE question_version_id = ? ORDER BY ord', [vid]).map((o) => o.id);
    const orders = new Set<string>();
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const r = await createExam(t, { mode: 'exam', count: 2, question_ids: [pinned.questionId, free.questionId], seed });
      const p = r.session.items.find((i) => i.question_id === pinned.questionId)!;
      const f = r.session.items.find((i) => i.question_id === free.questionId)!;
      // «All of the above» depends on the order: the whole question keeps its source order
      expect(p.options.map((o) => o.id)).toEqual(optIds(pinned.versionId));
      expect(p.options.map((o) => o.display_label)).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect([...f.options.map((o) => o.id)].sort()).toEqual([...optIds(free.versionId)].sort());
      orders.add(f.options.map((o) => o.id).join(','));
      // same seed → same order
      const again = await createExam(t, { mode: 'exam', count: 2, question_ids: [pinned.questionId, free.questionId], seed });
      expect(again.session.items.find((i) => i.question_id === free.questionId)!.options.map((o) => o.id)).toEqual(f.options.map((o) => o.id));
    }
    expect(orders.size).toBeGreaterThan(1);
    // practice keeps the source order unless shuffling is asked for
    const pr = await createExam(t, { mode: 'practice', count: 1, question_ids: [free.questionId] });
    expect(pr.session.items[0]!.options.map((o) => o.id)).toEqual(optIds(free.versionId));
  });

  it('Arabic option labels are delivered as Arabic display labels', async () => {
    const r = await createExam(t, { mode: 'practice', count: 1, question_ids: [q('B', '3')] });
    expect(r.session.items[0]!.options.map((o) => o.display_label)).toEqual(['أ', 'ب', 'ج', 'د']);
  });

  it('create is idempotent by the client attempt id', async () => {
    const attempt_id = newId();
    const a = await createExam(t, { mode: 'practice', count: 3, source_ids: [t.qs.sourceId], attempt_id });
    const b = await createExam(t, { mode: 'practice', count: 3, source_ids: [t.qs.sourceId], attempt_id });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.session.exam.id).toBe(a.session.exam.id);
  });
});

describe('delivery without leaks (AC-19)', () => {
  it('items carry no key, explanation, source, section, page, link reason or evidence', async () => {
    const r = await createExam(t, { mode: 'exam', count: 50, source_ids: [t.qs.sourceId, t.prev.sourceId, t.lecture.sourceId] });
    const allowed = ['index', 'question_id', 'question_version_id', 'qtype', 'stem', 'options', 'has_negation', 'negation_terms', 'media', 'scored'];
    for (const item of r.session.items) {
      expect(Object.keys(item).sort()).toEqual([...allowed].sort());
      for (const o of item.options) expect(Object.keys(o).sort()).toEqual(['display_label', 'id', 'text']);
    }
    const body = JSON.stringify(r.session.items);
    for (const leak of ['correct_option', 'explanation', 'distractor', 'answer_status', 'source_key', 'Section A', 'Abdominal pain', 'Surgery Course 1 Questions', 'Previous exam', 'lecture', 'reason', 'evidence', 'claim', 'region', 'page_id', 'source_label', 'occurrence']) {
      expect(body, leak).not.toContain(leak);
    }
    // NOT / EXCEPT are flagged for emphasis
    const a2 = r.session.items.find((i) => i.question_id === q('A', '2'))!;
    expect(a2.has_negation).toBe(true);
    expect(a2.negation_terms).toContain('NOT');
    // solutions are not available during the exam
    expect((await api(t).get(`/api/exams/attempts/${r.session.attempt.id}/items/0/feedback`)).statusCode).toBe(409);
    expect((await api(t).post(`/api/exams/attempts/${r.session.attempt.id}/items/0/solution`)).statusCode).toBe(409);
    expect((await api(t).get(`/api/exams/attempts/${r.session.attempt.id}/result`)).statusCode).toBe(409);
    expect((await api(t).post(`/api/exams/attempts/${r.session.attempt.id}/items/0/hint`, { level: 1 })).statusCode).toBe(409);
  });

  it('media: short-lived token, neutral alt text, no file name in the payload or the response headers', async () => {
    const a4 = q('A', '4');
    // attach a figure whose FILE NAME reveals the answer to A4's occurrence (as a figure region of its page)
    const region = t.ctx.db.get<{ id: string; page_id: string; version_id: string }>(
      `SELECT r.id, r.page_id, r.version_id FROM source_region r WHERE r.version_id = ? ORDER BY r.reading_order LIMIT 1`,
      [t.qs.versionId],
    )!;
    const file = await t.ctx.files.put(Buffer.from('89504e470d0a1a0a', 'hex'), { mime: 'image/png', originalName: 'answer_B_supports_but_does_not_confirm.png' });
    t.ctx.db.run(
      `INSERT INTO image_asset (id, file_id, source_id, version_id, page_id, region_id, origin, image_kind, title, caption, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'source', 'diagram', 'Answer B', 'Answer: B', ?)`,
      [newId(), file.id, t.qs.sourceId, region.version_id, region.page_id, region.id, t.ctx.clock.now()],
    );
    const occ = t.ctx.db.get<{ id: string; parse_json: string }>('SELECT id, parse_json FROM question_occurrence WHERE question_id = ? AND source_id = ?', [a4, t.qs.sourceId])!;
    const parse = JSON.parse(occ.parse_json);
    t.ctx.db.run('UPDATE question_occurrence SET parse_json = ? WHERE id = ?', [JSON.stringify({ ...parse, figure_region_ids: [region.id] }), occ.id]);
    try {
      const r = await createExam(t, { mode: 'practice', count: 1, question_ids: [a4] });
      const item = r.session.items[0]!;
      expect(item.media).toHaveLength(1);
      expect(item.media[0]!.alt_ar).toBe('الصورة 1 المرفقة بالسؤال');
      const s = JSON.stringify(r.session);
      expect(s).not.toContain('answer_B');
      expect(s).not.toContain('Answer: B');
      expect(s).not.toContain(file.id);
      expect(r.session.media_expires_at).toBeGreaterThan(t.ctx.clock.now());
      const img = await t.app.inject({ method: 'GET', url: item.media[0]!.token_url, headers: t.h });
      expect(img.statusCode).toBe(200);
      expect(String(img.headers['content-disposition'])).toBe('inline');
      expect(JSON.stringify(img.headers)).not.toContain('answer_B');
      // a forged / expired token is refused
      expect((await t.app.inject({ method: 'GET', url: `${item.media[0]!.token_url}x`, headers: t.h })).statusCode).toBe(403);
      t.clock.advance(3 * 60 * 60 * 1000);
      expect((await t.app.inject({ method: 'GET', url: item.media[0]!.token_url, headers: t.h })).statusCode).toBe(403);
      // reopening refreshes the token
      const again = await session(r.session.attempt.id);
      expect((await t.app.inject({ method: 'GET', url: again.items[0]!.media[0]!.token_url, headers: t.h })).statusCode).toBe(200);
    } finally {
      t.ctx.db.run('UPDATE question_occurrence SET parse_json = ? WHERE id = ?', [occ.parse_json, occ.id]);
    }
  });
});

describe('attempts (sync) — idempotent, pinned, never re-graded (AC-26)', () => {
  it('question_attempt append is idempotent and graded once against the pinned version', async () => {
    const a1 = q('A', '1');
    const r = await createExam(t, { mode: 'practice', count: 1, question_ids: [a1] });
    const item = r.session.items[0]!;
    const right = item.options.find((o) => JSON.stringify(o.text).includes("McBurney"))!;
    const id = newId();
    const payload = { question_id: a1, question_version_id: item.question_version_id, exam_attempt_id: r.session.attempt.id, exam_item_index: 0, selected_option_ids: [right.id], confidence: 'confident', answered_at: t.ctx.clock.now() };
    const op_id = newId();
    const first = await push(t, [{ entity_type: 'question_attempt', entity_id: id, op: 'append', payload, op_id }]);
    expect(first[0]!.result).toBe('applied');
    expect((first[0]!.entity as QuestionAttemptDTO).is_correct).toBe(true);
    expect((first[0]!.entity as QuestionAttemptDTO).scored).toBe(true);
    // same op again → duplicate; same entity with a new op id → duplicate (insert-if-absent)
    expect((await push(t, [{ entity_type: 'question_attempt', entity_id: id, op: 'append', payload, op_id }]))[0]!.result).toBe('duplicate');
    expect((await push(t, [{ entity_type: 'question_attempt', entity_id: id, op: 'append', payload: { ...payload, selected_option_ids: [item.options[0]!.id] } }]))[0]!.result).toBe('duplicate');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM question_attempt WHERE id = ?', [id])!.n).toBe(1);
    // a second, different answer to the same item is kept apart (rejected), never replaces the first
    const other = await push(t, [{ entity_type: 'question_attempt', entity_id: newId(), op: 'append', payload: { ...payload, selected_option_ids: [item.options[0]!.id] } }]);
    expect(other[0]!.result).toBe('rejected');
    // Dexie rows are camelCase: accepted too
    const camel = await push(t, [
      { entity_type: 'question_attempt', entity_id: newId(), op: 'append', payload: { questionId: a1, questionVersionId: item.question_version_id, selectedOptionIds: [right.id], confidence: 'guess', answeredAt: t.ctx.clock.now() } },
    ]);
    expect(camel[0]!.result).toBe('applied');
    expect((camel[0]!.entity as QuestionAttemptDTO).confidence).toBe('guess');
    // an option of another version is refused
    const bad = await push(t, [{ entity_type: 'question_attempt', entity_id: newId(), op: 'append', payload: { ...payload, exam_attempt_id: null, exam_item_index: null, selected_option_ids: ['not-an-option'] } }]);
    expect(bad[0]!.result).toBe('rejected');
    // deleting attempts is refused
    expect((await push(t, [{ entity_type: 'question_attempt', entity_id: id, op: 'delete', payload: null }]))[0]!.result).toBe('rejected');
  });

  it('AC-26: a key correction after the attempt keeps the attempt result and reports the newer key', async () => {
    const a4 = q('A', '4');
    const r = await createExam(t, { mode: 'practice', count: 1, question_ids: [a4] });
    const item = r.session.items[0]!;
    const right = item.options.find((o) => JSON.stringify(o.text).includes('Supports but does not confirm'))!;
    const fb1 = (await api(t).post(`/api/exams/attempts/${r.session.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [right.id], confidence: 'confident', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb1.is_correct).toBe(true);
    // the owner changes the key to another option → new version (the attempted one is locked)
    const before = (await api(t).get(`/api/questions/${a4}`)).json().question.current;
    const other = before.options.find((o: { id: string }) => o.id !== right.id)!;
    const key = await api(t).post(`/api/questions/${a4}/key`, { option_keys: [other.option_key], reason: 'test correction' });
    expect(key.statusCode).toBe(200);
    const after = (await api(t).get(`/api/questions/${a4}`)).json().question.current;
    expect(after.id).not.toBe(item.question_version_id);
    // the attempt keeps its version and its result
    const row = t.ctx.db.get<{ is_correct: number; question_version_id: string }>('SELECT is_correct, question_version_id FROM question_attempt WHERE id = ?', [fb1.attempt!.id])!;
    expect(row.is_correct).toBe(1);
    expect(row.question_version_id).toBe(item.question_version_id);
    const fb2 = (await api(t).get(`/api/exams/attempts/${r.session.attempt.id}/items/0/feedback`)).json() as AttemptFeedbackView;
    expect(fb2.is_correct).toBe(true);
    expect(fb2.correct_option_ids).toEqual([right.id]);
    expect(fb2.newer_version_note_ar).toMatch(/لم يُعَد تقييمها/);
    // a NEW exam pins the new version
    const r2 = await createExam(t, { mode: 'practice', count: 1, question_ids: [a4] });
    expect(r2.session.items[0]!.question_version_id).toBe(after.id);
  });
});

describe('exam attempt state: policy fixed, timer, pause, resume, finishing', () => {
  it('policy is fixed at creation: pause refused in an exam, a policy in the payload is ignored', async () => {
    const r = await createExam(t, { mode: 'exam', count: 3, source_ids: [t.qs.sourceId], minutes: 10 });
    expect(r.session.exam.policy).toMatchObject({ hints: 'off', show_solution: 'at_end', pause_allowed: false, total_seconds: 600 });
    const policyBefore = r.session.exam.policy;
    const paused = await push(t, [{ entity_type: 'exam_attempt', entity_id: r.session.attempt.id, op: 'upsert', payload: { ...stateOf(r.session, { status: 'paused' }), policy: { pause_allowed: true, hints: 'progressive' } } }]);
    expect(paused[0]!.result).toBe('rejected');
    expect(paused[0]!.detail).toMatch(/ثابتة/);
    // a policy smuggled into a normal state update changes nothing
    const smuggled = await push(t, [{ entity_type: 'exam_attempt', entity_id: r.session.attempt.id, op: 'upsert', payload: { ...stateOf(r.session, { current_index: 1 }), policy: { pause_allowed: true, hints: 'progressive', show_solution: 'after_each' } } }]);
    expect(smuggled[0]!.result).toBe('applied');
    expect((await session(r.session.attempt.id)).exam.policy).toEqual(policyBefore);
    // hints can never be switched on for an assessed exam, even at creation
    const withHints = await createExam(t, { mode: 'exam', count: 1, source_ids: [t.qs.sourceId], policy: { hints: 'progressive', pause_allowed: true } });
    expect(withHints.session.exam.policy.hints).toBe('off');
    expect(withHints.session.exam.policy.pause_allowed).toBe(true); // chosen at creation, then fixed
    const tp = await createExam(t, { mode: 'time_pressure', count: 2, source_ids: [t.qs.sourceId], per_question_seconds: 30, policy: { pause_allowed: true } });
    expect(tp.session.exam.policy.pause_allowed).toBe(false);
    expect(tp.session.exam.policy.per_question_seconds).toBe(30);
    const p2 = await push(t, [{ entity_type: 'exam_attempt', entity_id: tp.session.attempt.id, op: 'upsert', payload: stateOf(tp.session, { status: 'paused' }) }]);
    expect(p2[0]!.result).toBe('rejected');
    expect((await session(tp.session.attempt.id)).attempt.status).toBe('in_progress');
  });

  it('practice: pause allowed, timer never decreases, answers merge per item, resume after reload', async () => {
    const r = await createExam(t, { mode: 'practice', count: 3, source_ids: [t.qs.sourceId] });
    const s = r.session;
    const ans = (i: number, at: number) => ({ attempt_id: newId(), selected_option_ids: [s.items[i]!.options[0]!.id], confidence: 'unsure' as const, at, time_ms: 4000, hints_used: 0, solution_viewed_before_answer: false, submitted: false });
    t.clock.advance(60_000);
    const up1 = await push(t, [{ entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: stateOf(s, { status: 'paused', elapsed_ms: 50_000, current_index: 1, answers: { '0': ans(0, t.ctx.clock.now()) }, flagged: [1], timer: { item_ms: { '0': 30_000, '1': 20_000 }, pauses: 1, paused_at: t.ctx.clock.now() } }) }]);
    expect(up1[0]!.result).toBe('applied');
    // an older device copy with less time and without answer 0 never removes the answer or the time
    const up2 = await push(t, [{ entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: stateOf(s, { status: 'in_progress', elapsed_ms: 10_000, current_index: 2, answers: { '2': ans(2, t.ctx.clock.now()) }, flagged: [], timer: { item_ms: { '2': 5_000 }, pauses: 0, paused_at: null } }) }]);
    expect(up2[0]!.result).toBe('merged');
    const resumed = await session(s.attempt.id);
    expect(resumed.attempt.elapsed_ms).toBe(50_000);
    expect(Object.keys(resumed.attempt.answers).sort()).toEqual(['0', '2']);
    expect(resumed.attempt.timer.item_ms['0']).toBe(30_000);
    expect(resumed.attempt.timer.pauses).toBe(1);
    expect(resumed.attempt.current_index).toBe(2);
    // impossible time (more than the wall clock since start) is capped
    await push(t, [{ entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: stateOf(resumed, { elapsed_ms: 10 * 3600_000 }) }]);
    expect((await session(s.attempt.id)).attempt.elapsed_ms).toBeLessThanOrEqual(t.ctx.clock.now() - s.attempt.started_at + 60_000);
    // an option of another question is dropped, never stored
    const bad = await push(t, [{ entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: stateOf(resumed, { answers: { '1': { ...ans(1, t.ctx.clock.now()), selected_option_ids: [s.items[0]!.options[0]!.id] } } }) }]);
    expect(bad[0]!.detail).toMatch(/أُهملت/);
  });

  it('exam: answers change until finishing; finishing materializes one attempt per answered item; result after finishing; then immutable', async () => {
    const r = await createExam(t, { mode: 'exam', count: 4, question_ids: [q('A', '1'), q('A', '2'), q('A', '3'), q('B', '1')], seed: 'fin' });
    const s = r.session;
    const optWith = (i: number, txt: string) => s.items[i]!.options.find((o) => JSON.stringify(o.text).includes(txt))!.id;
    const idx = (qid: string) => s.items.findIndex((i) => i.question_id === qid);
    const i1 = idx(q('A', '1'));
    const i2 = idx(q('A', '2'));
    const i3 = idx(q('A', '3'));
    const now = t.ctx.clock.now();
    const answers: Record<string, unknown> = {
      [i1]: { attempt_id: newId(), selected_option_ids: [optWith(i1, "Murphy's point")], confidence: 'unsure', at: now, time_ms: 1000, hints_used: 0, solution_viewed_before_answer: false, submitted: false },
      [i2]: { attempt_id: newId(), selected_option_ids: [optWith(i2, 'Anorexia')], confidence: 'confident', at: now, time_ms: 1000, hints_used: 0, solution_viewed_before_answer: false, submitted: false },
      [i3]: { attempt_id: newId(), selected_option_ids: [optWith(i3, 'Pregnancy test')], confidence: 'guess', at: now, time_ms: 1000, hints_used: 0, solution_viewed_before_answer: false, submitted: false },
    };
    await push(t, [{ entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: stateOf(s, { answers: answers as never }) }]);
    // a direct per-question append during the exam is refused (graded only when the attempt is finished, AC-19)
    const early = await push(t, [{ entity_type: 'question_attempt', entity_id: newId(), op: 'append', payload: { question_id: q('A', '1'), question_version_id: s.items[i1]!.question_version_id, exam_attempt_id: s.attempt.id, exam_item_index: i1, selected_option_ids: [optWith(i1, "McBurney's point")], answered_at: now } }]);
    expect(early[0]!.result).toBe('rejected');
    expect(early[0]!.entity).toBeUndefined();
    // the owner changes the answer of A1 before finishing (newer timestamp wins for that item)
    t.clock.advance(5_000);
    const changed = { ...(answers[i1] as object), selected_option_ids: [optWith(i1, "McBurney's point")], at: t.ctx.clock.now() };
    const fin = await push(t, [{ entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: stateOf(s, { status: 'completed', answers: { ...answers, [i1]: changed } as never, elapsed_ms: 4000, finished_at: t.ctx.clock.now() }) }]);
    expect(fin[0]!.result).toBe('applied');
    const rows = t.ctx.db.all<{ exam_item_index: number; is_correct: number | null; confidence: string; mistake_type: string | null; mistake_origin: string | null }>(
      'SELECT exam_item_index, is_correct, confidence, mistake_type, mistake_origin FROM question_attempt WHERE exam_attempt_id = ? ORDER BY exam_item_index',
      [s.attempt.id],
    );
    expect(rows).toHaveLength(3);
    const byIdx = new Map(rows.map((x) => [x.exam_item_index, x]));
    expect(byIdx.get(i1)!.is_correct).toBe(1);
    // NOT question answered with a TRUE statement (Anorexia IS part of the score) → misread suggestion
    expect(byIdx.get(i2)!.is_correct).toBe(0);
    expect(byIdx.get(i2)!.mistake_type).toBe('misread');
    expect(byIdx.get(i2)!.mistake_origin).toBe('auto');
    expect(byIdx.get(i3)!.is_correct).toBe(1);
    // finishing again (lost response retried) → duplicate; any later change → rejected
    expect((await push(t, [{ entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: stateOf(s, { status: 'completed', answers: { ...answers, [i1]: changed } as never }) }]))[0]!.result).toBe('duplicate');
    expect((await push(t, [{ entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: stateOf(s, { status: 'in_progress' }) }]))[0]!.result).toBe('rejected');

    const res = (await api(t).get(`/api/exams/attempts/${s.attempt.id}/result`)).json() as ExamResultDetail;
    expect(res.total_items).toBe(4);
    expect(res.scored_items).toBe(4);
    expect(res.correct).toBe(2);
    expect(res.accuracy).toBe(0.5);
    expect(res.answered).toBe(3);
    expect(res.unanswered).toBe(1);
    expect(res.denominator_note_ar).toContain('4 أسئلة');
    expect(res.signals.correct_guess).toBe(1);
    expect(res.signals.confident_wrong).toBe(1);
    expect(res.items.find((i) => i.index === i3)!.mastery_signal).toBe('correct_guess');
    expect(res.by_lecture.reduce((a, l) => a + l.total, 0)).toBe(4);
    expect(res.suggested_review.some((x) => x.kind === 'retry_question')).toBe(true);
    // solutions and evidence after finishing
    const fb = (await api(t).get(`/api/exams/attempts/${s.attempt.id}/items/${i2}/feedback`)).json() as AttemptFeedbackView;
    expect(fb.correct_option_ids).toEqual([optWith(i2, 'Serum amylase')]);
    expect(fb.occurrences.length).toBeGreaterThan(0);
    expect(fb.origin_label_ar).toMatch(/سؤال من مصدر الأسئلة/);
    expect(fb.suggested_mistake_type).toBe('misread');
  });

  it('time pressure: over-budget answers are flagged as a suggestion only', async () => {
    const r = await createExam(t, { mode: 'time_pressure', count: 1, question_ids: [q('B', '1')], per_question_seconds: 20 });
    const s = r.session;
    const wrong = s.items[0]!.options.find((o) => JSON.stringify(o.text).includes('Psoas'))!.id;
    await push(t, [
      {
        entity_type: 'exam_attempt',
        entity_id: s.attempt.id,
        op: 'upsert',
        payload: stateOf(s, { status: 'completed', answers: { '0': { attempt_id: newId(), selected_option_ids: [wrong], confidence: 'unsure', at: t.ctx.clock.now(), time_ms: 45_000, hints_used: 0, solution_viewed_before_answer: false, submitted: false } } as never }),
      },
    ]);
    const res = (await api(t).get(`/api/exams/attempts/${s.attempt.id}/result`)).json() as ExamResultDetail;
    expect(res.items[0]!.over_time_budget).toBe(true);
    expect(res.items[0]!.mistake_type).toBe('time_pressure');
    expect(res.items[0]!.mistake_origin).toBe('auto');
    expect(res.time!.note_ar).toMatch(/لا يعني/);
    const qa = t.ctx.db.get<{ auto_mistake_reason: string }>('SELECT auto_mistake_reason FROM question_attempt WHERE exam_attempt_id = ?', [s.attempt.id])!;
    expect(qa.auto_mistake_reason).toMatch(/قد يكون ضغط الوقت عاملًا، وقد لا يكون/);
  });
});

describe('practice: hints, solution, confidence, mistake types (AC-27 data)', () => {
  it('progressive hints are recorded; hint-assisted / guessed answers are not independent mastery', async () => {
    const r = await createExam(t, { mode: 'practice', count: 2, question_ids: [q('A', '3'), q('A', '1')], seed: 'h' });
    const s = r.session;
    const iA3 = s.items.findIndex((i) => i.question_id === q('A', '3'));
    const iA1 = 1 - iA3;
    const base = `/api/exams/attempts/${s.attempt.id}/items/${iA3}`;
    expect((await api(t).post(`${base}/hint`, { level: 2 })).statusCode).toBe(409);
    const h1 = (await api(t).post(`${base}/hint`, { level: 1 })).json() as HintResponse;
    expect(h1.hint.level).toBe(1);
    // hint 1 points where to look and never names the answer
    expect(h1.hint.text_ar).not.toMatch(/β-hCG|Pregnancy test/i);
    const h2 = (await api(t).post(`${base}/hint`, { level: 2 })).json() as HintResponse;
    expect(h2.hint.level).toBe(2);
    expect(h2.hint.clues.map((c) => c.text)).toEqual(expect.arrayContaining(['30-year-old']));
    expect(JSON.stringify(h2.hint.stem)).toContain('"marks":["b"]');
    // the client claims no hints: the server keeps what it served
    const right = s.items[iA3]!.options.find((o) => JSON.stringify(o.text).includes('Pregnancy test'))!.id;
    const fb = (await api(t).post(`${base}/answer`, { id: newId(), selected_option_ids: [right], confidence: 'confident', hints_used: 0, answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb.is_correct).toBe(true);
    expect(fb.attempt!.hints_used).toBe(2);
    expect(fb.mastery_signal).toBe('correct_after_hint');
    expect(fb.explanation === null || typeof fb.explanation === 'object').toBe(true);
    expect(fb.lecture_links.length).toBeGreaterThan(0);
    // a guessed correct answer
    const rightA1 = s.items[iA1]!.options.find((o) => JSON.stringify(o.text).includes("McBurney"))!.id;
    const fbA1 = (await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/${iA1}/answer`, { id: newId(), selected_option_ids: [rightA1], confidence: 'guess', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fbA1.mastery_signal).toBe('correct_guess');
    expect(fbA1.attempt!.confidence).toBe('guess');
    // first answer stays: a second answer to the same item does not replace it
    const again = (await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/${iA1}/answer`, { id: newId(), selected_option_ids: [s.items[iA1]!.options[0]!.id], confidence: 'confident', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(again.attempt!.id).toBe(fbA1.attempt!.id);
  });

  it('solution viewed before answering is recorded and not scored; Anti-shortcut refuses it before an answer', async () => {
    const r = await createExam(t, { mode: 'practice', count: 1, question_ids: [q('B', '1')] });
    const base = `/api/exams/attempts/${r.session.attempt.id}/items/0`;
    expect((await api(t).get(`${base}/feedback`)).statusCode).toBe(409);
    const sol = (await api(t).post(`${base}/solution`)).json() as AttemptFeedbackView;
    expect(sol.correct_option_ids).toHaveLength(1);
    expect(sol.attempt).toBeNull();
    const fb = (await api(t).post(`${base}/answer`, { id: newId(), selected_option_ids: sol.correct_option_ids!, confidence: 'confident', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb.attempt!.solution_viewed_before_answer).toBe(true);
    expect(fb.scored).toBe(false);
    expect(fb.mastery_signal).toBe('correct_after_solution_viewed');

    const anti = await createExam(t, { mode: 'practice', count: 1, question_ids: [q('B', '1')], policy: { anti_shortcut: true } });
    expect(anti.session.exam.policy.anti_shortcut).toBe(true);
    const res = await api(t).post(`/api/exams/attempts/${anti.session.attempt.id}/items/0/solution`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/منع الاختصار/);
  });

  it('mistake type: auto suggestion for a confident wrong answer, editable by the owner (HTTP and sync), auto kept', async () => {
    const r = await createExam(t, { mode: 'practice', count: 1, question_ids: [q('B', '1')] });
    const wrong = r.session.items[0]!.options.find((o) => JSON.stringify(o.text).includes('Rovsing'))!.id;
    const fb = (await api(t).post(`/api/exams/attempts/${r.session.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [wrong], confidence: 'confident', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb.is_correct).toBe(false);
    expect(['misunderstanding', 'concept_confusion']).toContain(fb.suggested_mistake_type);
    expect(fb.attempt!.mistake_origin).toBe('auto');
    expect(fb.mistake_reason_ar).toMatch(/اقتراح آلي/);
    const edited = (await api(t).patch(`/api/exams/question-attempts/${fb.attempt!.id}/mistake`, { mistake_type: 'knowledge_gap' })).json().attempt as QuestionAttemptDTO;
    expect(edited.mistake_type).toBe('knowledge_gap');
    expect(edited.mistake_origin).toBe('owner');
    expect(edited.auto_mistake_type).toBe(fb.suggested_mistake_type);
    const viaSync = await push(t, [{ entity_type: 'question_attempt', entity_id: fb.attempt!.id, op: 'upsert', payload: { mistake_type: 'concept_confusion' } }]);
    expect(viaSync[0]!.result).toBe('applied');
    expect((viaSync[0]!.entity as QuestionAttemptDTO).mistake_type).toBe('concept_confusion');
    // the answer itself never changes through an upsert
    const row = t.ctx.db.get<{ selected_option_ids_json: string; is_correct: number }>('SELECT selected_option_ids_json, is_correct FROM question_attempt WHERE id = ?', [fb.attempt!.id])!;
    expect(JSON.parse(row.selected_option_ids_json)).toEqual([wrong]);
    expect(row.is_correct).toBe(0);
    expect((await api(t).patch(`/api/exams/question-attempts/${fb.attempt!.id}/mistake`, { mistake_type: 'bogus' })).statusCode).toBe(400);
  });
});

describe('history, validation, auth', () => {
  it('attempt history newest first; scores hidden for unfinished assessed exams', async () => {
    const res = (await api(t).get('/api/exams/attempts?limit=100')).json() as ExamAttemptListResponse;
    expect(res.items.length).toBeGreaterThan(5);
    const started = res.items.map((i) => i.started_at);
    expect([...started].sort((a, b) => b - a)).toEqual(started);
    for (const i of res.items) if ((i.mode === 'exam' || i.mode === 'time_pressure') && i.status !== 'completed') expect(i.correct).toBeNull();
    const page = (await api(t).get('/api/exams/attempts?limit=2')).json() as ExamAttemptListResponse;
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBe('2');
  });

  it('validation errors in Arabic; unknown attempt 404; auth required; CSRF required', async () => {
    const v = await api(t).post('/api/exams', { title: '', mode: 'party', count: 0 });
    expect(v.statusCode).toBe(400);
    expect(v.json().error.code).toBe('VALIDATION_FAILED');
    expect((await api(t).get('/api/exams/attempts/nope')).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/exams/attempts' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/exams', headers: { cookie: t.h.cookie }, payload: { mode: 'practice', count: 1 } })).statusCode).toBe(403);
  });

  it('capabilities: exams available; AI features honest without a provider', async () => {
    const caps = (await api(t).get('/api/capabilities')).json();
    expect(caps.features.exams.state).toBe('available');
    expect(caps.features['ai.generate_questions'].state).toBe('requires_configuration');
    expect(caps.features['ai.grade_written'].state).toBe('requires_configuration');
    const gen = await api(t).post('/api/exams/generate', { lecture_source_id: t.lecture.sourceId, topic: 'appendicitis', count: 1, difficulty: 'hard' });
    expect(gen.statusCode).toBe(409);
    expect(gen.json().error.code).toBe('AI_NOT_CONFIGURED');
  });
});
