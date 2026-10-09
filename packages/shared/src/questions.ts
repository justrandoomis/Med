// Question Vault, keys, matching, duplicates, exams and attempts contract (§33–§41, AC-10…AC-19).
import type { AnswerStatus, ConfidenceLevel, LectureLinkRelation, MistakeType, QuestionType } from './enums';
import type { NormBox } from './geometry';
import type { RichText } from './richtext';
import type { ClaimView } from './evidence';

export interface QuestionOptionView {
  id: string; // stable; keys reference this, never labels or display order
  option_key: string; // 'o1'.. stable across versions
  source_label: string | null; // as printed: 'A', 'b', 'أ'
  ord: number; // source order
  text: RichText;
  raw_text: string | null;
  region_id: string | null;
  pinned_position: boolean; // e.g. "all of the above" stays last
}

export interface QuestionOccurrenceView {
  id: string;
  source_id: string;
  source_title: string;
  source_type: string;
  source_version_id: string;
  section_key: string;
  section_title: string | null;
  printed_number: string | null;
  pages: Array<{ page_id: string; page_index: number; label_ar: string }>;
  region_ids: string[];
  /** «سؤال من مصدر الأسئلة — <اسم المصدر> — ص 34 — رقم السؤال 3» (§35) */
  origin_label_ar: string;
}

export interface AnswerKeyEntryView {
  id: string;
  section_key: string;
  printed_number: string;
  key_label: string;
  mark_kind: 'printed_key' | 'key_table' | 'circled_option' | 'handwritten' | 'highlight' | 'unknown';
  origin_known: boolean;
  page_id: string | null;
  region_id: string | null;
}

export interface QuestionVersionView {
  id: string;
  question_id: string;
  version_no: number;
  kind: 'raw_extraction' | 'structured' | 'owner_correction' | 'translation' | 'paraphrase' | 'generated';
  derived_from_version_id: string | null;
  lang: string | null;
  qtype: QuestionType;
  item_type: string | null;
  stem: RichText;
  stem_raw: string | null;
  has_negation: boolean;
  negation_terms: string[];
  shuffle_allowed: boolean;
  extraction_status: 'not_applicable' | 'extracted' | 'checks_passed' | 'needs_review' | 'owner_reviewed';
  answer_status: AnswerStatus;
  correct_option_ids: string[] | null;
  key_details: { key_entry_ids?: string[]; conflict_ar?: string; notes_ar?: string } | null;
  explanation: RichText | null;
  distractor_explanations: Record<string, RichText> | null;
  learning_objective: string | null;
  difficulty_est: string | null; // estimate only
  owner_reviewed_fields: string[];
  validation: QuestionValidation | null;
  created_by: 'extraction' | 'generation' | 'owner' | 'translation';
  model: string | null;
  created_at: number;
  options: QuestionOptionView[];
  claims?: Record<string, ClaimView>;
}

export interface QuestionValidationIssue {
  check:
    | 'stem_complete' | 'options_complete' | 'option_order' | 'merged_questions' | 'negation_preserved' | 'numbers_units_preserved'
    | 'images_attached' | 'key_bound' | 'key_conflict' | 'unofficial_mark' | 'single_best_answer' | 'distractors_explained'
    | 'no_answer_leak' | 'evidence_supported' | 'scope';
  passed: boolean;
  severity: 'blocker' | 'warning';
  reason_ar: string;
}
export interface QuestionValidation {
  issues: QuestionValidationIssue[];
  /** true only if no blocker failed — required before a question can be scored in an exam */
  publishable: boolean;
}

export interface QuestionView {
  id: string;
  origin_type: 'source' | 'generated' | 'owner';
  /** «سؤال من مصدر الأسئلة …» vs «سؤال مولد بواسطة MedLevo من المصادر المحددة» (§35, §62) */
  origin_label_ar: string;
  status: 'draft' | 'needs_review' | 'ready' | 'retired';
  course_node_id: string | null;
  current: QuestionVersionView;
  occurrences: QuestionOccurrenceView[];
  lecture_links: LectureLinkView[];
  duplicates: DuplicateView[];
  attempts_summary: { total: number; correct: number; last_at: number | null };
  created_at: number;
  updated_at: number;
}

