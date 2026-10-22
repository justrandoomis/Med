// AOS-21.45 (ARCHITECTURE_DELTA §14 «warnings at 80 % to the subject's moderators») with the REAL channel tree, roles
// and notification fan-out: an upload that takes a subject across 80 % of its storage limit tells the subject's
// moderators once (a quota_warning naming the subject, opening the subject); a plain member is not told.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficialLectureView } from '@medlevo/shared';
import { assignRole, call, createNode, ok, person, type Person } from '../channels/helpers';
import { createProcessingApp } from '../processing/helpers';
import { lecturePdf, multipart, pagesFor } from '../lectures/world';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { items } from './helpers';

let t: TestApp;
let pa: AuthHeaders;
let mod: Person;
let member: Person;
let subject: { id: string; space_id: string };

beforeAll(async () => {
  t = await createProcessingApp();
  pa = await t.login();
  const uni = await createNode(t, pa, null, 'university', 'جامعة الاختبار');
  const s = await createNode(t, pa, uni.id, 'subject', 'Histology');
  subject = { id: s.id, space_id: s.space_id! };
  mod = await person(t, 'mod');
  member = await person(t, 'member');
  await assignRole(t, pa, subject.id, mod.user.id, 'subject_moderator');
  await assignRole(t, pa, subject.id, member.user.id, 'contributor');
}, 120_000);
afterAll(async () => {
  await t?.close();
});

describe('AOS-21.45 — the subject moderators are told at 80 %', () => {
  it('one quota_warning to the moderators, naming the subject; not to a member', async () => {
    const lecture = ok<OfficialLectureView>(await call(t, mod.h, 'POST', `/api/spaces/${subject.space_id}/lectures`, { title: 'Epithelium', lecture_no: 1 }));
    const pdf = lecturePdf(pagesFor('H', 2));
    const used = t.ctx.quota.spaceStorageUsed(subject.space_id);
    const total = used.bytes_db + used.bytes_files;
    t.ctx.system.quotas.setSpaceInternal(subject.space_id, { storage_bytes_limit: Math.floor((total + pdf.length / 2) / 0.8) }, t.ctx.system.users.findForAuth('owner')!.id);
    const mp = multipart({}, { name: 'epi.pdf', data: pdf });
    const res = await t.app.inject({ method: 'POST', url: `/api/spaces/${subject.space_id}/lectures/${lecture.id}/upload`, headers: { ...mod.h, 'content-type': mp.contentType }, payload: mp.body });
    expect(res.statusCode, res.body).toBe(200);

    const warned = await items(t, mod.h, 'quota_warning');
    expect(warned).toHaveLength(1);
    expect(warned[0]!.text_ar).toContain('Histology');
    expect(warned[0]!.text_ar).toContain('80');
    expect(warned[0]!.link).toBe(`/subjects/${encodeURIComponent(subject.id)}`);
    expect(await items(t, member.h, 'quota_warning')).toHaveLength(0);

    // a second upload above 80 % in the same month: no second warning
    const mp2 = multipart({}, { name: 'epi2.pdf', data: lecturePdf(pagesFor('H2', 1)) });
    await t.app.inject({ method: 'POST', url: `/api/spaces/${subject.space_id}/lectures/${lecture.id}/upload`, headers: { ...mod.h, 'content-type': mp2.contentType }, payload: mp2.body });
    expect((await items(t, mod.h, 'quota_warning')).filter((n) => n.text_ar.includes('80'))).toHaveLength(1);
  });
});
