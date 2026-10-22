// X9 — the generated permission matrix (BUILD_PLAN §3.6 «test/authz/matrix.test.ts»; PRD AOS-2.14, 18.6, 21.18, 21.37;
// ARCHITECTURE_DELTA §5.3, §5.5, §5.7). Every resource type with a registered rule × every action × every principal of
// the world (each role, each membership state, in scope and out of it, archived) is asked of the REAL policy and
// compared with the expectation written below from §5.3 / PRD §4.3 — 404 (hidden) vs 403 (visible, not allowed) vs
// 403 MEMBERSHIP_PENDING vs allowed. Then the same expectations are checked through the HTTP routes, so a handler that
// skips the policy, or answers 403 where existence must not leak, fails too.
//
// P1-T5 adds its resources (official_lecture, publication, layer, file) as specs on this world; the test refuses to
// pass while a resource type has a registered rule and no spec.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JoinCodesResponse } from '@medlevo/shared';
import type { Action } from '../../src/modules/authz/policy';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_ACTIONS, ALL_RESOURCE_TYPES, type MatrixSpec, type Outcome, runMatrix, sampleResource, uncoveredResourceTypes, unruledResourceTypes } from '../../src/modules/authz/test-support/matrix';
import { createTestApp, type TestApp } from '../helpers/app';
import { call } from '../channels/helpers';
import { ARCHIVED, buildMatrixWorld, chainOf, type MatrixWorld, NODE_KEYS, type NodeKey, PRINCIPALS, SUBJECTS } from './world';
// P1-T5 step 1: official lectures, the subject-content `publish` of a space, space files
import { expectSpaceByLectures, lectureMatrixSpecs } from '../lectures/matrix-specs';

let t: TestApp;
let w: MatrixWorld;

beforeAll(async () => {
  t = await createTestApp();
  w = await buildMatrixWorld(t, await t.login());
}, 300_000);
afterAll(async () => {
  await t?.close();
});

// ───────── the expectations (ARCHITECTURE_DELTA §5.3, PRD §4.3), written from the profiles, not from the rules ─────────

type Role = 'admin' | 'assistant' | 'subject_moderator' | 'contributor';
const isPa = (p: string) => PRINCIPALS[p]!.platformAdmin === true;
/** the principal holds one of `roles` on the node or an ancestor (roles inherit down the tree, never sideways) */
const holds = (p: string, node: NodeKey, roles: Role[]) => {
  const chain = chainOf(node);
  return (PRINCIPALS[p]!.roles ?? []).some((r) => roles.includes(r.role) && chain.includes(r.on));
};
const archivedChain = (node: NodeKey) => chainOf(node).some((k) => ARCHIVED.includes(k));
/** an approved membership on the node or an ancestor — that stops granting access once the node is archived */
const approvedMember = (p: string, node: NodeKey) => {
  const m = PRINCIPALS[p]!.membership;
  return !!m && m.status === 'approved' && chainOf(node).includes(m.on) && !archivedChain(node);
};
const pendingOnly = (p: string, node: NodeKey) => {
  const m = PRINCIPALS[p]!.membership;
  return !!m && m.status === 'pending' && chainOf(node).includes(m.on) && !archivedChain(node);
};

function expectNode(p: string, action: Action, target: string): Outcome {
  if (target === 'MISSING') return 'hidden';
  if (target === 'ROOT') {
    if (action === 'view' || action === 'list') return 'allow';
    if (action === 'create') return isPa(p) ? 'allow' : 'forbidden';
    return 'hidden';
  }
  const node = target as NodeKey;
  switch (action) {
    case 'view':
    case 'list':
      return 'allow'; // titles: every signed-in user (§7.3)
    case 'create':
    case 'edit':
    case 'delete':
    case 'assign_role':
      return isPa(p) || holds(p, node, ['admin']) ? 'allow' : 'forbidden';
    case 'manage_members':
    case 'manage_codes':
      return isPa(p) || holds(p, node, ['admin', 'assistant']) ? 'allow' : 'forbidden';
    case 'view_audit':
      // the scoped audit view: Admin / Assistant subtree, platform admin all (§5.3; P1-T4 step 2 settles review N6)
      return isPa(p) || holds(p, node, ['admin', 'assistant']) ? 'allow' : 'forbidden';
    case 'view_stats':
      // «Subject Moderator: own subject (aggregates)» — only on a subject
      return isPa(p) || holds(p, node, ['admin', 'assistant']) || (SUBJECTS.includes(node) && holds(p, node, ['subject_moderator'])) ? 'allow' : 'forbidden';
    case 'moderate':
      // the report queue and moderation actions (P1-T4 step 2): moderators of the scope or above; anyone else 404
      return isPa(p) || holds(p, node, ['admin', 'assistant', 'subject_moderator']) ? 'allow' : 'hidden';
    case 'follow':
      if (!SUBJECTS.includes(node)) return 'forbidden';
      if (isPa(p) || holds(p, node, ['admin', 'assistant', 'subject_moderator', 'contributor']) || approvedMember(p, node)) return 'allow';
      return pendingOnly(p, node) ? 'pending' : 'forbidden';
    default:
      return 'hidden'; // no rule: deny by default
  }
}

