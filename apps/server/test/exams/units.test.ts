// Pure logic of the exams module: option order, display labels, mistake suggestions, clue words, deterministic
// checks of generated questions, validator issues, exam-state merging and AC-27 mastery signals.
import { describe, expect, it } from 'vitest';
import { masterySignal, type ExamAttemptDTO } from '@medlevo/shared';
import { mergeExamState } from '../../src/modules/exams/attempts';
import { seededRandom } from '../../src/modules/exams/builder';
import { displayLabels, isOrderDependent, optionOrder, sanitizeRichText } from '../../src/modules/exams/delivery';
import { normalizeQuestion, validatorIssues } from '../../src/modules/exams/generation/pipeline';
import type { GeneratedQuestion } from '../../src/modules/exams/generation/schema';
import { deterministicIssues, emphasizeNegation } from '../../src/modules/exams/generation/validate';
import { emphasizeClues } from '../../src/modules/exams/hints';
import { findClues, suggestMistake } from '../../src/modules/exams/mistakes';
import { defaultPolicy, questionsAr, type ExamRow } from '../../src/modules/exams/store';

const opts = (texts: string[], pinned: number[] = []) => texts.map((t, i) => ({ id: `o${i + 1}`, ord: i, pinned: pinned.includes(i), text: t }));

describe('option order (§38)', () => {
  it('shuffles free options only, keeps pinned options in place, deterministic per seed', () => {
    const o = opts(['a', 'b', 'c', 'd', 'e'], [4]);
    const seen = new Set<string>();
    for (const seed of ['1', '2', '3', '4', '5', '6', '7']) {
      const order = optionOrder(o, true, seededRandom(seed));
      expect(order[4]).toBe('o5');
      expect([...order].sort()).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
      expect(optionOrder(o, true, seededRandom(seed))).toEqual(order);
      seen.add(order.join());
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(optionOrder(o, false, seededRandom('x'))).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
  });

  it('order-dependent options («all of the above», «A and B», «كل ما سبق») are never shuffled', () => {
    expect(isOrderDependent(['x', 'All of the above'])).toBe(true);
    expect(isOrderDependent(['x', 'Both A and C'])).toBe(true);
    expect(isOrderDependent(['x', 'كل ما سبق'])).toBe(true);
    expect(isOrderDependent(['Anorexia', 'Nausea'])).toBe(false);
    const o = opts(['a', 'b', 'c', 'None of the above']);
    expect(optionOrder(o, true, seededRandom('q'))).toEqual(['o1', 'o2', 'o3', 'o4']);
  });

  it('display labels are positional (Latin or Arabic like the source)', () => {
    expect(displayLabels(['A', 'B', 'C'], 3)).toEqual(['A', 'B', 'C']);
    expect(displayLabels(['أ', 'ب', 'ج', 'د'], 4)).toEqual(['أ', 'ب', 'ج', 'د']);
    expect(displayLabels([null, null], 2)).toEqual(['A', 'B']);
  });

  it('delivered rich text keeps presentation only (no claim / evidence / term ids)', () => {
    const rt = sanitizeRichText({ v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: 'x', claim: 'c1', ev: ['e1'], kind: 'term', term: 't1', marks: ['b'] } as never] }] });
    expect(rt.paragraphs[0]!.runs[0]).toEqual({ t: 'x', marks: ['b'] });
  });
});

describe('policy defaults (§39)', () => {
  it('assessed modes: no hints, solution at the end, no pause; practice: progressive hints after each', () => {
    expect(defaultPolicy('exam', 30, null, 10)).toMatchObject({ hints: 'off', show_solution: 'at_end', pause_allowed: false, total_seconds: 1800 });
    expect(defaultPolicy('time_pressure', null, null, 5)).toMatchObject({ per_question_seconds: 60, total_seconds: 300, pause_allowed: false });
    expect(defaultPolicy('practice', null, null, 5)).toMatchObject({ hints: 'progressive', show_solution: 'after_each', pause_allowed: true, total_seconds: null });
  });

  it('Arabic counts agree with the number', () => {
    expect([1, 2, 3, 11].map(questionsAr)).toEqual(['سؤال واحد', 'سؤالان', '3 أسئلة', '11 سؤالًا']);
  });
});

