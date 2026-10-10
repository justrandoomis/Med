// Pure engine + text matching (§42): determinism (same definition + same events → same states), facts read only from
// the definition, branching only as defined, inappropriate choices continue with the authored consequence, OSCE
// patient answers only from defined facts, viva follow-ups chosen deterministically by rubric coverage, phrase
// matching with Arabic proclitics and negation.
import { describe, expect, it } from 'vitest';
import { caseDefinitionInputSchema, type CaseDefinition, type CaseStoredEvent } from '@medlevo/shared';
import { buildDefinition, honestyFor, statusFor, structuralIssues } from '../../src/modules/cases/definition';
import { apply, EngineError, judgeChecklist, judgeViva, orderCheck, replay } from '../../src/modules/cases/engine';
import { findPhrase, matchAny } from '../../src/modules/cases/text';
import { appendicitisCase, osceHistoryStation, vivaDefinition } from './helpers';

function def(input: unknown): CaseDefinition {
  const parsed = caseDefinitionInputSchema.parse(input);
  return buildDefinition(parsed, (_p, l) => l.map((s) => ({ text: s.text, medical: s.medical !== false, claim_id: null, evidence_ids: [], status: s.medical === false ? 'not_medical' : 'no_evidence', reason_ar: null })));
}

let seq = 0;
const e = (type: CaseStoredEvent['type'], payload: Record<string, unknown>): CaseStoredEvent => ({ id: `e${++seq}`, seq, type, payload, at: 1000 + seq });

describe('text matching', () => {
  it('matches phrases with Arabic proclitics and article variants', () => {
    expect(matchAny('هل تشعر بالغثيان؟', ['غثيان']).matched).toBe(true);
    expect(matchAny('والألم أين بدأ', ['ألم']).matched).toBe(true);
    expect(matchAny('Is there any NAUSEA today', ['nausea']).matched).toBe(true);
    expect(matchAny('nauseated', ['nausea']).matched).toBe(false);
  });
  it('a negated mention does not count', () => {
    const m = matchAny('It is not ultrasound, I would do CT', ['ultrasound']);
    expect(m.matched).toBe(false);
    expect(m.negated_only).toBe(true);
    expect(matchAny('ليس ultrasound', ['ultrasound']).matched).toBe(false);
    expect(matchAny('ما هي شدة الألم', ['شدة الألم']).matched).toBe(true); // «ما» (what) is not a negation
  });
  // review regression: «I would not order a CT» covered the point «CT»; «no evidence of nausea» counted as asking
  it('a negation a few words before the phrase in the same clause does not count; another clause is not negated', () => {
    expect(matchAny('I would not order a CT scan', ['ct']).matched).toBe(false);
    expect(matchAny('there is no evidence of nausea', ['nausea']).matched).toBe(false);
    expect(matchAny('لا يوجد دليل على غثيان', ['غثيان']).matched).toBe(false);
    expect(matchAny('Not ultrasound. I would order a CT', ['ct']).matched).toBe(true);
    expect(matchAny('no fever but nausea since morning', ['nausea']).matched).toBe(true);
    // «rule out X» names X as a differential in an answer (it is a negation only in image captions)
    expect(matchAny('I would rule out ectopic pregnancy', ['ectopic']).matched).toBe(true);
  });
  it('the simulated patient answers a negatively phrased question about a defined fact', () => {
    const d = def(osceHistoryStation());
    const s = apply(d, replay(d, []), { id: 'e1', seq: 1, type: 'utterance', payload: { text: 'No nausea today?' }, at: 1 });
    expect(s.revealed.map((r) => r.fact_id)).toContain('f_nausea');
  });
  it('reports token positions for ordering', () => {
    expect(findPhrase('first inspect then palpate', 'palpate')[0]!.at).toBe(3);
  });
});

