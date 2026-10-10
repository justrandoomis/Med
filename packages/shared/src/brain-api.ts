// Course Brain API (track F2 — §05 topics, §16, §23 course page, §31 knowledge map, §36 coverage map, §44 student
// knowledge map). Server: apps/server/src/modules/brain (mounted at /api/brain). Everything here is DETERMINISTIC:
// no AI is involved in extraction, relations, coverage or the knowledge maps.
//
// Honesty rules carried by these shapes:
//  * a stated mention points at the exact region (and sentence) it came from — `support: 'stated'`;
//  * a relation the text does not state is `support: 'inferred'` and carries its reasons; it is never shown as
//    lecture text, and it never widens the Source Lock (it only links to where the other concept is explained);
//  * coverage numbers always come with their denominators; source questions and generated questions are separate;
//  * the mastery estimate is labelled an estimate and is null below its minimum sample.

/** Job kind: deterministic knowledge extraction of one source version (enqueued by processing after a lecture). */
export const EXTRACT_KNOWLEDGE_JOB_KIND = 'extract_knowledge';
export interface ExtractKnowledgeJobInput {
  version_id: string;
}

/** Source types the Course Brain reads (study material; question sources and owner notes are not knowledge text). */
export const BRAIN_SOURCE_TYPES = ['lecture', 'course_reference', 'textbook', 'practical_manual', 'guideline'] as const;

// ───────── roles of a stated mention (the section / pattern it came from) ─────────
export const CONCEPT_ROLES = [
  'heading',
  'definition',
  'classification',
  'cause',
  'mechanism',
  'sign',
  'investigation',
  'differential',
  'management',
  'complication',
  'drug',
  'value',
  'table_entry',
  'figure',
  'feature',
] as const;
export type ConceptRole = (typeof CONCEPT_ROLES)[number];

export const CONCEPT_ROLE_LABELS_AR: Record<ConceptRole, string> = {
  heading: 'عنوان',
  definition: 'تعريف',
  classification: 'تصنيف',
  cause: 'سبب',
  mechanism: 'آلية',
  sign: 'عرض أو علامة',
  investigation: 'فحص',
  differential: 'تشخيص تفريقي',
  management: 'تدبير وعلاج',
  complication: 'مضاعفة',
  drug: 'دواء',
  value: 'قيمة أو حد',
  table_entry: 'بند جدول',
  figure: 'شكل أو جدول',
  feature: 'مذكور في النص',
};

/** Label of any stored role (stated roles + the question module's `candidate_*` roles). */
export function conceptRoleLabelAr(role: string | null | undefined): string {
  if (!role) return 'مذكور';
  if ((CONCEPT_ROLES as readonly string[]).includes(role)) return CONCEPT_ROLE_LABELS_AR[role as ConceptRole];
  if (role === 'candidate_heading') return 'مرشح من عنوان';
  if (role === 'candidate_table') return 'مرشح من جدول';
  if (role === 'candidate_caption') return 'مرشح من تعليق شكل';
  if (role.startsWith('candidate')) return 'مرشح من النص';
  return role;
}

export const RELATION_KINDS = ['prerequisite', 'part_of', 'differential_of', 'causes', 'treats', 'related'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];
export const RELATION_LABELS_AR: Record<RelationKind, string> = {
  prerequisite: 'متطلب سابق لـ',
  part_of: 'جزء من',
  differential_of: 'تشخيص تفريقي لـ',
  causes: 'يسبب',
  treats: 'يعالج',
  related: 'مرتبط بـ',
};

export type ConceptStatus = 'suggested' | 'accepted' | 'rejected';
export const CONCEPT_STATUS_LABELS_AR: Record<ConceptStatus, string> = { suggested: 'مقترح', accepted: 'مقبول', rejected: 'مرفوض' };

// ───────── locations ─────────
export interface BrainLocation {
  source_id: string;
  source_title: string;
  version_id: string;
  page_id: string | null;
  page_index: number | null;
  /** «ص 12 (الصفحة 2 في الملف)» / «شريحة 3» / «فقرة 4» — never an invented page number */
  page_label_ar: string | null;
  region_id: string;
}

export interface ConceptMentionView extends BrainLocation {
  id: string;
  role: string;
  role_label_ar: string;
  /** 'stated' = Course Brain extraction; 'candidate' = question-matching candidate (questions module) */
  support: 'stated' | 'candidate';
  /** exact text the mention came from (a sentence of the region, or the cell / heading) */
  quote: string | null;
  /** heading the region sits under */
  section: string | null;
}

export interface BrainConceptView {
  id: string;
  /** display name (Arabic when present, otherwise English) */
  name: string;
  name_en: string | null;
  name_ar: string | null;
  kind: string | null;
  origin: 'auto' | 'owner';
  status: ConceptStatus;
  name_origin: 'auto' | 'owner';
  aliases: string[];
  /** roles of its stated mentions (definition, sign, …) */
  roles: string[];
  has_definition: boolean;
  mention_count: number;
  lecture_ids: string[];
  owner_note: string | null;
  updated_at: number;
  mentions?: ConceptMentionView[];
}

