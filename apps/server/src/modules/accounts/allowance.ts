// AOS-21.46 — the visible remaining AI allowance (server side; «الاستهلاك» shows it). The account's own QuotaView
// (system/quota.ts: storage, AI used / limit / remaining / resets_at) plus:
//   * blocked_reason_ar — null when an AI call may be tried now, else the reason every task is refused before any call
//     (no provider, no ai_processing consent, allowance 0 or spent, the deployment ceiling) — the orchestrator's own
//     status for this binding, so the screen and the refusal always say the same thing;
//   * ai_spaces — the allowance of each subject the viewer MODERATES (gate-2 «moderator» access in that subject; a
//     member never sees a subject's budget).
// Runs inside the request's own vault binding.
import type { QuotaView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Viewer } from '../../system/binding';

export function quotaViewFor(ctx: AppContext, v: Viewer): QuotaView {
  const q = ctx.quota.view(v);
  const st = ctx.ai.status();
  const tasks = Object.values(st.tasks);
  const blocked = tasks.some((t) => t.available) ? null : (st.tasks.summarize?.reason_ar ?? tasks.find((t) => t.reason_ar)?.reason_ar ?? 'الذكاء الاصطناعي غير متاح الآن.');
  const spaces = ctx.system.vaults
    .listSpacesInternal()
    .filter((s) => s.status === 'active' || s.status === 'read_only')
    .filter((s) => {
      try {
        const m = ctx.authz.memberships.accessToSpace(v, s.id);
        return !!m && !m.pending && m.access === 'moderator';
      } catch {
        return false;
      }
    })
    .map((s) => ctx.quota.spaceAiView(s.id, s.title));
  return { ...q, ai: { ...q.ai, blocked_reason_ar: blocked }, ai_spaces: spaces };
}
