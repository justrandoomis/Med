// Round 7 H4 items 2, 3, 4 through the API: relations stated in prose become suggested relations with support 'stated'
// and the exact sentence (owner decisions kept across re-extraction, OCR sentences marked uncertain, purge removes
// them); algorithms / flowcharts listed per lecture, concept and course with links to their regions; the course's
// suggested relations recomputed by a BACKGROUND job (the course page never recomputes inside the request, and says
// «refreshing» until the job ran), incrementally (an incremental recompute equals a cold one).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECOMPUTE_RELATIONS_JOB_KIND, type BrainConceptResponse, type ConceptRelationListResponse, type ConceptRelationView, type CourseBrainResponse, type KnowledgeAlgorithmListResponse } from '@medlevo/shared';
import { clearRecomputeCaches, recomputeInferredRelations } from '../../src/modules/brain/relations';
import { brainApp, call, conceptByName, createCourse, extract, insertLecture, type BApp } from './helpers';

let t: BApp;
beforeAll(async () => {
  t = await brainApp();
});
afterAll(async () => t.close());

const relations = async (course: string) => (await call(t).ok<ConceptRelationListResponse>('GET', `/api/brain/relations?course_node_id=${course}`)).items;
const find = (items: ConceptRelationView[], from: string, to: string, rel: string) => items.find((r) => r.from.name === from && r.to.name === to && r.relation === rel);

describe('relations stated in prose (item 3)', () => {
  let course: string;
  let lecture: ReturnType<typeof insertLecture>;
  beforeAll(async () => {
    course = (await createCourse(t, 'Prose relations (TEST)')).id;
    lecture = insertLecture(t, course, 'Pancreas (TEST)', [
      [
        { kind: 'heading', text: 'Acute pancreatitis' },
        { kind: 'paragraph', text: 'Gallstones can cause acute pancreatitis.' },
        { kind: 'paragraph', text: 'Pseudocyst is a recognised complication of acute pancreatitis.' },
        { kind: 'paragraph', text: 'Alcohol does not cause gallstones.' },
      ],
    ]);
    await extract(t, lecture.sourceId);
  });

  it('a stated relation is a suggestion with support «stated», labelled «مذكورة في النص», with the exact sentence and its place', async () => {
    const items = await relations(course);
    const r = find(items, 'Gallstones', 'Acute pancreatitis', 'causes')!;
    expect(r).toMatchObject({ support: 'stated', origin: 'auto', status: 'suggested', support_label_ar: 'مذكورة في النص', relation_label_ar: 'يسبب' });
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatchObject({ kind: 'stated_in_text', pattern: 'en.x_causes_y' });
    expect(r.reasons[0]!.from).toMatchObject({ source_id: lecture.sourceId, region_id: lecture.regionIds[0]![1], quote: 'Gallstones can cause acute pancreatitis.' });
    expect(r.reasons[0]!.text_ar).toContain('مذكورة نصًا');
    expect(find(items, 'Pseudocyst', 'Acute pancreatitis', 'complication_of')).toMatchObject({ support: 'stated', relation_label_ar: 'مضاعفة لـ' });
    // the negated sentence produced nothing
    expect(items.some((x) => x.from.name === 'Alcohol')).toBe(false);
    // the concept page lists it too
    const c = await call(t).ok<BrainConceptResponse>('GET', `/api/brain/concepts/${conceptByName(t, 'Gallstones')!.id}`);
    expect(c.relations!.some((x) => x.relation === 'causes' && x.support === 'stated')).toBe(true);
  });

  it('the owner rejects it → re-extraction keeps it rejected; editing the sentence away removes an undecided one', async () => {
    let items = await relations(course);
    const r = find(items, 'Gallstones', 'Acute pancreatitis', 'causes')!;
    expect((await call(t).patch(`/api/brain/relations/${r.id}`, { status: 'rejected' })).statusCode).toBe(200);
    await extract(t, lecture.sourceId);
    items = await relations(course);
    expect(find(items, 'Gallstones', 'Acute pancreatitis', 'causes')!.status).toBe('rejected');
    // the complication sentence disappears from the lecture (a re-processed page): the undecided suggestion goes
    t.ctx.db.run('UPDATE source_region SET text = ? WHERE id = ?', ['Pseudocyst TEST sentence without a relation.', lecture.regionIds[0]![2]]);
    await extract(t, lecture.sourceId);
    items = await relations(course);
    expect(find(items, 'Pseudocyst', 'Acute pancreatitis', 'complication_of')).toBeUndefined();
  });

  it('an OCR sentence gives an «uncertain» reason; a permanent purge removes the statements and the suggestions built on them', async () => {
    const c2 = (await createCourse(t, 'OCR prose (TEST)')).id;
    const l = insertLecture(t, c2, 'Shock (TEST)', [
      [
        { kind: 'heading', text: 'Hypovolaemic shock' },
        { kind: 'paragraph', text: 'Hypovolaemic shock results from haemorrhage.' },
      ],
    ]);
    t.ctx.db.run(`UPDATE source_region SET text_origin = 'ocr' WHERE id = ?`, [l.regionIds[0]![1]]);
    await extract(t, l.sourceId);
    const r = find(await relations(c2), 'haemorrhage', 'Hypovolaemic shock', 'causes')!;
    expect(r.reasons[0]).toMatchObject({ kind: 'stated_in_text', uncertain: true });
    expect(r.reasons[0]!.text_ar).toContain('OCR');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM concept_relation_statement WHERE version_id = ?', [l.versionId])!.n).toBe(1);
    expect((await call(t).post(`/api/sources/${l.sourceId}/trash`, {})).statusCode).toBe(200);
    const impact = (await call(t).get(`/api/sources/${l.sourceId}/impact?mode=purge`)).json() as { confirm_token: string };
    expect((await call(t).del(`/api/sources/${l.sourceId}?confirm_token=${encodeURIComponent(impact.confirm_token)}`)).statusCode).toBe(200);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM concept_relation_statement WHERE version_id = ?', [l.versionId])!.n).toBe(0);
    expect(t.ctx.db.get('SELECT 1 AS x FROM concept_relation WHERE id = ?', [r.id])).toBeUndefined();
  });
});

