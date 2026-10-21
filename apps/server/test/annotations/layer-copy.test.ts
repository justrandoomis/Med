// P1-T2 step 2 — «انسخ الطبقة» (PRD AOS-4.11 Phase 1; ARCHITECTURE_DELTA §6.6, §7.5; 0861_attribution): a preview counts
// items per kind and page, the copy writes new derived ids with per-item attribution, image references are counted, the
// source layer never changes (hash), and a re-run is a no-op.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPersonalLayerId, newId, type CopyLayersResponse, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { createSourceFixture, inkData, inkPayload, notePayload, op, pageAnchor, type SourceFixture } from './helpers';

let t: TestApp;
let h: AuthHeaders;
let f: SourceFixture;
let doc: string;
let def: string;

beforeEach(async () => {
  t = await createTestApp();
  h = await t.login();
  f = createSourceFixture(t);
  doc = `source:${f.sourceId}`;
  def = defaultPersonalLayerId(doc);
});
afterEach(async () => {
  await t.close();
});

async function push(ops: SyncOp[]): Promise<SyncOpResult[]> {
  const res = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().results as SyncOpResult[];
}
async function copy(body: Record<string, unknown>, status = 200): Promise<CopyLayersResponse> {
  const res = await t.app.inject({ method: 'POST', url: '/api/annotations/layers/copy', headers: h, payload: body });
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as CopyLayersResponse;
}
/** sha256 over every row of the layer's items as stored (the guarantee: copying never changes the source) */
function sourceHash(): string {
  const rows = [
    ...t.ctx.db.all('SELECT * FROM annotation WHERE layer_id IS NULL ORDER BY id'),
    ...t.ctx.db.all('SELECT * FROM note WHERE layer_id IS NULL ORDER BY id'),
    ...t.ctx.db.all('SELECT * FROM annotation_target ORDER BY annotation_id'),
  ].filter((r) => !String((r as { id?: string; annotation_id?: string }).id ?? (r as { annotation_id?: string }).annotation_id).startsWith('lc_'));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function seedPersonal() {
  const ids = { ink1: newId(), ink2: newId(), hl: newId(), text: newId(), img: newId(), note: newId() };
  t.ctx.db.run(`INSERT INTO stored_file (id, sha256, size, mime, storage_key, created_at) VALUES ('F1', ?, 3, 'image/png', 'x', 1)`, ['b'.repeat(64)]);
  t.ctx.db.run(`INSERT INTO annotation_image (image_key, file_id, mime, bytes, referenced, created_at) VALUES ('IMGK', 'F1', 'image/png', 3, 1, 1)`);
  await push([
    op({ entity_type: 'annotation', entity_id: ids.ink1, op: 'append', payload: inkPayload(f, { pageIndex: 0 }) }),
    op({ entity_type: 'annotation', entity_id: ids.ink2, op: 'append', payload: inkPayload(f, { pageIndex: 2, x: 0.5 }) }),
    op({ entity_type: 'annotation', entity_id: ids.hl, op: 'append', payload: { kind: 'ink', tool: 'highlighter', anchor: pageAnchor(f, 0), data: { ...inkData(0.1), style: { tool: 'highlighter', color: 'hl-yellow', width: 0.02 } }, layer: 'highlight' } }),
    op({ entity_type: 'annotation', entity_id: ids.text, op: 'append', payload: { kind: 'text', anchor: pageAnchor(f, 2), data: { v: 1, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, text: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'مهم' }] }] }, color: 'ink-black', font_scale: 0.02 } } }),
    op({ entity_type: 'annotation', entity_id: ids.img, op: 'append', payload: { kind: 'image', anchor: pageAnchor(f, 0), data: { v: 1, image_key: 'IMGK', box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, mime: 'image/png', natural_w: 10, natural_h: 10, bytes: 3 } } }),
    op({ entity_type: 'note', entity_id: ids.note, payload: notePayload(f, 'ملاحظتي', 2) }),
  ]);
  return ids;
}

