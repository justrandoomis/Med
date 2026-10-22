// P1-T4 step 1 — adversarial review (BUILD_PLAN §1.2). Every test here reproduced a defect found in the review and
// failed before its fix:
//   R1  one person behind a campus address could lock the whole class out of joining and registering for an hour by
//       spending the address's budget of wrong proofs on the cheap, public preview (or on wrong registrations);
//   R2  a removal did not hold: a student removed from a subject kept it through an approved membership higher up, or
//       got it back by joining the stage with its open code;
//   R3  a rejected request became an approved membership through an auto-approving code;
//   R4  an invitation sent by an Assistant (or Admin) whose role was revoked still let the invitee in, approved;
//   R5  an Assistant could invite themselves and so hold a membership that outlives their role;
//   R6  an Admin of one node could move it out from under the Admins above it (into another university they
//       administer), taking it away from its superiors and handing its space to another tree's members.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelNodeView, ChannelRoleView, InvitationsResponse, JoinResponse, MemberView } from '@medlevo/shared';
import { channelsOf } from '../../src/modules/channels/service';
import { createTestApp, CSRF } from '../helpers/app';
import { assignRole, call, type ChannelWorld, createCode, createNode, ok, type Person, person } from './helpers';

const IP_CEILING = 20;
let w: ChannelWorld;
let uni: ChannelNodeView;

beforeAll(async () => {
  // the test client talks through a trusted loopback proxy, so every test can play its own campus address (a server
  // behind a proxy asks for a setup token: the harness creates the owner directly instead)
  const t = await createTestApp({ env: { MEDLEVO_LOGIN_IP_FAILURES_PER_HOUR: String(IP_CEILING), MEDLEVO_TRUST_PROXY: 'loopback' } });
  t.ownerBinding();
  w = { t, pa: await t.login(), close: () => t.close() };
  uni = await createNode(w.t, w.pa, null, 'university', 'جامعة المراجعة');
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const spaceOf = (n: ChannelNodeView) => n.space_id ?? channelsOf(w.t.ctx).repo.node(n.id)!.space_id!;
const accessOf = (p: Person, n: ChannelNodeView) => channelsOf(w.t.ctx).access.accessToSpace(w.t.ctx.tenancy.viewerOf(p.user, null), spaceOf(n));
const canView = (p: Person, n: ChannelNodeView) => w.t.ctx.authz.can(w.t.ctx.tenancy.viewerOf(p.user, null), 'view', { type: 'space', id: spaceOf(n) });
const joinCode = (p: Person, code: string, ip?: string) => call(w.t, p.h, 'POST', '/api/channels/join', { code }, ip ? { 'x-forwarded-for': ip } : {});
const decide = (nodeId: string, userId: string, decision: 'approve' | 'reject' | 'remove') => call(w.t, w.pa, 'POST', `/api/channels/nodes/${nodeId}/members/${userId}/decision`, { decision });
const preview = (token: string, ip: string) => w.t.app.inject({ method: 'GET', url: `/api/channels/join/preview?token=${token}`, headers: { 'x-forwarded-for': ip } });
let regN = 0;
const register = (join: Record<string, string>, ip: string) =>
  w.t.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { ...CSRF, 'x-forwarded-for': ip },
    payload: { username: `review_reg_${++regN}`, display_name: 'طالب في القاعة', password: 'student-password-123', join },
  });

