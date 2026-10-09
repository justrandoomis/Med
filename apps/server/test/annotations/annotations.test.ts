// Annotations module: sync merge policies (§47, AC-24), read APIs, reading progress (§45), sessions (§46), auth.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, toFtsQuery, type AnnotationDTO, type NoteDTO, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, CSRF, type TestApp } from '../helpers/app';
import { createSourceFixture, inkData, inkPayload, notePayload, op, pageAnchor, rt, sessionPayload, type SourceFixture } from './helpers';

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
async function push1(o: SyncOp): Promise<SyncOpResult> {
  return (await push([o]))[0]!;
}
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: h });
const count = (sql: string, params: unknown[] = []) => t.ctx.db.get<{ n: number }>(sql, params)!.n;

describe('annotation sync', () => {
  it('appends a stroke once (same id from another op → duplicate) and writes annotation_target + change feed', async () => {
    const id = newId();
    const a = op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: inkPayload(f) });
    const r1 = await push1(a);
    expect(r1.result).toBe('applied');
    expect((r1.entity as AnnotationDTO).rev).toBe(1);
    const again = op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: inkPayload(f), device_id: 'DEVICE_B' });
    expect((await push1(again)).result).toBe('duplicate');
    expect(count('SELECT COUNT(*) AS n FROM annotation')).toBe(1);
    expect(t.ctx.db.get('SELECT target_type, target_id FROM annotation_target WHERE annotation_id = ?', [id])).toEqual({ target_type: 'source_page', target_id: f.pageIds[0] });
    const pull = (await get('/api/sync/pull?since=0')).json();
    const change = pull.changes.find((c: { entity_id: string }) => c.entity_id === id);
    expect(change.entity_type).toBe('annotation');
    expect(change.entity.data.points).toHaveLength(3);
    expect(change.entity.anchor).toEqual(pageAnchor(f, 0));
  });

  it('answers a repeated op_id with duplicate + the original result (idempotent retry)', async () => {
    const a = op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: inkPayload(f) });
    await push1(a);
    const r = await push1(a);
    expect(r).toMatchObject({ result: 'duplicate', original_result: 'applied' });
    expect(count('SELECT COUNT(*) AS n FROM annotation')).toBe(1);
  });

  it('applies an edit whose base_rev equals the server rev (rev + 1)', async () => {
    const id = newId();
    await push1(op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: inkPayload(f) }));
    const r = await push1(op({ entity_type: 'annotation', entity_id: id, base_rev: 1, payload: { ...inkPayload(f), data: inkData(0.5) } }));
    expect(r.result).toBe('applied');
    const e = r.entity as AnnotationDTO;
    expect(e.rev).toBe(2);
    expect((e.data as { bbox: { x: number } }).bbox.x).toBe(0.5);
  });

  it('keeps both on a stale-rev edit: the incoming edit becomes a new annotation copy', async () => {
    const id = newId();
    await push1(op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: inkPayload(f) }));
    // device A edits (rev 1 → 2); device B edits the same stroke from rev 1 → stale
    await push1(op({ entity_type: 'annotation', entity_id: id, base_rev: 1, payload: { ...inkPayload(f), data: inkData(0.4) } }));
    const r = await push1(op({ entity_type: 'annotation', entity_id: id, base_rev: 1, device_id: 'DEVICE_B', payload: { ...inkPayload(f), data: inkData(0.7) } }));
    expect(r.result).toBe('conflict_kept_both');
    expect(r.detail).toMatch(/[؀-ۿ]/);
    expect((r.entity as AnnotationDTO).id).toBe(id);
    const rows = t.ctx.db.all<{ id: string; data_json: string; conflict_of_id: string | null; device_id: string }>('SELECT id, data_json, conflict_of_id, device_id FROM annotation ORDER BY created_at, id');
    expect(rows).toHaveLength(2);
    const original = rows.find((x) => x.id === id)!;
    const copy = rows.find((x) => x.id !== id)!;
    expect(JSON.parse(original.data_json).bbox.x).toBe(0.4);
    expect(JSON.parse(copy.data_json).bbox.x).toBe(0.7);
    expect(copy.conflict_of_id).toBe(id);
    expect(copy.device_id).toBe('DEVICE_B');
    // both are visible on the page and both reach other devices through pull
    const page = (await get(`/api/annotations/by-targets?keys=source_page:${f.pageIds[0]}`)).json();
    expect(page.annotations.map((a: AnnotationDTO) => a.id).sort()).toEqual([id, copy.id].sort());
    const pulled = (await get('/api/sync/pull?since=0')).json().changes.map((c: { entity_id: string }) => c.entity_id);
    expect(pulled).toEqual(expect.arrayContaining([id, copy.id]));
  });

  it('treats an identical re-send without base_rev as duplicate (no copy)', async () => {
    const id = newId();
    await push1(op({ entity_type: 'annotation', entity_id: id, payload: inkPayload(f) }));
    const r = await push1(op({ entity_type: 'annotation', entity_id: id, payload: inkPayload(f) }));
    expect(r.result).toBe('duplicate');
    expect(count('SELECT COUNT(*) AS n FROM annotation')).toBe(1);
  });

  it('deletes with a tombstone (pull carries deleted_at; page reads exclude it)', async () => {
    const id = newId();
    await push1(op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: inkPayload(f) }));
    const r = await push1(op({ entity_type: 'annotation', entity_id: id, op: 'delete', base_rev: 1, payload: null }));
    expect(r.result).toBe('applied');
    expect((r.entity as AnnotationDTO).deleted_at).toBe(t.clock.now());
    expect(count('SELECT COUNT(*) AS n FROM annotation WHERE id = ?', [id])).toBe(1); // never hard-deleted
    expect((await get(`/api/annotations/by-targets?keys=source_page:${f.pageIds[0]}`)).json().annotations).toHaveLength(0);
    expect((await get(`/api/annotations/by-targets?keys=source_page:${f.pageIds[0]}&include_deleted=1`)).json().annotations).toHaveLength(1);
    const pulled = (await get('/api/sync/pull?since=0')).json().changes.find((c: { entity_id: string }) => c.entity_id === id);
    expect(pulled.entity.deleted_at).not.toBeNull();
    // deleting again is a no-op duplicate
    expect((await push1(op({ entity_type: 'annotation', entity_id: id, op: 'delete', base_rev: 2, payload: null }))).result).toBe('duplicate');
  });

  it('an edit concurrent with a delete keeps the edited stroke (delete first, then the stale edit)', async () => {
    const id = newId();
    await push1(op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: inkPayload(f) }));
    await push1(op({ entity_type: 'annotation', entity_id: id, op: 'delete', base_rev: 1, payload: null }));
    const r = await push1(op({ entity_type: 'annotation', entity_id: id, base_rev: 1, device_id: 'DEVICE_B', payload: { ...inkPayload(f), data: inkData(0.6) } }));
    expect(r.result).toBe('merged');
    const e = r.entity as AnnotationDTO;
    expect(e.deleted_at).toBeNull();
    expect((e.data as { bbox: { x: number } }).bbox.x).toBe(0.6);
  });

  it('an edit concurrent with a delete keeps the edited stroke (edit first, then the stale delete)', async () => {
    const id = newId();
    await push1(op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: inkPayload(f) }));
    await push1(op({ entity_type: 'annotation', entity_id: id, base_rev: 1, device_id: 'DEVICE_B', payload: { ...inkPayload(f), data: inkData(0.6) } }));
    const r = await push1(op({ entity_type: 'annotation', entity_id: id, op: 'delete', base_rev: 1, payload: null }));
    expect(r.result).toBe('conflict_kept_both');
    expect((r.entity as AnnotationDTO).deleted_at).toBeNull();
    expect(t.ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM annotation WHERE id = ?', [id])!.deleted_at).toBeNull();
  });

  it('rejects invalid payloads with Arabic reasons and records them (the client keeps its copy)', async () => {
    const bad: Array<[string, unknown]> = [
      ['missing anchor', { kind: 'ink', data: inkData() }],
      ['points far outside the page', { ...inkPayload(f), data: { ...inkData(), points: [[5, 5, 0]] } }],
      ['unknown kind', { ...inkPayload(f), kind: 'laser' }],
      ['text highlight without quote', { kind: 'text_highlight', anchor: pageAnchor(f), data: { v: 1, style: 'highlight', color: 'yellow', rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }] } }],
    ];
    for (const [label, payload] of bad) {
      const r = await push1(op({ entity_type: 'annotation', entity_id: newId(), payload }));
      expect(r.result, label).toBe('rejected');
      expect(r.retryable, label).toBeUndefined();
      expect(r.detail, label).toMatch(/[؀-ۿ]/);
    }
    const mismatch = await push1(op({ entity_type: 'annotation', entity_id: newId(), payload: { ...inkPayload(f), id: 'OTHER' } }));
    expect(mismatch.result).toBe('rejected');
    expect(count('SELECT COUNT(*) AS n FROM annotation')).toBe(0);
  });

  it('accepts a text highlight with quote + normalized rects (layer highlight)', async () => {
    const id = newId();
    const payload = {
      kind: 'text_highlight',
      tool: null,
      anchor: pageAnchor(f, 1),
      data: { v: 1, style: 'underline', color: 'yellow', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }], quote: { exact: 'Ultrasound is the first-line', prefix: '', suffix: ' imaging' } },
    };
    const r = await push1(op({ entity_type: 'annotation', entity_id: id, payload }));
    expect(r.result).toBe('applied');
    expect((r.entity as AnnotationDTO).layer).toBe('highlight');
  });

  // regression (independent review of track B1): highlighting a whole dense page (> 4000 characters) was
  // rejected for good — the highlight stayed on one device and the save indicator showed an error forever
  it('accepts a text highlight that quotes a whole dense page', async () => {
    const exact = 'Acute appendicitis presents with periumbilical pain that migrates. '.repeat(110); // ≈ 7.4k chars
    const payload = { kind: 'text_highlight', anchor: pageAnchor(f, 1), data: { v: 1, style: 'highlight', color: 'marker-yellow', rects: [{ x: 0.05, y: 0.05, w: 0.9, h: 0.9 }], quote: { exact } } };
    const r = await push1(op({ entity_type: 'annotation', entity_id: newId(), payload }));
    expect(r.result).toBe('applied');
    const tooLong = { ...payload, data: { ...payload.data, quote: { exact: 'x'.repeat(20_001) } } };
    expect((await push1(op({ entity_type: 'annotation', entity_id: newId(), payload: tooLong }))).result).toBe('rejected');
  });

  it('keeps writing whose page does not exist, flagged «تحتاج إعادة ربط» with its previous location', async () => {
    const id = newId();
    const anchor = { ...pageAnchor(f, 2), page_id: 'MISSINGPAGE' };
    const r = await push1(op({ entity_type: 'annotation', entity_id: id, payload: { ...inkPayload(f), anchor } }));
    expect(r.result).toBe('applied');
    expect(r.detail).toMatch(/إعادة ربط/);
    expect((r.entity as AnnotationDTO).anchor_status).toBe('needs_reanchor');
    const list = (await get(`/api/annotations/needs-reanchor?source_id=${f.sourceId}`)).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].annotation.id).toBe(id);
    expect(list.items[0].source_title).toBe('محاضرة الزائدة الدودية');
    expect(list.items[0].previous_location_ar).toContain('الصفحة 3 في الملف');
  });

  it('refuses unsupported operations per entity type', async () => {
    const r = await push1(op({ entity_type: 'study_session', entity_id: newId(), op: 'delete', payload: null }));
    expect(r.result).toBe('rejected');
    const n = await push1(op({ entity_type: 'note', entity_id: newId(), op: 'append', payload: notePayload(f, 'x') }));
    expect(n.result).toBe('rejected');
  });
});