describe('copy one layer', () => {
  it('previews counts per kind and page (nothing is written), then copies with derived ids, attribution and an unchanged source', async () => {
    const ids = await seedPersonal();
    const hash = sourceHash();
    const count = () => t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation')!.n;
    const before = count();

    const pv = await copy({ from_layer_ids: [def], document_key: doc, into: { new_title: 'نسخة للمراجعة' }, preview: true });
    expect(pv.result).toBeUndefined();
    expect(pv.preview).toMatchObject({ items: 6, by_kind: { ink: 2, highlight: 1, text: 1, image: 1, note: 1 }, pages: 2, images: 1, already_copied: 0, skipped: [] });
    expect(pv.preview.by_page.map((p) => [p.label_ar.slice(0, 4), p.items])).toEqual([
      ['ص 11', 3],
      ['ص 13', 3],
    ]);
    expect(pv.preview.attributions).toEqual([{ id: 'vault:self', display_name: 'أنت', avatar_url: null }]);
    expect(count()).toBe(before);

    const done = await copy({ from_layer_ids: [def], document_key: doc, into: { new_title: 'نسخة للمراجعة' } });
    expect(done.result).toMatchObject({ copied: 6, already_copied: 0 });
    const into = done.result!.into_layer_id;
    expect(t.ctx.db.get('SELECT kind, title, writable FROM annotation_layer WHERE id = ?', [into])).toEqual({ kind: 'personal', title: 'نسخة للمراجعة', writable: 1 });
    const copies = t.ctx.db.all<{ id: string; migrated_from_id: string; origin: string; layer_id: string; data_json: string }>('SELECT id, migrated_from_id, origin, layer_id, data_json FROM annotation WHERE layer_id = ? ORDER BY id', [into]);
    expect(copies).toHaveLength(5);
    expect(copies.every((c) => c.id.startsWith('lc_') && c.origin === 'layer_copy')).toBe(true);
    expect(new Set(copies.map((c) => c.migrated_from_id))).toEqual(new Set([ids.ink1, ids.ink2, ids.hl, ids.text, ids.img]));
    for (const c of copies) {
      expect(c.data_json).toBe(t.ctx.db.get<{ data_json: string }>('SELECT data_json FROM annotation WHERE id = ?', [c.migrated_from_id])!.data_json);
    }
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note WHERE layer_id = ? AND migrated_from_id = ?', [into, ids.note])!.n).toBe(1);
    // one attribution row per copied item, with the hop it came from
    const attrs = t.ctx.db.all<{ entity_type: string; author_user_id: string; derived_from_json: string }>(`SELECT entity_type, author_user_id, derived_from_json FROM attribution WHERE entity_type IN ('annotation','note')`);
    expect(attrs).toHaveLength(6);
    expect(attrs.every((a) => a.author_user_id === 'vault:self' && JSON.parse(a.derived_from_json)[0].layer_id === def)).toBe(true);
    // the picture is shared by key, not duplicated, and still referenced
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation_image')!.n).toBe(1);
    // the source layer is byte-identical
    expect(sourceHash()).toBe(hash);
    // the copies reach the owner's devices through the change feed
    const pulled = (await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: h })).json();
    expect(pulled.changes.filter((c: { entity_id: string }) => c.entity_id.startsWith('lc_'))).toHaveLength(6);
    // the copy is audited
    expect(t.ctx.db.get<{ action: string }>(`SELECT action FROM change_log WHERE entity_id = ?`, [into])).toEqual({ action: 'layer_copy' });
  });

  it('a layer the copy creates gets a small sort order after the document’s layers (never a timestamp a device would refuse)', async () => {
    await seedPersonal();
    const r = await copy({ from_layer_ids: [def], document_key: doc, into: { new_title: 'نسخة' } });
    const row = t.ctx.db.get<{ sort_order: number }>('SELECT sort_order FROM annotation_layer WHERE id = ?', [r.result!.into_layer_id])!;
    expect(row.sort_order).toBeGreaterThanOrEqual(1);
    expect(row.sort_order).toBeLessThan(1e9);
  });

  it('a second run is a no-op — even after the owner erased one of the copies (it is not brought back)', async () => {
    await seedPersonal();
    const first = await copy({ from_layer_ids: [def], document_key: doc, into: { new_title: 'نسخة' } });
    const into = first.result!.into_layer_id;
    const one = t.ctx.db.get<{ id: string }>('SELECT id FROM annotation WHERE layer_id = ? LIMIT 1', [into])!.id;
    await push([op({ entity_type: 'annotation', entity_id: one, op: 'delete', base_rev: 1 })]);
    const again = await copy({ from_layer_ids: [def], document_key: doc, into: { new_title: 'نسخة' } });
    expect(again.result).toEqual({ into_layer_id: into, copied: 0, already_copied: 6 });
    expect(t.ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM annotation WHERE id = ?', [one])!.deleted_at).not.toBeNull();
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation_layer')!.n).toBe(1);
  });

  it('kind and page filters: «drawings from A» copies only ink and shapes of the chosen pages', async () => {
    await seedPersonal();
    const r = await copy({ from_layer_ids: [def], document_key: doc, kinds: ['ink', 'shape'], page_ids: [f.pageIds[2]!], into: { new_title: 'رسومات' } });
    expect(r.preview).toMatchObject({ items: 1, by_kind: { ink: 1 }, pages: 1 });
  });

  it('a followed explanation can be copied into my own layer: attribution keeps its author, and the copies are mine to edit', async () => {
    const now = t.clock.now();
    t.ctx.db.run(
      `INSERT INTO annotation_layer (id, document_key, kind, title, writable, origin_json, created_at, updated_at) VALUES ('FOL', ?, 'followed', 'شرح سارة', 0, ?, ?, ?)`,
      [doc, JSON.stringify({ publication_id: 'P1', version_no: 2, author_user_id: 'U2', author_display: 'سارة' }), now, now],
    );
    t.ctx.db.run(
      `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, rev, created_at, updated_at, layer_id, author_user_id, origin) VALUES ('F_ITEM', 'ink', 'pen', ?, ?, 'ink', 1, ?, ?, 'FOL', 'U2', 'follow_copy')`,
      [JSON.stringify(pageAnchor(f, 1)), JSON.stringify(inkData(0.3)), now, now],
    );
    t.ctx.db.run(`INSERT INTO attribution (entity_type, entity_id, author_user_id, author_display, derived_from_json, created_at) VALUES ('annotation', 'F_ITEM', 'U2', 'سارة', ?, ?)`, [JSON.stringify([{ space_id: 'S1', publication_id: 'P1', version_no: 2, item_id: 'X1' }]), now]);
    const r = await copy({ from_layer_ids: ['FOL'], into: { layer_id: def, document_key: doc } });
    expect(r.result!.copied).toBe(1);
    expect(r.preview.attributions).toEqual([{ id: 'U2', display_name: 'سارة', avatar_url: null }]);
    const c = t.ctx.db.get<{ id: string; layer_id: string | null; author_user_id: string | null }>(`SELECT id, layer_id, author_user_id FROM annotation WHERE migrated_from_id = 'F_ITEM'`)!;
    expect(c).toMatchObject({ layer_id: null, author_user_id: null });
    const chain = JSON.parse(t.ctx.db.get<{ d: string }>(`SELECT derived_from_json AS d FROM attribution WHERE entity_id = ?`, [c.id])!.d);
    expect(chain.map((x: { item_id: string }) => x.item_id)).toEqual(['X1', 'F_ITEM']);
    // the copy is the owner's own writing now: erasing it is allowed (the followed original stays)
    expect((await push([op({ entity_type: 'annotation', entity_id: c.id, op: 'delete', base_rev: 1 })]))[0]!.result).toBe('applied');
    expect(t.ctx.db.get<{ deleted_at: number | null }>(`SELECT deleted_at FROM annotation WHERE id = 'F_ITEM'`)!.deleted_at).toBeNull();
  });

  it('a followed item without its own attribution row is credited to the layer origin’s author (never a bare «كاتب آخر» when the name is known)', async () => {
    const now = t.clock.now();
    t.ctx.db.run(
      `INSERT INTO annotation_layer (id, document_key, kind, title, writable, origin_json, created_at, updated_at) VALUES ('FOL2', ?, 'followed', 'شرح سارة', 0, ?, ?, ?)`,
      [doc, JSON.stringify({ publication_id: 'P9', version_no: 4, author_user_id: 'U2', author_display: 'سارة' }), now, now],
    );
    t.ctx.db.run(
      `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, rev, created_at, updated_at, layer_id, author_user_id, origin) VALUES ('F_ITEM2', 'ink', 'pen', ?, ?, 'ink', 1, ?, ?, 'FOL2', 'U2', 'follow_copy')`,
      [JSON.stringify(pageAnchor(f, 1)), JSON.stringify(inkData(0.3)), now, now],
    );
    // an item by someone the origin does not name keeps the neutral name
    t.ctx.db.run(
      `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, rev, created_at, updated_at, layer_id, author_user_id, origin) VALUES ('F_ITEM3', 'ink', 'pen', ?, ?, 'ink', 1, ?, ?, 'FOL2', 'U7', 'follow_copy')`,
      [JSON.stringify(pageAnchor(f, 1)), JSON.stringify(inkData(0.5)), now, now],
    );
    const r = await copy({ from_layer_ids: ['FOL2'], into: { layer_id: def, document_key: doc } });
    expect(r.result!.copied).toBe(2);
    expect(r.preview.attributions).toEqual(
      expect.arrayContaining([
        { id: 'U2', display_name: 'سارة', avatar_url: null },
        { id: 'U7', display_name: 'كاتب آخر', avatar_url: null },
      ]),
    );
    const c = t.ctx.db.get<{ id: string }>(`SELECT id FROM annotation WHERE migrated_from_id = 'F_ITEM2'`)!;
    const a = t.ctx.db.get<{ author_display: string; d: string }>(`SELECT author_display, derived_from_json AS d FROM attribution WHERE entity_id = ?`, [c.id])!;
    expect(a.author_display).toBe('سارة');
    expect(JSON.parse(a.d)).toEqual([expect.objectContaining({ publication_id: 'P9', version_no: 4, item_id: 'F_ITEM2', layer_id: 'FOL2' })]);
  });

  it('into another copy of the same lecture: pages matched by position when the page counts agree; otherwise listed as skipped', async () => {
    await seedPersonal();
    const same = createSourceFixture(t, 'نسختي الثانية'); // 4 pages like f's version 1
    const r = await copy({ from_layer_ids: [def], document_key: doc, into: { new_title: 'منقول', document_key: `source:${same.sourceId}` } });
    expect(r.preview.skipped).toEqual([]);
    expect(r.result!.copied).toBe(6);
    const anchors = t.ctx.db.all<{ a: string }>(`SELECT anchor_json AS a FROM annotation WHERE layer_id = ?`, [r.result!.into_layer_id]).map((x) => JSON.parse(x.a));
    expect(anchors.every((a) => a.source_id === same.sourceId && a.page_id === same.pageIds[a.page_index])).toBe(true);
    // a version with a different page count: nothing is guessed
    const other = createSourceFixture(t, 'إصدار مختلف');
    t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [other.version2Id, other.sourceId]); // 2 pages
    const r2 = await copy({ from_layer_ids: [def], document_key: doc, into: { new_title: 'غير متطابق', document_key: `source:${other.sourceId}` }, preview: true });
    expect(r2.preview.items).toBe(0);
    expect(r2.preview.skipped[0]).toMatchObject({ items: 6 });
    expect(r2.preview.skipped[0]!.reason_ar).toMatch(/لا تتطابق/);
  });

  // (P1-T2 review) a copy «into another copy» names a document by key: one that does not exist (a typo, a lecture purged
  // meanwhile) must not leave an orphan layer behind — a purge of a document that is already gone never removes it
  it('refuses a target document that does not exist (no orphan layer row is created)', async () => {
    await seedPersonal();
    const layersBefore = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation_layer')!.n;
    for (const target of ['source:NO_SUCH_SOURCE', 'notebook:NO_SUCH_NODE']) {
      const res = await t.app.inject({ method: 'POST', url: '/api/annotations/layers/copy', headers: h, payload: { from_layer_ids: [def], document_key: doc, into: { new_title: 'إلى لا مكان', document_key: target } } });
      expect(res.statusCode, res.body).toBe(404);
    }
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation_layer')!.n).toBe(layersBefore);
  });

  it('never copies into a read-only layer, nor merges several layers in Phase 1', async () => {
    await seedPersonal();
    const now = t.clock.now();
    t.ctx.db.run(`INSERT INTO annotation_layer (id, document_key, kind, title, writable, created_at, updated_at) VALUES ('FOL', ?, 'followed', 'x', 0, ?, ?)`, [doc, now, now]);
    const res = await t.app.inject({ method: 'POST', url: '/api/annotations/layers/copy', headers: h, payload: { from_layer_ids: [def], document_key: doc, into: { layer_id: 'FOL' } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LAYER_READ_ONLY');
    expect((await t.app.inject({ method: 'POST', url: '/api/annotations/layers/copy', headers: h, payload: { from_layer_ids: [def, 'FOL'], into: { new_title: 'دمج' } } })).statusCode).toBe(400);
  });

  it('copies the realistic 5,000-stroke page in one transaction (time recorded for docs/PERFORMANCE.md)', async () => {
    const now = t.clock.now();
    const data = JSON.stringify(inkData(0.2));
    const anchor = JSON.stringify(pageAnchor(f, 0));
    t.ctx.db.tx(() => {
      for (let i = 0; i < 5000; i++) {
        const id = `S${String(i).padStart(6, '0')}`;
        t.ctx.db.run(`INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, rev, created_at, updated_at) VALUES (?, 'ink', 'pen', ?, ?, 'ink', 1, ?, ?)`, [id, anchor, data, now, now]);
        t.ctx.db.run(`INSERT INTO annotation_target (annotation_id, target_type, target_id) VALUES (?, 'source_page', ?)`, [id, f.pageIds[0]]);
      }
    });
    const t0 = performance.now();
    const r = await copy({ from_layer_ids: [def], document_key: doc, into: { new_title: 'كثيف' } });
    const ms = performance.now() - t0;
    expect(r.result!.copied).toBe(5000);
    console.log(`[perf] layer copy of 5000 strokes: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(15_000);
  });
});
