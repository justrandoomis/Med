// Course Brain on the Golden Set through the REAL pipeline: upload (sources API) → processing (pdf.js / docx) →
// processing hook → extract_knowledge (no AI) — and the question bank → extraction → matching, for the coverage map,
// the knowledge map and the Student Knowledge Map. Also: re-processing keeps owner decisions, topics suggestions and
// decisions, and case / OSCE / viva signals in the Weakness Center. Fixtures are synthetic TEST FIXTURE documents.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BrainConceptListResponse,
  BrainConceptResponse,
  CourseBrainResponse,
  CoverageResponse,
  KnowledgeMapResponse,
  StudentKnowledgeResponse,
  TopicDetailResponse,
  WeaknessListResponse,
} from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { createCase, evOk, osceHistoryStation, start, vivaDefinition } from '../cases/helpers';
import { api, createNode, createQuestionsApp, golden, questionAt, uploadAndProcess, type QApp } from '../questions/helpers';

let t: QApp;
let course: string;
let lecture: { sourceId: string; versionId: string };
let chole: { sourceId: string; versionId: string };
let notes: { sourceId: string; versionId: string };
let qs: { sourceId: string; versionId: string };

async function ok<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const res = await t.app.inject({ method, url, headers: t.h, payload: payload as never });
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json() as T;
}
const conceptId = (name: string) => t.ctx.db.get<{ id: string }>('SELECT id FROM concept WHERE (name_en = ? OR name_ar = ?) AND merged_into_id IS NULL', [name, name])!.id;
const concept = (name: string) => ok<BrainConceptResponse>('GET', `/api/brain/concepts/${conceptId(name)}`);

