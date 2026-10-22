// Phase 1 completion, track C2 — AOS-18.5 (invitations from the screen): an Admin / Assistant finds a NAMED person with
// the picker (exact username, or a member of a channel they already manage — never a directory of every account),
// invites them, sees the invitations sent into the node (pending / accepted / revoked / expired) and revokes a pending
// one — every change audited; a revoked invitation no longer lets its invitee in; anybody who may not manage the node
// gets 403 on the node routes and the 404 of a missing id on the invitation id.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelNodeView, InvitationsResponse, InvitationView, InviteeSearchResponse } from '@medlevo/shared';
import { assignRole, call, channelWorld, createCode, createNode, ok, person, type ChannelWorld, type Person } from './helpers';

let w: ChannelWorld;
let uni: ChannelNodeView;
let stage: ChannelNodeView;
let subjA: ChannelNodeView;
let subjB: ChannelNodeView;
let admin: Person; // Admin of the stage (manages both subjects)
let assistantB: Person; // Assistant of subject B only
let studentA: Person; // a member of subject A
let lone: Person; // an account that belongs to nothing (findable by exact username only)
let student: Person; // a student of A (no power)

beforeAll(async () => {
  w = await channelWorld();
  uni = await createNode(w.t, w.pa, null, 'university', 'جامعة الدعوات');
  stage = await createNode(w.t, w.pa, uni.id, 'stage', 'المرحلة الثالثة');
  subjA = await createNode(w.t, w.pa, stage.id, 'subject', 'Anatomy', { join_policy: 'open_with_code' });
  subjB = await createNode(w.t, w.pa, stage.id, 'subject', 'Physiology', { join_policy: 'closed' });
  admin = await person(w.t, 'inv_admin');
  assistantB = await person(w.t, 'inv_assistant');
  studentA = await person(w.t, 'zainab_ali');
  lone = await person(w.t, 'lone_student');
  student = await person(w.t, 'inv_student');
  await assignRole(w.t, w.pa, stage.id, admin.user.id, 'admin');
  await assignRole(w.t, w.pa, subjB.id, assistantB.user.id, 'assistant');
  const code = (await createCode(w.t, w.pa, subjA.id, { requires_approval: false })).code!;
  for (const p of [studentA, student]) ok(await call(w.t, p.h, 'POST', '/api/channels/join', { code }));
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const search = (who: Person, nodeId: string, q: string) => call(w.t, who.h, 'GET', `/api/channels/nodes/${nodeId}/invitees?q=${encodeURIComponent(q)}`);

describe('AOS-18.5 — the person picker finds named people, never everyone', () => {
  it('a member of a subject the Admin manages is found by the start of her name; a stranger only by the exact username', async () => {
    const r = ok<InviteeSearchResponse>(await search(admin, subjB.id, 'zain'));
    expect(r.candidates).toEqual([expect.objectContaining({ user: expect.objectContaining({ id: studentA.user.id }), match: 'member', state: 'can_invite' })]);
    expect(r.candidates[0]!.where_ar).toContain('Anatomy');
    // an account in no channel: not by a prefix …
    expect(ok<InviteeSearchResponse>(await search(admin, subjB.id, 'lone')).candidates).toEqual([]);
    // … only by its exact username
    expect(ok<InviteeSearchResponse>(await search(admin, subjB.id, 'lone_student')).candidates).toEqual([expect.objectContaining({ user: expect.objectContaining({ id: lone.user.id }), match: 'username' })]);
  });

  it('an Assistant of B alone does not see the members of A (a channel he does not manage); exact usernames still work', async () => {
    expect(ok<InviteeSearchResponse>(await search(assistantB, subjB.id, 'zain')).candidates).toEqual([]);
    expect(ok<InviteeSearchResponse>(await search(assistantB, subjB.id, 'zainab_ali')).candidates.map((c) => c.user.id)).toEqual([studentA.user.id]);
  });

  it('who may not manage the node\'s members gets 403; a one-letter query is refused', async () => {
    expect((await search(student, subjB.id, 'zain')).statusCode).toBe(403);
    expect((await search(studentA, subjA.id, 'lone_student')).statusCode).toBe(403);
    expect((await search(admin, subjB.id, 'z')).statusCode).toBe(400);
  });
});

describe('AOS-18.5 — invitations sent from the screen: list, revoke, expire, all audited', () => {
  let inv: InvitationView;
  it('the Admin invites the found person; the list of the node shows it pending; the state reads «invited»', async () => {
    inv = ok<InvitationsResponse>(await call(w.t, admin.h, 'POST', `/api/channels/nodes/${subjB.id}/invitations`, { user_ids: [studentA.user.id] })).invitations[0]!;
    const list = ok<InvitationsResponse>(await call(w.t, admin.h, 'GET', `/api/channels/nodes/${subjB.id}/invitations`));
    expect(list.invitations.map((i) => [i.id, i.status])).toEqual([[inv.id, 'pending']]);
    expect(list.invitations[0]!.invited_by.id).toBe(admin.user.id);
    expect(ok<InviteeSearchResponse>(await search(admin, subjB.id, 'zain')).candidates[0]!.state).toBe('invited');
    // the Assistant of B sees the same list; a student or another subject's member does not
    expect(ok<InvitationsResponse>(await call(w.t, assistantB.h, 'GET', `/api/channels/nodes/${subjB.id}/invitations`)).invitations).toHaveLength(1);
    expect((await call(w.t, student.h, 'GET', `/api/channels/nodes/${subjB.id}/invitations`)).statusCode).toBe(403);
    // filter by status
    expect(ok<InvitationsResponse>(await call(w.t, admin.h, 'GET', `/api/channels/nodes/${subjB.id}/invitations?status=accepted`)).invitations).toEqual([]);
  });

  it('revoking is id-addressed: strangers meet the 404 of a missing id; the Assistant may revoke; it is audited', async () => {
    const missing = await call(w.t, student.h, 'DELETE', '/api/channels/invitations/NO_SUCH_INVITATION');
    const res = await call(w.t, student.h, 'DELETE', `/api/channels/invitations/${inv.id}`);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(missing.body);
    // the invitee cannot «revoke» it either (she declines instead)
    expect((await call(w.t, studentA.h, 'DELETE', `/api/channels/invitations/${inv.id}`)).statusCode).toBe(404);
    const revoked = ok<InvitationView>(await call(w.t, assistantB.h, 'DELETE', `/api/channels/invitations/${inv.id}`));
    expect(revoked.status).toBe('revoked');
    // twice: the same answer, nothing new
    expect(ok<InvitationView>(await call(w.t, assistantB.h, 'DELETE', `/api/channels/invitations/${inv.id}`)).status).toBe('revoked');
    const audit = w.t.ctx.system.db.all<{ action: string; actor_user_id: string }>(`SELECT action, actor_user_id FROM security_audit WHERE target_id = ? ORDER BY created_at`, [inv.id]);
    expect(audit.filter((a) => a.action === 'channel_invitation_revoke')).toEqual([expect.objectContaining({ actor_user_id: assistantB.user.id })]);
    // the revoked invitation no longer lets her in, and it left her inbox
    expect(ok<InvitationsResponse>(await call(w.t, studentA.h, 'GET', '/api/channels/invitations')).invitations).toEqual([]);
    expect((await call(w.t, studentA.h, 'POST', `/api/channels/invitations/${inv.id}/decision`, { accept: true })).statusCode).toBe(409);
    expect(ok<InvitationsResponse>(await call(w.t, admin.h, 'GET', `/api/channels/nodes/${subjB.id}/invitations?status=revoked`)).invitations.map((i) => i.id)).toEqual([inv.id]);
  });

  it('a pending invitation past its time reads «expired» in the list', async () => {
    const again = ok<InvitationsResponse>(await call(w.t, admin.h, 'POST', `/api/channels/nodes/${subjB.id}/invitations`, { user_ids: [lone.user.id] })).invitations[0]!;
    w.t.ctx.system.db.run('UPDATE channel_invitation SET expires_at = ? WHERE id = ?', [w.t.ctx.clock.now() - 1000, again.id]);
    const list = ok<InvitationsResponse>(await call(w.t, admin.h, 'GET', `/api/channels/nodes/${subjB.id}/invitations`));
    expect(list.invitations.find((i) => i.id === again.id)?.status).toBe('expired');
    expect((await call(w.t, assistantB.h, 'DELETE', `/api/channels/invitations/${again.id}`)).statusCode).toBe(409);
  });
});
