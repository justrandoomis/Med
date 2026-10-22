// Sync API.
//   POST /api/sync/push { ops: SyncOp[] }  → per-op results (idempotent by op_id)
//   GET  /api/sync/pull?since=&limit=      → change feed page
// (AOS-21.29) the actor of every op is the session's user; each op's device_id must be an active device of that user —
// a device id the account never saw is registered on its first push (it is this signed-in client), a revoked one is
// answered `rejected/device_unknown` (retryable, never recorded; the client re-sends from a new device id).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACCEPT_INK_HEADER, parseAcceptInk, SYNC_OPS, type SyncPullResponse, type SyncPushResponse } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseQuery, RATE_LIMITS } from '../../lib/http';
import { MAX_ACTIVE_DEVICES } from '../accounts';
import { isOldClient } from '../auth/clientGate';
import { currentEpoch } from '../data/epoch';
import { MAX_PULL_LIMIT, MAX_PUSH_OPS } from './registry';

export { SyncRegistry, type SyncEntityHandler, type SyncApplyResult, type SyncTx, type SerializeOptions, MAX_PUSH_OPS, MAX_PULL_LIMIT } from './registry';

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

// server_epoch (track D1, additive): the epoch the device last pulled from; a stale one is refused (see push)
const pushBody = z.object({ ops: z.array(syncOpSchema).min(1).max(MAX_PUSH_OPS), server_epoch: z.string().min(1).max(64).optional() });
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
    // (track D1) the server's data was restored since this device last pulled: refuse the whole push BEFORE anything
    // is applied. Its ops were built on revisions the restored data may not have (blind conflicts / duplicates); the
    // device resets its cursor, re-queues what the restored server lacks, then pushes again with the new epoch.
    if (body.server_epoch !== undefined) {
      const epoch = currentEpoch(ctx.db);
      if (epoch && epoch.id !== body.server_epoch) {
        throw new AppError(
          'CONFLICT',
          'استُعيدت بيانات الخادم من نسخة احتياطية منذ آخر مزامنة لهذا الجهاز. يحدّث الجهاز حالة المزامنة أولًا ثم يعيد إرسال تغييراته تلقائيًا؛ لم يُطبَّق شيء من هذا الطلب.',
          409,
          { server_epoch_changed: true, server_epoch: epoch.id },
        );
      }
    }
    // (P1-T2) `accept-ink: 2` → ink entities in the answer carry packed points; without it, today's v1 (old clients)
    // (R1-b) `legacyClient`: an R1-a app (no supported `x-medlevo-client`; only user #1 gets this far) — see
    // annotations/sync.ts for the edit it cannot make safely
    // (AOS-21.29) the device check, once per device id of the request, against the session user's devices
    const viewer = req.viewer;
    const allowed = new Map<string, boolean>();
    if (viewer) {
      for (const id of new Set(body.ops.map((o) => o.device_id))) {
        const row = ctx.system.devices.get(viewer, id);
        if (row) allowed.set(id, row.revoked_at === null);
        else if (ctx.system.devices.activeCount(viewer) < MAX_ACTIVE_DEVICES) {
          const { device, created } = ctx.system.devices.register(viewer, { device_id: id });
          // the same security-history entry as POST /api/accounts/me/devices («أجهزتي» lists it)
          if (created) ctx.system.securityAudit.record({ actorUserId: viewer.userId, actorRole: 'self', action: 'device_register', targetType: 'device', targetId: device.device_uid, summary: 'تسجيل جهاز جديد (أول مزامنة)', ip: req.ip ?? null });
          allowed.set(id, device.revoked_at === null);
        } else allowed.set(id, false);
      }
    }
    const res = ctx.sync.push(
      body.ops.map((o) => ({ ...o, payload: o.payload ?? null })),
      { inkFormat: parseAcceptInk(req.headers[ACCEPT_INK_HEADER]), ...(isOldClient(req) ? { legacyClient: true } : {}) },
      viewer ? { actorUserId: viewer.userId, deviceAllowed: (id) => allowed.get(id) === true } : {},
    );
    // remember which device this session syncs from (sessions list shows it)
    const deviceId = body.ops[0]?.device_id;
    if (deviceId && req.auth?.sessionId) {
      // sessions live in the system DB (P1-T1): only the caller's own session row
      ctx.system.sessions.rememberDevice(req.auth.user.id, req.auth.sessionId, deviceId);
    }
    return res;
  });

  app.get('/pull', async (req): Promise<SyncPullResponse> => {
    const q = parseQuery(pullQuery, req);
    const res = ctx.sync.pull(q.since, q.limit, { inkFormat: parseAcceptInk(req.headers[ACCEPT_INK_HEADER]) });
    // (track D1, additive) the server data epoch: a restore starts a new one and the client resets its cursor
    const epoch = currentEpoch(ctx.db);
    if (epoch) {
      res.server_epoch = epoch.id;
      res.epoch_base_seq = epoch.base_seq;
    }
    res.head_seq = ctx.sync.headSeq();
    return res;
  });
}
