// G4 / AC-14 — a question WITHOUT a key: saved and shown as a SOURCE question; any generated solution is called an
// «AI-derived Answer» and carries its evidence; it never enters assessed scoring while the answer is not confirmed.
// REAL pipeline on the Golden Set (questions_surgery_course1.pdf: B3 is printed without a key, Arabic labels;
// lecture_cholecystitis.pdf: «Ultrasound is the first-line investigation for suspected gallstones») + the answer check
// added by this round (before it, NO path could give a keyless source question an evidence-backed solution — the
// questions module listed «AI-derived answers» as not done). The AI is the TEST-ONLY scripted provider: no API key exists
// here, so a real model's judgement is not exercised (see docs/ACCEPTANCE.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { richTextToPlain, type AttemptFeedbackView, type ExamCreateResponse, type ExamResultDetail, type QuestionVersionView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { listForExam } from '../../src/modules/questions/service';
import { api, createNode, detail, golden, listAll, questionAt, uploadAndProcess, type QApp } from '../questions/helpers';
import { answerCheck, appWith, ScriptedAi, solveWith, stateOf, verdicts } from './g4-helpers';

const plain = (rt: Parameters<typeof richTextToPlain>[0]) => richTextToPlain(rt);
const GALL = 'Ultrasound is the first-line investigation for suspected gallstones.';

const ai = new ScriptedAi();
let t: QApp;
let noAi: QApp;
let qs: { sourceId: string; versionId: string };
let b3: string;
let noAiB3: string;
let course: string;

