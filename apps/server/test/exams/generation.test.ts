// Generated hard MCQs (§37–§38, AC-18) and written-answer grading (§41) with a TEST-ONLY scripted AI provider on the
// Golden Set lecture processed by the real pipeline. Covers: valid question published with distractor explanations
// and verified evidence; ambiguous (two defensible answers) → repaired; unsupported citations → bounded repairs →
// review queue, never published; insufficient evidence → abstention with a suggestion (generator not called);
// Source Lock on the request; written grading with a verified rubric, qualitative fallback, idempotency.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GENERATED_ORIGIN_LABEL_AR,
  WRITTEN_ASSESSMENT_LABEL_AR,
  type AttemptFeedbackView,
  type GenerateQuestionsResponse,
  type GenerationRunView,
  type WrittenAttemptResponse,
  type WrittenQuestionView,
} from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { createQuestion } from '../../src/modules/questions/service';
import { aliasWith, allSupported, api, createExam, createExamApp, evidenceIn, pageId, ScriptedAi, type ExamApp } from './helpers';

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

function goodQuestion(prompt: string, opts: { badAlias?: boolean } = {}) {
  const preg = opts.badAlias ? 'E99' : aliasWith(prompt, 'pregnancy test');
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
      { option: 'D', explanation: [{ text: 'CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.', claim: { support_type: 'directly_stated', evidence: [ct] } }] },
    ],
  };
}

const VALID = { chosen_option: 'B', defensible_options: ['B'], answerable_from_evidence: true, clue_issues: [], issues: [], verdict: 'valid' };

async function generate(body: Record<string, unknown>): Promise<GenerationRunView> {
  const res = await api(t).post('/api/exams/generate', body);
  if (res.statusCode !== 200) throw new Error(`generate failed ${res.statusCode} ${res.body}`);
  await t.ctx.jobs.drain();
  return ((await api(t).get(`/api/exams/generate/${(res.json() as GenerateQuestionsResponse).run.id}`)).json() as GenerateQuestionsResponse).run;
}

