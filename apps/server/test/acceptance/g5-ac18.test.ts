// G5 — AC-18 «سؤال مولد صعب»: evidence exists for the concept, the answer and the distractor explanations → the question
// has ONE best answer, is shown as GENERATED (never as a past-exam question), and missing material is never filled with
// knowledge from outside the allowed sources. No API key exists here: the generator, the independent validator and the
// support verifier are the TEST-ONLY scripted provider (`ScriptedAi`, never registered in production); everything
// around them is the real system — the Golden Set lecture processed by the real pipeline, retrieval under the Source
// Lock, the deterministic checks, claims validation, publication, exams, feedback and the evidence API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENERATED_ORIGIN_LABEL_AR, type AttemptFeedbackView, type EvidenceView, type GenerateQuestionsResponse, type GenerationRunView } from '@medlevo/shared';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { aliasWith, allSupported, createExamApp, pageId, type ExamApp } from '../exams/helpers';
import { api, detail, questionAt } from '../questions/helpers';
import { exam, feedback, finishExam, plain, ScriptedAi } from './g5-helpers';

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

type Sentence = { text: string; claim: { support_type: string; evidence: string[] } | null };

function question(prompt: string, over: { best?: string; explanation?: Sentence[]; distractorA?: Sentence[] } = {}) {
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
    best_answer: over.best ?? 'B',
    explanation: over.explanation ?? [
      { text: 'A pregnancy test (β-hCG) is required in women of reproductive age.', claim: { support_type: 'directly_stated', evidence: [preg] } },
      { text: 'Ectopic pregnancy is included in the differential diagnosis.', claim: { support_type: 'derived', evidence: [ddx] } },
    ],
    distractors: [
      { option: 'A', explanation: over.distractorA ?? [{ text: 'The investigations listed for this presentation are ultrasound, CT abdomen and a pregnancy test.', claim: { support_type: 'synthesized', evidence: [us, ct, preg] } }] },
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

const request = () => ({ lecture_source_id: t.lecture.sourceId, page_ids: [pageId(t, t.lecture.versionId, 1)], topic: 'pregnancy test investigations', count: 1, difficulty: 'hard', item_types: ['investigation'] });
const generatedCount = () => t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM question WHERE origin_type = 'generated'`)!.n;
const reviewItems = (runId: string) =>
  t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_queue_item WHERE entity_type = 'generated_question_candidate' AND json_extract(details_json, '$.run_id') = ?`, [runId])!.n;

describe('AC-18: a generated hard question with evidence for the concept, the answer and every distractor', () => {
  let qid: string;

  it('is published with ONE best answer, labelled generated, never attributed to a past exam', async () => {
    ai.calls.length = 0;
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [question(req.prompt)] }))
      .on('validate_question', () => VALID)
      .on('verify_support', allSupported);
    const run = await generate(request());
    expect(run.status).toBe('completed');
    qid = run.candidates[0]!.question_id!;
    const d = await detail(t, qid);
    expect(d.question.origin_type).toBe('generated');
    expect(d.question.origin_label_ar).toBe(GENERATED_ORIGIN_LABEL_AR);
    expect(d.question.origin_label_ar).not.toMatch(/مصدر الأسئلة|امتحان سابق/);
    expect(d.question.occurrences).toHaveLength(0);
    expect(d.question.current.qtype).toBe('sba');
    expect(d.question.current.correct_option_ids).toHaveLength(1);
    expect(plain(d.question.current.options.find((o) => o.id === d.question.current.correct_option_ids![0])!.text)).toBe('Pregnancy test (β-hCG)');
    expect(d.question.current.answer_status).toBe('ai_derived');
    // the independent validator solved it WITHOUT the key and found exactly one defensible option
    const v = ai.callsFor('validate_question')[0]!;
    expect(v.prompt).not.toContain('best_answer');
    expect(v.prompt).not.toContain('Ectopic pregnancy is included in the differential diagnosis.');
    // the vault lists it among generated questions only
    const gen = ((await api(t).get('/api/questions?origin=generated&limit=50')).json() as { items: Array<{ id: string }> }).items.map((i) => i.id);
    const src = ((await api(t).get('/api/questions?origin=source&limit=50')).json() as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(gen).toContain(qid);
    expect(src).not.toContain(qid);
  });

  it('in an exam it is announced as generated (source items only as «سؤال من مصادر أسئلتك»); after finishing its evidence opens in full — lecture only', async () => {
    const a1 = questionAt(t, t.qs.sourceId, 'A', '1');
    const s = await exam(t, { mode: 'exam', count: 2, question_ids: [qid, a1], origin_mix: { source: 1, generated: 1 } });
    expect(s.exam.build!.by_origin.generated).toBe(1);
    const g = s.items.find((i) => i.question_id === qid)!;
    const o = s.items.find((i) => i.question_id === a1)!;
    expect(g.origin_type).toBe('generated');
    expect(g.origin_label_ar).toBe(GENERATED_ORIGIN_LABEL_AR);
    expect(o.origin_label_ar).toBe('سؤال من مصادر أسئلتك');
    expect(JSON.stringify(g)).not.toMatch(/claim|evidence|explanation|Ectopic pregnancy is included/);
    expect((await feedback(t, s.attempt.id, g.index)).status).toBe(409);

    await finishExam(t, s, (it) => (it.question_id === qid ? 'Pregnancy test' : "McBurney's point"));
    const fb = (await feedback(t, s.attempt.id, g.index)).body as AttemptFeedbackView;
    expect(fb.is_correct).toBe(true);
    expect(fb.origin_type).toBe('generated');
    expect(fb.origin_label_ar).toBe(GENERATED_ORIGIN_LABEL_AR);
    expect(fb.occurrences).toHaveLength(0);
    expect(Object.keys(fb.distractor_explanations ?? {})).toHaveLength(3);
    const claims = Object.values(fb.claims);
    expect(claims.length).toBeGreaterThanOrEqual(5);
    for (const c of claims) {
      expect(c.verification_status).toBe('linked');
      expect(c.citations.length).toBeGreaterThan(0);
      for (const cit of c.citations) {
        expect(cit.evidence.version_id).toBe(t.lecture.versionId); // nothing from outside the lecture (Source Lock)
        const ev = await api(t).get(`/api/evidence/${cit.evidence.id}`);
        expect(ev.statusCode).toBe(200);
        expect((ev.json() as { evidence: EvidenceView }).evidence.page_id).toBeTruthy();
      }
    }
  });
});

