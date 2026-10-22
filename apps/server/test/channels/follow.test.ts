// P1-T4 step 2 — «تابع المادة» = course follow (PRD AOS-2.16, 21.15 Phase 1 part, Q1: not a payment;
// ARCHITECTURE_DELTA §7.3 `PUT · DELETE /api/channels/subjects/:id/follow`, §4.1 `course_follow`). Members of the
// subject follow it (new official lectures reach their library as stubs — P1-T5 — and their inbox); a pending request
// or an outsider is refused with the reason; the toggle's state is in the node view; unfollow works and is idempotent;
// the library folder must be one of the follower's OWN vault folders.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelNodeDetail, CourseFollowView, CourseUnfollowResponse } from '@medlevo/shared';
import { call, type ChannelWorld, channelWorld, createCode, createNode, ok, person, type Person } from './helpers';

let w: ChannelWorld;
let subject: { id: string };
let other: { id: string };
let stage: { id: string };
let member: Person;
let pending: Person;
let outsider: Person;

beforeAll(async () => {
  w = await channelWorld();
  const uni = await createNode(w.t, w.pa, null, 'university', 'جامعة المتابعة');
  stage = await createNode(w.t, w.pa, uni.id, 'stage', 'المرحلة الأولى');
  subject = await createNode(w.t, w.pa, stage.id, 'subject', 'علم الأدوية', { join_policy: 'open_with_code' });
  other = await createNode(w.t, w.pa, stage.id, 'subject', 'علم الأمراض', { join_policy: 'open_with_code' });
  member = await person(w.t, 'follow_member');
  pending = await person(w.t, 'follow_pending');
  outsider = await person(w.t, 'follow_outsider');
  ok(await call(w.t, member.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, w.pa, subject.id, { requires_approval: false })).code }));
  ok(await call(w.t, pending.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, w.pa, subject.id, { requires_approval: true })).code }));
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const follow = (h: Person['h'], id: string, body: unknown = { add_new_lectures: true }) => call(w.t, h, 'PUT', `/api/channels/subjects/${id}/follow`, body);
const unfollow = (h: Person['h'], id: string) => call(w.t, h, 'DELETE', `/api/channels/subjects/${id}/follow`);

