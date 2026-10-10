// G4 / AC-10 — a question that runs over two pages with its options at the BOTTOM of the second page is extracted
// COMPLETELY, with all options and its original locations. REAL pipeline (upload → pdf.js/poppler processing → hook →
// extract_questions) on derived fixtures (fixtures/acceptance/make_g4_fixtures.py):
//   * g4_long_questions.pdf (exact layout): Q2's stem starts at the bottom of page 1 and stops mid-sentence («… his
//     temperature is»); page 2 continues with a VALUE at the line start («38.4 °C, …», must not become question 38), a
//     large blank gap, then five options at the very bottom; Q3's options are split over pages 3 and 4; running header
//     and page numbers on every page (never glued into the question).
//   * g4_long_question_ar.pdf (Word → LibreOffice, RTL): the same in Arabic, «11.5 ×10⁹/L» inside the Arabic sentence.
// Also: the question is delivered whole in practice (all options), its origin label names both pages, the original
// view highlights a region on each page, and re-extraction is idempotent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { richTextToPlain, type AttemptFeedbackView, type ExamCreateResponse, type QuestionOriginalView } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import { newId } from '../../src/lib/ids';
import { api, counts, createNode, createQuestionsApp, detail, listAll, questionAt, uploadAndProcess, type QApp } from '../questions/helpers';

const ACC = join(REPO_ROOT, 'fixtures', 'acceptance');
const fixture = (name: string) => readFileSync(join(ACC, name));
const plain = (rt: Parameters<typeof richTextToPlain>[0]) => richTextToPlain(rt);

let t: QApp;
let en: { sourceId: string; versionId: string };
let ar: { sourceId: string; versionId: string };

beforeAll(async () => {
  t = await createQuestionsApp();
  const course = (await createNode(t, 'G4 AC-10 course')).id;
  en = await uploadAndProcess(t, course, 'g4_long_questions.pdf', fixture('g4_long_questions.pdf'), 'question_source', 'G4 long questions');
  ar = await uploadAndProcess(t, course, 'g4_long_question_ar.pdf', fixture('g4_long_question_ar.pdf'), 'question_source', 'G4 Arabic long question');
}, 300_000);
afterAll(async () => {
  await t?.close();
});

