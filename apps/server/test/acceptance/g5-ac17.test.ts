// G5 — AC-17 «عدم تكرار السؤال»: the same question in two files appears ONCE in an exam and keeps both places where it
// appears; two versions that differ medically are never merged. REAL pipeline (upload → processing → questions hook →
// extraction): the Golden Set question source + previous exam, and the G5 «signs» banks — the same three questions in
// two files where Q1 differs only by the sign of a value («−8», U+2212, vs «8») and Q2 only by «♀» vs «♂»; Q3 is the
// Golden Set's A1 word for word in both (the true exact duplicate).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprint } from '../../src/modules/questions/text';
import { api, createNode, detail, golden, questionAt, uploadAndProcess, type QApp } from '../questions/helpers';
import { acceptanceFixture, appWith, exam, feedback, finishExam, plain } from './g5-helpers';

let t: QApp;
let course: string;
let qs: { sourceId: string; versionId: string };
let prev: { sourceId: string; versionId: string };
let sa: { sourceId: string; versionId: string };
let sb: { sourceId: string; versionId: string };

beforeAll(async () => {
  t = await appWith(null);
  course = (await createNode(t, 'Surgery Course 1')).id;
  qs = await uploadAndProcess(t, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Surgery Course 1 Questions');
  prev = await uploadAndProcess(t, course, 'questions_previous_exam_2024.pdf', golden('questions_previous_exam_2024.pdf'), 'previous_exam', 'Previous exam 2024');
  sa = await uploadAndProcess(t, course, 'g5_signs_a.pdf', acceptanceFixture('g5_signs_a.pdf'), 'question_source', 'Signs bank A');
  sb = await uploadAndProcess(t, course, 'g5_signs_b.pdf', acceptanceFixture('g5_signs_b.pdf'), 'previous_exam', 'Signs exam B');
}, 300_000);

afterAll(async () => {
  await t?.close();
});

describe('AC-17: one question, every occurrence kept', () => {
  it('the Golden A1 printed in FOUR files is one question with four occurrences (file, page, number each)', async () => {
    const a1 = questionAt(t, qs.sourceId, 'A', '1');
    expect(questionAt(t, prev.sourceId, '', '1')).toBe(a1);
    expect(questionAt(t, sa.sourceId, '', '3')).toBe(a1);
    expect(questionAt(t, sb.sourceId, '', '3')).toBe(a1);
    const d = await detail(t, a1);
    expect(d.question.origin_type).toBe('source');
    expect(d.question.occurrences.map((o) => o.source_id).sort()).toEqual([qs.sourceId, prev.sourceId, sa.sourceId, sb.sourceId].sort());
    const labels = d.question.occurrences.map((o) => o.origin_label_ar);
    expect(labels).toContain('سؤال من مصدر الأسئلة — Surgery Course 1 Questions — ص 1 — رقم السؤال 1 (Section A)');
    expect(labels).toContain('سؤال من مصدر الأسئلة — Previous exam 2024 — ص 1 — رقم السؤال 1');
    expect(labels).toContain('سؤال من مصدر الأسئلة — Signs bank A — ص 1 — رقم السؤال 3');
    expect(labels).toContain('سؤال من مصدر الأسئلة — Signs exam B — ص 1 — رقم السؤال 3');
    for (const o of d.question.occurrences) expect(o.pages.length).toBeGreaterThan(0);
    // the four printed keys agree → one source key, nothing conflicting
    expect(d.question.current.answer_status).toBe('source_key');
  });

  it('an assessed exam over the four files shows it ONCE; after finishing, its feedback lists all four occurrences', async () => {
    const a1 = questionAt(t, qs.sourceId, 'A', '1');
    const s = await exam(t, { mode: 'exam', count: 50, source_ids: [qs.sourceId, prev.sourceId, sa.sourceId, sb.sourceId], seed: 'g5-ac17' });
    const ids = s.items.map((i) => i.question_id);
    expect(ids.filter((id) => id === a1)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    const i1 = s.items.find((i) => i.question_id === a1)!;
    // during the exam: no file name, no page, no feedback (AC-19)
    expect(JSON.stringify(i1)).not.toMatch(/Signs|Previous exam|Surgery Course 1 Questions|ص 1/);
    expect((await feedback(t, s.attempt.id, i1.index)).status).toBe(409);

    await finishExam(t, s, (it) => (it.question_id === a1 ? "McBurney's point" : null));
    const fb = await feedback(t, s.attempt.id, i1.index);
    expect(fb.status).toBe(200);
    expect(fb.body.is_correct).toBe(true);
    expect(fb.body.occurrences).toHaveLength(4);
    expect(fb.body.occurrences.map((o) => o.source_title).sort()).toEqual(['Previous exam 2024', 'Signs bank A', 'Signs exam B', 'Surgery Course 1 Questions']);
    for (const o of fb.body.occurrences) {
      expect(o.origin_label_ar).toMatch(/^سؤال من مصدر الأسئلة — .+ — ص 1 — رقم السؤال (1|3)/);
      expect(o.pages[0]!.page_id).toBeTruthy();
    }
  });

  it('a third copy of a file (identical bytes, kept as a separate source) attaches again — still one question per item', async () => {
    const again = await uploadAndProcess(t, course, 'g5_signs_a.pdf', acceptanceFixture('g5_signs_a.pdf'), 'question_source', 'Signs bank A (copy)');
    for (const n of ['1', '2', '3']) expect(questionAt(t, again.sourceId, '', n)).toBe(questionAt(t, sa.sourceId, '', n));
    const be = await detail(t, questionAt(t, sa.sourceId, '', '1'));
    expect(be.question.occurrences.map((o) => o.source_id).sort()).toEqual([sa.sourceId, again.sourceId].sort());
    expect(be.question.current.answer_status).toBe('source_key');
  });
});

describe('AC-17: medically different versions are never merged', () => {
  it('«base excess −8» (U+2212) vs «base excess 8» → two questions, each with its own key', async () => {
    const minus = questionAt(t, sa.sourceId, '', '1');
    const plus = questionAt(t, sb.sourceId, '', '1');
    expect(minus).not.toBe(plus);
    const dm = await detail(t, minus);
    const dp = await detail(t, plus);
    expect(plain(dm.question.current.stem)).toContain('−8 mmol/L');
    expect(plain(dp.question.current.stem)).toContain('base excess of 8 mmol/L');
    // never a «conflicting key» born from a wrong merge: each file's key stands for its own question
    expect(dm.question.current.answer_status).toBe('source_key');
    expect(dp.question.current.answer_status).toBe('source_key');
    const keyText = (d: typeof dm) => d.question.current.options.filter((o) => d.question.current.correct_option_ids?.includes(o.id)).map((o) => plain(o.text));
    expect(keyText(dm)).toEqual(['Metabolic acidosis']);
    expect(keyText(dp)).toEqual(['Metabolic alkalosis']);
    expect(dm.question.occurrences.map((o) => o.source_id)).not.toContain(sb.sourceId);
    // if they are offered as similar, it is a SUGGESTION for the owner, never an automatic confirmation
    for (const dup of dm.question.duplicates.filter((x) => x.other_question_id === plus)) expect(dup.status).toBe('suggested');
  });

  it('«♀» vs «♂» → two questions, each with its own key', async () => {
    const female = questionAt(t, sa.sourceId, '', '2');
    const male = questionAt(t, sb.sourceId, '', '2');
    expect(female).not.toBe(male);
    const df = await detail(t, female);
    const dm = await detail(t, male);
    expect(plain(df.question.current.stem)).toContain('♀');
    expect(plain(dm.question.current.stem)).toContain('♂');
    expect(df.question.current.answer_status).toBe('source_key');
    expect(dm.question.current.answer_status).toBe('source_key');
  });

  it('an exam over both files includes BOTH different versions (they are not the same question)', async () => {
    const s = await exam(t, { mode: 'exam', count: 50, source_ids: [sa.sourceId, sb.sourceId], seed: 'g5-ac17-signs' });
    const ids = s.items.map((i) => i.question_id);
    for (const [f, n] of [[sa, '1'], [sb, '1'], [sa, '2'], [sb, '2']] as const) expect(ids).toContain(questionAt(t, f.sourceId, '', n));
    expect(ids.filter((id) => id === questionAt(t, sa.sourceId, '', '3'))).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the exact-duplicate identity keeps sign, sex and direction, but not formatting', () => {
    const fp = (stem: string, opts = ['Metabolic acidosis', 'Metabolic alkalosis']) => fingerprint(stem, opts);
    const differ: Array<[string, string]> = [
      ['Base excess −8 mmol/L. Which?', 'Base excess 8 mmol/L. Which?'],
      ['Base excess –8 mmol/L. Which?', 'Base excess 8 mmol/L. Which?'],
      ['A 24-year-old ♀ with RIF pain. Next?', 'A 24-year-old ♂ with RIF pain. Next?'],
      ['Pain radiates A → B. Which?', 'Pain radiates A ← B. Which?'],
      ['HCO₃⁻ 15 mmol/L. Which?', 'HCO₃ 15 mmol/L. Which?'],
      ['HIV –ve mother. Which?', 'HIV ve mother. Which?'],
    ];
    for (const [a, b] of differ) expect(fp(a), `${a} | ${b}`).not.toBe(fp(b));
    expect(fingerprint('Which value?', ['−2', '0', '+2'])).not.toBe(fingerprint('Which value?', ['2', '0', '+2']));
    const same: Array<[string, string]> = [
      ['Base excess −8 mmol/L. Which?', 'Base excess -8 mmol/L. Which?'],
      ['HCO₃⁻ 15 mmol/L. Which?', 'HCO₃− 15 mmol/L. Which?'],
      ['A dose of 5–10 mg/kg. Which?', 'A dose of 5–10 mg/kg. Which?'],
      ['Which point is classically tender?', 'Which  point is classically tender'],
      ['A 24-year-old ♀ with pain. Next?', 'A 24-year-old female with pain. Next?'],
    ];
    for (const [a, b] of same) expect(fp(a), `${a} | ${b}`).toBe(fp(b));
  });
});

describe('AC-17: the vault lists each version separately, the API agrees', () => {
  it('question list filtered by each signs file shows three questions, two of them different between the files', async () => {
    const list = async (src: string) => ((await api(t).get(`/api/questions?source_id=${src}&limit=50`)).json() as { items: Array<{ id: string }> }).items.map((i) => i.id).sort();
    const a = await list(sa.sourceId);
    const b = await list(sb.sourceId);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    expect(a.filter((id) => b.includes(id))).toEqual([questionAt(t, sa.sourceId, '', '3')]);
  });
});
