import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImpactReport, LibraryNodeView, LibraryTreeResponse, TemplatesResponse, TopicLinkView } from '@medlevo/shared';
import { suggestTopicLink } from '../../src/modules/library/tags';
import { orderBetween } from '../../src/modules/library/service';
import { CSRF } from '../helpers/app';
import { api, createNode, golden, type Harness, makeHarness, uploadOk } from '../sources/helpers';

let t: Harness;
beforeEach(async () => {
  t = await makeHarness();
});
afterEach(async () => {
  await t.close();
});

const tree = async (include = ''): Promise<LibraryTreeResponse> =>
  (await api(t).get(`/api/library/tree${include ? `?include=${include}` : ''}`)).json() as LibraryTreeResponse;

describe('AC-01 personal library', () => {
  it('creates a surgery notebook, a course and lecture / reference / question-source folders; no institutions anywhere', async () => {
    const nb = await createNode(t, { kind: 'notebook', title: 'الجراحة', cover: { style: 'linen', color: 'rose', symbol: 'syringe' } });
    const course = await createNode(t, { kind: 'course', title: 'Course 1', parent_id: nb.id });
    const lectures = await createNode(t, { kind: 'folder', title: 'المحاضرات', parent_id: course.id });
    await createNode(t, { kind: 'folder', title: 'المراجع', parent_id: course.id });
    await createNode(t, { kind: 'folder', title: 'مصادر الأسئلة', parent_id: course.id });
    const res = await uploadOk(t, lectures.id, [{ name: 'lecture_appendicitis.pdf', data: golden('lecture_appendicitis.pdf') }]);
    expect(res.results[0]!.status).toBe('accepted');
    const tr = await tree();
    expect(tr.nodes.map((n) => n.title)).toEqual(expect.arrayContaining(['الجراحة', 'Course 1', 'المحاضرات', 'المراجع', 'مصادر الأسئلة']));
    expect(tr.nodes.find((n) => n.id === nb.id)!.cover).toEqual({ style: 'linen', color: 'rose', symbol: 'syringe' });
    const src = tr.sources[0]!;
    expect(src.course_node_id).toBe(course.id); // derived from ancestors
    // single owner: no institution / member / role endpoints exist
    for (const url of ['/api/library/institutions', '/api/library/members', '/api/library/roles']) {
      expect((await api(t).get(url)).statusCode).toBe(404);
    }
    const caps = (await api(t).get('/api/capabilities')).json();
    expect(caps.features.library.state).toBe('available');
    expect(Object.keys(caps.features).some((k) => /institution|cohort|role|tenant/.test(k))).toBe(false);
  });
});

