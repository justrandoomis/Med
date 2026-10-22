// P1-T4 step 1 — roles with inheritance down the tree (PRD AOS-2.14, 18.6, 21.18; ARCHITECTURE_DELTA §5.1, §5.3, §5.5):
//   * the platform admin assigns any role; an Admin assigns roles BELOW Admin in their subtree; nobody else assigns;
//   * a role inherits down the tree and never to a sibling: a Subject Moderator of A has no power in B;
//   * gate 2 (the binding of /api/spaces/:spaceId) uses the real membership provider: member / moderator access per
//     subject, 403 MEMBERSHIP_PENDING for a pending request, 404 for anyone else — the body of a missing route.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelNodeView, ChannelRolesResponse, ChannelRoleView } from '@medlevo/shared';
import { MODULES, type ModuleEntry } from '../../src/modules';
import { SPACE_ROUTE_PREFIX } from '../../src/modules/authz/routes';
import type { SpaceRouteGrant } from '../../src/system/binding';
import { assignRole, call, type ChannelWorld, channelWorld, createCode, createNode, ok, type Person, person } from './helpers';

const probe: ModuleEntry = {
  name: 'channels-roles-probe',
  prefix: '/api/spaces',
  plugin: async (app, { ctx }) => {
    const where = async () => {
      const b = ctx.binding.current();
      return b?.kind === 'space' ? { space: b.spaceId, subject: b.subjectNodeId, access: b.access } : { kind: b?.kind };
    };
    app.get('/:spaceId/probe-read', where);
    app.post('/:spaceId/probe-moderate', where);
  },
};
const grants: SpaceRouteGrant[] = [
  { module: 'channels-roles-probe', method: 'GET', path: `${SPACE_ROUTE_PREFIX}/probe-read`, minAccess: 'member' },
  { module: 'channels-roles-probe', method: 'POST', path: `${SPACE_ROUTE_PREFIX}/probe-moderate`, minAccess: 'moderator' },
];

let w: ChannelWorld;
let uni: ChannelNodeView;
let other: ChannelNodeView;
let stage: ChannelNodeView;
let a: ChannelNodeView;
let b: ChannelNodeView;
let x: ChannelNodeView;
let admin: Person;
let assistant: Person;
let modA: Person;
let contrib: Person;
let student: Person;
let pending: Person;
let outsider: Person;

beforeAll(async () => {
  w = await channelWorld({ modules: [...MODULES, probe], spaceRoutes: grants });
  uni = await createNode(w.t, w.pa, null, 'university', 'جامعة الأدوار');
  other = await createNode(w.t, w.pa, null, 'university', 'جامعة أخرى');
  stage = await createNode(w.t, w.pa, uni.id, 'stage', 'المرحلة الثانية');
  a = await createNode(w.t, w.pa, stage.id, 'subject', 'المادة أ');
  b = await createNode(w.t, w.pa, stage.id, 'subject', 'المادة ب');
  x = await createNode(w.t, w.pa, other.id, 'subject', 'المادة س');
  admin = await person(w.t, 'r_admin');
  assistant = await person(w.t, 'r_assistant');
  modA = await person(w.t, 'r_mod_a');
  contrib = await person(w.t, 'r_contrib');
  student = await person(w.t, 'r_student');
  pending = await person(w.t, 'r_pending');
  outsider = await person(w.t, 'r_outsider');
  await assignRole(w.t, w.pa, uni.id, admin.user.id, 'admin');
  await assignRole(w.t, admin.h, stage.id, assistant.user.id, 'assistant');
  await assignRole(w.t, admin.h, a.id, modA.user.id, 'subject_moderator');
  await assignRole(w.t, admin.h, a.id, contrib.user.id, 'contributor');
  // the student joins the STAGE (inherits A and B); the pending one asks for A
  const stageOpen = ok<ChannelNodeView>(await call(w.t, w.pa, 'PATCH', `/api/channels/nodes/${stage.id}`, { join_policy: 'open_with_code' }));
  expect(stageOpen.join_policy).toBe('open_with_code');
  ok(await call(w.t, student.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, w.pa, stage.id, { requires_approval: false })).code }));
  ok(await call(w.t, pending.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, w.pa, a.id)).code }));
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const space = (n: ChannelNodeView) => n.space_id!;
const read = (p: Person, n: ChannelNodeView) => call(w.t, p.h, 'GET', `/api/spaces/${space(n)}/probe-read`);
const moderate = (p: Person, n: ChannelNodeView) => call(w.t, p.h, 'POST', `/api/spaces/${space(n)}/probe-moderate`, {});

