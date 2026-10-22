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
import type { QuotaView, SpaceAiAllowanceView } from '@medlevo/shared';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../lib/errors';
import { type Clock, localDate, startOfMonthInTz } from '../lib/time';
import type { Binding, TenantBinding, Viewer } from './binding';
import type { DatabasePool } from './pool';
import type { SystemRepos } from './repos';

export const QUOTA_AR = {
  storage: (usedMb: string, limitMb: string) =>
    `لا توجد مساحة كافية في حسابك لهذا الملف: تستخدم ${usedMb} من ${limitMb}. احذف ملفات لا تحتاجها أو اطلب من مسؤول المنصة زيادة المساحة.`,
  spaceStorage: (title: string, usedMb: string, limitMb: string) =>
    `لا توجد مساحة كافية في مادة «${title}» لهذا الملف: تستخدم المادة ${usedMb} من ${limitMb}. احذف ملفات لا تحتاجها المادة أو اطلب من مسؤول المنصة زيادة مساحتها.`,
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
  /** DATA_DIR: «نسخة من بياناتي» archives kept in DATA_DIR/exports/<vault id>/ count in the vault's quota (AOS-21.43) */
  dataDir?: string;
}

/** «نسخة من بياناتي» archive names (modules/accounts/export.ts EXPORT_NAME_RE). */
const EXPORT_ARCHIVE_RE = /^medlevo-export-[0-9TZ-]+-[0-9a-z]{8}\.tar\.gz$/;

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

/** AOS-21.45: a subject space crossed 80 % of its storage, or an upload was refused at 100 % (the moderators are told). */
export interface SpaceStorageWarning {
  spaceId: string;
  subjectNodeId: string;
  title: string;
  percent: 80 | 100;
  used: number;
  limit: number;
  /** one warning per space, threshold and month */
  dedupeKey: string;
}

