// Authz rules of official lectures and the subject's content (P1-T5 step 1; ARCHITECTURE_DELTA §5.3, §5.5; PRD §4.3,
// Q5). They self-register from the lectures module (`registerLectureRules`), so policy.ts never changes for them.
//
// Who may do what, in ONE subject (the space being bound), never across subjects:
//   * official moderator — a Subject Moderator or an Admin on the subject node or above (roles inherit down the tree),
//     or a platform admin the membership provider gave moderator access here: approve, publish versions, correct,
//     withdraw, rights takedown, page-map decisions, attachments and exam dates (§5.3 rows «official lecture …»);
//   * contributor — uploads drafts (a new lecture, or a new version of a lecture) and proposes corrections; a
//     moderator approves both (Q5); sees their own drafts;
//   * member (student, assistant, any role) — reads PUBLISHED and withdrawn lectures; an Assistant handles membership
//     and moderation, not official files (Q5), so «moderator» access at gate 2 alone grants nothing here;
//   * anyone else — 404, the body of a missing id (existence never leaks).
//
// The roles come from the membership provider (P1-T4 `channels`): `accessToSpace` returns the viewer's membership in
// THIS subject and — as an additive field this file reads — the channel roles the viewer holds on the subject node or
// an ancestor (`roles`). Without roles nobody gets official powers (fail closed): a membership provider that reports
// `access: 'moderator'` but no roles makes the viewer a plain member here.
import type { ChannelRole } from '@medlevo/shared';
import type { Viewer } from '../../../system/binding';
import { ALLOW, type Action, type Authz, type AuthzDeps, type AuthzRule, type Decision, forbidden, HIDDEN, type Resource, type SpaceMembership } from '../policy';

/** A space membership as the channels provider reports it, with the roles held on the subject node or above. */
export interface SubjectMembership extends SpaceMembership {
  roles?: readonly ChannelRole[];
}

/**
 * The official-lecture resource with the uploader, so a contributor reaches their own drafts, and whether a version of
 * it was ever published: a lecture withdrawn before any publication (a moderator rejecting a contributor's draft) stays
 * a draft for visibility — students never learn it existed (review P1-T5 step 1, R1). `everPublished` absent = true.
 */
export type OfficialLectureResource = Extract<Resource, { type: 'official_lecture' }> & { uploadedBy?: string | null; everPublished?: boolean };

export interface LecturePowers {
  /** an approved member (or any role) of this subject */
  member: boolean;
  /** approve, publish, correct, withdraw, take down; attachments and exam dates */
  officialModerator: boolean;
  /** upload drafts and propose corrections (an official moderator can too) */
  contributor: boolean;
  /** the subject node the membership was computed on */
  subjectNodeId: string | null;
}

const NONE: LecturePowers = Object.freeze({ member: false, officialModerator: false, contributor: false, subjectNodeId: null });

/** What the viewer may do with official content in the space `spaceId` (one subject, computed by the provider). */
export function lecturePowers(viewer: Viewer, spaceId: string, deps: AuthzDeps): LecturePowers {
  let m: SubjectMembership | null;
  try {
    m = deps.memberships.accessToSpace(viewer, spaceId) as SubjectMembership | null;
  } catch {
    return NONE;
  }
  if (!m || m.pending) return NONE;
  const roles = Array.isArray(m.roles) ? m.roles : [];
  const officialModerator = roles.includes('subject_moderator') || roles.includes('admin') || (viewer.isPlatformAdmin && m.access === 'moderator');
  return { member: true, officialModerator, contributor: officialModerator || roles.includes('contributor'), subjectNodeId: m.subjectNodeId };
}

const AR = {
  notModerator: 'هذا الإجراء لمشرف المادة فقط.',
  notContributor: 'رفع المحاضرات الرسمية واقتراح تصحيحها لمشرفي المادة والمساهمين فيها فقط.',
  withdrawn: 'سُحبت هذه المحاضرة؛ لا يمكن تعديلها أو رفع إصدار جديد لها.',
  notOwnDraft: 'يعدّل المساهم مسوداته فقط؛ ما نُشر يعدّله مشرف المادة.',
};

const isDraft = (status: string) => status === 'draft' || status === 'in_review';