describe('mistake suggestions (§44) — suggestions only, editable', () => {
  const base = { scored: true, is_correct: false as boolean | null, confidence: null as never, time_ms: 10_000, time_budget_ms: null as number | null, has_negation: false, negation_terms: [] as string[], item_type: null as string | null, stem: 'Which sign?', qtype: 'sba' };
  it('only wrong scored answers get a suggestion', () => {
    expect(suggestMistake({ ...base, is_correct: true })).toBeNull();
    expect(suggestMistake({ ...base, scored: false })).toBeNull();
    expect(suggestMistake({ ...base, is_correct: null })).toBeNull();
  });
  it('over the time budget → time_pressure, worded as a possibility', () => {
    const s = suggestMistake({ ...base, time_ms: 90_000, time_budget_ms: 60_000 })!;
    expect(s.type).toBe('time_pressure');
    expect(s.reason_ar).toMatch(/قد يكون/);
  });
  it('negation question → misread; confident wrong → misunderstanding / concept confusion; guess → knowledge gap', () => {
    expect(suggestMistake({ ...base, has_negation: true, negation_terms: ['EXCEPT'] })!.type).toBe('misread');
    expect(suggestMistake({ ...base, confidence: 'confident' as never })!.type).toBe('misunderstanding');
    expect(suggestMistake({ ...base, confidence: 'confident' as never, item_type: 'diagnosis' })!.type).toBe('concept_confusion');
    expect(suggestMistake({ ...base, confidence: 'guess' as never })!.type).toBe('knowledge_gap');
    expect(suggestMistake({ ...base, item_type: 'investigation', stem: 'What is the first-line test?' })!.type).toBe('first_line_vs_confirmatory');
    expect(suggestMistake({ ...base, item_type: 'next_step', stem: 'What is the best next step?' })!.type).toBe('step_order');
  });
});

describe('hint 2 clue words (§39)', () => {
  it('finds negation, qualifiers, age, values; emphasises them without changing the text order', () => {
    const stem = 'A 30-year-old woman has a WBC of 11.5 ×10⁹/L. Which is NOT the first-line test?';
    const clues = findClues(stem).map((c) => c.text);
    expect(clues).toEqual(expect.arrayContaining(['30-year-old', 'woman', 'NOT', 'first-line']));
    expect(clues.some((c) => c.includes('11.5'))).toBe(true);
    const { rt } = emphasizeClues(stem);
    expect(rt.paragraphs.flatMap((p) => p.runs.map((r) => r.t)).join('')).toBe(stem);
    expect(rt.paragraphs[0]!.runs.some((r) => r.marks?.includes('b') && r.t.includes('NOT'))).toBe(true);
    expect(findClues('أي مما يلي ليس من الأعراض؟').map((c) => c.text)).toContain('ليس');
  });
});

