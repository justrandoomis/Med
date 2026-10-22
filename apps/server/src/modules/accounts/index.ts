// Accounts and devices (/api/accounts; ARCHITECTURE_DELTA §7.2, P1-T1 step 1). Every route acts on the signed-in
// user's OWN account through the viewer-taking system repositories — there is no route here that names another user.
//   GET    /api/accounts/me                          → MeResponse
//   GET    /api/accounts/me/devices                  → DevicesResponse
//   POST   /api/accounts/me/devices                  {device_id, label?, platform?} → DeviceView (server-issued device_uid;
//                                                     idempotent per (user, device_id))
//   DELETE /api/accounts/me/devices/:deviceId        revokes the device and its key
//   PUT    /api/accounts/me/devices/:deviceId/key    {public_key, alg: 'Ed25519'} → DeviceView
//   GET    /api/accounts/me/quota                    → QuotaView (P1-T1 step 2: storage + AI allowance of MY account)
//   GET/PUT /api/accounts/me/ai-consent              → AiConsentView (AOS-21.42: my ai_processing consent; ./consent.ts)
//   POST   /api/accounts/me/export                   → {job_id, export} «نسخة من بياناتي» (MY vault only; ./export.ts)
//   GET    /api/accounts/me/exports                  → AccountExportsResponse
//   GET    /api/accounts/me/exports/:jobId/download  → the archive (application/gzip)
//   POST   /api/accounts/me/delete                   {preview:true} → DeletionPreview · {confirm_token, password} → {status}
//                                                     (PRD Q14; ./deletion.ts)
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  accountDeleteSchema,
  type AccountDeleteResponse,
  type AccountExportsResponse,
  type AccountExportView,
  ACCOUNTS_LABELS_AR,
  type DeletionPreview,
  deviceIdSchema,
  deviceKeySchema,
  type DevicesResponse,
  type DeviceView,
  type MeResponse,
  type QuotaView,
  registerDeviceSchema,
} from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams } from '../../lib/http';
import type { Viewer } from '../../system/binding';
import type { DeviceRow } from '../../system/repos';
import { quotaViewFor } from './allowance';
import { registerAiConsentRoutes } from './consent';
import { registerSpaceQuotaWarnings } from './spaceQuota';
import { confirmDeletion, deletionPreview, finishPendingDeletions } from './deletion';
import { ACCOUNT_EXPORT_JOB, assertExportHasRoom, EXPORT_INCLUDED_AR, EXPORT_NOTE_AR, exportFile, exportView, listExports, registerAccountExport } from './export';

/** A cap on one account's active devices (a client cannot fill the device table). */
export const MAX_ACTIVE_DEVICES = 50;
const jobParams = z.object({ jobId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });

const deviceParams = z.object({ deviceId: deviceIdSchema });

function viewerOf(req: FastifyRequest): Viewer {
  if (!req.viewer) throw new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401);
  return req.viewer;
}

export function toDeviceView(d: DeviceRow, currentDeviceId: string | null): DeviceView {
  return {
    device_id: d.device_id,
    device_uid: d.device_uid,
    label: d.label,
    platform: d.platform,
    has_key: d.public_key !== null,
    shared_device: d.shared_device === 1,
    first_seen_at: d.first_seen_at,
    last_seen_at: d.last_seen_at,
    revoked_at: d.revoked_at,
    current: currentDeviceId !== null && d.device_id === currentDeviceId,
  };
}

