// AOS-21.46 — the server side of the VISIBLE remaining AI allowance (the «الاستهلاك» screen shows it; track C3).
// GET /api/accounts/me/quota (and /api/accounts/me) answer, for the signed-in account:
//   * ai.remaining_usd — what may still be spent this month: the smaller of the account's allowance left and the
//     deployment ceiling left (ESTIMATED, the same numbers the atomic reservation checks);
//   * ai.resets_at — when the month's allowance starts again (the account's own timezone);
//   * ai.blocked_reason_ar — null when a call may be tried, else why AI is refused before any call;
//   * ai_spaces — the AI allowance of each subject the viewer MODERATES (members never see a subject's budget).
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AiTask, QuotaView, ResolvedScope } from '@medlevo/shared';
import type { SubjectMembership } from '../../src/modules/authz/rules/lectures';
import type { AiProvider, ProviderRequest, ProviderResponse, ProviderUsage } from '../../src/modules/ai/types';
import { startOfMonthInTz } from '../../src/lib/time';
import { createTestApp, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const scope: ResolvedScope = { mode: 'lecture_only', sourceIds: ['S1'], versionIds: ['V1'], versionBySource: { S1: 'V1' }, allowExternal: false, includeMyNotes: false, hash: 'h', describeAr: 'x' };
const req = () => ({ task: 'summarize' as const, schema: z.object({ summary: z.string() }), system: 's', input: [{ label: 'p', text: 't' }], scope, sourceVersionIds: ['V1'] });

class Provider implements AiProvider {
  readonly name = 'p1';
  supports(_t: AiTask) {
    return true;
  }
  modelFor() {
    return 'm';
  }
  estimateCostUsd(_m: string, u: ProviderUsage) {
    return (u.inputTokens * 3 + u.outputTokens * 15) / 1_000_000;
  }
  async generateStructured(_r: ProviderRequest): Promise<ProviderResponse> {
    return { model: 'm', usage: { inputTokens: 10_000, outputTokens: 10_000 }, json: { summary: 'ok' } }; // $0.18
  }
}

const quotaOf = async (app: TestApp, headers: Record<string, string>) => {
  const res = await app.app.inject({ method: 'GET', url: '/api/accounts/me/quota', headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as QuotaView;
};

describe('AOS-21.46 — the visible remaining AI allowance (server)', () => {
  it('user #1: remaining = allowance − estimated spending; resets at the next month; nothing blocks', async () => {
    t = await createTestApp({ ai: new Provider(), env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '2' } });
    const owner = await t.login();
    await t.ctx.ai.generateStructured(req());
    const q = await quotaOf(t, owner);
    expect(q.ai.limit_usd).toBe(2);
    expect(q.ai.used_usd_est).toBeCloseTo(0.18, 6);
    expect(q.ai.remaining_usd).toBeCloseTo(1.82, 6);
    expect(q.ai.blocked_reason_ar).toBeNull();
    const now = t.ctx.clock.now();
    expect(q.ai.resets_at).toBe(startOfMonthInTz(startOfMonthInTz(now, t.config.timezone) + 32 * 86_400_000, t.config.timezone));
    expect(q.ai.resets_at!).toBeGreaterThan(now);
    // /api/accounts/me carries the same view
    const me = (await t.app.inject({ method: 'GET', url: '/api/accounts/me', headers: owner })).json() as { quota: QuotaView };
    expect(me.quota.ai.remaining_usd).toBeCloseTo(1.82, 6);
  });

  it('another account starts at 0: remaining 0 and the reason, before any call', async () => {
    t = await createTestApp({ ai: new Provider() });
    await t.login();
    const sara = await addUser(t, 'sara');
    const q = await quotaOf(t, await sara.login());
    expect(q.ai.limit_usd).toBe(0);
    expect(q.ai.remaining_usd).toBe(0);
    expect(q.ai.blocked_reason_ar).toMatch(/غير مُفعّل لحسابك/);
  });

  it('the deployment ceiling caps what remains (allowance 5 $, deployment 1 $)', async () => {
    t = await createTestApp({ ai: new Provider(), env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '1' } });
    await t.login();
    const sara = await addUser(t, 'sara');
    t.ctx.system.quotas.setUserInternal(sara.user.id, { ai_monthly_usd_limit: 5 }, sara.user.id);
    const q = await quotaOf(t, await sara.login());
    expect(q.ai.limit_usd).toBe(5);
    expect(q.ai.remaining_usd).toBeLessThanOrEqual(1);
    expect(q.ai.remaining_usd).toBeGreaterThan(0.5);
  });

  it('no provider configured: the reason says so (no number pretends AI is usable)', async () => {
    t = await createTestApp({ ai: null });
    const q = await quotaOf(t, await t.login());
    expect(q.ai.blocked_reason_ar).toMatch(/غير مفعّلة/);
  });

  it("a subject's AI allowance is shown to its moderators only", async () => {
    t = await createTestApp({ ai: new Provider() });
    const owner = await t.login();
    const mod = await addUser(t, 'mod');
    const student = await addUser(t, 'student');
    const dbFile = t.ctx.pool.createFile('space', 'SPACEQ');
    t.ctx.system.vaults.registerSpaceInternal({ id: 'SPACEQ', title: 'Anatomy', dbFile });
    const ownerId = t.ctx.system.users.findForAuth('owner')!.id;
    t.ctx.system.quotas.setSpaceInternal('SPACEQ', { ai_monthly_usd_limit: 3 }, ownerId);
    const access = new Map<string, SubjectMembership>([
      [`${mod.user.id}/SPACEQ`, { subjectNodeId: 'N1', access: 'moderator', roles: ['subject_moderator'] }],
      [`${student.user.id}/SPACEQ`, { subjectNodeId: 'N1', access: 'member', roles: [] }],
    ]);
    t.ctx.authz.setMembershipProvider({ accessToSpace: (v, s) => access.get(`${v.userId}/${s}`) ?? null });
    // one call charged to the subject
    await t.ctx.binding.run({ kind: 'space', spaceId: 'SPACEQ', subjectNodeId: 'N1', viewer: { userId: mod.user.id, deviceId: null, isPlatformAdmin: false }, access: 'moderator', route: null }, () =>
      t!.ctx.ai.generateStructured(req()),
    );
    const qm = await quotaOf(t, await mod.login());
    expect(qm.ai_spaces).toEqual([
      expect.objectContaining({ space_id: 'SPACEQ', title: 'Anatomy', limit_usd: 3, used_usd_est: expect.closeTo(0.18, 6), remaining_usd: expect.closeTo(2.82, 6) }),
    ]);
    expect((await quotaOf(t, await student.login())).ai_spaces ?? []).toEqual([]);
    // the owner holds no role in that subject here (the test provider says so): nothing listed
    expect((await quotaOf(t, owner)).ai_spaces ?? []).toEqual([]);
  });
});
