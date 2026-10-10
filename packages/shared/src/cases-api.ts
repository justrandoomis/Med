// Clinical cases, OSCE stations and Oral/Viva (§42, §44 signals, AC-08 honesty) — track D3.
//
// THE RULES (enforced server-side, apps/server/src/modules/cases):
//  * A case is a DEFINITION (stages, FIXED patient facts, transitions per decision, checklist / rubric items) that is
//    versioned: an attempt pins the version it started on, so facts never change while it is being played.
//  * Patient / scenario details are authored educational data, labelled «بيانات تعليمية مؤلفة» — never a real patient
//    and never attributed to a source that does not state them.
//  * Every MEDICAL statement in an explanation / rationale is a claim linked to evidence (C1 validateClaims).
//    Generated cases drop unsupported sentences; the owner's own sentences are never dropped (they are marked).
//  * The engine is deterministic: same definition + same events → same states. It only follows transitions that the
//    definition declares and never invents consequences or harms.
//  * Assessment states what it can and cannot assess (no claim of measuring a real physical examination).
import { z } from 'zod';
import type { ClaimView, EvidenceView } from './evidence';
import { sourceScopeSchema, type SourceScope } from './scope';

// ───────── enums ─────────
export const CASE_KINDS = ['case', 'osce', 'viva'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];
export const CASE_KIND_LABELS_AR: Record<CaseKind, string> = {
  case: 'حالة سريرية تدريجية',
  osce: 'محطة OSCE',
  viva: 'امتحان شفهي (Viva)',
};

export const CASE_STAGE_TYPES = ['presentation', 'history', 'examination', 'investigations', 'differentials', 'diagnosis', 'management', 'review'] as const;
export type CaseStageType = (typeof CASE_STAGE_TYPES)[number];
export const CASE_STAGE_TYPE_LABELS_AR: Record<CaseStageType, string> = {
  presentation: 'القصة الأولية',
  history: 'أخذ القصة المرضية (History)',
  examination: 'الفحص السريري (Examination)',
  investigations: 'الفحوص (Investigations)',
  differentials: 'التشخيصات التفريقية (Differentials)',
  diagnosis: 'التشخيص (Diagnosis)',
  management: 'التدبير (Management)',
  review: 'مراجعة القرارات',
};

export const OSCE_STATION_TYPES = ['history_taking', 'examination', 'counselling', 'data_interpretation', 'emergency'] as const;
export type OsceStationType = (typeof OSCE_STATION_TYPES)[number];
export const OSCE_STATION_TYPE_LABELS_AR: Record<OsceStationType, string> = {
  history_taking: 'أخذ القصة المرضية (History Taking)',
  examination: 'وصف خطوات الفحص السريري (Physical Examination)',
  counselling: 'الإرشاد والتواصل (Counselling)',
  data_interpretation: 'تفسير البيانات (Data Interpretation)',
  emergency: 'سيناريو طارئ (Emergency)',
};

export const OSCE_ROLES = ['patient', 'examiner', 'tutor'] as const;
export type OsceRole = (typeof OSCE_ROLES)[number];
export const OSCE_ROLE_LABELS_AR: Record<OsceRole, string> = { patient: 'المريض', examiner: 'الممتحن', tutor: 'المعلّم' };

export const CASE_FACT_KINDS = ['story', 'history', 'vital', 'examination', 'investigation', 'imaging', 'other'] as const;
export type CaseFactKind = (typeof CASE_FACT_KINDS)[number];
export const CASE_FACT_KIND_LABELS_AR: Record<CaseFactKind, string> = {
  story: 'القصة',
  history: 'من القصة المرضية',
  vital: 'العلامات الحيوية',
  examination: 'نتيجة فحص سريري',
  investigation: 'نتيجة فحص مخبري',
  imaging: 'نتيجة تصوير',
  other: 'معلومة أخرى',
};

