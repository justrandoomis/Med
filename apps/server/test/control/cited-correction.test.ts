// Review fix (D2 adversarial review): correcting the text of a region that evidence already QUOTES must never change
// that region's text in place. The evidence service reuses an evidence row by (region, offsets) and treats a region's
// text as immutable, so an in-place correction of the same length made the next request reuse the OLD quote (the
// very OCR error the owner corrected) and showed it as «راجعته شخصيًا». Now the cited region keeps its text verbatim
// and is excluded; the corrected text becomes its successor in the same place. Uncited regions are still corrected
// in place (review.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolveReviewResponse, ReviewItemDetail } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { fromRegion, getView } from '../../src/modules/evidence/services';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { processVersion, regions } from '../processing/helpers';
import { api, createControlApp, processed, type Api } from './helpers';

let t: TestApp;
let h: AuthHeaders;
let a: Api;
let lecture: { sourceId: string; versionId: string };

beforeAll(async () => {
  t = await createControlApp();
  lecture = await processed(t, 'lecture_appendicitis.pdf', 'lecture', 'Acute Appendicitis (TEST FIXTURE)');
  h = await t.login();
  a = api(t, h);
}, 180_000);
afterAll(async () => t?.close());

function mkItem(regionId: string, pageId: string, pageIndex: number): string {
  const id = newId(t.ctx.clock.now());
  t.ctx.db.run(
    `INSERT INTO review_queue_item (id, kind, entity_type, entity_id, source_id, reason, details_json, status, created_at)
     VALUES (?, 'ocr_error', 'source_region', ?, ?, 'ثقة منخفضة في رقم (اختبار)', ?, 'open', ?)`,
    [id, regionId, lecture.sourceId, JSON.stringify({ origin: 'processing', version_id: lecture.versionId, page_id: pageId, page_index: pageIndex }), t.ctx.clock.now()],
  );
  t.ctx.db.run(`UPDATE source_region SET status = 'needs_review' WHERE id = ?`, [regionId]);
  return id;
}

interface RegionRow {
  id: string;
  page_id: string;
  parent_region_id: string | null;
  kind: string;
  reading_order: number;
  bbox_json: string | null;
  locator_json: string | null;
  text: string | null;
  text_origin: string | null;
  status: string;
}
const region = (id: string) => t.ctx.db.get<RegionRow>('SELECT * FROM source_region WHERE id = ?', [id])!;
const successorOf = (id: string) =>
  t.ctx.db.get<RegionRow>(`SELECT * FROM source_region WHERE json_valid(locator_json) AND json_extract(locator_json, '$.supersedes_region_id') = ?`, [id]);

