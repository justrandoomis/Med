// G1 / AC-01 — personal library (§60, ARCHITECTURE §0.8 single owner). Server-wide checks that complement the
// library test and the E2E spec (e2e/g1-ac01-personal-library.spec.ts):
//   * NO registered route (of every module) is an institution / users / roles / subscription endpoint;
//   * the schema has no such table and the owner table can hold exactly one row;
//   * a second owner can never be created; a surgery notebook → course → lecture / reference / question source
//     library is built from the owner's own folders (no institution node kind is accepted).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LibraryTreeResponse } from '@medlevo/shared';
import { CSRF } from '../helpers/app';
import { api, createNode, golden, type Harness, makeHarness, uploadOk } from '../sources/helpers';

const FORBIDDEN = /user|member|role|tenant|organi[sz]ation|universit|faculty|college|subscri|billing|pricing|payment|cohort|invit|admin|team|seat|account/i;

let t: Harness;
beforeAll(async () => {
  t = await makeHarness();
}, 60_000);
afterAll(async () => {
  await t?.close();
});

describe('G1 AC-01 — personal library, single owner, no institution / users / subscription anywhere', () => {
  it('no route of any module is an institution / users / roles / subscription endpoint', () => {
    const routes = t.app.printRoutes({ commonPrefix: false });
    const lines = routes.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(100); // every module is mounted (sanity: the listing is real)
    expect(routes).toContain('/api/library/');
    expect(lines.filter((l) => FORBIDDEN.test(l))).toEqual([]);
  });

  it('the schema has no institution / user / subscription table; exactly one owner row is possible', () => {
    const tables = t.ctx.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name);
    expect(tables).toContain('owner');
    expect(tables.filter((n) => FORBIDDEN.test(n))).toEqual([]);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM owner')!.n).toBe(1);
    // the CHECK constraint keeps it at one row even for a direct write
    expect(() =>
      t.ctx.db.run(`INSERT INTO owner (id, username, password_hash, password_changed_at, created_at, updated_at) VALUES ('second', 'b', 'x', 0, 0, 0)`),
    ).toThrow();
  });

  it('a second owner cannot be created through setup', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/setup', headers: { ...CSRF }, payload: { username: 'second', password: 'another-person-123' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_SET_UP');
  });

  it('surgery notebook → course → lecture, reference and question source; institution kinds are refused', async () => {
    const nb = await createNode(t, { kind: 'notebook', title: 'الجراحة', cover: { style: 'linen', color: 'rose', symbol: 'syringe' } });
    const course = await createNode(t, { kind: 'course', title: 'Course 1 — البطن الحاد', parent_id: nb.id });
    const up = async (file: string, type: string) => (await uploadOk(t, course.id, [{ name: file, data: golden(file) }], { source_type: type })).results[0]!;
    const lecture = await up('lecture_appendicitis.pdf', 'lecture');
    const reference = await up('lecture_cholecystitis.pdf', 'course_reference');
    const questions = await up('questions_surgery_course1.pdf', 'question_source');
    for (const r of [lecture, reference, questions]) expect(r.status).toBe('accepted');
    const tree = (await api(t).get('/api/library/tree')).json() as LibraryTreeResponse;
    const mine = tree.sources.filter((s) => s.course_node_id === course.id);
    expect(mine.map((s) => s.source_type).sort()).toEqual(['course_reference', 'lecture', 'question_source']);
    for (const kind of ['university', 'institution', 'organization', 'cohort', 'class_group']) {
      const res = await api(t).post('/api/library/nodes', { parent_id: null, kind, title: 'x' });
      expect(res.statusCode, kind).toBe(400);
    }
    const caps = (await api(t).get('/api/capabilities')).json() as { features: Record<string, unknown> };
    expect(Object.keys(caps.features).filter((k) => FORBIDDEN.test(k))).toEqual([]);
  });
});