export const DECISION_APPROPRIATENESS = ['appropriate', 'acceptable', 'inappropriate'] as const;
export type DecisionAppropriateness = (typeof DECISION_APPROPRIATENESS)[number];
export const DECISION_APPROPRIATENESS_LABELS_AR: Record<DecisionAppropriateness, string> = {
  appropriate: 'قرار مناسب',
  acceptable: 'مقبول لكنه ليس الأفضل',
  inappropriate: 'غير مناسب في هذا السيناريو',
};

export const CHECKLIST_CATEGORIES = ['history', 'examination', 'investigations', 'interpretation', 'diagnosis', 'management', 'communication', 'safety'] as const;
export type ChecklistCategory = (typeof CHECKLIST_CATEGORIES)[number];
export const CHECKLIST_CATEGORY_LABELS_AR: Record<ChecklistCategory, string> = {
  history: 'القصة المرضية',
  examination: 'الفحص',
  investigations: 'الفحوص',
  interpretation: 'التفسير',
  diagnosis: 'التشخيص',
  management: 'التدبير',
  communication: 'التواصل',
  safety: 'السلامة',
};

export const CASE_STATUSES = ['draft', 'needs_review', 'ready'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CASE_STATUS_LABELS_AR: Record<CaseStatus, string> = {
  draft: 'مسودة',
  needs_review: 'تحتاج مراجعتك',
  ready: 'جاهزة',
};

export const CASE_ORIGINS = ['owner', 'generated'] as const;
export type CaseOrigin = (typeof CASE_ORIGINS)[number];
export const CASE_ORIGIN_LABELS_AR: Record<CaseOrigin, string> = {
  owner: 'كتبتها بنفسك',
  generated: 'مولّدة بواسطة MedLevo من المصادر المحددة',
};

/** Always shown next to patient / scenario details. */
export const AUTHORED_DATA_LABEL_AR = 'بيانات تعليمية مؤلفة';
export const AUTHORED_DATA_NOTE_AR =
  'تفاصيل المريض والسيناريو بيانات تعليمية مؤلفة لأغراض التدريب، وليست مريضًا حقيقيًا ولا منسوبة إلى مصدر لم يذكرها. المعلومات الطبية في الشروح مرتبطة بأدلة من مصادرك.';

// ───────── authoring input (owner form / normalized generator output) ─────────
const localId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, 'معرّف داخلي: حروف إنجليزية وأرقام و _ - فقط (حتى 40).');
const shortText = (max: number) => z.string().trim().min(1).max(max);
const matchPhrases = z.array(z.string().trim().min(1).max(120)).max(20).default([]);

/** One sentence of an explanation / rationale. `medical: false` = connective text that needs no evidence. */
export const caseSentenceInputSchema = z
  .object({
    text: shortText(1500),
    evidence_ids: z.array(z.string().trim().min(1).max(64)).max(8).default([]),
    medical: z.boolean().default(true),
  })
  .strict();
export type CaseSentenceInput = z.input<typeof caseSentenceInputSchema>;
const sentences = (max: number) => z.array(caseSentenceInputSchema).max(max).default([]);

export const caseFactInputSchema = z
  .object({
    id: localId,
    label: shortText(120),
    value: shortText(1000),
    kind: z.enum(CASE_FACT_KINDS).default('other'),
    /** 'start' → shown when the attempt starts; 'on_request' → revealed only by a stage / decision / patient answer */
    reveal: z.enum(['start', 'on_request']).default('on_request'),
  })
  .strict();
export type CaseFactInput = z.input<typeof caseFactInputSchema>;

export const caseDecisionInputSchema = z
  .object({
    id: localId,
    label: shortText(300),
    appropriateness: z.enum(DECISION_APPROPRIATENESS),
    reveal_fact_ids: z.array(localId).max(20).default([]),
    /** authored scenario consequence (e.g. «يتأخر التشخيص ساعتين»); never generated at run time */
    consequence: z.string().trim().max(1000).default(''),
    explanation: sentences(12),
    /** branch target; null → the stage's next stage */
    next_stage_id: localId.nullable().default(null),
  })
  .strict();
