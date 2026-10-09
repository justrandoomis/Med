// Source Lock resolution + scope-locked retrieval on Golden Set fixtures processed by the real pipeline
// (§08, §09, §52, AC-05).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheKey, canReuse } from '../../src/modules/evidence/cache';
import { recordDependencies } from '../../src/modules/evidence/dependencies';
import { abstainFor, retrieve } from '../../src/modules/evidence/retrieval';
import { resolveScope } from '../../src/modules/evidence/scope';
import { newId } from '../../src/lib/ids';
import { cloneVersion, goldenLibrary, insertArtifact, linkReference, regionWith, type GoldenLibrary } from './helpers';

let g: GoldenLibrary;
beforeAll(async () => {
  g = await goldenLibrary();
}, 120_000);
afterAll(async () => {
  await g?.t.close();
});

const api = (method: 'GET' | 'POST', url: string, payload?: unknown) => g.t.app.inject({ method, url, headers: g.h, payload: payload as never });

describe('resolveScope (Source Lock)', () => {
  it('lecture_only → only the focal lecture version; stable hash; Arabic description', () => {
    const a = resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId, reference_source_ids: [g.reference.sourceId] });
    expect(a.versionIds).toEqual([g.lecture.versionId]);
    expect(a.sourceIds).toEqual([g.lecture.sourceId]);
    expect(a.versionBySource).toEqual({ [g.lecture.sourceId]: g.lecture.versionId });
    expect(a.allowExternal).toBe(false);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.describeAr).toContain('المحاضرة فقط');
    expect(a.describeAr).toContain('Acute Appendicitis');
    const b = resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId });
    expect(b.hash).toBe(a.hash); // references are irrelevant in lecture_only → same scope, same hash
    const wider = resolveScope(g.t.ctx, { mode: 'lecture_plus_references', lecture_source_id: g.lecture.sourceId, reference_source_ids: [g.reference.sourceId] });
    expect(wider.hash).not.toBe(a.hash);
  });

  it('lecture_plus_references marks the origin of each source; order of references does not change the hash', () => {
    const a = resolveScope(g.t.ctx, { mode: 'lecture_plus_references', lecture_source_id: g.lecture.sourceId, reference_source_ids: [g.reference.sourceId, g.questions.sourceId] });
    expect(a.origins).toEqual({ [g.lecture.sourceId]: 'lecture', [g.reference.sourceId]: 'reference', [g.questions.sourceId]: 'reference' });
    const b = resolveScope(g.t.ctx, { mode: 'lecture_plus_references', lecture_source_id: g.lecture.sourceId, reference_source_ids: [g.questions.sourceId, g.reference.sourceId] });
    expect(b.hash).toBe(a.hash);
  });

  it('references_only → only the chosen references; needs at least one', () => {
    const a = resolveScope(g.t.ctx, { mode: 'references_only', reference_source_ids: [g.reference.sourceId] });
    expect(a.versionIds).toEqual([g.reference.versionId]);
    expect(() => resolveScope(g.t.ctx, { mode: 'references_only', reference_source_ids: [] })).toThrow(/مرجعًا واحدًا/);
  });

  it('external evidence is refused while the owner has not enabled it', () => {
    expect(() => resolveScope(g.t.ctx, { mode: 'external', lecture_source_id: g.lecture.sourceId })).toThrowError(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
  });

  it('version pins, Source Freeze and current version', () => {
    const v2 = cloneVersion(g.t, g.lecture.sourceId, g.lecture.versionId);
    try {
      expect(resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId }).versionIds).toEqual([v2]);
      const pinned = resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId, version_pins: { [g.lecture.sourceId]: g.lecture.versionId } });
      expect(pinned.versionIds).toEqual([g.lecture.versionId]);
      expect(pinned.sources[0]).toMatchObject({ pinned: true, newer_version_exists: true });
      g.t.ctx.db.run('UPDATE source SET frozen_version_id = ? WHERE id = ?', [g.lecture.versionId, g.lecture.sourceId]);
      const frozen = resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId });
      expect(frozen.versionIds).toEqual([g.lecture.versionId]);
      expect(frozen.sources[0]).toMatchObject({ frozen: true });
      // a pin that belongs to another source is refused (never swapped silently)
      expect(() => resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId, version_pins: { [g.lecture.sourceId]: g.reference.versionId } })).toThrow(/لا تخص/);
    } finally {
      g.t.ctx.db.run('UPDATE source SET current_version_id = ?, frozen_version_id = NULL WHERE id = ?', [g.lecture.versionId, g.lecture.sourceId]);
    }
  });

  it('trashed / missing references are excluded with a reason; a trashed lecture cannot be locked', () => {
    g.t.ctx.db.run('UPDATE source SET deleted_at = ? WHERE id = ?', [g.t.ctx.clock.now(), g.reference.sourceId]);
    try {
      const r = resolveScope(g.t.ctx, { mode: 'lecture_plus_references', lecture_source_id: g.lecture.sourceId, reference_source_ids: [g.reference.sourceId, 'MISSING_SOURCE'] });
      expect(r.versionIds).toEqual([g.lecture.versionId]);
      expect(r.excluded.map((e) => e.source_id).sort()).toEqual(['MISSING_SOURCE', g.reference.sourceId].sort());
      expect(r.excluded.find((e) => e.source_id === g.reference.sourceId)!.reason_ar).toContain('سلة المحذوفات');
      expect(() => resolveScope(g.t.ctx, { mode: 'references_only', reference_source_ids: [g.reference.sourceId] })).toThrowError(expect.objectContaining({ code: 'OUT_OF_SCOPE' }));
      g.t.ctx.db.run('UPDATE source SET deleted_at = ? WHERE id = ?', [g.t.ctx.clock.now(), g.lecture.sourceId]);
      expect(() => resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId })).toThrowError(expect.objectContaining({ code: 'OUT_OF_SCOPE' }));
    } finally {
      g.t.ctx.db.run('UPDATE source SET deleted_at = NULL WHERE id IN (?, ?)', [g.reference.sourceId, g.lecture.sourceId]);
    }
  });

  it('My Notes sources enter the scope only when explicitly requested (low assurance)', () => {
    const now = g.t.ctx.clock.now();
    const notesId = newId();
    const notesV = newId();
    g.t.ctx.db.run(`INSERT INTO source (id, title, source_type, processing_status, created_at, updated_at) VALUES (?, 'My notes (TEST)', 'my_notes', 'ready', ?, ?)`, [notesId, now, now]);
    g.t.ctx.db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, format, pagination, processing_status, created_at) VALUES (?, ?, 1, 'original', ?, 'text/plain', 'text', 'paragraphs', 'ready', ?)`,
      [notesV, notesId, newId(), now],
    );
    g.t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [notesV, notesId]);
    const without = resolveScope(g.t.ctx, { mode: 'lecture_plus_references', lecture_source_id: g.lecture.sourceId, reference_source_ids: [notesId] });
    expect(without.versionIds).toEqual([g.lecture.versionId]);
    expect(without.excluded[0]!.reason_ar).toContain('ملاحظاتي');
    const withNotes = resolveScope(g.t.ctx, { mode: 'lecture_plus_references', lecture_source_id: g.lecture.sourceId, reference_source_ids: [notesId], include_my_notes: true });
    expect(withNotes.versionIds).toEqual([g.lecture.versionId, notesV]);
    expect(withNotes.sources.find((s) => s.source_id === notesId)).toMatchObject({ origin: 'my_notes', low_assurance: true });
    expect(withNotes.hash).not.toBe(without.hash);
  });

  it('POST /api/evidence/scope/resolve previews the scope; validation and auth', async () => {
    const res = await api('POST', '/api/evidence/scope/resolve', { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope.versionIds).toEqual([g.lecture.versionId]);
    expect(body.sources[0]).toMatchObject({ source_id: g.lecture.sourceId, origin: 'lecture', processing_status: expect.any(String) });
    expect((await api('POST', '/api/evidence/scope/resolve', { mode: 'lecture_only' })).statusCode).toBe(400);
    expect((await api('POST', '/api/evidence/scope/resolve', { mode: 'external', lecture_source_id: g.lecture.sourceId })).json().error.code).toBe('FEATURE_DISABLED');
    const anon = await g.t.app.inject({ method: 'POST', url: '/api/evidence/scope/resolve', headers: { 'x-medlevo-csrf': '1' }, payload: { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId } });
    expect(anon.statusCode).toBe(401);
    const noCsrf = await g.t.app.inject({ method: 'POST', url: '/api/evidence/scope/resolve', headers: { cookie: g.h.cookie }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('retrieve (scope-locked)', () => {
  const lectureOnly = () => resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId });

  it('AC-05: an answer that exists only in an out-of-scope reference is not found under Lecture Only → specific abstention', () => {
    const scope = lectureOnly();
    const r = retrieve(g.t.ctx, { scope, query: "Murphy's sign palpation right costal margin", purpose: 'lecture_explanation' });
    expect(r.candidates).toEqual([]);
    expect(r.searched.versions.map((v) => v.version_id)).toEqual([g.lecture.versionId]);
    expect(r.searched.pages_ready).toBe(4);
    expect(r.searched.semantic.used).toBe(false);
    expect(r.searched.semantic.reason_ar).toContain('البحث الدلالي');
    const a = abstainFor(g.t.ctx, r, scope)!;
    expect(a.reason).toBe('not_found_in_scope');
    expect(a.detail).toContain('4 صفحات');
    expect(a.suggest_scope).toBeUndefined(); // no reference linked yet
    // with the reference linked, the abstention suggests widening as an explicit owner action
    linkReference(g.t, g.lecture.sourceId, g.reference.sourceId);
    const b = abstainFor(g.t.ctx, r, scope)!;
    expect(b.suggest_scope).toMatchObject({ mode: 'lecture_plus_references', lecture_source_id: g.lecture.sourceId, reference_source_ids: [g.reference.sourceId] });
    // and only the wider scope finds it, marked as coming from a reference
    const wide = resolveScope(g.t.ctx, { mode: 'lecture_plus_references', lecture_source_id: g.lecture.sourceId });
    expect(wide.versionIds).toEqual([g.lecture.versionId, g.reference.versionId]); // linked reference used
    const w = retrieve(g.t.ctx, { scope: wide, query: "Murphy's sign palpation right costal margin", purpose: 'lecture_explanation' });
    expect(w.candidates.length).toBeGreaterThan(0);
    expect(w.candidates.every((c) => c.version_id === g.reference.versionId && c.scope_origin === 'reference')).toBe(true);
  });

  it('never returns out-of-scope chunks even when they rank higher (filter before ranking and LIMIT)', () => {
    // a synthetic out-of-scope chunk stuffed with the query terms ranks first globally
    const now = g.t.ctx.clock.now();
    const sid = newId();
    const vid = newId();
    g.t.ctx.db.run(`INSERT INTO source (id, title, source_type, processing_status, created_at, updated_at) VALUES (?, 'Out-of-scope textbook (TEST)', 'textbook', 'ready', ?, ?)`, [sid, now, now]);
    g.t.ctx.db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, format, pagination, processing_status, created_at) VALUES (?, ?, 1, 'original', ?, 'application/pdf', 'pdf', 'pages', 'ready', ?)`,
      [vid, sid, newId(), now],
    );
    g.t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [vid, sid]);
    g.t.ctx.db.run(
      `INSERT INTO document_chunk (id, version_id, source_id, kind, heading_path, text, region_ids_json, page_ids_json, index_version, created_at) VALUES (?, ?, ?, 'text', NULL, ?, '[]', '[]', 'test', ?)`,
      [newId(), vid, sid, 'Ultrasound first-line imaging. Ultrasound first-line imaging. Ultrasound first-line imaging children.', now],
    );
    const global = g.t.ctx.db.get<{ version_id: string }>(
      `SELECT c.version_id FROM chunk_fts JOIN document_chunk c ON c.rowid = chunk_fts.rowid WHERE chunk_fts MATCH '"ultrasound" "first" "line" "imaging"' ORDER BY bm25(chunk_fts) LIMIT 1`,
    )!;
    expect(global.version_id).toBe(vid); // it really ranks higher
    const r = retrieve(g.t.ctx, { scope: lectureOnly(), query: 'ultrasound first-line imaging', k: 1, purpose: 'lecture_explanation' });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.version_id).toBe(g.lecture.versionId);
    expect(r.candidates[0]!.text).toContain('Ultrasound is the first-line imaging test in children');
  });

  it('anchor regions come first with reading-order neighbours and adjacent chunks; out-of-scope anchors are dropped', () => {
    const anchor = regionWith(g.t, g.lecture.versionId, 'CT abdomen is preferred');
    const foreign = regionWith(g.t, g.reference.versionId, 'Murphy');
    const r = retrieve(g.t.ctx, { scope: lectureOnly(), query: '', anchor: { region_ids: [anchor.id, foreign.id] }, purpose: 'lecture_explanation' });
    expect(r.candidates[0]).toMatchObject({ kind: 'anchor_region', region_ids: [anchor.id] });
    expect(r.dropped_anchor_region_ids).toEqual([foreign.id]);
    expect(r.candidates.some((c) => c.kind === 'neighbour_region' && c.text.includes('Ultrasound is the first-line'))).toBe(true);
    expect(r.candidates.some((c) => c.kind === 'adjacent_chunk')).toBe(true);
    expect(r.candidates.every((c) => c.version_id === g.lecture.versionId)).toBe(true);
  });

  it('source priority decides where the search starts, not who wins: every source keeps its best hit', () => {
    const scope = resolveScope(g.t.ctx, { mode: 'lecture_plus_references', lecture_source_id: g.lecture.sourceId, reference_source_ids: [g.reference.sourceId, g.questions.sourceId] });
    const r = retrieve(g.t.ctx, { scope, query: 'ultrasound first-line', k: 2, purpose: 'lecture_explanation' });
    const kw = r.candidates.filter((c) => c.kind === 'keyword_chunk');
    expect(kw[0]!.source_id).toBe(g.lecture.sourceId); // lecture first (owner priority for lecture explanation)
    const sources = new Set(kw.map((c) => c.source_id));
    expect(sources.has(g.reference.sourceId)).toBe(true); // the reference is not pushed out by the lecture
    expect(kw.map((c) => c.priority_tier)).toEqual([...kw.map((c) => c.priority_tier)].sort((a, b) => a - b));
    // for question practice the question source is searched first
    const q = retrieve(g.t.ctx, { scope, query: 'ultrasound', k: 3, purpose: 'source_question_practice' });
    expect(q.candidates.filter((c) => c.kind === 'keyword_chunk')[0]!.source_id).toBe(g.questions.sourceId);
  });

  it('synonyms/abbreviations come ONLY from the owner dictionary (nothing seeded)', async () => {
    const before = await api('GET', '/api/evidence/terms');
    expect(before.json().terms).toEqual([]);
    const none = retrieve(g.t.ctx, { scope: lectureOnly(), query: 'WCC', purpose: 'lecture_explanation' });
    expect(none.candidates).toEqual([]);
    expect(none.query.expansions).toEqual([]);
    const add = await api('POST', '/api/evidence/terms', { term_en: 'white cell count', abbreviation: 'WCC', synonyms: ['عدد الكريات البيضاء'] });
    expect(add.statusCode).toBe(200);
    const r = retrieve(g.t.ctx, { scope: lectureOnly(), query: 'WCC', purpose: 'lecture_explanation' });
    expect(r.query.expansions).toEqual([{ from: 'wcc', to: ['white cell count', 'عدد الكريات البيضاء'] }]);
    expect(r.candidates.some((c) => c.text.includes('white cell count above 11'))).toBe(true);
    expect(r.searched.expansions).toEqual(r.query.expansions);
    const dup = await api('POST', '/api/evidence/terms', { term_en: 'White Cell Count' });
    expect(dup.statusCode).toBe(409);
    const id = add.json().term.id;
    expect((await api('POST', `/api/evidence/terms`, { term_en: 'x', bogus: 1 })).statusCode).toBe(400);
    expect((await g.t.app.inject({ method: 'DELETE', url: `/api/evidence/terms/${id}`, headers: g.h })).statusCode).toBe(200);
  });

  it('searched report: unreadable and unprocessed pages are counted so callers abstain precisely', () => {
    const page = g.t.ctx.db.get<{ id: string; processing_status: string; text_status: string }>('SELECT id, processing_status, text_status FROM source_page WHERE version_id = ? AND page_index = 3', [g.lecture.versionId])!;
    g.t.ctx.db.run(`UPDATE source_page SET processing_status = 'failed', text_status = 'failed' WHERE id = ?`, [page.id]);
    // a second version not processed yet (3 pages known from the file)
    const now = g.t.ctx.clock.now();
    const sid = newId();
    const vid = newId();
    g.t.ctx.db.run(`INSERT INTO source (id, title, source_type, processing_status, created_at, updated_at) VALUES (?, 'Pending lecture (TEST)', 'lecture', 'pending', ?, ?)`, [sid, now, now]);
    g.t.ctx.db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, format, pagination, processing_status, page_count, created_at) VALUES (?, ?, 1, 'original', ?, 'application/pdf', 'pdf', 'pages', 'pending', 3, ?)`,
      [vid, sid, newId(), now],
    );
    g.t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [vid, sid]);
    try {
      const scope = resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId });
      const r = retrieve(g.t.ctx, { scope, query: 'zzzz nothing', purpose: 'general' });
      expect(r.searched).toMatchObject({ pages_ready: 3, pages_unreadable: 1, pages_unprocessed: 0 });
      expect(r.searched.summary_ar).toBe('بُحث في 3 صفحات معالَجة من مصدر واحد ضمن النطاق؛ صفحة واحدة غير مقروءة.');
      expect(abstainFor(g.t.ctx, r, scope)!.detail).toContain('غير المقروءة');
      const pendingScope = resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: sid });
      const p = retrieve(g.t.ctx, { scope: pendingScope, query: 'appendicitis', purpose: 'general' });
      expect(p.searched).toMatchObject({ pages_ready: 0, pages_unprocessed: 3 });
      expect(abstainFor(g.t.ctx, p, pendingScope)!.reason).toBe('unreadable_source');
    } finally {
      g.t.ctx.db.run('UPDATE source_page SET processing_status = ?, text_status = ? WHERE id = ?', [page.processing_status, page.text_status, page.id]);
    }
  });

  it('requires a resolved scope (no default "everything")', () => {
    expect(() => retrieve(g.t.ctx, { scope: undefined as never, query: 'x', purpose: 'general' })).toThrowError(expect.objectContaining({ code: 'OUT_OF_SCOPE' }));
  });
});

describe('cache keys & reuse (§17, AC-05)', () => {
  const base = { kind: 'explanation', rulesVersion: 'r1', generatorVersion: 'g1', verifierVersion: 'v1', level: 'medium', language: 'ar' };
  it('a lecture-only request never shares a key with a wider scope; versions and rules change the key', () => {
    const lo = resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId });
    const wide = resolveScope(g.t.ctx, { mode: 'lecture_plus_references', lecture_source_id: g.lecture.sourceId, reference_source_ids: [g.reference.sourceId] });
    const k1 = cacheKey(g.t.ctx, { ...base, scope: lo });
    expect(cacheKey(g.t.ctx, { ...base, scope: lo })).toBe(k1);
    expect(cacheKey(g.t.ctx, { ...base, scope: wide })).not.toBe(k1);
    expect(cacheKey(g.t.ctx, { ...base, scope: lo, rulesVersion: 'r2' })).not.toBe(k1);
    expect(cacheKey(g.t.ctx, { ...base, scope: lo, level: 'simple' })).not.toBe(k1);
    const pinnedOther = resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId, version_pins: { [g.lecture.sourceId]: cloneVersion(g.t, g.lecture.sourceId, g.lecture.versionId, { makeCurrent: false }) } });
    expect(cacheKey(g.t.ctx, { ...base, scope: pinnedOther })).not.toBe(k1);
    expect(() => cacheKey(g.t.ctx, { ...base, scope: { ...lo, versionIds: [] } })).toThrowError(expect.objectContaining({ code: 'OUT_OF_SCOPE' }));
  });

  it('a cached artifact is reused only while it is published and its sources still exist and are not trashed', () => {
    const a = insertArtifact(g.t, { sourceId: g.lecture.sourceId });
    expect(canReuse(g.t.ctx, 'artifact', a).usable).toBe(false); // no recorded dependencies → never reused blindly
    recordDependencies(g.t.ctx, 'artifact', a, [g.lecture.versionId]);
    expect(canReuse(g.t.ctx, 'artifact', a)).toEqual({ usable: true, reason_ar: null });
    g.t.ctx.db.run('UPDATE source SET deleted_at = 1 WHERE id = ?', [g.lecture.sourceId]);
    expect(canReuse(g.t.ctx, 'artifact', a).reason_ar).toContain('سلة المحذوفات');
    g.t.ctx.db.run('UPDATE source SET deleted_at = NULL WHERE id = ?', [g.lecture.sourceId]);
    g.t.ctx.db.run(`UPDATE artifact SET status = 'stale' WHERE id = ?`, [a]);
    expect(canReuse(g.t.ctx, 'artifact', a).reason_ar).toContain('إعادة توليد');
  });
});

describe('review regressions (C1 adversarial review)', () => {
  it('default references are the lecture\'s INCOMING «reference_for» links — never a source the lecture is a reference for', () => {
    const linkId = newId();
    // «the lecture is a reference for the question bank» (outgoing from the lecture)
    g.t.ctx.db.run(`INSERT INTO source_link (id, from_source_id, to_source_id, relation, created_at) VALUES (?, ?, ?, 'reference_for', ?)`, [
      linkId,
      g.lecture.sourceId,
      g.questions.sourceId,
      g.t.ctx.clock.now(),
    ]);
    try {
      const r = resolveScope(g.t.ctx, { mode: 'lecture_plus_references', lecture_source_id: g.lecture.sourceId });
      expect(r.sourceIds).not.toContain(g.questions.sourceId);
      const empty = retrieve(g.t.ctx, { scope: resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId }), query: 'zzzz nothing', purpose: 'general' });
      const a = abstainFor(g.t.ctx, empty, resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId }));
      expect(a?.suggest_scope?.reference_source_ids ?? []).not.toContain(g.questions.sourceId);
    } finally {
      g.t.ctx.db.run('DELETE FROM source_link WHERE id = ?', [linkId]);
    }
  });

  it('an anchor page outside the scope is reported as dropped (not silently ignored)', () => {
    const page = g.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? LIMIT 1', [g.reference.versionId])!;
    const r = retrieve(g.t.ctx, { scope: resolveScope(g.t.ctx, { mode: 'lecture_only', lecture_source_id: g.lecture.sourceId }), query: '', anchor: { page_id: page.id }, purpose: 'general' });
    expect(r.candidates).toEqual([]);
    expect(r.dropped_anchor_page_id).toBe(page.id);
  });
});