describe('correcting CITED text never rewrites what evidence quoted', () => {
  it('a same-length correction of a cited paragraph: old quote kept and marked excluded, new evidence only from the corrected text', async () => {
    const r = regions(t, lecture.versionId, 2).find((x) => x.text && x.kind === 'paragraph' && /\d/.test(x.text))!;
    const page = t.ctx.db.get<{ page_index: number }>('SELECT page_index FROM source_page WHERE id = ?', [r.page_id])!;
    const cited = fromRegion(t.ctx, r.id); // generated content quoted it before the owner reviewed it
    expect(cited.quote).toBe(r.text);
    // an OCR-style digit fix that keeps the length («…10» → «…16»): the dangerous case
    const m = /\d(?!.*\d)/.exec(r.text!)!;
    const corrected = r.text!.slice(0, m.index) + (m[0] === '6' ? '8' : '6') + r.text!.slice(m.index + 1);
    expect(corrected.length).toBe(r.text!.length);
    const itemId = mkItem(r.id, r.page_id, page.page_index);

    const res = await a.post<ResolveReviewResponse>(`/api/control/review/${itemId}/resolve`, { action: 'correct', text: corrected });
    expect(res.status).toBe(200);
    expect(res.body.effects_ar.join(' ')).toContain('مستشهد به');

    // the cited row keeps its text verbatim, excluded from search and new evidence
    expect(region(r.id)).toMatchObject({ text: r.text, status: 'rejected' });
    expect(() => fromRegion(t.ctx, r.id)).toThrow();
    // the corrected text lives in its successor, in the same place, owned by the owner
    const next = successorOf(r.id)!;
    expect(next).toMatchObject({ text: corrected, text_origin: 'owner', status: 'owner_reviewed', page_id: r.page_id, kind: r.kind, reading_order: region(r.id).reading_order, bbox_json: region(r.id).bbox_json });
    // a NEW request for evidence quotes the corrected text — never the old row
    const fresh = fromRegion(t.ctx, next.id);
    expect(fresh.quote).toBe(corrected);
    expect(fresh.id).not.toBe(cited.id);
    // the old citation still shows exactly what it quoted, honestly marked as excluded (not «reviewed»)
    const oldView = getView(t.ctx, cited.id);
    expect(oldView.quote).toBe(r.text);
    expect(oldView.extraction_status).toBe('rejected');
    // search holds the corrected text only
    const chunks = t.ctx.db.all<{ text: string; region_ids_json: string }>('SELECT text, region_ids_json FROM document_chunk WHERE version_id = ?', [lecture.versionId]);
    const ids = chunks.flatMap((c) => JSON.parse(c.region_ids_json) as string[]);
    expect(ids).toContain(next.id);
    expect(ids).not.toContain(r.id);
    expect(chunks.map((c) => c.text).join('\n')).toContain(corrected);

    // the review desk shows the region that holds the text now, and the history (previous text kept)
    const d = (await a.get<ReviewItemDetail>(`/api/control/review/${itemId}`)).body;
    expect(d.status).toBe('corrected');
    expect(d.structured).toMatchObject({ type: 'region', region: { id: next.id, text: corrected, text_origin: 'owner' } });
    expect(d.corrections[0]).toMatchObject({ action: 'correct', region_id: r.id, before_text: r.text, after_text: corrected });
    expect(d.original!.bbox).not.toBeNull();

    // the replaced region cannot be decided on again (a second item about it is refused, nothing changes)
    const late = mkItem(r.id, r.page_id, page.page_index);
    t.ctx.db.run(`UPDATE source_region SET status = 'rejected' WHERE id = ?`, [r.id]); // (mkItem marked it needs_review)
    expect((await a.post(`/api/control/review/${late}/resolve`, { action: 'accept' })).status).toBe(409);
    expect(region(r.id).status).toBe('rejected');

    // re-processing the page never replaces the owner's text
    await processVersion(t, lecture.versionId, { page_indexes: [page.page_index], reason: 'reprocess' });
    expect(region(next.id)).toMatchObject({ text: corrected, text_origin: 'owner' });
  });

  it('a corrected cell of a CITED table: the table keeps its quoted text, its successor holds the corrected cell', async () => {
    const table = regions(t, lecture.versionId, 2).find((x) => x.kind === 'table')!;
    const cell = t.ctx.db.get<RegionRow>(
      `SELECT * FROM source_region WHERE parent_region_id = ? AND kind = 'table_cell' AND text GLOB '*[0-9]*' ORDER BY reading_order LIMIT 1`,
      [table.id],
    )!;
    expect(cell).toBeDefined();
    const cited = fromRegion(t.ctx, table.id);
    const m = /\d/.exec(cell.text!)!;
    const corrected = cell.text!.slice(0, m.index) + (m[0] === '7' ? '9' : '7') + cell.text!.slice(m.index + 1);
    const page = t.ctx.db.get<{ page_index: number }>('SELECT page_index FROM source_page WHERE id = ?', [cell.page_id])!;
    const itemId = mkItem(cell.id, cell.page_id, page.page_index);

    const res = await a.post<ResolveReviewResponse>(`/api/control/review/${itemId}/resolve`, { action: 'correct', text: corrected });
    expect(res.status).toBe(200);

    // the cited table row is unchanged and excluded; its successor carries the corrected cell
    expect(region(table.id)).toMatchObject({ text: table.text, status: 'rejected' });
    const nextTable = successorOf(table.id)!;
    expect(nextTable.kind).toBe('table');
    expect(nextTable.text).not.toBe(table.text);
    expect(nextTable.text).toContain(corrected);
    // every cell (the corrected one included) now belongs to the successor table
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_region WHERE parent_region_id = ?', [table.id])!.n).toBe(0);
    const cellNow = t.ctx.db.get<RegionRow>(`SELECT * FROM source_region WHERE parent_region_id = ? AND text = ?`, [nextTable.id, corrected]);
    expect(cellNow).toBeDefined();
    // old citation unchanged; new evidence from the table quotes the corrected text
    expect(getView(t.ctx, cited.id).quote).toBe(table.text);
    expect(fromRegion(t.ctx, nextTable.id).quote).toContain(corrected);
  });
});

describe('other review fixes', () => {
  it('review items closed together with a region decision are each in the history (no silent closing)', async () => {
    const r = regions(t, lecture.versionId, 1).find((x) => x.text && x.kind === 'paragraph' && x.status !== 'rejected')!;
    const page = t.ctx.db.get<{ page_index: number }>('SELECT page_index FROM source_page WHERE id = ?', [r.page_id])!;
    const first = mkItem(r.id, r.page_id, page.page_index);
    const second = mkItem(r.id, r.page_id, page.page_index);
    const res = await a.post<ResolveReviewResponse>(`/api/control/review/${first}/resolve`, { action: 'accept' });
    expect(res.status).toBe(200);
    expect(t.ctx.db.get<{ status: string }>('SELECT status FROM review_queue_item WHERE id = ?', [second])!.status).toBe('accepted');
    const audit = t.ctx.db.all<{ action: string }>(`SELECT action FROM change_log WHERE entity_type = 'review_queue_item' AND entity_id = ?`, [second]);
    expect(audit.map((x) => x.action)).toEqual(['review_accepted']);
  });

  it('every control route refuses a request without the owner session', async () => {
    const item = t.ctx.db.get<{ id: string }>('SELECT id FROM review_queue_item LIMIT 1')!;
    const calls: Array<{ method: 'GET' | 'POST'; url: string; payload?: object }> = [
      { method: 'GET', url: `/api/control/review/${item.id}` },
      { method: 'POST', url: '/api/control/impact/preview', payload: { change: { kind: 'model', role: 'generation', model: 'x' } } },
      { method: 'POST', url: '/api/control/impact/apply', payload: { change: { kind: 'settings', patch: { dialect: 'iraqi_teaching' } }, confirm_token: '0123456789abcdef' } },
    ];
    for (const c of calls) {
      const res = await t.app.inject({ method: c.method, url: c.url, headers: { 'x-medlevo-csrf': '1' }, ...(c.payload ? { payload: c.payload } : {}) });
      expect(res.statusCode, c.url).toBe(401);
    }
    expect(t.ctx.settings.get().dialect).not.toBe('iraqi_teaching');
  });
});
