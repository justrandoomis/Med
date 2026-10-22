// P1-T5 step 2 — «تابع المادة» fan-out with P1-T4's REAL channels (BUILD_PLAN §3.7 «course-follow stub fan-out»;
// ARCHITECTURE_DELTA §12 `official_lecture_new`; PRD AOS-2.16): a lecture's first publication lands in every follower's
// library as a stub (links, not copies), idempotently per user + lecture version; a follower who switched «add new
// lectures» off, a member who does not follow, and a stranger get nothing; nothing of a follower's vault is touched but
// the new stub.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelNodeView, OfficialLectureView, UploadOfficialVersionResponse } from '@medlevo/shared';
import { assignRole, call, createCode, createNode, ok, person, type Person } from '../channels/helpers';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { lecturePdf, multipart, pagesFor } from '../lectures/world';
import { createProcessingApp } from '../processing/helpers';

let t: TestApp;
let pa: AuthHeaders;
let subject: ChannelNodeView;
const p: Record<'mod' | 'follower' | 'quiet' | 'member' | 'outsider', Person> = {} as never;

const stubsOf = (who: Person) =>
  t.ctx.binding.run({ kind: 'vault', vaultId: t.ctx.system.vaults.ofUserInternal(who.user.id)!.id, viewer: null }, () =>
    t.ctx.db.all<{ id: string; origin_lecture_id: string; node_id: string }>('SELECT id, origin_lecture_id, node_id FROM source WHERE is_stub = 1'),
  );

async function publish(title: string): Promise<{ lectureId: string; versionId: string }> {
  const S = (rest: string) => `/api/spaces/${subject.space_id}${rest}`;
  const l = ok<OfficialLectureView>(await call(t, p.mod.h, 'POST', S('/lectures'), { title }));
  const mp = multipart({}, { name: `${title}.pdf`, data: lecturePdf(pagesFor(title, 3)) });
  const up = await t.app.inject({ method: 'POST', url: S(`/lectures/${l.id}/upload`), headers: { ...p.mod.h, 'content-type': mp.contentType }, payload: mp.body });
  expect(up.statusCode, up.body).toBe(200);
  const v = up.json() as UploadOfficialVersionResponse;
  await t.ctx.jobs.drain();
  ok(await call(t, p.mod.h, 'POST', S(`/lectures/${l.id}/versions/${v.version_id}/publish`), {}));
  await t.ctx.jobs.drain();
  return { lectureId: l.id, versionId: v.version_id };
}

beforeAll(async () => {
  t = await createProcessingApp();
  pa = await t.login();
  const uni = await createNode(t, pa, null, 'university', 'جامعة المتابعة');
  subject = await createNode(t, pa, uni.id, 'subject', 'الكيمياء الحيوية', { join_policy: 'open_with_code' });
  for (const k of Object.keys({ mod: 1, follower: 1, quiet: 1, member: 1, outsider: 1 }) as Array<keyof typeof p>) p[k] = await person(t, `cf_${k}`);
  await assignRole(t, pa, subject.id, p.mod.user.id, 'subject_moderator');
  const code = (await createCode(t, pa, subject.id, { requires_approval: false })).code!;
  for (const who of [p.follower, p.quiet, p.member]) ok(await call(t, who.h, 'POST', '/api/channels/join', { code }));
  ok(await call(t, p.follower.h, 'PUT', `/api/channels/subjects/${subject.id}/follow`, { add_new_lectures: true }));
  ok(await call(t, p.quiet.h, 'PUT', `/api/channels/subjects/${subject.id}/follow`, { add_new_lectures: false }));
}, 240_000);
afterAll(async () => {
  await t?.close();
});

describe('«تابع المادة»: new official lectures appear in followers’ libraries', () => {
  it('the first publication adds a stub to the follower only — idempotent, in «موادي من القنوات»', async () => {
    const a = await publish('Enzymes');
    expect(stubsOf(p.follower).map((s) => s.origin_lecture_id)).toEqual([a.lectureId]);
    for (const who of [p.quiet, p.member, p.outsider, p.mod]) expect(stubsOf(who)).toEqual([]);
    // the follower did not «start studying»: a stub in the library, no copy yet
    const copies = ok<{ copies: unknown[] }>(await call(t, p.follower.h, 'GET', '/api/copies'));
    expect(copies.copies).toEqual([]);
    // the fan-out ran once per user + lecture version: running the queue again changes nothing
    await t.ctx.jobs.drain();
    expect(stubsOf(p.follower)).toHaveLength(1);
    // the system index knows the follower holds it (counts only), so later versions reach them too
    const held = t.ctx.system.db.all<{ version_id: string; personal_items: number }>('SELECT version_id, personal_items FROM lecture_copy WHERE user_id = ?', [p.follower.user.id]);
    expect(held).toEqual([{ version_id: a.versionId, personal_items: 0 }]);
  });

  it('starting to study the followed lecture reopens the stub that is already there', async () => {
    const stub = stubsOf(p.follower)[0]!;
    const res = ok<{ created: boolean; copy: { source_id: string } }>(
      await call(t, p.follower.h, 'POST', '/api/copies', { id: 'CF_COPY_1', space_id: subject.space_id, lecture_id: stub.origin_lecture_id, mode: 'personal' }),
    );
    expect(res.created).toBe(true);
    expect(res.copy.source_id).toBe(stub.id);
    expect(stubsOf(p.follower)).toHaveLength(1);
  });

  it('an unfollowed subject adds nothing more', async () => {
    ok(await call(t, p.follower.h, 'DELETE', `/api/channels/subjects/${subject.id}/follow`));
    await publish('Metabolism');
    expect(stubsOf(p.follower)).toHaveLength(1);
  });
});
