// Question Vault HTTP contract (/api/questions) — request/response shapes not covered by questions.ts.
// Implemented by apps/server/src/modules/questions, consumed by apps/web/src/features/questions and the
// workspace «الأسئلة» rail tab. Views reuse questions.ts (QuestionView, QuestionVersionView, …) exactly.
import type { AnswerStatus, LectureLinkRelation, QuestionType, ReviewQueueKind } from './enums';
import type { JobView } from './api';
import type { NormBox } from './geometry';
import type { RichText } from './richtext';
import type {
  AnswerKeyEntryView,
  DuplicateView,
  LectureLinkView,
  QuestionOccurrenceView,
  QuestionValidation,
  QuestionVersionView,
  QuestionView,
} from './questions';

/** Job kinds handled by the questions module. */
export const EXTRACT_QUESTIONS_JOB_KIND = 'extract_questions';
export const MATCH_QUESTIONS_JOB_KIND = 'match_questions';
export interface ExtractQuestionsJobInput {
  version_id: string;
}
/** Either a source version (lecture → match the course's questions; question source → match its questions)
 *  or explicit questions (quick add / owner questions). */
export interface MatchQuestionsJobInput {
  version_id?: string;
  question_ids?: string[];
}

export type QuestionStatus = QuestionView['status'];
export type ExtractionStatus = QuestionVersionView['extraction_status'];

export const QUESTION_STATUS_LABELS_AR: Record<QuestionStatus, string> = {
  draft: 'مسودة',
  needs_review: 'يحتاج مراجعة',
  ready: 'جاهز للتدريب',
  retired: 'مستبعد',
};

/** Precise extraction labels (never "verified by AI"). */
export const EXTRACTION_STATUS_LABELS_AR: Record<ExtractionStatus, string> = {
  not_applicable: 'أضفته بنفسك',
  extracted: 'مستخرج',
  checks_passed: 'اجتاز فحوص الاستخراج',
  needs_review: 'الاستخراج يحتاج مراجعة',
  owner_reviewed: 'راجعته شخصيًا',
};

export const QUESTION_TYPE_LABELS_AR: Record<QuestionType, string> = {
  sba: 'اختيار من متعدد (إجابة واحدة)',
  multi_select: 'اختيار متعدد',
  true_false: 'صح أو خطأ',
  short_answer: 'إجابة قصيرة',
  essay: 'مقالي',
  enumerate: 'عدّد',
  compare: 'قارن',
  clinical_written: 'حالة سريرية مكتوبة',
};

export const QUESTION_ORIGIN_LABELS_AR: Record<QuestionView['origin_type'], string> = {
  source: 'من مصدر أسئلة',
  generated: 'مولد بواسطة MedLevo',
  owner: 'أضفته بنفسك',
};

export const KEY_MARK_KIND_LABELS_AR: Record<AnswerKeyEntryView['mark_kind'], string> = {
  printed_key: 'مفتاح مطبوع',
  key_table: 'جدول مفتاح',
  circled_option: 'دائرة حول خيار (ليست مفتاحًا رسميًا)',
  handwritten: 'علامة بخط اليد (ليست مفتاحًا رسميًا)',
  highlight: 'تظليل (ليس مفتاحًا رسميًا)',
  unknown: 'علامة غير معروفة',
};

export type KeyBinding = 'bound' | 'ambiguous_section' | 'no_matching_question' | 'unofficial';
export const KEY_BINDING_LABELS_AR: Record<KeyBinding, string> = {
  bound: 'مربوط بالسؤال (القسم + الرقم + النسخة)',
  ambiguous_section: 'لم يُربط: المفتاح بلا قسم في ملف متعدد الأقسام',
  no_matching_question: 'لم يُربط: لا يوجد سؤال بهذا الرقم في هذا القسم',
  unofficial: 'علامة غير رسمية — لا تُعد مفتاحًا',
};

/** Key entry plus where it was bound (detail screen). */
export interface KeyEntryDetail extends AnswerKeyEntryView {
  key_block: number;
  binding: KeyBinding;
  section_title: string | null;
  raw_text: string | null;
  source_id: string;
  source_title: string;
  page_label_ar: string | null;
  /** the option this label maps to in the bound occurrence (null when unbound / no such option) */
  option_key: string | null;
}

