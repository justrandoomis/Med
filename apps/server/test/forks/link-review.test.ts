// Phase 1 completion, track C2 — X8 (c) / AOS-19H.3: «اربط بالمحاضرة الرسمية» loses nothing.
//   * every item of the private lecture ends on the official version (copied) or in the review list of the OFFICIAL
//     copy («تحتاج مراجعة — من محاضرتك الخاصة»), from where it is copied by hand (or kept on the private lecture);
//   * inserted note pages are copied with what is written on them (deterministic ids: a second link copies nothing);
//   * the private source and every row on it stay byte-identical;
//   * the proof counts every item before and after: total = copied + listed for review + kept, and after the review
//     decisions total = copied + kept with every copy pointing back at its original (`migrated_from_id`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LinkToOfficialResponse, OfficialLinkStatusResponse, ReanchorCopyActionResponse, ReanchorCopyPreview, SyncOp, UploadResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { inkData, rt } from '../annotations/helpers';
import { createLectureWorld, drain, lecturePdf, pagesFor, SPACE_A, type LectureWorld, type Person } from '../lectures/world';
import { inVault, op, publishLecture, type Published } from './helpers';

let w: LectureWorld;
let L: Published;
const PAGES = pagesFor('Cardiac', 6);
// the student's own file: pages 1–5 are the official ones, page 6 is her own summary (it maps to nothing safely)
const VARIANT = lecturePdf(pagesFor('Cardiac', 6, { 5: 'my own extra summary page written by me for revision' }));

interface Priv {
  sourceId: string;
  versionId: string;
  pageIds: string[];
}

async function privateUpload(person: Person, name: string, data: Buffer): Promise<Priv> {
  const folder = inVault(w, person, () => {
    const id = newId();
    const now = Date.now();
    w.t.ctx.db.run(`INSERT INTO library_node (id, parent_id, kind, title, created_at, updated_at) VALUES (?, NULL, 'folder', 'ملفاتي', ?, ?)`, [id, now, now]);
    return id;
  });
  const res = await w.upload(person, '/api/sources/upload', { name, data }, { node_id: folder, source_type: 'lecture' });
  expect(res.statusCode, res.body).toBe(200);
  const r = (res.json() as UploadResponse).results[0]!;
  expect(r.status, JSON.stringify(r)).not.toBe('rejected');
  await drain(w);
  await drain(w);
  return inVault(w, person, () => {
    const sourceId = r.source_id!;
    const versionId = w.t.ctx.db.get<{ v: string }>('SELECT current_version_id AS v FROM source WHERE id = ?', [sourceId])!.v;
    const pageIds = w.t.ctx.db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index', [versionId]).map((x) => x.id);
    return { sourceId, versionId, pageIds };
  });
}

async function push(person: Person, ops: SyncOp[]): Promise<void> {
  const res = await w.req(person, 'POST', '/api/sync/push', { ops });
  expect(res.statusCode, res.body).toBe(200);
  for (const r of res.json().results as Array<{ result: string }>) expect(r.result, JSON.stringify(r)).toBe('applied');
}

/** ink + a note on page `i` of the private version; returns their ids */
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

/** a note page inserted after page `after`, with a stroke and a note on it */
async function insertNotePage(person: Person, p: Priv, after: number): Promise<{ pageId: string; items: string[] }> {
  const pageId = newId();
  await push(person, [op({ entity_type: 'note_page', entity_id: pageId, payload: { source_id: p.sourceId, after_page_index: after, after_page_id: p.pageIds[after], template: 'ruled', width: 595, height: 842, sort_order: 1, title: 'شرحي بعد الصفحة 3' } })]);
  const anchor = { type: 'note_page' as const, note_page_id: pageId, space: 'page_norm' as const };
  const inkId = newId();
  const noteId = newId();
  await push(person, [
    op({ entity_type: 'annotation', entity_id: inkId, payload: { kind: 'ink', tool: 'pen', anchor, data: inkData(0.5), layer: 'ink', z: 0, locked: false } }),
    op({ entity_type: 'note', entity_id: noteId, payload: { node_id: null, title: 'مخطط', body: rt('مخطط الدورة القلبية بخط يدي'), anchor, origin: 'owner' } }),
  ]);
  return { pageId, items: [inkId, noteId] };
}

