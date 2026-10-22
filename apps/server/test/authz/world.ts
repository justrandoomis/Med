// The fixture world of the generated permission matrix (X9): two universities, a college with a stage and two subjects,
// an archived subject, one subject in the other university — and one person for every role, membership state and
// scope that matters, all created through the real routes. Later tracks build their matrix specs on the same world
// (P1-T5: official lectures, publications, layers, files inside these subjects).
//
//   U1 «جامعة المصفوفة» ─ C1 «كلية الطب» ─ S «المرحلة الثالثة» ─┬─ A «المادة أ»
//                                         │                      └─ B «المادة ب»
//                                         └─ Z «مادة مؤرشفة» (archived)
//   U2 «جامعة أخرى» ─ X «المادة س»
//
// Principals: the platform admin; Admins of U1, U2 and C1; an Assistant of C1 and one of A; Subject Moderators of A, B
// and Z; Contributors of A and of S (above both subjects); approved members of S, A, Z and X; pending requests on A and
// on S; a rejected and a removed request on A; an outsider.
import type { ChannelNodeView } from '@medlevo/shared';
import type { Viewer } from '../../src/system/binding';
import type { TestApp } from '../helpers/app';
import { assignRole, call, createCode, createNode, ok, type Person, person } from '../channels/helpers';

export const NODE_KEYS = ['U1', 'C1', 'S', 'A', 'B', 'Z', 'U2', 'X'] as const;
export type NodeKey = (typeof NODE_KEYS)[number];

/** parent of every node of the world (null = a root) — written here, not read from the database */
export const PARENT: Record<NodeKey, NodeKey | null> = { U1: null, C1: 'U1', S: 'C1', A: 'S', B: 'S', Z: 'C1', U2: null, X: 'U2' };
export const SUBJECTS: readonly NodeKey[] = ['A', 'B', 'Z', 'X'];
export const ARCHIVED: readonly NodeKey[] = ['Z'];

/** Who holds what, as the matrix expects it. */
export interface PrincipalProfile {
  platformAdmin?: boolean;
  roles?: Array<{ role: 'admin' | 'assistant' | 'subject_moderator' | 'contributor'; on: NodeKey }>;
  membership?: { on: NodeKey; status: 'approved' | 'pending' | 'rejected' | 'removed' };
}

export const PRINCIPALS: Record<string, PrincipalProfile> = {
  pa: { platformAdmin: true },
  admin_u1: { roles: [{ role: 'admin', on: 'U1' }] },
  admin_u2: { roles: [{ role: 'admin', on: 'U2' }] },
  assistant_c1: { roles: [{ role: 'assistant', on: 'C1' }] },
  mod_a: { roles: [{ role: 'subject_moderator', on: 'A' }] },
  mod_b: { roles: [{ role: 'subject_moderator', on: 'B' }] },
  contrib_a: { roles: [{ role: 'contributor', on: 'A' }] },
  student_s: { membership: { on: 'S', status: 'approved' } },
  student_a: { membership: { on: 'A', status: 'approved' } },
  pending_a: { membership: { on: 'A', status: 'pending' } },
  rejected_a: { membership: { on: 'A', status: 'rejected' } },
  removed_a: { membership: { on: 'A', status: 'removed' } },
  member_z: { membership: { on: 'Z', status: 'approved' } },
  mod_z: { roles: [{ role: 'subject_moderator', on: 'Z' }] },
  outsider: {},
  // review P1-T4 step 1: roles below the root and on one subject, a role above the subjects, a member of the other
  // university, a pending request on the stage (inherited by its subjects)
  admin_c1: { roles: [{ role: 'admin', on: 'C1' }] },
  assistant_a: { roles: [{ role: 'assistant', on: 'A' }] },
  contrib_s: { roles: [{ role: 'contributor', on: 'S' }] },
  student_x: { membership: { on: 'X', status: 'approved' } },
  pending_s: { membership: { on: 'S', status: 'pending' } },
};
export type PrincipalKey = keyof typeof PRINCIPALS;