describe('algorithms / flowcharts (item 2)', () => {
  it('listed per lecture, per concept and per course — exact steps with links to their regions, certainty in words', async () => {
    const course = (await createCourse(t, 'Algorithms (TEST)')).id;
    const l = insertLecture(t, course, 'Appendix (TEST)', [
      [
        { kind: 'heading', text: 'Acute appendicitis' },
        { kind: 'paragraph', text: 'Acute appendicitis is defined as a TEST inflammation of the appendix.' },
        { kind: 'heading', text: 'Management of acute appendicitis' },
        { kind: 'list_item', text: '1. Resuscitate with IV fluids' },
        { kind: 'list_item', text: '2. Give analgesia and antibiotics' },
        { kind: 'list_item', text: '3. Arrange appendicectomy' },
      ],
      [
        { kind: 'heading', text: 'Imaging decisions' },
        { kind: 'paragraph', text: 'If the patient is pregnant, request ultrasound. If the diagnosis remains uncertain then request CT abdomen.' },
      ],
    ]);
    t.ctx.db.run(`UPDATE source_region SET text_origin = 'ocr' WHERE id = ?`, [l.regionIds[1]![1]]);
    await extract(t, l.sourceId);
    const bySource = await call(t).ok<KnowledgeAlgorithmListResponse>('GET', `/api/brain/algorithms?source_id=${l.sourceId}`);
    expect(bySource.items.map((a) => a.kind)).toEqual(['numbered_steps', 'conditional']);
    const steps = bySource.items[0]!;
    expect(steps).toMatchObject({ certainty: 'stated', ordered: true, title: 'Management of acute appendicitis', kind_label_ar: 'خطوات مرقّمة' });
    expect(steps.concept?.name).toBe('Acute appendicitis');
    expect(steps.nodes.map((n) => n.text)).toEqual(['Resuscitate with IV fluids', 'Give analgesia and antibiotics', 'Arrange appendicectomy']);
    expect(steps.nodes[0]!.href).toBe(`/study/${l.sourceId}?v=${l.versionId}&page_id=${l.pageIds[0]}&region=${l.regionIds[0]![3]}`);
    expect(steps.location?.page_label_ar).toBeTruthy();
    const rules = bySource.items[1]!;
    expect(rules).toMatchObject({ certainty: 'uncertain', certainty_label_ar: expect.stringContaining('OCR') });
    expect(rules.notes_ar.join(' ')).toContain('لا تُضاف فروع');
    expect(bySource.notes_ar.join(' ')).toContain('دون ذكاء اصطناعي');
    // per concept (the heading's concept) and per course
    const byConcept = await call(t).ok<KnowledgeAlgorithmListResponse>('GET', `/api/brain/algorithms?concept_id=${conceptByName(t, 'Acute appendicitis')!.id}`);
    expect(byConcept.items.map((a) => a.id)).toContain(steps.id);
    const byCourse = await call(t).ok<KnowledgeAlgorithmListResponse>('GET', `/api/brain/algorithms?course_node_id=${course}`);
    expect(byCourse.items).toHaveLength(2);
    // a re-processed page: the node's region is gone → no link, a note says so (until the next extraction)
    t.ctx.db.run('UPDATE concept_mention SET region_id = region_id'); // no-op keeps FKs consistent
    t.ctx.db.run('DELETE FROM concept_mention WHERE region_id = ?', [l.regionIds[0]![3]]);
    t.ctx.db.run('DELETE FROM source_region WHERE id = ?', [l.regionIds[0]![3]]);
    const after = (await call(t).ok<KnowledgeAlgorithmListResponse>('GET', `/api/brain/algorithms?source_id=${l.sourceId}`)).items[0]!;
    expect(after.nodes[0]!.href).toBeNull();
    expect(after.notes_ar.join(' ')).toContain('لم تعد موجودة');
    // validation
    expect((await call(t).get('/api/brain/algorithms')).statusCode).toBe(400);
    expect((await call(t).get(`/api/brain/algorithms?source_id=${l.sourceId}&concept_id=x`)).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: `/api/brain/algorithms?source_id=${l.sourceId}` })).statusCode).toBe(401);
  });
});

