// Study modes & AI-gated study tools (track F3) — HTTP contracts and Arabic labels shared by server and web:
//  * study modes Learn / Understand / Practice / Review / Exam (§39): one switch that ARRANGES the same tools and data
//    (the mode itself is persisted in study_session.mode through /api/sync);
//  * derived question versions — translations / paraphrases (§35, §37): option ids and key unchanged, labelled
//    derived, the original always viewable; validated (deterministic checks + an independent equivalence check);
//  * generated simulation following the owner's Exam DNA (§40): labelled «محاكاة مولدة», never the expected exam;
//  * interactive timelines and flowcharts (§31): structured output with claims per node / edge, verified against the
//    evidence of the locked scope, rendered as an accessible diagram + text twin, labelled «re-organized»;
//  * figure structure readings (§13, §14, AC-08): an on-demand vision step that stores a DERIVED, UNCERTAIN reading
//    (nodes / edges / direction with certainty) until the owner reviews it; never a fixed exam answer while uncertain.
import type { JobView } from './api';
import type { AbstainReason, ClaimView } from './evidence';
import type { AnswerStatus, StudyMode } from './enums';
import type { GenerationDifficulty } from './exams-api';
import type { RichText } from './richtext';
import type { SourceScope } from './scope';
import type { DiagramStructure } from './sources';

// ───────── study modes (§39) ─────────
export const STUDY_MODE_LABELS_AR: Record<StudyMode, string> = {
  learn: 'تعلّم',
  understand: 'افهم',
  practice: 'تدرّب',
  review: 'راجع',
  exam: 'امتحن نفسك',
};

/** One line per mode: what the mode arranges (shown under the switch). */
export const STUDY_MODE_HINTS_AR: Record<StudyMode, string> = {
  learn: 'القراءة أولًا: الشرح والمصادر قريبة، وأسئلة هذه الصفحة فقط.',
  understand: 'الفهم العميق: الشرح والمخططات وكتاب الدراسة أولًا، مع أسئلة قليلة للتحقق.',
  practice: 'التدريب: أسئلة المحاضرة كلها أولًا، مع تلميح ثم تلميح أعمق ثم الحل.',
  review: 'المراجعة: ملاحظاتك وما علّمته للمراجعة أولًا، ثم أسئلة للتثبيت.',
  exam: 'امتحن نفسك: الأسئلة فقط دون شروح أو حلول أو أسباب ربط حتى تنهي.',
};

/** Why explanation tools are hidden in Exam mode (shown next to the hidden controls, §39 / AC-19). */
export const EXAM_MODE_HIDDEN_AR = 'وضع «امتحن نفسك»: الشروح والحلول وأسباب ربط الأسئلة ومعاينة الأدلة مخفية حتى تخرج من هذا الوضع.';

// ───────── derived question versions (§35, §37) ─────────
export const DERIVED_VERSION_KINDS = ['translation', 'paraphrase'] as const;
export type DerivedVersionKind = (typeof DERIVED_VERSION_KINDS)[number];
export const DERIVED_VERSION_LANGS = ['ar', 'en'] as const;
export type DerivedVersionLang = (typeof DERIVED_VERSION_LANGS)[number];

export const DERIVED_VERSION_LABELS_AR: Record<DerivedVersionKind, string> = {
  translation: 'ترجمة مشتقة',
  paraphrase: 'إعادة صياغة مشتقة',
};
export const DERIVED_LANG_LABELS_AR: Record<DerivedVersionLang, string> = { ar: 'العربية', en: 'الإنجليزية' };

/** Shown with every derived version (§35: «لا تنسب الصياغة المولدة إلى امتحان سابق»). */
export const DERIVED_VERSION_NOTICE_AR =
  'نسخة مشتقة مولدة بواسطة MedLevo للمساعدة — ليست نص السؤال الأصلي ولا تُنسب إلى امتحان سابق. الخيارات والمفتاح هي نفسها في الأصل، والأصل متاح دائمًا.';

