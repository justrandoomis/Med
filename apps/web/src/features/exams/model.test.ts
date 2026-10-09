// Pure runner logic: keyboard mapping (Latin + Arabic labels), clocks, timer budgets, local state transitions
// (submitted answers locked, pause only when the policy allows it, no time while paused), resume merge that never
// drops an answer, navigator wording (state in words, not colour).
import { describe, expect, it } from 'vitest';
import type { ExamAnswerState } from '@medlevo/shared';
import {
  answeredCount,
  chooseOption,
  durationAr,
  finish,
  formatClock,
  mergeStates,
  navigatorLabel,
  optionIndexForKey,
  patchAnswer,
  pause,
  questionsAr,
  resume,
  setConfidence,
  syncPayload,
  tick,
  timerView,
  toggleFlag,
  type LocalExamState,
} from './model';

const empty = (patch: Partial<LocalExamState> = {}): LocalExamState => ({
  status: 'in_progress',
  elapsed_ms: 0,
  current_index: 0,
  answers: {},
  flagged: [],
  timer: { item_ms: {}, pauses: 0, paused_at: null },
  finished_at: null,
  ...patch,
});
const ans = (ids: string[], at: number, submitted = false): ExamAnswerState => ({ attempt_id: `a${at}`, selected_option_ids: ids, confidence: null, at, time_ms: null, hints_used: 0, solution_viewed_before_answer: false, submitted });

describe('keyboard', () => {
  it('digits, Latin and Arabic letters map to option positions; out of range → null', () => {
    expect(optionIndexForKey('1', 4)).toBe(0);
    expect(optionIndexForKey('4', 4)).toBe(3);
    expect(optionIndexForKey('5', 4)).toBeNull();
    expect(optionIndexForKey('b', 4)).toBe(1);
    expect(optionIndexForKey('E', 5)).toBe(4);
    expect(optionIndexForKey('أ', 4)).toBe(0);
    expect(optionIndexForKey('ب', 4)).toBe(1);
    expect(optionIndexForKey('ج', 4)).toBe(2);
    expect(optionIndexForKey('د', 4)).toBe(3);
    expect(optionIndexForKey('ه', 5)).toBe(4);
    expect(optionIndexForKey('Enter', 4)).toBeNull();
    expect(optionIndexForKey('x', 4)).toBeNull();
  });
});