export interface BrainConceptListResponse {
  items: BrainConceptView[];
  /** concepts excluded from the list (rejected / merged) are counted, never hidden silently */
  counts: { suggested: number; accepted: number; rejected: number; merged: number };
  notes_ar: string[];
}

export interface BrainConceptPatchRequest {
  status?: ConceptStatus;
  name_en?: string | null;
  name_ar?: string | null;
  kind?: string | null;
  note?: string | null;
}
export interface BrainConceptCreateRequest {
  name_en?: string | null;
  name_ar?: string | null;
  kind?: string | null;
}
export interface BrainConceptMergeRequest {
  /** the concept that absorbs this one (its mentions, relations and names) */
  into_id: string;
}
export interface BrainConceptResponse {
  concept: BrainConceptView & { merged_into?: { id: string; name: string } | null };
  relations?: ConceptRelationView[];
}

// ───────── relations ─────────
export interface RelationReason {
  kind: 'defined_earlier_used_later' | 'listed_under_section' | 'owner';
  text_ar: string;
  /** where the prerequisite / source side is stated */
  from?: BrainLocation & { quote: string | null };
  /** where it is used */
  to?: BrainLocation & { quote: string | null };
}

export interface ConceptRelationView {
  id: string;
  from: { id: string; name: string; status: ConceptStatus };
  to: { id: string; name: string; status: ConceptStatus };
  relation: RelationKind;
  relation_label_ar: string;
  /** 'inferred' relations are never lecture text */
  support: 'stated' | 'inferred';
  support_label_ar: string;
  origin: 'auto' | 'owner';
  status: ConceptStatus;
  reasons: RelationReason[];
  note: string | null;
  course_node_id: string | null;
  updated_at: number;
}
export interface ConceptRelationListResponse {
  items: ConceptRelationView[];
  notes_ar: string[];
}
export interface ConceptRelationCreateRequest {
  from_concept_id: string;
  to_concept_id: string;
  relation: RelationKind;
  note?: string | null;
}
export interface ConceptRelationPatchRequest {
  status?: ConceptStatus;
  relation?: RelationKind;
  note?: string | null;
}

// ───────── extraction status (course page) ─────────
export interface KnowledgeObjective {
  text: string;
  region_id: string;
  page_label_ar: string | null;
}

export interface BrainLectureStatus {
  source_id: string;
  title: string;
  source_type: string;
  /** the study version (frozen, else current) */
  version_id: string | null;
  processing_status: string | null;
  /** processed enough to read its regions */
  processed: boolean;
  extraction: null | {
    status: 'completed' | 'nothing_found';
    extractor_version: string;
    /** extracted from the study version with the current extractor */
    current: boolean;
    updated_at: number;
    counts: { concepts: number; mentions: number; definitions: number; sections: number; table_entries: number };
    objectives: KnowledgeObjective[];
  };
  job: null | { id: string; status: string };
}

export interface CourseBrainResponse {
  course: { id: string; title: string; kind: string };
  lectures: BrainLectureStatus[];
  totals: { lectures: number; extracted: number; concepts: number; relations: { suggested: number; accepted: number; rejected: number } };
  notes_ar: string[];
}

export interface BrainExtractRequest {
  source_id?: string;
  course_node_id?: string;
}
export interface BrainExtractResponse {
  jobs: Array<{ source_id: string; version_id: string; job_id: string }>;
  skipped: Array<{ source_id: string; reason_ar: string }>;
}

// ───────── knowledge map (§31, §16): concepts ↔ lectures ↔ questions ─────────
export type KnowledgeNodeType = 'lecture' | 'concept' | 'question';
export interface KnowledgeMapNode {
  id: string;
  type: KnowledgeNodeType;
  label: string;
  /** second line: source type, roles, question origin… */
  sublabel: string | null;
  /** concept status / question origin */
  status: string | null;
  /** in-app link (reader page, question, concept list) */
  href: string | null;
  /** order inside its column */
  order: number;
}
export interface KnowledgeMapEdge {
  id: string;
  from: string;
  to: string;
  /** mentions: lecture ↔ concept (stated) · covers: question ↔ concept / lecture · relation: concept ↔ concept */
  kind: 'mentions' | 'covers' | 'relation';
  support: 'stated' | 'inferred' | 'matched' | 'owner';
  relation: RelationKind | null;
  status: string | null;
  label_ar: string;
  /** pages that back the edge (mentions / covers) */
  pages: Array<{ page_id: string; label_ar: string }>;
}
export interface KnowledgeMapResponse {
  course: { id: string; title: string };
  /** `source_id` filter applied (one lecture), null = whole course */
  lecture_id: string | null;
  nodes: KnowledgeMapNode[];
  edges: KnowledgeMapEdge[];
  truncated: { concepts: { shown: number; total: number }; questions: { shown: number; total: number } };
  notes_ar: string[];
}