export type CaseDecisionInput = z.input<typeof caseDecisionInputSchema>;

export const caseStageInputSchema = z
  .object({
    id: localId,
    type: z.enum(CASE_STAGE_TYPES),
    title: shortText(150),
    prompt: z.string().trim().max(1500).default(''),
    reveal_fact_ids: z.array(localId).max(30).default([]),
    /** 'one' → a single final decision (may branch); 'many' → several choices, then «تابع»; 'none' → read and continue */
    select: z.enum(['one', 'many', 'none']).default('none'),
    decisions: z.array(caseDecisionInputSchema).max(20).default([]),
    next_stage_id: localId.nullable().default(null),
    teaching_points: sentences(12),
  })
  .strict();
export type CaseStageInput = z.input<typeof caseStageInputSchema>;

export const checklistItemInputSchema = z
  .object({
    id: localId,
    text: shortText(400),
    category: z.enum(CHECKLIST_CATEGORIES),
    points: z.number().int().min(1).max(5).default(1),
    /** decisions that satisfy the item (cases) */
    satisfied_by: z.array(localId).max(20).default([]),
    /** phrases that satisfy the item when the learner types them (OSCE) — normalized, deterministic */
    match: matchPhrases,
    /** expected position among examination steps (OSCE examination stations); null = order not assessed */
    order: z.number().int().min(1).max(60).nullable().default(null),
    critical: z.boolean().default(false),
    rationale: sentences(6),
  })
  .strict();
export type ChecklistItemInput = z.input<typeof checklistItemInputSchema>;

export const osceInputSchema = z
  .object({
    station_type: z.enum(OSCE_STATION_TYPES),
    candidate_instructions: shortText(2000),
    roles: z.array(z.enum(OSCE_ROLES)).min(1).max(3).default(['patient', 'examiner']),
    minutes: z.number().int().min(1).max(30).nullable().default(null),
    /** what the simulated patient answers: a typed question matching a phrase reveals the fact (never invented) */
    patient_responses: z
      .array(z.object({ id: localId, match: z.array(z.string().trim().min(1).max(120)).min(1).max(20), fact_id: localId }).strict())
      .max(60)
      .default([]),
  })
  .strict();
export type OsceInput = z.input<typeof osceInputSchema>;

export const vivaFollowUpInputSchema = z
  .object({
    id: localId,
    prompt: shortText(1000),
    when: z.discriminatedUnion('type', [
      z.object({ type: z.literal('missing'), point_id: localId }).strict(),
      z.object({ type: z.literal('covered'), point_id: localId }).strict(),
      z.object({ type: z.literal('always') }).strict(),
    ]),
  })
  .strict();

export const vivaQuestionInputSchema = z
  .object({
    id: localId,
    prompt: shortText(1000),
    points: z
      .array(z.object({ id: localId, text: shortText(400), match: z.array(z.string().trim().min(1).max(120)).min(1).max(20), rationale: sentences(6) }).strict())
      .min(1)
      .max(15),
    follow_ups: z.array(vivaFollowUpInputSchema).max(8).default([]),
    misconceptions: z
      .array(z.object({ id: localId, match: z.array(z.string().trim().min(1).max(120)).min(1).max(20), correction: sentences(4) }).strict())
      .max(10)
      .default([]),
  })
  .strict();
export type VivaQuestionInput = z.input<typeof vivaQuestionInputSchema>;

