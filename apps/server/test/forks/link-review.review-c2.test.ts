// Review of Phase 1 completion track C2 — X8 (c) / AOS-19H.3 «اربط بالمحاضرة الرسمية» loses nothing, counted for EVERY
// item and every document (adversarial review, 2026-10-22). Each case failed before its fix:
//   R1  an item the link copied to ONE official copy counted as «carried» for every other document: linking the same
//       private lecture to a second official lecture (the same lecture in another subject) copied nothing, said «نُسخ …»
//       anyway, and copied the inserted note page EMPTY («بما عليها»); and the private lecture's own «انقل ملاحظاتي إلى
//       الإصدار الجديد» counted what the link had copied elsewhere as «نُقل سابقًا», so nothing moved to its new version.
//   R2  items on an EARLIER version of the private lecture (never moved to its current version) were in no count and no
//       sentence: the link reported a total without them and «مرتبطة» as if everything was handled.
// Every file, stroke and note is a TEST FIXTURE generated here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LinkToOfficialResponse, ReanchorCopyPreview, SyncOp, UploadResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { inkData, rt } from '../annotations/helpers';
import { createLectureWorld, drain, lecturePdf, multipart, pagesFor, SPACE_A, SPACE_B, type LectureWorld, type Person } from '../lectures/world';
import { inVault, op, publishLecture, type Published } from './helpers';

let w: LectureWorld;
let LA: Published;
let LB: Published;
const PAGES = pagesFor('Renal', 5);

interface Priv {
  sourceId: string;
  versionId: string;
  pageIds: string[];
}

function folderOf(person: Person): string {
  return inVault(w, person, () => {
    const id = newId();
    const now = Date.now();
    w.t.ctx.db.run(`INSERT INTO library_node (id, parent_id, kind, title, created_at, updated_at) VALUES (?, NULL, 'folder', 'ملفاتي', ?, ?)`, [id, now, now]);
    return id;
  });
}

function versionOf(person: Person, sourceId: string): Priv {
  return inVault(w, person, () => {
    const versionId = w.t.ctx.db.get<{ v: string }>('SELECT current_version_id AS v FROM source WHERE id = ?', [sourceId])!.v;
    const pageIds = w.t.ctx.db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index', [versionId]).map((x) => x.id);
    return { sourceId, versionId, pageIds };
  });
}

async function privateUpload(person: Person, name: string, data: Buffer): Promise<Priv> {
  const res = await w.upload(person, '/api/sources/upload', { name, data }, { node_id: folderOf(person), source_type: 'lecture' });
  expect(res.statusCode, res.body).toBe(200);
  const r = (res.json() as UploadResponse).results[0]!;
  expect(r.status, JSON.stringify(r)).not.toBe('rejected');
  await drain(w);
  await drain(w);
  return versionOf(person, r.source_id!);
}

/** a new version of the private lecture (the owner's own «ارفع إصدارًا جديدًا») */
async function privateNewVersion(person: Person, sourceId: string, name: string, data: Buffer): Promise<Priv> {
  const mp = multipart({}, { name, data });
  const res = await w.t.app.inject({ method: 'POST', url: `/api/sources/${sourceId}/versions`, headers: { ...w.h[person], 'content-type': mp.contentType }, payload: mp.body });
  expect(res.statusCode, res.body).toBe(200);
  expect((res.json() as UploadResponse).results[0]!.status, res.body).not.toBe('rejected');
  await drain(w);
  await drain(w);
  return versionOf(person, sourceId);
}

async function push(person: Person, ops: SyncOp[]): Promise<void> {
  const res = await w.req(person, 'POST', '/api/sync/push', { ops });
  expect(res.statusCode, res.body).toBe(200);
  for (const r of res.json().results as Array<{ result: string }>) expect(r.result, JSON.stringify(r)).toBe('applied');
}

async function writeOnPage(person: Person, p: Priv, i: number, text: string): Promise<string[]> {
  const anchor = { type: 'page' as const, source_id: p.sourceId, version_id: p.versionId, page_id: p.pageIds[i]!, page_index: i, space: 'page_norm' as const };
  const inkId = newId();
  const noteId = newId();
  await push(person, [
    op({ entity_type: 'annotation', entity_id: inkId, payload: { kind: 'ink', tool: 'pen', anchor, data: inkData(0.3), layer: 'ink', z: 0, locked: false } }),
    op({ entity_type: 'note', entity_id: noteId, payload: { node_id: null, title: null, body: rt(text), anchor, origin: 'owner' } }),
  ]);
  return [inkId, noteId];
}

async function insertNotePage(person: Person, p: Priv, after: number): Promise<{ pageId: string; items: string[] }> {
  const pageId = newId();
  await push(person, [op({ entity_type: 'note_page', entity_id: pageId, payload: { source_id: p.sourceId, after_page_index: after, after_page_id: p.pageIds[after], template: 'ruled', width: 595, height: 842, sort_order: 1, title: 'صفحتي' } })]);
  const anchor = { type: 'note_page' as const, note_page_id: pageId, space: 'page_norm' as const };
  const inkId = newId();
  const noteId = newId();
  await push(person, [
    op({ entity_type: 'annotation', entity_id: inkId, payload: { kind: 'ink', tool: 'pen', anchor, data: inkData(0.5), layer: 'ink', z: 0, locked: false } }),
    op({ entity_type: 'note', entity_id: noteId, payload: { node_id: null, title: 'مخطط', body: rt('مخطط الكلية بخط يدي'), anchor, origin: 'owner' } }),
  ]);
  return { pageId, items: [inkId, noteId] };
}