function decideLecture(viewer: Viewer, action: Action, r: OfficialLectureResource, deps: AuthzDeps): Decision | null {
  const p = lecturePowers(viewer, r.spaceId, deps);
  if (!p.member) return HIDDEN;
  // one space = one subject: the space id decides (rows never belong to another subject's space)
  const own = !!r.uploadedBy && r.uploadedBy === viewer.userId;
  // a draft — or a lecture withdrawn before it was ever published — is seen by the subject's official moderators and
  // its uploader only; everything else is published content
  const unpublished = isDraft(r.status) || (r.status === 'withdrawn' && r.everPublished === false);
  const canSee = !unpublished || p.officialModerator || (own && p.contributor);
  const deny = (msg: string) => (canSee ? forbidden(msg) : HIDDEN);
  switch (action) {
    case 'view':
    case 'list':
      return canSee ? ALLOW : HIDDEN;
    case 'create':
      // r.id === '' : a NEW lecture (nothing to hide: the member sees the subject, so a refusal is 403)
      if (r.id === '') return p.contributor ? ALLOW : forbidden(AR.notContributor);
      // otherwise a new version of this lecture
      if (!p.contributor) return deny(AR.notContributor);
      if (r.status === 'withdrawn') return deny(AR.withdrawn);
      if (p.officialModerator) return ALLOW;
      return own || r.status === 'published' ? ALLOW : HIDDEN; // another contributor's draft is not theirs to see
    case 'edit':
      if (r.status === 'withdrawn') return deny(AR.withdrawn);
      if (p.officialModerator) return ALLOW;
      if (p.contributor && own && isDraft(r.status)) return ALLOW;
      return deny(p.contributor ? AR.notOwnDraft : AR.notModerator);
    case 'suggest':
      // a contributor's correction proposal (the moderators' queue decides it)
      if (r.status === 'withdrawn') return deny(AR.withdrawn);
      return p.contributor && canSee ? ALLOW : deny(AR.notContributor);
    case 'approve':
    case 'publish':
    case 'withdraw':
      if (!p.officialModerator) return deny(AR.notModerator);
      if (r.status === 'withdrawn' && action !== 'withdraw') return forbidden(AR.withdrawn);
      return ALLOW;
    default:
      return deny(AR.notModerator);
  }
}

/**
 * The subject's content in the space (attachments, exam dates, the updates feed): `list` / `view` for every member;
 * `publish` for official moderators, and for contributors (their attachment starts as a draft — the handler decides
 * the status from `lecturePowers`). Exam dates need an official moderator: the handler checks that too.
 */
function decideSpace(viewer: Viewer, action: Action, r: Extract<Resource, { type: 'space' }>, deps: AuthzDeps): Decision | null {
  const p = lecturePowers(viewer, r.id, deps);
  if (!p.member) return null; // abstain: other rules (P1-T4 channels) decide non-members; deny by default otherwise
  if (action === 'list' || action === 'view') return ALLOW;
  if (action === 'publish') return p.contributor ? ALLOW : forbidden(AR.notContributor);
  return null;
}

/** A stored file of a SPACE (`db` = `s:<spaceId>`): members only; the handler first applies the owning lecture's rules. */
function decideFile(viewer: Viewer, action: Action, r: Extract<Resource, { type: 'file' }>, deps: AuthzDeps): Decision | null {
  if (!r.db.startsWith('s:')) return null; // vault files are reached only through the viewer's own vault binding
  if (action !== 'view') return null;
  return lecturePowers(viewer, r.db.slice(2), deps).member ? ALLOW : HIDDEN;
}

export const LECTURE_RULES: readonly AuthzRule[] = [
  { name: 'lectures.official-lecture', resource: 'official_lecture', decide: (v, a, r, d) => (r.type === 'official_lecture' ? decideLecture(v, a, r, d) : null) },
  { name: 'lectures.subject-content', resource: 'space', decide: (v, a, r, d) => (r.type === 'space' ? decideSpace(v, a, r, d) : null) },
  { name: 'lectures.space-file', resource: 'file', decide: (v, a, r, d) => (r.type === 'file' ? decideFile(v, a, r, d) : null) },
];

/** Register the rules once per authz instance (idempotent: a second call is a no-op). */
export function registerLectureRules(authz: Authz): void {
  const have = new Set(authz.rules().map((r) => r.name));
  for (const rule of LECTURE_RULES) if (!have.has(rule.name)) authz.registerRule(rule);
}
