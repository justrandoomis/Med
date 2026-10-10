// Client for /api/learning (contract: @medlevo/shared learning.ts + learning-api.ts, server track L1).
import type {
  CardCreateRequest,
  CardCreateResponse,
  CardDetailResponse,
  CardDuplicatesResponse,
  CardFromMistakeRequest,
  CardFromSelectionRequest,
  CardListResponse,
  CardMutationResponse,
  CardQueueResponse,
  CardReviewPayload,
  CardUpdateRequest,
  ExamDnaDetail,
  ExamRelevanceView,
  ForgettingForecastView,
  HomeDetail,
  LearningProfilePatch,
  LearningProfileView,
  MistakeGenomeView,
  MistakeType,
  OcclusionCreateRequest,
  PlanListResponse,
  PlanPreviewResponse,
  PlanRebalanceResponse,
  ProfileSignalPart,
  ReasoningReplayView,
  RevisionSessionDetail,
  RevisionSessionRequest,
  SourceProgressListResponse,
  SrsConfigView,
  StudyPlanConfig,
  StudyPlanView,
  WeaknessDetailView,
  WeaknessListResponse,
  WeaknessPatchRequest,
} from '@medlevo/shared';
import { api } from '../../lib/api';

const P = '/learning';
const e = encodeURIComponent;

