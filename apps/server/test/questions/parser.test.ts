// Unit tests of the deterministic Question Vault logic: parser (sections, numbering, options, keys, marks),
// validation (AC-10/11/13/14/15 checks) and text helpers. Pure functions — no database.
import { describe, expect, it } from 'vitest';
import type { TableStructure } from '@medlevo/shared';
import { parseKeyPairs, parseQuestions, type ParserLine } from '../../src/modules/questions/parser';
import { rawContent, validateQuestion, type ValidationInput } from '../../src/modules/questions/validate';
import { fingerprint, labelInfo, negationTerms, numberUnitTokens, richTextWithNegation } from '../../src/modules/questions/text';
import { optionKeyForLabel } from '../../src/modules/questions/keys';
import { assessPair } from '../../src/modules/questions/duplicates';
import { candidatesFromRegions } from '../../src/modules/questions/concepts';

let seq = 0;
function line(text: string, extra: Partial<ParserLine> = {}): ParserLine {
  seq++;
  return {
    text,
    regionId: `r${seq}`,
    regionKind: 'paragraph',
    pageIndex: 0,
    pageId: 'p0',
    bbox: null,
    regionStatus: 'extracted',
    confidence: null,
    textOrigin: 'digital',
    ...extra,
  };
}
const lines = (...texts: string[]) => texts.map((t) => line(t));

describe('parser — questions, options, sections', () => {
  it('reads numbered questions with Latin and Arabic option labels, keeping labels and order', () => {
    const r = parseQuestions(lines('1. Which is first?', 'A. one', 'B. two', 'C. three', '2. ما هو الفحص الأولي؟', 'أ. Ultrasound', 'ب. CT', 'ج. MRI'));
    expect(r.questions).toHaveLength(2);
    expect(r.questions[0]!.options.map((o) => o.label)).toEqual(['A', 'B', 'C']);
    expect(r.questions[1]!.options.map((o) => [o.label, o.text])).toEqual([
      ['أ', 'Ultrasound'],
      ['ب', 'CT'],
      ['ج', 'MRI'],
    ]);
    expect(r.questions[1]!.stem).toBe('ما هو الفحص الأولي؟');
  });

  it('accepts Q1 / سؤال 1 / Arabic-Indic numerals / (a) and inline options on one line', () => {
    const r = parseQuestions(lines('Q1 Which drug?', '(a) aspirin', '(b) heparin', 'سؤال ٢: أي مما يلي صحيح؟', 'A. x B. y C. z'));
    expect(r.questions.map((q) => q.printedNumber)).toEqual(['1', '2']);
    expect(r.questions[0]!.options.map((o) => o.label)).toEqual(['a', 'b']);
    expect(r.questions[1]!.options.map((o) => [o.label, o.text])).toEqual([
      ['A', 'x'],
      ['B', 'y'],
      ['C', 'z'],
    ]);
  });

  it('numeric options inside a question use a different numbering style and are not new questions', () => {
    const r = parseQuestions(lines('1. First question?', 'A. a', 'B. b', '2. Which numbers are right?', '1) alpha', '2) beta', '3) gamma', '3. Third question?', 'A. c', 'B. d'));
    expect(r.questions.map((q) => q.printedNumber)).toEqual(['1', '2', '3']);
    expect(r.questions[1]!.options.map((o) => o.label)).toEqual(['1', '2', '3']);
  });

  it('a section header and a numbering reset each start a new section (AC-12)', () => {
    const r = parseQuestions(lines('Section A — Abdomen', '1. a?', 'A. x', 'B. y', 'Part B', '1. b?', 'A. x', 'B. y', '1. c?', 'A. x', 'B. y'));
    expect(r.questions.map((q) => `${q.sectionKey}:${q.printedNumber}`)).toEqual(['A:1', 'B:1', 'sec-3:1']);
    expect(r.questions[0]!.sectionTitle).toBe('Section A — Abdomen');
  });

  it('a question continues across pages: stem on page 0, options on page 1, header skipped (AC-10)', () => {
    const r = parseQuestions([
      line('3. A long stem that ends on this page and asks which test?', { pageIndex: 0, pageId: 'p0' }),
      // processing marks repeated running heads as 'header' — regionsToLines drops them before parsing
      line('A. one', { pageIndex: 1, pageId: 'p1' }),
      line('B. two', { pageIndex: 1, pageId: 'p1' }),
      line('C. three', { pageIndex: 1, pageId: 'p1' }),
      line('D. four', { pageIndex: 1, pageId: 'p1' }),
      line('E. five', { pageIndex: 1, pageId: 'p1' }),
    ]);
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]!.options).toHaveLength(5);
    expect([...new Set(r.questions[0]!.lines.map((l) => l.pageIndex))]).toEqual([0, 1]);
  });

  it('flags merged questions (labels restart) and option gaps (missing option)', () => {
    const r = parseQuestions(lines('1. One?', 'A. a', 'B. b', 'D. d', 'A. again', 'B. again'));
    const checks = r.questions[0]!.issues.map((i) => i.check);
    expect(checks).toContain('option_order');
    expect(checks).toContain('merged_questions');
  });

  it('an unnumbered question with options gets a stable item key', () => {
    const r = parseQuestions(lines('Which investigation is first-line?', 'A. US', 'B. CT'));
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]!.printedNumber).toBeNull();
    expect(r.questions[0]!.itemKey).toBe('u1');
    expect(r.questions[0]!.stem).toBe('Which investigation is first-line?');
  });

  it('figure regions inside a question are attached to it', () => {
    const r = parseQuestions([line('1. Identify the structure shown?'), line('', { regionKind: 'figure' }), line('A. x'), line('B. y')]);
    expect(r.questions[0]!.figures).toHaveLength(1);
  });
});

