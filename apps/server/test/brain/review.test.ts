// Course Brain — regression tests for the issues found in the F2 adversarial review:
//  * a stated mention's NAME literally appears in its quote (heading keywords are cut at the edges only);
//  * a merge never drops the owner's decision on a duplicate relation;
//  * a purged lecture's text does not survive inside relation reasons (migration 0801);
//  * a bilingual join keeps BOTH names usable by question matching;
//  * the concept page lists the study version's places only;
//  * the per-version mention cap is reported on the course page, never silent;
//  * a prerequisite rejected as a concept is not shown on the Student Knowledge Map;
//  * an extraction finishing after its source went to the trash does not fail;
//  * the coverage notes say that owner-added questions count with the source questions.
// Synthetic TEST lectures (rows), no AI.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrainConceptResponse, ConceptRelationListResponse, CourseBrainResponse, CoverageResponse, StudentKnowledgeResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { extractKnowledge, type RegionIn } from '../../src/modules/brain/extract';
import { MAX_MENTIONS, runKnowledgeExtraction } from '../../src/modules/brain/run';
import { conceptKey, extractConceptCandidates, lectureConcepts } from '../../src/modules/questions/concepts';
import { brainApp, call, conceptByName, createCourse, extract, insertLecture, type BApp } from './helpers';

let t: BApp;
beforeAll(async () => {
  t = await brainApp();
}, 60_000);
afterAll(async () => {
  await t?.close();
});

const relations = async (course: string) => (await call(t).ok<ConceptRelationListResponse>('GET', `/api/brain/relations?course_node_id=${course}`)).items;

describe('a stated name literally appears in its quote', () => {
  let n = 0;
  const r = (kind: string, text: string): RegionIn => ({ id: `rv${++n}`, page_id: 'p', page_index: 0, kind, text, structure_json: null, parent_region_id: null });

  it('heading keywords are removed at the edges only — never cut out of the middle of a name', () => {
    const names = (h: string) => extractKnowledge([r('heading', h)]).mentions.map((m) => m.name);
    expect(names('Cardiac drug toxicity')).toEqual(['Cardiac drug toxicity']);
    expect(names('Type 2 Diabetes Mellitus')).toEqual(['Type 2 Diabetes Mellitus']);
    expect(names('Type II respiratory failure')).toEqual(['Type II respiratory failure']);
    expect(names('Drug-induced liver injury')).toEqual(['Drug-induced liver injury']);
    expect(names('Treatment-resistant hypertension')).toEqual(['Treatment-resistant hypertension']);
    // the section words at the edges still go
    expect(names('Types of shock')).toEqual(['shock']);
    expect(names('Management of acute appendicitis')).toEqual(['acute appendicitis']);
    expect(names('Signs and symptoms of shock')).toEqual(['shock']);
    expect(names('Septic shock complications')).toEqual(['Septic shock']);
    expect(names('Mechanism of action of beta blockers')).toEqual(['beta blockers']);
  });

  it('invariant over varied regions: every mention name is a contiguous run of its quote (parenthetical abbreviations aside)', () => {
    const x = extractKnowledge([
      r('heading', 'Cardiac drug toxicity'),
      r('heading', 'Investigations of chest pain — فحوصات ألم الصدر'),
      r('heading', 'Pathophysiology of Type 1 hypersensitivity'),
      r('paragraph', 'Anaphylaxis is defined as a severe TEST reaction. Adrenaline is the first-line TEST drug in anaphylaxis.'),
      r('heading', 'Differential diagnosis'),
      r('paragraph', 'The differential diagnosis includes vasovagal syncope, panic attack and asthma.'),
      r('list_item', '• Serum tryptase'),
      r('caption', 'Figure 2: Classification of shock by mechanism'),
      r('paragraph', 'يُعرَّف التأق بأنه تفاعل تحسسي شديد.'),
    ]);
    const flat = (s: string) => s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    expect(x.mentions.length).toBeGreaterThan(5);
    for (const m of x.mentions) expect(flat(m.quote), `${m.name} ⊂ ${m.quote}`).toContain(flat(m.name));
  });
});

