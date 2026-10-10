// Personal Control Center contract (track D2, §48 · §51 · §53 · §56 · §18 · §47; AC-03, AC-26).
// GET/POST /api/control/* — implemented by apps/server/src/modules/control, consumed by apps/web/src/features/control.
// One owner, one calm control center: no roles, no admin dashboards. Every number here is a REAL count; costs are
// ESTIMATES computed from token usage (never an invoice); nothing here regenerates the library automatically.
import type { AiStatusResponse, AiTask, JobErrorView, JobProgress } from './api';
import type { JobStatus, LectureKind, ProcessingStatus, ReviewQueueKind, SourceType } from './enums';
import type { NormBox } from './geometry';
import type { OwnerSettings } from './settings';
import type { ProcessingSummary } from './sources';

// ───────────────────────── review queue (/api/control/review) ─────────────────────────
export const REVIEW_KIND_LABELS_AR: Record<ReviewQueueKind, string> = {
  ocr_error: 'نص مقروء قد يكون خاطئًا',
  unreadable_page: 'صفحة لم يُقرأ نصها',
  truncated_question: 'سؤال مبتور',
  missing_option: 'خيار مفقود',
  conflicting_key: 'مفتاح إجابة متعارض',
  unofficial_mark: 'علامة غير رسمية',
  ambiguous_figure: 'رسم غامض',
  image_mismatch: 'صورة غير مطابقة',
  uncertain_lecture_link: 'ربط بمحاضرة غير مؤكد',
  needs_reanchor: 'ملاحظة تحتاج إعادة ربط',
  claim_unsupported: 'جملة يعارضها المصدر',
  question_validation_failed: 'سؤال لم يجتز الفحص',
  metadata_suggestion: 'اقتراح بيانات وصفية',
  duplicate_suggestion: 'تكرار محتمل',
  classification_suggestion: 'اقتراح تصنيف',
};

export const REVIEW_ITEM_STATUSES = ['open', 'accepted', 'corrected', 'rejected', 'dismissed'] as const;
export type ReviewItemStatus = (typeof REVIEW_ITEM_STATUSES)[number];
export const REVIEW_ITEM_STATUS_LABELS_AR: Record<ReviewItemStatus, string> = {
  open: 'بانتظار مراجعتك',
  accepted: 'قبلته كما هو',
  corrected: 'صحّحته',
  rejected: 'رفضته',
  dismissed: 'أغلقته دون تغيير',
};

