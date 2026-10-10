// G4 / AC-11 — NOT / EXCEPT and values with units are preserved exactly (no dropped negation, no changed decimal
// separator or unit); a failure blocks automatic approval. REAL pipeline on derived fixtures
// (fixtures/acceptance/make_g4_fixtures.py) plus unit regressions for the three defects this round found and fixed:
//   1. a superscript / subscript typed as a FONT EFFECT («10<sup>9</sup>», «PaCO<sub>2</sub>», Word / reportlab) was read as
//      plain digits: «11.5 × 10⁹/L» became «11.5 × 109/L» (a different value!) and «PaCO₂» became «PaCO» plus a stray «2»
//      paragraph glued to the stem — both stored as `checks_passed`, scorable (layout/lines.ts attachScripts);
//   2. «×» (U+00D7) was classified as a strong LATIN letter, so «11.5 ×10⁹/L.» inside an Arabic sentence was stored as
//      «11.5 L/10⁹× .» (processing/text.ts charDir);
//   3. the Arabic negation words are lam-alef ligatures: LibreOffice's text layer gives «ال» for «لا» and «إال» for «إلا».
//      «أي مما يلي ال يسبب …» lost its negation silently — no NOT/EXCEPT flag, no emphasis, `checks_passed`, scorable
//      (processing/text.ts fixReversedLamAlef: whole-word repair).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { richTextToPlain, type ExamCreateResponse, type QuestionMutationResponse } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import { attachScripts, buildSegments, logicalLineText } from '../../src/modules/processing/layout/lines';
import type { TextItem } from '../../src/modules/processing/layout/types';
import { charDir, fixReversedLamAlef, hasReversedLamAlef } from '../../src/modules/processing/text';
import { createVersion, listForExam } from '../../src/modules/questions/service';
import { api, createNode, createQuestionsApp, detail, questionAt, uploadAndProcess, type QApp } from '../questions/helpers';

const ACC = join(REPO_ROOT, 'fixtures', 'acceptance');
const fixture = (name: string) => readFileSync(join(ACC, name));
const plain = (rt: Parameters<typeof richTextToPlain>[0]) => richTextToPlain(rt);
const item = (text: string, x0: number, x1: number, top: number, bottom: number, size: number): TextItem => ({ text, x0, x1, top, bottom, size, bold: false });

