// Platform operations (/api/platform; ARCHITECTURE_DELTA §5.8, P1-T1 step 1). Platform admin only: the binding hook
// answers 404 to everyone else before any handler runs (modules/authz/routes.ts). The views COUNT accounts, databases
// and queued work for the whole deployment; they never read the content of anyone's vault.
//   GET /api/platform/status → PlatformStatusResponse
// P1-T1 step 2:
//   GET  /api/platform/blobs                        → PlatformBlobsResponse (registry counts, sweeps, object-store copies)
//   POST /api/platform/blobs/sweep {kind}           → starts a mark-and-sweep (or a mark pass) in the background
//   GET  /api/platform/quotas/users/:userId         → PlatformQuotaView
//   PUT  /api/platform/quotas/users/:userId         {storage_mb?, ai_monthly_usd?} → PlatformQuotaView
//   PUT  /api/platform/quotas/spaces/:spaceId       {storage_mb?, ai_monthly_usd?} → PlatformQuotaView
//   GET  /api/platform/vaults/:vaultId/backups      → VaultBackupsResponse (+ the last restore of this process)
//   POST /api/platform/vaults/:vaultId/backups      → VaultBackupView (one vault, encrypted when the key is set)
//   POST /api/platform/vaults/:vaultId/restore      {file_name} → 202; runs in the background (data/vault-backup.ts)
// AOS-21.1 / X8 (d):
//   GET  /api/platform/spaces/:spaceId/backups        → SpaceBackupsResponse (+ the last restore check of this process)
//   POST /api/platform/spaces/:spaceId/backups        → SpaceBackupView (one subject space, encrypted when the key is set)
//   POST /api/platform/spaces/:spaceId/backups/verify {file_name} → 202; the restore check runs in the background
//        (data/space-backup.ts; it never changes the live space)
// (ARCHITECTURE_DELTA §7.12 names the quota routes /api/admin/quotas/…; they are platform-admin operations and live
// here with the other ones — /api/admin is the channel administration of P1-T4.)
// Today's whole-instance routes (backups, off-site copies, /export/all, evaluation, health, client-error list) stay
// where they are and are guarded in place by the same rule.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type BlobSweepView,
  type PlatformBlobsResponse,
  type PlatformQuotaView,
  type PlatformStatusResponse,
  restoreVaultSchema,
  runSweepSchema,
  setQuotaSchema,
  type SpaceBackupsResponse,
  type SpaceBackupView,
  type VaultBackupsResponse,
  type VaultBackupView,
  verifySpaceBackupSchema,
} from '@medlevo/shared';
import type { AppContext, ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams } from '../../lib/http';
import type { BlobSweepRow } from '../../system/ops';
import { PLATFORM_ROUTES } from '../authz/routes';
import { backupSpace, lastSpaceCheck, listSpaceBackups, SPACE_BACKUP_NOTE_AR, spaceTitle, verifySpaceBackup } from '../data/space-backup';
import { backupVault, lastVaultRestore, listVaultBackups, restoreVault, VAULT_BACKUP_NOTE_AR } from '../data/vault-backup';

const MiB = 1024 * 1024;
const userParams = z.object({ userId: z.string().min(1).max(64) });
const spaceParams = z.object({ spaceId: z.string().min(1).max(64) });
const vaultParams = z.object({ vaultId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/) });

const sweepView = (r: BlobSweepRow): BlobSweepView => ({ ...r });

export const BLOB_POLICY_AR =
  'الملفات مخزنة مرة واحدة حسب محتواها ويتشاركها كل من رفعها. لا يُحذف ملف إلا بعد فحصين متتاليين بينهما 7 أيام على الأقل لم يجدا أي حساب أو مادة تشير إليه، ثم 30 يومًا في الحجر الصحي، ثم فحص أخير لا يجده؛ وإن عاد أي حساب يشير إليه أُعيد فورًا. فحص لم يستطع قراءة كل الخزائن لا يقرر شيئًا.';

function adminOf(req: FastifyRequest): string {
  if (!req.viewer?.isPlatformAdmin) throw new AppError('NOT_FOUND', 'المسار المطلوب غير موجود.', 404);
  return req.viewer.userId;
}

