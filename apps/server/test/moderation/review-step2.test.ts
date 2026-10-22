// Adversarial review of P1-T4 step 2 (BUILD_PLAN §1.2) — each test reproduced a defect before its fix:
//   R1  a report on content written by the ONLY moderator of the chain, or a join request whose only approver is an
//       account on its way out, reached nobody: the platform-admin fallback looked only at whether a role row existed,
//       not at whether anyone eligible was left once the author was excluded and inactive (suspended) accounts skipped
//   R2  a moderator who wrote the reported content read the reporter's own words (the note) in the queue
//   R3  a report kept the scope of the moment it was filed: once the content belonged to another subject, the moderators
//       of the old subject still decided about it through the report id
//   R4  a reported item whose owner gives a link outside the in-app pattern made every moderation decision on it fail
//       (500) — a notice must never stop a moderator from hiding content
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReportQueueResponse, ReportView } from '@medlevo/shared';
import { assignRole, call, type ChannelWorld, channelWorld, createCode, createNode, ok, person, type Person } from '../channels/helpers';
import { drain, items } from '../notifications/helpers';
import { addPublication, type FixturePublication, installFixturePublications } from './fixture';

let w: ChannelWorld;
let pubs: Map<string, FixturePublication>;
let paId = '';

const target = (id: string) => ({ db: 'system', type: 'publication', id });
const report = (h: Person['h'], id: string, reason = 'wrong_content', note?: string) => call(w.t, h, 'POST', '/api/moderation/reports', { target: target(id), reason, ...(note ? { note } : {}) });
const act = (h: Person['h'], body: Record<string, unknown>) => call(w.t, h, 'POST', '/api/moderation/actions', body);

async function join(p: Person, nodeId: string, requiresApproval = false) {
  ok(await call(w.t, p.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, w.pa, nodeId, { requires_approval: requiresApproval })).code }));
}

const paRows = (kind: string) => w.t.ctx.system.db.all<{ payload_json: string }>('SELECT payload_json FROM notification WHERE user_id = ? AND kind = ?', [paId, kind]);

beforeAll(async () => {
  w = await channelWorld();
  pubs = installFixturePublications(w.t.ctx);
  paId = w.t.ctx.system.db.get<{ id: string }>(`SELECT id FROM user_account WHERE username = 'owner'`)!.id;
}, 120_000);
afterAll(async () => {
  await w?.close();
});

describe('R1 — someone eligible always hears about a report or a join request', () => {
  it('a report on content written by the only moderator of the chain reaches the platform admin', async () => {
    const uni = await createNode(w.t, w.pa, null, 'university', 'جامعة المشرف الوحيد');
    const subject = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة مشرفها كاتب', { join_policy: 'open_with_code' });
    const soleMod = await person(w.t, 'r1_sole_mod');
    const reporter = await person(w.t, 'r1_reporter');
    await assignRole(w.t, w.pa, subject.id, soleMod.user.id, 'assistant');
    await join(reporter, subject.id);
    addPublication(pubs, 'R1PUB', subject.id, soleMod.user.id, 'شرح المساعد الوحيد');
    ok<ReportView>(await report(reporter.h, 'R1PUB'));
    drain(w.t);
    // the author is never told about a report on their own content …
    expect(await items(w.t, soleMod.h, 'report_received')).toEqual([]);
    // … so the platform admin must be (the only one left who may decide)
    expect(paRows('report_received').map((r) => JSON.parse(r.payload_json).target_title)).toContain('شرح المساعد الوحيد');
    // and can decide it
    ok(await act(w.pa, { target: target('R1PUB'), action: 'dismiss', reason_ar: 'لا مخالفة بعد المراجعة.' }));
  });

  it('a join request whose only approver holds the role on a suspended account reaches the platform admin', async () => {
    const uni = await createNode(w.t, w.pa, null, 'university', 'جامعة المدير الموقوف');
    const subject = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة مديرها موقوف', { join_policy: 'approval' });
    const suspended = await person(w.t, 'r1_suspended_admin');
    await assignRole(w.t, w.pa, uni.id, suspended.user.id, 'admin');
    // a suspended account keeps its role rows (nothing revokes them) but is never told anything (the fan-out skips it)
    w.t.ctx.system.db.run(`UPDATE user_account SET status = 'suspended' WHERE id = ?`, [suspended.user.id]);
    const student = await person(w.t, 'r1_student');
    await join(student, subject.id, true);
    drain(w.t);
    expect(w.t.ctx.system.db.all('SELECT 1 FROM notification WHERE user_id = ?', [suspended.user.id])).toEqual([]);
    expect(paRows('join_requested').map((r) => JSON.parse(r.payload_json).node_title)).toContain('مادة مديرها موقوف');
  });

  it('the fallback stays a fallback: with an eligible moderator in the chain the platform admin is not paged', async () => {
    const uni = await createNode(w.t, w.pa, null, 'university', 'جامعة فيها مشرف آخر');
    const subject = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة فيها مشرفان', { join_policy: 'open_with_code' });
    const authorMod = await person(w.t, 'r1_author_mod');
    const otherMod = await person(w.t, 'r1_other_mod');
    const reporter = await person(w.t, 'r1_reporter2');
    await assignRole(w.t, w.pa, subject.id, authorMod.user.id, 'assistant');
    await assignRole(w.t, w.pa, subject.id, otherMod.user.id, 'subject_moderator');
    await join(reporter, subject.id);
    addPublication(pubs, 'R1PUB2', subject.id, authorMod.user.id, 'شرح له مشرف آخر');
    ok<ReportView>(await report(reporter.h, 'R1PUB2'));
    drain(w.t);
    expect((await items(w.t, otherMod.h, 'report_received')).length).toBe(1);
    expect(paRows('report_received').map((r) => JSON.parse(r.payload_json).target_title)).not.toContain('شرح له مشرف آخر');
  });
});