describe('G4 AC-11 — unit regressions (processing)', () => {
  it('a raised / lowered smaller run is written as a Unicode super/subscript and stays on its line (reportlab geometry)', () => {
    // pdf.js items of «… white cell count of 11.5 × 10<super>9</super>/L:» and «… PaCO<sub>2</sub> 52 mmHg …»
    const sup = [item('of 11.5 × 10', 250, 339.5, 122.9, 134.1, 10), item('9', 339.5, 344, 119.8, 128.7, 8), item('/L:', 344, 355.1, 122.9, 134.1, 10)];
    expect(attachScripts(sup).map((i) => i.text)).toEqual(['of 11.5 × 10', '⁹', '/L:']);
    const [seg] = buildSegments(sup);
    expect(logicalLineText(seg!.items, 'ltr')).toBe('of 11.5 × 10⁹/L:');
    const sub = [item('shows pH 7.32 and PaCO', 150, 299.2, 182.9, 194.1, 10), item('2', 299.2, 303.7, 189.8, 198.7, 8), item('52 mmHg.', 306.4, 350, 182.9, 194.1, 10)];
    const segs = buildSegments(sub);
    expect(segs).toHaveLength(1); // before the fix the «2» fell on its own row → a separate paragraph
    expect(logicalLineText(segs[0]!.items, 'ltr')).toBe('shows pH 7.32 and PaCO₂ 52 mmHg.');
  });

  it('LibreOffice geometry (superscript top / subscript bottom on the host line) is recognized too; a smaller word on the same baseline is not', () => {
    const lo = [
      item('with PaCO', 90, 182.3, 145.5, 158.1, 11),
      item('2', 182.3, 185.3, 150.8, 158.2, 6.4),
      item('52 mmHg and HCO', 187.7, 272.9, 145.5, 158.1, 11),
      item('3', 272.9, 275.9, 150.8, 158.2, 6.4),
      item('−', 275.9, 279.4, 145.5, 152.9, 6.4),
    ];
    expect(logicalLineText(buildSegments(lo)[0]!.items, 'ltr')).toBe('with PaCO₂ 52 mmHg and HCO₃⁻');
    // same baseline (bottom 158.1 for both, the small run starts lower only by its smaller size) → ordinary text
    const smallCaps = [item('dose 5', 90, 130, 145.5, 158.1, 11), item('MG', 130, 140, 150.0, 158.1, 7)];
    expect(attachScripts(smallCaps).map((i) => i.text)).toEqual(['dose 5', 'MG']);
  });

  it('«×» / «÷» are neutral for bidi: «11.5 ×10⁹/L.» inside an Arabic line keeps its logical order', () => {
    expect(charDir('×')).toBe('N');
    expect(charDir('÷')).toBe('N');
    expect(charDir('é')).toBe('L');
    // visual items of the LibreOffice line (right → left: 11.5, ×, 10⁹, /, L, «. جميع …»)
    const items = [
      item('. جميع ما يلي مناسب في التقييم الأولي عدا:', 255.8, 457, 72, 84.8, 11),
      item('L', 457.1, 462.7, 72.3, 85, 11),
      item('/', 462.8, 466.4, 72, 84.8, 11),
      item('10⁹', 466.4, 484.7, 72, 84.8, 11),
      item('×', 484.9, 494.1, 72, 84.8, 11),
      item('11.5', 497.4, 521.9, 72, 84.8, 11),
    ];
    expect(logicalLineText(items, 'rtl')).toBe('11.5 ×10⁹/L. جميع ما يلي مناسب في التقييم الأولي عدا:');
  });

  it('the reversed negation words «ال» → «لا», «إال» → «إلا», «أال» → «ألا», «وال» → «ولا»; correct words untouched', () => {
    expect(fixReversedLamAlef('أي مما يلي ال يسبب ارتفاع الحرارة؟').text).toBe('أي مما يلي لا يسبب ارتفاع الحرارة؟');
    expect(fixReversedLamAlef('أي مما يلي ال ُيعد').text).toBe('أي مما يلي لا ُيعد');
    expect(fixReversedLamAlef('جميع ما يلي من مضاعفاته إال:').text).toBe('جميع ما يلي من مضاعفاته إلا:');
    expect(fixReversedLamAlef('أال تعلم').text).toBe('ألا تعلم');
    expect(fixReversedLamAlef('وال يسبب الحمى').text).toBe('ولا يسبب الحمى');
    for (const w of ['لا', 'إلا', 'الا', 'ألا', 'ولا', 'الألم', 'الالتهاب', 'التهاب', 'والم', 'أداة التعريف ال', 'بال']) expect(fixReversedLamAlef(w).text, w).toBe(w);
    expect(fixReversedLamAlef('ال يسبب').fixes).toBe(1);
    expect(hasReversedLamAlef('أي مما يلي ال يسبب')).toBe(true);
    expect(hasReversedLamAlef('أي مما يلي لا يسبب')).toBe(false);
  });
});

let t: QApp;
let units: { sourceId: string; versionId: string };
let neg: { sourceId: string; versionId: string };

beforeAll(async () => {
  t = await createQuestionsApp();
  const course = (await createNode(t, 'G4 AC-11 course')).id;
  units = await uploadAndProcess(t, course, 'g4_units_negation.pdf', fixture('g4_units_negation.pdf'), 'question_source', 'G4 units');
  neg = await uploadAndProcess(t, course, 'g4_negation_ar.pdf', fixture('g4_negation_ar.pdf'), 'question_source', 'G4 Arabic negation');
}, 300_000);
afterAll(async () => {
  await t?.close();
});

