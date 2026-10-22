// P1-T5 step 3 — a publication behind P1-T4's minimal moderation, the author's withdrawal and account deletion
// (PRD Scenario 2 variant (e), AOS-18.7, 18.8 Phase 1 parts, 21.44, Q6, Q14; ARCHITECTURE_DELTA §6.4 «Withdraw», §13):
//   * a member reports it (`wrong_content`) → an Assistant hides it with a reason → it leaves «الشروحات»; followers keep
//     what they had and read «أخفى المشرف هذا الشرح: السبب»; the author and the reporter are told; two audit entries;
//     the restore brings it back; there is no «راجعه مشرف المادة» action in Phase 1 (refused);
//   * the author withdraws: forks keep attributed content, followed copies stop at their last version and say why, no
//     new copy can be taken; the publication page is gone for everybody else;
//   * the author deletes the account (Q14): «طالب سابق» everywhere at once, the explanation leaves every listing, forks
//     are not erased, followed copies freeze;
//   * nothing of a follower's personal layer reaches the author through the publication routes or the notifications.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentCopyView, LecturePublicationsResponse, PublicationView, ReportView, StartStudyingResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { finishPendingDeletions } from '../../src/modules/accounts/deletion';
import { call, ok } from '../channels/helpers';
import { createLayer, createPubWorld, layerRows, publish, settle, startPersonal, strokes, typedNote, type PubWorld, type Who } from './pubWorld';

let w: PubWorld;
let pub: PublicationView;
let layer: string;
const copies: Partial<Record<Who, DocumentCopyView>> = {};

async function start(who: Who, mode: 'followed' | 'independent_fork', publicationId = pub.id): Promise<StartStudyingResponse> {
  return ok<StartStudyingResponse>(await call(w.t, w.p[who].h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode, publication_id: publicationId }));
}
const list = async (who: Who) => ok<LecturePublicationsResponse>(await call(w.t, w.p[who].h, 'GET', w.S(`/lectures/${w.lecture.id}/publications`))).items.map((c) => c.id);
const copyOf = async (who: Who) => ok<DocumentCopyView>(await call(w.t, w.p[who].h, 'GET', `/api/copies/${copies[who]!.id}`));