export const learningApi = {
  srsConfig: () => api.get<SrsConfigView>(`${P}/srs-config`, { timeoutMs: 15_000, skipAuthRedirect: true }),
  // cards
  cards: (q: { source_id?: string; status?: 'active' | 'suspended' | 'needs_review' | 'deleted' | 'all'; q?: string; limit?: number; cursor?: string | null } = {}) =>
    api.get<CardListResponse>(`${P}/cards`, { query: { ...q, cursor: q.cursor ?? undefined }, timeoutMs: 30_000 }),
  card: (id: string) => api.get<CardDetailResponse>(`${P}/cards/${e(id)}`, { timeoutMs: 20_000 }),
  createCards: (body: CardCreateRequest) => api.post<CardCreateResponse>(`${P}/cards`, body, { timeoutMs: 30_000 }),
  fromSelection: (body: CardFromSelectionRequest) => api.post<CardCreateResponse>(`${P}/cards/from-selection`, body, { timeoutMs: 30_000 }),
  fromMistake: (body: CardFromMistakeRequest) => api.post<CardCreateResponse>(`${P}/cards/from-mistake`, body, { timeoutMs: 30_000 }),
  occlusion: (body: OcclusionCreateRequest) => api.post<CardCreateResponse>(`${P}/cards/occlusion`, body, { timeoutMs: 30_000 }),
  updateCard: (id: string, body: CardUpdateRequest) => api.patch<{ card: CardMutationResponse['card']; notes_ar: string[] }>(`${P}/cards/${e(id)}`, body, { timeoutMs: 30_000 }),
  deleteCard: (id: string) => api.del<CardMutationResponse>(`${P}/cards/${e(id)}`, { timeoutMs: 20_000 }),
  restoreCard: (id: string) => api.post<CardMutationResponse>(`${P}/cards/${e(id)}/restore`, {}, { timeoutMs: 20_000 }),
  resolveImpact: (id: string, resolution: 'keep' | 'relearn' | 'move_to_current_version') =>
    api.post<CardMutationResponse>(`${P}/cards/${e(id)}/impact/resolve`, { resolution }, { timeoutMs: 20_000 }),
  reviewPayload: (id: string) => api.get<CardReviewPayload>(`${P}/cards/${e(id)}/review`, { timeoutMs: 20_000 }),
  duplicates: () => api.get<CardDuplicatesResponse>(`${P}/cards/duplicates`, { timeoutMs: 30_000 }),
  decideDuplicate: (body: { card_a_id: string; card_b_id: string; decision: 'not_duplicate' | 'merge'; keep_id?: string | null }) =>
    api.post<{ kept: CardMutationResponse['card'] | null }>(`${P}/cards/duplicates/decide`, body, { timeoutMs: 20_000 }),
  queue: (limit = 0) => api.get<CardQueueResponse>(`${P}/review/queue`, { query: { limit }, timeoutMs: 20_000 }),
  forecast: (sourceId?: string | null) => api.get<ForgettingForecastView>(`${P}/forecast`, { query: { source_id: sourceId ?? undefined, days: '1,7,30' }, timeoutMs: 30_000 }),
  ankiExportUrl: (opts: { source_id?: string; include_suspended?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.source_id) q.set('source_id', opts.source_id);
    if (opts.include_suspended) q.set('include_suspended', 'true');
    const s = q.toString();
    return `/api${P}/export/anki${s ? `?${s}` : ''}`;
  },
  // weakness & mistakes
  weaknesses: (status: 'open' | 'active' | 'improving' | 'resolved' | 'dismissed' | 'all' = 'open') => api.get<WeaknessListResponse>(`${P}/weakness`, { query: { status }, timeoutMs: 30_000 }),
  weakness: (id: string) => api.get<WeaknessDetailView>(`${P}/weakness/${e(id)}`, { timeoutMs: 20_000 }),
  patchWeakness: (id: string, body: WeaknessPatchRequest) => api.patch<WeaknessDetailView>(`${P}/weakness/${e(id)}`, body, { timeoutMs: 20_000 }),
  weaknessRevision: (id: string, minutes: number) => api.post<RevisionSessionDetail>(`${P}/weakness/${e(id)}/revision`, { minutes }, { timeoutMs: 30_000 }),
  genome: () => api.get<MistakeGenomeView>(`${P}/mistakes/genome`, { timeoutMs: 30_000 }),
  setMistakeType: (attemptId: string, mistake_type: MistakeType | null) => api.patch<{ attempt: unknown }>(`${P}/mistakes/${e(attemptId)}`, { mistake_type }, { timeoutMs: 20_000 }),
  replay: (questionId: string, attemptId?: string | null) => api.get<ReasoningReplayView>(`${P}/reasoning/${e(questionId)}`, { query: { attempt_id: attemptId ?? undefined }, timeoutMs: 20_000 }),
  // profile
  profile: () => api.get<LearningProfileView>(`${P}/profile`, { timeoutMs: 20_000 }),
  patchProfile: (body: LearningProfilePatch) => api.patch<LearningProfileView>(`${P}/profile`, body, { timeoutMs: 20_000 }),
  resetProfilePart: (part: ProfileSignalPart) => api.post<LearningProfileView>(`${P}/profile/reset`, { part }, { timeoutMs: 20_000 }),
  // planner
  plans: () => api.get<PlanListResponse>(`${P}/plans`, { timeoutMs: 20_000 }),
  plan: (id: string) => api.get<StudyPlanView>(`${P}/plans/${e(id)}`, { timeoutMs: 30_000 }),
  previewPlan: (config: StudyPlanConfig) => api.post<PlanPreviewResponse>(`${P}/plans/preview`, config, { timeoutMs: 30_000 }),
  createPlan: (config: StudyPlanConfig) => api.post<StudyPlanView>(`${P}/plans`, config, { timeoutMs: 30_000 }),
  rebalance: (id: string) => api.post<PlanRebalanceResponse>(`${P}/plans/${e(id)}/rebalance`, {}, { timeoutMs: 30_000 }),
  setTask: (planId: string, taskId: string, status: 'todo' | 'done' | 'skipped') => api.patch<StudyPlanView>(`${P}/plans/${e(planId)}/tasks/${e(taskId)}`, { status }, { timeoutMs: 20_000 }),
  archivePlan: (id: string) => api.post<StudyPlanView>(`${P}/plans/${e(id)}/archive`, {}, { timeoutMs: 20_000 }),
  // revision, home, Exam DNA, progress
  revision: (body: RevisionSessionRequest) => api.post<RevisionSessionDetail>(`${P}/revision`, body, { timeoutMs: 30_000 }),
  revisionById: (id: string) => api.get<RevisionSessionDetail>(`${P}/revision/${e(id)}`, { timeoutMs: 20_000 }),
  home: () => api.get<HomeDetail>(`${P}/home`, { timeoutMs: 30_000 }),
  examDna: (q: { course_node_id?: string | null; source_ids?: string[] } = {}) =>
    api.get<ExamDnaDetail>(`${P}/exam-dna`, { query: { course_node_id: q.course_node_id ?? undefined, source_ids: q.source_ids?.length ? q.source_ids.join(',') : undefined }, timeoutMs: 30_000 }),
  relevance: (q: { question_id?: string; concept_id?: string }) => api.get<ExamRelevanceView>(`${P}/exam-dna/relevance`, { query: q, timeoutMs: 20_000 }),
  progress: (courseNodeId?: string | null) => api.get<SourceProgressListResponse>(`${P}/progress`, { query: { course_node_id: courseNodeId ?? undefined }, timeoutMs: 30_000 }),
};

/** Path keys used with the cached GET hook (the last good answer stays viewable offline, read-only). */
export const LEARNING_PATHS = {
  home: `${P}/home`,
  weakness: (status = 'open') => `${P}/weakness?status=${status}`,
  genome: `${P}/mistakes/genome`,
  forecast: `${P}/forecast?days=1,7,30`,
  plans: `${P}/plans`,
  plan: (id: string) => `${P}/plans/${e(id)}`,
  profile: `${P}/profile`,
  dna: `${P}/exam-dna`,
  queue: `${P}/review/queue?limit=0`,
} as const;
