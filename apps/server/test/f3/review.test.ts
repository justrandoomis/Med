// Track F3 — regressions from the independent adversarial review (scripted TEST-ONLY provider, Golden Set):
//  * a derived translation shows the ORIGINAL's key even after that key changed in place (unattempted version, a
//    source key found later — lifecycle refresh), and its generated text never becomes a fingerprint that decides the
//    identity of a source question at extraction;
//  * a diagram's labels (node / edge / time label / title) are generated text shown outside the verified statement:
//    a value, threshold, population or negation the statement and its evidence do not carry removes the part (listed);
//  * a simulation part larger than one generation run reports ALL its runs (it showed «طُلب 6، نُشر 5» for 6 / 6);
//  * a request cannot claim to come from a simulation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QuestionDerivationView, QuestionDetailResponse, SimulationRunView, StudyDiagramView } from '@medlevo/shared';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { labelIssues } from '../../src/modules/studybook/diagrams';
import { aliasWith, allSupported, api, createExamApp, evidenceIn, pageId, questionAt, ScriptedAi, type ExamApp } from '../exams/helpers';

const ai = new ScriptedAi();
let t: ExamApp;
beforeAll(async () => {
  t = await createExamApp({ ai });
}, 300_000);
afterAll(async () => {
  await t?.close();
});

const EQUIVALENT = { equivalent: true, options_equivalent: true, negation_preserved: true, numbers_units_preserved: true, issues: [] };
const VALID = { chosen_option: 'B', defensible_options: ['B'], answerable_from_evidence: true, clue_issues: [], issues: [], verdict: 'valid' };
const optionLines = (prompt: string) => [...(prompt.split('ORIGINAL QUESTION')[1] ?? '').matchAll(/^\[(o\d+)\] (.*)$/gm)].map((m) => ({ key: m[1]!, text: m[2]! }));

