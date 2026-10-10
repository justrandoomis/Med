// G4 / AC-12 — a file with two (or more) sections that BOTH start at question 1, and a key per section: each section's
// key binds to its own questions only — never by number alone, never across sections. REAL pipeline on derived fixtures
// (fixtures/acceptance/make_g4_fixtures.py) + parser unit regressions for the defects found and fixed this round:
//   1. per-section key lines merged into ONE region by the layout («Section B: 1. C 2. B 3. A Section A: 1. B 2. D 4. A»)
//      were dropped WHOLE: every question stayed «no key» although the file prints a key per section (parser.ts
//      splitSectionKeyRuns; a long «Section N: …» key run is also accepted as a header now);
//   2. keys printed «Q1: B Q2: D» / «Question 1: B» / «1 → B» / «1 = B» / «س1: ب» were not read; «Q1: B Q2: D» even became
//      a bogus question «B Q2: D» while the real questions read «no key» (parser.ts KEY_PAIR);
//   3. a key under an answer-key heading in a layout that still cannot be read was dropped SILENTLY → now reported to the
//      owner (review item + extraction summary), never guessed (parser.ts unreadKeyLines, extract.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { richTextToPlain, type AttemptFeedbackView, type ExamCreateResponse, type ExtractionSummaryView, type ReviewQueueResponse } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import { newId } from '../../src/lib/ids';
import { parseQuestions, splitSectionKeyRuns, type ParserLine } from '../../src/modules/questions/parser';
import { api, correctTexts, createNode, createQuestionsApp, detail, listAll, questionAt, uploadAndProcess, type QApp } from '../questions/helpers';

const ACC = join(REPO_ROOT, 'fixtures', 'acceptance');
const fixture = (name: string) => readFileSync(join(ACC, name));
const plain = (rt: Parameters<typeof richTextToPlain>[0]) => richTextToPlain(rt);

let seq = 0;
const line = (text: string): ParserLine => ({ text, regionId: `r${++seq}`, regionKind: 'paragraph', pageIndex: 0, pageId: 'p0', bbox: null, regionStatus: 'extracted', confidence: null, textOrigin: 'digital' });
const Q = ['1. Which vitamin deficiency causes scurvy?', 'A. Vitamin A', 'B. Vitamin C', 'C. Vitamin D', 'D. Vitamin K', '2. Which organ produces insulin?', 'A. Liver', 'B. Spleen', 'C. Pancreas', 'D. Kidney'];

describe('G4 AC-12 — parser regressions', () => {
  it('splits several section-labelled key runs printed on one line (EN and AR); leaves anything else alone', () => {
    expect(splitSectionKeyRuns('Section B: 1. C 2. B 3. A Section A: 1. B 2. D 4. A')).toEqual(['Section B: 1. C 2. B 3. A', 'Section A: 1. B 2. D 4. A']);
    expect(splitSectionKeyRuns('Answer Key: Part 2 - 1-C 2-B Part 1 - 1-B 2-D')).toEqual(['Answer Key:', 'Part 2 - 1-C 2-B', 'Part 1 - 1-B 2-D']);
    expect(splitSectionKeyRuns('القسم الثاني: 1. ج 2. ب القسم الأول: 1. ب 2. د')).toEqual(['القسم الثاني: 1. ج 2. ب', 'القسم الأول: 1. ب 2. د']);
    expect(splitSectionKeyRuns('Section A — Abdominal pain Section B — Biliary disease')).toEqual(['Section A — Abdominal pain Section B — Biliary disease']);
    expect(splitSectionKeyRuns('Section A: 1. B 2. C')).toEqual(['Section A: 1. B 2. C']);
  });

  it('a merged per-section key line binds each run to its own section (B listed first); a long key run is still a key', () => {
    const sections = ['Section A', ...Q, 'Section B', ...Q.map((x) => x.replace('scurvy', 'rickets').replace('insulin', 'glucagon'))];
    const r = parseQuestions([...sections, 'Answer Key', 'Section B: 1. D 2. C Section A: 1. B 2. C'].map(line));
    expect(r.questions).toHaveLength(4);
    expect(r.keys.map((k) => `${k.sectionLabel}${k.printedNumber}=${k.keyLabel}`).sort()).toEqual(['A1=B', 'A2=C', 'B1=D', 'B2=C']);
    const long = `Section A: ${Array.from({ length: 30 }, (_, i) => `${i + 1}. ${'ABCD'[i % 4]}`).join(' ')}`;
    expect(long.length).toBeGreaterThan(90);
    const r2 = parseQuestions([...Q, 'Answer Key', long].map(line));
    expect(r2.keys.filter((k) => k.sectionLabel === 'A')).toHaveLength(30);
  });

  it('reads «Q1: B», «Question 1: B», «1 → B», «1 = B», «س1: ب»; never turns a key line into a question', () => {
    for (const keyLines of [['Answer Key', 'Q1: B Q2: C'], ['Answer Key', 'Question 1: B', 'Question 2: C'], ['Answer Key', '1 → B, 2 → C'], ['Answer Key', '1 = B 2 = C'], ['Answers', 'Q1 B, Q2 C']]) {
      const r = parseQuestions([...Q, ...keyLines].map(line));
      expect(r.questions, keyLines.join(' | ')).toHaveLength(2);
      expect(r.keys.map((k) => `${k.printedNumber}=${k.keyLabel}`), keyLines.join(' | ')).toEqual(['1=B', '2=C']);
    }
    const ar = parseQuestions([...Q, 'الإجابات', 'س1: ب س2: ج'].map(line));
    expect(ar.keys.map((k) => `${k.printedNumber}=${k.keyLabel}`)).toEqual(['1=ب', '2=ج']);
  });

  it('a key line in an unreadable layout is REPORTED (not a question, not a guessed key); a real question after a key heading still parses', () => {
    const r = parseQuestions([...Q, 'Answer Key', '1 ➜ B 2 ➜ C'].map(line));
    expect(r.questions).toHaveLength(2);
    expect(r.keys).toHaveLength(0);
    expect(r.unreadKeyLines?.map((u) => u.text)).toEqual(['1 ➜ B 2 ➜ C']);
    const r2 = parseQuestions(['Answers', '1. Which nerve supplies the diaphragm?', 'A. Vagus', 'B. Phrenic'].map(line));
    expect(r2.unreadKeyLines).toEqual([]);
    expect(r2.questions).toHaveLength(1);
  });
});