function expectSpace(p: string, action: Action, target: string): Outcome {
  if (target === 'MISSING') return 'hidden';
  const node = target as NodeKey;
  const moderator = isPa(p) || holds(p, node, ['admin', 'assistant', 'subject_moderator']);
  const member = moderator || holds(p, node, ['contributor']) || approvedMember(p, node);
  if (!member) return pendingOnly(p, node) && ['view', 'list', 'moderate'].includes(action) ? 'pending' : 'hidden';
  if (action === 'view' || action === 'list') return 'allow';
  if (action === 'moderate') return moderator ? 'allow' : 'forbidden';
  return expectSpaceByLectures(p, action, node) ?? 'hidden';
}

const principals = () => Object.keys(PRINCIPALS).map((key) => ({ key, viewer: w.viewer(key) }));

function specs(): MatrixSpec[] {
  const vaultOf = (key: string) => w.t.ctx.system.vaults.ofUserInternal(w.viewer(key).userId)!;
  return [
    {
      resource: 'channel_node',
      targets: [
        { key: 'ROOT', resource: { type: 'channel_node', id: '' } },
        { key: 'MISSING', resource: { type: 'channel_node', id: 'NO_SUCH_NODE' } },
        ...NODE_KEYS.map((k) => ({ key: k, resource: { type: 'channel_node' as const, id: w.nodes[k].id } })),
      ],
      expect: expectNode,
    },
    {
      resource: 'space',
      targets: [{ key: 'MISSING', resource: { type: 'space', id: 'NO_SUCH_SPACE' } }, ...SUBJECTS.map((k) => ({ key: k, resource: { type: 'space' as const, id: w.nodes[k].space_id! } }))],
      expect: expectSpace,
    },
    {
      resource: 'platform',
      targets: [{ key: 'backups', resource: { type: 'platform', operation: 'GET /api/data/backups' } }],
      expect: (p) => (isPa(p) ? 'allow' : 'hidden'),
    },
    {
      resource: 'vault',
      targets: ['pa', 'student_a'].map((owner) => ({ key: owner, resource: { type: 'vault' as const, vaultId: vaultOf(owner).id, ownerUserId: w.viewer(owner).userId } })),
      // a vault is its owner's only — the platform admin included (§5.3 last row)
      expect: (p, _a, target) => (p === target ? 'allow' : 'hidden'),
    },
    ...lectureMatrixSpecs(w),
    // deny by default: every resource type no rule decides on yet is hidden from everyone, the platform admin included
    // (review P1-T4 step 1 — the matrix asks EVERY resource type of the policy, not only the ruled ones)
    ...unruledResourceTypes(w.t.ctx.authz).map(
      (type): MatrixSpec => ({
        resource: type,
        targets: SUBJECTS.map((k) => ({ key: k, resource: sampleResource(type, { spaceId: w.nodes[k].space_id!, vaultId: vaultOf('student_a').id, ownerUserId: w.viewer('student_a').userId, nodeId: w.nodes[k].id }) })),
        expect: () => 'hidden',
      }),
    ),
  ];
}

