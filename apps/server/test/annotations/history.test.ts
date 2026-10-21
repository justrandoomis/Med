// P1-T2 step 2 — version history (PRD AOS-4.15 Phase 1; ARCHITECTURE_DELTA §4.3, §6.6; ADR-0004 §2.8): every update,
// delete and restore writes a before-image in the same transaction; the per-layer history list shows author, time and
// action; nothing is restored from it yet; a purge removes the revisions (purge extension).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPersonalLayerId, newId, type ImpactReport, type LayerHistoryPage, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { createSourceFixture, inkData, inkPayload, notePayload, op, pageAnchor, rt, type SourceFixture } from './helpers';

let t: TestApp;
let h: AuthHeaders;
let f: SourceFixture;
let doc: string;

beforeEach(async () => {
  t = await createTestApp();
  h = await t.login();
  f = createSourceFixture(t);
  doc = `source:${f.sourceId}`;
});
afterEach(async () => {
  await t.close();
});

async function push1(o: SyncOp): Promise<SyncOpResult> {
  const res = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops: [o] } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().results[0] as SyncOpResult;
}
const revisions = (id: string) =>
  t.ctx.db.all<{ rev: number; action: string; snap_rev: number; snap_data: string; op_id: string | null; layer_id: string | null; document_key: string | null }>(
    `SELECT rev, action, json_extract(snapshot_json, '$.rev') AS snap_rev, json_extract(snapshot_json, '$.data_json') AS snap_data, op_id, layer_id, document_key
     FROM annotation_revision WHERE entity_id = ? ORDER BY rev`,
    [id],
  );
const history = async (layerId: string, query = '') => {
  const res = await t.app.inject({ method: 'GET', url: `/api/annotations/layers/${layerId}/history?document_key=${doc}${query}`, headers: h });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as LayerHistoryPage;
};

