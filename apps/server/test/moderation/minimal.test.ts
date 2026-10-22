// P1-T4 step 2 — the minimal moderation flow (BUILD_PLAN §3.6 `test/moderation/minimal.test.ts`; PRD AOS-18.7 and 18.8
// Phase 1 parts, Q6; ARCHITECTURE_DELTA §7.12, §13, §5.3 «reports: create / decide»): report (reasons incl.
// `patient_identifiers`, `copyright`) → the queue of that subject → hide with an Arabic reason → author and reporter
// notified → restore → two audit entries; one open report per reporter per target; rate-limited; dismiss; the author
// never learns who reported; a moderator of one subject has no power in another; whoever may not see the content gets
// the 404 of a missing id. The publications are P1-T5's (step 3); a fixture stands in for them through the same seam.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModerationActionView, ReportQueueResponse, ReportView, SecurityAuditResponse } from '@medlevo/shared';
import { assignRole, call, type ChannelWorld, channelWorld, createCode, createNode, ok, person, type Person } from '../channels/helpers';
import { drain, items } from '../notifications/helpers';
import { addPublication, type FixturePublication, installFixturePublications } from './fixture';

let w: ChannelWorld;
let pubs: Map<string, FixturePublication>;
const n = {} as Record<'U1' | 'S' | 'A' | 'B' | 'U2' | 'X', { id: string }>;
let modA: Person;
let assistA: Person;
let modB: Person;
let adminU1: Person;
let author: Person;
let reporter: Person;
let reporter2: Person;
let memberB: Person;
let outsider: Person;
let authorMod: Person;

const target = (id: string) => ({ db: 'system', type: 'publication', id });
const report = (h: Person['h'], id: string, reason = 'patient_identifiers', note?: string) => call(w.t, h, 'POST', '/api/moderation/reports', { target: target(id), reason, ...(note ? { note } : {}) });
const act = (h: Person['h'], body: Record<string, unknown>) => call(w.t, h, 'POST', '/api/moderation/actions', body);
const queue = (h: Person['h'], scope: string, status = '') => call(w.t, h, 'GET', `/api/moderation/queue?scope_node_id=${scope}${status ? `&status=${status}` : ''}`);
const missingBody = async (h: Person['h']) => (await act(h, { report_id: 'NO_SUCH_REPORT', action: 'hide', reason_ar: 'سبب' })).body;

async function join(p: Person, nodeId: string) {
  ok(await call(w.t, p.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, w.pa, nodeId, { requires_approval: false })).code }));
}

beforeAll(async () => {
  w = await channelWorld();
  pubs = installFixturePublications(w.t.ctx);
  n.U1 = await createNode(w.t, w.pa, null, 'university', 'جامعة الإشراف');
  n.S = await createNode(w.t, w.pa, n.U1.id, 'stage', 'المرحلة الثالثة');
  n.A = await createNode(w.t, w.pa, n.S.id, 'subject', 'الباطنية', { join_policy: 'open_with_code' });
  n.B = await createNode(w.t, w.pa, n.S.id, 'subject', 'الجراحة', { join_policy: 'open_with_code' });
  n.U2 = await createNode(w.t, w.pa, null, 'university', 'جامعة أخرى');
  n.X = await createNode(w.t, w.pa, n.U2.id, 'subject', 'مادة س', { join_policy: 'open_with_code' });
  [modA, assistA, modB, adminU1, author, reporter, reporter2, memberB, outsider, authorMod] = await Promise.all(
    ['mod_a', 'assist_a', 'mod_b', 'admin_u1', 'author', 'reporter', 'reporter2', 'member_b', 'outsider', 'author_mod'].map((u) => person(w.t, `m_${u}`)),
  ) as [Person, Person, Person, Person, Person, Person, Person, Person, Person, Person];
  await assignRole(w.t, w.pa, n.A.id, modA.user.id, 'subject_moderator');
  await assignRole(w.t, w.pa, n.A.id, assistA.user.id, 'assistant');
  await assignRole(w.t, w.pa, n.B.id, modB.user.id, 'subject_moderator');
  await assignRole(w.t, w.pa, n.U1.id, adminU1.user.id, 'admin');
  await assignRole(w.t, w.pa, n.A.id, authorMod.user.id, 'assistant');
  for (const p of [author, reporter, reporter2]) await join(p, n.A.id);
  await join(memberB, n.B.id);
  addPublication(pubs, 'PUB1', n.A.id, author.user.id, 'شرح الفشل القلبي');
  addPublication(pubs, 'PUB2', n.A.id, author.user.id, 'شرح الربو');
  addPublication(pubs, 'PUBB', n.B.id, memberB.user.id, 'شرح الزائدة');
  addPublication(pubs, 'PUBMOD', n.A.id, authorMod.user.id, 'شرح المساعد');
}, 120_000);
afterAll(async () => {
  await w?.close();
});

