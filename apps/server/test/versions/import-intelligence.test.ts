// P1-T3 step 1 — import intelligence beyond numbering: subject suggestions measured on a labelled TEST FIXTURE set
// (AOS-3.2, 3.7: precision reported on fixtures ONLY), subject placement through the review queue (nothing moves
// without confirmation), lecture ordering «حسب الرقم» / «حسب التاريخ» (AOS-3.5), the printed contents page → page
// links (AOS-3.9), and the committed fixtures being exactly what the generator builds.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { orderLectures, type LectureOrderItem, type LectureOrderResponse, type PrintedTocView, type SourceIdentityResponse } from '@medlevo/shared';
import { suggestSubjects, type SubjectNode } from '../../src/modules/sources/classify';
import { parsePrintedToc } from '../../src/modules/versions/toc';
import { COMMITTED, scenario4V1, VERSIONS_FIXTURE_DIR } from '../fixtures/versions/build';
import type { TestApp } from '../helpers/app';
import { addSource, createProcessingApp, processVersion } from '../processing/helpers';

let t: TestApp;
afterEach(async () => t?.close());

describe('subject suggestions on the labelled fixture set (TEST FIXTURE)', () => {
  const set = JSON.parse(readFileSync(join(VERSIONS_FIXTURE_DIR, 'subject-suggestions.json'), 'utf8')) as {
    nodes: SubjectNode[];
    cases: Array<{ file: string; cover: string; expected: string[] }>;
  };

  it('top-1 precision ≥ 0.9 and no suggestion for files that name no folder', () => {
    let suggested = 0;
    let correct = 0;
    let expectedSome = 0;
    const wrong: string[] = [];
    for (const c of set.cases) {
      const top = suggestSubjects(c.file, c.cover, set.nodes)[0];
      if (c.expected.length) expectedSome++;
      if (!top) continue;
      suggested++;
      if (c.expected.includes(top.node.id)) correct++;
      else wrong.push(`${c.file} → ${top.node.title}`);
    }
    const precision = correct / suggested;
    const recall = correct / expectedSome;
    // the numbers reported in docs/modules/library-sources.md (fixture set only)
    console.info(`[P1-T3] subject suggestions on ${set.cases.length} TEST FIXTURE cases: top-1 precision ${correct}/${suggested} = ${precision.toFixed(3)}, recall ${correct}/${expectedSome} = ${recall.toFixed(3)}`);
    expect(wrong).toEqual([]);
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });
});

describe('placement and ordering (stored)', () => {
  it('a subject suggestion moves nothing until accepted; accepting moves the source', async () => {
    t = await createProcessingApp();
    const h = await t.login();
    const mk = async (payload: Record<string, unknown>) => {
      const r = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: h, payload });
      expect(r.statusCode, r.body).toBe(200);
      return (r.json() as { node: { id: string } }).node.id;
    };
    const year = await mk({ kind: 'notebook', title: 'Year 2', parent_id: null });
    const inbox = await mk({ kind: 'folder', title: 'Inbox', parent_id: year });
    const abdomen = await mk({ kind: 'course', title: 'Abdomen', parent_id: year });
    const { sourceId, versionId } = await addSource(t, 'x.pdf', 'pdf', { data: scenario4V1(), fileName: 'Abdomen lec5 final (1).pdf', title: 'Abdomen lec5 final (1)' });
    t.ctx.db.run('UPDATE source SET node_id = ? WHERE id = ?', [inbox, sourceId]);
    await processVersion(t, versionId);
    const id = (await t.app.inject({ method: 'GET', url: `/api/versions/sources/${sourceId}/identity`, headers: h })).json() as SourceIdentityResponse;
    const s = id.suggestions.find((x) => x.field === 'subject')!;
    expect(s).toMatchObject({ status: 'open', value: { node_id: abdomen, node_title: 'Abdomen' } });
    expect(s.reasons_ar.join(' ')).toContain('abdomen');
    expect(t.ctx.db.get<{ node_id: string }>('SELECT node_id FROM source WHERE id = ?', [sourceId])!.node_id).toBe(inbox);
    const res = await t.app.inject({ method: 'POST', url: `/api/versions/suggestions/${s.id}/decide`, headers: h, payload: { action: 'accept' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(t.ctx.db.get<{ node_id: string }>('SELECT node_id FROM source WHERE id = ?', [sourceId])!.node_id).toBe(abdomen);
  });

  it('orderLectures: by number, by date, natural-title fallback, stable ties', () => {
    const it = (source_id: string, title: string, lecture_no: number | null, held_on: string | null, sort_order: number): LectureOrderItem => ({ source_id, title, lecture_no, held_on, sort_order, created_at: 0 });
    const items = [it('a', 'Lecture 10', 10, '2026-11-01', 1), it('b', 'Lecture 2', 2, '2026-10-05', 2), it('c', 'Notes 12', null, null, 3), it('d', 'Notes 2', null, '2026-10-01', 4), it('e', 'Lecture 2 (repeat)', 2, null, 5)];
    expect(orderLectures(items, 'number').map((x) => x.source_id)).toEqual(['b', 'e', 'a', 'd', 'c']);
    expect(orderLectures(items, 'date').map((x) => x.source_id)).toEqual(['d', 'b', 'a', 'e', 'c']);
    expect(orderLectures([...items].reverse(), 'number').map((x) => x.source_id)).toEqual(['b', 'e', 'a', 'd', 'c']);
  });

  it('the order is shown; applying it is explicit and becomes the folder’s manual order', async () => {
    t = await createProcessingApp();
    const h = await t.login();
    const node = (await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: h, payload: { kind: 'course', title: 'Abdomen', parent_id: null } })).json() as { node: { id: string } };
    const now = t.ctx.clock.now();
    const add = (id: string, title: string, no: number | null, order: number) =>
      t.ctx.db.run(`INSERT INTO source (id, title, source_type, node_id, lecture_no, lecture_no_origin, sort_order, created_at, updated_at) VALUES (?, ?, 'lecture', ?, ?, ?, ?, ?, ?)`, [id, title, node.node.id, no, no === null ? null : 'owner', order, now, now]);
    add('s3', 'Lecture 3', 3, 1);
    add('s1', 'Lecture 1', 1, 2);
    add('sx', 'Extra notes', null, 3);
    add('s2', 'Lecture 2', 2, 4);
    const view = (await t.app.inject({ method: 'GET', url: `/api/versions/order?node_id=${node.node.id}&mode=number`, headers: h })).json() as LectureOrderResponse;
    expect(view.items.map((x) => x.source_id)).toEqual(['s1', 's2', 's3', 'sx']);
    expect(view.missing_key).toBe(1);
    // nothing changed by looking
    expect(t.ctx.db.all<{ id: string }>('SELECT id FROM source WHERE node_id = ? ORDER BY sort_order', [node.node.id]).map((r) => r.id)).toEqual(['s3', 's1', 'sx', 's2']);
    const applied = await t.app.inject({ method: 'POST', url: '/api/versions/order/apply', headers: h, payload: { node_id: node.node.id, mode: 'number' } });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(t.ctx.db.all<{ id: string }>('SELECT id FROM source WHERE node_id = ? ORDER BY sort_order', [node.node.id]).map((r) => r.id)).toEqual(['s1', 's2', 's3', 'sx']);
    expect(t.ctx.db.get<{ sort_mode: string }>('SELECT sort_mode FROM library_node WHERE id = ?', [node.node.id])!.sort_mode).toBe('manual');
  });
});