describe('F3 review — derived versions keep the ORIGINAL key and never define identity', () => {
  it('the derived key follows the original key changed in place; the derived version has no fingerprint', async () => {
    const qid = questionAt(t, t.qs.sourceId, 'A', '4');
    ai.on('generate_questions', (req: ProviderRequest) => ({
      abstain: null,
      stem: 'عند الاشتباه بالتهاب الزائدة، فإن عدد كريات بيض قدره 11.5 ×10⁹/L:',
      options: optionLines(req.prompt).map((o) => ({ option_key: o.key, text: `ترجمة: ${o.text}` })),
    })).on('validate_question', () => EQUIVALENT);
    const res = await api(t).post(`/api/questions/${qid}/derived`, { kind: 'translation', lang: 'ar' });
    expect(res.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const get = async (id: string) => ((await api(t).get(`/api/questions/derivations/${id}`)).json() as { derivation: QuestionDerivationView }).derivation;
    const d0 = await get(res.json().derivation.id);
    expect(d0.status).toBe('published');
    const orig = ((await api(t).get(`/api/questions/${qid}`)).json() as QuestionDetailResponse).question.current;
    const keyOf = (ids: string[] | null) => (ids ?? []).map((id) => orig.options.find((o) => o.id === id)!.option_key);
    expect(d0.derived!.correct_option_keys).toEqual(keyOf(orig.correct_option_ids));
    // the lifecycle refresh changes the key of an UNATTEMPTED version in place (lifecycle.ts) — e.g. a key found later
    const other = orig.options.find((o) => !(orig.correct_option_ids ?? []).includes(o.id))!;
    t.ctx.db.run(`UPDATE question_version SET answer_status = 'owner_key', correct_option_ids_json = ? WHERE id = ?`, [JSON.stringify([other.id]), orig.id]);
    const d1 = await get(d0.id);
    expect(d1.derived!.from_current).toBe(true);
    expect(d1.derived!.correct_option_keys).toEqual([other.option_key]);
    expect(d1.derived!.answer_status).toBe('owner_key');
    // a generated text never matches a source question at extraction (fingerprints of ANY version are compared there)
    expect(t.ctx.db.get<{ f: string | null }>('SELECT fingerprint AS f FROM question_version WHERE id = ?', [d0.derived!.version_id])!.f).toBeNull();
    expect(t.ctx.db.get<{ f: string | null }>('SELECT fingerprint AS f FROM question_version WHERE id = ?', [orig.id])!.f).not.toBeNull();
  });
});

describe('F3 review — diagram labels may not say more than their verified statement', () => {
  it('labelIssues: values, thresholds, populations and a flipped negation are refused; plain wording / abbreviations are not', () => {
    const us = 'Ultrasound is the first-line imaging test in children and in pregnant women.';
    expect(labelIssues('children / pregnant women', [us])).toBeNull();
    expect(labelIssues('Ultrasound', [us])).toBeNull();
    expect(labelIssues('later — Pain in RIF', ['later migrates to the right iliac fossa'])).toBeNull();
    expect(labelIssues('age < 12 years', [us])).toMatch(/التسمية «age < 12 years»/);
    expect(labelIssues('Ultrasound within 2 hours', [us])).toMatch(/2/);
    expect(labelIssues('Score ≥ 9', ['Patients with an Alvarado score of 7 or more need surgical review.'])).not.toBeNull();
    expect(labelIssues('Give aspirin', ['Do not give aspirin to children with a viral illness.'])).not.toBeNull();
    expect(labelIssues('', [us])).toBeNull();
  });

  it('a node / edge whose label carries an unsupported value is removed (listed with the reason); an unsupported title falls back', async () => {
    ai.on('summarize', (req: ProviderRequest) => {
      const us = aliasWith(req.prompt, 'Ultrasound is the first-line');
      const ct = aliasWith(req.prompt, 'CT abdomen is preferred');
      const st = (text: string, alias: string) => ({ text, claim: { support_type: 'directly_stated', evidence: [alias] } });
      const US = 'Ultrasound is the first-line imaging test in children and in pregnant women.';
      const CT = 'CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.';
      return {
        abstain: null,
        title: 'Imaging within 6 hours',
        nodes: [
          { key: 'N1', label: 'Imaging choice', kind: 'decision', order: null, time_label: null, statement: st(US, us) },
          { key: 'N2', label: 'Ultrasound', kind: 'outcome', order: null, time_label: null, statement: st(US, us) },
          { key: 'N3', label: 'CT abdomen', kind: 'outcome', order: null, time_label: null, statement: st(CT, ct) },
          { key: 'N4', label: 'CT within 2 hours', kind: 'outcome', order: null, time_label: null, statement: st(CT, ct) },
        ],
        edges: [
          { from: 'N1', to: 'N2', label: 'children / pregnant women', statement: st(US, us) },
          { from: 'N1', to: 'N3', label: 'adults', statement: st(CT, ct) },
          { from: 'N2', to: 'N3', label: 'age < 12 years', statement: st(US, us) },
          { from: 'N3', to: 'N4', label: null, statement: st(CT, ct) },
        ],
      };
    }).on('verify_support', allSupported);
    const res = await api(t).post('/api/studybook/diagrams', { kind: 'flowchart', source_id: t.lecture.sourceId, page_ids: [pageId(t, t.lecture.versionId, 1)], force: true });
    expect(res.statusCode).toBe(200);
    const d = res.json().diagram as StudyDiagramView;
    expect(d.status).toBe('published');
    expect(d.nodes.map((n) => n.key)).toEqual(['N1', 'N2', 'N3']);
    expect(d.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['N1>N2', 'N1>N3']);
    expect(d.nodes.some((n) => /2 hours/.test(n.label))).toBe(false);
    expect(d.edges.some((e) => e.label === 'age < 12 years')).toBe(false);
    const removed = d.removed.map((r) => r.reason_ar).join(' | ');
    expect(removed).toMatch(/التسمية «CT within 2 hours»/);
    expect(removed).toMatch(/التسمية «age < 12 years»/);
    expect(d.title).not.toMatch(/6 hours/);
    expect(d.title).toContain('مخطط انسيابي');
  });
});

describe('F3 review — generated simulation parts and origins', () => {
  it('a part larger than one generation run reports every run (requested 6 → published 6, completed)', async () => {
    ai.on('generate_questions', (req: ProviderRequest) => {
      const n = Number(/Write (\d+) single-best-answer/.exec(req.prompt)?.[1] ?? 1);
      const ev = [...evidenceIn(req.prompt).entries()].filter(([, q]) => q.trim().length >= 30).slice(0, 4);
      const s = (k: number) => ({ text: ev[k]![1].trim(), claim: { support_type: 'directly_stated', evidence: [ev[k]![0]] } });
      const seed = ai.callsFor('generate_questions').length * 10;
      return {
        abstain: null,
        questions: Array.from({ length: n }, (_, i) => ({
          item_type: 'recall',
          learning_objective: `Simulation item ${seed + i}`,
          concepts: ['acute appendicitis'],
          difficulty_est: 'hard',
          stem: `A ${18 + seed + i}-year-old woman of reproductive age presents with periumbilical pain that has moved to the right iliac fossa. Which investigation should be performed first?`,
          options: [
            { key: 'A', text: 'Serum amylase level' },
            { key: 'B', text: 'Pregnancy test (β-hCG)' },
            { key: 'C', text: 'Barium enema study' },
            { key: 'D', text: 'Upper GI endoscopy' },
          ],
          best_answer: 'B',
          explanation: [s(0)],
          distractors: [
            { option: 'A', explanation: [s(1)] },
            { option: 'C', explanation: [s(2)] },
            { option: 'D', explanation: [s(3)] },
          ],
        })),
      };
    })
      .on('validate_question', () => VALID)
      .on('verify_support', allSupported);
    // 13 over the sample's item types (4 / 2 / 2 / 1 of 9) → a «recall» part of 6 = two runs (5 + 1)
    const res = await api(t).post('/api/exams/simulations', { count: 13, difficulty: 'hard' });
    expect(res.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const sim = ((await api(t).get(`/api/exams/simulations/${res.json().simulation.id}`)).json() as { simulation: SimulationRunView }).simulation;
    expect(sim.status, sim.summary_ar).toBe('completed');
    const big = sim.parts.find((p) => p.requested > 5)!;
    expect(big).toBeTruthy();
    expect(big.published).toBe(big.requested);
    expect(big.status).toBe('completed');
    expect(sim.parts.reduce((a, p) => a + p.published, 0)).toBe(sim.exam!.items);
  }, 120_000);

  it('a generation request cannot claim to be part of a simulation (set by the simulation job only)', async () => {
    const res = await api(t).post('/api/exams/generate', { lecture_source_id: t.lecture.sourceId, topic: 'appendicitis', count: 1, difficulty: 'hard', origin: 'simulation' });
    expect(res.statusCode).toBe(400);
  });
});
