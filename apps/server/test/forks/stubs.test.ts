// P1-T5 step 2 — «ابدأ الدراسة»: vault stubs with the space's ids, document_copy, lecture_copy (BUILD_PLAN §3.7
// `test/forks/stubs.test.ts`; ARCHITECTURE_DELTA §6.1, §6.5; ADR-0003 §3.3; PRD AOS-2.17–2.19, 4.1). The vault holds the
// official lecture's skeleton (source, versions, pages, fingerprints) under the SPACE's ids — no blob, chunk, FTS or
// region row duplicated; «ابدأ الدراسة» twice reopens the same copy; the system index says who holds which version and
// how many personal items sit on it, nothing else.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentCopiesResponse, DocumentCopyView, PageRegionsResponse } from '@medlevo/shared';
import { defaultPersonalLayerId } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { createLectureWorld, pagesFor, SPACE_A, SPACE_B, sp, type LectureWorld } from '../lectures/world';
import { holdings, inSpaceDb, inVault, pageIdsOf, publishLecture, startStudying, type Published, writeInk } from './helpers';

let w: LectureWorld;
let L: Published;
let copy: DocumentCopyView;

function filesDirCount(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else n++;
    }
  };
  walk(dir);
  return n;
}

beforeAll(async () => {
  w = await createLectureWorld();
  L = await publishLecture(w, SPACE_A, 'Renal anatomy (TEST FIXTURE)', pagesFor('Renal', 40));
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('«ابدأ الدراسة» creates a stub with the space ids', () => {
  it('the vault holds source, version and page skeleton with the SAME ids — no blob, chunk, FTS or region copied', async () => {
    const blobsBefore = filesDirCount(w.t.ctx.config.filesDir);
    const res = await startStudying(w, 'student', SPACE_A, L.lectureId);
    copy = res.copy;
    expect(res.created).toBe(true);
    expect(copy.mode).toBe('personal');
    expect(copy.source_id).toBe(L.sourceId);
    expect(copy.document_key).toBe(`source:${L.sourceId}`);
    expect(copy.lecture).toMatchObject({ space_id: SPACE_A, lecture_id: L.lectureId, version_id: L.versionId, version_no: 1 });
    expect(copy.personal_layer_id).toBe(defaultPersonalLayerId(`source:${L.sourceId}`));
    expect(copy.official).toMatchObject({ status: 'published', file_removed: false });

    const spacePages = pageIdsOf(w, SPACE_A, L.versionId);
    expect(spacePages).toHaveLength(40);
    inVault(w, 'student', () => {
      const db = w.t.ctx.db;
      const src = db.get<{ is_stub: number; origin_space_id: string; origin_lecture_id: string; current_version_id: string; source_type: string }>('SELECT * FROM source WHERE id = ?', [L.sourceId])!;
      expect(src).toMatchObject({ is_stub: 1, origin_space_id: SPACE_A, origin_lecture_id: L.lectureId, current_version_id: L.versionId, source_type: 'lecture' });
      expect(db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index', [L.versionId]).map((r) => r.id)).toEqual(spacePages);
      // nothing of the text: chunks, FTS and regions stay in the space
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM document_chunk WHERE version_id = ?', [L.versionId])!.n).toBe(0);
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH 'renal'`)!.n).toBe(0);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_region WHERE version_id = ?', [L.versionId])!.n).toBe(0);
      // the file: a vault row for the SAME blob (same sha256), no new bytes on disk
      const fileId = db.get<{ file_id: string }>('SELECT file_id FROM source_version WHERE id = ?', [L.versionId])!.file_id;
      const sha = db.get<{ sha256: string }>('SELECT sha256 FROM stored_file WHERE id = ?', [fileId])!.sha256;
      const spaceSha = inSpaceDb(w, SPACE_A, (s) => s.get<{ sha256: string }>('SELECT f.sha256 FROM source_version v JOIN stored_file f ON f.id = v.file_id WHERE v.id = ?', [L.versionId])!.sha256);
      expect(sha).toBe(spaceSha);
      // fingerprints travel with the stub (P1-T2's note copy needs them), page map runs only between held versions
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM page_fingerprint WHERE version_id = ?', [L.versionId])!.n).toBe(40);
      // the stub lands in «موادي من القنوات» › the subject
      const folder = db.get<{ title: string; parent: string }>('SELECT n.title, p.title AS parent FROM source s JOIN library_node n ON n.id = s.node_id JOIN library_node p ON p.id = n.parent_id WHERE s.id = ?', [L.sourceId])!;
      expect(folder).toEqual({ title: 'Anatomy A', parent: 'موادي من القنوات' });
      expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
      // the size of the skeleton (rows of the stub, without the fingerprints): measured and reported
      // value bytes (what the rows hold, without JSON keys): source + version + 40 pages
      const bytesOf = (rows: Array<Record<string, unknown>>) => rows.reduce((n, r) => n + Object.values(r).reduce<number>((m, v) => m + (v === null ? 0 : String(v).length), 0), 0);
      const skeleton =
        bytesOf(db.all('SELECT * FROM source WHERE id = ?', [L.sourceId])) +
        bytesOf(db.all('SELECT * FROM source_version WHERE id = ?', [L.versionId])) +
        bytesOf(db.all('SELECT * FROM source_page WHERE version_id = ?', [L.versionId]));
      const fps = db.get<{ b: number }>('SELECT SUM(LENGTH(text_minhash) + LENGTH(COALESCE(text_norm_hash, \'\')) + LENGTH(COALESCE(image_dhash, \'\')) + LENGTH(COALESCE(layout_hash, \'\')) + 60) AS b FROM page_fingerprint WHERE version_id = ?', [L.versionId])!.b;
      console.info(`[P1-T5 measure] 40-page stub skeleton ≈ ${(skeleton / 1024).toFixed(1)} KB (+ fingerprints ≈ ${(fps / 1024).toFixed(1)} KB)`);
      expect(skeleton).toBeLessThan(12 * 1024); // ADR-0003 S5: ≈ 10.2 KB per 40-page lecture
    });
    expect(filesDirCount(w.t.ctx.config.filesDir)).toBe(blobsBefore);
  });

  it('«ابدأ الدراسة» twice reopens the same copy; the same id with another body is refused', async () => {
    const again = await startStudying(w, 'student', SPACE_A, L.lectureId); // a new client id: the copy that exists
    expect(again.created).toBe(false);
    expect(again.copy.id).toBe(copy.id);
    const replay = await w.ok<{ created: boolean; copy: DocumentCopyView }>('student', 'POST', '/api/copies', { id: copy.id, space_id: SPACE_A, lecture_id: L.lectureId, mode: 'personal' });
    expect(replay.created).toBe(false);
    const other = await w.req('student', 'POST', '/api/copies', { id: copy.id, space_id: SPACE_B, lecture_id: L.lectureId, mode: 'personal' });
    expect(other.statusCode).toBe(409);
    inVault(w, 'student', () => {
      expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM document_copy')!.n).toBe(1);
      expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source WHERE is_stub = 1')!.n).toBe(1);
    });
    const list = await w.ok<DocumentCopiesResponse>('student', 'GET', `/api/copies?space_id=${SPACE_A}&lecture_id=${L.lectureId}`);
    expect(list.copies.map((c) => c.id)).toEqual([copy.id]);
  });

  it('lecture_copy says who holds which version and how many personal items sit on it — counts only', async () => {
    expect(holdings(w, 'student', SPACE_A, L.lectureId)).toEqual([{ version_id: L.versionId, personal_items: 0 }]);
    const pages = pageIdsOf(w, SPACE_A, L.versionId);
    await writeInk(w, 'student', copy, L.versionId, pages[4]!, 4, { note: 'ملاحظة الطالب' });
    await w.ok('student', 'GET', `/api/copies/${copy.id}`);
    expect(holdings(w, 'student', SPACE_A, L.lectureId)).toEqual([{ version_id: L.versionId, personal_items: 2 }]);
    const cols = w.t.ctx.system.db.all<{ name: string }>('PRAGMA table_info(lecture_copy)').map((c) => c.name);
    expect(cols.sort()).toEqual(['lecture_id', 'personal_items', 'space_id', 'updated_at', 'user_id', 'version_id']);
  });

  it('a second student gets their own stub in their own vault; nothing of the first one reaches it', async () => {
    w.setAccess('contrib2', SPACE_A, { access: 'member' });
    const res = await startStudying(w, 'contrib2', SPACE_A, L.lectureId);
    expect(res.created).toBe(true);
    inVault(w, 'contrib2', () => {
      expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation')!.n).toBe(0);
      expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note')!.n).toBe(0);
    });
    const other = await w.req('contrib2', 'GET', `/api/copies/${copy.id}`);
    expect(other.statusCode).toBe(404);
  });
});

describe('who may start studying', () => {
  it('a non-member, a pending member and a moderator of another subject get the body of a missing item; nothing is written', async () => {
    const missing = await w.req('outsider', 'POST', '/api/copies', { id: newId(), space_id: SPACE_A, lecture_id: 'NOPE_LECTURE', mode: 'personal' });
    expect(missing.statusCode).toBe(404);
    for (const who of ['outsider', 'pending', 'modB'] as const) {
      const res = await w.req(who, 'POST', '/api/copies', { id: newId(), space_id: SPACE_A, lecture_id: L.lectureId, mode: 'personal' });
      expect(res.statusCode, who).toBe(404);
      expect(res.json()).toEqual(missing.json());
      inVault(w, who, () => expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source WHERE is_stub = 1')!.n).toBe(0));
    }
  });

  it('a draft lecture cannot be studied (404); a fork of a publication that does not exist is «not found» (step 3)', async () => {
    const draft = await w.ok<{ id: string }>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Draft only' });
    const res = await w.req('student', 'POST', '/api/copies', { id: newId(), space_id: SPACE_A, lecture_id: draft.id, mode: 'personal' });
    expect(res.statusCode).toBe(404);
    const fork = await w.req('student', 'POST', '/api/copies', { id: newId(), space_id: SPACE_A, lecture_id: L.lectureId, mode: 'independent_fork', publication_id: 'PUB1' });
    // P1-T5 step 3 builds forks and followed copies (test/forks/followed-copies.test.ts); an unknown publication id
    // answers like any missing item
    expect(fork.statusCode).toBe(404);
  });

  it('PATCH sets «انقل ملاحظاتي تلقائيًا»; another user cannot touch the copy', async () => {
    const p = await w.ok<DocumentCopyView>('student', 'PATCH', `/api/copies/${copy.id}`, { reanchor_policy: 'auto' });
    expect(p.reanchor_policy).toBe('auto');
    expect((await w.req('outsider', 'PATCH', `/api/copies/${copy.id}`, { reanchor_policy: 'preview' })).statusCode).toBe(404);
  });
});

describe('the reader opens the stub like any source', () => {
  it('page regions of a stub page come from the space while the user is a member; afterwards only the vault’s own (pinned) rows', async () => {
    const pageId = pageIdsOf(w, SPACE_A, L.versionId)[2]!;
    const official = inSpaceDb(w, SPACE_A, (db) => db.all<{ id: string }>(`SELECT id FROM source_region WHERE page_id = ? AND status <> 'rejected' ORDER BY reading_order`, [pageId]).map((r) => r.id));
    expect(official.length).toBeGreaterThan(0);
    const res = await w.ok<PageRegionsResponse>('student', 'GET', `/api/sources/pages/${pageId}/regions`);
    expect(res.page.id).toBe(pageId);
    expect(res.regions.map((r) => r.id)).toEqual(official);
    // nothing was copied into the vault by reading
    inVault(w, 'student', () => expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_region WHERE page_id = ?', [pageId])!.n).toBe(0));
    w.setAccess('student', SPACE_A, null);
    try {
      const after = await w.ok<PageRegionsResponse>('student', 'GET', `/api/sources/pages/${pageId}/regions`);
      expect(after.regions).toEqual([]);
    } finally {
      w.setAccess('student', SPACE_A, { access: 'member' });
    }
  });
});
