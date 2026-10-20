// Round 7 — H3 (reader, writing & notes completeness): server-side regressions, each written to FAIL before its fix.
//  * item 7 — a note page whose notebook was purged while a device was offline (and that follows no source) was saved
//    with neither link: kept on the server but listed nowhere. GET /api/annotations/orphan-pages now lists it (with
//    what is written on it) so the owner can move it into a notebook or delete it.
//  * item 2 — manual re-anchoring: POST /api/annotations/reanchor moves a note / highlight / ink group to a place the
//    owner chose (a page, a paragraph on a page) or keeps it detached; previous anchor kept, revision checked, audited.
//  * item 10 — a purge's prune removed a picture whose only server annotation was purged, while an offline device still
//    had a queued copy with the same image_key (that copy then showed «لم تصل الصورة إلى الخادم بعد» everywhere).
import { crc32, deflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type ImageAnnotationData, type ImpactReport, type NeedsReanchorResponse, type NotePagesResponse, type OrphanNotePagesResponse, type ReanchorResponse, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { pruneAnnotationImages, UNREFERENCED_GRACE_MS } from '../../src/modules/annotations/images';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { multipart } from '../sources/helpers';
import { createSourceFixture, inkData, op, pageAnchor, type SourceFixture } from './helpers';

let t: TestApp;
let h: AuthHeaders;
let f: SourceFixture;

beforeEach(async () => {
  t = await createTestApp();
  h = await t.login();
  f = createSourceFixture(t);
});
afterEach(async () => {
  await t.close();
});

async function push(ops: SyncOp[]): Promise<SyncOpResult[]> {
  const res = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops } });
  expect(res.statusCode).toBe(200);
  return res.json().results as SyncOpResult[];
}
const push1 = async (o: SyncOp) => (await push([o]))[0]!;
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: h });
const count = (sql: string, params: unknown[] = []) => t.ctx.db.get<{ n: number }>(sql, params)!.n;

async function createNode(title = 'دفتر', kind = 'notebook'): Promise<string> {
  const res = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: h, payload: { parent_id: null, kind, title } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { node: { id: string } }).node.id;
}
const notePage = (o: Record<string, unknown>) => ({ template: 'ruled', width: 595, height: 842, sort_order: 1, title: null, ...o });
const noteAnchor = (id: string) => ({ type: 'note_page' as const, note_page_id: id, space: 'page_norm' as const });

