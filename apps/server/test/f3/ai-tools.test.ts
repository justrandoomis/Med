// Track F3 AI-gated study tools, end-to-end on the Golden Set (real upload → processing → extraction → matching) with
// the TEST-ONLY scripted provider (never registered in production): Create MCQ from a selection (published / review
// queue / abstain), derived translations & paraphrases (key and option ids unchanged, original kept, validated), the
// generated simulation following the owner's Exam DNA (labelled, generated items only), interactive flowcharts /
// timelines (schema + claim chips, unsupported parts removed), and the Vision step (a derived reading that stays
// uncertain and unusable as a fixed answer until the owner reviews it; the source region never changes).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GENERATED_ORIGIN_LABEL_AR,
  REORGANIZED_DIAGRAM_LABEL_AR,
  SIMULATION_NOTICE_AR,
  type ExamSessionView,
  type FigureReadingsResponse,
  type FigureReadingView,
  type GenerateQuestionsResponse,
  type GenerationRunView,
  type QuestionDerivationView,
  type QuestionDetailResponse,
  type SimulationPlanView,
  type SimulationRunView,
  type StudyDiagramView,
} from '@medlevo/shared';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { aliasWith, allSupported, api, createExam, createExamApp, evidenceIn, pageId, questionAt, ScriptedAi, type ExamApp } from '../exams/helpers';

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
const VALID = { chosen_option: 'B', defensible_options: ['B'], answerable_from_evidence: true, clue_issues: [], issues: [], verdict: 'valid' };
const isDerive = (req: ProviderRequest) => req.system.includes('DERIVED version');
const isEquivalence = (req: ProviderRequest) => req.system.includes('independent reviewer') && req.prompt.includes('DERIVED VERSION');

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

/** A valid question built from whatever evidence the request carries (each explanation sentence IS an excerpt). */
function genericQuestion(prompt: string, i: number) {
  const ev = [...evidenceIn(prompt).entries()].filter(([, q]) => q.trim().length >= 30).slice(0, 4);
  if (ev.length < 4) throw new Error(`generic question needs 4 excerpts, got ${ev.length}`);
  const s = (k: number) => ({ text: ev[k]![1].trim(), claim: { support_type: 'directly_stated', evidence: [ev[k]![0]] } });
  return {
    item_type: 'investigation',
    learning_objective: `Simulation item ${i + 1}: apply the lecture's statements to a presentation.`,
    concepts: ['acute appendicitis'],
    difficulty_est: 'hard',
    stem: STEM.replace('28-year-old', `${28 + i}-year-old`),
    options: [
      { key: 'A', text: `Serum amylase level` },
      { key: 'B', text: `Pregnancy test (β-hCG)` },
      { key: 'C', text: `Barium enema study` },
      { key: 'D', text: `Upper GI endoscopy` },
    ],
    best_answer: 'B',
    explanation: [s(0)],
    distractors: [
      { option: 'A', explanation: [s(1)] },
      { option: 'C', explanation: [s(2)] },
      { option: 'D', explanation: [s(3)] },
    ],
  };
}

async function generate(body: Record<string, unknown>): Promise<GenerationRunView> {
  const res = await api(t).post('/api/exams/generate', body);
  if (res.statusCode !== 200) throw new Error(`generate failed ${res.statusCode} ${res.body}`);
  await t.ctx.jobs.drain();
  return ((await api(t).get(`/api/exams/generate/${(res.json() as GenerateQuestionsResponse).run.id}`)).json() as GenerateQuestionsResponse).run;
}

