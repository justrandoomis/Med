// AOS-21.5 (ARCHITECTURE_DELTA §4.2 «Courses»: a channel `course` node is shared; a user's personal `library_node` kind
// `course` stays in the vault, untouched) — the MAPPING from a user's personal course node to the shared channel course:
//   * a member maps a personal course node of HER vault to a channel subject («تابع المادة» with that node as the place
//     new lectures go), and reads the mapping back FROM THE PERSONAL SIDE: GET /api/channels/course-mappings
//     (?library_node_id=) names the subject, the shared channel course above it (with its term dates) and the node;
//   * new official lectures of the subject land in that personal course node; the node itself is not changed (kind,
//     title, parent);
//   * a deleted personal node shows the mapping as `library_node: null` and new lectures fall back to «موادي من القنوات»;
//   * the mapping is the viewer's own: another account sees none of it, and nobody can map another user's node.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelNodeView, CourseMappingsResponse, OfficialLectureView, UploadOfficialVersionResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { assignRole, call, createCode, createNode, ok, person, type Person } from './helpers';
import { lecturePdf, multipart, pagesFor } from '../lectures/world';
import { createProcessingApp } from '../processing/helpers';
import type { AuthHeaders, TestApp } from '../helpers/app';

let t: TestApp;
let pa: AuthHeaders;
let course: ChannelNodeView;
let subject: ChannelNodeView;
let mod: Person;
let maryam: Person;
let omar: Person;
let personalCourse: string;

const inVault = <T>(p: Person, fn: () => T): T => t.ctx.binding.run({ kind: 'vault', vaultId: t.ctx.system.vaults.ofUserInternal(p.user.id)!.id, viewer: null }, fn);
function libraryNode(p: Person, kind: 'course' | 'folder', title: string): string {
  return inVault(p, () => {
    const id = newId();
    const now = Date.now();
    t.ctx.db.run(`INSERT INTO library_node (id, parent_id, kind, title, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)`, [id, kind, title, now, now]);
    return id;
  });
}

async function publishOfficial(title: string): Promise<string> {
  const S = (rest: string) => `/api/spaces/${subject.space_id}${rest}`;
  const l = ok<OfficialLectureView>(await call(t, mod.h, 'POST', S('/lectures'), { title, lecture_no: 1 }));
  const mp = multipart({}, { name: `${title}.pdf`, data: lecturePdf(pagesFor(title, 1)) });
  const up = await t.app.inject({ method: 'POST', url: S(`/lectures/${l.id}/upload`), headers: { ...mod.h, 'content-type': mp.contentType }, payload: mp.body });
  expect(up.statusCode, up.body).toBe(200);
  const v = up.json() as UploadOfficialVersionResponse;
  await t.ctx.jobs.drain();
  ok(await call(t, mod.h, 'POST', S(`/lectures/${l.id}/versions/${v.version_id}/publish`), {}));
  await t.ctx.jobs.drain();
  await t.ctx.jobs.drain();
  return l.id;
}

beforeAll(async () => {
  t = await createProcessingApp();
  pa = await t.login();
  const uni = await createNode(t, pa, null, 'university', 'جامعة الاختبار');
  course = await createNode(t, pa, uni.id, 'course', 'الفصل الأول 2026', { starts_on: '2026-09-01', ends_on: '2027-01-31' });
  subject = await createNode(t, pa, course.id, 'subject', 'Pharmacology', { join_policy: 'open_with_code' });
  mod = await person(t, 'map-mod');
  maryam = await person(t, 'map-maryam');
  omar = await person(t, 'map-omar');
  await assignRole(t, pa, subject.id, mod.user.id, 'subject_moderator');
  const code = (await createCode(t, pa, subject.id, { requires_approval: false })).code!;
  for (const p of [maryam, omar]) ok(await call(t, p.h, 'POST', '/api/channels/join', { code }));
  personalCourse = libraryNode(maryam, 'course', 'مقرري: علم الأدوية');
}, 300_000);
afterAll(async () => {
  await t?.close();
});

const mappings = async (p: Person, q = '') => ok<CourseMappingsResponse>(await call(t, p.h, 'GET', `/api/channels/course-mappings${q}`)).mappings;

describe('AOS-21.5 — a personal course node mapped to the shared channel course', () => {
  it('Maryam maps her personal course node; the mapping reads back from the personal side with the channel course', async () => {
    expect(await mappings(maryam)).toEqual([]);
    ok(await call(t, maryam.h, 'PUT', `/api/channels/subjects/${subject.id}/follow`, { add_new_lectures: true, library_folder_id: personalCourse }));
    const all = await mappings(maryam);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      library_node_id: personalCourse,
      library_node: { id: personalCourse, kind: 'course', title: 'مقرري: علم الأدوية' },
      subject: { id: subject.id, kind: 'subject', title: 'Pharmacology' },
      course: { id: course.id, kind: 'course', title: 'الفصل الأول 2026', starts_on: '2026-09-01', ends_on: '2027-01-31' },
      add_new_lectures: true,
    });
    // filtered by the personal node
    expect(await mappings(maryam, `?library_node_id=${personalCourse}`)).toHaveLength(1);
    expect(await mappings(maryam, `?library_node_id=${newId()}`)).toEqual([]);
  });

  it('a new official lecture lands in the personal course node; the node itself is untouched', async () => {
    const before = inVault(maryam, () => t.ctx.db.get('SELECT id, parent_id, kind, title FROM library_node WHERE id = ?', [personalCourse]));
    await publishOfficial('Lecture 1 Autonomic drugs');
    const placed = inVault(maryam, () => t.ctx.db.all<{ title: string }>('SELECT title FROM source WHERE node_id = ? AND deleted_at IS NULL', [personalCourse]));
    expect(placed.map((s) => s.title).join(' ')).toContain('Autonomic');
    expect(inVault(maryam, () => t.ctx.db.get('SELECT id, parent_id, kind, title FROM library_node WHERE id = ?', [personalCourse]))).toEqual(before);
  });

  it("the mapping is Maryam's own: Omar sees none of it and cannot map her node", async () => {
    expect(await mappings(omar)).toEqual([]);
    expect(await mappings(omar, `?library_node_id=${personalCourse}`)).toEqual([]);
    const res = await call(t, omar.h, 'PUT', `/api/channels/subjects/${subject.id}/follow`, { add_new_lectures: true, library_folder_id: personalCourse });
    expect(res.statusCode).toBe(400);
  });

  it('a deleted personal node: the mapping says so, and new lectures go to «موادي من القنوات»', async () => {
    inVault(maryam, () => t.ctx.db.run('UPDATE library_node SET deleted_at = ? WHERE id = ?', [Date.now(), personalCourse]));
    const m = await mappings(maryam);
    expect(m[0]).toMatchObject({ library_node_id: personalCourse, library_node: null });
    await publishOfficial('Lecture 2 Antibiotics');
    const inDeleted = inVault(maryam, () => t.ctx.db.all<{ title: string }>('SELECT title FROM source WHERE node_id = ? AND title LIKE ?', [personalCourse, '%Antibiotics%']));
    expect(inDeleted).toEqual([]);
    const anywhere = inVault(maryam, () => t.ctx.db.all<{ title: string }>("SELECT title FROM source WHERE title LIKE '%Antibiotics%' AND deleted_at IS NULL"));
    expect(anywhere).toHaveLength(1);
  });

  it('unfollowing ends the mapping', async () => {
    ok(await call(t, maryam.h, 'DELETE', `/api/channels/subjects/${subject.id}/follow`));
    expect(await mappings(maryam)).toEqual([]);
  });
});
