// Track F3 without an AI provider (the real server's state here): every AI-gated study tool reports
// `requires_configuration` with an Arabic reason and refuses to run (409 AI_NOT_CONFIGURED) — nothing pretends to work;
// the deterministic parts work fully: the study mode persists through /api/sync, the simulation plan follows the owner's
// sample (or says why it cannot), the rail «حالات» lists the cases of a lecture. Pure checks of the track (allocation,
// derived-text checks, diagram structure, figure-reading certainty) are unit-tested here too.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CapabilitiesResponse, CaseListResponse, LatestSessionResponse, SimulationPlanView, SyncOpResult } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { allocateSimulation, largestRemainder } from '../../src/modules/exams/simulation';
import { derivedIssues, equivalenceIssues, numbersOf } from '../../src/modules/questions/derived';
import { createQuestion } from '../../src/modules/questions/service';
import { diagramStructureIssues, type DiagramOutput } from '../../src/modules/studybook/diagrams';
import { readingStructure } from '../../src/modules/processing/vision';
import { createSourceFixture, op, sessionPayload, type SourceFixture } from '../annotations/helpers';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';

let t: TestApp;
let h: AuthHeaders;
let f: SourceFixture;

beforeAll(async () => {
  t = await createTestApp();
  h = await t.login();
  f = createSourceFixture(t);
});