describe('R2 — the author never reads the reporter\'s words', () => {
  it('a moderator who wrote the reported content sees neither the reporter nor the note in the queue', async () => {
    const uni = await createNode(w.t, w.pa, null, 'university', 'جامعة الملاحظة');
    const subject = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة الملاحظة', { join_policy: 'open_with_code' });
    const authorMod = await person(w.t, 'r2_author_mod');
    const otherMod = await person(w.t, 'r2_other_mod');
    const reporter = await person(w.t, 'r2_reporter');
    await assignRole(w.t, w.pa, subject.id, authorMod.user.id, 'assistant');
    await assignRole(w.t, w.pa, subject.id, otherMod.user.id, 'assistant');
    await join(reporter, subject.id);
    addPublication(pubs, 'R2PUB', subject.id, authorMod.user.id, 'شرح يُبلَّغ عنه');
    const r = ok<ReportView>(await report(reporter.h, 'R2PUB', 'harassment', 'أنا زميله في المجموعة ب وقد كتب عني هذا'));
    const mine = ok<ReportQueueResponse>(await call(w.t, authorMod.h, 'GET', `/api/moderation/queue?scope_node_id=${subject.id}`)).items.find((x) => x.id === r.id)!;
    expect(mine.reporter).toBeNull();
    expect(mine.note).toBeNull();
    expect(JSON.stringify(mine)).not.toContain('المجموعة ب');
    // another moderator still reads both
    const theirs = ok<ReportQueueResponse>(await call(w.t, otherMod.h, 'GET', `/api/moderation/queue?scope_node_id=${subject.id}`)).items.find((x) => x.id === r.id)!;
    expect(theirs.reporter).toMatchObject({ id: reporter.user.id });
    expect(theirs.note).toContain('المجموعة ب');
  });
});

