// Question Vault server calls (/api/questions). Shapes come from @medlevo/shared (questions.ts, questions-api.ts).
import type {
  ConceptListResponse,
  DuplicateDetail,
  ExtractionSummaryView,
  JobStartedResponse,
  JobView,
  KeyCorrectionRequest,
  LectureQuestionsResponse,
  QuestionCorrectionRequest,
  QuestionDetailResponse,
  QuestionListResponse,
  QuestionMutationResponse,
  QuestionOriginalView,
  QuestionReviewRequest,
  QuickAddResponse,
  QuickAddTextRequest,
  ReviewQueueResponse,
} from '@medlevo/shared';
import { api } from '../../lib/api';

const enc = encodeURIComponent;

export interface VaultFilters {
  course_id?: string;
  source_id?: string;
  lecture_id?: string;
  relation?: string;
  answer_status?: string;
  extraction_status?: string;
  status?: string;
  origin?: string;
  review?: 'open' | 'none';
  q?: string;
}

export const questionsApi = {
  list: (f: VaultFilters, cursor?: string | null) =>
    api.get<QuestionListResponse>('/questions', { query: { ...f, cursor: cursor ?? undefined, limit: 50 }, timeoutMs: 30_000 }),
  detail: (id: string) => api.get<QuestionDetailResponse>(`/questions/${enc(id)}`, { timeoutMs: 30_000 }),
  duplicates: (id: string) => api.get<{ items: DuplicateDetail[] }>(`/questions/${enc(id)}/duplicates`),
  original: (id: string, occurrenceId?: string) =>
    api.get<QuestionOriginalView>(`/questions/${enc(id)}/original`, { query: { occurrence_id: occurrenceId } }),
  correct: (id: string, body: QuestionCorrectionRequest) => api.patch<QuestionMutationResponse>(`/questions/${enc(id)}`, body),
  setKey: (id: string, body: KeyCorrectionRequest) => api.post<QuestionMutationResponse>(`/questions/${enc(id)}/key`, body),
  review: (id: string, body: QuestionReviewRequest) => api.post<QuestionMutationResponse>(`/questions/${enc(id)}/review`, body),
  decideLink: (linkId: string, status: 'accepted' | 'rejected', reason?: string) =>
    api.post<{ question: QuestionDetailResponse['question'] }>(`/questions/links/${enc(linkId)}/decision`, { status, reason: reason || undefined }),
  decideDuplicate: (dupId: string, status: 'confirmed' | 'rejected', reason?: string) =>
    api.post<{ ok: true }>(`/questions/duplicates/${enc(dupId)}/decision`, { status, reason: reason || undefined }),
  forLecture: (sourceId: string, pageId?: string | null) =>
    api.get<LectureQuestionsResponse>(`/questions/for-lecture/${enc(sourceId)}`, { query: { page_id: pageId ?? undefined }, timeoutMs: 30_000, skipAuthRedirect: true }),
  reviewQueue: (q: { status?: 'open' | 'resolved' | 'all'; kind?: string; source_id?: string } = {}) =>
    api.get<ReviewQueueResponse>('/questions/review-queue', { query: q, timeoutMs: 30_000 }),
  resolveItem: (itemId: string, action: 'accepted' | 'corrected' | 'rejected' | 'dismissed', note?: string) =>
    api.post<{ ok: true }>(`/questions/review-queue/${enc(itemId)}/resolve`, { action, note: note || undefined }),
  extraction: (versionId: string) => api.get<{ summary: ExtractionSummaryView | null; job: JobView | null }>(`/questions/extractions/${enc(versionId)}`),
  extract: (versionId: string) => api.post<JobStartedResponse>('/questions/extract', { version_id: versionId }),
  match: (sourceId: string) => api.post<JobStartedResponse>('/questions/match', { source_id: sourceId }),
  quickAddText: (body: QuickAddTextRequest) => api.post<QuickAddResponse>('/questions/quick-add', body),
  quickAddImage: (form: FormData) => api.post<QuickAddResponse>('/questions/quick-add', form, { timeoutMs: 120_000 }),
  concepts: (sourceId: string) => api.get<ConceptListResponse>('/questions/concepts', { query: { source_id: sourceId } }),
  decideConcept: (id: string, status: 'accepted' | 'rejected') => api.patch<{ ok: true }>(`/questions/concepts/${enc(id)}`, { status }),
};
