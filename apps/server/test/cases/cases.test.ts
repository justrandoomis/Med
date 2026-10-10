// Cases API (§42): owner authoring without AI (versions, validation), attempts (idempotent start and events, facts
// pinned to the started version, branching per definition, no spoilers in the run view, feedback modes), the final
// report (checklist scoring honesty notes, gaps, review plan), OSCE text stations, viva with deterministic follow-ups,
// the AI-gated viva judge, voice mode disabled with the reason, case signals, auth / CSRF.
import { afterEach, describe, expect, it } from 'vitest';
import type { CaseDetailView, CaseReportView, CaseRunView } from '@medlevo/shared';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';
import { FakeAiProvider } from '../helpers/fake-ai';
import { appendicitisCase, createCase, ev, evOk, osceHistoryStation, start, vivaDefinition } from './helpers';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function app(ai: FakeAiProvider | null = null): Promise<{ t: TestApp; h: AuthHeaders }> {
  t = await createTestApp({ ai });
  return { t, h: await t.login() };
}

describe('authoring without AI', () => {
  it('creates a case by hand, labels it owner-authored, reports what is missing, and versions every edit', async () => {
    const { t, h } = await app();
    const caps = (await t.app.inject({ method: 'GET', url: '/api/capabilities', headers: h })).json();
    expect(caps.features['ai.cases'].state).toBe('requires_configuration');

    const c: CaseDetailView = await createCase(t, h, appendicitisCase());
    expect(c.origin).toBe('owner');
    expect(c.origin_label_ar).toBe('كتبتها بنفسك');
    expect(c.status).toBe('needs_review'); // playable, but its rubric has no evidence from the owner's sources
    expect(c.status_reasons_ar.join(' ')).toContain('بلا دليل');
    expect(c.version_no).toBe(1);
    expect(c.authored_note_ar).toContain('بيانات تعليمية مؤلفة');
    expect(c.definition.facts.find((f) => f.id === 'f_temp')!.value).toBe('37.8 °C');

    const list = (await t.app.inject({ method: 'GET', url: '/api/cases', headers: h })).json();
    expect(list.cases).toHaveLength(1);
    expect(list.capabilities.generation.available).toBe(false);
    expect(list.capabilities.generation.reason_ar).toBeTruthy();
    expect(list.capabilities.voice.available).toBe(false);
    expect(list.capabilities.text_mode.available).toBe(true);

    // an edit based on an older version is refused (never silently overwritten)
    const stale = await t.app.inject({ method: 'PUT', url: `/api/cases/${c.id}`, headers: h, payload: { definition: appendicitisCase(), base_version_no: 0 } });
    expect(stale.statusCode).toBe(400); // base_version_no must be ≥ 1 (validation)
    const edited = await t.app.inject({ method: 'PUT', url: `/api/cases/${c.id}`, headers: h, payload: { definition: appendicitisCase({ title: 'Edited title' }), base_version_no: 1 } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().version_no).toBe(2);
    const conflict = await t.app.inject({ method: 'PUT', url: `/api/cases/${c.id}`, headers: h, payload: { definition: appendicitisCase(), base_version_no: 1 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.message).toContain('عُدّلت');
    const audit = t.ctx.db.all<{ action: string }>(`SELECT action FROM change_log WHERE entity_type = 'clinical_case' AND entity_id = ? ORDER BY created_at`, [c.id]);
    expect(audit.map((a) => a.action)).toEqual(['create', 'update']);
  });

  // review regression: an edit while a generation was still queued wrote version 1, and the job then failed on it
  it('a case whose generation has not finished cannot be edited yet', async () => {
    const { t, h } = await app();
    const now = t.ctx.clock.now();
    t.ctx.db.run(
      `INSERT INTO clinical_case (id, title, kind, scope_json, definition_json, is_generated, status, created_at, updated_at, origin, current_version_no, generation_json, status_reasons_json)
       VALUES ('GEN1', 'pending', 'case', 'null', '{}', 1, 'draft', ?, ?, 'generated', 0, '{"status":"queued"}', '[]')`,
      [now, now],
    );
    const res = await t.app.inject({ method: 'PUT', url: '/api/cases/GEN1', headers: h, payload: { definition: appendicitisCase() } });
    expect(res.statusCode).toBe(409);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM clinical_case_version WHERE case_id = 'GEN1'`)!.n).toBe(0);
  });

  it('a definition with broken references is saved as a draft and cannot be started', async () => {
    const { t, h } = await app();
    const bad = appendicitisCase();
    (bad.stages as Array<{ next_stage_id?: string | null }>)[0]!.next_stage_id = 's_nowhere';
    const c = await createCase(t, h, bad);
    expect(c.status).toBe('draft');
    expect(c.validation.some((i: { severity: string }) => i.severity === 'error')).toBe(true);
    const res = await t.app.inject({ method: 'POST', url: `/api/cases/${c.id}/attempts`, headers: h, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('s_nowhere');
  });

  it('rejects unknown fields and invalid ids', async () => {
    const { t, h } = await app();
    const res = await t.app.inject({ method: 'POST', url: '/api/cases', headers: h, payload: { definition: { ...appendicitisCase(), hacked: 1 } } });
    expect(res.statusCode).toBe(400);
    const res2 = await t.app.inject({ method: 'POST', url: '/api/cases', headers: h, payload: { definition: appendicitisCase({ facts: [{ id: 'bad id!', label: 'x', value: 'y' }] }) } });
    expect(res2.statusCode).toBe(400);
  });
});

describe('attempts', () => {
  it('runs a case deterministically: idempotent start, facts pinned to the started version, branching, consequences', async () => {
    const { t, h } = await app();
    const c = await createCase(t, h, appendicitisCase());
    let run = await start(t, h, c.id, { attempt_id: 'ATTEMPT_1' });
    const again = await start(t, h, c.id, { attempt_id: 'ATTEMPT_1' });
    expect(again.attempt.id).toBe(run.attempt.id);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM case_attempt')!.n).toBe(1);
    expect(run.facts.map((f) => f.id)).toEqual(['f_story', 'f_migration', 'f_temp']);
    expect(run.stage!.id).toBe('s_present');

    // the owner edits the case while the attempt runs: the attempt keeps its version's facts
    const def2 = appendicitisCase();
    (def2.facts as Array<{ id: string; value: string }>).find((f) => f.id === 'f_temp')!.value = '39.5 °C';
    await t.app.inject({ method: 'PUT', url: `/api/cases/${c.id}`, headers: h, payload: { definition: def2, base_version_no: 1 } });

    run = await evOk(t, h, run.attempt.id, { type: 'advance', stage_id: 's_present' });
    expect(run.stage!.id).toBe('s_exam');
    expect(run.facts.find((f) => f.id === 'f_temp')!.value).toBe('37.8 °C');
    expect(run.attempt.case_version_no).toBe(1);

    // no spoilers before choosing
    const raw = JSON.stringify(run.stage);
    expect(raw).not.toContain('appropriate');
    expect(raw).not.toContain('next_stage_id');
    expect(Object.keys(run.stage!.decisions[0]!).sort()).toEqual(['chosen', 'id', 'label']);

    run = await evOk(t, h, run.attempt.id, { type: 'choose', stage_id: 's_exam', decision_id: 'd_murphy' });
    const murphy = run.history.at(-1)!;
    expect(murphy.feedback!.appropriateness).toBe('inappropriate');
    expect(murphy.feedback!.consequence).toBe('لا يضيف هذا الفحص معلومة جديدة في هذا السيناريو.');
    run = await evOk(t, h, run.attempt.id, { type: 'choose', stage_id: 's_exam', decision_id: 'd_palpate' });
    expect(run.facts.map((f) => f.id)).toContain('f_rif');
    expect(run.facts.find((f) => f.id === 'f_rif')!.revealed_by_ar).toContain('Palpate');
    run = await evOk(t, h, run.attempt.id, { type: 'advance', stage_id: 's_exam' });
    run = await evOk(t, h, run.attempt.id, { type: 'choose', stage_id: 's_inv', decision_id: 'd_mri' });
    // no consequence authored → none shown, nothing invented
    expect(run.history.at(-1)!.feedback!.consequence).toBeNull();
    expect(run.history.at(-1)!.revealed_fact_ids).toEqual([]);
    run = await evOk(t, h, run.attempt.id, { type: 'advance', stage_id: 's_inv' });
    run = await evOk(t, h, run.attempt.id, { type: 'choose', stage_id: 's_dx', decision_id: 'd_chole' });
    expect(run.stage!.id).toBe('s_reconsider'); // branch defined by the decision

    // idempotent events: the same event id is never applied twice
    const evt = { event_id: 'EVT_FIXED', type: 'advance', stage_id: 's_reconsider' };
    const r1 = await t.app.inject({ method: 'POST', url: `/api/cases/attempts/${run.attempt.id}/events`, headers: h, payload: evt });
    const r2 = await t.app.inject({ method: 'POST', url: `/api/cases/attempts/${run.attempt.id}/events`, headers: h, payload: evt });
    expect(r1.json().result).toBe('applied');
    expect(r2.json().result).toBe('duplicate');
    expect(r2.json().run.attempt.last_seq).toBe(r1.json().run.attempt.last_seq);
    // a stale stage id is refused
    const stale = await ev(t, h, run.attempt.id, { type: 'advance', stage_id: 's_reconsider' });
    expect(stale.statusCode).toBe(409);

    run = await evOk(t, h, run.attempt.id, { type: 'choose', stage_id: 's_mx', decision_id: 'd_surgery' });
    expect(run.stage!.is_last).toBe(true);
    // the report is only available after finishing
    expect((await t.app.inject({ method: 'GET', url: `/api/cases/attempts/${run.attempt.id}/report`, headers: h })).statusCode).toBe(409);
    run = await evOk(t, h, run.attempt.id, { type: 'finish' });
    expect(run.finished).toBe(true);

    const rep: CaseReportView = (await t.app.inject({ method: 'GET', url: `/api/cases/attempts/${run.attempt.id}/report`, headers: h })).json();
    expect(rep.checklist.map((x) => [x.id, x.met])).toEqual([
      ['c_palpate', true],
      ['c_cbc', false],
      ['c_dx', false],
      ['c_mx', true],
    ]);
    expect(rep.score).toEqual({ got: 3, max: 6, label_ar: expect.stringContaining('تقدير') });
    expect(rep.checklist[0]!.evidence_note_ar).toContain('بلا دليل');
    expect(rep.missed_appropriate.map((m) => m.label)).toEqual(expect.arrayContaining(['Full blood count', 'CT abdomen', 'Acute appendicitis']));
    expect(rep.honesty.cannot_assess_ar.join(' ')).toContain('بيانات تعليمية مؤلفة');
    expect(rep.decisions.find((d) => d.label === 'MRI brain')!.appropriateness_label_ar).toBe('غير مناسب في هذا السيناريو');

    // owner override after finishing: both verdicts are visible; the log keeps every event
    const o = await evOk(t, h, run.attempt.id, { type: 'override_item', item_id: 'c_dx', met: true, note: 'وصلت بعد إعادة النظر' });
    expect(o.history.at(-1)!.label).toContain('حكمك');
    const rep2: CaseReportView = (await t.app.inject({ method: 'GET', url: `/api/cases/attempts/${run.attempt.id}/report`, headers: h })).json();
    const dx = rep2.checklist.find((x) => x.id === 'c_dx')!;
    expect([dx.auto_met, dx.met, dx.override?.note]).toEqual([false, true, 'وصلت بعد إعادة النظر']);
    expect(rep2.notes_ar.join(' ')).toContain('عدّلتَ الحكم');
    const events = t.ctx.db.all<{ seq: number }>('SELECT seq FROM case_event WHERE attempt_id = ? ORDER BY seq', [run.attempt.id]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("feedback mode 'end' hides appropriateness and explanations until the attempt is finished", async () => {
    const { t, h } = await app();
    const c = await createCase(t, h, appendicitisCase());
    let run = await start(t, h, c.id, { feedback: 'end' });
    run = await evOk(t, h, run.attempt.id, { type: 'advance', stage_id: 's_present' });
    run = await evOk(t, h, run.attempt.id, { type: 'choose', stage_id: 's_exam', decision_id: 'd_murphy' });
    const fb = run.history.at(-1)!.feedback!;
    expect(fb.appropriateness).toBeNull();
    expect(fb.consequence).toContain('لا يضيف'); // the scenario still continues with the authored consequence
    run = await evOk(t, h, run.attempt.id, { type: 'finish' });
    expect(run.history.find((x) => x.type === 'choose')!.feedback!.appropriateness).toBe('inappropriate');
  });

  it('voice mode is disabled with the reason; the text mode works', async () => {
    const { t, h } = await app();
    const c = await createCase(t, h, appendicitisCase());
    const res = await t.app.inject({ method: 'POST', url: `/api/cases/${c.id}/attempts`, headers: h, payload: { mode: 'voice' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('FEATURE_DISABLED');
    expect(res.json().error.message).toContain('لن يُحسب خطأ التعرف');
    const run = await start(t, h, c.id);
    expect(run.voice.available).toBe(false);
    expect(run.attempt.mode).toBe('text');
  });
});

describe('OSCE (text) station', () => {
  it('the simulated patient answers only defined facts; checklist, order and honesty notes in the report', async () => {
    const { t, h } = await app();
    const c = await createCase(t, h, osceHistoryStation());
    expect(c.status).toBe('needs_review');
    let run = await start(t, h, c.id);
    expect(run.case.osce!.station_label_ar).toContain('History Taking');
    expect(JSON.stringify(run)).not.toContain('o_fever'); // the checklist is not sent while playing
    run = await evOk(t, h, run.attempt.id, { type: 'utterance', text: 'هل تشعر بالغثيان؟' });
    expect(run.history.at(-1)!.patient_responses).toEqual([{ fact_id: 'f_nausea', text: 'نعم، أشعر بغثيان منذ الصباح' }]);
    run = await evOk(t, h, run.attempt.id, { type: 'utterance', text: 'Do you smoke?' });
    expect(run.history.at(-1)!.patient_responses).toEqual([]);
    expect(run.history.at(-1)!.no_response_ar).toContain('لا يُخترع');
    run = await evOk(t, h, run.attempt.id, { type: 'utterance', text: 'متى بدأ الألم؟' });
    run = await evOk(t, h, run.attempt.id, { type: 'finish' });
    const rep: CaseReportView = (await t.app.inject({ method: 'GET', url: `/api/cases/attempts/${run.attempt.id}/report`, headers: h })).json();
    expect(rep.checklist.map((x) => x.met)).toEqual([true, true, false]);
    expect(rep.order_check).toMatchObject({ assessed: true, in_order: false });
    expect(rep.honesty.cannot_assess_ar.join(' ')).toContain('التواصل غير اللفظي');
    expect(rep.review_plan.map((r) => r.label_ar)).toContain('راجع: Asked about fever');
    // signals for the Weakness Center (shared shape)
    const sig = (await t.app.inject({ method: 'GET', url: '/api/cases/signals', headers: h })).json();
    expect(sig.signals.filter((s: { type: string }) => s.type === 'osce')).toHaveLength(3);
    expect(sig.signals.find((s: { item_id: string }) => s.item_id === 'o_fever').correct).toBe(false);
    expect(sig.note_ar).toContain('تقدير');

    // review regression: after finishing (the report seen) a typed text can no longer be revised into a match;
    // the owner's verdict on the item is the way to correct it, shown beside the automatic one
    const firstText = run.history.find((x) => x.type === 'utterance')!.event_id;
    const late = await ev(t, h, run.attempt.id, { type: 'revise', target_event_id: firstText, text: 'هل تشعر بالغثيان؟ هل عندك حمى؟' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toContain('حكمك');
    const ov = await evOk(t, h, run.attempt.id, { type: 'override_item', item_id: 'o_fever', met: true, note: 'سألت عنها شفهيًا' });
    expect(ov.finished).toBe(true);
    const rep2: CaseReportView = (await t.app.inject({ method: 'GET', url: `/api/cases/attempts/${run.attempt.id}/report`, headers: h })).json();
    expect(rep2.checklist.find((x) => x.id === 'o_fever')).toMatchObject({ auto_met: false, met: true, override: { met: true } });
  });
});

describe('viva', () => {
  it('asks the defined follow-up for a missing point, then reports gaps and misconceptions', async () => {
    const { t, h } = await app();
    const c = await createCase(t, h, vivaDefinition());
    let run = await start(t, h, c.id);
    expect(run.viva!.current).toMatchObject({ question_id: 'q1', is_follow_up: false, index: 1, total: 2 });
    run = await evOk(t, h, run.attempt.id, { type: 'viva_answer', question_id: 'q1', text: "WBC, and Murphy's sign" });
    expect(run.viva!.current).toMatchObject({ question_id: 'q1', follow_up_id: 'f_us', prompt: 'And in children or pregnant women?' });
    // the follow-up does not reveal the solution (only the authored probe)
    expect(JSON.stringify(run.viva)).not.toContain('Ultrasound first-line');
    const ans = run.history.at(-1)!;
    run = await evOk(t, h, run.attempt.id, { type: 'viva_answer', question_id: 'q1', follow_up_id: 'f_us', text: 'I am not sure' });
    expect(run.viva!.current).toMatchObject({ question_id: 'q1', follow_up_id: 'f_ct' });
    run = await evOk(t, h, run.attempt.id, { type: 'viva_answer', question_id: 'q1', follow_up_id: 'f_ct', text: 'CT abdomen' });
    expect(run.viva!.current).toMatchObject({ question_id: 'q2' });
    run = await evOk(t, h, run.attempt.id, { type: 'revise', target_event_id: ans.event_id, text: "WBC and ultrasound, and Murphy's sign" });
    run = await evOk(t, h, run.attempt.id, { type: 'finish' });
    const rep: CaseReportView = (await t.app.inject({ method: 'GET', url: `/api/cases/attempts/${run.attempt.id}/report`, headers: h })).json();
    const q1 = rep.viva!.questions[0]!;
    expect(q1.covered.map((p) => p.id).sort()).toEqual(['p_ct', 'p_us', 'p_wbc']); // the revised text counts
    expect(q1.answers[0]!.original_text).toBe("WBC, and Murphy's sign");
    expect(q1.misconceptions.map((m) => m.id)).toEqual(['m_murphy']);
    expect(q1.follow_ups_asked).toEqual(['And in children or pregnant women?', 'And in adults when the diagnosis is uncertain?']);
    expect(rep.viva!.questions[1]!.missed.map((p) => p.id)).toEqual(['p_ectopic']);
    expect(rep.notes_ar.join(' ')).toContain('صحّحتَ');
    expect(rep.score).toBeNull(); // no checklist; coverage is reported per question
    expect(rep.viva!.covered_points).toBe(3);
  });

  it('the AI judge is refused without a provider; with one, only defined points are accepted and the verdict is stored', async () => {
    const { t, h } = await app();
    const c = await createCase(t, h, vivaDefinition());
    const res = await t.app.inject({ method: 'POST', url: `/api/cases/${c.id}/attempts`, headers: h, payload: { judge: 'ai' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('AI_NOT_CONFIGURED');
    await t.close();

    const ai = new FakeAiProvider({ steps: [{ json: { covered_point_ids: ['p_wbc', 'p_us', 'p_invented'] } }] });
    const x = await app(ai);
    const c2 = await createCase(x.t, x.h, vivaDefinition());
    let run = await start(x.t, x.h, c2.id, { judge: 'ai' });
    run = await evOk(x.t, x.h, run.attempt.id, { type: 'viva_answer', question_id: 'q1', text: 'blood tests and imaging' });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.task).toBe('case_sim');
    expect(ai.calls[0]!.prompt).toContain('untrusted_content'); // the learner's answer is data
    // p_ct is missing according to the verdict → its follow-up (deterministic rule of the definition)
    expect(run.viva!.current).toMatchObject({ question_id: 'q1', follow_up_id: 'f_ct' });
    const stored = x.t.ctx.db.get<{ payload_json: string }>(`SELECT payload_json FROM case_event WHERE type = 'viva_answer'`)!;
    expect(JSON.parse(stored.payload_json).judged.covered).toEqual(['p_wbc', 'p_us']);
    // review regression: an answer to a question that is not pending is refused WITHOUT a model call (no cost)
    const stale = await ev(x.t, x.h, run.attempt.id, { type: 'viva_answer', question_id: 'q2', text: 'ectopic pregnancy' });
    expect(stale.statusCode).toBe(409);
    expect(ai.calls).toHaveLength(1);
  });
});

describe('auth', () => {
  it('requires the owner session and the CSRF header', async () => {
    const { t, h } = await app();
    expect((await t.app.inject({ method: 'GET', url: '/api/cases' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/cases', headers: { cookie: h.cookie }, payload: { definition: appendicitisCase() } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/cases/attempts/nope', headers: h })).statusCode).toBe(404);
  });
});

export type { CaseRunView };
