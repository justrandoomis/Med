// P1-T4 step 2 — the in-app inbox (PRD AOS-18.13, 21.31, 5.18 Phase 1 part; ARCHITECTURE_DELTA §4.1
// `2200_notifications`, §7.12, §12): join requests reach the approvers, decisions reach the requester, invitations the
// invitee; per-user read state; de-duplication; titles and counts only; nothing reaches — or stays visible to — a
// recipient who may not open what it is about; preferences per kind (push is not offered on this server and says why).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeletionPreview, MarkNotificationsReadResponse, NotificationPrefsResponse, NotificationsResponse } from '@medlevo/shared';
import { finishPendingDeletions } from '../../src/modules/accounts/deletion';
import { notificationsOf } from '../../src/modules/notifications/service';
import { CLIENT_VERSION } from '../helpers/app';
import { assignRole, call, type ChannelWorld, channelWorld, createCode, createNode, ok, person, type Person } from '../channels/helpers';
import { drain, inbox, items, storedRows } from './helpers';

let w: ChannelWorld;
let uni: { id: string };
let subject: { id: string; space_id: string | null };
let adminU: Person;
let assistS: Person;
let modS: Person;
let student: Person;
let other: Person;
let invitee: Person;

beforeAll(async () => {
  w = await channelWorld();
  uni = await createNode(w.t, w.pa, null, 'university', 'جامعة التنبيهات');
  subject = await createNode(w.t, w.pa, uni.id, 'subject', 'علم وظائف الأعضاء', { join_policy: 'approval' });
  adminU = await person(w.t, 'notif_admin');
  assistS = await person(w.t, 'notif_assistant');
  modS = await person(w.t, 'notif_moderator');
  student = await person(w.t, 'notif_student');
  other = await person(w.t, 'notif_other');
  invitee = await person(w.t, 'notif_invitee');
  await assignRole(w.t, w.pa, uni.id, adminU.user.id, 'admin');
  await assignRole(w.t, w.pa, subject.id, assistS.user.id, 'assistant');
  await assignRole(w.t, w.pa, subject.id, modS.user.id, 'subject_moderator');
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const requestJoin = async (p: Person, nodeId: string) => ok(await call(w.t, p.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, w.pa, nodeId, { requires_approval: true })).code }));
const decide = async (by: Person['h'], nodeId: string, userId: string, decision: 'approve' | 'reject' | 'remove', reason?: string) =>
  ok(await call(w.t, by, 'POST', `/api/channels/nodes/${nodeId}/members/${userId}/decision`, { decision, ...(reason ? { reason } : {}) }));