describe('R3 — the content\'s subject decides who moderates it, not the subject it had when it was reported', () => {
  it('after the content belongs to another subject, the old subject\'s moderator cannot decide through the report id', async () => {
    const uni = await createNode(w.t, w.pa, null, 'university', 'جامعة النقل');
    const a = await createNode(w.t, w.pa, uni.id, 'subject', 'المادة الأولى', { join_policy: 'open_with_code' });
    const b = await createNode(w.t, w.pa, uni.id, 'subject', 'المادة الثانية', { join_policy: 'open_with_code' });
    const modA = await person(w.t, 'r3_mod_a');
    const modB = await person(w.t, 'r3_mod_b');
    const author = await person(w.t, 'r3_author');
    const reporter = await person(w.t, 'r3_reporter');
    await assignRole(w.t, w.pa, a.id, modA.user.id, 'subject_moderator');
    await assignRole(w.t, w.pa, b.id, modB.user.id, 'subject_moderator');
    await join(reporter, a.id);
    const pub = addPublication(pubs, 'R3PUB', a.id, author.user.id, 'شرح ينتقل');
    const r = ok<ReportView>(await report(reporter.h, 'R3PUB'));
    // the owner track now files the content under subject B (what its resolve() answers)
    pub.subjectNodeId = b.id;
    const byOld = await act(modA.h, { report_id: r.id, action: 'hide', reason_ar: 'إخفاء من مشرف المادة القديمة' });
    expect(byOld.statusCode).toBe(404);
    expect(pub.state).toBe('visible');
    // the moderator of the content's subject decides it
    ok(await act(modB.h, { report_id: r.id, action: 'hide', reason_ar: 'إخفاء من مشرف المادة الحالية' }));
    expect(pub.state).toBe('hidden');
  });
});

describe('R4 — a notice never blocks a moderation decision', () => {
  it('content whose owner gives a link outside the in-app pattern is still hidden; the author\'s notice simply has no link', async () => {
    const uni = await createNode(w.t, w.pa, null, 'university', 'جامعة الرابط');
    const subject = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة الرابط', { join_policy: 'open_with_code' });
    const mod = await person(w.t, 'r4_mod');
    const author = await person(w.t, 'r4_author');
    await assignRole(w.t, w.pa, subject.id, mod.user.id, 'subject_moderator');
    await join(author, subject.id);
    const pub = addPublication(pubs, 'R4PUB', subject.id, author.user.id, 'شرح برابط غريب');
    // the fixture builds `/p/<id>`; an owner track could answer a link with a fragment or a full URL
    const handler = (await import('../../src/modules/moderation/targets')).moderationTargetsOf(w.t.ctx).handler('publication')!;
    const resolve = handler.resolve.bind(handler);
    handler.resolve = (t) => {
      const info = resolve(t);
      return info && t.id === 'R4PUB' ? { ...info, link: 'https://evil.example/p#R4PUB' } : info;
    };
    try {
      ok(await act(mod.h, { target: target('R4PUB'), action: 'hide', reason_ar: 'معلومة خاطئة.' }));
      expect(pub.state).toBe('hidden');
      const notice = (await items(w.t, author.h, 'moderation')).find((x) => (x.payload as { target_title: string }).target_title === 'شرح برابط غريب')!;
      expect(notice).toBeTruthy();
      expect(notice.link).toBeNull();
    } finally {
      handler.resolve = resolve;
    }
  });
});

describe('R5 — the author never learns who reported, even after the content is gone', () => {
  it('a moderator whose reported content no longer resolves (deleted by them) still sees neither reporter nor note', async () => {
    const uni = await createNode(w.t, w.pa, null, 'university', 'جامعة المحذوف');
    const subject = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة المحذوف', { join_policy: 'open_with_code' });
    const authorMod = await person(w.t, 'r5_author_mod');
    const reporter = await person(w.t, 'r5_reporter');
    await assignRole(w.t, w.pa, subject.id, authorMod.user.id, 'assistant');
    await join(reporter, subject.id);
    addPublication(pubs, 'R5PUB', subject.id, authorMod.user.id, 'شرح سيُحذف');
    const r = ok<ReportView>(await report(reporter.h, 'R5PUB', 'privacy', 'أنا صاحب الصورة في الشرح'));
    // the author removes the publication: the owner track no longer resolves it
    pubs.delete('R5PUB');
    const mine = ok<ReportQueueResponse>(await call(w.t, authorMod.h, 'GET', `/api/moderation/queue?scope_node_id=${subject.id}`)).items.find((x) => x.id === r.id)!;
    expect(mine.target.title).toBeNull();
    expect(mine.reporter).toBeNull();
    expect(mine.note).toBeNull();
    expect(JSON.stringify(mine)).not.toContain(reporter.user.id);
  });
});
