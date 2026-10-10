// G8 / AC-26 — source update (§18): «correcting a fact or a key identifies the affected tools, shows an alert, and keeps
// the old versions and the attempts linked to them.» Through the REAL HTTP routes on a G8-only question source (printed
// key of Q3 is WRONG on purpose) and the Golden Set appendicitis lecture, processed by the real pipeline. The only AI
// call (the evidence-backed answer check) is the TEST-ONLY scripted provider — there is no key here.
// Adversarial paths: tools that depend on the corrected key WITHOUT a source-version dependency (a card made from the
// mistake, an exam created earlier that still pins the old key, an exam attempt in progress), a FACT corrected in the
// question text itself, a fact corrected in the lecture that an evidence-backed answer relied on, and an owner who must
// recognise each affected tool by name (Arabic labels, titles, links) — not by an internal type key.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEPENDENT_TYPE_LABELS_AR,
  type AttemptFeedbackView,
  type CardCreateResponse,
  type ContentAlertView,
  type ExamCreateResponse,
  type ExamResultDetail,
  type ExamSessionView,
  type FlashcardView,
  type QuestionDetailResponse,
  type QuestionMutationResponse,
  type SyncPushResponse,
} from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { api, createNode, uploadAndProcess } from '../questions/helpers';
import { acc, g8App, gold, type G8App } from './g8-helpers';
import { ScriptedAi, solveWith, verdicts } from './g4-helpers';

const ai = new ScriptedAi();
let t: G8App;
let bank: { sourceId: string; versionId: string };
let lecture: { sourceId: string; versionId: string };

beforeAll(async () => {
  t = await g8App({ ai });
  const course = (await createNode(t, 'G8 AC-26 course')).id;
  lecture = await uploadAndProcess(t, course, 'lecture_appendicitis.pdf', gold('lecture_appendicitis.pdf'), 'lecture', 'Appendicitis G8-26');
  bank = await uploadAndProcess(t, course, 'g8_key_bank.pdf', acc('g8_key_bank.pdf'), 'question_source', 'G8 Revision Bank');
  await t.ctx.jobs.drain();
}, 240_000);

afterAll(async () => {
  await t?.close();
});

// ───────── helpers ─────────
const bankQuestion = (n: number) =>
  t.ctx.db.get<{ question_id: string }>('SELECT question_id FROM question_occurrence WHERE source_id = ? AND printed_number = ?', [bank.sourceId, String(n)])!.question_id;
const keyOf = (versionId: string) => JSON.parse(t.ctx.db.get<{ k: string }>('SELECT correct_option_ids_json AS k FROM question_version WHERE id = ?', [versionId])!.k) as string[];
const optionByText = (versionId: string, text: string) =>
  t.ctx.db.get<{ id: string; option_key: string }>(`SELECT id, option_key FROM question_option WHERE question_version_id = ? AND text_json LIKE ?`, [versionId, `%${text}%`])!;
