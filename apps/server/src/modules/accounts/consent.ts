// «معالجة الذكاء الاصطناعي» — the signed-in user's own ai_processing consent (AOS-21.42; IA §4.14).
//   GET /api/accounts/me/ai-consent  → AiConsentView (the configured provider, whether it leaves the deployment, the
//                                      current consent text and its version, my active consent and my history)
//   PUT /api/accounts/me/ai-consent  {granted:true, provider, text_version} | {granted:false} → AiConsentView
// Only the viewer's own consent is ever read or written (the system repository takes the viewer). A grant must name
// the provider configured now and the consent text version shown now (409 otherwise — nothing recorded); granting
// again replaces the active row; withdrawing stops every further send at once (modules/ai/consent.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AI_CONSENT_AR,
  AI_CONSENT_TEXT_VERSION,
  aiConsentPutSchema,
  aiConsentTextAr,
  type AiConsentView,
  aiProviderLabelAr,
  DATA_POLICY_VERSION,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { parseBody } from '../../lib/http';
import type { Viewer } from '../../system/binding';

function viewerOf(req: FastifyRequest): Viewer {
  if (!req.viewer) throw new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401);
  return req.viewer;
}

export function aiConsentView(ctx: AppContext, v: Viewer): AiConsentView {
  const providerId = ctx.ai.providerName;
  const provider = providerId ? { id: providerId, label_ar: aiProviderLabelAr(providerId), leaves_deployment: ctx.ai.providerLeavesDeployment === true } : null;
  const active = ctx.system.consents.aiProcessing(v);
  const history = ctx.system.consents.history(v, 'ai_processing').map((r) => {
    const scope = fromJson<{ providers?: unknown }>(r.scope_json, {}) ?? {};
    return {
      providers: Array.isArray(scope.providers) ? scope.providers.filter((p): p is string => typeof p === 'string') : [],
      text_version: r.text_version,
      granted_at: r.granted_at,
      revoked_at: r.revoked_at,
    };
  });
  return {
    kind: 'ai_processing',
    provider,
    granted: !!(active && providerId && active.providers.includes(providerId)),
    providers: active?.providers ?? [],
    granted_at: active?.grantedAt ?? null,
    text_version: active?.textVersion ?? null,
    current_text_version: AI_CONSENT_TEXT_VERSION,
    text_ar: aiConsentTextAr(provider?.label_ar ?? 'مزوّد الذكاء الاصطناعي'),
    history,
    policy_version: DATA_POLICY_VERSION,
  };
}

export function registerAiConsentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/me/ai-consent', async (req): Promise<AiConsentView> => aiConsentView(ctx, viewerOf(req)));

  app.put('/me/ai-consent', { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (req): Promise<AiConsentView> => {
    const v = viewerOf(req);
    const body = parseBody(aiConsentPutSchema, req);
    if (body.granted) {
      const providerId = ctx.ai.providerName;
      if (!providerId) throw new AppError('CONFLICT', AI_CONSENT_AR.noProvider, 409);
      if (body.provider !== providerId) throw new AppError('CONFLICT', AI_CONSENT_AR.wrongProvider, 409, { provider: providerId });
      if (body.text_version !== AI_CONSENT_TEXT_VERSION) throw new AppError('CONFLICT', AI_CONSENT_AR.staleText, 409, { current_text_version: AI_CONSENT_TEXT_VERSION });
      ctx.system.consents.grantAiProcessing(v, [providerId], AI_CONSENT_TEXT_VERSION);
      ctx.system.securityAudit.record({
        actorUserId: v.userId,
        actorRole: 'self',
        action: 'consent_grant',
        targetType: 'consent',
        targetId: 'ai_processing',
        summary: `موافقة على معالجة الذكاء الاصطناعي لدى ${aiProviderLabelAr(providerId)}`,
        details: { kind: 'ai_processing', providers: [providerId], text_version: AI_CONSENT_TEXT_VERSION },
        ip: req.ip ?? null,
      });
    } else {
      const n = ctx.system.consents.revokeAiProcessing(v);
      if (n > 0) {
        ctx.system.securityAudit.record({ actorUserId: v.userId, actorRole: 'self', action: 'consent_revoke', targetType: 'consent', targetId: 'ai_processing', summary: 'سحب الموافقة على معالجة الذكاء الاصطناعي', ip: req.ip ?? null });
      }
    }
    return aiConsentView(ctx, v);
  });
}
