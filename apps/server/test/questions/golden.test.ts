// Question Vault on the Golden Set through the REAL pipeline: upload (sources API) → processing (pdfjs /
// tesseract) → processing hook → extract_questions → match_questions. Covers AC-10…AC-17 and AC-26 (question
// part), idempotent re-extraction, owner corrections, quick add and auth.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LectureQuestionsResponse, QuestionMutationResponse, QuestionOriginalView, QuickAddResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { createVersion, listForExam, dedupeCandidates } from '../../src/modules/questions/service';
import { expected } from '../processing/helpers';
import { multipart } from '../sources/helpers';
import { api, correctTexts, counts, createNode, createQuestionsApp, detail, golden, listAll, local, questionAt, uploadAndProcess, type QApp } from './helpers';

let t: QApp;
let course1: string;
let course2: string;
let qs: { sourceId: string; versionId: string };
let prev: { sourceId: string; versionId: string };
let photo: { sourceId: string; versionId: string };

beforeAll(async () => {
  t = await createQuestionsApp();
  course1 = (await createNode(t, 'Surgery Course 1')).id;
  course2 = (await createNode(t, 'Surgery Course 2')).id;
  // the question sources arrive FIRST (AC-16: the lecture is uploaded later, in a test below)
  qs = await uploadAndProcess(t, course1, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Surgery Course 1 Questions');
  prev = await uploadAndProcess(t, course1, 'questions_previous_exam_2024.pdf', golden('questions_previous_exam_2024.pdf'), 'previous_exam', 'Previous exam 2024');
  // quick add of one photographed question (§33): image → OCR → extraction, no full-file workflow
  const body = multipart({ node_id: course1, title: 'Question photo' }, [{ name: 'question_photo_circled.png', data: golden('question_photo_circled.png'), contentType: 'image/png' }]);
  const res = await t.app.inject({ method: 'POST', url: '/api/questions/quick-add', headers: { ...t.h, 'content-type': body.contentType }, payload: body.payload });
  if (res.statusCode !== 200) throw new Error(`quick add failed ${res.statusCode} ${res.body}`);
  const qa = res.json() as QuickAddResponse;
  photo = { sourceId: qa.source_id!, versionId: qa.version_id! };
  await t.ctx.jobs.drain();
}, 300_000);

afterAll(async () => {
  await t?.close();
});

const exp = () => expected['questions_surgery_course1.pdf'];

describe('extraction from the question source (§33, §34)', () => {
  it('extracts the 7 questions in sections A and B, each with its real number of options', async () => {
    const items = await listAll(t, `source_id=${qs.sourceId}`);
    expect(items).toHaveLength(exp().total_questions);
    for (const sec of exp().sections) {
      for (const q of sec.questions) {
        const d = await detail(t, questionAt(t, qs.sourceId, sec.key, q.n));
        expect(d.question.current.options).toHaveLength(q.options);
        expect(d.question.origin_type).toBe('source');
        expect(d.question.current.kind).toBe('raw_extraction');
        expect(d.question.current.stem_raw).toMatch(new RegExp(`^${q.n}\\. `));
      }
    }
    const summary = (await api(t).get(`/api/questions/extractions/${qs.versionId}`)).json().summary;
    expect(summary.sections.map((s: { key: string; questions: number }) => [s.key, s.questions])).toEqual([
      ['A', 4],
      ['B', 3],
    ]);
    expect(summary.keys_bound).toBe(6);
    expect(summary.message_ar).toContain('7 أسئلة');
  });

  it('AC-10: A3 spans pages 0–1 with all 5 options and its original location', async () => {
    const id = questionAt(t, qs.sourceId, 'A', '3');
    const d = await detail(t, id);
    const occ = d.question.occurrences[0]!;
    expect(occ.pages.map((p) => p.page_index)).toEqual([0, 1]);
    expect(d.question.current.options.map((o) => o.source_label)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(d.question.current.options.map((o) => o.option_key)).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
    expect(occ.origin_label_ar).toBe('سؤال من مصدر الأسئلة — Surgery Course 1 Questions — ص 1–2 — رقم السؤال 3 (Section A)');
    const orig = (await api(t).get(`/api/questions/${id}/original`)).json() as QuestionOriginalView;
    expect(orig.pages.map((p) => p.page_index)).toEqual([0, 1]);
    expect(orig.pages.every((p) => p.boxes.length > 0)).toBe(true);
    expect(orig.raw_text).toContain('E. Upper GI endoscopy');
    expect(d.question.current.extraction_status).toBe('checks_passed');
  });

  it('AC-11: NOT / EXCEPT kept and flagged; «11.5 ×10⁹/L» preserved; numbers check passed', async () => {
    const a2 = (await detail(t, questionAt(t, qs.sourceId, 'A', '2'))).question.current;
    expect(a2.has_negation).toBe(true);
    expect(a2.negation_terms).toEqual(['NOT']);
    const emph = a2.stem.paragraphs.flatMap((p) => p.runs).filter((r) => r.marks?.includes('em'));
    expect(emph.map((r) => r.t)).toEqual(['NOT']);
    const b2 = (await detail(t, questionAt(t, qs.sourceId, 'B', '2'))).question.current;
    expect(b2.negation_terms).toEqual(['EXCEPT']);
    const a4 = (await detail(t, questionAt(t, qs.sourceId, 'A', '4'))).question.current;
    const stem = a4.stem.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');
    expect(stem).toContain(exp().sections[0].questions[3].must_contain);
    expect(a4.validation!.issues.find((i) => i.check === 'numbers_units_preserved')).toMatchObject({ passed: true });
    expect(a4.validation!.issues.find((i) => i.check === 'negation_preserved')).toMatchObject({ passed: true });
    const p3 = (await detail(t, questionAt(t, prev.sourceId, '', '3'))).question.current;
    const optTexts = p3.options.map((o) => o.text.paragraphs[0]!.runs.map((r) => r.t).join(''));
    for (const s of expected['questions_previous_exam_2024.pdf'].questions[2].must_contain as string[]) expect(optTexts).toContain(s);
  });

  it('AC-11: a structured version with an altered unit fails validation and cannot be approved automatically', async () => {
    const id = questionAt(t, qs.sourceId, 'A', '4');
    const before = (await detail(t, id)).question.current;
    const stem = before.stem.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');
    const r = createVersion(t.ctx, id, { kind: 'structured', createdBy: 'extraction', stem: stem.replace('×10⁹/L', '×10⁹/mL'), note: 'synthetic altered unit (test)' });
    const n = r.validation!.issues.find((i) => i.check === 'numbers_units_preserved')!;
    expect(n).toMatchObject({ passed: false, severity: 'blocker' });
    const d = await detail(t, id);
    expect(d.question.status).toBe('needs_review');
    expect(d.question.current.extraction_status).toBe('needs_review');
    expect(d.scorable).toBe(false);
    expect(d.review_items.some((i) => i.kind === 'question_validation_failed' && i.status === 'open')).toBe(true);
    // approval without acknowledging the blocker is refused
    const refused = await api(t).post(`/api/questions/${id}/review`, { decision: 'accept' });
    expect(refused.statusCode).toBe(409);
    expect(JSON.stringify(refused.json().error.details)).toContain('numbers_units_preserved');
    // the owner fixes it: a correction restores the unit → checks pass again
    const fixed = await api(t).patch(`/api/questions/${id}`, { stem, note: 'إرجاع الوحدة كما في الأصل' });
    expect(fixed.statusCode).toBe(200);
    const fx = fixed.json() as QuestionMutationResponse;
    expect(fx.question.current.kind).toBe('owner_correction');
    expect(fx.question.current.validation!.issues.find((i) => i.check === 'numbers_units_preserved')?.passed).toBe(true);
    expect(fx.question.status).toBe('ready');
  });

  it('AC-12: sections A and B both start at 1; keys are bound per section (never by number alone)', async () => {
    const a1 = (await detail(t, questionAt(t, qs.sourceId, 'A', '1'))).question;
    const b1 = (await detail(t, questionAt(t, qs.sourceId, 'B', '1'))).question;
    expect(a1.id).not.toBe(b1.id);
    expect(correctTexts(a1)).toEqual(["McBurney's point"]);
    expect(correctTexts(b1)).toEqual(["Murphy's sign"]);
    expect(a1.current.answer_status).toBe('source_key');
    const keys = t.ctx.db.all<{ section_key: string; printed_number: string; key_label: string; binding: string }>(
      'SELECT section_key, printed_number, key_label, binding FROM answer_key_entry WHERE source_version_id = ? ORDER BY section_key, printed_number',
      [qs.versionId],
    );
    expect(keys.map((k) => `${k.section_key}${k.printed_number}=${k.key_label}:${k.binding}`)).toEqual([
      'A1=B:bound',
      'A2=C:bound',
      'A3=B:bound',
      'A4=B:bound',
      'B1=A:bound',
      'B2=D:bound',
    ]);
    for (const sec of exp().sections) {
      for (const q of sec.questions) {
        const d = await detail(t, questionAt(t, qs.sourceId, sec.key, q.n));
        if (q.key) {
          const labels = d.question.current.options.filter((o) => d.question.current.correct_option_ids?.includes(o.id)).map((o) => o.source_label);
          expect(labels).toEqual([q.key]);
        }
        expect(d.question.current.answer_status).toBe(q.answer_status);
      }
    }
  });

  it('AC-12: a key without section labels in a multi-section file stays unbound → review, both questions missing_key', async () => {
    const amb = await uploadAndProcess(t, course2, 'ambiguous_keys.pdf', local('ambiguous_keys.pdf'), 'question_source');
    const items = await listAll(t, `source_id=${amb.sourceId}`);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.answer_status === 'missing_key' && !i.scorable)).toBe(true);
    const entries = t.ctx.db.all<{ binding: string; matched_occurrence_id: string | null }>('SELECT binding, matched_occurrence_id FROM answer_key_entry WHERE source_version_id = ?', [amb.versionId]);
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.binding === 'ambiguous_section' && e.matched_occurrence_id === null)).toBe(true);
    const rq = (await api(t).get(`/api/questions/review-queue?source_id=${amb.sourceId}`)).json();
    expect(rq.items.filter((i: { kind: string }) => i.kind === 'conflicting_key').length).toBe(2);
    expect(rq.items[0].reason).toContain('بلا قسم محدد');
  });

  it('AC-14: B3 has no key → kept as a source question, unscored practice only', async () => {
    const id = questionAt(t, qs.sourceId, 'B', '3');
    const d = await detail(t, id);
    expect(d.question.current.answer_status).toBe('missing_key');
    expect(d.question.current.correct_option_ids).toBeNull();
    expect(d.question.current.options.map((o) => o.source_label)).toEqual(exp().sections[1].questions[2].option_labels);
    expect(d.scorable).toBe(false);
    expect(d.unscorable_reason_ar).toContain('لا يوجد مفتاح');
    expect(d.question.status).toBe('ready');
    const scorable = listForExam(t.ctx, { sourceIds: [qs.sourceId], onlyScorable: true }).map((c) => c.question_id);
    expect(scorable).not.toContain(id);
    expect(listForExam(t.ctx, { sourceIds: [qs.sourceId] }).find((c) => c.question_id === id)?.unscorable_reason_ar).toBeTruthy();
  });

  it('AC-13: the circled option on the photo is an unofficial mark, never an official key', async () => {
    const items = await listAll(t, `source_id=${photo.sourceId}`);
    expect(items).toHaveLength(1);
    const d = await detail(t, items[0]!.id);
    expect(d.question.current.answer_status).toBe('missing_key');
    expect(d.question.current.correct_option_ids).toBeNull();
    expect(d.question.occurrences[0]!.printed_number).toBe('7');
    expect(d.question.current.options).toHaveLength(4);
    expect(d.key_entries).toHaveLength(1);
    expect(d.key_entries[0]).toMatchObject({ mark_kind: 'circled_option', origin_known: false, binding: 'unofficial', key_label: 'A' });
    expect(d.review_items.some((i) => i.kind === 'unofficial_mark' && i.status === 'open')).toBe(true);
    // the OCR'd option text is uncertain → extraction needs review, not silent acceptance
    expect(d.question.current.extraction_status).toBe('needs_review');
    expect(d.scorable).toBe(false);
  });

  it('AC-15: two printed key tables that disagree → conflicting_key, both kept, original untouched; owner key resolves with a new version', async () => {
    const ck = await uploadAndProcess(t, course2, 'conflicting_keys.pdf', local('conflicting_keys.pdf'), 'question_source');
    const q1 = questionAt(t, ck.sourceId, 'A', '1');
    const q2 = questionAt(t, ck.sourceId, 'A', '2');
    expect((await detail(t, q1)).question.current.answer_status).toBe('source_key');
    const d2 = await detail(t, q2);
    expect(d2.question.current.answer_status).toBe('conflicting_key');
    expect(d2.question.current.correct_option_ids).toBeNull();
    expect(d2.question.current.key_details?.conflict_ar).toContain('متعارضة');
    expect(d2.key_entries.map((k) => `${k.key_block}:${k.key_label}:${k.mark_kind}`).sort()).toEqual(['1:C:key_table', '2:D:key_table']);
    expect(d2.review_items.some((i) => i.kind === 'conflicting_key' && i.status === 'open')).toBe(true);
    expect(d2.scorable).toBe(false);
    const originalVersion = d2.question.current.id;
    const stemBefore = d2.question.current.stem_raw;
    // the owner decides (C) → new version owner_key; the source entries and the old version stay as printed
    const optC = d2.question.current.options.find((o) => o.source_label === 'C')!.option_key;
    const res = await api(t).post(`/api/questions/${q2}/key`, { option_keys: [optC], reason: 'راجعت المحاضرة' });
    expect(res.statusCode).toBe(200);
    const m = res.json() as QuestionMutationResponse;
    expect(m.new_version_id).not.toBe(originalVersion);
    expect(m.question.current.answer_status).toBe('owner_key');
    expect(m.impact?.content_alert_id).toBeTruthy();
    const after = await detail(t, q2);
    expect(after.key_entries).toHaveLength(2);
    expect(after.versions.find((v) => v.id === originalVersion)?.answer_status).toBe('conflicting_key');
    expect(after.versions.find((v) => v.id === originalVersion)?.stem_raw).toBe(stemBefore);
    expect(after.review_items.find((i) => i.kind === 'conflicting_key')?.status).toBe('corrected');
  });

  it('AC-17: the previous-exam Q1 is the same question (one question, two occurrences); Q2 is only a near-duplicate suggestion', async () => {
    const a1 = questionAt(t, qs.sourceId, 'A', '1');
    expect(questionAt(t, prev.sourceId, '', '1')).toBe(a1);
    const d = await detail(t, a1);
    expect(d.question.occurrences.map((o) => o.source_id).sort()).toEqual([qs.sourceId, prev.sourceId].sort());
    expect(d.question.occurrences.map((o) => o.origin_label_ar)).toContain('سؤال من مصدر الأسئلة — Previous exam 2024 — ص 1 — رقم السؤال 1');
    const a2 = questionAt(t, qs.sourceId, 'A', '2');
    const p2 = questionAt(t, prev.sourceId, '', '2');
    expect(p2).not.toBe(a2);
    const dup = (await detail(t, p2)).question.duplicates.find((x) => x.other_question_id === a2)!;
    expect(dup.kind).toBe('near');
    expect(dup.status).toBe('suggested');
    expect(dup.blockers.join(' ')).toMatch(/النفي/);
    expect(dup.blockers.join(' ')).toMatch(/الخيارات/);
    // an exam selection never shows the same question twice
    const cands = dedupeCandidates(listForExam(t.ctx, { sourceIds: [qs.sourceId, prev.sourceId] }));
    expect(cands.filter((c) => c.question_id === a1)).toHaveLength(1);
    expect(new Set(cands.map((c) => c.question_id)).size).toBe(cands.length);
    // the owner rejects the suggestion → it stays rejected after re-extraction
    const dec = await api(t).post(`/api/questions/duplicates/${dup.id}/decision`, { status: 'rejected', reason: 'نفي مختلف' });
    expect(dec.statusCode).toBe(200);
    await api(t).post('/api/questions/extract', { version_id: prev.versionId });
    await t.ctx.jobs.drain();
    expect((await detail(t, p2)).question.duplicates.find((x) => x.id === dup.id)?.status).toBe('rejected');
  });
});

