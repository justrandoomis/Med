// Pure logic of the practice / exam runner (unit-tested): keyboard mapping, timers, local exam state,
// per-item merge with the server copy (never drops an answer), navigator labels, Arabic counts.
import type {
  ConfidenceLevel,
  ExamAnswerState,
  ExamAttemptDTO,
  ExamAttemptStatus,
  ExamAttemptSyncPayload,
  ExamPolicyView,
  ExamTimerState,
  MistakeType,
} from '@medlevo/shared';

// ───────── keyboard (1–9, A–H, أ ب ج د هـ و) ─────────
const ARABIC_KEYS: Record<string, number> = { 'أ': 0, 'ا': 0, 'إ': 0, 'آ': 0, 'ب': 1, 'ج': 2, 'د': 3, 'ه': 4, 'ة': 4, 'و': 5, 'ز': 6, 'ح': 7 };

/** Option index for a key press, or null. Digits 1–9, Latin letters a–h, Arabic letters أ–ح (any case/form). */
export function optionIndexForKey(key: string, optionCount: number): number | null {
  if (!key || key.length !== 1) return null;
  let i: number | null = null;
  if (/^[1-9]$/.test(key)) i = Number(key) - 1;
  else if (/^[a-h]$/i.test(key)) i = key.toLowerCase().charCodeAt(0) - 97;
  else if (key in ARABIC_KEYS) i = ARABIC_KEYS[key]!;
  return i !== null && i < optionCount ? i : null;
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return false;
  const h = el as HTMLElement;
  return h.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(h.tagName);
}

// ───────── time ─────────
/** «04:05» / «1:02:03» (always LTR digits, rendered inside an LTR isolate). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Spoken duration for screen readers: «3 دقائق و5 ثوانٍ». */
export function durationAr(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const unit = (n: number, one: string, two: string, few: string, many: string) => (n === 1 ? one : n === 2 ? two : n >= 3 && n <= 10 ? `${n} ${few}` : `${n} ${many}`);
  const mm = m > 0 ? unit(m, 'دقيقة واحدة', 'دقيقتان', 'دقائق', 'دقيقة') : '';
  const ss = s > 0 || m === 0 ? unit(s, 'ثانية واحدة', 'ثانيتان', 'ثوانٍ', 'ثانية') : '';
  return [mm, ss].filter(Boolean).join(' و');
}

export interface TimerView {
  /** total time left (policy total_seconds), null when the exam has no total limit */
  totalLeftMs: number | null;
  /** time left for the current question (policy per_question_seconds), null when none */
  itemLeftMs: number | null;
  /** the per-question budget was exceeded (suggestion only, never a forced answer) */
  itemOver: boolean;
  /** the total limit is reached → the attempt is finished automatically (answers kept) */
  totalExpired: boolean;
}

export function timerView(policy: Pick<ExamPolicyView, 'total_seconds' | 'per_question_seconds'>, state: Pick<LocalExamState, 'elapsed_ms' | 'timer' | 'current_index'>): TimerView {
  const totalLeftMs = policy.total_seconds ? policy.total_seconds * 1000 - state.elapsed_ms : null;
  const spent = state.timer.item_ms[String(state.current_index)] ?? 0;
  const itemLeftMs = policy.per_question_seconds ? policy.per_question_seconds * 1000 - spent : null;
  return {
    totalLeftMs: totalLeftMs === null ? null : Math.max(0, totalLeftMs),
    itemLeftMs: itemLeftMs === null ? null : Math.max(0, itemLeftMs),
    itemOver: itemLeftMs !== null && itemLeftMs <= 0,
    totalExpired: totalLeftMs !== null && totalLeftMs <= 0,
  };
}

// ───────── local state ─────────
export interface LocalExamState {
  status: ExamAttemptStatus;
  elapsed_ms: number;
  current_index: number;
  answers: Record<string, ExamAnswerState>;
  flagged: number[];
  timer: ExamTimerState;
  finished_at: number | null;
}

