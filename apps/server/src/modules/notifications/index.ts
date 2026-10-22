// Notifications (/api/notifications; ARCHITECTURE_DELTA §7.12, §12; P1-T4 step 2). The signed-in user's OWN inbox and
// preferences — every query is keyed by the session's user, so no route takes another person's id.
//
//   GET  /                → NotificationsResponse  (?cursor=&limit=&unread=; newest first; only rows the reader may still open)
//   POST /read            {ids} | {all: true} → MarkNotificationsReadResponse (another user's id changes nothing)
//   GET  /prefs           → NotificationPrefsResponse (in-app per kind; push not offered on this server, with the reason)
//   PUT  /prefs           PutNotificationPrefsRequest → NotificationPrefsResponse (push on → 409 FEATURE_DISABLED)
//
// The Web Push subscription routes of the contract are NOT mounted: this server has no VAPID keys and nothing has been
// measured on a device, so a subscription would be a switch that does nothing (AOS-23.3). The fan-out worker starts with
// the server and stops with it; pending fan-outs left by a restart resume at boot.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { markNotificationsReadSchema, notificationsQuerySchema, putNotificationPrefsSchema } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseQuery } from '../../lib/http';
import type { Viewer } from '../../system/binding';
import { registerAccountDeletionParticipant } from '../accounts/deletion';
import { notificationsOf } from './service';

function viewerOf(req: FastifyRequest): Viewer {
  if (!req.viewer) throw new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401);
  return req.viewer;
}

export default async function notificationsModule(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  const svc = notificationsOf(ctx);
  registerAccountDeletionParticipant(ctx, { name: 'notifications', run: (_ctx, who) => svc.forgetUser(who.userId) });
  app.addHook('onReady', async () => svc.fanout.start());
  app.addHook('onClose', async () => svc.fanout.stop());

  app.get('/', async (req) => svc.inbox(viewerOf(req), parseQuery(notificationsQuerySchema, req)));

  app.post('/read', async (req) => svc.markRead(viewerOf(req), parseBody(markNotificationsReadSchema, req)));

  app.get('/prefs', async (req) => svc.prefs(viewerOf(req)));

  app.put('/prefs', async (req) => svc.putPrefs(viewerOf(req), parseBody(putNotificationPrefsSchema, req)));
}