describe('generated question checks (§38)', () => {
  const sentence = (text: string, ev = ['E1']) => ({ text, claim: { support_type: 'derived' as const, evidence: ev } });
  const good = (): GeneratedQuestion => ({
    item_type: 'investigation',
    learning_objective: 'Pick the first test.',
    concepts: ['x'],
    difficulty_est: 'hard',
    stem: 'A 28-year-old woman of reproductive age presents with right iliac fossa pain, anorexia and nausea for one day. Which investigation should be performed first?',
    options: [
      { key: 'A', text: 'Serum amylase level' },
      { key: 'B', text: 'Pregnancy test' },
      { key: 'C', text: 'Barium enema study' },
      { key: 'D', text: 'Upper GI endoscopy' },
    ],
    best_answer: 'B',
    explanation: [sentence('A pregnancy test is required in women of reproductive age.')],
    distractors: ['A', 'C', 'D'].map((k) => ({ option: k, explanation: [sentence(`Option ${k} is not among the listed investigations for this case.`)] })),
  });
  it('a well-formed question passes', () => {
    expect(deterministicIssues(good())).toEqual([]);
  });
  it('catches two identical options, a missing best answer, «all of the above», wrong option count', () => {
    const q = good();
    q.options[2] = { key: 'C', text: 'Serum amylase level' };
    expect(deterministicIssues(q).map((i) => i.check)).toContain('options_complete');
    expect(deterministicIssues({ ...good(), best_answer: 'E' }).map((i) => i.check)).toContain('single_best_answer');
    const above = good();
    above.options[3] = { key: 'D', text: 'All of the above' };
    expect(deterministicIssues(above).map((i) => i.check)).toContain('single_best_answer');
    expect(deterministicIssues({ ...good(), options: good().options.slice(0, 3) }).map((i) => i.check)).toContain('options_complete');
  });
  it('catches wording clues: length, absolute words only in distractors, «an» grammar, answer repeated in the stem', () => {
    const long = good();
    long.options[1] = { key: 'B', text: 'A pregnancy test because ectopic pregnancy must always be excluded first in these women' };
    expect(deterministicIssues(long).some((i) => i.check === 'no_answer_leak')).toBe(true);
    const abs = good();
    abs.options[0] = { key: 'A', text: 'Always serum amylase' };
    expect(deterministicIssues(abs).some((i) => i.check === 'no_answer_leak')).toBe(true);
    const an = { ...good(), stem: `${good().stem.replace(/\?$/, '')}. The best choice is an`, options: [{ key: 'A', text: 'Serum test' }, { key: 'B', text: 'Ultrasound' }, { key: 'C', text: 'Barium study' }, { key: 'D', text: 'CT scan' }] };
    expect(deterministicIssues(an).some((i) => i.reason_ar.includes('an'))).toBe(true);
  });
  it('requires an evidence-backed explanation for the answer and EVERY distractor (not just «incorrect»)', () => {
    const q = good();
    q.distractors = q.distractors.slice(0, 2);
    expect(deterministicIssues(q).some((i) => i.check === 'distractors_explained' && i.reason_ar.includes('D'))).toBe(true);
    const generic = good();
    generic.distractors[0] = { option: 'A', explanation: [sentence('This is incorrect.')] };
    expect(deterministicIssues(generic).some((i) => i.reason_ar.includes('عام'))).toBe(true);
    const noEv = good();
    noEv.distractors[1] = { option: 'C', explanation: [{ text: 'Barium enema is not part of the work-up in this case at all.', claim: null }] };
    expect(deterministicIssues(noEv).some((i) => i.reason_ar.includes('بلا دليل'))).toBe(true);
  });
  it('incomplete vignette and missing question mark are caught; negation is emphasised', () => {
    expect(deterministicIssues({ ...good(), stem: 'Pain in RIF. Test?' }).some((i) => i.check === 'stem_complete')).toBe(true);
    expect(emphasizeNegation('Pain migrates. Which is not a feature of the score?')).toBe('Pain migrates. Which is NOT a feature of the score?');
    expect(normalizeQuestion({ ...good(), best_answer: ' b ' }).best_answer).toBe('B');
  });
  it('independent validator: another chosen answer / several defensible options / not answerable → issues', () => {
    const v = { chosen_option: 'B', defensible_options: ['B'], answerable_from_evidence: true, clue_issues: [], issues: [], verdict: 'valid' as const };
    expect(validatorIssues(good(), v)).toEqual([]);
    expect(validatorIssues(good(), { ...v, chosen_option: 'C' })[0]!.check).toBe('single_best_answer');
    expect(validatorIssues(good(), { ...v, defensible_options: ['B', 'D'] }).some((i) => i.reason_ar.includes('B، D'))).toBe(true);
    expect(validatorIssues(good(), { ...v, answerable_from_evidence: false })[0]!.check).toBe('evidence_supported');
    expect(validatorIssues(good(), { ...v, verdict: 'invalid' })).toHaveLength(1);
  });
});

