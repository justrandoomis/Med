// Study Book module client (/api/studybook) — explanations, comparisons, Study Book, summaries, contextual chat,
// explanation rules — plus the owner's term dictionary (/api/studybook/terms → evidence module, owner of the table).
import type {
  ChatPostResponse,
  ChatThreadResponse,
  ChatThreadsResponse,
  CompareRequest,
  ExplainRequest,
  ExplainResponse,
  ExplanationRulesPatch,
  ExplanationRulesResponse,
  MedicalTermView,
  NoteDTO,
  StudyArtifactView,
  StudyBookCreateResponse,
  StudyBookStatusResponse,
  StudyBookView,
  SummaryCreateResponse,
  SummaryPreviewResponse,
  SummaryRequest,
  ChatThreadCreate,
  AnswerStyle,
  StudyBookRequest,
} from '@medlevo/shared';
import { api } from '../../lib/api';

const AI_TIMEOUT = 5 * 60_000;

export interface ArtifactListItem {
  id: string;
  kind: StudyArtifactView['kind'];
  title: string | null;
  status: StudyArtifactView['status'];
  version_no: number;
  lineage_id: string;
  created_at: number;
  is_frozen: boolean;
  anchor_page_id: string | null;
}

export interface TermInput {
  term_en: string;
  abbreviation?: string | null;
  synonyms?: string[];
  explanation_ar?: string | null;
  accepted_translation_ar?: string | null;
  owner_preferred_ar?: string | null;
}

export const studybookApi = {
  explain: (req: ExplainRequest & { rules?: ExplanationRulesPatch }, signal?: AbortSignal) => api.post<ExplainResponse>('/studybook/explain', req, { timeoutMs: AI_TIMEOUT, signal }),
  compare: (req: CompareRequest, signal?: AbortSignal) => api.post<ExplainResponse>('/studybook/compare', req, { timeoutMs: AI_TIMEOUT, signal }),
  artifact: (id: string) => api.get<{ artifact: StudyArtifactView }>(`/studybook/artifacts/${encodeURIComponent(id)}`, { timeoutMs: 30_000 }),
  artifacts: (sourceId: string, kind?: StudyArtifactView['kind'], limit = 20) =>
    api.get<{ artifacts: ArtifactListItem[] }>('/studybook/artifacts', { query: { source_id: sourceId, kind, limit }, timeoutMs: 30_000 }),
  freezeArtifact: (id: string, frozen: boolean) => api.post<{ artifact: StudyArtifactView }>(`/studybook/artifacts/${encodeURIComponent(id)}/freeze`, { frozen }),

  bookForSource: (sourceId: string) => api.get<StudyBookStatusResponse>('/studybook/books', { query: { source_id: sourceId }, timeoutMs: 30_000 }),
  book: (id: string) => api.get<StudyBookView>(`/studybook/books/${encodeURIComponent(id)}`, { timeoutMs: 30_000 }),
  createBook: (req: StudyBookRequest & { regenerate?: boolean }) => api.post<StudyBookCreateResponse>('/studybook/books', req, { timeoutMs: 60_000 }),
  resumeBook: (id: string) => api.post<StudyBookView>(`/studybook/books/${encodeURIComponent(id)}/resume`),
  cancelBook: (id: string) => api.post<StudyBookView>(`/studybook/books/${encodeURIComponent(id)}/cancel`),
  freezeBook: (id: string, frozen: boolean) => api.post<StudyBookView>(`/studybook/books/${encodeURIComponent(id)}/freeze`, { frozen }),

  summaryPreview: (req: SummaryRequest) => api.post<SummaryPreviewResponse>('/studybook/summaries/preview', req, { timeoutMs: 30_000 }),
  createSummary: (req: SummaryRequest) => api.post<SummaryCreateResponse>('/studybook/summaries', req, { timeoutMs: 60_000 }),
  summary: (id: string) => api.get<StudyBookView>(`/studybook/summaries/${encodeURIComponent(id)}`, { timeoutMs: 30_000 }),

  createThread: (req: ChatThreadCreate & { title?: string }) => api.post<ChatThreadResponse>('/studybook/threads', req),
  threads: (sourceId: string, pageId?: string | null) => api.get<ChatThreadsResponse>('/studybook/threads', { query: { source_id: sourceId, page_id: pageId ?? undefined }, timeoutMs: 30_000 }),
  thread: (id: string) => api.get<ChatThreadResponse>(`/studybook/threads/${encodeURIComponent(id)}`, { timeoutMs: 30_000 }),
  ask: (threadId: string, text: string, style?: AnswerStyle, signal?: AbortSignal) =>
    api.post<ChatPostResponse>(`/studybook/threads/${encodeURIComponent(threadId)}/messages`, { text, style }, { timeoutMs: AI_TIMEOUT, signal }),
  archiveThread: (id: string) => api.post(`/studybook/threads/${encodeURIComponent(id)}/archive`),
  saveAsNote: (messageId: string, noteId: string) => api.post<{ note: NoteDTO; result: string }>(`/studybook/messages/${encodeURIComponent(messageId)}/save-note`, { note_id: noteId }),

  rules: (q: { source_id?: string; node_id?: string } = {}) => api.get<ExplanationRulesResponse>('/studybook/rules', { query: q, timeoutMs: 30_000 }),
  saveOwnerRules: (patch: ExplanationRulesPatch) => api.put<ExplanationRulesResponse>('/studybook/rules/owner', patch),
  saveNodeRules: (nodeId: string, patch: ExplanationRulesPatch) => api.put<ExplanationRulesResponse>(`/studybook/rules/nodes/${encodeURIComponent(nodeId)}`, patch),
  clearNodeRules: (nodeId: string) => api.del<ExplanationRulesResponse>(`/studybook/rules/nodes/${encodeURIComponent(nodeId)}`),

  // the owner's dictionary: /api/studybook/terms forwards to the evidence module (owner of medical_term; also used by retrieval / search expansion)
  terms: () => api.get<{ terms: MedicalTermView[] }>('/studybook/terms', { timeoutMs: 30_000 }),
  createTerm: (t: TermInput) => api.post<{ term: MedicalTermView }>('/studybook/terms', t),
  updateTerm: (id: string, t: Partial<TermInput>) => api.patch<{ term: MedicalTermView }>(`/studybook/terms/${encodeURIComponent(id)}`, t),
  deleteTerm: (id: string) => api.del<{ ok: true }>(`/studybook/terms/${encodeURIComponent(id)}`),
};
