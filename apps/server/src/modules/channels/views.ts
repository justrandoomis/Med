// Row → contract view mapping of the channels module (P1-T4 step 1). Only what the contract names leaves the server:
// people as UserRef (display name only — «طالب سابق» for a deleted account), nodes as NodeRef, never a code's secret.
import type {
  ChannelMembershipView,
  ChannelRoleView,
  CourseFollowView,
  InvitationView,
  JoinCodeView,
  MemberView,
  NodeRef,
  UserRef,
} from '@medlevo/shared';
import type { CourseFollowRow, InvitationRow, JoinCodeRow, MembershipRow, NodeRow, PersonRow, RoleRow } from './repo';

export const FORMER_STUDENT_AR = 'طالب سابق';

export function nodeRef(n: Pick<NodeRow, 'id' | 'kind' | 'title'>): NodeRef {
  return { id: n.id, kind: n.kind, title: n.title };
}

export function userRef(id: string, people: Map<string, PersonRow>): UserRef {
  const p = people.get(id);
  if (!p || p.status === 'deleted') return { id, display_name: FORMER_STUDENT_AR, avatar_url: null, former: true };
  return { id, display_name: p.display_name, avatar_url: null };
}

export function membershipView(m: MembershipRow, node: Pick<NodeRow, 'id' | 'kind' | 'title'>): ChannelMembershipView {
  return { id: m.id, node: nodeRef(node), status: m.status, join_method: m.join_method, created_at: m.created_at, decided_at: m.decided_at, reason_ar: m.decision_reason };
}

export function codeView(c: JoinCodeRow, node: Pick<NodeRow, 'id' | 'kind' | 'title'>, people: Map<string, PersonRow>): JoinCodeView {
  return {
    id: c.id,
    node: nodeRef(node),
    kind: c.kind,
    hint: c.hint,
    requires_approval: c.requires_approval === 1,
    max_uses: c.max_uses,
    use_count: c.use_count,
    expires_at: c.expires_at,
    revoked_at: c.revoked_at,
    created_by: userRef(c.created_by, people),
    created_at: c.created_at,
  };
}

export function roleView(r: RoleRow, node: Pick<NodeRow, 'id' | 'kind' | 'title'>, people: Map<string, PersonRow>): ChannelRoleView {
  return { id: r.id, node: nodeRef(node), user: userRef(r.user_id, people), role: r.role, granted_by: userRef(r.granted_by, people), created_at: r.created_at };
}

export function invitationView(i: InvitationRow, node: Pick<NodeRow, 'id' | 'kind' | 'title'>, people: Map<string, PersonRow>): InvitationView {
  return {
    id: i.id,
    node: nodeRef(node),
    invitee: userRef(i.invitee_user_id, people),
    invited_by: userRef(i.invited_by, people),
    status: i.status,
    expires_at: i.expires_at,
    created_at: i.created_at,
    decided_at: i.decided_at,
  };
}

export function memberView(m: MembershipRow, people: Map<string, PersonRow>, roles: RoleRow[]): MemberView {
  return {
    membership_id: m.id,
    user: userRef(m.user_id, people),
    status: m.status,
    join_method: m.join_method,
    created_at: m.created_at,
    decided_at: m.decided_at,
    decided_by: m.decided_by ? userRef(m.decided_by, people) : null,
    reason_ar: m.decision_reason,
    roles: [...new Set(roles.filter((r) => r.user_id === m.user_id && r.node_id === m.node_id).map((r) => r.role))],
  };
}

export function courseFollowView(f: CourseFollowRow, subject: Pick<NodeRow, 'id' | 'kind' | 'title'>): CourseFollowView {
  return { subject: nodeRef(subject), add_new_lectures: f.add_new_lectures === 1, library_folder_id: f.library_folder_id, created_at: f.created_at };
}