describe('owner decisions on relations survive a merge', () => {
  it('a rejected relation moved by a merge stays rejected instead of the target’s undecided duplicate', async () => {
    const course = (await createCourse(t, 'Merge decisions')).id;
    const l1 = insertLecture(t, course, 'M1 (TEST)', [[{ kind: 'heading', text: 'Sepsis' }, { kind: 'paragraph', text: 'Sepsis is defined as a TEST response to infection.' }]], { sortOrder: 1 });
    const l2 = insertLecture(t, course, 'M2 (TEST)', [[{ kind: 'heading', text: 'Septic Shock' }, { kind: 'paragraph', text: 'Septic shock is a subset of sepsis.' }]], { sortOrder: 2 });
    const l3 = insertLecture(t, course, 'M3 (TEST)', [[{ kind: 'heading', text: 'Shock states' }, { kind: 'paragraph', text: 'Shock states develop after sepsis.' }]], { sortOrder: 3 });
    for (const l of [l1, l2, l3]) await extract(t, l.sourceId);
    const before = await relations(course);
    const toSS = before.find((r) => r.relation === 'prerequisite' && r.to.name === 'Septic Shock')!;
    expect(before.find((r) => r.relation === 'prerequisite' && r.to.name === 'Shock states')!.status).toBe('suggested');
    expect((await call(t).patch(`/api/brain/relations/${toSS.id}`, { status: 'rejected' })).statusCode).toBe(200);

    const ss = conceptByName(t, 'Septic Shock')!.id;
    const st = conceptByName(t, 'Shock states')!.id;
    expect((await call(t).post(`/api/brain/concepts/${ss}/merge`, { into_id: st })).statusCode).toBe(200);
    const after = (await relations(course)).filter((r) => r.relation === 'prerequisite' && r.to.id === st);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('rejected');
    // and a later re-extraction keeps it rejected
    for (const l of [l1, l2, l3]) await extract(t, l.sourceId);
    const again = (await relations(course)).filter((r) => r.relation === 'prerequisite' && r.to.id === st);
    expect(again.map((r) => r.status)).toEqual(['rejected']);
  });
});

describe('a purged lecture does not live on inside relation reasons', () => {
  it('undecided suggestions built on it disappear; decided ones keep the decision with a neutral reason and none of its text', async () => {
    const course = (await createCourse(t, 'Purge reasons')).id;
    const secret = 'TEST purge-sentinel sentence about infection';
    const l1 = insertLecture(t, course, 'P1 secret title (TEST)', [[{ kind: 'heading', text: 'Bacteraemia' }, { kind: 'paragraph', text: `Bacteraemia is defined as a ${secret}.` }]], { sortOrder: 1 });
    const l2 = insertLecture(t, course, 'P2 (TEST)', [[{ kind: 'heading', text: 'Endocarditis' }, { kind: 'paragraph', text: 'Endocarditis can follow bacteraemia.' }]], { sortOrder: 2 });
    const l3 = insertLecture(t, course, 'P3 (TEST)', [[{ kind: 'heading', text: 'Osteomyelitis' }, { kind: 'paragraph', text: 'Osteomyelitis may follow bacteraemia.' }]], { sortOrder: 3 });
    for (const l of [l1, l2, l3]) await extract(t, l.sourceId);
    const items = await relations(course);
    const toEndo = items.find((r) => r.relation === 'prerequisite' && r.to.name === 'Endocarditis')!;
    const toOsteo = items.find((r) => r.relation === 'prerequisite' && r.to.name === 'Osteomyelitis')!;
    expect(JSON.stringify(toEndo.reasons)).toContain(secret);
    // the owner accepts one; the other stays undecided
    expect((await call(t).patch(`/api/brain/relations/${toEndo.id}`, { status: 'accepted' })).statusCode).toBe(200);

    expect((await call(t).post(`/api/sources/${l1.sourceId}/trash`, {})).statusCode).toBe(200);
    const impact = (await call(t).get(`/api/sources/${l1.sourceId}/impact?mode=purge`)).json() as { confirm_token: string };
    const del = await call(t).del(`/api/sources/${l1.sourceId}?confirm_token=${encodeURIComponent(impact.confirm_token)}`);
    expect(del.statusCode).toBe(200);

    const leftovers = t.ctx.db.all<{ id: string }>(`SELECT id FROM concept_relation WHERE reasons_json LIKE ? OR reasons_json LIKE ? OR reasons_json LIKE ?`, [
      `%${secret}%`,
      '%P1 secret title%',
      `%${l1.versionId}%`,
    ]);
    expect(leftovers).toEqual([]);
    const kept = t.ctx.db.get<{ status: string; reasons_json: string }>('SELECT status, reasons_json FROM concept_relation WHERE id = ?', [toEndo.id])!;
    expect(kept.status).toBe('accepted');
    expect(JSON.parse(kept.reasons_json)).toEqual([expect.objectContaining({ kind: 'basis_removed' })]);
    expect(t.ctx.db.get('SELECT 1 AS x FROM concept_relation WHERE id = ?', [toOsteo.id])).toBeUndefined();
  });
});

