// Handwriting recognition API (track F4): /api/annotations/recognitions + /api/annotations/ask-context.
import type {
  AskContextRequest,
  AskContextResponse,
  InkRecognitionView,
  RecognitionCreateRequest,
  RecognitionListResponse,
  RecognitionResponse,
} from '@medlevo/shared';
import { api } from '../../../lib/api';

export const recognitionApi = {
  create: (req: RecognitionCreateRequest) => api.post<RecognitionResponse>('/annotations/recognitions', req, { timeoutMs: 60_000 }).then((r) => r.recognition),
  get: (id: string, signal?: AbortSignal) => api.get<RecognitionResponse>(`/annotations/recognitions/${encodeURIComponent(id)}`, { signal }).then((r) => r.recognition),
  list: (q: { page_id?: string; note_page_id?: string; source_id?: string; question_id?: string }) =>
    api.get<RecognitionListResponse>('/annotations/recognitions', { query: q }).then((r) => r.recognitions),
  correct: (id: string, corrected_text: string | null) => api.patch<RecognitionResponse>(`/annotations/recognitions/${encodeURIComponent(id)}`, { corrected_text }).then((r) => r.recognition),
  retry: (id: string) => api.post<RecognitionResponse>(`/annotations/recognitions/${encodeURIComponent(id)}/retry`, {}).then((r) => r.recognition),
  remove: (id: string) => api.del<{ ok: true }>(`/annotations/recognitions/${encodeURIComponent(id)}`),
  askContext: (req: AskContextRequest) => api.post<AskContextResponse>('/annotations/ask-context', req),
};

export function isSettled(r: InkRecognitionView): boolean {
  return r.status === 'recognized' || r.status === 'unreadable' || r.status === 'failed';
}

export const WAIT_TIMEOUT_AR = 'ما زالت القراءة جارية على الخادم. أغلق النافذة وارجع إليها لاحقًا: حدّد الكتابة نفسها بأداة التحديد الحر ثم «تحويل إلى نص» لتجد النتيجة.';

/** Poll a reading until it is settled (recognized / unreadable / failed). */
export async function waitForRecognition(
  id: string,
  opts: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number; get?: (id: string, signal?: AbortSignal) => Promise<InkRecognitionView>; onUpdate?: (r: InkRecognitionView) => void } = {},
): Promise<InkRecognitionView> {
  const get = opts.get ?? recognitionApi.get;
  const interval = opts.intervalMs ?? 1200;
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const r = await get(id, opts.signal);
    opts.onUpdate?.(r);
    if (isSettled(r)) return r;
    if (Date.now() > deadline) throw new Error(WAIT_TIMEOUT_AR);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, interval);
      opts.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
}
