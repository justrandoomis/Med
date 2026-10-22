// P1-T5 step 1 with P1-T4's REAL channels (no test double): a subject created through /api/channels has its own space;
// roles assigned there and a membership obtained with a class code decide what each person may do with official
// lectures — the membership provider's `roles` field is what rules/lectures.ts reads (Q5: a Subject Moderator
// publishes, a Contributor's upload waits, an Assistant has no power over official files, a student reads).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelNodeView, CursorPage, OfficialLectureView, UploadOfficialVersionResponse } from '@medlevo/shared';
import { assignRole, call, createCode, createNode, ok, person, type Person } from '../channels/helpers';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { createProcessingApp } from '../processing/helpers';
import { lecturePdf, multipart, pagesFor } from './world';

let t: TestApp;
let pa: AuthHeaders;
let subject: ChannelNodeView;
let other: ChannelNodeView;
const p: Record<'mod' | 'contrib' | 'student' | 'assistant' | 'outsider' | 'modOther', Person> = {} as never;

beforeAll(async () => {
  t = await createProcessingApp();
  pa = await t.login();
  const uni = await createNode(t, pa, null, 'university', 'جامعة الاختبار');
  subject = await createNode(t, pa, uni.id, 'subject', 'التشريح', { join_policy: 'open_with_code' });
  other = await createNode(t, pa, uni.id, 'subject', 'الفسلجة');
  for (const k of Object.keys({ mod: 1, contrib: 1, student: 1, assistant: 1, outsider: 1, modOther: 1 }) as Array<keyof typeof p>) p[k] = await person(t, `ci_${k.toLowerCase()}`);
  await assignRole(t, pa, subject.id, p.mod.user.id, 'subject_moderator');
  await assignRole(t, pa, subject.id, p.contrib.user.id, 'contributor');
  await assignRole(t, pa, uni.id, p.assistant.user.id, 'assistant');
  await assignRole(t, pa, other.id, p.modOther.user.id, 'subject_moderator');
  const code = (await createCode(t, pa, subject.id, { requires_approval: false })).code!;
  ok(await call(t, p.student.h, 'POST', '/api/channels/join', { code }));
}, 180_000);
afterAll(async () => {
  await t?.close();
});

describe('official lectures inside a real channel subject', () => {
  it('the space comes from the channel tree; roles held there decide every step', async () => {
    const spaceId = subject.space_id!;
    expect(spaceId).toBeTruthy();
    const S = (rest: string) => `/api/spaces/${spaceId}${rest}`;
    const lecture = ok<OfficialLectureView>(await call(t, p.contrib.h, 'POST', S('/lectures'), { title: 'المحاضرة الأولى', lecture_no: 1 }));
    expect(lecture.subject).toMatchObject({ id: subject.id, kind: 'subject' });
    const mp = multipart({}, { name: 'lecture1.pdf', data: lecturePdf(pagesFor('Integration', 2)) });
    const up = await t.app.inject({ method: 'POST', url: S(`/lectures/${lecture.id}/upload`), headers: { ...p.contrib.h, 'content-type': mp.contentType }, payload: mp.body });
    expect(up.statusCode, up.body).toBe(200);
    const v = up.json() as UploadOfficialVersionResponse;
    await t.ctx.jobs.drain();

    // the student does not see the contributor's draft; the assistant passes gate 2 but holds no official power
    expect((await call(t, p.student.h, 'GET', S(`/lectures/${lecture.id}`))).statusCode).toBe(404);
    expect((await call(t, p.assistant.h, 'POST', S(`/lectures/${lecture.id}/approve`), {})).statusCode).toBe(404);
    expect((await call(t, p.contrib.h, 'POST', S(`/lectures/${lecture.id}/versions/${v.version_id}/publish`), {})).statusCode).toBe(403);
    // the moderator of ANOTHER subject, and a signed-in stranger, get «not found»
    expect((await call(t, p.modOther.h, 'GET', S('/lectures'))).statusCode).toBe(404);
    expect((await call(t, p.outsider.h, 'GET', S('/lectures'))).statusCode).toBe(404);

    ok(await call(t, p.mod.h, 'POST', S(`/lectures/${lecture.id}/versions/${v.version_id}/publish`), {}));
    const list = ok<CursorPage<OfficialLectureView>>(await call(t, p.student.h, 'GET', S('/lectures')));
    expect(list.items.map((l) => [l.title, l.status])).toEqual([['المحاضرة الأولى', 'published']]);
    expect(list.items[0]!.approved?.by.id).toBe(p.mod.user.id); // publishing a contributor's lecture is the approval (Q5)
    // the platform admin may bind every space (P1-T4) and holds official powers there
    expect((await call(t, pa, 'GET', S(`/lectures/${lecture.id}`))).statusCode).toBe(200);
  });
});