describe('nodes', () => {
  it('rename keeps id and links; audited as rename', async () => {
    const n = await createNode(t, { kind: 'subject', title: 'Pharma' });
    const tag = (await api(t).post('/api/library/tags', { name: 'مهم', color: 'amber' })).json().tag;
    await api(t).post(`/api/library/tags/${tag.id}/links`, { entity_type: 'library_node', entity_id: n.id });
    const res = await api(t).patch(`/api/library/nodes/${n.id}`, { title: 'الأدوية' });
    expect(res.statusCode).toBe(200);
    const node = res.json().node as LibraryNodeView;
    expect(node.id).toBe(n.id);
    expect(node.title).toBe('الأدوية');
    expect(node.tags.map((x) => x.name)).toEqual(['مهم']);
    const audit = (await api(t).get(`/api/audit?entity_type=library_node&entity_id=${n.id}`)).json();
    expect(audit.entries.map((e: { action: string }) => e.action)).toEqual(['rename', 'tag', 'create']);
  });

  it('validates tokens: unknown cover colour, raw hex and unknown template are rejected', async () => {
    const bad1 = await api(t).post('/api/library/nodes', { parent_id: null, kind: 'notebook', title: 'x', cover: { style: 'linen', color: '#ff0000' } });
    expect(bad1.statusCode).toBe(400);
    expect(bad1.json().error.code).toBe('VALIDATION_FAILED');
    const bad2 = await api(t).post('/api/library/nodes', { parent_id: null, kind: 'notebook', title: 'x', template: 'nope' });
    expect(bad2.statusCode).toBe(400);
    const bad3 = await api(t).post('/api/library/nodes', { parent_id: null, kind: 'university', title: 'x' });
    expect(bad3.statusCode).toBe(400);
    const empty = await api(t).post('/api/library/nodes', { parent_id: null, kind: 'folder', title: '   ' });
    expect(empty.statusCode).toBe(400);
  });

  it('move: manual ordering with before/after (fractional), renumbering when gaps run out', async () => {
    const parent = await createNode(t, { title: 'P' });
    const a = await createNode(t, { title: 'A', parent_id: parent.id });
    const b = await createNode(t, { title: 'B', parent_id: parent.id });
    const c = await createNode(t, { title: 'C', parent_id: parent.id });
    const order = async () =>
      (await tree()).nodes
        .filter((n) => n.parent_id === parent.id)
        .sort((x, y) => x.sort_order - y.sort_order)
        .map((n) => n.title);
    expect(await order()).toEqual(['A', 'B', 'C']);
    expect((await api(t).post(`/api/library/nodes/${c.id}/move`, { parent_id: parent.id, before_id: a.id })).statusCode).toBe(200);
    expect(await order()).toEqual(['C', 'A', 'B']);
    await api(t).post(`/api/library/nodes/${c.id}/move`, { parent_id: parent.id, after_id: a.id });
    expect(await order()).toEqual(['A', 'C', 'B']);
    // squeeze 60 times between A and its next sibling: gaps go below 1e-6 and siblings are renumbered
    for (let i = 0; i < 60; i++) {
      const cur = await order();
      const moving = cur[2] === 'B' ? b : c;
      const r = await api(t).post(`/api/library/nodes/${moving.id}/move`, { parent_id: parent.id, after_id: a.id });
      expect(r.statusCode).toBe(200);
    }
    expect((await order())[0]).toBe('A');
    expect(new Set(await order()).size).toBe(3);
    expect(orderBetween(null, null)).toBeGreaterThan(0);
    expect(orderBetween(1, 2)).toBe(1.5);
  });

  it('move: prevents cycles (into itself or a descendant) with a clear Arabic error', async () => {
    const root = await createNode(t, { title: 'Root' });
    const child = await createNode(t, { title: 'Child', parent_id: root.id });
    const grand = await createNode(t, { title: 'Grand', parent_id: child.id });
    for (const target of [root.id, child.id, grand.id]) {
      const r = await api(t).post(`/api/library/nodes/${root.id}/move`, { parent_id: target });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toContain('لا يمكن نقل المجلد إلى داخله');
    }
    const ok = await api(t).post(`/api/library/nodes/${grand.id}/move`, { parent_id: null });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().node.parent_id).toBeNull();
    const bothAnchors = await api(t).post(`/api/library/nodes/${grand.id}/move`, { parent_id: null, before_id: root.id, after_id: root.id });
    expect(bothAnchors.statusCode).toBe(400);
  });

  it('moving a folder into a course recomputes the course/subject of the sources inside it', async () => {
    const subject = await createNode(t, { kind: 'subject', title: 'Surgery' });
    const course = await createNode(t, { kind: 'course', title: 'Course 1', parent_id: subject.id });
    const loose = await createNode(t, { title: 'Loose' });
    const up = await uploadOk(t, loose.id, [{ name: 'lecture_cholecystitis.pdf', data: golden('lecture_cholecystitis.pdf') }]);
    const sid = up.results[0]!.source_id!;
    let s = (await api(t).get(`/api/sources/${sid}`)).json();
    expect([s.subject_node_id, s.course_node_id]).toEqual([null, null]);
    await api(t).post(`/api/library/nodes/${loose.id}/move`, { parent_id: course.id });
    s = (await api(t).get(`/api/sources/${sid}`)).json();
    expect([s.subject_node_id, s.course_node_id]).toEqual([subject.id, course.id]);
    expect(s.path.map((p: { title: string }) => p.title)).toEqual(['Surgery', 'Course 1', 'Loose']);
  });

  it('archive hides the subtree unless include=archived', async () => {
    const a = await createNode(t, { title: 'Old year' });
    const inner = await createNode(t, { title: 'Inner', parent_id: a.id });
    await uploadOk(t, inner.id, [{ name: 'flowchart.png', data: golden('flowchart.png') }]);
    await api(t).post(`/api/library/nodes/${a.id}/archive`);
    let tr = await tree();
    expect(tr.nodes.find((n) => n.id === a.id || n.id === inner.id)).toBeUndefined();
    expect(tr.sources).toHaveLength(0);
    tr = await tree('archived');
    expect(tr.nodes.find((n) => n.id === a.id)!.archived_at).not.toBeNull();
    expect(tr.sources).toHaveLength(1);
    await api(t).post(`/api/library/nodes/${a.id}/unarchive`);
    expect((await tree()).sources).toHaveLength(1);
  });
});