describe('who assigns which role', () => {
  it('an Admin assigns roles below Admin, never Admin; an Assistant, a moderator and a student assign nothing', async () => {
    const target = await person(w.t, 'r_target');
    const r = await call(w.t, admin.h, 'POST', `/api/channels/nodes/${a.id}/roles`, { user_id: target.user.id, role: 'admin' });
    expect(r.statusCode).toBe(403);
    for (const p of [assistant, modA, student]) {
      expect((await call(w.t, p.h, 'POST', `/api/channels/nodes/${a.id}/roles`, { user_id: target.user.id, role: 'contributor' })).statusCode, p.user.username).toBe(403);
    }
    // the outsider sees the node (titles are public to signed-in users) but may not act: 403
    expect((await call(w.t, outsider.h, 'POST', `/api/channels/nodes/${a.id}/roles`, { user_id: target.user.id, role: 'contributor' })).statusCode).toBe(403);
    // an Admin of one university assigns nothing in another
    expect((await call(w.t, admin.h, 'POST', `/api/channels/nodes/${x.id}/roles`, { user_id: target.user.id, role: 'contributor' })).statusCode).toBe(403);
    // assigning the same role twice returns the same assignment
    const first = await assignRole(w.t, admin.h, b.id, target.user.id, 'contributor');
    expect((await assignRole(w.t, admin.h, b.id, target.user.id, 'contributor')).id).toBe(first.id);
    // an unknown account is a 404
    expect((await call(w.t, admin.h, 'POST', `/api/channels/nodes/${a.id}/roles`, { user_id: 'NO_SUCH_USER', role: 'contributor' })).statusCode).toBe(404);
  });

  it('roles are listed with where they come from (inherited ones included); only admins and assistants see the list', async () => {
    const list = ok<ChannelRolesResponse>(await call(w.t, admin.h, 'GET', `/api/channels/nodes/${a.id}/roles`));
    const pairs = list.roles.map((r) => [r.user.id, r.role, r.node.id]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        [admin.user.id, 'admin', uni.id],
        [assistant.user.id, 'assistant', stage.id],
        [modA.user.id, 'subject_moderator', a.id],
        [contrib.user.id, 'contributor', a.id],
      ]),
    );
    expect(list.roles.find((r) => r.user.id === modA.user.id)!.granted_by.id).toBe(admin.user.id);
    expect((await call(w.t, assistant.h, 'GET', `/api/channels/nodes/${a.id}/roles`)).statusCode).toBe(200);
    expect((await call(w.t, student.h, 'GET', `/api/channels/nodes/${a.id}/roles`)).statusCode).toBe(403);
  });

  it('revoking: an Admin revokes a role below Admin in the subtree; never an Admin role; others get the 404 of a missing id', async () => {
    const p = await person(w.t, 'r_revoked');
    const role = await assignRole(w.t, admin.h, a.id, p.user.id, 'contributor');
    const outsiderTry = await call(w.t, outsider.h, 'DELETE', `/api/channels/roles/${role.id}`);
    expect(outsiderTry.statusCode).toBe(404);
    expect(outsiderTry.body).toBe((await call(w.t, outsider.h, 'DELETE', '/api/channels/roles/NO_SUCH_ROLE')).body);
    const done = ok<ChannelRoleView & { revoked_at?: number }>(await call(w.t, admin.h, 'DELETE', `/api/channels/roles/${role.id}`));
    expect(done.id).toBe(role.id);
    const adminRole = ok<ChannelRolesResponse>(await call(w.t, admin.h, 'GET', `/api/channels/nodes/${uni.id}/roles`)).roles.find((r) => r.role === 'admin')!;
    expect((await call(w.t, admin.h, 'DELETE', `/api/channels/roles/${adminRole.id}`)).statusCode).toBe(403);
    expect(ok<ChannelRolesResponse>(await call(w.t, admin.h, 'GET', `/api/channels/nodes/${a.id}/roles`)).roles.some((r) => r.id === role.id)).toBe(false);
  });
});

