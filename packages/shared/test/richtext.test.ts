import { describe, expect, it } from 'vitest';
import { detectDir, richTextFromPlain, richTextToPlain, segmentRuns, stripBidiControls } from '../src/richtext';

const join = (runs: { t: string }[]) => runs.map((r) => r.t).join('');

describe('bidi segmentation (§21 typesetting examples)', () => {
  const cases: Array<[string, string[]]> = [
    ['يعطى 5 mg IV ببطء', ['5 mg IV']],
    ['قيمة pH 7.35 طبيعية', ['pH 7.35']],
    ['تركيز Na+ 135 mmol/L في الدم', ['Na+ 135 mmol/L']],
    ['جرثومة H. pylori شائعة', ['H. pylori']],
    ['نطلب CT abdomen عند الشك', ['CT abdomen']],
    ['المسار A → B → C هو المهم', ['A → B → C']],
    ['نطلب (CT abdomen) فورًا', ['(CT abdomen)']],
  ];
  for (const [input, ltr] of cases) {
    it(`isolates LTR island in: ${input}`, () => {
      const runs = segmentRuns(input, 'rtl');
      expect(join(runs)).toBe(input); // logical order preserved exactly
      expect(runs.filter((r) => r.dir === 'ltr').map((r) => r.t)).toEqual(ltr);
    });
  }

  it('keeps sentence-final punctuation in the Arabic run', () => {
    const runs = segmentRuns('السبب هو H. pylori.', 'rtl');
    expect(runs.filter((r) => r.dir === 'ltr').map((r) => r.t)).toEqual(['H. pylori']);
    expect(join(runs)).toBe('السبب هو H. pylori.');
  });

  it('detects paragraph direction', () => {
    expect(detectDir('التهاب الزائدة الدودية Appendicitis')).toBe('rtl');
    expect(detectDir('Which of the following is NOT a feature?')).toBe('ltr');
  });

  it('strips bidi control characters (OCR output) and never stores them', () => {
    const ocr = 'Appendicitis 5 mg IV ‏التهاب الزائدة‎';
    const clean = stripBidiControls(ocr);
    expect(clean).not.toMatch(/[‎‏]/);
    const rt = richTextFromPlain(ocr);
    expect(richTextToPlain(rt)).toBe(clean);
  });

  it('isolates Arabic islands inside LTR paragraphs', () => {
    const runs = segmentRuns('The term التهاب means inflammation', 'ltr');
    expect(runs.filter((r) => r.dir === 'rtl').map((r) => r.t)).toEqual(['التهاب']);
  });
});
