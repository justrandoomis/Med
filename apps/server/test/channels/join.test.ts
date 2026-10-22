// P1-T4 step 1 — joining (BUILD_PLAN §3.6 «test/channels/join.test.ts»; PRD AOS-2.11, 2.12, 2.13, 2.15, 18.5, Q2/Q3;
// ARCHITECTURE_DELTA §4.1 `join_code`, §7.3):
//   * codes are stored hashed (keyed), expire, can be revoked, count their uses and stop at max_uses;
//   * wrong codes are rate-limited per account (10 an hour) under a high per-IP ceiling (a campus NAT);
//   * the join policy and the code decide pending vs approved; a removed member always needs approval again;
//   * the public preview shows ONLY the title (kind, approval) for a valid invite token — the same 404 as a missing
//     route otherwise;
//   * approvals by an Admin / Assistant, with a reason, audited; invitations go to existing accounts only.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelNodeView, CreateJoinCodeResponse, InvitationsResponse, JoinCodesResponse, JoinPreviewResponse, JoinResponse, MemberView } from '@medlevo/shared';
import { channelsOf } from '../../src/modules/channels/service';
import { CSRF } from '../helpers/app';
import { assignRole, call, type ChannelWorld, channelWorld, createCode, createNode, missingRouteBody, ok, type Person, person } from './helpers';

const HOUR = 60 * 60_000;
let w: ChannelWorld;
let uni: ChannelNodeView;

