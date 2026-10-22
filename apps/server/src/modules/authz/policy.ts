// The ONE place that decides (ARCHITECTURE_DELTA §5.5; P1-T1 step 1 — the policy core).
//
// Deny by default: a (viewer, action, resource) with no rule that allows it is refused, and refused as «not found»
// (404, the same body as a missing id) unless a rule says the viewer may SEE the resource but not act on it (403).
// Rules self-register from their own module's files (`registerRule` — P1-T4: channels, P1-T5: lectures, publications,
// layers), so tracks never edit this file to add a resource. Any matching rule's deny wins over every allow.
import type { ErrorCode } from '@medlevo/shared';
import { AppError } from '../../lib/errors';
import { type GrantProvider, NO_GRANTS } from '../../system/acl';
import type { SpaceAccess, Viewer } from '../../system/binding';

export type Action =
  | 'view' | 'list' | 'create' | 'edit' | 'delete' | 'publish' | 'approve' | 'withdraw' | 'moderate'
  | 'fork' | 'follow' | 'comment' | 'suggest' | 'vote' | 'rate' | 'write_layer' | 'manage_members' | 'manage_codes'
  | 'assign_role' | 'record' | 'share_recording' | 'view_audit' | 'view_stats' | 'set_quota'
  /** a whole-deployment operation (§5.8) */
  | 'operate';

export type LayerKindRef = string;

export type Resource =
  | { type: 'platform'; operation: string }
  | { type: 'vault'; vaultId: string; ownerUserId: string }
  | { type: 'channel_node'; id: string }
  | { type: 'space'; id: string }
  | { type: 'official_lecture'; spaceId: string; id: string; status: string; subjectNodeId: string }
  | { type: 'publication'; id: string }
  | { type: 'layer'; db: string; id: string; kind: LayerKindRef; ownerUserId: string | null }
  | { type: 'discussion'; spaceId: string; threadId: string; audience: string; audienceRef: string | null }
  | { type: 'collab_doc'; spaceId: string; id: string }
  | { type: 'room'; spaceId: string; id: string }
  | { type: 'recording'; db: string; id: string }
  | { type: 'file'; db: string; fileId: string };

export type ResourceType = Resource['type'];

export interface Decision {
  allowed: boolean;
  /** hide → 404 (existence never leaks); otherwise 403 with the code */
  reason?: { code: ErrorCode; messageAr: string; hide: boolean };
}

export const ALLOW: Decision = Object.freeze({ allowed: true });
const NOT_FOUND_AR = 'العنصر غير موجود.';
export const HIDDEN: Decision = Object.freeze({ allowed: false, reason: { code: 'NOT_FOUND' as ErrorCode, messageAr: NOT_FOUND_AR, hide: true } });
export function forbidden(messageAr: string, code: ErrorCode = 'FORBIDDEN'): Decision {
  return { allowed: false, reason: { code, messageAr, hide: false } };
}

/** What a viewer may do inside one subject space: computed per subject node (or an ancestor), never across subjects. */
export interface SpaceMembership {
  subjectNodeId: string;
  access: SpaceAccess;
  /** an approved membership is pending (403 MEMBERSHIP_PENDING) */
  pending?: boolean;
}

/**
 * Memberships and roles (skeleton). The channel tables arrive with P1-T4 (`2050_directory`, `2100_permissions`, R1-c);
 * until then nobody is a member of any subject, so every space binding is refused.
 */
export interface MembershipProvider {
  accessToSpace(viewer: Viewer, spaceId: string): SpaceMembership | null;
}

export const NO_MEMBERSHIPS: MembershipProvider = Object.freeze({ accessToSpace: () => null });

export interface AuthzDeps {
  memberships: MembershipProvider;
  /**
   * AOS-21.18: per-resource ACL grants (system `acl_grant`); a rule asks `grants?.has(viewer, type, db, id, permission)`.
   * Always set by the policy; optional for callers that build deps by hand (a missing provider grants nothing).
   */
  grants?: GrantProvider;
}

