// G4 / AC-15 — a key that conflicts with the material: the conflict is SHOWN, the original is KEPT, and neither the
// record nor past results are corrected silently. Two realistic paths, both on the REAL pipeline:
//   A. key vs MATERIAL (the AC's own wording): g4_wrong_key.pdf prints key A («Murphy's point») for «to which point does
//      the pain classically migrate?», while the course lecture (lecture_appendicitis.pdf) says it migrates to «the right
//      iliac fossa (McBurney's point)». Before this round nothing compared a printed key with the lecture (the schema had an
//      `answer_evidence.contradicts_key` role that nothing wrote) — the answer check (questions/answercheck.ts) was added.
//      AI = TEST-ONLY scripted solver + verifier (no key exists here).
//   B. key vs KEY arriving LATER (deterministic, no AI): the golden A1 (key B) is answered in an exam; then another source
//      prints the same question with key C (g4_a1_other_key.pdf).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { richTextToPlain, type AttemptFeedbackView, type ExamCreateResponse, type ExamResultDetail, type ExamSessionView, type QuestionMutationResponse, type ReviewQueueResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { listForExam } from '../../src/modules/questions/service';
import { api, correctTexts, createNode, detail, golden, questionAt, uploadAndProcess, type QApp } from '../questions/helpers';
import { acceptanceFixture, answerCheck, appWith, ScriptedAi, solveWith, stateOf, verdicts } from './g4-helpers';

const plain = (rt: Parameters<typeof richTextToPlain>[0]) => richTextToPlain(rt);
const MIGRATES = "Pain usually begins in the periumbilical region and later migrates to the right iliac fossa (McBurney's point).";

const ai = new ScriptedAi();
let t: QApp;
let course: string;
let wrong: { sourceId: string; versionId: string };
let golden1: { sourceId: string; versionId: string };
let q1: string;
let checkedVersion: string;
let practiceAttempt: { examAttemptId: string; questionAttemptId: string };

beforeAll(async () => {
  t = await appWith(ai);
  course = (await createNode(t, 'Surgery Course 1')).id;
  golden1 = await uploadAndProcess(t, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Surgery Course 1 Questions');
  wrong = await uploadAndProcess(t, course, 'g4_wrong_key.pdf', acceptanceFixture('g4_wrong_key.pdf'), 'question_source', 'G4 key check bank');
  await uploadAndProcess(t, course, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Acute Appendicitis (TEST FIXTURE)');
  q1 = questionAt(t, wrong.sourceId, '', '1');
}, 300_000);
afterAll(async () => {
  await t?.close();
});

async function practice(questionId: string): Promise<ExamSessionView> {
  const r = await api(t).post('/api/exams', { title: '', mode: 'practice', count: 1, question_ids: [questionId] });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as ExamCreateResponse).session;
}
async function answer(s: ExamSessionView, optionText: string): Promise<AttemptFeedbackView> {
  const opt = s.items[0]!.options.find((o) => plain(o.text) === optionText)!;
  const res = await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [opt.id], confidence: 'confident', answered_at: t.ctx.clock.now() });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AttemptFeedbackView;
}
async function finishAndResult(s: ExamSessionView): Promise<ExamResultDetail> {
  await api(t).post('/api/sync/push', { ops: [{ op_id: newId(), device_id: 'd1', client_ts: t.ctx.clock.now(), entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: stateOf(s, { status: 'completed', finished_at: t.ctx.clock.now() }) }] });
  return (await api(t).get(`/api/exams/attempts/${s.attempt.id}/result`)).json() as ExamResultDetail;
}