const currentVersionOf = (qid: string) => t.ctx.db.get<{ v: string }>('SELECT current_version_id AS v FROM question WHERE id = ?', [qid])!.v;
async function exam(mode: 'practice' | 'exam', questionIds: string[]): Promise<ExamSessionView> {
  const res = await api(t).post('/api/exams', { title: '', mode, count: questionIds.length, question_ids: questionIds, policy: mode === 'practice' ? { shuffle_options: false } : undefined, seed: newId(t.clock.now()) });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as ExamCreateResponse).session;
}
async function push(ops: Array<{ entity_type: string; entity_id: string; op: 'upsert' | 'append'; payload: unknown }>): Promise<SyncPushResponse> {
  const res = await api(t).post('/api/sync/push', { ops: ops.map((o) => ({ ...o, op_id: newId(t.clock.now()), device_id: 'g8-device', client_ts: t.clock.now() })) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SyncPushResponse;
}
async function practiceAnswer(questionId: string, optionText: string, id: string): Promise<AttemptFeedbackView> {
  const s = await exam('practice', [questionId]);
  const item = s.items[0]!;
  t.clock.advance(5_000);
  const res = await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/0/answer`, {
    id,
    selected_option_ids: [optionByText(item.question_version_id, optionText).id],
    confidence: 'confident',
    answered_at: t.clock.now(),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AttemptFeedbackView;
}
async function alerts(): Promise<ContentAlertView[]> {
  return ((await api(t).get('/api/evidence/alerts?status=all&limit=200')).json() as { alerts: ContentAlertView[] }).alerts;
}
/** Every affected item must be recognisable by the owner: an Arabic type label, a title, and a place to open it. */
function expectIdentifiable(a: ContentAlertView) {
  for (const i of a.items) {
    expect(DEPENDENT_TYPE_LABELS_AR[i.type], `Arabic label for «${i.type}»`).toMatch(/[؀-ۿ]/);
    expect(i.title, `${i.type} ${i.id} has a title`).toBeTruthy();
    expect((i as { href?: string | null }).href, `${i.type} ${i.id} can be opened`).toMatch(/^\//);
    expect(i.impact_label_ar).toMatch(/[؀-ۿ]/);
  }
  expect(a.summary).toMatch(/[؀-ۿ]/);
  expect(a.kind_label_ar).toMatch(/[؀-ۿ]/);
}

describe('G8 AC-26 — correcting a KEY', () => {
  it('the alert names every affected tool (old version, attempts, the card from the mistake, exams still pinned to the old key); versions, attempts and results are kept', async () => {
    const q3 = bankQuestion(3);
    const v0 = currentVersionOf(q3);
    const printed = optionByText(v0, 'Ultrasound');
    const ct = optionByText(v0, 'CT abdomen');
    expect(keyOf(v0)).toEqual([printed.id]); // the printed (wrong) key

    // 1) practice: the printed key → graded correct
    await practiceAnswer(q3, 'Ultrasound', 'g8a26-practice');
    // 2) an assessed exam, finished: CT → graded WRONG by the printed key
    const e1 = await exam('exam', [q3]);
    t.clock.advance(30_000);
    await push([
      {
        entity_type: 'exam_attempt',
        entity_id: e1.attempt.id,
        op: 'upsert',
        payload: { ...e1.attempt, status: 'completed', finished_at: t.clock.now(), answers: { '0': { attempt_id: 'g8a26-exam', selected_option_ids: [ct.id], confidence: 'confident', at: t.clock.now(), submitted: false } } },
      },
    ]);
    const resultBefore = (await api(t).get(`/api/exams/attempts/${e1.attempt.id}/result`)).json() as ExamResultDetail;
    // 3) a card made from that mistake
    const card = ((await api(t).post('/api/learning/cards/from-mistake', { attempt_id: 'g8a26-exam' })).json() as CardCreateResponse).cards[0]!;
    // 4) an exam created BEFORE the correction, not taken yet (it pins the old version)
    const pending = await exam('exam', [q3]);
    expect(pending.items[0]!.question_version_id).toBe(v0);

    // the owner corrects the key
    const res = await api(t).post(`/api/questions/${q3}/key`, { option_keys: [ct.option_key], reason: 'المحاضرة: CT هو المفضل عند البالغين' });
    expect(res.statusCode, res.body).toBe(200);
    const m = res.json() as QuestionMutationResponse;
    expect(m.impact).toMatchObject({ attempts_total: 2, would_change: 2 });

    const alert = (await alerts()).find((a) => a.id === m.impact!.content_alert_id)!;
    expect(alert.kind).toBe('key_corrected');
    expect(alert.severity).toBe('answer_change');
    const byType = (type: string) => alert.items.filter((i) => i.type === type).map((i) => i.id);
    expect(byType('question_version')).toEqual([v0]);
    expect(byType('question_attempt').sort()).toEqual(['g8a26-exam', 'g8a26-practice']);
    expect(byType('flashcard'), 'the card made from the mistake is an affected tool').toEqual([card.id]);
    expect(byType('exam'), 'the exam that still pins the old key is an affected tool').toContain(pending.exam.id);
    expectIdentifiable(alert);
    expect(alert.items.find((i) => i.type === 'question_version')!.title).toContain('G8 set: which imaging test');
    expect(alert.summary).toContain('لم يُعَد تقييم');

    // kept: the old version, both attempts on it with their results, the finished exam's result
    const d = (await api(t).get(`/api/questions/${q3}`)).json() as QuestionDetailResponse;
    expect(d.versions.find((v) => v.id === v0)!.correct_option_ids).toEqual([printed.id]);
    expect(d.question.current.correct_option_ids).not.toEqual([printed.id]);
    expect(d.attempts_by_version[v0]).toBe(2);
    const rows = t.ctx.db.all<{ id: string; question_version_id: string; is_correct: number }>(`SELECT id, question_version_id, is_correct FROM question_attempt WHERE id IN ('g8a26-practice', 'g8a26-exam') ORDER BY id`);
    expect(rows).toEqual([
      { id: 'g8a26-exam', question_version_id: v0, is_correct: 0 },
      { id: 'g8a26-practice', question_version_id: v0, is_correct: 1 },
    ]);
    const resultAfter = (await api(t).get(`/api/exams/attempts/${e1.attempt.id}/result`)).json() as ExamResultDetail;
    expect(resultAfter.correct).toBe(resultBefore.correct);
    const fb = (await api(t).get(`/api/exams/attempts/${e1.attempt.id}/items/0/feedback`)).json() as AttemptFeedbackView;
    expect(fb.newer_version_note_ar).toMatch(/[؀-ۿ]/);
    // the card says why it needs review; its history is kept
    const cv = ((await api(t).get(`/api/learning/cards/${card.id}`)).json() as { card: FlashcardView }).card;
    expect(cv.needs_review).toBe(true);
    expect(cv.impacts.map((i) => i.kind)).toContain('question_changed');
    // a NEW exam uses the corrected version; the pending one keeps what it pinned (and its alert says so)
    expect((await exam('exam', [q3])).items[0]!.question_version_id).toBe(m.new_version_id);
    expect(((await api(t).get(`/api/exams/attempts/${pending.attempt.id}`)).json() as ExamSessionView).items[0]!.question_version_id).toBe(v0);
  });
});

describe('G8 AC-26 — correcting a FACT', () => {
  it('a fact corrected in an attempted question (option text): new version, the old one and its attempts kept, an alert names the affected tools', async () => {
    const q2 = bankQuestion(2);
    const v0 = currentVersionOf(q2);
    await practiceAnswer(q2, 'Below 4', 'g8a26-q2-wrong');
    const card = ((await api(t).post('/api/learning/cards/from-mistake', { attempt_id: 'g8a26-q2-wrong' })).json() as CardCreateResponse).cards[0]!;
    const before = (await alerts()).length;
    const d0 = (await api(t).get(`/api/questions/${q2}`)).json() as QuestionDetailResponse;
    const options = d0.question.current.options.map((o) => {
      const text = o.text.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');
      return { option_key: o.option_key, source_label: o.source_label, text: text.includes('Below 4') ? 'Below 3.5 ×10⁹/L' : text };
    });
    const res = await api(t).patch(`/api/questions/${q2}`, { options, note: 'تصحيح قيمة في الخيار B' });
    expect(res.statusCode, res.body).toBe(200);
    const m = res.json() as QuestionMutationResponse;
    expect(m.new_version_id).not.toBe(v0);
    // kept
    expect(t.ctx.db.get<{ v: string }>(`SELECT question_version_id AS v FROM question_attempt WHERE id = 'g8a26-q2-wrong'`)!.v).toBe(v0);
    const d = (await api(t).get(`/api/questions/${q2}`)).json() as QuestionDetailResponse;
    expect(JSON.stringify(d.versions.find((v) => v.id === v0)!.options)).toContain('Below 4');
    // shown: an alert that names the affected tools
    const all = await alerts();
    expect(all.length).toBeGreaterThan(before);
    const alert = all.find((a) => a.items.some((i) => i.type === 'question_version' && i.id === v0) && a.items.some((i) => i.id === 'g8a26-q2-wrong'));
    expect(alert, 'an alert for the corrected question').toBeTruthy();
    expect(alert!.severity).toBe('fact_change');
    expect(alert!.items.map((i) => i.id)).toEqual(expect.arrayContaining([v0, 'g8a26-q2-wrong', card.id]));
    expectIdentifiable(alert!);
    const cv = ((await api(t).get(`/api/learning/cards/${card.id}`)).json() as { card: FlashcardView }).card;
    expect(cv.needs_review).toBe(true);
  });

  it('a fact corrected in the LECTURE (Control Center text correction) flags the evidence-backed answer and the card made from that page', async () => {
    const q1 = bankQuestion(1);
    // an evidence-backed answer check (scripted test provider) that agrees with the printed key, from lecture page 11
    ai.on('validate_question', solveWith('In the periumbilical region', 'periumbilical', 'Pain usually begins in the periumbilical region.')).on('verify_support', verdicts('supported'));
    const check = await api(t).post(`/api/questions/${q1}/answer-check`, { lecture_source_id: lecture.sourceId });
    expect(check.statusCode, check.body).toBe(200);
    expect((check.json() as { check: { outcome: string } }).check.outcome).toBe('agrees');
    const qv = currentVersionOf(q1);
    // a card from a selection on the same page
    const region = t.ctx.db.get<{ id: string; text: string }>(
      `SELECT r.id, r.text FROM source_region r JOIN source_page p ON p.id = r.page_id WHERE r.version_id = ? AND r.text LIKE 'Pain usually begins%' LIMIT 1`,
      [lecture.versionId],
    )!;
    const card = ((await api(t).post('/api/learning/cards/from-selection', { source_id: lecture.sourceId, version_id: lecture.versionId, quote: region.text.slice(0, 40), region_id: region.id, start: 0, end: 40, front: 'أين يبدأ الألم؟' })).json() as CardCreateResponse).cards[0]!;
    // the owner corrects the flagged Arabic sentence of that page in the Control Center
    const flagged = t.ctx.db.get<{ id: string; text: string }>(
      `SELECT r.id, r.text FROM source_region r JOIN source_page p ON p.id = r.page_id WHERE r.version_id = ? AND p.page_index = 0 AND r.text LIKE '%عادةS%'`,
      [lecture.versionId],
    )!;
    const item = t.ctx.db.get<{ id: string }>(`SELECT id FROM review_queue_item WHERE entity_id = ? AND status = 'open'`, [flagged.id])!;
    const fix = await api(t).post(`/api/control/review/${item.id}/resolve`, { action: 'correct', text: flagged.text.replace('عادةS', 'عادةً'), note: 'تصحيح قراءة' });
    expect(fix.statusCode, fix.body).toBe(200);
    const alertId = (fix.json() as { alert: { id: string } | null }).alert!.id;
    const alert = (await alerts()).find((a) => a.id === alertId)!;
    const ids = alert.items.map((i) => `${i.type}:${i.id}`);
    expect(ids).toContain(`flashcard:${card.id}`);
    expect(ids, 'the answer whose evidence is on the corrected page').toContain(`question_version:${qv}`);
    expectIdentifiable(alert);
    // the old text is kept (history) and the card says why it needs review
    expect(t.ctx.db.get<{ before_text: string }>('SELECT before_text FROM control_region_correction WHERE region_id = ?', [flagged.id])!.before_text).toContain('عادةS');
    const cv = ((await api(t).get(`/api/learning/cards/${card.id}`)).json() as { card: FlashcardView }).card;
    expect(cv.impacts.map((i) => i.kind)).toContain('source_changed');
  });
});