beforeAll(async () => {
  w = await createPubWorld(4);
  await startPersonal(w, 'hasan');
  layer = await createLayer(w, 'hasan', 'شرحي');
  await strokes(w, 'hasan', layer, 0, 5);
  pub = await publish(w, 'hasan', [layer], 'شرح حسن');
  copies.zainab = (await start('zainab', 'followed')).copy;
  copies.ali = (await start('ali', 'independent_fork')).copy;
  // زينب's own notes — private to her vault
  await strokes(w, 'zainab', null, 1, 2);
  await typedNote(w, 'zainab', null, 1, 'سر زينب: لا يراه أحد');
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('variant (e): report → hide → restore by an Assistant', () => {
  let report: ReportView;
  it('a member reports it; another subject’s student and a non-member cannot (the 404 of a missing item)', async () => {
    report = ok<ReportView>(await call(w.t, w.p.zainab.h, 'POST', '/api/moderation/reports', { target: { db: 'system', type: 'publication', id: pub.id }, reason: 'wrong_content', note: 'الشكل في الصفحة 1 خاطئ' }));
    expect(report.status).toBe('open');
    for (const who of ['physio', 'ahmad'] as const) {
      const res = await call(w.t, w.p[who].h, 'POST', '/api/moderation/reports', { target: { db: 'system', type: 'publication', id: pub.id }, reason: 'spam' });
      expect(res.statusCode, who).toBe(404);
    }
    // the author cannot report his own explanation
    expect((await call(w.t, w.p.hasan.h, 'POST', '/api/moderation/reports', { target: { db: 'system', type: 'publication', id: pub.id }, reason: 'spam' })).statusCode).toBe(409);
    // a version is reported in the subject's space
    const v1 = w.t.ctx.dbs.space(w.space).get<{ id: string }>('SELECT id FROM publication_version WHERE publication_id = ? AND version_no = 1', [pub.id])!.id;
    const rv = ok<ReportView>(await call(w.t, w.p.ali.h, 'POST', '/api/moderation/reports', { target: { db: w.space, type: 'publication_version', id: v1 }, reason: 'copyright' }));
    expect(rv.target.title).toBe('شرح حسن');
  });

  it('مصطفى (Assistant) hides it: it leaves the list, followers keep what they had and read why, author and reporter are told', async () => {
    ok(await call(w.t, w.p.mustafa.h, 'POST', '/api/moderation/actions', { report_id: report.id, action: 'hide', reason_ar: 'معلومة خاطئة في الصفحة 1.' }));
    await settle(w);
    expect(await list('zainab')).toEqual([]);
    // the publication page: the author, the subject's moderators and the holders of a copy read it with the reason
    for (const who of ['hasan', 'mustafa', 'sara', 'zainab', 'ali'] as const) {
      const v = ok<PublicationView>(await call(w.t, w.p[who].h, 'GET', w.S(`/publications/${pub.id}`)));
      expect(v.status, who).toBe('hidden_by_moderator');
      expect(v.hidden?.reason_ar, who).toBe('معلومة خاطئة في الصفحة 1.');
    }
    // … a member without a copy does not see it at all
    expect((await call(w.t, w.p.noor.h, 'GET', w.S(`/publications/${pub.id}`))).statusCode).toBe(404);
    const z = await copyOf('zainab');
    expect(z.publication!.status).toBe('hidden_by_moderator');
    expect(z.publication!.status_note_ar).toContain('أخفى المشرف هذا الشرح: معلومة خاطئة في الصفحة 1.');
    expect(layerRows(w, 'zainab', z.copied_layer_id)).toHaveLength(5);
    // nobody starts a new copy of it while hidden
    expect((await call(w.t, w.p.huda.h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode: 'followed', publication_id: pub.id })).statusCode).toBe(404);
    const notices = (who: Who) => w.t.ctx.system.db.all<{ kind: string; payload_json: string }>(`SELECT kind, payload_json FROM notification WHERE user_id = ? AND kind = 'moderation'`, [w.p[who].user.id]);
    expect(notices('hasan').map((n) => JSON.parse(n.payload_json).as)).toEqual(['author']);
    expect(notices('zainab').map((n) => JSON.parse(n.payload_json).as)).toEqual(['reporter']);
  });

  it('there is no «راجعه مشرف المادة» in Phase 1: the action does not exist for an Assistant (nor anyone)', async () => {
    const res = await call(w.t, w.p.mustafa.h, 'POST', '/api/moderation/actions', { target: { db: 'system', type: 'publication', id: pub.id }, action: 'mark_reviewed', reason_ar: 'راجعته' });
    expect(res.statusCode).toBe(400);
    expect(w.t.ctx.system.db.get<{ moderator_review: string }>('SELECT moderator_review FROM publication WHERE id = ?', [pub.id])!.moderator_review).toBe('none');
  });

  it('the restore brings it back to the list; two audit entries exist', async () => {
    ok(await call(w.t, w.p.mustafa.h, 'POST', '/api/moderation/actions', { target: { db: 'system', type: 'publication', id: pub.id }, action: 'restore', reason_ar: 'صُحّح الخطأ.' }));
    expect(await list('zainab')).toEqual([pub.id]);
    expect((await copyOf('zainab')).publication!.status_note_ar).toBeNull();
    const audit = w.t.ctx.system.db.all<{ action: string }>(`SELECT action FROM security_audit WHERE target_type = 'publication' AND target_id = ? ORDER BY created_at, id`, [pub.id]);
    expect(audit.map((a) => a.action).sort()).toEqual(['moderation_hide', 'moderation_restore']);
  });

  it('a moderator of ANOTHER subject cannot act on it (the 404 of a missing item)', async () => {
    const res = await call(w.t, w.p.modB.h, 'POST', '/api/moderation/actions', { target: { db: 'system', type: 'publication', id: pub.id }, action: 'hide', reason_ar: 'لا.' });
    expect(res.statusCode).toBe(404);
  });
});

describe('nothing of a follower’s personal layer reaches the author', () => {
  it('publication routes, the diff and the author’s inbox carry only the author’s own content', async () => {
    const bodies: string[] = [];
    for (const url of [w.S(`/publications/${pub.id}`), w.S(`/publications/${pub.id}/versions/1/items`), w.S(`/lectures/${w.lecture.id}/publications`)]) {
      bodies.push((await call(w.t, w.p.hasan.h, 'GET', url)).body);
    }
    bodies.push((await call(w.t, w.p.hasan.h, 'GET', '/api/notifications')).body);
    for (const b of bodies) expect(b).not.toContain('سر زينب');
    const zIds = layerRows(w, 'zainab', null).map((r) => r.id as string);
    for (const b of bodies) for (const id of zIds) expect(b).not.toContain(id);
  });
});

describe('the author withdraws (ARCHITECTURE_DELTA §6.4 «Withdraw»)', () => {
  it('forks keep their copy; followed copies stop and say why; no new copy; the page is gone for others', async () => {
    const res = ok<PublicationView>(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${pub.id}/withdraw`), {}));
    expect(res.status).toBe('withdrawn');
    expect(await list('noor')).toEqual([]);
    expect((await call(w.t, w.p.noor.h, 'GET', w.S(`/publications/${pub.id}`))).statusCode).toBe(404);
    const ali = await copyOf('ali');
    expect(layerRows(w, 'ali', ali.copied_layer_id)).toHaveLength(5);
    const z = await copyOf('zainab');
    expect(z.publication!.status).toBe('withdrawn');
    expect(z.publication!.status_note_ar).toBe('توقف التحديث — لم يعد الشرح منشورًا. ما عندك باقٍ كما هو.');
    expect(layerRows(w, 'zainab', z.copied_layer_id)).toHaveLength(5);
    expect((await call(w.t, w.p.huda.h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode: 'followed', publication_id: pub.id })).statusCode).toBe(404);
    // a republish of a withdrawn explanation is refused
    expect((await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${pub.id}/versions`), { layer_ids: [layer], change_note: null })).statusCode).toBe(403);
  });
});