export interface MatrixWorld {
  t: TestApp;
  nodes: Record<NodeKey, ChannelNodeView>;
  people: Record<string, Person>;
  /** the platform admin's headers */
  pa: Person['h'];
  viewer(key: string): Viewer;
  /** ancestors of a node, itself first */
  chain(key: NodeKey): NodeKey[];
}

export function chainOf(key: NodeKey): NodeKey[] {
  const out: NodeKey[] = [];
  for (let k: NodeKey | null = key; k; k = PARENT[k]) out.push(k);
  return out;
}

export async function buildMatrixWorld(t: TestApp, paHeaders: Person['h']): Promise<MatrixWorld> {
  const n = {} as Record<NodeKey, ChannelNodeView>;
  n.U1 = await createNode(t, paHeaders, null, 'university', 'جامعة المصفوفة');
  n.C1 = await createNode(t, paHeaders, n.U1.id, 'college', 'كلية الطب');
  n.S = await createNode(t, paHeaders, n.C1.id, 'stage', 'المرحلة الثالثة', { join_policy: 'open_with_code' });
  n.A = await createNode(t, paHeaders, n.S.id, 'subject', 'المادة أ');
  n.B = await createNode(t, paHeaders, n.S.id, 'subject', 'المادة ب');
  n.Z = await createNode(t, paHeaders, n.C1.id, 'subject', 'مادة مؤرشفة', { join_policy: 'open_with_code' });
  n.U2 = await createNode(t, paHeaders, null, 'university', 'جامعة أخرى');
  n.X = await createNode(t, paHeaders, n.U2.id, 'subject', 'المادة س');

  const people: Record<string, Person> = {};
  for (const key of Object.keys(PRINCIPALS)) if (key !== 'pa') people[key] = await person(t, `m_${key}`);
  for (const [key, prof] of Object.entries(PRINCIPALS)) {
    for (const r of prof.roles ?? []) await assignRole(t, paHeaders, n[r.on].id, people[key]!.user.id, r.role);
  }
  // memberships through the real join flow: codes (an auto-approving one where the node's policy allows it, else one
  // that asks), then the decision of an Admin
  const codes: Partial<Record<NodeKey, { auto?: string; ask: string }>> = {};
  const codeFor = async (k: NodeKey, wantPending: boolean): Promise<string> => {
    const open = n[k].join_policy === 'open_with_code';
    const c = (codes[k] ??= { ask: (await createCode(t, paHeaders, n[k].id)).code!, ...(open ? { auto: (await createCode(t, paHeaders, n[k].id, { requires_approval: false })).code! } : {}) });
    return !wantPending && c.auto ? c.auto : c.ask;
  };
  for (const [key, prof] of Object.entries(PRINCIPALS)) {
    const m = prof.membership;
    if (!m) continue;
    const p = people[key]!;
    const joined = ok<{ membership: { status: string } }>(await call(t, p.h, 'POST', '/api/channels/join', { code: await codeFor(m.on, m.status === 'pending') }));
    const decide = (decision: 'approve' | 'reject' | 'remove') => call(t, paHeaders, 'POST', `/api/channels/nodes/${n[m.on].id}/members/${p.user.id}/decision`, { decision });
    if (m.status === 'pending') continue;
    if (m.status === 'rejected') ok(await decide('reject'));
    else if (joined.membership.status === 'pending') ok(await decide('approve'));
    if (m.status === 'removed') ok(await decide('remove'));
  }
  ok(await call(t, paHeaders, 'POST', `/api/channels/nodes/${n.Z.id}/archive`, { preview: false }));
  n.Z = ok<ChannelNodeView>(await call(t, paHeaders, 'GET', `/api/channels/nodes/${n.Z.id}`));
  // spaces as the platform admin sees them (it may bind every space)
  for (const k of SUBJECTS) if (!n[k].space_id) throw new Error(`world: subject ${k} has no space`);

  const paUser = t.ctx.system.users.findForAuth('owner')!;
  return {
    t,
    nodes: n,
    people,
    pa: paHeaders,
    viewer: (key) => (key === 'pa' ? t.ctx.tenancy.viewerOf(paUser, null) : t.ctx.tenancy.viewerOf(people[key]!.user, null)),
    chain: chainOf,
  };
}