describe('question matching keeps both names of a bilingual concept', () => {
  it('after the Course Brain joins the English and Arabic candidates, the lecture still offers the Arabic name to the matcher', async () => {
    const course = (await createCourse(t, 'Bilingual matching')).id;
    const l = insertLecture(t, course, 'B1 (TEST)', [[{ kind: 'heading', text: 'Acute Cholangitis — التهاب الأقنية الصفراوية الحاد' }]]);
    extractConceptCandidates(t.ctx, l.versionId);
    const before = lectureConcepts(t.ctx, l.versionId);
    expect(new Set(before.map((c) => c.id)).size).toBe(2);
    runKnowledgeExtraction(t.ctx, l.versionId);
    const after = lectureConcepts(t.ctx, l.versionId);
    expect(new Set(after.map((c) => c.id)).size).toBe(1); // joined into one concept…
    expect(after.map((c) => c.key).sort()).toEqual(before.map((c) => c.key).sort()); // …matched by the same names as before
    expect(after.map((c) => c.key)).toContain(conceptKey('التهاب الأقنية الصفراوية الحاد'));
  });
});

describe('concept page: places in the study version only', () => {
  it('a superseded version’s quotes are not mixed with the current version’s', async () => {
    const course = (await createCourse(t, 'Versions')).id;
    const l = insertLecture(t, course, 'V1 (TEST)', [[{ kind: 'heading', text: 'Pyelonephritis' }, { kind: 'paragraph', text: 'Pyelonephritis is defined as an OLD TEST wording.' }]]);
    await extract(t, l.sourceId);
    // a new version of the same lecture becomes the study version
    const now = t.ctx.clock.now();
    const v2 = newId(now);
    const p2 = newId(now);
    t.ctx.db.tx(() => {
      t.ctx.db.run(
        `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, file_name, format, page_count, processing_status, created_at)
         VALUES (?, ?, 2, 'original', ?, 'application/pdf', 'v2.pdf', 'pdf', 1, 'ready', ?)`,
        [v2, l.sourceId, newId(now), now],
      );
      t.ctx.db.run(`INSERT INTO source_page (id, version_id, page_index, kind, text_status, processing_status, created_at, updated_at) VALUES (?, ?, 0, 'page', 'digital', 'ready', ?, ?)`, [p2, v2, now, now]);
      t.ctx.db.run(
        `INSERT INTO source_region (id, version_id, page_id, kind, reading_order, text, text_origin, status, created_at, updated_at) VALUES (?, ?, ?, 'paragraph', 0, ?, 'digital', 'extracted', ?, ?)`,
        [newId(now), v2, p2, 'Pyelonephritis is defined as a NEW TEST wording.', now, now],
      );
      t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [v2, l.sourceId]);
    });
    runKnowledgeExtraction(t.ctx, v2);
    const d = await call(t).ok<BrainConceptResponse>('GET', `/api/brain/concepts/${conceptByName(t, 'Pyelonephritis')!.id}`);
    const quotes = d.concept.mentions!.filter((m) => m.support === 'stated').map((m) => m.quote);
    expect(quotes).toContain('Pyelonephritis is defined as a NEW TEST wording.');
    expect(quotes.join(' ')).not.toContain('OLD TEST wording');
    expect(d.concept.mentions!.every((m) => m.version_id === v2)).toBe(true);
  });
});

