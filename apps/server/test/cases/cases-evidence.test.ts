// Cases with evidence (§42, §10, AC-05/06/07) on the Golden Set lecture processed by the REAL pipeline:
//  * owner authoring: evidence attached by the owner goes through C1 validateClaims — without a verifier the claim is
//    'needs_review' (never 'linked'); a sentence whose number its evidence does not carry is kept (owner writing is
//    never dropped) but marked; evidence outside the case's Source Lock is refused; unchanged sentences reuse claims
//  * the evidence suggestion endpoint (deterministic retrieval in the scope) and the report's review plan
//  * AI generation with a TEST-ONLY scripted provider: unsupported sentences / an unknown alias are removed and listed,
//    a rubric item left without a supported rationale is removed, kept claims are linked by the independent verifier,
//    the case is labelled generated; no provider → requires configuration; too little evidence → abstention
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CaseDetailView, CaseReportView, CaseSummaryView } from '@medlevo/shared';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { regionWith } from '../evidence/helpers';
import { aliasFor, ScriptedAi, studyLibrary, type StudyLib } from '../studybook/helpers';
import { appendicitisCase, createCase, evOk, start } from './helpers';

const ai = new ScriptedAi();
let lib: StudyLib;
let noAi: StudyLib;

beforeAll(async () => {
  lib = await studyLibrary(ai);
  noAi = await studyLibrary(null);
}, 300_000);

afterAll(async () => {
  await lib?.t.close();
  await noAi?.t.close();
});

async function evidenceFor(L: StudyLib, versionId: string, needle: string): Promise<string> {
  const region = regionWith(L.t, versionId, needle);
  const res = await L.t.app.inject({ method: 'POST', url: '/api/evidence/from-region', headers: L.h, payload: { region_id: region.id } });
  if (res.statusCode !== 200) throw new Error(res.body);
  return res.json().evidence.id as string;
}

const lectureScope = (L: StudyLib) => ({ mode: 'lecture_only' as const, lecture_source_id: L.lecture.sourceId });

