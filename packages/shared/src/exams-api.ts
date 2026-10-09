// Practice & exams HTTP + sync contract (/api/exams, track C4) — shapes not covered by questions.ts.
// Implemented by apps/server/src/modules/exams, consumed by apps/web/src/features/exams.
// questions.ts types (ExamConfig, ExamPolicy, ExamItemView, QuestionAttemptInput, AttemptFeedback,
// ExamResultView) are used EXACTLY; the types below only add to them.
import type { JobView } from './api';
import type { AnswerStatus, ConfidenceLevel, MistakeType, QuestionType } from './enums';
import type { ClaimView } from './evidence';
import { MASTERY_WEIGHTS } from './learning';
import type { RichText } from './richtext';
import type { SourceScope } from './scope';
import type { AttemptFeedback, ExamConfig, ExamItemView, ExamPolicy, ExamResultView, QuestionAttemptInput, QuestionOccurrenceView } from './questions';

// ───────── modes & policy ─────────
export type ExamMode = ExamConfig['mode'];
export const EXAM_MODES: readonly ExamMode[] = ['practice', 'exam', 'time_pressure', 'simulation', 'revision'];
export const EXAM_MODE_LABELS_AR: Record<ExamMode, string> = {
  practice: 'تدريب',
  exam: 'امتحان',
  time_pressure: 'تدريب تحت ضغط الوقت',
  simulation: 'محاكاة امتحان',
  revision: 'مراجعة',
};
/** Assessed modes: only scorable questions, no hints, solutions only after finishing (§39, AC-14, AC-19). */
export const ASSESSED_MODES: readonly ExamMode[] = ['exam', 'time_pressure', 'simulation'];
export function isAssessedMode(mode: ExamMode): boolean {
  return ASSESSED_MODES.includes(mode);
}

/** ExamPolicy + the optional Anti-shortcut mode (§39). Fixed when the exam is created; never changes mid-attempt. */
export interface ExamPolicyView extends ExamPolicy {
  /** the solution button stays hidden until an answer was chosen */
  anti_shortcut: boolean;
}

/** Item types a question type can be delivered in the MCQ runner. Written types use the written flow (§41). */
export const MCQ_QUESTION_TYPES: readonly QuestionType[] = ['sba', 'multi_select', 'true_false'];
export const WRITTEN_QUESTION_TYPES: readonly QuestionType[] = ['short_answer', 'essay', 'enumerate', 'compare', 'clinical_written'];

// ───────── builder ─────────
export interface ExamCreateRequest extends ExamConfig {
  /** client ULID of the attempt: a retried create returns the same exam/attempt (idempotent) */
  attempt_id?: string;
  /** owner choices; assessed modes force hints 'off' and show_solution 'at_end' */
  policy?: Partial<Pick<ExamPolicyView, 'pause_allowed' | 'hints' | 'shuffle_options' | 'anti_shortcut'>>;
  /** /practice deep link: this question comes first */
  start_question_id?: string | null;
  /** deterministic selection / shuffling (tests, reproducible simulations) */
  seed?: string | null;
}

export type ExamExclusionCode =
  | 'unscorable' // key unresolved / blocking validation — never in assessed modes (AC-14)
  | 'duplicate' // same question via another occurrence / confirmed duplicate (AC-17)
  | 'written_type' // essay / short answer → written flow
  | 'difficulty' // estimated difficulty differs from the requested one
  | 'media_unavailable' // the question needs a picture that cannot be delivered
  | 'origin_mix' // the source/generated ratio left it out
  | 'not_needed'; // more matching questions than requested

export interface ExamBuildExclusion {
  code: ExamExclusionCode;
  reason_ar: string;
  count: number;
  /** first ids (capped) so the owner can open them */
  question_ids: string[];
}

/** What the builder found and why items were left out — real counts, never estimates. */
export interface ExamBuildReport {
  requested: number;
  /** questions matching the scope/filters (after merging occurrences), before scoring rules */
  matched: number;
  scorable: number;
  unscorable: number;
  duplicates_removed: number;
  selected: number;
  selected_scored: number;
  selected_unscored: number;
  /** of the selected items */
  by_origin: { source: number; generated: number; owner: number };
  /** «أخطائي» found in the scope (latest scored attempt wrong) */
  my_mistakes: number;
  exclusions: ExamBuildExclusion[];
  notes_ar: string[];
}

