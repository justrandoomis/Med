// P1-T5's part of the generated permission matrix (X9; ARCHITECTURE_DELTA §5.3 rows «official lecture …», «subject
// attachment / exam date: publish», §5.5 files; PRD §4.3, Q5). The expectations are written from the role profiles of
// P1-T4's matrix world (test/authz/world.ts), independently of rules/lectures.ts, and are added to the X9 run in
// test/authz/matrix.test.ts: every official-lecture status × every action × every principal in and out of scope, the
// subject-content `publish` of a space, and space files.
import type { Action } from '../../src/modules/authz/policy';
import type { MatrixSpec, MatrixTarget, Outcome } from '../../src/modules/authz/test-support/matrix';
import { ARCHIVED, chainOf, type MatrixWorld, type NodeKey, PRINCIPALS, SUBJECTS } from '../authz/world';

type Role = 'admin' | 'assistant' | 'subject_moderator' | 'contributor';
const isPa = (p: string) => PRINCIPALS[p]!.platformAdmin === true;
const holds = (p: string, node: NodeKey, roles: Role[]) => (PRINCIPALS[p]!.roles ?? []).some((r) => roles.includes(r.role) && chainOf(node).includes(r.on));
const archivedChain = (node: NodeKey) => chainOf(node).some((k) => ARCHIVED.includes(k));
const approvedMember = (p: string, node: NodeKey) => {
  const m = PRINCIPALS[p]!.membership;
  return !!m && m.status === 'approved' && chainOf(node).includes(m.on) && !archivedChain(node);
};

/** Q5: Subject Moderators and Admins (and the platform admin) hold official powers; Assistants do not. */
const officialModerator = (p: string, node: NodeKey) => isPa(p) || holds(p, node, ['subject_moderator', 'admin']);
const contributor = (p: string, node: NodeKey) => officialModerator(p, node) || holds(p, node, ['contributor']);
/** any role in the subject, or an approved membership (a pending one grants nothing here) */
const member = (p: string, node: NodeKey) => isPa(p) || holds(p, node, ['admin', 'assistant', 'subject_moderator', 'contributor']) || approvedMember(p, node);

// `withdrawn_draft`: a contributor's lecture a moderator withdrew before any version was published (a rejected draft) —
// status 'withdrawn' without a head version; it stays a draft for visibility (review P1-T5 step 1, R1)
const STATUSES = ['draft', 'in_review', 'published', 'withdrawn', 'withdrawn_draft'] as const;
type Status = (typeof STATUSES)[number];
/** drafts are a contributor's; published / withdrawn lectures a moderator's */
const UPLOADER: Record<Status, string> = { draft: 'contrib_a', in_review: 'contrib_a', published: 'mod_a', withdrawn: 'mod_a', withdrawn_draft: 'contrib_a' };

export function expectLecture(p: string, action: Action, target: string): Outcome {
  const [node, key] = target.split(':') as [NodeKey, Status | 'new'];
  if (!member(p, node)) return 'hidden';
  if (key === 'new') return contributor(p, node) ? 'allow' : 'forbidden';
  const status = key === 'withdrawn_draft' ? 'withdrawn' : key;
  const draft = key === 'draft' || key === 'in_review' || key === 'withdrawn_draft';
  const own = UPLOADER[key] === p;
  const canSee = !draft || officialModerator(p, node) || (own && contributor(p, node));
  const deny: Outcome = canSee ? 'forbidden' : 'hidden';
  switch (action) {
    case 'view':
    case 'list':
      return canSee ? 'allow' : 'hidden';
    case 'create':
      if (!contributor(p, node) || status === 'withdrawn') return deny;
      if (officialModerator(p, node)) return 'allow';
      return own || status === 'published' ? 'allow' : 'hidden';
    case 'edit':
      if (status === 'withdrawn') return deny;
      if (officialModerator(p, node)) return 'allow';
      return contributor(p, node) && own && (status === 'draft' || status === 'in_review') ? 'allow' : deny;
    case 'suggest':
      if (status === 'withdrawn') return deny;
      return contributor(p, node) && canSee ? 'allow' : deny;
    case 'approve':
    case 'publish':
    case 'withdraw':
      if (!officialModerator(p, node)) return deny;
      return status === 'withdrawn' && action !== 'withdraw' ? 'forbidden' : 'allow';
    default:
      return deny;
  }
}

/** `publish` on a space = adding the subject's content (attachments: a contributor's starts as a draft). */
export function expectSpaceByLectures(p: string, action: Action, node: NodeKey): Outcome | null {
  if (action !== 'publish') return null;
  return contributor(p, node) ? 'allow' : 'forbidden';
}