describe('Q14: the author deletes the account', () => {
  it('«طالب سابق» at once, gone from listings, forks kept, followed copies frozen', async () => {
    // a second, live publication with a follower and a fork
    const l2 = await createLayer(w, 'hasan', 'شرح ثان');
    await strokes(w, 'hasan', l2, 2, 3);
    const p2 = await publish(w, 'hasan', [l2], 'شرح حسن الثاني');
    copies.huda = (await start('huda', 'followed', p2.id)).copy;
    copies.noor = (await start('noor', 'independent_fork', p2.id)).copy;
    expect(await list('zainab')).toEqual([p2.id]);
    const preview = ok<{ confirm_token: string; publications: { total: number; forked_by_others: number } }>(await call(w.t, w.p.hasan.h, 'POST', '/api/accounts/me/delete', { preview: true }));
    // the preview says what happens: one live explanation leaves the listings, one other student keeps a fork of it
    expect(preview.publications).toEqual({ total: 1, forked_by_others: 1 });
    ok(await call(w.t, w.p.hasan.h, 'POST', '/api/accounts/me/delete', { confirm_token: preview.confirm_token, password: w.p.hasan.password }));
    await finishPendingDeletions(w.t.ctx);
    expect(await list('zainab')).toEqual([]);
    expect(w.t.ctx.system.db.get<{ status: string }>('SELECT status FROM publication WHERE id = ?', [p2.id])!.status).toBe('author_deleted');
    const huda = ok<DocumentCopyView>(await call(w.t, w.p.huda.h, 'GET', `/api/copies/${copies.huda.id}`));
    expect(huda.publication!.author.display_name).toBe('طالب سابق');
    expect(huda.publication!.status_note_ar).toBe('توقف التحديث — حذف صاحب الشرح حسابه. ما عندك باقٍ كما هو.');
    expect(layerRows(w, 'huda', huda.copied_layer_id)).toHaveLength(3);
    const noor = ok<DocumentCopyView>(await call(w.t, w.p.noor.h, 'GET', `/api/copies/${copies.noor.id}`));
    expect(layerRows(w, 'noor', noor.copied_layer_id)).toHaveLength(3);
  });
});
