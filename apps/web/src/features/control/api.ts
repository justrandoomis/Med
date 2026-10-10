// Server calls of the Personal Control Center (shapes in packages/shared/src/control-api.ts).
import type {
  CapabilitiesResponse,
  ControlOverviewResponse,
  HistoryResponse,
  ImpactApplyResponse,
  ImpactChange,
  ImpactPreviewResponse,
  IntelligenceResponse,
  JobView,
  ProcessingOverviewResponse,
  ProcessingToolsStatusResponse,
  ResolveReviewRequest,
  ResolveReviewResponse,
  ReviewItemDetail,
  ReviewQueueKind,
  ReviewQueueListResponse,
  SourceDetail,
  SourcesPrioritiesResponse,
  StorageResponse,
} from '@medlevo/shared';
import { api } from '../../lib/api';

const enc = encodeURIComponent;
const T = { timeoutMs: 30_000 };

export interface ReviewFilter {
  status: 'open' | 'resolved' | 'all';
  kind?: ReviewQueueKind | '';
  source_id?: string;
  cursor?: string | null;
}

export const controlApi = {
  overview: () => api.get<ControlOverviewResponse>('/control/overview', T),
  review: (f: ReviewFilter) =>
    api.get<ReviewQueueListResponse>('/control/review', { ...T, query: { status: f.status, kind: f.kind || undefined, source_id: f.source_id || undefined, cursor: f.cursor ?? undefined, limit: 50 } }),
  reviewItem: (id: string) => api.get<ReviewItemDetail>(`/control/review/${enc(id)}`, T),
  resolve: (id: string, body: ResolveReviewRequest) => api.post<ResolveReviewResponse>(`/control/review/${enc(id)}/resolve`, body, T),
  processing: () => api.get<ProcessingOverviewResponse>('/control/processing', T),
  tools: () => api.get<ProcessingToolsStatusResponse>('/processing/status', T),
  retryJob: (id: string) => api.post<JobView>(`/jobs/${enc(id)}/retry`, {}, T),
  cancelJob: (id: string) => api.post<JobView>(`/jobs/${enc(id)}/cancel`, {}, T),
  reprocessPages: (versionId: string, pageIndexes: number[]) => api.post<{ job: JobView }>(`/sources/versions/${enc(versionId)}/reprocess`, { page_indexes: pageIndexes }, T),
  intelligence: () => api.get<IntelligenceResponse>('/control/intelligence', T),
  preview: (change: ImpactChange) => api.post<ImpactPreviewResponse>('/control/impact/preview', { change }, T),
  apply: (change: ImpactChange, confirm_token: string) => api.post<ImpactApplyResponse>('/control/impact/apply', { change, confirm_token }, T),
  sources: () => api.get<SourcesPrioritiesResponse>('/control/sources', T),
  patchSource: (id: string, body: { priority?: number; selection_reason?: string | null }) => api.patch<SourceDetail>(`/sources/${enc(id)}`, body, T),
  storage: () => api.get<StorageResponse>('/control/storage', T),
  history: (q: { entity_type?: string; before?: string | null }) =>
    api.get<HistoryResponse>('/control/history', { ...T, query: { entity_type: q.entity_type || undefined, before: q.before ?? undefined, limit: 50 } }),
  capabilities: () => api.get<CapabilitiesResponse>('/capabilities', T),
};