describe('X9 — policy matrix: resource × action × role × membership state × scope', () => {
  it('every resource type with a registered rule has a spec (the matrix gains every new resource)', () => {
    expect(uncoveredResourceTypes(w.t.ctx.authz, specs())).toEqual([]);
  });

  it('every resource type of the policy is asked with every action (unruled ones must be hidden from everyone)', () => {
    const asked = new Set(specs().map((sp) => sp.resource));
    expect(ALL_RESOURCE_TYPES.filter((type) => !asked.has(type))).toEqual([]);
    // today: publications, layers, discussions, collaborative copies, rooms and recordings have no rule yet
    expect(unruledResourceTypes(w.t.ctx.authz).length).toBeGreaterThan(0);
    expect(ALL_ACTIONS).toContain('operate');
  });

  it('the real policy answers every case as §5.3 says (allow / 403 / 404 / 403 pending)', () => {
    const report = runMatrix(w.t.ctx.authz, principals(), specs());
    expect(report.failures).toEqual([]);
    // the matrix is large and not trivially «all hidden»
    expect(report.cases).toBeGreaterThan(5000);
    for (const o of ['allow', 'forbidden', 'hidden', 'pending'] as const) expect(report.outcomes[o], o).toBeGreaterThan(0);
  });

  it('a Subject Moderator of A has no power in B; an Admin of U1 none in U2 (spot checks of the generated cases)', () => {
    const can = (p: string, action: Action, r: Parameters<typeof w.t.ctx.authz.can>[2]) => w.t.ctx.authz.can(w.viewer(p), action, r);
    expect(can('mod_a', 'moderate', { type: 'space', id: w.nodes.A.space_id! }).allowed).toBe(true);
    expect(can('mod_a', 'view', { type: 'space', id: w.nodes.B.space_id! }).reason?.hide).toBe(true);
    expect(can('admin_u1', 'edit', { type: 'channel_node', id: w.nodes.X.id }).reason?.hide).toBe(false);
    expect(can('admin_u1', 'edit', { type: 'channel_node', id: w.nodes.X.id }).allowed).toBe(false);
    expect(can('assistant_c1', 'assign_role', { type: 'channel_node', id: w.nodes.A.id }).allowed).toBe(false);
    // an Admin below the root is never an Admin upward or sideways
    expect(can('admin_c1', 'edit', { type: 'channel_node', id: w.nodes.A.id }).allowed).toBe(true);
    expect(can('admin_c1', 'edit', { type: 'channel_node', id: w.nodes.U1.id }).allowed).toBe(false);
    expect(can('admin_c1', 'view', { type: 'space', id: w.nodes.X.space_id! }).reason?.hide).toBe(true);
    // a pending request on the stage is pending in each of its subjects, and nothing elsewhere
    expect(can('pending_s', 'view', { type: 'space', id: w.nodes.A.space_id! }).reason?.code).toBe('MEMBERSHIP_PENDING');
    expect(can('pending_s', 'view', { type: 'space', id: w.nodes.X.space_id! }).reason?.hide).toBe(true);
  });
});

// ───────── the same expectations through the routes ─────────

const STATUS: Record<Outcome, number> = { allow: 200, forbidden: 403, hidden: 404, pending: 403 };

