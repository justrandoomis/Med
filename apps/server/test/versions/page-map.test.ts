// P1-T3 step 2 — page fingerprints and the order-preserving old ↔ new page map (PRD AOS-3.12, 21.13; ARCHITECTURE_DELTA
// §6.2; Scenario 4). All inputs are labelled TEST FIXTURES (test/fixtures/versions/build.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { isCopyTarget, type PageFingerprintInput, type VersionCompareResponse, type VersionPageMap } from '@medlevo/shared';
import { minhashOf, normalizePageText, textHashOf } from '../../src/modules/processing/fingerprint';
import { alignPages, getPageMap, PAGE_MAP_ALGO, readPageMap, THRESHOLDS } from '../../src/modules/versions/pagemap';
import { scenario4V1, scenario4V1Reexport, scenario4V2, sentences } from '../fixtures/versions/build';
import type { TestApp } from '../helpers/app';
import { addSource, createProcessingApp, processVersion } from '../processing/helpers';

const fp = (id: string, i: number, text: string, extra: Partial<PageFingerprintInput> = {}): PageFingerprintInput => {
  const norm = normalizePageText([text]);
  return { page_id: id, page_index: i, text_norm_hash: textHashOf(norm), minhash: minhashOf(norm), dhash: null, layout_hash: 'L', text_len: norm.length, ...extra };
};

describe('normalisation and the pure matcher', () => {
  it('a printed page number, header or footer never changes the fingerprint', () => {
    const body = 'The rectus sheath encloses the rectus abdominis muscle and the pyramidalis.';
    expect(normalizePageText([body, 'Page 11'])).toBe(normalizePageText([body, 'Page 13']));
    expect(normalizePageText([body, 'ص ١١'])).toBe(normalizePageText([body]));
    expect(normalizePageText([body, '- 7 -'])).toBe(normalizePageText([body]));
    expect(normalizePageText([body, '12 / 40'])).toBe(normalizePageText([body]));
  });

  it('inserted, removed and changed pages; the order is preserved; nothing crosses', () => {
    const old = Array.from({ length: 8 }, (_, i) => fp(`o${i}`, i, sentences(100 + i, 6).join(' ')));
    // new: o0 o1 [X] o2 o3 o4' (rewritten) o5 o7 (o6 removed)
    const neu = [old[0]!, old[1]!, fp('x', 0, sentences(900, 6).join(' ')), old[2]!, old[3]!, fp('o4b', 0, sentences(904, 6).join(' ')), old[5]!, old[7]!].map((p, j) => ({ ...p, page_id: `n${j}`, page_index: j }));
    const res = alignPages(old, neu);
    const to = res.entries.map((e) => e.to?.page_index ?? null);
    expect(to).toEqual([0, 1, 3, 4, 5, 6, null, 7]);
    expect(res.entries.map((e) => e.status)).toEqual(['safe', 'safe', 'safe', 'safe', 'uncertain', 'safe', 'none', 'safe']);
    expect(res.inserted.map((p) => p.page_index)).toEqual([2]);
    // order preserved: the mapped indexes increase
    const mapped = to.filter((x): x is number => x !== null);
    expect([...mapped].sort((a, b) => a - b)).toEqual(mapped);
  });

  it('a moved page is found but uncertain; two identical candidates inside one gap are uncertain', () => {
    const a = Array.from({ length: 5 }, (_, i) => fp(`a${i}`, i, sentences(200 + i, 6).join(' ')));
    // page a1 moved to the end
    const b = [a[0]!, a[2]!, a[3]!, a[4]!, a[1]!].map((p, j) => ({ ...p, page_id: `b${j}`, page_index: j }));
    const res = alignPages(a, b);
    const moved = res.entries[1]!;
    expect(moved.to?.page_index).toBe(4);
    expect(moved.status).toBe('uncertain');
    expect(moved.moved).toBe(true);
    // duplicates: «Questions?» twice in the new version where the old had it once between the same neighbours
    const q = (id: string, i: number) => fp(id, i, 'Questions and discussion time for the whole class today please');
    const old2 = [fp('p0', 0, sentences(300, 6).join(' ')), q('pq', 1), fp('p2', 2, sentences(302, 6).join(' '))];
    const new2 = [fp('m0', 0, sentences(300, 6).join(' ')), q('mq1', 1), q('mq2', 2), fp('m3', 3, sentences(302, 6).join(' '))];
    const r2 = alignPages(old2, new2);
    expect(r2.entries[1]!.status).toBe('uncertain');
  });

  it('owner decisions are fixed: a confirmed pair is kept, a rejected page has no counterpart', () => {
    const old = Array.from({ length: 4 }, (_, i) => fp(`o${i}`, i, sentences(400 + i, 6).join(' ')));
    const neu = old.map((p, j) => ({ ...p, page_id: `n${j}`, page_index: j }));
    const r = alignPages(old, neu, [
      { from_page_id: 'o1', status: 'rejected', to_page_id: null },
      { from_page_id: 'o3', status: 'confirmed', to_page_id: 'n3' },
    ]);
    expect(r.entries[1]).toMatchObject({ status: 'rejected', to: null, decided_by: 'owner' });
    expect(r.entries[3]).toMatchObject({ status: 'confirmed', decided_by: 'owner' });
    expect(r.entries[3]!.to?.page_id).toBe('n3');
    expect(r.inserted.map((p) => p.page_id)).toEqual(['n1']);
  });

  it('thresholds are versioned in algo', () => {
    expect(PAGE_MAP_ALGO).toContain(`j${THRESHOLDS.jaccardSafe}`);
    expect(PAGE_MAP_ALGO).toContain(`d${THRESHOLDS.dhashSafe}`);
    expect(PAGE_MAP_ALGO).toContain('fp2:');
  });
});