// ───────── Question Coverage Map (§36) ─────────
export type CoverageStatus = 'source' | 'generated_only' | 'uncovered';
export const COVERAGE_STATUS_LABELS_AR: Record<CoverageStatus, string> = {
  source: 'لها أسئلة من المصادر',
  generated_only: 'أسئلة مولدة فقط',
  uncovered: 'بلا أسئلة',
};

export interface CoverageCount {
  /** denominator */
  total: number;
  with_source_questions: number;
  with_generated_questions: number;
  /** at least one of its questions (source or generated) has an attempt */
  attempted: number;
  /** neither source nor generated questions */
  uncovered: number;
}

export interface CoveragePageRow {
  page_id: string;
  page_index: number;
  label_ar: string;
  source_question_ids: string[];
  generated_question_ids: string[];
  attempted_question_ids: string[];
  status: CoverageStatus;
}
export interface CoverageConceptRow {
  concept_id: string;
  name: string;
  status_concept: ConceptStatus;
  page_ids: string[];
  source_question_ids: string[];
  generated_question_ids: string[];
  attempted_question_ids: string[];
  status: CoverageStatus;
  /** why the questions count for this concept */
  basis_ar: string;
}
export interface CoverageLecture {
  source_id: string;
  title: string;
  version_id: string | null;
  pages: CoveragePageRow[];
  concepts: CoverageConceptRow[];
  totals: {
    pages: CoverageCount;
    concepts: CoverageCount;
    questions: { source: number; generated: number; attempted_source: number; attempted_generated: number };
  };
}
export interface CoverageResponse {
  scope: { kind: 'course' | 'lecture'; id: string; title: string };
  lectures: CoverageLecture[];
  totals: { pages: CoverageCount; concepts: CoverageCount };
  notes_ar: string[];
}

// ───────── Student Knowledge Map (§44) ─────────
export const KNOWLEDGE_STATES = ['not_started', 'read', 'practicing', 'needs_work', 'developing', 'strong'] as const;
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];
export const KNOWLEDGE_STATE_LABELS_AR: Record<KnowledgeState, string> = {
  not_started: 'لم تبدأ بعد',
  read: 'قرأت مواضعه',
  practicing: 'تتدرب عليه (لا تقدير بعد)',
  needs_work: 'يحتاج مراجعة',
  developing: 'يتحسن',
  strong: 'إتقان تقديري جيد',
};

export interface StudentConceptView {
  concept_id: string;
  name: string;
  concept_status: ConceptStatus;
  state: KnowledgeState;
  state_label_ar: string;
  /** null below the minimum sample — never a guess */
  mastery_estimate: number | null;
  mastery_sample: number;
  mastery_basis_ar: string;
  /** why this state (each line is checkable) */
  reasons_ar: string[];
  reading: { pages_total: number; pages_viewed: number };
  practice: { questions: number; question_attempts: number; scored_attempts: number; cards: number; card_reviews: number };
  weakness: null | { id: string; status: string; score: number };
  prerequisites: Array<{ concept_id: string; name: string; state: KnowledgeState; state_label_ar: string; support: 'stated' | 'inferred'; relation_status: ConceptStatus; relation_id: string }>;
  lectures: Array<{ source_id: string; title: string; page_ids: string[]; first_page_label_ar: string | null }>;
  next_step_ar: string;
}
export interface StudentKnowledgeResponse {
  scope: { kind: 'course' | 'all'; id: string | null; title: string | null };
  items: StudentConceptView[];
  counts: Record<KnowledgeState, number>;
  estimate_note_ar: string;
  notes_ar: string[];
}

// ───────── topics (§05) ─────────
export const TOPIC_ENTITY_TYPES = ['source', 'source_region', 'question', 'library_node', 'concept', 'image_asset', 'flashcard', 'note'] as const;
export type TopicEntityType = (typeof TOPIC_ENTITY_TYPES)[number];
export const TOPIC_ENTITY_LABELS_AR: Record<TopicEntityType, string> = {
  source: 'مصدر',
  source_region: 'موضع في مصدر',
  question: 'سؤال',
  library_node: 'مجلد',
  concept: 'مفهوم',
  image_asset: 'صورة',
  flashcard: 'بطاقة',
  note: 'ملاحظة',
};

export interface TopicLinkDetail {
  id: string;
  topic_id: string;
  entity_type: string;
  entity_id: string;
  origin: 'auto' | 'owner';
  status: ConceptStatus;
  created_at: number;
  /** resolved title (source title, question stem, page + excerpt…); null when the entity no longer exists */
  label: string | null;
  sublabel: string | null;
  /** in-app link */
  href: string | null;
  /** why the system suggested it (auto links) */
  reason_ar: string | null;
}
export interface TopicDetailResponse {
  topic: { id: string; title: string; title_ar: string | null; parent_topic_id: string | null; created_at: number; updated_at: number };
  links: TopicLinkDetail[];
  children: Array<{ id: string; title: string; title_ar: string | null }>;
  counts: { accepted: number; suggested: number; rejected: number };
}
export interface TopicSuggestResponse {
  created: number;
  /** links the owner already decided (accepted / rejected / own) — never touched */
  kept: number;
}