describe('«تابع المادة» (course follow)', () => {
  it('a member follows the subject; the node view shows the toggle on; unfollow ends it (idempotent)', async () => {
    const f = ok<CourseFollowView>(await follow(member.h, subject.id));
    expect(f).toMatchObject({ subject: { id: subject.id, kind: 'subject', title: 'علم الأدوية' }, add_new_lectures: true, library_folder_id: null });
    const node = ok<ChannelNodeDetail>(await call(w.t, member.h, 'GET', `/api/channels/nodes/${subject.id}`));
    expect(node.viewer.course_follow).toMatchObject({ subject: { id: subject.id }, add_new_lectures: true });
    // the tree carries the same state
    const tree = ok<{ nodes: Array<{ id: string; viewer: { course_follow: unknown } }> }>(await call(w.t, member.h, 'GET', `/api/channels/tree?root=${stage.id}&depth=1`));
    expect(tree.nodes.find((n) => n.id === subject.id)!.viewer.course_follow).not.toBeNull();

    // changing the setting keeps the follow (one row per user and subject)
    const changed = ok<CourseFollowView>(await follow(member.h, subject.id, { add_new_lectures: false }));
    expect(changed.add_new_lectures).toBe(false);
    expect(changed.created_at).toBe(f.created_at);
    expect(w.t.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM course_follow WHERE user_id = ?', [member.user.id])!.n).toBe(1);

    const off = ok<CourseUnfollowResponse>(await unfollow(member.h, subject.id));
    expect(off).toEqual({ subject: { id: subject.id, kind: 'subject', title: 'علم الأدوية' }, course_follow: null });
    expect(ok<ChannelNodeDetail>(await call(w.t, member.h, 'GET', `/api/channels/nodes/${subject.id}`)).viewer.course_follow).toBeNull();
    // again: the same answer, nothing changes
    expect(ok<CourseUnfollowResponse>(await unfollow(member.h, subject.id)).course_follow).toBeNull();
    // and following again starts a new follow
    expect(ok<CourseFollowView>(await follow(member.h, subject.id)).add_new_lectures).toBe(true);
  });

  it('a pending request is told it waits for approval; an outsider must join first (403 with the reason)', async () => {
    const p = await follow(pending.h, subject.id);
    expect(p.statusCode).toBe(403);
    expect(p.json().error.code).toBe('MEMBERSHIP_PENDING');
    const o = await follow(outsider.h, subject.id);
    expect(o.statusCode).toBe(403);
    expect(o.json().error.code).toBe('MEMBERSHIP_REQUIRED');
    // membership of one subject does not open its sibling (never sideways)
    const s = await follow(member.h, other.id);
    expect(s.statusCode).toBe(403);
    expect(s.json().error.code).toBe('MEMBERSHIP_REQUIRED');
    expect(w.t.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM course_follow WHERE user_id IN (?, ?)', [pending.user.id, outsider.user.id])!.n).toBe(0);
  });

  it('only subjects are followed; a missing node is the 404 of a missing id', async () => {
    const st = await follow(w.pa, stage.id);
    expect(st.statusCode).toBe(403);
    const missing = await follow(member.h, 'NO_SUCH_NODE');
    expect(missing.statusCode).toBe(404);
    expect((await unfollow(member.h, 'NO_SUCH_NODE')).statusCode).toBe(404);
    const bad = await follow(member.h, subject.id, { add_new_lectures: 'yes' });
    expect(bad.statusCode).toBe(400);
  });

  it('the library folder must be a folder of the follower\'s OWN vault (never another user\'s, never a notebook)', async () => {
    // a folder in the member's own vault
    const mine = ok<{ node: { id: string } }>(await call(w.t, member.h, 'POST', '/api/library/nodes', { kind: 'folder', title: 'موادي من القنوات', parent_id: null })).node;
    const withFolder = ok<CourseFollowView>(await follow(member.h, subject.id, { add_new_lectures: true, library_folder_id: mine.id }));
    expect(withFolder.library_folder_id).toBe(mine.id);
    // a folder of ANOTHER user's vault: unknown here (the request is bound to the follower's own vault)
    const theirs = ok<{ node: { id: string } }>(await call(w.t, outsider.h, 'POST', '/api/library/nodes', { kind: 'folder', title: 'مجلد غيري', parent_id: null })).node;
    const foreign = await follow(member.h, subject.id, { add_new_lectures: true, library_folder_id: theirs.id });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.body).not.toContain('مجلد غيري');
    // a notebook is not a folder
    const notebook = ok<{ node: { id: string } }>(await call(w.t, member.h, 'POST', '/api/library/nodes', { kind: 'notebook', title: 'دفتري', parent_id: null })).node;
    expect((await follow(member.h, subject.id, { add_new_lectures: true, library_folder_id: notebook.id })).statusCode).toBe(400);
    // null puts new lectures back under «موادي من القنوات»
    expect(ok<CourseFollowView>(await follow(member.h, subject.id, { add_new_lectures: true, library_folder_id: null })).library_folder_id).toBeNull();
  });

  it('the follow is the viewer\'s own: nobody sees or ends someone else\'s', async () => {
    ok(await follow(member.h, subject.id));
    // the platform admin's view of the subject shows ITS OWN follow state, not the member's
    expect(ok<ChannelNodeDetail>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${subject.id}`)).viewer.course_follow).toBeNull();
    // the platform admin's unfollow touches only its own row
    ok(await unfollow(w.pa, subject.id));
    expect(ok<ChannelNodeDetail>(await call(w.t, member.h, 'GET', `/api/channels/nodes/${subject.id}`)).viewer.course_follow).not.toBeNull();
  });

  it('CSRF and session are required', async () => {
    const noSession = await w.t.app.inject({ method: 'PUT', url: `/api/channels/subjects/${subject.id}/follow`, headers: { 'x-medlevo-csrf': '1' }, payload: { add_new_lectures: true } });
    expect(noSession.statusCode).toBe(401);
    const noCsrf = await w.t.app.inject({ method: 'PUT', url: `/api/channels/subjects/${subject.id}/follow`, headers: { cookie: member.h.cookie }, payload: { add_new_lectures: true } });
    expect(noCsrf.statusCode).toBe(403);
  });
});
