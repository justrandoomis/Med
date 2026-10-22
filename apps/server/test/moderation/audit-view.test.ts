// P1-T4 step 2 — the scoped security-audit view `GET /api/admin/audit` (PRD AOS-18.14, 21.33; ARCHITECTURE_DELTA §7.12,
// §13, §5.3 «scoped audit / usage statistics: Subject Moderator own subject (aggregates), Assistant subtree, Admin
// subtree, platform admin all»). Entries carry the actor, the actor's role and the scope; the view filters by scope
// (the node and everything below it, nothing beside it) and by action; no IP address, no details, no private content.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SecurityAuditResponse } from '@medlevo/shared';
import { assignRole, call, type ChannelWorld, channelWorld, createCode, createNode, ok, person, type Person } from '../channels/helpers';

let w: ChannelWorld;
const n = {} as Record<'U1' | 'S' | 'A' | 'B' | 'U2' | 'X', { id: string }>;
let adminU1: Person;
let adminU2: Person;
let assistA: Person;
let modA: Person;
let student: Person;

const audit = (h: Person['h'], scope: string, extra = '') => call(w.t, h, 'GET', `/api/admin/audit?scope_node_id=${scope}${extra}`);

beforeAll(async () => {
  w = await channelWorld();
  n.U1 = await createNode(w.t, w.pa, null, 'university', 'جامعة السجل');
  n.S = await createNode(w.t, w.pa, n.U1.id, 'stage', 'المرحلة الأولى');
  n.A = await createNode(w.t, w.pa, n.S.id, 'subject', 'الكيمياء الحيوية', { join_policy: 'open_with_code' });
  n.B = await createNode(w.t, w.pa, n.S.id, 'subject', 'علم الأنسجة', { join_policy: 'open_with_code' });
  n.U2 = await createNode(w.t, w.pa, null, 'university', 'جامعة ثانية');
  n.X = await createNode(w.t, w.pa, n.U2.id, 'subject', 'مادة ثانية', { join_policy: 'open_with_code' });
  [adminU1, adminU2, assistA, modA, student] = (await Promise.all(['admin_u1', 'admin_u2', 'assist_a', 'mod_a', 'student'].map((u) => person(w.t, `a_${u}`)))) as [Person, Person, Person, Person, Person];
  await assignRole(w.t, w.pa, n.U1.id, adminU1.user.id, 'admin');
  await assignRole(w.t, w.pa, n.U2.id, adminU2.user.id, 'admin');
  await assignRole(w.t, w.pa, n.A.id, assistA.user.id, 'assistant');
  await assignRole(w.t, w.pa, n.A.id, modA.user.id, 'subject_moderator');
  // some activity in each place
  ok(await call(w.t, student.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, assistA.h, n.A.id, { requires_approval: false })).code }));
  await createCode(w.t, adminU1.h, n.B.id);
  await createCode(w.t, adminU2.h, n.X.id);
  // a login of the student: an audit row without a scope (never in a scoped view)
  await student.login();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

describe('GET /api/admin/audit', () => {
  it('an Admin sees the entries of the node and everything below it — never beside it', async () => {
    const u1 = ok<SecurityAuditResponse>(await audit(adminU1.h, n.U1.id, '&limit=100'));
    const scopes = new Set(u1.items.map((e) => e.scope?.id));
    expect(scopes.has(n.A.id)).toBe(true);
    expect(scopes.has(n.B.id)).toBe(true);
    expect(scopes.has(n.X.id)).toBe(false);
    expect(scopes.has(n.U2.id)).toBe(false);
    expect(u1.items.every((e) => e.scope !== null)).toBe(true);
    // the subject only
    const a = ok<SecurityAuditResponse>(await audit(adminU1.h, n.A.id, '&limit=100'));
    expect(a.items.length).toBeGreaterThan(0);
    expect(a.items.every((e) => e.scope?.id === n.A.id)).toBe(true);
    // the other university's Admin: refused (the node is visible, so 403)
    expect((await audit(adminU1.h, n.X.id)).statusCode).toBe(403);
    expect(ok<SecurityAuditResponse>(await audit(adminU2.h, n.X.id)).items.every((e) => e.scope?.id === n.X.id)).toBe(true);
    expect((await audit(adminU2.h, n.A.id)).statusCode).toBe(403);
  });

  it('entries carry actor, role and scope; no IP, no details, no codes', async () => {
    const a = ok<SecurityAuditResponse>(await audit(adminU1.h, n.A.id, '&limit=100'));
    const code = a.items.find((e) => e.action === 'channel_code_create')!;
    expect(code).toMatchObject({ actor: { id: assistA.user.id, display_name: 'a_assist_a' }, actor_role: `assistant@${n.A.id}`, scope: { id: n.A.id, kind: 'subject', title: 'الكيمياء الحيوية' }, target: { db: 'system', type: 'join_code' } });
    expect(code.summary_ar).toMatch(/[؀-ۿ]/);
    for (const e of a.items) {
      expect(Object.keys(e).sort()).toEqual(['action', 'actor', 'actor_role', 'created_at', 'id', 'scope', 'summary_ar', 'target']);
    }
    expect(JSON.stringify(a)).not.toMatch(/127\.0\.0\.1|"ip"|details/);
  });

  it('an Assistant sees its subtree; a Subject Moderator (aggregates only, Phase 2), a student and an outsider are refused', async () => {
    expect(ok<SecurityAuditResponse>(await audit(assistA.h, n.A.id)).items.length).toBeGreaterThan(0);
    expect((await audit(assistA.h, n.S.id)).statusCode).toBe(403);
    expect((await audit(assistA.h, n.B.id)).statusCode).toBe(403);
    expect((await audit(modA.h, n.A.id)).statusCode).toBe(403);
    expect((await audit(student.h, n.A.id)).statusCode).toBe(403);
    expect((await audit(student.h, 'NO_SUCH_NODE')).statusCode).toBe(404);
    // the platform admin: any scope
    expect(ok<SecurityAuditResponse>(await audit(w.pa, n.X.id)).items.length).toBeGreaterThan(0);
  });

  it('filters by action and pages newest first with an opaque cursor', async () => {
    const joins = ok<SecurityAuditResponse>(await audit(adminU1.h, n.U1.id, '&action=channel_join'));
    expect(joins.items.length).toBeGreaterThan(0);
    expect(joins.items.every((e) => e.action === 'channel_join')).toBe(true);
    const p1 = ok<SecurityAuditResponse>(await audit(adminU1.h, n.U1.id, '&limit=2'));
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = ok<SecurityAuditResponse>(await audit(adminU1.h, n.U1.id, `&limit=2&cursor=${p1.next_cursor}`));
    expect(p2.items.map((e) => e.id)).not.toContain(p1.items[0]!.id);
    expect(p2.items[0]!.created_at).toBeLessThanOrEqual(p1.items[1]!.created_at);
    expect((await audit(adminU1.h, n.U1.id, '&action=DROP%20TABLE')).statusCode).toBe(400);
    expect((await audit(adminU1.h, n.U1.id, '&cursor=AAAA')).statusCode).toBe(400);
    expect((await call(w.t, adminU1.h, 'GET', '/api/admin/audit')).statusCode).toBe(400);
  });
});
