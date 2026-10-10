// Review Queue across all kinds (§48, AC-26): list / filter / counts, detail (original location + structured data +
// specific reason), resolution per kind, OCR/region correction → owner text + history + audit + search + content
// change alert for dependents, nothing regenerated, attempts untouched; page transcription; routing of items owned
// by other screens; auth. Golden Set fixtures go through the REAL processing pipeline (no OCR tools installed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolveReviewResponse, ReviewItemDetail, ReviewQueueListResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { recordDependencies } from '../../src/modules/evidence/services';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { CSRF } from '../helpers/app';
import { processVersion, regions } from '../processing/helpers';
import { api, createControlApp, insertArtifactWithRules, openItems, processed, type Api } from './helpers';

let t: TestApp;
let h: AuthHeaders;
let a: Api;
let lecture: { sourceId: string; versionId: string };
let scanned: { sourceId: string; versionId: string };

beforeAll(async () => {
  t = await createControlApp();
  lecture = await processed(t, 'lecture_appendicitis.pdf', 'lecture', 'Acute Appendicitis (TEST FIXTURE)');
  scanned = await processed(t, 'mixed_scanned_lecture.pdf', 'lecture', 'Mixed scanned (TEST FIXTURE)');
  h = await t.login();
  a = api(t, h);
}, 180_000);
afterAll(async () => t?.close());

let flagged: ReturnType<typeof regions>[number] | null = null;
/** the region processing flagged («عادةS»: a tanween read as a Latin S) — captured before it is corrected */
function flaggedRegion() {
  if (flagged) return flagged;
  const r = regions(t, lecture.versionId, 0).find((x) => x.text?.includes('عادةS'));
  if (!r) throw new Error('fixture region not found');
  flagged = r;
  return r;
}

function itemFor(entityId: string) {
  return t.ctx.db.get<{ id: string; status: string; resolution_json: string | null }>(`SELECT id, status, resolution_json FROM review_queue_item WHERE entity_id = ? ORDER BY created_at LIMIT 1`, [entityId])!;
}

