// Evidence, claims, citations and the generation/verification contract (§03, §10, §11, §12, §17, §30, §52).
//
// THE RULES (enforced server-side; see docs/ARCHITECTURE.md §3.6–3.7):
//  * A citation can only point to an `evidence` row, which is an exact excerpt of an existing region.
//  * Generators see evidence under SHORT ALIASES ("E1", "E2", …) that the server maps back to real ids.
//    An alias the server did not hand out is rejected (AC-06) — the model can never cite a page/book/URL freely.
//  * Every evidence item handed to a generator was retrieved from the RESOLVED SCOPE only (AC-05).
//  * Each medical sentence is a claim with a support type and evidence aliases; unsupported medical sentences
//    are removed from the published output and reported (never softened into "may be" — §10).
import type { SourceType, SupportType, VerificationStatus } from './enums';
import type { NormBox } from './geometry';
import type { RichText } from './richtext';
import type { ScopeMode, SourceScope } from './scope';

// ───────── views ─────────
export interface EvidenceView {
  id: string;
  source_id: string;
  source_title: string;
  source_type: SourceType;
  version_id: string;
  version_no: number;
  page_id: string | null;
  page_index: number | null;
  /** display label, e.g. «ص 12 (الصفحة 14 في الملف)» or «شريحة 3» or «فقرة 7» */
  locator_label_ar: string;
  region_id: string | null;
  region_kind: string | null;
  quote: string;
  bbox: NormBox | null;
  /** extraction status of the underlying region */
  extraction_status: 'extracted' | 'checks_passed' | 'needs_review' | 'uncertain' | 'owner_reviewed' | 'rejected';
  /** availability right now (§11: say so instead of opening a substitute page) */
  availability: 'available' | 'source_deleted' | 'version_replaced' | 'not_downloaded_offline';
}

/** Small chip label, e.g. «محاضرة ص12», «مرجع — شريحة 4», «مصدر أسئلة ص34». */
export function sourceChipLabel(e: Pick<EvidenceView, 'source_type' | 'locator_label_ar'>): string {
  const kind: Partial<Record<SourceType, string>> = {
    lecture: 'محاضرة',
    course_reference: 'مرجع',
    textbook: 'كتاب',
    guideline: 'دليل',
    question_source: 'مصدر أسئلة',
    previous_exam: 'امتحان سابق',
    my_notes: 'ملاحظاتي',
    lecture_audio: 'تسجيل',
    image_atlas: 'أطلس',
    practical_manual: 'دليل عملي',
    external_source: 'مصدر خارجي',
  };
  const short = e.locator_label_ar.replace(/\s*\(.*\)\s*$/, '').replace(/^ص /, 'ص');
  return `${kind[e.source_type] ?? 'مصدر'} ${short}`;
}

export interface CitationView {
  evidence: EvidenceView;
  relation: 'supports' | 'partially_supports' | 'contradicts' | 'context';
}

export interface ClaimView {
  id: string;
  text: string;
  support_type: SupportType;
  verification_status: VerificationStatus;
  citations: CitationView[];
  /** failed check names with Arabic reasons (e.g. critical token "11 ×10⁹/L" missing from evidence) */
  issues: Array<{ check: VerificationCheck; reason_ar: string }>;
}

export const VERIFICATION_CHECKS = [
  'schema', // output matched the structured schema
  'evidence_exists', // every alias mapped to a real evidence id (AC-06)
  'in_scope', // every evidence version is inside the resolved scope (AC-05)
  'critical_tokens', // negations, numbers, units, doses, thresholds, ages, exceptions present in cited evidence (AC-07, §12)
  'quote_containment', // directly_stated / original_quote text is contained in the evidence quote
  'entailment', // independent verifier judged the evidence supports the claim (AC-07)
  'single_best_answer', // questions (§38)
  'distractor_explanations',
  'no_answer_leak',
] as const;
export type VerificationCheck = (typeof VERIFICATION_CHECKS)[number];

// ───────── generation contract (model-facing) ─────────
/** What a generator receives for each evidence item (never real ids). */
export interface EvidenceForModel {
  alias: string; // "E1"
  source_label: string; // «محاضرة: Acute Appendicitis — ص 11»
  source_type: SourceType;
  quote: string; // exact excerpt (untrusted data)
}

/** One sentence of generated content. Medical sentences MUST carry a claim. */
export interface GeneratedSentence {
  text: string;
  /** null only for non-medical connective text (headings, transitions, questions to the learner) */
  claim: null | {
    support_type: SupportType;
    evidence: string[]; // aliases, e.g. ["E1","E3"]
  };
  /** marks a verbatim quote of the source (rendered as original text, must match exactly) */
  original_quote?: boolean;
}