describe('G4 AC-15 A — the printed key contradicts the lecture', () => {
  it('premise: the printed key A is bound as the source key, the question is scorable, and the owner answered A (graded correct)', async () => {
    const d = await detail(t, q1);
    expect(d.question.current.answer_status).toBe('source_key');
    expect(correctTexts(d.question)).toEqual(["Murphy's point"]);
    expect(d.scorable).toBe(true);
    expect(d.question.lecture_links.length).toBeGreaterThan(0);
    checkedVersion = d.question.current.id;
    const s = await practice(q1);
    const fb = await answer(s, "Murphy's point");
    expect(fb.is_correct).toBe(true);
    practiceAttempt = { examAttemptId: s.attempt.id, questionAttemptId: fb.attempt!.id };
    const res = await finishAndResult(s);
    expect(res.correct).toBe(1);
    expect(res.scored_items).toBe(1);
  });

  it('a check the verifier does NOT confirm changes nothing (no conflict claimed on weak evidence)', async () => {
    ai.on('validate_question', solveWith("McBurney's point", 'migrates to the right iliac fossa', MIGRATES)).on('verify_support', verdicts('not_supported'));
    const r = await answerCheck(t, q1);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.check.outcome).toBe('unresolved');
    const d = await detail(t, q1);
    expect(d.question.current.id).toBe(checkedVersion);
    expect(d.question.current.answer_status).toBe('source_key');
    expect(d.scorable).toBe(true);
  });

  it('a verified conflict: «مفتاح المصدر يختار A لكن الأدلة المختارة تشير إلى B» — a new conflicting version, nothing scored on it', async () => {
    ai.on('validate_question', solveWith("McBurney's point", 'migrates to the right iliac fossa', MIGRATES)).on('verify_support', verdicts('supported'));
    const r = await answerCheck(t, q1);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = r.body.check;
    expect(c.outcome).toBe('conflicts');
    expect(c.reason_ar).toContain('مفتاح المصدر يختار A لكن الأدلة المختارة تشير إلى B');
    expect(c.reason_ar).toContain('لم يُصحَّح المفتاح ولا نتائج محاولاتك السابقة تلقائيًا');
    expect(r.body.claims[c.claim_ids[0]!]!.citations[0]!.evidence.quote).toContain("McBurney's point");
    // the independent solver was never shown the printed key
    const prompt = ai.callsFor('validate_question').at(-1)!.prompt;
    expect(prompt).not.toMatch(/Answer Key|1\. A 2\. B/);
    const d = await detail(t, q1);
    expect(d.question.current.id).toBe(r.body.new_version_id);
    expect(d.question.current.answer_status).toBe('conflicting_key');
    expect(d.question.current.key_details?.conflict_ar).toContain('مفتاح المصدر يختار A');
    expect(d.scorable).toBe(false);
    expect(d.review_items.some((i) => i.kind === 'conflicting_key' && i.status === 'open' && i.reason.includes('الأدلة المختارة تشير إلى B'))).toBe(true);
    const rq = (await api(t).get(`/api/questions/review-queue?source_id=${wrong.sourceId}`)).json() as ReviewQueueResponse;
    expect(rq.items.some((i) => i.kind === 'conflicting_key' && i.reason.includes('مفتاح المصدر يختار A'))).toBe(true);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM answer_evidence WHERE question_version_id = ? AND role = 'contradicts_key'`, [d.question.current.id])!.n).toBeGreaterThan(0);
  });

  it('the original is kept: the printed key entry and the checked version (source key A) are untouched', async () => {
    const d = await detail(t, q1);
    expect(d.key_entries.map((k) => `${k.key_label}:${k.mark_kind}:${k.binding}`)).toEqual(['A:printed_key:bound']);
    const old = d.versions.find((v) => v.id === checkedVersion)!;
    expect(old.answer_status).toBe('source_key');
    expect(old.options.filter((o) => old.correct_option_ids?.includes(o.id)).map((o) => plain(o.text))).toEqual(["Murphy's point"]);
    expect(old.attempts).toBe(1);
  });

  it('nothing is re-graded: the earlier attempt and the finished result stay as they were; an alert lists the attempt', async () => {
    const row = t.ctx.db.get<{ is_correct: number; scored: number; question_version_id: string }>('SELECT is_correct, scored, question_version_id FROM question_attempt WHERE id = ?', [practiceAttempt.questionAttemptId])!;
    expect(row).toEqual({ is_correct: 1, scored: 1, question_version_id: checkedVersion });
    const res = (await api(t).get(`/api/exams/attempts/${practiceAttempt.examAttemptId}/result`)).json() as ExamResultDetail;
    expect(res.correct).toBe(1);
    expect(res.scored_items).toBe(1);
    const fb = (await api(t).get(`/api/exams/attempts/${practiceAttempt.examAttemptId}/items/0/feedback`)).json() as AttemptFeedbackView;
    expect(fb.is_correct).toBe(true);
    expect(fb.newer_version_note_ar).toMatch(/لم يُعَد تقييمها/);
    const alert = t.ctx.db.get<{ id: string; summary: string }>(`SELECT id, summary FROM content_alert WHERE kind = 'key_corrected' AND json_extract(details_json, '$.question_id') = ? AND json_extract(details_json, '$.by') = 'evidence'`, [q1])!;
    expect(alert.summary).toMatch(/الأدلة المختارة تخالف مفتاح المصدر/);
    expect(alert.summary).toMatch(/لم يُعَد تقييم أي منها/);
    const items = t.ctx.db.all<{ dependent_type: string; dependent_id: string }>('SELECT dependent_type, dependent_id FROM content_alert_item WHERE alert_id = ?', [alert.id]);
    expect(items).toContainEqual({ dependent_type: 'question_attempt', dependent_id: practiceAttempt.questionAttemptId });
  });

  it('an assessed exam no longer takes it; practice shows it unscored with the conflict as the reason', async () => {
    expect(listForExam(t.ctx, { sourceIds: [wrong.sourceId], onlyScorable: true }).map((c) => c.question_id)).not.toContain(q1);
    const s = await practice(q1);
    expect(s.items[0]!.scored).toBe(false);
    expect(s.unscored_reasons['0']).toBeTruthy();
  });

  it('re-extraction and re-matching never restore the printed key silently (the conflict stays until the key itself changes)', async () => {
    await api(t).post('/api/questions/extract', { version_id: wrong.versionId });
    await api(t).post('/api/questions/match', { source_id: wrong.sourceId });
    await t.ctx.jobs.drain();
    const d = await detail(t, q1);
    expect(d.question.current.answer_status).toBe('conflicting_key');
    expect(d.question.current.key_details?.conflict_ar).toContain('مفتاح المصدر يختار A');
    expect(d.scorable).toBe(false);
  });

  it('the owner decides (key B) → a new version «your key»; the earlier attempt still keeps its original result', async () => {
    const d0 = await detail(t, q1);
    const optB = d0.question.current.options.find((o) => plain(o.text) === "McBurney's point")!;
    const res = await api(t).post(`/api/questions/${q1}/key`, { option_keys: [optB.option_key], reason: 'راجعت المحاضرة' });
    expect(res.statusCode).toBe(200);
    const m = res.json() as QuestionMutationResponse;
    expect(m.question.current.answer_status).toBe('owner_key');
    expect(t.ctx.db.get<{ is_correct: number }>('SELECT is_correct FROM question_attempt WHERE id = ?', [practiceAttempt.questionAttemptId])!.is_correct).toBe(1);
    expect((await detail(t, q1)).key_entries.map((k) => k.key_label)).toEqual(['A']); // the printed key is still recorded as printed
  });

  it('a key that AGREES with the lecture is confirmed with its evidence — no new version, still scorable', async () => {
    const q2 = questionAt(t, wrong.sourceId, '', '2');
    const before = (await detail(t, q2)).question.current.id;
    ai.on('validate_question', solveWith('Pregnancy test (beta-hCG)', 'women of reproductive age', 'A pregnancy test (β-hCG) is required in women of reproductive age.')).on('verify_support', verdicts('supported'));
    const r = await answerCheck(t, q2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.check.outcome).toBe('agrees');
    expect(r.body.new_version_id).toBeNull();
    const d = await detail(t, q2);
    expect(d.question.current.id).toBe(before);
    expect(d.question.current.answer_status).toBe('source_key');
    expect(d.question.current.key_details?.answer_check?.outcome).toBe('agrees');
    expect(d.scorable).toBe(true);
  });
});

describe('G4 AC-15 B — another source prints a different key AFTER the question was answered (no AI)', () => {
  it('the conflict is shown with both printed keys; the finished exam result and its attempt are not changed', async () => {
    const a1 = questionAt(t, golden1.sourceId, 'A', '1');
    const s = await practice(a1);
    const fb = await answer(s, "McBurney's point");
    expect(fb.is_correct).toBe(true);
    const before = await finishAndResult(s);
    expect(before.correct).toBe(1);
    const attemptedVersion = fb.question_version_id;

    await uploadAndProcess(t, course, 'g4_a1_other_key.pdf', acceptanceFixture('g4_a1_other_key.pdf'), 'question_source', 'G4 revision sheet');
    expect(questionAt(t, (t.ctx.db.get<{ id: string }>(`SELECT id FROM source WHERE title = 'G4 revision sheet'`)!).id, '', '1')).toBe(a1); // one question, two occurrences
    const d = await detail(t, a1);
    expect(d.question.current.answer_status).toBe('conflicting_key');
    expect(d.question.current.id).not.toBe(attemptedVersion); // the attempted version is locked → a new version
    expect(d.question.current.key_details?.conflict_ar).toMatch(/متعارضة/);
    expect(d.key_entries.map((k) => k.key_label).sort()).toEqual(['B', 'C']);
    expect(d.scorable).toBe(false);
    expect(d.versions.find((v) => v.id === attemptedVersion)?.answer_status).toBe('source_key');

    const after = (await api(t).get(`/api/exams/attempts/${s.attempt.id}/result`)).json() as ExamResultDetail;
    expect(after.correct).toBe(before.correct);
    expect(after.scored_items).toBe(before.scored_items);
    expect(t.ctx.db.get<{ is_correct: number }>('SELECT is_correct FROM question_attempt WHERE id = ?', [fb.attempt!.id])!.is_correct).toBe(1);
    const alert = t.ctx.db.get<{ summary: string }>(`SELECT summary FROM content_alert WHERE kind = 'key_corrected' AND json_extract(details_json, '$.question_id') = ? AND json_extract(details_json, '$.by') = 'source'`, [a1]);
    expect(alert?.summary).toMatch(/لم يُعَد تقييم أي محاولة تلقائيًا/);
    expect(listForExam(t.ctx, { questionIds: [a1], onlyScorable: true })).toHaveLength(0);
  });
});
