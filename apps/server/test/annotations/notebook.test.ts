// Notebook pages, page links and pictures on pages (track F1, §26 / §25 / §5): note_page sync edge cases (notebook
// pages, dividers, placement after a source page, trash / restore), link and image annotation validation, the
// image upload API (sniffing, limits, idempotency), and image files across purge and backup.
import { crc32, deflateSync } from 'node:zlib';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type AnnotationDTO, type ImageAnnotationData, type ImpactReport, type LinkData, type NotePageView, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { createBackup } from '../../src/modules/data/backup';
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

async function createNode(title = 'دفتر ملاحظات الجراحة', kind = 'notebook', parentId: string | null = null): Promise<string> {
  const res = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: h, payload: { parent_id: parentId, kind, title } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { node: { id: string } }).node.id;
}

const notePage = (o: Partial<NotePageView> & Record<string, unknown>) => ({ template: 'ruled', width: 595, height: 842, sort_order: 1, title: null, ...o });
const noteAnchor = (id: string) => ({ type: 'note_page' as const, note_page_id: id, space: 'page_norm' as const });

/** A real (tiny) PNG file. */
function png(w = 3, h = 2, seed = 0): Buffer {
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
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (1 + w * 3) + 1 + x] = (x * 40 + y * 90 + seed) & 0xff;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function uploadImage(key: string, data: Buffer, name = 'diagram.png', contentType = 'image/png') {
  const body = multipart({ image_key: key, device_id: 'DEVICE_A' }, [{ name, data, contentType, field: 'file' }]);
  return t.app.inject({ method: 'POST', url: '/api/annotations/images', headers: { ...h, 'content-type': body.contentType }, payload: body.payload });
}

function imageData(key: string, o: Partial<ImageAnnotationData> = {}): ImageAnnotationData {
  return { v: 1, image_key: key, box: { x: 0.2, y: 0.3, w: 0.4, h: 0.2 }, mime: 'image/png', natural_w: 3, natural_h: 2, bytes: 100, alt: 'مخطط الأوعية', name: 'diagram.png', ...o };
}
const imageAnnotation = (anchor: unknown, key: string, o: Partial<ImageAnnotationData> = {}) => ({ kind: 'image', tool: 'image', anchor, data: imageData(key, o), layer: 'media', z: 0, locked: false });