export function stateFromDTO(a: ExamAttemptDTO): LocalExamState {
  return {
    status: a.status,
    elapsed_ms: a.elapsed_ms,
    current_index: a.current_index,
    answers: { ...a.answers },
    flagged: [...a.flagged],
    timer: { item_ms: { ...a.timer.item_ms }, pauses: a.timer.pauses, paused_at: a.timer.paused_at },
    finished_at: a.finished_at,
  };
}

export function syncPayload(s: LocalExamState, now: number): ExamAttemptSyncPayload {
  return {
    status: s.status,
    elapsed_ms: Math.round(s.elapsed_ms),
    current_index: s.current_index,
    answers: s.answers,
    flagged: s.flagged,
    timer: { item_ms: Object.fromEntries(Object.entries(s.timer.item_ms).map(([k, v]) => [k, Math.round(v)])), pauses: s.timer.pauses, paused_at: s.timer.paused_at },
    finished_at: s.finished_at,
    client_ts: now,
  };
}

const TERMINAL = new Set<ExamAttemptStatus>(['completed', 'abandoned']);
export const isFinished = (s: Pick<LocalExamState, 'status'>) => TERMINAL.has(s.status);

/**
 * Resume: the local copy (this device, possibly unsynced) merged with the server copy. Per item the newer answer
 * wins and a submitted answer is never replaced; time never decreases; a finished server copy is final.
 */
export function mergeStates(local: LocalExamState | null, server: LocalExamState): LocalExamState {
  if (!local) return server;
  if (isFinished(server)) return server;
  const answers: Record<string, ExamAnswerState> = { ...server.answers };
  for (const [k, a] of Object.entries(local.answers)) {
    const s = answers[k];
    if (!s || (!s.submitted && (a.submitted || a.at > s.at))) answers[k] = a;
  }
  const itemMs: Record<string, number> = { ...server.timer.item_ms };
  for (const [k, v] of Object.entries(local.timer.item_ms)) itemMs[k] = Math.max(itemMs[k] ?? 0, v);
  return {
    // this device is the one running the attempt: its status / position / flags are the latest intent
    status: local.status,
    elapsed_ms: Math.max(local.elapsed_ms, server.elapsed_ms),
    current_index: local.current_index,
    answers,
    flagged: [...new Set([...local.flagged])].sort((a, b) => a - b),
    timer: { item_ms: itemMs, pauses: Math.max(local.timer.pauses, server.timer.pauses), paused_at: local.timer.paused_at },
    finished_at: local.finished_at ?? server.finished_at,
  };
}

/** Choose an option (MCQ single best answer replaces; multi-select toggles). Locked once submitted. */
export function chooseOption(s: LocalExamState, index: number, optionId: string, opts: { multi: boolean; attemptId: string; now: number }): LocalExamState {
  const key = String(index);
  const cur = s.answers[key];
  if (cur?.submitted || isFinished(s)) return s;
  let selected: string[];
  if (opts.multi) selected = cur?.selected_option_ids.includes(optionId) ? cur.selected_option_ids.filter((x) => x !== optionId) : [...(cur?.selected_option_ids ?? []), optionId];
  else selected = [optionId];
  const next: ExamAnswerState = {
    attempt_id: cur?.attempt_id ?? opts.attemptId,
    selected_option_ids: selected,
    confidence: cur?.confidence ?? null,
    at: opts.now,
    time_ms: Math.round(s.timer.item_ms[key] ?? 0),
    hints_used: cur?.hints_used ?? 0,
    solution_viewed_before_answer: cur?.solution_viewed_before_answer ?? false,
    submitted: false,
  };
  return { ...s, answers: { ...s.answers, [key]: next } };
}

export function setConfidence(s: LocalExamState, index: number, confidence: ConfidenceLevel, now: number): LocalExamState {
  const key = String(index);
  const cur = s.answers[key];
  if (!cur || isFinished(s)) return s;
  return { ...s, answers: { ...s.answers, [key]: { ...cur, confidence, at: cur.submitted ? cur.at : now } } };
}