function png(w = 3, hgt = 2, seed = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(hgt, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(hgt * (1 + w * 3));
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w * 3; x++) raw[y * (1 + w * 3) + 1 + x] = (x * 40 + y * 90 + seed) & 0xff;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function uploadImage(key: string, data: Buffer) {
  const body = multipart({ image_key: key, device_id: 'DEVICE_A' }, [{ name: 'p.png', data, contentType: 'image/png', field: 'file' }]);
  const res = await t.app.inject({ method: 'POST', url: '/api/annotations/images', headers: { ...h, 'content-type': body.contentType }, payload: body.payload });
  expect(res.statusCode).toBe(200);
}
const imageData = (key: string): ImageAnnotationData => ({ v: 1, image_key: key, box: { x: 0.2, y: 0.3, w: 0.4, h: 0.2 }, mime: 'image/png', natural_w: 3, natural_h: 2, bytes: 100, alt: null, name: 'p.png' });
const imageAnnotation = (anchor: unknown, key: string) => ({ kind: 'image', tool: 'image', anchor, data: imageData(key), layer: 'media', z: 0, locked: false });

async function purgeNode(nodeId: string): Promise<void> {
  await t.app.inject({ method: 'POST', url: `/api/library/nodes/${nodeId}/trash`, headers: h });
  const impact = (await get(`/api/library/nodes/${nodeId}/impact?mode=purge`)).json() as ImpactReport;
  const res = await t.app.inject({ method: 'DELETE', url: `/api/library/nodes/${nodeId}?confirm_token=${encodeURIComponent(impact.confirm_token!)}`, headers: h });
  expect(res.statusCode).toBe(200);
}

describe('H3 item 10 — prune after a purge keeps a released picture for a grace period', () => {
  it('a copy with the same image_key still queued on an offline device finds its picture when it syncs after the purge', async () => {
    const key = newId();
    await uploadImage(key, png(4, 3, 7));
    // device A: the picture on a notebook page (synced, so the upload is «referenced»)
    const nodeA = await createNode('دفتر الجهاز الأول');
    const pageA = newId();
    await push1(op({ entity_type: 'note_page', entity_id: pageA, payload: notePage({ node_id: nodeA }) }));
    await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: imageAnnotation(noteAnchor(pageA), key) }));
    const fileId = t.ctx.db.get<{ file_id: string }>('SELECT file_id FROM annotation_image WHERE image_key = ?', [key])!.file_id;
    const blob = t.ctx.files.path(fileId);

    // device B (offline) pasted the same picture on a lecture page: its append is still queued. Device A purges.
    await purgeNode(nodeA);
    expect(count("SELECT COUNT(*) AS n FROM annotation WHERE kind = 'image'")).toBe(0);
    // the picture is RELEASED, not removed: an offline device may still hold a queued copy with this key
    expect(count('SELECT COUNT(*) AS n FROM annotation_image WHERE image_key = ?', [key])).toBe(1);
    expect(existsSync(blob)).toBe(true);
    expect(pruneAnnotationImages(t.ctx)).toBe(0);

    // a day later device B comes online: its copy arrives and the picture is still served
    t.clock.advance(24 * 60 * 60 * 1000);
    const copy = newId();
    const r = await push1({ ...op({ entity_type: 'annotation', entity_id: copy, op: 'append', payload: imageAnnotation(pageAnchor(f, 1), key) }), device_id: 'DEVICE_B' });
    expect(r.result).toBe('applied');
    expect((await get(`/api/annotations/images/${key}`)).statusCode).toBe(200);
    // referenced again: no later prune removes it, however long it waits
    t.clock.advance(UNREFERENCED_GRACE_MS * 3);
    expect(pruneAnnotationImages(t.ctx)).toBe(0);
    expect(existsSync(blob)).toBe(true);
  });

  it('a released picture nobody claims is removed once the grace period after its release has passed', async () => {
    const key = newId();
    await uploadImage(key, png(2, 2, 3));
    const nodeId = await createNode();
    const page = newId();
    await push1(op({ entity_type: 'note_page', entity_id: page, payload: notePage({ node_id: nodeId }) }));
    await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: imageAnnotation(noteAnchor(page), key) }));
    // the upload is OLD (created long before the purge): the grace counts from the release, not from the upload
    t.clock.advance(UNREFERENCED_GRACE_MS * 2);
    await purgeNode(nodeId);
    expect(count('SELECT COUNT(*) AS n FROM annotation_image WHERE image_key = ?', [key])).toBe(1);
    t.clock.advance(UNREFERENCED_GRACE_MS - 60_000);
    expect(pruneAnnotationImages(t.ctx)).toBe(0);
    t.clock.advance(120_000);
    expect(pruneAnnotationImages(t.ctx)).toBe(1);
    expect((await get(`/api/annotations/images/${key}`)).statusCode).toBe(404);
  });
});

