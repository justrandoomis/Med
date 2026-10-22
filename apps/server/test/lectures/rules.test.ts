// P1-T5 step 1 — the authz rules of official lectures, the subject's content and space files, as a generated matrix
// (ARCHITECTURE_DELTA §5.3 rows «official lecture …» and «subject attachment / exam date», §5.7; PRD §4.3, Q5):
// each role × action × lecture status → allow / 403 / 404, one subject at a time. The X9 matrix generator of P1-T4
// enumerates every registered rule; this is the lectures part.
import { describe, expect, it } from 'vitest';
import type { ChannelRole } from '@medlevo/shared';
import { createAuthz, type Action, type MembershipProvider } from '../../src/modules/authz/policy';
import { lecturePowers, LECTURE_RULES, registerLectureRules, type OfficialLectureResource, type SubjectMembership } from '../../src/modules/authz/rules/lectures';
import type { Viewer } from '../../src/system/binding';

type Who = 'moderator' | 'admin' | 'contributor' | 'uploader' | 'student' | 'assistant' | 'platform_admin_member' | 'platform_admin_moderator' | 'other_subject' | 'outsider' | 'pending' | 'no_roles_moderator';
const v = (userId: string, isPlatformAdmin = false): Viewer => ({ userId, deviceId: null, isPlatformAdmin });

const M: Record<Who, SubjectMembership | null> = {
  moderator: { subjectNodeId: 'S1', access: 'moderator', roles: ['subject_moderator'] },
  admin: { subjectNodeId: 'S1', access: 'moderator', roles: ['admin'] },
  contributor: { subjectNodeId: 'S1', access: 'member', roles: ['contributor'] },
  uploader: { subjectNodeId: 'S1', access: 'member', roles: ['contributor'] },
  student: { subjectNodeId: 'S1', access: 'member', roles: [] },
  assistant: { subjectNodeId: 'S1', access: 'moderator', roles: ['assistant'] },
  platform_admin_member: { subjectNodeId: 'S1', access: 'member', roles: [] },
  platform_admin_moderator: { subjectNodeId: 'S1', access: 'moderator', roles: [] },
  other_subject: null,
  outsider: null,
  pending: { subjectNodeId: 'S1', access: 'member', roles: ['contributor'], pending: true },
  // fail closed: a provider that reports moderator access without roles grants no official power
  no_roles_moderator: { subjectNodeId: 'S1', access: 'moderator' },
};
const provider: MembershipProvider = { accessToSpace: (viewer, spaceId) => (spaceId === 'SP1' ? M[viewer.userId as Who] ?? null : viewer.userId === 'other_subject' ? { subjectNodeId: 'S2', access: 'moderator', roles: ['subject_moderator'] as ChannelRole[] } : null) };
const viewerOf = (w: Who) => v(w, w.startsWith('platform_admin'));

function setup() {
  const authz = createAuthz();
  authz.setMembershipProvider(provider);
  registerLectureRules(authz);
  registerLectureRules(authz); // idempotent
  return authz;
}
const lecture = (status: string, uploadedBy = 'uploader', id = 'L1'): OfficialLectureResource => ({ type: 'official_lecture', spaceId: 'SP1', id, status, subjectNodeId: 'S1', uploadedBy });
const outcome = (d: { allowed: boolean; reason?: { hide: boolean } }) => (d.allowed ? 'allow' : d.reason?.hide ? '404' : '403');