describe('annotation_revision — a before-image of every change, in the same transaction', () => {
  it('update, delete and restore of a stroke each keep the full row as it was; creating keeps nothing (it is the current row)', async () => {
    const id = newId();
    await push1(op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: inkPayload(f) }));
    expect(revisions(id)).toEqual([]);
    const before1 = t.ctx.db.get<{ data_json: string }>('SELECT data_json FROM annotation WHERE id = ?', [id])!.data_json;
    const edit = op({ entity_type: 'annotation', entity_id: id, base_rev: 1, payload: { ...inkPayload(f), data: inkData(0.5) } });
    await push1(edit);
    const del = op({ entity_type: 'annotation', entity_id: id, op: 'delete', base_rev: 2 });
    await push1(del);
    // an edit that arrives after the delete brings the stroke back (it is kept) — and that is recorded too
    await push1(op({ entity_type: 'annotation', entity_id: id, base_rev: 2, payload: { ...inkPayload(f), data: inkData(0.6) } }));
    const revs = revisions(id);
    expect(revs.map((r) => [r.rev, r.action, r.snap_rev])).toEqual([
      [1, 'update', 1],
      [2, 'delete', 2],
      [3, 'restore', 3],
    ]);
    expect(revs[0]!.snap_data).toBe(before1);
    expect(revs[0]!.op_id).toBe(edit.op_id);
    expect(revs[1]!.op_id).toBe(del.op_id);
    expect(revs.every((r) => r.layer_id === null && r.document_key === doc)).toBe(true);
    // a retried op (same op_id) never writes a second before-image
    await push1(edit);
    expect(revisions(id)).toHaveLength(3);
  });

  it('notes and layers get before-images too; a refused op writes none', async () => {
    const n = newId();
    await push1(op({ entity_type: 'note', entity_id: n, payload: notePayload(f, 'نص أول') }));
    await push1(op({ entity_type: 'note', entity_id: n, base_rev: 1, payload: notePayload(f, 'نص ثانٍ') }));
    await push1(op({ entity_type: 'note', entity_id: n, op: 'delete', base_rev: 2 }));
    expect(t.ctx.db.all<{ action: string; body: string }>(`SELECT action, json_extract(snapshot_json, '$.body_json') AS body FROM annotation_revision WHERE entity_id = ? ORDER BY rev`, [n]).map((r) => [r.action, JSON.parse(r.body).paragraphs[0].runs[0].t])).toEqual([
      ['update', 'نص أول'],
      ['delete', 'نص ثانٍ'],
    ]);
    const L = newId();
    await push1(op({ entity_type: 'annotation_layer', entity_id: L, payload: { id: L, document_key: doc, kind: 'answers', title: 'إجابات' } }));
    await push1(op({ entity_type: 'annotation_layer', entity_id: L, base_rev: 1, payload: { id: L, document_key: doc, kind: 'answers', title: 'إجابات', visible: false } }));
    expect(t.ctx.db.get(`SELECT action, layer_id FROM annotation_revision WHERE entity_type = 'annotation_layer' AND entity_id = ?`, [L])).toEqual({ action: 'update', layer_id: L });
    // a refused op (an unknown layer) changes nothing and records no history
    const count = () => t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation_revision')!.n;
    const before = count();
    const a = newId();
    await push1(op({ entity_type: 'annotation', entity_id: a, op: 'append', payload: inkPayload(f) }));
    expect((await push1(op({ entity_type: 'annotation', entity_id: a, base_rev: 1, payload: { ...inkPayload(f), layer_id: 'NOPE' } }))).result).toBe('rejected');
    expect(count()).toBe(before);
  });

  it('the owner’s manual re-anchoring (Round 7) keeps a before-image as well', async () => {
    const id = newId();
    await push1(op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: inkPayload(f) }));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/annotations/reanchor',
      headers: h,
      payload: { action: 'move', items: [{ kind: 'annotation', id, rev: 1 }], target: { type: 'page', source_id: f.sourceId, version_id: f.versionId, page_id: f.pageIds[2] } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const revs = revisions(id);
    expect(revs).toHaveLength(1);
    expect(JSON.parse(t.ctx.db.get<{ s: string }>(`SELECT snapshot_json AS s FROM annotation_revision WHERE entity_id = ?`, [id])!.s).anchor_json).toBe(JSON.stringify(pageAnchor(f, 0)));
  });
});

describe('the layer history list (read-only)', () => {
  it('shows who (you), when and what — newest first — with the page; pages through with next_before', async () => {
    const def = defaultPersonalLayerId(doc);
    const a = newId();
    t.clock.set(t.clock.now() + 1000);
    await push1(op({ entity_type: 'annotation', entity_id: a, op: 'append', payload: inkPayload(f, { pageIndex: 1 }) }));
    t.clock.set(t.clock.now() + 1000);
    await push1(op({ entity_type: 'annotation', entity_id: a, base_rev: 1, payload: { ...inkPayload(f, { pageIndex: 1 }), data: inkData(0.4) } }));
    t.clock.set(t.clock.now() + 1000);
    await push1(op({ entity_type: 'annotation', entity_id: a, op: 'delete', base_rev: 2 }));
    t.clock.set(t.clock.now() + 1000);
    const n = newId();
    await push1(op({ entity_type: 'note', entity_id: n, payload: { title: null, body: rt('سؤال'), anchor: pageAnchor(f, 0) } }));

    const page = await history(def);
    expect(page.entries.map((e) => [e.action, e.item_kind, e.actor_label_ar])).toEqual([
      ['create', 'note', 'أنت'],
      ['delete', 'ink', 'أنت'],
      ['update', 'ink', 'أنت'],
      ['create', 'ink', 'أنت'],
    ]);
    expect(page.entries[1]!.summary_ar).toMatch(/^حُذفت كتابة بالقلم — ص 12/);
    expect(page.entries[3]!.summary_ar).toMatch(/^أُضيفت كتابة بالقلم — ص 12/);
    expect(page.entries[0]!.summary_ar).toMatch(/^أُضيفت ملاحظة — ص 11/);
    expect(page.entries[2]!.page_label_ar).toMatch(/^ص 12/);
    expect(page.entries[1]!.at).toBeGreaterThan(page.entries[2]!.at);
    expect(page.next_before).toBeNull();
    const first = await history(def, '&limit=2');
    expect(first.entries).toHaveLength(2);
    const rest = await history(def, `&limit=2&before=${encodeURIComponent(first.next_before!)}`);
    expect([...first.entries, ...rest.entries].map((e) => `${e.action}:${e.entity_id}`)).toEqual(page.entries.map((e) => `${e.action}:${e.entity_id}`));
  });

  it('lists only the layer asked for; an unknown layer is 404', async () => {
    const L = newId();
    await push1(op({ entity_type: 'annotation_layer', entity_id: L, payload: { id: L, document_key: doc, kind: 'answers', title: 'إجابات' } }));
    await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: inkPayload(f) }));
    const onL = newId();
    await push1(op({ entity_type: 'annotation', entity_id: onL, op: 'append', payload: { ...inkPayload(f), layer_id: L } }));
    const page = await history(L);
    expect(page.entries.map((e) => e.entity_id)).toEqual([onL]);
    expect((await t.app.inject({ method: 'GET', url: '/api/annotations/layers/NOPE/history', headers: h })).statusCode).toBe(404);
  });
});

