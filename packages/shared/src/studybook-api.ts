// Study Book module HTTP contract (/api/studybook) — explanations, Study Book, contextual chat, summaries,
// compare, figure explanations, explanation rules (§15–§21, §24, §28, §30, §31). Added by track C2
// (docs/modules/studybook.md). The model-facing generation contract stays in ./evidence.ts; request shapes
// (ExplainRequest, ChatThreadCreate, SummaryRequest, StudyBookRequest, ExplanationRules) stay in ./studybook.ts.
import type { AnswerStyle, ExplanationLevel, SummaryType } from './enums';
import type { AbstainReason, ArtifactView, ContentBlockView } from './evidence';
import type { JobView } from './api';
import type { SourceScope } from './scope';
import type { RichText } from './richtext';
import type { ExplanationRules, ExplanationTemplateKey, SelectionAnchor } from './studybook';

// ───────── labels (Arabic UI copy shared by server text and web) ─────────
export const GENERATED_EXAMPLE_LABEL_AR = 'مثال تعليمي مولد';
export const MEMORY_HOOK_LABEL_AR = 'وسيلة حفظ مولدة — ليست حقيقة علمية بذاتها';
export const MINI_QUESTION_LABEL_AR = 'سؤال تحقق مولد';
export const GENERATED_CONTENT_LABEL_AR = 'محتوى مولَّد من مصادرك — ليس مصدرًا مستقلًا';
export const REAL_PATIENT_NOTICE_AR =
  'MedLevo منصة تعليمية: لا تقدم تشخيصًا ولا خطة علاج لمريض حقيقي، ولا تحوّل نتائج الدراسة إلى قرار علاجي. لحالة حقيقية راجع الطبيب المختص (أو الطوارئ عند الخطر). يمكنك أن تسأل عن المفهوم العلمي نفسه بصيغة تعليمية.';

export const ANSWER_STYLE_LABELS_AR: Record<AnswerStyle, string> = {
  simple: 'مبسّط',
  short: 'مختصر',
  detailed: 'مفصّل',
  expert: 'خبير',
  literal: 'حرفي (اقتباسات فقط)',
};

export const EXPLANATION_LEVEL_LABELS_AR: Record<ExplanationLevel, string> = {
  simple: 'مبسّط',
  brief: 'مختصر',
  medium: 'متوسط',
  detailed: 'مفصّل',
  expert: 'خبير',
  exam_focus: 'تركيز امتحاني',
};

export const EXPLANATION_TEMPLATE_LABELS_AR: Record<ExplanationTemplateKey, string> = {
  anatomy: 'التشريح',
  physiology: 'الفسلجة',
  pathology: 'علم الأمراض',
  pharmacology: 'علم الأدوية',
  surgery: 'الجراحة',
  medicine: 'الباطنية',
  general: 'عام (دون قالب)',
};

export const SUMMARY_TYPE_LABELS_AR: Record<SummaryType, string> = {
  quick: 'سريع',
  detailed: 'مفصّل',
  exam: 'امتحاني',
  clinical: 'سريري',
  last_minute: 'اللحظة الأخيرة',
  high_yield: 'الأهم (High-Yield)',
  tables_only: 'جداول فقط',
  flowcharts: 'مخططات انسيابية',
  mind_map: 'خريطة ذهنية',
  custom: 'مخصّص',
};

/** Summary types that are SELECTIONS of topics, never a replacement for full coverage (§31). */
export const SELECTION_SUMMARY_TYPES: readonly SummaryType[] = ['last_minute', 'high_yield'];

export const RETRY_STRATEGIES = ['prerequisites', 'diagram', 'comparison', 'clinical_example', 'analogy', 'smaller_steps'] as const;
export type RetryStrategy = (typeof RETRY_STRATEGIES)[number];
export const RETRY_STRATEGY_LABELS_AR: Record<RetryStrategy, string> = {
  prerequisites: 'ابدأ بالمتطلبات السابقة',
  diagram: 'ارسمها خطوات (مخطط)',
  comparison: 'قارنها بما يشبهها',
  clinical_example: 'مثال سريري تعليمي',
  analogy: 'تشبيه',
  smaller_steps: 'خطوات أصغر',
};

// ───────── artifacts ─────────
/** Display facts the server derives for a block (never medical content). */
export interface StudyBlockMeta {
  /** visible label inside the block, e.g. «مثال تعليمي مولد» */
  label_ar?: string;
  /** template section this block belongs to (explanations) or the Study Book section title */
  section_title?: string | null;
  /** pages of the original the block explains (Lecture Twin) */
  page_ids?: string[];
  page_indexes?: number[];
  /** figure explanations: model-read visual items (not evidence) and how many are uncertain */
  visual?: { items: number; uncertain: number; vision_used: boolean };
  /** content that must never become a fixed exam answer (uncertain visual reading, AC-08) */
  not_for_exam_answer?: boolean;
}

export type StudyBlockView = ContentBlockView & { meta: StudyBlockMeta | null };

export interface ArtifactVersionRef {
  id: string;
  version_no: number;
  status: ArtifactView['status'];
  is_frozen: boolean;
  created_at: number;
  published_at: number | null;
}