export interface DeriveQuestionRequest {
  kind: DerivedVersionKind;
  /** target language (a paraphrase keeps the original language when omitted) */
  lang?: DerivedVersionLang;
}

export type DerivationStatus = 'queued' | 'running' | 'published' | 'needs_review' | 'failed';
export const DERIVATION_STATUS_LABELS_AR: Record<DerivationStatus, string> = {
  queued: 'في الانتظار',
  running: 'يُولَّد ثم يُتحقق من تطابقه مع الأصل',
  published: 'اجتاز الفحوص',
  needs_review: 'لم يُنشر: يحتاج مراجعتك',
  failed: 'فشل',
};

export interface DerivedOptionView {
  /** the ORIGINAL option id (answers and keys always reference it — unchanged by the derived version) */
  id: string;
  option_key: string;
  display_label: string;
  text: RichText;
}

export interface DerivedVersionView {
  version_id: string;
  kind: DerivedVersionKind;
  lang: string;
  label_ar: string;
  notice_ar: string;
  derived_from_version_id: string;
  derived_from_version_no: number;
  /** false when the question has a newer original version (the derived text may no longer match it) */
  from_current: boolean;
  stale_note_ar: string | null;
  stem: RichText;
  has_negation: boolean;
  options: DerivedOptionView[];
  /** stable option keys of the key (identical to the original version's) */
  correct_option_keys: string[] | null;
  answer_status: AnswerStatus;
  model: string | null;
  created_at: number;
}

export interface DerivationIssue {
  check: string;
  reason_ar: string;
  by: 'deterministic' | 'validator';
}

export interface QuestionDerivationView {
  id: string;
  question_id: string;
  source_version_id: string;
  kind: DerivedVersionKind;
  lang: string;
  status: DerivationStatus;
  status_label_ar: string;
  issues: DerivationIssue[];
  derived: DerivedVersionView | null;
  job: JobView | null;
  error_ar: string | null;
  created_at: number;
  updated_at: number;
}

export interface QuestionDerivationsResponse {
  question_id: string;
  current_version_id: string;
  derivations: QuestionDerivationView[];
  /** generation possible now (capability + MCQ type) and why not */
  can_derive: { available: boolean; reason_ar: string | null };
}

export interface QuestionDerivationResponse {
  derivation: QuestionDerivationView;
}

// ───────── generated simulation (§40) ─────────
export const SIMULATION_LABEL_AR = 'محاكاة مولدة';
export const SIMULATION_NOTICE_AR =
  'محاكاة مولدة — ليست نسخة متوقعة من الامتحان القادم. تتبع توزيع عينة أسئلتك المرفوعة فقط (بمقاماتها)، وكل سؤال فيها مولد من محاضراتك ومتحقق من أدلته.';

export interface SimulationRequest {
  /** total generated questions requested (split by the DNA distribution) */
  count: number;
  difficulty: GenerationDifficulty;
  /** restrict the DNA sample and the lectures to one course */
  course_node_id?: string | null;
  minutes?: number | null;
}

export interface SimulationBucket {
  lecture_source_id: string;
  lecture_title: string;
  /** questions to generate from this lecture */
  count: number;
  /** the lecture's share in the sample: unique questions linked to it / unique questions in the sample */
  share: { unique: number; denominator: number };
  /** generated item types following the sample's item-type distribution (inside this bucket) */
  item_types: string[];
  /** topic handed to the generator (concepts of the sample's questions on this lecture, or the lecture title) */
  topic: string;
  reason_ar: string;
}

export interface SimulationPlanView {
  request: SimulationRequest;
  buckets: SimulationBucket[];
  sample: { files: number; unique_questions: number; occurrences: number; date_range: string | null };
  item_types: Array<{ item_type: string; count: number; denominator: number }>;
  warnings_ar: string[];
  /** lectures of the sample left out and why (no processed version, trashed, …) */
  excluded: Array<{ lecture_source_id: string; title: string; reason_ar: string }>;
  counting_note_ar: string;
  notice_ar: string;
  /** a simulation can be generated now (AI capability + a usable distribution) and why not */
  can_generate: { available: boolean; reason_ar: string | null };
}

