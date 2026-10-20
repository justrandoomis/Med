// H1 / AC-04: one page label for the whole server. A page WITHOUT a printed number in a version whose other pages are
// numbered is «الصفحة 1 في الملف» — never «ص 1», which may be the printed number of another page. Before H1 many
// producers (search hits, annotation / re-anchor text, question pages, exam / weakness / home / export / media labels…)
// called the shared label without `numbered_version` and showed «ص 1» for the unnumbered cover page.
// 1) a guard: no server module calls `pageDisplayLabel` (or hand-builds «ص N») outside sources/pagelabel.ts;
// 2) the helper; 3) one behavioural test per producer family on a real fixture.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type SearchResponse } from '@medlevo/shared';
import { describeAnchorAr } from '../../src/modules/annotations/repo';
import { computeCoverage } from '../../src/modules/brain/coverage';
import { mentionView, MENTION_SELECT, type MentionRow } from '../../src/modules/brain/store';
import { fromRegion, getView } from '../../src/modules/evidence/evidence';
import { resultPageLabelAr } from '../../src/modules/exams/results';
import { homeView } from '../../src/modules/learning/home';
import { pagesLabel } from '../../src/modules/learning/weakness';
import { linksFrom } from '../../src/modules/media/links';
import { occurrenceView } from '../../src/modules/questions/store';
import { pageLabelAr, pageLabelKnown, versionIsNumbered, versionNumberedSql } from '../../src/modules/sources/pagelabel';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';
import { op } from '../annotations/helpers';

const SRC_DIR = join(__dirname, '../../src');
const COVER = 'الصفحة 1 في الملف';

let t: TestApp;
let h: AuthHeaders;
const f = { sourceId: '', versionId: '', plainVersionId: '', pages: [] as string[], plainPage: '', region: '' };

beforeAll(async () => {
  t = await createTestApp();
  h = await t.login();
  const db = t.ctx.db;
  const now = t.ctx.clock.now();
  f.sourceId = newId(now);
  f.versionId = newId(now);
  f.plainVersionId = newId(now);
  db.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES (?, 'Numbered lecture (TEST FIXTURE)', 'lecture', ?, ?)`, [f.sourceId, now, now]);
  for (const [vid, no] of [
    [f.versionId, 1],
    [f.plainVersionId, 2],
  ] as const) {
    db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, format, page_count, processing_status, created_at)
       VALUES (?, ?, ?, 'original', ?, 'application/pdf', 'pdf', 4, 'ready', ?)`,
      [vid, f.sourceId, no, `h-${vid}`, now],
    );
  }
  db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [f.versionId, f.sourceId]);
  // version 1: an unnumbered cover, then printed pages 12, 13, 14
  ['', '12', '13', '14'].forEach((label, i) => {
    const id = newId(now);
    f.pages.push(id);
    db.run(
      `INSERT INTO source_page (id, version_id, page_index, printed_label, printed_label_origin, kind, width, height, unit, processing_status, text_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'page', 595, 842, 'pt', 'ready', 'digital', ?, ?)`,
      [id, f.versionId, i, label || null, label ? 'detected_text' : null, now, now],
    );
  });
  // version 2: no printed numbers at all → «ص 1» stays correct there
  f.plainPage = newId(now);
  db.run(
    `INSERT INTO source_page (id, version_id, page_index, printed_label, kind, width, height, unit, processing_status, text_status, created_at, updated_at)
     VALUES (?, ?, 0, NULL, 'page', 595, 842, 'pt', 'ready', 'digital', ?, ?)`,
    [f.plainPage, f.plainVersionId, now, now],
  );
  f.region = newId(now);
  db.run(
    `INSERT INTO source_region (id, version_id, page_id, kind, reading_order, text, text_origin, status, created_at, updated_at)
     VALUES (?, ?, ?, 'paragraph', 0, 'Synthetic cover text about hepatocyte zonation (TEST FIXTURE).', 'digital', 'extracted', ?, ?)`,
    [f.region, f.versionId, f.pages[0], now, now],
  );
  db.run(
    `INSERT INTO document_chunk (id, version_id, source_id, kind, text, region_ids_json, page_ids_json, index_version, created_at)
     VALUES (?, ?, ?, 'text', 'Synthetic cover text about hepatocyte zonation (TEST FIXTURE).', ?, ?, 'idx-test', ?)`,
    [newId(now), f.versionId, f.sourceId, JSON.stringify([f.region]), JSON.stringify([f.pages[0]]), now],
  );
}, 60_000);
afterAll(async () => t?.close());

function serverFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? serverFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('the one server page label (guard)', () => {
  it('no server module calls pageDisplayLabel or hand-builds «ص N» outside sources/pagelabel.ts', () => {
    const offenders: string[] = [];
    for (const file of serverFiles(SRC_DIR)) {
      const rel = relative(SRC_DIR, file);
      if (rel === join('modules', 'sources', 'pagelabel.ts')) continue;
      const src = readFileSync(file, 'utf8');
      if (/pageDisplayLabel\s*\(/.test(src)) offenders.push(`${rel}: pageDisplayLabel(`);
      if (/`ص \$\{/.test(src)) offenders.push(`${rel}: \`ص \${…}\``);
    }
    expect(offenders).toEqual([]);
  });
});

describe('pageLabelAr / pageLabelKnown', () => {
  it('derives numbered_version from the version, the page id, or takes a known value', () => {
    const db = t.ctx.db;
    const cover = { page_index: 0, printed_label: null, kind: 'page' };
    expect(versionIsNumbered(db, f.versionId)).toBe(true);
    expect(versionIsNumbered(db, f.plainVersionId)).toBe(false);
    expect(pageLabelAr(db, { ...cover, version_id: f.versionId })).toBe(COVER);
    expect(pageLabelAr(db, { ...cover, id: f.pages[0]! })).toBe(COVER);
    expect(pageLabelAr(db, { ...cover, page_id: f.pages[0]! })).toBe(COVER);
    expect(pageLabelKnown({ ...cover, numbered_version: true })).toBe(COVER);
    expect(pageLabelAr(db, { ...cover, id: f.plainPage })).toBe('ص 1');
    expect(pageLabelAr(db, { page_index: 1, printed_label: '12', kind: 'page', version_id: f.versionId })).toBe('ص 12 (الصفحة 2 في الملف)');
    expect(pageLabelAr(db, { page_index: 1, printed_label: '12', kind: 'page', version_id: f.versionId }, { withFileIndex: false })).toBe('ص 12');
    const row = db.get<{ n: number | null }>(`SELECT ${versionNumberedSql('p')} AS n FROM source_page p WHERE p.id = ?`, [f.plainPage]);
    expect(row!.n).toBeNull();
  });
});

describe('producer families name the unnumbered cover «الصفحة 1 في الملف»', () => {
  it('evidence citations (Evidence Peek locator)', () => {
    const ev = fromRegion(t.ctx, f.region);
    expect(getView(t.ctx, ev.id).locator_label_ar).toBe(COVER);
  });

  it('universal search hits', async () => {
    const res = (await t.app.inject({ method: 'GET', url: '/api/search?q=hepatocyte&types=chunks', headers: h })).json() as SearchResponse;
    const hit = res.results.find((r) => r.location?.page_id === f.pages[0]);
    expect(hit, JSON.stringify(res.results)).toBeTruthy();
    expect(hit!.location!.page_label_ar).toBe(COVER);
  });

  it('annotation / re-anchor descriptions', () => {
    const d = describeAnchorAr(t.ctx.db, { type: 'page', source_id: f.sourceId, version_id: f.versionId, page_id: f.pages[0]!, page_index: 0, space: 'page_norm' });
    expect(d.text).toBe(`${COVER} — الإصدار 1`);
  });

  it('home «continue» (study session page)', async () => {
    const sid = newId();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: h,
      payload: {
        ops: [
          op({
            entity_type: 'study_session',
            entity_id: sid,
            payload: { source_id: f.sourceId, version_id: f.versionId, mode: 'learn', view: 'original', location: { page_index: 0, page_id: f.pages[0], zoom: 1, rotation: 0, layout: 'continuous' } },
          }),
        ],
      } as never,
    });
    expect(res.json().results[0].result).toBe('applied');
    const cont = homeView(t.ctx).continue.find((c) => c.source_id === f.sourceId);
    expect(cont?.page_label_ar).toBe(COVER);
  });

  it('question pages and the origin label', () => {
    const v = occurrenceView(t.ctx, {
      id: 'occ-1',
      question_id: 'q-1',
      question_version_id: 'qv-1',
      source_id: f.sourceId,
      source_version_id: f.versionId,
      section_key: '',
      section_title: null,
      printed_number: '1',
      page_ids_json: JSON.stringify([f.pages[0], f.pages[1]]),
      region_ids_json: '[]',
      source_title: 'Numbered lecture (TEST FIXTURE)',
      source_type: 'question_source',
    } as never);
    expect(v.pages.map((p) => p.label_ar)).toEqual([COVER, 'ص 12']);
    expect(v.origin_label_ar).toContain(COVER);
    expect(v.origin_label_ar).not.toMatch(/ص 1(?!\d)/);
  });

  it('exam result pages and weakness pages', () => {
    expect(resultPageLabelAr(t.ctx, f.pages[0]!)).toBe(COVER);
    expect(resultPageLabelAr(t.ctx, f.plainPage)).toBe('ص 1');
    expect(pagesLabel(t.ctx.db, [f.pages[0]!, f.pages[2]!])).toEqual([COVER, 'ص 13']);
  });

  it('media links (transcript segment → page)', () => {
    const now = t.ctx.clock.now();
    t.ctx.db.run(`INSERT INTO media_region_link (id, from_type, from_id, to_page_id, origin, created_at) VALUES (?, 'transcript_segment', 'seg-h1', ?, 'manual', ?)`, [newId(now), f.pages[0], now]);
    expect(linksFrom(t.ctx, 'transcript_segment', 'seg-h1')[0]!.page_label_ar).toBe(COVER);
  });

  it('course brain: coverage rows (pure) and concept mentions', () => {
    const cov = computeCoverage(
      [
        { id: 'p0', page_index: 0, printed_label: null, kind: 'page' },
        { id: 'p1', page_index: 1, printed_label: '12', kind: 'page' },
      ],
      [],
      [],
    );
    expect(cov.pages.map((p) => p.label_ar)).toEqual([COVER, 'ص 12 (الصفحة 2 في الملف)']);
    const now = t.ctx.clock.now();
    const conceptId = newId(now);
    t.ctx.db.run(`INSERT INTO concept (id, name_en, kind, origin, status, created_at, updated_at) VALUES (?, 'hepatocyte zonation', 'concept', 'auto', 'accepted', ?, ?)`, [conceptId, now, now]);
    t.ctx.db.run(`INSERT INTO concept_mention (id, concept_id, region_id, version_id, role, created_at) VALUES (?, ?, ?, ?, 'stated', ?)`, [newId(now), conceptId, f.region, f.versionId, now]);
    const m = t.ctx.db.get<MentionRow>(`${MENTION_SELECT} WHERE m.concept_id = ?`, [conceptId])!;
    expect(mentionView(m).page_label_ar).toBe(COVER);
  });

  it('export of a source (page headings)', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/data/export/source/${f.sourceId}?format=md`, headers: h });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.body).toContain(`## ${COVER}`);
    expect(res.body).not.toMatch(/^## ص 1$/m);
  });
});
