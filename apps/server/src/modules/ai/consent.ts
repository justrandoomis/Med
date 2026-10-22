// The ai_processing consent gate (AOS-21.42; PRD NFR-PR1; ARCHITECTURE_DELTA §5.6). Before the orchestrator sends
// anything to a provider whose data LEAVES the deployment (`AiProvider.dataLeavesDeployment`), the user whose content
// the call carries must have an active `ai_processing` consent naming that provider (system `consent_record`).
//
// Whose content: a call bound to a VAULT carries that vault user's content (the request's viewer, or — background
// work — the vault's owner). A call bound to a subject SPACE processes the subject's official content, which is not a
// user's private content (and lecture audio stays gated by the subject's lecturer policy, Phase 3). Outside any database
// nothing is sent (the orchestrator has no party then).
import { AI_CONSENT_AR, AI_CONSENT_TEXT_VERSION, aiProviderLabelAr } from '@medlevo/shared';
import { AppError } from '../../lib/errors';
import type { TenantBinding } from '../../system/binding';
import type { SystemRepos } from '../../system/repos';
import type { AiProvider } from './types';

/** Why a call made outside every user's and subject's database is not sent (C1 review). */
export const AI_CONSENT_NO_OWNER_AR = 'لا يُرسل شيء إلى مزوّد ذكاء اصطناعي خارجي من خارج حساب مستخدم أو مساحة مادة: لا توجد موافقة تغطيه.';

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
    // C1 review: a consent covers the text it was given to — after the consent text changes, the user agrees again
    if (consent && consent.providers.includes(provider.name) && consent.textVersion === AI_CONSENT_TEXT_VERSION) return null;
    return AI_CONSENT_AR.required(aiProviderLabelAr(provider.name));
  }

  /** Throws CONSENT_REQUIRED (409, details.kind = 'ai_processing') when the call may not be made. */
  assert(provider: AiProvider): void {
    // C1 review: outside every user's and every subject's database (the root context of background work, or no context
    // at all) there is nobody whose consent covers the content — the gate failed OPEN there while the budget fell back
    // to the deployment ceiling, and the provider was called before usage recording threw NO_TENANT_BOUND. Nothing
    // leaves the deployment from there.
    if (provider.dataLeavesDeployment === true) {
      const b = this.binding.current() ?? this.binding.harnessDefault();
      if (!b || b.kind === 'root') throw new AppError('CONSENT_REQUIRED', AI_CONSENT_NO_OWNER_AR, 409, { kind: 'ai_processing', provider: provider.name });
    }
    const reason = this.blockedReason(provider);
    if (reason) throw new AppError('CONSENT_REQUIRED', reason, 409, { kind: 'ai_processing', provider: provider.name });
  }
}