describe('owner authoring with evidence (no AI provider)', () => {
  it('validates attached evidence, keeps unsupported owner sentences marked, refuses out-of-scope evidence, reuses claims', async () => {
    const { t, h } = noAi;
    const wbc = await evidenceFor(noAi, noAi.lecture.versionId, 'white cell count');
    const ref = await evidenceFor(noAi, noAi.reference.versionId, 'Murphy');
    const def = appendicitisCase();
    const checklist = def.checklist as Array<Record<string, unknown>>;
    checklist[1]!.rationale = [
      { text: 'A white cell count above 11 ×10⁹/L supports the diagnosis.', evidence_ids: [wbc] },
      { text: 'A white cell count above 15 ×10⁹/L supports the diagnosis.', evidence_ids: [wbc] },
      { text: "Murphy's sign suggests cholecystitis.", evidence_ids: [ref] },
      { text: 'Well done.', medical: false },
    ];
    const c: CaseDetailView = await createCase(t, h, def, lectureScope(noAi));
    const r = c.definition.checklist[1]!.rationale;
    expect(r.map((s) => s.status)).toEqual(['needs_review', 'rejected', 'rejected', 'not_medical']);
    expect(r[1]!.text).toContain('15'); // kept, marked
    expect(r[1]!.reason_ar).toBeTruthy();
    expect(r[2]!.reason_ar).toContain('Source Lock');
    expect(r[0]!.claim_id).toBeTruthy();
    const claim = c.claims[r[0]!.claim_id!]!;
    expect(claim.verification_status).toBe('needs_review');
    expect(claim.citations[0]!.evidence.locator_label_ar).toContain('ص 11');
    expect(c.scope_describe_ar).toBeTruthy();

    // an unchanged sentence reuses its claim (no new claim rows, no new verifier call)
    const claimsBefore = t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM claim WHERE owner_type = 'case'`)!.n;
    const def2 = structuredClone(def);
    (def2.checklist as Array<Record<string, unknown>>)[1]!.rationale = [{ text: 'A white cell count above 11 ×10⁹/L supports the diagnosis.', evidence_ids: [wbc] }];
    const c2 = (await t.app.inject({ method: 'PUT', url: `/api/cases/${c.id}`, headers: h, payload: { definition: def2, scope: lectureScope(noAi), base_version_no: 1 } })).json();
    expect(c2.definition.checklist[1].rationale[0].claim_id).toBe(r[0]!.claim_id);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM claim WHERE owner_type = 'case'`)!.n).toBe(claimsBefore);

    // the report's review plan points at the page of a missed item's evidence
    let run = await start(t, h, c.id);
    run = await evOk(t, h, run.attempt.id, { type: 'finish' });
    const rep: CaseReportView = (await t.app.inject({ method: 'GET', url: `/api/cases/attempts/${run.attempt.id}/report`, headers: h })).json();
    const plan = rep.review_plan.find((p) => p.label_ar.includes('full blood count'))!;
    expect(plan.evidence[0]!.locator_label_ar).toContain('ص 11');
    expect(rep.notes_ar.join(' ')).toContain('لم تصل إلى');
  });

  it('suggests evidence inside the Source Lock only', async () => {
    const { t, h } = noAi;
    const res = await t.app.inject({ method: 'POST', url: '/api/cases/evidence/suggest', headers: h, payload: { scope: lectureScope(noAi), text: 'pregnancy test reproductive age' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.evidence.length).toBeGreaterThan(0);
    expect(body.evidence.every((e: { source_id: string }) => e.source_id === noAi.lecture.sourceId)).toBe(true);
    expect(body.evidence.some((e: { quote: string }) => e.quote.includes('β-hCG'))).toBe(true);
  });

  it('generation without a provider is refused with the reason', async () => {
    const { t, h } = noAi;
    const res = await t.app.inject({ method: 'POST', url: '/api/cases/generate', headers: h, payload: { lecture_source_id: noAi.lecture.sourceId, kind: 'case', topic: 'appendicitis' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('AI_NOT_CONFIGURED');
  });
});

function generatedCase(req: ProviderRequest) {
  const pain = aliasFor(req, 'periumbilical');
  const ct = aliasFor(req, 'CT abdomen is preferred');
  const preg = aliasFor(req, 'pregnancy test');
  return {
    abstain: null,
    case: {
      title: 'ألم الحفرة الحرقفية اليمنى',
      summary: 'سيناريو تعليمي.',
      objectives: ['تمييز هجرة الألم'],
      facts: [
        { id: 'f_story', label: 'القصة', value: 'Sara, 27, pain since this morning', kind: 'story', reveal: 'start' },
        { id: 'f_ct', label: 'CT', value: 'Inflamed appendix', kind: 'imaging', reveal: 'on_request' },
      ],
      stages: [
        {
          id: 's1',
          type: 'investigations',
          title: 'الفحوص',
          prompt: 'اختر الفحص.',
          reveal_fact_ids: [],
          select: 'one',
          next_stage_id: 's2',
          decisions: [
            {
              id: 'd_ct',
              label: 'CT abdomen',
              appropriateness: 'appropriate',
              reveal_fact_ids: ['f_ct'],
              consequence: '',
              next_stage_id: null,
              explanation: [{ text: 'CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.', claim: { support_type: 'directly_stated', evidence: [ct] } }],
            },
            {
              id: 'd_none',
              label: 'No investigation',
              appropriateness: 'inappropriate',
              reveal_fact_ids: [],
              consequence: 'Diagnosis remains uncertain.',
              next_stage_id: null,
              explanation: [
                { text: 'A pregnancy test (β-hCG) is required in women of reproductive age.', claim: { support_type: 'directly_stated', evidence: [preg] } },
                { text: 'Skipping tests is always safe.', claim: { support_type: 'derived', evidence: ['E99'] } },
              ],
            },
          ],
          teaching_points: [{ text: 'Pain usually begins in the periumbilical region and later migrates to the right iliac fossa.', claim: { support_type: 'directly_stated', evidence: [pain] } }],
        },
        { id: 's2', type: 'review', title: 'المراجعة', prompt: '', reveal_fact_ids: [], select: 'none', next_stage_id: null, decisions: [], teaching_points: [] },
      ],
      start_stage_id: 's1',
      checklist: [
        { id: 'c_ct', text: 'Ordered CT', category: 'investigations', points: 1, satisfied_by: ['d_ct'], match: [], order: null, critical: false, rationale: [{ text: 'CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.', claim: { support_type: 'directly_stated', evidence: [ct] } }] },
        // its only rationale changes the number → rejected → the item is removed
        { id: 'c_bad', text: 'Knows the threshold', category: 'investigations', points: 1, satisfied_by: ['d_ct'], match: [], order: null, critical: false, rationale: [{ text: 'A white cell count above 20 ×10⁹/L is required.', claim: { support_type: 'directly_stated', evidence: [pain] } }] },
      ],
      osce: null,
      viva: null,
    },
  };
}

describe('AI generation (test-only scripted provider)', () => {
  it('removes unsupported sentences and rubric items, links the rest through the independent verifier, labels the case', async () => {
    const { t, h } = lib;
    let seen: ProviderRequest | null = null;
    ai.once('case_sim', (req) => {
      seen = req;
      return generatedCase(req);
    });
    const pages = t.ctx.db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index IN (0, 1) ORDER BY page_index', [lib.lecture.versionId]).map((p) => p.id);
    const res = await t.app.inject({ method: 'POST', url: '/api/cases/generate', headers: h, payload: { lecture_source_id: lib.lecture.sourceId, kind: 'case', page_ids: pages } });
    expect(res.statusCode).toBe(200);
    const queued: CaseSummaryView = res.json().case;
    expect(queued.origin).toBe('generated');
    expect(queued.generation!.status).toBe('queued');
    await t.ctx.jobs.drain();
    expect(ai.errors).toEqual([]);
    expect(seen!.prompt).toContain('untrusted_content');
    const c: CaseDetailView = (await t.app.inject({ method: 'GET', url: `/api/cases/${queued.id}`, headers: h })).json();
    expect(c.generation!.status).toBe('done');
    expect(c.origin_label_ar).toContain('مولّدة');
    expect(c.definition.checklist.map((x) => x.id)).toEqual(['c_ct']);
    const removed = c.generation!.removed.map((r) => r.text).join(' | ');
    expect(removed).toContain('Skipping tests is always safe.');
    expect(removed).toContain('above 20');
    expect(removed).toContain('Knows the threshold');
    const kept = c.definition.stages[0]!.decisions[0]!.explanation[0]!;
    expect(kept.status).toBe('linked');
    expect(c.claims[kept.claim_id!]!.verification_status).toBe('linked');
    expect(c.definition.stages[0]!.decisions[1]!.explanation.map((s) => s.text)).toEqual(['A pregnancy test (β-hCG) is required in women of reproductive age.']);
    // review regression: the model-written consequence of a decision is unverified scenario text → the owner reviews
    // it for invented harms before the case is 'ready' (it stays playable)
    expect(c.status).toBe('needs_review');
    expect(c.status_reasons_ar.join(' ')).toContain('No investigation');
    expect(c.status_reasons_ar.join(' ')).toContain('لا يخترع ضررًا');
    expect(c.status_reasons_ar.join(' ')).not.toContain('CT abdomen'); // the decision without a consequence is not flagged
    expect(ai.callsFor('verify_support').length).toBeGreaterThan(0);
    // playable
    const run = await start(t, h, c.id);
    expect(run.case.origin).toBe('generated');
    expect(run.case.authored_note_ar).toContain('بيانات تعليمية مؤلفة');
  });

  it('abstains without calling the generator when the scope has too little evidence', async () => {
    const { t, h } = lib;
    const before = ai.callsFor('case_sim').length;
    const res = await t.app.inject({ method: 'POST', url: '/api/cases/generate', headers: h, payload: { lecture_source_id: lib.lecture.sourceId, kind: 'viva', topic: 'zzqx nonexistent topic words' } });
    expect(res.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const c: CaseDetailView = (await t.app.inject({ method: 'GET', url: `/api/cases/${res.json().case.id}`, headers: h })).json();
    expect(c.generation!.status).toBe('abstained');
    expect(c.status).toBe('draft');
    expect(c.generation!.message_ar).toBeTruthy();
    expect(ai.callsFor('case_sim').length).toBe(before);
    const st = await t.app.inject({ method: 'POST', url: `/api/cases/${c.id}/attempts`, headers: h, payload: {} });
    expect(st.statusCode).toBe(409);
  });
});