export const caseDefinitionInputSchema = z
  .object({
    kind: z.enum(CASE_KINDS),
    title: shortText(200),
    summary: z.string().trim().max(1500).default(''),
    language: z.enum(['ar', 'en']).default('ar'),
    objectives: z.array(shortText(300)).max(10).default([]),
    facts: z.array(caseFactInputSchema).max(80).default([]),
    stages: z.array(caseStageInputSchema).max(20).default([]),
    start_stage_id: localId.nullable().default(null),
    checklist: z.array(checklistItemInputSchema).max(40).default([]),
    osce: osceInputSchema.nullable().default(null),
    viva: z
      .object({ questions: z.array(vivaQuestionInputSchema).min(1).max(12), max_follow_ups: z.number().int().min(0).max(3).default(2) })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type CaseDefinitionInput = z.input<typeof caseDefinitionInputSchema>;
export type CaseDefinitionParsed = z.output<typeof caseDefinitionInputSchema>;

export const caseSaveRequestSchema = z
  .object({
    definition: caseDefinitionInputSchema,
    /** Source Lock for the evidence of this case (null → no evidence can be attached) */
    scope: sourceScopeSchema.nullable().default(null),
    /** optimistic concurrency: the version the edit is based on (updates only) */
    base_version_no: z.number().int().min(1).optional(),
  })
  .strict();
export type CaseSaveRequest = z.input<typeof caseSaveRequestSchema>;

// ───────── stored definition (server → web) ─────────
export type CaseSentenceStatus = 'linked' | 'needs_review' | 'conflict' | 'rejected' | 'no_evidence' | 'not_medical';
export const CASE_SENTENCE_STATUS_LABELS_AR: Record<CaseSentenceStatus, string> = {
  linked: 'مرتبطة بدليل تحقق منه المحقق المستقل',
  needs_review: 'مرتبطة بدليل ولم يُتحقق منها تحققًا مستقلًا بعد',
  conflict: 'الدليل يناقضها',
  rejected: 'الدليل المرفق لا يدعمها',
  no_evidence: 'بلا دليل من مصادرك',
  not_medical: 'نص ربط غير طبي',
};

export interface CaseSentence {
  text: string;
  medical: boolean;
  claim_id: string | null;
  evidence_ids: string[];
  status: CaseSentenceStatus;
  /** why it is not linked (Arabic) */
  reason_ar: string | null;
}

export interface CaseFact {
  id: string;
  label: string;
  value: string;
  kind: CaseFactKind;
  reveal: 'start' | 'on_request';
}
export interface CaseDecision {
  id: string;
  label: string;
  appropriateness: DecisionAppropriateness;
  reveal_fact_ids: string[];
  consequence: string;
  explanation: CaseSentence[];
  next_stage_id: string | null;
}
export interface CaseStage {
  id: string;
  type: CaseStageType;
  title: string;
  prompt: string;
  reveal_fact_ids: string[];
  select: 'one' | 'many' | 'none';
  decisions: CaseDecision[];
  next_stage_id: string | null;
  teaching_points: CaseSentence[];
}
export interface ChecklistItem {
  id: string;
  text: string;
  category: ChecklistCategory;
  points: number;
  satisfied_by: string[];
  match: string[];
  order: number | null;
  critical: boolean;
  rationale: CaseSentence[];
}
export interface OsceStation {
  station_type: OsceStationType;
  candidate_instructions: string;
  roles: OsceRole[];
  minutes: number | null;
  patient_responses: Array<{ id: string; match: string[]; fact_id: string }>;
}
export interface VivaPoint {
  id: string;
  text: string;
  match: string[];
  rationale: CaseSentence[];
}
export interface VivaFollowUp {
  id: string;
  prompt: string;
  when: { type: 'missing'; point_id: string } | { type: 'covered'; point_id: string } | { type: 'always' };
}
export interface VivaQuestion {
  id: string;
  prompt: string;
  points: VivaPoint[];
  follow_ups: VivaFollowUp[];
  misconceptions: Array<{ id: string; match: string[]; correction: CaseSentence[] }>;
}
export interface CaseDefinition {
  schema_version: 1;
  kind: CaseKind;
  title: string;
  summary: string;
  language: 'ar' | 'en';
  objectives: string[];
  facts: CaseFact[];
  stages: CaseStage[];
  start_stage_id: string | null;
  checklist: ChecklistItem[];
  osce: OsceStation | null;
  viva: { questions: VivaQuestion[]; max_follow_ups: number } | null;
}

export interface CaseValidationIssue {
  path: string;
  /** 'error' blocks playing; 'warning' is shown */
  severity: 'error' | 'warning';
  message_ar: string;
}

export interface CaseHonesty {
  can_assess_ar: string[];
  cannot_assess_ar: string[];
}

export interface CaseSummaryView {
  id: string;
  title: string;
  kind: CaseKind;
  kind_label_ar: string;
  station_type: OsceStationType | null;
  origin: CaseOrigin;
  origin_label_ar: string;
  status: CaseStatus;
  status_label_ar: string;
  /** why it is not 'ready' (Arabic) */
  status_reasons_ar: string[];
  version_no: number;
  scope_describe_ar: string | null;
  attempts: number;
  last_attempt: { id: string; status: CaseAttemptStatus; started_at: number; finished_at: number | null } | null;
  generation: CaseGenerationInfo | null;
  created_at: number;
  updated_at: number;
}

export interface CaseGenerationInfo {
  status: 'queued' | 'running' | 'done' | 'abstained' | 'failed';
  status_label_ar: string;
  job_id: string | null;
  message_ar: string | null;
  removed: Array<{ text: string; reason_ar: string }>;
  model: string | null;
}

export interface CaseDetailView extends CaseSummaryView {
  /** the full definition (it reveals the solution — the web shows it behind an explicit disclosure) */
  definition: CaseDefinition;
  scope: SourceScope | null;
  claims: Record<string, ClaimView>;
  validation: CaseValidationIssue[];
  honesty: CaseHonesty;
  authored_note_ar: string;
  versions: Array<{ version_no: number; created_at: number; origin: CaseOrigin; attempts: number }>;
}

export interface CaseListResponse {
  cases: CaseSummaryView[];
  /** voice mode / AI generation availability with reasons */
  capabilities: CasesCapabilities;
}

export interface CasesCapabilities {
  authoring: { available: true };
  generation: { available: boolean; reason_ar: string | null };
  ai_viva_judge: { available: boolean; reason_ar: string | null };
  voice: { available: false; reason_ar: string };
  text_mode: { available: true };
}

export interface CaseEvidenceSuggestRequest {
  scope: SourceScope;
  text: string;
  limit?: number;
}
export interface CaseEvidenceSuggestResponse {
  evidence: EvidenceView[];
  searched_ar: string;
  abstain_ar: string | null;
}

export const caseGenerateRequestSchema = z
  .object({
    lecture_source_id: z.string().trim().min(1).max(64),
    scope: sourceScopeSchema.nullable().optional(),
    kind: z.enum(CASE_KINDS),
    station_type: z.enum(OSCE_STATION_TYPES).nullable().optional(),
    topic: z.string().trim().max(300).nullable().optional(),
    page_ids: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
    language: z.enum(['ar', 'en']).optional(),
  })
  .strict()
  .refine((r) => !!r.topic?.trim() || (r.page_ids?.length ?? 0) > 0, {
    message: 'اختر صفحات من المحاضرة أو اكتب موضوعًا محددًا؛ لا تُولَّد حالة من «المحاضرة كلها» دون تحديد.',
    path: ['topic'],
  })
  .refine((r) => r.kind !== 'osce' || !!r.station_type, { message: 'اختر نوع محطة OSCE.', path: ['station_type'] });
export type CaseGenerateRequest = z.input<typeof caseGenerateRequestSchema>;

// ───────── attempts & events ─────────
export const CASE_ATTEMPT_STATUSES = ['in_progress', 'completed', 'abandoned'] as const;
export type CaseAttemptStatus = (typeof CASE_ATTEMPT_STATUSES)[number];

export const caseStartRequestSchema = z
  .object({
    /** client ULID → idempotent start */
    attempt_id: z.string().trim().min(1).max(64).optional(),
    /** 'immediate' → feedback after each decision (guided practice); 'end' → only in the final review */
    feedback: z.enum(['immediate', 'end']).default('immediate'),
    /** viva follow-up selection: deterministic rubric coverage, or an AI judge (AI-gated) */
    judge: z.enum(['deterministic', 'ai']).default('deterministic'),
    mode: z.enum(['text', 'voice']).default('text'),
  })
  .strict();
export type CaseStartRequest = z.input<typeof caseStartRequestSchema>;

const eventId = z.string().trim().min(1).max(64);
export const caseEventInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choose'), event_id: eventId, stage_id: localId, decision_id: localId }).strict(),
  z.object({ type: z.literal('advance'), event_id: eventId, stage_id: localId }).strict(),
  z.object({ type: z.literal('utterance'), event_id: eventId, text: shortText(2000) }).strict(),
  z.object({ type: z.literal('viva_answer'), event_id: eventId, question_id: localId, follow_up_id: localId.nullable().default(null), text: shortText(4000) }).strict(),
  /** correct a typed (or, later, recognized) text: the original stays in the log, the assessment uses the revision */
  z.object({ type: z.literal('revise'), event_id: eventId, target_event_id: eventId, text: shortText(4000) }).strict(),
  /** the owner's own judgement of a checklist item (id) / viva point («questionId:pointId») — labelled «حكمك»; the automatic one stays visible */
  z.object({ type: z.literal('override_item'), event_id: eventId, item_id: z.string().trim().regex(/^[A-Za-z0-9_:-]{1,90}$/), met: z.boolean(), note: z.string().trim().max(300).default('') }).strict(),
  z.object({ type: z.literal('finish'), event_id: eventId }).strict(),
]);
export type CaseEventInput = z.input<typeof caseEventInputSchema>;
export type CaseEventType = CaseEventInput['type'];