export interface GeneratedBlock {
  kind:
    | 'heading' | 'paragraph' | 'term' | 'figure' | 'comparison_table' | 'clinical_note' | 'exam_pearl' | 'mini_question'
    | 'memory_hook' | 'example' | 'original_quote' | 'list' | 'flowchart' | 'warning' | 'coverage_note';
  sentences: GeneratedSentence[];
  /** for comparison_table: rows of cells; each cell is a sentence (claims allowed per cell) */
  table?: { header: string[]; rows: GeneratedSentence[][] };
  /** region aliases (R1…) this block explains, when the request supplied regions */
  explains_regions?: string[];
}

export const ABSTAIN_REASONS = [
  'not_found_in_scope', // nothing relevant in the allowed sources (suggest widening scope explicitly)
  'unreadable_source', // relevant pages failed / unreadable / not processed
  'out_of_scope_request', // asks beyond the locked scope
  'missing_key', // question has no key and evidence is insufficient
  'conflict', // sources conflict; both sides shown instead of a confident answer
  'insufficient_evidence', // partial evidence only
  'real_patient_request', // personal diagnosis/treatment request (§12)
  'ai_not_configured',
  'budget_exceeded',
] as const;
export type AbstainReason = (typeof ABSTAIN_REASONS)[number];

export const ABSTAIN_REASON_LABELS_AR: Record<AbstainReason, string> = {
  not_found_in_scope: 'لم أجد هذه المعلومة في المصادر المسموحة ضمن النطاق الحالي.',
  unreadable_source: 'الصفحات ذات الصلة غير مقروءة أو لم تكتمل معالجتها.',
  out_of_scope_request: 'الطلب يتجاوز النطاق المقفل للمصادر.',
  missing_key: 'لا يوجد مفتاح إجابة، والأدلة لا تكفي لتحديد الإجابة.',
  conflict: 'المصادر متعارضة في هذه النقطة؛ أعرض الطرفين بدل جواب جازم.',
  insufficient_evidence: 'الأدلة المتاحة تدعم جزءًا فقط من المطلوب.',
  real_patient_request: 'المنصة تعليمية ولا تقدم تشخيصًا أو خطة علاج لمريض حقيقي.',
  ai_not_configured: 'خدمة الذكاء الاصطناعي غير مُعدّة على الخادم.',
  budget_exceeded: 'بلغت ميزانية الذكاء الاصطناعي حدّها.',
};

export interface GeneratedContent {
  blocks: GeneratedBlock[];
  abstain: null | { reason: AbstainReason; detail: string };
  /** partial answers: what is covered vs not (never claim completeness that isn't there) */
  coverage_note?: string;
}

// ───────── published (server → web) ─────────
export interface ContentBlockView {
  id: string;
  block_key: string;
  section_key: string | null;
  ord: number;
  kind: GeneratedBlock['kind'];
  content: RichText; // runs carry `claim` ids; chips render after claim runs
  table?: { header: RichText[]; rows: RichText[][] } | null;
  source_region_ids: string[];
  status: 'complete' | 'incomplete' | 'rejected';
  verification_status: VerificationStatus | 'not_applicable';
}

export interface ArtifactView {
  id: string;
  lineage_id: string;
  version_no: number;
  kind: 'study_book' | 'summary' | 'explanation' | 'chat_answer' | 'comparison' | 'mind_map' | 'flowchart' | 'figure_explanation' | 'case_explanation';
  title: string | null;
  primary_source_id: string | null;
  scope: { mode: ScopeMode; source_ids: string[]; version_ids: string[]; describe_ar: string };
  params: Record<string, unknown>;
  status: 'draft' | 'generating' | 'partial' | 'verifying' | 'published' | 'stale' | 'failed' | 'superseded';
  model: string | null;
  rules_version: string;
  coverage: { pages_total?: number; pages_covered?: number; sections_total?: number; sections_covered?: number; missing_ar?: string[] } | null;
  is_frozen: boolean;
  stale_reason: string | null;
  created_at: number;
  published_at: number | null;
  blocks: ContentBlockView[];
  claims: Record<string, ClaimView>;
  /** sentences removed because they failed verification (shown on demand, never as supported) */
  removed: Array<{ text: string; reason_ar: string }>;
  abstain: null | { reason: AbstainReason; reason_ar: string; detail?: string; suggest_scope?: SourceScope };
}

/** Evidence Ribbon (§11): coverage counts per source — NOT a correctness score. */
export interface EvidenceRibbonItem {
  source_id: string;
  source_title: string;
  source_type: SourceType;
  supported_claims: number;
}
