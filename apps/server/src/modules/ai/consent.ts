// The ai_processing consent gate (AOS-21.42; PRD NFR-PR1; ARCHITECTURE_DELTA §5.6). Before the orchestrator sends
// anything to a provider whose data LEAVES the deployment (`AiProvider.dataLeavesDeployment`), the user whose content
// the call carries must have an active `ai_processing` consent naming that provider (system `consent_record`).
//
// Whose content: a call bound to a VAULT carries that vault user's content (the request's viewer, or — background
// work — the vault's owner). A call bound to a subject SPACE processes the subject's official content, which is not a
// user's private content (and lecture audio stays gated by the subject's lecturer policy, Phase 3). Outside any database
// nothing is sent (the orchestrator has no party then).
import { AI_CONSENT_AR, aiProviderLabelAr } from '@medlevo/shared';
import { AppError } from '../../lib/errors';
import type { TenantBinding } from '../../system/binding';
import type { SystemRepos } from '../../system/repos';
import type { AiProvider } from './types';

export class AiConsentGate {
  constructor(
    private readonly system: SystemRepos,
    private readonly binding: TenantBinding,
  ) {}

  /** The user whose content a call bound right now would carry (null: a space, or no database). */
  contentOwner(): string | null {
    const b = this.binding.current() ?? this.binding.harnessDefault();
    if (!b || b.kind !== 'vault') return null;
    return b.viewer?.userId ?? this.system.vaults.byIdInternal(b.vaultId)?.user_id ?? null;
  }

  /** The Arabic reason a call to `provider` may not be made now, or null. */
  blockedReason(provider: AiProvider | null): string | null {
    if (!provider || provider.dataLeavesDeployment !== true) return null;
    const userId = this.contentOwner();
    if (!userId) return null;
    const consent = this.system.consents.aiProcessingOfUserInternal(userId);
    if (consent && consent.providers.includes(provider.name)) return null;
    return AI_CONSENT_AR.required(aiProviderLabelAr(provider.name));
  }

  /** Throws CONSENT_REQUIRED (409, details.kind = 'ai_processing') when the call may not be made. */
  assert(provider: AiProvider): void {
    const reason = this.blockedReason(provider);
    if (reason) throw new AppError('CONSENT_REQUIRED', reason, 409, { kind: 'ai_processing', provider: provider.name });
  }
}