export interface CaseStoredEvent {
  id: string;
  seq: number;
  type: CaseEventType;
  payload: Record<string, unknown>;
  at: number;
}

export interface RevealedFact {
  id: string;
  label: string;
  value: string;
  kind: CaseFactKind;
  kind_label_ar: string;
  /** what revealed it (Arabic) */
  revealed_by_ar: string;
}

export interface CaseHistoryEntry {
  event_id: string;
  seq: number;
  type: CaseEventType;
  at: number;
  stage_title: string | null;
  /** the learner's choice / text (typed text shows its latest revision) */
  label: string;
  original_text: string | null;
  revised: boolean;
  /** feedback (only when the attempt's feedback mode allows it now) */
  feedback: null | {
    appropriateness: DecisionAppropriateness | null;
    appropriateness_label_ar: string | null;
    consequence: string | null;
    explanation: CaseSentence[];
  };
  revealed_fact_ids: string[];
  /** simulated patient answers (OSCE) — only defined facts, never invented */
  patient_responses: Array<{ fact_id: string; text: string }>;
  no_response_ar: string | null;
  /** OSCE checklist items matched by this text (immediate feedback mode only) */
  matched_items: string[];
}

export interface CaseRunStageView {
  id: string;
  type: CaseStageType;
  type_label_ar: string;
  title: string;
  prompt: string;
  select: 'one' | 'many' | 'none';
  /** labels only — never the appropriateness, explanation or branch target (no spoilers) */
  decisions: Array<{ id: string; label: string; chosen: boolean }>;
  can_advance: boolean;
  is_last: boolean;
}