describe('note sync', () => {
  it('creates, edits (rev), keeps a conflicting edit as a separate note (conflict_of_id) and indexes text for search', async () => {
    const id = newId();
    const c = await push1(op({ entity_type: 'note', entity_id: id, payload: notePayload(f, 'ألم حول السرة ثم ينتقل') }));
    expect(c.result).toBe('applied');
    expect(t.ctx.db.get('SELECT source_id, anchor_target_key FROM note WHERE id = ?', [id])).toEqual({ source_id: f.sourceId, anchor_target_key: `source_page:${f.pageIds[0]}` });
    const e = await push1(op({ entity_type: 'note', entity_id: id, base_rev: 1, payload: notePayload(f, 'ألمٌ حول السُّرة (periumbilical)') }));
    expect(e.result).toBe('applied');
    expect((e.entity as NoteDTO).rev).toBe(2);
    const stale = await push1(op({ entity_type: 'note', entity_id: id, base_rev: 1, device_id: 'DEVICE_B', payload: notePayload(f, 'نص من الجهاز الثاني') }));
    expect(stale.result).toBe('conflict_kept_both');
    const notes = (await get(`/api/annotations/notes?source_id=${f.sourceId}`)).json().notes as NoteDTO[];
    expect(notes).toHaveLength(2);
    const copy = notes.find((n) => n.id !== id)!;
    expect(copy.conflict_of_id).toBe(id);
    expect(copy.body.paragraphs[0]!.runs[0]!.t).toBe('نص من الجهاز الثاني');
    // search key is normalized (harakat removed) → matches without diacritics
    const hits = t.ctx.db.all<{ entity_id: string }>(`SELECT entity_id FROM owner_content_fts WHERE owner_content_fts MATCH ?`, [toFtsQuery('السرة')!]);
    expect(hits.map((x) => x.entity_id)).toContain(id);
    expect(t.ctx.db.all(`SELECT entity_id FROM owner_content_fts WHERE owner_content_fts MATCH ?`, [toFtsQuery('periumbilical')!])).toHaveLength(1);
  });

  it('delete tombstones the note and removes it from search; a stale delete keeps the edited text', async () => {
    const id = newId();
    await push1(op({ entity_type: 'note', entity_id: id, payload: notePayload(f, 'ملاحظة للحذف') }));
    const d = await push1(op({ entity_type: 'note', entity_id: id, op: 'delete', base_rev: 1, payload: null }));
    expect(d.result).toBe('applied');
    expect(t.ctx.db.all(`SELECT * FROM owner_content_fts WHERE entity_id = ?`, [id])).toHaveLength(0);
    expect((await get(`/api/annotations/notes?source_id=${f.sourceId}`)).json().notes).toHaveLength(0);

    const id2 = newId();
    await push1(op({ entity_type: 'note', entity_id: id2, payload: notePayload(f, 'أصل') }));
    await push1(op({ entity_type: 'note', entity_id: id2, base_rev: 1, device_id: 'DEVICE_B', payload: notePayload(f, 'معدّل') }));
    const staleDelete = await push1(op({ entity_type: 'note', entity_id: id2, op: 'delete', base_rev: 1, payload: null }));
    expect(staleDelete.result).toBe('conflict_kept_both');
    expect((staleDelete.entity as NoteDTO).deleted_at).toBeNull();
  });

  it('strips bidi control characters from stored note text and keeps a note whose folder does not exist', async () => {
    const id = newId();
    const body = { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'جرعة ‏5 mg‎' }] }] };
    const r = await push1(op({ entity_type: 'note', entity_id: id, payload: { body, node_id: 'NOFOLDER', anchor: null } }));
    expect(r.result).toBe('merged');
    expect(r.detail).toMatch(/المجلد/);
    const n = r.entity as NoteDTO;
    expect(n.node_id).toBeNull();
    expect(n.body.paragraphs[0]!.runs[0]!.t).toBe('جرعة 5 mg');
  });

  it('rejects a note without a valid RichText body', async () => {
    const r = await push1(op({ entity_type: 'note', entity_id: newId(), payload: { body: 'plain string' } }));
    expect(r.result).toBe('rejected');
  });
});

