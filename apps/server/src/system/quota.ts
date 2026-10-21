// Quotas (P1-T1 step 2; ARCHITECTURE_DELTA §14, PRD Q10 / Q22, ADR-0003 §3.8): `ctx.quota`.
//
// Storage — a user's vault database plus the blobs it references (each blob counted once per vault: stored_file.sha256
// is unique per database). Default 2 GB per student vault (PRD Q22, MEDLEVO_USER_STORAGE_QUOTA_MB); user #1 — the first
// account, i.e. today's single owner — keeps today's behaviour (no limit) until the platform admin sets one. Enforced
// when a signed-in user adds bytes (uploads, annotation images, chunked upload sessions): `QUOTA_EXCEEDED` with
// {kind, used, limit}. Background work (processing renders, converted PDFs) is counted but never refused mid-way.
//
// AI — per-user monthly allowance (USD, ESTIMATED): user #1 gets the deployment's MEDLEVO_AI_MONTHLY_BUDGET_USD; every
// other account gets 0 — «غير مُفعّل لحسابك» — until the platform admin sets a cap (PRD Q10). A subject space has its
// own allowance (0 until set). The deployment budget stays a ceiling over everyone (modules/ai/budget.ts reserves
// atomically in the system ledger).
import type { QuotaView } from '@medlevo/shared';
import { AppError } from '../lib/errors';
import { type Clock, localDate, startOfMonthInTz } from '../lib/time';
import type { Binding, TenantBinding, Viewer } from './binding';
import type { DatabasePool } from './pool';
import type { SystemRepos } from './repos';

export const QUOTA_AR = {
  storage: (usedMb: string, limitMb: string) =>
    `لا توجد مساحة كافية في حسابك لهذا الملف: تستخدم ${usedMb} من ${limitMb}. احذف ملفات لا تحتاجها أو اطلب من مسؤول المنصة زيادة المساحة.`,
  aiNotEnabled: 'الذكاء الاصطناعي غير مُفعّل لحسابك: لم يحدد مسؤول المنصة حدًّا شهريًا لاستخدامك بعد. باقي الميزات تعمل دونه.',
  aiAllowance: (limit: number) => `بلغت التكلفة التقديرية لاستخدامك الذكاء الاصطناعي هذا الشهر الحد المسموح لحسابك (${limit}$). انتظر بداية الشهر القادم أو اطلب من مسؤول المنصة رفع الحد.`,
  aiSpaceNotEnabled: 'الذكاء الاصطناعي غير مُفعّل لهذه المادة: لم يحدد مسؤول المنصة حدًّا شهريًا لها بعد.',
  aiSpaceAllowance: (limit: number) => `بلغت التكلفة التقديرية للذكاء الاصطناعي في هذه المادة هذا الشهر الحد المحدد لها (${limit}$).`,
  aiDeployment: (limit: number) => `بلغت التكلفة التقديرية للذكاء الاصطناعي على المنصة كلها هذا الشهر الحد الذي حدده المسؤول (${limit}$). انتظر بداية الشهر القادم.`,
} as const;

const MiB = 1024 * 1024;
const mb = (bytes: number) => `${(bytes / MiB).toFixed(bytes >= 100 * MiB ? 0 : 1)} م.ب`;

export interface QuotaConfig {
  /** default storage limit of a vault other than user #1's (bytes) */
  userStorageBytes: number;
  /** default storage limit of a subject space (bytes) */
  spaceStorageBytes: number;
  /** MEDLEVO_AI_MONTHLY_BUDGET_USD: user #1's default allowance and the deployment ceiling */
  deploymentAiUsd: number;
  /** the deployment's timezone (the ceiling's month) */
  timezone: string;
}

/** Who pays for an AI call made in the current binding. */
export interface AiParty {
  userId: string;
  spaceId: string | null;
  /** YYYY-MM in the charged party's timezone */
  month: string;
  monthStart: number;
  limitUsd: number;
  /** why the allowance is what it is (messages) */
  source: 'user_default_first' | 'user_default_zero' | 'user_explicit' | 'space_explicit' | 'space_default_zero';
}

export class QuotaService {
  constructor(
    private readonly system: SystemRepos,
    private readonly pool: DatabasePool,
    private readonly binding: TenantBinding,
    private readonly clock: Clock,
    private readonly cfg: QuotaConfig,
  ) {}

  private isFirstUser(userId: string): boolean {
    return this.system.users.firstUserIdInternal() === userId;
  }

  /** The storage limit of a user's vault in bytes (null = no limit: user #1 by default). */
  storageLimit(userId: string): number | null {
    const row = this.system.quotas.userInternal(userId);
    if (row && row.storage_bytes_limit !== null) return row.storage_bytes_limit;
    return this.isFirstUser(userId) ? null : this.cfg.userStorageBytes;
  }

  /**
   * Bytes a vault uses: its database (logical size: pages × page size, which includes what still sits in the WAL and
   * does not jump with checkpoints) and the blobs it references (each once). Reads that vault.
   */
  storageUsed(vaultId: string): { bytes_db: number; bytes_files: number } {
    const vault = this.system.vaults.byIdInternal(vaultId);
    if (!vault || vault.status !== 'active') return { bytes_db: vault?.bytes_db ?? 0, bytes_files: vault?.bytes_files ?? 0 };
    const db = this.pool.get('vault', vaultId);
    const pages = db.get<{ page_count: number }>('PRAGMA page_count')!.page_count;
    const pageSize = db.get<{ page_size: number }>('PRAGMA page_size')!.page_size;
    const bytesDb = pages * pageSize;
    const files = db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM stored_file')!.n;
    this.system.vaults.setBytesInternal(vaultId, bytesDb, files);
    return { bytes_db: bytesDb, bytes_files: files };
  }

