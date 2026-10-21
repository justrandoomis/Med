// P1-T1 step 2 — AI allowances and atomic reservations (BUILD_PLAN §3.3 «test/ai/allowance.test.ts»; ADR-0003 §3.8,
// ARCHITECTURE_DELTA §14, PRD Q10). User #1 keeps today's whole budget; every other account starts at 0
// («غير مُفعّل لحسابك») until the platform admin sets a cap; a subject space has its own allowance; the deployment
// budget stays a ceiling over everyone. Concurrent calls never exceed an allowance: the worst case of each call is
// reserved in the system ledger in one transaction before the provider is called, then settled or released.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AiTask, ResolvedScope } from '@medlevo/shared';
import type { AiProvider, ProviderRequest, ProviderResponse, ProviderUsage } from '../../src/modules/ai/types';
import { ProviderError } from '../../src/modules/ai/types';
import { QUOTA_AR } from '../../src/system/quota';
import type { Binding } from '../../src/system/binding';
import { createTestApp, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const scope: ResolvedScope = {
  mode: 'lecture_only',
  sourceIds: ['S1'],
  versionIds: ['V1'],
  versionBySource: { S1: 'V1' },
  allowExternal: false,
  includeMyNotes: false,
  hash: 'scopehash',
  describeAr: 'المحاضرة فقط',
};
const schema = z.object({ summary: z.string().min(1) });
const req = () => ({ task: 'summarize' as const, schema, system: 'Summarize.', input: [{ label: 'p1', text: 'text' }], scope, sourceVersionIds: ['V1'] });

/** A provider whose calls wait until the test releases them (so reservations overlap), with fixed usage. */
class GatedProvider implements AiProvider {
  readonly name = 'gated';
  calls = 0;
  private waiters: Array<() => void> = [];
  constructor(
    private readonly usage: ProviderUsage = { inputTokens: 1000, outputTokens: 500 },
    private readonly gate = false,
    private readonly fail: ProviderError | null = null,
  ) {}
  supports(_t: AiTask): boolean {
    return true;
  }
  modelFor(): string {
    return 'gated-1';
  }
  /** $3 / $15 per million tokens */
  estimateCostUsd(_m: string, u: ProviderUsage): number {
    return (u.inputTokens * 3 + u.outputTokens * 15) / 1_000_000;
  }
  release(): void {
    for (const w of this.waiters.splice(0)) w();
  }
  get waiting(): number {
    return this.waiters.length;
  }
  async generateStructured(_r: ProviderRequest): Promise<ProviderResponse> {
    this.calls++;
    if (this.gate) await new Promise<void>((r) => this.waiters.push(r));
    if (this.fail) throw this.fail;
    return { model: 'gated-1', usage: this.usage, requestRef: `g-${this.calls}`, json: { summary: 'ok' } };
  }
}

/** Worst case of one call of req(): estimated input + 4096 output tokens at $15/M (≈ $0.0615). */
const worstCase = (app: TestApp) => {
  // measured through a reservation of one call (the ledger row of a gated call)
  return app.ctx.system.db.get<{ r: number }>(`SELECT reserved_usd AS r FROM ai_budget_ledger ORDER BY created_at DESC LIMIT 1`)?.r ?? 0;
};

const asVault = <T>(app: TestApp, vaultId: string, userId: string, fn: () => T): T =>
  app.ctx.binding.run({ kind: 'vault', vaultId, viewer: { userId, deviceId: null, isPlatformAdmin: false } }, fn);

describe('per-user allowance', () => {
  it('user #1 keeps the deployment budget; another account starts at 0 and is told «غير مُفعّل لحسابك»', async () => {
    const p = new GatedProvider();
    t = await createTestApp({ ai: p, env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '5' } });
    expect(t.ctx.ai.budget()).toMatchObject({ monthly_usd: 5, spent_usd: 0 }); // the harness binds user #1
    const b = await addUser(t, 'student-b');
    const st = asVault(t, b.vault.id, b.user.id, () => t!.ctx.ai.status());
    expect(st.budget).toMatchObject({ monthly_usd: 0, remaining_usd: 0 });
    expect(st.tasks.summarize).toMatchObject({ available: false, reason_ar: QUOTA_AR.aiNotEnabled });
    await expect(asVault(t, b.vault.id, b.user.id, () => t!.ctx.ai.generateStructured(req()))).rejects.toMatchObject({
      code: 'AI_BUDGET_EXCEEDED',
      messageAr: QUOTA_AR.aiNotEnabled,
    });
    expect(p.calls).toBe(0);
    // recorded in B's own vault, not user #1's
    expect(asVault(t, b.vault.id, b.user.id, () => t!.ctx.db.all<{ status: string }>('SELECT status FROM usage_record').map((r) => r.status))).toEqual(['budget_blocked']);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM usage_record')!.n).toBe(0);
    // the API says the same to B
    const h = await b.login();
    const me = (await t.app.inject({ method: 'GET', url: '/api/accounts/me/quota', headers: h })).json();
    expect(me.ai).toMatchObject({ limit_usd: 0, used_usd_est: 0 });
  });

  it('the platform admin sets a cap; calls are reserved, then settled with their estimated cost', async () => {
    const p = new GatedProvider();
    t = await createTestApp({ ai: p, env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '5' } });
    const admin = await t.login();
    const b = await addUser(t, 'student-b');
    const put = await t.app.inject({ method: 'PUT', url: `/api/platform/quotas/users/${b.user.id}`, headers: admin, payload: { ai_monthly_usd: 2 } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().ai).toMatchObject({ limit_usd: 2, explicit: true });
    await asVault(t, b.vault.id, b.user.id, () => t!.ctx.ai.generateStructured(req()));
    const rows = t.ctx.system.db.all<{ status: string; actual_usd: number; user_id: string; space_id: string | null }>('SELECT * FROM ai_budget_ledger');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'settled', user_id: b.user.id, space_id: null });
    expect(rows[0]!.actual_usd).toBeCloseTo(0.0105, 6);
    expect(asVault(t, b.vault.id, b.user.id, () => t!.ctx.ai.budget())).toMatchObject({ monthly_usd: 2, spent_usd: 0.0105 });
    // user #1's own allowance is untouched by B's spending (but the deployment ceiling sees both)
    expect(t.ctx.ai.budget()).toMatchObject({ monthly_usd: 5, spent_usd: 0 });
    // a non-admin cannot see or set quotas (the platform route does not exist for them)
    const hb = await b.login();
    expect((await t.app.inject({ method: 'PUT', url: `/api/platform/quotas/users/${b.user.id}`, headers: hb, payload: { ai_monthly_usd: 100 } })).statusCode).toBe(404);
    // null returns to the default (0 for a student)
    await t.app.inject({ method: 'PUT', url: `/api/platform/quotas/users/${b.user.id}`, headers: admin, payload: { ai_monthly_usd: null } });
    expect(asVault(t, b.vault.id, b.user.id, () => t!.ctx.ai.budget().monthly_usd)).toBe(0);
  });

  it('concurrent reservations never exceed the allowance (only the calls that fit reach the provider)', async () => {
    const p = new GatedProvider({ inputTokens: 1000, outputTokens: 500 }, true);
    t = await createTestApp({ ai: p, env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '50' } });
    const b = await addUser(t, 'student-b');
    // probe the worst case of one call with a generous cap, then set the cap to exactly 3 of them
    t.ctx.system.quotas.setUserInternal(b.user.id, { ai_monthly_usd_limit: 1 }, b.user.id);
    const probe = asVault(t, b.vault.id, b.user.id, () => t!.ctx.ai.generateStructured(req()));
    await new Promise((r) => setImmediate(r));
    const wc = worstCase(t);
    expect(wc).toBeGreaterThan(0.05);
    p.release();
    await probe;
    const spent = 0.0105;
    t.ctx.system.quotas.setUserInternal(b.user.id, { ai_monthly_usd_limit: spent + 3 * wc + 1e-6 }, b.user.id);

    const runs = Array.from({ length: 8 }, () => asVault(t!, b.vault.id, b.user.id, () => t!.ctx.ai.generateStructured(req())).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error'));
    for (let i = 0; i < 10 && p.waiting < 3; i++) await new Promise((r) => setImmediate(r));
    expect(p.waiting).toBe(3); // three reservations fit; the other five were refused before any call
    p.release();
    const results = await Promise.all(runs);
    expect(results.filter((r) => r === 'ok')).toHaveLength(3);
    expect(results.filter((r) => r === 'AI_BUDGET_EXCEEDED')).toHaveLength(5);
    expect(p.calls).toBe(4); // the probe + 3
    // settled at the real (estimated) cost: the unused worst case is free again
    const used = t.ctx.system.aiLedger.usedInternal({ userId: b.user.id }, asVault(t, b.vault.id, b.user.id, () => t!.ctx.quota.aiParty(t!.ctx.binding.current())!.month));
    expect(used.reserved).toBe(0);
    expect(used.settled).toBeCloseTo(4 * spent, 6);
  });

  it('a call that never reached the provider (or cost nothing) gives its reservation back', async () => {
    const p = new GatedProvider(undefined, false, new ProviderError('connection', { retryable: true }));
    t = await createTestApp({ ai: p, env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '5' } });
    await expect(t.ctx.ai.generateStructured(req())).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' });
    const row = t.ctx.system.db.get<{ status: string; actual_usd: number }>('SELECT status, actual_usd FROM ai_budget_ledger')!;
    expect(row).toMatchObject({ status: 'released', actual_usd: 0 });
    expect(t.ctx.ai.budget().spent_usd).toBe(0);
  });

  it('the deployment budget is a ceiling over every account', async () => {
    const p = new GatedProvider();
    t = await createTestApp({ ai: p, env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '0.1' } });
    t.ownerBinding(); // user #1 first
    const b = await addUser(t, 'student-b');
    t.ctx.system.quotas.setUserInternal(b.user.id, { ai_monthly_usd_limit: 10 }, b.user.id);
    // B spends: settled costs of earlier calls this month (0.08 of the 0.1 deployment budget)
    const month = asVault(t, b.vault.id, b.user.id, () => t!.ctx.quota.aiParty(t!.ctx.binding.current())!.month);
    const r = t.ctx.system.aiLedger.reserveInternal({ userId: b.user.id, spaceId: null, month, kind: 'ai', amountUsd: 0.08, limitUsd: 10, outsideLedgerUsd: 0, deploymentLimitUsd: 0.1, deploymentSinceMs: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) t.ctx.system.aiLedger.settleInternal(r.id, 0.08, null);
    // user #1's own allowance (0.1) is unused, but the deployment has 0.02 left: a worst-case call does not fit
    await expect(t.ctx.ai.generateStructured(req())).rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED', messageAr: QUOTA_AR.aiDeployment(0.1) });
    expect(p.calls).toBe(0);
  });

  it('usage recorded before the ledger existed still counts (the single owner\'s month so far)', async () => {
    const p = new GatedProvider();
    t = await createTestApp({ ai: p, env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '0.08' } });
    t.ctx.db.run(`INSERT INTO usage_record (id, task, provider, model, estimated_cost_usd, status, created_at) VALUES ('PRE', 'summarize', 'fake', 'm', 0.05, 'ok', ?)`, [t.clock.now() - 1000]);
    expect(t.ctx.ai.budget()).toMatchObject({ monthly_usd: 0.08, spent_usd: 0.05 });
    await expect(t.ctx.ai.generateStructured(req())).rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED' });
    expect(p.calls).toBe(0);
  });

  it('stale reservations (a stopped process) are released at boot', async () => {
    const p = new GatedProvider();
    t = await createTestApp({ ai: p });
    const owner = t.ctx.system.users.firstUserIdInternal() ?? (t.ownerBinding() as Extract<Binding, { kind: 'vault' }>).viewer!.userId;
    t.ctx.system.db.run(`INSERT INTO ai_budget_ledger (id, user_id, month, kind, reserved_usd, status, created_at) VALUES ('stale', ?, '2026-10', 'ai', 3, 'reserved', ?)`, [owner, t.clock.now() - 2 * 60 * 60 * 1000]);
    t.ctx.system.db.run(`INSERT INTO ai_budget_ledger (id, user_id, month, kind, reserved_usd, status, created_at) VALUES ('fresh', ?, '2026-10', 'ai', 3, 'reserved', ?)`, [owner, t.clock.now() - 60 * 1000]);
    expect(t.ctx.system.aiLedger.releaseStaleInternal(t.clock.now() - 60 * 60 * 1000)).toBe(1);
    expect(t.ctx.system.aiLedger.getInternal('stale')!.status).toBe('released');
    expect(t.ctx.system.aiLedger.getInternal('fresh')!.status).toBe('reserved');
  });
});

