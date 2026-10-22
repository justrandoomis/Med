// AC-01b, system paths (BUILD_PLAN §3.6 `test/acceptance/ac01b.test.ts`; PRD §9 / ARCHITECTURE_DELTA §15.3 AC-01b):
// two users in TWO subjects of TWO universities of one deployment — nothing of user A reaches user B through any channel,
// membership, role, code, invitation, audit, moderation or notification route, and a moderator of A's subject gets
// nothing of B's (P1-T5 adds the content paths in ac01b-content.test.ts). Every refusal is checked against the body a
// missing id / route gets, so a refusal never tells B that A's thing exists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelNodeDetail } from '@medlevo/shared';
import { assignRole, call, type ChannelWorld, channelWorld, createCode, createNode, ok, person, type Person } from '../channels/helpers';
import { addPublication, installFixturePublications } from '../moderation/fixture';
import { drain, items } from '../notifications/helpers';

let w: ChannelWorld;
const n = {} as Record<'UA' | 'A' | 'UB' | 'B', { id: string; space_id?: string | null }>;
let userA: Person;
let userB: Person;
let modA: Person;
let modB: Person;
let reportA = '';

beforeAll(async () => {
  w = await channelWorld();
  const pubs = installFixturePublications(w.t.ctx);
  n.UA = await createNode(w.t, w.pa, null, 'university', 'جامعة أ');
  n.A = await createNode(w.t, w.pa, n.UA.id, 'subject', 'مادة أ', { join_policy: 'approval' });
  n.UB = await createNode(w.t, w.pa, null, 'university', 'جامعة ب');
  n.B = await createNode(w.t, w.pa, n.UB.id, 'subject', 'مادة ب', { join_policy: 'approval' });
  [userA, userB, modA, modB] = (await Promise.all(['user_a', 'user_b', 'mod_a', 'mod_b'].map((u) => person(w.t, `b_${u}`)))) as [Person, Person, Person, Person];
  await assignRole(w.t, w.pa, n.A.id, modA.user.id, 'subject_moderator');
  await assignRole(w.t, w.pa, n.UA.id, modA.user.id, 'assistant');
  await assignRole(w.t, w.pa, n.B.id, modB.user.id, 'subject_moderator');
  await assignRole(w.t, w.pa, n.UB.id, modB.user.id, 'assistant');
  // A asks to join A, is approved, follows it, gets an invitation elsewhere in A's university, publishes and is reported
  ok(await call(w.t, userA.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, w.pa, n.A.id)).code }));
  ok(await call(w.t, modA.h, 'POST', `/api/channels/nodes/${n.A.id}/members/${userA.user.id}/decision`, { decision: 'approve' }));
  ok(await call(w.t, userA.h, 'PUT', `/api/channels/subjects/${n.A.id}/follow`, { add_new_lectures: true }));
  ok(await call(w.t, userB.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, w.pa, n.B.id)).code }));
  ok(await call(w.t, modB.h, 'POST', `/api/channels/nodes/${n.B.id}/members/${userB.user.id}/decision`, { decision: 'approve' }));
  addPublication(pubs, 'PUB_A', n.A.id, userA.user.id, 'شرح سري من أ');
  const reporterA = await person(w.t, 'b_reporter_a');
  ok(await call(w.t, reporterA.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, w.pa, n.A.id)).code }));
  ok(await call(w.t, modA.h, 'POST', `/api/channels/nodes/${n.A.id}/members/${reporterA.user.id}/decision`, { decision: 'approve' }));
  reportA = ok<{ id: string }>(await call(w.t, reporterA.h, 'POST', '/api/moderation/reports', { target: { db: 'system', type: 'publication', id: 'PUB_A' }, reason: 'privacy', note: 'ملاحظة سرية' })).id;
  drain(w.t);
}, 120_000);
afterAll(async () => {
  await w?.close();
});