export type SimulationStatus = 'queued' | 'running' | 'completed' | 'partial' | 'abstained' | 'failed';
export const SIMULATION_STATUS_LABELS_AR: Record<SimulationStatus, string> = {
  queued: 'في الانتظار',
  running: 'يُولَّد كل جزء من محاضرته ثم يُتحقق منه',
  completed: 'اكتملت المحاكاة',
  partial: 'اكتملت جزئيًا',
  abstained: 'لم يُنشر أي سؤال',
  failed: 'فشل',
};

export interface SimulationRunPart {
  bucket_index: number;
  lecture_source_id: string;
  lecture_title: string;
  requested: number;
  run_id: string | null;
  status: string;
  status_label_ar: string;
  published: number;
}

export interface SimulationRunView {
  id: string;
  status: SimulationStatus;
  status_label_ar: string;
  label_ar: string;
  notice_ar: string;
  plan: SimulationPlanView;
  parts: SimulationRunPart[];
  /** the simulation exam (mode «simulation», every item generated) — null until assembled */
  exam: { exam_id: string; attempt_id: string; items: number; generated_items: number } | null;
  summary_ar: string;
  job: JobView | null;
  created_at: number;
  updated_at: number;
}

export interface SimulationResponse {
  simulation: SimulationRunView;
}
export interface SimulationListResponse {
  simulations: SimulationRunView[];
}

// ───────── interactive timelines & flowcharts (§31) ─────────
export const STUDY_DIAGRAM_KINDS = ['flowchart', 'timeline'] as const;
export type StudyDiagramKind = (typeof STUDY_DIAGRAM_KINDS)[number];
export const STUDY_DIAGRAM_KIND_LABELS_AR: Record<StudyDiagramKind, string> = {
  flowchart: 'مخطط انسيابي',
  timeline: 'خط زمني',
};
/** Every generated diagram carries this label: a re-organized study diagram, distinct from the source's figures. */
export const REORGANIZED_DIAGRAM_LABEL_AR = 'مخطط أُعيد تنظيمه تعليميًا من مصادرك — ليس صورة من المصدر. كل خطوة وعلاقة تحمل دليلها.';

export interface StudyDiagramRequest {
  kind: StudyDiagramKind;
  source_id: string;
  /** default: lecture only on this source */
  scope?: SourceScope | null;
  page_ids?: string[];
  /** a selection on a page (regions / quote) as the focus */
  anchor?: { page_id: string; region_ids?: string[]; quote?: string | null } | null;
  topic?: string | null;
  /** ignore a cached diagram with the same key */
  force?: boolean;
}

export type DiagramNodeKind = 'start' | 'step' | 'decision' | 'outcome' | 'event';
export const DIAGRAM_NODE_KIND_LABELS_AR: Record<DiagramNodeKind, string> = {
  start: 'بداية',
  step: 'خطوة',
  decision: 'قرار',
  outcome: 'نتيجة',
  event: 'حدث',
};

export interface StudyDiagramNodeView {
  key: string;
  label: string;
  kind: DiagramNodeKind;
  /** timeline: position (1…n) and the time label as stated («Day 1», «0–24 h») */
  order: number | null;
  time_label: string | null;
  /** verified statement behind the node (claim chips) */
  statement: string;
  claim_ids: string[];
  verification: 'linked' | 'needs_review';
}

export interface StudyDiagramEdgeView {
  from: string;
  to: string;
  /** condition / relation as words («if score ≥ 7»); the direction is ALWAYS from → to */
  label: string | null;
  statement: string;
  claim_ids: string[];
  verification: 'linked' | 'needs_review';
}

export type StudyDiagramStatus = 'published' | 'abstained' | 'failed';