beforeAll(async () => {
  t = await createQuestionsApp();
  course = (await createNode(t, 'Surgery Course 1 (F2)')).id;
  lecture = await uploadAndProcess(t, course, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Appendicitis (F2)');
  chole = await uploadAndProcess(t, course, 'lecture_cholecystitis.pdf', golden('lecture_cholecystitis.pdf'), 'lecture', 'Cholecystitis (F2)');
  notes = await uploadAndProcess(t, course, 'lecture_notes_shock.docx', golden('lecture_notes_shock.docx'), 'lecture', 'Shock notes (F2)');
  qs = await uploadAndProcess(t, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Surgery bank (F2)');
  await t.ctx.jobs.drain();
}, 300_000);

afterAll(async () => {
  await t?.close();
});

describe('extraction on the Golden Set (definitions / sections → concepts with their regions)', () => {
  it('the processing hook ran extract_knowledge for each lecture (not for the question bank); objectives kept apart', async () => {
    const cb = await ok<CourseBrainResponse>('GET', `/api/brain/courses/${course}`);
    expect(cb.lectures.map((l) => l.source_id).sort()).toEqual([lecture.sourceId, chole.sourceId, notes.sourceId].sort());
    const app = cb.lectures.find((l) => l.source_id === lecture.sourceId)!;
    expect(app.job?.status).toBe('completed');
    expect(app.extraction).toMatchObject({ status: 'completed', current: true });
    expect(app.extraction!.objectives.map((o) => o.text)).toEqual(['Describe the typical migration of pain in acute appendicitis.', 'List the investigations used when the diagnosis is uncertain.']);
    expect(app.extraction!.objectives[0]!.page_label_ar).toBe('ص 11 (الصفحة 1 في الملف)');
    expect(app.extraction!.counts.sections).toBeGreaterThanOrEqual(4);
    expect(t.ctx.db.get('SELECT 1 AS x FROM concept_extraction WHERE version_id = ?', [qs.versionId])).toBeUndefined();
  });

  it('headings, sections, statements and table rows become concepts with their role, page and exact quote', async () => {
    const appx = await concept('Acute Appendicitis');
    expect(appx.concept.name_ar).toBe('التهاب الزائدة الدودية الحاد');
    expect(appx.concept.mentions!.find((m) => m.support === 'stated' && m.role === 'heading')).toMatchObject({ page_label_ar: 'ص 11 (الصفحة 1 في الملف)', source_id: lecture.sourceId });

    const us = await concept('Ultrasound');
    const usStated = us.concept.mentions!.filter((m) => m.support === 'stated');
    expect(usStated.map((m) => m.role)).toEqual(['investigation', 'investigation']);
    expect(usStated.find((m) => m.source_id === lecture.sourceId)).toMatchObject({
      page_label_ar: 'ص 12 (الصفحة 2 في الملف)',
      quote: 'Ultrasound is the first-line imaging test in children and in pregnant women.',
      section: 'Investigations — الفحوصات',
      role_label_ar: 'فحص',
    });
    expect(us.concept.lecture_ids.sort()).toEqual([lecture.sourceId, chole.sourceId].sort());

    expect((await concept('mesenteric adenitis')).concept.roles).toEqual(['differential']);
    expect((await concept('white cell count')).concept.roles).toEqual(['value']);
    expect((await concept('Elevated temperature')).concept.mentions!.find((m) => m.support === 'stated')).toMatchObject({ role: 'value', page_label_ar: 'ص 13 (الصفحة 3 في الملف)' });
    expect((await concept("Murphy's sign")).concept.roles).toEqual(['sign']);
  });

  it('DOCX: «Shock is classified as …» and the Arabic «تُصنف الصدمة إلى …» land on the SAME concept (bilingual heading)', async () => {
    const shock = await concept('Shock');
    expect(shock.concept.name_ar).toBe('الصدمة');
    const cls = shock.concept.mentions!.filter((m) => m.role === 'classification').map((m) => m.quote);
    expect(cls).toEqual(['Shock is classified as hypovolaemic, cardiogenic, distributive or obstructive.', 'تُصنف الصدمة إلى نقص الحجم، قلبية، توزيعية، أو انسدادية.']);
    expect(shock.concept.has_definition).toBe(true);
    // DOCX has no pages: the mention says «قسم N», never an invented page number
    expect(shock.concept.mentions!.find((m) => m.role === 'classification')!.page_label_ar).toBe('قسم 2');
  });

  it('every stated mention quotes text that is really in its region (stated = literally there)', () => {
    const rows = t.ctx.db.all<{ quote: string; text: string | null; structure_json: string | null }>(
      `SELECT m.quote, r.text, r.structure_json FROM concept_mention m JOIN source_region r ON r.id = m.region_id WHERE m.support = 'stated' AND m.version_id IN (?, ?, ?)`,
      [lecture.versionId, chole.versionId, notes.versionId],
    );
    expect(rows.length).toBeGreaterThan(20);
    const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
    for (const r of rows) expect(flat(`${r.text ?? ''} ${r.structure_json ?? ''}`)).toContain(flat(r.quote));
  });

  it('question matching is unchanged by the Course Brain (it reads only its own candidate mentions)', async () => {
    const res = (await api(t).get(`/api/questions/for-lecture/${lecture.sourceId}`)).json() as { items: Array<{ link: { relation: string }; stem_preview: string }> };
    const covered = res.items.filter((i) => i.link.relation === 'directly_covered').map((i) => i.stem_preview);
    expect(covered.some((s) => s.includes('NOT typically part of the Alvarado score'))).toBe(true);
  });
});

describe('re-processing and re-extraction keep the owner decisions', () => {
  it('reprocessing a page replaces its regions (stated mentions do not block it); the rejected / renamed concepts stay', async () => {
    const rebound = conceptId('Rebound tenderness');
    const ct = conceptId('CT abdomen');
    await ok('PATCH', `/api/brain/concepts/${rebound}`, { status: 'rejected' });
    await ok('PATCH', `/api/brain/concepts/${ct}`, { name_en: 'CT of the abdomen' });
    const re = await api(t).post(`/api/sources/versions/${lecture.versionId}/reprocess`, { page_indexes: [1, 2] });
    expect(re.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    expect(t.ctx.db.get<{ status: string }>('SELECT status FROM concept WHERE id = ?', [rebound])!.status).toBe('rejected');
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM concept WHERE name_en = 'CT abdomen'")!.n).toBe(0);
    const ctv = await ok<BrainConceptResponse>('GET', `/api/brain/concepts/${ct}`);
    expect(ctv.concept.name_en).toBe('CT of the abdomen');
    // the re-extracted mention on the new region of page 12 points at the owner's concept
    expect(ctv.concept.mentions!.find((m) => m.support === 'stated')).toMatchObject({ page_label_ar: 'ص 12 (الصفحة 2 في الملف)', quote: 'CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.' });
    const list = await ok<BrainConceptListResponse>('GET', `/api/brain/concepts?source_id=${lecture.sourceId}`);
    expect(list.items.map((c) => c.id)).not.toContain(rebound);
  });
});

describe('Question Coverage Map (§36): source vs generated, attempted, uncovered — with denominators', () => {
  const pageId = (i: number) => t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = ?', [lecture.versionId, i])!.id;

  it('pages and concepts with source questions, nothing generated yet, nothing attempted yet', async () => {
    const cov = await ok<CoverageResponse>('GET', `/api/brain/coverage?source_id=${lecture.sourceId}`);
    const l = cov.lectures[0]!;
    expect(l.totals.pages.total).toBe(4);
    expect(l.pages.map((p) => p.label_ar)).toEqual(['ص 11 (الصفحة 1 في الملف)', 'ص 12 (الصفحة 2 في الملف)', 'ص 13 (الصفحة 3 في الملف)', 'ص 14 (الصفحة 4 في الملف)']);
    const a2 = questionAt(t, qs.sourceId, 'A', '2');
    const a3 = questionAt(t, qs.sourceId, 'A', '3');
    expect(l.pages.find((p) => p.page_index === 2)!.source_question_ids).toContain(a2);
    expect(l.pages.find((p) => p.page_index === 1)!.source_question_ids).toContain(a3);
    expect(l.totals.pages.with_generated_questions).toBe(0);
    expect(l.totals.pages.attempted).toBe(0);
    // identities: uncovered = pages with neither kind; every count ≤ its denominator
    expect(l.totals.pages.uncovered).toBe(l.pages.filter((p) => p.source_question_ids.length + p.generated_question_ids.length === 0).length);
    expect(l.totals.pages.with_source_questions).toBe(l.pages.filter((p) => p.status === 'source').length);
    const alv = l.concepts.find((c) => c.name === 'Alvarado score')!;
    expect(alv.source_question_ids).toContain(a2);
    expect(alv.status).toBe('source');
    expect(alv.basis_ar).toContain('الأساس');
    expect(l.totals.concepts.total).toBe(l.concepts.length);
    expect(cov.notes_ar.join(' ')).toContain('منفصلة');
  });

  it('a published GENERATED question counts separately from the source questions; attempts mark pages and concepts as attempted', async () => {
    const now = t.ctx.clock.now();
    const qid = newId(now);
    const vid = newId(now);
    const runId = newId(now);
    t.ctx.db.tx(() => {
      t.ctx.db.run(`INSERT INTO question (id, origin_type, status, course_node_id, created_at, updated_at) VALUES (?, 'generated', 'ready', ?, ?, ?)`, [qid, course, now, now]);
      t.ctx.db.run(
        `INSERT INTO question_version (id, question_id, version_no, kind, qtype, stem_json, stem_raw, extraction_status, answer_status, created_by, created_at)
         VALUES (?, ?, 1, 'generated', 'sba', ?, ?, 'not_applicable', 'ai_derived', 'generation', ?)`,
        [vid, qid, JSON.stringify({ v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: 'TEST generated question about the management pathway' }] }] }), 'TEST generated question about the management pathway', now],
      );
      t.ctx.db.run('UPDATE question SET current_version_id = ? WHERE id = ?', [vid, qid]);
      t.ctx.db.run(`INSERT INTO question_generation_run (id, lecture_source_id, request_json, scope_json, status, created_at, updated_at) VALUES (?, ?, '{}', '{}', 'completed', ?, ?)`, [runId, lecture.sourceId, now, now]);
      t.ctx.db.run(
        `INSERT INTO generated_question_candidate (id, run_id, ord, status, candidate_json, evidence_json, question_id, question_version_id, created_at, updated_at)
         VALUES (?, ?, 1, 'published', '{}', ?, ?, ?, ?, ?)`,
        [newId(now), runId, JSON.stringify({ lecture_page_ids: [pageId(3)], region_ids: [] }), qid, vid, now, now],
      );
    });
    const a2 = questionAt(t, qs.sourceId, 'A', '2');
    const a2v = t.ctx.db.get<{ v: string }>('SELECT current_version_id AS v FROM question WHERE id = ?', [a2])!.v;
    t.ctx.db.run(
      `INSERT INTO question_attempt (id, question_id, question_version_id, is_correct, scored, confidence, answered_at, created_at) VALUES (?, ?, ?, 1, 1, 'confident', ?, ?)`,
      [newId(now), a2, a2v, now, now],
    );
    const l = (await ok<CoverageResponse>('GET', `/api/brain/coverage?source_id=${lecture.sourceId}`)).lectures[0]!;
    const p14 = l.pages.find((p) => p.page_index === 3)!;
    expect(p14.generated_question_ids).toEqual([qid]);
    // a generated question never turns a page into «covered by the source»: the source side is counted on its own
    expect(p14.source_question_ids).not.toContain(qid);
    expect(p14.status).toBe(p14.source_question_ids.length ? 'source' : 'generated_only');
    expect(l.totals.pages.with_generated_questions).toBe(1);
    expect(l.totals.questions.generated).toBe(1);
    expect(l.pages.find((p) => p.page_index === 2)!.attempted_question_ids).toContain(a2);
    expect(l.totals.pages.attempted).toBeGreaterThanOrEqual(1);
    expect(l.concepts.find((c) => c.name === 'Alvarado score')!.attempted_question_ids).toEqual([a2]);
    expect(l.totals.questions.attempted_source).toBe(1);
    // course scope = the sum of its lectures, with the same denominators
    const cov = await ok<CoverageResponse>('GET', `/api/brain/coverage?course_node_id=${course}`);
    expect(cov.totals.pages.total).toBe(cov.lectures.reduce((s, x) => s + x.totals.pages.total, 0));
    expect(cov.scope).toMatchObject({ kind: 'course', id: course });
    expect((await api(t).get('/api/brain/coverage')).statusCode).toBe(400);
  });
});