describe('note pages in a notebook (§26, §5)', () => {
  it('creates pages and dividers in a notebook, lists them in order, and seeds a device with what is written on them', async () => {
    const nodeId = await createNode();
    const divider = newId();
    const p1 = newId();
    const p2 = newId();
    const res = await push([
      op({ entity_type: 'note_page', entity_id: divider, payload: notePage({ node_id: nodeId, kind: 'divider', color: 'teal', title: 'القسم الأول', template: 'blank', sort_order: 0 }) }),
      op({ entity_type: 'note_page', entity_id: p2, payload: notePage({ node_id: nodeId, title: 'الصفحة الثانية', template: 'grid', sort_order: 2 }) }),
      op({ entity_type: 'note_page', entity_id: p1, payload: notePage({ node_id: nodeId, title: 'الصفحة الأولى', template: 'dotted', sort_order: 1 }) }),
    ]);
    expect(res.map((r) => r.result)).toEqual(['applied', 'applied', 'applied']);
    expect(res[0]!.entity).toMatchObject({ kind: 'divider', color: 'teal', node_id: nodeId, source_id: null });
    expect(res[2]!.entity).toMatchObject({ kind: 'page', color: null, template: 'dotted' });

    const ink = newId();
    expect((await push1(op({ entity_type: 'annotation', entity_id: ink, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: noteAnchor(p1), data: inkData(0.3), layer: 'ink' } }))).result).toBe('applied');
    expect(t.ctx.db.get('SELECT target_type, target_id FROM annotation_target WHERE annotation_id = ?', [ink])).toEqual({ target_type: 'note_page', target_id: p1 });

    const list = (await get(`/api/annotations/note-pages?node_id=${nodeId}`)).json().note_pages as NotePageView[];
    expect(list.map((p) => p.id)).toEqual([divider, p1, p2]);
    const book = (await get(`/api/annotations/notebook/${nodeId}`)).json() as { note_pages: NotePageView[]; annotations: AnnotationDTO[] };
    expect(book.note_pages).toHaveLength(3);
    expect(book.annotations.map((a) => a.id)).toEqual([ink]);
    // by-targets serves note pages like source pages
    const byTargets = (await get(`/api/annotations/by-targets?keys=note_page:${p1}`)).json().annotations as AnnotationDTO[];
    expect(byTargets.map((a) => a.id)).toEqual([ink]);
  });

  it('rename / re-template / reorder is a rev-checked upsert; a stale edit from another device is rejected with the server copy', async () => {
    const nodeId = await createNode();
    const id = newId();
    await push1(op({ entity_type: 'note_page', entity_id: id, payload: notePage({ node_id: nodeId, title: 'قديم', sort_order: 1 }) }));
    const renamed = await push1(op({ entity_type: 'note_page', entity_id: id, base_rev: 1, payload: notePage({ node_id: nodeId, title: 'خلاصة الفصل', sort_order: 1.5, template: 'grid' }) }));
    expect(renamed.result).toBe('applied');
    expect(renamed.entity).toMatchObject({ rev: 2, title: 'خلاصة الفصل', sort_order: 1.5, template: 'grid' });
    const stale = await push1(op({ entity_type: 'note_page', entity_id: id, base_rev: 1, device_id: 'DEVICE_B', payload: notePage({ node_id: nodeId, title: 'عنوان من جهاز آخر', sort_order: 1 }) }));
    expect(stale.result).toBe('rejected');
    expect(stale.entity).toMatchObject({ title: 'خلاصة الفصل', rev: 2 });
    // the same content again (a re-sent edit) is a duplicate, not a rejection
    const same = await push1(op({ entity_type: 'note_page', entity_id: id, base_rev: 1, payload: notePage({ node_id: nodeId, title: 'خلاصة الفصل', sort_order: 1.5, template: 'grid' }) }));
    expect(same.result).toBe('duplicate');
  });

  it('trash and restore: delete is a tombstone that keeps the ink; listing hides it unless asked; an upsert restores it with its writing', async () => {
    const nodeId = await createNode();
    const id = newId();
    await push1(op({ entity_type: 'note_page', entity_id: id, payload: notePage({ node_id: nodeId, title: 'صفحة للمحذوفات' }) }));
    const ink = newId();
    await push1(op({ entity_type: 'annotation', entity_id: ink, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: noteAnchor(id), data: inkData(), layer: 'ink' } }));
    const del = await push1(op({ entity_type: 'note_page', entity_id: id, op: 'delete', base_rev: 1, payload: { id } }));
    expect(del.result).toBe('applied');
    expect((del.entity as NotePageView).deleted_at).not.toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM annotation WHERE id = ? AND deleted_at IS NULL', [ink])).toBe(1);
    expect((await get(`/api/annotations/note-pages?node_id=${nodeId}`)).json().note_pages).toHaveLength(0);
    const withTrash = (await get(`/api/annotations/note-pages?node_id=${nodeId}&include_deleted=1`)).json().note_pages as NotePageView[];
    expect(withTrash.map((p) => [p.id, p.deleted_at !== null])).toEqual([[id, true]]);
    expect((await get(`/api/annotations/notebook/${nodeId}`)).json().annotations).toHaveLength(0);
    // restore (an upsert of the tombstoned page) brings the page AND its writing back
    const restored = await push1(op({ entity_type: 'note_page', entity_id: id, base_rev: 2, payload: notePage({ node_id: nodeId, title: 'صفحة للمحذوفات' }) }));
    expect(restored.result).toBe('merged');
    expect(restored.entity).toMatchObject({ deleted_at: null, rev: 3 });
    expect((await get(`/api/annotations/notebook/${nodeId}`)).json().annotations.map((a: AnnotationDTO) => a.id)).toEqual([ink]);
  });

  it('refuses pages that belong nowhere, placement without a source, unknown colours and absurd sizes — each with an Arabic reason', async () => {
    const nodeId = await createNode();
    const nowhere = await push1(op({ entity_type: 'note_page', entity_id: newId(), payload: notePage({}) }));
    expect(nowhere.result).toBe('rejected');
    expect(nowhere.detail).toMatch(/داخل دفتر أو مجلد/);
    const placed = await push1(op({ entity_type: 'note_page', entity_id: newId(), payload: notePage({ node_id: nodeId, after_page_index: 2 }) }));
    expect(placed.result).toBe('rejected');
    expect(placed.detail).toMatch(/يحتاج المصدر/);
    const colour = await push1(op({ entity_type: 'note_page', entity_id: newId(), payload: notePage({ node_id: nodeId, kind: 'divider', color: '#ff0000' }) }));
    expect(colour.result).toBe('rejected');
    expect(colour.detail).toMatch(/color: /);
    const tiny = await push1(op({ entity_type: 'note_page', entity_id: newId(), payload: notePage({ node_id: nodeId, width: 2 }) }));
    expect(tiny.result).toBe('rejected');
    const kind = await push1(op({ entity_type: 'note_page', entity_id: newId(), payload: notePage({ node_id: nodeId, kind: 'cover' }) }));
    expect(kind.result).toBe('rejected');
    expect(count('SELECT COUNT(*) AS n FROM note_page')).toBe(0);
  });

  it('a page inserted after a source page keeps the page id; a page id of another source is dropped (kept by index), never the note page', async () => {
    const id = newId();
    const ok = await push1(op({ entity_type: 'note_page', entity_id: id, payload: notePage({ source_id: f.sourceId, after_page_index: 1, after_page_id: f.pageIds[1] }) }));
    expect(ok.result).toBe('applied');
    expect(ok.entity).toMatchObject({ source_id: f.sourceId, after_page_index: 1, after_page_id: f.pageIds[1] });
    // a page of the second version of the same source is fine (placement survives a re-numbered version)
    const v2 = await push1(op({ entity_type: 'note_page', entity_id: newId(), payload: notePage({ source_id: f.sourceId, after_page_index: 0, after_page_id: f.v2PageIds[0] }) }));
    expect(v2.result).toBe('applied');
    const other = createSourceFixture(t, 'مرجع آخر');
    const wrong = await push1(op({ entity_type: 'note_page', entity_id: newId(), payload: notePage({ source_id: f.sourceId, after_page_index: 2, after_page_id: other.pageIds[0] }) }));
    expect(wrong.result).toBe('merged');
    expect(wrong.detail).toMatch(/برقم الصفحة/);
    expect(wrong.entity).toMatchObject({ after_page_index: 2, after_page_id: null });
    // the reader's offline download carries the inserted pages with their placement
    const forSource = (await get(`/api/annotations/source/${f.sourceId}`)).json();
    expect(forSource.note_pages.map((p: NotePageView) => p.after_page_id)).toEqual(expect.arrayContaining([f.pageIds[1], f.v2PageIds[0], null]));
    expect((await get(`/api/annotations/note-pages?source_id=${f.sourceId}`)).json().note_pages).toHaveLength(3);
  });

  it('GET /note-pages needs a notebook or a source; unknown ones are 404; the notebook route needs auth', async () => {
    expect((await get('/api/annotations/note-pages')).statusCode).toBe(400);
    expect((await get('/api/annotations/note-pages?node_id=NOPE')).statusCode).toBe(404);
    expect((await get('/api/annotations/note-pages?source_id=NOPE')).statusCode).toBe(404);
    expect((await get('/api/annotations/notebook/NOPE')).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/annotations/notebook/x' })).statusCode).toBe(401);
  });
});