describe('list, filters and counts', () => {
  it('lists open items of every kind with the specific reason, page label and real counts', async () => {
    const r = await a.get<ReviewQueueListResponse>('/api/control/review');
    expect(r.status).toBe(200);
    const ocr = r.body.items.find((i) => i.entity_id === flaggedRegion().id)!;
    expect(ocr).toMatchObject({ kind: 'ocr_error', kind_label_ar: expect.any(String), status: 'open', origin: 'processing', handled_in: 'control', link: null });
    expect(ocr.reason).toContain('«S»');
    expect(ocr.location_label_ar).toBe('ص 11 (الصفحة 1 في الملف)');
    expect(ocr.source_title).toBe('Acute Appendicitis (TEST FIXTURE)');
    const unreadable = r.body.items.find((i) => i.kind === 'unreadable_page' && i.source_id === scanned.sourceId)!;
    expect(unreadable.entity_type).toBe('source_page');
    // counts are real (match the table)
    const n = t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_queue_item WHERE status = 'open'`)!.n;
    expect(r.body.counts.open).toBe(n);
    expect(r.body.counts.open_by_kind.ocr_error).toBe(openItems(t, 'ocr_error').length);
    expect(r.body.sources.map((s) => s.id)).toEqual(expect.arrayContaining([lecture.sourceId, scanned.sourceId]));
  });

  it('filters by kind, source and status, and pages with a cursor', async () => {
    const byKind = await a.get<ReviewQueueListResponse>('/api/control/review?kind=unreadable_page');
    expect(byKind.body.items.length).toBeGreaterThan(0);
    expect(byKind.body.items.every((i) => i.kind === 'unreadable_page')).toBe(true);
    const bySource = await a.get<ReviewQueueListResponse>(`/api/control/review?source_id=${lecture.sourceId}`);
    expect(bySource.body.items.every((i) => i.source_id === lecture.sourceId)).toBe(true);
    const page1 = await a.get<ReviewQueueListResponse>('/api/control/review?limit=1');
    expect(page1.body.items).toHaveLength(1);
    if (page1.body.counts.open > 1) {
      expect(page1.body.next_cursor).toBeTruthy();
      const page2 = await a.get<ReviewQueueListResponse>(`/api/control/review?limit=1&cursor=${page1.body.next_cursor}`);
      expect(page2.body.items[0]!.id).not.toBe(page1.body.items[0]!.id);
    }
    expect((await a.get('/api/control/review?kind=not_a_kind')).status).toBe(400);
    expect((await a.get('/api/control/review?cursor=../../etc')).status).toBe(400);
  });

  it('hides items of a source in the trash and brings them back on restore', async () => {
    const before = (await a.get<ReviewQueueListResponse>(`/api/control/review?source_id=${scanned.sourceId}`)).body.items.length;
    expect(before).toBeGreaterThan(0);
    // (the sources module's own trash semantics: deleted_at set on the source)
    t.ctx.db.run('UPDATE source SET deleted_at = ? WHERE id = ?', [t.ctx.clock.now(), scanned.sourceId]);
    expect((await a.get<ReviewQueueListResponse>(`/api/control/review?source_id=${scanned.sourceId}`)).body.items).toHaveLength(0);
    const one = openItems(t).find((i) => i.source_id === scanned.sourceId)!;
    expect((await a.post(`/api/control/review/${one.id}/resolve`, { action: 'dismiss' })).status).toBe(409);
    t.ctx.db.run('UPDATE source SET deleted_at = NULL WHERE id = ?', [scanned.sourceId]);
    expect((await a.get<ReviewQueueListResponse>(`/api/control/review?source_id=${scanned.sourceId}`)).body.items.length).toBe(before);
  });
});

describe('detail: original location + structured data + reason', () => {
  it('points at the source, version, page and region box, renderable from the original PDF', async () => {
    const item = itemFor(flaggedRegion().id);
    const r = await a.get<ReviewItemDetail>(`/api/control/review/${item.id}`);
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.original).toMatchObject({
      source_id: lecture.sourceId,
      version_id: lecture.versionId,
      version_no: 1,
      is_active_version: true,
      page_index: 0,
      page_label_ar: 'ص 11 (الصفحة 1 في الملف)',
      render: { kind: 'pdf', page_index: 0 },
    });
    expect(d.original!.bbox).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) }));
    expect(d.original!.open_link!.href).toContain(`/study/${lecture.sourceId}?v=${lecture.versionId}&page=0`);
    expect(d.structured).toMatchObject({ type: 'region', region: { id: flaggedRegion().id, text_origin: 'digital', status: 'needs_review' } });
    if (d.structured.type === 'region') expect(d.structured.region.text).toContain('عادةS');
    expect(d.actions.map((x) => x.action)).toEqual(['accept', 'correct', 'reject', 'dismiss']);
    expect(d.actions.find((x) => x.action === 'correct')!.effect_ar).toContain('سجل التصحيحات');
    expect(d.resolution).toBeNull();
    expect((await a.get('/api/control/review/NOPE0000000000000000000000')).status).toBe(404);
  });
});

describe('OCR / region correction (AC-26)', () => {
  it('stores the owner text, keeps the previous text, audits, re-indexes and alerts every dependent — without regenerating', async () => {
    const region = flaggedRegion();
    const item = itemFor(region.id);
    // dependents built on that page: a generated explanation citing the region, a flashcard-like dependent and
    // a question version with an attempt (the attempt must never change)
    const artifactId = insertArtifactWithRules(t, { sourceId: lecture.sourceId, versionIds: [lecture.versionId], regionIds: [region.id] });
    const otherPageRegion = regions(t, lecture.versionId, 2).find((x) => x.text && x.kind !== 'header' && x.kind !== 'footer')!;
    const unaffectedArtifact = insertArtifactWithRules(t, { sourceId: lecture.sourceId, versionIds: [lecture.versionId], regionIds: [otherPageRegion.id] });
    recordDependencies(t.ctx, 'question_version', 'QV-TEST-1', [lecture.versionId], [region.id]);
    const artifactsBefore = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact')!.n;
    const jobsBefore = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM processing_job')!.n;
    const corrected = region.text!.replace('عادةS', 'عادةً');

    const res = await a.post<ResolveReviewResponse>(`/api/control/review/${item.id}/resolve`, { action: 'correct', text: corrected, note: 'تنوين مقروء كحرف S' });
    expect(res.status).toBe(200);
    // region: owner text, owner_reviewed
    const after = t.ctx.db.get<{ text: string; text_origin: string; status: string; confidence: number | null }>('SELECT text, text_origin, status, confidence FROM source_region WHERE id = ?', [region.id])!;
    expect(after).toMatchObject({ text: corrected, text_origin: 'owner', status: 'owner_reviewed' });
    // history keeps the previous text verbatim
    const hist = t.ctx.db.get<{ before_text: string; after_text: string; before_origin: string; before_status: string; alert_id: string | null; action: string }>(
      'SELECT * FROM control_region_correction WHERE region_id = ?',
      [region.id],
    )!;
    expect(hist).toMatchObject({ action: 'correct', before_text: region.text, after_text: corrected, before_origin: 'digital', before_status: 'needs_review' });
    // review item resolved with resolution_json
    const it2 = itemFor(region.id);
    expect(it2.status).toBe('corrected');
    const resolution = JSON.parse(it2.resolution_json!);
    expect(resolution).toMatchObject({ by: 'owner', via: 'control', action: 'correct', note: 'تنوين مقروء كحرف S', alert_id: hist.alert_id });
    // audit: region correction (before/after) + review item resolution
    const audit = t.ctx.db.all<{ entity_type: string; action: string; before_json: string; after_json: string }>(
      `SELECT entity_type, action, before_json, after_json FROM change_log WHERE entity_id IN (?, ?) ORDER BY created_at`,
      [region.id, item.id],
    );
    expect(audit.map((x) => `${x.entity_type}:${x.action}`)).toEqual(expect.arrayContaining(['source_region:correct', 'review_queue_item:review_corrected']));
    const ra = audit.find((x) => x.entity_type === 'source_region')!;
    expect(JSON.parse(ra.before_json).text).toContain('عادةS');
    expect(JSON.parse(ra.after_json).text).toContain('عادةً');
    // search finds the corrected text; the defect is gone from the index
    const chunks = t.ctx.db.all<{ text: string }>('SELECT text FROM document_chunk WHERE version_id = ?', [lecture.versionId]).map((c) => c.text).join('\n');
    expect(chunks).toContain('عادةً');
    expect(chunks).not.toContain('عادةS');
    // content change alert (AC-26): the dependents on page 1 are listed, the artifact is stale (not regenerated)
    expect(res.body.alert).not.toBeNull();
    const alert = t.ctx.db.get<{ kind: string; status: string; summary: string }>('SELECT kind, status, summary FROM content_alert WHERE id = ?', [res.body.alert!.id])!;
    expect(alert.status).toBe('open');
    expect(alert.summary).toContain('سجل التصحيحات');
    const alertItems = t.ctx.db.all<{ dependent_type: string; dependent_id: string; impact: string }>('SELECT dependent_type, dependent_id, impact FROM content_alert_item WHERE alert_id = ?', [res.body.alert!.id]);
    expect(alertItems).toEqual(expect.arrayContaining([{ dependent_type: 'artifact', dependent_id: artifactId, impact: 'needs_regeneration' }, { dependent_type: 'question_version', dependent_id: 'QV-TEST-1', impact: 'needs_review' }]));
    expect(alertItems.find((x) => x.dependent_id === unaffectedArtifact)?.impact ?? 'still_valid').toBe('still_valid');
    expect(t.ctx.db.get<{ status: string }>('SELECT status FROM artifact WHERE id = ?', [artifactId])!.status).toBe('stale');
    expect(t.ctx.db.get<{ status: string }>('SELECT status FROM artifact WHERE id = ?', [unaffectedArtifact])!.status).toBe('published');
    // nothing regenerated: no new artifacts, no generation job
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact')!.n).toBe(artifactsBefore);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM processing_job')!.n).toBe(jobsBefore);
    expect(res.body.effects_ar.join(' ')).toContain('لم يُعَد توليد أي شيء تلقائيًا');
    // the detail now shows the decision and the correction history (previous text kept)
    const d = res.body.item;
    expect(d.status).toBe('corrected');
    expect(d.actions).toEqual([]);
    expect(d.corrections[0]).toMatchObject({ action: 'correct', before_text: region.text, after_text: corrected });
    expect(d.resolution).toMatchObject({ action: 'correct', note: 'تنوين مقروء كحرف S', alert_id: hist.alert_id });
    // the history viewer shows it in words
    const histView = await a.get(`/api/control/history?entity_type=source_region&entity_id=${region.id}`);
    expect(histView.body.entries[0]).toMatchObject({ entity_label_ar: 'نص في صفحة', action_label_ar: 'تصحيح', actor_label_ar: 'أنت' });
    expect(histView.body.entries[0].changes.find((c: { label: string }) => c.label === 'النص')).toBeDefined();
  });

  it('refuses to resolve twice and never lets re-processing replace the owner text', async () => {
    const region = flaggedRegion();
    const item = itemFor(region.id);
    const again = await a.post(`/api/control/review/${item.id}/resolve`, { action: 'accept' });
    expect(again.status).toBe(409);
    const ownerText = t.ctx.db.get<{ text: string }>('SELECT text FROM source_region WHERE id = ?', [region.id])!.text;
    await processVersion(t, lecture.versionId, { page_indexes: [0], reason: 'reprocess' });
    const kept = t.ctx.db.get<{ text: string; text_origin: string }>('SELECT text, text_origin FROM source_region WHERE id = ?', [region.id]);
    expect(kept).toMatchObject({ text: ownerText, text_origin: 'owner' });
  });

  it('validates the correction: unchanged text, empty text, unknown action, bidi controls stripped', async () => {
    const r = regions(t, lecture.versionId, 1).find((x) => x.text && x.kind === 'paragraph')!;
    const id = newId(t.ctx.clock.now());
    t.ctx.db.run(
      `INSERT INTO review_queue_item (id, kind, entity_type, entity_id, source_id, reason, details_json, status, created_at)
       VALUES (?, 'ocr_error', 'source_region', ?, ?, 'سبب للاختبار', ?, 'open', ?)`,
      [id, r.id, lecture.sourceId, JSON.stringify({ origin: 'processing', version_id: lecture.versionId, page_id: r.page_id }), t.ctx.clock.now()],
    );
    expect((await a.post(`/api/control/review/${id}/resolve`, { action: 'correct', text: r.text })).status).toBe(400);
    expect((await a.post(`/api/control/review/${id}/resolve`, { action: 'correct', text: '   ' })).status).toBe(400);
    expect((await a.post(`/api/control/review/${id}/resolve`, { action: 'correct' })).status).toBe(400);
    expect((await a.post(`/api/control/review/${id}/resolve`, { action: 'approve' })).status).toBe(400);
    expect((await a.post(`/api/control/review/${id}/resolve`, { action: 'dismiss', extra: 1 })).status).toBe(400);
    // nothing changed by the refused requests
    expect(t.ctx.db.get<{ status: string }>('SELECT status FROM review_queue_item WHERE id = ?', [id])!.status).toBe('open');
    // stored text is logical order without invisible bidi controls
    const ok = await a.post(`/api/control/review/${id}/resolve`, { action: 'correct', text: `\u202B${r.text} (مصحَّح)\u202C` });
    expect(ok.status).toBe(200);
    const stored = t.ctx.db.get<{ text: string }>('SELECT text FROM source_region WHERE id = ?', [r.id])!.text;
    expect(stored).toBe(`${r.text} (مصحَّح)`);
  });
});

describe('accept / reject / dismiss on extracted text', () => {
  function makeItem(regionId: string, sourceId: string, pageId: string, versionId: string): string {
    const id = newId(t.ctx.clock.now());
    t.ctx.db.run(
      `INSERT INTO review_queue_item (id, kind, entity_type, entity_id, source_id, reason, details_json, status, created_at)
       VALUES (?, 'ocr_error', 'source_region', ?, ?, 'ثقة منخفضة في كلمات: test', ?, 'open', ?)`,
      [id, regionId, sourceId, JSON.stringify({ origin: 'processing', version_id: versionId, page_id: pageId, page_index: 2 }), t.ctx.clock.now()],
    );
    t.ctx.db.run(`UPDATE source_region SET status = 'needs_review' WHERE id = ?`, [regionId]);
    return id;
  }

  it('accept confirms the text without changing it and creates no alert', async () => {
    const r = regions(t, lecture.versionId, 2).find((x) => x.text && x.kind === 'paragraph')!;
    const itemId = makeItem(r.id, lecture.sourceId, r.page_id, lecture.versionId);
    const alertsBefore = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_alert')!.n;
    const res = await a.post<ResolveReviewResponse>(`/api/control/review/${itemId}/resolve`, { action: 'accept' });
    expect(res.status).toBe(200);
    expect(res.body.alert).toBeNull();
    expect(t.ctx.db.get('SELECT text, status FROM source_region WHERE id = ?', [r.id])).toEqual({ text: r.text, status: 'owner_reviewed' });
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_alert')!.n).toBe(alertsBefore);
    expect(res.body.item.corrections[0]).toMatchObject({ action: 'accept', before_status: 'needs_review', after_status: 'owner_reviewed' });
  });

  it('reject excludes the text from search and evidence (kept, not deleted) and alerts its dependents', async () => {
    const r = regions(t, lecture.versionId, 3).find((x) => x.text && x.kind === 'paragraph' && x.text.length > 30)!;
    const dep = insertArtifactWithRules(t, { sourceId: lecture.sourceId, versionIds: [lecture.versionId], regionIds: [r.id] });
    const itemId = makeItem(r.id, lecture.sourceId, r.page_id, lecture.versionId);
    const res = await a.post<ResolveReviewResponse>(`/api/control/review/${itemId}/resolve`, { action: 'reject' });
    expect(res.status).toBe(200);
    expect(t.ctx.db.get('SELECT text, status FROM source_region WHERE id = ?', [r.id])).toEqual({ text: r.text, status: 'rejected' });
    const chunkRegionIds = t.ctx.db.all<{ region_ids_json: string }>('SELECT region_ids_json FROM document_chunk WHERE version_id = ?', [lecture.versionId]).flatMap((c) => JSON.parse(c.region_ids_json));
    expect(chunkRegionIds).not.toContain(r.id);
    expect(res.body.alert).not.toBeNull();
    expect(t.ctx.db.get<{ status: string }>('SELECT status FROM artifact WHERE id = ?', [dep])!.status).toBe('stale');
    // evidence can no longer be made from it
    const ev = await a.post('/api/evidence/from-region', { region_id: r.id });
    expect(ev.status).toBeGreaterThanOrEqual(400);
  });

  it('dismiss closes the item and changes nothing', async () => {
    const r = regions(t, lecture.versionId, 3).find((x) => x.text && x.kind === 'heading')!;
    const itemId = makeItem(r.id, lecture.sourceId, r.page_id, lecture.versionId);
    const res = await a.post<ResolveReviewResponse>(`/api/control/review/${itemId}/resolve`, { action: 'dismiss', note: 'لاحقًا' });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('dismissed');
    expect(t.ctx.db.get('SELECT text, status FROM source_region WHERE id = ?', [r.id])).toEqual({ text: r.text, status: 'needs_review' });
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM control_region_correction WHERE region_id = ?', [r.id])!.n).toBe(0);
  });
});

describe('unreadable page: the owner types the text', () => {
  it('stores an owner transcription (no box claimed), makes it searchable and the page ready', async () => {
    const item = openItems(t, 'unreadable_page').find((i) => i.source_id === scanned.sourceId)!;
    const detail = (await a.get<ReviewItemDetail>(`/api/control/review/${item.id}`)).body;
    expect(detail.structured.type).toBe('page');
    if (detail.structured.type === 'page') expect(detail.structured.page.text_status).toBe('needs_ocr');
    expect(detail.actions.map((x) => x.action)).toEqual(['accept', 'correct', 'dismiss']);
    const text = 'Helicobacter pylori: urea breath test (نص كتبه المالك للاختبار)';
    const res = await a.post<ResolveReviewResponse>(`/api/control/review/${item.id}/resolve`, { action: 'correct', text });
    expect(res.status).toBe(200);
    const reg = t.ctx.db.get<{ text: string; text_origin: string; status: string; bbox_json: string | null; kind: string }>(
      `SELECT text, text_origin, status, bbox_json, kind FROM source_region WHERE page_id = ? AND text_origin = 'owner'`,
      [item.entity_id],
    )!;
    expect(reg).toMatchObject({ text, text_origin: 'owner', status: 'owner_reviewed', bbox_json: null, kind: 'text_block' });
    const page = t.ctx.db.get<{ processing_status: string; text_status: string }>('SELECT processing_status, text_status FROM source_page WHERE id = ?', [item.entity_id])!;
    expect(page.processing_status).toBe('ready');
    expect(page.text_status).toBe('needs_ocr'); // never claims it was read by a machine
    const search = await a.get(`/api/search?q=${encodeURIComponent('urea breath')}&types=chunks`);
    expect(JSON.stringify(search.body)).toContain('urea breath');
    expect(res.body.item.corrections[0]).toMatchObject({ action: 'owner_text', after_text: text });
  });
});

describe('classification suggestions', () => {
  it('accept / correct / reject go through the sources service (owner decision recorded)', async () => {
    const items = t.ctx.db.all<{ id: string; entity_id: string }>(`SELECT id, entity_id FROM review_queue_item WHERE kind = 'classification_suggestion' AND status = 'open'`);
    // make one per action from the real item shape
    const base = items[0] ?? null;
    const mk = (sourceId: string) => {
      const id = newId(t.ctx.clock.now());
      t.ctx.db.run(
        `INSERT INTO review_queue_item (id, kind, entity_type, entity_id, source_id, reason, details_json, status, created_at) VALUES (?, 'classification_suggestion', 'source', ?, ?, 'صُنّفت المحاضرة تلقائيًا كـ«سريرية».', ?, 'open', ?)`,
        [id, sourceId, sourceId, JSON.stringify({ origin: 'processing', suggested: 'clinical', reasons_ar: ['كلمات سريرية'] }), t.ctx.clock.now()],
      );
      return id;
    };
    const first = base?.id ?? mk(lecture.sourceId);
    const d = (await a.get<ReviewItemDetail>(`/api/control/review/${first}`)).body;
    expect(d.structured.type).toBe('classification');
    const ok = await a.post<ResolveReviewResponse>(`/api/control/review/${first}/resolve`, { action: 'correct', lecture_kind: 'practical' });
    expect(ok.status).toBe(200);
    const src = base?.entity_id ?? lecture.sourceId;
    expect(t.ctx.db.get('SELECT lecture_kind, lecture_kind_origin FROM source WHERE id = ?', [src])).toEqual({ lecture_kind: 'practical', lecture_kind_origin: 'owner' });
    const second = mk(src);
    expect((await a.post(`/api/control/review/${second}/resolve`, { action: 'correct' })).status).toBe(400);
    expect((await a.post(`/api/control/review/${second}/resolve`, { action: 'reject' })).status).toBe(200);
    expect(t.ctx.db.get('SELECT lecture_kind, lecture_kind_origin FROM source WHERE id = ?', [src])).toEqual({ lecture_kind: null, lecture_kind_origin: null });
    const third = mk(src);
    expect((await a.post(`/api/control/review/${third}/resolve`, { action: 'accept' })).status).toBe(200);
    expect(t.ctx.db.get('SELECT lecture_kind, lecture_kind_origin FROM source WHERE id = ?', [src])).toEqual({ lecture_kind: 'clinical', lecture_kind_origin: 'owner' });
  });
});

describe('items owned by other screens deep-link there', () => {
  function insertItem(kind: string, entityType: string, entityId: string, details: Record<string, unknown>): string {
    const id = newId(t.ctx.clock.now());
    t.ctx.db.run(
      `INSERT INTO review_queue_item (id, kind, entity_type, entity_id, source_id, reason, details_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'سبب محدد للاختبار', ?, 'open', ?)`,
      [id, kind, entityType, entityId, lecture.sourceId, JSON.stringify(details), t.ctx.clock.now()],
    );
    return id;
  }

  it('question items → questions review screen; only «close» here', async () => {
    const id = insertItem('conflicting_key', 'question', 'Q-TEST-1', { origin: 'questions', code: 'key_conflict', question_id: 'Q-TEST-1' });
    const d = (await a.get<ReviewItemDetail>(`/api/control/review/${id}`)).body;
    expect(d.handled_in).toBe('questions');
    expect(d.link).toEqual({ href: '/questions/Q-TEST-1/review', label_ar: expect.any(String) });
    expect(d.actions.map((x) => x.action)).toEqual(['dismiss']);
    expect(d.actions_note_ar).toContain('شاشة مراجعة السؤال');
    const refused = await a.post(`/api/control/review/${id}/resolve`, { action: 'accept' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.allowed).toEqual(['dismiss']);
    expect((await a.post(`/api/control/review/${id}/resolve`, { action: 'dismiss' })).status).toBe(200);
  });

  it('notes to re-anchor → workspace; generated questions → exams (never published from here); claims → workspace', async () => {
    const re = insertItem('needs_reanchor', 'note', 'N-TEST-1', { origin: 'studybook', previous_version_no: 1, new_version_no: 2 });
    const dr = (await a.get<ReviewItemDetail>(`/api/control/review/${re}`)).body;
    expect(dr).toMatchObject({ handled_in: 'workspace', structured: { type: 'note_anchor', previous_version_no: 1, new_version_no: 2 } });
    expect(dr.link!.href).toBe(`/study/${lecture.sourceId}`);
    expect(dr.actions.map((x) => x.action)).toEqual(['dismiss']);

    const gen = insertItem('question_validation_failed', 'generated_question_candidate', 'GQ-TEST-1', { origin: 'exams' });
    const dg = (await a.get<ReviewItemDetail>(`/api/control/review/${gen}`)).body;
    expect(dg.handled_in).toBe('exams');
    expect(dg.actions.map((x) => x.action)).toEqual(['reject', 'dismiss']);
    expect((await a.post(`/api/control/review/${gen}/resolve`, { action: 'accept' })).status).toBe(400);
    const kept = await a.post<ResolveReviewResponse>(`/api/control/review/${gen}/resolve`, { action: 'reject' });
    expect(kept.status).toBe(200);
    expect(kept.body.effects_ar[0]).toContain('غير منشور');

    const cl = insertItem('claim_unsupported', 'claim', 'C-TEST-1', { origin: 'evidence' });
    const dc = (await a.get<ReviewItemDetail>(`/api/control/review/${cl}`)).body;
    expect(dc.handled_in).toBe('workspace');
    expect(dc.actions.map((x) => x.action)).toEqual(['dismiss']);
  });
});

describe('auth and CSRF', () => {
  it('every control route needs the owner session; mutations need the CSRF header', async () => {
    for (const url of ['/api/control/overview', '/api/control/review', '/api/control/processing', '/api/control/intelligence', '/api/control/sources', '/api/control/storage', '/api/control/history']) {
      expect((await t.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    const item = openItems(t)[0]!;
    expect((await t.app.inject({ method: 'POST', url: `/api/control/review/${item.id}/resolve`, headers: CSRF, payload: { action: 'dismiss' } })).statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: `/api/control/review/${item.id}/resolve`, headers: { cookie: h.cookie }, payload: { action: 'dismiss' } });
    expect(noCsrf.statusCode).toBe(403);
    const noCsrfImpact = await t.app.inject({ method: 'POST', url: '/api/control/impact/preview', headers: { cookie: h.cookie }, payload: { change: { kind: 'model', role: 'generation', model: 'x' } } });
    expect(noCsrfImpact.statusCode).toBe(403);
    // the item is still open
    expect(t.ctx.db.get<{ status: string }>('SELECT status FROM review_queue_item WHERE id = ?', [item.id])!.status).toBe('open');
  });
});
