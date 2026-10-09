// Regression tests from the independent review of track C4 (practice & exams). Each test pins one confirmed defect:
//  1. generated MCQ: a distractor explanation whose claim the independent verifier rates only «partial» (needs
//     review) must block publishing (repair → review queue), never be published as evidence-backed;
//  2. finishing an exam whose pinned question was purged meanwhile must not leave a half-finished, partly graded
//     attempt (the sync op was 'rejected' while the completed state had already been written);
//  3. practice: an answer chosen but not checked before finishing is an attempt (no permanent «not on the server
//     yet» counter for answers the server would never receive);
//  4. written grading: rubric points / «wrong statement» reasons that the verifier did not confirm («partial») never
//     count toward the estimated score or tell the student they are wrong;
//  5. AC-26 wording: an answer given AFTER a key correction (exam pinned the older version) is not described as
//     «the key changed after your attempt».
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttemptFeedbackView, ExamAttemptDTO, ExamResultDetail, GenerateQuestionsResponse, GenerationRunView, SyncOpResult, WrittenAttemptResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { createQuestion } from '../../src/modules/questions/service';
import { aliasWith, allSupported, api, createExam, createExamApp, pageId, push, questionAt, ScriptedAi, type ExamApp } from './helpers';

const ai = new ScriptedAi();
let t: ExamApp;

beforeAll(async () => {
  t = await createExamApp({ ai });
}, 300_000);

afterAll(async () => {
  await t?.close();
});

const STEM =
  'A 28-year-old woman of reproductive age presents with periumbilical pain that has moved to the right iliac fossa, with anorexia and nausea. Which investigation should be performed first to exclude an important differential diagnosis?';

function goodQuestion(prompt: string) {
  const preg = aliasWith(prompt, 'pregnancy test');
  const us = aliasWith(prompt, 'Ultrasound is the first-line');
  const ct = aliasWith(prompt, 'CT abdomen is preferred');
  const ddx = aliasWith(prompt, 'differential diagnosis includes');
  return {
    item_type: 'investigation',
    learning_objective: 'Choose the first investigation that excludes ectopic pregnancy in a woman of reproductive age with right iliac fossa pain.',
    concepts: ['acute appendicitis', 'ectopic pregnancy'],
    difficulty_est: 'hard',
    stem: STEM,
    options: [
      { key: 'A', text: 'Serum amylase level' },
      { key: 'B', text: 'Pregnancy test (β-hCG)' },
      { key: 'C', text: 'Barium enema study' },
      { key: 'D', text: 'Upper GI endoscopy' },
    ],
    best_answer: 'B',
    explanation: [
      { text: 'A pregnancy test (β-hCG) is required in women of reproductive age.', claim: { support_type: 'directly_stated', evidence: [preg] } },
      { text: 'Ectopic pregnancy is included in the differential diagnosis.', claim: { support_type: 'derived', evidence: [ddx] } },
    ],
    distractors: [
      { option: 'A', explanation: [{ text: 'The investigations listed for this presentation are ultrasound, CT abdomen and a pregnancy test.', claim: { support_type: 'synthesized', evidence: [us, ct, preg] } }] },
      { option: 'C', explanation: [{ text: 'Ultrasound is the first-line imaging test in children and in pregnant women.', claim: { support_type: 'directly_stated', evidence: [us] } }] },
      {
        option: 'D',
        explanation: [
          { text: 'CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.', claim: { support_type: 'directly_stated', evidence: [ct] } },
          // a second medical sentence that passes the deterministic checks but the verifier only rates «partial»
          { text: 'Ultrasound is the first-line imaging test in pregnant women.', claim: { support_type: 'derived', evidence: [us] } },
        ],
      },
    ],
  };
}

const VALID = { chosen_option: 'B', defensible_options: ['B'], answerable_from_evidence: true, clue_issues: [], issues: [], verdict: 'valid' };