let t: QApp;
let merged: { sourceId: string; versionId: string };
let arabic: { sourceId: string; versionId: string };
let formats: { sourceId: string; versionId: string };
let inline: { sourceId: string; versionId: string };

beforeAll(async () => {
  t = await createQuestionsApp();
  const course = (await createNode(t, 'G4 AC-12 course')).id;
  merged = await uploadAndProcess(t, course, 'g4_sections_merged_key.pdf', fixture('g4_sections_merged_key.pdf'), 'question_source', 'G4 sections');
  arabic = await uploadAndProcess(t, course, 'g4_sections_ar.pdf', fixture('g4_sections_ar.pdf'), 'question_source', 'G4 أقسام');
  formats = await uploadAndProcess(t, course, 'g4_key_formats.pdf', fixture('g4_key_formats.pdf'), 'question_source', 'G4 key formats');
  inline = await uploadAndProcess(t, course, 'g4_sections_inline_keys.pdf', fixture('g4_sections_inline_keys.pdf'), 'question_source', 'G4 inline keys');
}, 300_000);
afterAll(async () => {
  await t?.close();
});

/** every BOUND key entry belongs to an occurrence of the SAME section and number (no cross-binding anywhere) */
function crossBindings(versionId: string) {
  return t.ctx.db.all<{ k: string }>(
    `SELECT e.section_key || '/' || e.printed_number || '→' || o.section_key || '/' || o.printed_number AS k
       FROM answer_key_entry e JOIN question_occurrence o ON o.id = e.matched_occurrence_id
      WHERE e.source_version_id = ? AND e.binding = 'bound' AND (e.section_key <> o.section_key OR e.printed_number <> o.printed_number)`,
    [versionId],
  );
}

