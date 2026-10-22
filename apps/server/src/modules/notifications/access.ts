// «May this person still open what the notification is about?» (P1-T4 step 2). Asked twice: when the fan-out writes the
// row (nobody is told about a subject they may not enter) and every time the inbox is read (a membership or a role lost
// since hides the earlier rows — their titles are the subject's, not the reader's). One answer per (access, scope):
//   self            always (the reader's own decision, invitation, moderation outcome, quota, re-anchor report)
//   member          may enter the scope node: approved member here or above (a nearer removal wins), any role here or
//                   above, or the platform admin — never a pending request (ChannelAccess.mayEnter)
//   manage_members  the policy's `manage_members` on the node (Admin / Assistant here or above, platform admin)
//   moderate        the policy's `moderate` on the node (Admin / Assistant / Subject Moderator here or above, platform admin)
// Without the channels module (no ChannelAccess behind the policy) only `self` passes: fail closed.
import type { AppContext } from '../../context';
import type { Viewer } from '../../system/binding';
import { ChannelAccess } from '../channels/access';

export const NOTIFICATION_ACCESS = ['self', 'member', 'manage_members', 'moderate'] as const;
export type NotificationAccess = (typeof NOTIFICATION_ACCESS)[number];

export function mayOpen(ctx: AppContext, viewer: Viewer, access: NotificationAccess, scopeNodeId: string | null): boolean {
  if (access === 'self') return true;
  if (!scopeNodeId) return false;
  switch (access) {
    case 'member': {
      const provider = ctx.authz.memberships;
      if (!(provider instanceof ChannelAccess)) return false;
      const e = provider.effective(viewer, scopeNodeId);
      return !!e && ChannelAccess.mayEnter(e);
    }
    case 'manage_members':
      return ctx.authz.can(viewer, 'manage_members', { type: 'channel_node', id: scopeNodeId }).allowed;
    case 'moderate':
      return ctx.authz.can(viewer, 'moderate', { type: 'channel_node', id: scopeNodeId }).allowed;
  }
}

/** Memoised `mayOpen` for one viewer within one request or one fan-out step. */
export function accessMemo(ctx: AppContext, viewer: Viewer): (access: NotificationAccess, scopeNodeId: string | null) => boolean {
  const memo = new Map<string, boolean>();
  return (access, scopeNodeId) => {
    const key = `${access}|${scopeNodeId ?? ''}`;
    let v = memo.get(key);
    if (v === undefined) memo.set(key, (v = mayOpen(ctx, viewer, access, scopeNodeId)));
    return v;
  };
}
