// Universal Search (§46) on Golden Set fixtures processed by the real pipeline.
import { normalizeForSearch, type SearchResponse } from '@medlevo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/lib/ids';
import { goldenLibrary, type GoldenLibrary } from '../evidence/helpers';

let g: GoldenLibrary;
beforeAll(async () => {
  g = await goldenLibrary(null);
}, 120_000);
afterAll(async () => {
  await g?.t.close();
});

const search = async (qs: string): Promise<SearchResponse> => {
  const res = await g.t.app.inject({ method: 'GET', url: `/api/search?${qs}`, headers: g.h });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SearchResponse;
};
const q = (s: string) => encodeURIComponent(s);
const marked = (r: SearchResponse['results'][number]) => r.snippet.highlights.map((h) => r.snippet.text.slice(h.start, h.end));

function syntheticSource(title: string, type = 'textbook', texts: string[] = []): { sourceId: string; versionIds: string[] } {
  const now = g.t.ctx.clock.now();
  const sourceId = newId();
  g.t.ctx.db.run(`INSERT INTO source (id, title, source_type, processing_status, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?)`, [sourceId, title, type, now, now]);
  const versionIds = texts.map((text, i) => {
    const vid = newId();
    g.t.ctx.db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, format, pagination, processing_status, created_at) VALUES (?, ?, ?, 'original', ?, 'application/pdf', 'pdf', 'pages', 'ready', ?)`,
      [vid, sourceId, i + 1, newId(), now],
    );
    g.t.ctx.db.run(`INSERT INTO document_chunk (id, version_id, source_id, kind, text, region_ids_json, page_ids_json, index_version, created_at) VALUES (?, ?, ?, 'text', ?, '[]', '[]', 'test', ?)`, [
      newId(),
      vid,
      sourceId,
      text,
      now,
    ]);
    return vid;
  });
  g.t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [versionIds[versionIds.length - 1] ?? null, sourceId]);
  return { sourceId, versionIds };
}

describe('GET /api/search', () => {
  it("Arabic normalization: «الالم» finds «الألم», highlighted on the original text with its page identity", async () => {
    const r = await search(`q=${q('الالم')}`);
    const hit = r.results.find((x) => x.type === 'chunks' && x.location?.source_id === g.lecture.sourceId)!;
    expect(hit).toBeTruthy();
    expect(marked(hit)).toContain('الألم');
    expect(hit.snippet.text).toContain('يبدأ الألم');
    expect(hit.location).toMatchObject({ version_id: g.lecture.versionId, page_index: 0, page_label_ar: 'ص 11 (الصفحة 1 في الملف)', region_id: expect.any(String) });
    expect(hit).toMatchObject({ origin: 'source', source_type: 'lecture', is_evidence: false });
    expect(hit.title).toContain('Acute Appendicitis');
  });

  it('exact mode verifies the phrase on the original text', async () => {
    const r = await search(`q=${q('does NOT exclude')}&mode=exact`);
    expect(r.results).toHaveLength(1);
    expect(marked(r.results[0]!)).toEqual(['does NOT exclude']);
    expect((await search(`q=${q('exclude NOT does')}&mode=exact`)).results).toEqual([]);
    const strict = await search(`q=${q('الالم')}&mode=exact`);
    expect(strict.results).toEqual([]); // the FTS key matched, the original text does not contain «الالم»
    expect(strict.exact_rejected).toBeGreaterThanOrEqual(1);
  });

  it('filters by source type, source and library subtree (applied before ranking)', async () => {
    const ref = await search(`q=ultrasound&source_type=course_reference&types=chunks`);
    expect(ref.results.length).toBeGreaterThan(0);
    expect(ref.results.every((x) => x.location?.source_id === g.reference.sourceId)).toBe(true);
    const one = await search(`q=ultrasound&source_id=${g.questions.sourceId}`);
    expect(one.results.every((x) => x.location?.source_id === g.questions.sourceId)).toBe(true);
    // library subtree: subject → course → lecture
    const now = g.t.ctx.clock.now();
    const subject = newId();
    const course = newId();
    g.t.ctx.db.run(`INSERT INTO library_node (id, parent_id, kind, title, created_at, updated_at) VALUES (?, NULL, 'subject', 'Surgery', ?, ?)`, [subject, now, now]);
    g.t.ctx.db.run(`INSERT INTO library_node (id, parent_id, kind, title, created_at, updated_at) VALUES (?, ?, 'course', 'Course 1', ?, ?)`, [course, subject, now, now]);
    g.t.ctx.db.run('UPDATE source SET node_id = ? WHERE id = ?', [course, g.lecture.sourceId]);
    const sub = await search(`q=ultrasound&node_id=${subject}`);
    expect(sub.results.length).toBeGreaterThan(0);
    expect(sub.results.every((x) => x.location?.source_id === g.lecture.sourceId)).toBe(true);
  });

  it('only the active version of live sources is searched — even when another version ranks higher', async () => {
    const s = syntheticSource('Versioned (TEST)', 'textbook', ['quokka quokka quokka quokka habitat', 'quokka habitat']);
    const trashed = syntheticSource('Trashed (TEST)', 'textbook', ['quokka quokka quokka quokka quokka']);
    g.t.ctx.db.run('UPDATE source SET deleted_at = ? WHERE id = ?', [g.t.ctx.clock.now(), trashed.sourceId]);
    const r = await search('q=quokka&limit=1');
    expect(r.results).toHaveLength(1);
    expect(r.results[0]!.location).toMatchObject({ source_id: s.sourceId, version_id: s.versionIds[1] });
    expect(r.next_cursor).toBeNull();
    // an explicit (older) version can be searched on purpose
    const old = await search(`q=quokka&version_id=${s.versionIds[0]}`);
    expect(old.results.map((x) => x.location?.version_id)).toEqual([s.versionIds[0]]);
  });

  it('generated content is labelled, ranked after source results and never evidence; owner notes are labelled too', async () => {
    const now = g.t.ctx.clock.now();
    syntheticSource('Wombat textbook (TEST)', 'textbook', ['wombat burrow']);
    const artifact = newId();
    const block = newId();
    g.t.ctx.db.run(
      `INSERT INTO artifact (id, lineage_id, version_no, kind, title, primary_source_id, scope_json, params_json, cache_key, rules_version, generator_version, verifier_version, status, created_at, updated_at)
       VALUES (?, ?, 1, 'summary', 'ملخص مولَّد', ?, '{}', '{}', 'k', 'r', 'g', 'v', 'published', ?, ?)`,
      [artifact, artifact, g.lecture.sourceId, now, now],
    );
    const generatedText = 'wombat wombat wombat wombat burrow summary';
    g.t.ctx.db.run(`INSERT INTO content_block (id, artifact_id, block_key, ord, kind, content_json, created_at) VALUES (?, ?, 'b1', 0, 'paragraph', ?, ?)`, [
      block,
      artifact,
      JSON.stringify({ v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: generatedText }] }] }),
      now,
    ]);
    g.t.ctx.db.run(`INSERT INTO owner_content_fts (entity_type, entity_id, origin, text) VALUES ('content_block', ?, 'generated', ?)`, [block, normalizeForSearch(generatedText)]);
    const note = newId();
    g.t.ctx.db.run(`INSERT INTO note (id, title, body_json, origin, created_at, updated_at) VALUES (?, 'ملاحظة', ?, 'owner', ?, ?)`, [
      note,
      JSON.stringify({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'تذكّر: wombat يحفر الجحور' }] }] }),
      now,
      now,
    ]);
    g.t.ctx.db.run(`INSERT INTO owner_content_fts (entity_type, entity_id, origin, text) VALUES ('note', ?, 'owner', ?)`, [note, normalizeForSearch('ملاحظة\nتذكّر: wombat يحفر الجحور')]);

    const r = await search('q=wombat');
    expect(r.results.map((x) => x.origin)).toEqual(['source', 'owner_note', 'generated']);
    const gen = r.results[2]!;
    expect(gen).toMatchObject({ type: 'generated', id: block, title: 'ملخص مولَّد', is_evidence: false, location: { source_id: g.lecture.sourceId } });
    expect(marked(gen)).toEqual(['wombat', 'wombat', 'wombat', 'wombat'].slice(0, gen.snippet.highlights.length));
    const n = r.results[1]!;
    expect(n).toMatchObject({ type: 'notes', id: note });
    expect(marked(n)).toEqual(['wombat']);
    // type filter
    expect((await search('q=wombat&types=generated')).results.map((x) => x.type)).toEqual(['generated']);
  });

  it('questions from question_fts: source questions before generated ones, with their occurrence', async () => {
    const now = g.t.ctx.clock.now();
    const mk = (origin: 'source' | 'generated', stem: string, withOcc: boolean) => {
      const qid = newId();
      const vid = newId();
      g.t.ctx.db.run(`INSERT INTO question (id, origin_type, current_version_id, status, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?)`, [qid, origin, vid, now, now]);
      g.t.ctx.db.run(
        `INSERT INTO question_version (id, question_id, version_no, kind, qtype, stem_json, stem_raw, extraction_status, answer_status, created_by, created_at)
         VALUES (?, ?, 1, ?, 'sba', ?, ?, 'checks_passed', 'source_key', ?, ?)`,
        [vid, qid, origin === 'source' ? 'structured' : 'generated', JSON.stringify({ v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: stem }] }] }), stem, origin === 'source' ? 'extraction' : 'generation', now],
      );
      if (withOcc) {
        const page = g.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 0', [g.questions.versionId])!;
        g.t.ctx.db.run(
          `INSERT INTO question_occurrence (id, question_id, question_version_id, source_id, source_version_id, section_key, printed_number, page_ids_json, region_ids_json, created_at)
           VALUES (?, ?, ?, ?, ?, 'Z', '9', ?, '[]', ?)`,
          [newId(), qid, vid, g.questions.sourceId, g.questions.versionId, JSON.stringify([page.id]), now],
        );
      }
      g.t.ctx.db.run('INSERT INTO question_fts (question_id, version_id, text) VALUES (?, ?, ?)', [qid, vid, normalizeForSearch(stem)]);
      return qid;
    };
    const gen = mk('generated', 'Which axolotl axolotl feature regenerates?', false);
    const src = mk('source', 'Which axolotl organ regenerates?', true);
    const r = await search('q=axolotl&types=questions');
    expect(r.results.map((x) => x.id)).toEqual([src, gen]);
    expect(r.results[0]).toMatchObject({ origin: 'source', title: 'Surgery question bank (TEST FIXTURE) — سؤال 9', location: { source_id: g.questions.sourceId, page_index: 0 } });
    expect(r.results[1]).toMatchObject({ origin: 'generated', title: 'سؤال مولَّد', location: null });
  });

  it('owner dictionary expansion and honest notices', async () => {
    g.t.ctx.db.run(`INSERT INTO medical_term (id, term_en, abbreviation, synonyms_json, origin, created_at, updated_at) VALUES (?, 'right iliac fossa', 'RIF', '[]', 'owner', ?, ?)`, [
      newId(),
      g.t.ctx.clock.now(),
      g.t.ctx.clock.now(),
    ]);
    const r = await search('q=RIF&types=chunks');
    expect(r.expansions).toEqual([{ from: 'rif', to: ['right iliac fossa'] }]);
    // exact mode searches the phrase as typed: no expansion is applied, so none is reported (review regression)
    expect((await search('q=RIF&types=chunks&mode=exact')).expansions).toEqual([]);
    const all = r.results.flatMap(marked).map((m) => m.toLowerCase());
    expect(all).toEqual(expect.arrayContaining(['right', 'iliac', 'fossa', 'rif']));
    const t = await search('q=ultrasound&types=transcripts');
    expect(t.results).toEqual([]);
    expect(t.notices_ar.join(' ')).toContain('التفريغ الصوتي غير متاح');
  });

  it('pagination with an opaque cursor', async () => {
    const a = await search('q=ultrasound&limit=1&types=chunks');
    expect(a.results).toHaveLength(1);
    expect(a.next_cursor).toEqual(expect.any(String));
    const b = await search(`q=ultrasound&limit=1&types=chunks&cursor=${a.next_cursor}`);
    expect(b.results).toHaveLength(1);
    expect(b.results[0]!.id).not.toBe(a.results[0]!.id);
  });

  it('semantic mode is refused with the reason; validation; auth', async () => {
    const sem = await g.t.app.inject({ method: 'GET', url: '/api/search?q=x&mode=semantic', headers: g.h });
    expect(sem.statusCode).toBe(409);
    expect(sem.json().error).toMatchObject({ code: 'FEATURE_DISABLED', message: expect.stringContaining('embeddings') });
    expect((await g.t.app.inject({ method: 'GET', url: '/api/search', headers: g.h })).statusCode).toBe(400);
    expect((await g.t.app.inject({ method: 'GET', url: '/api/search?q=x&types=bogus', headers: g.h })).statusCode).toBe(400);
    expect((await g.t.app.inject({ method: 'GET', url: '/api/search?q=x' })).statusCode).toBe(401);
    // FTS operators in the query are data, not syntax
    const inj = await search(`q=${q('ultrasound OR NEAR( "x" * ')}`);
    expect(inj.results).toEqual([]);
  });
});