/** verify_support: every claim supported except the ones whose text contains `needle` (rated «partial»). */
function supportedExcept(needle: string) {
  return (req: ProviderRequest) => {
    const blocks = [...req.prompt.matchAll(/CLAIM \[(\d+)\]: ([^\n]*)/g)];
    return {
      results: blocks.map((m) => ({
        index: Number(m[1]),
        verdict: m[2]!.includes(needle) ? 'partial' : 'supported',
        reason: m[2]!.includes(needle) ? 'الدليل يذكر البالغين وCT فقط، لا التنظير.' : 'مدعومة',
      })),
    };
  };
}

async function generate(body: Record<string, unknown>): Promise<GenerationRunView> {
  const res = await api(t).post('/api/exams/generate', body);
  if (res.statusCode !== 200) throw new Error(`generate failed ${res.statusCode} ${res.body}`);
  await t.ctx.jobs.drain();
  return ((await api(t).get(`/api/exams/generate/${(res.json() as GenerateQuestionsResponse).run.id}`)).json() as GenerateQuestionsResponse).run;
}

const generatedCount = () => t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM question WHERE origin_type = 'generated'`)!.n;

describe('review: generated MCQ — only verified claims can be published', () => {
  it('a distractor explanation with a «partial» (needs review) claim is never published', async () => {
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [goodQuestion(req.prompt)] }))
      .on('validate_question', () => VALID)
      .on('verify_support', supportedExcept('imaging test in pregnant women'));
    ai.calls.length = 0;
    const before = generatedCount();
    const run = await generate({ lecture_source_id: t.lecture.sourceId, page_ids: [pageId(t, t.lecture.versionId, 1)], topic: 'pregnancy test investigations', count: 1, difficulty: 'hard', item_types: ['investigation'] });
    const c = run.candidates[0]!;
    expect(c.status).toBe('needs_review');
    expect(c.question_id).toBeNull();
    expect(c.issues.some((i) => i.by === 'evidence' && /المشتت D/.test(i.reason_ar))).toBe(true);
    expect(generatedCount()).toBe(before);
    // the repair rounds were used (bounded) before giving up
    expect(ai.callsFor('generate_questions')).toHaveLength(3);
  });

  it('control: the same question with every claim supported is published', async () => {
    ai.on('verify_support', allSupported);
    const run = await generate({ lecture_source_id: t.lecture.sourceId, page_ids: [pageId(t, t.lecture.versionId, 1)], topic: 'pregnancy test investigations', count: 1, difficulty: 'hard', item_types: ['investigation'] });
    expect(run.candidates[0]!.status).toBe('published');
  });
});

describe('review: finishing an exam never leaves a half-graded attempt', () => {
  it('a pinned question purged before finishing: the attempt finishes, the other answers are graded, nothing is rejected half-way', async () => {
    const keep = questionAt(t, t.qs.sourceId, 'A', '1');
    const gone = createQuestion(t.ctx, {
      origin: 'owner',
      qtype: 'sba',
      stem: 'Which sign is elicited by deep palpation of the left iliac fossa causing pain in the right iliac fossa?',
      options: [{ text: "Rovsing's sign" }, { text: 'Psoas sign' }, { text: 'Obturator sign' }, { text: "Murphy's sign" }],
      correctOptionIndexes: [0],
      answerStatus: 'owner_key',
    });
    const r = await createExam(t, { mode: 'exam', count: 2, question_ids: [keep, gone.questionId], seed: 'purge' });
    const s = r.session;
    expect(s.items).toHaveLength(2);
    const now = t.ctx.clock.now();
    const answers: Record<string, unknown> = {};
    s.items.forEach((it, i) => {
      answers[String(i)] = { attempt_id: newId(), selected_option_ids: [it.options[0]!.id], confidence: 'unsure', at: now, time_ms: 1000, hints_used: 0, solution_viewed_before_answer: false, submitted: false };
    });
    const state = (a: ExamAttemptDTO, patch: Partial<ExamAttemptDTO>) => ({ status: a.status, elapsed_ms: a.elapsed_ms, current_index: a.current_index, answers: a.answers, flagged: a.flagged, timer: a.timer, ...patch });
    expect((await push(t, [{ entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: state(s.attempt, { answers: answers as never }) }]))[0]!.result).toBe('applied');

    // the owner's own question is purged meanwhile (same tables the source purge clears)
    t.ctx.db.run('DELETE FROM question_fts WHERE question_id = ?', [gone.questionId]);
    t.ctx.db.run('DELETE FROM question_lecture_link WHERE question_id = ?', [gone.questionId]);
    t.ctx.db.run('DELETE FROM question_duplicate WHERE question_a_id = ? OR question_b_id = ?', [gone.questionId, gone.questionId]);
    t.ctx.db.run(`DELETE FROM review_queue_item WHERE entity_type = 'question' AND entity_id = ?`, [gone.questionId]);
    t.ctx.db.run('UPDATE question SET current_version_id = NULL WHERE id = ?', [gone.questionId]);
    t.ctx.db.run('DELETE FROM question_option WHERE question_version_id = ?', [gone.versionId]);
    t.ctx.db.run('DELETE FROM question_version WHERE id = ?', [gone.versionId]);
    t.ctx.db.run('DELETE FROM question WHERE id = ?', [gone.questionId]);

    const fin = (await push(t, [{ entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: state(s.attempt, { status: 'completed', answers: answers as never, finished_at: now }) }]))[0] as SyncOpResult;
    expect(fin.result).not.toBe('rejected');
    expect((fin.entity as ExamAttemptDTO).status).toBe('completed');
    const keptIdx = s.items.findIndex((i) => i.question_id === keep);
    const rows = t.ctx.db.all<{ exam_item_index: number }>('SELECT exam_item_index FROM question_attempt WHERE exam_attempt_id = ?', [s.attempt.id]);
    expect(rows.map((x) => x.exam_item_index)).toEqual([keptIdx]);
    expect(fin.detail ?? '').toMatch(/لم يعد موجودًا|حُذف/);
    // the result does not pretend the unreachable answer is still on its way
    const res = (await api(t).get(`/api/exams/attempts/${s.attempt.id}/result`)).json() as ExamResultDetail;
    expect(res.missing_on_server).toBe(0);
  });
});

describe('review: practice — chosen but unchecked answers when finishing', () => {
  it('finishing a practice set records the chosen answers as attempts (no phantom «not on the server yet»)', async () => {
    const qid = questionAt(t, t.qs.sourceId, 'B', '1');
    const r = await createExam(t, { mode: 'practice', count: 1, question_ids: [qid] });
    const s = r.session;
    const now = t.ctx.clock.now();
    const answers = { '0': { attempt_id: newId(), selected_option_ids: [s.items[0]!.options[0]!.id], confidence: 'guess', at: now, time_ms: 900, hints_used: 0, solution_viewed_before_answer: false, submitted: false } };
    const fin = await push(t, [
      { entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: { status: 'completed', elapsed_ms: 900, current_index: 0, answers, flagged: [], timer: { item_ms: { '0': 900 }, pauses: 0, paused_at: null }, finished_at: now } },
    ]);
    expect(fin[0]!.result).toBe('applied');
    const res = (await api(t).get(`/api/exams/attempts/${s.attempt.id}/result`)).json() as ExamResultDetail;
    expect(res.missing_on_server).toBe(0);
    expect(res.answered).toBe(1);
    expect(res.items[0]!.confidence).toBe('guess');
  });
});

describe('review: written grading counts only verified rubric points', () => {
  it('a «partial» rubric point is not part of the estimated score; a «wrong» note needs a verified reason', async () => {
    const c = createQuestion(t.ctx, {
      origin: 'owner',
      qtype: 'short_answer',
      stem: 'Which imaging investigation is first-line for suspected appendicitis in children and pregnant women, and when is CT abdomen preferred?',
      options: [],
      answerStatus: 'not_applicable',
      lecture: { sourceId: t.lecture.sourceId, relation: 'directly_covered', reason: 'test link' },
    });
    const id = newId();
    expect((await api(t).post('/api/exams/written/attempts', { id, question_id: c.questionId, question_version_id: c.versionId, answer_text: 'Ultrasound for children and pregnant women. MRI is always first.', answered_at: t.ctx.clock.now() })).statusCode).toBe(200);
    ai.on('grade_written', (req: ProviderRequest) => {
      const us = aliasWith(req.prompt, 'Ultrasound is the first-line');
      const ct = aliasWith(req.prompt, 'CT abdomen is preferred');
      return {
        rubric: [
          { text: 'Ultrasound is the first-line imaging test in children and in pregnant women.', weight: 2, claim: { support_type: 'directly_stated', evidence: [us] } },
          { text: 'CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.', weight: 2, claim: { support_type: 'directly_stated', evidence: [ct] } },
          { text: 'Ultrasound is the first-line imaging test in pregnant women.', weight: 3, claim: { support_type: 'derived', evidence: [us] } },
        ],
        points: [
          { rubric_index: 0, status: 'correct', note: 'ذكرت الموجات فوق الصوتية.' },
          { rubric_index: 1, status: 'missing', note: 'لم تذكر CT.' },
          { rubric_index: 2, status: 'correct', note: 'نقطة غير متحقق منها.' },
        ],
        wrong_statements: [{ text: 'MRI is always first', why: { text: 'Ultrasound is the first-line imaging test in pregnant women.', claim: { support_type: 'derived', evidence: [us] } } }],
        improved_answer: [{ text: 'Ultrasound is the first-line imaging test in children and in pregnant women.', claim: { support_type: 'directly_stated', evidence: [us] } }],
        qualitative_feedback: ['الإجابة مختصرة.'],
      };
    }).on('verify_support', supportedExcept('imaging test in pregnant women'));
    const a = ((await api(t).post(`/api/exams/written/attempts/${id}/grade`, {})).json() as WrittenAttemptResponse).attempt;
    const s = a.assessment!;
    expect(s.kind).toBe('rubric_score');
    expect(s.rubric.map((p) => p.text)).not.toContain('Ultrasound is the first-line imaging test in pregnant women.');
    expect(s.estimated_score).toEqual({ got: 2, max: 4 });
    expect(s.wrong_statements).toHaveLength(0);
  });
});

describe('review: AC-26 note wording', () => {
  it('an answer given after the key was corrected says so (not «changed after your attempt»)', async () => {
    const c = createQuestion(t.ctx, {
      origin: 'owner',
      qtype: 'sba',
      stem: 'Which imaging test is first-line in pregnant women with suspected appendicitis?',
      options: [{ text: 'Ultrasound' }, { text: 'CT abdomen' }, { text: 'Plain X-ray' }, { text: 'Barium enema' }],
      correctOptionIndexes: [1],
      answerStatus: 'owner_key',
    });
    const r = await createExam(t, { mode: 'practice', count: 1, question_ids: [c.questionId] });
    // the exam pinned the version; the owner corrects the key BEFORE answering
    const cur = (await api(t).get(`/api/questions/${c.questionId}`)).json().question.current;
    const us = cur.options.find((o: { text: unknown }) => JSON.stringify(o.text).includes('Ultrasound'));
    expect((await api(t).post(`/api/questions/${c.questionId}/key`, { option_keys: [us.option_key], reason: 'correction' })).statusCode).toBe(200);
    t.clock.advance(1000);
    const item = r.session.items[0]!;
    const fb = (await api(t).post(`/api/exams/attempts/${r.session.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [item.options.find((o) => JSON.stringify(o.text).includes('Ultrasound'))!.id], answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb.newer_version_note_ar).toBeTruthy();
    expect(fb.newer_version_note_ar).not.toMatch(/بعد محاولتك/);
    expect(fb.newer_version_note_ar).toMatch(/قبل إجابتك/);
  });
});
