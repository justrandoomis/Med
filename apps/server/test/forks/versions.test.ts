// P1-T5 step 2 — a new OFFICIAL version reaches the copies (BUILD_PLAN §3.7; ARCHITECTURE_DELTA §6.3; PRD Scenario 4,
// Q35): the fan-out reads `lecture_copy` (never a scan of vaults), each holder's vault gets the new version as a stub
// with the official page map and a content alert; the user's notes are COPIED with P1-T2's one-tap flow (preview first,
// nothing changes until the tap) or automatically when they chose «انقل ملاحظاتي تلقائيًا». The original items are never
// changed. A withdrawal keeps every copy and note; a rights takedown nulls the stub's file references and deletes the
// vault's file rows with foreign_keys ON — ink and notes stay over placeholders. A purge of an official lecture is
// refused while any vault holds personal items on it (a count, never names).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentCopyView, ReanchorCopyPreview, ReanchorCopyRunResponse } from '@medlevo/shared';
import { buildImpactReport, computeImpact, executePurge } from '../../src/modules/sources/purge';
import { createLectureWorld, drain, inSpace, pagesFor, SPACE_A, sp, type LectureWorld } from '../lectures/world';
import { holdings, inVault, pageIdsOf, publishLecture, publishVersion, startStudying, type Published, writeInk } from './helpers';

let w: LectureWorld;
let L: Published;
let copy: DocumentCopyView;
let auto: DocumentCopyView;
let v2 = '';
let ink5 = '';
let note9 = '';

const V1 = pagesFor('Hepatic', 12);
// v2: two pages inserted after p.3, p.9 rewritten (Scenario 4 shape)
const V2 = [...V1.slice(0, 3), ['Inserted page one about portal hypertension', 'New material A', 'More text A'], ['Inserted page two about varices', 'New material B', 'More text B'], ...pagesFor('Hepatic', 12, { 8: 'COMPLETELY REWRITTEN PAGE about hepatic encephalopathy grading' }).slice(3)];
const V2_REWRITTEN = V2.map((p, i) => (i === 10 ? ['COMPLETELY different words now for page nine', 'ammonia lactulose rifaximin', 'west haven criteria'] : p));

const rowsOf = (ids: string[]) => w.t.ctx.db.all(`SELECT * FROM annotation WHERE id IN (${ids.map(() => '?').join(',')}) UNION ALL SELECT id, NULL, NULL, anchor_json, body_json, NULL, NULL, NULL, NULL, previous_anchor_json, NULL, device_id, rev, created_at, updated_at, deleted_at, conflict_of_id, layer_id, author_user_id, migrated_from_id, origin, detached_at FROM note WHERE id IN (${ids.map(() => '?').join(',')})`, [...ids, ...ids]);