export class QuotaService {
  private readonly spaceWarningListeners = new Set<(e: SpaceStorageWarning) => void>();

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
  /**
   * AOS-21.43: bytes of the «نسخة من بياناتي» archives kept on the server for this vault (up to three). They are the
   * account's bytes on the server's disk, so they count in its quota.
   */
  exportsBytes(vaultId: string): number {
    if (!this.cfg.dataDir || !/^[A-Za-z0-9_-]{1,80}$/.test(vaultId)) return 0;
    const dir = join(this.cfg.dataDir, 'exports', vaultId);
    let total = 0;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const n of names) {
      if (!EXPORT_ARCHIVE_RE.test(n)) continue;
      try {
        total += statSync(join(dir, n)).size;
      } catch {
        // removed meanwhile
      }
    }
    return total;
  }

  /** db + files + kept export archives (what every storage check compares with the limit). */
  storageTotal(vaultId: string): number {
    const u = this.storageUsed(vaultId);
    return u.bytes_db + u.bytes_files + u.bytes_exports;
  }

  storageUsed(vaultId: string): { bytes_db: number; bytes_files: number; bytes_exports: number } {
    const vault = this.system.vaults.byIdInternal(vaultId);
    if (!vault || vault.status !== 'active') return { bytes_db: vault?.bytes_db ?? 0, bytes_files: vault?.bytes_files ?? 0, bytes_exports: this.exportsBytes(vaultId) };
    const db = this.pool.get('vault', vaultId);
    const pages = db.get<{ page_count: number }>('PRAGMA page_count')!.page_count;
    const pageSize = db.get<{ page_size: number }>('PRAGMA page_size')!.page_size;
    const bytesDb = pages * pageSize;
    const files = db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM stored_file')!.n;
    this.system.vaults.setBytesInternal(vaultId, bytesDb, files);
    return { bytes_db: bytesDb, bytes_files: files, bytes_exports: this.exportsBytes(vaultId) };
  }

  // ───────── subject spaces (AOS-21.9 / 21.45; PRD Q22: 20 GB per subject by default) ─────────

  /** The storage limit of a subject space in bytes: what the platform admin set, else MEDLEVO_SPACE_STORAGE_QUOTA_MB. */
  spaceStorageLimit(spaceId: string): number {
    return this.system.quotas.spaceInternal(spaceId)?.storage_bytes_limit ?? this.cfg.spaceStorageBytes;
  }

  /** Bytes a subject space uses: its database (logical size) and the blobs it references (each once). Reads that space. */
  spaceStorageUsed(spaceId: string): { bytes_db: number; bytes_files: number } {
    const db = this.pool.get('space', spaceId);
    const pages = db.get<{ page_count: number }>('PRAGMA page_count')!.page_count;
    const pageSize = db.get<{ page_size: number }>('PRAGMA page_size')!.page_size;
    const files = db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM stored_file')!.n;
    return { bytes_db: pages * pageSize, bytes_files: files };
  }

  /** Subscribe to space storage warnings (the accounts module turns them into notifications); returns «unsubscribe». */
  onSpaceStorageWarning(fn: (e: SpaceStorageWarning) => void): () => void {
    this.spaceWarningListeners.add(fn);
    return () => this.spaceWarningListeners.delete(fn);
  }

  private warnSpace(b: Extract<Binding, { kind: 'space' }>, percent: 80 | 100, used: number, limit: number): void {
    const title = this.system.vaults.spaceByIdInternal(b.spaceId)?.title ?? b.spaceId;
    const month = this.monthOf(this.clock.now(), this.cfg.timezone).month;
    const e: SpaceStorageWarning = { spaceId: b.spaceId, subjectNodeId: b.subjectNodeId, title, percent, used, limit, dedupeKey: `quota_warning:space:${b.spaceId}:${percent}:${month}` };
    for (const fn of this.spaceWarningListeners) {
      try {
        fn(e);
      } catch {
        // a warning never fails the upload it is about
      }
    }
  }

  /**
   * A signed-in member's NEW file in a subject space (official lectures, attachments): refused when it would take the
   * subject over its limit (QUOTA_EXCEEDED kind 'space_storage'); crossing 80 % warns the subject's moderators once.
   */
  private checkSpaceStorage(b: Extract<Binding, { kind: 'space' }>, addBytes: number): void {
    const limit = this.spaceStorageLimit(b.spaceId);
    const used = this.spaceStorageUsed(b.spaceId);
    const total = used.bytes_db + used.bytes_files;
    if (total + addBytes > limit) {
      this.warnSpace(b, 100, total, limit);
      const title = this.system.vaults.spaceByIdInternal(b.spaceId)?.title ?? '';
      throw new AppError('QUOTA_EXCEEDED', QUOTA_AR.spaceStorage(title, mb(total), mb(limit)), 409, {
        kind: 'space_storage',
        space_id: b.spaceId,
        used: total,
        limit,
        wanted: addBytes,
        resets_at: null,
      });
    }
    if (total < 0.8 * limit && total + addBytes >= 0.8 * limit) this.warnSpace(b, 80, total + addBytes, limit);
  }

  /** The vault a binding writes into for its user, when the bytes count against a user's quota. */
  private chargedVault(b: Binding | null): { vaultId: string; viewer: Viewer } | null {
    if (!b || b.kind !== 'vault' || !b.viewer) return null;
    return { vaultId: b.vaultId, viewer: b.viewer };
  }

  /**
   * Called before a NEW stored_file row is written in the bound database (FileStore.put). Refuses when a signed-in
   * user's upload would take their vault — or, bound to a subject space, that subject (AOS-21.45) — over its limit;
   * background work (no viewer) is counted but passes.
   */
  checkStorageForNewFile(addBytes: number): void {
    const b = this.binding.current();
    if (b && b.kind === 'space') {
      if (b.viewer) this.checkSpaceStorage(b, addBytes);
      return;
    }
    const target = this.chargedVault(b);
    if (!target) return;
    const limit = this.storageLimit(target.viewer.userId);
    if (limit === null) return;
    const total = this.storageTotal(target.vaultId);
    if (total + addBytes > limit) throw this.storageError(total, limit, addBytes);
  }

  /** Before an upload session starts: the bytes of the viewer's other open sessions are counted too. */
  checkStorageForUpload(viewer: Viewer, vaultId: string, addBytes: number): void {
    const limit = this.storageLimit(viewer.userId);
    if (limit === null) return;
    const open = this.system.uploads.openBytes(viewer);
    const total = this.storageTotal(vaultId) + open;
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

  /** The first instant of the month after the one starting at `monthStart` (in `timezone`). */
  nextMonthStart(monthStart: number, timezone: string): number {
    return startOfMonthInTz(monthStart + 32 * 86_400_000, timezone);
  }

  /**
   * AOS-21.46: what a party may still spend this month — the smaller of its allowance left and the deployment ceiling
   * left (the same ESTIMATED numbers the atomic reservation of modules/ai/budget.ts checks).
   */
  private remainingUsd(limitUsd: number, usedUsd: number, settled: number, outside: number): number {
    const deploymentUsed = this.system.aiLedger.deploymentUsedInternal(startOfMonthInTz(this.clock.now(), this.cfg.timezone)) + Math.max(0, outside - settled);
    const deploymentLeft = this.cfg.deploymentAiUsd <= 0 ? 0 : this.cfg.deploymentAiUsd - deploymentUsed;
    return Math.round(Math.max(0, Math.min(limitUsd - usedUsd, deploymentLeft)) * 1e6) / 1e6;
  }

  /** «حصتي»: the viewer's own storage and AI allowance (ASR arrives with ADR-0006). Reads the viewer's own vault. */
  view(viewer: Viewer): QuotaView {
    const vault = this.system.vaults.ofViewer(viewer);
    const used = vault ? this.storageUsed(vault.id) : { bytes_db: 0, bytes_files: 0, bytes_exports: 0 };
    const party = vault ? this.aiParty({ kind: 'vault', vaultId: vault.id, viewer }) : null;
    let aiUsed = 0;
    let remaining = 0;
    if (party) {
      const l = this.system.aiLedger.usedInternal({ userId: viewer.userId }, party.month);
      const outside = vault
        ? this.binding.run({ kind: 'vault', vaultId: vault.id, viewer: null }, () =>
            this.pool.get('vault', vault.id).get<{ n: number | null }>('SELECT SUM(estimated_cost_usd) AS n FROM usage_record WHERE created_at >= ?', [party.monthStart])!.n ?? 0,
          )
        : 0;
      aiUsed = Math.round((Math.max(l.settled, outside) + l.reserved) * 1e6) / 1e6;
      remaining = this.remainingUsd(party.limitUsd, aiUsed, l.settled, outside);
    }
    const tz = this.system.users.byIdInternal(viewer.userId)?.timezone ?? this.cfg.timezone;
    const month = party?.month ?? this.monthOf(this.clock.now(), tz).month;
    const resetsAt = this.nextMonthStart(party?.monthStart ?? startOfMonthInTz(this.clock.now(), tz), tz);
    return {
      storage: { used_bytes: used.bytes_db + used.bytes_files + used.bytes_exports, limit_bytes: this.storageLimit(viewer.userId), exports_bytes: used.bytes_exports },
      ai: { month, used_usd_est: aiUsed, limit_usd: party?.limitUsd ?? 0, remaining_usd: remaining, resets_at: resetsAt },
      asr: { month, used_minutes: 0, limit_minutes: 0 },
    };
  }

  /** AOS-21.46: one subject space's monthly AI allowance (its moderators see it). Reads that space. */
  spaceAiView(spaceId: string, title: string): SpaceAiAllowanceView {
    const now = this.clock.now();
    const m = this.monthOf(now, this.cfg.timezone);
    const limit = this.system.quotas.spaceInternal(spaceId)?.ai_monthly_usd_limit ?? 0;
    const l = this.system.aiLedger.usedInternal({ spaceId }, m.month);
    let outside = 0;
    try {
      outside = this.binding.run({ kind: 'space', spaceId, subjectNodeId: '', viewer: null, access: 'moderator', route: null }, () =>
        this.pool.get('space', spaceId).get<{ n: number | null }>('SELECT SUM(estimated_cost_usd) AS n FROM usage_record WHERE created_at >= ?', [m.start])!.n ?? 0,
      );
    } catch {
      outside = 0; // a space that cannot be opened right now: the ledger alone
    }
    const usedUsd = Math.round((Math.max(l.settled, outside) + l.reserved) * 1e6) / 1e6;
    return {
      space_id: spaceId,
      title,
      month: m.month,
      used_usd_est: usedUsd,
      limit_usd: limit,
      remaining_usd: this.remainingUsd(limit, usedUsd, l.settled, outside),
      resets_at: this.nextMonthStart(m.start, this.cfg.timezone),
    };
  }
}