beforeAll(async () => {
  w = await channelWorld({ env: { MEDLEVO_LOGIN_IP_FAILURES_PER_HOUR: '40' } });
  uni = await createNode(w.t, w.pa, null, 'university', 'جامعة الانضمام');
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const joinCode = (p: Person, code: string, ip?: string) => call(w.t, p.h, 'POST', '/api/channels/join', { code }, ip ? { 'x-forwarded-for': ip } : {});

describe('class codes', () => {
  it('a code is shown once in base32 groups «XXXX-XXXX» and stored only as a keyed hash', async () => {
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة الرموز');
    const res = await createCode(w.t, w.pa, subj.id);
    expect(res.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(res.link).toBeUndefined();
    expect(res.view).toMatchObject({ kind: 'class_code', hint: res.code!.slice(-2), requires_approval: true, use_count: 0, max_uses: null, revoked_at: null });
    expect(res.view.expires_at).toBe(w.t.clock.now() + 24 * HOUR);
    const plain = res.code!.replace('-', '');
    const rows = w.t.ctx.system.db.all<Record<string, unknown>>('SELECT * FROM join_code WHERE id = ?', [res.view.id]);
    expect(JSON.stringify(rows)).not.toContain(plain);
    const { createHash } = await import('node:crypto');
    expect(rows[0]!.secret_hash).not.toBe(createHash('sha256').update(plain).digest('hex'));
    w.t.ctx.system.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(readFileSync(w.t.config.systemDbPath).includes(Buffer.from(plain))).toBe(false);
    // the admin list never shows the code itself
    const list = ok<JoinCodesResponse>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${subj.id}/codes`));
    expect(JSON.stringify(list)).not.toContain(plain);
    expect(list.codes.map((c) => c.id)).toEqual([res.view.id]);
  });

  it('typed codes are normalised: lower case, spaces, Arabic-Indic digits and the look-alikes O→0, I/L→1', async () => {
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة التطبيع', { join_policy: 'open_with_code' });
    let code: CreateJoinCodeResponse;
    // find a code with a digit 0 or 1 in it (most have one) so the look-alike mapping is exercised
    do code = await createCode(w.t, w.pa, subj.id, { requires_approval: false });
    while (!/[01]/.test(code.code!));
    const typed = code
      .code!.toLowerCase()
      .replace('-', ' ')
      .replace(/0/g, 'o')
      .replace(/1/g, 'l')
      .replace(/[2-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    const p = await person(w.t, 'join_typed');
    const r = ok<JoinResponse>(await joinCode(p, ` ${typed} `));
    expect(r.membership).toMatchObject({ status: 'approved', join_method: 'class_code', node: { id: subj.id } });
  });

  it('the join policy and the code decide pending or approved; joining again changes nothing and uses nothing', async () => {
    const approval = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة بموافقة');
    const open = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة مفتوحة', { join_policy: 'open_with_code' });
    // an «approval» node never takes an auto-approving code
    const refused = await call(w.t, w.pa, 'POST', `/api/channels/nodes/${approval.id}/codes`, { kind: 'class_code', expires_in_hours: 1, requires_approval: false });
    expect(refused.statusCode).toBe(409);
    const c1 = await createCode(w.t, w.pa, approval.id);
    const c2 = await createCode(w.t, w.pa, open.id, { requires_approval: false });
    const c3 = await createCode(w.t, w.pa, open.id, { requires_approval: true });
    const p = await person(w.t, 'join_policy');
    const a = ok<JoinResponse>(await joinCode(p, c1.code!));
    expect(a.membership.status).toBe('pending');
    expect(a.message_ar).toContain('بانتظار');
    expect(ok<JoinResponse>(await joinCode(p, c2.code!)).membership.status).toBe('approved');
    const q = await person(w.t, 'join_policy_q');
    expect(ok<JoinResponse>(await joinCode(q, c3.code!)).membership.status).toBe('pending');
    // again: same membership, no extra use counted
    const again = ok<JoinResponse>(await joinCode(p, c1.code!));
    expect(again.membership.id).toBe(a.membership.id);
    const uses = (id: string) => w.t.ctx.system.db.get<{ n: number }>('SELECT use_count AS n FROM join_code WHERE id = ?', [id])!.n;
    expect(uses(c1.view.id)).toBe(1);
    // a pending member reaches nothing in the subject's space (403 MEMBERSHIP_PENDING at gate 2)
    const access = channelsOf(w.t.ctx).access.accessToSpace(w.t.ctx.tenancy.viewerOf(p.user, null), approval.space_id ?? channelsOf(w.t.ctx).repo.node(approval.id)!.space_id!);
    expect(access).toMatchObject({ pending: true });
  });

  it('expired, revoked and exhausted codes all answer the same generic JOIN_CODE_INVALID', async () => {
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة الصلاحية', { join_policy: 'open_with_code' });
    const expired = await createCode(w.t, w.pa, subj.id, { expires_in_hours: 1, requires_approval: false });
    const revoked = await createCode(w.t, w.pa, subj.id, { expires_in_hours: 48, requires_approval: false });
    const once = await createCode(w.t, w.pa, subj.id, { expires_in_hours: 48, max_uses: 1, requires_approval: false });
    const del = ok<{ revoked_at: number | null }>(await call(w.t, w.pa, 'DELETE', `/api/channels/codes/${revoked.view.id}`));
    expect(del.revoked_at).toBe(w.t.clock.now());
    const first = await person(w.t, 'join_once_1');
    expect(ok<JoinResponse>(await joinCode(first, once.code!)).membership.status).toBe('approved');
    w.t.clock.advance(2 * HOUR);
    const p = await person(w.t, 'join_invalid');
    const bodies = new Set<string>();
    for (const c of [expired.code!, revoked.code!, once.code!, 'ZZZZ-ZZZZ']) {
      const r = await joinCode(p, c);
      expect(r.statusCode, c).toBe(400);
      expect(r.json().error.code).toBe('JOIN_CODE_INVALID');
      bodies.add(r.body);
    }
    expect(bodies.size).toBe(1);
    // the use count stayed at its maximum
    const list = ok<JoinCodesResponse>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${subj.id}/codes`));
    expect(list.codes.find((c) => c.id === once.view.id)).toMatchObject({ use_count: 1, max_uses: 1 });
  });

  it('wrong codes: 10 per account per hour, then 429 for that account only; the per-IP ceiling is much higher', async () => {
    const p = await person(w.t, 'join_guesser');
    const ip = '203.0.113.7';
    for (let i = 0; i < 10; i++) expect((await joinCode(p, `AAAA-AAA${i}`, ip)).statusCode).toBe(400);
    const limited = await joinCode(p, 'AAAA-AAAZ', ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    // a classmate behind the same campus address still joins
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة الحد', { join_policy: 'open_with_code' });
    const good = await createCode(w.t, w.pa, subj.id, { requires_approval: false });
    const mate = await person(w.t, 'join_classmate');
    expect((await joinCode(mate, good.code!, ip)).statusCode).toBe(200);
    // an hour later the account may try again
    w.t.clock.advance(HOUR + 1000);
    expect((await joinCode(p, good.code!, ip)).statusCode).toBe(200);
  });
});

describe('invite links and the public preview (AOS-2.13; the QR encodes the link)', () => {
  let subj: ChannelNodeView;
  let link: CreateJoinCodeResponse;
  beforeAll(async () => {
    subj = await createNode(w.t, w.pa, uni.id, 'subject', 'الجراحة', { join_policy: 'open_with_code' });
    link = await createCode(w.t, w.pa, subj.id, { kind: 'invite_link', requires_approval: false, expires_in_hours: 24 * 7 });
  });
  const token = () => link.link!.split('/join/')[1]!;

  it('a link is https://<origin>/join/<token>, the QR payload is the same link, and only a hash is kept', () => {
    expect(link.link).toMatch(new RegExp(`^${w.t.config.origin}/join/[A-Za-z0-9_-]{40,}$`));
    expect(link.qr_payload).toBe(link.link);
    expect(link.code).toBeUndefined();
    expect(JSON.stringify(w.t.ctx.system.db.all('SELECT * FROM join_code'))).not.toContain(token());
  });

  it('the preview is public and shows only the title, the kind and whether approval is needed', async () => {
    const r = await w.t.app.inject({ method: 'GET', url: `/api/channels/join/preview?token=${token()}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ title_ar: 'الجراحة', kind: 'subject', requires_approval: false } satisfies JoinPreviewResponse);
    expect((await w.t.app.inject({ method: 'HEAD', url: `/api/channels/join/preview?token=${token()}` })).statusCode).toBe(200);
  });

  it('the public preview writes nothing for a valid token and one failure row for a wrong one (no write per request)', async () => {
    const rows = () => w.t.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM join_attempt')!.n;
    const before = rows();
    for (let i = 0; i < 5; i++) expect((await w.t.app.inject({ method: 'GET', url: `/api/channels/join/preview?token=${token()}` })).statusCode).toBe(200);
    expect(rows()).toBe(before);
    expect((await w.t.app.inject({ method: 'GET', url: `/api/channels/join/preview?token=${'y'.repeat(43)}` })).statusCode).toBe(404);
    expect(rows()).toBe(before + 1);
  });

  it('a wrong, expired, revoked or class-code token gets the body of a missing route — nothing else', async () => {
    const missing = await missingRouteBody(w.t, w.pa);
    const revokedLink = await createCode(w.t, w.pa, subj.id, { kind: 'invite_link', requires_approval: false });
    await call(w.t, w.pa, 'DELETE', `/api/channels/codes/${revokedLink.view.id}`);
    const shortLived = await createCode(w.t, w.pa, subj.id, { kind: 'invite_link', requires_approval: false, expires_in_hours: 1 });
    const classCode = await createCode(w.t, w.pa, subj.id, { requires_approval: false });
    w.t.clock.advance(HOUR + 1);
    for (const tok of ['x'.repeat(43), revokedLink.link!.split('/join/')[1]!, shortLived.link!.split('/join/')[1]!, classCode.code!.replace('-', '').padEnd(16, 'A')]) {
      const r = await w.t.app.inject({ method: 'GET', url: `/api/channels/join/preview?token=${tok}` });
      expect(r.statusCode, tok).toBe(404);
      expect(r.body).toBe(missing);
    }
    // a malformed token is the same 404, not a validation message that would describe the token format
    const bad = await w.t.app.inject({ method: 'GET', url: '/api/channels/join/preview?token=%3Cscript%3E' });
    expect(bad.statusCode).toBe(404);
    expect(bad.body).toBe(missing);
  });

  it('a signed-in user joins with the link; the method is invite_link', async () => {
    const p = await person(w.t, 'link_joiner');
    const r = ok<JoinResponse>(await call(w.t, p.h, 'POST', '/api/channels/join/link', { token: token() }));
    expect(r.membership).toMatchObject({ status: 'approved', join_method: 'invite_link', node: { id: subj.id, title: 'الجراحة' } });
    // a link token is no class code and the other way round
    expect((await joinCode(p, token())).statusCode).toBe(400);
  });

  it('a closed node takes no codes or links at all — invitations only', async () => {
    const closed = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة مغلقة', { join_policy: 'closed' });
    const r = await call(w.t, w.pa, 'POST', `/api/channels/nodes/${closed.id}/codes`, { kind: 'invite_link', expires_in_hours: 1, requires_approval: true });
    expect(r.statusCode).toBe(409);
  });
});

describe('approvals (AOS-2.15) and member management', () => {
  let subj: ChannelNodeView;
  let assistant: Person;
  let student: Person;
  let outsider: Person;
  let code: string;
  beforeAll(async () => {
    subj = await createNode(w.t, w.pa, uni.id, 'subject', 'علم الأمراض');
    assistant = await person(w.t, 'approver_assistant');
    student = await person(w.t, 'approval_student');
    outsider = await person(w.t, 'approval_outsider');
    await assignRole(w.t, w.pa, uni.id, assistant.user.id, 'assistant');
    code = (await createCode(w.t, assistant.h, subj.id)).code!;
  });

  it('an Assistant (inherited from the university) lists pending requests and approves one; it is audited', async () => {
    const pending = ok<JoinResponse>(await joinCode(student, code));
    expect(pending.membership.status).toBe('pending');
    const list = ok<{ items: MemberView[]; next_cursor: string | null }>(await call(w.t, assistant.h, 'GET', `/api/channels/nodes/${subj.id}/members?status=pending`));
    expect(list.items.map((m) => m.user.id)).toEqual([student.user.id]);
    expect(list.items[0]).toMatchObject({ status: 'pending', join_method: 'class_code', user: { id: student.user.id, display_name: 'approval_student', avatar_url: null } });
    const decided = ok<MemberView>(await call(w.t, assistant.h, 'POST', `/api/channels/nodes/${subj.id}/members/${student.user.id}/decision`, { decision: 'approve' }));
    expect(decided).toMatchObject({ status: 'approved', decided_by: { id: assistant.user.id } });
    const viewer = w.t.ctx.tenancy.viewerOf(student.user, null);
    expect(channelsOf(w.t.ctx).access.accessToSpace(viewer, channelsOf(w.t.ctx).repo.node(subj.id)!.space_id!)).toMatchObject({ access: 'member' });
    expect(w.t.ctx.system.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM security_audit WHERE action = 'channel_membership_decide' AND actor_user_id = ? AND scope_node_id = ?`, [assistant.user.id, subj.id])!.n).toBe(1);
  });

  it('a student cannot see the member list (403); an outsider cannot revoke a code (the 404 of a missing id)', async () => {
    expect((await call(w.t, student.h, 'GET', `/api/channels/nodes/${subj.id}/members`)).statusCode).toBe(403);
    const codes = ok<JoinCodesResponse>(await call(w.t, assistant.h, 'GET', `/api/channels/nodes/${subj.id}/codes`));
    const id = codes.codes[0]!.id;
    const r = await call(w.t, outsider.h, 'DELETE', `/api/channels/codes/${id}`);
    const missing = await call(w.t, outsider.h, 'DELETE', '/api/channels/codes/NO_SUCH_CODE');
    expect(r.statusCode).toBe(404);
    expect(r.body).toBe(missing.body);
  });

  it('reject with a reason, remove; a removed member re-joining with a code always waits for approval', async () => {
    const r1 = await person(w.t, 'rejected_one');
    ok<JoinResponse>(await joinCode(r1, code));
    const rej = ok<MemberView>(await call(w.t, assistant.h, 'POST', `/api/channels/nodes/${subj.id}/members/${r1.user.id}/decision`, { decision: 'reject', reason: 'لست من طلاب هذه المرحلة' }));
    expect(rej).toMatchObject({ status: 'rejected', reason_ar: 'لست من طلاب هذه المرحلة' });
    const removed = ok<MemberView>(await call(w.t, assistant.h, 'POST', `/api/channels/nodes/${subj.id}/members/${student.user.id}/decision`, { decision: 'remove', reason: 'خروج من المادة' }));
    expect(removed.status).toBe('removed');
    // the subject now auto-approves code joins — still pending for the removed member
    ok(await call(w.t, w.pa, 'PATCH', `/api/channels/nodes/${subj.id}`, { join_policy: 'open_with_code' }));
    const auto = (await createCode(w.t, assistant.h, subj.id, { requires_approval: false })).code!;
    expect(ok<JoinResponse>(await joinCode(student, auto)).membership.status).toBe('pending');
    // nobody decides about themselves
    const self = await call(w.t, assistant.h, 'POST', `/api/channels/nodes/${subj.id}/members/${assistant.user.id}/decision`, { decision: 'approve' });
    expect([403, 404]).toContain(self.statusCode);
  });

  it('members are paged with an opaque cursor', async () => {
    const node = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة الصفحات');
    const c = (await createCode(w.t, w.pa, node.id)).code!;
    for (let i = 0; i < 5; i++) {
      const p = await person(w.t, `pager_${i}`);
      w.t.clock.advance(1000);
      ok(await joinCode(p, c));
    }
    const first = ok<{ items: MemberView[]; next_cursor: string | null }>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${node.id}/members?limit=2`));
    expect(first.items.map((m) => m.user.display_name)).toEqual(['pager_0', 'pager_1']);
    const second = ok<{ items: MemberView[]; next_cursor: string | null }>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${node.id}/members?limit=2&cursor=${first.next_cursor}`));
    expect(second.items.map((m) => m.user.display_name)).toEqual(['pager_2', 'pager_3']);
    const last = ok<{ items: MemberView[]; next_cursor: string | null }>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${node.id}/members?limit=2&cursor=${second.next_cursor}`));
    expect(last.items.map((m) => m.user.display_name)).toEqual(['pager_4']);
    expect(last.next_cursor).toBeNull();
  });
});

describe('invitations (existing accounts only)', () => {
  it('an Admin invites; only the invitee sees and decides; accepting makes an approved membership', async () => {
    const closed = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة بالدعوة', { join_policy: 'closed' });
    const invitee = await person(w.t, 'invitee');
    const other = await person(w.t, 'not_invitee');
    const sent = ok<InvitationsResponse>(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${closed.id}/invitations`, { user_ids: [invitee.user.id] }));
    expect(sent.invitations).toHaveLength(1);
    const inv = sent.invitations[0]!;
    expect(inv).toMatchObject({ status: 'pending', invitee: { id: invitee.user.id }, node: { id: closed.id } });
    // inviting again returns the same pending invitation
    expect(ok<InvitationsResponse>(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${closed.id}/invitations`, { user_ids: [invitee.user.id] })).invitations[0]!.id).toBe(inv.id);
    expect(ok<InvitationsResponse>(await call(w.t, invitee.h, 'GET', '/api/channels/invitations')).invitations.map((i) => i.id)).toEqual([inv.id]);
    expect(ok<InvitationsResponse>(await call(w.t, other.h, 'GET', '/api/channels/invitations')).invitations).toEqual([]);
    const stolen = await call(w.t, other.h, 'POST', `/api/channels/invitations/${inv.id}/decision`, { accept: true });
    expect(stolen.statusCode).toBe(404);
    const accepted = ok<JoinResponse & { invitation: { status: string } }>(await call(w.t, invitee.h, 'POST', `/api/channels/invitations/${inv.id}/decision`, { accept: true }));
    expect(accepted.membership).toMatchObject({ status: 'approved', join_method: 'invitation' });
    expect(accepted.invitation.status).toBe('accepted');
    // decided once only
    expect((await call(w.t, invitee.h, 'POST', `/api/channels/invitations/${inv.id}/decision`, { accept: true })).statusCode).toBe(409);
    // an unknown account cannot be invited
    expect((await call(w.t, w.pa, 'POST', `/api/channels/nodes/${closed.id}/invitations`, { user_ids: ['NO_SUCH_USER_ID'] })).statusCode).toBe(404);
  });

  it('declining leaves no membership', async () => {
    const node = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة الرفض', { join_policy: 'closed' });
    const p = await person(w.t, 'decliner');
    const inv = ok<InvitationsResponse>(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${node.id}/invitations`, { user_ids: [p.user.id] })).invitations[0]!;
    const r = ok<{ invitation: { status: string }; membership: unknown }>(await call(w.t, p.h, 'POST', `/api/channels/invitations/${inv.id}/decision`, { accept: false }));
    expect(r.invitation.status).toBe('declined');
    expect(r.membership).toBeNull();
    expect(ok<ChannelNodeView>(await call(w.t, p.h, 'GET', `/api/channels/nodes/${node.id}`)).viewer.membership).toBeNull();
  });
});

describe('CSRF and session on the join routes', () => {
  it('a join without the CSRF header is refused', async () => {
    const p = await person(w.t, 'csrf_joiner');
    const r = await w.t.app.inject({ method: 'POST', url: '/api/channels/join', headers: { cookie: p.h.cookie }, payload: { code: 'ABCD-EFGH' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('CSRF_FAILED');
    const anon = await w.t.app.inject({ method: 'POST', url: '/api/channels/join', headers: CSRF, payload: { code: 'ABCD-EFGH' } });
    expect(anon.statusCode).toBe(401);
  });
});