describe('honest limits', () => {
  it('the per-version mention cap is reported on the course page (counts + note), never silent', async () => {
    const course = (await createCourse(t, 'Big textbook')).id;
    const per = 820;
    const pages = [0, 1].map((p) => Array.from({ length: per }, (_, i) => ({ kind: 'list_item', text: `• Finding ${p}x${i} TEST` })));
    const l = insertLecture(t, course, 'Huge TEST textbook', pages, { sourceType: 'textbook' });
    await extract(t, l.sourceId);
    const cb = await call(t).ok<CourseBrainResponse>('GET', `/api/brain/courses/${course}`);
    const lec = cb.lectures.find((x) => x.source_id === l.sourceId)!;
    expect(lec.extraction!.counts.mentions).toBe(MAX_MENTIONS);
    expect(lec.extraction!.counts.mentions_found).toBe(2 * per);
    expect(cb.notes_ar.join(' ')).toContain(`أول ${MAX_MENTIONS} من ${2 * per}`);
  });

  it('a prerequisite rejected as a concept is not offered as something to study first', async () => {
    const course = (await createCourse(t, 'Rejected prerequisite')).id;
    const l1 = insertLecture(t, course, 'R1 (TEST)', [[{ kind: 'heading', text: 'Hypoxaemia' }, { kind: 'paragraph', text: 'Hypoxaemia is defined as a TEST low oxygen state.' }]], { sortOrder: 1 });
    const l2 = insertLecture(t, course, 'R2 (TEST)', [[{ kind: 'heading', text: 'Respiratory failure' }, { kind: 'paragraph', text: 'Respiratory failure presents with hypoxaemia.' }]], { sortOrder: 2 });
    await extract(t, l1.sourceId);
    await extract(t, l2.sourceId);
    const k = async () => (await call(t).ok<StudentKnowledgeResponse>('GET', `/api/brain/knowledge?course_node_id=${course}`)).items.find((i) => i.name === 'Respiratory failure')!;
    expect((await k()).prerequisites.map((p) => p.name)).toEqual(['Hypoxaemia']);
    expect((await call(t).patch(`/api/brain/concepts/${conceptByName(t, 'Hypoxaemia')!.id}`, { status: 'rejected' })).statusCode).toBe(200);
    expect((await k()).prerequisites).toEqual([]);
  });

  it('an extraction that finishes after its source went to the trash completes (no failing job, no course follow-up)', async () => {
    const course = (await createCourse(t, 'Trashed')).id;
    const l = insertLecture(t, course, 'T1 (TEST)', [[{ kind: 'heading', text: 'Cellulitis' }]]);
    t.ctx.db.run('UPDATE source SET deleted_at = ? WHERE id = ?', [t.ctx.clock.now(), l.sourceId]);
    const summary = runKnowledgeExtraction(t.ctx, l.versionId);
    expect(summary.status).toBe('completed');
    expect(summary.relations).toBeNull();
  });

  it('coverage says that questions you added yourself count with the source questions', async () => {
    const course = (await createCourse(t, 'Coverage note')).id;
    insertLecture(t, course, 'C1 (TEST)', [[{ kind: 'heading', text: 'Gout' }]]);
    const cov = await call(t).ok<CoverageResponse>('GET', `/api/brain/coverage?course_node_id=${course}`);
    expect(cov.notes_ar.join(' ')).toContain('أضفتها بنفسك');
  });
});