export interface ExamPreviewResponse {
  report: ExamBuildReport;
}

// ───────── attempt state (sync entity 'exam_attempt') ─────────
export type ExamAttemptStatus = 'in_progress' | 'paused' | 'completed' | 'abandoned';
export const EXAM_ATTEMPT_STATUS_LABELS_AR: Record<ExamAttemptStatus, string> = {
  in_progress: 'جارية',
  paused: 'متوقفة مؤقتًا',
  completed: 'منتهية',
  abandoned: 'متروكة',
};

/** The owner's current answer to one item while the attempt runs (exam mode: changeable until finishing). */
export interface ExamAnswerState {
  /** client ULID of the question_attempt this answer becomes (stable across edits and retries) */
  attempt_id: string;
  selected_option_ids: string[];
  confidence: ConfidenceLevel | null;
  /** epoch ms of the last change of THIS answer (per-item merge across devices) */
  at: number;
  time_ms: number | null;
  hints_used: number;
  solution_viewed_before_answer: boolean;
  /** practice: the answer was submitted (locked, appended as a question_attempt) */
  submitted: boolean;
}

export interface ExamTimerState {
  /** active (non-paused) ms spent on each item, by item index */
  item_ms: Record<string, number>;
  /** pauses taken (only possible when the policy allows it) */
  pauses: number;
  paused_at: number | null;
}

/** Server copy of an exam attempt (sync DTO, pull + push responses). */
export interface ExamAttemptDTO {
  id: string;
  exam_id: string;
  status: ExamAttemptStatus;
  started_at: number;
  finished_at: number | null;
  /** active time (pauses excluded); never decreases */
  elapsed_ms: number;
  current_index: number;
  answers: Record<string, ExamAnswerState>;
  flagged: number[];
  timer: ExamTimerState;
  rev: number;
  updated_at: number;
}

/** Sync payload for 'exam_attempt' upserts: the FULL mutable state (policy and items can never be sent). */
export interface ExamAttemptSyncPayload {
  status: ExamAttemptStatus;
  elapsed_ms: number;
  current_index: number;
  answers: Record<string, ExamAnswerState>;
  flagged: number[];
  timer: ExamTimerState;
  finished_at?: number | null;
  client_ts?: number;
}

// ───────── question attempts (sync entity 'question_attempt') ─────────
/** Sync payload for 'question_attempt' appends = QuestionAttemptInput + the exam item it answers. */
export interface QuestionAttemptSyncPayload extends QuestionAttemptInput {
  exam_item_index?: number | null;
}

/** Owner edit of an attempt's derived signals (upsert): the answer itself can never change. */
export interface QuestionAttemptSignalsPayload {
  mistake_type: MistakeType | null;
}

export interface QuestionAttemptDTO {
  id: string;
  question_id: string;
  question_version_id: string;
  exam_attempt_id: string | null;
  exam_item_index: number | null;
  selected_option_ids: string[];
  /** null → not scored */
  is_correct: boolean | null;
  scored: boolean;
  unscored_reason_ar: string | null;
  confidence: ConfidenceLevel | null;
  hints_used: number;
  solution_viewed_before_answer: boolean;
  time_ms: number | null;
  time_budget_ms: number | null;
  flagged: boolean;
  mistake_type: MistakeType | null;
  mistake_origin: 'auto' | 'owner' | null;
  auto_mistake_type: MistakeType | null;
  auto_mistake_reason_ar: string | null;
  answered_at: number;
  created_at: number;
  rev: number;
}

// ───────── AC-27 learning signals ─────────
export type MasterySignal = keyof typeof MASTERY_WEIGHTS;
export const MASTERY_SIGNAL_LABELS_AR: Record<MasterySignal, string> = {
  correct_confident_independent: 'صحيحة بثقة ودون مساعدة',
  correct_unsure: 'صحيحة مع تردد',
  correct_guess: 'صحيحة بالتخمين — لا تُعد إتقانًا',
  correct_after_hint: 'صحيحة بعد تلميح',
  correct_after_solution_viewed: 'صحيحة بعد رؤية الحل — لا تُعد إتقانًا',
  wrong: 'خاطئة',
};

