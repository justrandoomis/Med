// Authz rules of the channel resources (P1-T4 step 1; ARCHITECTURE_DELTA §5.3, PRD §4.3). Registered by the channels
// module from its own plugin (`registerChannelRules`): the policy core never changes to add them.
//
//   channel_node (id '' = the virtual root above the universities):
//     view, list                       every signed-in user (titles only, §7.3)
//     create, edit, delete, assign_role platform admin, Admin here or above          (else 403: the node is visible)
//     manage_members, manage_codes      platform admin, Admin or Assistant here or above
//     view_audit                        platform admin, Admin or Assistant here or above (the scoped audit view, step 2)
//     view_stats                        the same, plus a Subject Moderator on a SUBJECT («own subject (aggregates)», §5.3;
//                                       review P1-T4 step 1 N6 — no route consumes it before Phase 2)
//     moderate                          platform admin, Admin / Assistant / Subject Moderator here or above (the report
//                                       queue and moderation actions, step 2); anyone else → 404 («moderators of that
//                                       scope only; anyone else 404», moderation-api.ts)
//     follow                            a subject the viewer may enter (member / role / platform admin);
//                                       403 MEMBERSHIP_PENDING while a request waits, 403 MEMBERSHIP_REQUIRED otherwise
//     root: view/list everyone, create (a university) the platform admin only (PRD Q4)
//   space (the subject's shared store):
//     view, list                        whoever gate 2 lets in (member, role, platform admin); pending → 403
//                                       MEMBERSHIP_PENDING; anyone else → 404
//     moderate                          a moderating role (Admin / Assistant / Subject Moderator here or above) or the
//                                       platform admin; a member → 403; anyone else → 404
// Every other action abstains (deny by default → 404), so P1-T5 can register its own `space` actions (attachments,
// exam dates: `publish`) without meeting a deny of this file. «Below Admin» (an Admin never grants or revokes the
// Admin role) is a property of the role, not of the node: modules/channels/service.ts checks it.
import type { Viewer } from '../../../system/binding';
import { ChannelAccess, MODERATING_ROLES } from '../../channels/access';
import { type Action, ALLOW, type Authz, type Decision, forbidden, HIDDEN, type Resource } from '../policy';

export const CHANNEL_ROOT_ID = '';

const NOT_YOURS_AR = 'لا تملك صلاحية هذا الإجراء في هذه القناة.';
const PENDING_AR = 'طلب انضمامك إلى هذه المادة بانتظار الموافقة.';
const JOIN_FIRST_AR = 'انضم إلى المادة أولًا لتتمكن من هذا.';

export function channelNodeDecision(access: ChannelAccess, viewer: Viewer, action: Action, id: string): Decision | null {
  if (id === CHANNEL_ROOT_ID) {
    if (action === 'view' || action === 'list') return ALLOW;
    if (action === 'create') return viewer.isPlatformAdmin ? ALLOW : forbidden('إنشاء جامعة جديدة من صلاحية مسؤول المنصة فقط.');
    return null;
  }
  const e = access.effective(viewer, id);
  if (!e) return HIDDEN;
  const pa = viewer.isPlatformAdmin;
  switch (action) {
    case 'view':
    case 'list':
      return ALLOW;
    case 'create':
    case 'edit':
    case 'delete':
    case 'assign_role':
      return pa || ChannelAccess.hasRole(e, ['admin']) ? ALLOW : forbidden(NOT_YOURS_AR);
    case 'manage_members':
    case 'manage_codes':
      return pa || ChannelAccess.hasRole(e, ['admin', 'assistant']) ? ALLOW : forbidden(NOT_YOURS_AR);
    case 'view_audit':
      return pa || ChannelAccess.hasRole(e, ['admin', 'assistant']) ? ALLOW : forbidden(NOT_YOURS_AR);
    case 'view_stats':
      return pa || ChannelAccess.hasRole(e, ['admin', 'assistant']) || (e.node.kind === 'subject' && ChannelAccess.hasRole(e, ['subject_moderator'])) ? ALLOW : forbidden(NOT_YOURS_AR);
    case 'moderate':
      return pa || ChannelAccess.hasRole(e, MODERATING_ROLES) ? ALLOW : HIDDEN;
    case 'follow': {
      if (e.node.kind !== 'subject') return forbidden('المتابعة للمواد فقط.');
      const s = ChannelAccess.subjectAccess(e);
      if (s && !s.pending) return ALLOW;
      if (s?.pending) return forbidden(PENDING_AR, 'MEMBERSHIP_PENDING');
      return forbidden(JOIN_FIRST_AR, 'MEMBERSHIP_REQUIRED');
    }
    default:
      return null;
  }
}

export function spaceDecision(access: ChannelAccess, viewer: Viewer, action: Action, spaceId: string): Decision | null {
  if (action !== 'view' && action !== 'list' && action !== 'moderate') return null;
  const s = access.accessToSpace(viewer, spaceId);
  if (!s) return HIDDEN;
  if (s.pending) return forbidden(PENDING_AR, 'MEMBERSHIP_PENDING');
  if (action === 'moderate') return s.access === 'moderator' ? ALLOW : forbidden('هذا الإجراء لمشرفي المادة فقط.');
  return ALLOW;
}

/** Register the channel rules on a policy (idempotent per policy: the channels plugin calls it once). */
export function registerChannelRules(authz: Authz, access: ChannelAccess): void {
  if (authz.rules().some((r) => r.name === 'channels.node')) return;
  authz.registerRule({
    name: 'channels.node',
    resource: 'channel_node',
    decide: (viewer, action, r: Resource) => (r.type === 'channel_node' ? channelNodeDecision(access, viewer, action, r.id) : null),
  });
  authz.registerRule({
    name: 'channels.space',
    resource: 'space',
    decide: (viewer, action, r: Resource) => (r.type === 'space' ? spaceDecision(access, viewer, action, r.id) : null),
  });
}
