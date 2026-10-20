// H2 item 10 — question extraction hardening (§33, §34, §36):
//  a. «Paper I / II» sections and a «Paper 1 / 2» key (or the reverse) are the same sections for key binding — they
//     were `no_matching_question`; letter-labelled sections («Section I» among A…I) are never read as roman numerals;
//  b. a trailing UNLABELLED key block after the last section binds to that section ONLY when the file keys its
//     sections one by one and every number exists there — otherwise it stays a review item, never cross-bound;
//  c. «38.4 ° C» (a PDF line split inside «°C») is written «38.4 °C» in the STRUCTURED version only; raw stays verbatim;
//  d. a resumed extraction (power loss between commit and checkpoint) reports the questions THIS job created as new;
//  e. a circle around an option that OCR reads together with its label («(8 Ditrasound» for a circled «B») is that
//     option with an unofficial `circled_option` mark — not glued to the option before it;
//  f. questions stored before the G5 fingerprint fix are re-fingerprinted, so «−8» / «8», «♀» / «♂» never merge.
import { describe, expect, it } from 'vitest';
import { keySection } from '../../src/modules/questions/keys';
import { parseQuestions, type ParserLine } from '../../src/modules/questions/parser';
import { structuredText } from '../../src/modules/questions/text';

let seq = 0;
const line = (text: string, extra: Partial<ParserLine> = {}): ParserLine => ({
  text,
  regionId: `r${++seq}`,
  regionKind: 'paragraph',
  pageIndex: 0,
  pageId: 'p0',
  bbox: null,
  regionStatus: 'extracted',
  confidence: null,
  textOrigin: 'digital',
  ...extra,
});
const QA = ['1. Which vitamin deficiency causes scurvy?', 'A. Vitamin A', 'B. Vitamin C', 'C. Vitamin D', '2. Which organ produces insulin?', 'A. Liver', 'B. Spleen', 'C. Pancreas'];
const QB = ['1. Which bone forms the heel?', 'A. Talus', 'B. Calcaneus', 'C. Cuboid', '2. Which muscle flexes the elbow?', 'A. Triceps', 'B. Brachialis', 'C. Deltoid', '3. Which joint is ball and socket?', 'A. Hip', 'B. Knee', 'C. Ankle'];

function bindings(lines: string[]) {
  const parsed = parseQuestions(lines.map((t) => line(t)));
  return { parsed, keys: parsed.keys.map((k) => ({ n: k.printedNumber, label: k.keyLabel, ...keySection(k, parsed) })) };
}

describe('a. roman ↔ digit section labels for key binding', () => {
  it('«Paper I / II» sections with a «Paper 1 / 2» key — and the reverse — bind per section', () => {
    const a = bindings(['Paper I', ...QA, 'Paper II', ...QB, 'Answer Key', 'Paper 1: 1. B 2. C', 'Paper 2: 1. B 2. B 3. A']);
    expect(a.keys.map((k) => `${k.sectionKey}${k.n}=${k.label}:${k.binding}`)).toEqual(['I1=B:bound', 'I2=C:bound', 'II1=B:bound', 'II2=B:bound', 'II3=A:bound']);
    const b = bindings(['Part 1', ...QA, 'Part 2', ...QB, 'Answer Key', 'Part II: 1. B 2. B 3. A', 'Part I: 1. B 2. C']);
    expect(b.keys.map((k) => `${k.sectionKey}${k.n}:${k.binding}`)).toEqual(['21:bound', '22:bound', '23:bound', '11:bound', '12:bound']);
  });

  it('letter-labelled sections stay letters: «Section I» among A…I is the ninth section, not section 1', () => {
    const letters = 'ABCDEFGHI'.split('');
    const lines = letters.flatMap((l) => [`Section ${l}`, '1. A question about the topic?', 'A. one', 'B. two']);
    const r = bindings([...lines, 'Answer Key', 'Section I: 1. B', 'Section 1: 1. A']);
    expect(r.keys.map((k) => `${k.sectionKey}:${k.binding}`)).toEqual(['I:bound', '1:no_matching_question']);
  });
});