/** The mastery category of an attempt (AC-27): guessed / hint-assisted correct answers are NOT independent mastery. */
export function masterySignal(a: Pick<QuestionAttemptDTO, 'is_correct' | 'confidence' | 'hints_used' | 'solution_viewed_before_answer'>): MasterySignal | null {
  if (a.is_correct === null) return null;
  if (!a.is_correct) return 'wrong';
  if (a.solution_viewed_before_answer) return 'correct_after_solution_viewed';
  if (a.hints_used > 0) return 'correct_after_hint';
  if (a.confidence === 'guess') return 'correct_guess';
  if (a.confidence === 'unsure') return 'correct_unsure';
  return 'correct_confident_independent';
}

// ───────── session (what the runner needs) ─────────
export interface ExamSummaryView {
  id: string;
  title: string;
  mode: ExamMode;
  mode_label_ar: string;
  policy: ExamPolicyView;
  created_at: number;
  is_generated_simulation: boolean;
  item_count: number;
  scored_count: number;
  build: ExamBuildReport | null;
}

export interface ExamSessionView {
  exam: ExamSummaryView;
  attempt: ExamAttemptDTO;
  /** delivery payload: no keys, explanations, sources or revealing media names (AC-19) */
  items: ExamItemView[];
  /** media token URLs expire; reopen the session to refresh them */
  media_expires_at: number | null;
  /** practice: unscored items carry a visible reason (AC-14) */
  unscored_reasons: Record<string, string>;
}

// ───────── hints & solution (practice) ─────────
export interface HintView {
  level: 1 | 2;
  title_ar: string;
  text_ar: string;
  /** level 1: where to look (never the answer) */
  pages: Array<{ source_id: string; lecture_title: string; page_id: string; label_ar: string }>;
  /** level 2: the stem with clue words emphasized + why they matter */
  stem: RichText | null;
  clues: Array<{ text: string; why_ar: string }>;
}

// ───────── feedback (after answering / after finishing) ─────────
export interface AttemptFeedbackView extends AttemptFeedback {
  question_id: string;
  question_version_id: string;
  /** null when the solution was viewed before answering (practice) */
  attempt: QuestionAttemptDTO | null;
  origin_type: 'source' | 'generated' | 'owner';
  /** «سؤال من مصدر الأسئلة …» / «سؤال مولد بواسطة MedLevo من المصادر المحددة» */
  origin_label_ar: string;
  answer_status_label_ar: string;
  /** options in the delivered order with their display labels */
  options: Array<{ id: string; display_label: string; text: RichText }>;
  stem: RichText;
  negation_terms: string[];
  unscored_reason_ar: string | null;
  mastery_signal: MasterySignal | null;
  mistake_reason_ar: string | null;
  /** claims cited in the explanation / distractor explanations (evidence chips) */
  claims: Record<string, ClaimView>;
  /** lecture links shown AFTER answering (never during an exam) */
  lecture_links: Array<{ lecture_source_id: string; lecture_title: string; relation_label_ar: string; pages: Array<{ page_id: string; label_ar: string }> }>;
  /** a later version changed the key: this attempt keeps its original result (AC-26) */
  newer_version_note_ar: string | null;
  /** generated question: estimated difficulty (estimate only), learning objective */
  learning_objective: string | null;
  difficulty_est: string | null;
}

export interface MistakeUpdateRequest {
  mistake_type: MistakeType | null;
}

// ───────── results ─────────
export interface ExamResultItem {
  index: number;
  question_id: string;
  question_version_id: string;
  stem_preview: string;
  origin_type: 'source' | 'generated' | 'owner';
  scored: boolean;
  unscored_reason_ar: string | null;
  answered: boolean;
  is_correct: boolean | null;
  confidence: ConfidenceLevel | null;
  hints_used: number;
  solution_viewed_before_answer: boolean;
  time_ms: number | null;
  over_time_budget: boolean;
  flagged: boolean;
  mistake_type: MistakeType | null;
  mistake_origin: 'auto' | 'owner' | null;
  attempt_id: string | null;
  mastery_signal: MasterySignal | null;
  lecture_titles: string[];
  concepts: string[];
}