beforeAll(async () => {
  t = await appWith(ai);
  course = (await createNode(t, 'Surgery Course 1')).id;
  qs = await uploadAndProcess(t, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Surgery Course 1 Questions');
  await uploadAndProcess(t, course, 'lecture_cholecystitis.pdf', golden('lecture_cholecystitis.pdf'), 'lecture', 'Acute Cholecystitis (TEST FIXTURE)');
  b3 = questionAt(t, qs.sourceId, 'B', '3');
  // the same library on a server WITHOUT any AI provider (the real deployment here: no key)
  noAi = await appWith(null);
  const c2 = (await createNode(noAi, 'Surgery Course 1')).id;
  const qs2 = await uploadAndProcess(noAi, c2, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Surgery Course 1 Questions');
  noAiB3 = questionAt(noAi, qs2.sourceId, 'B', '3');
  await uploadAndProcess(noAi, c2, 'lecture_cholecystitis.pdf', golden('lecture_cholecystitis.pdf'), 'lecture', 'Acute Cholecystitis (TEST FIXTURE)');
}, 300_000);
afterAll(async () => {
  await t?.close();
  await noAi?.close();
});

const versionsOf = (app: QApp, qid: string) => app.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM question_version WHERE question_id = ?', [qid])!.n;

describe('G4 AC-14 — a question without a key', () => {
  it('is saved and shown as a SOURCE question (origin, page, number, Arabic labels) with «no key», unscored', async () => {
    const item = (await listAll(t, `source_id=${qs.sourceId}`)).find((i) => i.id === b3)!;
    expect(item.origin_type).toBe('source');
    expect(item.answer_status).toBe('missing_key');
    expect(item.scorable).toBe(false);
    const d = await detail(t, b3);
    expect(d.question.occurrences[0]!.origin_label_ar).toBe('سؤال من مصدر الأسئلة — Surgery Course 1 Questions — ص 2 — رقم السؤال 3 (Section B)');
    expect(d.question.current.options.map((o) => o.source_label)).toEqual(['أ', 'ب', 'ج', 'د']);
    expect(d.question.current.correct_option_ids).toBeNull();
    expect(d.unscorable_reason_ar).toContain('لا يوجد مفتاح');
    expect(d.question.status).toBe('ready'); // its TEXT is fine; only the key is missing (separate statuses)
  });

  it('never enters an assessed exam; practice shows it unscored; answering it changes no score and no mastery', async () => {
    const preview = (await api(t).post('/api/exams/preview', { title: '', mode: 'exam', count: 50, source_ids: [qs.sourceId] })).json().report;
    expect(preview.exclusions.find((e: { code: string }) => e.code === 'unscorable').question_ids).toContain(b3);
    for (const mode of ['exam', 'time_pressure', 'simulation'] as const) {
      const r = await api(t).post('/api/exams', { title: '', mode, count: 50, source_ids: [qs.sourceId], per_question_seconds: mode === 'time_pressure' ? 60 : undefined });
      expect(r.statusCode, mode).toBe(200);
      expect((r.json() as ExamCreateResponse).session.items.map((i) => i.question_id), mode).not.toContain(b3);
    }
    const s = ((await api(t).post('/api/exams', { title: '', mode: 'practice', count: 1, question_ids: [b3] })).json() as ExamCreateResponse).session;
    expect(s.items[0]!.scored).toBe(false);
    const fb = (await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [s.items[0]!.options[0]!.id], confidence: 'confident', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb.scored).toBe(false);
    expect(fb.is_correct).toBeNull();
    expect(fb.correct_option_ids).toBeNull();
    expect(fb.unscored_reason_ar).toBeTruthy();
    expect(fb.origin_label_ar).toContain('سؤال من مصدر الأسئلة');
    const row = t.ctx.db.get<{ scored: number; is_correct: number | null }>('SELECT scored, is_correct FROM question_attempt WHERE id = ?', [fb.attempt!.id])!;
    expect(row).toEqual({ scored: 0, is_correct: null });
    // a practice result never counts it in the denominator
    await api(t).post('/api/sync/push', { ops: [{ op_id: newId(), device_id: 'd1', client_ts: t.ctx.clock.now(), entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: stateOf(s, { status: 'completed', finished_at: t.ctx.clock.now() }) }] });
    const res = (await api(t).get(`/api/exams/attempts/${s.attempt.id}/result`)).json() as ExamResultDetail;
    expect(res.scored_items).toBe(0);
    expect(res.accuracy).toBeNull();
    expect(res.unscored_reasons.map((u) => u.question_id)).toContain(b3);
  });

  it('without an AI provider the answer check is refused honestly (409, requires_configuration) and nothing changes', async () => {
    const id = noAiB3;
    const before = versionsOf(noAi, id);
    const cap = (await noAi.app.inject({ method: 'GET', url: '/api/capabilities', headers: noAi.h })).json().features['ai.answer_check'];
    expect(cap.state).toBe('requires_configuration');
    expect(cap.reason_ar).toMatch(/ANTHROPIC_API_KEY/);
    const r = await answerCheck(noAi, id);
    expect(r.status).toBe(409);
    expect(r.body.error!.code).toBe('AI_NOT_CONFIGURED');
    expect(versionsOf(noAi, id)).toBe(before);
    expect((await detail(noAi, id)).question.current.answer_status).toBe('missing_key');
  });

  it('an UNCONFIRMED derivation (the verifier does not confirm the support) is recorded as unresolved: no answer, still unscored', async () => {
    ai.on('validate_question', solveWith('Ultrasound', 'suspected gallstones', GALL)).on('verify_support', verdicts('not_supported'));
    const before = versionsOf(t, b3);
    const r = await answerCheck(t, b3);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.check.outcome).toBe('unresolved');
    expect(r.body.check.chosen_option_key).toBeNull();
    expect(r.body.check.reason_ar).toMatch(/لا يُعتمد جواب غير مؤكد/);
    expect(r.body.new_version_id).toBeNull();
    expect(versionsOf(t, b3)).toBe(before);
    const d = await detail(t, b3);
    expect(d.question.current.answer_status).toBe('missing_key');
    expect(d.scorable).toBe(false);
    expect(d.question.current.key_details?.answer_check?.outcome).toBe('unresolved');
  });

  it('two defensible options / a model abstention → unresolved / abstained, nothing derived', async () => {
    ai.on('validate_question', (req) => ({ ...solveWith('Ultrasound', 'suspected gallstones', GALL)(req), defensible_options: ['A', 'B'] })).on('verify_support', verdicts('supported'));
    expect((await answerCheck(t, b3)).body.check.outcome).toBe('unresolved');
    ai.on('validate_question', () => ({ abstain: { reason: 'insufficient_evidence', detail: 'لا يكفي' }, chosen_option: null, defensible_options: [], answerable_from_evidence: false, support: [] }));
    const r = await answerCheck(t, b3);
    expect(r.body.check.outcome).toBe('abstained');
    expect((await detail(t, b3)).question.current.answer_status).toBe('missing_key');
  });

  it('a VERIFIED derivation is an «AI-derived Answer» with its evidence — a new version; the source question and its «no key» state stay visible', async () => {
    ai.on('validate_question', solveWith('Ultrasound', 'suspected gallstones', GALL)).on('verify_support', verdicts('supported'));
    const prev = (await detail(t, b3)).question.current;
    const r = await answerCheck(t, b3);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = r.body.check;
    expect(c.outcome).toBe('derived');
    expect(c.reason_ar).toContain('AI-derived Answer');
    expect(c.reason_ar).toContain('لا يوجد مفتاح في المصدر');
    expect(c.key_status).toBe('missing_key');
    expect(r.body.new_version_id).toBeTruthy();
    // its evidence: a linked claim citing the lecture page, from the Source-Locked lecture only
    expect(c.claim_ids.length).toBeGreaterThan(0);
    const claim = r.body.claims[c.claim_ids[0]!]!;
    expect(claim.verification_status).toBe('linked');
    expect(claim.citations[0]!.evidence.quote).toContain('Ultrasound is the first-line investigation for suspected gallstones');
    expect(c.scope_describe_ar).toBeTruthy();
    const d = await detail(t, b3);
    const v = d.question.current;
    expect(v.id).toBe(r.body.new_version_id);
    expect(v.answer_status).toBe('ai_derived');
    expect(v.created_by).toBe('generation');
    expect(v.options.filter((o) => v.correct_option_ids?.includes(o.id)).map((o) => [o.source_label, plain(o.text)])).toEqual([['أ', 'Ultrasound']]);
    expect(v.key_details?.notes_ar).toContain('AI-derived');
    expect(d.answer_check_claims?.[c.claim_ids[0]!]?.verification_status).toBe('linked');
    expect(d.question.origin_type).toBe('source'); // still the source question, never relabelled
    expect(d.question.occurrences[0]!.origin_label_ar).toContain('سؤال من مصدر الأسئلة');
    // the version that was checked stays as printed: no key
    const old = d.versions.find((x) => x.id === prev.id) as QuestionVersionView;
    expect(old.answer_status).toBe('missing_key');
    expect(old.correct_option_ids).toBeNull();
    // answer evidence rows exist for the derived version
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM answer_evidence WHERE question_version_id = ? AND role = 'supports_answer'`, [v.id])!.n).toBeGreaterThan(0);
    // the solver was never told a key (there is none) and saw only the locked lecture's evidence
    const prompt = ai.callsFor('validate_question').at(-1)!.prompt;
    expect(prompt).toContain('suspected gallstones');
    expect(prompt).not.toMatch(/McBurney|Alvarado/); // nothing from another source
  });

  it('the verified AI-derived answer is the ONLY way a keyless question becomes scorable; it is labelled AI-derived wherever it is graded', async () => {
    expect(listForExam(t.ctx, { sourceIds: [qs.sourceId], onlyScorable: true }).map((c) => c.question_id)).toContain(b3);
    const s = ((await api(t).post('/api/exams', { title: '', mode: 'practice', count: 1, question_ids: [b3] })).json() as ExamCreateResponse).session;
    const us = s.items[0]!.options.find((o) => plain(o.text) === 'Ultrasound')!;
    const fb = (await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [us.id], confidence: 'confident', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb.is_correct).toBe(true);
    expect(fb.answer_status_label_ar).toBe('حل مولد من الأدلة (AI-derived)');
  });
});