describe('report → queue → hide → notified → restore → audit (the Phase 1 flow)', () => {
  let reportId = '';

  it('a member reports a publication with a reason; it lands in that subject\'s queue only', async () => {
    const r = ok<ReportView>(await report(reporter.h, 'PUB1', 'patient_identifiers', 'تظهر صورة فيها اسم المريض ورقمه'));
    reportId = r.id;
    expect(r).toMatchObject({ target: { db: 'system', type: 'publication', id: 'PUB1', title: 'شرح الفشل القلبي' }, scope: { id: n.A.id, kind: 'subject' }, reason: 'patient_identifiers', status: 'open', resolved_at: null });
    // the reporter is no moderator: the view names nobody
    expect(r.reporter).toBeNull();

    const q = ok<ReportQueueResponse>(await queue(modA.h, n.A.id));
    expect(q.items.map((x) => x.id)).toEqual([reportId]);
    expect(q.items[0]!.reporter).toMatchObject({ id: reporter.user.id });
    expect(q.items[0]!.note).toBe('تظهر صورة فيها اسم المريض ورقمه');
    // an Admin above sees it in the queue of the university (subtree), and of the subject
    expect(ok<ReportQueueResponse>(await queue(adminU1.h, n.U1.id)).items.map((x) => x.id)).toContain(reportId);
    // the moderator of B, the reporter, the author, an outsider: exactly the body of a missing route
    const missingRoute = (await call(w.t, outsider.h, 'GET', '/api/moderation/no-such-route')).body;
    for (const p of [modB, reporter, author, outsider]) {
      const res = await queue(p.h, n.A.id);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(missingRoute);
    }
    expect((await queue(outsider.h, 'NO_SUCH_NODE')).body).toBe(missingRoute);
    expect(ok<ReportQueueResponse>(await queue(modB.h, n.B.id)).items).toEqual([]);
  });

  it('the subject\'s moderators and assistants are told (no reporter named); the author and the reporter are not', async () => {
    for (const p of [modA, assistA, adminU1]) {
      const got = await items(w.t, p.h, 'report_received');
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ actor: null, payload: { subject_title: 'الباطنية', target_title: 'شرح الفشل القلبي', reason: 'patient_identifiers', open_reports: 1 } });
      expect(JSON.stringify(got[0])).not.toContain(reporter.user.id);
    }
    for (const p of [author, reporter, modB, memberB]) expect(await items(w.t, p.h, 'report_received')).toEqual([]);
  });

  it('an Assistant hides it with an Arabic reason: the author and the reporter are notified, nobody names the reporter to the author', async () => {
    const a = ok<ModerationActionView>(await act(assistA.h, { report_id: reportId, action: 'hide', reason_ar: 'يحتوي معرّفات مريض؛ احذف الصورة ثم أعد النشر.' }));
    expect(a).toMatchObject({ action: 'hide', report_id: reportId, target: { db: 'system', type: 'publication', id: 'PUB1' }, moderator: { id: assistA.user.id }, role: 'assistant' });
    expect(pubs.get('PUB1')!.state).toBe('hidden');
    // the report is closed as actioned
    const q = ok<ReportQueueResponse>(await queue(modA.h, n.A.id, 'actioned'));
    expect(q.items.find((x) => x.id === reportId)).toMatchObject({ status: 'actioned' });
    expect(ok<ReportQueueResponse>(await queue(modA.h, n.A.id, 'open')).items.find((x) => x.id === reportId)).toBeUndefined();

    const toAuthor = await items(w.t, author.h, 'moderation');
    expect(toAuthor).toHaveLength(1);
    expect(toAuthor[0]).toMatchObject({ actor: null, payload: { target_title: 'شرح الفشل القلبي', action: 'hide', as: 'author', reason_ar: 'يحتوي معرّفات مريض؛ احذف الصورة ثم أعد النشر.' } });
    const authorInbox = JSON.stringify(await items(w.t, author.h));
    expect(authorInbox).not.toContain(reporter.user.id);
    expect(authorInbox).not.toContain('m_reporter');
    const toReporter = await items(w.t, reporter.h, 'moderation');
    expect(toReporter).toHaveLength(1);
    expect(toReporter[0]).toMatchObject({ actor: null, payload: { action: 'hide', as: 'reporter' } });
  });

  it('hidden content cannot be reported again by members (it is gone for them) and cannot be hidden twice', async () => {
    expect((await report(reporter2.h, 'PUB1')).statusCode).toBe(404);
    const twice = await act(modA.h, { target: target('PUB1'), action: 'hide', reason_ar: 'مرة ثانية' });
    expect(twice.statusCode).toBe(409);
  });

  it('a Subject Moderator restores it with a reason; the author is told; two audit entries name the roles', async () => {
    const a = ok<ModerationActionView>(await act(modA.h, { target: target('PUB1'), action: 'restore', reason_ar: 'حُذفت الصورة؛ أُعيد الشرح.' }));
    expect(a).toMatchObject({ action: 'restore', report_id: null, role: 'subject_moderator' });
    expect(pubs.get('PUB1')!.state).toBe('visible');
    expect(pubs.get('PUB1')!.history.map((h) => h.state)).toEqual(['hidden', 'visible']);
    expect((await items(w.t, author.h, 'moderation')).map((x) => (x.payload as { action: string }).action)).toEqual(['restore', 'hide']);
    // restoring something that is visible is refused
    expect((await act(modA.h, { target: target('PUB1'), action: 'restore', reason_ar: 'مرة ثانية' })).statusCode).toBe(409);

    const audit = ok<SecurityAuditResponse>(await call(w.t, adminU1.h, 'GET', `/api/admin/audit?scope_node_id=${n.A.id}&action=moderation_hide`));
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ action: 'moderation_hide', scope: { id: n.A.id }, actor: { id: assistA.user.id }, target: { db: 'system', type: 'publication', id: 'PUB1' } });
    expect(audit.items[0]!.actor_role).toBe(`assistant@${n.A.id}`);
    const both = ok<SecurityAuditResponse>(await call(w.t, adminU1.h, 'GET', `/api/admin/audit?scope_node_id=${n.A.id}`));
    expect(both.items.filter((x) => x.action.startsWith('moderation_')).map((x) => x.action)).toEqual(['moderation_restore', 'moderation_hide']);
    // the reporter's note and identity are not in the moderation entries (the reporter's own join is audited elsewhere)
    const moderationEntries = JSON.stringify(both.items.filter((x) => x.action.startsWith('moderation_')));
    expect(JSON.stringify(both)).not.toContain('اسم المريض');
    expect(moderationEntries).not.toContain(reporter.user.id);
    expect(w.t.ctx.system.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM moderation_action WHERE target_id = 'PUB1'`)!.n).toBe(2);
  });
});

describe('reports', () => {
  it('one OPEN report per reporter per target; another reporter may report too; after a decision one may report again', async () => {
    const first = ok<ReportView>(await report(reporter.h, 'PUB2', 'copyright'));
    const again = await report(reporter.h, 'PUB2', 'wrong_content');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details.report_id).toBe(first.id);
    const second = ok<ReportView>(await report(reporter2.h, 'PUB2', 'wrong_content'));
    expect(second.id).not.toBe(first.id);

    // dismiss the first report: its reporter is told, the author is NOT (a dismissed report says nothing about them)
    const authorBefore = (await items(w.t, author.h, 'moderation')).length;
    ok<ModerationActionView>(await act(modA.h, { report_id: first.id, action: 'dismiss', reason_ar: 'لا يوجد انتهاك لحقوق النشر.' }));
    expect((await items(w.t, reporter.h, 'moderation'))[0]).toMatchObject({ payload: { action: 'dismiss', as: 'reporter', target_title: 'شرح الربو' } });
    expect((await items(w.t, author.h, 'moderation')).length).toBe(authorBefore);
    expect(pubs.get('PUB2')!.state).toBe('visible');
    // the other reporter's report is still open
    expect(ok<ReportQueueResponse>(await queue(modA.h, n.A.id, 'open')).items.map((x) => x.id)).toEqual([second.id]);
    // dismissing a closed report is refused
    expect((await act(modA.h, { report_id: first.id, action: 'dismiss', reason_ar: 'مرة ثانية' })).statusCode).toBe(409);
    // the first reporter may report again now
    ok<ReportView>(await report(reporter.h, 'PUB2', 'other'));
  });

  it('reasons are the Phase 1 list (incl. patient identifiers and copyright); notes are plain text; only publications in Phase 1', async () => {
    expect((await report(reporter2.h, 'PUB2', 'not_a_reason')).statusCode).toBe(400);
    expect((await report(reporter2.h, 'PUBB', 'spam', 'ملاحظة ‮مقلوبة')).statusCode).toBe(400);
    const discussion = await call(w.t, reporter.h, 'POST', '/api/moderation/reports', { target: { db: 'system', type: 'discussion_post', id: 'X1' }, reason: 'spam' });
    expect(discussion.statusCode).toBe(400);
    // a publication is named by its system index row only (one spelling per target)
    const wrongDb = await call(w.t, reporter.h, 'POST', '/api/moderation/reports', { target: { db: 'SPACEID', type: 'publication', id: 'PUB2' }, reason: 'spam' });
    expect(wrongDb.statusCode).toBe(400);
  });

  it('a non-member, a member of another subject and a missing publication all get the same 404', async () => {
    const missing = await report(outsider.h, 'NO_SUCH_PUBLICATION');
    expect(missing.statusCode).toBe(404);
    for (const p of [outsider, memberB]) {
      const res = await report(p.h, 'PUB2');
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(missing.body);
    }
    // publication_version has no handler yet (P1-T5 step 3): unknown, so 404 too
    const version = await call(w.t, reporter.h, 'POST', '/api/moderation/reports', { target: { db: 'SPACE0001', type: 'publication_version', id: 'V1' }, reason: 'spam' });
    expect(version.statusCode).toBe(404);
  });

  it('nobody reports their own content', async () => {
    const own = await report(author.h, 'PUB2');
    expect(own.statusCode).toBe(409);
  });

  it('reports are rate-limited per account (20 an hour)', async () => {
    const flood = await person(w.t, 'm_flood');
    await join(flood, n.A.id);
    for (let i = 0; i < 21; i++) addPublication(pubs, `FLOOD${i}`, n.A.id, author.user.id);
    for (let i = 0; i < 20; i++) ok(await report(flood.h, `FLOOD${i}`, 'spam'));
    const over = await report(flood.h, 'FLOOD20', 'spam');
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
    // other accounts are not affected
    ok(await report(reporter2.h, 'FLOOD20', 'spam'));
    w.t.clock.advance(61 * 60_000);
    ok(await report(flood.h, 'FLOOD20', 'spam'));
  });
});

describe('who may decide', () => {
  it('a member who can see the content gets 403; anyone who cannot see it, or a report id, gets the 404 of a missing id', async () => {
    await join(reporter2, n.B.id);
    const r = ok<ReportView>(await report(reporter2.h, 'PUBB', 'spam'));
    const asMember = await act(reporter.h, { target: target('PUB2'), action: 'hide', reason_ar: 'سبب' });
    expect(asMember.statusCode).toBe(403);
    // the moderator of A meets B's content as a non-member: 404, by report id or by target
    const missing = await missingBody(modA.h);
    const byId = await act(modA.h, { report_id: r.id, action: 'dismiss', reason_ar: 'سبب' });
    expect(byId.statusCode).toBe(404);
    expect(byId.body).toBe(missing);
    expect((await act(modA.h, { target: target('PUBB'), action: 'hide', reason_ar: 'سبب' })).statusCode).toBe(404);
    // a report id is never a handle for its reporter either
    expect((await act(reporter2.h, { report_id: r.id, action: 'dismiss', reason_ar: 'سبب' })).statusCode).toBe(404);
    // the moderator of B decides it
    ok(await act(modB.h, { report_id: r.id, action: 'dismiss', reason_ar: 'ليس إعلانًا.' }));
    // the platform admin moderates every subject
    ok(await act(w.pa, { target: target('PUBB'), action: 'hide', reason_ar: 'فحص من مسؤول المنصة' }));
    ok(await act(w.pa, { target: target('PUBB'), action: 'restore', reason_ar: 'انتهى الفحص' }));
  });

  it('a moderator never decides about their own content, and never sees who reported it', async () => {
    const r = ok<ReportView>(await report(reporter.h, 'PUBMOD', 'harassment'));
    const own = await act(authorMod.h, { report_id: r.id, action: 'dismiss', reason_ar: 'لا شيء' });
    expect(own.statusCode).toBe(403);
    expect((await act(authorMod.h, { target: target('PUBMOD'), action: 'hide', reason_ar: 'أخفيه' })).statusCode).toBe(403);
    const q = ok<ReportQueueResponse>(await queue(authorMod.h, n.A.id, 'open'));
    const mine = q.items.find((x) => x.id === r.id)!;
    expect(mine.reporter).toBeNull();
    // and the report notice skips the author
    expect((await items(w.t, authorMod.h, 'report_received')).some((x) => (x.payload as { target_title: string }).target_title === 'شرح المساعد')).toBe(false);
    // another moderator decides
    ok(await act(modA.h, { report_id: r.id, action: 'dismiss', reason_ar: 'لا إساءة.' }));
  });

  it('a reporter who has left the subject is not told the outcome (the author still is)', async () => {
    const leaver = await person(w.t, 'm_leaver');
    await join(leaver, n.A.id);
    addPublication(pubs, 'PUBLEAVE', n.A.id, author.user.id, 'شرح يغادر مُبلّغه');
    const r = ok<ReportView>(await report(leaver.h, 'PUBLEAVE', 'wrong_content'));
    ok(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${n.A.id}/members/${leaver.user.id}/decision`, { decision: 'remove' }));
    ok(await act(modA.h, { report_id: r.id, action: 'hide', reason_ar: 'معلومة خاطئة عن الجرعة.' }));
    drain(w.t);
    expect(w.t.ctx.system.db.all(`SELECT 1 FROM notification WHERE user_id = ? AND kind = 'moderation'`, [leaver.user.id])).toEqual([]);
    expect((await items(w.t, author.h, 'moderation')).some((x) => (x.payload as { target_title: string }).target_title === 'شرح يغادر مُبلّغه')).toBe(true);
  });

  it('the body needs a report or a target and an Arabic reason; Phase 2 actions are refused', async () => {
    expect((await act(modA.h, { action: 'hide', reason_ar: 'سبب' })).statusCode).toBe(400);
    expect((await act(modA.h, { target: target('PUB2'), action: 'hide' })).statusCode).toBe(400);
    expect((await act(modA.h, { target: target('PUB2'), action: 'mark_reviewed', reason_ar: 'سبب' })).statusCode).toBe(400);
    expect((await act(modA.h, { target: target('PUB2'), action: 'suspend_user', reason_ar: 'سبب' })).statusCode).toBe(400);
    const r = ok<ReportView>(await report(reporter2.h, 'FLOOD1', 'spam'));
    // a report and a different target in one body
    expect((await act(modA.h, { report_id: r.id, target: target('PUB2'), action: 'dismiss', reason_ar: 'سبب' })).statusCode).toBe(400);
  });
});