export interface ReviewSuggestion {
  kind: 'lecture_pages' | 'retry_question' | 'check_unscored';
  label_ar: string;
  reason_ar: string;
  source_id?: string;
  page_id?: string;
  question_id?: string;
}

export interface ExamResultDetail extends ExamResultView {
  title: string;
  mode: ExamMode;
  status: ExamAttemptStatus;
  finished_at: number | null;
  answered: number;
  unanswered: number;
  by_lecture: Array<{ lecture_source_id: string | null; label: string; correct: number; total: number }>;
  items: ExamResultItem[];
  suggested_review: ReviewSuggestion[];
  time: {
    total_seconds: number | null;
    per_question_seconds: number | null;
    over_budget: { total: number; correct: number };
    within_budget: { total: number; correct: number };
    note_ar: string;
  } | null;
  /** AC-27 data: answers that were right but not independent mastery */
  signals: { correct_guess: number; correct_after_hint: number; solution_viewed: number; confident_wrong: number };
  /** «الدقة = الصحيحة ÷ الأسئلة المحسوبة (n)» */
  denominator_note_ar: string;
  /** question attempts of this exam that the server has not received yet (answers still on a device) */
  missing_on_server: number;
}

// ───────── history ─────────
export interface ExamAttemptListItem {
  attempt_id: string;
  exam_id: string;
  title: string;
  mode: ExamMode;
  status: ExamAttemptStatus;
  started_at: number;
  finished_at: number | null;
  item_count: number;
  answered: number;
  scored_items: number;
  correct: number | null;
}
export interface ExamAttemptListResponse {
  items: ExamAttemptListItem[];
  next_cursor: string | null;
}

// ───────── generated MCQs (§37–§38, AC-18) ─────────
export const GENERATED_ORIGIN_LABEL_AR = 'سؤال مولد بواسطة MedLevo من المصادر المحددة';
export const GENERATION_DIFFICULTIES = ['medium', 'hard', 'very_hard'] as const;
export type GenerationDifficulty = (typeof GENERATION_DIFFICULTIES)[number];
export const GENERATION_DIFFICULTY_LABELS_AR: Record<GenerationDifficulty, string> = {
  medium: 'متوسط',
  hard: 'صعب',
  very_hard: 'صعب جدًا',
};
export const GENERATED_ITEM_TYPES = [
  'vignette', 'diagnosis', 'investigation', 'next_step', 'management', 'mechanism', 'complications', 'risk_factors', 'interpretation', 'recall',
] as const;
export type GeneratedItemType = (typeof GENERATED_ITEM_TYPES)[number];
export const GENERATED_ITEM_TYPE_LABELS_AR: Record<GeneratedItemType, string> = {
  vignette: 'حالة سريرية (Clinical Vignette)',
  diagnosis: 'التشخيص',
  investigation: 'الفحوصات',
  next_step: 'الخطوة التالية (Best Next Step)',
  management: 'العلاج والتدبير',
  mechanism: 'الآلية',
  complications: 'المضاعفات',
  risk_factors: 'عوامل الخطر',
  interpretation: 'تفسير النتائج',
  recall: 'استرجاع معلومة',
};

export interface GenerateQuestionsRequest {
  lecture_source_id: string;
  /** default: lecture_only on this lecture. Wider scopes only by explicit owner choice. */
  scope?: SourceScope | null;
  topic?: string | null;
  /** generate from these lecture pages (anchors) */
  page_ids?: string[];
  count: number;
  difficulty: GenerationDifficulty;
  item_types?: GeneratedItemType[];
  language?: 'en' | 'ar';
}

export type GenerationRunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'needs_review' | 'abstained' | 'failed';
export const GENERATION_RUN_STATUS_LABELS_AR: Record<GenerationRunStatus, string> = {
  queued: 'في الانتظار',
  running: 'قيد التوليد والتحقق',
  completed: 'اكتمل',
  partial: 'اكتمل جزئيًا',
  needs_review: 'لم يُنشر شيء: الأسئلة تحتاج مراجعتك',
  abstained: 'امتنع عن التوليد',
  failed: 'فشل',
};

