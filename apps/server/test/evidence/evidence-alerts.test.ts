// Evidence rows & views, availability (§11), verification without an AI provider, dependencies and content
// change alerts with stale/frozen handling (§18, AC-26). Real pipeline, no AI provider configured.
import { PROCESS_JOB_KIND, sourceChipLabel, type ContentAlertView } from '@medlevo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/lib/ids';
import { validateClaims } from '../../src/modules/evidence/claims';
import { canReuse } from '../../src/modules/evidence/cache';
import { onSourceVersionChanged, recordDependencies } from '../../src/modules/evidence/dependencies';
import { fromRegion, getView } from '../../src/modules/evidence/evidence';
import { buildEvidencePack } from '../../src/modules/evidence/pack';
import { retrieve } from '../../src/modules/evidence/retrieval';
import { resolveScope } from '../../src/modules/evidence/scope';
import { addSource, processVersion } from '../processing/helpers';
import { golden, multipart } from '../sources/helpers';
import { cloneVersion, goldenLibrary, insertArtifact, regionWith, type GoldenLibrary } from './helpers';

let g: GoldenLibrary;
beforeAll(async () => {
  g = await goldenLibrary(null);
}, 120_000);
afterAll(async () => {
  await g?.t.close();
});

const get = (url: string) => g.t.app.inject({ method: 'GET', url, headers: g.h });
const post = (url: string, payload: unknown = {}) => g.t.app.inject({ method: 'POST', url, headers: g.h, payload: payload as never });
const artifactStatus = (id: string) => g.t.ctx.db.get<{ status: string; stale_reason: string | null }>('SELECT status, stale_reason FROM artifact WHERE id = ?', [id])!;
const alerts = async (status = 'active'): Promise<ContentAlertView[]> => (await get(`/api/evidence/alerts?status=${status}`)).json().alerts;