describe('printed table of contents → page links', () => {
  it('pure parser: dotted leaders, Arabic, number-first lines; only on a contents page', () => {
    const p = parsePrintedToc([
      { page_index: 0, lines: ['Lecture 5', 'Abdomen'] },
      { page_index: 1, lines: ['الفهرس', 'المقدمة ........ ٣', 'عضلات الجدار …… ٨', '14 ........ القناة الأربية', 'Blood supply ---- 22'] },
      { page_index: 2, lines: ['Introduction', 'Text 5 more text 12'] },
    ]);
    expect(p.toc_page_indexes).toEqual([1]);
    expect(p.entries.map((e) => [e.title, e.printed_page])).toEqual([
      ['المقدمة', '3'],
      ['عضلات الجدار', '8'],
      ['القناة الأربية', '14'],
      ['Blood supply', '22'],
    ]);
    expect(parsePrintedToc([{ page_index: 0, lines: ['Some text 12', 'More 14'] }]).entries).toEqual([]);
  });

  it('the Scenario 4 contents page links each entry to the page with that printed number', async () => {
    t = await createProcessingApp();
    const h = await t.login();
    const { versionId } = await addSource(t, 'x.pdf', 'pdf', { data: scenario4V1(), fileName: 'Abdomen Lecture 5.pdf' });
    await processVersion(t, versionId);
    const res = await t.app.inject({ method: 'GET', url: `/api/versions/versions/${versionId}/toc`, headers: h });
    expect(res.statusCode, res.body).toBe(200);
    const toc = res.json() as PrintedTocView;
    expect(toc.toc_page_indexes).toEqual([1]);
    expect(toc.entries.map((e) => [e.title, e.printed_page, e.target?.page_index, e.resolution])).toEqual([
      ['Introduction', '3', 2, 'printed_label'],
      ['Muscles of the wall', '8', 7, 'printed_label'],
      ['Inguinal canal', '14', 13, 'printed_label'],
      ['Blood supply', '22', 21, 'printed_label'],
      ['Clinical notes', '31', 30, 'printed_label'],
      ['Summary', '39', 38, 'printed_label'],
    ]);
    expect(toc.entries[0]!.target!.label_ar).toContain('3');
  });
});

describe('committed fixtures', () => {
  it('the committed PDFs are exactly what the generator builds (TEST FIXTURE, reproducible)', () => {
    for (const [name, build] of Object.entries(COMMITTED)) {
      expect(readFileSync(join(VERSIONS_FIXTURE_DIR, name)).equals(build()), name).toBe(true);
    }
  });
});
