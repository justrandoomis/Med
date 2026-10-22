// AOS-21.42 (PRD NFR-PR1; ARCHITECTURE_DELTA §5.6) — no user content goes to an AI provider outside the deployment
// before that user's `ai_processing` consent NAMING the provider is recorded (system `consent_record`).
//   * without it: CONSENT_REQUIRED (409, details.kind = 'ai_processing') BEFORE anything is sent or reserved, and
//     `/api/ai/status` reports every task unavailable with the reason;
//   * PUT /api/accounts/me/ai-consent records it (the exact text version, the provider), one active row per user,
//     audited; withdrawing stops the next send at once;
//   * per user: one account's consent never covers another;
//   * official content processed in a subject space is not a user's content (not gated);
//   * a provider that runs inside the deployment (no data leaves) is not gated; the Anthropic adapter declares that
//     its data leaves the deployment.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AI_CONSENT_TEXT_VERSION, type AiConsentView, type AiStatusResponse, type AiTask, type ResolvedScope } from '@medlevo/shared';
import { AnthropicProvider } from '../../src/modules/ai/providers';
import type { AiProvider, ProviderRequest, ProviderResponse, ProviderUsage } from '../../src/modules/ai/types';
import { createTestApp, CSRF, type TestApp } from '../helpers/app';
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
const req = () => ({ task: 'summarize' as const, schema, system: 'Summarize.', input: [{ label: 'p1', text: 'PRIVATE NOTE TEXT 7731' }], scope, sourceVersionIds: ['V1'] });

/** A provider standing for a hosted API (its data leaves the deployment), or a local one. Records what it was sent. */
class RecordingProvider implements AiProvider {
  readonly calls: ProviderRequest[] = [];
  constructor(
    readonly name: string,
    readonly dataLeavesDeployment: boolean | undefined,
  ) {}
  supports(_t: AiTask): boolean {
    return true;
  }
  modelFor(): string {
    return 'rec-1';
  }
  estimateCostUsd(_m: string, u: ProviderUsage): number {
    return (u.inputTokens * 3 + u.outputTokens * 15) / 1_000_000;
  }
  async generateStructured(r: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(r);
    return { model: 'rec-1', usage: { inputTokens: 100, outputTokens: 50 }, json: { summary: 'ok' } };
  }
}

async function appWith(p: AiProvider) {
  t = await createTestApp({ ai: p });
  const owner = await t.login();
  return { t, owner };
}

