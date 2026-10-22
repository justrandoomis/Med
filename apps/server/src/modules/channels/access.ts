// Who may do what where in the university tree (P1-T4 step 1; ARCHITECTURE_DELTA §5.1, §5.5 gate 2).
//
// One computation, used by the authz rules (rules/channels.ts), by gate 2 (the space binding: `accessToSpace`, the
// `MembershipProvider` of the policy core) and by the views. For a viewer and a node it reads the node's ancestors
// from the closure (one indexed lookup) and the viewer's roles and memberships on them:
//   * roles inherit down the tree, never sideways: a role on a university applies to every node below it;
//   * an approved membership on the node or an ancestor makes a member — unless the node (or an ancestor) is archived:
//     then memberships stop granting access and only roles (and the platform admin) still do — or unless a NEARER
//     removal says otherwise (a student removed from a subject stays out of it, review P1-T4 step 1 R2);
//   * the platform admin (user #1 after the owner migration) administers every node (PRD Q4) and moderates every space,
//     but holds no role row and is not a member: it never sees anyone's vault (core rule).
// Gate 2 access per subject: Admin / Assistant / Subject Moderator (here or above) and the platform admin →
// `moderator`; Contributor or approved member → `member`; a pending request only → `member` + pending (403
// MEMBERSHIP_PENDING); anything else → null (404, the body of a missing route).
import type { ChannelRole, MembershipStatus } from '@medlevo/shared';
import type { Viewer } from '../../system/binding';
import type { AuthzDeps, MembershipProvider, SpaceMembership } from '../authz/policy';
import type { AncestorRow, ChannelRepo, MembershipRow, NodeRow } from './repo';

export const MODERATING_ROLES: readonly ChannelRole[] = ['admin', 'assistant', 'subject_moderator'];

export interface EffectiveAccess {
  node: NodeRow;
  /** the node first, then its ancestors up to the root */
  chain: AncestorRow[];
  /** the node or an ancestor is archived */
  archived: boolean;
  isPlatformAdmin: boolean;
  /** active roles held on the node or an ancestor, nearest first */
  roles: Array<{ role: ChannelRole; nodeId: string; depth: number; id: string }>;
  /** the viewer's memberships on the node or an ancestor, nearest first */
  memberships: Array<MembershipRow & { depth: number }>;
}

/** Gate-2 access plus the subject's roles for later rules (P1-T5: contributor drafts, moderator-only actions). */
export interface SubjectAccess extends SpaceMembership {
  roles: ChannelRole[];
  isPlatformAdmin: boolean;
}

export class ChannelAccess implements MembershipProvider {
  constructor(private readonly repo: ChannelRepo) {}

  /** null for a node that does not exist. */
  effective(viewer: Viewer, nodeId: string): EffectiveAccess | null {
    const chain = this.repo.ancestors(nodeId);
    if (chain.length === 0) return null;
    const ids = chain.map((a) => a.id);
    const depthOf = new Map(chain.map((a) => [a.id, a.depth]));
    const roles = this.repo
      .rolesOn(viewer.userId, ids)
      .map((r) => ({ role: r.role, nodeId: r.node_id, depth: depthOf.get(r.node_id)!, id: r.id }))
      .sort((a, b) => a.depth - b.depth);
    const memberships = this.repo
      .membershipsOn(viewer.userId, ids)
      .map((m) => ({ ...m, depth: depthOf.get(m.node_id)! }))
      .sort((a, b) => a.depth - b.depth);
    return { node: chain[0]!, chain, archived: chain.some((a) => a.status === 'archived'), isPlatformAdmin: viewer.isPlatformAdmin, roles, memberships };
  }