describe('R1 — one person behind a campus address cannot lock the class out', () => {
  it('wrong public previews never use up the budget of code joins or registrations from that address', async () => {
    const ip = '198.51.100.10';
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة القاعة', { join_policy: 'open_with_code' });
    // a scanner (or a prankster) sends more wrong preview tokens than the address ceiling
    for (let i = 0; i < IP_CEILING; i++) expect((await preview(`${'q'.repeat(40)}${String(i).padStart(3, '0')}`, ip)).statusCode).toBe(404);
    // the preview itself is now limited for this address (scanning stops)…
    expect((await preview('q'.repeat(43), ip)).statusCode).toBe(429);
    // …but a classmate behind the same address still joins with the class code, and a new student still registers
    const code = (await createCode(w.t, w.pa, subj.id, { requires_approval: false })).code!;
    const mate = await person(w.t, 'r1_mate');
    expect((await joinCode(mate, code, ip)).statusCode).toBe(200);
    const reg = await register({ code }, ip);
    expect(reg.statusCode, reg.body).toBe(200);
  });

  it('wrong registrations never block signed-in classmates, nor a registration through the QR / invite link', async () => {
    const ip = '198.51.100.11';
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة التسجيل الجماعي', { join_policy: 'open_with_code' });
    for (let i = 0; i < IP_CEILING; i++) expect((await register({ code: `QQQQ-QQ${String(i).padStart(2, '0')}` }, ip)).statusCode).toBe(400);
    // guessing class codes through registration is now limited for this address…
    expect((await register({ code: 'QQQQ-QQZZ' }, ip)).statusCode).toBe(429);
    // …while a signed-in classmate still joins with the code, and the hall still registers with the QR's link
    const code = (await createCode(w.t, w.pa, subj.id, { requires_approval: false })).code!;
    const mate = await person(w.t, 'r1_mate_2');
    expect((await joinCode(mate, code, ip)).statusCode).toBe(200);
    const link = (await createCode(w.t, w.pa, subj.id, { kind: 'invite_link', requires_approval: false })).link!;
    const reg = await register({ invite_token: link.split('/join/')[1]! }, ip);
    expect(reg.statusCode, reg.body).toBe(200);
  });

  it('signed-in wrong codes still meet the address ceiling (many accounts guessing from one address)', async () => {
    const ip = '198.51.100.12';
    const guessers = [await person(w.t, 'r1_guess_a'), await person(w.t, 'r1_guess_b')];
    for (const g of guessers) for (let i = 0; i < 10; i++) expect((await joinCode(g, `WWWW-WW${String(i).padStart(2, '0')}`, ip)).statusCode).toBe(400);
    const third = await person(w.t, 'r1_guess_c');
    expect((await joinCode(third, 'WWWW-WWZZ', ip)).statusCode).toBe(429);
  });
});