/** Every live item whose document is the private source (page items, note pages, and what is written on them). */
function privateInventory(person: Person, p: Priv): { annotations: string[]; notes: string[]; notePages: string[] } {
  return inVault(w, person, () => {
    const db = w.t.ctx.db;
    const notePages = db.all<{ id: string }>('SELECT id FROM note_page WHERE source_id = ? AND deleted_at IS NULL ORDER BY id', [p.sourceId]).map((r) => r.id);
    const npSet = new Set(notePages);
    const annotations = db
      .all<{ id: string; anchor_json: string }>('SELECT id, anchor_json FROM annotation WHERE deleted_at IS NULL ORDER BY id')
      .filter((r) => {
        const a = JSON.parse(r.anchor_json) as { type: string; source_id?: string; note_page_id?: string };
        return (a.type === 'page' && a.source_id === p.sourceId) || (a.type === 'note_page' && npSet.has(a.note_page_id!));
      })
      .map((r) => r.id);
    const notes = db.all<{ id: string }>('SELECT id FROM note WHERE source_id = ? AND deleted_at IS NULL ORDER BY id', [p.sourceId]).map((r) => r.id);
    return { annotations, notes, notePages };
  });
}

/** The copy of each original on the official copy (stub): `migrated_from_id` → where it landed. */
function copiesOnStub(person: Person, stubSourceId: string): Map<string, { id: string; anchor: { type: string; source_id?: string; version_id?: string; note_page_id?: string }; layer_id: string | null }> {
  return inVault(w, person, () => {
    const db = w.t.ctx.db;
    const out = new Map<string, { id: string; anchor: { type: string; source_id?: string; version_id?: string; note_page_id?: string }; layer_id: string | null }>();
    const stubNotePages = new Set(db.all<{ id: string }>('SELECT id FROM note_page WHERE source_id = ? AND deleted_at IS NULL', [stubSourceId]).map((r) => r.id));
    for (const t of ['annotation', 'note'] as const) {
      for (const r of db.all<{ id: string; migrated_from_id: string | null; anchor_json: string | null; layer_id: string | null }>(`SELECT id, migrated_from_id, anchor_json, layer_id FROM ${t} WHERE deleted_at IS NULL AND migrated_from_id IS NOT NULL`)) {
        const anchor = JSON.parse(r.anchor_json ?? 'null') as { type: string; source_id?: string; note_page_id?: string };
        const onStub = (anchor?.type === 'page' && anchor.source_id === stubSourceId) || (anchor?.type === 'note_page' && stubNotePages.has(anchor.note_page_id!));
        if (onStub) out.set(r.migrated_from_id!, { id: r.id, anchor, layer_id: r.layer_id });
      }
    }
    return out;
  });
}

const snapshot = (person: Person, p: Priv) =>
  inVault(w, person, () => {
    const db = w.t.ctx.db;
    return JSON.stringify([
      db.all('SELECT * FROM source WHERE id = ?', [p.sourceId]),
      db.all('SELECT * FROM source_version WHERE source_id = ? ORDER BY id', [p.sourceId]),
      db.all('SELECT * FROM source_page WHERE version_id = ? ORDER BY id', [p.versionId]),
      db.all(`SELECT * FROM annotation WHERE json_extract(anchor_json, '$.source_id') = ? OR json_extract(anchor_json, '$.note_page_id') IN (SELECT id FROM note_page WHERE source_id = ?) ORDER BY id`, [p.sourceId, p.sourceId]),
      db.all('SELECT * FROM note WHERE source_id = ? ORDER BY id', [p.sourceId]),
      db.all('SELECT * FROM note_page WHERE source_id = ? ORDER BY id', [p.sourceId]),
    ]);
  });

