// AI allowance and atomic reservations (P1-T1 step 2; ADR-0003 §3.8, ARCHITECTURE_DELTA §14, PRD Q10).
//
// Before every provider call the orchestrator RESERVES the call's worst-case ESTIMATED cost in the system ledger
// (`ai_budget_ledger`, one BEGIN IMMEDIATE transaction that checks the charged allowance AND the deployment ceiling), then
// SETTLES it with the estimated cost of what really happened, or RELEASES it when the call never reached the provider.
// Two concurrent calls therefore never both pass a check that only one of them fits in (the old pre-check read
// usage_record and could not see a call in flight — docs/modules/core-server.md).
//
// Who pays: the vault's user (their allowance), or a subject space (its allowance) for work bound to a space. Usage
// recorded before the ledger existed (the single owner's month so far) still counts: the charged party's spending is
// max(ledger settled, usage_record of its database this month) + outstanding reservations.
import type { AiBudgetStatus } from '@medlevo/shared';
import type { Db } from '../../db/db';
import type { Clock } from '../../lib/time';
import { startOfMonthInTz } from '../../lib/time';
import type { TenantBinding } from '../../system/binding';
import { isNoTenantBound } from '../../system/binding';
import type { SystemRepos } from '../../system/repos';
import { type AiParty, QUOTA_AR, type QuotaService } from '../../system/quota';

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface AiBudgetState {
  party: AiParty;
  /** the charged party's ESTIMATED spending this month (settled + outstanding) */
  usedUsd: number;
  deploymentUsedUsd: number;
  deploymentLimitUsd: number;
  /** null when a call may be tried; otherwise the Arabic reason it is refused before any call */
  blockedAr: string | null;
}

export type Reservation = { ok: true; id: string } | { ok: false; messageAr: string; details: Record<string, unknown> };

export class AiBudgetService {
  constructor(
    private readonly system: SystemRepos,
    private readonly quota: QuotaService,
    private readonly binding: TenantBinding,
    /** the bound database (proxy): its usage_record holds spending made before the ledger existed */
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly cfg: { deploymentUsd: number; timezone: string },
  ) {}

  /** spending recorded in the bound database this month (all of it, ledger or not) */
  private recordedIn(monthStart: number): number {
    try {
      return this.db.get<{ n: number | null }>('SELECT SUM(estimated_cost_usd) AS n FROM usage_record WHERE created_at >= ?', [monthStart])?.n ?? 0;
    } catch (e) {
      if (isNoTenantBound(e)) return 0;
      throw e;
    }
  }

  private deploymentSince(): number {
    return startOfMonthInTz(this.clock.now(), this.cfg.timezone);
  }

  private notEnabledAr(p: AiParty): string {
    if (p.spaceId) return p.source === 'space_default_zero' ? QUOTA_AR.aiSpaceNotEnabled : QUOTA_AR.aiSpaceAllowance(p.limitUsd);
    if (p.source === 'user_default_zero') return QUOTA_AR.aiNotEnabled;
    return p.source === 'user_default_first' ? deploymentZeroOrFull(this.cfg.deploymentUsd) : QUOTA_AR.aiAllowance(p.limitUsd);
  }

  private exhaustedAr(p: AiParty): string {
    if (p.spaceId) return QUOTA_AR.aiSpaceAllowance(p.limitUsd);
    return p.source === 'user_default_first' ? deploymentZeroOrFull(this.cfg.deploymentUsd) : QUOTA_AR.aiAllowance(p.limitUsd);
  }