// ───────── list ─────────
export interface QuestionListQuery {
  course_id?: string;
  source_id?: string;
  lecture_id?: string;
  relation?: LectureLinkRelation;
  answer_status?: AnswerStatus;
  extraction_status?: ExtractionStatus;
  status?: QuestionStatus;
  origin?: QuestionView['origin_type'];
  review?: 'open' | 'none';
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface QuestionListItem {
  id: string;
  origin_type: QuestionView['origin_type'];
  origin_label_ar: string;
  status: QuestionStatus;
  version_id: string;
  version_no: number;
  qtype: QuestionType;
  stem_preview: string;
  has_negation: boolean;
  negation_terms: string[];
  answer_status: AnswerStatus;
  extraction_status: ExtractionStatus;
  options_count: number;
  occurrences_count: number;
  /** first occurrence (source order) */
  primary_occurrence: Pick<QuestionOccurrenceView, 'source_id' | 'source_title' | 'section_key' | 'section_title' | 'printed_number' | 'pages'> | null;
  open_review: Array<{ id: string; kind: ReviewQueueKind; reason: string }>;
  lecture_links: Array<{ lecture_source_id: string; lecture_title: string; relation: LectureLinkRelation; status: LectureLinkView['status'] }>;
  /** true only when the key is scorable AND no blocking validation failed */
  scorable: boolean;
  unscorable_reason_ar: string | null;
  updated_at: number;
}

export interface QuestionListResponse {
  items: QuestionListItem[];
  next_cursor: string | null;
  /** total matching the filters (real count, not an estimate) */
  total: number;
}

// ───────── detail ─────────
export interface QuestionReviewItemView {
  id: string;
  kind: ReviewQueueKind;
  kind_label_ar: string;
  entity_type: string;
  entity_id: string;
  question_id: string | null;
  source_id: string | null;
  reason: string;
  status: 'open' | 'accepted' | 'corrected' | 'rejected' | 'dismissed';
  details: Record<string, unknown> | null;
  created_at: number;
  resolved_at: number | null;
}

export interface QuestionDetailResponse {
  question: QuestionView;
  /** newest first; attempted versions are immutable */
  versions: Array<QuestionVersionView & { attempts: number; note: string | null }>;
  key_entries: KeyEntryDetail[];
  review_items: QuestionReviewItemView[];
  /** attempts per version (owner's history is never re-graded silently) */
  attempts_by_version: Record<string, number>;
  /** occurrence id → the regions of the question block (open the original page with the region highlighted) */
  occurrence_boxes: Record<string, Array<{ page_id: string; page_index: number; region_id: string | null; bbox: NormBox | null }>>;
  scorable: boolean;
  unscorable_reason_ar: string | null;
}

// ───────── corrections ─────────
export interface QuestionOptionInput {
  /** existing stable key ('o1'…) to keep the option's identity; omit for a new option */
  option_key?: string;
  source_label?: string | null;
  text: string;
  pinned_position?: boolean;
}

export interface QuestionCorrectionRequest {
  stem?: string;
  options?: QuestionOptionInput[];
  qtype?: QuestionType;
  explanation?: string | null;
  learning_objective?: string | null;
  /** fields the owner personally compared with the original */
  reviewed_fields?: string[];
  note?: string;
  /** the owner saw the blocking checks and confirms the corrected text anyway */
  acknowledge_blockers?: boolean;
}

export interface KeyCorrectionRequest {
  /** stable option keys of the correct option(s); null → remove the owner key (back to the source state) */
  option_keys: string[] | null;
  reason?: string;
}

/** What a key change means for past attempts — reported, never applied silently (§36, AC-15, AC-26). */
export interface KeyChangeImpact {
  attempts_total: number;
  /** attempts whose correctness WOULD differ under the new key (their stored result is not changed) */
  would_change: number;
  attempts: Array<{ attempt_id: string; version_id: string; answered_at: number; was_correct: boolean | null; would_be_correct: boolean | null }>;
  content_alert_id: string | null;
  summary_ar: string;
}

export interface QuestionMutationResponse {
  question: QuestionView;
  /** set when the change created a new version */
  new_version_id: string | null;
  impact: KeyChangeImpact | null;
  validation: QuestionValidation | null;
}

export interface QuestionReviewRequest {
  decision: 'accept' | 'reject';
  reviewed_fields?: string[];
  reason?: string;
  acknowledge_blockers?: boolean;
}

// ───────── lecture links ─────────
export interface LinkDecisionRequest {
  status: 'accepted' | 'rejected';
  reason?: string;
}
export interface OwnerLinkRequest {
  lecture_source_id: string;
  relation: LectureLinkRelation;
  reason?: string;
}

export interface LectureQuestionItem {
  link: LectureLinkView;
  question_id: string;
  origin_label_ar: string;
  stem_preview: string;
  qtype: QuestionType;
  has_negation: boolean;
  answer_status: AnswerStatus;
  status: QuestionStatus;
  scorable: boolean;
  /** true when one of the matched lecture pages is the requested page */
  on_this_page: boolean;
  occurrence: QuestionOccurrenceView | null;
  /** where to open the original question (first region box) */
  original: { source_id: string; version_id: string; page_id: string | null; page_index: number | null; bbox: NormBox | null; region_id: string | null } | null;
}

export interface LectureQuestionsResponse {
  lecture: { source_id: string; title: string; version_id: string | null };
  items: LectureQuestionItem[];
  /** honest state of matching for this lecture (e.g. not processed yet, no question sources in its course) */
  matching: { state: 'done' | 'pending' | 'not_processed' | 'no_question_sources'; message_ar: string | null; job: JobView | null };
}

// ───────── duplicates ─────────
export interface DuplicateDecisionRequest {
  status: 'confirmed' | 'rejected';
  reason?: string;
}
export interface DuplicateDetail extends DuplicateView {
  other_stem_preview: string;
  other_origin_label_ar: string;
  decision_reason: string | null;
}

// ───────── extraction / matching triggers ─────────
export interface ExtractRequest {
  version_id: string;
}
export interface MatchRequest {
  version_id?: string;
  source_id?: string;
}
export interface JobStartedResponse {
  job: JobView | null;
  message_ar: string;
}

export interface ExtractionSummaryView {
  version_id: string;
  source_id: string;
  status: 'completed' | 'needs_review' | 'nothing_found';
  questions: number;
  new_questions: number;
  exact_duplicates_attached: number;
  sections: Array<{ key: string; title: string | null; questions: number }>;
  key_blocks: number;
  keys_bound: number;
  keys_unbound: number;
  unofficial_marks: number;
  needs_review: number;
  not_found_again: number;
  message_ar: string;
  updated_at: number;
}

// ───────── review queue ─────────
export interface ReviewQueueResponse {
  items: Array<QuestionReviewItemView & { question_stem_preview: string | null; origin_label_ar: string | null }>;
  total_open: number;
}
export interface ReviewResolveRequest {
  action: 'accepted' | 'corrected' | 'rejected' | 'dismissed';
  note?: string;
}

/** Original page + regions for the side-by-side review screen. */
export interface QuestionOriginalView {
  occurrence: QuestionOccurrenceView;
  version: { id: string; format: string; display_file_id: string | null; file_id: string | null };
  pages: Array<{
    page_id: string;
    page_index: number;
    label_ar: string;
    width: number | null;
    height: number | null;
    kind: string;
    render_file_id: string | null;
    boxes: Array<{ region_id: string | null; bbox: NormBox }>;
  }>;
  raw_text: string | null;
}

// ───────── quick add (§33: one question, minimal fields) ─────────
export interface QuickAddTextRequest {
  text: string;
  course_node_id?: string | null;
  lecture_source_id?: string | null;
  /** the correct option's label as the owner knows it (owner key — never presented as a source key) */
  key_label?: string | null;
}
export interface QuickAddResponse {
  mode: 'text' | 'image';
  question_id: string | null;
  source_id: string | null;
  version_id: string | null;
  job_id: string | null;
  message_ar: string;
}

// ───────── concept candidates (§16, minimal) ─────────
export interface ConceptCandidateView {
  id: string;
  name: string;
  lang: 'en' | 'ar';
  kind: string | null;
  origin: 'auto' | 'owner';
  status: 'suggested' | 'accepted' | 'rejected';
  mentions: Array<{ region_id: string; page_id: string | null; page_label_ar: string | null; role: string }>;
}
export interface ConceptListResponse {
  items: ConceptCandidateView[];
}
export interface ConceptDecisionRequest {
  status: 'accepted' | 'rejected';
}

/** Practice deep link built by the exams track (route `/practice`). */
export function practiceUrl(sourceId: string, questionId: string): string {
  return `/practice?source_id=${encodeURIComponent(sourceId)}&question_id=${encodeURIComponent(questionId)}`;
}

/** Plain preview of a RichText stem (first ~180 chars, logical order). */
export function stemPreview(rt: RichText | null | undefined, max = 180): string {
  if (!rt) return '';
  const s = rt.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join(' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