function userQuotaView(ctx: AppContext, userId: string): PlatformQuotaView {
  const user = ctx.system.users.byIdInternal(userId);
  if (!user || user.status === 'deleted') throw new AppError('NOT_FOUND', 'الحساب غير موجود.', 404);
  const row = ctx.system.quotas.userInternal(userId);
  const vault = ctx.system.vaults.ofUserInternal(userId);
  // counts only — the size of the vault and of the files it references, never their content
  const used = vault && vault.status === 'active' ? ctx.quota.storageUsed(vault.id) : null;
  const party = vault ? ctx.quota.aiParty({ kind: 'vault', vaultId: vault.id, viewer: null }) : null;
  const ledger = party ? ctx.system.aiLedger.usedInternal({ userId }, party.month) : { settled: 0, reserved: 0 };
  const allowance = ctx.quota.aiAllowance(userId);
  return {
    subject: { kind: 'user', user_id: userId },
    storage: { limit_bytes: ctx.quota.storageLimit(userId), used_bytes: used ? used.bytes_db + used.bytes_files : null, explicit: row?.storage_bytes_limit != null },
    ai: { limit_usd: allowance.limitUsd, month: party?.month ?? '', used_usd_est: Math.round((ledger.settled + ledger.reserved) * 1e6) / 1e6, explicit: row?.ai_monthly_usd_limit != null },
  };
}

function spaceQuotaView(ctx: AppContext, spaceId: string): PlatformQuotaView {
  if (!ctx.system.vaults.spaceByIdInternal(spaceId)) throw new AppError('NOT_FOUND', 'المادة غير موجودة.', 404);
  const row = ctx.system.quotas.spaceInternal(spaceId);
  const month = ctx.quota.monthOf(ctx.clock.now(), ctx.config.timezone).month;
  const ledger = ctx.system.aiLedger.usedInternal({ spaceId }, month);
  return {
    subject: { kind: 'space', space_id: spaceId },
    storage: { limit_bytes: row?.storage_bytes_limit ?? ctx.config.quota.spaceStorageBytes, used_bytes: null, explicit: row?.storage_bytes_limit != null },
    ai: { limit_usd: row?.ai_monthly_usd_limit ?? 0, month, used_usd_est: Math.round((ledger.settled + ledger.reserved) * 1e6) / 1e6, explicit: row?.ai_monthly_usd_limit != null },
  };
}