describe('joins, decisions and invitations reach the right inbox', () => {
  it('a join request reaches the approvers (Admin above, Assistant here) — not a Subject Moderator, a student or the requester', async () => {
    await requestJoin(student, subject.id);
    for (const approver of [adminU, assistS]) {
      const list = await items(w.t, approver.h, 'join_requested');
      expect(list).toHaveLength(1);
      const n = list[0]!;
      expect(n).toMatchObject({ kind: 'join_requested', payload: { node_title: 'علم وظائف الأعضاء', pending_count: 1 }, read_at: null });
      expect(n.actor).toMatchObject({ id: student.user.id, display_name: 'notif_student' });
      expect(n.target).toEqual({ db: 'system', space_id: null, type: 'channel_node', id: subject.id });
      expect(n.text_ar).toContain('علم وظائف الأعضاء');
      expect(n.link).toMatch(/^\//);
    }
    for (const nobody of [modS, student, other]) expect(await items(w.t, nobody.h, 'join_requested')).toEqual([]);
    // approvers exist, so the platform admin is not paged for every request in every university
    expect(await items(w.t, w.pa, 'join_requested')).toEqual([]);
  });

  it('the decision reaches the requester, with the approver named and the reason when one was given', async () => {
    await decide(adminU.h, subject.id, student.user.id, 'approve');
    const decided = await items(w.t, student.h, 'join_decided');
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ payload: { node_title: 'علم وظائف الأعضاء', decision: 'approved' }, actor: { id: adminU.user.id } });
    expect(decided[0]!.text_ar).toContain('علم وظائف الأعضاء');

    await requestJoin(other, subject.id);
    await decide(assistS.h, subject.id, other.user.id, 'reject', 'المادة لطلاب المرحلة الثانية فقط');
    expect((await items(w.t, other.h, 'join_decided'))[0]).toMatchObject({ payload: { decision: 'rejected' } });

    await decide(adminU.h, subject.id, student.user.id, 'remove');
    const after = await items(w.t, student.h, 'join_decided');
    expect(after.map((n) => n.payload)).toEqual([
      { node_title: 'علم وظائف الأعضاء', decision: 'removed' },
      { node_title: 'علم وظائف الأعضاء', decision: 'approved' },
    ]);
    // re-admit for the next tests
    await requestJoin(student, subject.id);
    await decide(adminU.h, subject.id, student.user.id, 'approve');
  });

  it('a new account registering with a code that needs approval is announced to the approvers too', async () => {
    const before = (await items(w.t, assistS.h, 'join_requested')).length;
    const code = (await createCode(w.t, w.pa, subject.id, { requires_approval: true })).code!;
    const r = await w.t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'x-medlevo-csrf': '1', 'x-medlevo-client': CLIENT_VERSION['x-medlevo-client'], 'user-agent': 'vitest-register' },
      payload: { username: 'notif_newcomer', display_name: 'طالب مسجل جديد', password: 'newcomer-password-123', join: { code } },
    });
    expect(r.statusCode, r.body).toBe(200);
    const list = await items(w.t, assistS.h, 'join_requested');
    expect(list.length).toBe(before + 1);
    expect(list[0]!.actor).toMatchObject({ display_name: 'طالب مسجل جديد' });
  });

  it('an invitation reaches the invitee once (inviting again changes nothing)', async () => {
    ok(await call(w.t, adminU.h, 'POST', `/api/channels/nodes/${subject.id}/invitations`, { user_ids: [invitee.user.id] }));
    ok(await call(w.t, adminU.h, 'POST', `/api/channels/nodes/${subject.id}/invitations`, { user_ids: [invitee.user.id] }));
    const inv = await items(w.t, invitee.h, 'invitation');
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ payload: { node_title: 'علم وظائف الأعضاء' }, actor: { id: adminU.user.id } });
    expect(storedRows(w.t, invitee.user.id).filter((r) => r.kind === 'invitation')).toHaveLength(1);
  });
});

describe('read state is per user', () => {
  it('marks chosen ids or everything; another user\'s id changes nothing and confirms nothing', async () => {
    const before = await inbox(w.t, adminU.h);
    expect(before.unread_count).toBeGreaterThan(0);
    const mine = before.items[0]!;
    // someone else tries to mark the admin's notification read: ignored, and the answer is the same as for a missing id
    const foreign = ok<MarkNotificationsReadResponse>(await call(w.t, other.h, 'POST', '/api/notifications/read', { ids: [mine.id] }));
    const missing = ok<MarkNotificationsReadResponse>(await call(w.t, other.h, 'POST', '/api/notifications/read', { ids: ['NO_SUCH_NOTIFICATION'] }));
    expect(foreign.updated).toBe(0);
    expect(missing.updated).toBe(0);
    expect((await inbox(w.t, adminU.h)).items.find((n) => n.id === mine.id)!.read_at).toBeNull();

    const one = ok<MarkNotificationsReadResponse>(await call(w.t, adminU.h, 'POST', '/api/notifications/read', { ids: [mine.id] }));
    expect(one).toEqual({ updated: 1, unread_count: before.unread_count - 1 });
    const unreadOnly = await inbox(w.t, adminU.h, '?unread=true');
    expect(unreadOnly.items.some((n) => n.id === mine.id)).toBe(false);
    expect(unreadOnly.items.every((n) => n.read_at === null)).toBe(true);

    const all = ok<MarkNotificationsReadResponse>(await call(w.t, adminU.h, 'POST', '/api/notifications/read', { all: true }));
    expect(all.unread_count).toBe(0);
    expect((await inbox(w.t, adminU.h)).unread_count).toBe(0);
    // the Assistant's copy of the same join request is still unread: read state is per user
    expect((await items(w.t, assistS.h, 'join_requested')).every((n) => n.read_at === null)).toBe(true);
    // marking again is a no-op
    expect(ok<MarkNotificationsReadResponse>(await call(w.t, adminU.h, 'POST', '/api/notifications/read', { all: true })).updated).toBe(0);
  });

  it('pages newest first with an opaque cursor; bad cursors and bodies are refused', async () => {
    const page1 = await inbox(w.t, student.h, '?limit=1');
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = await inbox(w.t, student.h, `?limit=1&cursor=${page1.next_cursor}`);
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
    expect(page2.items[0]!.created_at).toBeLessThanOrEqual(page1.items[0]!.created_at);
    expect((await call(w.t, student.h, 'GET', '/api/notifications?cursor=!!!')).statusCode).toBe(400);
    expect((await call(w.t, student.h, 'GET', '/api/notifications?cursor=AAAA')).statusCode).toBe(400);
    expect((await call(w.t, student.h, 'POST', '/api/notifications/read', { ids: [] })).statusCode).toBe(400);
    expect((await call(w.t, student.h, 'POST', '/api/notifications/read', { all: false })).statusCode).toBe(400);
  });
});