describe('background, incremental relation recompute (item 4)', () => {
  it('the extraction job enqueues the recompute; the course page never recomputes in the request and says «refreshing» until it ran', async () => {
    const course = (await createCourse(t, 'Background (TEST)')).id;
    const l1 = insertLecture(t, course, 'B1 (TEST)', [[{ kind: 'heading', text: 'Sepsis' }, { kind: 'paragraph', text: 'Sepsis is defined as a TEST dysregulated response.' }]], { sortOrder: 1 });
    const l2 = insertLecture(t, course, 'B2 (TEST)', [[{ kind: 'heading', text: 'Septic shock' }, { kind: 'paragraph', text: 'Septic shock is a subset of sepsis with TEST features.' }]], { sortOrder: 2 });
    // run only the extraction jobs: enqueue, then claim extract jobs one by one
    for (const l of [l1, l2]) expect((await call(t).post('/api/brain/extract', { source_id: l.sourceId })).statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const jobs = t.ctx.db.all<{ status: string }>(`SELECT status FROM processing_job WHERE kind = ? AND json_extract(input_json, '$.course_key') = ?`, [RECOMPUTE_RELATIONS_JOB_KIND, course]);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.every((j) => j.status === 'completed')).toBe(true);
    let cb = await call(t).ok<CourseBrainResponse>('GET', `/api/brain/courses/${course}`);
    expect(cb.relations_state).toMatchObject({ status: 'current', job_id: null });
    expect(cb.relations_state!.computed_at).toBeGreaterThan(0);
    const before = await relations(course);
    expect(find(before, 'Sepsis', 'Septic shock', 'prerequisite')).toBeTruthy();
    // the course order changes: the GET enqueues a recompute and answers at once with the previous relations
    t.ctx.db.run('UPDATE source SET sort_order = 0 WHERE id = ?', [l2.sourceId]);
    cb = await call(t).ok<CourseBrainResponse>('GET', `/api/brain/courses/${course}`);
    expect(cb.relations_state?.status).toBe('refreshing');
    expect(cb.relations_state?.job_id).toBeTruthy();
    expect(find(await relations(course), 'Sepsis', 'Septic shock', 'prerequisite')).toBeTruthy(); // not recomputed in the request
    await t.ctx.jobs.drain();
    cb = await call(t).ok<CourseBrainResponse>('GET', `/api/brain/courses/${course}`);
    expect(cb.relations_state?.status).toBe('current');
    expect(find(await relations(course), 'Sepsis', 'Septic shock', 'prerequisite')).toBeUndefined();
    // the same state again → no new job
    const n = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM processing_job WHERE kind = ?', [RECOMPUTE_RELATIONS_JOB_KIND])!.n;
    await call(t).ok<CourseBrainResponse>('GET', `/api/brain/courses/${course}`);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM processing_job WHERE kind = ?', [RECOMPUTE_RELATIONS_JOB_KIND])!.n).toBe(n);
  });

  it('an incremental recompute (one lecture changed) equals a cold recompute from scratch', async () => {
    const course = (await createCourse(t, 'Incremental (TEST)')).id;
    const ls = [0, 1, 2, 3].map((i) =>
      insertLecture(
        t,
        course,
        `Inc ${i} (TEST)`,
        [
          [
            { kind: 'heading', text: `Topic${i} entity` },
            { kind: 'paragraph', text: `Term${i} is defined as a TEST item; it is used with Term${Math.max(0, i - 1)} and Topic${Math.max(0, i - 2)} entity.` },
            { kind: 'paragraph', text: `Term${i} can cause Finding${i}.` },
          ],
        ],
        { sortOrder: i },
      ),
    );
    for (const l of ls) await extract(t, l.sourceId);
    // lecture 2 changes and is re-extracted: the recompute reuses the other lectures' cached facts
    t.ctx.db.run('UPDATE source_region SET text = ? WHERE id = ?', ['Term2 is defined as a TEST item used with Term0 only.', ls[2]!.regionIds[0]![1]]);
    await extract(t, ls[2]!.sourceId);
    const snapshot = () =>
      t.ctx.db.all('SELECT from_concept_id, to_concept_id, relation, support, status, reasons_json FROM concept_relation WHERE course_node_id = ? ORDER BY from_concept_id, to_concept_id, relation', [course]);
    const incremental = snapshot();
    expect(incremental.length).toBeGreaterThan(0);
    clearRecomputeCaches(t.ctx);
    recomputeInferredRelations(t.ctx, course);
    expect(snapshot()).toEqual(incremental);
  });
});