const investigationsRequest = () => ({ lecture_source_id: t.lecture.sourceId, page_ids: [pageId(t, t.lecture.versionId, 1)], topic: 'pregnancy test investigations', count: 1, difficulty: 'hard', item_types: ['investigation'] });
const generatedCount = () => t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM question WHERE origin_type = 'generated'`)!.n;

describe('generated hard MCQs (§37–§38, AC-18)', () => {
  let publishedId: string;

  it('a valid question is published with verified evidence for the answer AND every distractor', async () => {
    ai.calls.length = 0;
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [goodQuestion(req.prompt)] }))
      .on('validate_question', () => VALID)
      .on('verify_support', allSupported);
    const run = await generate(investigationsRequest());
    expect(run.status).toBe('completed');
    expect(run.candidates).toHaveLength(1);
    const c = run.candidates[0]!;
    expect(c.status).toBe('published');
    expect(c.rounds).toBe(1);
    expect(c.question_id).toBeTruthy();
    publishedId = c.question_id!;
    expect(run.scope_describe_ar).toContain('المحاضرة فقط');

    // the independent validator never saw the key or the explanations
    const v = ai.callsFor('validate_question')[0]!;
    expect(v.prompt).not.toContain('best_answer');
    expect(v.prompt).not.toContain('Ectopic pregnancy is included in the differential diagnosis.');
    expect(v.prompt).toContain('Pregnancy test (β-hCG)');
    // every model call stayed inside the locked scope (the lecture version only)
    for (const call of ai.calls) for (const quote of evidenceIn(call.prompt).values()) expect(quote).not.toMatch(/cholecystitis/i);

    const q = (await api(t).get(`/api/questions/${publishedId}`)).json().question;
    expect(q.origin_type).toBe('generated');
    expect(q.origin_label_ar).toBe(GENERATED_ORIGIN_LABEL_AR);
    expect(q.current.answer_status).toBe('ai_derived');
    expect(q.current.kind).toBe('generated');
    expect(q.current.difficulty_est).toBe('hard');
    expect(q.current.learning_objective).toMatch(/ectopic pregnancy/);
    expect(q.current.validation.publishable).toBe(true);
    expect(Object.keys(q.current.distractor_explanations)).toHaveLength(3);
    expect(q.occurrences).toHaveLength(0); // never attributed to a previous exam
    expect(q.lecture_links[0].lecture_source_id).toBe(t.lecture.sourceId);
    expect(q.lecture_links[0].reason).toMatch(/وُلّد هذا السؤال/);
    // dependencies recorded → replacement alerts reach it
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_dependency WHERE dependent_type = 'question_version' AND dependent_id = ?`, [q.current.id])!.n).toBeGreaterThan(0);
  });

  it('practice on the generated question: feedback shows the evidence chips, distractor explanations and the generated label', async () => {
    const r = await createExam(t, { mode: 'practice', count: 1, question_ids: [publishedId] });
    const item = r.session.items[0]!;
    const right = item.options.find((o) => JSON.stringify(o.text).includes('Pregnancy test'))!;
    const fb = (await api(t).post(`/api/exams/attempts/${r.session.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [right.id], confidence: 'confident', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb.is_correct).toBe(true);
    expect(fb.scored).toBe(true);
    expect(fb.origin_type).toBe('generated');
    expect(fb.origin_label_ar).toBe(GENERATED_ORIGIN_LABEL_AR);
    expect(fb.answer_status).toBe('ai_derived');
    expect(Object.keys(fb.distractor_explanations ?? {})).toHaveLength(3);
    for (const id of Object.keys(fb.distractor_explanations!)) expect(item.options.map((o) => o.id)).toContain(id);
    const claims = Object.values(fb.claims);
    expect(claims.length).toBeGreaterThanOrEqual(5);
    expect(claims.every((c) => c.verification_status === 'linked' && c.citations.length > 0)).toBe(true);
    expect(fb.difficulty_est).toBe('hard');
    // and the generated question takes part in the origin mix of the builder
    const mix = await createExam(t, { mode: 'exam', count: 2, source_ids: [t.qs.sourceId, t.lecture.sourceId], question_ids: [publishedId], origin_mix: { source: 1, generated: 1 } });
    expect(mix.session.exam.build!.by_origin.generated).toBe(1);
  });

  it('two defensible answers (independent validator) → repaired, then published (bounded rounds)', async () => {
    let validations = 0;
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [goodQuestion(req.prompt)] })).on('validate_question', () => {
      validations++;
      return validations === 1 ? { chosen_option: 'B', defensible_options: ['B', 'C'], answerable_from_evidence: true, clue_issues: [], issues: [], verdict: 'invalid' } : VALID;
    });
    ai.calls.length = 0;
    const run = await generate(investigationsRequest());
    expect(run.status).toBe('completed');
    expect(run.candidates[0]!.status).toBe('published');
    expect(run.candidates[0]!.rounds).toBe(2);
    const repairCall = ai.callsFor('generate_questions')[1]!;
    expect(repairCall.prompt).toContain('REPAIR');
    expect(repairCall.prompt).toMatch(/أكثر من خيار يمكن الدفاع عنه/);
  });

  it('unsupported claims (an alias the server never handed out) → 2 repairs → review queue, never published', async () => {
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [goodQuestion(req.prompt, { badAlias: true })] })).on('validate_question', () => VALID);
    ai.calls.length = 0;
    const before = generatedCount();
    const run = await generate(investigationsRequest());
    expect(run.status).toBe('needs_review');
    const c = run.candidates[0]!;
    expect(c.status).toBe('needs_review');
    expect(c.rounds).toBe(3);
    expect(c.question_id).toBeNull();
    expect(c.issues.some((i) => i.by === 'evidence')).toBe(true);
    expect(ai.callsFor('generate_questions')).toHaveLength(3); // generation + 2 repairs, no endless loop
    expect(generatedCount()).toBe(before);
    const item = t.ctx.db.get<{ kind: string; reason: string; details_json: string }>(
      `SELECT kind, reason, details_json FROM review_queue_item WHERE entity_type = 'generated_question_candidate' AND entity_id = ?`,
      [c.id],
    )!;
    expect(item.kind).toBe('question_validation_failed');
    expect(item.reason).toMatch(/لم يُنشر/);
    expect(JSON.parse(item.details_json).origin).toBe('exams');
  });

  it('a deterministic clue (absolute words only in distractors, answer much longer) is caught before any validator call', async () => {
    ai.on('generate_questions', (req) => {
      const g = goodQuestion(req.prompt);
      g.options = [
        { key: 'A', text: 'Always a serum amylase level' },
        { key: 'B', text: 'A pregnancy test (β-hCG) because ectopic pregnancy must be excluded in women of reproductive age first' },
        { key: 'C', text: 'Never anything but a barium enema' },
        { key: 'D', text: 'Only upper GI endoscopy' },
      ];
      return { abstain: null, questions: [g] };
    });
    ai.calls.length = 0;
    const run = await generate(investigationsRequest());
    expect(run.candidates[0]!.status).toBe('needs_review');
    expect(run.candidates[0]!.issues.some((i) => i.check === 'no_answer_leak' && i.by === 'deterministic')).toBe(true);
    expect(ai.callsFor('validate_question')).toHaveLength(0);
  });

  it('insufficient evidence in the locked scope → abstain with a suggestion; the generator is never called', async () => {
    ai.calls.length = 0;
    const run = await generate({ lecture_source_id: t.lecture.sourceId, topic: 'Murphy sign gallbladder cholelithiasis', count: 2, difficulty: 'very_hard' });
    expect(run.status).toBe('abstained');
    expect(run.abstain!.reason).toBe('not_found_in_scope');
    expect(run.abstain!.suggestion_ar).toMatch(/صعب|متوسط/);
    expect(run.abstain!.suggestion_ar).toMatch(/لا يُكمَل نقص المادة/);
    expect(ai.callsFor('generate_questions')).toHaveLength(0);
  });

  it('the generator itself abstains → abstained, nothing published', async () => {
    ai.on('generate_questions', () => ({ abstain: { reason: 'insufficient_evidence', detail: 'The excerpts do not explain why each distractor is wrong.' }, questions: [] }));
    const before = generatedCount();
    const run = await generate({ ...investigationsRequest(), difficulty: 'very_hard' });
    expect(run.status).toBe('abstained');
    expect(run.abstain!.reason).toBe('insufficient_evidence');
    expect(run.summary_ar).toMatch(/صعب/);
    expect(generatedCount()).toBe(before);
  });

  it('Source Lock: the request cannot widen or move the scope; pages must belong to the locked lecture version', async () => {
    const other = await api(t).post('/api/exams/generate', { ...investigationsRequest(), scope: { mode: 'references_only', reference_source_ids: [t.qs.sourceId] } });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('OUT_OF_SCOPE');
    const foreignPage = await api(t).post('/api/exams/generate', { ...investigationsRequest(), page_ids: [pageId(t, t.qs.versionId, 0)] });
    expect(foreignPage.statusCode).toBe(409);
    const qsrc = await api(t).post('/api/exams/generate', { ...investigationsRequest(), lecture_source_id: t.qs.sourceId, page_ids: [] , topic: 'x'});
    expect(qsrc.statusCode).toBe(400);
    const noTopic = await api(t).post('/api/exams/generate', { lecture_source_id: t.lecture.sourceId, count: 1, difficulty: 'hard' });
    expect(noTopic.statusCode).toBe(400);
    const smuggle = await api(t).post('/api/exams/generate', { ...investigationsRequest(), version_ids: ['x'] });
    expect(smuggle.statusCode).toBe(400);
  });

  it('runs are listed per lecture', async () => {
    const list = (await api(t).get(`/api/exams/generate?lecture_source_id=${t.lecture.sourceId}`)).json().runs as GenerationRunView[];
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(list[0]!.created_at).toBeGreaterThanOrEqual(list[list.length - 1]!.created_at);
  });
});

describe('written answers (§41)', () => {
  let qid: string;
  let vid: string;

  const rubricResponder = (opts: { bad?: boolean } = {}) => (req: ProviderRequest) => {
    const us = opts.bad ? 'E98' : aliasWith(req.prompt, 'Ultrasound is the first-line');
    const ct = opts.bad ? 'E99' : aliasWith(req.prompt, 'CT abdomen is preferred');
    return {
      rubric: [
        { text: 'Ultrasound is the first-line imaging test in children and in pregnant women.', weight: 2, claim: { support_type: 'directly_stated', evidence: [us] } },
        { text: 'CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.', weight: 2, claim: { support_type: 'directly_stated', evidence: [ct] } },
      ],
      points: [
        { rubric_index: 0, status: 'correct', note: 'ذكرت الموجات فوق الصوتية للأطفال والحوامل.' },
        { rubric_index: 1, status: 'missing', note: 'لم تذكر CT للبالغين.' },
      ],
      wrong_statements: [{ text: 'MRI is always first', why: { text: 'Ultrasound is the first-line imaging test in children and in pregnant women.', claim: { support_type: 'directly_stated', evidence: [us] } } }],
      improved_answer: [
        { text: 'Ultrasound is the first-line imaging test in children and in pregnant women.', claim: { support_type: 'directly_stated', evidence: [us] } },
        { text: 'CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.', claim: { support_type: 'directly_stated', evidence: [ct] } },
      ],
      qualitative_feedback: ['الإجابة مختصرة وتحتاج ترتيبًا حسب الفئة العمرية.'],
    };
  };

  beforeAll(() => {
    const c = createQuestion(t.ctx, {
      origin: 'owner',
      qtype: 'short_answer',
      stem: 'Which imaging investigation is first-line for suspected appendicitis in children and pregnant women, and when is CT abdomen preferred?',
      options: [],
      answerStatus: 'not_applicable',
      lecture: { sourceId: t.lecture.sourceId, relation: 'directly_covered', reason: 'test link' },
    });
    qid = c.questionId;
    vid = c.versionId;
  });

  const save = (body: Record<string, unknown>) => api(t).post('/api/exams/written/attempts', { question_id: qid, question_version_id: vid, answered_at: t.ctx.clock.now(), ...body });

  it('attempts are saved idempotently; MCQ questions and unconfirmed recognized text are refused', async () => {
    const id = newId();
    const a = await save({ id, answer_text: 'Ultrasound for children and pregnant women. MRI is always first.' });
    expect(a.statusCode).toBe(200);
    expect((a.json() as WrittenAttemptResponse).attempt.status).toBe('saved');
    const again = await save({ id, answer_text: 'something else' });
    expect((again.json() as WrittenAttemptResponse).attempt.answer_text).toBe('Ultrasound for children and pregnant women. MRI is always first.');
    expect((await save({ id: newId(), answer_text: '', recognized_text: 'Ultrasound', recognized_confirmed: false })).statusCode).toBe(400);
    const mcq = await api(t).post('/api/exams/written/attempts', { id: newId(), question_id: publishedOr(), question_version_id: 'x', answer_text: 'x', answered_at: 1 });
    expect(mcq.statusCode).toBe(400);
  });

  function publishedOr(): string {
    return t.ctx.db.get<{ id: string }>(`SELECT id FROM question WHERE origin_type = 'source' LIMIT 1`)!.id;
  }

  it('graded on a verified, evidence-bound rubric: points, estimated score, improved answer with evidence, label', async () => {
    const id = newId();
    await save({ id, answer_text: 'Ultrasound for children and pregnant women. MRI is always first.' });
    ai.on('grade_written', rubricResponder()).on('verify_support', allSupported);
    const res = await api(t).post(`/api/exams/written/attempts/${id}/grade`, {});
    expect(res.statusCode).toBe(200);
    const a = (res.json() as WrittenAttemptResponse).attempt;
    expect(a.status).toBe('graded');
    const s = a.assessment!;
    expect(s.label_ar).toBe(WRITTEN_ASSESSMENT_LABEL_AR);
    expect(s.kind).toBe('rubric_score');
    expect(s.rubric_origin).toBe('generated');
    expect(s.rubric).toHaveLength(2);
    expect(s.estimated_score).toEqual({ got: 2, max: 4 });
    expect(s.points.map((p) => p.status).sort()).toEqual(['correct', 'missing']);
    expect(s.wrong_statements).toHaveLength(1);
    expect(s.improved_answer!.paragraphs[0]!.runs.some((r) => r.claim)).toBe(true);
    expect(Object.values(s.claims).length).toBeGreaterThan(0);
    expect(Object.values(s.claims).every((c) => c.verification_status === 'linked')).toBe(true);
    // graded once: asking again does not call the model again
    const n = ai.callsFor('grade_written').length;
    const again = (await api(t).post(`/api/exams/written/attempts/${id}/grade`, {})).json() as WrittenAttemptResponse;
    expect(again.attempt.assessment!.estimated_score).toEqual({ got: 2, max: 4 });
    expect(ai.callsFor('grade_written')).toHaveLength(n);
  });

  it('no sufficient rubric (points fail evidence validation) → qualitative feedback only, no score', async () => {
    const id = newId();
    await save({ id, answer_text: 'Ultrasound.' });
    ai.on('grade_written', rubricResponder({ bad: true }));
    const a = ((await api(t).post(`/api/exams/written/attempts/${id}/grade`, {})).json() as WrittenAttemptResponse).attempt;
    expect(a.assessment!.kind).toBe('qualitative_only');
    expect(a.assessment!.estimated_score).toBeNull();
    expect(a.assessment!.rubric).toHaveLength(0);
    expect(a.assessment!.wrong_statements).toHaveLength(0);
    expect(a.assessment!.qualitative_feedback).toHaveLength(1);
    expect(a.assessment!.notes_ar.join(' ')).toMatch(/لا تُقدَّر درجة/);
  });

  it('a question with no rubric and no linked lecture → qualitative only, the model is not called', async () => {
    const c = createQuestion(t.ctx, { origin: 'owner', qtype: 'essay', stem: 'Discuss the management of a patient with an uncertain diagnosis after clinical assessment.', options: [], answerStatus: 'not_applicable' });
    const id = newId();
    const s = await api(t).post('/api/exams/written/attempts', { id, question_id: c.questionId, question_version_id: c.versionId, answer_text: 'Observe and re-examine.', answered_at: t.ctx.clock.now() });
    expect(s.statusCode).toBe(200);
    const n = ai.callsFor('grade_written').length;
    const a = ((await api(t).post(`/api/exams/written/attempts/${id}/grade`, {})).json() as WrittenAttemptResponse).attempt;
    expect(a.assessment!.kind).toBe('qualitative_only');
    expect(a.assessment!.notes_ar[0]).toMatch(/لم يُستدعَ النموذج/);
    expect(ai.callsFor('grade_written')).toHaveLength(n);
    const view = (await api(t).get(`/api/exams/written/${c.questionId}`)).json() as WrittenQuestionView;
    expect(view.attempts).toHaveLength(1);
    expect(view.has_rubric).toBe(false);
  });
});