const cur = async (sourceId: string, section: string, n: string) => (await detail(t, questionAt(t, sourceId, section, n))).question.current;
const em = (v: Awaited<ReturnType<typeof cur>>) => v.stem.paragraphs.flatMap((p) => p.runs).filter((r) => r.marks?.includes('em')).map((r) => r.t);

describe('G4 AC-11 — the real pipeline keeps values, units and negation exactly', () => {
  it('values typed with super/subscript font effects keep their meaning (10⁹, PaCO₂), decimal commas and comparison signs stay as printed', async () => {
    const q1 = await cur(units.sourceId, '', '1');
    expect(plain(q1.stem)).toBe('In suspected appendicitis, a white cell count of 11.5 × 10⁹/L:');
    expect(plain(q1.stem)).not.toContain('109/L');
    const q2 = await cur(units.sourceId, '', '2');
    expect(plain(q2.stem)).toBe('An arterial blood gas shows pH 7.32 and PaCO₂ 52 mmHg. Which disturbance is present?');
    const q3 = await cur(units.sourceId, '', '3');
    expect(plain(q3.stem)).toBe('Serum potassium is 6,5 mmol/L and creatinine 1,2 mg/dL. Which is the first step?');
    const q4 = await cur(units.sourceId, '', '4');
    expect(q4.options.map((o) => plain(o.text))).toContain('Oliguria < 0.5 mL/kg/h');
    for (const v of [q1, q2, q3, q4]) {
      expect(v.validation!.issues.find((i) => i.check === 'numbers_units_preserved')).toMatchObject({ passed: true });
      expect(v.extraction_status).toBe('checks_passed');
    }
  });

  it('NOT in bold and a lower-case «except» are kept, flagged and emphasized', async () => {
    const q4 = await cur(units.sourceId, '', '4');
    expect(plain(q4.stem)).toBe('Which of the following is NOT a feature of shock?');
    expect(q4.negation_terms).toEqual(['NOT']);
    expect(em(q4)).toEqual(['NOT']);
    const q5 = await cur(units.sourceId, '', '5');
    expect(plain(q5.stem)).toBe('All of the following are risk factors for gallstones except:');
    expect(q5.has_negation).toBe(true);
    expect(em(q5)).toEqual(['except']);
  });

  it('Arabic negation «لا» / «إلا» (lam-alef ligatures in the PDF) and «عدا» / «خاطئة» are kept, flagged and emphasized', async () => {
    const q1 = await cur(neg.sourceId, '', '1');
    expect(plain(q1.stem)).toBe('أي مما يلي لا يسبب ارتفاع حرارة المريض؟');
    expect(q1.negation_terms).toEqual(['لا']);
    expect(em(q1)).toEqual(['لا']);
    const q2 = await cur(neg.sourceId, '', '2');
    expect(plain(q2.stem)).toBe('جميع ما يلي من مضاعفات التهاب الزائدة إلا:');
    expect(q2.negation_terms).toEqual(['إلا']);
    expect((await cur(neg.sourceId, '', '3')).negation_terms).toEqual(['عدا']);
    const q4 = await cur(neg.sourceId, '', '4');
    expect(q4.negation_terms).toEqual(['خاطئة']);
    // the Arabic-Indic decimal is stored exactly as printed (never rewritten as «3.5»)
    expect(plain(q4.stem)).toContain('٣٫٥ ملمول/لتر');
    expect(plain(q4.stem)).toContain('128 ملمول/لتر');
  });

  it('Word-typed super/subscripts survive LibreOffice too: «10⁹/L», «PaCO₂ 52 mmHg and HCO₃⁻ 26 mmol/L»', async () => {
    expect(plain((await cur(neg.sourceId, 'E', '5')).stem)).toBe('A white cell count of 11.5 × 10⁹/L in suspected appendicitis:');
    expect(plain((await cur(neg.sourceId, 'E', '6')).stem)).toBe('pH 7.32 with PaCO₂ 52 mmHg and HCO₃⁻ 26 mmol/L indicates:');
  });

  it('a question whose text processing could not read with certainty is NOT approved automatically (Arabic Q4: flagged ligature word)', async () => {
    const id = questionAt(t, neg.sourceId, '', '4');
    const d = await detail(t, id);
    expect(d.question.status).toBe('needs_review');
    expect(d.scorable).toBe(false);
    expect(listForExam(t.ctx, { sourceIds: [neg.sourceId], onlyScorable: true }).map((c) => c.question_id)).not.toContain(id);
  });
});