describe('G4 AC-12 — sections that restart at 1, a key per section, no cross-binding', () => {
  it('three sections all numbered from 1; the key lists Section B first, merged into one line by the layout → each binds to its own section', async () => {
    expect(await listAll(t, `source_id=${merged.sourceId}`)).toHaveLength(6);
    const key = async (s: string, n: string) => correctTexts((await detail(t, questionAt(t, merged.sourceId, s, n))).question);
    expect(await key('A', '1')).toEqual(['Vitamin C']);
    expect(await key('A', '2')).toEqual(['Vitamin E']);
    expect(await key('B', '1')).toEqual(['Pancreas']);
    expect(await key('B', '2')).toEqual(['Glucagon']);
    expect(await key('B', '3')).toEqual(['Alpha cells']);
    expect(crossBindings(merged.versionId)).toEqual([]);
    const summary = (await api(t).get(`/api/questions/extractions/${merged.versionId}`)).json().summary as ExtractionSummaryView;
    expect(summary.keys_bound).toBe(5);
  });

  it('Section C has no key: it stays «no key» (never borrows question 1 of A or B); «Section A: 4. A» has no question → unbound with a reason', async () => {
    const c1 = await detail(t, questionAt(t, merged.sourceId, 'C', '1'));
    expect(c1.question.current.answer_status).toBe('missing_key');
    expect(c1.key_entries).toEqual([]);
    expect(c1.scorable).toBe(false);
    const a4 = t.ctx.db.get<{ binding: string; matched_occurrence_id: string | null }>(
      `SELECT binding, matched_occurrence_id FROM answer_key_entry WHERE source_version_id = ? AND section_key = 'A' AND printed_number = '4'`,
      [merged.versionId],
    )!;
    expect(a4).toEqual({ binding: 'no_matching_question', matched_occurrence_id: null });
    const rq = (await api(t).get(`/api/questions/review-queue?source_id=${merged.sourceId}`)).json() as ReviewQueueResponse;
    expect(rq.items.some((i) => /القسم A — السؤال 4/.test(i.reason) && /لا يقابله سؤال/.test(i.reason))).toBe(true);
  });

  it('origin labels tell the two «question 1» apart (section shown), and practice grades B1 with SECTION B\'s key', async () => {
    const a1 = await detail(t, questionAt(t, merged.sourceId, 'A', '1'));
    const b1Id = questionAt(t, merged.sourceId, 'B', '1');
    const b1 = await detail(t, b1Id);
    expect(a1.question.occurrences[0]!.origin_label_ar).toContain('رقم السؤال 1 (Section A)');
    expect(b1.question.occurrences[0]!.origin_label_ar).toContain('رقم السؤال 1 (Section B)');
    const s = ((await api(t).post('/api/exams', { title: '', mode: 'practice', count: 1, question_ids: [b1Id] })).json() as ExamCreateResponse).session;
    const item = s.items[0]!;
    // the letter of Section A's key for question 1 (B → «Spleen» in B1) is wrong for B1
    const spleen = item.options.find((o) => plain(o.text) === 'Spleen')!;
    const fb = (await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [spleen.id], confidence: 'confident', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb.is_correct).toBe(false);
    expect(fb.correct_option_ids).toEqual([item.options.find((o) => plain(o.text) === 'Pancreas')!.id]);
  });

  it('Arabic sections «القسم الأول / الثاني», key listing the second section first → bound per section', async () => {
    const key = async (s: string, n: string) => correctTexts((await detail(t, questionAt(t, arabic.sourceId, s, n))).question);
    expect(await key('1', '1')).toEqual(['فيتامين C']);
    expect(await key('1', '2')).toEqual(['فيتامين E']);
    expect(await key('2', '1')).toEqual(['البنكرياس']);
    expect(await key('2', '2')).toEqual(['الغلوكاغون']);
    expect(crossBindings(arabic.versionId)).toEqual([]);
    expect((await detail(t, questionAt(t, arabic.sourceId, '2', '1'))).question.occurrences[0]!.origin_label_ar).toContain('(القسم الثاني)');
  });

  it('«Q1: B Q2: D» is read as Part 1\'s key (no bogus question); Part 2\'s unreadable key is reported, and Part 2 never borrows Part 1\'s key', async () => {
    const items = await listAll(t, `source_id=${formats.sourceId}`);
    expect(items).toHaveLength(5);
    expect(correctTexts((await detail(t, questionAt(t, formats.sourceId, '1', '1'))).question)).toEqual(['Vitamin D']);
    expect(correctTexts((await detail(t, questionAt(t, formats.sourceId, '1', '2'))).question)).toEqual(['Vitamin K']);
    for (const n of ['1', '2', '3']) {
      const d = await detail(t, questionAt(t, formats.sourceId, '2', n));
      expect(d.question.current.answer_status, n).toBe('missing_key');
      expect(d.key_entries, n).toEqual([]);
    }
    const summary = (await api(t).get(`/api/questions/extractions/${formats.versionId}`)).json().summary as ExtractionSummaryView;
    expect(summary.status).toBe('needs_review');
    expect(summary.message_ar).toContain('سطر مفتاح لم تُقرأ صيغته');
    const rq = (await api(t).get(`/api/questions/review-queue?source_id=${formats.sourceId}`)).json() as ReviewQueueResponse;
    const unread = rq.items.find((i) => i.reason.includes('Q1 is C, Q2 is B, Q3 is A'));
    expect(unread?.reason).toMatch(/بصيغة لم تُقرأ/);
    expect(unread?.reason).toMatch(/تبقى الأسئلة «بلا مفتاح»/);
  });

  it('keys printed after EACH part: Part 1\'s binds to Part 1; Part 2\'s trailing unlabeled key stays unbound (review), never applied by number', async () => {
    expect(correctTexts((await detail(t, questionAt(t, inline.sourceId, '1', '1'))).question)).toEqual(['Phrenic']);
    expect(correctTexts((await detail(t, questionAt(t, inline.sourceId, '1', '2'))).question)).toEqual(['Left anterior descending']);
    for (const n of ['1', '2', '3']) expect((await detail(t, questionAt(t, inline.sourceId, '2', n))).question.current.answer_status, n).toBe('missing_key');
    expect(crossBindings(inline.versionId)).toEqual([]);
    const rq = (await api(t).get(`/api/questions/review-queue?source_id=${inline.sourceId}`)).json() as ReviewQueueResponse;
    expect(rq.items.filter((i) => i.kind === 'conflicting_key' && /بلا قسم محدد/.test(i.reason))).toHaveLength(3);
  });
});
