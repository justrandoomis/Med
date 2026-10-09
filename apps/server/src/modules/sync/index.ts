// Sync API.
//   POST /api/sync/push { ops: SyncOp[] }  → per-op results (idempotent by op_id)
//   GET  /api/sync/pull?since=&limit=      → change feed page
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SYNC_OPS, type SyncPullResponse, type SyncPushResponse } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { parseBody, parseQuery, RATE_LIMITS } from '../../lib/http';
import { MAX_PULL_LIMIT, MAX_PUSH_OPS } from './registry';

export { SyncRegistry, type SyncEntityHandler, type SyncApplyResult, type SyncTx, MAX_PUSH_OPS, MAX_PULL_LIMIT } from './registry';

export const SYNC_NO_ENTITY_TYPES_AR =
  'محرك المزامنة جاهز على الخادم، لكن لم يُفعَّل بعدُ أي نوع من البيانات للمزامنة في هذا الإصدار. تبقى كتاباتك محفوظة على هذا الجهاز وتنتظر المزامنة.';

const idString = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const syncOpSchema = z.object({
  op_id: idString,
  device_id: idString,
  entity_type: z.string().min(2).max(64).regex(/^[a-z][a-z0-9_]*$/),
  entity_id: idString,
  op: z.enum(SYNC_OPS),
  base_rev: z.number().int().min(0).nullable().optional(),
  payload: z.unknown(),
  client_ts: z.number().int().min(0).optional(),
});

const pushBody = z.object({ ops: z.array(syncOpSchema).min(1).max(MAX_PUSH_OPS) });
const pullQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).default(200),
});

export default async function syncModule(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { ctx } = opts;
  // The generic engine is live, but nothing can actually sync until an owning module registers an
  // entity type (annotation, note, flashcard, …). Report that honestly instead of 'available'.
  const reflectCapability = (types: string[]) => {
    if (types.length > 0) ctx.capabilities.set('sync', 'available');
    else ctx.capabilities.set('sync', 'not_implemented', SYNC_NO_ENTITY_TYPES_AR);
  };
  reflectCapability(ctx.sync.registeredTypes());
  ctx.sync.onRegister(reflectCapability);

  app.post('/push', { config: { rateLimit: RATE_LIMITS.sync } }, async (req): Promise<SyncPushResponse> => {
    const body = parseBody(pushBody, req);
    const res = ctx.sync.push(body.ops.map((o) => ({ ...o, payload: o.payload ?? null })));
    // remember which device this session syncs from (sessions list shows it)
    const deviceId = body.ops[0]?.device_id;
    if (deviceId && req.auth?.sessionId) {
      ctx.db.run('UPDATE auth_session SET device_id = COALESCE(device_id, ?) WHERE id = ?', [deviceId, req.auth.sessionId]);
    }
    return res;
  });

  app.get('/pull', async (req): Promise<SyncPullResponse> => {
    const q = parseQuery(pullQuery, req);
    return ctx.sync.pull(q.since, q.limit);
  });
}
