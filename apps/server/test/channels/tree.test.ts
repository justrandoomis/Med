// P1-T4 step 1 — the university tree (BUILD_PLAN §3.6 «test/channels/tree.test.ts»; PRD AOS-2.1, 18.2, 21.2–21.6;
// ARCHITECTURE_DELTA §4.1 `2050_directory`, §7.3):
//   * user #1 (the platform admin) creates the first university (PRD Q4); nobody else can, and a root is a university;
//   * kinds strictly descend down the tree (levels may be skipped); a subject is the last level;
//   * the closure answers «is X inside Y» in one lookup, also after a move; a move never makes a cycle;
//   * creating a subject creates its own space FILE through T1's registry (one space per subject, PRD Q36);
//   * archive shows its impact first, then archives the subtree, revokes open codes and makes the spaces read-only;
//   * titles are visible to every signed-in user (titles only), never to anyone signed out; AC-20 on titles.
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelArchiveResponse, ChannelNodeDetail, ChannelNodeView, ChannelTreeResponse } from '@medlevo/shared';
import { channelsOf } from '../../src/modules/channels/service';
import { assignRole, call, type ChannelWorld, channelWorld, createCode, createNode, ok, type Person, person } from './helpers';

let w: ChannelWorld;
let admin: Person;
let student: Person;

beforeAll(async () => {
  w = await channelWorld();
  admin = await person(w.t, 'tree_admin');
  student = await person(w.t, 'tree_student');
}, 120_000);
afterAll(async () => {
  await w?.close();
});