describe('clocks', () => {
  it('formats clocks and spoken durations', () => {
    expect(formatClock(65_000)).toBe('01:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(durationAr(65_000)).toBe('دقيقة واحدة و5 ثوانٍ');
    expect(durationAr(120_000)).toBe('دقيقتان');
    expect(durationAr(0)).toBe('0 ثانية');
  });
  it('timer budgets: total left, per question left, over budget is a flag not a forced answer', () => {
    const s = empty({ elapsed_ms: 50_000, timer: { item_ms: { '0': 70_000 }, pauses: 0, paused_at: null } });
    expect(timerView({ total_seconds: 60, per_question_seconds: 60 }, s)).toEqual({ totalLeftMs: 10_000, itemLeftMs: 0, itemOver: true, totalExpired: false });
    expect(timerView({ total_seconds: 40, per_question_seconds: null }, s).totalExpired).toBe(true);
    expect(timerView({ total_seconds: null, per_question_seconds: null }, s)).toMatchObject({ totalLeftMs: null, itemLeftMs: null });
  });
});

describe('state transitions', () => {
  it('choosing replaces (single) or toggles (multi); a submitted answer is locked', () => {
    let s = chooseOption(empty(), 0, 'o1', { multi: false, attemptId: 'q1', now: 1 });
    s = chooseOption(s, 0, 'o2', { multi: false, attemptId: 'other', now: 2 });
    expect(s.answers['0']).toMatchObject({ selected_option_ids: ['o2'], attempt_id: 'q1', at: 2 });
    let m = chooseOption(empty(), 1, 'a', { multi: true, attemptId: 'm', now: 1 });
    m = chooseOption(m, 1, 'b', { multi: true, attemptId: 'm', now: 2 });
    m = chooseOption(m, 1, 'a', { multi: true, attemptId: 'm', now: 3 });
    expect(m.answers['1']!.selected_option_ids).toEqual(['b']);
    const locked = patchAnswer(s, 0, { submitted: true });
    expect(chooseOption(locked, 0, 'o3', { multi: false, attemptId: 'x', now: 9 })).toBe(locked);
    // confidence is part of the checked answer: it cannot be re-labelled after «تحقّق» (review fix, AC-27 data)
    expect(setConfidence(locked, 0, 'guess', 10)).toBe(locked);
    expect(setConfidence(s, 0, 'guess', 10).answers['0']).toMatchObject({ confidence: 'guess', at: 10 });
    expect(answeredCount(s)).toBe(1);
  });

  it('time counts only while in progress; pause only when the policy allows it; finished is final', () => {
    const s = tick(empty(), 1000);
    expect(s.elapsed_ms).toBe(1000);
    expect(s.timer.item_ms['0']).toBe(1000);
    expect(pause(s, { pause_allowed: false }, 5)).toBe(s);
    const p = pause(s, { pause_allowed: true }, 5);
    expect(p.status).toBe('paused');
    expect(p.timer.pauses).toBe(1);
    expect(tick(p, 5000)).toBe(p);
    const r = resume(p);
    expect(r.status).toBe('in_progress');
    const f = finish(r, 9);
    expect(f).toMatchObject({ status: 'completed', finished_at: 9 });
    expect(tick(f, 1000)).toBe(f);
    expect(chooseOption(f, 0, 'o1', { multi: false, attemptId: 'x', now: 10 })).toBe(f);
  });

  it('resume merge: newer answer per item wins, submitted answers are never replaced, time never decreases', () => {
    const server = empty({ elapsed_ms: 9000, answers: { '0': ans(['s0'], 5), '1': ans(['s1'], 5, true), '3': ans(['s3'], 5) }, timer: { item_ms: { '0': 4000 }, pauses: 1, paused_at: null } });
    const local = empty({ elapsed_ms: 7000, current_index: 2, answers: { '0': ans(['l0'], 9), '1': ans(['l1'], 9), '2': ans(['l2'], 9) }, timer: { item_ms: { '0': 3000, '2': 500 }, pauses: 0, paused_at: null }, flagged: [2] });
    const m = mergeStates(local, server);
    expect(m.answers['0']!.selected_option_ids).toEqual(['l0']);
    expect(m.answers['1']!.selected_option_ids).toEqual(['s1']);
    expect(m.answers['2']!.selected_option_ids).toEqual(['l2']);
    expect(m.answers['3']!.selected_option_ids).toEqual(['s3']);
    expect(m.elapsed_ms).toBe(9000);
    expect(m.timer.item_ms).toEqual({ '0': 4000, '2': 500 });
    expect(m.current_index).toBe(2);
    expect(mergeStates(local, { ...server, status: 'completed' }).status).toBe('completed');
    expect(mergeStates(null, server)).toBe(server);
  });

  it('flags toggle; navigator label says the state in words; the sync payload is the full state', () => {
    const s = toggleFlag(chooseOption(empty(), 0, 'o1', { multi: false, attemptId: 'q', now: 1 }), 0);
    expect(navigatorLabel(0, s)).toBe('السؤال 1، مُجاب، مُعلَّم للمراجعة، الحالي');
    expect(navigatorLabel(1, s)).toBe('السؤال 2، غير مُجاب');
    expect(toggleFlag(s, 0).flagged).toEqual([]);
    const p = syncPayload(tick(s, 1234.6), 99);
    expect(p).toMatchObject({ status: 'in_progress', elapsed_ms: 1235, current_index: 0, flagged: [0], client_ts: 99 });
    expect(Object.keys(p).sort()).toEqual(['answers', 'client_ts', 'current_index', 'elapsed_ms', 'finished_at', 'flagged', 'status', 'timer']);
  });

  it('Arabic counts', () => {
    expect([0, 1, 2, 5, 12].map(questionsAr)).toEqual(['لا أسئلة', 'سؤال واحد', 'سؤالان', '5 أسئلة', '12 سؤالًا']);
  });
});
