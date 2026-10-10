// Download Manager manifest (§47, AC-23): completeness, exact sizes and hashes, solutions flag, bundle = what the
// app's own GET requests return, content hash changes with the content, learning data, failure paths.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfflineBundleResponse, OfflineDataEntry, OfflineFileEntry, OfflineLearningResponse, OfflineManifestResponse } from '@medlevo/shared';
import { normalizeOfflinePath } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { CSRF } from '../helpers/app';
import { dataLibrary, getJson, push, rt, writeOwnerData, type DataLib, type OwnerData } from './helpers';

let lib: DataLib;
let owner: OwnerData;
let manifest: OfflineManifestResponse;

beforeAll(async () => {
  lib = await dataLibrary();
  owner = await writeOwnerData(lib, { attempt: false });
  const m = await getJson<OfflineManifestResponse>(lib, `/api/data/offline/${lib.lecture.sourceId}/manifest`);
  expect(m.status, m.raw).toBe(200);
  manifest = m.body;
}, 240_000);
afterAll(async () => {
  await lib?.t.close();
});

const dataEntries = () => manifest.entries.filter((e): e is OfflineDataEntry => e.kind === 'data');
const fileEntries = () => manifest.entries.filter((e): e is OfflineFileEntry => e.kind === 'file');

describe('offline manifest', () => {
  it('lists everything the workspace needs for the active version, with exact sizes', async () => {
    expect(manifest.format).toBe('medlevo-offline-1');
    expect(manifest.version).toMatchObject({ id: lib.lecture.versionId, version_no: 1, is_active: true });
    const S = lib.lecture.sourceId;
    const V = lib.lecture.versionId;
    const paths = dataEntries().map((e) => e.path);
    for (const p of [
      `/api/sources/${S}`,
      `/api/sources/${S}/versions/${V}/pages`,
      `/api/annotations/source/${S}?version_id=${V}`,
      `/api/annotations/notes?source_id=${S}`,
      `/api/annotations/sessions/latest?source_id=${S}`,
      `/api/annotations/progress/${S}`,
      `/api/studybook/books?source_id=${S}`,
      `/api/questions/for-lecture/${S}`,
      `/api/data/offline/${S}/learning`,
    ]) {
      expect(paths, p).toContain(p);
    }
    // every page's regions (text layer, search, overlays offline)
    for (const pid of lib.lecture.pageIds) expect(paths).toContain(`/api/sources/pages/${pid}/regions`);
    // display PDF with the stored size and hash
    const pdf = fileEntries().find((f) => f.role === 'display_pdf')!;
    const stored = lib.t.ctx.db.get<{ size: number; sha256: string; id: string }>('SELECT s.id, s.size, s.sha256 FROM stored_file s JOIN source_version v ON v.file_id = s.id WHERE v.id = ?', [V])!;
    expect(pdf).toMatchObject({ file_id: stored.id, size: stored.size, sha256: stored.sha256, url: `/api/files/${stored.id}`, mime: 'application/pdf' });
    // every data size is the exact byte length of what the app's GET returns
    for (const e of dataEntries()) {
      const r = await lib.t.app.inject({ method: 'GET', url: e.path, headers: lib.h });
      expect(r.statusCode).toBe(200);
      expect(Buffer.byteLength(r.body), e.path).toBe(e.size);
      expect(createHash('sha256').update(r.body).digest('hex')).toBe(e.sha256);
    }
    const sum = manifest.entries.reduce((a, e) => a + e.size, 0);
    expect(manifest.totals.bytes).toBe(sum);
    expect(manifest.totals.file_bytes + manifest.totals.data_bytes).toBe(sum);
  });

  it('reports the contents honestly: writing, Study Book with evidence, questions with solutions, cards', () => {
    expect(manifest.contents.annotations).toBe(2);
    expect(manifest.contents.notes).toBe(1);
    expect(manifest.contents.pages).toBe(lib.lecture.pageIds.length);
    expect(manifest.contents.has_display_pdf).toBe(true);
    expect(manifest.contents.study_book).toMatchObject({ artifact_id: owner.book!.artifact.id, version_no: 1 });
    expect(manifest.contents.study_book!.blocks).toBeGreaterThan(0);
    expect(manifest.contents.flashcards).toBe(2);
    expect(manifest.contents.review_events).toBe(3);
    expect(manifest.contents.questions.linked).toBeGreaterThan(0);
    expect(manifest.contents.questions.with_solutions).toBe(manifest.contents.questions.linked);
    const detailEntries = dataEntries().filter((e) => e.role === 'question_detail');
    expect(detailEntries.length).toBe(manifest.contents.questions.linked);
    expect(detailEntries.every((e) => e.contains_solutions)).toBe(true);
    expect(dataEntries().filter((e) => e.role !== 'question_detail').every((e) => !e.contains_solutions)).toBe(true);
    expect(manifest.totals.solution_bytes).toBe(detailEntries.reduce((a, e) => a + e.size, 0));
    expect(manifest.not_included_ar.join(' ')).toContain('اتصالًا');
  });

  it('include_solutions=0 leaves the question details (keys) out', async () => {
    const m = (await getJson<OfflineManifestResponse>(lib, `/api/data/offline/${lib.lecture.sourceId}/manifest?include_solutions=0`)).body;
    expect(m.include_solutions).toBe(false);
    expect(m.entries.some((e) => e.kind === 'data' && e.contains_solutions)).toBe(false);
    expect(m.contents.questions.with_solutions).toBe(0);
    expect(m.not_included_ar.join(' ')).toContain('دون مفاتيح الإجابة');
  });

  it('the bundle carries exactly the GET answers (Study Book claims with evidence views included)', async () => {
    const b = (await getJson<OfflineBundleResponse>(lib, `/api/data/offline/${lib.lecture.sourceId}/bundle`)).body;
    expect(b.content_hash).toBe(manifest.content_hash);
    expect(b.entries.map((e) => e.path).sort()).toEqual(dataEntries().map((e) => e.path).sort());
    const detail = b.entries.find((e) => e.role === 'source_detail')!;
    expect(detail.body).toEqual((await getJson(lib, `/api/sources/${lib.lecture.sourceId}`)).body);
    const book = b.entries.find((e) => e.role === 'study_book')!.body as { artifact: { claims: Record<string, { citations: Array<{ evidence: { locator_label_ar: string; quote: string } }> }> } };
    const cites = Object.values(book.artifact.claims).flatMap((c) => c.citations);
    expect(cites.length).toBeGreaterThan(0);
    expect(cites[0]!.evidence.locator_label_ar).toMatch(/^ص /);
    // the stored key equals what the client's request normalizes to
    expect(normalizeOfflinePath(`/api/annotations/source/${lib.lecture.sourceId}?version_id=${lib.lecture.versionId}`)).toBe(b.entries.find((e) => e.role === 'annotations')!.path);
  });

  it('content_hash is stable, and changes when the owner writes something new', async () => {
    const again = (await getJson<OfflineManifestResponse>(lib, `/api/data/offline/${lib.lecture.sourceId}/manifest`)).body;
    expect(again.content_hash).toBe(manifest.content_hash);
    await push(lib, [{ entity_type: 'note', entity_id: newId(), op: 'upsert', payload: { title: null, body: rt('ملاحظة جديدة'), anchor: null, origin: 'owner' } }]);
    lib.t.ctx.db.run('UPDATE note SET source_id = ? WHERE source_id IS NULL', [lib.lecture.sourceId]);
    const after = (await getJson<OfflineManifestResponse>(lib, `/api/data/offline/${lib.lecture.sourceId}/manifest`)).body;
    expect(after.content_hash).not.toBe(manifest.content_hash);
  });

  it('learning data: only the source\'s cards and their review events', async () => {
    const other = newId();
    const now = lib.t.ctx.clock.now();
    lib.t.ctx.db.run(`INSERT INTO flashcard (id, kind, front_json, back_json, source_id, evidence_ids_json, origin, rev, created_at, updated_at) VALUES (?, 'basic', '{}', '{}', ?, '[]', 'owner', 1, ?, ?)`, [
      other,
      lib.questions.sourceId,
      now,
      now,
    ]);
    const l = (await getJson<OfflineLearningResponse>(lib, `/api/data/offline/${lib.lecture.sourceId}/learning`)).body;
    expect(l.flashcards.map((c) => c.id).sort()).toEqual([...owner.cardIds].sort());
    expect(l.review_events.map((e) => e.id).sort()).toEqual([...owner.eventIds].sort());
  });

  it('failure paths: unknown source 404, version of another source 404, trashed source 409, no session 401', async () => {
    expect((await getJson(lib, `/api/data/offline/${newId()}/manifest`)).status).toBe(404);
    expect((await getJson(lib, `/api/data/offline/${lib.lecture.sourceId}/manifest?version=${lib.questions.versionId}`)).status).toBe(404);
    expect((await getJson(lib, `/api/data/offline/${lib.lecture.sourceId}/manifest?version=bad%20id`)).status).toBe(400);
    expect((await lib.t.app.inject({ method: 'GET', url: `/api/data/offline/${lib.lecture.sourceId}/manifest` })).statusCode).toBe(401);
    expect((await lib.t.app.inject({ method: 'GET', url: `/api/data/offline/${lib.lecture.sourceId}/bundle` })).statusCode).toBe(401);
    const trash = await lib.t.app.inject({ method: 'POST', url: `/api/sources/${lib.questions.sourceId}/trash`, headers: { ...lib.h, ...CSRF }, payload: {} });
    expect(trash.statusCode, trash.body).toBe(200);
    expect((await getJson(lib, `/api/data/offline/${lib.questions.sourceId}/manifest`)).status).toBe(409);
  });
});