export const REVIEW_ACTIONS = ['accept', 'correct', 'reject', 'dismiss'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
export const REVIEW_ACTION_STATUS: Record<ReviewAction, Exclude<ReviewItemStatus, 'open'>> = {
  accept: 'accepted',
  correct: 'corrected',
  reject: 'rejected',
  dismiss: 'dismissed',
};

/** Where an item is really resolved: here, or on the screen that owns its data (deep link). */
export type ReviewHandledIn = 'control' | 'questions' | 'workspace' | 'exams';

export interface ReviewLink {
  /** web path (same origin), e.g. /questions/<id>/review or /study/<source>?v=&page= */
  href: string;
  label_ar: string;
}

export interface ReviewActionSpec {
  action: ReviewAction;
  label_ar: string;
  /** exactly what happens — shown before the owner confirms */
  effect_ar: string;
  /** what the action needs from the owner */
  input: 'none' | 'text' | 'lecture_kind';
}

export interface ReviewQueueItemView {
  id: string;
  kind: ReviewQueueKind;
  kind_label_ar: string;
  status: ReviewItemStatus;
  status_label_ar: string;
  entity_type: string;
  entity_id: string;
  /** module that raised it (processing / questions / studybook / evidence / exams), when recorded */
  origin: string | null;
  source_id: string | null;
  source_title: string | null;
  source_type: SourceType | null;
  /** the SPECIFIC reason (Arabic), as recorded by the module that raised it */
  reason: string;
  /** «ص 12 (الصفحة 14 في الملف)», «شريحة 3» … when the item points at a page */
  location_label_ar: string | null;
  handled_in: ReviewHandledIn;
  link: ReviewLink | null;
  created_at: number;
  resolved_at: number | null;
}

export interface ReviewQueueCounts {
  /** open items in total (all kinds, all sources) */
  open: number;
  /** open items per kind */
  open_by_kind: Partial<Record<ReviewQueueKind, number>>;
  by_status: Record<ReviewItemStatus, number>;
}

export interface ReviewQueueListResponse {
  items: ReviewQueueItemView[];
  counts: ReviewQueueCounts;
  /** sources that have items, with their open count (filter choices) */
  sources: Array<{ id: string; title: string; open: number }>;
  next_cursor: string | null;
}

/** The ORIGINAL location of an item: source → version → page → region box. */
export interface ReviewOriginal {
  source_id: string;
  source_title: string;
  source_type: SourceType;
  version_id: string;
  version_no: number;
  /** the version study tools use (frozen ?? current) */
  is_active_version: boolean;
  page_id: string | null;
  page_index: number | null;
  page_label_ar: string | null;
  page_kind: 'page' | 'slide' | 'image' | 'docx_section' | 'audio_segment' | null;
  /** normalized box on the UNROTATED page (ARCHITECTURE §3.8); null when the item has no box */
  bbox: NormBox | null;
  /** how the web can draw the original */
  render: { kind: 'pdf'; file_id: string; page_index: number } | { kind: 'image'; file_id: string } | { kind: 'none'; reason_ar: string };
  /** «افتح في مساحة الدراسة» deep link */
  open_link: ReviewLink | null;
}

export interface ReviewRegionData {
  id: string;
  kind: string;
  kind_label_ar: string;
  text: string | null;
  text_origin: 'digital' | 'ocr' | 'owner' | 'vision' | null;
  text_origin_label_ar: string;
  /** 0–1 when the extractor reported one */
  confidence: number | null;
  status: string;
  status_label_ar: string;
}

export interface ReviewPageData {
  id: string;
  text_status: string;
  text_status_label_ar: string;
  processing_status: string;
  ocr_confidence: number | null;
  error_code: string | null;
  error_detail_ar: string | null;
  /** readable regions currently on the page */
  region_count: number;
  /** text the owner typed for this page (owner transcription), if any */
  owner_text: string | null;
}

export type ReviewStructured =
  | { type: 'region'; region: ReviewRegionData }
  | { type: 'page'; page: ReviewPageData }
  | {
      type: 'classification';
      current: LectureKind | null;
      current_origin: 'auto' | 'owner' | null;
      suggested: LectureKind | null;
      reasons_ar: string[];
      options: Array<{ value: LectureKind; label_ar: string }>;
    }
  | { type: 'claim'; text: string; support_label_ar: string; status_label_ar: string; artifact_title: string | null }
  | { type: 'question'; question_id: string | null; stem_preview: string | null }
  | { type: 'note_anchor'; target_kind: string; preview: string | null; previous_version_no: number | null; new_version_no: number | null }
  | { type: 'generated_question'; stem: string | null; options: string[]; issues_ar: string[] }
  | { type: 'other'; facts: Array<{ label_ar: string; value: string }> };

/** One recorded change of a region / page text. The previous text is never lost (§48, AC-26). */
export interface RegionCorrectionView {
  id: string;
  region_id: string;
  page_id: string | null;
  action: 'correct' | 'accept' | 'reject' | 'owner_text';
  action_label_ar: string;
  before_text: string | null;
  after_text: string | null;
  before_origin: string | null;
  after_origin: string | null;
  before_status: string | null;
  after_status: string | null;
  /** content change alert created for the dependents (null: nothing depended on it) */
  alert_id: string | null;
  note: string | null;
  created_at: number;
}

export interface ReviewResolution {
  action: string;
  by: string;
  note: string | null;
  at: number | null;
  effects_ar: string[];
  alert_id: string | null;
}

export interface ReviewItemDetail extends ReviewQueueItemView {
  original: ReviewOriginal | null;
  structured: ReviewStructured;
  /** actions available HERE (empty when the item is resolved on its own screen) */
  actions: ReviewActionSpec[];
  actions_note_ar: string | null;
  resolution: ReviewResolution | null;
  /** corrections recorded for this region / page, newest first */
  corrections: RegionCorrectionView[];
}

export interface ResolveReviewRequest {
  action: ReviewAction;
  /** corrected text (correct on a region) or the owner's transcription (correct on an unreadable page) */
  text?: string;
  /** correct on a classification suggestion */
  lecture_kind?: LectureKind;
  note?: string;
}

export interface ReviewAlertSummary {
  id: string;
  summary: string;
  counts: { still_valid: number; needs_regeneration: number; needs_review: number };
}

export interface ResolveReviewResponse {
  item: ReviewItemDetail;
  /** what actually happened, in order (Arabic) */
  effects_ar: string[];
  alert: ReviewAlertSummary | null;
}

// ───────────────────────── processing (/api/control/processing) ─────────────────────────
export interface ControlJobView {
  id: string;
  kind: string;
  kind_label_ar: string;
  /** one readable sentence: what this job does / did */
  explanation_ar: string;
  status: JobStatus;
  status_label_ar: string;
  progress: JobProgress | null;
  /** «الصفحة 12 من 40» — real counts only, never a percentage */
  progress_label_ar: string | null;
  attempts: number;
  max_attempts: number;
  error: JobErrorView | null;
  source: { id: string; title: string; version_id: string | null; version_no: number | null } | null;
  page_indexes: number[] | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  can_retry: boolean;
  can_cancel: boolean;
  retry_effect_ar: string | null;
  cancel_effect_ar: string | null;
}

export interface AttentionPageView {
  page_id: string | null;
  page_index: number;
  label_ar: string;
  error_code: string;
  reason_ar: string;
  /** the page holds text you corrected or typed: re-processing it is refused so your text is never replaced */
  owner_corrected: boolean;
}

export interface VersionAttentionView {
  source_id: string;
  source_title: string;
  source_type: SourceType;
  version_id: string;
  version_no: number;
  is_active: boolean;
  processing_status: ProcessingStatus;
  status_label_ar: string;
  summary: ProcessingSummary | null;
  /** failed / problematic pages with their specific reason */
  pages: AttentionPageView[];
  open_review_items: number;
  /** what the gap means for study tools (AC-03) */
  coverage_note_ar: string;
}

export interface ProcessingOverviewResponse {
  active: ControlJobView[];
  recent: ControlJobView[];
  attention: VersionAttentionView[];
  counts: { queued: number; running: number; waiting_for_input: number; failed: number; partial: number };
  notes_ar: string[];
}

// ───────────────────────── intelligence (/api/control/intelligence) ─────────────────────────
export const AI_TASK_LABELS_AR: Record<AiTask, string> = {
  explain: 'الشرح من المصدر',
  study_book: 'كتاب الدراسة',
  chat: 'المحادثة المرتبطة بالمصدر',
  summarize: 'الملخصات',
  compare: 'المقارنات',
  verify_support: 'التحقق المستقل من الادعاءات',
  generate_questions: 'توليد الأسئلة',
  validate_question: 'فحص الأسئلة المولدة',
  vision_figure: 'قراءة الرسوم والصور',
  grade_written: 'تقييم الإجابات المكتوبة',
  case_sim: 'محاكاة الحالات',
  classify: 'التصنيف',
  embed: 'البحث الدلالي (embeddings)',
  transcribe: 'تفريغ الصوت',
};

export const MODEL_ROLES = ['generation', 'verification', 'vision'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export const MODEL_ROLE_LABELS_AR: Record<ModelRole, string> = {
  generation: 'التوليد (الشرح والكتب والأسئلة)',
  verification: 'التحقق المستقل',
  vision: 'الرؤية (الرسوم والصور)',
};

export interface ModelRoleView {
  role: ModelRole;
  label_ar: string;
  /** model configured for this role (null without a provider) */
  model: string | null;
  /** server setting that changes it */
  env_var: string;
  tasks: AiTask[];
}

export interface UsageBucket {
  key: string;
  label_ar: string;
  calls: number;
  ok: number;
  errors: number;
  schema_rejected: number;
  budget_blocked: number;
  input_tokens: number;
  output_tokens: number;
  /** ESTIMATE from token counts and a static price table — not an invoice */
  estimated_cost_usd: number;
}

export interface UsageMonth extends UsageBucket {
  /** YYYY-MM in the owner timezone */
  month: string;
  period_start: number;
  by_task: UsageBucket[];
  by_model: UsageBucket[];
}

export interface IntelligenceResponse {
  ai: AiStatusResponse;
  roles: ModelRoleView[];
  usage: { months: UsageMonth[]; estimated: true; note_ar: string };
  /** rule-affecting defaults (edited through an impact preview) */
  rules: Pick<OwnerSettings, 'explanation_level' | 'dialect' | 'custom_instruction' | 'socratic_default' | 'check_question_density' | 'answer_style'>;
  notes_ar: string[];
}

// ───────────────────────── impact preview (/api/control/impact) ─────────────────────────
export const IMPACT_SETTING_KEYS = [
  'explanation_level',
  'dialect',
  'custom_instruction',
  'socratic_default',
  'check_question_density',
  'answer_style',
  'source_priority',
] as const;
export type ImpactSettingKey = (typeof IMPACT_SETTING_KEYS)[number];

export type ImpactChange =
  | { kind: 'settings'; patch: Partial<Pick<OwnerSettings, ImpactSettingKey>> }
  /** owner layer of the explanation rules (studybook RulesPatch: template, level, dialect, keep_english_terms, show_original_text, socratic, include) */
  | { kind: 'rules_owner'; patch: Record<string, unknown> }
  /** a folder's rules; patch null removes the folder override */
  | { kind: 'rules_node'; node_id: string; patch: Record<string, unknown> | null }
  /** preview only — models are server settings (MEDLEVO_MODEL_*) applied at restart */
  | { kind: 'model'; role: ModelRole; model: string };

export interface ImpactArtifactView {
  id: string;
  title: string | null;
  kind: string;
  kind_label_ar: string;
  status: string;
  source_id: string | null;
  source_title: string | null;
  frozen: boolean;
  reason_ar: string;
}

export interface ImpactPreviewResponse {
  /** what would change, in words */
  change_ar: string[];
  /** stored generated content a new request would no longer reuse (it stays readable, unchanged) */
  affected: ImpactArtifactView[];
  affected_count: number;
  /** stored content this change does not touch */
  unaffected_count: number;
  /** made under earlier rules or request-specific options: not reused by default requests anyway */
  not_comparable_count: number;
  /** source priority only: stored content whose scope mixes reordered source types (could differ if regenerated by you) */
  may_differ_count: number;
  /** always false: nothing is regenerated automatically (§48) */
  regenerates_automatically: false;
  effects_ar: string[];
  can_apply: boolean;
  apply_note_ar: string;
  /** pass to /apply; a stale token (state changed since the preview) is refused */
  confirm_token: string | null;
}

export interface ImpactApplyRequest {
  change: ImpactChange;
  confirm_token: string;
}

export interface ImpactApplyResponse {
  applied: true;
  effects_ar: string[];
  preview: ImpactPreviewResponse;
}

// ───────────────────────── sources & priorities (/api/control/sources) ─────────────────────────
export const PRIORITY_PURPOSES = ['lecture_explanation', 'source_question_practice', 'clinical_expansion'] as const;
export type PriorityPurpose = (typeof PRIORITY_PURPOSES)[number];
export const PRIORITY_PURPOSE_LABELS_AR: Record<PriorityPurpose, { title: string; description: string }> = {
  lecture_explanation: { title: 'شرح المحاضرة', description: 'من أين يبدأ البحث عن الأدلة عند شرح محاضرة أو بناء كتاب الدراسة.' },
  source_question_practice: { title: 'التدريب على أسئلة المصدر', description: 'ترتيب المصادر عند ربط الأسئلة بالأدلة وتوليد الحلول.' },
  clinical_expansion: { title: 'التوسع السريري', description: 'ترتيب المراجع عند توسيع شرح سريري خارج المحاضرة (ضمن النطاق الذي تختاره).' },
};

export interface ControlSourceRow {
  id: string;
  title: string;
  source_type: SourceType;
  source_type_label_ar: string;
  /** owner number for organization (−100…100); stored only — the search order follows the task priorities */
  priority: number;
  selection_reason: string | null;
  processing_status: ProcessingStatus;
  active_version_no: number | null;
  frozen: boolean;
  /** titles of the lectures this source is a selected reference for */
  reference_for: string[];
  open_review_items: number;
}

export interface SourcesPrioritiesResponse {
  purposes: Array<{ purpose: PriorityPurpose; title_ar: string; description_ar: string; order: string[] }>;
  source_types: Array<{ value: SourceType; label_ar: string }>;
  sources: ControlSourceRow[];
  notes_ar: string[];
}

// ───────────────────────── storage (/api/control/storage) ─────────────────────────
export interface StorageCategoryView {
  key: string;
  label_ar: string;
  files: number;
  bytes: number;
  note_ar?: string;
}

export interface StorageResponse {
  database: { bytes: number; files: number };
  files: { count: number; bytes: number; categories: StorageCategoryView[] };
  backups: { count: number; bytes: number };
  other: StorageCategoryView[];
  total_bytes: number;
  measured_at: number;
  notes_ar: string[];
}

// ───────────────────────── history (/api/control/history) ─────────────────────────
export interface HistoryEntryView {
  id: string;
  at: number;
  entity_type: string;
  entity_label_ar: string;
  entity_id: string;
  action: string;
  action_label_ar: string;
  summary: string | null;
  actor: string;
  actor_label_ar: string;
  job_id: string | null;
  /** readable before → after facts (secrets never included) */
  changes: Array<{ label: string; before: string | null; after: string | null }>;
  link: ReviewLink | null;
}

export interface HistoryResponse {
  entries: HistoryEntryView[];
  next_before: string | null;
  entity_types: Array<{ value: string; label_ar: string }>;
}

// ───────────────────────── overview (/api/control/overview) ─────────────────────────
export interface ControlOverviewResponse {
  review: { open: number; open_by_kind: Partial<Record<ReviewQueueKind, number>> };
  alerts: { open: number };
  processing: { active: number; failed: number; attention: number };
  ai: { configured: boolean; provider: string | null; spent_usd: number; monthly_usd: number; estimated: true };
  generated_at: number;
}