afterAll(async () => {
  await t?.close();
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => t.app.inject({ method, url, headers: h, payload: payload as never });

describe('F3 — AI-gated tools without a provider: requires_configuration, never a fake result', () => {
  it('capabilities name the reason; the vision step is no longer «not implemented»', async () => {
    const caps = (await call('GET', '/api/capabilities')).json() as CapabilitiesResponse;
    for (const k of ['ai.generate_questions', 'ai.summaries', 'processing.vision'] as const) {
      expect(caps.features[k].state).toBe('requires_configuration');
      expect(caps.features[k].reason_ar).toMatch(/ANTHROPIC_API_KEY/);
    }
    expect(caps.features['processing.vision'].reason_ar).toMatch(/OCR فقط/);
    expect(caps.features['processing.vision'].reason_ar).not.toMatch(/لم تُبنَ/);
  });

  it('Create MCQ from a selection → 409 AI_NOT_CONFIGURED (no run is stored)', async () => {
    const res = await call('POST', '/api/exams/generate', {
      lecture_source_id: f.sourceId,
      anchor: { page_id: f.pageIds[0], quote: 'Pain usually begins in the periumbilical region.' },
      count: 1,
      difficulty: 'hard',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('AI_NOT_CONFIGURED');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM question_generation_run')!.n).toBe(0);
  });

  it('a derived version (translation) → 409 with the reason; the listing says why it cannot be made', async () => {
    const q = createQuestion(t.ctx, {
      origin: 'owner',
      qtype: 'sba',
      stem: 'Which point is classically tender in acute appendicitis?',
      options: [{ text: "Murphy's point" }, { text: "McBurney's point" }, { text: "Kehr's point" }, { text: "Castell's point" }],
      correctOptionIndexes: [1],
      answerStatus: 'owner_key',
    });
    const res = await call('POST', `/api/questions/${q.questionId}/derived`, { kind: 'translation', lang: 'ar' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('AI_NOT_CONFIGURED');
    const list = (await call('GET', `/api/questions/${q.questionId}/derived`)).json();
    expect(list.derivations).toEqual([]);
    expect(list.can_derive.available).toBe(false);
    expect(list.can_derive.reason_ar).toMatch(/ANTHROPIC_API_KEY/);
    // invalid kind → 400
    expect((await call('POST', `/api/questions/${q.questionId}/derived`, { kind: 'summary' })).statusCode).toBe(400);
  });

  it('generated simulation: the plan preview works without AI (and says why it cannot generate); creating it → 409', async () => {
    const res = await call('POST', '/api/exams/simulations/preview', { count: 10, difficulty: 'hard' });
    expect(res.statusCode).toBe(200);
    const plan = res.json().plan as SimulationPlanView;
    expect(plan.notice_ar).toMatch(/محاكاة مولدة — ليست نسخة متوقعة/);
    expect(plan.sample.unique_questions).toBe(0);
    expect(plan.buckets).toEqual([]);
    expect(plan.can_generate.available).toBe(false);
    expect(plan.can_generate.reason_ar).toMatch(/لا توجد أسئلة في عينتك/);
    const create = await call('POST', '/api/exams/simulations', { count: 10, difficulty: 'hard' });
    expect(create.statusCode).toBe(409);
    expect(create.json().error.code).toBe('AI_NOT_CONFIGURED');
    expect((await call('POST', '/api/exams/simulations/preview', { count: 1, difficulty: 'hard' })).statusCode).toBe(400);
  });

  it('timelines / flowcharts → 409; figure analysis → 409 before any region lookup', async () => {
    const d = await call('POST', '/api/studybook/diagrams', { kind: 'flowchart', source_id: f.sourceId, page_ids: [f.pageIds[0]] });
    expect(d.statusCode).toBe(409);
    expect(d.json().error.code).toBe('AI_NOT_CONFIGURED');
    // the request must name what to draw
    expect((await call('POST', '/api/studybook/diagrams', { kind: 'timeline', source_id: f.sourceId })).statusCode).toBe(400);
    const v = await call('POST', '/api/processing/figures/no-such-region/analyze', {});
    expect(v.statusCode).toBe(409);
    expect(v.json().error.code).toBe('AI_NOT_CONFIGURED');
  });
});

describe('F3 — study mode persisted in the study session (deterministic, through /api/sync)', () => {
  async function push(ops: Parameters<typeof op>[0][]): Promise<SyncOpResult[]> {
    const res = await call('POST', '/api/sync/push', { ops: ops.map((o) => op(o)) });
    expect(res.statusCode).toBe(200);
    return res.json().results as SyncOpResult[];
  }

  it('a mode switch is saved and comes back as the session mode; an unknown mode is rejected', async () => {
    const id = newId();
    const [a] = await push([{ entity_type: 'study_session', entity_id: id, payload: { ...sessionPayload(f, 1), mode: 'practice' } }]);
    expect(a!.result).toBe('applied');
    let latest = (await call('GET', `/api/annotations/sessions/latest?source_id=${f.sourceId}`)).json() as LatestSessionResponse;
    expect(latest.session!.mode).toBe('practice');
    // switching to «امتحن نفسك» at the same place: applied on top of the server revision
    const [b] = await push([{ entity_type: 'study_session', entity_id: id, base_rev: latest.session!.rev, payload: { ...sessionPayload(f, 1), mode: 'exam' } }]);
    expect(b!.result).toBe('applied');
    latest = (await call('GET', `/api/annotations/sessions/latest?source_id=${f.sourceId}`)).json() as LatestSessionResponse;
    expect(latest.session!.mode).toBe('exam');
    expect(latest.session!.location.page_index).toBe(1);
    const [c] = await push([{ entity_type: 'study_session', entity_id: id, base_rev: latest.session!.rev, payload: { ...sessionPayload(f, 1), mode: 'cram' } }]);
    expect(c!.result).toBe('rejected');
    latest = (await call('GET', `/api/annotations/sessions/latest?source_id=${f.sourceId}`)).json() as LatestSessionResponse;
    expect(latest.session!.mode).toBe('exam');
  });
});

describe('F3 — rail «حالات»: cases of one lecture', () => {
  it('GET /api/cases?source_id= lists the cases whose focal lecture is the source, not the others', async () => {
    const other = createSourceFixture(t, 'محاضرة أخرى');
    const now = t.clock.now();
    const ins = (title: string, sourceId: string | null, scope: object) =>
      t.ctx.db.run(
        `INSERT INTO clinical_case (id, title, kind, scope_json, definition_json, is_generated, status, created_at, updated_at, origin, current_version_no, source_id, status_reasons_json)
         VALUES (?, ?, 'case', ?, '{}', 0, 'draft', ?, ?, 'owner', 0, ?, '[]')`,
        [newId(now), title, JSON.stringify(scope), now, now, sourceId],
      );
    ins('حالة الزائدة', f.sourceId, { mode: 'lecture_only', lecture_source_id: f.sourceId });
    ins('حالة بنطاق المحاضرة فقط', null, { mode: 'lecture_only', lecture_source_id: f.sourceId });
    ins('حالة محاضرة أخرى', other.sourceId, { mode: 'lecture_only', lecture_source_id: other.sourceId });
    const res = await call('GET', `/api/cases?source_id=${f.sourceId}`);
    expect(res.statusCode).toBe(200);
    const titles = (res.json() as CaseListResponse).cases.map((c) => c.title).sort();
    expect(titles).toEqual(['حالة الزائدة', 'حالة بنطاق المحاضرة فقط'].sort());
    expect((await call('GET', '/api/cases')).json().cases.length).toBe(3);
  });
});

describe('F3 — pure checks', () => {
  it('largest remainder: real counts that add up, zero weights get nothing', () => {
    expect(largestRemainder(10, [6, 3, 1])).toEqual([6, 3, 1]);
    expect(largestRemainder(5, [6, 3, 1])).toEqual([3, 2, 0]);
    expect(largestRemainder(3, [1, 1, 1, 0])).toEqual([1, 1, 1, 0]);
    expect(largestRemainder(4, [0, 0])).toEqual([0, 0]);
    expect(largestRemainder(7, [2, 5]).reduce((a, b) => a + b, 0)).toBe(7);
  });

  it('the simulation follows the sample: lecture shares, then item types inside each lecture', () => {
    const buckets = allocateSimulation({
      count: 10,
      lectures: [
        { id: 'L1', title: 'Appendicitis', unique: 6, denominator: 10, topic: 'appendicitis' },
        { id: 'L2', title: 'Cholecystitis', unique: 3, denominator: 10, topic: 'cholecystitis' },
        { id: 'L3', title: 'Shock', unique: 1, denominator: 10, topic: 'shock' },
      ],
      itemTypes: [
        { item_type: 'diagnosis', count: 4 },
        { item_type: 'clinical_feature', count: 2 }, // counted as a diagnosis item
        { item_type: 'management', count: 3 },
        { item_type: 'unclassified', count: 1 }, // never a generated type
      ],
    });
    const per = (id: string) => buckets.filter((b) => b.lecture_source_id === id).reduce((a, b) => a + b.count, 0);
    expect([per('L1'), per('L2'), per('L3')]).toEqual([6, 3, 1]);
    const l1 = buckets.filter((b) => b.lecture_source_id === 'L1');
    expect(l1.find((b) => b.item_types[0] === 'diagnosis')!.count).toBe(4); // 6 × 6/9
    expect(l1.find((b) => b.item_types[0] === 'management')!.count).toBe(2);
    expect(buckets.every((b) => b.share.denominator === 10)).toBe(true);
    expect(buckets.some((b) => b.item_types.includes('unclassified' as never))).toBe(false);
    expect(buckets[0]!.reason_ar).toMatch(/6 من 10/);
  });

  it('derived text: keys, numbers in the SAME option, negation, language and a real paraphrase are checked', () => {
    const original = {
      stem: 'Which of the following is NOT typically part of the Alvarado score?',
      hasNegation: true,
      options: [
        { option_key: 'o1', text: 'Migration of pain' },
        { option_key: 'o2', text: 'A white cell count of 11.5 ×10⁹/L' },
        { option_key: 'o3', text: 'Serum amylase' },
      ],
    };
    const ok = {
      abstain: null,
      stem: 'أيٌّ مما يلي ليس عادةً جزءًا من Alvarado score؟',
      options: [
        { option_key: 'o1', text: 'انتقال الألم' },
        { option_key: 'o2', text: 'عدد كريات بيض 11.5 ×10⁹/L' },
        { option_key: 'o3', text: 'Serum amylase' },
      ],
    };
    expect(derivedIssues('translation', 'ar', original, ok)).toEqual([]);
    // negation dropped
    expect(derivedIssues('translation', 'ar', original, { ...ok, stem: 'أيٌّ مما يلي جزء من Alvarado score؟' }).map((i) => i.check)).toContain('negation_preserved');
    // a number moved to another option / changed
    const moved = { ...ok, options: [{ option_key: 'o1', text: 'انتقال الألم 11.5' }, { option_key: 'o2', text: 'عدد كريات بيض مرتفع' }, ok.options[2]!] };
    expect(derivedIssues('translation', 'ar', original, moved).filter((i) => i.check === 'numbers_units_preserved').length).toBeGreaterThan(0);
    // an option dropped / a key invented
    const missing = { ...ok, options: [ok.options[0]!, ok.options[1]!, { option_key: 'o9', text: 'Serum amylase' }] };
    expect(derivedIssues('translation', 'ar', original, missing).map((i) => i.check)).toContain('options_complete');
    // wrong language
    expect(derivedIssues('translation', 'ar', original, { ...ok, stem: original.stem }).map((i) => i.check)).toContain('language');
    // an identical "paraphrase" is no paraphrase
    expect(derivedIssues('paraphrase', 'en', original, { abstain: null, stem: original.stem, options: original.options }).map((i) => i.check)).toContain('paraphrase_differs');
    // Arabic-Indic digits count as the same number
    expect(numbersOf('١١٫٥')).toEqual(['11.5']);
    // the independent reviewer's verdict becomes specific issues
    expect(equivalenceIssues({ equivalent: false, options_equivalent: false, negation_preserved: true, numbers_units_preserved: true, issues: ['option o3 now means "lipase"'] }).map((i) => i.check)).toEqual([
      'options_equivalent',
      'equivalent',
    ]);
    expect(equivalenceIssues({ equivalent: true, options_equivalent: true, negation_preserved: true, numbers_units_preserved: true, issues: [] })).toEqual([]);
  });

  it('diagram structure: unknown nodes, self loops, decisions without labelled branches, unordered timelines are refused', () => {
    const s = (text: string) => ({ text, claim: { support_type: 'directly_stated' as const, evidence: ['E1'] } });
    const flow: DiagramOutput = {
      abstain: null,
      title: 'Imaging',
      nodes: [
        { key: 'N1', label: 'Uncertain diagnosis', kind: 'decision', order: null, time_label: null, statement: s('a') },
        { key: 'N2', label: 'Ultrasound', kind: 'outcome', order: null, time_label: null, statement: s('b') },
        { key: 'N3', label: 'CT abdomen', kind: 'outcome', order: null, time_label: null, statement: s('c') },
      ],
      edges: [
        { from: 'N1', to: 'N2', label: 'children / pregnant women', statement: s('d') },
        { from: 'N1', to: 'N3', label: 'adults', statement: s('e') },
      ],
    };
    expect(diagramStructureIssues('flowchart', flow)).toEqual([]);
    expect(diagramStructureIssues('flowchart', { ...flow, edges: [flow.edges[0]!] }).join(' ')).toMatch(/فرعين|غير مرتبطة/);
    expect(diagramStructureIssues('flowchart', { ...flow, edges: [...flow.edges, { from: 'N2', to: 'N9', label: null, statement: s('x') }] }).join(' ')).toMatch(/غير موجودة/);
    expect(diagramStructureIssues('flowchart', { ...flow, edges: [...flow.edges, { from: 'N2', to: 'N2', label: null, statement: s('x') }] }).join(' ')).toMatch(/إلى نفسها/);
    expect(diagramStructureIssues('flowchart', { ...flow, edges: [{ ...flow.edges[0]!, label: null }, flow.edges[1]!] }).join(' ')).toMatch(/شرطًا/);
    const timeline: DiagramOutput = {
      abstain: null,
      title: 'Pain',
      nodes: [
        { key: 'N1', label: 'Periumbilical pain', kind: 'event', order: 1, time_label: null, statement: s('a') },
        { key: 'N2', label: 'Pain in RIF', kind: 'event', order: 2, time_label: null, statement: s('b') },
      ],
      edges: [],
    };
    expect(diagramStructureIssues('timeline', timeline)).toEqual([]);
    expect(diagramStructureIssues('timeline', { ...timeline, nodes: [timeline.nodes[0]!, { ...timeline.nodes[1]!, order: 1 }] }).join(' ')).toMatch(/مكرر/);
    expect(diagramStructureIssues('timeline', { ...timeline, nodes: [timeline.nodes[0]!, { ...timeline.nodes[1]!, order: null }] }).join(' ')).toMatch(/ترتيبًا/);
  });

  it('figure reading: «read» only when the model is sure AND the OCR text agrees; arrows to unknown nodes are dropped', () => {
    const { structure, notes } = readingStructure(
      {
        figure_kind: 'flowchart',
        direction: 'top_down',
        nodes: [
          { id: 'n1', label: 'Suspected appendicitis', certainty: 'clear', bbox: null },
          { id: 'n2', label: 'Alvarado score', certainty: 'clear', bbox: null },
          { id: 'n3', label: 'Score ≥ 7 · Surgical review', certainty: 'clear', bbox: null }, // not in the OCR text
          { id: 'n4', label: 'Imaging', certainty: 'uncertain', bbox: null },
        ],
        edges: [
          { from: 'n1', to: 'n2', label: null, certainty: 'clear' },
          { from: 'n2', to: 'n3', label: null, certainty: 'clear' },
          { from: 'n2', to: 'n9', label: null, certainty: 'clear' },
        ],
        notes: [],
      },
      'Suspected appendicitis\nAlvarado score\nScore 27 Surgical review\nImaging',
    );
    expect(structure.nodes.map((n) => n.certainty)).toEqual(['read', 'read', 'uncertain', 'uncertain']);
    expect(structure.edges).toHaveLength(2);
    expect(structure.edges[0]).toMatchObject({ from: 'n1', to: 'n2', certainty: 'read' });
    expect(structure.edges[1]).toMatchObject({ from: 'n2', to: 'n3', certainty: 'uncertain' });
    expect(notes.join(' ')).toMatch(/سهم واحد/);
    expect(structure.understanding).toBe('structure_read');
  });
});