describe('page links (annotation kind link)', () => {
  const link = (anchor: unknown, data: Partial<LinkData> & Record<string, unknown>) => ({ kind: 'link', tool: 'link', anchor, data: { v: 1, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 }, ...data }, layer: 'text' });

  it('stores links to a source page (with a region) and to a note page; serves them with the page', async () => {
    const nodeId = await createNode();
    const np = newId();
    await push1(op({ entity_type: 'note_page', entity_id: np, payload: notePage({ node_id: nodeId }) }));
    const toSource = newId();
    const r1 = await push1(
      op({
        entity_type: 'annotation',
        entity_id: toSource,
        op: 'append',
        payload: link(noteAnchor(np), {
          target: { type: 'source_page', source_id: f.sourceId, version_id: f.versionId, page_id: f.pageIds[2]!, page_index: 2, bbox: { x: 0.1, y: 0.4, w: 0.5, h: 0.1 } },
          label: 'انظر الجدول',
          target_label: 'ص 13 — محاضرة الزائدة الدودية',
        }),
      }),
    );
    expect(r1.result).toBe('applied');
    expect((r1.entity as AnnotationDTO).layer).toBe('text');
    const toNote = newId();
    const r2 = await push1(op({ entity_type: 'annotation', entity_id: toNote, op: 'append', payload: link(pageAnchor(f, 0), { target: { type: 'note_page', note_page_id: np } }) }));
    expect(r2.result).toBe('applied');
    const data = (r2.entity as AnnotationDTO).data as LinkData;
    expect(data.target).toEqual({ type: 'note_page', note_page_id: np });
    const onPage = (await get(`/api/annotations/by-targets?keys=source_page:${f.pageIds[0]},note_page:${np}`)).json().annotations as AnnotationDTO[];
    expect(onPage.map((a) => a.id).sort()).toEqual([toSource, toNote].sort());
    // the link can be moved / resized like any annotation (rev-checked upsert)
    const moved = await push1(op({ entity_type: 'annotation', entity_id: toNote, base_rev: 1, payload: link(pageAnchor(f, 0), { box: { x: 0.5, y: 0.6, w: 0.2, h: 0.05 }, target: { type: 'note_page', note_page_id: np } }) }));
    expect(moved.result).toBe('applied');
    expect(((moved.entity as AnnotationDTO).data as LinkData).box).toEqual({ x: 0.5, y: 0.6, w: 0.2, h: 0.05 });
  });

  it('rejects malformed links with a reason (never stores a link that cannot be followed)', async () => {
    const cases: Array<Record<string, unknown>> = [
      { target: { type: 'url', url: 'https://example.com' } },
      { target: { type: 'source_page', source_id: f.sourceId } },
      { target: { type: 'note_page', note_page_id: 'bad id!' } },
      { target: { type: 'source_page', source_id: f.sourceId, version_id: null, page_id: null, page_index: 0, bbox: { x: 2, y: 0, w: 1, h: 1 } } },
      { box: { x: 0.1, y: 0.1, w: 0, h: 0.1 }, target: { type: 'note_page', note_page_id: 'NP1' } },
      { target: { type: 'note_page', note_page_id: 'NP1' }, label: 'x'.repeat(201) },
    ];
    for (const c of cases) {
      const r = await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: link(pageAnchor(f, 0), c as Partial<LinkData>) }));
      expect(r.result, JSON.stringify(c)).toBe('rejected');
      expect(r.detail).toMatch(/رفض الخادم/);
    }
    expect(count("SELECT COUNT(*) AS n FROM annotation WHERE kind = 'link'")).toBe(0);
  });
});