beforeAll(async () => {
  w = await createLectureWorld();
  L = await publishLecture(w, SPACE_A, 'Cardiac cycle (TEST FIXTURE)', PAGES);
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('X8 (c): linking a private lecture to its official twin loses nothing', () => {
  let priv: Priv;
  let placed: string[];
  let unplaced: string[];
  let notePage: { pageId: string; items: string[] };
  let link: LinkToOfficialResponse;

  it('the link copies what it can place, copies the inserted note page with its writing, and lists the rest for review', async () => {
    priv = await privateUpload('student', 'my cardiac (own summary).pdf', VARIANT);
    placed = [...(await writeOnPage('student', priv, 1, 'ملاحظة على الصفحة الثانية')), ...(await writeOnPage('student', priv, 3, 'ملاحظة على الصفحة الرابعة'))];
    unplaced = await writeOnPage('student', priv, 5, 'ملخصي الخاص في الصفحة الأخيرة');
    notePage = await insertNotePage('student', priv, 2);
    const before = privateInventory('student', priv);
    const total = before.annotations.length + before.notes.length;
    expect(total).toBe(8); // 3 pages × (ink + note) + the note page's ink + note
    expect(before.notePages).toEqual([notePage.pageId]);
    const snap = snapshot('student', priv);

    link = await w.ok<LinkToOfficialResponse>('student', 'POST', '/api/copies/link', { id: 'LINK_REVIEW_1', source_id: priv.sourceId, space_id: SPACE_A, lecture_id: L.lectureId, to_version_id: L.versionId });
    expect(link.summary).toMatchObject({ copied: 4, needs_review: 2, kept: 0 });
    expect(link.summary!.note_pages).toEqual({ total: 1, copied: 1, items: 2 });
    // honest wording: what is in the review list of the official copy, and where it is
    expect(link.summary!.summary_ar).toContain('إعادة ربط');
    expect(snapshot('student', priv)).toBe(snap);

    const copies = copiesOnStub('student', L.sourceId);
    for (const id of [...placed, ...notePage.items]) expect(copies.has(id), id).toBe(true);
    for (const id of unplaced) expect(copies.has(id), id).toBe(false);
    for (const c of copies.values()) expect(c.layer_id).toBeNull(); // the official copy's «ملاحظاتي»
    // the note page is a copy on the official copy, placed after the official page that matches private page 3
    inVault(w, 'student', () => {
      const np = w.t.ctx.db.all<{ id: string; source_id: string; after_page_id: string | null; title: string | null }>('SELECT id, source_id, after_page_id, title FROM note_page WHERE source_id = ? AND deleted_at IS NULL', [L.sourceId]);
      expect(np).toHaveLength(1);
      expect(np[0]!.id).not.toBe(notePage.pageId);
      expect(np[0]!.title).toBe('شرحي بعد الصفحة 3');
      const official3 = w.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 2', [L.versionId])!.id;
      expect(np[0]!.after_page_id).toBe(official3);
      for (const id of notePage.items) expect(copies.get(id)!.anchor).toEqual({ type: 'note_page', note_page_id: np[0]!.id, space: 'page_norm' });
      expect(w.t.ctx.db.all('PRAGMA foreign_key_check')).toEqual([]);
    });

    // the count before = what was copied + what the review list of the OFFICIAL copy lists (+ kept: none)
    const preview = await w.ok<ReanchorCopyPreview>('student', 'GET', `/api/annotations/reanchor-copy?source_id=${L.sourceId}&to_version_id=${L.versionId}`);
    expect(preview.linked).toEqual([
      expect.objectContaining({ source: { id: priv.sourceId, title: expect.any(String) }, version: { id: priv.versionId, version_no: 1 }, items: 6, pending: 2 }),
    ]);
    const review = await w.ok<ReanchorCopyPreview>('student', 'GET', `/api/annotations/reanchor-copy?source_id=${L.sourceId}&to_version_id=${L.versionId}&from_version_id=${priv.versionId}`);
    expect(review.state).toBe('ready');
    expect(review.linked_from).toEqual({ source_id: priv.sourceId, title: expect.any(String) });
    expect(review.review.map((r) => r.id).sort()).toEqual([...unplaced].sort());
    expect(copies.size + review.review.length + review.kept).toBe(total);
  });

  it('the review list copies an unplaced item across to the official copy (a copy, never a move); another stays on the private lecture', async () => {
    const snap = snapshot('student', priv);
    const review = await w.ok<ReanchorCopyPreview>('student', 'GET', `/api/annotations/reanchor-copy?source_id=${L.sourceId}&to_version_id=${L.versionId}&from_version_id=${priv.versionId}`);
    const ink = review.review.find((r) => r.kind === 'annotation')!;
    const note = review.review.find((r) => r.kind === 'note')!;
    const target = ink.suggested ?? { page_id: inVault(w, 'student', () => w.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 5', [L.versionId])!.id) };
    const res = await w.ok<ReanchorCopyActionResponse>('student', 'POST', '/api/annotations/reanchor', {
      action: 'copy',
      items: [{ kind: ink.kind, id: ink.id, rev: ink.rev }],
      to_version_id: L.versionId,
      target: { type: 'page', version_id: L.versionId, page_id: target.page_id },
    });
    expect(res.annotations).toHaveLength(1);
    expect(res.annotations[0]!.anchor).toMatchObject({ type: 'page', source_id: L.sourceId, version_id: L.versionId, page_id: target.page_id });
    expect(res.annotations[0]!.migrated_from_id).toBe(ink.id);
    const kept = await w.ok<ReanchorCopyActionResponse>('student', 'POST', '/api/annotations/reanchor', { action: 'keep_on_previous', items: [{ kind: note.kind, id: note.id, rev: note.rev }], to_version_id: L.versionId });
    expect(kept.summary_ar).toContain('محاضرتك الخاصة');
    expect(snapshot('student', priv)).toBe(snap);

    // the count after: every item is on the official copy or kept (by the owner's choice) — none lost, none twice
    const inv = privateInventory('student', priv);
    const total = inv.annotations.length + inv.notes.length;
    const copies = copiesOnStub('student', L.sourceId);
    const after = await w.ok<ReanchorCopyPreview>('student', 'GET', `/api/annotations/reanchor-copy?source_id=${L.sourceId}&to_version_id=${L.versionId}&from_version_id=${priv.versionId}`);
    expect(after.review).toEqual([]);
    expect(after.kept_items.map((k) => k.id)).toEqual([note.id]);
    expect(copies.size + after.kept_items.length).toBe(total);
    for (const id of [...inv.annotations, ...inv.notes]) expect(copies.has(id) || id === note.id, id).toBe(true);
    const linked = await w.ok<ReanchorCopyPreview>('student', 'GET', `/api/annotations/reanchor-copy?source_id=${L.sourceId}&to_version_id=${L.versionId}`);
    expect(linked.linked?.[0]).toMatchObject({ pending: 0 });
  });

  it('a second link copies nothing more (no second note page, no duplicate item)', async () => {
    const before = copiesOnStub('student', L.sourceId).size;
    const again = await w.ok<LinkToOfficialResponse>('student', 'POST', '/api/copies/link', { id: 'LINK_REVIEW_1', source_id: priv.sourceId, space_id: SPACE_A, lecture_id: L.lectureId, to_version_id: L.versionId });
    expect(again.summary!.note_pages).toEqual({ total: 1, copied: 0, items: 0 });
    expect(copiesOnStub('student', L.sourceId).size).toBe(before);
    inVault(w, 'student', () => expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note_page WHERE source_id = ? AND deleted_at IS NULL', [L.sourceId])!.n).toBe(1));
  });

  it('items of a private lecture that is NOT linked cannot be copied across documents (400), and another user cannot read the list', async () => {
    const other = await privateUpload('student', 'unlinked cardiac.pdf', lecturePdf(pagesFor('Cardiac', 6, { 4: 'a second private file with its own page five', 5: 'and its own page six summary' })));
    const [inkId] = await writeOnPage('student', other, 1, 'غير مربوطة');
    const rev = inVault(w, 'student', () => w.t.ctx.db.get<{ rev: number }>('SELECT rev FROM annotation WHERE id = ?', [inkId])!.rev);
    const page = inVault(w, 'student', () => w.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 1', [L.versionId])!.id);
    const res = await w.req('student', 'POST', '/api/annotations/reanchor', { action: 'copy', items: [{ kind: 'annotation', id: inkId, rev }], to_version_id: L.versionId, target: { type: 'page', version_id: L.versionId, page_id: page } });
    expect(res.statusCode).toBe(400);
    const peek = await w.req('student', 'GET', `/api/annotations/reanchor-copy?source_id=${L.sourceId}&to_version_id=${L.versionId}&from_version_id=${other.versionId}`);
    expect(peek.statusCode).toBe(404);
    // another account: the stub does not exist in their vault
    expect((await w.req('contrib', 'GET', `/api/annotations/reanchor-copy?source_id=${L.sourceId}&to_version_id=${L.versionId}&from_version_id=${priv.versionId}`)).statusCode).toBe(404);
  });
});

describe('«the library offers the link» — link status for library rows (19H.3, 19I.2)', () => {
  it('an official copy says which lecture it is; a linked private lecture shows its review count; an unlinked twin is offered; strangers get nothing', async () => {
    const twin = await privateUpload('student', 'cardiac twin unlinked.pdf', lecturePdf(pagesFor('Cardiac', 6, { 0: 'my very own cover page for the cardiac cycle notes' })));
    const unrelated = await privateUpload('student', 'unrelated ophthalmology.pdf', lecturePdf(pagesFor('Ophthalmology retina', 3)));
    const linkedPriv = inVault(w, 'student', () => w.t.ctx.db.get<{ private_source_id: string }>('SELECT private_source_id FROM private_link LIMIT 1')!.private_source_id);
    const ids = [L.sourceId, linkedPriv, twin.sourceId, unrelated.sourceId, 'NOT_IN_MY_VAULT'];
    const res = await w.ok<OfficialLinkStatusResponse>('student', 'GET', `/api/copies/link-status?source_ids=${ids.join(',')}`);
    const by = new Map(res.statuses.map((s) => [s.source_id, s]));
    expect(by.get(L.sourceId)).toMatchObject({ official: { space_id: SPACE_A, lecture_id: L.lectureId, subject_title: 'Anatomy A' }, linked: null, candidate: null });
    expect(by.get(linkedPriv)).toMatchObject({ official: null, linked: { stub_source_id: L.sourceId, lecture_id: L.lectureId, pending: 0 }, candidate: null });
    expect(by.get(twin.sourceId)).toMatchObject({ official: null, linked: null, candidate: { space_id: SPACE_A, lecture_id: L.lectureId, subject_title: 'Anatomy A' } });
    expect(by.get(unrelated.sourceId)).toMatchObject({ official: null, linked: null, candidate: null });
    expect(by.has('NOT_IN_MY_VAULT')).toBe(false);
    // another account asking about the same ids learns nothing
    expect((await w.ok<OfficialLinkStatusResponse>('contrib', 'GET', `/api/copies/link-status?source_ids=${ids.join(',')}`)).statuses).toEqual([]);
    // more than 30 ids are refused
    const many = Array.from({ length: 31 }, (_, i) => `ID${i}`).join(',');
    expect((await w.req('student', 'GET', `/api/copies/link-status?source_ids=${many}`)).statusCode).toBe(400);
  });
});