describe('note_page sync', () => {
  it('upserts with rev; a stale metadata edit is rejected with the server copy; delete is a tombstone', async () => {
    const id = newId();
    const base = { source_id: f.sourceId, after_page_index: 1, template: 'ruled', width: 595, height: 842, sort_order: 1, title: 'صفحة بعد ص 12' };
    expect((await push1(op({ entity_type: 'note_page', entity_id: id, payload: base }))).result).toBe('applied');
    const up = await push1(op({ entity_type: 'note_page', entity_id: id, base_rev: 1, payload: { ...base, template: 'grid' } }));
    expect(up.result).toBe('applied');
    expect(up.entity).toMatchObject({ rev: 2, template: 'grid' });
    const stale = await push1(op({ entity_type: 'note_page', entity_id: id, base_rev: 1, device_id: 'DEVICE_B', payload: { ...base, template: 'dotted' } }));
    expect(stale.result).toBe('rejected');
    expect(stale.entity).toMatchObject({ template: 'grid', rev: 2 });
    const del = await push1(op({ entity_type: 'note_page', entity_id: id, op: 'delete', base_rev: 2, payload: null }));
    expect(del.result).toBe('applied');
    expect(t.ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM note_page WHERE id = ?', [id])!.deleted_at).not.toBeNull();
  });
});

describe('study_session sync (§46)', () => {
  it('creates and updates a session; a stale update from another device is rejected WITH the newer server copy', async () => {
    const id = newId();
    expect((await push1(op({ entity_type: 'study_session', entity_id: id, payload: sessionPayload(f, 0) }))).result).toBe('applied');
    t.clock.advance(1000);
    const a = await push1(op({ entity_type: 'study_session', entity_id: id, base_rev: 1, payload: sessionPayload(f, 2, 1.5) }));
    expect(a.result).toBe('applied');
    t.clock.advance(1000);
    // device B still believes rev 1 → must not overwrite the newer position silently
    const b = await push1(op({ entity_type: 'study_session', entity_id: id, base_rev: 1, device_id: 'DEVICE_B', payload: sessionPayload(f, 1) }));
    expect(b.result).toBe('rejected');
    expect(b.detail).toMatch(/جهاز آخر/);
    expect(b.entity).toMatchObject({ id, rev: 2, location: { page_index: 2, zoom: 1.5 } });
    const latest = (await get(`/api/annotations/sessions/latest?source_id=${f.sourceId}`)).json();
    expect(latest.session.location.page_index).toBe(2);
    // after the owner chose, the client re-sends based on the server rev → applied
    const c = await push1(op({ entity_type: 'study_session', entity_id: id, base_rev: 2, device_id: 'DEVICE_B', payload: sessionPayload(f, 1) }));
    expect(c.result).toBe('applied');
  });

  it('rejects a session for an unknown source or a version of another source', async () => {
    const r = await push1(op({ entity_type: 'study_session', entity_id: newId(), payload: { ...sessionPayload(f, 0), source_id: 'NOSOURCE' } }));
    expect(r.result).toBe('rejected');
    expect(r.detail).toMatch(/المصدر/);
    const other = createSourceFixture(t, 'مصدر آخر');
    const r2 = await push1(op({ entity_type: 'study_session', entity_id: newId(), payload: { ...sessionPayload(f, 0), version_id: other.versionId } }));
    expect(r2.result).toBe('rejected');
  });

  it('rejects invalid locations (zoom, rotation)', async () => {
    const bad = { ...sessionPayload(f, 0), location: { page_index: 0, zoom: 50, rotation: 45 } };
    expect((await push1(op({ entity_type: 'study_session', entity_id: newId(), payload: bad }))).result).toBe('rejected');
  });
});

describe('read APIs', () => {
  it('GET /by-targets returns live annotations for several pages in one request; validates keys', async () => {
    await push([
      op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: inkPayload(f, { pageIndex: 0 }) }),
      op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: inkPayload(f, { pageIndex: 1 }) }),
      op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: inkPayload(f, { pageIndex: 3 }) }),
    ]);
    const res = await get(`/api/annotations/by-targets?keys=source_page:${f.pageIds[0]},source_page:${f.pageIds[1]}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().annotations).toHaveLength(2);
    expect((await get('/api/annotations/by-targets?keys=bogus')).statusCode).toBe(400);
    const many = Array.from({ length: 201 }, (_, i) => `source_page:P${i}`).join(',');
    expect((await get(`/api/annotations/by-targets?keys=${many}`)).statusCode).toBe(400);
  });

  it('GET /source/:id returns all annotations, notes and note pages of a document (offline download); version filter; 404', async () => {
    const npId = newId();
    await push([
      op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: inkPayload(f, { pageIndex: 0 }) }),
      op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { ...inkPayload(f), anchor: { type: 'page', source_id: f.sourceId, version_id: f.version2Id, page_id: f.v2PageIds[0]!, page_index: 0, space: 'page_norm' } } }),
      op({ entity_type: 'note', entity_id: newId(), payload: notePayload(f, 'ملاحظة') }),
      op({ entity_type: 'note_page', entity_id: npId, payload: { source_id: f.sourceId, after_page_index: 0, template: 'blank' } }),
    ]);
    await push1(op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { ...inkPayload(f), anchor: { type: 'note_page', note_page_id: npId, space: 'page_norm' } } }));
    const all = (await get(`/api/annotations/source/${f.sourceId}`)).json();
    expect(all.version_ids).toEqual([f.versionId, f.version2Id]);
    expect(all.annotations).toHaveLength(3);
    expect(all.notes).toHaveLength(1);
    expect(all.note_pages).toHaveLength(1);
    const v1 = (await get(`/api/annotations/source/${f.sourceId}?version_id=${f.versionId}`)).json();
    expect(v1.annotations).toHaveLength(2); // v1 page + note page
    expect((await get('/api/annotations/source/NOPE')).statusCode).toBe(404);
    const other = createSourceFixture(t, 'آخر');
    expect((await get(`/api/annotations/source/${f.sourceId}?version_id=${other.versionId}`)).statusCode).toBe(404);
  });

  it('GET /notes filters by page and requires a filter', async () => {
    await push([op({ entity_type: 'note', entity_id: newId(), payload: notePayload(f, 'ص 11') }), op({ entity_type: 'note', entity_id: newId(), payload: notePayload(f, 'ص 12', 1) })]);
    const p2 = (await get(`/api/annotations/notes?page_id=${f.pageIds[1]}`)).json().notes as NoteDTO[];
    expect(p2).toHaveLength(1);
    expect(p2[0]!.body).toEqual(rt('ص 12'));
    expect((await get('/api/annotations/notes')).statusCode).toBe(400);
  });

  it('GET /sessions/recent lists one entry per source (newest first) with title, version and page label; skips trashed sources', async () => {
    const other = createSourceFixture(t, 'محاضرة المرارة');
    await push1(op({ entity_type: 'study_session', entity_id: newId(), payload: sessionPayload(f, 2) }));
    t.clock.advance(1000);
    await push1(op({ entity_type: 'study_session', entity_id: newId(), payload: sessionPayload(other, 0) }));
    t.clock.advance(1000);
    // a newer session for the first source from another device
    await push1(op({ entity_type: 'study_session', entity_id: newId(), device_id: 'DEVICE_B', payload: sessionPayload(f, 3) }));
    const items = (await get('/api/annotations/sessions/recent?limit=5')).json().items;
    expect(items.map((i: { source: { title: string } }) => i.source.title)).toEqual(['محاضرة الزائدة الدودية', 'محاضرة المرارة']);
    expect(items[0].page).toMatchObject({ page_index: 3, printed_label: '14', label_ar: 'ص 14 (الصفحة 4 في الملف)' });
    expect(items[0].version).toMatchObject({ version_no: 1, is_active: true });
    t.ctx.db.run('UPDATE source SET deleted_at = ? WHERE id = ?', [t.clock.now(), other.sourceId]);
    expect((await get('/api/annotations/sessions/recent')).json().items).toHaveLength(1);
    expect((await get('/api/annotations/sessions/latest?source_id=NOPE')).json()).toEqual({ session: null });
  });
});

describe('reading progress (§45: reading only, never mastery)', () => {
  it('records viewed pages as a set and computes viewed / total for one version', async () => {
    const post = (payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/annotations/progress', headers: h, payload });
    expect((await post({ source_id: f.sourceId, version_id: f.versionId, page_index: 0 })).json()).toMatchObject({ pages_viewed: [0], pages_total: 4, reading_progress: 0.25 });
    await post({ source_id: f.sourceId, version_id: f.versionId, page_indexes: [1, 1, 0] });
    const p = (await get(`/api/annotations/progress/${f.sourceId}`)).json();
    expect(p).toMatchObject({ version_id: f.versionId, pages_viewed: [0, 1], pages_total: 4, reading_progress: 0.5 });
    expect(p).not.toHaveProperty('mastery_estimate');
    expect(p).not.toHaveProperty('explanation_coverage');
    // pages of another version are not mixed in — and viewing a page of a NON-active version (e.g. a
    // citation made against v2 while v1 is the current one) never wipes the active version's progress
    // (regression: it used to replace the stored set with [1] of v2)
    const v2 = (await post({ source_id: f.sourceId, version_id: f.version2Id, page_index: 1 })).json();
    expect(v2).toMatchObject({ version_id: f.versionId, pages_viewed: [0, 1], pages_total: 4, reading_progress: 0.5 });
    // once v2 is the version being studied, its pages replace the old version's
    t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [f.version2Id, f.sourceId]);
    const v2active = (await post({ source_id: f.sourceId, version_id: f.version2Id, page_index: 1 })).json();
    expect(v2active).toMatchObject({ version_id: f.version2Id, pages_viewed: [1], pages_total: 2, reading_progress: 0.5 });
    t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [f.versionId, f.sourceId]);
    // out of range / wrong version / missing page
    expect((await post({ source_id: f.sourceId, version_id: f.versionId, page_index: 9 })).statusCode).toBe(400);
    const other = createSourceFixture(t, 'آخر');
    expect((await post({ source_id: f.sourceId, version_id: other.versionId, page_index: 0 })).statusCode).toBe(404);
    expect((await post({ source_id: f.sourceId, version_id: f.versionId })).statusCode).toBe(400);
    expect((await get('/api/annotations/progress/NOPE')).statusCode).toBe(404);
    // the shared mastery column is untouched
    expect(t.ctx.db.get<{ m: number | null }>('SELECT mastery_estimate AS m FROM source_progress WHERE source_id = ?', [f.sourceId])!.m).toBeNull();
  });

  it('reports zero progress honestly before anything was viewed', async () => {
    expect((await get(`/api/annotations/progress/${f.sourceId}`)).json()).toEqual({ source_id: f.sourceId, version_id: null, pages_viewed: [], pages_total: null, reading_progress: 0, updated_at: null });
  });
});

describe('auth, CSRF and capabilities', () => {
  it('requires the owner session for reads and writes, and the CSRF header for POST', async () => {
    const anon = await t.app.inject({ method: 'GET', url: `/api/annotations/by-targets?keys=source_page:${f.pageIds[0]}` });
    expect(anon.statusCode).toBe(401);
    const anonPost = await t.app.inject({ method: 'POST', url: '/api/annotations/progress', headers: CSRF, payload: { source_id: f.sourceId, version_id: f.versionId, page_index: 0 } });
    expect(anonPost.statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/annotations/progress', headers: { cookie: h.cookie }, payload: { source_id: f.sourceId, version_id: f.versionId, page_index: 0 } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/annotations/sessions/recent' })).statusCode).toBe(401);
  });

  it('declares workspace.reader and workspace.ink available, and sync becomes available', async () => {
    const caps = (await get('/api/capabilities')).json();
    expect(caps.features['workspace.reader'].state).toBe('available');
    expect(caps.features['workspace.ink'].state).toBe('available');
    expect(caps.features.sync.state).toBe('available');
    expect(t.ctx.sync.registeredTypes()).toEqual(expect.arrayContaining(['annotation', 'note', 'note_page', 'study_session']));
  });
});