describe('H3 item 7 — note pages left with neither notebook nor source («صفحات بلا دفتر»)', () => {
  it('a page edited offline after its notebook was purged is listed as an orphan with its writing, then moved or trashed', async () => {
    const nodeId = await createNode('دفتر سيُحذف');
    const page = newId();
    await push1(op({ entity_type: 'note_page', entity_id: page, payload: notePage({ node_id: nodeId, title: 'ملاحظات القلب' }) }));
    await purgeNode(nodeId);
    expect(count('SELECT COUNT(*) AS n FROM note_page WHERE id = ?', [page])).toBe(0);

    // device B was offline the whole time: its rename and a pen stroke on the page arrive after the purge
    const rename = await push1({ ...op({ entity_type: 'note_page', entity_id: page, base_rev: 1, payload: notePage({ node_id: nodeId, title: 'ملاحظات القلب — مراجعة' }) }), device_id: 'DEVICE_B' });
    expect(rename.result).toBe('merged');
    expect(rename.detail).toMatch(/صفحات بلا دفتر/);
    const stroke = newId();
    await push1({ ...op({ entity_type: 'annotation', entity_id: stroke, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: noteAnchor(page), data: inkData(0.4), layer: 'ink' } }), device_id: 'DEVICE_B' });

    // listed — the page and what is written on it — nowhere else
    const orphans = (await get('/api/annotations/orphan-pages')).json() as OrphanNotePagesResponse;
    expect(orphans.note_pages.map((p) => [p.id, p.title, p.node_id, p.source_id])).toEqual([[page, 'ملاحظات القلب — مراجعة', null, null]]);
    expect(orphans.annotations.map((a) => a.id)).toEqual([stroke]);
    const viaQuery = (await get('/api/annotations/note-pages?orphans=1')).json() as NotePagesResponse;
    expect(viaQuery.note_pages.map((p) => p.id)).toEqual([page]);

    // the owner moves it into another notebook (a normal rev-checked upsert): it leaves the orphan list with its ink
    const target = await createNode('دفتر القلب');
    const moved = await push1(op({ entity_type: 'note_page', entity_id: page, base_rev: 1, payload: notePage({ node_id: target, title: 'ملاحظات القلب — مراجعة' }) }));
    expect(moved.result).toBe('applied');
    expect(((await get('/api/annotations/orphan-pages')).json() as OrphanNotePagesResponse).note_pages).toEqual([]);
    const book = (await get(`/api/annotations/notebook/${target}`)).json() as { note_pages: Array<{ id: string }>; annotations: Array<{ id: string }> };
    expect(book.note_pages.map((p) => p.id)).toEqual([page]);
    expect(book.annotations.map((a) => a.id)).toEqual([stroke]);
  });

  it('a trashed orphan stays listed (restore list) with include_deleted, and is never removed by listing', async () => {
    const nodeId = await createNode('دفتر');
    const page = newId();
    await push1(op({ entity_type: 'note_page', entity_id: page, payload: notePage({ node_id: nodeId }) }));
    await purgeNode(nodeId);
    await push1({ ...op({ entity_type: 'note_page', entity_id: page, payload: notePage({ node_id: nodeId }) }), device_id: 'DEVICE_B' });
    await push1(op({ entity_type: 'note_page', entity_id: page, op: 'delete', base_rev: 1, payload: { id: page } }));
    expect(((await get('/api/annotations/orphan-pages')).json() as OrphanNotePagesResponse).note_pages).toEqual([]);
    const withTrash = (await get('/api/annotations/orphan-pages?include_deleted=1')).json() as OrphanNotePagesResponse;
    expect(withTrash.note_pages.map((p) => [p.id, p.deleted_at !== null])).toEqual([[page, true]]);
    expect(count('SELECT COUNT(*) AS n FROM note_page WHERE id = ?', [page])).toBe(1);
    // auth
    expect((await t.app.inject({ method: 'GET', url: '/api/annotations/orphan-pages' })).statusCode).toBe(401);
  });
});

