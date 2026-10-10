// Personal learning contract: flashcards & spaced repetition, weakness center, mistake genome, learning
// profile, study planner, one-tap revision, home (§43, §44, §45, §40 Exam DNA, AC-23, AC-24, AC-27).
import type { ConfidenceLevel, MistakeType } from './enums';
import type { RichText } from './richtext';

// ───────── flashcards & SRS (§43) ─────────
export const FLASHCARD_KINDS = ['basic', 'cloze', 'image_occlusion', 'mistake'] as const;
export type FlashcardKind = (typeof FLASHCARD_KINDS)[number];

/** 1 Again · 2 Hard · 3 Good · 4 Easy */
export type ReviewRating = 1 | 2 | 3 | 4;
export const REVIEW_RATING_LABELS_AR: Record<ReviewRating, string> = { 1: 'مجددًا', 2: 'صعب', 3: 'جيد', 4: 'سهل' };

export type CardState = 'new' | 'learning' | 'review' | 'relearning';
export const CARD_STATE_LABELS_AR: Record<CardState, string> = {
  new: 'جديدة',
  learning: 'قيد التعلّم',
  review: 'مراجعة',
  relearning: 'إعادة تعلّم',
};

export interface OcclusionMask {
  id: string;
  /** normalized box on the ORIGINAL image (non-destructive overlay) */
  box: { x: number; y: number; w: number; h: number };
  label: string;
}

export interface FlashcardDTO {
  id: string; // client ULID
  kind: FlashcardKind;
  front: RichText;
  back: RichText;
  /** cloze: text with {{c1::...}} markers stored in front; image occlusion: image + masks */
  image?: { image_asset_id: string; masks: OcclusionMask[]; active_mask_id?: string } | null;
  concept_id: string | null;
  topic_id: string | null;
  source_id: string | null;
  source_version_id: string | null;
  evidence_ids: string[];
  origin: 'owner' | 'generated' | 'from_mistake' | 'from_selection';
  origin_ref: Record<string, unknown> | null;
  suspended: boolean;
  buried_until: number | null;
  rev: number;
  device_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ReviewEventDTO {
  id: string; // client ULID — an event is applied at most once (AC-24)
  card_id: string;
  rating: ReviewRating;
  reviewed_at: number;
  duration_ms: number | null;
  device_id: string | null;
}

/** Derived (never authored): replaying review events with the documented algorithm. */
export interface ReviewStateView {
  card_id: string;
  algorithm: string; // e.g. 'FSRS-6 via ts-fsrs 5.4.2, w=default, desired_retention=0.9'
  state: CardState;
  due_at: number;
  stability: number | null;
  difficulty: number | null;
  reps: number;
  lapses: number;
  last_review_at: number | null;
  /** estimated recall probability now — an ESTIMATE from the review log, not a measurement (§44) */
  retrievability: number | null;
}

// ───────── weakness & mistakes (§44) ─────────
export interface WeaknessSignal {
  type: 'mcq' | 'card' | 'written' | 'case' | 'osce' | 'viva';
  ref_id: string;
  at: number;
  correct: boolean | null;
  confidence: ConfidenceLevel | null;
  hints_used: number;
  mistake_type: MistakeType | null;
  mistake_origin: 'auto' | 'owner' | null;
}

export interface WeaknessView {
  id: string;
  label: string;
  concept_id: string | null;
  topic_id: string | null;
  source_ids: string[];
  signals: WeaknessSignal[];
  /** transparent estimate with its reasons (never a hidden score) */
  score: number;
  reasons_ar: string[];
  status: 'active' | 'improving' | 'resolved' | 'dismissed';
  suggested_actions: Array<{ kind: 'review_pages' | 'flashcards' | 'practice_questions' | 'simplified_explanation' | 'retry_case'; label_ar: string; ref: Record<string, unknown> }>;
  updated_at: number;
}

/** Mastery estimate rules (AC-27): guessed or hint-assisted correct answers count less than independent confident ones. */
export const MASTERY_WEIGHTS = {
  correct_confident_independent: 1,
  correct_unsure: 0.6,
  correct_guess: 0.2,
  correct_after_hint: 0.35,
  correct_after_solution_viewed: 0,
  wrong: -0.6,
} as const;

// ───────── learning profile (§44) ─────────
export interface LearningProfile {
  self_level: string;
  subjects_studied: string[];
  preferences: { explanation_level: string; dialect: string; socratic: boolean };
  pace_minutes_per_day: number | null;
  /** what the platform currently uses to personalise, each item editable/resettable */
  used_signals_ar: string[];
}

// ───────── planner (§45) ─────────
export interface StudyPlanConfig {
  title: string;
  exam_date: string; // YYYY-MM-DD in owner timezone
  source_ids: string[]; // lectures/references to cover
  available_weekdays: number[]; // 0=Sunday … 6=Saturday
  daily_minutes: number;
  blocked_dates: string[]; // YYYY-MM-DD
  include: { learn: boolean; review: boolean; mcq: boolean; flashcards: boolean; weakness: boolean };
}

export interface PlanTaskView {
  id: string;
  plan_id: string;
  day: string; // YYYY-MM-DD owner timezone
  kind: 'learn' | 'review' | 'mcq' | 'flashcards' | 'weakness' | 'exam';
  title_ar: string;
  ref: Record<string, unknown> | null;
  minutes: number;
  status: 'todo' | 'done' | 'skipped' | 'moved';
  moved_from_day: string | null;
}

export interface PlanRebalanceReport {
  moved: number;
  dropped_ar: string[]; // what no longer fits — said explicitly, never an impossible last day
  feasible: boolean;
  summary_ar: string;
}

// ───────── progress separation (§45) ─────────
export interface SourceProgressView {
  source_id: string;
  reading_progress: number; // pages viewed / total — NOT mastery
  explanation_coverage: number; // study book sections generated & verified / total
  practice_count: number;
  mastery_estimate: number | null; // estimate from attempts & reviews
}

// ───────── home (§45) ─────────
export interface HomeView {
  continue: Array<{ source_id: string; title: string; version_id: string | null; page_label_ar: string | null; mode: string; updated_at: number }>;
  today: PlanTaskView[];
  due_cards: number;
  new_cards_available: number;
  exam: { title: string; date: string; days_left: number } | null;
  top_weakness: WeaknessView | null;
  important_questions: Array<{ question_id: string; reason_ar: string }>;
}

// ───────── one-tap revision (§45) ─────────
export interface RevisionSessionRequest {
  minutes: number;
  course_node_id?: string | null;
  source_ids?: string[];
}
export interface RevisionSessionView {
  id: string;
  minutes: number;
  items: Array<
    | { kind: 'flashcard'; card_id: string; est_minutes: number; reason_ar: string }
    | { kind: 'question'; question_id: string; est_minutes: number; reason_ar: string }
    | { kind: 'pages'; source_id: string; page_indexes: number[]; est_minutes: number; reason_ar: string }
  >;
  explanation_ar: string; // why these items (transparent)
}

// ───────── Exam DNA (§40) ─────────
export interface ExamDnaView {
  sample: { files: number; unique_questions: number; occurrences: number; date_range: string | null };
  /** each row has an explicit denominator */
  by_concept: Array<{ label: string; unique: number; occurrences: number; denominator_unique: number }>;
  by_item_type: Array<{ item_type: string; count: number; denominator: number }>;
  warnings_ar: string[]; // small/old/unrepresentative samples
  relevance_note_ar: string; // «مؤشر أهمية داخل أرشيفك، وليس احتمال ظهور السؤال»
}