describe('trash & restore (subtree semantics)', () => {
  it('trashing a node hides its descendants and their sources; restore brings them back; audit recorded', async () => {
    const root = await createNode(t, { title: 'Year 4' });
    const sub = await createNode(t, { title: 'Sub', parent_id: root.id });
    const sibling = await createNode(t, { title: 'Sibling' });
    const up = await uploadOk(t, sub.id, [
      { name: 'flowchart.png', data: golden('flowchart.png') },
      { name: 'scanned_page.png', data: golden('scanned_page.png') },
    ]);
    const [s1, s2] = up.results.map((r) => r.source_id!);
    // s2 trashed on its own first: it must stay trashed after the folder is restored
    expect((await api(t).post(`/api/sources/${s2}/trash`)).statusCode).toBe(200);
    expect((await api(t).post(`/api/library/nodes/${root.id}/trash`)).statusCode).toBe(200);
    let tr = await tree();
    expect(tr.nodes.map((n) => n.id)).toEqual([sibling.id]);
    expect(tr.sources).toHaveLength(0);
    // every module filtering on deleted_at IS NULL sees nothing from the trashed subtree
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source WHERE deleted_at IS NULL')!.n).toBe(0);
    tr = await tree('trash');
    expect(tr.nodes.find((n) => n.id === sub.id)!.deleted_at).not.toBeNull();
    // a child trashed together with its parent is restored through the parent
    const childRestore = await api(t).post(`/api/library/nodes/${sub.id}/restore`, {});
    expect(childRestore.statusCode).toBe(409);
    expect(childRestore.json().error.details.reason).toBe('trashed_with_parent');
    const r = await api(t).post(`/api/library/nodes/${root.id}/restore`, {});
    expect(r.statusCode).toBe(200);
    tr = await tree();
    expect(tr.nodes.map((n) => n.id).sort()).toEqual([root.id, sub.id, sibling.id].sort());
    expect(tr.sources.map((s) => s.id)).toEqual([s1]);
    const actions = (await api(t).get(`/api/audit?entity_type=library_node&entity_id=${root.id}`)).json().entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['restore', 'trash', 'create']);
  });

  it('restoring when the original parent is in the trash asks for a destination', async () => {
    const parent = await createNode(t, { title: 'Parent' });
    const child = await createNode(t, { title: 'Child', parent_id: parent.id });
    const other = await createNode(t, { title: 'Other' });
    await api(t).post(`/api/library/nodes/${child.id}/trash`);
    await api(t).post(`/api/library/nodes/${parent.id}/trash`);
    const r1 = await api(t).post(`/api/library/nodes/${child.id}/restore`, {});
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.details.reason).toBe('parent_in_trash');
    const r2 = await api(t).post(`/api/library/nodes/${child.id}/restore`, { parent_id: other.id });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().node.parent_id).toBe(other.id);
    const moveIntoTrash = await api(t).post(`/api/library/nodes/${other.id}/move`, { parent_id: parent.id });
    expect(moveIntoTrash.statusCode).toBe(409);
  });
});

