// Rows, read models and DTOs of the exams module (tables: exam, exam_attempt, question_attempt, exam_item_event,
// question_generation_run, generated_question_candidate, written_attempt — ARCHITECTURE §2 range 0550–0599).
import {
  EXAM_MODE_LABELS_AR,
  isAssessedMode,
  type ConfidenceLevel,
  type ExamAnswerState,
  type ExamAttemptDTO,
  type ExamAttemptStatus,
  type ExamBuildReport,
  type ExamMode,
  type ExamPolicyView,
  type ExamSummaryView,
  type ExamTimerState,
  type MistakeType,
  type QuestionAttemptDTO,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';

// ───────── exam ─────────
/** One delivered item, pinned at creation (items_json). */
export interface ExamItemRecord {
  question_id: string;
  question_version_id: string;
  /** option ids in delivery order (stable ids; the key references ids, never labels or positions) */
  option_order: string[];
  display_labels: string[];
  scored: boolean;
  unscored_reason_ar: string | null;
  origin_type: 'source' | 'generated' | 'owner';
}

export interface ExamRow {
  id: string;
  title: string;
  mode: ExamMode;
  config_json: string;
  policy_json: string;
  items_json: string;
  is_generated_simulation: number;
  created_at: number;
  build_json: string | null;
  seed: string | null;
}

export interface ExamAttemptRow {
  id: string;
  exam_id: string;
  status: ExamAttemptStatus;
  started_at: number;
  finished_at: number | null;
  elapsed_ms: number;
  timer_json: string | null;
  current_index: number;
  result_json: string | null;
  updated_at: number;
  answers_json: string;
  flags_json: string;
  rev: number;
  device_id: string | null;
}

export interface QuestionAttemptRow {
  id: string;
  question_id: string;
  question_version_id: string;
  exam_attempt_id: string | null;
  selected_option_ids_json: string | null;
  is_correct: number | null;
  scored: number;
  confidence: ConfidenceLevel | null;
  hints_used: number;
  solution_viewed_before_answer: number;
  time_ms: number | null;
  flagged: number;
  mistake_type: MistakeType | null;
  mistake_origin: 'auto' | 'owner' | null;
  device_id: string | null;
  answered_at: number;
  created_at: number;
  exam_item_index: number | null;
  unscored_reason: string | null;
  key_status_at_answer: string | null;
  key_at_answer_json: string | null;
  time_budget_ms: number | null;
  auto_mistake_type: MistakeType | null;
  auto_mistake_reason: string | null;
  rev: number;
  updated_at: number | null;
}

export function getExam(db: Db, id: string): ExamRow {
  const r = db.get<ExamRow>('SELECT * FROM exam WHERE id = ?', [id]);
  if (!r) throw new AppError('NOT_FOUND', 'الاختبار غير موجود.', 404);
  return r;
}

export function findAttempt(db: Db, id: string): ExamAttemptRow | null {
  return db.get<ExamAttemptRow>('SELECT * FROM exam_attempt WHERE id = ?', [id]) ?? null;
}

export function getAttempt(db: Db, id: string): ExamAttemptRow {
  const r = findAttempt(db, id);
  if (!r) throw new AppError('NOT_FOUND', 'محاولة الاختبار غير موجودة.', 404);
  return r;
}

export function findQuestionAttempt(db: Db, id: string): QuestionAttemptRow | null {
  return db.get<QuestionAttemptRow>('SELECT * FROM question_attempt WHERE id = ?', [id]) ?? null;
}

export function examItems(e: Pick<ExamRow, 'items_json'>): ExamItemRecord[] {
  return fromJson<ExamItemRecord[]>(e.items_json, []) ?? [];
}

export function examPolicy(e: Pick<ExamRow, 'policy_json'>): ExamPolicyView {
  const p = fromJson<Partial<ExamPolicyView>>(e.policy_json, {}) ?? {};
  return {
    pause_allowed: p.pause_allowed ?? false,
    hints: p.hints ?? 'off',
    show_solution: p.show_solution ?? 'at_end',
    shuffle_options: p.shuffle_options ?? false,
    per_question_seconds: p.per_question_seconds ?? null,
    total_seconds: p.total_seconds ?? null,
    anti_shortcut: p.anti_shortcut ?? false,
  };
}

export function examSummary(e: ExamRow): ExamSummaryView {
  const items = examItems(e);
  return {
    id: e.id,
    title: e.title,
    mode: e.mode,
    mode_label_ar: EXAM_MODE_LABELS_AR[e.mode],
    policy: examPolicy(e),
    created_at: e.created_at,
    is_generated_simulation: e.is_generated_simulation === 1,
    item_count: items.length,
    scored_count: items.filter((i) => i.scored).length,
    build: fromJson<ExamBuildReport | null>(e.build_json, null),
  };
}

/** Policy defaults per mode (§39). Assessed modes: no hints, solution after finishing, pause off by default. */
export function defaultPolicy(mode: ExamMode, minutes: number | null | undefined, perQuestionSeconds: number | null | undefined, count: number): ExamPolicyView {
  const assessed = isAssessedMode(mode);
  const perQ = mode === 'time_pressure' ? (perQuestionSeconds ?? 60) : (perQuestionSeconds ?? null);
  const total = minutes ? Math.round(minutes * 60) : mode === 'time_pressure' && perQ ? perQ * count : null;
  return {
    pause_allowed: !assessed,
    hints: assessed ? 'off' : 'progressive',
    show_solution: assessed ? 'at_end' : 'after_each',
    shuffle_options: assessed,
    per_question_seconds: perQ,
    total_seconds: total,
    anti_shortcut: false,
  };
}

// ───────── DTOs ─────────
export function emptyTimer(): ExamTimerState {
  return { item_ms: {}, pauses: 0, paused_at: null };
}

export function attemptDTO(a: ExamAttemptRow): ExamAttemptDTO {
  const timer = fromJson<Partial<ExamTimerState>>(a.timer_json, {}) ?? {};
  return {
    id: a.id,
    exam_id: a.exam_id,
    status: a.status,
    started_at: a.started_at,
    finished_at: a.finished_at,
    elapsed_ms: a.elapsed_ms,
    current_index: a.current_index,
    answers: fromJson<Record<string, ExamAnswerState>>(a.answers_json, {}) ?? {},
    flagged: fromJson<number[]>(a.flags_json, []) ?? [],
    timer: { item_ms: timer.item_ms ?? {}, pauses: timer.pauses ?? 0, paused_at: timer.paused_at ?? null },
    rev: a.rev,
    updated_at: a.updated_at,
  };
}

export function questionAttemptDTO(r: QuestionAttemptRow): QuestionAttemptDTO {
  return {
    id: r.id,
    question_id: r.question_id,
    question_version_id: r.question_version_id,
    exam_attempt_id: r.exam_attempt_id,
    exam_item_index: r.exam_item_index,
    selected_option_ids: fromJson<string[]>(r.selected_option_ids_json, []) ?? [],
    is_correct: r.is_correct === null ? null : r.is_correct === 1,
    scored: r.scored === 1,
    unscored_reason_ar: r.unscored_reason,
    confidence: r.confidence,
    hints_used: r.hints_used,
    solution_viewed_before_answer: r.solution_viewed_before_answer === 1,
    time_ms: r.time_ms,
    time_budget_ms: r.time_budget_ms,
    flagged: r.flagged === 1,
    mistake_type: r.mistake_type,
    mistake_origin: r.mistake_origin,
    auto_mistake_type: r.auto_mistake_type,
    auto_mistake_reason_ar: r.auto_mistake_reason,
    answered_at: r.answered_at,
    created_at: r.created_at,
    rev: r.rev,
  };
}

/** Arabic count with agreement: «سؤال واحد»، «سؤالان»، «3 أسئلة»، «11 سؤالًا». */
export function questionsAr(n: number): string {
  if (n === 0) return 'لا أسئلة';
  if (n === 1) return 'سؤال واحد';
  if (n === 2) return 'سؤالان';
  if (n >= 3 && n <= 10) return `${n} أسئلة`;
  return `${n} سؤالًا`;
}

export function attemptsAr(n: number): string {
  if (n === 1) return 'محاولة واحدة';
  if (n === 2) return 'محاولتان';
  if (n >= 3 && n <= 10) return `${n} محاولات`;
  return `${n} محاولة`;
}

/** Ensure an exam attempt belongs to the context's DB (used by routes). */
export function attemptWithExam(ctx: AppContext, attemptId: string): { attempt: ExamAttemptRow; exam: ExamRow } {
  const attempt = getAttempt(ctx.db, attemptId);
  const exam = getExam(ctx.db, attempt.exam_id);
  return { attempt, exam };
}