  /** The current binding's party and spending, or null outside any database (module registration). */
  state(): AiBudgetState | null {
    const party = this.quota.aiParty(this.binding.current() ?? this.binding.harnessDefault());
    if (!party) return null;
    const who = party.spaceId ? { spaceId: party.spaceId } : { userId: party.userId };
    const l = this.system.aiLedger.usedInternal(who, party.month);
    const outside = this.recordedIn(party.monthStart);
    const usedUsd = round6(Math.max(l.settled, outside) + l.reserved);
    const deploymentUsedUsd = round6(this.system.aiLedger.deploymentUsedInternal(this.deploymentSince()) + Math.max(0, outside - l.settled));
    let blockedAr: string | null = null;
    if (party.limitUsd <= 0) blockedAr = this.notEnabledAr(party);
    else if (usedUsd >= party.limitUsd) blockedAr = this.exhaustedAr(party);
    else if (this.cfg.deploymentUsd <= 0) blockedAr = deploymentZeroOrFull(0);
    else if (deploymentUsedUsd >= this.cfg.deploymentUsd) blockedAr = QUOTA_AR.aiDeployment(this.cfg.deploymentUsd);
    return { party, usedUsd, deploymentUsedUsd, deploymentLimitUsd: this.cfg.deploymentUsd, blockedAr };
  }

  /** The AiBudgetStatus the existing API shows, for the charged party (null → the caller's deployment view). */
  status(): AiBudgetStatus | null {
    const s = this.state();
    if (!s) return null;
    const remaining = Math.max(0, Math.min(s.party.limitUsd - s.usedUsd, s.deploymentLimitUsd - s.deploymentUsedUsd));
    return {
      monthly_usd: s.party.limitUsd,
      spent_usd: s.usedUsd,
      remaining_usd: round6(remaining),
      period_start: s.party.monthStart,
      estimated: true,
    };
  }

  /** Reserve `amountUsd` (worst case) for one provider call; never throws for a refusal. */
  reserve(amountUsd: number): Reservation | null {
    const party = this.quota.aiParty(this.binding.current() ?? this.binding.harnessDefault());
    if (!party) return null;
    const outside = this.recordedIn(party.monthStart);
    const r = this.system.aiLedger.reserveInternal({
      userId: party.userId,
      spaceId: party.spaceId,
      month: party.month,
      kind: 'ai',
      amountUsd: round6(amountUsd),
      limitUsd: party.limitUsd,
      outsideLedgerUsd: outside,
      deploymentLimitUsd: this.cfg.deploymentUsd,
      deploymentSinceMs: this.deploymentSince(),
    });
    if (r.ok) return { ok: true, id: r.id };
    const messageAr =
      r.reason === 'deployment'
        ? this.cfg.deploymentUsd <= 0
          ? deploymentZeroOrFull(0)
          : QUOTA_AR.aiDeployment(this.cfg.deploymentUsd)
        : party.limitUsd <= 0
          ? this.notEnabledAr(party)
          : this.exhaustedAr(party);
    return {
      ok: false,
      messageAr,
      details: {
        charged: party.spaceId ? 'space' : 'user',
        limit_usd: r.limitUsd,
        used_usd: r.usedUsd,
        remaining_usd: round6(Math.max(0, r.limitUsd - r.usedUsd)),
        wanted_usd: round6(amountUsd),
      },
    };
  }

  settle(id: string, actualUsd: number, usageRef: string | null): void {
    this.system.aiLedger.settleInternal(id, actualUsd, usageRef);
  }

  release(id: string): void {
    this.system.aiLedger.releaseInternal(id);
  }

  /** Boot: reservations left open by a stopped process (no call outlives a restart; calls time out after 2 × 120 s). */
  releaseStale(): number {
    return this.system.aiLedger.releaseStaleInternal(this.clock.now() - 60 * 60 * 1000);
  }
}

/** Today's single-owner wording for the deployment budget (unchanged for user #1). */
export function deploymentZeroOrFull(budget: number): string {
  if (budget <= 0) return 'استدعاءات الذكاء الاصطناعي متوقفة لأن الميزانية الشهرية مضبوطة على 0. ارفع الحد (MEDLEVO_AI_MONTHLY_BUDGET_USD) لتفعيلها.';
  return `بلغت التكلفة التقديرية للذكاء الاصطناعي هذا الشهر الحد الذي حددته (${budget}$). ارفع الحد من إعدادات الخادم أو انتظر بداية الشهر القادم.`;
}
