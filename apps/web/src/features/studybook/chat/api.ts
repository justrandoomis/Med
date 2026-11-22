// HTTP client of the study chat (saved conversations, model/effort preferences, streamed answers). Conversations live on
// the server (each user's own vault): they survive a reload and appear on the owner's other devices; answering needs
// the server (AI + evidence check), so nothing here is queued offline.
import type {
  ChatMessageCreateBody,
  ChatPostResponse,
  ChatPrefs,
  ChatPrefsResponse,
  ChatStreamEvent,
  ChatThreadCreateBody,
  ChatThreadResponse,
  ChatThreadsResponse,
  ChatThreadView,
} from '@medlevo/shared';
import { api } from '../../../lib/api';
import { postStudyStream } from '../streaming';

const T = 30_000;
const enc = encodeURIComponent;

export const chatApi = {
  prefs: () => api.get<ChatPrefsResponse>('/studybook/chat/prefs', { timeoutMs: T }),
  savePrefs: (patch: Partial<ChatPrefs>) => api.put<ChatPrefsResponse>('/studybook/chat/prefs', patch, { timeoutMs: T }),
  list: (q: { source_id?: string | null; q?: string | null; limit?: number } = {}) =>
    api.get<ChatThreadsResponse>('/studybook/threads', { query: { source_id: q.source_id ?? undefined, q: q.q?.trim() || undefined, limit: q.limit ?? 100 }, timeoutMs: T }),
  thread: (id: string) => api.get<ChatThreadResponse>(`/studybook/threads/${enc(id)}`, { timeoutMs: T }),
  create: (body: ChatThreadCreateBody) => api.post<ChatThreadResponse>('/studybook/threads', body, { timeoutMs: T }),
  rename: (id: string, title: string) => api.patch<{ thread: ChatThreadView }>(`/studybook/threads/${enc(id)}`, { title }, { timeoutMs: T }),
  remove: (id: string) => api.del<{ deleted: true }>(`/studybook/threads/${enc(id)}`, { timeoutMs: T }),
  send: (threadId: string, body: ChatMessageCreateBody, opts: { signal?: AbortSignal; onEvent?: (e: ChatStreamEvent) => void }) =>
    postStudyStream<ChatPostResponse>(`/studybook/threads/${enc(threadId)}/messages/stream`, body, opts),
};