export interface CaseRunView {
  attempt: {
    id: string;
    case_id: string;
    case_version_no: number;
    status: CaseAttemptStatus;
    feedback: 'immediate' | 'end';
    judge: 'deterministic' | 'ai';
    mode: 'text';
    started_at: number;
    finished_at: number | null;
    last_seq: number;
  };
  case: {
    id: string;
    title: string;
    kind: CaseKind;
    kind_label_ar: string;
    origin: CaseOrigin;
    origin_label_ar: string;
    summary: string;
    objectives: string[];
    authored_note_ar: string;
    osce: null | { station_type: OsceStationType; station_label_ar: string; candidate_instructions: string; roles: OsceRole[]; minutes: number | null };
  };
  facts: RevealedFact[];
  stage: CaseRunStageView | null;
  history: CaseHistoryEntry[];
  viva: null | {
    current: null | { question_id: string; follow_up_id: string | null; prompt: string; index: number; total: number; is_follow_up: boolean };
    answered: number;
    total_questions: number;
  };
  can_finish: boolean;
  finished: boolean;
  claims: Record<string, ClaimView>;
  honesty: CaseHonesty;
  voice: { available: false; reason_ar: string };
}

export interface CaseEventResponse {
  /** 'applied' or 'duplicate' (the same event_id was already recorded — nothing applied twice) */
  result: 'applied' | 'duplicate';
  run: CaseRunView;
}