describe('nothing private reaches someone who may not open it', () => {
  it('an approver whose role is revoked no longer sees the join requests it was sent (list and count)', async () => {
    const before = await items(w.t, assistS.h, 'join_requested');
    expect(before.length).toBeGreaterThan(0);
    const roles = ok<{ roles: Array<{ id: string; user: { id: string }; role: string }> }>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${subject.id}/roles`));
    const role = roles.roles.find((r) => r.user.id === assistS.user.id && r.role === 'assistant')!;
    ok(await call(w.t, w.pa, 'DELETE', `/api/channels/roles/${role.id}`));
    const after = await inbox(w.t, assistS.h);
    expect(after.items.filter((n) => n.kind === 'join_requested')).toEqual([]);
    expect(after.unread_count).toBe(0);
    expect(JSON.stringify(after)).not.toContain('notif_other');
    // the rows are still stored (a role given back shows them again) — hidden, not deleted
    expect(storedRows(w.t, assistS.user.id).some((r) => r.kind === 'join_requested')).toBe(true);
    await assignRole(w.t, w.pa, subject.id, assistS.user.id, 'assistant');
    expect((await items(w.t, assistS.h, 'join_requested')).length).toBe(before.length);
  });

  it('subject news reaches followers who may still open the subject; a removed follower gets nothing, and earlier news disappears', async () => {
    const follower = await person(w.t, 'notif_follower');
    const leaver = await person(w.t, 'notif_leaver');
    for (const p of [follower, leaver]) {
      await requestJoin(p, subject.id);
      await decide(adminU.h, subject.id, p.user.id, 'approve');
      ok(await call(w.t, p.h, 'PUT', `/api/channels/subjects/${subject.id}/follow`, { add_new_lectures: true }));
    }
    const svc = notificationsOf(w.t.ctx);
    // what P1-T5 does when a lecture is published (titles and counts only)
    const lecture = (n: number) =>
      svc.publish({
        content: { kind: 'official_lecture_new', payload: { subject_title: 'علم وظائف الأعضاء', lecture_title: `محاضرة القلب ${n}`, lecture_no: n } },
        target: { db: 'space', space_id: subject.space_id!, type: 'official_lecture', id: `LEC${n}` },
        scopeNodeId: subject.id,
        access: 'member',
        dedupeKey: `official_lecture_new:${subject.space_id}:LEC${n}`,
        audience: { kind: 'course_followers', subject_node_id: subject.id },
      });
    lecture(1);
    drain(w.t);
    expect((await items(w.t, leaver.h, 'official_lecture_new')).map((n) => n.payload)).toEqual([{ subject_title: 'علم وظائف الأعضاء', lecture_title: 'محاضرة القلب 1', lecture_no: 1 }]);
    const one = (await items(w.t, follower.h, 'official_lecture_new'))[0]!;
    expect(one.target).toEqual({ db: 'space', space_id: subject.space_id, type: 'official_lecture', id: 'LEC1' });

    await decide(adminU.h, subject.id, leaver.user.id, 'remove');
    lecture(2);
    drain(w.t);
    // the removed follower: no row for lecture 2 was even written, and lecture 1 is no longer shown
    expect(storedRows(w.t, leaver.user.id).filter((r) => r.kind === 'official_lecture_new').map((r) => JSON.parse(r.payload_json).lecture_no)).toEqual([1]);
    const leaverInbox = await inbox(w.t, leaver.h);
    expect(leaverInbox.items.filter((n) => n.kind === 'official_lecture_new')).toEqual([]);
    expect(JSON.stringify(leaverInbox)).not.toContain('محاضرة القلب');
    expect((await items(w.t, follower.h, 'official_lecture_new')).map((n) => (n.payload as { lecture_title: string }).lecture_title)).toEqual(['محاضرة القلب 2', 'محاضرة القلب 1']);
  });

  it('a payload holds titles and counts only: an unknown field is refused before anything is written; titles are cleaned', () => {
    const svc = notificationsOf(w.t.ctx);
    const rowsBefore = w.t.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notification_fanout')!.n;
    expect(() =>
      svc.publish({
        // note text from a vault must never ride along
        content: { kind: 'invitation', payload: { node_title: 'مادة', note_text: 'ملاحظتي الخاصة' } } as never,
        dedupeKey: 'test:private-field',
        audience: { kind: 'users', user_ids: [student.user.id] },
      }),
    ).toThrow();
    expect(w.t.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notification_fanout')!.n).toBe(rowsBefore);

    // a vault title with bidi controls and 300 characters becomes a clean one-line title of at most 200 characters
    svc.publish({
      content: { kind: 'reanchor_ready', payload: { lecture_title: `‫محاضرة‬ ${'أ'.repeat(300)}`, copied: 3, needs_review: 1, kept: 0 } },
      dedupeKey: 'test:reanchor-title',
      audience: { kind: 'users', user_ids: [student.user.id] },
    });
    drain(w.t);
    const row = storedRows(w.t, student.user.id).find((r) => r.kind === 'reanchor_ready')!;
    const title = JSON.parse(row.payload_json).lecture_title as string;
    expect(Array.from(title).length).toBeLessThanOrEqual(200);
    expect(title).not.toMatch(/[‪-‮]/);
    expect(title.endsWith('…')).toBe(true);
  });

  it('kinds without an actor never name one (a moderation outcome never names the reporter)', async () => {
    const svc = notificationsOf(w.t.ctx);
    svc.publish({
      content: { kind: 'moderation', payload: { target_title: 'شرح القلب', action: 'hide', reason_ar: 'يحتوي معرّفات مريض', as: 'author' } },
      actorUserId: other.user.id, // a caller passing the reporter by mistake
      dedupeKey: 'test:moderation-actor',
      audience: { kind: 'users', user_ids: [student.user.id] },
    });
    const n = (await items(w.t, student.h, 'moderation'))[0]!;
    expect(n.actor).toBeNull();
    expect(storedRows(w.t, student.user.id).length).toBeGreaterThan(0);
    expect(w.t.ctx.system.db.get<{ actor_user_id: string | null }>(`SELECT actor_user_id FROM notification WHERE user_id = ? AND kind = 'moderation'`, [student.user.id])!.actor_user_id).toBeNull();
  });

  it('a deleted actor reads «طالب سابق» everywhere at once', async () => {
    const gone = await person(w.t, 'notif_gone_admin');
    await assignRole(w.t, w.pa, uni.id, gone.user.id, 'admin');
    const target = await person(w.t, 'notif_target');
    ok(await call(w.t, gone.h, 'POST', `/api/channels/nodes/${subject.id}/invitations`, { user_ids: [target.user.id] }));
    drain(w.t);
    // something in the leaving account's own inbox first
    notificationsOf(w.t.ctx).publish({ content: { kind: 'quota_warning', payload: { quota: 'storage', percent: 80 } }, dedupeKey: 'test:gone-quota', audience: { kind: 'users', user_ids: [gone.user.id] } });
    drain(w.t);
    expect(storedRows(w.t, gone.user.id).length).toBeGreaterThan(0);
    const preview = ok<DeletionPreview>(await call(w.t, gone.h, 'POST', '/api/accounts/me/delete', { preview: true }));
    ok(await call(w.t, gone.h, 'POST', '/api/accounts/me/delete', { confirm_token: preview.confirm_token, password: gone.password }));
    await finishPendingDeletions(w.t.ctx);
    // the deleted account's inbox and preferences are gone with it
    expect(storedRows(w.t, gone.user.id)).toEqual([]);
    const body = await inbox(w.t, target.h);
    // the invitation is gone with its sender's power (review P1-T4 step 1 R4) — but whatever names the actor shows the
    // neutral name, never the old one
    expect(JSON.stringify(body)).not.toContain('notif_gone_admin');
    for (const n of body.items) if (n.actor?.id === gone.user.id) expect(n.actor).toMatchObject({ display_name: 'طالب سابق', former: true });
  });
});

describe('de-duplication', () => {
  it('the same event published twice is written once per recipient', async () => {
    const svc = notificationsOf(w.t.ctx);
    const input = {
      content: { kind: 'subject_update' as const, payload: { subject_title: 'علم وظائف الأعضاء', event_kind: 'exam_date_published' as const, title: 'امتحان نصف الفصل' } },
      scopeNodeId: subject.id,
      access: 'member' as const,
      dedupeKey: 'subject_update:EVT1',
      audience: { kind: 'users' as const, user_ids: [student.user.id, student.user.id] },
    };
    expect(svc.publish(input).created).toBe(true);
    expect(svc.publish(input).created).toBe(false);
    drain(w.t);
    expect(storedRows(w.t, student.user.id).filter((r) => r.dedupe_key === 'subject_update:EVT1')).toHaveLength(1);
  });
});

describe('preferences', () => {
  it('in-app per kind (default on); push is not offered on this server and says why', async () => {
    const prefs = ok<NotificationPrefsResponse>(await call(w.t, other.h, 'GET', '/api/notifications/prefs'));
    expect(prefs.prefs.map((p) => p.kind)).toContain('join_decided');
    expect(prefs.prefs.every((p) => p.in_app && !p.push && p.label_ar.length > 0)).toBe(true);
    expect(prefs.push.available).toBe(false);
    expect(prefs.push.reason_ar).toMatch(/[؀-ۿ]/);

    const off = ok<NotificationPrefsResponse>(await call(w.t, other.h, 'PUT', '/api/notifications/prefs', { prefs: [{ kind: 'join_decided', channel: 'in_app', enabled: false }] }));
    expect(off.prefs.find((p) => p.kind === 'join_decided')!.in_app).toBe(false);
    const count = (await items(w.t, other.h, 'join_decided')).length;
    await requestJoin(other, subject.id);
    await decide(adminU.h, subject.id, other.user.id, 'approve');
    expect((await items(w.t, other.h, 'join_decided')).length).toBe(count);

    const push = await call(w.t, other.h, 'PUT', '/api/notifications/prefs', { prefs: [{ kind: 'join_decided', channel: 'push', enabled: true }] });
    expect(push.statusCode).toBe(409);
    expect(push.json().error.code).toBe('FEATURE_DISABLED');
    expect((await call(w.t, other.h, 'PUT', '/api/notifications/prefs', { prefs: [{ kind: 'nope', channel: 'in_app', enabled: true }] })).statusCode).toBe(400);
    // the preference of one user is not another's
    expect(ok<NotificationPrefsResponse>(await call(w.t, student.h, 'GET', '/api/notifications/prefs')).prefs.find((p) => p.kind === 'join_decided')!.in_app).toBe(true);
  });

  it('the push-subscription routes are not mounted while push cannot be delivered (no decorative endpoint)', async () => {
    const res = await call(w.t, other.h, 'POST', '/api/notifications/push-subscriptions', { endpoint: 'https://push.example.org/x', keys: { p256dh: 'a', auth: 'b' } });
    expect(res.statusCode).toBe(404);
  });

  it('the inbox needs a session', async () => {
    const res = await w.t.app.inject({ method: 'GET', url: '/api/notifications', headers: { 'x-medlevo-csrf': '1' } });
    expect(res.statusCode).toBe(401);
    const body = (await call(w.t, other.h, 'GET', '/api/notifications')).json() as NotificationsResponse;
    expect(Array.isArray(body.items)).toBe(true);
  });
});