describe('Scenario 4 (TEST FIXTURE): 2 pages inserted after p.10, p.30 rewritten', () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  async function twoVersions(v2: Buffer, v2Name: string) {
    t = await createProcessingApp();
    const a = await addSource(t, 'x.pdf', 'pdf', { data: scenario4V1(), fileName: 'Abdomen Lecture 5.pdf', title: 'TEST FIXTURE Abdomen Lecture 5' });
    const b = await addSource(t, 'y.pdf', 'pdf', { data: v2, fileName: v2Name, title: 'TEST FIXTURE upload' });
    await processVersion(t, a.versionId);
    await processVersion(t, b.versionId);
    return { a, b };
  }

  it('maps p.1–10 → p.1–10, two inserted pages, p.11–40 → p.13–42, p.30 → p.32 flagged changed', async () => {
    const { a, b } = await twoVersions(scenario4V2(), 'Abdomen lec5 final (1).pdf');
    const map: VersionPageMap = await getPageMap(t.ctx, a.versionId, b.versionId);
    expect(map.entries).toHaveLength(40);
    for (let p = 1; p <= 40; p++) {
      const e = map.entries[p - 1]!;
      const expectedTo = p <= 10 ? p : p + 2;
      expect(e.to_page_index, `old p.${p}`).toBe(expectedTo - 1);
      if (p === 30) {
        expect(e.change).toBe('changed');
        expect(e.status).toBe('uncertain');
        expect(isCopyTarget(e)).toBe(false);
      } else {
        expect(e.status, `old p.${p}`).toBe('safe');
        expect(e.change).toBe('unchanged');
        expect(e.layout_safe).toBe(true);
        expect(isCopyTarget(e)).toBe(true);
      }
    }
    expect(map.inserted.map((p) => p.to_page_index)).toEqual([10, 11]);
    expect(map.counts).toMatchObject({ unchanged: 39, changed: 1, inserted: 2, removed: 0, moved: 0 });
    expect(map.algo).toBe(PAGE_MAP_ALGO);
    // stored: a second call reads the same map (deterministic, no recomputation needed)
    const again = readPageMap(t.ctx, a.versionId, b.versionId)!;
    expect(again.entries.map((e) => [e.from_page_id, e.to_page_id, e.status])).toEqual(map.entries.map((e) => [e.from_page_id, e.to_page_id, e.status]));
  });

  it('a re-exported identical PDF maps every page safe with layout_safe', async () => {
    const { a, b } = await twoVersions(scenario4V1Reexport(), 'Abdomen Lecture 5 (re-export).pdf');
    const map = await getPageMap(t.ctx, a.versionId, b.versionId);
    expect(map.entries.every((e) => e.status === 'safe' && e.layout_safe && e.change === 'unchanged')).toBe(true);
    expect(map.entries.map((e) => e.to_page_index)).toEqual(map.entries.map((e) => e.from_page_index));
    expect(map.inserted).toEqual([]);
  });

  it('the compare API: rows in new order, inserted pages marked, a word diff for the rewritten page; owner decisions persist', async () => {
    const { a, b } = await twoVersions(scenario4V2(), 'Abdomen lec5 final (1).pdf');
    const h = await t.login();
    const res = await t.app.inject({ method: 'GET', url: `/api/versions/compare?from=${a.versionId}&to=${b.versionId}`, headers: h });
    expect(res.statusCode, res.body).toBe(200);
    const c = res.json() as VersionCompareResponse;
    expect(c.state).toBe('ready');
    expect(c.rows).toHaveLength(42);
    expect(c.rows.map((r) => r.to?.page_index)).toEqual(Array.from({ length: 42 }, (_, i) => i));
    expect(c.rows.filter((r) => r.change === 'inserted').map((r) => r.to!.page_index)).toEqual([10, 11]);
    const changed = c.rows.find((r) => r.change === 'changed')!;
    expect(changed.from?.page_index).toBe(29);
    expect(changed.to?.page_index).toBe(31);
    expect(changed.diff!.added.length).toBeGreaterThan(0);
    expect(changed.diff!.removed.length).toBeGreaterThan(0);
    expect(changed.from!.label_ar).toContain('30');
    expect(c.rows[0]!.to!.thumbnail).toBe(true);

    // the owner confirms the rewritten page is the same page → kept across a recomputation
    const d = await t.app.inject({
      method: 'POST',
      url: '/api/versions/maps/decide',
      headers: h,
      payload: { from_version_id: a.versionId, to_version_id: b.versionId, from_page_id: changed.from!.page_id, action: 'confirm' },
    });
    expect(d.statusCode, d.body).toBe(200);
    const after = d.json() as VersionCompareResponse;
    const row = after.rows.find((r) => r.from?.page_id === changed.from!.page_id)!;
    expect(row).toMatchObject({ status: 'confirmed', decided_by: 'owner' });
    await processVersion(t, b.versionId, { reason: 'reprocess' });
    const map = await getPageMap(t.ctx, a.versionId, b.versionId);
    expect(map.entries[29]).toMatchObject({ status: 'confirmed', to_page_index: 31 });

    // a page image for the side-by-side view
    const img = await t.app.inject({ method: 'GET', url: `/api/versions/pages/${c.rows[0]!.to!.page_id}/thumbnail`, headers: h });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.subarray(1, 4).toString()).toBe('PNG');
  });

  it('the purge deletes the maps of purged versions (both sides) and nothing of the other source', async () => {
    const { a, b } = await twoVersions(scenario4V2(), 'Abdomen lec5 final (1).pdf');
    await getPageMap(t.ctx, a.versionId, b.versionId);
    const h = await t.login();
    expect((await t.app.inject({ method: 'POST', url: `/api/sources/${b.sourceId}/trash`, headers: h })).statusCode).toBe(200);
    const impact = await t.app.inject({ method: 'GET', url: `/api/sources/${b.sourceId}/impact?mode=purge`, headers: h });
    expect(impact.statusCode, impact.body).toBe(200);
    const report = impact.json() as { confirm_token: string; lines_ar: string[] };
    expect(report.lines_ar.join(' ')).toContain('مقارنات صفحات بين النسخ (1)');
    const del = await t.app.inject({ method: 'DELETE', url: `/api/sources/${b.sourceId}?confirm_token=${encodeURIComponent(report.confirm_token)}`, headers: h });
    expect(del.statusCode, del.body).toBe(200);
    expect((del.json() as { removed: { extensions?: Record<string, Record<string, number>> } }).removed.extensions?.versions?.page_maps).toBe(1);
    const n = (sql: string, p: unknown[]) => t.ctx.db.get<{ n: number }>(sql, p)!.n;
    expect(n('SELECT COUNT(*) AS n FROM version_page_map WHERE to_version_id = ?', [b.versionId])).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM page_map_run WHERE to_version_id = ?', [b.versionId])).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM page_fingerprint WHERE version_id = ?', [b.versionId])).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM page_fingerprint WHERE version_id = ?', [a.versionId])).toBe(40);
  });
});