const regionWith = (versionId: string, pageIndex: number, needle: string): string => {
  const r = t.ctx.db.get<{ id: string }>(
    `SELECT r.id FROM source_region r JOIN source_page p ON p.id = r.page_id WHERE r.version_id = ? AND p.page_index = ? AND r.text LIKE ? ORDER BY length(r.text) LIMIT 1`,
    [versionId, pageIndex, `%${needle}%`],
  );
  if (!r) throw new Error(`no region with «${needle}»`);
  return r.id;
};
const reviewItems = (entityType: string, id: string) =>
  t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_queue_item WHERE entity_type = ? AND entity_id = ? AND status = 'open'`, [entityType, id])!.n;

// ───────────────────────────── Create MCQ from a selection (§30) ─────────────────────────────
describe('Create MCQ from a reader selection (§30, §37–§38)', () => {
  it('published: the selection is the retrieval focus, the scope stays lecture-only, the question is generated and labelled', async () => {
    ai.calls.length = 0;
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [goodQuestion(req.prompt)] }))
      .on('validate_question', () => VALID)
      .on('verify_support', allSupported);
    const page = pageId(t, t.lecture.versionId, 1);
    const region = regionWith(t.lecture.versionId, 1, 'pregnancy test');
    const run = await generate({
      lecture_source_id: t.lecture.sourceId,
      anchor: { page_id: page, region_ids: [region], quote: 'A pregnancy test (β-hCG) is required in women of reproductive age.' },
      count: 1,
      difficulty: 'hard',
      item_types: ['investigation'],
    });
    expect(run.status).toBe('completed');
    expect(run.request.origin).toBe('selection');
    expect(run.request.anchor).toMatchObject({ page_id: page, region_ids: [region] });
    expect(run.scope_describe_ar).toContain('المحاضرة فقط');
    expect(run.candidates[0]!.status).toBe('published');
    // the selected region is handed to the generator (anchor first), the instruction names the selected passage
    const g = ai.callsFor('generate_questions')[0]!;
    expect([...evidenceIn(g.prompt).values()][0]).toMatch(/pregnancy test/i);
    expect(g.prompt).toMatch(/selected/i);
    const q = (await api(t).get(`/api/questions/${run.candidates[0]!.question_id}`)).json().question;
    expect(q.origin_type).toBe('generated');
    expect(q.origin_label_ar).toBe(GENERATED_ORIGIN_LABEL_AR);
    expect(q.current.answer_status).toBe('ai_derived');
  });

  it('validation failure (a citation the server never handed out) → bounded repairs → review queue, never published', async () => {
    ai.on('generate_questions', (req) => ({ abstain: null, questions: [goodQuestion(req.prompt, { badAlias: true })] }))
      .on('validate_question', () => VALID)
      .on('verify_support', allSupported);
    const before = t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM question WHERE origin_type = 'generated'`)!.n;
    const run = await generate({
      lecture_source_id: t.lecture.sourceId,
      anchor: { page_id: pageId(t, t.lecture.versionId, 1), quote: 'A pregnancy test (β-hCG) is required in women of reproductive age.' },
      count: 1,
      difficulty: 'hard',
    });
    expect(run.status).toBe('needs_review');
    const c = run.candidates[0]!;
    expect(c.status).toBe('needs_review');
    expect(c.question_id).toBeNull();
    expect(c.rounds).toBe(3);
    expect(reviewItems('generated_question_candidate', c.id)).toBe(1);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM question WHERE origin_type = 'generated'`)!.n).toBe(before);
  });

  it('abstains when the selected passage cannot support a valid question: nothing is published or queued', async () => {
    ai.calls.length = 0;
    ai.on('generate_questions', () => ({ abstain: { reason: 'insufficient_evidence', detail: 'The selected caption does not state a testable fact.' }, questions: [] }));
    const before = t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM question WHERE origin_type = 'generated'`)!.n;
    const run = await generate({
      lecture_source_id: t.lecture.sourceId,
      anchor: { page_id: pageId(t, t.lecture.versionId, 3), quote: 'Figure 1: Management pathway by Alvarado score (synthetic diagram).' },
      count: 1,
      difficulty: 'hard',
    });
    expect(run.status).toBe('abstained');
    expect(run.abstain!.reason_ar).toMatch(/امتنع المولّد/);
    expect(run.abstain!.suggestion_ar).toMatch(/لا يُكمَل نقص المادة من ذاكرة النموذج/);
    expect(run.candidates).toEqual([]);
    // AC-08: the diagram labels read by OCR on that page are never handed to the generator for a fixed answer
    const prompt = ai.callsFor('generate_questions')[0]!.prompt;
    expect(prompt).not.toMatch(/Score\s*[≥≤]/);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM question WHERE origin_type = 'generated'`)!.n).toBe(before);
  });

  it('Source Lock: a selection on another source / version → 409; an empty selection → 400', async () => {
    const other = pageId(t, t.qs.versionId, 0);
    const res = await api(t).post('/api/exams/generate', { lecture_source_id: t.lecture.sourceId, anchor: { page_id: other, quote: 'Which point is classically tender' }, count: 1, difficulty: 'hard' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('OUT_OF_SCOPE');
    const foreignRegion = t.ctx.db.get<{ id: string }>(`SELECT id FROM source_region WHERE version_id = ? AND text IS NOT NULL LIMIT 1`, [t.qs.versionId])!.id;
    const res2 = await api(t).post('/api/exams/generate', {
      lecture_source_id: t.lecture.sourceId,
      anchor: { page_id: pageId(t, t.lecture.versionId, 1), region_ids: [foreignRegion] },
      count: 1,
      difficulty: 'hard',
    });
    expect(res2.statusCode).toBe(409);
    const empty = await api(t).post('/api/exams/generate', { lecture_source_id: t.lecture.sourceId, anchor: { page_id: pageId(t, t.lecture.versionId, 1), quote: '  ' }, count: 1, difficulty: 'hard' });
    expect(empty.statusCode).toBe(400);
  });
});

// ───────────────────────────── derived versions (§35, §37) ─────────────────────────────
function optionLines(prompt: string): Array<{ key: string; text: string }> {
  const block = prompt.split('ORIGINAL QUESTION')[1] ?? '';
  return [...block.matchAll(/^\[(o\d+)\] (.*)$/gm)].map((m) => ({ key: m[1]!, text: m[2]! }));
}

async function derive(questionId: string, body: Record<string, unknown>): Promise<QuestionDerivationView> {
  const res = await api(t).post(`/api/questions/${questionId}/derived`, body);
  if (res.statusCode !== 200) throw new Error(`derive failed ${res.statusCode} ${res.body}`);
  await t.ctx.jobs.drain();
  const d = (res.json() as { derivation: QuestionDerivationView }).derivation;
  return ((await api(t).get(`/api/questions/derivations/${d.id}`)).json() as { derivation: QuestionDerivationView }).derivation;
}

const EQUIVALENT = { equivalent: true, options_equivalent: true, negation_preserved: true, numbers_units_preserved: true, issues: [] };

describe('derived question versions — translation / paraphrase (§35, §37)', () => {
  it('a translation is published as a DERIVED version: the original stays current, option ids and key are unchanged', async () => {
    const qid = questionAt(t, t.qs.sourceId, 'A', '4'); // «a white cell count of 11.5 ×10⁹/L»
    const before = (await api(t).get(`/api/questions/${qid}`)).json() as QuestionDetailResponse;
    const original = before.question.current;
    ai.calls.length = 0;
    ai.on('generate_questions', (req) => {
      expect(isDerive(req)).toBe(true);
      const opts = optionLines(req.prompt);
      const ar: Record<string, string> = { o1: 'يؤكد التشخيص', o2: 'يدعم التشخيص لكنه لا يؤكده', o3: 'ينفي التشخيص', o4: 'يدل على حدوث انثقاب' };
      return { abstain: null, stem: 'عند الاشتباه بالتهاب الزائدة، فإن عدد كريات بيض قدره 11.5 ×10⁹/L:', options: opts.map((o) => ({ option_key: o.key, text: ar[o.key] ?? o.text })) };
    }).on('validate_question', (req) => {
      expect(isEquivalence(req)).toBe(true);
      return EQUIVALENT;
    });
    const d = await derive(qid, { kind: 'translation', lang: 'ar' });
    expect(d.status).toBe('published');
    expect(d.issues).toEqual([]);
    const v = d.derived!;
    expect(v.kind).toBe('translation');
    expect(v.lang).toBe('ar');
    expect(v.label_ar).toBe('ترجمة مشتقة (العربية)');
    expect(v.notice_ar).toMatch(/ليست نص السؤال الأصلي ولا تُنسب إلى امتحان سابق/);
    expect(v.derived_from_version_id).toBe(original.id);
    expect(v.from_current).toBe(true);
    // option identity: the ORIGINAL ids, in the same order, under the same keys; the key is the same option key
    expect(v.options.map((o) => o.id)).toEqual(original.options.map((o) => o.id));
    expect(v.options.map((o) => o.option_key)).toEqual(original.options.map((o) => o.option_key));
    const keyOf = (ids: string[] | null) => (ids ?? []).map((id) => original.options.find((o) => o.id === id)!.option_key);
    expect(v.correct_option_keys).toEqual(keyOf(original.correct_option_ids));
    expect(v.answer_status).toBe(original.answer_status);
    // the model never saw the key
    const g = ai.callsFor('generate_questions')[0]!;
    expect(g.prompt).not.toMatch(/answer key|correct option|best_answer/i);
    // the original is untouched and still the question
    const after = (await api(t).get(`/api/questions/${qid}`)).json() as QuestionDetailResponse;
    expect(after.question.current.id).toBe(original.id);
    expect(after.question.current.stem).toEqual(original.stem);
    expect(after.versions.some((x) => x.kind === 'translation' && x.created_by === 'translation')).toBe(true);
    // a new exam still pins the ORIGINAL version
    const exam = await createExam(t, { mode: 'practice', count: 1, question_ids: [qid] });
    expect(exam.session.items[0]!.question_version_id).toBe(original.id);
    // asking again returns the same derivation (no second model call)
    const calls = ai.calls.length;
    const again = (await api(t).post(`/api/questions/${qid}/derived`, { kind: 'translation', lang: 'ar' })).json().derivation as QuestionDerivationView;
    expect(again.id).toBe(d.id);
    expect(ai.calls.length).toBe(calls);
  });

  it('a dropped negation (NOT) is caught deterministically → needs review + review queue, never a version; the reviewer is not asked', async () => {
    const qid = questionAt(t, t.qs.sourceId, 'A', '2'); // «… is NOT typically part of the Alvarado score?»
    const versionsBefore = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM question_version WHERE question_id = ?', [qid])!.n;
    ai.calls.length = 0;
    ai.on('generate_questions', (req) => ({
      abstain: null,
      stem: 'أيٌّ مما يلي جزء من Alvarado score عادةً؟',
      options: optionLines(req.prompt).map((o) => ({ option_key: o.key, text: o.text })),
    })).on('validate_question', () => {
      throw new Error('the reviewer must not be asked after a deterministic failure');
    });
    const d = await derive(qid, { kind: 'translation', lang: 'ar' });
    expect(d.status).toBe('needs_review');
    expect(d.derived).toBeNull();
    expect(d.issues.map((i) => i.check)).toContain('negation_preserved');
    expect(reviewItems('question_derivation', d.id)).toBe(1);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM question_version WHERE question_id = ?', [qid])!.n).toBe(versionsBefore);
  });

  it('the independent reviewer finds a meaning change in a paraphrase → needs review, nothing published', async () => {
    const qid = questionAt(t, t.qs.sourceId, 'A', '1');
    ai.on('generate_questions', (req) => ({
      abstain: null,
      stem: 'In acute appendicitis, which point is classically the most tender on examination?',
      options: optionLines(req.prompt).map((o) => ({ option_key: o.key, text: o.text })),
    })).on('validate_question', () => ({ ...EQUIVALENT, equivalent: false, options_equivalent: false, issues: ['«most tender» changes the qualifier'] }));
    const d = await derive(qid, { kind: 'paraphrase' });
    expect(d.status).toBe('needs_review');
    expect(d.issues.map((i) => i.by)).toEqual(expect.arrayContaining(['validator']));
    expect(d.derived).toBeNull();
    const list = (await api(t).get(`/api/questions/${qid}/derived`)).json();
    expect(list.can_derive.available).toBe(true);
    expect(list.derivations[0].status).toBe('needs_review');
  });
});

// ───────────────────────────── generated simulation (§40) ─────────────────────────────
describe('generated simulation following the owner\'s Exam DNA (§40)', () => {
  let plan: SimulationPlanView;

  it('the plan follows the sample with denominators and is labelled «محاكاة مولدة»', async () => {
    const res = await api(t).post('/api/exams/simulations/preview', { count: 3, difficulty: 'hard' });
    expect(res.statusCode).toBe(200);
    plan = (res.json() as { plan: SimulationPlanView }).plan;
    expect(plan.notice_ar).toBe(SIMULATION_NOTICE_AR);
    expect(plan.sample.unique_questions).toBeGreaterThan(0);
    expect(plan.buckets.reduce((a, b) => a + b.count, 0)).toBe(3);
    for (const b of plan.buckets) {
      expect(b.lecture_source_id).toBe(t.lecture.sourceId);
      expect(b.share.denominator).toBe(plan.sample.unique_questions);
      expect(b.share.unique).toBeGreaterThan(0);
      expect(b.topic.length).toBeGreaterThan(0);
    }
    expect(plan.counting_note_ar).toMatch(/ليس احتمال ظهور/);
    expect(plan.can_generate.available).toBe(true);
  });

  it('a course simulation uses that course’s lectures only (a sample question linked to another course’s lecture)', async () => {
    const inCourse = (await api(t).post('/api/exams/simulations/preview', { count: 3, difficulty: 'hard', course_node_id: t.course })).json().plan as SimulationPlanView;
    expect(inCourse.buckets.map((b) => b.lecture_source_id)).toContain(t.lecture.sourceId);
    // the same lecture filed under another course: excluded from this course's plan, with the reason
    const before = t.ctx.db.get<{ course_node_id: string | null; node_id: string | null; subject_node_id: string | null }>('SELECT course_node_id, node_id, subject_node_id FROM source WHERE id = ?', [t.lecture.sourceId])!;
    t.ctx.db.run('UPDATE source SET course_node_id = NULL, node_id = NULL, subject_node_id = NULL WHERE id = ?', [t.lecture.sourceId]);
    try {
      const other = (await api(t).post('/api/exams/simulations/preview', { count: 3, difficulty: 'hard', course_node_id: t.course })).json().plan as SimulationPlanView;
      expect(other.buckets).toEqual([]);
      expect(other.excluded).toContainEqual(expect.objectContaining({ lecture_source_id: t.lecture.sourceId, reason_ar: 'المحاضرة خارج الكورس المختار.' }));
      expect(other.can_generate.available).toBe(false);
    } finally {
      t.ctx.db.run('UPDATE source SET course_node_id = ?, node_id = ?, subject_node_id = ? WHERE id = ?', [before.course_node_id, before.node_id, before.subject_node_id, t.lecture.sourceId]);
    }
  });

  it('generates each part through the regular pipeline and assembles an exam of generated items only (mode simulation)', async () => {
    ai.on('generate_questions', (req) => {
      const n = Number(/Write (\d+) single-best-answer/.exec(req.prompt)?.[1] ?? 1);
      return { abstain: null, questions: Array.from({ length: n }, (_, i) => genericQuestion(req.prompt, i)) };
    })
      .on('validate_question', () => VALID)
      .on('verify_support', allSupported);
    const res = await api(t).post('/api/exams/simulations', { count: 3, difficulty: 'hard', minutes: 30 });
    expect(res.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const sim = ((await api(t).get(`/api/exams/simulations/${res.json().simulation.id}`)).json() as { simulation: SimulationRunView }).simulation;
    expect(sim.status, sim.summary_ar).toBe('completed');
    expect(sim.label_ar).toBe('محاكاة مولدة');
    expect(sim.parts.every((p) => p.run_id && p.status === 'completed')).toBe(true);
    expect(sim.exam).not.toBeNull();
    expect(sim.exam!.items).toBe(3);
    expect(sim.exam!.generated_items).toBe(3);
    for (const p of sim.parts) {
      const run = ((await api(t).get(`/api/exams/generate/${p.run_id}`)).json() as GenerateQuestionsResponse).run;
      expect(run.request.origin).toBe('simulation');
      expect(run.scope_describe_ar).toContain('المحاضرة فقط');
    }
    const session = (await api(t).get(`/api/exams/attempts/${sim.exam!.attempt_id}`)).json() as ExamSessionView;
    expect(session.exam.mode).toBe('simulation');
    expect(session.exam.is_generated_simulation).toBe(true);
    expect(session.exam.title).toMatch(/محاكاة مولدة/);
    expect(session.exam.policy.hints).toBe('off');
    expect(session.items.every((i) => i.origin_type === 'generated')).toBe(true);
    expect(session.items.every((i) => i.scored)).toBe(true);
    // listed with the others
    const list = (await api(t).get('/api/exams/simulations')).json() as { simulations: SimulationRunView[] };
    expect(list.simulations.some((s) => s.id === sim.id)).toBe(true);
  });

  it('when nothing passes the checks: «abstained», no exam is assembled, the summary says why', async () => {
    ai.on('generate_questions', () => ({ abstain: { reason: 'insufficient_evidence', detail: 'not enough evidence' }, questions: [] }));
    const res = await api(t).post('/api/exams/simulations', { count: 2, difficulty: 'hard' });
    await t.ctx.jobs.drain();
    const sim = ((await api(t).get(`/api/exams/simulations/${res.json().simulation.id}`)).json() as { simulation: SimulationRunView }).simulation;
    expect(sim.status).toBe('abstained');
    expect(sim.exam).toBeNull();
    expect(sim.summary_ar).toMatch(/لم يجتز أي سؤال/);
  });
});

// ───────────────────────────── timelines & flowcharts (§31) ─────────────────────────────
async function diagram(body: Record<string, unknown>): Promise<StudyDiagramView> {
  const res = await api(t).post('/api/studybook/diagrams', body);
  if (res.statusCode !== 200) throw new Error(`diagram failed ${res.statusCode} ${res.body}`);
  return (res.json() as { diagram: StudyDiagramView }).diagram;
}

function imagingFlowchart(prompt: string, opts: { badCt?: boolean; oneBranch?: boolean } = {}) {
  const us = aliasWith(prompt, 'Ultrasound is the first-line');
  const ct = opts.badCt ? 'E77' : aliasWith(prompt, 'CT abdomen is preferred');
  const st = (text: string, alias: string) => ({ text, claim: { support_type: 'directly_stated', evidence: [alias] } });
  const edges = [
    { from: 'N1', to: 'N2', label: 'children / pregnant women', statement: st('Ultrasound is the first-line imaging test in children and in pregnant women.', us) },
    { from: 'N1', to: 'N3', label: 'adults, diagnosis still uncertain', statement: st('CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.', ct) },
  ];
  return {
    abstain: null,
    title: 'Imaging in suspected appendicitis',
    nodes: [
      { key: 'N1', label: 'Imaging choice', kind: 'decision', order: null, time_label: null, statement: st('Ultrasound is the first-line imaging test in children and in pregnant women.', us) },
      { key: 'N2', label: 'Ultrasound', kind: 'outcome', order: null, time_label: null, statement: st('Ultrasound is the first-line imaging test in children and in pregnant women.', us) },
      { key: 'N3', label: 'CT abdomen', kind: 'outcome', order: null, time_label: null, statement: st('CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.', ct) },
    ],
    edges: opts.oneBranch ? [edges[0]!] : edges,
  };
}

describe('interactive flowcharts & timelines (§31)', () => {
  it('a flowchart: every node and edge carries a verified claim (chips), directions kept, labelled re-organized; repeated → cached', async () => {
    ai.calls.length = 0;
    ai.on('summarize', (req) => imagingFlowchart(req.prompt)).on('verify_support', allSupported);
    const page = pageId(t, t.lecture.versionId, 1);
    const d = await diagram({ kind: 'flowchart', source_id: t.lecture.sourceId, page_ids: [page] });
    expect(d.status).toBe('published');
    expect(d.label_ar).toBe(REORGANIZED_DIAGRAM_LABEL_AR);
    expect(d.kind_label_ar).toBe('مخطط انسيابي');
    expect(d.scope_describe_ar).toContain('المحاضرة فقط');
    expect(d.nodes.map((n) => n.key)).toEqual(['N1', 'N2', 'N3']);
    expect(d.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['N1>N2', 'N1>N3']);
    expect(d.edges[1]!.label).toBe('adults, diagnosis still uncertain');
    for (const x of [...d.nodes, ...d.edges]) {
      expect(x.claim_ids).toHaveLength(1);
      expect(x.verification).toBe('linked');
      const c = d.claims[x.claim_ids[0]!]!;
      expect(c.verification_status).toBe('linked');
      expect(c.citations[0]!.evidence.source_id).toBe(t.lecture.sourceId);
    }
    expect(d.removed).toEqual([]);
    expect(d.stale_reason_ar).toBeNull();
    const calls = ai.callsFor('summarize').length;
    const again = await diagram({ kind: 'flowchart', source_id: t.lecture.sourceId, page_ids: [page] });
    expect(again.id).toBe(d.id);
    expect(again.cached).toBe(true);
    expect(ai.callsFor('summarize').length).toBe(calls);
    const list = (await api(t).get(`/api/studybook/diagrams?source_id=${t.lecture.sourceId}`)).json();
    expect(list.diagrams[0].id).toBe(d.id);
  });

  it('a node whose citation the server never handed out is removed WITH its edges (listed with the reason)', async () => {
    ai.on('summarize', (req) => imagingFlowchart(req.prompt, { badCt: true }));
    const d = await diagram({ kind: 'flowchart', source_id: t.lecture.sourceId, page_ids: [pageId(t, t.lecture.versionId, 1)], force: true });
    expect(d.status).toBe('published');
    expect(d.nodes.map((n) => n.key)).toEqual(['N1', 'N2']);
    expect(d.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['N1>N2']);
    expect(d.removed.length).toBeGreaterThanOrEqual(2);
    expect(Object.values(d.claims).every((c) => c.citations.every((x) => x.evidence.id))).toBe(true);
  });

  it('an incoherent structure (a decision with one branch) is refused as a whole — nothing is shown', async () => {
    ai.on('summarize', (req) => imagingFlowchart(req.prompt, { oneBranch: true }));
    const d = await diagram({ kind: 'flowchart', source_id: t.lecture.sourceId, page_ids: [pageId(t, t.lecture.versionId, 1)], force: true });
    expect(d.status).toBe('failed');
    expect(d.nodes).toEqual([]);
    expect(d.abstain!.detail).toMatch(/فرعين/);
  });

  it('a timeline keeps the order of its events; the model\'s abstention is shown as such', async () => {
    ai.on('summarize', (req) => {
      const pain = aliasWith(req.prompt, 'periumbilical region');
      const st = (text: string) => ({ text, claim: { support_type: 'directly_stated', evidence: [pain] } });
      return {
        abstain: null,
        title: 'Course of pain',
        nodes: [
          { key: 'N2', label: 'Pain in RIF', kind: 'event', order: 2, time_label: 'later', statement: st('later migrates to the right iliac fossa') },
          { key: 'N1', label: 'Periumbilical pain', kind: 'event', order: 1, time_label: null, statement: st('Pain usually begins in the periumbilical region') },
        ],
        edges: [],
      };
    });
    const d = await diagram({ kind: 'timeline', source_id: t.lecture.sourceId, page_ids: [pageId(t, t.lecture.versionId, 0)] });
    expect(d.status).toBe('published');
    expect(d.kind_label_ar).toBe('خط زمني');
    expect(d.nodes.map((n) => n.key)).toEqual(['N1', 'N2']);
    expect(d.nodes[1]!.time_label).toBe('later');
    ai.on('summarize', () => ({ abstain: { reason: 'insufficient_evidence', detail: 'no sequence in the evidence' }, title: '', nodes: [], edges: [] }));
    const ab = await diagram({ kind: 'timeline', source_id: t.lecture.sourceId, topic: 'Alvarado score', force: true });
    expect(ab.status).toBe('abstained');
    expect(ab.abstain!.reason).toBe('insufficient_evidence');
    expect(ab.nodes).toEqual([]);
  });

  it('Source Lock: pages of another source → 409', async () => {
    const res = await api(t).post('/api/studybook/diagrams', { kind: 'flowchart', source_id: t.lecture.sourceId, page_ids: [pageId(t, t.qs.versionId, 0)] });
    expect(res.statusCode).toBe(409);
  });
});

// ───────────────────────────── the Vision step (§13, §14, AC-08) ─────────────────────────────
describe('Vision step for a figure: a derived reading, uncertain and unusable as a fixed answer until reviewed (AC-08)', () => {
  const figure = () => t.ctx.db.get<{ id: string }>(`SELECT id FROM source_region WHERE version_id = ? AND kind = 'figure' ORDER BY reading_order LIMIT 1`, [t.lecture.versionId])!.id;
  const diagramRegion = (fig: string) => t.ctx.db.get<{ id: string; structure_json: string; status: string; text: string | null }>(`SELECT id, structure_json, status, text FROM source_region WHERE parent_region_id = ? AND kind = 'diagram'`, [fig])!;
  const reading = (out: Record<string, unknown>) => () => out;
  const FLOW = {
    figure_kind: 'flowchart',
    direction: 'top_down',
    nodes: [
      { id: 'n1', label: 'Suspected appendicitis', certainty: 'clear', bbox: null },
      { id: 'n2', label: 'Alvarado score', certainty: 'clear', bbox: null },
      { id: 'n3', label: 'Score ≥ 7 · Surgical review', certainty: 'clear', bbox: null },
      { id: 'n4', label: 'Observe, re-assess', certainty: 'uncertain', bbox: null },
    ],
    edges: [
      { from: 'n1', to: 'n2', label: null, certainty: 'clear' },
      { from: 'n2', to: 'n3', label: null, certainty: 'clear' },
      { from: 'n2', to: 'n4', label: null, certainty: 'clear' },
      { from: 'n2', to: 'n7', label: null, certainty: 'clear' },
    ],
    notes: [],
  };

  async function analyze(regionId: string): Promise<FigureReadingView> {
    const res = await api(t).post(`/api/processing/figures/${regionId}/analyze`, {});
    if (res.statusCode !== 200) throw new Error(`analyze failed ${res.statusCode} ${res.body}`);
    await t.ctx.jobs.drain();
    return ((await api(t).get(`/api/processing/figure-readings/${res.json().reading.id}`)).json() as { reading: FigureReadingView }).reading;
  }

  it('reads the structure on demand into a DERIVED uncertain reading; the source region is unchanged', async () => {
    const fig = figure();
    const before = diagramRegion(fig);
    ai.calls.length = 0;
    ai.on('vision_figure', reading(FLOW));
    const r = await analyze(fig);
    expect(r.status).toBe('uncertain');
    expect(r.label_ar).toMatch(/لا تُعتمد إجابةً امتحانية حتى تراجعها/);
    expect(r.usable_as_fixed_answer).toBe(false);
    expect(r.direction).toBe('top_down');
    expect(r.structure!.understanding).toBe('structure_read');
    expect(r.structure!.edges.some((e) => e.to === 'n7')).toBe(false); // an arrow to nothing is dropped, and said
    expect(r.notes_ar.join(' ')).toMatch(/سهم واحد/);
    expect(r.structure!.nodes.find((n) => n.id === 'n4')!.certainty).toBe('uncertain');
    expect(r.counts.uncertain).toBeGreaterThan(0);
    // the crop was sent with the request, inside the lecture's own lock
    const call = ai.callsFor('vision_figure')[0]!;
    expect(call.images?.length).toBe(1);
    // AC-08: the original region keeps its OCR-only structure and stays uncertain (never evidence for a fixed answer)
    const after = diagramRegion(fig);
    expect(after.structure_json).toBe(before.structure_json);
    expect(after.status).toBe(before.status);
    expect(JSON.parse(after.structure_json).edges).toEqual([]);
    const listed = (await api(t).get(`/api/processing/figures/${fig}/readings`)).json() as FigureReadingsResponse;
    expect(listed.readings[0]!.id).toBe(r.id);
    expect(listed.can_analyze.available).toBe(true);
    // the diagram child resolves to the same figure
    expect(((await api(t).get(`/api/processing/figures/${before.id}/readings`)).json() as FigureReadingsResponse).figure_region_id).toBe(fig);
  });

  it('owner review: confirm (with a corrected label) → reviewed and usable; the model reading and the source stay as they were', async () => {
    const fig = figure();
    const r = (((await api(t).get(`/api/processing/figures/${fig}/readings`)).json() as FigureReadingsResponse).readings)[0]!;
    const res = await api(t).post(`/api/processing/figure-readings/${r.id}/review`, { decision: 'confirm', nodes: [{ id: 'n3', label: 'Score ≥ 7 → surgical review' }] });
    expect(res.statusCode).toBe(200);
    const rv = res.json().reading as FigureReadingView;
    expect(rv.status).toBe('owner_reviewed');
    expect(rv.usable_as_fixed_answer).toBe(true);
    expect(rv.reviewed_structure!.nodes.find((n) => n.id === 'n3')!.label).toBe('Score ≥ 7 → surgical review');
    expect(rv.reviewed_structure!.nodes.every((n) => n.certainty === 'read')).toBe(true);
    expect(rv.structure!.nodes.find((n) => n.id === 'n3')!.label).toBe('Score ≥ 7 · Surgical review');
    expect(JSON.parse(diagramRegion(fig).structure_json).edges).toEqual([]);
    // an edge to an unknown node is refused
    const bad = await api(t).post(`/api/processing/figure-readings/${r.id}/review`, { decision: 'confirm', edges: [{ from: 'n1', to: 'n9' }] });
    expect(bad.statusCode).toBe(400);
  });

  it('a second reading can be rejected (never usable); an unreadable crop fails with its reason; non-figures are refused', async () => {
    const fig = figure();
    ai.on('vision_figure', reading(FLOW));
    const r2 = await analyze(fig);
    const rej = (await api(t).post(`/api/processing/figure-readings/${r2.id}/review`, { decision: 'reject', note: 'الأسهم غير صحيحة' })).json().reading as FigureReadingView;
    expect(rej.status).toBe('rejected');
    expect(rej.usable_as_fixed_answer).toBe(false);
    ai.on('vision_figure', reading({ figure_kind: 'unreadable', direction: 'unknown', nodes: [], edges: [], notes: [] }));
    const r3 = await analyze(fig);
    expect(r3.status).toBe('failed');
    expect(r3.structure).toBeNull();
    expect(r3.error_ar).toMatch(/غير مقروءة/);
    // a failed reading cannot be confirmed
    expect((await api(t).post(`/api/processing/figure-readings/${r3.id}/review`, { decision: 'confirm' })).statusCode).toBe(409);
    const para = t.ctx.db.get<{ id: string }>(`SELECT id FROM source_region WHERE version_id = ? AND kind IN ('paragraph','text_block') LIMIT 1`, [t.lecture.versionId])!.id;
    expect((await api(t).post(`/api/processing/figures/${para}/analyze`, {})).statusCode).toBe(400);
  });
});