describe('inheritance and gate 2 with the real membership provider', () => {
  it('node views show inherited roles and memberships', async () => {
    const seenByMod = ok<ChannelNodeView>(await call(w.t, modA.h, 'GET', `/api/channels/nodes/${a.id}`));
    expect(seenByMod.viewer).toMatchObject({ roles: ['subject_moderator'], inherited_from: null });
    expect(seenByMod.space_id).toBe(space(a));
    const seenByAdmin = ok<ChannelNodeView>(await call(w.t, admin.h, 'GET', `/api/channels/nodes/${a.id}`));
    expect(seenByAdmin.viewer).toMatchObject({ roles: ['admin'], inherited_from: { id: uni.id } });
    const seenByStudent = ok<ChannelNodeView>(await call(w.t, student.h, 'GET', `/api/channels/nodes/${b.id}`));
    expect(seenByStudent.viewer.membership).toMatchObject({ status: 'approved', node: { id: stage.id } });
    expect(seenByStudent.viewer.inherited_from).toEqual({ id: stage.id, kind: 'stage', title: 'المرحلة الثانية' });
    expect(seenByStudent.space_id).toBe(space(b));
    const seenByOutsider = ok<ChannelNodeView>(await call(w.t, outsider.h, 'GET', `/api/channels/nodes/${a.id}`));
    expect(seenByOutsider).toMatchObject({ space_id: null, viewer: { membership: null, roles: [] } });
  });

  it('member / moderator access per subject, never across subjects or universities', async () => {
    expect(ok<{ access: string }>(await read(student, a)).access).toBe('member');
    expect(ok<{ access: string }>(await read(student, b)).access).toBe('member');
    expect(ok<{ access: string }>(await read(contrib, a)).access).toBe('member');
    expect(ok<{ access: string }>(await read(modA, a)).access).toBe('moderator');
    expect(ok<{ access: string }>(await read(assistant, b)).access).toBe('moderator');
    expect(ok<{ access: string }>(await read(admin, a)).access).toBe('moderator');
    expect(ok<{ access: string; subject: string }>(await read(admin, a)).subject).toBe(a.id);
    // the moderator of A has nothing in B; a student moderates nothing; the admin has nothing in another university
    const missing = (await call(w.t, outsider.h, 'GET', '/api/spaces/NO_SUCH_SPACE/probe-read')).body;
    for (const [p, n] of [
      [modA, b],
      [contrib, b],
      [outsider, a],
      [admin, x],
      [student, x],
    ] as const) {
      const r = await read(p, n);
      expect(r.statusCode, `${p.user.username} → ${n.title}`).toBe(404);
      expect(r.body).toBe(missing);
    }
    expect((await moderate(student, a)).statusCode).toBe(403);
    expect((await moderate(contrib, a)).statusCode).toBe(403);
    expect((await moderate(modA, a)).statusCode).toBe(200);
    expect((await moderate(modA, b)).statusCode).toBe(404);
  });

  it('a pending request answers 403 MEMBERSHIP_PENDING; approval opens the space', async () => {
    const r = await read(pending, a);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('MEMBERSHIP_PENDING');
    expect((await read(pending, b)).statusCode).toBe(404);
    ok(await call(w.t, assistant.h, 'POST', `/api/channels/nodes/${a.id}/members/${pending.user.id}/decision`, { decision: 'approve' }));
    expect(ok<{ access: string }>(await read(pending, a)).access).toBe('member');
  });

  it('revoking a role takes its power away at once', async () => {
    const p = await person(w.t, 'r_short_mod');
    const role = await assignRole(w.t, admin.h, b.id, p.user.id, 'subject_moderator');
    expect((await moderate(p, b)).statusCode).toBe(200);
    ok(await call(w.t, admin.h, 'DELETE', `/api/channels/roles/${role.id}`));
    expect((await moderate(p, b)).statusCode).toBe(404);
  });
});