describe('parser — answer keys', () => {
  it('per-section key lines bind by section label; numbering alone is never enough (AC-12)', () => {
    const r = parseQuestions(lines('Section A', '1. a?', 'A. x', 'B. y', 'Section B', '1. b?', 'A. x', 'B. y', 'Answer Key', 'Section A: 1. B', 'Section B: 1. A'));
    expect(r.keys.map((k) => `${k.sectionLabel}:${k.printedNumber}=${k.keyLabel}`)).toEqual(['A:1=B', 'B:1=A']);
  });

  it('key heading + bare section sub-headings + runs', () => {
    const r = parseQuestions(lines('Section A', '1. a?', 'A. x', 'B. y', 'Section B', '1. b?', 'A. x', 'B. y', 'الإجابات', 'Section A', '1. A', 'Section B', '1. B'));
    expect(r.keys.map((k) => `${k.sectionLabel}:${k.printedNumber}=${k.keyLabel}`)).toEqual(['A:1=A', 'B:1=B']);
  });

  it('a key printed between two sections belongs to the section before it', () => {
    const r = parseQuestions(lines('Section A', '1. a?', 'A. x', 'B. y', 'Answers', '1. B', 'Section B', '1. b?', 'A. x', 'B. y'));
    expect(r.keys).toHaveLength(1);
    expect(r.keys[0]!.afterSectionKey).toBe('A');
    expect(r.keyBlocks[0]!.followedBySection).toBe(true);
    expect(r.questions.map((q) => q.sectionKey)).toEqual(['A', 'B']);
  });

  it('inline «Answer: B» binds to its question; Arabic key labels are read', () => {
    const r = parseQuestions(lines('1. a?', 'A. x', 'B. y', 'Answer: B', '2. b?', 'أ. x', 'ب. y', 'الإجابة: ب'));
    expect(r.keys.map((k) => [k.inlineFor?.itemKey, k.keyLabel])).toEqual([
      ['1', 'B'],
      ['2', 'ب'],
    ]);
  });

  it('key tables (and two tables read as one region) keep every printed key in separate blocks (AC-15)', () => {
    const table: TableStructure = {
      type: 'table',
      rows: 6,
      cols: 2,
      cells: [
        ['Question', 'Answer'],
        ['1', 'B'],
        ['2', 'C'],
        ['Question', 'Answer'],
        ['1', 'B'],
        ['2', 'D'],
      ].flatMap((row, r) => row.map((text, c) => ({ r, c, text, header: r === 0 }))),
    };
    const r = parseQuestions([...lines('1. a?', 'A. x', 'B. y', 'C. z', 'D. w', '2. b?', 'A. x', 'B. y', 'C. z', 'D. w'), line('', { regionKind: 'table', table })]);
    expect(r.keys.map((k) => `${k.keyBlock}:${k.printedNumber}=${k.keyLabel}`)).toEqual(['1:1=B', '1:2=C', '2:1=B', '2:2=D']);
    expect(r.keys.every((k) => k.markKind === 'key_table' && k.originKnown)).toBe(true);
  });

  it('key pairs are recognized only when the whole line is pairs', () => {
    expect(parseKeyPairs('1. B 2. C 3. B 4. B')).toHaveLength(4);
    expect(parseKeyPairs('١- أ ٢- ب')).toEqual([
      { n: '1', label: 'أ' },
      { n: '2', label: 'ب' },
    ]);
    expect(parseKeyPairs('3. A 30-year-old woman presents')).toBeNull();
  });

  it('a circled option is an UNOFFICIAL mark, never a key (AC-13)', () => {
    const r = parseQuestions(lines('7. Which test?', '(A Dttrasound', 'B. CT', 'C. MRI', 'D. ERCP'));
    const q = r.questions[0]!;
    expect(q.options[0]!.label).toBe('A');
    expect(q.options[0]!.mark).toBe('circled_option');
    expect(r.keys).toHaveLength(0);
    const r2 = parseQuestions(lines('1. Which?', 'Ⓑ CT', 'A. US'));
    expect(r2.questions[0]!.options[0]!.mark).toBe('circled_option');
  });
});

