// Media server calls (/api/media): audio + transcripts + links, image explorer + overlays, image quiz, AC-09 matcher.
import type {
  AudioAssetView,
  AudioListResponse,
  ImageDetailView,
  ImageListResponse,
  ImageMatchResponse,
  ImageQuizAnswerResponse,
  ImageQuizFinishResponse,
  ImageQuizView,
  ImageRequest,
  MediaLinkView,
  MediaStatusResponse,
  OverlayShape,
  OverlayView,
  RecordingView,
  SegmentRevisionView,
  SourcePagesResponse,
  TranscriptImportResponse,
  TranscriptResponse,
  TranscriptSegmentView,
} from '@medlevo/shared';
import { api } from '../../lib/api';

const enc = encodeURIComponent;

export const mediaApi = {
  /** (track F4) in-app recordings of / linked to a source, with the strokes written while recording */
  recordings: (sourceId: string) => api.get<{ recordings: RecordingView[] }>('/media/recordings', { query: { source_id: sourceId } }).then((r) => r.recordings),
  status: () => api.get<MediaStatusResponse>('/media/status'),
  // audio
  audio: () => api.get<AudioListResponse>('/media/audio'),
  reportDuration: (id: string, duration_ms: number) => api.patch<AudioAssetView>(`/media/audio/${enc(id)}`, { duration_ms }),
  transcript: (id: string, includeDeleted = false) => api.get<TranscriptResponse>(`/media/audio/${enc(id)}/transcript`, { query: { include_deleted: includeDeleted ? '1' : undefined } }),
  addSegment: (id: string, body: { start_ms: number; end_ms: number; text: string }) => api.post<TranscriptSegmentView>(`/media/audio/${enc(id)}/segments`, body),
  importSubtitles: (id: string, body: { text: string; file_name?: string | null; format?: 'vtt' | 'srt' | 'auto'; replace_previous_import?: boolean }) =>
    api.post<TranscriptImportResponse>(`/media/audio/${enc(id)}/import`, body, { timeoutMs: 120_000 }),
  patchSegment: (id: string, body: { base_rev: number; corrected_text?: string | null; start_ms?: number; end_ms?: number }) => api.patch<TranscriptSegmentView>(`/media/segments/${enc(id)}`, body),
  deleteSegment: (id: string, baseRev: number) => api.del<TranscriptSegmentView>(`/media/segments/${enc(id)}?base_rev=${baseRev}`),
  restoreSegment: (id: string) => api.post<TranscriptSegmentView>(`/media/segments/${enc(id)}/restore`, {}),
  revisions: (id: string) => api.get<{ revisions: SegmentRevisionView[] }>(`/media/segments/${enc(id)}/revisions`),
  link: (segmentId: string, body: { page_id?: string; region_id?: string }) => api.post<MediaLinkView>(`/media/segments/${enc(segmentId)}/links`, body),
  unlink: (linkId: string) => api.del<{ ok: true }>(`/media/links/${enc(linkId)}`),
  confirmLink: (linkId: string) => api.post<MediaLinkView>(`/media/links/${enc(linkId)}/confirm`, {}),
  pages: (sourceId: string, versionId: string) => api.get<SourcePagesResponse>(`/sources/${enc(sourceId)}/versions/${enc(versionId)}/pages`),
  // images
  images: (q: { kind?: string; origin?: string; source_id?: string; q?: string; cursor?: string | null } = {}) =>
    api.get<ImageListResponse>('/media/images', { query: { kind: q.kind || undefined, origin: q.origin || undefined, source_id: q.source_id || undefined, q: q.q || undefined, cursor: q.cursor ?? undefined } }),
  image: (id: string) => api.get<ImageDetailView>(`/media/images/${enc(id)}`),
  patchMeta: (id: string, body: Record<string, unknown>) => api.patch<ImageDetailView>(`/media/images/${enc(id)}/meta`, body),
  addOverlay: (imageId: string, body: { kind: string; shape: OverlayShape; label?: string | null; aliases?: string[]; certainty?: string; note?: string | null }) =>
    api.post<OverlayView>(`/media/images/${enc(imageId)}/overlays`, body),
  patchOverlay: (id: string, body: Record<string, unknown> & { base_rev: number }) => api.patch<OverlayView>(`/media/overlays/${enc(id)}`, body),
  deleteOverlay: (id: string) => api.del<{ ok: true }>(`/media/overlays/${enc(id)}`),
  match: (request: ImageRequest) => api.post<ImageMatchResponse>('/media/images/match', { request }),
  // quiz
  createQuiz: (image_id: string, overlay_ids?: string[]) => api.post<ImageQuizView>('/media/quiz', { image_id, ...(overlay_ids?.length ? { overlay_ids } : {}) }),
  quiz: (id: string) => api.get<ImageQuizView>(`/media/quiz/${enc(id)}`),
  answer: (id: string, body: { key: string; answer: string; self_mark_correct?: boolean }) => api.post<ImageQuizAnswerResponse>(`/media/quiz/${enc(id)}/answer`, body),
  finishQuiz: (id: string) => api.post<ImageQuizFinishResponse>(`/media/quiz/${enc(id)}/finish`, {}),
};
