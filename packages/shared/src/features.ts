// Feature capability registry (§61: unfinished features are explicitly disabled, never fake).
// The server computes the live status of each feature from implementation status + configuration
// (e.g. AI provider keys) and exposes it at GET /api/capabilities. The UI must use it to disable
// controls WITH the reason, instead of showing buttons that do nothing.

export const FEATURE_KEYS = [
  // library & sources
  'library', 'upload', 'processing.pdf', 'processing.docx', 'processing.pptx', 'processing.images',
  'processing.zip', 'processing.legacy_office', 'processing.ocr', 'processing.vision',
  // reading & writing
  'workspace.reader', 'workspace.ink', 'workspace.handwriting_recognition', 'workspace.audio',
  // evidence & AI
  'search.keyword', 'search.semantic', 'evidence.citations', 'ai.explain', 'ai.chat', 'ai.study_book',
  'ai.summaries', 'ai.figure_explain', 'ai.generate_questions', 'ai.grade_written', 'ai.cases',
  'external.evidence', 'external.images',
  // questions & practice
  'questions.vault', 'questions.extraction', 'questions.matching', 'exams',
  // learning
  'flashcards', 'weakness', 'planner', 'exam_dna',
  // devices & data
  'sync', 'offline', 'backup', 'export.markdown', 'export.anki_tsv', 'export.pdf', 'export.docx',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type FeatureState =
  | 'available'
  | 'not_implemented' // not built yet — UI must show it as unavailable
  | 'requires_configuration' // e.g. AI key missing on the server
  | 'requires_connection' // needs network (offline right now)
  | 'requires_native' // needs a native iPad layer / unsupported in this browser
  | 'disabled_by_owner';

export interface FeatureStatus {
  key: FeatureKey;
  state: FeatureState;
  /** Arabic, specific reason shown next to the disabled control */
  reason_ar?: string;
}

export type CapabilitiesResponse = {
  features: Record<FeatureKey, FeatureStatus>;
  ai: { configured: boolean; provider?: string; budget_remaining_usd?: number | null };
  server_time: number;
  app_version: string;
};