const baseInput = (over: Partial<ValidationInput>): ValidationInput => ({
  stem: 'In suspected appendicitis, a white cell count of 11.5 ×10⁹/L:',
  options: [
    { label: 'A', text: 'Confirms the diagnosis' },
    { label: 'B', text: 'Supports but does not confirm the diagnosis' },
  ],
  qtype: 'sba',
  rawText: '4. In suspected appendicitis, a white cell count of 11.5 ×10⁹/L:\nA. Confirms the diagnosis\nB. Supports but does not confirm the diagnosis',
  structural: [],
  figuresAttached: 0,
  uncertainRegions: [],
  answerStatus: 'source_key',
  conflictAr: null,
  unofficialMarks: [],
  createdBy: 'extraction',
  ownerReviewedFields: [],
  ...over,
});

describe('validation', () => {
  it('numbers and units identical to the raw text pass; an altered unit is a blocker (AC-11)', () => {
    const ok = validateQuestion(baseInput({}));
    expect(ok.publishable).toBe(true);
    expect(ok.issues.find((i) => i.check === 'numbers_units_preserved')?.passed).toBe(true);
    const bad = validateQuestion(baseInput({ stem: 'In suspected appendicitis, a white cell count of 11.5 ×10⁹/mL:' }));
    const n = bad.issues.find((i) => i.check === 'numbers_units_preserved')!;
    expect(n.passed).toBe(false);
    expect(n.severity).toBe('blocker');
    expect(n.reason_ar).toContain('11.5×10⁹/L');
    expect(bad.publishable).toBe(false);
    // a changed decimal separator also fails
    expect(validateQuestion(baseInput({ stem: 'In suspected appendicitis, a white cell count of 11,5 ×10⁹/L:' })).publishable).toBe(false);
  });

  it('a dropped NOT/EXCEPT is a blocker (AC-11)', () => {
    const raw = '2. Which of the following is NOT typically part of the score?\nA. x\nB. y';
    const kept = validateQuestion(baseInput({ stem: 'Which of the following is NOT typically part of the score?', options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }], rawText: raw }));
    expect(kept.issues.find((i) => i.check === 'negation_preserved')?.passed).toBe(true);
    const lost = validateQuestion(baseInput({ stem: 'Which of the following is typically part of the score?', options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }], rawText: raw }));
    expect(lost.issues.find((i) => i.check === 'negation_preserved')?.passed).toBe(false);
    expect(lost.publishable).toBe(false);
  });

  it('missing key is a warning (unscored practice), conflicting key a blocker, marks a warning (AC-13/14/15)', () => {
    const missing = validateQuestion(baseInput({ answerStatus: 'missing_key' }));
    expect(missing.issues.find((i) => i.check === 'key_bound')).toMatchObject({ passed: false, severity: 'warning' });
    expect(missing.publishable).toBe(true);
    const conflict = validateQuestion(baseInput({ answerStatus: 'conflicting_key', conflictAr: 'تعارض' }));
    expect(conflict.issues.find((i) => i.check === 'key_conflict')).toMatchObject({ passed: false, severity: 'blocker' });
    const marked = validateQuestion(baseInput({ answerStatus: 'missing_key', unofficialMarks: [{ label: 'A', kind: 'circled_option' }] }));
    expect(marked.issues.find((i) => i.check === 'unofficial_mark')).toMatchObject({ passed: false, severity: 'warning' });
  });

  it('truncated stems, single options, missing images and low-confidence OCR block auto-approval', () => {
    expect(validateQuestion(baseInput({ stem: 'Which of the', rawText: null })).issues.find((i) => i.check === 'stem_complete')?.passed).toBe(false);
    expect(validateQuestion(baseInput({ options: [{ label: 'A', text: 'x' }], rawText: null })).publishable).toBe(false);
    expect(validateQuestion(baseInput({ stem: 'Identify the structure shown in the image?', rawText: null })).issues.find((i) => i.check === 'images_attached')?.passed).toBe(false);
    const ocr = validateQuestion(baseInput({ uncertainRegions: [{ where: 'option', label: 'A', reason: 'OCR' }] }));
    expect(ocr.publishable).toBe(false);
  });

  it('a field the owner reviewed turns a difference into a warning (manual approval)', () => {
    const v = validateQuestion(baseInput({ stem: 'In suspected appendicitis, a white cell count of 11.5 ×10⁹/mL:', ownerReviewedFields: ['stem'] }));
    expect(v.issues.find((i) => i.check === 'numbers_units_preserved')).toMatchObject({ passed: false, severity: 'warning' });
    expect(v.publishable).toBe(true);
  });

  it('rawContent strips numbering and labels only', () => {
    expect(rawContent('4. In a 30-year-old, Na+ 140 mmol/L\nA. 10 mg\n(b) x\nأ. y')).toBe('In a 30-year-old, Na+ 140 mmol/L\n10 mg\nx\ny');
  });
});

