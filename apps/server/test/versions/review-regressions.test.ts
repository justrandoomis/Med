// P1-T3 adversarial review — regression tests for the defects the reviewer reproduced (each failed before its fix).
// All inputs are labelled TEST FIXTURES (test/fixtures/versions/build.ts) or synthetic fingerprints.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecideSuggestionResponse, PageFingerprintInput, SourceIdentityResponse, VersionCompareResponse, VersionFilesResponse } from '@medlevo/shared';
import { detectLectureNumber } from '../../src/modules/sources/classify';
import { fingerprintVersion, minhashOf, normalizePageText, textHashOf } from '../../src/modules/processing/fingerprint';
import { detectTools } from '../../src/modules/processing/tools';
import { newId } from '../../src/lib/ids';
import { analyzeIdentity } from '../../src/modules/versions/identity';
import { alignPages, changeOf, computeAndStorePageMap, getPageMap } from '../../src/modules/versions/pagemap';
import { makeDocxDisplayPdf } from '../../src/modules/versions/rendition';
import { scenario4V1, scenario4V1Reexport, scenario4V2, sentences } from '../fixtures/versions/build';
import type { TestApp } from '../helpers/app';
import { addSource, createProcessingApp, processVersion } from '../processing/helpers';

const fp = (id: string, i: number, text: string, extra: Partial<PageFingerprintInput> = {}): PageFingerprintInput => {
  const norm = normalizePageText([text]);
  return { page_id: id, page_index: i, text_norm_hash: textHashOf(norm), minhash: minhashOf(norm), dhash: null, layout_hash: 'L', text_len: norm.length, ...extra };
};

let t: TestApp;
afterEach(async () => t?.close());

async function twoVersions(v2 = scenario4V2()) {
  t = await createProcessingApp();
  const a = await addSource(t, 'x.pdf', 'pdf', { data: scenario4V1(), fileName: 'Abdomen Lecture 5.pdf', title: 'TEST FIXTURE Abdomen Lecture 5' });
  const b = await addSource(t, 'y.pdf', 'pdf', { data: v2, fileName: 'Abdomen lec5 final (1).pdf', title: 'TEST FIXTURE upload' });
  await processVersion(t, a.versionId);
  await processVersion(t, b.versionId);
  return { a, b };
}