describe('definition validation', () => {
  it('a valid owner case has no errors; references and branches are checked', () => {
    const ok = def(appendicitisCase());
    expect(structuralIssues(ok).filter((i) => i.severity === 'error')).toEqual([]);
    const bad = def(appendicitisCase({ start_stage_id: 'nope' }));
    expect(statusFor(structuralIssues(bad)).status).toBe('draft');
    const badRef = appendicitisCase();
    (badRef.stages as Array<{ decisions?: Array<{ next_stage_id?: string | null }> }>)[3]!.decisions![1]!.next_stage_id = 's_missing';
    expect(structuralIssues(def(badRef)).some((i) => i.severity === 'error' && i.message_ar.includes('s_missing'))).toBe(true);
    const branchMany = appendicitisCase();
    (branchMany.stages as Array<{ decisions?: Array<{ next_stage_id?: string | null }> }>)[1]!.decisions![0]!.next_stage_id = 's_dx';
    expect(structuralIssues(def(branchMany)).some((i) => i.severity === 'error' && i.message_ar.includes('لا يمكن أن يتفرع'))).toBe(true);
  });
  it('a case whose stages never end is refused', () => {
    const loop = appendicitisCase();
    (loop.stages as Array<{ next_stage_id?: string | null; decisions?: Array<{ next_stage_id?: string | null }> }>)[5]!.next_stage_id = 's_present';
    expect(structuralIssues(def(loop)).some((i) => i.severity === 'error' && i.message_ar.includes('لا توجد نهاية'))).toBe(true);
  });
  it('rubric items without evidence are warnings (needs review), not silently accepted', () => {
    const s = statusFor(structuralIssues(def(appendicitisCase())));
    expect(s.status).toBe('needs_review');
    expect(s.reasons_ar.some((r) => r.includes('بلا دليل'))).toBe(true);
  });
  it('honesty notes say what an OSCE examination station cannot assess', () => {
    const h = honestyFor(def(osceHistoryStation({ osce: { station_type: 'examination', candidate_instructions: 'افحص البطن', roles: ['examiner'] } })));
    expect(h.cannot_assess_ar.join(' ')).toContain('لا تقيس المحاكاة تنفيذ الفحص الجسدي الفعلي');
    expect(h.cannot_assess_ar.join(' ')).toContain('تقدير');
  });
});

describe('case state machine', () => {
  const d = def(appendicitisCase());
  const run = () => {
    seq = 0;
    return [
      e('advance', { stage_id: 's_present' }),
      e('choose', { stage_id: 's_exam', decision_id: 'd_palpate' }),
      e('choose', { stage_id: 's_exam', decision_id: 'd_murphy' }),
      e('advance', { stage_id: 's_exam' }),
      e('choose', { stage_id: 's_inv', decision_id: 'd_cbc' }),
      e('advance', { stage_id: 's_inv' }),
      e('choose', { stage_id: 's_dx', decision_id: 'd_chole' }),
      e('advance', { stage_id: 's_reconsider' }),
      e('choose', { stage_id: 's_mx', decision_id: 'd_surgery' }),
      e('finish', {}),
    ];
  };

  it('same events → same states (replayed twice, and step by step)', () => {
    const events = run();
    const a = replay(d, events);
    const b = replay(d, structuredClone(events));
    expect(b).toEqual(a);
    // prefix replays are stable too
    for (let i = 1; i <= events.length; i++) expect(replay(d, events.slice(0, i))).toEqual(replay(d, structuredClone(events.slice(0, i))));
    expect(a.finished).toBe(true);
  });

  it('facts are revealed only by the definition and their values never change', () => {
    const s = replay(d, run());
    const ids = s.revealed.map((r) => r.fact_id);
    expect(ids).toEqual(['f_story', 'f_migration', 'f_temp', 'f_rif', 'f_wbc']);
    expect(ids).not.toContain('f_ct'); // CT was never ordered
    // the state holds ids only: values come from the (immutable) definition
    expect(JSON.stringify(s)).not.toContain('37.8');
  });

  it('branches only as defined: the inappropriate diagnosis goes to the defined «reconsider» stage', () => {
    seq = 0;
    const base = [e('advance', { stage_id: 's_present' }), e('advance', { stage_id: 's_exam' }), e('advance', { stage_id: 's_inv' })];
    const wrong = replay(d, [...base, e('choose', { stage_id: 's_dx', decision_id: 'd_chole' })]);
    expect(wrong.stage_id).toBe('s_reconsider');
    const right = replay(d, [...base, e('choose', { stage_id: 's_dx', decision_id: 'd_appendicitis' })]);
    expect(right.stage_id).toBe('s_mx');
  });

  it('refuses what the definition does not allow', () => {
    seq = 0;
    const s0 = replay(d, []);
    expect(() => apply(d, s0, e('choose', { stage_id: 's_exam', decision_id: 'd_palpate' }))).toThrow(EngineError); // wrong stage
    expect(() => apply(d, s0, e('choose', { stage_id: 's_present', decision_id: 'd_palpate' }))).toThrow(/للقراءة فقط/);
    const s1 = apply(d, s0, e('advance', { stage_id: 's_present' }));
    expect(() => apply(d, s1, e('choose', { stage_id: 's_exam', decision_id: 'd_invented' }))).toThrow(/غير موجود/);
    const s2 = apply(d, s1, e('choose', { stage_id: 's_exam', decision_id: 'd_palpate' }));
    expect(() => apply(d, s2, e('choose', { stage_id: 's_exam', decision_id: 'd_palpate' }))).toThrow(/من قبل/);
    expect(() => apply(d, s2, e('override_item', { item_id: 'c_cbc', met: true }))).toThrow(/بعد إنهاء/);
    const fin = apply(d, s2, e('finish', {}));
    expect(() => apply(d, fin, e('advance', { stage_id: 's_exam' }))).toThrow(/انتهت/);
  });

  it('checklist judgement follows the chosen decisions; owner overrides are kept beside the automatic verdict', () => {
    const events = run();
    let s = replay(d, events);
    let j = judgeChecklist(d, s);
    expect(j.map((x) => [x.item.id, x.met])).toEqual([
      ['c_palpate', true],
      ['c_cbc', true],
      ['c_dx', false],
      ['c_mx', true],
    ]);
    s = apply(d, s, e('override_item', { item_id: 'c_dx', met: true, note: 'وصلت إليه بعد إعادة النظر' }));
    j = judgeChecklist(d, s);
    const dx = j.find((x) => x.item.id === 'c_dx')!;
    expect(dx.auto_met).toBe(false);
    expect(dx.met).toBe(true);
    expect(dx.override?.note).toContain('إعادة النظر');
  });
});

