// AOS-21.46 — review of track C1 (2026-10-22): `ai_spaces` on /api/accounts/me and /me/quota listed every subject the
// viewer had gate-2 «moderator» access to. The platform admin has that access to EVERY subject (channels/access.ts),
// so each /me of the admin opened every subject's database (spaceAiView reads its usage_record) — hundreds of SQLite
// files per page load on a real deployment — and listed subjects the admin holds no role in (their allowances are on
// the platform quota screen). Now a subject is listed only where the viewer holds a moderating ROLE (admin, assistant,
// subject moderator) in it.
import { afterEach, describe, expect, it } from 'vitest';
import type { AiTask, QuotaView } from '@medlevo/shared';
import type { SubjectMembership } from '../../src/modules/authz/rules/lectures';
import type { AiProvider, ProviderRequest, ProviderResponse, ProviderUsage } from '../../src/modules/ai/types';
import { createTestApp, type TestApp } from '../helpers/app';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

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
    return { model: 'm', usage: { inputTokens: 10, outputTokens: 10 }, json: { summary: 'ok' } };
  }
}

describe('AOS-21.46 (review) — the subjects listed in ai_spaces are the ones the viewer moderates by role', () => {
  it("the platform admin's blanket access does not list (or open) every subject; a role held there does", async () => {
    t = await createTestApp({ ai: new Provider() });
    const owner = await t.login();
    const ownerId = t.ctx.system.users.findForAuth('owner')!.id;
    for (const id of ['SPACE1', 'SPACE2', 'SPACE3']) t.ctx.system.vaults.registerSpaceInternal({ id, title: `Subject ${id}`, dbFile: t.ctx.pool.createFile('space', id) });
    // as channels/access.ts answers for the platform admin: «moderator» in every subject; a role only in SPACE2
    const access = (spaceId: string): SubjectMembership => ({ subjectNodeId: `N-${spaceId}`, access: 'moderator', roles: spaceId === 'SPACE2' ? ['subject_moderator'] : [] });
    t.ctx.authz.setMembershipProvider({ accessToSpace: (v, s) => (v.userId === ownerId ? access(s) : null) });
    const res = await t.app.inject({ method: 'GET', url: '/api/accounts/me/quota', headers: owner });
    expect(res.statusCode, res.body).toBe(200);
    expect(((res.json() as QuotaView).ai_spaces ?? []).map((s) => s.space_id)).toEqual(['SPACE2']);
  });
});