describe('roots: the platform admin creates the first university (PRD Q4)', () => {
  it('user #1 is the platform admin and creates a university; the response is the node view', async () => {
    const me = ok<{ is_platform_admin: boolean }>(await call(w.t, w.pa, 'GET', '/api/accounts/me'));
    expect(me.is_platform_admin).toBe(true);
    const u = await createNode(w.t, w.pa, null, 'university', 'جامعة بغداد', { title_en: 'University of Baghdad' });
    expect(u).toMatchObject({ kind: 'university', title: 'جامعة بغداد', title_en: 'University of Baghdad', parent_id: null, has_space: false, space_id: null, join_policy: 'approval', status: 'active' });
    expect(u.viewer).toEqual({ membership: null, roles: [], inherited_from: null, course_follow: null });
  });

  it('nobody else creates a university (403: the tree is visible, the action is not theirs); a root must be a university', async () => {
    const r = await call(w.t, student.h, 'POST', '/api/channels/nodes', { parent_id: null, kind: 'university', title: 'جامعة أخرى' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('FORBIDDEN');
    const college = await call(w.t, w.pa, 'POST', '/api/channels/nodes', { parent_id: null, kind: 'college', title: 'كلية بلا جامعة' });
    expect(college.statusCode).toBe(400);
    expect(college.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('signed out: every channel route answers 401 (titles are for signed-in users only, PRD Q2)', async () => {
    const r = await w.t.app.inject({ method: 'GET', url: '/api/channels/tree' });
    expect(r.statusCode).toBe(401);
  });
});

describe('kinds strictly descend; levels may be skipped', () => {
  let uni: ChannelNodeView;
  beforeAll(async () => {
    uni = await createNode(w.t, w.pa, null, 'university', 'جامعة المستنصرية');
  });

  it('accepts every strictly lower kind (skipping levels) and refuses equal or higher kinds', async () => {
    const college = await createNode(w.t, w.pa, uni.id, 'college', 'كلية الطب');
    const stage = await createNode(w.t, w.pa, college.id, 'stage', 'المرحلة الثالثة', { ordinal: 3 }); // no department
    const year = await createNode(w.t, w.pa, stage.id, 'academic_year', 'العام الدراسي ٢٠٢٦–٢٠٢٧', { starts_on: '2026-09-15', ends_on: '2027-06-30' });
    expect(year).toMatchObject({ starts_on: '2026-09-15', ends_on: '2027-06-30' });
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة عامة'); // a subject directly under the university
    expect(subj.parent_id).toBe(uni.id);
    for (const [parent, kind] of [
      [college.id, 'university'],
      [college.id, 'college'],
      [stage.id, 'department'],
      [subj.id, 'subject'],
      [subj.id, 'course'],
    ] as const) {
      const r = await call(w.t, w.pa, 'POST', '/api/channels/nodes', { parent_id: parent, kind, title: 'غير صالح' });
      expect(r.statusCode, `${kind} under ${parent}`).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('dates belong to academic years and courses only; the end never precedes the start', async () => {
    const bad = await call(w.t, w.pa, 'POST', '/api/channels/nodes', { parent_id: uni.id, kind: 'college', title: 'كلية', starts_on: '2026-01-01' });
    expect(bad.statusCode).toBe(400);
    const order = await call(w.t, w.pa, 'POST', '/api/channels/nodes', { parent_id: uni.id, kind: 'academic_year', title: 'سنة', starts_on: '2027-01-01', ends_on: '2026-01-01' });
    expect(order.statusCode).toBe(400);
  });

  it('an unknown parent is 404; a title with a bidi control character is refused (AC-20)', async () => {
    expect((await call(w.t, w.pa, 'POST', '/api/channels/nodes', { parent_id: 'NOPE', kind: 'college', title: 'كلية' })).statusCode).toBe(404);
    const bidi = await call(w.t, w.pa, 'POST', '/api/channels/nodes', { parent_id: uni.id, kind: 'college', title: 'كلية‮الطب' });
    expect(bidi.statusCode).toBe(400);
  });
});

describe('the closure table', () => {
  it('answers «inside» in one lookup for every ancestor; a move rewrites the subtree and refuses cycles and wrong kinds', async () => {
    const u = await createNode(w.t, w.pa, null, 'university', 'جامعة الكوفة');
    const c = await createNode(w.t, w.pa, u.id, 'college', 'كلية الطب');
    const d = await createNode(w.t, w.pa, c.id, 'department', 'قسم الجراحة');
    const s = await createNode(w.t, w.pa, d.id, 'stage', 'المرحلة الرابعة');
    const subj = await createNode(w.t, w.pa, s.id, 'subject', 'الجراحة العامة');
    const repo = channelsOf(w.t.ctx).repo;
    for (const anc of [u, c, d, s, subj]) expect(repo.isInside(subj.id, anc.id), anc.title).toBe(true);
    expect(repo.isInside(u.id, subj.id)).toBe(false);
    expect(repo.ancestors(subj.id).map((a) => [a.id, a.depth])).toEqual([
      [subj.id, 0],
      [s.id, 1],
      [d.id, 2],
      [c.id, 3],
      [u.id, 4],
    ]);
    // move the stage (with its subject) straight under the college: the department is no longer an ancestor
    const moved = ok<ChannelNodeView>(await call(w.t, w.pa, 'PATCH', `/api/channels/nodes/${s.id}`, { parent_id: c.id }));
    expect(moved.parent_id).toBe(c.id);
    expect(repo.isInside(subj.id, d.id)).toBe(false);
    expect(repo.ancestors(subj.id).map((a) => a.id)).toEqual([subj.id, s.id, c.id, u.id]);
    // a node never moves under itself or under its own descendant, nor under a lower kind
    expect((await call(w.t, w.pa, 'PATCH', `/api/channels/nodes/${c.id}`, { parent_id: s.id })).statusCode).toBe(400);
    expect((await call(w.t, w.pa, 'PATCH', `/api/channels/nodes/${s.id}`, { parent_id: s.id })).statusCode).toBe(400);
    expect((await call(w.t, w.pa, 'PATCH', `/api/channels/nodes/${c.id}`, { parent_id: d.id })).statusCode).toBe(400);
  });
});

describe('one space per subject, through T1’s registry', () => {
  it('creating a subject creates its own registered space file; two subjects never share one', async () => {
    const u = await createNode(w.t, w.pa, null, 'university', 'جامعة البصرة');
    const a = await createNode(w.t, w.pa, u.id, 'subject', 'التشريح');
    const b = await createNode(w.t, w.pa, u.id, 'subject', 'الفسلجة');
    expect(a.has_space && b.has_space).toBe(true);
    // the platform admin may bind every space (moderator powers, BUILD_PLAN Q4): it sees the ids
    expect(a.space_id).toBeTruthy();
    expect(a.space_id).not.toBe(b.space_id);
    for (const sid of [a.space_id!, b.space_id!]) {
      const row = w.t.ctx.system.vaults.spaceByIdInternal(sid);
      expect(row).toMatchObject({ status: 'active' });
      expect(existsSync(w.t.ctx.pool.pathOf('space', sid))).toBe(true);
    }
    expect(w.t.ctx.pool.pathOf('space', a.space_id!)).not.toBe(w.t.ctx.pool.pathOf('space', b.space_id!));
    // the space opens with the base + space migration sets (a real subject database, not a vault)
    const db = w.t.ctx.dbs.space(a.space_id!);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_migration WHERE name LIKE '0%'")!.n).toBeGreaterThan(10);
    // a non-subject never gets a space (a course-level space is a later explicit choice, PRD Q36); a subject always does
    expect((await call(w.t, w.pa, 'POST', '/api/channels/nodes', { parent_id: u.id, kind: 'college', title: 'كلية', create_space: true })).statusCode).toBe(400);
    expect((await call(w.t, w.pa, 'POST', '/api/channels/nodes', { parent_id: u.id, kind: 'subject', title: 'مادة', create_space: false })).statusCode).toBe(400);
  });

  it('space_id is shown only to a viewer who may bind it; renaming a subject renames its space', async () => {
    const u = await createNode(w.t, w.pa, null, 'university', 'جامعة ذي قار');
    const subj = await createNode(w.t, w.pa, u.id, 'subject', 'الأدوية');
    const seen = ok<ChannelNodeDetail>(await call(w.t, student.h, 'GET', `/api/channels/nodes/${subj.id}`));
    expect(seen).toMatchObject({ id: subj.id, title: 'الأدوية', has_space: true, space_id: null });
    expect(seen.path.map((p) => p.id)).toEqual([u.id]);
    const renamed = ok<ChannelNodeView>(await call(w.t, w.pa, 'PATCH', `/api/channels/nodes/${subj.id}`, { title: 'علم الأدوية' }));
    expect(renamed.title).toBe('علم الأدوية');
    expect(w.t.ctx.system.vaults.spaceByIdInternal(subj.space_id!)!.title).toBe('علم الأدوية');
  });
});

describe('the tree endpoint', () => {
  it('lists titles to every signed-in user, by depth and root, and says when the tree was cut', async () => {
    const u = await createNode(w.t, w.pa, null, 'university', 'جامعة الموصل');
    const c = await createNode(w.t, w.pa, u.id, 'college', 'كلية طب الموصل');
    const s = await createNode(w.t, w.pa, c.id, 'subject', 'الكيمياء الحيوية');
    const top = ok<ChannelTreeResponse>(await call(w.t, student.h, 'GET', '/api/channels/tree?depth=1'));
    expect(top.nodes.every((n) => n.kind === 'university')).toBe(true);
    expect(top.nodes.map((n) => n.id)).toContain(u.id);
    const sub = ok<ChannelTreeResponse>(await call(w.t, student.h, 'GET', `/api/channels/tree?root=${u.id}&depth=2`));
    expect(sub.nodes.map((n) => n.id)).toEqual([u.id, c.id, s.id]);
    expect(sub.truncated).toBe(false);
    const one = ok<ChannelTreeResponse>(await call(w.t, student.h, 'GET', `/api/channels/tree?root=${u.id}&depth=1`));
    expect(one.nodes.map((n) => n.id)).toEqual([u.id, c.id]);
    // only names and the join policy: never the space id to a non-member
    expect(sub.nodes.find((n) => n.id === s.id)).toMatchObject({ has_space: true, space_id: null, join_policy: 'approval' });
    expect((await call(w.t, student.h, 'GET', '/api/channels/tree?root=NOPE')).statusCode).toBe(404);
  });
});

describe('admins act on their own subtree only', () => {
  it('an Admin of one university creates and edits below it, and nothing in another university', async () => {
    const mine = await createNode(w.t, w.pa, null, 'university', 'جامعة بابل');
    const other = await createNode(w.t, w.pa, null, 'university', 'جامعة كربلاء');
    await assignRole(w.t, w.pa, mine.id, admin.user.id, 'admin');
    const c = await createNode(w.t, admin.h, mine.id, 'college', 'كلية طب بابل');
    expect(c.viewer.roles).toEqual(['admin']);
    expect(c.viewer.inherited_from).toEqual({ id: mine.id, kind: 'university', title: 'جامعة بابل' });
    const r = await call(w.t, admin.h, 'POST', '/api/channels/nodes', { parent_id: other.id, kind: 'college', title: 'تسلل' });
    expect(r.statusCode).toBe(403);
    expect((await call(w.t, admin.h, 'PATCH', `/api/channels/nodes/${other.id}`, { title: 'تسلل' })).statusCode).toBe(403);
    // moving a node out of the subtree needs admin rights on the new parent too
    expect((await call(w.t, admin.h, 'PATCH', `/api/channels/nodes/${c.id}`, { parent_id: other.id })).statusCode).toBe(403);
    // a student can see the node but not edit it
    expect((await call(w.t, student.h, 'PATCH', `/api/channels/nodes/${c.id}`, { title: 'x' })).statusCode).toBe(403);
  });
});

describe('archive with an impact preview', () => {
  it('previews, then archives the subtree: codes revoked, spaces read-only, memberships stop granting access', async () => {
    const u = await createNode(w.t, w.pa, null, 'university', 'جامعة الأنبار');
    const c = await createNode(w.t, w.pa, u.id, 'college', 'كلية طب الأنبار', { join_policy: 'open_with_code' });
    const s1 = await createNode(w.t, w.pa, c.id, 'subject', 'الباطنية', { join_policy: 'open_with_code' });
    await createNode(w.t, w.pa, c.id, 'subject', 'الأطفال');
    const code = await createCode(w.t, w.pa, c.id, { requires_approval: false });
    const joiner = await person(w.t, 'archive_joiner');
    const joined = ok<{ membership: { status: string } }>(await call(w.t, joiner.h, 'POST', '/api/channels/join', { code: code.code }));
    expect(joined.membership.status).toBe('approved');
    const access = channelsOf(w.t.ctx).access;
    expect(access.accessToSpace(w.t.ctx.tenancy.viewerOf(joiner.user, null), s1.space_id!)).toMatchObject({ access: 'member' });

    const preview = ok<ChannelArchiveResponse>(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${c.id}/archive`, { preview: true }));
    expect(preview).toEqual({ archived: false, preview: { node: { id: c.id, kind: 'college', title: 'كلية طب الأنبار' }, descendants: 2, memberships: 1, spaces: 2, open_codes: 1 } });
    // nothing changed by the preview
    expect(ok<ChannelNodeView>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${c.id}`)).status).toBe('active');

    const done = ok<ChannelArchiveResponse>(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${c.id}/archive`, { preview: false }));
    expect(done.archived).toBe(true);
    for (const id of [c.id, s1.id]) expect(ok<ChannelNodeView>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${id}`)).status).toBe('archived');
    expect(w.t.ctx.system.vaults.spaceByIdInternal(s1.space_id!)!.status).toBe('read_only');
    expect(access.accessToSpace(w.t.ctx.tenancy.viewerOf(joiner.user, null), s1.space_id!)).toBeNull();
    // the code is revoked: a new account cannot join with it
    const late = await person(w.t, 'archive_late');
    expect((await call(w.t, late.h, 'POST', '/api/channels/join', { code: code.code })).statusCode).toBe(400);
    // an archived node takes no edits, no children and no new codes
    expect((await call(w.t, w.pa, 'PATCH', `/api/channels/nodes/${c.id}`, { title: 'x' })).statusCode).toBe(409);
    expect((await call(w.t, w.pa, 'POST', '/api/channels/nodes', { parent_id: c.id, kind: 'subject', title: 'x' })).statusCode).toBe(409);
    expect((await call(w.t, w.pa, 'POST', `/api/channels/nodes/${c.id}/codes`, { kind: 'class_code', expires_in_hours: 1, requires_approval: true })).statusCode).toBe(409);
    // the scoped audit holds the archive (no private content: title only)
    const audit = w.t.ctx.system.db.all<{ action: string; scope_node_id: string }>(`SELECT action, scope_node_id FROM security_audit WHERE action LIKE 'channel_%' AND scope_node_id = ?`, [c.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['channel_node_create', 'channel_node_archive']));
  });
});