describe('exam state merge (never loses answers, policy fixed)', () => {
  const exam = (pause: boolean): ExamRow => ({
    id: 'e',
    title: 't',
    mode: pause ? 'practice' : 'exam',
    config_json: '{}',
    policy_json: JSON.stringify({ pause_allowed: pause, hints: 'off', show_solution: 'at_end', shuffle_options: false, per_question_seconds: null, total_seconds: null }),
    items_json: JSON.stringify([
      { question_id: 'q1', question_version_id: 'v1', option_order: ['a', 'b'], display_labels: ['A', 'B'], scored: true, unscored_reason_ar: null, origin_type: 'source' },
      { question_id: 'q2', question_version_id: 'v2', option_order: ['c', 'd'], display_labels: ['A', 'B'], scored: true, unscored_reason_ar: null, origin_type: 'source' },
    ]),
    is_generated_simulation: 0,
    created_at: 0,
    build_json: null,
    seed: null,
  });
  const server = (patch: Partial<ExamAttemptDTO> = {}): ExamAttemptDTO => ({
    id: 'a',
    exam_id: 'e',
    status: 'in_progress',
    started_at: 0,
    finished_at: null,
    elapsed_ms: 1000,
    current_index: 0,
    answers: {},
    flagged: [],
    timer: { item_ms: {}, pauses: 0, paused_at: null },
    rev: 1,
    updated_at: 0,
    ...patch,
  });
  const ans = (ids: string[], at: number, submitted = false) => ({ attempt_id: `x${at}`, selected_option_ids: ids, confidence: null, at, time_ms: null, hints_used: 0, solution_viewed_before_answer: false, submitted });

  it('pause refused when the policy forbids it; a finished attempt never changes', () => {
    expect(mergeExamState(exam(false), server(), { status: 'paused', elapsed_ms: 0, current_index: 0, answers: {}, flagged: [], timer: {} }, 10_000).ok).toBe(false);
    expect(mergeExamState(exam(true), server(), { status: 'paused', elapsed_ms: 0, current_index: 0, answers: {}, flagged: [], timer: {} }, 10_000).ok).toBe(true);
    expect(mergeExamState(exam(true), server({ status: 'completed' }), { status: 'in_progress', elapsed_ms: 0, current_index: 0, answers: {}, flagged: [], timer: {} }, 10_000).ok).toBe(false);
  });

  it('answers merge per item by their own time; submitted answers are locked; invalid options dropped; time never decreases', () => {
    const s = server({ answers: { '0': ans(['a'], 5) as never, '1': ans(['c'], 5, true) as never } });
    const m = mergeExamState(exam(true), s, { status: 'in_progress', elapsed_ms: 500, current_index: 1, answers: { '0': ans(['b'], 4), '1': ans(['d'], 9) }, flagged: [], timer: {} }, 100_000);
    if (!m.ok) throw new Error('merge failed');
    expect(m.next.answers['0']!.selected_option_ids).toEqual(['a']); // older incoming loses
    expect(m.next.answers['1']!.selected_option_ids).toEqual(['c']); // submitted stays
    expect(m.merged).toBe(true);
    expect(m.next.elapsed_ms).toBe(1000);
    const newer = mergeExamState(exam(true), s, { status: 'in_progress', elapsed_ms: 5000, current_index: 0, answers: { '0': ans(['b'], 7), '1': ans(['zz'], 9) }, flagged: [1, 7], timer: {} }, 100_000);
    if (!newer.ok) throw new Error('merge failed');
    expect(newer.next.answers['0']!.selected_option_ids).toEqual(['b']);
    expect(newer.dropped).toBe(1);
    expect(newer.next.flagged).toEqual([1]);
    expect(newer.next.elapsed_ms).toBe(5000);
  });
});

describe('AC-27 mastery signals', () => {
  it('guessed, hint-assisted and solution-viewed correct answers are not independent mastery', () => {
    const a = { is_correct: true, confidence: 'confident' as const, hints_used: 0, solution_viewed_before_answer: false };
    expect(masterySignal(a)).toBe('correct_confident_independent');
    expect(masterySignal({ ...a, confidence: 'guess' })).toBe('correct_guess');
    expect(masterySignal({ ...a, hints_used: 1 })).toBe('correct_after_hint');
    expect(masterySignal({ ...a, solution_viewed_before_answer: true })).toBe('correct_after_solution_viewed');
    expect(masterySignal({ ...a, is_correct: false })).toBe('wrong');
    expect(masterySignal({ ...a, is_correct: null })).toBeNull();
  });
});