// ───────── P1-T5 step 3: course-only publications (ARCHITECTURE_DELTA §5.3 «publication: …»; PRD Q6, Q7, AOS-18.7) ─────────

/** the subject's moderators (Assistant, Subject Moderator, Admin above, platform admin): they see a HIDDEN publication */
const subjectModerator = (p: string, node: NodeKey) => isPa(p) || holds(p, node, ['admin', 'assistant', 'subject_moderator']);
const PUB_AUTHOR = 'student_a';
const PUB_KEYS = ['active', 'hidden_by_moderator', 'withdrawn', 'author_deleted', 'hidden_by_moderator+holder', 'withdrawn+holder', 'new'] as const;
type PubKey = (typeof PUB_KEYS)[number];

export function expectPublication(p: string, action: Action, target: string): Outcome {
  const [node, key] = target.split(':') as [NodeKey, PubKey];
  if (!member(p, node)) return 'hidden';
  if (key === 'new') return action === 'create' ? 'allow' : 'hidden';
  const holder = key.endsWith('+holder');
  const status = key.replace('+holder', '');
  const author = p === PUB_AUTHOR;
  const canSee = status === 'active' || author || holder || (status === 'hidden_by_moderator' && subjectModerator(p, node));
  if (!canSee) return 'hidden';
  switch (action) {
    case 'view':
    case 'list':
      return 'allow';
    case 'edit':
      return author && (status === 'active' || status === 'hidden_by_moderator') ? 'allow' : 'forbidden';
    case 'withdraw':
      return author ? 'allow' : 'forbidden';
    case 'fork':
    case 'follow':
      return !author && status === 'active' ? 'allow' : 'forbidden';
    default:
      return 'forbidden'; // Phase 2 actions (suggest, rate, comment, …) are refused to whoever can see it
  }
}

function publicationTargets(w: MatrixWorld): MatrixTarget[] {
  const out: MatrixTarget[] = [];
  for (const k of SUBJECTS) {
    for (const key of PUB_KEYS) {
      out.push({
        key: `${k}:${key}`,
        resource: {
          type: 'publication',
          id: key === 'new' ? '' : `P-${k}-${key}`,
          spaceId: w.nodes[k].space_id!,
          authorUserId: key === 'new' ? '' : w.viewer(PUB_AUTHOR).userId,
          status: key === 'new' ? 'active' : key.replace('+holder', ''),
          viewerHoldsCopy: key.endsWith('+holder'),
        } as MatrixTarget['resource'],
      });
    }
  }
  return out;
}

export function lectureMatrixSpecs(w: MatrixWorld): MatrixSpec[] {
  const lectureTargets: MatrixTarget[] = [];
  for (const k of SUBJECTS) {
    for (const key of STATUSES) {
      const status = key === 'withdrawn_draft' ? 'withdrawn' : key;
      lectureTargets.push({
        key: `${k}:${key}`,
        resource: {
          type: 'official_lecture',
          spaceId: w.nodes[k].space_id!,
          id: `L-${k}-${key}`,
          status,
          subjectNodeId: w.nodes[k].id,
          uploadedBy: w.viewer(UPLOADER[key]).userId,
          everPublished: key !== 'draft' && key !== 'in_review' && key !== 'withdrawn_draft',
        } as MatrixTarget['resource'],
      });
    }
  }
  const newTargets: MatrixTarget[] = SUBJECTS.map((k) => ({
    key: `${k}:new`,
    resource: { type: 'official_lecture', spaceId: w.nodes[k].space_id!, id: '', status: 'draft', subjectNodeId: w.nodes[k].id } as MatrixTarget['resource'],
  }));
  const fileTargets: MatrixTarget[] = [
    ...SUBJECTS.map((k) => ({ key: k, resource: { type: 'file' as const, db: `s:${w.nodes[k].space_id!}`, fileId: `F-${k}` } })),
    { key: 'VAULT', resource: { type: 'file', db: 'v:SOME_VAULT', fileId: 'F-V' } },
  ];
  return [
    // P1-T5 step 3: every publication state × every action × every principal, in and out of the subject
    { resource: 'publication', targets: publicationTargets(w), expect: expectPublication },
    { resource: 'official_lecture', targets: lectureTargets, expect: expectLecture },
    { resource: 'official_lecture', actions: ['create'], targets: newTargets, expect: expectLecture },
    {
      resource: 'file',
      targets: fileTargets,
      // a space file: members of THAT subject may view (the handler first applies the owning lecture's rules); a vault
      // file is reached only through its owner's own vault binding — no rule allows it
      expect: (p, action, target) => (target !== 'VAULT' && action === 'view' && member(p, target as NodeKey) ? 'allow' : 'hidden'),
    },
  ];
}
