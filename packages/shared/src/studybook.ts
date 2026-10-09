// Explanation Rules Engine, Study Book, contextual chat, summaries & terminology contract (§16–§21, §24, §30, §31).
import type { AnswerStyle, ExplanationLevel, SummaryType } from './enums';
import type { SourceScope } from './scope';
import type { TextQuote } from './annotations';

/** Subject templates (§19). A template structures an explanation; it NEVER justifies inventing missing fields. */
export const EXPLANATION_TEMPLATES = {
  anatomy: ['الموقع', 'العلاقات', 'التروية الدموية', 'التصريف', 'التعصيب', 'الأهمية السريرية'],
  physiology: ['الآلية', 'التنظيم', 'العلاقات', 'ما يحدث عند الاختلال'],
  pathology: ['السبب', 'Pathogenesis', 'التغيرات', 'المظاهر السريرية', 'التشخيص'],
  pharmacology: ['Mechanism', 'الاستعمالات', 'الموانع', 'الآثار الجانبية', 'التداخلات'],
  surgery: ['Presentation', 'History', 'Examination', 'Differential Diagnosis', 'Investigations', 'Management', 'Complications'],
  medicine: ['التعريف', 'الأسباب', 'المظاهر السريرية', 'الفحوصات', 'التشخيص التفريقي', 'العلاج', 'المضاعفات'],
  general: [],
} as const;
export type ExplanationTemplateKey = keyof typeof EXPLANATION_TEMPLATES;

/** Versioned, owner-editable rule set (stored as settings / per-node overrides). */
export interface ExplanationRules {
  rules_version: string; // bump on any change → part of the cache key
  template: ExplanationTemplateKey;
  level: ExplanationLevel;
  dialect: 'fusha_simple' | 'iraqi_teaching';
  /** owner free-text instruction, e.g. «اشرح لي كأني أول مرة» — treated as preference, never as a source */
  custom_instruction: string;
  keep_english_terms: boolean;
  show_original_text: boolean;
  include: { memory_hooks: boolean; clinical_notes: boolean; exam_pearls: boolean; mini_questions: boolean; examples: boolean };
  socratic: boolean;
}

export interface SelectionAnchor {
  source_id: string;
  version_id: string;
  page_id?: string | null;
  region_ids?: string[];
  quote?: TextQuote | null;
  /** normalized rectangle for "explain this part of the image" */
  bbox?: { x: number; y: number; w: number; h: number } | null;
  block?: { lineage_id: string; block_key: string } | null;
}

export type SelectionAction = 'explain' | 'simplify' | 'translate' | 'ask' | 'compare' | 'create_mcq' | 'create_flashcard' | 'add_to_revision' | 'explain_image';

export interface ExplainRequest {
  action: Extract<SelectionAction, 'explain' | 'simplify' | 'translate' | 'explain_image'>;
  anchor: SelectionAnchor;
  scope: SourceScope;
  style: AnswerStyle;
  level?: ExplanationLevel;
  instruction?: string;
  /** Explain Until Understood: previous artifact id + the strategy to switch to */
  retry_of?: { artifact_id: string; strategy: 'prerequisites' | 'diagram' | 'comparison' | 'clinical_example' | 'analogy' | 'smaller_steps' } | null;
}

export interface ChatThreadCreate {
  anchor: SelectionAnchor | null;
  scope: SourceScope;
  style: AnswerStyle;
  socratic?: boolean;
}
export interface ChatMessageCreate {
  text: string;
  style?: AnswerStyle;
}

export interface SummaryRequest {
  type: SummaryType;
  source_id: string;
  version_id?: string;
  /** page indexes / section keys / topic ids; empty = whole lecture */
  page_indexes?: number[];
  topic_ids?: string[];
  scope: SourceScope;
  instruction?: string;
}

export interface StudyBookRequest {
  source_id: string;
  version_id?: string;
  scope: SourceScope;
  rules?: Partial<ExplanationRules>;
  /** generate only these sections (progressive generation, resumable per section/block) */
  section_keys?: string[];
}

export interface MedicalTermView {
  id: string;
  term_en: string;
  abbreviation: string | null;
  synonyms: string[];
  explanation_ar: string | null;
  accepted_translation_ar: string | null;
  owner_preferred_ar: string | null;
  origin: 'owner' | 'extracted' | 'generated';
  updated_at: number;
}
