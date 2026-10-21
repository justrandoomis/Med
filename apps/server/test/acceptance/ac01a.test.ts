// AC-01a (server part) — «the personal library works for a user who never joins a channel» (PRD §9 / ARCHITECTURE_DELTA
// §15.3; BUILD_PLAN §3.3 step 3). Every step of today's AC-01 (test/acceptance/g1-ac01.test.ts, e2e
// g1-ac01-personal-library) is run for TWO accounts of one deployment, neither of which is a member of any channel:
//   * user #1 (the first account — the single owner of R1-a after the owner migration; platform admin), and
//   * another account (not an admin, no membership, no role) — the user AC-01a is really about;
// for each: «الجراحة» notebook → course → a lecture, a reference (`course_reference`) and a question source uploaded with
// the owner-chosen types; the course groups them; institution node kinds are refused; no channel / institution route or
// capability is needed; /api/accounts/me reports no membership and no role. And the library is the account's own: the other
// account's tree, sources and source pages are invisible (the light half of AC-01b; the full matrix is
// test/tenancy/isolation.test.ts). The client-version gate (step 3) never stands in the way of a current client; the R1-a
// PWA of user #1 keeps working until it updates, while an outdated client of another account is asked to update (426).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LibraryTreeResponse, MeResponse, SourceDetail } from '@medlevo/shared';
import { type AuthHeaders } from '../helpers/app';
import { addUser } from '../helpers/tenancy';
import { createNode, golden, type Harness, makeHarness, upload, uploadOk } from '../sources/helpers';

let t: Harness;
let first: Harness;
let other: Harness;
const built = new Map<string, { course: string; sources: string[] }>();

const as = (h: AuthHeaders): Harness => Object.assign(Object.create(Object.getPrototypeOf(t) as object) as Harness, t, { h });
const get = (who: Harness, url: string) => t.app.inject({ method: 'GET', url, headers: who.h });

beforeAll(async () => {
  t = await makeHarness();
  first = as(t.h);
  const b = await addUser(t, 'student_no_channel');
  other = as(await b.login());
}, 60_000);
afterAll(async () => {
  await t?.close();
});