  /**
   * The same computation for many nodes at once (the tree view): one closure query for all of them, the viewer's
   * roles and memberships read once. Nodes that do not exist are left out.
   */
  effectiveMany(viewer: Viewer, nodes: readonly NodeRow[]): Map<string, EffectiveAccess> {
    const out = new Map<string, EffectiveAccess>();
    if (nodes.length === 0) return out;
    const ancestorIds = this.repo.ancestorIdsOf(nodes.map((n) => n.id));
    const allIds = new Set<string>();
    for (const list of ancestorIds.values()) for (const id of list) allIds.add(id);
    const byId = new Map(this.repo.nodesByIds([...allIds]).map((n) => [n.id, n]));
    const roles = this.repo.rolesOfUser(viewer.userId);
    const memberships = this.repo.membershipsOfUser(viewer.userId);
    for (const node of nodes) {
      const ids = ancestorIds.get(node.id);
      if (!ids) continue;
      const chain: AncestorRow[] = ids.map((id, depth) => ({ ...byId.get(id)!, depth })).filter((a) => a.id !== undefined);
      const depthOf = new Map(chain.map((a) => [a.id, a.depth]));
      out.set(node.id, {
        node: chain[0] ?? { ...node, depth: 0 },
        chain,
        archived: chain.some((a) => a.status === 'archived'),
        isPlatformAdmin: viewer.isPlatformAdmin,
        roles: roles
          .filter((r) => depthOf.has(r.node_id))
          .map((r) => ({ role: r.role, nodeId: r.node_id, depth: depthOf.get(r.node_id)!, id: r.id }))
          .sort((a, b) => a.depth - b.depth),
        memberships: memberships
          .filter((m) => depthOf.has(m.node_id))
          .map((m) => ({ ...m, depth: depthOf.get(m.node_id)! }))
          .sort((a, b) => a.depth - b.depth),
      });
    }
    return out;
  }

  static hasRole(e: EffectiveAccess, roles: readonly ChannelRole[]): boolean {
    return e.roles.some((r) => roles.includes(r.role));
  }

  /**
   * The nearest membership with this status that still grants something (never on an archived chain). A removal
   * decides like an approval or a request does, and the NEARER of the two wins (review P1-T4 step 1, R2): a student
   * removed from a subject stays out of it even with an approved (or pending) membership higher up, and does not get
   * it back by joining the stage again — the subject's own approvers re-admit them (a new request they approve, or an
   * invitation). An approval on the subject itself still wins over a removal higher up.
   */
  static nearest(e: EffectiveAccess, status: Extract<MembershipStatus, 'approved' | 'pending'>): (MembershipRow & { depth: number }) | null {
    if (e.archived) return null;
    const m = e.memberships.find((x) => x.status === status || x.status === 'removed');
    return m && m.status === status ? m : null;
  }

  /** The membership that decides between in and out here (approved or removed, nearest first), archived or not. */
  static decisive(e: EffectiveAccess): (MembershipRow & { depth: number }) | null {
    return e.memberships.find((x) => x.status === 'approved' || x.status === 'removed') ?? null;
  }

  /** Approved member (here or above, not archived), any role here or above, or the platform admin. */
  static mayEnter(e: EffectiveAccess): boolean {
    return e.isPlatformAdmin || e.roles.length > 0 || ChannelAccess.nearest(e, 'approved') !== null;
  }

  /** Gate-2 access of the viewer to the subject that owns `spaceId` (MembershipProvider). */
  accessToSpace(viewer: Viewer, spaceId: string): SubjectAccess | null {
    const node = this.repo.nodeOfSpace(spaceId);
    if (!node) return null;
    const e = this.effective(viewer, node.id);
    if (!e) return null;
    return ChannelAccess.subjectAccess(e);
  }

  static subjectAccess(e: EffectiveAccess): SubjectAccess | null {
    const roles = [...new Set(e.roles.map((r) => r.role))];
    const base = { subjectNodeId: e.node.id, roles, isPlatformAdmin: e.isPlatformAdmin };
    if (e.isPlatformAdmin || ChannelAccess.hasRole(e, MODERATING_ROLES)) return { ...base, access: 'moderator' };
    if (roles.includes('contributor') || ChannelAccess.nearest(e, 'approved')) return { ...base, access: 'member' };
    if (ChannelAccess.nearest(e, 'pending')) return { ...base, access: 'member', pending: true };
    return null;
  }
}

/**
 * The channel access behind a policy's membership provider, for later rules (P1-T5 `rules/lectures.ts`): roles of the
 * viewer on the subject of a space. Null when the channels module is not mounted (then nobody is a member of anything).
 */
export function subjectAccessOf(deps: Pick<AuthzDeps, 'memberships'> | MembershipProvider, viewer: Viewer, spaceId: string): SubjectAccess | null {
  const provider = 'memberships' in deps ? deps.memberships : deps;
  if (!(provider instanceof ChannelAccess)) return null;
  return provider.accessToSpace(viewer, spaceId);
}