export function patchAnswer(s: LocalExamState, index: number, patch: Partial<ExamAnswerState>): LocalExamState {
  const key = String(index);
  const cur = s.answers[key];
  if (!cur) return s;
  return { ...s, answers: { ...s.answers, [key]: { ...cur, ...patch } } };
}

export function toggleFlag(s: LocalExamState, index: number): LocalExamState {
  const has = s.flagged.includes(index);
  return { ...s, flagged: has ? s.flagged.filter((i) => i !== index) : [...s.flagged, index].sort((a, b) => a - b) };
}

/** Advance the clocks by `ms` of ACTIVE time (never while paused or finished). */
export function tick(s: LocalExamState, ms: number): LocalExamState {
  if (s.status !== 'in_progress' || ms <= 0) return s;
  const key = String(s.current_index);
  return { ...s, elapsed_ms: s.elapsed_ms + ms, timer: { ...s.timer, item_ms: { ...s.timer.item_ms, [key]: (s.timer.item_ms[key] ?? 0) + ms } } };
}

export function pause(s: LocalExamState, policy: Pick<ExamPolicyView, 'pause_allowed'>, now: number): LocalExamState {
  if (!policy.pause_allowed || s.status !== 'in_progress') return s;
  return { ...s, status: 'paused', timer: { ...s.timer, pauses: s.timer.pauses + 1, paused_at: now } };
}

export function resume(s: LocalExamState): LocalExamState {
  if (s.status !== 'paused') return s;
  return { ...s, status: 'in_progress', timer: { ...s.timer, paused_at: null } };
}

export function finish(s: LocalExamState, now: number): LocalExamState {
  if (isFinished(s)) return s;
  return { ...s, status: 'completed', finished_at: now, timer: { ...s.timer, paused_at: null } };
}

export function answeredCount(s: Pick<LocalExamState, 'answers'>): number {
  return Object.values(s.answers).filter((a) => a.selected_option_ids.length > 0).length;
}

/** «السؤال 3، مُجاب، مُعلَّم، الحالي» — state in words, never by colour alone. */
export function navigatorLabel(index: number, s: LocalExamState): string {
  const a = s.answers[String(index)];
  const parts = [`السؤال ${index + 1}`];
  parts.push(a?.submitted ? 'تحققت من إجابته' : a && a.selected_option_ids.length ? 'مُجاب' : 'غير مُجاب');
  if (s.flagged.includes(index)) parts.push('مُعلَّم للمراجعة');
  if (s.current_index === index) parts.push('الحالي');
  return parts.join('، ');
}

// ───────── labels ─────────
export const CONFIDENCE_LABELS_AR: Record<ConfidenceLevel, string> = { guess: 'تخمين', unsure: 'غير متأكد', confident: 'واثق' };

export const MISTAKE_HELP_AR: Record<MistakeType, string> = {
  knowledge_gap: 'لم تكن المعلومة لديك.',
  misunderstanding: 'فهمت الفكرة بشكل غير دقيق.',
  concept_confusion: 'خلطت بين مفهومين متقاربين.',
  misread: 'قرأت السؤال أو كلمة النفي بشكل خاطئ.',
  first_line_vs_confirmatory: 'خلطت بين الفحص الأولي والفحص المؤكِّد.',
  step_order: 'أخطأت ترتيب الخطوات.',
  time_pressure: 'ضيق الوقت أثّر على الإجابة.',
};

/** Arabic count agreement for questions: «سؤال واحد»، «سؤالان»، «3 أسئلة»، «11 سؤالًا». */
export function questionsAr(n: number): string {
  if (n === 0) return 'لا أسئلة';
  if (n === 1) return 'سؤال واحد';
  if (n === 2) return 'سؤالان';
  if (n >= 3 && n <= 10) return `${n} أسئلة`;
  return `${n} سؤالًا`;
}

/** «7 من 10» — the denominator is always shown (no bare percentages). */
export function ofAr(n: number, d: number): string {
  return `${n} من ${d}`;
}