export interface StudyDiagramView {
  id: string;
  kind: StudyDiagramKind;
  kind_label_ar: string;
  title: string;
  label_ar: string;
  status: StudyDiagramStatus;
  source_id: string;
  scope_describe_ar: string;
  page_ids: string[];
  nodes: StudyDiagramNodeView[];
  edges: StudyDiagramEdgeView[];
  claims: Record<string, ClaimView>;
  /** parts removed by verification (shown on demand, never as supported) */
  removed: Array<{ text: string; reason_ar: string }>;
  abstain: null | { reason: AbstainReason; reason_ar: string; detail: string; suggest_scope?: SourceScope };
  /** the source changed since: the diagram may no longer match it */
  stale_reason_ar: string | null;
  model: string | null;
  cached?: boolean;
  created_at: number;
}

export interface StudyDiagramResponse {
  diagram: StudyDiagramView;
}
export interface StudyDiagramListResponse {
  diagrams: StudyDiagramView[];
}

// ───────── figure structure readings — the vision step (§13, §14, AC-08) ─────────
export const FIGURE_READING_LABEL_AR =
  'قراءة بصرية مشتقة للشكل — ليست نص المصدر. تبقى «غير مؤكدة» ولا تُعتمد إجابةً امتحانية حتى تراجعها وتؤكدها.';

export type FigureReadingStatus = 'queued' | 'running' | 'uncertain' | 'owner_reviewed' | 'rejected' | 'failed';
export const FIGURE_READING_STATUS_LABELS_AR: Record<FigureReadingStatus, string> = {
  queued: 'في الانتظار',
  running: 'تُقرأ الصورة',
  uncertain: 'غير مؤكدة — تنتظر مراجعتك',
  owner_reviewed: 'راجعتها وأكدتها',
  rejected: 'رفضتها',
  failed: 'فشلت القراءة',
};

export type FigureDirection = 'top_down' | 'bottom_up' | 'left_right' | 'right_left' | 'radial' | 'mixed' | 'unknown';
export const FIGURE_DIRECTION_LABELS_AR: Record<FigureDirection, string> = {
  top_down: 'من الأعلى إلى الأسفل',
  bottom_up: 'من الأسفل إلى الأعلى',
  left_right: 'من اليسار إلى اليمين',
  right_left: 'من اليمين إلى اليسار',
  radial: 'من المركز إلى الخارج',
  mixed: 'اتجاهات مختلطة',
  unknown: 'الاتجاه غير مقروء',
};

export interface FigureReadingView {
  id: string;
  /** the figure region read (the original region and its OCR structure are never modified) */
  figure_region_id: string;
  diagram_region_id: string | null;
  page_id: string | null;
  version_id: string;
  source_id: string;
  status: FigureReadingStatus;
  status_label_ar: string;
  label_ar: string;
  /** derived structure: nodes / edges with certainty ('read' | 'uncertain') */
  structure: DiagramStructure | null;
  direction: FigureDirection;
  direction_label_ar: string;
  /** owner-corrected structure (after review) — the model reading stays as it was */
  reviewed_structure: DiagramStructure | null;
  counts: { nodes: number; edges: number; uncertain: number };
  /** AC-08: only an owner-reviewed reading may ever back a fixed exam answer */
  usable_as_fixed_answer: boolean;
  notes_ar: string[];
  model: string | null;
  job: JobView | null;
  error_ar: string | null;
  created_at: number;
  reviewed_at: number | null;
}

export interface FigureReadingsResponse {
  figure_region_id: string;
  readings: FigureReadingView[];
  can_analyze: { available: boolean; reason_ar: string | null };
}
export interface FigureReadingResponse {
  reading: FigureReadingView;
}

export interface FigureReadingReviewRequest {
  decision: 'confirm' | 'reject';
  /** optional owner corrections (labels / edges); certainty becomes 'read' only for what the owner confirmed */
  nodes?: Array<{ id: string; label: string }>;
  edges?: Array<{ from: string; to: string; label?: string | null }>;
  note?: string | null;
}
