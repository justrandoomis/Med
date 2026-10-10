// G6 / AC-20 regression: superscript / subscript digits belong to the LTR expression they are written in.
// Before the fix «×10⁹» at the end of an English run inside Arabic was split into an isolated «×10» and a bare «⁹»;
// the browser then drew the «⁹» (EN → AN after Arabic letters) to the LEFT of the isolate: «⁹×10», «₂CO», «₃⁻HCO».
// The visual result is checked in Chromium by e2e/g6-ac20-mixed-text.spec.ts; this test pins the segmentation.
import { describe, expect, it } from 'vitest';
import { detectDir, richTextToPlain, richTextFromPlain, segmentRuns } from '../src/richtext';

const ltrRuns = (s: string) => segmentRuns(s, detectDir(s)).filter((r) => r.dir === 'ltr').map((r) => r.t);

describe('segmentRuns keeps super/subscripts inside their LTR island (AC-20)', () => {
  it.each([
    ['عدد الكريات البيضاء أعلى من 11 ×10⁹ في اللتر', ['11 ×10⁹']],
    ['يرتفع CO₂ في الدم', ['CO₂']],
    ['قيمة HCO₃⁻ منخفضة', ['HCO₃⁻']],
    ['المؤشر x¹ ثم x⁴ فقط', ['x¹', 'x⁴']],
    ['الكالسيوم Ca²⁺ منخفض', ['Ca²⁺']],
    ['التركيز 10⁻³ mol في المحلول', ['10⁻³ mol']],
    ['الفوسفات PO₄³⁻ مرتفع', ['PO₄³⁻']],
  ])('%s', (text, islands) => {
    expect(ltrRuns(text)).toEqual(islands);
    // logical order is untouched: the runs concatenate back to the input, no control characters added
    expect(segmentRuns(text).map((r) => r.t).join('')).toBe(text);
  });

  it('the §21 samples inside Arabic sentences still form one island each', () => {
    const text = 'الجرعة 5 mg IV ثم pH 7.35 والصوديوم Na+ 135 mmol/L وجرثومة H. pylori والفحص CT abdomen والتسلسل A → B → C';
    expect(ltrRuns(text)).toEqual(['5 mg IV', 'pH 7.35', 'Na+ 135 mmol/L', 'H. pylori', 'CT abdomen', 'A → B → C']);
    const rt = richTextFromPlain(text);
    expect(richTextToPlain(rt)).toBe(text);
  });
});