export interface AuthzRule {
  /** for diagnostics and the matrix test */
  name: string;
  resource: ResourceType;
  /** allow / deny, or null to abstain */
  decide(viewer: Viewer, action: Action, resource: Resource, deps: AuthzDeps): Decision | null;
}

export type VisibilityKeyProvider = (viewer: Viewer, spaceId: string, deps: AuthzDeps) => string[];

export interface Authz {
  can(viewer: Viewer, action: Action, resource: Resource): Decision;
  /** throws AppError: 404 when hidden, else 403 with the rule's code */
  assert(viewer: Viewer, action: Action, resource: Resource): void;
  /** the sync-pull / FTS scope keys of this viewer in a bound space (§8.4); [] = only rows every member sees */
  visibilityKeys(viewer: Viewer, spaceId: string): string[];
  registerRule(rule: AuthzRule): void;
  registerVisibilityKeys(provider: VisibilityKeyProvider): void;
  setMembershipProvider(p: MembershipProvider): void;
  readonly memberships: MembershipProvider;
  /** AOS-21.18: the ACL grants the rules read (the context wires the system `acl_grant` repository) */
  setGrantProvider(p: GrantProvider): void;
  /** the registered rules (matrix test) */
  rules(): readonly AuthzRule[];
}

/** Built-in rules of the core: platform operations and «nobody reads another user's vault». */
const CORE_RULES: AuthzRule[] = [
  {
    name: 'core.platform-admin-only',
    resource: 'platform',
    decide: (viewer) => (viewer.isPlatformAdmin ? ALLOW : HIDDEN),
  },
  {
    // ARCHITECTURE_DELTA §5.3 last row: any user's vault content — no route for anyone, the platform admin included
    name: 'core.own-vault-only',
    resource: 'vault',
    decide: (viewer, _action, r) => (r.type === 'vault' && r.ownerUserId === viewer.userId ? ALLOW : HIDDEN),
  },
];

export function createAuthz(): Authz {
  const rules: AuthzRule[] = [...CORE_RULES];
  const keyProviders: VisibilityKeyProvider[] = [];
  let memberships: MembershipProvider = NO_MEMBERSHIPS;
  let grants: GrantProvider = NO_GRANTS;
  const deps = (): AuthzDeps => ({ memberships, grants });

  const can = (viewer: Viewer, action: Action, resource: Resource): Decision => {
    let allowed = false;
    let firstDeny: Decision | null = null;
    for (const rule of rules) {
      if (rule.resource !== resource.type) continue;
      let d: Decision | null;
      try {
        d = rule.decide(viewer, action, resource, deps());
      } catch {
        d = HIDDEN; // a failing rule never allows
      }
      if (!d) continue;
      if (!d.allowed) {
        firstDeny ??= d;
      } else allowed = true;
    }
    if (firstDeny) return firstDeny;
    return allowed ? ALLOW : HIDDEN;
  };

  return {
    can,
    assert(viewer, action, resource) {
      const d = can(viewer, action, resource);
      if (d.allowed) return;
      const r = d.reason ?? HIDDEN.reason!;
      if (r.hide) throw new AppError('NOT_FOUND', NOT_FOUND_AR, 404);
      throw new AppError(r.code, r.messageAr, 403);
    },
    visibilityKeys(viewer, spaceId) {
      const keys = new Set<string>();
      for (const p of keyProviders) for (const k of p(viewer, spaceId, deps())) keys.add(k);
      return [...keys].sort();
    },
    registerRule(rule) {
      if (rules.some((r) => r.name === rule.name)) throw new Error(`authz rule already registered: ${rule.name}`);
      rules.push(rule);
    },
    registerVisibilityKeys(provider) {
      keyProviders.push(provider);
    },
    setMembershipProvider(p) {
      memberships = p;
    },
    get memberships() {
      return memberships;
    },
    setGrantProvider(p) {
      grants = p;
    },
    rules: () => rules,
  };
}