describe('text helpers', () => {
  it('negation terms in English and Arabic, emphasized in the stem RichText', () => {
    expect(negationTerms('All of the following EXCEPT:')).toEqual(['EXCEPT']);
    expect(negationTerms('جميع ما يلي صحيح باستثناء')).toEqual(['باستثناء']);
    const rt = richTextWithNegation('Which is NOT typically part of the score?');
    const em = rt.paragraphs[0]!.runs.filter((r) => r.marks?.includes('em'));
    expect(em.map((r) => r.t)).toEqual(['NOT']);
    expect(rt.paragraphs[0]!.runs.map((r) => r.t).join('')).toBe('Which is NOT typically part of the score?');
  });

  it('numbers keep units, multipliers and separators verbatim', () => {
    expect(numberUnitTokens('a white cell count of 11.5 ×10⁹/L:')).toEqual(['11.5×10⁹/L']);
    expect(numberUnitTokens('Na+ 140 mmol/L and K+ 6.5 mmol/L, temp ≥ 37.3 °C')).toEqual(['140mmol/L', '6.5mmol/L', '≥37.3°C']);
  });

  it('exact-duplicate fingerprint ignores option order but not negation', () => {
    expect(fingerprint('Which point?', ['A x', 'B y'])).toBe(fingerprint('Which  point?', ['B y', 'A x']));
    expect(fingerprint('Which is NOT part?', ['x'])).not.toBe(fingerprint('Which is part?', ['x']));
  });

  it('labels map within a script and across Latin ↔ Arabic by order', () => {
    expect(labelInfo('ب')).toMatchObject({ script: 'arabic', index: 1 });
    expect(labelInfo('هـ')).toMatchObject({ script: 'arabic', index: 4 });
    expect(optionKeyForLabel({ o1: 'A', o2: 'B' }, 'B')).toEqual({ optionKey: 'o2', crossScript: false });
    expect(optionKeyForLabel({ o1: 'أ', o2: 'ب' }, 'B')).toEqual({ optionKey: 'o2', crossScript: true });
    expect(optionKeyForLabel({ o1: 'A', o2: 'B' }, 'E').optionKey).toBeNull();
  });

  it('near-duplicate assessment lists the blockers (AC-17)', () => {
    const shape = (stem: string, opts: string[], correct: string | null) => ({
      stem,
      options: new Map(opts.map((o, i) => [`o${i + 1}`, o])),
      correctTexts: correct ? [correct.toLowerCase()] : null,
      v: { qtype: 'sba' } as never,
    });
    const a = shape('Which of the following is NOT typically part of the Alvarado score?', ['Migration of pain', 'Anorexia', 'Serum amylase', 'Leukocytosis'], 'serum amylase');
    const b = shape('Which of the following is typically part of the Alvarado score?', ['Migration of pain', 'Serum amylase', 'Serum lipase', 'Blood glucose'], 'migration of pain');
    const res = assessPair(a, b);
    expect(res.kind).toBe('near');
    expect(res.blockers.join(' ')).toContain('النفي');
    expect(res.blockers.join(' ')).toContain('الخيارات');
    expect(res.blockers.join(' ')).toContain('الإجابة الصحيحة');
  });

  it('concept candidates from headings, table first column and capitalized terms', () => {
    const table: TableStructure = {
      type: 'table',
      rows: 3,
      cols: 2,
      cells: [
        { r: 0, c: 0, text: 'Feature', header: true },
        { r: 0, c: 1, text: 'Points', header: true },
        { r: 1, c: 0, text: 'Anorexia' },
        { r: 1, c: 1, text: '1' },
        { r: 2, c: 0, text: 'Leukocytosis' },
        { r: 2, c: 1, text: '2' },
      ],
    };
    const c = candidatesFromRegions([
      { id: 'h', kind: 'heading', text: 'Acute Appendicitis — التهاب الزائدة الدودية الحاد', structure_json: null, parent_region_id: null },
      { id: 'h2', kind: 'heading', text: 'Learning objectives', structure_json: null, parent_region_id: null },
      { id: 't', kind: 'table', text: '', structure_json: JSON.stringify(table), parent_region_id: null },
      { id: 'p', kind: 'paragraph', text: "Pain migrates to McBurney's point.", structure_json: null, parent_region_id: null },
    ]).map((x) => x.name);
    expect(c).toEqual(expect.arrayContaining(['Acute Appendicitis', 'التهاب الزائدة الدودية الحاد', 'Anorexia', 'Leukocytosis', "McBurney's point"]));
    expect(c).not.toContain('Learning objectives');
  });
});
