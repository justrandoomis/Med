// P1-T5 step 3 — course-only publications in the subject's space (BUILD_PLAN §3.7 «test/forks/publications.test.ts»;
// ARCHITECTURE_DELTA §6.4, §7.6; ADR-0004 §2.4; PRD AOS-2.8, 4.14, 4.18, 5.12, 5.24, 5.27, 21.16, Scenario 2 step 1/5):
//   * publish course-only: an immutable snapshot of the author's chosen layers, items under STABLE ids, attribution,
//     completeness as numbers, labelled «شرح طالب — ليس مصدرًا»; what the snapshot leaves out is counted and said;
//   * the live head: a republish writes rows only for added / changed items and closes changed / removed ones; the same
//     content again is a no-op; one changed stroke out of 5 000 writes ONE publication_item row;
//   * reads: the per-lecture list («الشروحات»), the publication page, the items of a version, the diff of two versions;
//   * members of THIS subject only: a non-member, a pending member and another subject's moderator get the body of a
//     missing route; author-only actions answer 403 to a member who can see the publication.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LecturePublicationsResponse, PublicationItemsResponse, PublicationView, UpstreamPreview } from '@medlevo/shared';
import { inkDataForClient, STUDENT_EXPLANATION_LABEL_AR } from '@medlevo/shared';
import { call, missingRouteBody, ok } from '../channels/helpers';
import { createLayer, createPubWorld, publish, push, op, startPersonal, strokes, textBox, type PubWorld } from './pubWorld';

let w: PubWorld;
let layer: string;
let pub: PublicationView;
const v1Strokes: string[] = [];

beforeAll(async () => {
  w = await createPubWorld(6);
  await startPersonal(w, 'hasan');
  layer = await createLayer(w, 'hasan', 'شرحي');
  // Scenario 2 step 1: 12 strokes on p.1–3 and 2 text boxes, in «شرحي»
  v1Strokes.push(...(await strokes(w, 'hasan', layer, 0, 4)), ...(await strokes(w, 'hasan', layer, 1, 4)), ...(await strokes(w, 'hasan', layer, 2, 4)));
  await textBox(w, 'hasan', layer, 0, 'الجذع البطني');
  await textBox(w, 'hasan', layer, 2, 'الشريان المساريقي');
}, 300_000);
afterAll(async () => {
  await w?.close();
});

const spaceRows = (sql: string, params: unknown[] = []) => w.t.ctx.dbs.space(w.space).all<Record<string, unknown>>(sql, params as never[]);

