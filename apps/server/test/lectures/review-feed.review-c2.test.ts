// Review of Phase 1 completion track C2 — who reaches the subject's review queue and updates feed, and who is told of a
// new official version reached through the review queue, tried as each kind of person with REAL channels (pubWorld):
// a guest (401), a pending member and a removed member (no queue, no feed, no notice — though the removed one still
// holds a copy of the lecture), a student and an Assistant (no queue), another subject's moderator (404), the Subject
// Moderator (the queue) — and the official_version notice reaches the holders who are still members only.
// Every file is a TEST FIXTURE generated here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecideSubjectReviewResponse, OfficialLectureDetail, OfficialLectureView, SubjectReviewResponse, UploadOfficialVersionResponse } from '@medlevo/shared';
import { call, createCode, ok, person, type Person } from '../channels/helpers';
import { createPubWorld, settle, startPersonal, type PubWorld, type Who } from '../forks/pubWorld';
import { lecturePdf, multipart, pagesFor } from './world';

let w: PubWorld;
let pending: Person;

const notices = async (h: Person['h']) => ok<{ items: Array<{ kind: string }> }>(await call(w.t, h, 'GET', '/api/notifications')).items.map((n) => n.kind);

beforeAll(async () => {
  w = await createPubWorld(6);
  await startPersonal(w, 'zainab');
  await startPersonal(w, 'ali');
  // ali holds a copy, then is removed from the subject by the Assistant
  ok(await call(w.t, w.p.mustafa.h, 'POST', `/api/channels/nodes/${w.subject.id}/members/${w.p.ali.user.id}/decision`, { decision: 'remove', reason: 'خروج من المادة' }));
  // a join request still waiting for approval
  pending = await person(w.t, 'pw_pending_rev');
  const admin = await w.t.login();
  const code = (await createCode(w.t, admin, w.subject.id, { requires_approval: true })).code!;
  const j = await call(w.t, pending.h, 'POST', '/api/channels/join', { code });
  expect(j.statusCode, j.body).toBeLessThan(300);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('the review queue and the feed, tried as every kind of person', () => {
  it('only the subject\'s official moderators read the queue; the feed is for members only', async () => {
    const q = (h: Person['h'] | null) => call(w.t, h, 'GET', w.S('/subject/review'));
    const feed = (h: Person['h'] | null) => call(w.t, h, 'GET', w.S('/subject/events?limit=20'));
    expect((await q(w.p.sara.h)).statusCode).toBe(200);
    expect((await q(null)).statusCode).toBe(401);
    expect((await q(pending.h)).statusCode).toBe(403);
    expect((await q(w.p.ali.h)).statusCode).toBe(404); // removed: the subject is closed to him
    expect((await q(w.p.zainab.h)).statusCode).toBe(403);
    expect((await q(w.p.mustafa.h)).statusCode).toBe(403);
    expect((await q(w.p.modB.h)).statusCode).toBe(404);
    expect((await feed(w.p.zainab.h)).statusCode).toBe(200);
    expect((await feed(null)).statusCode).toBe(401);
    expect((await feed(pending.h)).statusCode).toBe(403);
    expect((await feed(w.p.ali.h)).statusCode).toBe(404);
    expect((await feed(w.p.modB.h)).statusCode).toBe(404);
  });

  it('a new version accepted through the queue and published reaches the holders who are members — not the removed holder, nor the pending one', async () => {
    const B = ok<OfficialLectureView>(await call(w.t, w.p.sara.h, 'POST', w.S('/lectures'), { title: 'Lecture 5 (department re-export)' }));
    const mp = multipart({}, { name: 'lecture5-again.pdf', data: lecturePdf(pagesFor('Lecture 5', 6, { 5: 'a new closing slide for this year only' })) });
    const up = await w.t.app.inject({ method: 'POST', url: w.S(`/lectures/${B.id}/upload`), headers: { ...w.p.sara.h, 'content-type': mp.contentType }, payload: mp.body });
    expect(up.statusCode, up.body).toBe(200);
    expect((up.json() as UploadOfficialVersionResponse).version_id).toBeTruthy();
    await w.t.ctx.jobs.drain();
    const nv = ok<SubjectReviewResponse>(await call(w.t, w.p.sara.h, 'GET', w.S('/subject/review'))).items.find((i) => i.suggestion.field === 'new_version_of')!;
    expect(nv).toBeTruthy();
    // neither the pending nor the removed person can decide it
    expect((await call(w.t, pending.h, 'POST', w.S(`/subject/review/${nv.suggestion.id}/decide`), { action: 'accept' })).statusCode).toBe(403);
    expect((await call(w.t, w.p.ali.h, 'POST', w.S(`/subject/review/${nv.suggestion.id}/decide`), { action: 'accept' })).statusCode).toBe(404);
    const res = ok<DecideSubjectReviewResponse>(await call(w.t, w.p.sara.h, 'POST', w.S(`/subject/review/${nv.suggestion.id}/decide`), { action: 'accept' }));
    await w.t.ctx.jobs.drain();
    const v2 = ok<OfficialLectureDetail>(await call(w.t, w.p.sara.h, 'GET', w.S(`/lectures/${w.lecture.id}`))).versions.find((v) => v.id === res.new_version!.version_id)!;
    ok(await call(w.t, w.p.sara.h, 'POST', w.S(`/lectures/${w.lecture.id}/versions/${v2.id}/publish`), {}));
    await settle(w);
    await settle(w);
    expect(await notices(w.p.zainab.h)).toContain('official_version');
    expect(await notices(w.p.ali.h)).not.toContain('official_version');
    expect(await notices(pending.h)).not.toContain('official_version');
    for (const who of ['physio', 'ahmad'] as Who[]) expect(await notices(w.p[who].h)).not.toContain('official_version');
  });
});