describe('G4 AC-10 — a question over two pages, options at the bottom of the second page', () => {
  it('EN: Q2 is ONE question with its whole stem (both pages) and all five options, nothing from the header/footer', async () => {
    const items = await listAll(t, `source_id=${en.sourceId}`);
    expect(items).toHaveLength(3);
    // «38.4 °C» at the top of page 2 is a value, not question 38
    expect(t.ctx.db.all('SELECT 1 AS x FROM question_occurrence WHERE source_id = ? AND printed_number = ?', [en.sourceId, '38'])).toHaveLength(0);
    const d = await detail(t, questionAt(t, en.sourceId, '', '2'));
    const v = d.question.current;
    const stem = plain(v.stem);
    expect(stem).toContain('A 58-year-old man is brought to the emergency department');
    expect(stem).toContain('On examination his temperature is');
    expect(stem).toContain('38.4 °C, his blood pressure is 90/60 mmHg and his pulse is 118/min.');
    expect(stem).toMatch(/Which of the following is NOT part of the initial management\?$/);
    expect(stem).not.toMatch(/TEST FIXTURE|G4 Long Question Bank/); // running header never glued in
    expect(v.options.map((o) => [o.source_label, plain(o.text)])).toEqual([
      ['A', 'Intravenous crystalloid fluids'],
      ['B', 'Adequate analgesia'],
      ['C', 'Oxygen if hypoxic'],
      ['D', 'Routine prophylactic antibiotics'],
      ['E', 'Hourly urine output monitoring'],
    ]);
    expect(v.options.map((o) => o.option_key)).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
    expect(v.negation_terms).toEqual(['NOT']);
    expect(v.extraction_status).toBe('checks_passed');
    expect(v.validation!.issues.filter((i) => !i.passed && i.severity === 'blocker')).toEqual([]);
    // the key printed at the end of the file binds to this question (D), so it is scorable
    expect(v.answer_status).toBe('source_key');
    expect(v.options.filter((o) => v.correct_option_ids?.includes(o.id)).map((o) => o.source_label)).toEqual(['D']);
    expect(d.scorable).toBe(true);
  });

  it('EN: its original location is both pages — label «ص 1–2», a highlighted region on each page, the options at the bottom of page 2', async () => {
    const id = questionAt(t, en.sourceId, '', '2');
    const d = await detail(t, id);
    const occ = d.question.occurrences[0]!;
    expect(occ.pages.map((p) => p.page_index)).toEqual([0, 1]);
    expect(occ.origin_label_ar).toBe('سؤال من مصدر الأسئلة — G4 long questions — ص 1–2 — رقم السؤال 2');
    const orig = (await api(t).get(`/api/questions/${id}/original`)).json() as QuestionOriginalView;
    expect(orig.pages.map((p) => p.page_index)).toEqual([0, 1]);
    expect(orig.pages.every((p) => p.boxes.length > 0)).toBe(true);
    // page 1: the stem's first lines near the bottom; page 2: down to the options at the bottom
    const bottom = (p: QuestionOriginalView['pages'][number]) => Math.max(...p.boxes.map((b) => b.bbox.y + b.bbox.h));
    expect(bottom(orig.pages[0]!)).toBeGreaterThan(0.7);
    expect(bottom(orig.pages[1]!)).toBeGreaterThan(0.7);
    expect(orig.raw_text).toContain('E. Hourly urine output monitoring');
    expect(orig.raw_text).toContain('On examination his temperature is');
    // every option keeps the region it was printed in (jump to the exact place)
    expect(d.question.current.options.every((o) => o.region_id !== null)).toBe(true);
  });

  it('EN: options split over two pages (Q3: A–B at the bottom of page 3, C–D on page 4) — all four, key bound', async () => {
    const d = await detail(t, questionAt(t, en.sourceId, '', '3'));
    expect(d.question.occurrences[0]!.pages.map((p) => p.page_index)).toEqual([2, 3]);
    expect(d.question.current.options.map((o) => plain(o.text))).toEqual(['Plain abdominal X-ray', 'Ultrasound of the abdomen', 'MRCP', 'CT of the abdomen']);
    expect(d.question.current.answer_status).toBe('source_key');
    expect(d.question.current.extraction_status).toBe('checks_passed');
  });

  it('AR: an Arabic stem over a page break with «11.5 ×10⁹/L» in logical order, five Arabic options after a large gap, «عدا» kept', async () => {
    const d = await detail(t, questionAt(t, ar.sourceId, '', '2'));
    const v = d.question.current;
    const pages = d.question.occurrences[0]!.pages.map((p) => p.page_index);
    expect(pages[0]).toBe(0);
    expect(pages).toContain(1);
    const stem = plain(v.stem);
    expect(stem).toContain('امرأة عمرها 30 سنة تراجع بألم في الحفرة الحرقفية اليمنى منذ 12 ساعة');
    expect(stem).toContain('11.5 ×10⁹/L. جميع ما يلي مناسب في التقييم الأولي عدا:');
    expect(v.options.map((o) => o.source_label)).toEqual(['أ', 'ب', 'ج', 'د', 'هـ']);
    expect(v.options.map((o) => plain(o.text))).toEqual(['اختبار الحمل', 'تعداد الدم الكامل', 'حقنة الباريوم الشرجية', 'فحص البول', 'الأمواج فوق الصوتية']);
    expect(v.negation_terms).toEqual(['عدا']);
    expect(v.stem.paragraphs.flatMap((p) => p.runs).filter((r) => r.marks?.includes('em')).map((r) => r.t)).toEqual(['عدا']);
    expect(v.answer_status).toBe('source_key');
    expect(v.options.filter((o) => v.correct_option_ids?.includes(o.id)).map((o) => o.source_label)).toEqual(['ج']);
    expect(v.extraction_status).toBe('checks_passed');
  });

  it('practice delivers the whole question (stem from both pages, all five options) and grades it with the bound key', async () => {
    const id = questionAt(t, en.sourceId, '', '2');
    const res = await api(t).post('/api/exams', { title: '', mode: 'practice', count: 1, question_ids: [id] });
    expect(res.statusCode, res.body).toBe(200);
    const s = (res.json() as ExamCreateResponse).session;
    const item = s.items[0]!;
    expect(item.options).toHaveLength(5);
    expect(plain(item.stem)).toContain('On examination his temperature is');
    expect(plain(item.stem)).toContain('Which of the following is NOT part of the initial management?');
    expect(item.has_negation).toBe(true);
    const right = item.options.find((o) => plain(o.text) === 'Routine prophylactic antibiotics')!;
    const fb = (await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [right.id], confidence: 'confident', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb.is_correct).toBe(true);
    expect(fb.origin_label_ar).toContain('ص 1–2');
  });

  it('re-extraction is idempotent: the same question, pages and options — nothing duplicated', async () => {
    const before = counts(t);
    const id = questionAt(t, en.sourceId, '', '2');
    const res = await api(t).post('/api/questions/extract', { version_id: en.versionId });
    expect(res.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const after = counts(t);
    expect(after.questions).toBe(before.questions);
    expect(after.occurrences).toBe(before.occurrences);
    expect(questionAt(t, en.sourceId, '', '2')).toBe(id);
    const d = await detail(t, id);
    expect(d.question.occurrences[0]!.pages.map((p) => p.page_index)).toEqual([0, 1]);
    expect(d.question.current.options).toHaveLength(5);
  });
});