describe('AC-01a — the personal library for an account with no channel', () => {
  it('neither account is a member of anything; only the first is user #1', async () => {
    const me1 = (await get(first, '/api/accounts/me')).json() as MeResponse;
    const me2 = (await get(other, '/api/accounts/me')).json() as MeResponse;
    for (const me of [me1, me2]) {
      expect(me.memberships).toEqual([]);
      expect(me.roles).toEqual([]);
      expect(typeof me.vault_id).toBe('string');
    }
    expect(me1.vault_id).not.toBe(me2.vault_id);
    expect(me1.owns_legacy_device_data).toBe(true);
    expect(me2.owns_legacy_device_data).toBe(false);
    expect(me2.is_platform_admin).toBe(false);
    // P1-T4 adds channels; no channel route exists, so nothing of AC-01 can depend on one
    expect(t.app.printRoutes({ commonPrefix: false }).split('\n').filter((l) => /channel|universit|college|subscri|billing|pricing|payment/i.test(l))).toEqual([]);
  });

  for (const [label, who] of [
    ['user #1', () => first],
    ['another account', () => other],
  ] as const) {
    it(`${label}: notebook → course → lecture, reference and question source; the course groups them`, async () => {
      const u = who();
      const nb = await createNode(u, { kind: 'notebook', title: 'الجراحة', cover: { style: 'linen', color: 'rose', symbol: 'syringe' } });
      const course = await createNode(u, { kind: 'course', title: 'Course 1 — البطن الحاد', parent_id: nb.id });
      const up = async (file: string, type: string) => (await uploadOk(u, course.id, [{ name: file, data: golden(file) }], { source_type: type })).results[0]!;
      const lecture = await up('lecture_appendicitis.pdf', 'lecture');
      const reference = await up('lecture_cholecystitis.pdf', 'course_reference');
      const questions = await up('questions_surgery_course1.pdf', 'question_source');
      for (const r of [lecture, reference, questions]) expect(r.status).toBe('accepted');
      const tree = (await get(u, '/api/library/tree')).json() as LibraryTreeResponse;
      const mine = tree.sources.filter((s) => s.course_node_id === course.id);
      expect(mine.map((s) => s.source_type).sort()).toEqual(['course_reference', 'lecture', 'question_source']);
      expect(tree.nodes.find((n) => n.id === nb.id)?.title).toBe('الجراحة');
      const listed = (await get(u, `/api/sources?node_id=${course.id}`)).json() as { sources: Array<{ id: string }> };
      expect(listed.sources).toHaveLength(3);
      built.set(label, { course: course.id, sources: mine.map((s) => s.id) });
    });

    it(`${label}: institution node kinds are refused; no capability needs an institution or a channel`, async () => {
      const u = who();
      for (const kind of ['university', 'institution', 'organization', 'cohort', 'class_group', 'channel']) {
        const res = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: u.h, payload: { parent_id: null, kind, title: 'x' } });
        expect(res.statusCode, kind).toBe(400);
      }
      const caps = (await get(u, '/api/capabilities')).json() as { features: Record<string, unknown> };
      expect(Object.keys(caps.features).filter((k) => /universit|institution|organi[sz]ation|cohort|channel|subscri|billing/i.test(k))).toEqual([]);
    });
  }

  it('each library is the account’s own: the other account’s nodes and sources are invisible', async () => {
    const a = built.get('user #1')!;
    const b = built.get('another account')!;
    expect(a && b).toBeTruthy();
    const treeB = (await get(other, '/api/library/tree')).json() as LibraryTreeResponse;
    expect(treeB.nodes.some((n) => n.id === a.course)).toBe(false);
    expect(treeB.sources.some((s) => a.sources.includes(s.id))).toBe(false);
    const treeA = (await get(first, '/api/library/tree')).json() as LibraryTreeResponse;
    expect(treeA.sources.some((s) => b.sources.includes(s.id))).toBe(false);
    for (const id of a.sources) expect((await get(other, `/api/sources/${id}`)).statusCode).toBe(404);
    for (const id of b.sources) {
      const own = await get(other, `/api/sources/${id}`);
      expect(own.statusCode).toBe(200);
      expect((own.json() as SourceDetail).id).toBe(id);
    }
    // uploading into the other account's course is refused like an unknown node
    const res = await upload(other, a.course, [{ name: 'lecture_appendicitis.pdf', data: golden('lecture_appendicitis.pdf') }], { source_type: 'lecture' });
    expect([400, 404]).toContain(res.statusCode);
  });

  it('client-version gate: an R1-a PWA of user #1 keeps working; another account’s outdated client is asked to update', async () => {
    const strip = (h: AuthHeaders) => ({ cookie: h.cookie, 'x-medlevo-csrf': '1', accept: 'application/json' });
    const oldFirst = await t.app.inject({ method: 'GET', url: '/api/library/tree', headers: strip(first.h) });
    expect(oldFirst.statusCode).toBe(200);
    const oldFirstWrite = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: strip(first.h), payload: { parent_id: null, kind: 'notebook', title: 'الباطنية' } });
    expect(oldFirstWrite.statusCode).toBe(200);
    const oldOther = await t.app.inject({ method: 'GET', url: '/api/library/tree', headers: strip(other.h) });
    expect(oldOther.statusCode).toBe(426);
    expect(oldOther.json().error.code).toBe('CLIENT_TOO_OLD');
    const oldOtherWrite = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: strip(other.h), payload: { parent_id: null, kind: 'notebook', title: 'x' } });
    expect(oldOtherWrite.statusCode).toBe(426);
    // nothing was written by the refused request
    const treeB = (await get(other, '/api/library/tree')).json() as LibraryTreeResponse;
    expect(treeB.nodes.some((n) => n.title === 'x')).toBe(false);
  });
});