describe('b. a trailing unlabelled key block after the last section', () => {
  it('per-part keys (Part 1 keyed between the parts): the trailing block binds to the last part', () => {
    const r = bindings(['Part 1', ...QA, 'Answers', '1. B 2. C', 'Part 2', ...QB, 'Answers', '1. B 2. B 3. A']);
    expect(r.keys.map((k) => `${k.sectionKey}${k.n}=${k.label}:${k.binding}`)).toEqual(['11=B:bound', '12=C:bound', '21=B:bound', '22=B:bound', '23=A:bound']);
  });

  it('never when it could be the whole file\'s key: earlier parts unkeyed, a number the last part does not have, two trailing blocks', () => {
    // one key block at the end of a two-part file: it may be the key of either part
    const whole = bindings(['Part 1', ...QA, 'Part 2', ...QB, 'Answers', '1. B 2. B 3. A']);
    expect(whole.keys.every((k) => k.binding === 'ambiguous_section' && k.sectionKey === null)).toBe(true);
    // the trailing block lists question 4, which the last part does not have
    const extra = bindings(['Part 1', ...QA, 'Answers', '1. B 2. C', 'Part 2', ...QB, 'Answers', '1. B 2. B 3. A 4. C']);
    expect(extra.keys.filter((k) => k.n !== '1' || k.sectionKey !== '1').every((k) => k.sectionKey !== '2' || k.binding !== 'bound')).toBe(true);
    expect(extra.keys.slice(2).every((k) => k.binding === 'ambiguous_section')).toBe(true);
    // two unlabelled blocks after the last part (two printings of a key): nothing is chosen between them
    const two = bindings(['Part 1', ...QA, 'Answers', '1. B 2. C', 'Part 2', ...QB, 'Answers', '1. B 2. B 3. A', 'Key', '1. C 2. B 3. A']);
    expect(two.keys.slice(2).every((k) => k.binding === 'ambiguous_section')).toBe(true);
  });
});

describe('c. «38.4 ° C» in the structured text only', () => {
  it('joins a degree sign split from its unit; nothing else changes', () => {
    expect(structuredText('His temperature is 38.4 ° C and pulse 118/min.')).toBe('His temperature is 38.4 °C and pulse 118/min.');
    expect(structuredText('حرارتها 38.4 ° C وتعداد')).toBe('حرارتها 38.4 °C وتعداد');
    expect(structuredText('38.4 °C')).toBe('38.4 °C');
    expect(structuredText('98.6 °  F')).toBe('98.6 °F');
    expect(structuredText('an angle of 30 ° Cobb')).toBe('an angle of 30 ° Cobb'); // a word, not a unit
  });

  it('the parser keeps the raw line verbatim; the stem is the structured text', () => {
    const r = parseQuestions(['1. A man has a temperature of 38.4 ° C. What is the likely cause?', 'A. Appendicitis', 'B. Gastritis'].map((t) => line(t)));
    expect(r.questions[0]!.stemRaw).toContain('38.4 ° C');
    expect(structuredText(r.questions[0]!.stem)).toContain('38.4 °C');
  });
});

describe('e. a circle read together with the option label by OCR', () => {
  it('«(8 Ditrasound» after option A is option B with a circled mark — not part of option A', () => {
    const ocr = { textOrigin: 'ocr', confidence: 0.82 } as const;
    const r = parseQuestions(
      ['4. Which investigation is preferred in adults when the diagnosis remains uncertain?', 'A. Plain abdominal film', '(8 Ditrasound', 'C. CT abdomen', 'D. Barium enema', 'Answer: C'].map((t) =>
        line(t, ocr),
      ),
    );
    const q = r.questions[0]!;
    expect(q.options.map((o) => [o.label, o.text, o.mark])).toEqual([
      ['A', 'Plain abdominal film', null],
      ['B', 'Ditrasound', 'circled_option'],
      ['C', 'CT abdomen', null],
      ['D', 'Barium enema', null],
    ]);
    expect(q.options[1]!.markReason).toBe('ocr_label_confusion');
    // the printed key is the key; the circle is only a mark
    expect(r.keys.map((k) => [k.keyLabel, k.markKind])).toEqual([['C', 'printed_key']]);
  });

  it('only the EXPECTED next label: «(8 mg daily» after option C is not a circled «B»; digital text is never re-read', () => {
    const ocr = { textOrigin: 'ocr', confidence: 0.82 } as const;
    const r = parseQuestions(['1. Dose?', 'A. 2 mg', 'B. 4 mg', 'C. 6 mg', '(8 mg daily)'].map((t) => line(t, ocr)));
    expect(r.questions[0]!.options.map((o) => o.label)).toEqual(['A', 'B', 'C']);
    const digital = parseQuestions(['4. Which test?', 'A. Plain film', '(8 Ditrasound', 'C. CT'].map((t) => line(t)));
    expect(digital.questions[0]!.options.map((o) => o.label)).toEqual(['A', 'C']);
  });

  it('a printed circled «©» read by OCR for a circled C is that option, marked', () => {
    const r = parseQuestions(['1. Which?', 'A. one', 'B. two', '© three', 'D. four'].map((t) => line(t, { textOrigin: 'ocr', confidence: 0.8 })));
    expect(r.questions[0]!.options.map((o) => [o.label, o.mark])).toEqual([
      ['A', null],
      ['B', null],
      ['C', 'circled_option'],
      ['D', null],
    ]);
  });
});
