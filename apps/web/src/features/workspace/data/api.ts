// Server reads used by the workspace. Shapes come from @medlevo/shared (sources.ts / workspace.ts);
// the library/sources/processing tracks implement those endpoints.
import type {
  LatestSessionResponse,
  NeedsReanchorResponse,
  NotesResponse,
  PageRegionsResponse,
  ReadingProgressView,
  RecentSessionsResponse,
  SourceAnnotationsResponse,
  SourceDetail,
  SourcePagesResponse,
} from '@medlevo/shared';
import { api } from '../../../lib/api';

export const fileUrl = (fileId: string) => `/api/files/${encodeURIComponent(fileId)}`;

export function fetchSource(sourceId: string, signal?: AbortSignal): Promise<SourceDetail> {
  return api.get<SourceDetail>(`/sources/${encodeURIComponent(sourceId)}`, { signal, timeoutMs: 30_000 });
}

export function fetchPages(sourceId: string, versionId: string, signal?: AbortSignal): Promise<SourcePagesResponse> {
  return api.get<SourcePagesResponse>(`/sources/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(versionId)}/pages`, { signal, timeoutMs: 30_000 });
}

const regionCache = new Map<string, Promise<PageRegionsResponse>>();

/** Regions of one page (cached for the app session; a failed request is not cached). */
export function fetchRegions(pageId: string): Promise<PageRegionsResponse> {
  let p = regionCache.get(pageId);
  if (!p) {
    p = api.get<PageRegionsResponse>(`/sources/pages/${encodeURIComponent(pageId)}/regions`, { timeoutMs: 30_000 });
    regionCache.set(pageId, p);
    p.catch(() => regionCache.delete(pageId));
  }
  return p;
}

export function clearRegionCache(): void {
  regionCache.clear();
}

export function fetchSourceAnnotations(sourceId: string, versionId: string): Promise<SourceAnnotationsResponse> {
  return api.get<SourceAnnotationsResponse>(`/annotations/source/${encodeURIComponent(sourceId)}`, { query: { version_id: versionId }, timeoutMs: 30_000, skipAuthRedirect: true });
}

export function fetchNotes(sourceId: string): Promise<NotesResponse> {
  return api.get<NotesResponse>('/annotations/notes', { query: { source_id: sourceId }, timeoutMs: 30_000, skipAuthRedirect: true });
}

export function fetchNeedsReanchor(sourceId: string): Promise<NeedsReanchorResponse> {
  return api.get<NeedsReanchorResponse>('/annotations/needs-reanchor', { query: { source_id: sourceId }, timeoutMs: 30_000, skipAuthRedirect: true });
}

export function fetchLatestSession(sourceId: string, timeoutMs = 4000): Promise<LatestSessionResponse> {
  return api.get<LatestSessionResponse>('/annotations/sessions/latest', { query: { source_id: sourceId }, timeoutMs, skipAuthRedirect: true });
}

export function fetchRecentSessions(limit = 8): Promise<RecentSessionsResponse> {
  return api.get<RecentSessionsResponse>('/annotations/sessions/recent', { query: { limit }, timeoutMs: 15_000, skipAuthRedirect: true });
}

export function postProgress(sourceId: string, versionId: string, pageIndexes: number[]): Promise<ReadingProgressView> {
  return api.post<ReadingProgressView>('/annotations/progress', { source_id: sourceId, version_id: versionId, page_indexes: pageIndexes }, { timeoutMs: 15_000, skipAuthRedirect: true });
}

export function fetchProgress(sourceId: string): Promise<ReadingProgressView> {
  return api.get<ReadingProgressView>(`/annotations/progress/${encodeURIComponent(sourceId)}`, { timeoutMs: 15_000, skipAuthRedirect: true });
}

/** Tells the library the source was opened (last_opened_at). Best effort. */
export function markOpened(sourceId: string): void {
  void api.post(`/sources/${encodeURIComponent(sourceId)}/open`, undefined, { skipAuthRedirect: true, timeoutMs: 10_000 }).catch(() => undefined);
}