describe('AC-01b — system paths: nothing of A reaches B', () => {
  it('B sees A\'s subject as a title only — no membership, roles, follow or space of A', async () => {
    const a = ok<ChannelNodeDetail>(await call(w.t, userB.h, 'GET', `/api/channels/nodes/${n.A.id}`));
    expect(a.viewer).toEqual({ membership: null, roles: [], inherited_from: null, course_follow: null });
    expect(a.space_id).toBeNull();
    expect(JSON.stringify(a)).not.toContain(userA.user.id);
  });

  it('A\'s members, codes, roles and invitations are refused to B (403 on a visible node; 404 by id)', async () => {
    for (const path of ['members', 'codes', 'roles']) expect((await call(w.t, userB.h, 'GET', `/api/channels/nodes/${n.A.id}/${path}`)).statusCode).toBe(403);
    const missingCode = await call(w.t, userB.h, 'DELETE', '/api/channels/codes/NO_SUCH_CODE');
    const codeA = ok<{ codes: Array<{ id: string }> }>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${n.A.id}/codes`)).codes[0]!.id;
    const res = await call(w.t, userB.h, 'DELETE', `/api/channels/codes/${codeA}`);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(missingCode.body);
    // B's own invitations list holds nothing of A
    expect(ok<{ invitations: unknown[] }>(await call(w.t, userB.h, 'GET', '/api/channels/invitations')).invitations).toEqual([]);
  });

  it('B cannot follow A\'s subject; B\'s follow of B is not visible to A', async () => {
    const f = await call(w.t, userB.h, 'PUT', `/api/channels/subjects/${n.A.id}/follow`, { add_new_lectures: true });
    expect(f.statusCode).toBe(403);
    expect(f.json().error.code).toBe('MEMBERSHIP_REQUIRED');
    ok(await call(w.t, userB.h, 'PUT', `/api/channels/subjects/${n.B.id}/follow`, { add_new_lectures: true }));
    expect(ok<ChannelNodeDetail>(await call(w.t, userA.h, 'GET', `/api/channels/nodes/${n.B.id}`)).viewer.course_follow).toBeNull();
  });

  it('notifications: B\'s inbox holds nothing of A; A\'s notification ids are inert for B', async () => {
    const bInbox = await items(w.t, userB.h);
    const text = JSON.stringify(bInbox);
    for (const leak of ['مادة أ', 'جامعة أ', 'شرح سري', userA.user.id]) expect(text).not.toContain(leak);
    const aInbox = await items(w.t, userA.h);
    expect(aInbox.length).toBeGreaterThan(0);
    const before = aInbox.filter((x) => x.read_at === null).length;
    const res = ok<{ updated: number }>(await call(w.t, userB.h, 'POST', '/api/notifications/read', { ids: aInbox.map((x) => x.id) }));
    expect(res.updated).toBe(0);
    expect((await items(w.t, userA.h)).filter((x) => x.read_at === null).length).toBe(before);
    // the moderator of B is not told about A's report
    expect(await items(w.t, modB.h, 'report_received')).toEqual([]);
    expect((await items(w.t, modA.h, 'report_received')).length).toBe(1);
  });

  it('moderation: the moderator of B gets nothing of A — queue, report, content (the 404 of a missing id)', async () => {
    expect((await call(w.t, modB.h, 'GET', `/api/moderation/queue?scope_node_id=${n.A.id}`)).statusCode).toBe(404);
    expect((await call(w.t, modB.h, 'GET', `/api/moderation/queue?scope_node_id=${n.UA.id}`)).statusCode).toBe(404);
    const missing = await call(w.t, modB.h, 'POST', '/api/moderation/actions', { report_id: 'NO_SUCH_REPORT', action: 'dismiss', reason_ar: 'سبب' });
    const byId = await call(w.t, modB.h, 'POST', '/api/moderation/actions', { report_id: reportA, action: 'dismiss', reason_ar: 'سبب' });
    expect(byId.statusCode).toBe(404);
    expect(byId.body).toBe(missing.body);
    const report = await call(w.t, userB.h, 'POST', '/api/moderation/reports', { target: { db: 'system', type: 'publication', id: 'PUB_A' }, reason: 'spam' });
    const missingTarget = await call(w.t, userB.h, 'POST', '/api/moderation/reports', { target: { db: 'system', type: 'publication', id: 'NO_SUCH_PUB' }, reason: 'spam' });
    expect(report.statusCode).toBe(404);
    expect(report.body).toBe(missingTarget.body);
    // B's queue never lists A's report
    const qB = ok<{ items: Array<{ id: string }> }>(await call(w.t, modB.h, 'GET', `/api/moderation/queue?scope_node_id=${n.UB.id}`));
    expect(qB.items.map((r) => r.id)).not.toContain(reportA);
  });

  it('audit: the Assistant of B\'s university is refused A\'s audit; its own view holds nothing of A', async () => {
    expect((await call(w.t, modB.h, 'GET', `/api/admin/audit?scope_node_id=${n.UA.id}`)).statusCode).toBe(403);
    const own = ok<{ items: Array<{ scope: { id: string } | null; summary_ar: string; actor: { id: string } | null }> }>(await call(w.t, modB.h, 'GET', `/api/admin/audit?scope_node_id=${n.UB.id}&limit=100`));
    expect(own.items.length).toBeGreaterThan(0);
    const text = JSON.stringify(own);
    for (const leak of ['مادة أ', 'جامعة أ', userA.user.id, n.A.id]) expect(text).not.toContain(leak);
  });

  it('nothing of A in B\'s raw rows either: B\'s notification rows name only B\'s world', () => {
    const rows = w.t.ctx.system.db.all<{ payload_json: string; scope_node_id: string | null }>('SELECT payload_json, scope_node_id FROM notification WHERE user_id = ?', [userB.user.id]);
    for (const r of rows) {
      expect(r.payload_json).not.toContain('مادة أ');
      expect([null, n.B.id, n.UB.id]).toContain(r.scope_node_id);
    }
  });
});