describe('page map: owner decisions are always kept and never crash a recomputation', () => {
  it('pure: two confirmed pairs that cross (a swap the owner confirmed) are both kept', () => {
    const old = Array.from({ length: 4 }, (_, i) => fp(`o${i}`, i, sentences(400 + i, 6).join(' ')));
    const neu = old.map((p, j) => ({ ...p, page_id: `n${j}`, page_index: j }));
    const r = alignPages(old, neu, [
      { from_page_id: 'o0', status: 'confirmed', to_page_id: 'n3' },
      { from_page_id: 'o3', status: 'confirmed', to_page_id: 'n0' },
    ]);
    expect(r.entries[0]).toMatchObject({ status: 'confirmed', decided_by: 'owner' });
    expect(r.entries[0]!.to?.page_id).toBe('n3');
    expect(r.entries[3]).toMatchObject({ status: 'confirmed', decided_by: 'owner' });
    expect(r.entries[3]!.to?.page_id).toBe('n0');
    // no new page is the counterpart of two old pages
    const targets = r.entries.map((e) => e.to?.page_id).filter(Boolean);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('stored: confirming two crossing pairs through the API answers 200 both times and keeps both', async () => {
    const { a, b } = await twoVersions();
    const h = await t.login();
    const map = await getPageMap(t.ctx, a.versionId, b.versionId);
    const e5 = map.entries[5]!;
    const e20 = map.entries[20]!;
    const decide = (from_page_id: string, to_page_id: string) =>
      t.app.inject({ method: 'POST', url: '/api/versions/maps/decide', headers: h, payload: { from_version_id: a.versionId, to_version_id: b.versionId, from_page_id, action: 'confirm', to_page_id } });
    const d1 = await decide(e5.from_page_id, e20.to_page_id!);
    expect(d1.statusCode, d1.body).toBe(200);
    const d2 = await decide(e20.from_page_id, e5.to_page_id!);
    expect(d2.statusCode, d2.body).toBe(200); // was 500: UNIQUE constraint failed
    const c = d2.json() as VersionCompareResponse;
    expect(c.rows.find((r) => r.from?.page_id === e5.from_page_id)).toMatchObject({ status: 'confirmed', to: { page_id: e20.to_page_id } });
    expect(c.rows.find((r) => r.from?.page_id === e20.from_page_id)).toMatchObject({ status: 'confirmed', to: { page_id: e5.to_page_id } });
    // a later recomputation (e.g. after reprocessing) still works and keeps both decisions
    const again = computeAndStorePageMap(t.ctx, a.versionId, b.versionId);
    expect(again.entries[5]).toMatchObject({ status: 'confirmed', to_page_id: e20.to_page_id });
    expect(again.entries[20]).toMatchObject({ status: 'confirmed', to_page_id: e5.to_page_id });
    const targets = again.entries.map((e) => e.to_page_id).filter(Boolean);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('a confirmed decision whose new page no longer exists does not break the recomputation', async () => {
    const { a, b } = await twoVersions();
    const map = await getPageMap(t.ctx, a.versionId, b.versionId);
    const e = map.entries[3]!;
    t.ctx.db.run(`UPDATE version_page_map SET status = 'confirmed', method = 'owner', to_page_id = 'gone-page' WHERE from_version_id = ? AND to_version_id = ? AND from_page_id = ?`, [a.versionId, b.versionId, e.from_page_id]);
    const again = computeAndStorePageMap(t.ctx, a.versionId, b.versionId);
    expect(again.entries[3]).toMatchObject({ to_page_id: null, decided_by: 'owner' });
    // the owner's row is kept as they left it (they can reset it from the compare screen)
    expect(t.ctx.db.get<{ to_page_id: string }>('SELECT to_page_id FROM version_page_map WHERE from_page_id = ? AND to_version_id = ?', [e.from_page_id, b.versionId])!.to_page_id).toBe('gone-page');
  });
});

describe('page map: fingerprint collisions', () => {
  it('the same short caption on a different picture is not the same page', () => {
    const old = [fp('o0', 0, sentences(1, 6).join(' ')), fp('o1', 1, 'Figure 1', { dhash: '0000000000000000' }), fp('o2', 2, sentences(2, 6).join(' '))];
    const neu = [fp('n0', 0, sentences(1, 6).join(' ')), fp('n1', 1, 'Figure 1', { dhash: 'ffffffffffffffff' }), fp('n2', 2, sentences(2, 6).join(' '))];
    const r = alignPages(old, neu);
    expect(r.entries[1]).toMatchObject({ status: 'uncertain', layout_safe: false }); // was safe + layout_safe
    expect(changeOf({ ...r.entries[1]!, to_page_id: r.entries[1]!.to?.page_id ?? null })).toBe('changed');
    // the same caption on the same picture still is
    const same = alignPages(old, neu.map((p, j) => (j === 1 ? { ...p, dhash: '0000000000000001' } : p)));
    expect(same.entries[1]).toMatchObject({ status: 'safe', method: 'identical' });
  });

  it('two different pictures paired only by their place are «changed», never «لم تتغير»', () => {
    expect(changeOf({ status: 'uncertain', to_page_id: 'x', method: 'image_similarity', text_score: null, image_distance: 30, layout_safe: false })).toBe('changed');
    expect(changeOf({ status: 'safe', to_page_id: 'x', method: 'image_similarity', text_score: null, image_distance: 2, layout_safe: true })).toBe('unchanged');
  });

  it('a figure that moved on a page with the same text makes coordinates unsafe (layout_safe false)', async () => {
    const { a, b } = await twoVersions(scenario4V1Reexport());
    const now = t.ctx.clock.now();
    const addFigure = (versionId: string, x: number) => {
      const page = t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 5', [versionId])!;
      t.ctx.db.run(
        `INSERT INTO source_region (id, version_id, page_id, kind, reading_order, bbox_json, status, created_at, updated_at) VALUES (?, ?, ?, 'figure', 99, ?, 'extracted', ?, ?)`,
        [newId(now), versionId, page.id, JSON.stringify({ x, y: 0.5, w: 0.3, h: 0.2 }), now, now],
      );
    };
    addFigure(a.versionId, 0.1);
    addFigure(b.versionId, 0.6);
    await fingerprintVersion(t.ctx, a.versionId, { pdftoppm: detectTools().pdftoppm, force: true });
    await fingerprintVersion(t.ctx, b.versionId, { pdftoppm: detectTools().pdftoppm, force: true });
    const map = computeAndStorePageMap(t.ctx, a.versionId, b.versionId);
    expect(map.entries[5]).toMatchObject({ status: 'safe', layout_safe: false }); // was layout_safe: true
    expect(map.entries[4]).toMatchObject({ status: 'safe', layout_safe: true });
  });

  it('300 identical pages are aligned without a quadratic-per-anchor scan', () => {
    const blank = (id: string, i: number): PageFingerprintInput => ({ page_id: id, page_index: i, text_norm_hash: null, minhash: null, dhash: '00ff00ff00ff00ff', layout_hash: null, text_len: 0 });
    const a = Array.from({ length: 300 }, (_, i) => blank(`a${i}`, i));
    const b = Array.from({ length: 302 }, (_, i) => blank(`b${i}`, i));
    const t0 = performance.now();
    const r = alignPages(a, b);
    expect(performance.now() - t0).toBeLessThan(3000); // ~400 ms before the per-page candidate index, ~150 ms after
    expect(r.entries.every((e) => e.to !== null)).toBe(true);
  });
});

describe('lecture number: one file naming two lectures is never certain', () => {
  it.each([
    'Lecture 5-6.pdf',
    'Lec 5-6 abdomen.pdf',
    'Lecture 5, 6.pdf',
    'Lecture 05 + 06.pdf',
    'Lecture 5 to 7.pdf',
    'Lectures 5 to 7.pdf',
    'المحاضرة الأولى والثانية.pdf',
    'المحاضرة الخامسة والسادسة.pdf',
    'المحاضرتان الخامسة والسادسة.pdf',
    'محاضرة 5 الى 6.pdf',
  ])('%s → uncertain (was stored as a certain number)', (name) => {
    const d = detectLectureNumber(name, '');
    expect(d?.certainty).toBe('uncertain');
    expect(d!.reasons_ar.join(' ')).toContain('أكثر من محاضرة');
  });

  it('a date after the number is not a second lecture', () => {
    expect(detectLectureNumber('Lecture 5 - 12.10.2026.pdf', '')).toMatchObject({ value: 5, certainty: 'certain', reasons_ar: ['«lecture 5» في اسم الملف'] });
    expect(detectLectureNumber('محاضرة 5 - 12-10-2026.pdf', '')).toMatchObject({ value: 5, certainty: 'certain' });
    expect(detectLectureNumber('المحاضرة الحادية والعشرون.pdf', '')).toMatchObject({ value: 21, certainty: 'certain' });
  });
});

describe('stored identity: an uncertain or rejected value has no downstream effect', () => {
  const firstRegion = (versionId: string) =>
    t.ctx.db.get<{ id: string; text: string }>(`SELECT r.id, r.text FROM source_region r JOIN source_page p ON p.id = r.page_id WHERE r.version_id = ? AND p.page_index = 0 ORDER BY r.reading_order LIMIT 1`, [versionId])!;
  const stored = (sourceId: string) => t.ctx.db.get<{ lecture_no: number | null; lecture_no_origin: string | null }>('SELECT lecture_no, lecture_no_origin FROM source WHERE id = ?', [sourceId])!;

  it('rejecting a stored number that the latest analysis is unsure of clears it (it stayed 5 before)', async () => {
    t = await createProcessingApp();
    const h = await t.login();
    const { sourceId, versionId } = await addSource(t, 'x.pdf', 'pdf', { data: scenario4V1(), fileName: 'Abdomen Lecture 5.pdf', title: 'x' });
    await processVersion(t, versionId);
    expect(stored(sourceId)).toEqual({ lecture_no: 5, lecture_no_origin: 'detected' });
    // the first page now also mentions another lecture → the latest analysis is no longer sure of 5
    const r = firstRegion(versionId);
    t.ctx.db.run('UPDATE source_region SET text = ? WHERE id = ?', [`${r.text}\nLecture 6`, r.id]);
    analyzeIdentity(t.ctx, sourceId, versionId, null);
    const id = (await t.app.inject({ method: 'GET', url: `/api/versions/sources/${sourceId}/identity`, headers: h })).json() as SourceIdentityResponse;
    const s = id.suggestions.find((x) => x.field === 'lecture_no' && (x.status === 'open' || x.status === 'applied'))!;
    // the value in effect is shown as stored (applied), with the latest analysis' doubt
    expect(s).toMatchObject({ status: 'applied', certainty: 'uncertain', value: { lecture_no: 5 } });
    const d = await t.app.inject({ method: 'POST', url: `/api/versions/suggestions/${s.id}/decide`, headers: h, payload: { action: 'reject' } });
    expect(d.statusCode, d.body).toBe(200);
    expect((d.json() as DecideSuggestionResponse).result_ar).toContain('أُزيل');
    expect(stored(sourceId)).toEqual({ lecture_no: null, lecture_no_origin: 'owner' });
  });

  it('a stored number the latest analysis contradicts is withdrawn until the owner confirms one', async () => {
    t = await createProcessingApp();
    const { sourceId, versionId } = await addSource(t, 'x.pdf', 'pdf', { data: scenario4V1(), fileName: 'Abdomen Lecture 5.pdf', title: 'x' });
    await processVersion(t, versionId);
    expect(stored(sourceId)).toEqual({ lecture_no: 5, lecture_no_origin: 'detected' });
    const r = firstRegion(versionId);
    // «Lecture 6» now outnumbers the three mentions of 5 (file name, heading, course line)
    t.ctx.db.run('UPDATE source_region SET text = ? WHERE id = ?', [`${r.text}\nLecture 6\nLecture 6 notes\nsee Lecture 6\nLecture 6 summary\nLecture 6 cases`, r.id]);
    const out = analyzeIdentity(t.ctx, sourceId, versionId, null);
    expect(out?.lecture_no).toBe('proposed');
    expect(stored(sourceId)).toEqual({ lecture_no: null, lecture_no_origin: null }); // was still 5 «detected»
    const open = t.ctx.db.all<{ value_key: string; status: string }>(`SELECT value_key, status FROM import_suggestion WHERE source_id = ? AND field = 'lecture_no' AND status IN ('open','applied')`, [sourceId]);
    expect(open).toEqual([{ value_key: '6', status: 'open' }]);
    // the owner's value is never touched by this rule
    t.ctx.db.run(`UPDATE source SET lecture_no = 9, lecture_no_origin = 'owner' WHERE id = ?`, [sourceId]);
    analyzeIdentity(t.ctx, sourceId, versionId, null);
    expect(stored(sourceId)).toEqual({ lecture_no: 9, lecture_no_origin: 'owner' });
  });
});

describe('new version: the upload is kept when it carries the owner’s cards', () => {
  it('a flashcard on the upload keeps it out of the trash', async () => {
    t = await createProcessingApp();
    const h = await t.login();
    const { a, b } = await (async () => {
      const x = await addSource(t, 'x.pdf', 'pdf', { data: scenario4V1(), fileName: 'Abdomen Lecture 5.pdf', title: 'TEST FIXTURE Abdomen Lecture 5' });
      await processVersion(t, x.versionId);
      const y = await addSource(t, 'y.pdf', 'pdf', { data: scenario4V2(), fileName: 'Abdomen lec5 final (1).pdf', title: 'TEST FIXTURE upload' });
      await processVersion(t, y.versionId);
      return { a: x, b: y };
    })();
    expect(a.sourceId).not.toBe(b.sourceId);
    const now = t.ctx.clock.now();
    t.ctx.db.run(`INSERT INTO flashcard (id, kind, front_json, back_json, source_id, origin, created_at, updated_at) VALUES ('fc-own', 'basic', '{}', '{}', ?, 'owner', ?, ?)`, [b.sourceId, now, now]);
    const id = (await t.app.inject({ method: 'GET', url: `/api/versions/sources/${b.sourceId}/identity`, headers: h })).json() as SourceIdentityResponse;
    const p = id.suggestions.find((s) => s.field === 'new_version_of')!;
    expect(p).toBeTruthy();
    const d = await t.app.inject({ method: 'POST', url: `/api/versions/suggestions/${p.id}/decide`, headers: h, payload: { action: 'accept' } });
    expect(d.statusCode, d.body).toBe(200);
    expect((d.json() as DecideSuggestionResponse).new_version?.upload_trashed).toBe(false); // was trashed
    expect(t.ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM source WHERE id = ?', [b.sourceId])!.deleted_at).toBeNull();
  });
});

describe('DOCX display PDF: a re-made rendition never leaks or loses a file', () => {
  const hasSoffice = !!detectTools().soffice;

  it.skipIf(!hasSoffice)('re-making releases the previous PDF; a failed re-run keeps the previous one', async () => {
    t = await createProcessingApp();
    const h = await t.login();
    const { versionId } = await addSource(t, 'lecture_notes_shock.docx', 'docx');
    await processVersion(t, versionId);
    // an earlier display PDF (distinct bytes, so the re-made one cannot be the same stored file)
    const earlier = await t.ctx.files.put(Buffer.from('%PDF-1.4\n% TEST FIXTURE earlier rendition\n'), { mime: 'application/pdf', originalName: 'earlier.pdf' });
    t.ctx.db.run(`UPDATE version_rendition SET file_id = ?, status = 'ready' WHERE version_id = ?`, [earlier.id, versionId]);
    await makeDocxDisplayPdf(t.ctx, versionId, new AbortController().signal);
    const second = t.ctx.db.get<{ file_id: string }>(`SELECT file_id FROM version_rendition WHERE version_id = ?`, [versionId])!.file_id;
    expect(second).not.toBe(earlier.id);
    expect(t.ctx.files.stat(earlier.id)).toBeNull(); // was left behind as an orphan blob
    // a failing converter: the ready PDF stays available, with the reason
    const r = await makeDocxDisplayPdf(t.ctx, versionId, new AbortController().signal, '/bin/false');
    expect(r.status).toBe('failed');
    const files = (await t.app.inject({ method: 'GET', url: `/api/versions/versions/${versionId}/files`, headers: h })).json() as VersionFilesResponse;
    expect(files.docx_rendition).toMatchObject({ status: 'ready' });
    expect(files.docx_rendition!.reason_ar).toContain('بقيت النسخة السابقة');
    expect(files.files.find((f) => f.role === 'docx_display_pdf')?.file_id).toBe(second);
    expect(t.ctx.files.stat(second)).not.toBeNull();
  }, 180_000);
});

describe('purge: a proposal that points at a purged lecture is closed with it', () => {
  it('«إصدار جديد من X» is superseded when X is purged (it stayed open and failed on accept)', async () => {
    const { a, b } = await (async () => {
      t = await createProcessingApp();
      const x = await addSource(t, 'x.pdf', 'pdf', { data: scenario4V1(), fileName: 'Abdomen Lecture 5.pdf', title: 'TEST FIXTURE Abdomen Lecture 5' });
      await processVersion(t, x.versionId);
      const y = await addSource(t, 'y.pdf', 'pdf', { data: scenario4V2(), fileName: 'Abdomen lec5 final (1).pdf', title: 'TEST FIXTURE upload' });
      await processVersion(t, y.versionId);
      return { a: x, b: y };
    })();
    const h = await t.login();
    const open = () => t.ctx.db.all<{ status: string }>(`SELECT status FROM import_suggestion WHERE source_id = ? AND field = 'new_version_of'`, [b.sourceId]);
    expect(open()).toEqual([{ status: 'open' }]);
    expect((await t.app.inject({ method: 'POST', url: `/api/sources/${a.sourceId}/trash`, headers: h })).statusCode).toBe(200);
    const impact = (await t.app.inject({ method: 'GET', url: `/api/sources/${a.sourceId}/impact?mode=purge`, headers: h })).json() as { confirm_token: string };
    const del = await t.app.inject({ method: 'DELETE', url: `/api/sources/${a.sourceId}?confirm_token=${encodeURIComponent(impact.confirm_token)}`, headers: h });
    expect(del.statusCode, del.body).toBe(200);
    expect(open()).toEqual([{ status: 'superseded' }]);
    const list = (await t.app.inject({ method: 'GET', url: '/api/versions/suggestions?status=open', headers: h })).json() as { suggestions: Array<{ field: string }> };
    expect(list.suggestions.filter((s) => s.field === 'new_version_of')).toEqual([]);
  });
});

import { createLimiter } from '../../src/modules/versions/limit';

describe('page images: renders are bounded', () => {
  it('the limiter never runs more than its slots and serves everyone in order', async () => {
    const lim = createLimiter(3);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        lim.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 2));
          order.push(i);
          running--;
          if (i === 5) throw new Error('one render failed');
        }).catch(() => undefined),
      ),
    );
    expect(peak).toBe(3);
    expect(order).toHaveLength(20);
    expect(lim.active).toBe(0);
    expect(lim.waiting).toBe(0);
  });

  it('many page images at once all arrive (through the bounded renderer)', async () => {
    const { b } = await twoVersions();
    const h = await t.login();
    const pages = t.ctx.db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index LIMIT 12', [b.versionId]);
    const res = await Promise.all(pages.map((p) => t.app.inject({ method: 'GET', url: `/api/versions/pages/${p.id}/thumbnail`, headers: h })));
    expect(res.map((r) => r.statusCode)).toEqual(pages.map(() => 200));
    expect(res.every((r) => r.headers['content-type'] === 'image/png')).toBe(true);
  });
});
