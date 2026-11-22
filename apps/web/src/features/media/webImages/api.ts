// Client API of the web reference images («صور من الويب»). Other screens (e.g. the AI chat / explanations) embed
// `<WebImageStrip query=… />` or call `searchWebImages(query)` — every result carries its attribution and must be
// shown with it and with WEB_IMAGE_LABEL_AR («صورة من الويب — ليست من محاضرتك»).
import type { FigureDescriptionContent, FigureImageType, WebImagePinRequest, WebImageProvider, WebImageRefListResponse, WebImageRefView, WebImageResult, WebImageSearchResponse, WebImageStatusResponse } from '@medlevo/shared';
import { api } from '../../../lib/api';

const BASE = '/media/web-images';

export function searchWebImages(query: string, opts: { providers?: WebImageProvider[]; limit?: number; signal?: AbortSignal } = {}): Promise<WebImageSearchResponse> {
  const body: { query: string; providers?: WebImageProvider[]; limit?: number } = { query };
  if (opts.providers) body.providers = opts.providers;
  if (opts.limit) body.limit = opts.limit;
  return api.post<WebImageSearchResponse>(`${BASE}/search`, body, { timeoutMs: 30_000, signal: opts.signal });
}

export const webImagesApi = {
  status: () => api.get<WebImageStatusResponse>(`${BASE}/status`),
  search: searchWebImages,
  refs: (sourceId?: string) => api.get<WebImageRefListResponse>(`${BASE}/refs${sourceId ? `?source_id=${encodeURIComponent(sourceId)}` : ''}`),
  pin: (result: WebImageResult, ctx: Omit<WebImagePinRequest, 'result'> = {}) => api.post<{ item: WebImageRefView }>(`${BASE}/refs`, { result, ...ctx }),
  unpin: (id: string) => api.del<{ ok: true }>(`${BASE}/refs/${encodeURIComponent(id)}`),
};

const IMAGE_TYPE_EN: Record<FigureImageType, string> = {
  histology: 'histology',
  gross: 'gross pathology',
  radiology: 'radiograph',
  graph: '',
  diagram: 'diagram',
  clinical_photo: 'clinical',
  other: '',
};

/**
 * A search query from a figure's AI description (modules/processing/figures.ts: type / findings / diagnosis):
 * «Colorectal adenocarcinoma histology». The diagnosis first (even a suggestion — the results are references, not
 * answers), else the English caption shortened; the picture type as a hint. null when there is nothing to search.
 */
export function queryFromFigure(c: FigureDescriptionContent | null | undefined): string | null {
  if (!c) return null;
  const hint = IMAGE_TYPE_EN[c.image_type] ?? '';
  const main = c.diagnosis?.text?.trim() || c.caption_en.split(/\s+/).filter(Boolean).slice(0, 8).join(' ').replace(/[.,;:]+$/, '');
  if (!main) return null;
  const q = !hint || main.toLowerCase().includes(hint.split(' ')[0]!) ? main : `${main} ${hint}`;
  return q.slice(0, 200);
}