describe('lectures authz rules', () => {
  it('registers three named rules once', () => {
    const authz = setup();
    expect(authz.rules().filter((r) => r.name.startsWith('lectures.')).map((r) => r.name)).toEqual(LECTURE_RULES.map((r) => r.name));
  });

  it('powers per role in ONE subject (Q5: assistants handle members, not official files; fail closed without roles)', () => {
    const deps = { memberships: provider };
    const p = (w: Who) => {
      const x = lecturePowers(viewerOf(w), 'SP1', deps);
      return [x.member, x.officialModerator, x.contributor];
    };
    expect(p('moderator')).toEqual([true, true, true]);
    expect(p('admin')).toEqual([true, true, true]);
    expect(p('contributor')).toEqual([true, false, true]);
    expect(p('student')).toEqual([true, false, false]);
    expect(p('assistant')).toEqual([true, false, false]);
    expect(p('platform_admin_member')).toEqual([true, false, false]);
    expect(p('platform_admin_moderator')).toEqual([true, true, true]);
    expect(p('no_roles_moderator')).toEqual([true, false, false]);
    expect(p('pending')).toEqual([false, false, false]);
    expect(p('outsider')).toEqual([false, false, false]);
    // a moderator of another subject is nobody here
    expect(p('other_subject')).toEqual([false, false, false]);
  });

  it('matrix: role × action × status → allow / 403 / 404', () => {
    const authz = setup();
    const actions: Action[] = ['view', 'create', 'edit', 'suggest', 'approve', 'publish', 'withdraw', 'delete'];
    const statuses = ['draft', 'in_review', 'published', 'withdrawn'];
    const table: Record<string, string> = {};
    for (const who of Object.keys(M) as Who[]) {
      for (const status of statuses) {
        for (const action of actions) table[`${who}|${status}|${action}`] = outcome(authz.can(viewerOf(who), action, lecture(status)));
      }
    }
    const row = (who: Who, status: string) => actions.map((a) => table[`${who}|${status}|${a}`]).join(' ');
    //                                                view   create edit   suggest approve publish withdraw delete
    expect(row('moderator', 'draft')).toBe('allow allow allow allow allow allow allow 403');
    expect(row('moderator', 'published')).toBe('allow allow allow allow allow allow allow 403');
    expect(row('moderator', 'withdrawn')).toBe('allow 403 403 403 403 403 allow 403');
    expect(row('uploader', 'draft')).toBe('allow allow allow allow 403 403 403 403');
    expect(row('uploader', 'in_review')).toBe('allow allow allow allow 403 403 403 403');
    expect(row('uploader', 'published')).toBe('allow allow 403 allow 403 403 403 403');
    // another contributor never sees someone else's draft
    expect(row('contributor', 'draft')).toBe('404 404 404 404 404 404 404 404');
    expect(row('contributor', 'published')).toBe('allow allow 403 allow 403 403 403 403');
    expect(row('student', 'draft')).toBe('404 404 404 404 404 404 404 404');
    expect(row('student', 'published')).toBe('allow 403 403 403 403 403 403 403');
    expect(row('student', 'withdrawn')).toBe('allow 403 403 403 403 403 403 403');
    expect(row('assistant', 'draft')).toBe('404 404 404 404 404 404 404 404');
    expect(row('assistant', 'published')).toBe('allow 403 403 403 403 403 403 403');
    for (const who of ['outsider', 'other_subject', 'pending'] as const) {
      for (const status of statuses) expect(row(who, status), `${who} ${status}`).toBe('404 404 404 404 404 404 404 404');
    }
    // creating a NEW lecture (id '') is for contributors and moderators
    expect(outcome(authz.can(viewerOf('contributor'), 'create', lecture('draft', 'contributor', '')))).toBe('allow');
    expect(outcome(authz.can(viewerOf('student'), 'create', lecture('draft', 'student', '')))).toBe('403');
    expect(outcome(authz.can(viewerOf('assistant'), 'create', lecture('draft', 'assistant', '')))).toBe('403');
  });

  it('powers come from the membership in the lecture’s OWN space: a moderator of another space is nobody here', () => {
    const authz = setup();
    expect(outcome(authz.can(viewerOf('moderator'), 'view', { ...lecture('published'), spaceId: 'SP2' }))).toBe('404');
    expect(outcome(authz.can(viewerOf('other_subject'), 'view', { ...lecture('published'), spaceId: 'SP2' }))).toBe('allow');
  });

  it('subject content (resource «space») and space files', () => {
    const authz = setup();
    const space = { type: 'space' as const, id: 'SP1' };
    expect(outcome(authz.can(viewerOf('student'), 'list', space))).toBe('allow');
    expect(outcome(authz.can(viewerOf('student'), 'publish', space))).toBe('403');
    expect(outcome(authz.can(viewerOf('contributor'), 'publish', space))).toBe('allow');
    expect(outcome(authz.can(viewerOf('assistant'), 'publish', space))).toBe('403');
    expect(outcome(authz.can(viewerOf('outsider'), 'list', space))).toBe('404');
    expect(outcome(authz.can(viewerOf('moderator'), 'manage_members', space))).toBe('404'); // not this rule's business
    const file = { type: 'file' as const, db: 's:SP1', fileId: 'F1' };
    expect(outcome(authz.can(viewerOf('student'), 'view', file))).toBe('allow');
    expect(outcome(authz.can(viewerOf('outsider'), 'view', file))).toBe('404');
    expect(outcome(authz.can(viewerOf('student'), 'delete', file))).toBe('404');
    // a vault file is never decided here (the binding reaches only the viewer's own vault)
    expect(outcome(authz.can(viewerOf('student'), 'view', { type: 'file', db: 'v:V1', fileId: 'F1' }))).toBe('404');
  });

  it('a membership provider that throws never allows', () => {
    const authz = createAuthz();
    authz.setMembershipProvider({ accessToSpace: () => { throw new Error('boom'); } });
    registerLectureRules(authz);
    expect(outcome(authz.can(viewerOf('moderator'), 'view', lecture('published')))).toBe('404');
  });
});