const consentOf = async (app: TestApp, headers: Record<string, string>) => {
  const res = await app.app.inject({ method: 'GET', url: '/api/accounts/me/ai-consent', headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AiConsentView;
};
const putConsent = (app: TestApp, headers: Record<string, string>, payload: unknown) =>
  app.app.inject({ method: 'PUT', url: '/api/accounts/me/ai-consent', headers: { ...headers, ...CSRF }, payload: payload as object });

describe('AOS-21.42 — ai_processing consent before any content leaves for an AI provider', () => {
  it('without consent: CONSENT_REQUIRED before anything is sent or reserved; status says why', async () => {
    const p = new RecordingProvider('anthropic', true);
    const { t: app, owner } = await appWith(p);
    await expect(app.ctx.ai.generateStructured(req())).rejects.toMatchObject({ code: 'CONSENT_REQUIRED', status: 409, details: { kind: 'ai_processing', provider: 'anthropic' } });
    expect(p.calls).toHaveLength(0);
    expect(app.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ai_budget_ledger')!.n).toBe(0);
    const st = (await app.app.inject({ method: 'GET', url: '/api/ai/status', headers: owner })).json() as AiStatusResponse;
    expect(st.tasks.summarize.available).toBe(false);
    expect(st.tasks.summarize.reason_ar).toContain('موافقتك');
    const v = await consentOf(app, owner);
    expect(v).toMatchObject({ kind: 'ai_processing', granted: false, providers: [], provider: { id: 'anthropic', leaves_deployment: true }, current_text_version: AI_CONSENT_TEXT_VERSION });
    expect(v.text_ar.join(' ')).toContain('Anthropic');
  });

  it('recording the consent (current text, the configured provider) lets the call go; withdrawing stops the next one', async () => {
    const p = new RecordingProvider('anthropic', true);
    const { t: app, owner } = await appWith(p);
    // a stale text version, or another provider than the configured one, is refused (nothing recorded)
    expect((await putConsent(app, owner, { granted: true, provider: 'anthropic', text_version: 'ai-processing-old' })).statusCode).toBe(409);
    expect((await putConsent(app, owner, { granted: true, provider: 'someone-else', text_version: AI_CONSENT_TEXT_VERSION })).statusCode).toBe(409);
    expect(app.ctx.system.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM consent_record`)!.n).toBe(0);

    const ok = await putConsent(app, owner, { granted: true, provider: 'anthropic', text_version: AI_CONSENT_TEXT_VERSION });
    expect(ok.statusCode, ok.body).toBe(200);
    const view = ok.json() as AiConsentView;
    expect(view).toMatchObject({ granted: true, providers: ['anthropic'], text_version: AI_CONSENT_TEXT_VERSION });
    const ownerId = app.ctx.system.users.findForAuth('owner')!.id;
    const rows = app.ctx.system.db.all<{ kind: string; subject_user_id: string; recorded_by: string; scope_json: string; text_version: string; revoked_at: number | null }>(
      `SELECT kind, subject_user_id, recorded_by, scope_json, text_version, revoked_at FROM consent_record`,
    );
    expect(rows).toEqual([{ kind: 'ai_processing', subject_user_id: ownerId, recorded_by: ownerId, scope_json: JSON.stringify({ providers: ['anthropic'] }), text_version: AI_CONSENT_TEXT_VERSION, revoked_at: null }]);
    expect(app.ctx.system.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM security_audit WHERE action = 'consent_grant' AND actor_user_id = ?`, [ownerId])!.n).toBe(1);

    await expect(app.ctx.ai.generateStructured(req())).resolves.toMatchObject({ output: { summary: 'ok' } });
    expect(p.calls).toHaveLength(1);
    const st = (await app.app.inject({ method: 'GET', url: '/api/ai/status', headers: owner })).json() as AiStatusResponse;
    expect(st.tasks.summarize.available).toBe(true);

    // granting again keeps ONE active row
    expect((await putConsent(app, owner, { granted: true, provider: 'anthropic', text_version: AI_CONSENT_TEXT_VERSION })).statusCode).toBe(200);
    expect(app.ctx.system.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM consent_record WHERE revoked_at IS NULL`)!.n).toBe(1);

    const off = await putConsent(app, owner, { granted: false });
    expect(off.statusCode, off.body).toBe(200);
    expect((off.json() as AiConsentView).granted).toBe(false);
    expect((off.json() as AiConsentView).history.length).toBeGreaterThanOrEqual(1);
    await expect(app.ctx.ai.generateStructured(req())).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(p.calls).toHaveLength(1);
  });

  it("one user's consent never covers another user's content", async () => {
    const p = new RecordingProvider('anthropic', true);
    const { t: app, owner } = await appWith(p);
    expect((await putConsent(app, owner, { granted: true, provider: 'anthropic', text_version: AI_CONSENT_TEXT_VERSION })).statusCode).toBe(200);
    const sara = await addUser(app, 'sara');
    app.ctx.system.quotas.setUserInternal(sara.user.id, { ai_monthly_usd_limit: 5 }, sara.user.id);
    const vaultId = app.ctx.system.vaults.ofUserInternal(sara.user.id)!.id;
    const asSara = <T>(fn: () => T) => app.ctx.binding.run({ kind: 'vault', vaultId, viewer: { userId: sara.user.id, deviceId: null, isPlatformAdmin: false } }, fn);
    await expect(asSara(() => app.ctx.ai.generateStructured(req()))).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    // background work in her vault (no viewer) is her content too
    await expect(app.ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, () => app.ctx.ai.generateStructured(req()))).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(p.calls).toHaveLength(0);
    const sh = await sara.login();
    expect((await consentOf(app, sh)).granted).toBe(false);
    expect((await putConsent(app, sh, { granted: true, provider: 'anthropic', text_version: AI_CONSENT_TEXT_VERSION })).statusCode).toBe(200);
    await expect(asSara(() => app.ctx.ai.generateStructured(req()))).resolves.toBeTruthy();
  });

  it('official content in a subject space is not a user content: no user consent needed there', async () => {
    const p = new RecordingProvider('anthropic', true);
    const { t: app } = await appWith(p);
    const dbFile = app.ctx.pool.createFile('space', 'SPACEC');
    app.ctx.system.vaults.registerSpaceInternal({ id: 'SPACEC', title: 'Anatomy', dbFile });
    app.ctx.system.quotas.setSpaceInternal('SPACEC', { ai_monthly_usd_limit: 5 }, app.ctx.system.users.findForAuth('owner')!.id);
    await expect(
      app.ctx.binding.run({ kind: 'space', spaceId: 'SPACEC', subjectNodeId: 'N', viewer: null, access: 'moderator', route: null }, () => app.ctx.ai.generateStructured(req())),
    ).resolves.toBeTruthy();
    expect(p.calls).toHaveLength(1);
  });

  it('a provider inside the deployment (no data leaves) is not gated; the Anthropic adapter declares that its data leaves', async () => {
    const p = new RecordingProvider('local-model', undefined);
    const { t: app, owner } = await appWith(p);
    await expect(app.ctx.ai.generateStructured(req())).resolves.toBeTruthy();
    expect((await consentOf(app, owner)).provider).toMatchObject({ id: 'local-model', leaves_deployment: false });
    expect(new AnthropicProvider({ apiKey: 'sk-test-not-a-key', models: { generation: null, verification: null, vision: null } }).dataLeavesDeployment).toBe(true);
  });

  it('no provider configured: the view says nothing is sent anywhere, and a grant is refused', async () => {
    t = await createTestApp({ ai: null });
    const owner = await t.login();
    const v = await consentOf(t, owner);
    expect(v.provider).toBeNull();
    expect(v.granted).toBe(false);
    expect((await putConsent(t, owner, { granted: true, provider: 'anthropic', text_version: AI_CONSENT_TEXT_VERSION })).statusCode).toBe(409);
  });
});