describe('pictures on pages (annotation kind image + /api/annotations/images)', () => {
  it('the annotation may arrive before its picture: stored, the picture is «not here yet», then the upload makes it servable', async () => {
    const key = newId();
    const ann = newId();
    const r = await push1(op({ entity_type: 'annotation', entity_id: ann, op: 'append', payload: imageAnnotation(pageAnchor(f, 1), key) }));
    expect(r.result).toBe('applied');
    expect((r.entity as AnnotationDTO).layer).toBe('media');
    const missing = await get(`/api/annotations/images/${key}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toMatch(/لم تصل هذه الصورة/);

    const bytes = png(3, 2);
    const up = await uploadImage(key, bytes);
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ duplicate: false, image: { image_key: key, mime: 'image/png', bytes: bytes.length, width: 3, height: 2, used_by: 1 } });
    expect(t.ctx.db.get('SELECT referenced FROM annotation_image WHERE image_key = ?', [key])).toEqual({ referenced: 1 });

    const served = await get(`/api/annotations/images/${key}`);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(served.rawPayload, bytes)).toBe(0);
    expect((await get(`/api/annotations/images/${key}/meta`)).json()).toMatchObject({ image_key: key, used_by: 1 });

    // a retry of the same upload (lost response) is idempotent; other bytes under the same key are refused
    const again = await uploadImage(key, bytes);
    expect(again.json().duplicate).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM annotation_image')).toBe(1);
    const clash = await uploadImage(key, png(4, 4, 7));
    expect(clash.statusCode).toBe(409);
  });

  it('the picture may arrive first: uploading before the annotation marks it referenced when the annotation syncs', async () => {
    const key = newId();
    expect((await uploadImage(key, png())).json().image.used_by).toBe(0);
    expect(t.ctx.db.get('SELECT referenced FROM annotation_image WHERE image_key = ?', [key])).toEqual({ referenced: 0 });
    await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: imageAnnotation(pageAnchor(f, 0), key) }));
    expect(t.ctx.db.get('SELECT referenced FROM annotation_image WHERE image_key = ?', [key])).toEqual({ referenced: 1 });
  });

  it('sniffs the content: SVG / HTML / text / TIFF are refused whatever the client says; size and key limits hold', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r1 = await uploadImage(newId(), svg, 'x.png', 'image/png');
    expect(r1.statusCode).toBe(415);
    expect(r1.json().error.message).toMatch(/ليس صورة مدعومة/);
    expect((await uploadImage(newId(), Buffer.from('<!doctype html><p>hi'), 'a.png')).statusCode).toBe(415);
    const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(64)]);
    expect((await uploadImage(newId(), tiff, 'scan.tif', 'image/tiff')).statusCode).toBe(415);
    const big = Buffer.concat([png(), Buffer.alloc(10 * 1024 * 1024 + 10)]);
    const r2 = await uploadImage(newId(), big);
    expect(r2.statusCode).toBe(413);
    expect(r2.json().error.message).toMatch(/أكبر من الحد/);
    expect((await uploadImage('bad key!', png())).statusCode).toBe(400);
    expect((await get('/api/annotations/images/bad%20key')).statusCode).toBe(400);
    // nothing of the refused uploads was stored
    expect(count('SELECT COUNT(*) AS n FROM annotation_image')).toBe(0);
    // a JSON body is not an upload
    const json = await t.app.inject({ method: 'POST', url: '/api/annotations/images', headers: h, payload: { image_key: newId() } });
    expect(json.statusCode).toBe(415);
  });

  it('rejects image annotations with an unsupported type, a size over the limit or no key', async () => {
    for (const o of [{ mime: 'image/svg+xml' }, { bytes: 10 * 1024 * 1024 + 1 }, { natural_w: 0 }, { image_key: '' }] as Array<Partial<ImageAnnotationData>>) {
      const r = await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: imageAnnotation(pageAnchor(f, 0), newId(), o) }));
      expect(r.result, JSON.stringify(o)).toBe('rejected');
    }
  });

  it('purge: a picture another page still shows is kept; once nothing shows it the file is removed; backups carry it', async () => {
    // the same picture on a lecture page AND on a notebook page (copy / paste keeps the image_key)
    const key = newId();
    const bytes = png(5, 4, 3);
    await uploadImage(key, bytes);
    const nodeId = await createNode('دفتري');
    const np = newId();
    await push1(op({ entity_type: 'note_page', entity_id: np, payload: notePage({ node_id: nodeId }) }));
    await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: imageAnnotation(pageAnchor(f, 0), key) }));
    const onNote = newId();
    await push1(op({ entity_type: 'annotation', entity_id: onNote, op: 'append', payload: imageAnnotation(noteAnchor(np), key) }));
    const fileId = t.ctx.db.get<{ file_id: string }>('SELECT file_id FROM annotation_image WHERE image_key = ?', [key])!.file_id;
    const blob = t.ctx.files.path(fileId);
    expect(existsSync(blob)).toBe(true);

    // backups archive every stored file, the picture included
    const out = mkdtempSync(join(tmpdir(), 'medlevo-f1-backup-'));
    try {
      const b = await createBackup({ dataDir: t.dataDir, dbPath: t.config.dbPath, filesDir: t.config.filesDir, outDir: out, appVersion: t.config.appVersion, now: () => Date.now(), db: t.ctx.db });
      expect(b.manifest.files.map((x) => x.file_id)).toContain(fileId);
      expect(b.manifest.files_missing).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }

    // purge the lecture: its image annotation goes, the notebook page still shows the picture → kept
    await t.app.inject({ method: 'POST', url: `/api/sources/${f.sourceId}/trash`, headers: h });
    const impact = (await get(`/api/sources/${f.sourceId}/impact?mode=purge`)).json() as ImpactReport;
    const purged = await t.app.inject({ method: 'DELETE', url: `/api/sources/${f.sourceId}?confirm_token=${encodeURIComponent(impact.confirm_token!)}`, headers: h });
    expect(purged.statusCode).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM annotation WHERE kind = 'image'")).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM annotation_image WHERE image_key = ?', [key])).toBe(1);
    expect(existsSync(blob)).toBe(true);
    expect((await get(`/api/annotations/images/${key}`)).statusCode).toBe(200);

    // a tombstoned annotation still holds its picture (undo restores it)
    await push1(op({ entity_type: 'annotation', entity_id: onNote, op: 'delete', base_rev: 1, payload: { id: onNote } }));
    expect(pruneAnnotationImages(t.ctx)).toBe(0);
    expect(existsSync(blob)).toBe(true);

    // purge the notebook: nothing shows the picture any more → row and file removed
    await t.app.inject({ method: 'POST', url: `/api/library/nodes/${nodeId}/trash`, headers: h });
    const nImpact = (await get(`/api/library/nodes/${nodeId}/impact?mode=purge`)).json() as ImpactReport;
    const nPurged = await t.app.inject({ method: 'DELETE', url: `/api/library/nodes/${nodeId}?confirm_token=${encodeURIComponent(nImpact.confirm_token!)}`, headers: h });
    expect(nPurged.statusCode).toBe(200);
    expect(count('SELECT COUNT(*) AS n FROM annotation_image')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM stored_file WHERE id = ?', [fileId])).toBe(0);
    expect(existsSync(blob)).toBe(false);
  });

  it('prune keeps a never-referenced upload for the grace period (its annotation may still be queued on a device), then removes it', async () => {
    const key = newId();
    await uploadImage(key, png(2, 2, 9));
    expect(pruneAnnotationImages(t.ctx)).toBe(0);
    t.clock.advance(UNREFERENCED_GRACE_MS + 1000);
    expect(pruneAnnotationImages(t.ctx)).toBe(1);
    expect((await get(`/api/annotations/images/${key}`)).statusCode).toBe(404);
  });
});
