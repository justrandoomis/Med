// Moderation (/api/moderation) and the scoped audit view (/api/admin) — P1-T4 step 2; ARCHITECTURE_DELTA §7.12, §13.
//
//   POST /api/moderation/reports   CreateReportRequest → ReportView         any member who can see the content (404
//                                                                          otherwise); one open report per target;
//                                                                          20 an hour per account
//   GET  /api/moderation/queue     ?scope_node_id=&status=&cursor=&limit=   → ReportQueueResponse (moderators of the scope
//                                                                          or above; anyone else: the 404 of a missing route)
//   POST /api/moderation/actions   ModerationActionRequest → ModerationActionView (hide / restore / dismiss with an Arabic
//                                                                          reason; `moderate` on the content's subject)
//   GET  /api/admin/audit          ?scope_node_id=&action=&cursor=&limit=   → SecurityAuditResponse (Admin / Assistant of
//                                                                          the scope or above, platform admin; 403 otherwise)
// System routes: each one decides through the ONE policy; the reported content is reached only through the target
// registry its owner track fills (targets.ts — P1-T5 step 3 registers publications).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditQuerySchema, createReportSchema, moderationActionSchema, reportQueueQuerySchema } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseQuery } from '../../lib/http';
import type { Viewer } from '../../system/binding';
import { moderationOf, scopedAudit } from './service';

function viewerOf(req: FastifyRequest): Viewer {
  if (!req.viewer) throw new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401);
  return req.viewer;
}

/** Mounted at /api/moderation. */
export default async function moderationModule(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  const svc = moderationOf(ctx);

  // a coarse per-address ceiling on top of the per-account limit of the service (a whole hall behind one NAT stays far below it)
  app.post('/reports', { config: { rateLimit: { max: 120, timeWindow: 60_000 } } }, async (req) => svc.createReport(viewerOf(req), parseBody(createReportSchema, req)));

  app.get('/queue', async (req) => svc.queue(viewerOf(req), parseQuery(reportQueueQuerySchema, req)));

  app.post('/actions', async (req) => svc.act(viewerOf(req), parseBody(moderationActionSchema, req), req.ip ?? null));
}

/** Mounted at /api/admin: the channel administration area's server routes (Phase 1: the scoped audit view). */
export async function adminAuditModule(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  app.get('/audit', async (req) => scopedAudit(ctx, viewerOf(req), parseQuery(auditQuerySchema, req)));
}