export default async function platformModule(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  app.get('/status', async (): Promise<PlatformStatusResponse> => {
    const sys = ctx.system.db;
    const n = (sql: string, params: unknown[] = []) => sys.get<{ n: number }>(sql, params)!.n;
    const pool = ctx.pool.stats();
    const dayAgo = ctx.clock.now() - 24 * 60 * 60 * 1000;
    return {
      accounts: {
        total: n('SELECT COUNT(*) AS n FROM user_account'),
        active: n(`SELECT COUNT(*) AS n FROM user_account WHERE status = 'active'`),
        platform_admins: n('SELECT COUNT(*) AS n FROM user_account WHERE is_platform_admin = 1'),
      },
      vaults: { total: n('SELECT COUNT(*) AS n FROM vault'), open: pool.open },
      spaces: { total: n('SELECT COUNT(*) AS n FROM space') },
      pool: { open: pool.open, max: pool.max, hits: pool.hits, misses: pool.misses, evictions: pool.evictions, fd_limit: pool.fdLimit },
      jobs: {
        queued: n(`SELECT COUNT(*) AS n FROM job_index WHERE status = 'queued'`),
        running: n(`SELECT COUNT(*) AS n FROM job_index WHERE status = 'running'`),
        failed_last_day: n(`SELECT COUNT(*) AS n FROM job_index WHERE status = 'failed' AND updated_at >= ?`, [dayAgo]),
      },
      guarded_routes: [...PLATFORM_ROUTES],
    };
  });

  // ───────── blob registry and GC (counts only) ─────────
  app.get('/blobs', async (): Promise<PlatformBlobsResponse> => {
    const s = ctx.config.blobGc.schedule;
    return {
      registry: ctx.system.blobs.countsInternal(),
      object_store: { kind: ctx.config.blobStore.kind, pending_copies: ctx.blobs.objectStore ? ctx.system.blobs.pendingReplicationInternal(1_000_000).length : 0 },
      sweep: {
        running: ctx.gc.isRunning,
        schedule: s ? `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}` : null,
        recent: ctx.system.blobs.lastSweepsInternal(10).map(sweepView),
      },
      policy_ar: BLOB_POLICY_AR,
    };
  });

  app.post('/blobs/sweep', { config: { rateLimit: { max: 6, timeWindow: 60_000 } } }, async (req, reply) => {
    const { kind } = req.body === undefined || req.body === null ? { kind: 'sweep' as const } : parseBody(runSweepSchema, req);
    // background work: the root context, never the admin's own vault binding
    const started = ctx.binding.runRoot(() => ctx.gc.run(kind));
    void started.catch((e: unknown) => ctx.log.warn({ err: e }, 'blob sweep failed'));
    return reply.code(202).send({ started: true, kind });
  });

  // ───────── per-vault backups and restore ─────────
  app.get('/vaults/:vaultId/backups', async (req): Promise<VaultBackupsResponse & { last_restore: unknown }> => {
    adminOf(req);
    const { vaultId } = parseParams(vaultParams, req);
    return { vault_id: vaultId, backups: listVaultBackups(ctx, vaultId), note_ar: VAULT_BACKUP_NOTE_AR, last_restore: lastVaultRestore.get(vaultId) ?? null };
  });

  app.post('/vaults/:vaultId/backups', { config: { rateLimit: { max: 6, timeWindow: 10 * 60_000 } } }, async (req, reply): Promise<VaultBackupView> => {
    const admin = adminOf(req);
    const { vaultId } = parseParams(vaultParams, req);
    const view = await backupVault(ctx, vaultId);
    ctx.system.securityAudit.record({ actorUserId: admin, actorRole: 'platform_admin', action: 'vault_backup', targetDb: vaultId, targetType: 'vault', targetId: vaultId, summary: 'نسخة احتياطية لخزنة حساب', details: { encrypted: view.encrypted, size: view.size }, ip: req.ip ?? null });
    return reply.code(201).send(view);
  });

  app.post('/vaults/:vaultId/restore', { config: { rateLimit: { max: 3, timeWindow: 10 * 60_000 } } }, async (req, reply) => {
    const admin = adminOf(req);
    const { vaultId } = parseParams(vaultParams, req);
    const { file_name } = parseBody(restoreVaultSchema, req);
    listVaultBackups(ctx, vaultId); // the vault exists
    ctx.system.securityAudit.record({ actorUserId: admin, actorRole: 'platform_admin', action: 'vault_restore_request', targetDb: vaultId, targetType: 'vault', targetId: vaultId, summary: 'طلب استعادة خزنة حساب', details: { file_name }, ip: req.ip ?? null });
    // background work in the root context: this request's own lease (the admin's vault) is released first
    ctx.binding.runRoot(() =>
      setImmediate(() => {
        void restoreVault(ctx, vaultId, file_name)
          .then((r) => lastVaultRestore.set(vaultId, { ...r, finished_at: ctx.clock.now() }))
          .catch((e: unknown) => {
            lastVaultRestore.set(vaultId, { vault_id: vaultId, ok: false, checks: [{ name: 'apply', ok: false, detail_ar: (e as Error).message.slice(0, 200) }], rollback_copy: null, sessions_revoked: 0, finished_at: ctx.clock.now() });
          });
      }),
    );
    return reply.code(202).send({ started: true });
  });

  // ───────── per-space backups and their restore check (AOS-21.1 / X8 (d)) ─────────
  app.get('/spaces/:spaceId/backups', async (req): Promise<SpaceBackupsResponse> => {
    adminOf(req);
    const { spaceId } = parseParams(spaceParams, req);
    const backups = listSpaceBackups(ctx, spaceId);
    return { space_id: spaceId, title: spaceTitle(ctx, spaceId), backups, note_ar: SPACE_BACKUP_NOTE_AR, last_check: lastSpaceCheck.get(spaceId) ?? null };
  });

  app.post('/spaces/:spaceId/backups', { config: { rateLimit: { max: 6, timeWindow: 10 * 60_000 } } }, async (req, reply): Promise<SpaceBackupView> => {
    const admin = adminOf(req);
    const { spaceId } = parseParams(spaceParams, req);
    // the snapshot reads the space file by path: the request's own binding (the admin's vault) is left alone
    const view = await ctx.binding.runRoot(() => backupSpace(ctx, spaceId));
    ctx.system.securityAudit.record({ actorUserId: admin, actorRole: 'platform_admin', action: 'space_backup', targetDb: spaceId, targetType: 'space', targetId: spaceId, summary: 'نسخة احتياطية لمساحة مادة', details: { encrypted: view.encrypted, size: view.size }, ip: req.ip ?? null });
    return reply.code(201).send(view);
  });

  app.post('/spaces/:spaceId/backups/verify', { config: { rateLimit: { max: 6, timeWindow: 10 * 60_000 } } }, async (req, reply) => {
    const admin = adminOf(req);
    const { spaceId } = parseParams(spaceParams, req);
    const { file_name } = parseBody(verifySpaceBackupSchema, req);
    if (!listSpaceBackups(ctx, spaceId).some((b) => b.file_name === file_name)) throw new AppError('NOT_FOUND', 'النسخة غير موجودة.', 404);
    if (lastSpaceCheck.get(spaceId)?.running) throw new AppError('CONFLICT', 'فحص آخر لنسخة هذه المادة يعمل الآن؛ أعد المحاولة بعد قليل.', 409);
    const started = ctx.clock.now();
    lastSpaceCheck.set(spaceId, { space_id: spaceId, file_name, running: true, ok: false, checks: [], started_at: started, finished_at: null });
    ctx.system.securityAudit.record({ actorUserId: admin, actorRole: 'platform_admin', action: 'space_backup_verify', targetDb: spaceId, targetType: 'space', targetId: spaceId, summary: 'فحص استعادة نسخة مساحة مادة', details: { file_name }, ip: req.ip ?? null });
    // background work in the root context: this request's own lease (the admin's vault) is released first
    ctx.binding.runRoot(() =>
      setImmediate(() => {
        void verifySpaceBackup(ctx, spaceId, file_name)
          .then((r) => lastSpaceCheck.set(spaceId, r))
          .catch((e: unknown) => {
            lastSpaceCheck.set(spaceId, { space_id: spaceId, file_name, running: false, ok: false, checks: [{ name: 'verify', ok: false, detail_ar: (e as Error).message.slice(0, 200) }], started_at: started, finished_at: ctx.clock.now() });
          });
      }),
    );
    return reply.code(202).send({ started: true });
  });

  // ───────── quotas (PRD Q10, Q22) ─────────
  app.get('/quotas/users/:userId', async (req): Promise<PlatformQuotaView> => {
    adminOf(req);
    return userQuotaView(ctx, parseParams(userParams, req).userId);
  });

  app.put('/quotas/users/:userId', async (req): Promise<PlatformQuotaView> => {
    const admin = adminOf(req);
    const { userId } = parseParams(userParams, req);
    const body = parseBody(setQuotaSchema, req);
    userQuotaView(ctx, userId); // exists
    ctx.system.quotas.setUserInternal(
      userId,
      {
        ...(body.storage_mb !== undefined ? { storage_bytes_limit: body.storage_mb === null ? null : body.storage_mb * MiB } : {}),
        ...(body.ai_monthly_usd !== undefined ? { ai_monthly_usd_limit: body.ai_monthly_usd } : {}),
      },
      admin,
    );
    ctx.system.securityAudit.record({ actorUserId: admin, actorRole: 'platform_admin', action: 'quota_set', targetType: 'user', targetId: userId, summary: 'تعديل حصة حساب', details: { storage_mb: body.storage_mb, ai_monthly_usd: body.ai_monthly_usd }, ip: req.ip ?? null });
    return userQuotaView(ctx, userId);
  });

  app.put('/quotas/spaces/:spaceId', async (req): Promise<PlatformQuotaView> => {
    const admin = adminOf(req);
    const { spaceId } = parseParams(spaceParams, req);
    const body = parseBody(setQuotaSchema, req);
    spaceQuotaView(ctx, spaceId);
    ctx.system.quotas.setSpaceInternal(
      spaceId,
      {
        ...(body.storage_mb !== undefined ? { storage_bytes_limit: body.storage_mb === null ? null : body.storage_mb * MiB } : {}),
        ...(body.ai_monthly_usd !== undefined ? { ai_monthly_usd_limit: body.ai_monthly_usd } : {}),
      },
      admin,
    );
    ctx.system.securityAudit.record({ actorUserId: admin, actorRole: 'platform_admin', action: 'quota_set', targetType: 'space', targetId: spaceId, summary: 'تعديل حصة مادة', details: { storage_mb: body.storage_mb, ai_monthly_usd: body.ai_monthly_usd }, ip: req.ip ?? null });
    return spaceQuotaView(ctx, spaceId);
  });
}