describe('impact & permanent purge', () => {
  async function seed() {
    const root = await createNode(t, { kind: 'course', title: 'To delete' });
    const inner = await createNode(t, { title: 'Inner', parent_id: root.id });
    const keep = await createNode(t, { title: 'Keep' });
    const up = await uploadOk(t, inner.id, [
      { name: 'histology_images.zip', data: golden('histology_images.zip') },
      { name: 'lecture_appendicitis.pdf', data: golden('lecture_appendicitis.pdf') },
    ]);
    const zipSource = up.results[0]!.source_id!;
    const pdfSource = up.results[1]!.source_id!;
    // a source OUTSIDE the subtree sharing one image blob (dedup) with the purged zip
    const outside = await uploadOk(t, keep.id, [{ name: 'muscle.png', data: await zipEntry('slides/10_muscle.png') }]);
    expect(outside.results[0]!.status).toBe('accepted');
    const db = t.ctx.db;
    const now = t.clock.now();
    const page = db.get<{ id: string; version_id: string }>(
      'SELECT p.id, p.version_id FROM source_page p JOIN source s ON s.current_version_id = p.version_id WHERE s.id = ? ORDER BY page_index LIMIT 1',
      [zipSource],
    )!;
    // owner writing on a purged page + a note in the folder
    db.run(`INSERT INTO annotation (id, kind, anchor_json, data_json, created_at, updated_at) VALUES ('ANN1', 'ink', ?, '{}', ?, ?)`, [
      JSON.stringify({ type: 'page', source_id: zipSource, version_id: page.version_id, page_id: page.id, page_index: 0, space: 'page_norm' }),
      now,
      now,
    ]);
    db.run(`INSERT INTO annotation_target (annotation_id, target_type, target_id) VALUES ('ANN1', 'source_page', ?)`, [page.id]);
    db.run(`INSERT INTO note (id, node_id, body_json, created_at, updated_at) VALUES ('NOTE1', ?, '{}', ?, ?)`, [inner.id, now, now]);
    // a question that occurs only in the purged source, with an attempt
    db.run(`INSERT INTO question (id, origin_type, created_at, updated_at) VALUES ('Q1', 'source', ?, ?)`, [now, now]);
    db.run(
      `INSERT INTO question_version (id, question_id, version_no, kind, qtype, stem_json, extraction_status, answer_status, created_by, created_at)
       VALUES ('QV1', 'Q1', 1, 'raw_extraction', 'sba', '{}', 'extracted', 'missing_key', 'extraction', ?)`,
      [now],
    );
    db.run(
      `INSERT INTO question_occurrence (id, question_id, question_version_id, source_id, source_version_id, printed_number, page_ids_json, region_ids_json, created_at)
       VALUES ('QO1', 'Q1', 'QV1', ?, ?, '1', '[]', '[]', ?)`,
      [zipSource, page.version_id, now],
    );
    db.run(`INSERT INTO question_attempt (id, question_id, question_version_id, answered_at, created_at) VALUES ('QA1', 'Q1', 'QV1', ?, ?)`, [now, now]);
    // a flashcard from the pdf source, with a review
    const pdfVersion = db.get<{ id: string }>('SELECT current_version_id AS id FROM source WHERE id = ?', [pdfSource])!.id;
    db.run(`INSERT INTO flashcard (id, kind, front_json, back_json, source_id, origin, created_at, updated_at) VALUES ('FC1', 'basic', '{}', '{}', ?, 'owner', ?, ?)`, [pdfSource, now, now]);
    db.run(`INSERT INTO review_event (id, card_id, rating, reviewed_at, created_at) VALUES ('RE1', 'FC1', 3, ?, ?)`, [now, now]);
    // an artifact from the pdf, and an artifact OUTSIDE that cites evidence from it
    db.run(
      `INSERT INTO source_region (id, version_id, page_id, kind, text, created_at, updated_at) VALUES ('R1', ?, NULL, 'paragraph', 'text', ?, ?)`,
      [pdfVersion, now, now],
    );
    db.run(`INSERT INTO evidence (id, version_id, source_id, region_id, quote, created_at) VALUES ('E1', ?, ?, 'R1', 'text', ?)`, [pdfVersion, pdfSource, now]);
    for (const [aid, src] of [
      ['ART_IN', pdfSource],
      ['ART_OUT', outside.results[0]!.source_id!],
    ] as const) {
      db.run(
        `INSERT INTO artifact (id, lineage_id, version_no, kind, primary_source_id, scope_json, params_json, cache_key, rules_version, generator_version, verifier_version, status, created_at, updated_at)
         VALUES (?, ?, 1, 'summary', ?, '{}', '{}', 'k', '1', '1', '1', 'published', ?, ?)`,
        [aid, `L_${aid}`, src, now, now],
      );
      db.run(`INSERT INTO content_block (id, artifact_id, block_key, ord, kind, content_json, created_at) VALUES (?, ?, 'b1', 0, 'paragraph', '{}', ?)`, [`CB_${aid}`, aid, now]);
      db.run(`INSERT INTO claim (id, owner_type, owner_id, text, support_type, verification_status, created_at, updated_at) VALUES (?, 'content_block', ?, 'c', 'directly_stated', 'linked', ?, ?)`, [
        `CL_${aid}`,
        `CB_${aid}`,
        now,
        now,
      ]);
      db.run(`INSERT INTO citation (id, claim_id, evidence_id, relation, created_at) VALUES (?, ?, 'E1', 'supports', ?)`, [`CI_${aid}`, `CL_${aid}`, now]);
    }
    db.run(`INSERT INTO artifact_dependency (id, dependent_type, dependent_id, source_version_id, created_at) VALUES ('DEP1', 'artifact', 'ART_OUT', ?, ?)`, [pdfVersion, now]);
    return { root, inner, keep, zipSource, pdfSource, outsideSource: outside.results[0]!.source_id! };
  }

  async function zipEntry(name: string): Promise<Buffer> {
    const JSZip = (await import('jszip')).default;
    const z = await JSZip.loadAsync(golden('histology_images.zip'));
    return z.file(name)!.async('nodebuffer');
  }

  it('impact counts the subtree: nodes, sources, versions, pages, annotations, notes, questions, flashcards, artifacts', async () => {
    const s = await seed();
    const r = (await api(t).get(`/api/library/nodes/${s.root.id}/impact?mode=purge`)).json() as ImpactReport;
    expect(r).toMatchObject({ nodes: 2, sources: 2, versions: 2, pages: 3, annotations: 1, notes: 1, questions: 1, flashcards: 1, artifacts: 1 });
    expect(r.confirm_token).toBeTruthy();
    expect(r.lines_ar.join('\n')).toMatch(/سيُحذف نهائيًا: مجلدان/);
    expect(r.lines_ar.join('\n')).toMatch(/يستشهد بهذه المصادر/);
    const trash = (await api(t).get(`/api/library/nodes/${s.root.id}/impact?mode=trash`)).json() as ImpactReport;
    expect(trash.confirm_token).toBeUndefined();
    expect(trash.lines_ar.join('\n')).toMatch(/سلة المحذوفات/);
  });

  it('purge: only from trash, only with a valid token; deletes exactly the subtree; orphaned files removed after commit', async () => {
    const s = await seed();
    const notInTrash = await api(t).del(`/api/library/nodes/${s.root.id}?confirm_token=x`);
    expect(notInTrash.statusCode).toBe(409);
    await api(t).post(`/api/library/nodes/${s.root.id}/trash`);
    expect((await api(t).del(`/api/library/nodes/${s.root.id}`)).statusCode).toBe(400);
    expect((await api(t).del(`/api/library/nodes/${s.root.id}?confirm_token=abc.def`)).statusCode).toBe(400);
    const impact = (await api(t).get(`/api/library/nodes/${s.root.id}/impact?mode=purge`)).json() as ImpactReport;
    // a token for a different node is rejected
    const other = (await api(t).get(`/api/library/nodes/${s.keep.id}/impact?mode=purge`)).json() as ImpactReport;
    expect((await api(t).del(`/api/library/nodes/${s.root.id}?confirm_token=${encodeURIComponent(other.confirm_token!)}`)).statusCode).toBe(400);
    // the impact changes after the token was issued → must re-confirm
    t.ctx.db.run(`INSERT INTO note (id, node_id, body_json, created_at, updated_at) VALUES ('NOTE2', ?, '{}', 1, 1)`, [s.inner.id]);
    const stale = await api(t).del(`/api/library/nodes/${s.root.id}?confirm_token=${encodeURIComponent(impact.confirm_token!)}`);
    expect(stale.statusCode).toBe(409);
    // expired token
    const fresh = (await api(t).get(`/api/library/nodes/${s.root.id}/impact?mode=purge`)).json() as ImpactReport;
    t.clock.advance(16 * 60 * 1000);
    expect((await api(t).del(`/api/library/nodes/${s.root.id}?confirm_token=${encodeURIComponent(fresh.confirm_token!)}`)).statusCode).toBe(400);

    const blobsBefore = t.ctx.db.all<{ id: string }>('SELECT id FROM stored_file').map((r) => r.id);
    const paths = new Map(blobsBefore.map((id) => [id, t.ctx.files.path(id)]));
    const sharedFile = t.ctx.db.get<{ file_id: string }>(
      'SELECT v.file_id FROM source_version v JOIN source s ON s.current_version_id = v.id WHERE s.id = ?',
      [s.outsideSource],
    )!.file_id;

    const tok = (await api(t).get(`/api/library/nodes/${s.root.id}/impact?mode=purge`)).json() as ImpactReport;
    const res = await api(t).del(`/api/library/nodes/${s.root.id}?confirm_token=${encodeURIComponent(tok.confirm_token!)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toMatchObject({ nodes: 2, sources: 2, notes: 2, questions: 1, flashcards: 1 });
    const db = t.ctx.db;
    const n = (sql: string, p: unknown[] = []) => db.get<{ n: number }>(sql, p)!.n;
    expect(n('SELECT COUNT(*) AS n FROM library_node WHERE id IN (?, ?)', [s.root.id, s.inner.id])).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM library_node WHERE id = ?', [s.keep.id])).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM source WHERE id IN (?, ?)', [s.zipSource, s.pdfSource])).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM source WHERE id = ?', [s.outsideSource])).toBe(1);
    for (const [table, id] of [
      ['annotation', 'ANN1'],
      ['note', 'NOTE1'],
      ['question', 'Q1'],
      ['question_attempt', 'QA1'],
      ['flashcard', 'FC1'],
      ['review_event', 'RE1'],
      ['artifact', 'ART_IN'],
      ['evidence', 'E1'],
    ]) {
      expect(n(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, [id]), `${table} ${id}`).toBe(0);
    }
    // outside artifact is kept, unlinked and flagged; a content alert lists it
    expect(db.get<{ status: string }>(`SELECT status FROM artifact WHERE id = 'ART_OUT'`)!.status).toBe('stale');
    expect(db.get<{ verification_status: string }>(`SELECT verification_status FROM claim WHERE id = 'CL_ART_OUT'`)!.verification_status).toBe('needs_review');
    expect(n(`SELECT COUNT(*) AS n FROM citation WHERE id = 'CI_ART_OUT'`)).toBe(0);
    const alert = db.get<{ kind: string; affected_json: string }>(`SELECT kind, affected_json FROM content_alert WHERE kind = 'source_deleted'`)!;
    expect(JSON.parse(alert.affected_json)).toEqual(expect.arrayContaining([{ type: 'artifact', id: 'ART_OUT', impact: 'needs_review' }]));
    // files: blobs used only by the purged sources are gone from DB and disk; the shared blob stays
    expect(t.ctx.files.verifyBlob(sharedFile)).toBe(true);
    const remaining = new Set(db.all<{ id: string }>('SELECT id FROM stored_file').map((r) => r.id));
    const removed = blobsBefore.filter((id) => !remaining.has(id));
    expect(removed.length).toBe(res.json().removed_files);
    expect(removed.length).toBeGreaterThanOrEqual(3); // zip original + 2 unshared images + pdf
    for (const id of removed) expect(existsSync(paths.get(id)!)).toBe(false);
    // sync clients learn about deleted owner writing
    const feed = db.all<{ entity_type: string; entity_id: string }>('SELECT entity_type, entity_id FROM sync_change');
    expect(feed).toEqual(expect.arrayContaining([{ entity_type: 'annotation', entity_id: 'ANN1' }, { entity_type: 'note', entity_id: 'NOTE1' }]));
    const audit = (await api(t).get(`/api/audit?entity_type=library_node&entity_id=${s.root.id}`)).json().entries;
    expect(audit[0].action).toBe('purge');
  });

  it('a table that still references the purge set (unknown to this module) aborts the purge — nothing deleted', async () => {
    const root = await createNode(t, { title: 'X' });
    const up = await uploadOk(t, root.id, [{ name: 'flowchart.png', data: golden('flowchart.png') }]);
    t.ctx.db.exec(`CREATE TABLE future_thing (id TEXT PRIMARY KEY, source_id TEXT REFERENCES source(id)) STRICT`);
    t.ctx.db.run('INSERT INTO future_thing (id, source_id) VALUES (?, ?)', ['F1', up.results[0]!.source_id!]);
    await api(t).post(`/api/library/nodes/${root.id}/trash`);
    const tok = (await api(t).get(`/api/library/nodes/${root.id}/impact?mode=purge`)).json().confirm_token;
    const res = await api(t).del(`/api/library/nodes/${root.id}?confirm_token=${encodeURIComponent(tok)}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('لم يُحذف أي شيء');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source')!.n).toBe(1);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM library_node')!.n).toBe(1);
  });
});