describe('lecture ↔ question matching (§35)', () => {
  let lecture: { sourceId: string; versionId: string };

  it('AC-16: the lecture arrives AFTER the question sources → its questions are linked with reasons and pages', async () => {
    lecture = await uploadAndProcess(t, course1, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Acute Appendicitis lecture');
    const res = (await api(t).get(`/api/questions/for-lecture/${lecture.sourceId}`)).json() as LectureQuestionsResponse;
    expect(res.matching.state).toBe('done');
    const m = expected.matching;
    for (const e of m.expect_linked_to_lecture as Array<{ section: string; n: string }>) {
      const qid = questionAt(t, qs.sourceId, e.section, e.n);
      const item = res.items.find((i) => i.question_id === qid);
      expect(item, `${e.section}${e.n} linked`).toBeTruthy();
      expect(item!.link.relation).toBe('directly_covered');
      expect(item!.link.answerable_from_lecture).toBe(true);
      expect(item!.link.reason.length).toBeGreaterThan(20);
      expect(item!.link.lecture_pages.length).toBeGreaterThan(0);
      expect(item!.link.lecture_pages[0]!.label_ar).toMatch(/^ص 1[1-4]$/);
      expect(item!.origin_label_ar).toContain('سؤال من مصدر الأسئلة — Surgery Course 1 Questions');
      expect(item!.original?.source_id).toBe(qs.sourceId);
    }
    for (const e of m.expect_not_directly_covered as Array<{ section: string; n: string }>) {
      const qid = questionAt(t, qs.sourceId, e.section, e.n);
      const item = res.items.find((i) => i.question_id === qid);
      if (item) expect(['partially_covered', 'course_related_only']).toContain(item.link.relation);
      if (item) expect(item.link.answerable_from_lecture).toBe(false);
    }
    // specific reasons: A1 names the answer and the page; A2 explains the NOT logic
    const a1 = res.items.find((i) => i.question_id === questionAt(t, qs.sourceId, 'A', '1'))!;
    expect(a1.link.reason).toContain("McBurney's point");
    expect(a1.link.reason).toContain('ص 11');
    const a2 = res.items.find((i) => i.question_id === questionAt(t, qs.sourceId, 'A', '2'))!;
    expect(a2.link.reason).toContain('NOT');
    expect(a2.link.matched_terms).toContain('Alvarado score');
  });

  it('the questions of the current page come first', async () => {
    const pages = t.ctx.db.all<{ id: string; page_index: number }>('SELECT id, page_index FROM source_page WHERE version_id = ? ORDER BY page_index', [lecture.versionId]);
    const table = pages.find((p) => p.page_index === 2)!;
    const res = (await api(t).get(`/api/questions/for-lecture/${lecture.sourceId}?page_id=${table.id}`)).json() as LectureQuestionsResponse;
    expect(res.items[0]!.on_this_page).toBe(true);
    expect(res.items[0]!.link.lecture_pages.map((p) => p.page_id)).toContain(table.id);
    const firstOff = res.items.findIndex((i) => !i.on_this_page);
    expect(res.items.slice(firstOff).every((i) => !i.on_this_page)).toBe(true);
  });

  it('matching is scoped to the course: a lecture of another course gets none of these questions', async () => {
    const other = await uploadAndProcess(t, course2, 'lecture_cholecystitis.pdf', golden('lecture_cholecystitis.pdf'), 'lecture');
    const res = (await api(t).get(`/api/questions/for-lecture/${other.sourceId}`)).json() as LectureQuestionsResponse;
    const course1Questions = new Set((await listAll(t, `course_id=${course1}`)).map((i) => i.id));
    expect(res.items.filter((i) => course1Questions.has(i.question_id))).toHaveLength(0);
  });

  it('owner link decisions persist and are never overridden by re-matching', async () => {
    const qid = questionAt(t, qs.sourceId, 'A', '4');
    const link = (await detail(t, qid)).question.lecture_links.find((l) => l.lecture_source_id === lecture.sourceId)!;
    const rej = await api(t).post(`/api/questions/links/${link.id}/decision`, { status: 'rejected', reason: 'ليس من هذه المحاضرة في رأيي' });
    expect(rej.statusCode).toBe(200);
    const m = await api(t).post('/api/questions/match', { source_id: lecture.sourceId });
    expect(m.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const after = (await detail(t, qid)).question.lecture_links.find((l) => l.id === link.id)!;
    expect(after.status).toBe('rejected');
    expect(after.decision_reason).toBe('ليس من هذه المحاضرة في رأيي');
    const res = (await api(t).get(`/api/questions/for-lecture/${lecture.sourceId}`)).json() as LectureQuestionsResponse;
    expect(res.items.find((i) => i.question_id === qid)).toBeUndefined();
    // and «من محاضرتي فقط» no longer offers it
    expect(listForExam(t.ctx, { lectureOnlyAnswerable: lecture.sourceId }).map((c) => c.question_id)).not.toContain(qid);
    expect(listForExam(t.ctx, { lectureOnlyAnswerable: lecture.sourceId }).map((c) => c.question_id)).toContain(questionAt(t, qs.sourceId, 'A', '1'));
  });

  it('concept candidates (§16) come from the lecture and can be rejected by the owner', async () => {
    const res = (await api(t).get(`/api/questions/concepts?source_id=${lecture.sourceId}`)).json();
    const names = res.items.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Acute Appendicitis', 'Alvarado score', 'Anorexia', 'Leukocytosis']));
    expect(names).not.toContain('Learning objectives');
    const c = res.items.find((x: { name: string }) => x.name === 'Anorexia');
    expect(c.status).toBe('suggested');
    expect(c.mentions[0].page_label_ar).toMatch(/^ص 1[1-4]$/);
    expect((await api(t).patch(`/api/questions/concepts/${c.id}`, { status: 'rejected' })).statusCode).toBe(200);
    const again = (await api(t).get(`/api/questions/concepts?source_id=${lecture.sourceId}`)).json();
    expect(again.items.find((x: { id: string }) => x.id === c.id).status).toBe('rejected');
  });
});

describe('re-extraction, corrections and attempts (§34, §36, AC-26)', () => {
  it('re-extraction (manual and after re-processing a page) is idempotent', async () => {
    const before = counts(t);
    const r = await api(t).post('/api/questions/extract', { version_id: qs.versionId });
    expect(r.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    expect(counts(t)).toEqual(before);
    // re-process page 2 (index 1): regions are replaced, the hook re-extracts, nothing is duplicated
    const rp = await api(t).post(`/api/sources/versions/${qs.versionId}/reprocess`, { page_indexes: [1] });
    expect(rp.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const job = t.ctx.db.get<{ status: string }>(`SELECT status FROM processing_job WHERE kind = 'process_source_version' ORDER BY created_at DESC LIMIT 1`)!;
    expect(job.status).toBe('completed');
    expect(counts(t)).toEqual(before);
    // occurrence locations now point at the NEW regions of page 1
    const occ = t.ctx.db.all<{ region_ids_json: string }>('SELECT region_ids_json FROM question_occurrence WHERE source_version_id = ?', [qs.versionId]);
    const ids = occ.flatMap((o) => JSON.parse(o.region_ids_json) as string[]);
    const missing = ids.filter((rid) => !t.ctx.db.get('SELECT 1 AS x FROM source_region WHERE id = ?', [rid]));
    expect(missing).toEqual([]);
  });

  it('owner corrections create a new version and are never overwritten by re-extraction', async () => {
    const id = questionAt(t, qs.sourceId, 'B', '1');
    const before = await detail(t, id);
    const res = await api(t).patch(`/api/questions/${id}`, {
      options: before.question.current.options.map((o) => ({ option_key: o.option_key, source_label: o.source_label, text: o.option_key === 'o4' ? "Rovsing's sign (RIF pain on LIF pressure)" : o.text.paragraphs[0]!.runs.map((r) => r.t).join('') })),
      note: 'توضيح الخيار D',
    });
    expect(res.statusCode).toBe(200);
    const corrected = (res.json() as QuestionMutationResponse).question.current;
    expect(corrected.kind).toBe('owner_correction');
    expect(corrected.version_no).toBe(before.question.current.version_no + 1);
    expect(corrected.owner_reviewed_fields).toContain('options');
    // the key (source) still points at the same stable option
    expect(correctTexts((res.json() as QuestionMutationResponse).question)).toEqual(["Murphy's sign"]);
    await api(t).post('/api/questions/extract', { version_id: qs.versionId });
    await t.ctx.jobs.drain();
    const after = await detail(t, id);
    expect(after.question.current.id).toBe(corrected.id);
    expect(after.versions.find((v) => v.id === before.question.current.id)?.options.find((o) => o.option_key === 'o4')?.text.paragraphs[0]!.runs.map((r) => r.t).join('')).toBe("Rovsing's sign");
  });

  it('AC-26: a key correction keeps past attempts on their version, reports the impact, raises an alert, never re-grades', async () => {
    const id = questionAt(t, qs.sourceId, 'A', '3');
    const d = await detail(t, id);
    const v = d.question.current;
    const optB = v.options.find((o) => o.source_label === 'B')!;
    const optA = v.options.find((o) => o.source_label === 'A')!;
    const now = t.ctx.clock.now();
    const attemptId = newId(now);
    t.ctx.db.run(
      `INSERT INTO question_attempt (id, question_id, question_version_id, selected_option_ids_json, is_correct, scored, answered_at, created_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
      [attemptId, id, v.id, JSON.stringify([optB.id]), now, now],
    );
    // an owner text edit on an attempted version → new version, attempt untouched
    const res = await api(t).post(`/api/questions/${id}/key`, { option_keys: [optA.option_key], reason: 'اختبار أثر التصحيح' });
    expect(res.statusCode).toBe(200);
    const m = res.json() as QuestionMutationResponse;
    expect(m.new_version_id).not.toBe(v.id);
    expect(m.impact).toMatchObject({ attempts_total: 1, would_change: 1 });
    expect(m.impact!.attempts[0]).toMatchObject({ attempt_id: attemptId, version_id: v.id, was_correct: true, would_be_correct: false });
    const attempt = t.ctx.db.get<{ question_version_id: string; is_correct: number }>('SELECT question_version_id, is_correct FROM question_attempt WHERE id = ?', [attemptId])!;
    expect(attempt).toEqual({ question_version_id: v.id, is_correct: 1 });
    const alert = t.ctx.db.get<{ kind: string; severity: string; affected_json: string; summary: string }>('SELECT kind, severity, affected_json, summary FROM content_alert WHERE id = ?', [m.impact!.content_alert_id])!;
    expect(alert.kind).toBe('key_corrected');
    expect(alert.severity).toBe('answer_change');
    expect(alert.affected_json).toContain(attemptId);
    expect(alert.summary).toContain('لم يُعَد تقييم');
    const after = await detail(t, id);
    expect(after.question.current.answer_status).toBe('owner_key');
    expect(after.attempts_by_version[v.id]).toBe(1);
    expect(after.versions.find((x) => x.id === v.id)?.correct_option_ids).toEqual([optB.id]);
    // the old version is immutable: a PATCH creates yet another version
    const p = await api(t).patch(`/api/questions/${id}`, { stem: 'A 30-year-old woman of reproductive age presents with right iliac fossa pain. Which investigation should be performed first to exclude an important differential diagnosis?', learning_objective: 'Exclude ectopic pregnancy' });
    expect(p.statusCode).toBe(200);
    expect((await detail(t, id)).versions).toHaveLength(3);
  });

  it('review: reject retires the question (kept, not deleted); accept records the reviewed fields', async () => {
    const photoQ = (await listAll(t, `source_id=${photo.sourceId}`))[0]!.id;
    const acc = await api(t).post(`/api/questions/${photoQ}/review`, { decision: 'accept', reviewed_fields: ['stem', 'options'] });
    expect(acc.statusCode).toBe(409); // the OCR'd option is uncertain: the owner must look first
    const ok = await api(t).post(`/api/questions/${photoQ}/review`, { decision: 'accept', reviewed_fields: ['stem', 'options', 'images'], acknowledge_blockers: true });
    expect(ok.statusCode).toBe(200);
    const d = await detail(t, photoQ);
    expect(d.question.current.extraction_status).toBe('owner_reviewed');
    expect(d.question.current.owner_reviewed_fields).toEqual(expect.arrayContaining(['stem', 'options', 'images']));
    expect(d.question.current.answer_status).toBe('missing_key'); // reviewing text never invents a key
    const rej = await api(t).post(`/api/questions/${photoQ}/review`, { decision: 'reject', reason: 'صورة مكررة' });
    expect(rej.statusCode).toBe(200);
    expect((await detail(t, photoQ)).question.status).toBe('retired');
    expect((await listAll(t, `source_id=${photo.sourceId}`)).length).toBe(0);
    expect((await listAll(t, `source_id=${photo.sourceId}&status=retired`)).length).toBe(1);
  });
});

describe('quick add text, search, filters and auth', () => {
  it('quick add text → owner question with an OWNER key (never a source key)', async () => {
    const res = await api(t).post('/api/questions/quick-add', { text: '12. Which nerve supplies the diaphragm?\nA. Vagus\nB. Phrenic\nC. Intercostal', key_label: 'B', course_node_id: course1 });
    expect(res.statusCode).toBe(200);
    const qa = res.json() as QuickAddResponse;
    const d = await detail(t, qa.question_id!);
    expect(d.question.origin_type).toBe('owner');
    expect(d.question.origin_label_ar).toBe('سؤال أضفته بنفسك');
    expect(d.question.current.answer_status).toBe('owner_key');
    expect(correctTexts(d.question)).toEqual(['Phrenic']);
    expect(d.question.occurrences).toHaveLength(0);
    expect((await api(t).post('/api/questions/quick-add', { text: '1. a?\nA. x\nB. y\n2. b?\nA. x\nB. y' })).statusCode).toBe(400);
    expect((await api(t).post('/api/questions/quick-add', { text: '1. a?\nA. x\nB. y', key_label: 'D' })).statusCode).toBe(400);
  });

  it('list filters and normalized search', async () => {
    const missing = await listAll(t, 'answer_status=missing_key');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((i) => i.answer_status === 'missing_key')).toBe(true);
    const neg = await listAll(t, `q=${encodeURIComponent('Alvarado')}`);
    expect(neg.map((i) => i.stem_preview).join(' ')).toContain('Alvarado');
    const ar = await listAll(t, `q=${encodeURIComponent('المراره')}`);
    expect(ar.length).toBe(1);
    const linked = await listAll(t, 'relation=directly_covered');
    expect(linked.length).toBeGreaterThanOrEqual(4);
  });

  it('every route needs the owner session; mutations need the CSRF header', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/questions' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: `/api/questions/for-lecture/${qs.sourceId}` })).statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/questions/quick-add', headers: { cookie: t.h.cookie }, payload: { text: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await api(t).get('/api/questions/does-not-exist')).statusCode).toBe(404);
    const caps = (await api(t).get('/api/capabilities')).json();
    expect(caps.features['questions.vault'].state).toBe('available');
    expect(caps.features['questions.extraction'].state).toBe('available');
    expect(caps.features['questions.matching'].state).toBe('available');
  });
});
