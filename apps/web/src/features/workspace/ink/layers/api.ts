// Server reads and actions of the layers panel that need the network (Academic OS P1-T2 step 2): a layer's history
// («سجل الطبقة», read-only) and «انسخ الطبقة» (preview first, then the copy). Creating, renaming, hiding and locking
// layers never wait for the network (./repo.ts, through the outbox).
import type { CopyLayersRequest, CopyLayersResponse, LayerHistoryPage } from '@medlevo/shared';
import { api } from '../../../../lib/api';
import { getSyncEngine } from '../../../../lib/sync';

export function fetchLayerHistory(layerId: string, opts: { documentKey: string; before?: string | null; limit?: number; signal?: AbortSignal }): Promise<LayerHistoryPage> {
  return api.get<LayerHistoryPage>(`/annotations/layers/${encodeURIComponent(layerId)}/history`, {
    query: { document_key: opts.documentKey, ...(opts.before ? { before: opts.before } : {}), limit: opts.limit ?? 50 },
    signal: opts.signal,
    timeoutMs: 20_000,
  });
}

/** Preview (`preview: true`, nothing written) or run a layer copy; after a copy the new items reach this device by sync. */
export async function copyLayer(req: CopyLayersRequest): Promise<CopyLayersResponse> {
  const res = await api.post<CopyLayersResponse>('/annotations/layers/copy', req, { timeoutMs: 120_000 });
  if (!req.preview) void getSyncEngine().syncNow({ pull: true });
  return res;
}

export const COPY_KIND_LABELS_AR: Record<string, string> = {
  ink: 'كتابة بالقلم',
  shape: 'أشكال',
  highlight: 'تظليل حر',
  text_highlight: 'تظليل نص',
  text: 'نصوص',
  sticky: 'ملصقات',
  image: 'صور',
  link: 'روابط',
  bookmark: 'علامات',
  note: 'ملاحظات',
};