describe('tags, topics, templates, recent, favorites', () => {
  it('tags CRUD and link/unlink to nodes and sources (deleting a tag never deletes items)', async () => {
    const node = await createNode(t, { title: 'N' });
    const up = await uploadOk(t, node.id, [{ name: 'flowchart.png', data: golden('flowchart.png') }]);
    const sid = up.results[0]!.source_id!;
    const tag = (await api(t).post('/api/library/tags', { name: 'High yield', color: 'amber' })).json().tag;
    expect((await api(t).post('/api/library/tags', { name: 'high YIELD' })).statusCode).toBe(409);
    await api(t).post(`/api/library/tags/${tag.id}/links`, { entity_type: 'source', entity_id: sid });
    await api(t).post(`/api/library/tags/${tag.id}/links`, { entity_type: 'library_node', entity_id: node.id });
    expect((await api(t).post(`/api/library/tags/${tag.id}/links`, { entity_type: 'source', entity_id: 'NOPE' })).statusCode).toBe(404);
    let tr = await tree();
    expect(tr.sources[0]!.tags.map((x) => x.name)).toEqual(['High yield']);
    expect((await api(t).get('/api/library/tags')).json().tags[0].usage).toBe(2);
    await api(t).patch(`/api/library/tags/${tag.id}`, { name: 'مهم جدًا' });
    await api(t).del(`/api/library/tags/${tag.id}/links?entity_type=source&entity_id=${sid}`);
    tr = await tree();
    expect(tr.sources[0]!.tags).toEqual([]);
    expect(tr.nodes[0]!.tags.map((x) => x.name)).toEqual(['مهم جدًا']);
    await api(t).del(`/api/library/tags/${tag.id}`);
    tr = await tree();
    expect(tr.nodes).toHaveLength(1);
    expect(tr.nodes[0]!.tags).toEqual([]);
  });

  it('topic links: auto suggestions are correctable and the owner decision persists', async () => {
    const node = await createNode(t, { title: 'N' });
    const topic = (await api(t).post('/api/library/topics', { title: 'Appendicitis', title_ar: 'التهاب الزائدة' })).json().topic;
    const sugg = suggestTopicLink(t.ctx, topic.id, 'library_node', node.id)!;
    expect(sugg).toMatchObject({ origin: 'auto', status: 'suggested' });
    const rej = await api(t).patch(`/api/library/topic-links/${sugg.id}`, { status: 'rejected' });
    expect(rej.json().link.status).toBe('rejected');
    // a later automatic run does NOT resurrect the rejected suggestion
    expect(suggestTopicLink(t.ctx, topic.id, 'library_node', node.id)).toBeNull();
    let links = (await api(t).get(`/api/library/topic-links?entity_type=library_node&entity_id=${node.id}`)).json().links as TopicLinkView[];
    expect(links).toHaveLength(1);
    expect(links[0]!.status).toBe('rejected');
    // the owner links it explicitly → accepted, origin owner
    const own = (await api(t).post(`/api/library/topics/${topic.id}/links`, { entity_type: 'library_node', entity_id: node.id })).json().link;
    expect(own).toMatchObject({ origin: 'owner', status: 'accepted' });
    // removing an AUTO link marks it rejected instead of deleting it (no re-suggestion)
    const topic2 = (await api(t).post('/api/library/topics', { title: 'Shock' })).json().topic;
    const s2 = suggestTopicLink(t.ctx, topic2.id, 'library_node', node.id)!;
    await api(t).del(`/api/library/topic-links/${s2.id}`);
    expect(suggestTopicLink(t.ctx, topic2.id, 'library_node', node.id)).toBeNull();
    links = (await api(t).get(`/api/library/topic-links?topic_id=${topic2.id}`)).json().links;
    expect(links[0]!.status).toBe('rejected');
    // cycles in topic parents are refused
    const child = (await api(t).post('/api/library/topics', { title: 'Child', parent_topic_id: topic.id })).json().topic;
    expect((await api(t).patch(`/api/library/topics/${topic.id}`, { parent_topic_id: child.id })).statusCode).toBe(400);
  });

  it('templates: static list; from-template creates an editable skeleton', async () => {
    const list = (await api(t).get('/api/library/templates')).json() as TemplatesResponse;
    const keys = list.templates.map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['anatomy', 'physiology', 'pathology', 'pharmacology', 'internal_medicine', 'surgery', 'pediatrics', 'obgyn', 'radiology']));
    for (const tpl of list.templates) {
      expect(tpl.explanation_template).toBeTruthy();
      expect(tpl.skeleton.length).toBeGreaterThan(0);
    }
    const res = await api(t).post('/api/library/nodes/from-template', { template_key: 'surgery', parent_id: null });
    expect(res.statusCode).toBe(200);
    const { node, created } = res.json();
    expect(node).toMatchObject({ kind: 'subject', title: 'الجراحة', template: 'surgery' });
    const tpl = list.templates.find((x) => x.key === 'surgery')!;
    expect(created).toBe(1 + tpl.skeleton.length);
    const children = (await tree()).nodes.filter((n) => n.parent_id === node.id);
    expect(children.map((c) => c.title)).toEqual(tpl.skeleton.map((s) => s.title));
    // owner edits freely afterwards
    expect((await api(t).patch(`/api/library/nodes/${children[0]!.id}`, { title: 'Lectures' })).statusCode).toBe(200);
    expect((await api(t).post(`/api/library/nodes/${children[1]!.id}/trash`)).statusCode).toBe(200);
    expect((await api(t).post('/api/library/nodes/from-template', { template_key: 'astrology', parent_id: null })).statusCode).toBe(404);
  });

  it('recent (by last opened) and favorites', async () => {
    const node = await createNode(t, { title: 'N', is_favorite: true });
    const up = await uploadOk(t, node.id, [
      { name: 'flowchart.png', data: golden('flowchart.png') },
      { name: 'scanned_page.png', data: golden('scanned_page.png') },
    ]);
    const [a, b] = up.results.map((r) => r.source_id!);
    expect((await api(t).get('/api/library/recent')).json().sources).toEqual([]);
    await api(t).post(`/api/sources/${a}/open`);
    t.clock.advance(1000);
    await api(t).post(`/api/sources/${b}/open`);
    expect((await api(t).get('/api/library/recent')).json().sources.map((s: { id: string }) => s.id)).toEqual([b, a]);
    await api(t).patch(`/api/sources/${a}`, { is_favorite: true });
    const fav = (await api(t).get('/api/library/favorites')).json();
    expect(fav.nodes.map((n: { id: string }) => n.id)).toEqual([node.id]);
    expect(fav.sources.map((s: { id: string }) => s.id)).toEqual([a]);
  });
});

describe('auth', () => {
  it('requires the owner session and CSRF for every library route', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/library/tree' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/library/templates' })).statusCode).toBe(401);
    const noCookie = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: CSRF, payload: { parent_id: null, kind: 'folder', title: 'x' } });
    expect(noCookie.statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: { cookie: t.h.cookie }, payload: { parent_id: null, kind: 'folder', title: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
  });
});