describe('evidence rows', () => {
  it('fromRegion is idempotent per region + offsets and the quote is an exact substring of the region', () => {
    const r = regionWith(g.t, g.lecture.versionId, 'white cell count above 11');
    const a = fromRegion(g.t.ctx, r.id);
    const b = fromRegion(g.t.ctx, r.id);
    expect(b.id).toBe(a.id);
    expect(a.quote).toBe(r.text);
    expect([a.start_offset, a.end_offset]).toEqual([0, r.text.length]);
    const start = r.text.indexOf('11 ×10⁹/L');
    const sub = fromRegion(g.t.ctx, r.id, { start, end: start + '11 ×10⁹/L'.length });
    expect(sub.quote).toBe('11 ×10⁹/L');
    expect(sub.id).not.toBe(a.id);
    expect(fromRegion(g.t.ctx, r.id, { start, end: start + '11 ×10⁹/L'.length }).id).toBe(sub.id);
    expect(() => fromRegion(g.t.ctx, r.id, { start: 5, end: 2 })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => fromRegion(g.t.ctx, r.id, { start: 0, end: r.text.length + 1 })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    const header = g.t.ctx.db.get<{ id: string }>(`SELECT id FROM source_region WHERE version_id = ? AND kind = 'header' LIMIT 1`, [g.lecture.versionId])!;
    expect(() => fromRegion(g.t.ctx, header.id)).toThrowError(expect.objectContaining({ code: 'INVALID_EVIDENCE' }));
    expect(() => fromRegion(g.t.ctx, 'NOPE')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('views carry precise locators: printed + file page (AC-04), DOCX paragraphs (no invented pages)', async () => {
    const r = regionWith(g.t, g.lecture.versionId, 'white cell count above 11');
    const v = getView(g.t.ctx, fromRegion(g.t.ctx, r.id).id);
    expect(v).toMatchObject({ source_type: 'lecture', page_index: 0, locator_label_ar: 'ص 11 (الصفحة 1 في الملف)', region_kind: 'paragraph', availability: 'available', extraction_status: 'extracted' });
    expect(v.bbox).toMatchObject({ x: expect.any(Number), w: expect.any(Number) });
    expect(sourceChipLabel(v)).toBe('محاضرة ص11');
    const docx = await addSource(g.t, 'lecture_notes_shock.docx', 'docx', { sourceType: 'course_reference', title: 'Shock notes (TEST FIXTURE)' });
    await processVersion(g.t, docx.versionId);
    const para = regionWith(g.t, docx.versionId, 'Shock is classified');
    const dv = getView(g.t.ctx, fromRegion(g.t.ctx, para.id).id);
    expect(dv.locator_label_ar).toMatch(/^فقرة \d+$/);
    expect(sourceChipLabel(dv)).toMatch(/^مرجع فقرة \d+$/);
  });

  it('API: from-region, batch (missing ids never shown), GET by id; auth + CSRF', async () => {
    const r = regionWith(g.t, g.lecture.versionId, 'CT abdomen is preferred');
    const res = await post('/api/evidence/from-region', { region_id: r.id });
    expect(res.statusCode).toBe(200);
    const e = res.json().evidence;
    expect(e).toMatchObject({ region_id: r.id, quote: r.text, locator_label_ar: 'ص 12 (الصفحة 2 في الملف)' });
    expect((await post('/api/evidence/from-region', { region_id: r.id })).json().evidence.id).toBe(e.id);
    expect((await post('/api/evidence/from-region', { region_id: r.id, start: 3, end: 1 })).statusCode).toBe(400);
    expect((await post('/api/evidence/from-region', { region_id: r.id, junk: 1 })).statusCode).toBe(400);
    const batch = await post('/api/evidence/batch', { ids: [e.id, 'MISSING1'] });
    expect(batch.json()).toMatchObject({ evidence: [{ id: e.id }], missing: ['MISSING1'] });
    expect((await get(`/api/evidence/${e.id}`)).json().evidence.id).toBe(e.id);
    expect((await get('/api/evidence/NOPE')).statusCode).toBe(404);
    expect((await g.t.app.inject({ method: 'GET', url: `/api/evidence/${e.id}` })).statusCode).toBe(401);
    expect((await g.t.app.inject({ method: 'POST', url: '/api/evidence/batch', headers: { cookie: g.h.cookie }, payload: { ids: [] } })).statusCode).toBe(403);
    const caps = (await get('/api/capabilities')).json().features;
    expect(caps['evidence.citations'].state).toBe('available');
    expect(caps['search.keyword'].state).toBe('available');
    expect(caps['search.semantic']).toMatchObject({ state: 'requires_configuration', reason_ar: expect.stringContaining('embeddings') });
  });

  it('availability: trashed source → source_deleted; never pretends the page is still there', () => {
    const r = regionWith(g.t, g.reference.versionId, 'Murphy');
    const id = fromRegion(g.t.ctx, r.id).id;
    g.t.ctx.db.run('UPDATE source SET deleted_at = ? WHERE id = ?', [g.t.ctx.clock.now(), g.reference.sourceId]);
    try {
      expect(getView(g.t.ctx, id).availability).toBe('source_deleted');
      expect(() => fromRegion(g.t.ctx, r.id)).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    } finally {
      g.t.ctx.db.run('UPDATE source SET deleted_at = NULL WHERE id = ?', [g.reference.sourceId]);
    }
  });
});

describe('verification without an AI provider', () => {
  it('entailment unavailable → needs_review with the reason, never linked', async () => {
    const scope = resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId });
    const us = fromRegion(g.t.ctx, regionWith(g.t, g.lecture.versionId, 'Ultrasound is the first-line').id).id;
    const pack = buildEvidencePack(g.t.ctx, scope, [us]);
    const r = await validateClaims(g.t.ctx, {
      ownerType: 'message',
      ownerId: newId(),
      scope,
      aliasMap: pack.aliasMap,
      sentences: [{ text: 'Ultrasound is the first-line imaging test in children.', claim: { support_type: 'directly_stated', evidence: ['E1'] } }],
    });
    expect(r.sentences[0]).toMatchObject({ status: 'needs_review', keep: true });
    expect(r.sentences[0]!.reason_ar).toContain('لم يُجرَ التحقق المستقل');
    expect(r.entailment).toMatchObject({ used: false, model: null });
    const issues = (await get(`/api/evidence/claims/${r.sentences[0]!.claim_id}`)).json().claim.issues;
    expect(issues).toEqual([{ check: 'entailment', reason_ar: expect.stringContaining('ANTHROPIC_API_KEY') }]);
  });
});

describe('dependencies & content change alerts (§18, AC-26)', () => {
  it('recordDependencies is idempotent and resolves regions to their version', () => {
    const r = regionWith(g.t, g.lecture.versionId, 'Anorexia and nausea');
    const n1 = recordDependencies(g.t.ctx, 'flashcard', 'CARD1', [g.lecture.versionId], [r.id]);
    const n2 = recordDependencies(g.t.ctx, 'flashcard', 'CARD1', [g.lecture.versionId], [r.id, 'UNKNOWN_REGION']);
    expect([n1, n2]).toEqual([1, 0]);
    expect(g.t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_dependency WHERE dependent_id = 'CARD1'`)!.n).toBe(1);
  });

  it('replacement upload → alert with per-dependent impact; non-frozen artifacts stale, frozen kept with a warning; comparison completes after processing', async () => {
    const L = g.lecture;
    const wcc = regionWith(g.t, L.versionId, 'white cell count above 11');
    const ct = regionWith(g.t, L.versionId, 'CT abdomen is preferred');
    const us = regionWith(g.t, L.versionId, 'Ultrasound is the first-line');
    const a1 = insertArtifact(g.t, { sourceId: L.sourceId, title: 'شرح كريات الدم' });
    const a2 = insertArtifact(g.t, { sourceId: L.sourceId, title: 'شرح مجمّد', frozen: true });
    recordDependencies(g.t.ctx, 'artifact', a1, [L.versionId], [wcc.id, ct.id]);
    recordDependencies(g.t.ctx, 'artifact', a2, [L.versionId]);
    recordDependencies(g.t.ctx, 'question_version', 'QV1', [L.versionId], [us.id]);

    const body = multipart({ note: 'نسخة مختلفة (اختبار)' }, [{ name: 'appendicitis v2.pdf', data: golden('lecture_cholecystitis.pdf') }]);
    const up = await g.t.app.inject({ method: 'POST', url: `/api/sources/${L.sourceId}/versions`, headers: { ...g.h, 'content-type': body.contentType }, payload: body.payload });
    expect(up.statusCode, up.body).toBe(200);
    const v2 = up.json().results[0].version_id as string;

    let alert = (await alerts()).find((a) => a.source_id === L.sourceId && a.source_version_id === v2)!;
    expect(alert).toMatchObject({ kind: 'source_replaced', status: 'open', from_version_id: L.versionId });
    expect(alert.change).toMatchObject({ state: 'pending_processing' });
    const item = (id: string) => alert.items.find((i) => i.id === id)!;
    expect(item(a1)).toMatchObject({ type: 'artifact', impact: 'needs_review', frozen: false, title: 'شرح كريات الدم' });
    expect(item(a2)).toMatchObject({ frozen: true, reason_ar: expect.stringContaining('تجميد') });
    expect(item('QV1')).toMatchObject({ type: 'question_version', impact: 'needs_review' });
    expect(item('CARD1')).toMatchObject({ type: 'flashcard' });
    expect(artifactStatus(a1).status).toBe('stale');
    expect(artifactStatus(a1).stale_reason).toContain('نسخة جديدة من المصدر');
    expect(artifactStatus(a2).status).toBe('published'); // frozen → never changed silently
    // evidence cited from v1 now says its version was replaced (unless the caller keeps it on purpose)
    const old = fromRegion(g.t.ctx, wcc.id).id;
    expect(getView(g.t.ctx, old).availability).toBe('version_replaced');
    expect(getView(g.t.ctx, old, { pinnedVersionIds: [L.versionId] }).availability).toBe('available');

    // processing of v2 finishes → the next read completes the comparison
    await g.t.ctx.jobs.drain();
    alert = (await alerts()).find((a) => a.id === alert.id)!;
    expect(alert.change).toMatchObject({ state: 'compared', text_identical: false });
    expect(alert.change!.critical_removed).toEqual(expect.arrayContaining(['11 ×10⁹/L', '37.3 °C', '75%']));
    expect(alert.severity).toBe('fact_change');
    const fresh = (id: string) => alert.items.find((i) => i.id === id)!;
    expect(fresh(a1)).toMatchObject({ impact: 'needs_regeneration', reason_ar: expect.stringContaining('مقطعان مستشهد بهما') });
    expect(fresh('QV1')).toMatchObject({ impact: 'needs_review' });
    expect(alert.counts.needs_regeneration).toBeGreaterThanOrEqual(1);
    expect(artifactStatus(a1).status).toBe('stale');
  });

  it('a layout-only new version (same text) → layout_changed, still_valid, and artifacts are restored', async () => {
    const L = g.lecture;
    // the source currently points at v2 (cholecystitis text); make a v3 from the ORIGINAL v1 file
    const r = regionWith(g.t, L.versionId, 'Anorexia and nausea');
    const a4 = insertArtifact(g.t, { sourceId: L.sourceId, title: 'شرح الأعراض' });
    recordDependencies(g.t.ctx, 'artifact', a4, [L.versionId], [r.id]);
    const v3 = cloneVersion(g.t, L.sourceId, L.versionId);
    const res = onSourceVersionChanged(g.t.ctx, { sourceId: L.sourceId, fromVersionId: L.versionId, toVersionId: v3, kind: 'source_replaced' });
    expect(artifactStatus(a4).status).toBe('stale'); // not comparable yet
    g.t.ctx.jobs.enqueue(PROCESS_JOB_KIND, { version_id: v3, reason: 'replacement' });
    await g.t.ctx.jobs.drain();
    const alert = (await alerts()).find((a) => a.id === res.alertId)!;
    expect(alert).toMatchObject({ kind: 'layout_changed', severity: 'info', change: { state: 'compared', text_identical: true } });
    expect(alert.items.find((i) => i.id === a4)).toMatchObject({ impact: 'still_valid' });
    expect(artifactStatus(a4)).toEqual({ status: 'published', stale_reason: null });
  });

  it('finished page re-processing jobs become alerts once (only pages that dependents use are flagged)', async () => {
    const R = g.reference;
    const p0 = regionWith(g.t, R.versionId, 'Right upper quadrant pain');
    const p1 = regionWith(g.t, R.versionId, 'Ultrasound is the first-line investigation');
    expect([p0.page_index, p1.page_index]).toEqual([0, 1]);
    const a5 = insertArtifact(g.t, { sourceId: R.sourceId, title: 'صفحة 31' });
    const a6 = insertArtifact(g.t, { sourceId: R.sourceId, title: 'صفحة 32' });
    recordDependencies(g.t.ctx, 'artifact', a5, [R.versionId], [p0.id]);
    recordDependencies(g.t.ctx, 'artifact', a6, [R.versionId], [p1.id]);
    const before = (await alerts('all')).length;
    g.t.ctx.jobs.enqueue(PROCESS_JOB_KIND, { version_id: R.versionId, page_indexes: [1], reason: 'reprocess' });
    await g.t.ctx.jobs.drain();
    const list = await alerts('all');
    expect(list.length).toBe(before + 1);
    const a = list.find((x) => x.source_id === R.sourceId && x.kind === 'source_updated')!;
    expect(a.summary).toContain('أُعيدت معالجة صفحة واحدة');
    expect(a.items.find((i) => i.id === a6)).toMatchObject({ impact: 'needs_regeneration' });
    expect(a.items.find((i) => i.id === a5)).toMatchObject({ impact: 'still_valid' });
    expect(artifactStatus(a6).status).toBe('stale');
    expect(artifactStatus(a5).status).toBe('published');
    expect((await alerts('all')).length).toBe(before + 1); // idempotent
  });

  it('acknowledge / resolve; resolved alerts leave the active list; 404 for unknown ids', async () => {
    const [first] = await alerts();
    const ack = await post(`/api/evidence/alerts/${first!.id}/ack`);
    expect(ack.json().alert).toMatchObject({ status: 'acknowledged', acknowledged_at: expect.any(Number) });
    const res = await post(`/api/evidence/alerts/${first!.id}/resolve`);
    expect(res.json().alert).toMatchObject({ status: 'resolved', resolved_at: expect.any(Number) });
    expect((await alerts()).some((a) => a.id === first!.id)).toBe(false);
    expect((await alerts('resolved')).some((a) => a.id === first!.id)).toBe(true);
    expect((await post('/api/evidence/alerts/NOPE/ack')).statusCode).toBe(404);
    const audit = g.t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE entity_type = 'content_alert' AND entity_id = ?`, [first!.id])!;
    expect(audit.n).toBe(2);
  });
});

describe('review regressions (C1 adversarial review)', () => {
  it('model-written (vision) region text is never evidence and never a retrieval candidate', () => {
    const page = g.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 0', [g.questions.versionId])!;
    const id = newId();
    const now = g.t.ctx.clock.now();
    g.t.ctx.db.run(
      `INSERT INTO source_region (id, version_id, page_id, kind, reading_order, text, text_origin, status, created_at, updated_at) VALUES (?, ?, ?, 'figure', 98, ?, 'vision', 'extracted', ?, ?)`,
      [id, g.questions.versionId, page.id, 'A generated description: the figure shows an inflamed appendix.', now, now],
    );
    expect(() => fromRegion(g.t.ctx, id)).toThrowError(expect.objectContaining({ code: 'INVALID_EVIDENCE' }));
    const scope = resolveScope(g.t.ctx, { mode: 'references_only', reference_source_ids: [g.questions.sourceId] });
    const r = retrieve(g.t.ctx, { scope, query: '', anchor: { page_id: page.id }, purpose: 'general' });
    expect(r.candidates.some((c) => c.region_ids.includes(id))).toBe(false);
    g.t.ctx.db.run('DELETE FROM source_region WHERE id = ?', [id]);
  });

  it('canReuse refuses an artifact whose cited region no longer exists (page re-processed, alert not reconciled yet)', () => {
    const page = g.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 0', [g.questions.versionId])!;
    const rid = newId();
    const now = g.t.ctx.clock.now();
    g.t.ctx.db.run(
      `INSERT INTO source_region (id, version_id, page_id, kind, reading_order, text, text_origin, status, created_at, updated_at) VALUES (?, ?, ?, 'paragraph', 97, 'temporary region', 'digital', 'extracted', ?, ?)`,
      [rid, g.questions.versionId, page.id, now, now],
    );
    const a = insertArtifact(g.t, { sourceId: g.questions.sourceId });
    recordDependencies(g.t.ctx, 'artifact', a, [g.questions.versionId], [rid]);
    expect(canReuse(g.t.ctx, 'artifact', a).usable).toBe(true);
    g.t.ctx.db.run('DELETE FROM source_region WHERE id = ?', [rid]);
    const after = canReuse(g.t.ctx, 'artifact', a);
    expect(after.usable).toBe(false);
    expect(after.reason_ar).toContain('أُعيدت معالجة');
  });

  it('content-block dependents: frozen through their artifact; a layout-only change restores their artifact', async () => {
    const Q = g.questions;
    const region = g.t.ctx.db.get<{ id: string }>(
      `SELECT id FROM source_region WHERE version_id = ? AND kind NOT IN ('header','footer','table_cell') AND text IS NOT NULL AND trim(text) <> '' ORDER BY reading_order LIMIT 1`,
      [Q.versionId],
    )!;
    const now = g.t.ctx.clock.now();
    const mkBlock = (artifactId: string) => {
      const id = newId();
      g.t.ctx.db.run(`INSERT INTO content_block (id, artifact_id, block_key, ord, kind, content_json, created_at) VALUES (?, ?, ?, 0, 'paragraph', ?, ?)`, [
        id,
        artifactId,
        `b-${id}`,
        JSON.stringify({ v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: 'block' }] }] }),
        now,
      ]);
      return id;
    };
    const live = insertArtifact(g.t, { sourceId: Q.sourceId, title: 'أسئلة مشروحة' });
    const frozen = insertArtifact(g.t, { sourceId: Q.sourceId, title: 'مجمّد', frozen: true });
    const b1 = mkBlock(live);
    const b2 = mkBlock(frozen);
    recordDependencies(g.t.ctx, 'content_block', b1, [Q.versionId], [region.id]);
    recordDependencies(g.t.ctx, 'content_block', b2, [Q.versionId], [region.id]);
    const v2 = cloneVersion(g.t, Q.sourceId, Q.versionId);
    const res = onSourceVersionChanged(g.t.ctx, { sourceId: Q.sourceId, fromVersionId: Q.versionId, toVersionId: v2, kind: 'source_replaced' });
    expect(res.items.find((i) => i.id === b2)).toMatchObject({ frozen: true });
    expect(artifactStatus(live).status).toBe('stale');
    expect(artifactStatus(frozen).status).toBe('published');
    g.t.ctx.jobs.enqueue(PROCESS_JOB_KIND, { version_id: v2, reason: 'replacement' });
    await g.t.ctx.jobs.drain();
    const alert = (await alerts('all')).find((a) => a.id === res.alertId)!;
    expect(alert).toMatchObject({ kind: 'layout_changed' });
    expect(alert.items.find((i) => i.id === b1)).toMatchObject({ impact: 'still_valid' });
    expect(artifactStatus(live)).toEqual({ status: 'published', stale_reason: null });
  });
});