export interface StudyArtifactView extends ArtifactView {
  blocks: StudyBlockView[];
  anchor: SelectionAnchor | null;
  parent_artifact_id: string | null;
  job_id: string | null;
  /** all versions of this lineage, newest first */
  versions: ArtifactVersionRef[];
}

export interface ExplainResponse {
  artifact: StudyArtifactView;
  /** served from the cache: same key (scope, versions, rules, level, language, dialect, …) and still valid */
  cached: boolean;
}

/** Compare Mode (§31): items are terms / concepts; the table has a row per aspect, claims per cell. */
export interface CompareRequest {
  items: string[];
  scope: SourceScope;
  anchor?: SelectionAnchor | null;
  style?: AnswerStyle;
  instruction?: string;
}

// ───────── Study Book ─────────
export interface StudyBookSectionView {
  section_key: string;
  ord: number;
  title: string | null;
  status: 'pending' | 'generating' | 'complete' | 'abstained' | 'failed';
  status_label_ar: string;
  block_count: number;
  page_indexes: number[];
  page_labels_ar: string[];
  detail_ar: string | null;
}

export interface ReanchorItem {
  target_kind: 'annotation' | 'note';
  target_id: string;
  block_key: string;
  previous_version_no: number | null;
  status: 'matched' | 'needs_reanchor';
  /** «ملاحظة على فقرة من النسخة 1 لم تعد موجودة» */
  reason_ar: string;
}

/** Lecture Twin: which original pages each block explains. */
export interface TwinEntry {
  block_key: string;
  section_key: string | null;
  page_indexes: number[];
}

export interface StudyBookView {
  artifact: StudyArtifactView;
  sections: StudyBookSectionView[];
  job: JobView | null;
  /** real counts — never a percentage */
  progress: { sections_total: number; sections_complete: number; sections_abstained: number; sections_failed: number };
  twin: TwinEntry[];
  reanchor: ReanchorItem[];
  /** a frozen version is shown by default; a newer published version may exist */
  newer_version_id: string | null;
}

export interface StudyBookStatusResponse {
  /** the version shown by default (frozen > latest published > latest) or null when none exists */
  book: StudyBookView | null;
  /** generation possible now (capability + processed source) and why not */
  can_generate: { available: boolean; reason_ar: string | null };
}

export interface StudyBookCreateResponse {
  book: StudyBookView;
  cached: boolean;
}

// ───────── chat (§30) ─────────
export interface ChatMessageView {
  id: string;
  thread_id: string;
  role: 'owner' | 'assistant' | 'system_notice';
  status: 'draft' | 'verifying' | 'final' | 'rejected' | 'abstained';
  style: AnswerStyle | null;
  /** owner text, or the published (verified) answer text; drafts never carry content */
  content: RichText;
  artifact: StudyArtifactView | null;
  abstain: null | { reason: AbstainReason; reason_ar: string; detail?: string; suggest_scope?: SourceScope };
  reply_to_id: string | null;
  created_at: number;
}

export interface ChatThreadView {
  id: string;
  source_id: string | null;
  version_id: string | null;
  page_id: string | null;
  anchor: SelectionAnchor | null;
  scope: { mode: SourceScope['mode']; source_ids: string[]; version_ids: string[]; describe_ar: string; hash: string };
  style: AnswerStyle;
  socratic: boolean;
  title: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
  last_message_preview: string | null;
}

export interface ChatThreadResponse {
  thread: ChatThreadView;
  messages: ChatMessageView[];
}

export interface ChatThreadsResponse {
  threads: ChatThreadView[];
}

export interface ChatPostResponse {
  owner_message: ChatMessageView;
  answer: ChatMessageView;
}

export interface SaveNoteRequest {
  /** client-generated ULID of the new note (idempotent per message) */
  note_id: string;
  node_id?: string | null;
}

// ───────── summaries (§31) ─────────
export interface SummaryPreviewResponse {
  type: SummaryType;
  type_label_ar: string;
  source_id: string;
  version_id: string;
  scope_describe_ar: string;
  pages_selected: number;
  pages_ready: number;
  pages_unreadable: number[];
  pages_unprocessed: number[];
  /** a summary may be called complete only when every selected page is processed and nothing is excluded */
  will_be_complete: boolean;
  is_selection: boolean;
  notes_ar: string[];
}

export interface SummaryCreateResponse {
  book: StudyBookView;
  cached: boolean;
}

// ───────── explanation rules (§19) ─────────
export interface ExplanationRulesResponse {
  /** effective rules for the context asked (owner settings + owner extras + node template/overrides) */
  rules: ExplanationRules;
  /** where each part came from, for the settings screen */
  layers: {
    settings: Pick<ExplanationRules, 'level' | 'dialect' | 'custom_instruction' | 'socratic'>;
    owner: ExplanationRulesPatch | null;
    node: { node_id: string; title: string; template_key: string | null; override: ExplanationRulesPatch | null } | null;
  };
  templates: Record<ExplanationTemplateKey, readonly string[]>;
}

export type ExplanationRulesPatch = Partial<Pick<ExplanationRules, 'template' | 'level' | 'dialect' | 'keep_english_terms' | 'show_original_text' | 'socratic'>> & {
  include?: Partial<ExplanationRules['include']>;
};