describe('X9 — route matrix: every channel route applies the policy (status per principal)', () => {
  it('node-addressed routes answer 200 / 403 per §5.3 (nodes are visible, so a refusal is a 403)', async () => {
    const failures: string[] = [];
    const routes = NODE_ROUTES();
    for (const r of routes) {
      for (const p of Object.keys(PRINCIPALS)) {
        const h = p === 'pa' ? w.pa : w.people[p]!.h;
        const res = await r.run(h);
        const want = STATUS[expectNode(p, r.action, r.node)];
        if (res.statusCode !== want) failures.push(`${r.name} as ${p}: expected ${want}, got ${res.statusCode} ${res.body.slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it('every /api/channels route is in the route matrix, or names the test that checks who may call it', () => {
    // the routes the channels plugin registers, read from its source (a new route without a matrix entry fails here)
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'modules', 'channels', 'index.ts'), 'utf8');
    const registered = [...src.matchAll(/^\s*app\.(get|post|patch|put|delete)\('([^']+)'/gm)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`).sort();
    expect(registered.length).toBeGreaterThan(15);
    const matrixRoutes = NODE_ROUTES().map((r) => r.route);
    const elsewhere: Record<string, string> = {
      // id-addressed: the 404 of a missing id to anyone who may not act (the test below)
      'DELETE /codes/:id': 'matrix.test.ts «id-addressed routes»',
      'DELETE /roles/:id': 'matrix.test.ts «id-addressed routes»',
      'POST /invitations/:id/decision': 'matrix.test.ts «id-addressed routes»',
      // (C2, AOS-18.5) revoking an invitation: the 404 of a missing id to anyone who may not manage the node
      'DELETE /invitations/:id': 'matrix.test.ts «a role id and an invitation id…»; invitations-admin.c2.test.ts',
      // the viewer's own things: every signed-in user, nobody else's rows (join.test.ts «invitations», «CSRF and session»)
      'GET /invitations': 'join.test.ts «invitations (existing accounts only)»',
      // (C1, AOS-21.5) the viewer's own course mappings (her follows), nobody else's
      'GET /course-mappings': "course-mapping.c1.test.ts «the mapping is Maryam's own»",
      'POST /join': 'join.test.ts «class codes»',
      'POST /join/link': 'join.test.ts «invite links and the public preview»',
      // public: the title only, the body of a missing route otherwise
      'GET /join/preview': 'join.test.ts «the preview is public…», g8-security.test.ts',
      // archive itself (the preview is in the matrix): tree.test.ts «archive with an impact preview»
      'POST /nodes/:id/archive': 'matrix route «archive preview»; tree.test.ts',
      // the viewer's own follow only, idempotent (P1-T4 step 2)
      'DELETE /subjects/:id/follow': 'follow.test.ts «the follow is the viewer\'s own»; ac01b.test.ts',
    };
    const uncovered = registered.filter((r) => !matrixRoutes.includes(r) && !(r in elsewhere));
    expect(uncovered).toEqual([]);
  });

  // the node-addressed routes of the matrix, each with the action the policy decides for it
  function NODE_ROUTES(): Array<{ name: string; route: string; action: Action; node: NodeKey; run: (h: Record<string, string>) => ReturnType<typeof call> }> {
    return [
      { name: 'GET node', route: 'GET /nodes/:id', action: 'view', node: 'A', run: (h) => call(t, h as never, 'GET', `/api/channels/nodes/${w.nodes.A.id}`) },
      { name: 'GET tree', route: 'GET /tree', action: 'list', node: 'U1', run: (h) => call(t, h as never, 'GET', `/api/channels/tree?root=${w.nodes.U1.id}`) },
      { name: 'PATCH node', route: 'PATCH /nodes/:id', action: 'edit', node: 'B', run: (h) => call(t, h as never, 'PATCH', `/api/channels/nodes/${w.nodes.B.id}`, { ordinal: 2 }) },
      { name: 'archive preview', route: 'POST /nodes/:id/archive', action: 'delete', node: 'A', run: (h) => call(t, h as never, 'POST', `/api/channels/nodes/${w.nodes.A.id}/archive`, { preview: true }) },
      { name: 'members', route: 'GET /nodes/:id/members', action: 'manage_members', node: 'A', run: (h) => call(t, h as never, 'GET', `/api/channels/nodes/${w.nodes.A.id}/members`) },
      {
        // approving an approved member changes nothing: 200 for whoever may decide, 403 for everyone else
        name: 'member decision',
        route: 'POST /nodes/:id/members/:userId/decision',
        action: 'manage_members',
        node: 'A',
        run: (h) => call(t, h as never, 'POST', `/api/channels/nodes/${w.nodes.A.id}/members/${w.people.student_a!.user.id}/decision`, { decision: 'approve' }),
      },
      { name: 'codes', route: 'GET /nodes/:id/codes', action: 'manage_codes', node: 'A', run: (h) => call(t, h as never, 'GET', `/api/channels/nodes/${w.nodes.A.id}/codes`) },
      {
        name: 'create code',
        route: 'POST /nodes/:id/codes',
        action: 'manage_codes',
        node: 'B',
        run: (h) => call(t, h as never, 'POST', `/api/channels/nodes/${w.nodes.B.id}/codes`, { kind: 'class_code', expires_in_hours: 1, requires_approval: true }),
      },
      { name: 'roles list', route: 'GET /nodes/:id/roles', action: 'manage_members', node: 'A', run: (h) => call(t, h as never, 'GET', `/api/channels/nodes/${w.nodes.A.id}/roles`) },
      {
        name: 'assign contributor',
        route: 'POST /nodes/:id/roles',
        action: 'assign_role',
        node: 'B',
        run: (h) => call(t, h as never, 'POST', `/api/channels/nodes/${w.nodes.B.id}/roles`, { user_id: w.people.outsider!.user.id, role: 'contributor' }),
      },
      {
        name: 'invite',
        route: 'POST /nodes/:id/invitations',
        action: 'manage_members',
        node: 'B',
        run: (h) => call(t, h as never, 'POST', `/api/channels/nodes/${w.nodes.B.id}/invitations`, { user_ids: [w.people.outsider!.user.id] }),
      },
      // (C2, AOS-18.5) the invitations sent into a node and the person picker: who manages the node's members
      { name: 'invitations sent', route: 'GET /nodes/:id/invitations', action: 'manage_members', node: 'A', run: (h) => call(t, h as never, 'GET', `/api/channels/nodes/${w.nodes.A.id}/invitations`) },
      { name: 'invitee picker', route: 'GET /nodes/:id/invitees', action: 'manage_members', node: 'A', run: (h) => call(t, h as never, 'GET', `/api/channels/nodes/${w.nodes.A.id}/invitees?q=nobody-here`) },
      { name: 'create subject', route: 'POST /nodes', action: 'create', node: 'S', run: (h) => call(t, h as never, 'POST', '/api/channels/nodes', { parent_id: w.nodes.S.id, kind: 'subject', title: 'مادة من المصفوفة' }) },
      // P1-T4 step 2: «تابع المادة» — members of the subject; pending 403 MEMBERSHIP_PENDING; anyone else 403
      { name: 'follow subject', route: 'PUT /subjects/:id/follow', action: 'follow', node: 'A', run: (h) => call(t, h as never, 'PUT', `/api/channels/subjects/${w.nodes.A.id}/follow`, { add_new_lectures: true }) },
    ];
  }

  it('id-addressed routes (a code, a role) answer the 404 of a missing id to anyone who may not manage them', async () => {
    const codes = (await call(t, w.pa, 'GET', `/api/channels/nodes/${w.nodes.A.id}/codes`)).json() as JoinCodesResponse;
    const codeId = codes.codes[0]!.id;
    const failures: string[] = [];
    for (const p of Object.keys(PRINCIPALS)) {
      if (p === 'pa') continue;
      const h = w.people[p]!.h;
      const missing = await call(t, h, 'DELETE', '/api/channels/codes/NO_SUCH_CODE');
      // a fresh code each time for those who may revoke it, so every principal meets a live code
      const fresh = ((await call(t, w.pa, 'POST', `/api/channels/nodes/${w.nodes.A.id}/codes`, { kind: 'class_code', expires_in_hours: 1, requires_approval: true })).json() as { view: { id: string } }).view.id;
      const res = await call(t, h, 'DELETE', `/api/channels/codes/${fresh}`);
      const allowed = expectNode(p, 'manage_codes', 'A') === 'allow';
      if (allowed ? res.statusCode !== 200 : res.statusCode !== 404 || res.body !== missing.body) failures.push(`revoke code as ${p}: ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
    expect(codeId).toBeTruthy();
  }, 120_000);

  it('a role id and an invitation id answer the 404 of a missing id to anyone who may not act on them', async () => {
    const failures: string[] = [];
    const roles = (await call(t, w.pa, 'GET', `/api/channels/nodes/${w.nodes.A.id}/roles`)).json() as { roles: Array<{ id: string; role: string; node: { id: string } }> };
    const modRole = roles.roles.find((r) => r.role === 'subject_moderator' && r.node.id === w.nodes.A.id)!;
    const invitee = w.people.outsider!;
    const inv = (await call(t, w.pa, 'POST', `/api/channels/nodes/${w.nodes.B.id}/invitations`, { user_ids: [invitee.user.id] })).json() as { invitations: Array<{ id: string }> };
    const invId = inv.invitations[0]!.id;
    for (const p of Object.keys(PRINCIPALS)) {
      if (p === 'pa') continue;
      const h = w.people[p]!.h;
      // the role: only those who may assign roles on A (Admins above it) may act; everyone else meets a missing id
      if (expectNode(p, 'assign_role', 'A') !== 'allow') {
        const res = await call(t, h, 'DELETE', `/api/channels/roles/${modRole.id}`);
        const missing = await call(t, h, 'DELETE', '/api/channels/roles/NO_SUCH_ROLE');
        if (res.statusCode !== 404 || res.body !== missing.body) failures.push(`revoke role as ${p}: ${res.statusCode}`);
      }
      // (C2) revoking it: only who may manage B's members; everyone else meets a missing id (nothing is revoked)
      if (expectNode(p, 'manage_members', 'B') !== 'allow') {
        const res = await call(t, h, 'DELETE', `/api/channels/invitations/${invId}`);
        const missing = await call(t, h, 'DELETE', '/api/channels/invitations/NO_SUCH_INVITATION');
        if (res.statusCode !== 404 || res.body !== missing.body) failures.push(`revoke invitation as ${p}: ${res.statusCode}`);
      }
      // the invitation: only its invitee
      if (p !== 'outsider') {
        const res = await call(t, h, 'POST', `/api/channels/invitations/${invId}/decision`, { accept: true });
        const missing = await call(t, h, 'POST', '/api/channels/invitations/NO_SUCH_INVITATION/decision', { accept: true });
        if (res.statusCode !== 404 || res.body !== missing.body) failures.push(`decide invitation as ${p}: ${res.statusCode}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

// ───────── P1-T4 step 2: the moderation queue and the scoped audit view, for every principal ─────────

describe('X9 — moderation and audit routes apply the policy (status per principal)', () => {
  it('GET /api/moderation/queue answers the moderators of the scope (or above) and 404 to everyone else; the audit view 200 / 403', async () => {
    const failures: string[] = [];
    for (const scope of ['A', 'S', 'X'] as const) {
      for (const p of Object.keys(PRINCIPALS)) {
        const h = p === 'pa' ? w.pa : w.people[p]!.h;
        const q = await call(t, h, 'GET', `/api/moderation/queue?scope_node_id=${w.nodes[scope].id}`);
        const wantQ = STATUS[expectNode(p, 'moderate', scope)];
        if (q.statusCode !== wantQ) failures.push(`queue ${scope} as ${p}: expected ${wantQ}, got ${q.statusCode}`);
        const a = await call(t, h, 'GET', `/api/admin/audit?scope_node_id=${w.nodes[scope].id}`);
        const wantA = STATUS[expectNode(p, 'view_audit', scope)];
        if (a.statusCode !== wantA) failures.push(`audit ${scope} as ${p}: expected ${wantA}, got ${a.statusCode}`);
      }
    }
    // a hidden queue looks exactly like a missing route
    const missing = await call(t, w.people.student_a!.h, 'GET', '/api/moderation/this-route-does-not-exist');
    const hidden = await call(t, w.people.student_a!.h, 'GET', `/api/moderation/queue?scope_node_id=${w.nodes.A.id}`);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(missing.body);
    expect(failures).toEqual([]);
  }, 180_000);

  it('every /api/moderation, /api/admin and /api/notifications route is in this matrix or names the test that checks who may call it', () => {
    const routesOf = (file: string) => {
      const src = readFileSync(join(__dirname, '..', '..', 'src', 'modules', ...file.split('/')), 'utf8');
      return [...src.matchAll(/^\s*app\.(get|post|patch|put|delete)\('([^']+)'/gm)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`).sort();
    };
    const covered: Record<string, string> = {
      'GET /queue': 'matrix.test.ts «moderation and audit routes»',
      'GET /audit': 'matrix.test.ts «moderation and audit routes»; moderation/audit-view.test.ts',
      'POST /reports': 'moderation/minimal.test.ts «reports» (members who can see the content; 404 otherwise)',
      'POST /actions': 'moderation/minimal.test.ts «who may decide»',
      // the signed-in user's own inbox and preferences: no route takes another person's id
      'GET /': 'notifications/inbox.test.ts «read state is per user»',
      'POST /read': 'notifications/inbox.test.ts «read state is per user»; acceptance/ac01b.test.ts',
      'GET /prefs': 'notifications/inbox.test.ts «preferences»',
      'PUT /prefs': 'notifications/inbox.test.ts «preferences»',
    };
    const registered = [...routesOf('moderation/index.ts'), ...routesOf('notifications/index.ts')];
    expect(registered.length).toBe(8);
    expect(registered.filter((r) => !(r in covered))).toEqual([]);
  });
});
