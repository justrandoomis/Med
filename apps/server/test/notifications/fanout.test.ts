// P1-T4 step 2 — the fan-out (ARCHITECTURE_DELTA §12: «a job that writes notification rows in the system DB in batches of
// 500, with dedupe_key»; BUILD_PLAN §3.6 `test/notifications/*`: dedupe keys, batches of 500, payloads hold titles and
// counts only). Publishing writes ONE queue row and returns — the request never walks the audience; the worker writes
// at most 500 rows per step and yields between steps; a failed step is retried later and never duplicates; recipients
// with the kind switched off, deleted accounts and people who may not open the subject are skipped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOTIFICATION_BATCH_SIZE } from '@medlevo/shared';
import { notificationsOf } from '../../src/modules/notifications/service';
import { createTestApp, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';
import { call, createNode, ok } from '../channels/helpers';
import { drain } from './helpers';

let t: TestApp;
let pa: Awaited<ReturnType<TestApp['login']>>;
let subject: { id: string; space_id: string | null };

const FOLLOWERS = 1203;

beforeAll(async () => {
  t = await createTestApp();
  pa = await t.login();
  const uni = await createNode(t, pa, null, 'university', 'جامعة الإرسال');
  subject = await createNode(t, pa, uni.id, 'subject', 'التشريح', { join_policy: 'approval' });
  // 1,203 approved members who follow the subject, written straight into the system DB (creating 1,203 vaults through
  // the account service would take minutes and test nothing of the fan-out)
  const db = t.ctx.system.db;
  const now = t.clock.now();
  db.tx(() => {
    for (let i = 0; i < FOLLOWERS; i++) {
      const id = `FANUSER${String(i).padStart(5, '0')}`;
      db.run(
        `INSERT INTO user_account (id, username, username_norm, display_name, password_hash, password_changed_at, is_platform_admin, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'x', ?, 0, 'active', ?, ?)`,
        [id, `fan_${i}`, `fan_${i}`, `طالب ${i}`, now, now, now],
      );
      db.run(
        `INSERT INTO channel_membership (id, node_id, user_id, status, join_method, created_at, updated_at) VALUES (?, ?, ?, 'approved', 'added_by_admin', ?, ?)`,
        [`FANMEM${i}`, subject.id, id, now, now],
      );
      db.run('INSERT INTO course_follow (user_id, subject_node_id, add_new_lectures, created_at) VALUES (?, ?, 1, ?)', [id, subject.id, now]);
    }
  });
}, 300_000);
afterAll(async () => {
  await t?.close();
});

const rows = (dedupe: string) => t.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notification WHERE dedupe_key = ?', [dedupe])!.n;
const fanoutOf = (dedupe: string) =>
  t.ctx.system.db.get<{ status: string; batches: number; delivered: number; attempts: number }>('SELECT status, batches, delivered, attempts FROM notification_fanout WHERE dedupe_key = ?', [dedupe])!;

function publishLecture(n: number) {
  return notificationsOf(t.ctx).publish({
    content: { kind: 'official_lecture_new', payload: { subject_title: 'التشريح', lecture_title: `المحاضرة ${n}`, lecture_no: n } },
    target: { db: 'space', space_id: subject.space_id!, type: 'official_lecture', id: `L${n}` },
    scopeNodeId: subject.id,
    access: 'member',
    dedupeKey: `official_lecture_new:L${n}`,
    audience: { kind: 'course_followers', subject_node_id: subject.id },
  });
}

describe('batched fan-out', () => {
  it('publishing writes one queue row and no notification; the worker writes batches of 500 and yields between them', () => {
    expect(NOTIFICATION_BATCH_SIZE).toBe(500);
    const res = publishLecture(1);
    expect(res.created).toBe(true);
    // nothing was written for the recipients by the publishing call itself
    expect(rows('official_lecture_new:L1')).toBe(0);
    const svc = notificationsOf(t.ctx);
    // one step = one batch — and a step is short (it runs between requests on the event loop; measured ≈ 40 ms for
    // 500 recipients here, the bound below is generous for a loaded CI machine)
    const t0 = performance.now();
    expect(svc.fanout.step()).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(rows('official_lecture_new:L1')).toBe(500);
    expect(fanoutOf('official_lecture_new:L1')).toMatchObject({ status: 'pending', batches: 1 });
    drain(t);
    expect(rows('official_lecture_new:L1')).toBe(FOLLOWERS);
    expect(fanoutOf('official_lecture_new:L1')).toMatchObject({ status: 'done', batches: 3, delivered: FOLLOWERS });
  });

  it('the same event twice (a retried request) is one fan-out and one row per recipient', () => {
    expect(publishLecture(1).created).toBe(false);
    drain(t);
    expect(rows('official_lecture_new:L1')).toBe(FOLLOWERS);
  });

  it('a step that fails is retried later from where it stopped, without duplicates', () => {
    const svc = notificationsOf(t.ctx);
    let calls = 0;
    svc.registerAudience('test.flaky', (params, after, limit) => {
      calls++;
      if (calls === 2) throw new Error('disk hiccup');
      return t.ctx.system.db
        .all<{ user_id: string }>('SELECT user_id FROM course_follow WHERE subject_node_id = ? AND ended_at IS NULL AND user_id > ? ORDER BY user_id LIMIT ?', [params.subject!, after ?? '', limit])
        .map((r) => r.user_id);
    });
    svc.publish({
      content: { kind: 'subject_update', payload: { subject_title: 'التشريح', event_kind: 'attachment_published', title: 'جدول المحاضرات' } },
      scopeNodeId: subject.id,
      access: 'member',
      dedupeKey: 'subject_update:flaky',
      audience: { kind: 'registered', name: 'test.flaky', params: { subject: subject.id } },
    });
    drain(t);
    // the first batch landed, the second failed and waits
    expect(rows('subject_update:flaky')).toBe(500);
    expect(fanoutOf('subject_update:flaky')).toMatchObject({ status: 'pending', attempts: 1 });
    // not due yet: nothing happens
    drain(t);
    expect(rows('subject_update:flaky')).toBe(500);
    t.clock.advance(10 * 60_000);
    drain(t);
    expect(rows('subject_update:flaky')).toBe(FOLLOWERS);
    expect(fanoutOf('subject_update:flaky').status).toBe('done');
  });

  it('a fan-out whose recipients\' rows already exist (a crash after the insert, before the cursor moved) adds nothing', () => {
    const db = t.ctx.system.db;
    // put the finished fan-out back to the start, as if the worker died before recording its progress
    db.run(`UPDATE notification_fanout SET status = 'pending', cursor = NULL, run_after = 0 WHERE dedupe_key = 'official_lecture_new:L1'`);
    drain(t);
    expect(rows('official_lecture_new:L1')).toBe(FOLLOWERS);
  });

  it('skips the kind switched off, deleted accounts and members who left; an unknown audience fails visibly', () => {
    const db = t.ctx.system.db;
    db.run(`INSERT INTO notification_pref (user_id, kind, channel, enabled) VALUES ('FANUSER00000', 'official_lecture_new', 'in_app', 0)`);
    db.run(`UPDATE user_account SET status = 'deleted' WHERE id = 'FANUSER00001'`);
    db.run(`UPDATE channel_membership SET status = 'left' WHERE user_id = 'FANUSER00002'`);
    publishLecture(2);
    drain(t);
    expect(rows('official_lecture_new:L2')).toBe(FOLLOWERS - 3);
    const got = new Set(db.all<{ user_id: string }>(`SELECT user_id FROM notification WHERE dedupe_key = 'official_lecture_new:L2'`).map((r) => r.user_id));
    for (const id of ['FANUSER00000', 'FANUSER00001', 'FANUSER00002']) expect(got.has(id)).toBe(false);

    // an audience nobody registered is refused when publishing (nothing queued)
    const svc = notificationsOf(t.ctx);
    const event = (name: string, key: string) =>
      svc.publish({
        content: { kind: 'subject_update', payload: { subject_title: 'التشريح', event_kind: 'exam_date_changed', title: 'الامتحان النهائي' } },
        scopeNodeId: subject.id,
        dedupeKey: key,
        audience: { kind: 'registered', name, params: {} },
      });
    expect(() => event('no.such.audience', 'subject_update:unknown-audience')).toThrow(/not registered/);
    expect(t.ctx.system.db.get(`SELECT 1 AS x FROM notification_fanout WHERE dedupe_key = 'subject_update:unknown-audience'`)).toBeUndefined();
    // an audience that keeps failing is retried with back-off and then marked failed (never silently dropped)
    svc.registerAudience('test.broken', () => {
      throw new Error('broken audience');
    });
    event('test.broken', 'subject_update:broken');
    for (let i = 0; i < 8; i++) {
      drain(t);
      t.clock.advance(24 * 60 * 60_000);
    }
    expect(fanoutOf('subject_update:broken')).toMatchObject({ status: 'failed', attempts: 6 });
  });

  it('the request that causes a notification answers before the fan-out (one queue row in the request)', async () => {
    // a join request: one fan-out row is queued for the approvers, the response does not wait for it
    const before = t.ctx.system.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notification_fanout WHERE kind = 'join_requested'`)!.n;
    const u = await addUser(t, 'fan_requester');
    const h = await u.login();
    const code = ok<{ code: string }>(await call(t, pa, 'POST', `/api/channels/nodes/${subject.id}/codes`, { kind: 'class_code', expires_in_hours: 1, requires_approval: true })).code;
    ok(await call(t, h, 'POST', '/api/channels/join', { code }));
    expect(t.ctx.system.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notification_fanout WHERE kind = 'join_requested'`)!.n).toBe(before + 1);
    drain(t);
    // no approver role in this tree: the platform admin hears about it (someone must)
    const paRows = t.ctx.system.db.all<{ kind: string }>(`SELECT kind FROM notification WHERE user_id = (SELECT id FROM user_account WHERE username = 'owner')`);
    expect(paRows.map((r) => r.kind)).toContain('join_requested');
  });
});