export interface GeneratedCandidateView {
  id: string;
  ord: number;
  status: 'published' | 'needs_review' | 'rejected';
  /** generation + repair rounds used (max 3) */
  rounds: number;
  question_id: string | null;
  stem_preview: string;
  learning_objective: string | null;
  concepts: string[];
  difficulty_est: string | null;
  issues: Array<{ check: string; reason_ar: string; by: 'deterministic' | 'evidence' | 'validator' }>;
}

export interface GenerationRunView {
  id: string;
  status: GenerationRunStatus;
  status_label_ar: string;
  request: GenerateQuestionsRequest;
  scope_describe_ar: string;
  job: JobView | null;
  abstain: null | { reason: string; reason_ar: string; detail: string; suggestion_ar: string; suggest_scope?: SourceScope };
  candidates: GeneratedCandidateView[];
  summary_ar: string;
  created_at: number;
}

export interface GenerateQuestionsResponse {
  run: GenerationRunView;
}

// ───────── written answers (§41) ─────────
export const WRITTEN_ASSESSMENT_LABEL_AR = 'تقييم تعليمي آلي، ليس تصحيحًا رسميًا';

export interface WrittenAttemptInput {
  /** client ULID (idempotent) */
  id: string;
  question_id: string;
  question_version_id: string;
  answer_text: string;
  /** text recognized from handwriting (not available in this build); never graded until confirmed */
  recognized_text?: string | null;
  recognized_confirmed?: boolean;
  answered_at: number;
}

export interface RubricPointView {
  id: string;
  text: string;
  weight: number;
  claim_id: string | null;
  evidence_ids: string[];
}

export interface WrittenAssessmentView {
  kind: 'rubric_score' | 'qualitative_only';
  label_ar: string;
  rubric_origin: 'question' | 'generated' | null;
  rubric: RubricPointView[];
  points: Array<{ rubric_id: string; status: 'correct' | 'partial' | 'missing' | 'wrong'; note: string }>;
  wrong_statements: Array<{ text: string; why: string }>;
  /** estimate (sum of matched rubric weights); null when the rubric is not sufficient */
  estimated_score: { got: number; max: number } | null;
  improved_answer: RichText | null;
  qualitative_feedback: string[];
  claims: Record<string, ClaimView>;
  removed: Array<{ text: string; reason_ar: string }>;
  notes_ar: string[];
}

export interface WrittenAttemptView {
  id: string;
  question_id: string;
  question_version_id: string;
  answer_text: string;
  recognized_text: string | null;
  recognized_confirmed: boolean;
  status: 'saved' | 'graded' | 'grading_failed';
  answered_at: number;
  graded_at: number | null;
  assessment: WrittenAssessmentView | null;
  error_ar: string | null;
}

export interface WrittenQuestionView {
  question_id: string;
  question_version_id: string;
  qtype: QuestionType;
  stem: RichText;
  origin_label_ar: string;
  answer_status: AnswerStatus;
  has_rubric: boolean;
  attempts: WrittenAttemptView[];
  occurrences: QuestionOccurrenceView[];
}

// ───────── HTTP envelopes (/api/exams) ─────────
export interface ExamCreateResponse {
  session: ExamSessionView;
  /** false when a retried create (same attempt_id) returned the existing exam */
  created: boolean;
}

export interface HintRequest {
  level: 1 | 2;
}
export interface HintResponse {
  hint: HintView;
}

/** Practice «تحقق من إجابتي»: the answer of one item (QuestionAttemptInput minus what the item pins). */
export interface PracticeAnswerRequest {
  id: string;
  selected_option_ids: string[];
  confidence?: ConfidenceLevel | null;
  hints_used?: number;
  solution_viewed_before_answer?: boolean;
  time_ms?: number | null;
  flagged?: boolean;
  answered_at: number;
}

export interface MistakeUpdateResponse {
  attempt: QuestionAttemptDTO;
}

export interface GenerationRunListResponse {
  runs: GenerationRunView[];
}

export interface WrittenAttemptResponse {
  attempt: WrittenAttemptView;
}

export interface WrittenGradeRequest {
  /** explicit owner choice; default: the lecture of the question's best link (lecture only) */
  scope?: SourceScope | null;
}

/** Route of the written flow for a question (written types are not delivered by the MCQ runner). */
export function writtenUrl(questionId: string): string {
  return `/exams/written/${encodeURIComponent(questionId)}`;
}