describe('R2 — a removal holds', () => {
  let stage: ChannelNodeView;
  let a: ChannelNodeView;
  let b: ChannelNodeView;
  let stageCode: string;
  let aCode: string;
  beforeAll(async () => {
    stage = await createNode(w.t, w.pa, uni.id, 'stage', 'المرحلة الرابعة', { join_policy: 'open_with_code' });
    a = await createNode(w.t, w.pa, stage.id, 'subject', 'مادة الإزالة', { join_policy: 'open_with_code' });
    b = await createNode(w.t, w.pa, stage.id, 'subject', 'مادة شقيقة');
    stageCode = (await createCode(w.t, w.pa, stage.id, { requires_approval: false })).code!;
    aCode = (await createCode(w.t, w.pa, a.id, { requires_approval: false })).code!;
  });

  it('removed from a subject, a student loses it even with an approved membership of the stage above', async () => {
    const s = await person(w.t, 'r2_both');
    expect(ok<JoinResponse>(await joinCode(s, aCode)).membership.status).toBe('approved');
    expect(ok<JoinResponse>(await joinCode(s, stageCode)).membership).toMatchObject({ status: 'approved', node: { id: stage.id } });
    expect(accessOf(s, a)).toMatchObject({ access: 'member' });
    ok<MemberView>(await decide(a.id, s.user.id, 'remove'));
    expect(accessOf(s, a)).toBeNull();
    expect(canView(s, a).reason?.hide).toBe(true);
    // the sibling subject, which the stage membership grants, stays open
    expect(accessOf(s, b)).toMatchObject({ access: 'member' });
    // the node view says so too: no space for A, and no claim of an approved membership there
    const view = ok<ChannelNodeView>(await call(w.t, s.h, 'GET', `/api/channels/nodes/${a.id}`));
    expect(view.space_id).toBeNull();
    expect(view.viewer.membership?.status).toBe('removed');
  });

  it('a removed student does not get the subject back by joining the stage with its open code', async () => {
    const s = await person(w.t, 'r2_back_door');
    ok<JoinResponse>(await joinCode(s, aCode));
    ok<MemberView>(await decide(a.id, s.user.id, 'remove'));
    expect(ok<JoinResponse>(await joinCode(s, stageCode)).membership).toMatchObject({ status: 'approved', node: { id: stage.id } });
    expect(accessOf(s, a)).toBeNull();
    expect(accessOf(s, b)).toMatchObject({ access: 'member' });
    // re-admission goes through the subject's own approvers: a new request waits, an approval opens it again
    expect(ok<JoinResponse>(await joinCode(s, aCode)).membership).toMatchObject({ status: 'pending', node: { id: a.id } });
    ok<MemberView>(await decide(a.id, s.user.id, 'approve'));
    expect(accessOf(s, a)).toMatchObject({ access: 'member' });
  });

  it('removed from the stage, a student joining one of its subjects with an open code waits for that subject’s approvers', async () => {
    const s = await person(w.t, 'r2_removed_above');
    ok<JoinResponse>(await joinCode(s, stageCode));
    ok<MemberView>(await decide(stage.id, s.user.id, 'remove'));
    expect(accessOf(s, a)).toBeNull();
    expect(ok<JoinResponse>(await joinCode(s, aCode)).membership).toMatchObject({ status: 'pending', node: { id: a.id } });
    expect(accessOf(s, a)).toMatchObject({ pending: true });
    expect(accessOf(s, b)).toBeNull();
  });

  it('an invitation from the subject re-admits a removed member (it is not skipped as «already in»)', async () => {
    const s = await person(w.t, 'r2_invited_back');
    ok<JoinResponse>(await joinCode(s, stageCode));
    ok<JoinResponse>(await joinCode(s, aCode)); // «already a member» through the stage: no row on A
    expect(w.t.ctx.system.db.get('SELECT 1 AS x FROM channel_membership WHERE node_id = ? AND user_id = ?', [a.id, s.user.id])).toBeUndefined();
    // a row on A that is removed: join A first, then the stage, then removal
    const t2 = await person(w.t, 'r2_invited_back_2');
    ok<JoinResponse>(await joinCode(t2, aCode));
    ok<JoinResponse>(await joinCode(t2, stageCode));
    ok<MemberView>(await decide(a.id, t2.user.id, 'remove'));
    const sent = ok<InvitationsResponse>(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${a.id}/invitations`, { user_ids: [t2.user.id] }));
    expect(sent.invitations).toHaveLength(1);
    ok(await call(w.t, t2.h, 'POST', `/api/channels/invitations/${sent.invitations[0]!.id}/decision`, { accept: true }));
    expect(accessOf(t2, a)).toMatchObject({ access: 'member' });
  });
});

describe('R3 — a rejected request', () => {
  it('is not turned into an approved membership by an auto-approving code: it waits for approval again', async () => {
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة الرفض المراجعة', { join_policy: 'open_with_code' });
    const ask = (await createCode(w.t, w.pa, subj.id, { requires_approval: true })).code!;
    const auto = (await createCode(w.t, w.pa, subj.id, { requires_approval: false })).code!;
    const s = await person(w.t, 'r3_rejected');
    expect(ok<JoinResponse>(await joinCode(s, ask)).membership.status).toBe('pending');
    expect(ok<MemberView>(await decide(subj.id, s.user.id, 'reject')).status).toBe('rejected');
    expect(ok<JoinResponse>(await joinCode(s, auto)).membership.status).toBe('pending');
    expect(accessOf(s, subj)).toMatchObject({ pending: true });
  });
});

describe('R4/R5 — invitations follow the inviter’s power', () => {
  let closed: ChannelNodeView;
  let assistant: Person;
  let role: ChannelRoleView;
  beforeAll(async () => {
    closed = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة الدعوات', { join_policy: 'closed' });
    assistant = await person(w.t, 'r4_assistant');
    role = ok<ChannelRoleView>(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${uni.id}/roles`, { user_id: assistant.user.id, role: 'assistant' }));
  });

  it('an invitation from an Assistant whose role was revoked can no longer be accepted (nor is it listed)', async () => {
    const invitee = await person(w.t, 'r4_invitee');
    const kept = await person(w.t, 'r4_invitee_kept');
    const sent = ok<InvitationsResponse>(await call(w.t, assistant.h, 'POST', `/api/channels/nodes/${closed.id}/invitations`, { user_ids: [invitee.user.id] }));
    const fromPa = ok<InvitationsResponse>(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${closed.id}/invitations`, { user_ids: [kept.user.id] }));
    ok(await call(w.t, w.pa, 'DELETE', `/api/channels/roles/${role.id}`));
    expect(ok<InvitationsResponse>(await call(w.t, invitee.h, 'GET', '/api/channels/invitations')).invitations).toEqual([]);
    const r = await call(w.t, invitee.h, 'POST', `/api/channels/invitations/${sent.invitations[0]!.id}/decision`, { accept: true });
    expect(r.statusCode).toBe(409);
    expect(accessOf(invitee, closed)).toBeNull();
    expect(w.t.ctx.system.db.get<{ status: string }>('SELECT status FROM channel_invitation WHERE id = ?', [sent.invitations[0]!.id])!.status).toBe('revoked');
    // an invitation from someone who still holds the power is unaffected
    ok(await call(w.t, kept.h, 'POST', `/api/channels/invitations/${fromPa.invitations[0]!.id}/decision`, { accept: true }));
    expect(accessOf(kept, closed)).toMatchObject({ access: 'member' });
  });

  it('nobody invites themselves (a membership that would outlive their role)', async () => {
    const helper = await person(w.t, 'r5_assistant');
    await assignRole(w.t, w.pa, uni.id, helper.user.id, 'assistant');
    const other = await person(w.t, 'r5_other');
    const r = await call(w.t, helper.h, 'POST', `/api/channels/nodes/${closed.id}/invitations`, { user_ids: [other.user.id, helper.user.id] });
    expect(r.statusCode).toBe(403);
    expect(w.t.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM channel_invitation WHERE node_id = ? AND invitee_user_id IN (?, ?)', [closed.id, helper.user.id, other.user.id])!.n).toBe(0);
  });
});

describe('R6 — a move stays inside the mover’s authority', () => {
  it('an Admin of a subject (and of a node elsewhere) cannot move the subject out from under the Admins above it', async () => {
    const college = await createNode(w.t, w.pa, uni.id, 'college', 'كلية النقل');
    const subj = await createNode(w.t, w.pa, college.id, 'subject', 'مادة النقل');
    const otherUni = await createNode(w.t, w.pa, null, 'university', 'جامعة الوجهة');
    const otherCollege = await createNode(w.t, w.pa, otherUni.id, 'college', 'كلية الوجهة');
    const mover = await person(w.t, 'r6_mover');
    await assignRole(w.t, w.pa, subj.id, mover.user.id, 'admin');
    await assignRole(w.t, w.pa, otherCollege.id, mover.user.id, 'admin');
    const r = await call(w.t, mover.h, 'PATCH', `/api/channels/nodes/${subj.id}`, { parent_id: otherCollege.id });
    expect(r.statusCode).toBe(403);
    expect(channelsOf(w.t.ctx).repo.node(subj.id)!.parent_id).toBe(college.id);
    // an Admin of the university (above the old parent) who also administers the target may move it; so may the
    // platform admin
    const upper = await person(w.t, 'r6_upper');
    await assignRole(w.t, w.pa, uni.id, upper.user.id, 'admin');
    const sibling = await createNode(w.t, w.pa, uni.id, 'college', 'كلية شقيقة');
    expect(ok<ChannelNodeView>(await call(w.t, upper.h, 'PATCH', `/api/channels/nodes/${subj.id}`, { parent_id: sibling.id })).parent_id).toBe(sibling.id);
    expect(ok<ChannelNodeView>(await call(w.t, w.pa, 'PATCH', `/api/channels/nodes/${subj.id}`, { parent_id: otherCollege.id })).parent_id).toBe(otherCollege.id);
  });
});

describe('R7 — archiving takes back the pending invitations into the archived subtree', () => {
  it('the invitee is not left with an invitation that can only fail', async () => {
    const node = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة ستؤرشف', { join_policy: 'closed' });
    const p = await person(w.t, 'r7_invitee');
    const inv = ok<InvitationsResponse>(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${node.id}/invitations`, { user_ids: [p.user.id] })).invitations[0]!;
    ok(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${node.id}/archive`, { preview: false }));
    expect(ok<InvitationsResponse>(await call(w.t, p.h, 'GET', '/api/channels/invitations')).invitations).toEqual([]);
    expect(w.t.ctx.system.db.get<{ status: string }>('SELECT status FROM channel_invitation WHERE id = ?', [inv.id])!.status).toBe('revoked');
  });
});

describe('racing requests (guards written in the review: they passed before and must keep passing)', () => {
  it('parallel joins with a code of two uses: exactly two memberships, and the code counts two', async () => {
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة السباق', { join_policy: 'open_with_code' });
    const two = await createCode(w.t, w.pa, subj.id, { requires_approval: false, max_uses: 2 });
    const people = await Promise.all(Array.from({ length: 8 }, (_, i) => person(w.t, `race_join_${i}`)));
    const results = await Promise.all(people.map((p, i) => joinCode(p, two.code!, `192.0.2.${i + 1}`)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(2);
    expect(results.filter((r) => r.statusCode !== 200).every((r) => r.statusCode === 400)).toBe(true);
    expect(w.t.ctx.system.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM channel_membership WHERE node_id = ? AND status = 'approved'`, [subj.id])!.n).toBe(2);
    expect(w.t.ctx.system.db.get<{ n: number }>('SELECT use_count AS n FROM join_code WHERE id = ?', [two.view.id])!.n).toBe(2);
  });

  it('parallel registrations with a single-use code: exactly one account is created', async () => {
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة التسجيل المتزامن');
    const once = await createCode(w.t, w.pa, subj.id, { max_uses: 1 });
    const before = w.t.ctx.system.users.countInternal();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => register({ code: once.code! }, `192.0.2.${100 + i}`)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(w.t.ctx.system.users.countInternal()).toBe(before + 1);
  });

  it('two approvers approving one request at once: both see it approved, one decision is recorded', async () => {
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة القرار المتزامن');
    const second = await person(w.t, 'race_second_approver');
    await assignRole(w.t, w.pa, subj.id, second.user.id, 'assistant');
    const s = await person(w.t, 'race_decided');
    ok<JoinResponse>(await joinCode(s, (await createCode(w.t, w.pa, subj.id)).code!));
    const url = `/api/channels/nodes/${subj.id}/members/${s.user.id}/decision`;
    const [a, b] = await Promise.all([call(w.t, w.pa, 'POST', url, { decision: 'approve' }), call(w.t, second.h, 'POST', url, { decision: 'approve' })]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([(a.json() as MemberView).status, (b.json() as MemberView).status]).toEqual(['approved', 'approved']);
    const row = w.t.ctx.system.db.get<{ id: string }>('SELECT id FROM channel_membership WHERE node_id = ? AND user_id = ?', [subj.id, s.user.id])!;
    expect(w.t.ctx.system.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM security_audit WHERE action = 'channel_membership_decide' AND target_id = ?`, [row.id])!.n).toBe(1);
  });
});