describe('purge removes the history with the items (purge extension)', () => {
  it('lists the counts in the preview and deletes revisions, attribution and the document’s layers', async () => {
    const L = newId();
    await push1(op({ entity_type: 'annotation_layer', entity_id: L, payload: { id: L, document_key: doc, kind: 'answers', title: 'إجابات' } }));
    const a = newId();
    await push1(op({ entity_type: 'annotation', entity_id: a, op: 'append', payload: { ...inkPayload(f), layer_id: L } }));
    await push1(op({ entity_type: 'annotation', entity_id: a, base_rev: 1, payload: { ...inkPayload(f), data: inkData(0.5), layer_id: L } }));
    // an unrelated document keeps everything
    const other = createSourceFixture(t, 'محاضرة أخرى');
    const b = newId();
    await push1(op({ entity_type: 'annotation', entity_id: b, op: 'append', payload: inkPayload(other) }));
    await push1(op({ entity_type: 'annotation', entity_id: b, base_rev: 1, payload: { ...inkPayload(other), data: inkData(0.5) } }));

    expect((await t.app.inject({ method: 'POST', url: `/api/sources/${f.sourceId}/trash`, headers: h })).statusCode).toBe(200);
    const impact = (await t.app.inject({ method: 'GET', url: `/api/sources/${f.sourceId}/impact?mode=purge`, headers: h })).json() as ImpactReport;
    expect(impact.lines_ar.join('\n')).toMatch(/1 من طبقات الملاحظات/);
    expect(impact.lines_ar.join('\n')).toMatch(/1 من نسخ سجل التعديلات/);
    const res = await t.app.inject({ method: 'DELETE', url: `/api/sources/${f.sourceId}?confirm_token=${encodeURIComponent(impact.confirm_token!)}`, headers: h });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().removed.extensions['annotations.layers']).toEqual({ layers: 1, revisions: 1, attributions: 0 });
    expect(t.ctx.db.get('SELECT 1 AS x FROM annotation_layer WHERE id = ?', [L])).toBeUndefined();
    expect(t.ctx.db.all(`SELECT entity_id FROM annotation_revision`)).toEqual([{ entity_id: b }]);
    // the deleted layer is announced to the owner's devices
    const pulled = (await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: h })).json();
    expect(pulled.changes.find((c: { entity_id: string }) => c.entity_id === L)).toMatchObject({ entity_type: 'annotation_layer', entity: null });
  });
});