beforeAll(async () => {
  w = await createLectureWorld();
  L = await publishLecture(w, SPACE_A, 'Liver (TEST FIXTURE)', V1);
  copy = (await startStudying(w, 'student', SPACE_A, L.lectureId)).copy;
  const pages = pageIdsOf(w, SPACE_A, L.versionId);
  ink5 = (await writeInk(w, 'student', copy, L.versionId, pages[4]!, 4)).inkId;
  note9 = (await writeInk(w, 'student', copy, L.versionId, pages[8]!, 8, { note: 'ملاحظتي على الصفحة التاسعة', x: 0.5 })).noteId!;
  // a second student who chose «انقل ملاحظاتي تلقائيًا»
  w.setAccess('contrib2', SPACE_A, { access: 'member' });
  auto = (await startStudying(w, 'contrib2', SPACE_A, L.lectureId)).copy;
  await writeInk(w, 'contrib2', auto, L.versionId, pages[4]!, 4);
  await w.ok('contrib2', 'PATCH', `/api/copies/${auto.id}`, { reanchor_policy: 'auto' });
  await w.ok('student', 'GET', `/api/copies/${copy.id}`); // refreshes the holder counts
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('a new official version reaches every copy', () => {
  it('the publish preview counts the holders (suppressed under 5) — never names', async () => {
    const up = await w.upload('mod', sp(SPACE_A, `/lectures/${L.lectureId}/upload`), { name: 'liver v2.pdf', data: (await import('../lectures/world')).lecturePdf(V2_REWRITTEN) });
    expect(up.statusCode, up.body).toBe(200);
    v2 = (up.json() as { version_id: string }).version_id;
    await drain(w);
    const preview = await w.ok<{ holders: { value: number | null; label_ar: string } }>('mod', 'POST', sp(SPACE_A, `/lectures/${L.lectureId}/versions/${v2}/publish`), { preview: true });
    expect(preview.holders).toEqual({ value: null, label_ar: 'أقل من 5' });
  });

  it('after publish + page map, each holder vault holds v2 with the official page map and an alert; v1 items untouched', async () => {
    const before = inVault(w, 'student', () => JSON.stringify(rowsOf([ink5, note9])));
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${L.lectureId}/versions/${v2}/publish`), {});
    await drain(w);
    await drain(w);
    inVault(w, 'student', () => {
      const db = w.t.ctx.db;
      expect(db.get<{ current_version_id: string }>('SELECT current_version_id FROM source WHERE id = ?', [L.sourceId])!.current_version_id).toBe(v2);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ?', [v2])!.n).toBe(14);
      const spaceMap = inSpace(w, SPACE_A, () => w.t.ctx.db.all('SELECT from_page_id, to_page_id, status FROM version_page_map WHERE from_version_id = ? AND to_version_id = ? ORDER BY from_page_id', [L.versionId, v2]));
      expect(db.all('SELECT from_page_id, to_page_id, status FROM version_page_map WHERE from_version_id = ? AND to_version_id = ? ORDER BY from_page_id', [L.versionId, v2])).toEqual(spaceMap);
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM content_alert WHERE source_id = ? AND source_version_id = ? AND kind = 'source_replaced'`, [L.sourceId, v2])!.n).toBe(1);
      expect(JSON.stringify(rowsOf([ink5, note9]))).toBe(before);
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM annotation WHERE origin = 'reanchor_copy'`)!.n).toBe(0); // nothing moved without the tap
      expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    });
    expect(holdings(w, 'student', SPACE_A, L.lectureId).sort((a, b) => a.personal_items - b.personal_items)).toEqual(
      [
        { version_id: v2, personal_items: 0 },
        { version_id: L.versionId, personal_items: 3 }, // ink p.5, ink + note p.9
      ].sort((a, b) => a.personal_items - b.personal_items),
    );
  });

  it('the one-tap note copy (P1-T2) previews, copies the safe item, lists the rewritten page for review — and is idempotent', async () => {
    const preview = await w.ok<ReanchorCopyPreview>('student', 'GET', `/api/annotations/reanchor-copy?source_id=${L.sourceId}&to_version_id=${v2}`);
    expect(preview.state).toBe('ready');
    expect(preview.from_version?.id).toBe(L.versionId);
    expect(preview.copy).toBe(1); // the ink on p.5 → v2 p.7 (two pages inserted before it)
    expect(preview.needs_review).toBe(2); // the ink and the note on the rewritten page are never guessed
    const v2Pages = pageIdsOf(w, SPACE_A, v2);
    expect(preview.will_copy.map((x) => x.page.page_id)).toEqual([v2Pages[6]]);
    const before = inVault(w, 'student', () => JSON.stringify(rowsOf([ink5, note9])));
    const run = await w.ok<ReanchorCopyRunResponse>('student', 'POST', '/api/annotations/reanchor-copy', { source_id: L.sourceId, from_version_id: L.versionId, to_version_id: v2, map_computed_at: preview.map_computed_at });
    expect(run.report.copied).toBe(1);
    inVault(w, 'student', () => expect(JSON.stringify(rowsOf([ink5, note9]))).toBe(before)); // copy, never move
    const again = await w.ok<ReanchorCopyRunResponse>('student', 'POST', '/api/annotations/reanchor-copy', { source_id: L.sourceId, from_version_id: L.versionId, to_version_id: v2, map_computed_at: preview.map_computed_at });
    expect(again.report.copied).toBe(0);
    await w.ok('student', 'GET', `/api/copies/${copy.id}`);
    expect(holdings(w, 'student', SPACE_A, L.lectureId).find((h) => h.version_id === v2)?.personal_items).toBe(1);
  });

  it('«انقل ملاحظاتي تلقائيًا»: the same copy ran without the tap, same rules, the original kept', async () => {
    inVault(w, 'contrib2', () => {
      const db = w.t.ctx.db;
      const copies = db.all<{ migrated_from_id: string; anchor_json: string }>(`SELECT migrated_from_id, anchor_json FROM annotation WHERE origin = 'reanchor_copy'`);
      expect(copies).toHaveLength(1);
      expect(JSON.parse(copies[0]!.anchor_json).version_id).toBe(v2);
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM annotation WHERE id = ? AND deleted_at IS NULL`, [copies[0]!.migrated_from_id])!.n).toBe(1);
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reanchor_copy_run WHERE to_version_id = ?`, [v2])!.n).toBe(1);
    });
  });

  it('a former member keeps their copy as it is and gets no new version', async () => {
    w.setAccess('contrib2', SPACE_A, null);
    const v3 = await publishVersion(w, SPACE_A, L.lectureId, V2_REWRITTEN.map((p, i) => (i === 0 ? ['v3 cover page changed', 'x', 'y'] : p)), 'v3.pdf');
    await drain(w);
    inVault(w, 'contrib2', () => expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_version WHERE id = ?', [v3])!.n).toBe(0));
    inVault(w, 'student', () => expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_version WHERE id = ?', [v3])!.n).toBe(1));
    const view = await w.ok<DocumentCopyView>('contrib2', 'GET', `/api/copies/${auto.id}`);
    expect(view.official?.status).toBe('unavailable');
    expect(view.newer_official_version).toBeNull(); // nothing of the subject reaches a former member
    w.setAccess('contrib2', SPACE_A, { access: 'member' });
  });
});

describe('purge, withdrawal and the rights takedown', () => {
  it('a purge of the official lecture is refused while a vault holds personal items on it — a suppressed count, no names', async () => {
    const res = inSpace(w, SPACE_A, () => {
      const report = buildImpactReport(w.t.ctx, 'source', L.sourceId, { sourceIds: [L.sourceId] }, 'purge');
      expect(report.lines_ar.join(' ')).toContain('لا يُحذف نهائيًا ما دامت ملاحظاتهم عليها');
      expect(computeImpact(w.t.ctx, { sourceIds: [L.sourceId] }).extensions?.forks?.holders_with_items).toBeGreaterThan(0);
      try {
        executePurge(w.t.ctx, 'source', L.sourceId, { sourceIds: [L.sourceId] }, report.confirm_token, { summary: 'test purge', before: null });
        return null;
      } catch (e) {
        return e as { code: string; statusCode: number; message: string; details?: unknown };
      }
    });
    expect(res?.code).toBe('CONFLICT');
    expect(JSON.stringify(res)).not.toContain(w.id.student);
    expect(res?.message).toContain('أقل من 5');
    inSpace(w, SPACE_A, () => expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM official_lecture WHERE id = ?', [L.lectureId])!.n).toBe(1));
  });

  it('a lecture whose holders wrote nothing on it can be purged: only space rows go, the stubs stay in the vaults', async () => {
    const M = await publishLecture(w, SPACE_A, 'Spleen (TEST FIXTURE)', pagesFor('Spleen', 3));
    await startStudying(w, 'student', SPACE_A, M.lectureId);
    const out = inSpace(w, SPACE_A, () => {
      const report = buildImpactReport(w.t.ctx, 'source', M.sourceId, { sourceIds: [M.sourceId] }, 'purge');
      return executePurge(w.t.ctx, 'source', M.sourceId, { sourceIds: [M.sourceId] }, report.confirm_token, { summary: 'test purge', before: null });
    });
    expect(out.counts.sources).toBe(1);
    inSpace(w, SPACE_A, () => expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM official_lecture WHERE id = ?', [M.lectureId])!.n).toBe(0));
    inVault(w, 'student', () => expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source WHERE id = ?', [M.sourceId])!.n).toBe(1));
    expect(holdings(w, 'student', SPACE_A, M.lectureId)).toEqual([]);
  });

  it('a rights takedown nulls the stub file references, then deletes the vault file rows (FK ON); ink and notes stay', async () => {
    const before = inVault(w, 'student', () => ({
      files: w.t.ctx.db.all<{ id: string }>('SELECT DISTINCT file_id AS id FROM source_version WHERE source_id = ? AND file_id IS NOT NULL', [L.sourceId]).map((r) => r.id),
      items: w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation WHERE deleted_at IS NULL')!.n + w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note WHERE deleted_at IS NULL')!.n,
    }));
    expect(before.files.length).toBeGreaterThan(0);
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${L.lectureId}/withdraw`), { reason: 'rights_takedown', note_ar: 'طلب صاحب الحقوق سحب الملف' });
    await drain(w);
    inVault(w, 'student', () => {
      const db = w.t.ctx.db;
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_version WHERE source_id = ? AND (file_id IS NOT NULL OR original_file_id IS NOT NULL OR display_file_id IS NOT NULL)', [L.sourceId])!.n).toBe(0);
      for (const f of before.files) expect(db.get('SELECT 1 AS x FROM stored_file WHERE id = ?', [f])).toBeUndefined();
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id IN (SELECT id FROM source_version WHERE source_id = ?)', [L.sourceId])!.n).toBeGreaterThan(0);
      const items = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation WHERE deleted_at IS NULL')!.n + db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note WHERE deleted_at IS NULL')!.n;
      expect(items).toBe(before.items);
      expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    });
    const view = await w.ok<DocumentCopyView>('student', 'GET', `/api/copies/${copy.id}`);
    expect(view.official).toMatchObject({ status: 'withdrawn', file_removed: true });
    expect(view.official?.note_ar).toContain('بقيت ملاحظاتك');
    // a withdrawn lecture is never started anew, but the copy that exists reopens
    const again = await startStudying(w, 'student', SPACE_A, L.lectureId);
    expect(again.created).toBe(false);
    expect(again.copy.id).toBe(copy.id);
  });
});