export interface LectureLinkView {
  id: string;
  question_id: string;
  lecture_source_id: string;
  lecture_title: string;
  relation: LectureLinkRelation;
  score: number | null;
  reason: string; // Arabic, specific
  matched_terms: string[];
  lecture_pages: Array<{ page_id: string; page_index: number; label_ar: string }>;
  answerable_from_lecture: boolean;
  origin: 'auto' | 'owner';
  status: 'suggested' | 'accepted' | 'rejected';
  decision_reason: string | null;
}

export interface DuplicateView {
  id: string;
  other_question_id: string;
  kind: 'exact' | 'near' | 'paraphrase';
  similarity: number | null;
  /** reasons the pair must NOT be merged (negation differs, numbers differ, options differ, keys differ) */
  blockers: string[];
  status: 'suggested' | 'confirmed' | 'rejected';
}

// ───────── extraction (deterministic parser output, before persistence) ─────────
export interface ExtractedOption {
  label: string;
  text: string;
  region_ids: string[];
  page_index: number;
  bbox?: NormBox;
}
export interface ExtractedQuestion {
  section_key: string; // stable section identity within the version (e.g. 'A', 'B', or 'sec-2')
  section_title: string | null;
  printed_number: string;
  stem: string;
  options: ExtractedOption[];
  page_indexes: number[]; // pages it spans (AC-10)
  region_ids: string[];
  issues: QuestionValidationIssue[];
}
export interface ExtractedKeyEntry {
  section_key: string;
  printed_number: string;
  key_label: string;
  mark_kind: AnswerKeyEntryView['mark_kind'];
  origin_known: boolean;
  page_index: number;
  region_ids: string[];
}

// ───────── practice & exams ─────────
export interface ExamConfig {
  title: string;
  mode: 'practice' | 'exam' | 'time_pressure' | 'simulation' | 'revision';
  source_ids?: string[]; // lectures / question sources in scope
  course_node_ids?: string[];
  question_ids?: string[]; // explicit selection
  count: number;
  minutes?: number | null;
  per_question_seconds?: number | null;
  qtypes?: QuestionType[];
  origin_mix?: { source: number; generated: number }; // ratios
  include_my_mistakes?: boolean;
  lecture_only_answerable?: boolean; // «من محاضرتي فقط» (§35)
  difficulty?: 'any' | 'easy' | 'medium' | 'hard';
}
export interface ExamPolicy {
  pause_allowed: boolean;
  hints: 'off' | 'progressive';
  show_solution: 'after_each' | 'at_end';
  shuffle_options: boolean;
  per_question_seconds: number | null;
  total_seconds: number | null;
}

/** Question as delivered DURING an exam: no key, no explanation, no source preview, neutral media names (AC-19). */
export interface ExamItemView {
  index: number;
  question_id: string;
  question_version_id: string;
  qtype: QuestionType;
  stem: RichText;
  options: Array<{ id: string; display_label: string; text: RichText }>;
  has_negation: boolean;
  negation_terms: string[];
  media: Array<{ token_url: string; alt_ar: string }>;
  /** whether this item counts toward the score (unresolved keys never do) */
  scored: boolean;
}

export interface QuestionAttemptInput {
  id: string; // client ULID (idempotent)
  question_id: string;
  question_version_id: string;
  exam_attempt_id?: string | null;
  selected_option_ids: string[];
  confidence?: ConfidenceLevel | null;
  hints_used?: number;
  solution_viewed_before_answer?: boolean;
  time_ms?: number | null;
  flagged?: boolean;
  answered_at: number;
}

export interface AttemptFeedback {
  is_correct: boolean | null; // null → not scored (key unresolved)
  scored: boolean;
  correct_option_ids: string[] | null;
  answer_status: AnswerStatus;
  explanation: RichText | null;
  distractor_explanations: Record<string, RichText> | null;
  occurrences: QuestionOccurrenceView[];
  suggested_mistake_type: MistakeType | null;
}

export interface ExamResultView {
  attempt_id: string;
  total_items: number;
  scored_items: number;
  correct: number;
  accuracy: number | null; // correct / scored_items
  elapsed_ms: number;
  hints_used: number;
  by_concept: Array<{ label: string; correct: number; total: number }>;
  unscored_reasons: Array<{ question_id: string; reason_ar: string }>;
  strong: string[];
  weak: string[];
}
