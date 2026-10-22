// Authz rules of course-only publications (P1-T5 step 3; ARCHITECTURE_DELTA §5.2, §5.3 rows «publication: …», §6.4;
// PRD §4.3, AOS-5.12, 5.24, 18.7, Q6, Q7). They self-register from the forks module (`registerPublicationRules`), so
// policy.ts never changes for them.
//
// Phase 1 publishes COURSE-ONLY explanations, so every reader is a member of the subject (gate 2 already asked for
// membership in THIS subject; this rule asks again — one space = one subject, never across subjects):
//   * create          — any approved member (or role) of the subject (Q7: every member may publish);
//   * view            — an ACTIVE publication: every member; a HIDDEN one (a moderator hid it): its author, the
//                       subject's moderators (Assistant / Subject Moderator / Admin, who may restore it) and the members
//                       who hold a fork or a followed copy of it (they read why it stopped); a WITHDRAWN one (or one
//                       whose author deleted the account, Q14): its author and the holders of a copy — nobody else
//                       learns it existed (404, the body of a missing id);
//   * list            — members (the handler lists only what the viewer may see, filtered before paginating);
//   * edit / withdraw — the author only (another member who can see it: 403); a withdrawn publication is not edited;
//   * fork / follow   — a member who is not the author, while it is active;
//   * suggest, rate, vote, comment … — Phase 2: refused (403 to someone who can see it).
// AOS-21.18: «holds a copy» is a per-resource ACL grant — taking a fork or a followed copy writes a durable `view`
// grant (system `acl_grant`, forks/system.ts), and this rule reads it through the policy's grant provider (a member
// still; a grant never lets a non-member in).
// Moderation itself (hide / restore) is P1-T4's `moderate` on the subject's channel node, reached through the target
// registry the forks module fills (moderation/targets.ts).
import type { Viewer } from '../../../system/binding';
import { ALLOW, type Action, type Authz, type AuthzDeps, type AuthzRule, type Decision, forbidden, HIDDEN, type Resource } from '../policy';

/** The publication resource with what the decision needs (the handler reads it from the system index first). */
export type PublicationResource = Extract<Resource, { type: 'publication' }> & {
  /** the subject's space the publication lives in ('' never matches a membership) */
  spaceId: string;
  /** '' for a NEW publication (create) */
  authorUserId: string;
  status: 'active' | 'hidden_by_moderator' | 'withdrawn' | 'author_deleted';
  /** the viewer holds a fork or a followed copy of it (system `publication_copy`, not ended) */
  viewerHoldsCopy?: boolean;
};

export interface PublicationPowers {
  member: boolean;
  /** Assistant, Subject Moderator, Admin on the subject or above, or the platform admin (gate-2 «moderator» access) */
  moderator: boolean;
}

export function publicationPowers(viewer: Viewer, spaceId: string, deps: AuthzDeps): PublicationPowers {
  if (!spaceId) return { member: false, moderator: false };
  let m: ReturnType<AuthzDeps['memberships']['accessToSpace']>;
  try {
    m = deps.memberships.accessToSpace(viewer, spaceId);
  } catch {
    return { member: false, moderator: false };
  }
  if (!m || m.pending) return { member: false, moderator: false };
  return { member: true, moderator: m.access === 'moderator' };
}

export const PUBLICATION_AR = {
  authorOnly: 'يعدّل الشرحَ أو يسحبه صاحبه فقط.',
  ownExplanation: 'هذا شرحك: تجده في نسختك من المحاضرة، ولا تحتاج نسخة منه.',
  hidden: 'أخفى المشرف هذا الشرح؛ لا تُؤخذ منه نسخ جديدة حتى يُعاد إظهاره.',
  withdrawn: 'سُحب هذا الشرح؛ لا تُؤخذ منه نسخ جديدة ولا يُعدَّل.',
  later: 'هذا الإجراء غير متاح في هذا الإصدار.',
} as const;

function decidePublication(viewer: Viewer, action: Action, r: PublicationResource, deps: AuthzDeps): Decision | null {
  const p = publicationPowers(viewer, r.spaceId, deps);
  if (!p.member) return HIDDEN;
  if (r.id === '') {
    // a NEW publication in this subject (nothing to hide: the member sees the subject, so a refusal is a 403)
    return action === 'create' ? ALLOW : HIDDEN;
  }
  const author = r.authorUserId !== '' && r.authorUserId === viewer.userId;
  const holder = r.viewerHoldsCopy === true || deps.grants?.has(viewer, 'publication', r.spaceId, r.id, 'view') === true;
  const canSee =
    r.status === 'active' || author || holder || (r.status === 'hidden_by_moderator' && p.moderator);
  if (!canSee) return HIDDEN;
  switch (action) {
    case 'view':
    case 'list':
      return ALLOW;
    case 'edit':
      if (!author) return forbidden(PUBLICATION_AR.authorOnly);
      return r.status === 'withdrawn' || r.status === 'author_deleted' ? forbidden(PUBLICATION_AR.withdrawn) : ALLOW;
    case 'withdraw':
      return author ? ALLOW : forbidden(PUBLICATION_AR.authorOnly);
    case 'fork':
    case 'follow':
      if (author) return forbidden(PUBLICATION_AR.ownExplanation);
      if (r.status === 'hidden_by_moderator') return forbidden(PUBLICATION_AR.hidden);
      if (r.status !== 'active') return forbidden(PUBLICATION_AR.withdrawn);
      return ALLOW;
    default:
      return forbidden(PUBLICATION_AR.later);
  }
}

export const PUBLICATION_RULES: readonly AuthzRule[] = [
  {
    name: 'publications.course-only',
    resource: 'publication',
    decide: (v, a, r, d) => (r.type === 'publication' ? decidePublication(v, a, r as PublicationResource, d) : null),
  },
];

/** Register the rules once per authz instance (idempotent: a second call is a no-op). */
export function registerPublicationRules(authz: Authz): void {
  const have = new Set(authz.rules().map((r) => r.name));
  for (const rule of PUBLICATION_RULES) if (!have.has(rule.name)) authz.registerRule(rule);
}