export default async function accountsModule(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  const { devices, users, vaults, securityAudit } = ctx.system;
  registerAccountExport(ctx);
  // AOS-21.45: a subject crossing 80 % of its storage tells its moderators (./spaceQuota.ts)
  const stopSpaceWarnings = registerSpaceQuotaWarnings(ctx);
  app.addHook('onClose', async () => stopSpaceWarnings());
  // deletions a restart interrupted are finished at boot and every minute (a vault still in use is retried)
  app.addHook('onReady', async () => {
    await ctx.binding.runRoot(() => finishPendingDeletions(ctx)).catch((e: unknown) => ctx.log.warn({ err: e }, 'pending account deletions will be retried'));
  });
  let timer: NodeJS.Timeout | null = null;
  app.addHook('onListen', async () => {
    ctx.binding.runRoot(() => {
      timer = setInterval(() => void finishPendingDeletions(ctx).catch(() => undefined), 60_000);
      timer.unref();
    });
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });

  app.get('/me', async (req): Promise<MeResponse> => {
    const v = viewerOf(req);
    const me = users.me(v);
    const vault = vaults.ofViewer(v);
    if (!me || !vault) throw new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401);
    return {
      id: me.id,
      username: me.username,
      display_name: me.display_name,
      is_platform_admin: me.is_platform_admin === 1,
      owns_legacy_device_data: users.isUserOne(v),
      vault_id: vault.id,
      timezone: me.timezone,
      memberships: [],
      roles: [],
      quota: quotaViewFor(ctx, v),
      legacy_owner: me.legacy_owner === 1,
    };
  });

  // AOS-21.46: + the remaining allowance, why AI is refused now (if it is) and the subjects I moderate (./allowance.ts)
  app.get('/me/quota', async (req): Promise<QuotaView> => quotaViewFor(ctx, viewerOf(req)));

  // AOS-21.42: my ai_processing consent (./consent.ts)
  registerAiConsentRoutes(app, ctx);

  // ───────── «نسخة من بياناتي» (my vault only) ─────────
  app.post('/me/export', { config: { rateLimit: { max: 3, timeWindow: 10 * 60_000 } } }, async (req): Promise<{ job_id: string; export: AccountExportView }> => {
    const v = viewerOf(req);
    const busy = ctx.jobs.list({ kind: ACCOUNT_EXPORT_JOB, status: ['queued', 'running'], limit: 1 }).jobs[0];
    if (busy) throw new AppError('CONFLICT', ACCOUNTS_LABELS_AR.export_running, 409, { job_id: busy.id });
    // AOS-21.43: the kept archives count in my storage quota
    assertExportHasRoom(ctx, v);
    const job = ctx.jobs.enqueue(ACCOUNT_EXPORT_JOB, {}, { idempotencyKey: `account_export:${ctx.clock.now()}` });
    return { job_id: job.id, export: exportView(ctx, ctx.jobs.get(job.id)!) };
  });

  app.get('/me/exports', async (req): Promise<AccountExportsResponse> => {
    viewerOf(req);
    return { exports: listExports(ctx), included_ar: EXPORT_INCLUDED_AR, note_ar: EXPORT_NOTE_AR };
  });

  app.get('/me/exports/:jobId/download', { config: { rateLimit: { max: 20, timeWindow: 60_000 } } }, async (req, reply) => {
    viewerOf(req);
    const { jobId } = parseParams(jobParams, req);
    const job = ctx.jobs.get(jobId); // a job of MY vault only (the bound database)
    const f = job ? exportFile(ctx, job) : null;
    if (!f) throw new AppError('NOT_FOUND', ACCOUNTS_LABELS_AR.export_not_found, 404);
    reply.header('content-type', 'application/gzip');
    reply.header('content-length', String(f.out.size));
    reply.header('content-disposition', `attachment; filename="${f.out.file_name}"`);
    reply.header('cache-control', 'private, no-store');
    return reply.send(createReadStream(f.path));
  });

  // ───────── deleting my account (PRD Q14) ─────────
  app.post('/me/delete', { config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (req): Promise<DeletionPreview | AccountDeleteResponse> => {
    const v = viewerOf(req);
    const body = parseBody(accountDeleteSchema, req);
    if ('preview' in body) return deletionPreview(ctx, v);
    return confirmDeletion(ctx, v, body, req.ip ?? null);
  });

  app.get('/me/devices', async (req): Promise<DevicesResponse> => {
    const v = viewerOf(req);
    return { devices: devices.list(v).map((d) => toDeviceView(d, v.deviceId)) };
  });

  app.post('/me/devices', async (req): Promise<DeviceView> => {
    const v = viewerOf(req);
    const body = parseBody(registerDeviceSchema, req);
    if (!devices.get(v, body.device_id) && devices.activeCount(v) >= MAX_ACTIVE_DEVICES) {
      throw new AppError('CONFLICT', `بلغت أجهزتك المسجلة الحد الأقصى (${MAX_ACTIVE_DEVICES}). ألغِ جهازًا لم تعد تستخدمه ثم أعد المحاولة.`, 409);
    }
    const { device, created } = devices.register(v, { device_id: body.device_id, label: body.label ?? null, platform: body.platform ?? null });
    if (device.revoked_at !== null) throw new AppError('CONFLICT', ACCOUNTS_LABELS_AR.device_revoked, 409);
    if (created) securityAudit.record({ actorUserId: v.userId, actorRole: 'self', action: 'device_register', targetType: 'device', targetId: device.device_uid, summary: 'تسجيل جهاز جديد', ip: req.ip ?? null });
    return toDeviceView(device, v.deviceId ?? body.device_id);
  });

  app.delete('/me/devices/:deviceId', async (req) => {
    const v = viewerOf(req);
    const { deviceId } = parseParams(deviceParams, req);
    if (!devices.revoke(v, deviceId)) throw new AppError('NOT_FOUND', ACCOUNTS_LABELS_AR.device_not_found, 404);
    securityAudit.record({ actorUserId: v.userId, actorRole: 'self', action: 'device_revoke', targetType: 'device', targetId: deviceId, summary: 'إلغاء جهاز ومفتاحه', ip: req.ip ?? null });
    return { ok: true };
  });

  app.put('/me/devices/:deviceId/key', async (req): Promise<DeviceView> => {
    const v = viewerOf(req);
    const { deviceId } = parseParams(deviceParams, req);
    const body = parseBody(deviceKeySchema, req);
    if (Buffer.from(body.public_key, 'base64url').length !== 32) {
      throw new AppError('VALIDATION_FAILED', 'المفتاح العام غير صالح: يلزم مفتاح Ed25519 من 32 بايت.', 400);
    }
    if (!devices.setKey(v, deviceId, body.public_key)) throw new AppError('NOT_FOUND', ACCOUNTS_LABELS_AR.device_not_found, 404);
    securityAudit.record({ actorUserId: v.userId, actorRole: 'self', action: 'device_key', targetType: 'device', targetId: deviceId, summary: 'تسجيل مفتاح جهاز', ip: req.ip ?? null });
    return toDeviceView(devices.get(v, deviceId)!, v.deviceId);
  });
}