describe('knowledge map (lectures ↔ concepts ↔ questions)', () => {
  it('every edge joins two nodes; mention edges carry pages, question edges their basis; totals say what was cut', async () => {
    const map = await ok<KnowledgeMapResponse>('GET', `/api/brain/map?course_node_id=${course}`);
    const ids = new Set(map.nodes.map((n) => n.id));
    for (const e of map.edges) {
      expect(ids.has(e.from), e.id).toBe(true);
      expect(ids.has(e.to), e.id).toBe(true);
    }
    expect(map.nodes.filter((n) => n.type === 'lecture')).toHaveLength(3);
    const alv = map.nodes.find((n) => n.type === 'concept' && n.label === 'Alvarado score')!;
    const a2 = questionAt(t, qs.sourceId, 'A', '2');
    expect(map.edges.find((e) => e.from === `question:${a2}` && e.to === alv.id)).toMatchObject({ kind: 'covers', support: 'matched' });
    const m = map.edges.find((e) => e.kind === 'mentions' && e.from === `lecture:${lecture.sourceId}` && e.to === alv.id)!;
    expect(m.pages.map((p) => p.label_ar)).toEqual(expect.arrayContaining(['ص 13 (الصفحة 3 في الملف)']));
    expect(map.truncated.concepts.total).toBeGreaterThanOrEqual(map.truncated.concepts.shown);
    // the generated question is a separate kind of node
    expect(map.nodes.some((n) => n.type === 'question' && n.status === 'generated' && n.sublabel?.includes('مولَّد'))).toBe(true);
    // the rejected concept is not on the map
    expect(map.nodes.some((n) => n.label === 'Rebound tenderness')).toBe(false);
    // one lecture only
    const one = await ok<KnowledgeMapResponse>('GET', `/api/brain/map?course_node_id=${course}&source_id=${chole.sourceId}`);
    expect(one.nodes.filter((n) => n.type === 'lecture').map((n) => n.id)).toEqual([`lecture:${chole.sourceId}`]);
  });
});

