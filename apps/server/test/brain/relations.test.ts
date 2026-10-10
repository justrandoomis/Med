// Course Brain — inferred relations (defined earlier → used later; listed under «Differential diagnosis»), owner
// decisions on concepts and relations that survive re-extraction, Source Lock never widened, auth / validation.
// Synthetic TEST lectures (rows), no AI.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrainConceptListResponse, BrainConceptResponse, ConceptRelationListResponse, ConceptRelationView, CourseBrainResponse } from '@medlevo/shared';
import { brainApp, call, conceptByName, createCourse, extract, insertLecture, type BApp, type InsertedLecture } from './helpers';

let t: BApp;
let course: string;
let l1: InsertedLecture;
let l2: InsertedLecture;

beforeAll(async () => {
  t = await brainApp();
  course = (await createCourse(t, 'Brain course A')).id;
  l1 = insertLecture(t, course, 'Lecture 1 — Sepsis (TEST)', [
    [
      { kind: 'heading', text: 'Sepsis — الإنتان' },
      { kind: 'paragraph', text: 'Sepsis is defined as organ dysfunction caused by a dysregulated response to infection.' },
    ],
  ], { sortOrder: 1 });
  l2 = insertLecture(t, course, 'Lecture 2 — Septic shock (TEST)', [
    [
      { kind: 'heading', text: 'Septic Shock' },
      { kind: 'paragraph', text: 'Septic shock is a subset of sepsis with circulatory failure.' },
    ],
    [
      { kind: 'heading', text: 'Differential diagnosis' },
      { kind: 'paragraph', text: 'The differential diagnosis includes cardiogenic shock and hypovolaemic shock.' },
    ],
  ], { sortOrder: 2 });
  await extract(t, l1.sourceId);
  await extract(t, l2.sourceId);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const relations = async () => (await call(t).ok<ConceptRelationListResponse>('GET', `/api/brain/relations?course_node_id=${course}`)).items;
const find = (items: ConceptRelationView[], from: string, to: string, rel: string) => items.find((r) => r.from.name === from && r.to.name === to && r.relation === rel);

describe('inferred relations (labelled, with reasons, never lecture text)', () => {
  it('a concept defined in an earlier lecture and used in a later one is a suggested prerequisite of the later lecture', async () => {
    const items = await relations();
    const pre = find(items, 'الإنتان', 'Septic Shock', 'prerequisite');
    expect(pre).toBeDefined();
    expect(pre).toMatchObject({ support: 'inferred', origin: 'auto', status: 'suggested', support_label_ar: 'مستنتجة — ليست نصًا من المحاضرة' });
    const reason = pre!.reasons[0]!;
    expect(reason.kind).toBe('defined_earlier_used_later');
    expect(reason.from).toMatchObject({ source_id: l1.sourceId, region_id: l1.regionIds[0]![1], page_label_ar: 'ص 1' });
    expect(reason.from!.quote).toBe('Sepsis is defined as organ dysfunction caused by a dysregulated response to infection.');
    expect(reason.to).toMatchObject({ source_id: l2.sourceId, region_id: l2.regionIds[0]![1] });
    expect(reason.text_ar).toContain('Lecture 1 — Sepsis (TEST)');
  });

  it('items listed under «Differential diagnosis» are suggested differential_of the lecture topic (inferred)', async () => {
    const items = await relations();
    for (const x of ['cardiogenic shock', 'hypovolaemic shock']) {
      const r = find(items, x, 'Septic Shock', 'differential_of');
      expect(r, x).toMatchObject({ support: 'inferred', status: 'suggested' });
      expect(r!.reasons[0]!.kind).toBe('listed_under_section');
      expect(r!.reasons[0]!.text_ar).toContain('استنتاج');
    }
  });

  it('the bilingual heading gives one concept with both names; the stated mentions keep region, page and exact quote', async () => {
    const sepsis = conceptByName(t, 'Sepsis')!;
    expect(sepsis.name_ar).toBe('الإنتان');
    const d = await call(t).ok<BrainConceptResponse>('GET', `/api/brain/concepts/${sepsis.id}`);
    expect(d.concept.roles.sort()).toEqual(['definition', 'heading']);
    expect(d.concept.has_definition).toBe(true);
    const def = d.concept.mentions!.find((m) => m.role === 'definition')!;
    expect(def).toMatchObject({ support: 'stated', region_id: l1.regionIds[0]![1], page_label_ar: 'ص 1', role_label_ar: 'تعريف', source_id: l1.sourceId });
    // relations of the concept come with it
    expect(d.relations!.some((r) => r.relation === 'prerequisite' && r.from.id === sepsis.id)).toBe(true);
  });

  it('the Student Knowledge Map shows the suggested prerequisite with its own state and the inferred label', async () => {
    const res = (await call(t).ok<import('@medlevo/shared').StudentKnowledgeResponse>('GET', `/api/brain/knowledge?course_node_id=${course}`)).items;
    const septic = res.find((i) => i.name === 'Septic Shock')!;
    expect(septic.prerequisites).toEqual([expect.objectContaining({ name: 'الإنتان', support: 'inferred', relation_status: 'suggested', state: 'not_started' })]);
    expect(septic.reasons_ar.join(' ')).toContain('علاقة مستنتجة');
  });

  it('Source Lock is never widened by a relation: Lecture Only on lecture 2 resolves to lecture 2 alone', async () => {
    const res = await call(t).post('/api/evidence/scope/resolve', { mode: 'lecture_only', lecture_source_id: l2.sourceId });
    expect(res.statusCode).toBe(200);
    expect(res.json().scope.versionIds).toEqual([l2.versionId]);
  });
});

describe('owner decisions persist across re-extraction', () => {
  it('relations: rejected stays rejected, accepted stays accepted, owner relations stay; nothing is duplicated', async () => {
    let items = await relations();
    const pre = find(items, 'الإنتان', 'Septic Shock', 'prerequisite')!;
    const dd = find(items, 'cardiogenic shock', 'Septic Shock', 'differential_of')!;
    expect((await call(t).patch(`/api/brain/relations/${pre.id}`, { status: 'rejected' })).statusCode).toBe(200);
    expect((await call(t).patch(`/api/brain/relations/${dd.id}`, { status: 'accepted' })).statusCode).toBe(200);
    const own = await call(t).ok<{ relation: ConceptRelationView }>('POST', '/api/brain/relations', {
      from_concept_id: conceptByName(t, 'hypovolaemic shock')!.id,
      to_concept_id: conceptByName(t, 'cardiogenic shock')!.id,
      relation: 'related',
      note: 'TEST owner relation',
    });
    expect(own.relation).toMatchObject({ origin: 'owner', status: 'accepted', support_label_ar: 'أضفتها بنفسك — ليست نصًا من المحاضرة' });

    const before = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM concept_relation')!.n;
    await extract(t, l1.sourceId);
    await extract(t, l2.sourceId);
    items = await relations();
    expect(find(items, 'الإنتان', 'Septic Shock', 'prerequisite')!.status).toBe('rejected');
    expect(find(items, 'cardiogenic shock', 'Septic Shock', 'differential_of')!.status).toBe('accepted');
    expect(items.find((r) => r.id === own.relation.id)).toMatchObject({ origin: 'owner', note: 'TEST owner relation' });
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM concept_relation')!.n).toBe(before);

    // deleting a suggestion = rejecting it (never suggested again); deleting the owner's relation removes it
    const hypo = find(items, 'hypovolaemic shock', 'Septic Shock', 'differential_of')!;
    expect((await call(t).del(`/api/brain/relations/${hypo.id}`)).statusCode).toBe(200);
    expect((await call(t).del(`/api/brain/relations/${own.relation.id}`)).statusCode).toBe(200);
    await extract(t, l2.sourceId);
    items = await relations();
    expect(find(items, 'hypovolaemic shock', 'Septic Shock', 'differential_of')!.status).toBe('rejected');
    expect(items.find((r) => r.id === own.relation.id)).toBeUndefined();
  });

  it('concepts: reject, rename (old name becomes an alias) and merge survive re-extraction — no concept is recreated', async () => {
    const cardio = conceptByName(t, 'cardiogenic shock')!;
    const hypo = conceptByName(t, 'hypovolaemic shock')!;
    const septic = conceptByName(t, 'Septic Shock')!;
    expect((await call(t).patch(`/api/brain/concepts/${cardio.id}`, { status: 'rejected' })).statusCode).toBe(200);
    const renamed = await call(t).ok<BrainConceptResponse>('PATCH', `/api/brain/concepts/${septic.id}`, { name_en: 'Septic shock (owner name)', name_ar: 'الصدمة الإنتانية' });
    expect(renamed.concept).toMatchObject({ name_en: 'Septic shock (owner name)', name_ar: 'الصدمة الإنتانية', name_origin: 'owner', aliases: ['Septic Shock'] });
    // a clashing rename is refused with a pointer to merge
    const clash = await call(t).patch(`/api/brain/concepts/${hypo.id}`, { name_en: 'Sepsis' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toContain('ادمج');
    // merge «hypovolaemic shock» into the renamed concept (TEST data — the merge only tests mechanics)
    const merged = await call(t).ok<BrainConceptResponse>('POST', `/api/brain/concepts/${hypo.id}/merge`, { into_id: septic.id });
    expect(merged.concept.id).toBe(septic.id);
    expect(merged.concept.aliases).toEqual(expect.arrayContaining(['Septic Shock', 'hypovolaemic shock']));

    const conceptsBefore = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM concept')!.n;
    await extract(t, l1.sourceId);
    await extract(t, l2.sourceId);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM concept')!.n).toBe(conceptsBefore);
    expect(conceptByName(t, 'cardiogenic shock')!.status).toBe('rejected');
    expect(t.ctx.db.get<{ merged_into_id: string }>('SELECT merged_into_id FROM concept WHERE id = ?', [hypo.id])!.merged_into_id).toBe(septic.id);
    // the re-extracted mentions of the old names land on the owner's concept
    const d = await call(t).ok<BrainConceptResponse>('GET', `/api/brain/concepts/${septic.id}`);
    expect(d.concept.name_en).toBe('Septic shock (owner name)');
    expect(d.concept.mentions!.map((m) => m.quote)).toEqual(expect.arrayContaining(['Septic Shock', 'The differential diagnosis includes cardiogenic shock and hypovolaemic shock.']));
    // a merged concept answers with its target
    const old = await call(t).ok<BrainConceptResponse>('GET', `/api/brain/concepts/${hypo.id}`);
    expect(old.concept.merged_into).toEqual({ id: septic.id, name: 'الصدمة الإنتانية' });
    // rejected concepts are hidden from the default list and counted
    const list = await call(t).ok<BrainConceptListResponse>('GET', `/api/brain/concepts?course_node_id=${course}`);
    expect(list.items.map((c) => c.id)).not.toContain(cardio.id);
    expect(list.counts.rejected).toBe(1);
    expect(list.counts.merged).toBe(1);
    const rejected = await call(t).ok<BrainConceptListResponse>('GET', `/api/brain/concepts?course_node_id=${course}&status=rejected`);
    expect(rejected.items.map((c) => c.id)).toEqual([cardio.id]);
  });

  it('the question candidate extractor resolves renamed / merged names too (no duplicate concept appears)', async () => {
    const { extractConceptCandidates } = await import('../../src/modules/questions/concepts');
    const before = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM concept')!.n;
    extractConceptCandidates(t.ctx, l2.versionId);
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM concept WHERE name_en = 'Septic Shock'")!.n).toBe(0);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM concept')!.n).toBeGreaterThanOrEqual(before);
    const heading = t.ctx.db.get<{ concept_id: string }>(`SELECT concept_id FROM concept_mention WHERE version_id = ? AND role = 'candidate_heading' AND region_id = ?`, [l2.versionId, l2.regionIds[0]![0]]);
    expect(heading?.concept_id).toBe(conceptByName(t, 'Septic shock (owner name)')!.id);
  });

  it('when the lecture order changes, undecided suggestions whose basis is gone are removed; decided ones stay', async () => {
    // lecture 2 now comes BEFORE lecture 1: «Sepsis» is no longer defined earlier than where it is used
    t.ctx.db.run('UPDATE source SET sort_order = 0 WHERE id = ?', [l2.sourceId]);
    const cb = await call(t).ok<CourseBrainResponse>('GET', `/api/brain/courses/${course}`);
    expect(cb.lectures.map((l) => l.source_id)).toEqual([l2.sourceId, l1.sourceId]);
    const items = await relations();
    // the rejected prerequisite is kept as the owner's decision
    expect(find(items, 'الإنتان', 'الصدمة الإنتانية', 'prerequisite')!.status).toBe('rejected');
    t.ctx.db.run('UPDATE source SET sort_order = 2 WHERE id = ?', [l2.sourceId]);
  });
});

describe('course page, validation, auth', () => {
  it('GET /courses/:id: extraction status per lecture, counts and honest notes', async () => {
    const cb = await call(t).ok<CourseBrainResponse>('GET', `/api/brain/courses/${course}`);
    expect(cb.course.title).toBe('Brain course A');
    expect(cb.lectures).toHaveLength(2);
    for (const l of cb.lectures) {
      expect(l.processed).toBe(true);
      expect(l.extraction).toMatchObject({ status: 'completed', current: true });
      expect(l.job?.status).toBe('completed');
    }
    expect(cb.totals.extracted).toBe(2);
    expect(cb.notes_ar.join(' ')).toContain('دون ذكاء اصطناعي');
  });

  it('a lecture that is not processed is skipped with a reason; unknown ids are 404; bad bodies 400', async () => {
    const pending = insertLecture(t, course, 'Pending lecture (TEST)', [[{ kind: 'heading', text: 'Pending' }]]);
    t.ctx.db.run(`UPDATE source_version SET processing_status = 'processing' WHERE id = ?`, [pending.versionId]);
    const r = await call(t).ok<{ jobs: unknown[]; skipped: Array<{ source_id: string; reason_ar: string }> }>('POST', '/api/brain/extract', { source_id: pending.sourceId });
    expect(r.jobs).toEqual([]);
    expect(r.skipped[0]!.reason_ar).toContain('لم تكتمل معالجة');
    expect((await call(t).get('/api/brain/concepts/NOPE')).statusCode).toBe(404);
    expect((await call(t).get('/api/brain/courses/NOPE')).statusCode).toBe(404);
    expect((await call(t).post('/api/brain/extract', {})).statusCode).toBe(400);
    expect((await call(t).post('/api/brain/relations', { from_concept_id: 'a', to_concept_id: 'a', relation: 'nonsense' })).statusCode).toBe(400);
    const self = conceptByName(t, 'Sepsis')!.id;
    expect((await call(t).post('/api/brain/relations', { from_concept_id: self, to_concept_id: self, relation: 'related' })).statusCode).toBe(400);
    expect((await call(t).post(`/api/brain/concepts/${self}/merge`, { into_id: self })).statusCode).toBe(400);
    t.ctx.db.run(`UPDATE source SET deleted_at = 1 WHERE id = ?`, [pending.sourceId]);
  });

  it('owner session and CSRF are required', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/brain/courses/${course}` })).statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/brain/extract', headers: { cookie: t.h.cookie }, payload: { course_node_id: course } });
    expect(noCsrf.statusCode).toBe(403);
  });
});