describe('H3 item 2 — manual re-anchoring («تحتاج إعادة ربط»): the owner picks the place, or keeps it detached', () => {
  /** a page anchor of v1 whose page is gone (e.g. written against a page a re-processing replaced) */
  const goneAnchor = () => ({ type: 'page' as const, source_id: f.sourceId, version_id: f.versionId, page_id: 'GONEPAGE', page_index: 7, space: 'page_norm' as const });
  const ink = (x: number, y: number) => ({ v: 1, points: [[x, y, 0], [x + 0.1, y + 0.05, 16]], style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x, y, w: 0.1, h: 0.05 }, pressure_available: false, tilt_available: false });
  function region(pageIndex: number, bbox: { x: number; y: number; w: number; h: number }, text = 'فقرة الألم حول السرة'): string {
    const id = newId();
    const now = t.clock.now();
    t.ctx.db.run(
      `INSERT INTO source_region (id, version_id, page_id, kind, reading_order, bbox_json, text, text_origin, status, created_at, updated_at) VALUES (?, ?, ?, 'paragraph', 1, ?, ?, 'digital', 'extracted', ?, ?)`,
      [id, f.versionId, f.pageIds[pageIndex], JSON.stringify(bbox), text, now, now],
    );
    return id;
  }
  async function writeGroup(): Promise<string[]> {
    const ids = [newId(), newId()];
    const res = await push([
      op({ entity_type: 'annotation', entity_id: ids[0]!, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: goneAnchor(), data: ink(0.2, 0.3), layer: 'ink' } }),
      op({ entity_type: 'annotation', entity_id: ids[1]!, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: goneAnchor(), data: ink(0.4, 0.5), layer: 'ink' } }),
    ]);
    expect(res.map((r) => r.result)).toEqual(['applied', 'applied']);
    return ids;
  }
  const reanchorReq = (payload: unknown) => t.app.inject({ method: 'POST', url: '/api/annotations/reanchor', headers: h, payload: payload as Record<string, unknown> });
  const lists = async () => (await get(`/api/annotations/needs-reanchor?source_id=${f.sourceId}`)).json() as NeedsReanchorResponse;

  it('an ink group moves to a paragraph of a page: placed AT the paragraph, shape kept, previous anchor kept, audited, synced', async () => {
    const ids = await writeGroup();
    expect((await lists()).items.map((i) => i.annotation.id).sort()).toEqual([...ids].sort());
    const p = region(2, { x: 0.1, y: 0.6, w: 0.8, h: 0.1 });
    const since = (await get('/api/sync/pull?since=0&limit=500')).json().next_since as number;
    const res = await reanchorReq({ items: ids.map((id) => ({ kind: 'annotation', id, rev: 1 })), action: 'move', target: { type: 'page', version_id: f.versionId, page_id: f.pageIds[2], region_id: p } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReanchorResponse;
    expect(body.summary_ar).toMatch(/أُعيد ربط/);
    const [a, b] = ids.map((id) => body.annotations.find((x) => x.id === id)!);
    // the group's corner (0.2, 0.3) went to the paragraph's corner (0.1, 0.6); the second stroke keeps its offset
    expect((a!.data as { bbox: { x: number; y: number } }).bbox).toMatchObject({ x: 0.1, y: 0.6 });
    expect((b!.data as { bbox: { x: number; y: number } }).bbox).toMatchObject({ x: 0.3, y: 0.8 });
    expect((a!.data as { points: number[][] }).points[0]!.slice(0, 2)).toEqual([0.1, 0.6]);
    for (const x of [a!, b!]) {
      expect(x.anchor).toMatchObject({ type: 'page', page_id: f.pageIds[2], page_index: 2 });
      expect(x.anchor_status).toBe('reanchored');
      expect(x.previous_anchor).toMatchObject({ page_id: 'GONEPAGE' });
      expect(x.rev).toBe(2);
    }
    expect((await lists()).items).toEqual([]);
    // the page now shows it; the audit log has the decision with both anchors; other devices get it through the pull
    const onPage = (await get(`/api/annotations/by-targets?keys=source_page:${f.pageIds[2]}`)).json().annotations as Array<{ id: string }>;
    expect(onPage.map((x) => x.id).sort()).toEqual([...ids].sort());
    const audit = t.ctx.db.all<{ action: string; before_json: string; after_json: string }>(`SELECT action, before_json, after_json FROM change_log WHERE entity_type = 'annotation' AND entity_id = ?`, [ids[0]]);
    expect(audit.map((r) => r.action)).toContain('reanchor');
    const pulled = (await get(`/api/sync/pull?since=${since}&limit=500`)).json().changes as Array<{ entity_id: string }>;
    expect(pulled.map((c) => c.entity_id)).toEqual(expect.arrayContaining(ids));
    // a later edit from a device that does not carry the previous anchor keeps it (and the status)
    const edit = await push1(op({ entity_type: 'annotation', entity_id: ids[0]!, base_rev: 2, payload: { kind: 'ink', tool: 'pen', anchor: a!.anchor, data: ink(0.15, 0.62), layer: 'ink' } }));
    expect(edit.result).toBe('applied');
    expect(edit.entity).toMatchObject({ anchor_status: 'reanchored', previous_anchor: { page_id: 'GONEPAGE' } });
  });

  it('«keep detached» moves nothing: the item leaves the list, is listed as detached, and can be re-anchored later', async () => {
    const ids = await writeGroup();
    const res = await reanchorReq({ items: [{ kind: 'annotation', id: ids[0], rev: 1 }], action: 'keep_detached' });
    expect(res.statusCode).toBe(200);
    const after = (res.json() as ReanchorResponse).annotations[0]!;
    expect(after.anchor).toMatchObject({ page_id: 'GONEPAGE' });
    expect(after.detached_at).toBeTypeOf('number');
    const l = await lists();
    expect(l.items.map((i) => i.annotation.id)).toEqual([ids[1]]);
    expect(l.detached!.annotations.map((i) => i.annotation.id)).toEqual([ids[0]]);
    // later: placed on page 1 at the same spot on the page (no paragraph chosen)
    const moved = await reanchorReq({ items: [{ kind: 'annotation', id: ids[0], rev: 2 }], action: 'move', target: { type: 'page', version_id: f.versionId, page_id: f.pageIds[1] } });
    expect(moved.statusCode).toBe(200);
    const m = (moved.json() as ReanchorResponse).annotations[0]!;
    expect((m.data as { bbox: { x: number } }).bbox.x).toBe(0.2);
    expect(m.detached_at).toBeNull();
    expect((await lists()).detached!.annotations).toEqual([]);
  });

  it('a note whose page is gone is listed; moved to a page it keeps its previous anchor; the decision is audited', async () => {
    const noteId = newId();
    const r = await push1(op({ entity_type: 'note', entity_id: noteId, payload: { title: null, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'ليش؟' }] }] }, anchor: goneAnchor(), origin: 'owner' } }));
    expect(r.result).toBe('applied');
    const l = await lists();
    expect(l.notes!.map((n) => n.note.id)).toEqual([noteId]);
    expect(l.notes![0]!.reason_ar).toMatch(/صفحتها لم تعد موجودة/);
    const res = await reanchorReq({ items: [{ kind: 'note', id: noteId, rev: 1 }], action: 'move', target: { type: 'page', version_id: f.versionId, page_id: f.pageIds[0] } });
    expect(res.statusCode).toBe(200);
    const n = (res.json() as ReanchorResponse).notes[0]!;
    expect(n.anchor).toMatchObject({ page_id: f.pageIds[0] });
    expect(n.previous_anchor).toMatchObject({ page_id: 'GONEPAGE' });
    expect((await lists()).notes).toEqual([]);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE entity_type = 'note' AND entity_id = ? AND action = 'reanchor'`, [noteId])!.n).toBe(1);
    // the notes view of that page lists it now
    const notes = (await get(`/api/annotations/notes?page_id=${f.pageIds[0]}`)).json().notes as Array<{ id: string }>;
    expect(notes.map((x) => x.id)).toEqual([noteId]);
  });

  it('refuses honestly: a stale revision (edited elsewhere), a page of another source, a paragraph of another page; nothing changes', async () => {
    const ids = await writeGroup();
    const stale = await reanchorReq({ items: [{ kind: 'annotation', id: ids[0], rev: 0 }], action: 'keep_detached' });
    expect(stale.statusCode).toBe(409);
    const other = createSourceFixture(t, 'مصدر آخر');
    const cross = await reanchorReq({ items: [{ kind: 'annotation', id: ids[0], rev: 1 }], action: 'move', target: { type: 'page', version_id: other.versionId, page_id: other.pageIds[0] } });
    expect(cross.statusCode).toBe(400);
    const p = region(3, { x: 0.1, y: 0.1, w: 0.5, h: 0.1 });
    const wrongRegion = await reanchorReq({ items: [{ kind: 'annotation', id: ids[0], rev: 1 }], action: 'move', target: { type: 'page', version_id: f.versionId, page_id: f.pageIds[2], region_id: p } });
    expect(wrongRegion.statusCode).toBe(400);
    const missingTarget = await reanchorReq({ items: [{ kind: 'annotation', id: ids[0], rev: 1 }], action: 'move' });
    expect(missingTarget.statusCode).toBe(400);
    expect((await lists()).items).toHaveLength(2);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE action LIKE 'reanchor%'`)!.n).toBe(0);
    // auth + CSRF
    expect((await t.app.inject({ method: 'POST', url: '/api/annotations/reanchor', payload: {} })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/annotations/reanchor', headers: { 'x-medlevo-csrf': '1' }, payload: {} })).statusCode).toBe(401);
  });
});