describe('Student Knowledge Map (§44): states with reasons, mastery only as an estimate', () => {
  const state = async (name: string) => (await ok<StudentKnowledgeResponse>('GET', `/api/brain/knowledge?course_node_id=${course}`)).items.find((i) => i.name === name)!;

  it('not started → read (reader progress) → practicing (below the sample) → strong estimate', async () => {
    let mi = await state('mesenteric adenitis');
    expect(mi).toMatchObject({ state: 'not_started', mastery_estimate: null });
    expect(mi.next_step_ar).toContain('ص 12');
    await ok('POST', '/api/annotations/progress', { source_id: lecture.sourceId, version_id: lecture.versionId, page_indexes: [1] });
    mi = await state('mesenteric adenitis');
    expect(mi).toMatchObject({ state: 'read', state_label_ar: 'قرأت مواضعه', reading: { pages_total: 1, pages_viewed: 1 } });

    // Alvarado score: one confident correct attempt (from the coverage test) → practicing, no estimate yet
    let alv = await state('Alvarado score');
    expect(alv.state).toBe('practicing');
    expect(alv.mastery_estimate).toBeNull();
    expect(alv.mastery_basis_ar).toContain('لا يُقدَّر');
    const a2 = questionAt(t, qs.sourceId, 'A', '2');
    const a2v = t.ctx.db.get<{ v: string }>('SELECT current_version_id AS v FROM question WHERE id = ?', [a2])!.v;
    for (let i = 0; i < 2; i++) {
      const now = t.ctx.clock.now() + i + 1;
      t.ctx.db.run(`INSERT INTO question_attempt (id, question_id, question_version_id, is_correct, scored, confidence, answered_at, created_at) VALUES (?, ?, ?, 1, 1, 'confident', ?, ?)`, [newId(now), a2, a2v, now, now]);
    }
    alv = await state('Alvarado score');
    expect(alv).toMatchObject({ state: 'strong', mastery_estimate: 1, mastery_sample: 3, state_label_ar: 'إتقان تقديري جيد' });
    expect(alv.next_step_ar).toContain('لا يعني');
  });

  it('wrong scored answers → «needs work» with the reason; guessed correct answers weigh less', async () => {
    const a4 = questionAt(t, qs.sourceId, 'A', '4');
    const v = t.ctx.db.get<{ v: string }>('SELECT current_version_id AS v FROM question WHERE id = ?', [a4])!.v;
    for (let i = 0; i < 3; i++) {
      const now = t.ctx.clock.now() + 10 + i;
      t.ctx.db.run(`INSERT INTO question_attempt (id, question_id, question_version_id, is_correct, scored, confidence, answered_at, created_at) VALUES (?, ?, ?, ?, 1, 'guess', ?, ?)`, [newId(now), a4, v, i === 0 ? 1 : 0, now, now]);
    }
    const wcc = await state('white cell count');
    expect(wcc.state).toBe('needs_work');
    expect(wcc.mastery_estimate).toBe(0);
    expect(wcc.reasons_ar.join(' ')).toContain('محسوبة');
    const res = await ok<StudentKnowledgeResponse>('GET', `/api/brain/knowledge?course_node_id=${course}`);
    expect(res.estimate_note_ar).toContain('تقدير');
    expect(res.counts.strong + res.counts.needs_work + res.counts.read + res.counts.not_started + res.counts.practicing + res.counts.developing).toBe(res.items.length);
  });
});