  /** The vault a binding writes into for its user, when the bytes count against a user's quota. */
  private chargedVault(b: Binding | null): { vaultId: string; viewer: Viewer } | null {
    if (!b || b.kind !== 'vault' || !b.viewer) return null;
    return { vaultId: b.vaultId, viewer: b.viewer };
  }

  /**
   * Called before a NEW stored_file row is written in the bound database (FileStore.put). Refuses when a signed-in
   * user's upload would take their vault over its limit; background work (no viewer) and spaces (R1-c) pass.
   */
  checkStorageForNewFile(addBytes: number): void {
    const target = this.chargedVault(this.binding.current());
    if (!target) return;
    const limit = this.storageLimit(target.viewer.userId);
    if (limit === null) return;
    const used = this.storageUsed(target.vaultId);
    const total = used.bytes_db + used.bytes_files;
    if (total + addBytes > limit) throw this.storageError(total, limit, addBytes);
  }

  /** Before an upload session starts: the bytes of the viewer's other open sessions are counted too. */
  checkStorageForUpload(viewer: Viewer, vaultId: string, addBytes: number): void {
    const limit = this.storageLimit(viewer.userId);
    if (limit === null) return;
    const used = this.storageUsed(vaultId);
    const open = this.system.uploads.openBytes(viewer);
    const total = used.bytes_db + used.bytes_files + open;
    if (total + addBytes > limit) throw this.storageError(total, limit, addBytes);
  }

  storageError(used: number, limit: number, wanted: number): AppError {
    return new AppError('QUOTA_EXCEEDED', QUOTA_AR.storage(mb(used), mb(limit)), 409, { kind: 'storage', used, limit, wanted, resets_at: null });
  }

  // ───────── AI ─────────

  monthOf(ms: number, timezone: string): { month: string; start: number } {
    return { month: localDate(ms, timezone).slice(0, 7), start: startOfMonthInTz(ms, timezone) };
  }

  /** A user's monthly AI allowance (USD) and where it comes from. */
  aiAllowance(userId: string): { limitUsd: number; source: AiParty['source'] } {
    const row = this.system.quotas.userInternal(userId);
    if (row && row.ai_monthly_usd_limit !== null) return { limitUsd: row.ai_monthly_usd_limit, source: 'user_explicit' };
    return this.isFirstUser(userId) ? { limitUsd: this.cfg.deploymentAiUsd, source: 'user_default_first' } : { limitUsd: 0, source: 'user_default_zero' };
  }

  /**
   * The party an AI call made in `b` is charged to: the vault's user, or the subject space (its allowance, 0 until
   * the platform admin sets one). Null outside any database (status at module registration).
   */
  aiParty(b: Binding | null): AiParty | null {
    if (!b || b.kind === 'root') return null;
    const now = this.clock.now();
    if (b.kind === 'vault') {
      const userId = b.viewer?.userId ?? this.system.vaults.byIdInternal(b.vaultId)?.user_id ?? null;
      if (!userId) return null;
      const tz = this.system.users.byIdInternal(userId)?.timezone ?? this.cfg.timezone;
      const m = this.monthOf(now, tz);
      const a = this.aiAllowance(userId);
      return { userId, spaceId: null, month: m.month, monthStart: m.start, limitUsd: a.limitUsd, source: a.source };
    }
    const actor = b.viewer?.userId ?? this.system.users.firstUserIdInternal();
    if (!actor) return null;
    const m = this.monthOf(now, this.cfg.timezone);
    const row = this.system.quotas.spaceInternal(b.spaceId);
    const limit = row?.ai_monthly_usd_limit ?? null;
    return { userId: actor, spaceId: b.spaceId, month: m.month, monthStart: m.start, limitUsd: limit ?? 0, source: limit === null ? 'space_default_zero' : 'space_explicit' };
  }

  /** «حصتي»: the viewer's own storage and AI allowance (ASR arrives with ADR-0006). Reads the viewer's own vault. */
  view(viewer: Viewer): QuotaView {
    const vault = this.system.vaults.ofViewer(viewer);
    const used = vault ? this.storageUsed(vault.id) : { bytes_db: 0, bytes_files: 0 };
    const party = vault ? this.aiParty({ kind: 'vault', vaultId: vault.id, viewer }) : null;
    let aiUsed = 0;
    if (party) {
      const l = this.system.aiLedger.usedInternal({ userId: viewer.userId }, party.month);
      const outside = vault
        ? this.binding.run({ kind: 'vault', vaultId: vault.id, viewer: null }, () =>
            this.pool.get('vault', vault.id).get<{ n: number | null }>('SELECT SUM(estimated_cost_usd) AS n FROM usage_record WHERE created_at >= ?', [party.monthStart])!.n ?? 0,
          )
        : 0;
      aiUsed = Math.round((Math.max(l.settled, outside) + l.reserved) * 1e6) / 1e6;
    }
    return {
      storage: { used_bytes: used.bytes_db + used.bytes_files, limit_bytes: this.storageLimit(viewer.userId) },
      ai: { month: party?.month ?? this.monthOf(this.clock.now(), this.cfg.timezone).month, used_usd_est: aiUsed, limit_usd: party?.limitUsd ?? 0 },
      asr: { month: party?.month ?? this.monthOf(this.clock.now(), this.cfg.timezone).month, used_minutes: 0, limit_minutes: 0 },
    };
  }
}