describe('OSCE station', () => {
  const d = def(osceHistoryStation());
  it('the patient answers only with defined facts; unknown questions reveal nothing', () => {
    seq = 0;
    const s = replay(d, [e('utterance', { text: 'متى بدأ الألم؟' }), e('utterance', { text: 'Do you smoke?' })]);
    expect(s.utterances[0]!.responses).toEqual([{ response_id: 'r_onset', fact_id: 'f_onset' }]);
    expect(s.utterances[1]!.responses).toEqual([]);
    expect(s.revealed.map((r) => r.fact_id)).toEqual(['f_onset']);
  });
  it('checklist by matched phrases, revisions keep the original, order check', () => {
    seq = 0;
    let s = replay(d, [e('utterance', { text: 'هل عندك غثيان؟' }), e('utterance', { text: 'when did the pain start?' })]);
    expect(judgeChecklist(d, s).map((j) => j.met)).toEqual([true, true, false]);
    expect(orderCheck(judgeChecklist(d, s)).in_order).toBe(false);
    const target = s.utterances[1]!.event_id;
    s = apply(d, s, e('revise', { target_event_id: target, text: 'when did the pain start? any fever?' }));
    expect(s.utterances[1]!.original).toBe('when did the pain start?');
    expect(s.utterances[1]!.revisions).toBe(1);
    expect(judgeChecklist(d, s).find((j) => j.item.id === 'o_fever')!.met).toBe(true);
  });
  // review regression: a text could be revised after finishing (after the report was seen) and count as an automatic match
  it('a finished attempt refuses text revisions; only an owner verdict on an item can be added', () => {
    seq = 0;
    let s = replay(d, [e('utterance', { text: 'when did the pain start?' }), e('finish', {})]);
    const target = s.utterances[0]!.event_id;
    expect(() => apply(d, s, e('revise', { target_event_id: target, text: 'when did the pain start? any fever? nausea?' }), { appending: true })).toThrow(EngineError);
    s = apply(d, s, e('override_item', { item_id: 'o_fever', met: true, note: '' }));
    const fever = judgeChecklist(d, s).find((j) => j.item.id === 'o_fever')!;
    expect(fever).toMatchObject({ auto_met: false, met: true });
  });
});

describe('viva', () => {
  const d = def(vivaDefinition());
  it('chooses the follow-up from the definition by rubric coverage (deterministic), then the next question', () => {
    seq = 0;
    let s = replay(d, []);
    expect(s.viva!.pending).toEqual({ question_id: 'q1', follow_up_id: null });
    s = apply(d, s, e('viva_answer', { question_id: 'q1', follow_up_id: null, text: 'WBC and CT scan' }));
    expect(s.viva!.pending).toEqual({ question_id: 'q1', follow_up_id: 'f_us' }); // ultrasound missing → that probe
    s = apply(d, s, e('viva_answer', { question_id: 'q1', follow_up_id: 'f_us', text: 'Ultrasound first' }));
    expect(s.viva!.pending).toEqual({ question_id: 'q2', follow_up_id: null }); // all covered → next question
    s = apply(d, s, e('viva_answer', { question_id: 'q2', follow_up_id: null, text: "Murphy's sign is positive; ectopic pregnancy" }));
    expect(s.viva!.pending).toBeNull();
    const j = judgeViva(d, s);
    expect(j[0]!.covered.map((c) => c.id).sort()).toEqual(['p_ct', 'p_us', 'p_wbc']);
    expect(j[1]!.covered.map((c) => c.id)).toEqual(['p_ectopic']);
    // the misconception is detected only in the question that defines it
    expect(j[0]!.misconceptions).toEqual([]);
  });
  it('an answer for a question that is not pending is refused; AI verdicts are restricted to defined points', () => {
    seq = 0;
    const s = replay(d, []);
    expect(() => apply(d, s, e('viva_answer', { question_id: 'q2', follow_up_id: null, text: 'x' }))).toThrow(EngineError);
    const s2 = apply(d, s, e('viva_answer', { question_id: 'q1', follow_up_id: null, text: 'blah', judged: { covered: ['p_wbc', 'p_invented'], model: 'm' } }));
    expect(s2.viva!.answers[0]!.judged).toEqual({ covered: ['p_wbc'], model: 'm' });
  });
});
