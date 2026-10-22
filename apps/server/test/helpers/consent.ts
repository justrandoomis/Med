// AOS-21.42: record a user's ai_processing consent naming a provider, as «أوافق» on /me/privacy does — for tests that
// drive a provider whose data leaves the deployment (the real Anthropic adapter against a mocked HTTP endpoint).
import { AI_CONSENT_TEXT_VERSION } from '@medlevo/shared';
import type { TestApp } from './app';

export function grantAiConsent(t: TestApp, provider = 'anthropic', userId?: string): void {
  const id = userId ?? (t.ownerBinding() as { viewer: { userId: string } | null }).viewer!.userId;
  t.ctx.system.consents.grantAiProcessing({ userId: id, deviceId: null, isPlatformAdmin: false }, [provider], AI_CONSENT_TEXT_VERSION);
}
