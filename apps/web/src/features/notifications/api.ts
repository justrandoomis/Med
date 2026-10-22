// The in-app inbox «التنبيهات» (P1-T4; notifications-api.ts; IA §4.9). The server keeps only titles and counts in a
// notification and re-checks, when the inbox is read, that the viewer may still open its subject — a row the viewer
// lost access to disappears together with its count.
import type {
  MarkNotificationsReadResponse,
  NotificationPrefsResponse,
  NotificationsResponse,
  PutNotificationPrefsRequest,
} from '@medlevo/shared';
import { useSyncExternalStore } from 'react';
import { api } from '../../lib/api';

const T = { timeoutMs: 20_000 };

export const notificationsApi = {
  list: (q: { unread?: boolean; cursor?: string | null; limit?: number } = {}) =>
    api.get<NotificationsResponse>('/notifications', { ...T, query: { unread: q.unread ? 'true' : undefined, cursor: q.cursor ?? undefined, limit: q.limit ?? 30 } }),
  markRead: (body: { ids: string[] } | { all: true }) => api.post<MarkNotificationsReadResponse>('/notifications/read', body, T),
  prefs: () => api.get<NotificationPrefsResponse>('/notifications/prefs', T),
  putPrefs: (body: PutNotificationPrefsRequest) => api.put<NotificationPrefsResponse>('/notifications/prefs', body, T),
};

// ───────────── the unread count shown on the bell (one source for the bell and the inbox) ─────────────

let unread: number | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setUnreadCount(n: number | null): void {
  if (n === unread) return;
  unread = n;
  emit();
}

let inflight: Promise<void> | null = null;
/** Ask the server for the unread count (quietly: offline or an error keeps the last known value). */
export function refreshUnreadCount(): Promise<void> {
  if (inflight) return inflight;
  inflight = notificationsApi
    .list({ unread: true, limit: 1 })
    .then((r) => setUnreadCount(r.unread_count))
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useUnreadCount(): number | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => unread,
    () => null,
  );
}