describe('per-space allowance', () => {
  it('work bound to a subject space is charged to the space (0 until set), never to the student', async () => {
    const p = new GatedProvider();
    t = await createTestApp({ ai: p, env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '5' } });
    const owner = t.ctx.system.users.findForAuth('owner') ?? null;
    t.ownerBinding();
    const ownerId = owner?.id ?? t.ctx.system.users.firstUserIdInternal()!;
    const spaceId = 'space01';
    const dbFile = t.ctx.pool.createFile('space', spaceId);
    t.ctx.system.vaults.registerSpaceInternal({ id: spaceId, title: 'Anatomy', dbFile });
    const inSpace = <T>(fn: () => T): T =>
      t!.ctx.binding.run({ kind: 'space', spaceId, subjectNodeId: 'n1', viewer: { userId: ownerId, deviceId: null, isPlatformAdmin: true }, access: 'moderator', route: null }, fn);
    await expect(inSpace(() => t!.ctx.ai.generateStructured(req()))).rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED', messageAr: QUOTA_AR.aiSpaceNotEnabled });
    t.ctx.system.quotas.setSpaceInternal(spaceId, { ai_monthly_usd_limit: 1 }, ownerId);
    await inSpace(() => t!.ctx.ai.generateStructured(req()));
    const rows = t.ctx.system.db.all<{ space_id: string | null; user_id: string; status: string }>(`SELECT space_id, user_id, status FROM ai_budget_ledger WHERE status = 'settled'`);
    expect(rows).toEqual([{ space_id: spaceId, user_id: ownerId, status: 'settled' }]);
    expect(t.ctx.ai.budget().spent_usd).toBe(0); // the user's own allowance was not charged
  });
});