describe('G4 AC-11 — a check failure blocks automatic approval (and every assessed exam)', () => {
  it('a structured version that changes the decimal comma («6,5» → «6.5») fails, is not scorable, is kept out of an assessed exam, and accept needs an explicit acknowledgement', async () => {
    const id = questionAt(t, units.sourceId, '', '3');
    const before = await cur(units.sourceId, '', '3');
    const r = createVersion(t.ctx, id, { kind: 'structured', createdBy: 'extraction', stem: plain(before.stem).replace('6,5', '6.5'), note: 'synthetic changed separator (test)' });
    expect(r.validation!.issues.find((i) => i.check === 'numbers_units_preserved')).toMatchObject({ passed: false, severity: 'blocker' });
    const d = await detail(t, id);
    expect(d.question.status).toBe('needs_review');
    expect(d.scorable).toBe(false);
    const preview = (await api(t).post('/api/exams/preview', { title: '', mode: 'exam', count: 50, source_ids: [units.sourceId] })).json().report;
    expect(preview.exclusions.find((e: { code: string }) => e.code === 'unscorable').question_ids).toContain(id);
    const practice = (await api(t).post('/api/exams', { title: '', mode: 'practice', count: 1, question_ids: [id] })).json() as ExamCreateResponse;
    expect(practice.session.items[0]!.scored).toBe(false);
    const refused = await api(t).post(`/api/questions/${id}/review`, { decision: 'accept' });
    expect(refused.statusCode).toBe(409);
    expect(JSON.stringify(refused.json().error.details)).toContain('numbers_units_preserved');
    // the owner restores the printed value → checks pass again (owner correction = new version)
    const fixed = await api(t).patch(`/api/questions/${id}`, { stem: plain(before.stem), note: 'إرجاع الفاصلة كما في الأصل' });
    expect(fixed.statusCode).toBe(200);
    expect((fixed.json() as QuestionMutationResponse).question.current.validation!.issues.find((i) => i.check === 'numbers_units_preserved')?.passed).toBe(true);
  });

  it('a structured version that drops NOT fails the negation check and is not scorable; one that drops «لا» likewise', async () => {
    for (const [sourceId, n, from, to] of [
      [units.sourceId, '4', 'is NOT a feature', 'is a feature'],
      [neg.sourceId, '1', 'لا يسبب', 'يسبب'],
    ] as const) {
      const id = questionAt(t, sourceId, '', n);
      const before = await cur(sourceId, '', n);
      const r = createVersion(t.ctx, id, { kind: 'structured', createdBy: 'extraction', stem: plain(before.stem).replace(from, to), note: 'synthetic dropped negation (test)' });
      expect(r.validation!.issues.find((i) => i.check === 'negation_preserved'), n).toMatchObject({ passed: false, severity: 'blocker' });
      const d = await detail(t, id);
      expect(d.scorable).toBe(false);
      expect(d.review_items.some((i) => i.status === 'open')).toBe(true);
    }
  });

  it('delivery keeps the negation flag and the emphasis for the runner', async () => {
    const id = questionAt(t, units.sourceId, '', '5');
    const s = ((await api(t).post('/api/exams', { title: '', mode: 'practice', count: 1, question_ids: [id] })).json() as ExamCreateResponse).session;
    expect(s.items[0]!.has_negation).toBe(true);
    expect(s.items[0]!.negation_terms).toEqual(['except']);
    expect(plain(s.items[0]!.stem)).toContain('except:');
  });
});
