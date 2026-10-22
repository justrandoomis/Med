// Helpers of the P1-T4 notification tests: read a person's inbox through the real route (the guard, the binding, the
// policy) after the fan-out queue has been drained synchronously.
import type { NotificationsResponse, NotificationView } from '@medlevo/shared';
import { notificationsOf } from '../../src/modules/notifications/service';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { call, ok } from '../channels/helpers';

/** Run every due fan-out batch now (the worker would do the same a moment later in the background). */
export function drain(t: TestApp): number {
  return notificationsOf(t.ctx).fanout.drain();
}

export async function inbox(t: TestApp, h: AuthHeaders, query = ''): Promise<NotificationsResponse> {
  drain(t);
  return ok<NotificationsResponse>(await call(t, h, 'GET', `/api/notifications${query}`));
}

export async function items(t: TestApp, h: AuthHeaders, kind?: NotificationView['kind']): Promise<NotificationView[]> {
  const all: NotificationView[] = [];
  let cursor: string | null = null;
  do {
    const page: NotificationsResponse = await inbox(t, h, `?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    all.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return kind ? all.filter((n) => n.kind === kind) : all;
}

/** Rows of the system notification table for a user (what is stored, whatever the inbox shows). */
export function storedRows(t: TestApp, userId: string): Array<{ kind: string; payload_json: string; dedupe_key: string | null }> {
  return t.ctx.system.db.all('SELECT kind, payload_json, dedupe_key FROM notification WHERE user_id = ? ORDER BY created_at, id', [userId]);
}