describe('publish course-only (Scenario 2 step 1)', () => {
  it('publishes the chosen layer as version 1: stable items, completeness in numbers, the student label', async () => {
    pub = await publish(w, 'hasan', [layer], 'شرح حسن للمحاضرة 5');
    expect(pub.head_version_no).toBe(1);
    expect(pub.status).toBe('active');
    expect(pub.visibility).toBe('course');
    expect(pub.kind).toBe('explanation');
    expect(pub.author.id).toBe(w.p.hasan.user.id);
    expect(pub.origin_label_ar).toBe(STUDENT_EXPLANATION_LABEL_AR);
    expect(pub.completeness).toEqual({ pages_covered: 3, pages_total: 6 });
    expect(pub.versions.map((v) => [v.no, v.lecture_version_no, v.item_count])).toEqual([[1, 1, 14]]);
    expect(pub.viewer.can_edit).toBe(true);
    expect(pub.viewer.source_layer_ids).toEqual([layer]);
    expect(pub.snapshot).toEqual({ items: 14, skipped: [] });
    // the space holds the immutable content: one version, 14 rows valid from 1
    expect(spaceRows('SELECT version_no, item_count, pages_covered, pages_total FROM publication_version WHERE publication_id = ?', [pub.id])).toEqual([
      { version_no: 1, item_count: 14, pages_covered: 3, pages_total: 6 },
    ]);
    expect(spaceRows('SELECT COUNT(*) AS n FROM publication_item WHERE publication_id = ? AND valid_from = 1 AND valid_to IS NULL', [pub.id])).toEqual([{ n: 14 }]);
    // the system index: the live head and nothing of the content
    const row = w.t.ctx.system.db.get<Record<string, unknown>>('SELECT * FROM publication WHERE id = ?', [pub.id])!;
    expect(row).toMatchObject({ space_id: w.space, lecture_id: w.lecture.id, subject_node_id: w.subject.id, author_user_id: w.p.hasan.user.id, head_version_no: 1, status: 'active' });
  });

  it('the same Idempotency-Key returns the same publication (a retried POST after a lost answer)', async () => {
    const other = await createLayer(w, 'hasan', 'إجابات');
    await strokes(w, 'hasan', other, 3, 1);
    const a = await publish(w, 'hasan', [other], 'إجاباتي', {}, { 'idempotency-key': 'pub-key-1' });
    const b = await publish(w, 'hasan', [other], 'إجاباتي', {}, { 'idempotency-key': 'pub-key-1' });
    expect(b.id).toBe(a.id);
    expect(w.t.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM publication WHERE author_user_id = ? AND client_key = ?', [w.p.hasan.user.id, 'pub-key-1'])!.n).toBe(1);
    // withdraw it again so the list below has only Scenario 2's explanation
    ok(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${a.id}/withdraw`), {}));
  });

  it('what the snapshot leaves out is counted with the reason; a layer with nothing publishable is refused', async () => {
    const mixed = await createLayer(w, 'hasan', 'مختلط');
    await strokes(w, 'hasan', mixed, 4, 2);
    const bm = await push(w, 'hasan', [
      op({ entity_type: 'annotation', entity_id: `BM${Date.now()}`, payload: { kind: 'bookmark', tool: null, anchor: { type: 'page', source_id: w.lecture.sourceId, version_id: w.lecture.versionId, page_id: w.lecture.pageIds[4]!, page_index: 4, space: 'page_norm' }, data: { v: 1, label: 'مهم' }, layer: 'ink', z: 0, locked: false, layer_id: mixed } }),
    ]);
    expect(bm[0]!.result).toBe('applied');
    const p2 = await publish(w, 'hasan', [mixed], 'شرح مختلط');
    expect(p2.snapshot!.items).toBe(2);
    expect(p2.snapshot!.skipped).toEqual([{ reason_ar: expect.stringContaining('العلامات المرجعية'), items: 1 }]);
    ok(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${p2.id}/withdraw`), {}));

    const empty = await createLayer(w, 'hasan', 'فارغة');
    const res = await call(w.t, w.p.hasan.h, 'POST', w.S('/publications'), { lecture_id: w.lecture.id, layer_ids: [empty], title: 'لا شيء', kind: 'explanation', visibility: 'course' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('لا يوجد');
  });

  it('refuses layers that are not the author’s own writing, note pages (not in Phase 1) and Phase 2 visibilities', async () => {
    // another user's layer id is simply not in the author's vault
    const zLayer = await createLayer(w, 'zainab', 'شرح زينب');
    const res = await call(w.t, w.p.hasan.h, 'POST', w.S('/publications'), { lecture_id: w.lecture.id, layer_ids: [zLayer], title: 'x', kind: 'explanation', visibility: 'course' });
    expect(res.statusCode).toBe(404);
    const np = await call(w.t, w.p.hasan.h, 'POST', w.S('/publications'), { lecture_id: w.lecture.id, layer_ids: [layer], note_page_ids: ['NP1'], title: 'x', kind: 'explanation', visibility: 'course' });
    expect(np.statusCode).toBe(409);
    const pub2 = await call(w.t, w.p.hasan.h, 'POST', w.S('/publications'), { lecture_id: w.lecture.id, layer_ids: [layer], title: 'x', kind: 'explanation', visibility: 'public' });
    expect(pub2.statusCode).toBe(400);
  });
});

describe('reads: «الشروحات», the publication page, items of a version', () => {
  it('lists the active explanations of the lecture for members, newest first, with the student label', async () => {
    const list = ok<LecturePublicationsResponse>(await call(w.t, w.p.zainab.h, 'GET', w.S(`/lectures/${w.lecture.id}/publications`)));
    expect(list.items.map((c) => c.id)).toEqual([pub.id]);
    expect(list.items[0]).toMatchObject({ title: 'شرح حسن للمحاضرة 5', head_version_no: 1, completeness: { pages_covered: 3, pages_total: 6 }, label_ar: STUDENT_EXPLANATION_LABEL_AR });
    expect(list.items[0]!.author.display_name).toBeTruthy();
  });

  it('a member reads the publication page and the items of version 1 (stable ids, the author, ink v2 on request)', async () => {
    const v = ok<PublicationView>(await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}`)));
    expect(v.viewer).toMatchObject({ copy: null, can_edit: false, source_layer_ids: null, can_report: true });
    expect(v.snapshot).toBeNull();
    const items = ok<PublicationItemsResponse>(await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}/versions/1/items`)));
    expect(items.items).toHaveLength(14);
    expect(items.notes).toEqual([]);
    expect(items.redacted).toBe(false);
    expect(new Set(items.items.map((i) => i.author_user_id))).toEqual(new Set([w.p.hasan.user.id]));
    // stable ids: never the author's own item ids (those stay in his vault)
    for (const i of items.items) expect(v1Strokes).not.toContain(i.id);
    const page2 = ok<PublicationItemsResponse>(await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}/versions/1/items?page_id=${w.lecture.pageIds[1]}`)));
    expect(page2.items).toHaveLength(4);
    const v2ink = ok<PublicationItemsResponse>(await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}/versions/1/items?page_id=${w.lecture.pageIds[1]}`), undefined, { 'accept-ink': '2' }));
    // ink v2 for a client that asks for it: exactly what the shared codec gives for each v1 stroke
    for (const [i, it] of v2ink.items.entries()) expect(it.data).toEqual(inkDataForClient('ink', page2.items[i]!.data, 2));
    const missing = await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}/versions/9/items`));
    expect(missing.statusCode).toBe(404);
  });

  it('a non-member, a pending member and another subject’s moderator get the body of a missing route', async () => {
    const body = await missingRouteBody(w.t, w.p.ahmad.h);
    for (const who of ['ahmad', 'physio', 'modB'] as const) {
      for (const url of [w.S(`/lectures/${w.lecture.id}/publications`), w.S(`/publications/${pub.id}`), w.S(`/publications/${pub.id}/versions/1/items`), w.S(`/publications/${pub.id}/diff?from=1&to=2`)]) {
        const res = await call(w.t, w.p[who].h, 'GET', url);
        expect(res.statusCode, `${who} ${url}`).toBe(404);
        expect(res.body, `${who} ${url}`).toBe(body);
      }
    }
    // a publication of subject A asked for through subject B's space: missing as well
    const cross = await call(w.t, w.p.physio.h, 'GET', `/api/spaces/${w.otherSpace}/publications/${pub.id}`);
    expect(cross.statusCode).toBe(404);
  });

  it('author-only actions: 403 to a member who sees it, never a change', async () => {
    for (const [m, url, body] of [
      ['POST', w.S(`/publications/${pub.id}/versions`), { layer_ids: [layer], change_note: null }],
      ['PATCH', w.S(`/publications/${pub.id}`), { title: 'عنوان آخر' }],
      ['POST', w.S(`/publications/${pub.id}/withdraw`), {}],
    ] as const) {
      const res = await call(w.t, w.p.zainab.h, m, url, body);
      expect(res.statusCode, `${m} ${url}`).toBe(403);
    }
    expect(ok<PublicationView>(await call(w.t, w.p.hasan.h, 'GET', w.S(`/publications/${pub.id}`))).title).toBe('شرح حسن للمحاضرة 5');
  });
});

describe('the live head: republish writes deltas only (ADR-0004 §2.4)', () => {
  it('the same content again is a no-op that returns the head', async () => {
    const again = ok<PublicationView>(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${pub.id}/versions`), { layer_ids: [layer], change_note: 'لا شيء' }));
    expect(again.head_version_no).toBe(1);
    expect(spaceRows('SELECT COUNT(*) AS n FROM publication_version WHERE publication_id = ?', [pub.id])).toEqual([{ n: 1 }]);
  });

  it('Scenario 2 step 5: moves one stroke, deletes another, adds 6 on p.4 → version 2 with 7 rows written and 2 closed', async () => {
    const moved = v1Strokes[0]!;
    const removed = v1Strokes[1]!;
    const before = spaceRows('SELECT item_id FROM publication_item WHERE publication_id = ?', [pub.id]).length;
    const r1 = await push(w, 'hasan', [
      op({ entity_type: 'annotation', entity_id: moved, payload: { kind: 'ink', tool: 'pen', anchor: { type: 'page', source_id: w.lecture.sourceId, version_id: w.lecture.versionId, page_id: w.lecture.pageIds[0]!, page_index: 0, space: 'page_norm' }, data: { v: 1, points: [[0.5, 0.5, 0, 0.5], [0.6, 0.55, 16, 0.5], [0.7, 0.6, 32, 0.5]], style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.1 }, pressure_available: true, tilt_available: false }, layer: 'ink', z: 0, locked: false, layer_id: layer }, base_rev: 1 }),
      op({ entity_type: 'annotation', entity_id: removed, op: 'delete', payload: {}, base_rev: 1 }),
    ]);
    for (const r of r1) expect(['applied', 'merged']).toContain(r.result);
    await strokes(w, 'hasan', layer, 3, 6);
    const v2 = ok<PublicationView>(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${pub.id}/versions`), { layer_ids: [layer], change_note: 'نقلت خطًا وأضفت 6 خطوط في الصفحة 4.' }));
    expect(v2.head_version_no).toBe(2);
    expect(v2.versions.map((v) => [v.no, v.change_note, v.item_count])).toEqual([
      [1, null, 14],
      [2, 'نقلت خطًا وأضفت 6 خطوط في الصفحة 4.', 19],
    ]);
    expect(v2.completeness).toEqual({ pages_covered: 4, pages_total: 6 });
    const after = spaceRows('SELECT item_id FROM publication_item WHERE publication_id = ?', [pub.id]).length;
    expect(after - before).toBe(7); // 6 added + 1 changed; unchanged items cost nothing
    expect(spaceRows('SELECT COUNT(*) AS n FROM publication_item WHERE publication_id = ? AND valid_to = 2', [pub.id])).toEqual([{ n: 2 }]);
    const diff = ok<UpstreamPreview>(await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}/diff?from=1&to=2`)));
    expect(diff.counts).toEqual({ added: 6, removed: 1, changed: 1 });
    expect(diff.summary_ar).toBe('أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1');
    expect(diff.change_note).toBe('نقلت خطًا وأضفت 6 خطوط في الصفحة 4.');
    expect(diff.personal_items_affected).toBe(0);
    expect(diff.pages.map((p) => [p.page.page_index, p.added, p.removed, p.changed])).toEqual([
      [0, 0, 1, 1],
      [3, 6, 0, 0],
    ]);
    // unchanged items keep their stable ids in version 2
    const i1 = ok<PublicationItemsResponse>(await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}/versions/1/items`))).items.map((i) => i.id);
    const i2 = ok<PublicationItemsResponse>(await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}/versions/2/items`))).items.map((i) => i.id);
    expect(i1.filter((id) => i2.includes(id))).toHaveLength(13);
    expect(i2).toHaveLength(19);
  });

  it('a version never changes: PATCH changes only the title and summary of the publication', async () => {
    const p = ok<PublicationView>(await call(w.t, w.p.hasan.h, 'PATCH', w.S(`/publications/${pub.id}`), { title: 'شرح حسن', summary: 'ص 1–4' }));
    expect(p).toMatchObject({ title: 'شرح حسن', summary: 'ص 1–4', head_version_no: 2 });
    expect(spaceRows('SELECT COUNT(*) AS n FROM publication_version WHERE publication_id = ?', [pub.id])).toEqual([{ n: 2 }]);
  });
});

