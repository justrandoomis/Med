// Enumerations mirrored from the SQL CHECK constraints (apps/server/src/db/migrations/0001_core.sql).
// Keep in sync; server tests assert parity.

export const SOURCE_TYPES = [
  'lecture', 'course_reference', 'textbook', 'guideline', 'question_source', 'previous_exam',
  'image_atlas', 'practical_manual', 'my_notes', 'lecture_audio', 'my_audio_note', 'external_source',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABELS_AR: Record<SourceType, string> = {
  lecture: 'محاضرة',
  course_reference: 'مرجع الكورس',
  textbook: 'كتاب',
  guideline: 'دليل إرشادي',
  question_source: 'مصدر أسئلة',
  previous_exam: 'امتحان سابق',
  image_atlas: 'أطلس صور',
  practical_manual: 'دليل عملي',
  my_notes: 'ملاحظاتي',
  lecture_audio: 'تسجيل محاضرة',
  my_audio_note: 'ملاحظة صوتية',
  external_source: 'مصدر خارجي',
};

export const LIBRARY_NODE_KINDS = ['notebook', 'folder', 'subject', 'course', 'section', 'topic_folder'] as const;
export type LibraryNodeKind = (typeof LIBRARY_NODE_KINDS)[number];

export const PROCESSING_STATUSES = ['pending', 'processing', 'partial', 'ready', 'failed', 'needs_review'] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const PAGE_TEXT_STATUSES = ['pending', 'digital', 'ocr', 'mixed', 'no_text_found', 'needs_ocr', 'failed'] as const;
export type PageTextStatus = (typeof PAGE_TEXT_STATUSES)[number];

export const REGION_KINDS = [
  'text_block', 'heading', 'paragraph', 'list_item', 'table', 'table_cell', 'figure', 'caption',
  'diagram', 'question', 'option', 'answer_key', 'transcript', 'note', 'footer', 'header',
] as const;
export type RegionKind = (typeof REGION_KINDS)[number];

export const LECTURE_KINDS = ['theoretical', 'practical', 'clinical', 'mixed'] as const;
export type LectureKind = (typeof LECTURE_KINDS)[number];

// Evidence / accuracy contract (§10, §12)
export const SUPPORT_TYPES = [
  'directly_stated', 'derived', 'synthesized', 'externally_supplemented', 'contradicted', 'unsupported',
] as const;
export type SupportType = (typeof SUPPORT_TYPES)[number];

export const SUPPORT_TYPE_LABELS_AR: Record<SupportType, string> = {
  directly_stated: 'مذكور نصًا',
  derived: 'مستنتج من الدليل',
  synthesized: 'تركيب من عدة أدلة',
  externally_supplemented: 'مكمّل من مصدر خارجي',
  contradicted: 'يعارضه المصدر',
  unsupported: 'غير مدعوم',
};

export const VERIFICATION_STATUSES = ['pending', 'linked', 'needs_review', 'conflict', 'rejected', 'owner_reviewed'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Visible, precise status labels. Never "AI Verified" (§12). */
export const STATUS_LABELS_AR = {
  extracted: 'مستخرج',
  checks_passed: 'اجتاز فحوص الاستخراج',
  linked: 'مرتبط بدليل',
  owner_reviewed: 'راجعته شخصيًا',
  needs_review: 'يحتاج مراجعة',
  conflict: 'تعارض',
  pending: 'قيد التحقق',
  rejected: 'مرفوض',
  uncertain: 'غير مؤكد',
} as const;

// Questions (§33–§38)
export const ANSWER_STATUSES = ['source_key', 'missing_key', 'ai_derived', 'conflicting_key', 'unresolved', 'owner_key', 'not_applicable'] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];
export const ANSWER_STATUS_LABELS_AR: Record<AnswerStatus, string> = {
  source_key: 'مفتاح المصدر',
  missing_key: 'لا يوجد مفتاح',
  ai_derived: 'حل مولد من الأدلة (AI-derived)',
  conflicting_key: 'مفتاح متعارض',
  unresolved: 'غير محسوم',
  owner_key: 'مفتاح حددته بنفسي',
  not_applicable: 'لا ينطبق',
};
/** Only these answer statuses may be scored in an assessed exam. */
export const SCORABLE_ANSWER_STATUSES: readonly AnswerStatus[] = ['source_key', 'owner_key', 'ai_derived'];

export const QUESTION_TYPES = ['sba', 'multi_select', 'true_false', 'short_answer', 'essay', 'enumerate', 'compare', 'clinical_written'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const LECTURE_LINK_RELATIONS = ['directly_covered', 'strongly_related', 'partially_covered', 'course_related_only'] as const;
export type LectureLinkRelation = (typeof LECTURE_LINK_RELATIONS)[number];
export const LECTURE_LINK_LABELS_AR: Record<LectureLinkRelation, string> = {
  directly_covered: 'مغطى مباشرة',
  strongly_related: 'وثيق الصلة',
  partially_covered: 'مغطى جزئيًا',
  course_related_only: 'مرتبط بالكورس فقط',
};

export const CONFIDENCE_LEVELS = ['guess', 'unsure', 'confident'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const MISTAKE_TYPES = [
  'knowledge_gap', 'misunderstanding', 'concept_confusion', 'misread', 'first_line_vs_confirmatory', 'step_order', 'time_pressure',
] as const;
export type MistakeType = (typeof MISTAKE_TYPES)[number];
export const MISTAKE_TYPE_LABELS_AR: Record<MistakeType, string> = {
  knowledge_gap: 'نقص معرفة',
  misunderstanding: 'سوء فهم',
  concept_confusion: 'خلط بين مفهومين',
  misread: 'خطأ قراءة',
  first_line_vs_confirmatory: 'الفحص الأولي مقابل المؤكِّد',
  step_order: 'ترتيب الخطوات',
  time_pressure: 'ضغط الوقت',
};

export const JOB_STATUSES = ['queued', 'running', 'waiting_for_input', 'partial', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const STUDY_MODES = ['learn', 'understand', 'practice', 'review', 'exam'] as const;
export type StudyMode = (typeof STUDY_MODES)[number];

export const EXPLANATION_LEVELS = ['simple', 'brief', 'medium', 'detailed', 'expert', 'exam_focus'] as const;
export type ExplanationLevel = (typeof EXPLANATION_LEVELS)[number];

export const ANSWER_STYLES = ['simple', 'short', 'detailed', 'expert', 'literal'] as const;
export type AnswerStyle = (typeof ANSWER_STYLES)[number];

export const SUMMARY_TYPES = ['quick', 'detailed', 'exam', 'clinical', 'last_minute', 'high_yield', 'tables_only', 'flowcharts', 'mind_map', 'custom'] as const;
export type SummaryType = (typeof SUMMARY_TYPES)[number];

export const REVIEW_QUEUE_KINDS = [
  'ocr_error', 'unreadable_page', 'truncated_question', 'missing_option', 'conflicting_key', 'unofficial_mark',
  'ambiguous_figure', 'image_mismatch', 'uncertain_lecture_link', 'needs_reanchor', 'claim_unsupported',
  'question_validation_failed', 'metadata_suggestion', 'duplicate_suggestion', 'classification_suggestion',
] as const;
export type ReviewQueueKind = (typeof REVIEW_QUEUE_KINDS)[number];

export const SYNC_STATES = ['saved_locally', 'pending_sync', 'synced', 'conflict', 'error'] as const;
export type SyncState = (typeof SYNC_STATES)[number];
export const SYNC_STATE_LABELS_AR: Record<SyncState, string> = {
  saved_locally: 'محفوظ محليًا',
  pending_sync: 'ينتظر المزامنة',
  synced: 'تمت المزامنة',
  conflict: 'تعارض',
  error: 'خطأ',
};