export interface ChecklistResult {
  id: string;
  text: string;
  category: ChecklistCategory;
  category_label_ar: string;
  points: number;
  critical: boolean;
  /** the automatic, deterministic judgement */
  auto_met: boolean;
  /** what satisfied it (Arabic), or why not */
  auto_reason_ar: string;
  /** the owner's judgement, when given */
  override: null | { met: boolean; note: string; at: number };
  met: boolean;
  rationale: CaseSentence[];
  evidence_note_ar: string | null;
}

export interface CaseReportView {
  attempt: CaseRunView['attempt'];
  case: CaseRunView['case'];
  checklist: ChecklistResult[];
  /** estimate from the checklist only (null when there is no checklist) */
  score: null | { got: number; max: number; label_ar: string };
  decisions: Array<{
    stage_title: string;
    stage_type_label_ar: string;
    label: string;
    appropriateness: DecisionAppropriateness;
    appropriateness_label_ar: string;
    consequence: string;
    explanation: CaseSentence[];
  }>;
  missed_appropriate: Array<{ stage_title: string; label: string; explanation: CaseSentence[] }>;
  order_check: null | { assessed: boolean; in_order: boolean | null; note_ar: string };
  viva: null | {
    questions: Array<{
      id: string;
      prompt: string;
      answers: Array<{ text: string; original_text: string | null; follow_up_prompt: string | null }>;
      covered: Array<{ id: string; text: string; by: 'match' | 'ai' | 'owner' }>;
      missed: Array<{ id: string; text: string; rationale: CaseSentence[] }>;
      misconceptions: Array<{ id: string; correction: CaseSentence[]; matched_phrase: string }>;
      follow_ups_asked: string[];
    }>;
    covered_points: number;
    total_points: number;
  };
  /** pages to re-read for the gaps (from the evidence of the missed items / points) */
  review_plan: Array<{ label_ar: string; evidence: EvidenceView[] }>;
  teaching_points: CaseSentence[];
  honesty: CaseHonesty;
  notes_ar: string[];
  claims: Record<string, ClaimView>;
}

export interface CaseAttemptListResponse {
  attempts: Array<{ id: string; case_id: string; case_title: string; kind: CaseKind; status: CaseAttemptStatus; started_at: number; finished_at: number | null; score: { got: number; max: number } | null }>;
}

/** Signals for the Weakness Center (shared WeaknessSignal shape + grouping hints). */
export interface CaseWeaknessSignal {
  type: 'case' | 'osce';
  ref_id: string;
  at: number;
  correct: boolean | null;
  confidence: null;
  hints_used: 0;
  mistake_type: null;
  mistake_origin: null;
  label: string;
  case_id: string;
  item_id: string;
  /** sources of the item's evidence (grouping hint) */
  source_ids: string[];
  owner_judged: boolean;
}
export interface CaseSignalsResponse {
  signals: CaseWeaknessSignal[];
  note_ar: string;
}