/** originals (`migrated_from_id`) that have a live copy in the document `stubSourceId` (its pages and its note pages) */
function copiedInto(person: Person, stubSourceId: string): Set<string> {
  return inVault(w, person, () => {
    const db = w.t.ctx.db;
    const notePages = new Set(db.all<{ id: string }>('SELECT id FROM note_page WHERE source_id = ? AND deleted_at IS NULL', [stubSourceId]).map((r) => r.id));
    const out = new Set<string>();
    for (const t of ['annotation', 'note'] as const) {
      for (const r of db.all<{ migrated_from_id: string; anchor_json: string | null }>(`SELECT migrated_from_id, anchor_json FROM ${t} WHERE deleted_at IS NULL AND migrated_from_id IS NOT NULL`)) {
        const a = JSON.parse(r.anchor_json ?? 'null') as { type: string; source_id?: string; note_page_id?: string } | null;
        if ((a?.type === 'page' && a.source_id === stubSourceId) || (a?.type === 'note_page' && notePages.has(a.note_page_id!))) out.add(r.migrated_from_id);
      }
    }
    return out;
  });
}

const link = (id: string, p: Priv, space: string, L: Published) =>
  w.ok<LinkToOfficialResponse>('student', 'POST', '/api/copies/link', { id, source_id: p.sourceId, space_id: space, lecture_id: L.lectureId, to_version_id: L.versionId });

beforeAll(async () => {
  w = await createLectureWorld();
  // the same lecture is official in two subjects the student belongs to
  w.setAccess('student', SPACE_B, { access: 'member' });
  LA = await publishLecture(w, SPACE_A, 'Renal physiology (TEST FIXTURE)', PAGES);
  LB = await publishLecture(w, SPACE_B, 'Renal physiology B (TEST FIXTURE)', PAGES, 'modB');
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('R1 — what a link copied to one document is not «carried» for another', () => {
  let priv: Priv;
  let pageItems: string[];
  let np: { pageId: string; items: string[] };

  it('linking the same private lecture to a second official lecture copies everything there too (and says so truly)', async () => {
    priv = await privateUpload('student', 'renal mine.pdf', lecturePdf(PAGES));
    pageItems = [...(await writeOnPage('student', priv, 1, 'ملاحظة الكلية')), ...(await writeOnPage('student', priv, 3, 'ملاحظة النفرون'))];
    np = await insertNotePage('student', priv, 2);
    const a = await link('LINK_R1_A', priv, SPACE_A, LA);
    expect(a.summary).toMatchObject({ copied: 4, needs_review: 0 });
    expect(a.summary!.note_pages).toEqual({ total: 1, copied: 1, items: 2 });
    const intoA = copiedInto('student', LA.sourceId);
    for (const id of [...pageItems, ...np.items]) expect(intoA.has(id), id).toBe(true);

    const b = await link('LINK_R1_B', priv, SPACE_B, LB);
    const intoB = copiedInto('student', LB.sourceId);
    // every item is on the second official copy as well — the note page with what is written on it
    for (const id of [...pageItems, ...np.items]) expect(intoB.has(id), id).toBe(true);
    expect(b.summary).toMatchObject({ copied: 4, needs_review: 0 });
    expect(b.summary!.note_pages).toEqual({ total: 1, copied: 1, items: 2 });
    // a repeated link to B copies nothing more and says nothing new was copied
    const again = await link('LINK_R1_B', priv, SPACE_B, LB);
    expect(again.summary!.note_pages).toEqual({ total: 1, copied: 0, items: 0 });
    expect(copiedInto('student', LB.sourceId).size).toBe(intoB.size);
  });

  it('the private lecture\'s own new version still receives its notes (the link\'s copies elsewhere are not «moved already»)', async () => {
    const v2 = await privateNewVersion('student', priv.sourceId, 'renal mine v2.pdf', lecturePdf(pagesFor('Renal', 5, { 4: 'my corrected last page of the renal lecture' })));
    expect(v2.versionId).not.toBe(priv.versionId);
    const preview = await w.ok<ReanchorCopyPreview>('student', 'GET', `/api/annotations/reanchor-copy?source_id=${priv.sourceId}&to_version_id=${v2.versionId}`);
    expect(preview.state).toBe('ready');
    expect(preview.already_moved).toBe(0);
    expect(preview.copy).toBe(4);
  });
});

describe('R2 — items on an earlier version of the private lecture are counted and named', () => {
  it('the link counts the items left on an earlier private version and says where they are', async () => {
    const p1 = await privateUpload('student', 'renal older.pdf', lecturePdf(pagesFor('Renal', 5, { 0: 'my own cover page for the renal lecture notes' })));
    const onV1 = await writeOnPage('student', p1, 1, 'على الإصدار الأول');
    const p2 = await privateNewVersion('student', p1.sourceId, 'renal older v2.pdf', lecturePdf(pagesFor('Renal', 5, { 0: 'my second cover page for the renal lecture notes' })));
    const onV2 = await writeOnPage('student', p2, 3, 'على الإصدار الثاني');
    const res = await link('LINK_R2', p2, SPACE_A, LA);
    const into = copiedInto('student', LA.sourceId);
    for (const id of onV2) expect(into.has(id), id).toBe(true);
    // the v1 items are not on the official copy — they are counted as kept on the private lecture, and said so
    for (const id of onV1) expect(into.has(id), id).toBe(false);
    expect(res.summary!.total).toBe(onV1.length + onV2.length);
    expect(res.summary!.copied + res.summary!.needs_review + res.summary!.kept).toBe(res.summary!.total);
    expect(res.summary!.kept).toBe(onV1.length);
    expect(res.summary!.summary_ar).toContain('الإصدار 1 من محاضرتك الخاصة');
  });
});