describe('topics (§05): suggestions, owner decisions, validated links', () => {
  it('a topic named like a concept gets suggested links (concept, source, region, question); decisions persist', async () => {
    const topic = (await api(t).post('/api/library/topics', { title: 'Alvarado score', title_ar: 'مقياس ألفارادو' })).json().topic as { id: string };
    const s1 = await ok<{ created: number; kept: number }>('POST', '/api/brain/topics/suggest', { topic_id: topic.id });
    expect(s1.created).toBeGreaterThanOrEqual(3);
    let d = await ok<TopicDetailResponse>('GET', `/api/brain/topics/${topic.id}`);
    const a2 = questionAt(t, qs.sourceId, 'A', '2');
    const q = d.links.find((l) => l.entity_type === 'question' && l.entity_id === a2)!;
    expect(q).toMatchObject({ origin: 'auto', status: 'suggested', reason_ar: 'اسم الموضوع مذكور في نص السؤال.', href: `/questions/${a2}` });
    const src = d.links.find((l) => l.entity_type === 'source' && l.entity_id === lecture.sourceId)!;
    expect(src).toMatchObject({ label: 'Appendicitis (F2)', status: 'suggested' });
    expect(d.links.some((l) => l.entity_type === 'source_region' && l.sublabel?.includes('ص 13'))).toBe(true);

    await ok('PATCH', `/api/library/topic-links/${q.id}`, { status: 'rejected' });
    await ok('PATCH', `/api/library/topic-links/${src.id}`, { status: 'accepted' });
    const s2 = await ok<{ created: number; kept: number }>('POST', '/api/brain/topics/suggest', { topic_id: topic.id });
    expect(s2.created).toBe(0);
    d = await ok<TopicDetailResponse>('GET', `/api/brain/topics/${topic.id}`);
    expect(d.links.find((l) => l.id === q.id)!.status).toBe('rejected');
    expect(d.links.find((l) => l.id === src.id)!.status).toBe('accepted');
    expect(d.counts.rejected).toBe(1);

    // owner links: validated entity type and existence
    const region = t.ctx.db.get<{ id: string }>(`SELECT id FROM source_region WHERE version_id = ? AND kind = 'caption'`, [lecture.versionId])!.id;
    expect((await api(t).post(`/api/library/topics/${topic.id}/links`, { entity_type: 'source_region', entity_id: region })).statusCode).toBe(200);
    expect((await api(t).post(`/api/library/topics/${topic.id}/links`, { entity_type: 'spaceship', entity_id: region })).statusCode).toBe(400);
    expect((await api(t).post(`/api/library/topics/${topic.id}/links`, { entity_type: 'source', entity_id: 'NOPE' })).statusCode).toBe(404);
    const list = await ok<{ topics: Array<{ id: string; counts: { sources: number; questions: number } }> }>('GET', '/api/brain/topics');
    expect(list.topics.find((x) => x.id === topic.id)!.counts.sources).toBe(1);
  });
});