describe('AC-18: what may never be published', () => {
  it('two answers («BC») or two defensible options → repaired, else review; never published', async () => {
    const before = generatedCount();
    ai.calls.length = 0;
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [question(req.prompt, { best: 'BC' })] }))
      .on('validate_question', () => ({ ...VALID, defensible_options: ['B', 'C'], verdict: 'invalid' }))
      .on('verify_support', allSupported);
    const run = await generate(request());
    expect(run.status).toBe('needs_review');
    expect(run.candidates[0]!.status).toBe('needs_review');
    expect(run.candidates[0]!.issues.map((i) => i.check)).toContain('single_best_answer');
    expect(ai.callsFor('generate_questions')).toHaveLength(3); // generation + 2 bounded repairs
    expect(generatedCount()).toBe(before);
    expect(reviewItems(run.id)).toBe(1);
    // a key that the validator can defend but with a second defensible option
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [question(req.prompt)] }));
    const run2 = await generate(request());
    expect(run2.candidates[0]!.status).toBe('needs_review');
    expect(run2.candidates[0]!.issues.some((i) => i.check === 'single_best_answer' && /أكثر من خيار/.test(i.reason_ar))).toBe(true);
    expect(generatedCount()).toBe(before);
  });

  it('knowledge from outside the material written WITHOUT a claim (EN and AR) is never published', async () => {
    const before = generatedCount();
    const outside: Array<{ where: 'explanation' | 'distractor'; text: string }> = [
      { where: 'explanation', text: 'In pregnant women CT abdomen is the first test to order.' },
      { where: 'distractor', text: 'Serum amylase is the most specific marker of appendiceal perforation.' },
      { where: 'explanation', text: 'الزائدة الملتهبة لا تحتاج جراحة عند النساء الحوامل.' },
    ];
    for (const o of outside) {
      ai.calls.length = 0;
      ai.on('generate_questions', (req) => {
        const base = question(req.prompt);
        const extra: Sentence = { text: o.text, claim: null };
        return {
          abstain: null,
          questions: [o.where === 'explanation' ? { ...base, explanation: [...base.explanation, extra] } : question(req.prompt, { distractorA: [...base.distractors[0]!.explanation, extra] })],
        };
      })
        .on('validate_question', () => VALID)
        .on('verify_support', allSupported);
      const run = await generate(request());
      expect(run.candidates[0]!.status, o.text).toBe('needs_review');
      expect(run.candidates[0]!.issues.some((i) => i.check === 'evidence_supported' && i.reason_ar.includes('بلا دليل')), o.text).toBe(true);
      expect(generatedCount(), o.text).toBe(before);
      // and the sentence is nowhere in a published explanation
      const published = t.ctx.db.all<{ explanation_json: string | null; distractor_explanations_json: string | null }>(
        `SELECT v.explanation_json, v.distractor_explanations_json FROM question_version v JOIN question q ON q.id = v.question_id WHERE q.origin_type = 'generated'`,
      );
      for (const p of published) expect(`${p.explanation_json}${p.distractor_explanations_json}`, o.text).not.toContain(o.text.slice(0, 30));
    }
  });

  it('a short connective phrase without a claim is fine (control): the question is published', async () => {
    ai.on('generate_questions', (req) => {
      const base = question(req.prompt);
      return { abstain: null, questions: [{ ...base, explanation: [{ text: "Let's see why.", claim: null }, ...base.explanation] }] };
    })
      .on('validate_question', () => VALID)
      .on('verify_support', allSupported);
    const run = await generate(request());
    expect(run.status).toBe('completed');
    expect(run.candidates[0]!.status).toBe('published');
  });

  it('not enough material for the difficulty → abstains with a suggestion; the generator is never asked', async () => {
    ai.calls.length = 0;
    ai.on('generate_questions', (req: ProviderRequest) => {
      throw new Error(`the generator must not be asked: ${req.task}`);
    });
    const run = await generate({ lecture_source_id: t.lecture.sourceId, topic: 'mesenteric adenitis', count: 1, difficulty: 'very_hard' });
    expect(run.status, run.summary_ar).toBe('abstained');
    expect(run.abstain?.reason).toBe('insufficient_evidence');
    expect(run.abstain?.reason_ar).toBe('الأدلة في النطاق لا تكفي لسؤال بهذه الصعوبة');
    expect(run.abstain?.suggestion_ar).toContain('لا يُكمَل نقص المادة من ذاكرة النموذج');
    expect(ai.callsFor('generate_questions')).toHaveLength(0);
  });

  it('a topic the lecture does not cover → abstains; the generator is never asked', async () => {
    ai.calls.length = 0;
    const run = await generate({ lecture_source_id: t.lecture.sourceId, topic: 'thyroid storm propylthiouracil dosing', count: 1, difficulty: 'hard' });
    expect(run.status).toBe('abstained');
    expect(ai.callsFor('generate_questions')).toHaveLength(0);
  });
});
