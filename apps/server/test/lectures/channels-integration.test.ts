// P1-T5 step 1 with P1-T4's REAL channels (no test double): a subject created through /api/channels has its own space;
// roles assigned there and a membership obtained with a class code decide what each person may do with official
// lectures — the membership provider's `roles` field is what rules/lectures.ts reads (Q5: a Subject Moderator
// publishes, a Contributor's upload waits, an Assistant has no power over official files, a student reads).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { ChannelNodeView, CursorPage, LecturesFromTemplateResponse, OfficialLectureView, UploadOfficialVersionResponse, UploadSessionView } from '@medlevo/shared';
import { assignRole, call, createCode, createNode, ok, person, type Person } from '../channels/helpers';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { createProcessingApp } from '../processing/helpers';
import { lecturePdf, multipart, pagesFor } from './world';

let t: TestApp;
let pa: AuthHeaders;
let subject: ChannelNodeView;
let other: ChannelNodeView;
const p: Record<'mod' | 'contrib' | 'student' | 'assistant' | 'outsider' | 'modOther' | 'uniAdmin', Person> = {} as never;
let uniId = '';

beforeAll(async () => {
  t = await createProcessingApp();
  pa = await t.login();
  const uni = await createNode(t, pa, null, 'university', 'جامعة الاختبار');
  subject = await createNode(t, pa, uni.id, 'subject', 'التشريح', { join_policy: 'open_with_code' });
  other = await createNode(t, pa, uni.id, 'subject', 'الفسلجة');
  uniId = uni.id;
  for (const k of Object.keys({ mod: 1, contrib: 1, student: 1, assistant: 1, outsider: 1, modOther: 1, uniAdmin: 1 }) as Array<keyof typeof p>) p[k] = await person(t, `ci_${k.toLowerCase()}`);
  await assignRole(t, pa, uni.id, p.uniAdmin.user.id, 'admin');
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

// AOS-2.3 / 18.3 (gaps: templates; chunked upload into a space) with the REAL channel roles
describe('a subject from a study template, and a resumable upload into it', () => {
  it('an Admin of the university creates a subject from a template, then its lecture skeleton; only official moderators may', async () => {
    const res = await call(t, p.uniAdmin.h, 'POST', '/api/channels/nodes', { parent_id: uniId, kind: 'subject', title: 'الأدوية', template_key: 'pharmacology', create_space: true });
    const node = ok<ChannelNodeView>(res);
    expect(node.title_en).toBe('Pharmacology'); // the template's English name when none is given
    expect(node.space_id).toBeTruthy();
    const S = (rest: string) => `/api/spaces/${node.space_id}${rest}`;
    const made = ok<LecturesFromTemplateResponse>(await call(t, p.uniAdmin.h, 'POST', S('/lectures/from-template'), { template_key: 'pharmacology' }));
    expect(made.created.map((l) => l.title)[0]).toBe('المبادئ العامة — General pharmacology');
    expect(made.created).toHaveLength(5);
    // an Assistant above the subject passes gate 2 but holds no official power (Q5); a stranger learns nothing
    expect((await call(t, p.assistant.h, 'POST', S('/lectures/from-template'), { template_key: 'pharmacology' })).statusCode).toBe(403);
    expect((await call(t, p.outsider.h, 'POST', S('/lectures/from-template'), { template_key: 'pharmacology' })).statusCode).toBe(404);
    // a template is for subjects only; an unknown one is refused
    expect((await call(t, p.uniAdmin.h, 'POST', '/api/channels/nodes', { parent_id: uniId, kind: 'college', title: 'كلية', template_key: 'anatomy' })).statusCode).toBe(400);
    expect((await call(t, p.uniAdmin.h, 'POST', '/api/channels/nodes', { parent_id: uniId, kind: 'subject', title: 'مادة', template_key: 'nope' })).statusCode).toBe(400);
  });

  it("the contributor's chunked upload into the subject becomes a version; the student and the stranger cannot start one", async () => {
    const S = (rest: string) => `/api/spaces/${subject.space_id}${rest}`;
    const data = lecturePdf(pagesFor('Chunked', 3));
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const body = { size: data.length, sha256: sha(data), mime: 'application/pdf', name: 'chunked.pdf', target: { space_id: subject.space_id } };
    expect((await call(t, p.student.h, 'POST', S('/uploads'), body)).statusCode).toBe(403);
    expect((await call(t, p.outsider.h, 'POST', S('/uploads'), body)).statusCode).toBe(404);
    expect((await call(t, p.modOther.h, 'POST', S('/uploads'), body)).statusCode).toBe(404);
    const s = ok<UploadSessionView>(await call(t, p.contrib.h, 'POST', S('/uploads'), body));
    for (let n = 0; n < s.chunks; n++) {
      const part = data.subarray(n * s.chunk_size, (n + 1) * s.chunk_size);
      const r = await t.app.inject({ method: 'PUT', url: S(`/uploads/${s.upload_id}/chunks/${n}`), headers: { ...p.contrib.h, 'content-type': 'application/octet-stream', 'x-content-sha256': sha(part) }, payload: part });
      expect(r.statusCode, r.body).toBe(200);
    }
    ok(await call(t, p.contrib.h, 'POST', S(`/uploads/${s.upload_id}/complete`), {}));
    const lecture = ok<OfficialLectureView>(await call(t, p.contrib.h, 'POST', S('/lectures'), { title: 'محاضرة مقطّعة' }));
    const up = ok<UploadOfficialVersionResponse>(await call(t, p.contrib.h, 'POST', S(`/lectures/${lecture.id}/upload`), { upload_id: s.upload_id }));
    expect(up.version_id).toBeTruthy();
  });
});