describe('scale: one changed stroke out of 5 000 (ARCHITECTURE_DELTA §6.8)', () => {
  it('writes one publication_item row and the follower would pull one stroke', async () => {
    const big = await createLayer(w, 'hasan', 'شرح كبير');
    const ids = await strokes(w, 'hasan', big, 5, 5000);
    const t0 = Date.now();
    const p = await publish(w, 'hasan', [big], 'شرح كبير');
    const publishMs = Date.now() - t0;
    expect(p.versions[0]!.item_count).toBe(5000);
    const before = spaceRows('SELECT COUNT(*) AS n FROM publication_item WHERE publication_id = ?', [p.id])[0]!.n as number;
    await push(w, 'hasan', [
      op({ entity_type: 'annotation', entity_id: ids[42]!, payload: { kind: 'ink', tool: 'pen', anchor: { type: 'page', source_id: w.lecture.sourceId, version_id: w.lecture.versionId, page_id: w.lecture.pageIds[5]!, page_index: 5, space: 'page_norm' }, data: { v: 1, points: [[0.9, 0.9, 0, 0.5], [0.91, 0.91, 16, 0.5]], style: { tool: 'pen', color: 'ink-red', width: 0.0025 }, bbox: { x: 0.9, y: 0.9, w: 0.01, h: 0.01 }, pressure_available: true, tilt_available: false }, layer: 'ink', z: 0, locked: false, layer_id: big }, base_rev: 1 }),
    ]);
    const t1 = Date.now();
    const v2 = ok<PublicationView>(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${p.id}/versions`), { layer_ids: [big], change_note: null }));
    const republishMs = Date.now() - t1;
    expect(v2.head_version_no).toBe(2);
    const after = spaceRows('SELECT COUNT(*) AS n FROM publication_item WHERE publication_id = ?', [p.id])[0]!.n as number;
    expect(after - before).toBe(1);
    const diff = ok<UpstreamPreview>(await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${p.id}/diff?from=1&to=2`)));
    expect(diff.counts).toEqual({ added: 0, removed: 0, changed: 1 });
    // measured here (one process, no other load): recorded in docs/modules/copies-publications.md
    console.log(`[P1-T5 s3] publish 5000 strokes: ${publishMs} ms; republish with 1 changed: ${republishMs} ms`);
    expect(publishMs).toBeLessThan(20_000);
    ok(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${p.id}/withdraw`), {}));
  }, 120_000);
});