describe('Weakness Center reads case / OSCE / viva signals with their own type', () => {
  it('a finished OSCE station and viva show up as their own signals and a «case» weakness with a retry action', async () => {
    const osce = await createCase(t, t.h, osceHistoryStation());
    let run = await start(t, t.h, osce.id);
    run = await evOk(t, t.h, run.attempt.id, { type: 'utterance', text: 'متى بدأ الألم؟' });
    await evOk(t, t.h, run.attempt.id, { type: 'finish' });
    const viva = await createCase(t, t.h, vivaDefinition());
    let vr = await start(t, t.h, viva.id);
    vr = await evOk(t, t.h, vr.attempt.id, { type: 'viva_answer', question_id: 'q1', text: 'WBC' });
    await evOk(t, t.h, vr.attempt.id, { type: 'finish' });

    const w = await ok<WeaknessListResponse>('GET', '/api/learning/weakness?status=all');
    expect(w.sources_note_ar.join(' ')).toContain('OSCE');
    const ow = w.items.find((i) => i.kind === 'case' && i.label.includes('OSCE'))!;
    expect(ow).toBeDefined();
    const osceSignals = ow.signal_views.filter((s) => s.type === 'osce');
    expect(osceSignals).toHaveLength(3);
    expect(osceSignals.filter((s) => s.correct === false).map((s) => s.label)).toEqual(expect.arrayContaining([expect.stringContaining('Asked about fever')]));
    expect(osceSignals.find((s) => s.correct === false)!.category_label_ar).toContain('تقدير من قائمة التقييم');
    expect(ow.suggested_actions.find((a) => a.kind === 'retry_case')!.ref).toEqual({ case_id: osce.id });
    expect(ow.reasons_ar.join(' ')).toContain('لم');
    const vw = w.items.find((i) => i.kind === 'case' && i.label.includes('امتحان شفهي'))!;
    expect(vw.signal_views.every((s) => s.type === 'viva')).toBe(true);

    // the owner can exclude a case signal (the attempt itself is untouched)
    const ref = osceSignals.find((s) => s.correct === false)!.ref;
    const patched = await ok<{ counts: { excluded: number } }>('PATCH', `/api/learning/weakness/${ow.id}`, { excluded_refs: [ref] });
    expect(patched.counts.excluded).toBe(1);
    // the published shared signals carry the viva type too
    const sig = (await api(t).get('/api/cases/signals')).json() as { signals: Array<{ type: string }> };
    expect(new Set(sig.signals.map((s) => s.type))).toEqual(new Set(['osce', 'viva']));
  });
});
