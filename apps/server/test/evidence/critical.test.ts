// Unit tests for the deterministic critical-token and containment checks (AC-07, §12).
import { describe, expect, it } from 'vitest';
import { canonicalNumber, checkContainment, checkCriticalTokens, extractCriticalTokens } from '../../src/modules/evidence/critical';

const WCC = 'A white cell count above 11 ×10⁹/L supports the diagnosis, but a normal count does NOT exclude it.';
const TABLE = 'Feature: Leukocytosis | Points: 2 | Unit / threshold: > 10 ×10⁹/L';

describe('critical token extraction', () => {
  it('numbers: Arabic-Indic digits, decimal commas, thousands separators, trailing zeros', () => {
    expect(extractCriticalTokens('١١ ×10⁹/L').numbers).toEqual(['11']);
    expect(extractCriticalTokens('K+ 6,5 mmol/L').numbers).toEqual(['6.5']);
    expect(extractCriticalTokens('K+ ٦٫٥ mmol/L').numbers).toEqual(['6.5']);
    expect(extractCriticalTokens('10,000 platelets').numbers).toEqual(['10000']);
    expect(canonicalNumber('6.50')).toBe('6.5');
    expect(canonicalNumber('011')).toBe('11');
  });

  it('units with their numbers (×10⁹/L written several ways, %, °C, Arabic unit words)', () => {
    const a = extractCriticalTokens(WCC);
    expect(a.units).toEqual(['x10^9/l']);
    expect(a.quantities).toEqual(['11 x10^9/l']);
    expect(a.numbers).toEqual(['11']); // the exponent 9 is part of the unit, not a value
    expect(extractCriticalTokens('11 x10^9/L').quantities).toEqual(['11 x10^9/l']);
    expect(extractCriticalTokens('neutrophils > 75%').quantities).toEqual(['75 %']);
    expect(extractCriticalTokens('≥ 37.3 °C').quantities).toEqual(['37.3 °c']);
    expect(extractCriticalTokens('500 ملغ كل 8 ساعات').quantities).toEqual(['500 mg', '8 h']);
    expect(extractCriticalTokens('5 µg/kg').units).toEqual(['mcg/kg']);
  });

  it('thresholds: symbols and words in English and Arabic, only when followed by a number', () => {
    expect(extractCriticalTokens(TABLE).comparators).toEqual(['gt']);
    expect(extractCriticalTokens(WCC).comparators).toEqual(['gt']); // «above 11»
    expect(extractCriticalTokens('أكثر من 11').comparators).toEqual(['gt']);
    expect(extractCriticalTokens('at least 3 points').comparators).toEqual(['ge']);
    expect(extractCriticalTokens('لا يقل عن 3').comparators).toEqual(['ge']);
    expect(extractCriticalTokens('أقل من ٥').comparators).toEqual(['lt']);
    expect(extractCriticalTokens('pain over the abdomen').comparators).toEqual([]);
  });

  it('negations, exceptions and populations (EN + AR)', () => {
    expect(extractCriticalTokens(WCC).negation).toBe(true);
    expect(extractCriticalTokens("it doesn't exclude").negation).toBe(true);
    expect(extractCriticalTokens('لا يستبعد التشخيص').negation).toBe(true);
    expect(extractCriticalTokens('ولم يُستبعد').negation).toBe(true);
    expect(extractCriticalTokens('Ultrasound is the first-line test').negation).toBe(false);
    expect(extractCriticalTokens('All are risk factors EXCEPT obesity').exception).toBe(true);
    expect(extractCriticalTokens('جميعها عوامل خطر باستثناء السمنة').exception).toBe(true);
    expect(extractCriticalTokens('in children and in pregnant women').populations).toEqual(expect.arrayContaining(['child', 'pregnant', 'female']));
    expect(extractCriticalTokens('عند الأطفال والحوامل').populations).toEqual(expect.arrayContaining(['child', 'pregnant']));
    expect(extractCriticalTokens('في البالغين').populations).toEqual(['adult']);
  });
});

describe('checkCriticalTokens (claim vs union of cited quotes)', () => {
  it('passes a faithful paraphrase', () => {
    expect(checkCriticalTokens('A white cell count above 11 ×10⁹/L supports appendicitis.', [WCC]).passed).toBe(true);
  });

  it('fails a changed number (11 vs 10 ×10⁹/L) with an Arabic reason', () => {
    const r = checkCriticalTokens('Leukocytosis above 11 ×10⁹/L scores 2 points.', [TABLE]);
    expect(r.passed).toBe(false);
    expect(r.missing.numbers).toEqual(['11']);
    expect(r.reasons_ar.join(' ')).toContain('11');
  });

  it('fails a changed unit', () => {
    const r = checkCriticalTokens('A white cell count above 11 g/L supports the diagnosis.', [WCC]);
    expect(r.passed).toBe(false);
    expect(r.missing.units).toEqual(['g/l']);
  });

  it('fails a changed threshold', () => {
    const r = checkCriticalTokens('A white cell count of at least 11 ×10⁹/L supports the diagnosis.', [WCC]);
    expect(r.passed).toBe(false);
    expect(r.missing.comparators).toEqual(['ge']);
  });

  it('fails a dropped NOT (the evidence negates what the claim asserts)', () => {
    const r = checkCriticalTokens('A normal white cell count excludes appendicitis.', [WCC]);
    expect(r.passed).toBe(false);
    expect(r.missing.dropped_negation).toBe(true);
    expect(r.reasons_ar.join(' ')).toContain('ينفي');
  });

  it('fails an added NOT that the evidence does not carry', () => {
    const r = checkCriticalTokens('Ultrasound is NOT the first-line imaging test in children.', ['Ultrasound is the first-line imaging test in children and in pregnant women.']);
    expect(r.passed).toBe(false);
    expect(r.missing.negation).toBe(true);
  });

  it('keeps a correct negated claim', () => {
    expect(checkCriticalTokens('A normal count does not exclude appendicitis.', [WCC]).passed).toBe(true);
  });

  it('fails a population that the evidence does not mention', () => {
    const r = checkCriticalTokens('Ultrasound is the first-line imaging test in adults.', ['Ultrasound is the first-line imaging test in children and in pregnant women.']);
    expect(r.passed).toBe(false);
    expect(r.missing.populations).toEqual(['adult']);
  });

  it('cross-language: an Arabic claim may cite English evidence, but numbers/units/Latin terms must match', () => {
    const ok = checkCriticalTokens('عدد كريات الدم البيضاء فوق ١١ ×10⁹/L يدعم التشخيص، والعدد الطبيعي لا يستبعده.', [WCC]);
    expect(ok.passed).toBe(true);
    expect(ok.cross_language).toBe(true);
    const latin = checkCriticalTokens('يبدأ الألم حول السرة ثم ينتقل إلى نقطة McBurney', ["Pain usually begins in the periumbilical region and later migrates to the right iliac fossa (McBurney's point)."]);
    expect(latin.passed).toBe(true);
    const wrong = checkCriticalTokens('يبدأ الألم حول السرة ثم ينتقل إلى نقطة Murphy', ["Pain usually begins in the periumbilical region and later migrates to the right iliac fossa (McBurney's point)."]);
    expect(wrong.passed).toBe(false);
    expect(wrong.missing.latin_terms).toEqual(['murphy']);
  });

  it('abbreviations must appear in the evidence', () => {
    const r = checkCriticalTokens('MRI is preferred in adults when the diagnosis remains uncertain.', ['CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.']);
    expect(r.passed).toBe(false);
    expect(r.missing.abbreviations).toEqual(['MRI']);
  });
});

describe('review regressions (C1 adversarial review)', () => {
  it('Arabic thresholds written with «على / أعلى / مئوية / بالمئة» are recognised (they were never detected)', () => {
    expect(extractCriticalTokens('الحرارة أعلى من 38').comparators).toEqual(['gt']);
    expect(extractCriticalTokens('على الأقل 3 نقاط').comparators).toEqual(['ge']);
    expect(extractCriticalTokens('على الأكثر 2 غرام').comparators).toEqual(['le']);
    expect(extractCriticalTokens('لا يزيد على 4 غرامات').comparators).toEqual(['le']);
    expect(extractCriticalTokens('عند الأطفال دون 5 سنوات').comparators).toEqual(['lt']);
    expect(extractCriticalTokens('حرارة 38 درجة مئوية').quantities).toEqual(['38 °c']);
    expect(extractCriticalTokens('الحساسية 85 بالمئة').quantities).toEqual(['85 %']);
    // an inverted Arabic threshold is refused
    const r = checkCriticalTokens('الحرارة أعلى من 38 درجة مئوية تدعم التشخيص.', ['الحرارة أقل من 38 درجة مئوية.']);
    expect(r.passed).toBe(false);
    expect(r.missing.comparators).toEqual(['gt']);
    // and the faithful English rendering of the Arabic evidence passes (°C now matches «درجة مئوية»)
    expect(checkCriticalTokens('Fever above 38 °C supports the diagnosis.', ['الحرارة أعلى من 38 درجة مئوية تدعم التشخيص.']).passed).toBe(true);
  });

  it('a threshold is the comparator WITH its value: swapped thresholds fail', () => {
    const r = checkCriticalTokens('WBC > 11 and CRP < 10 suggest appendicitis.', ['WBC < 11 and CRP > 10 suggest appendicitis.']);
    expect(r.passed).toBe(false);
    expect(r.missing.thresholds).toEqual(['gt 11', 'lt 10']);
    expect(r.reasons_ar.join(' ')).toContain('> 11');
    expect(checkCriticalTokens('Patients aged 65 and above are at risk.', ['Patients aged 65 or above are at risk.']).passed).toBe(true);
  });

  it('dropped NOT is judged on what the NOT governs (no false rejections of «X, not Y, …» / «without …» clauses)', () => {
    expect(checkCriticalTokens('Ultrasound is the first-line test in children.', ['Ultrasound, not CT, is the first-line test in children.']).passed).toBe(true);
    expect(checkCriticalTokens('Antibiotics alone may be used in selected patients.', ['Antibiotics alone, without surgery, may be used in selected patients.']).passed).toBe(true);
    // still caught: the claim asserts exactly what is negated
    expect(checkCriticalTokens('A normal white cell count excludes appendicitis.', [WCC]).missing.dropped_negation).toBe(true);
    expect(checkCriticalTokens('Appendicitis can be excluded by a normal count.', ['Appendicitis cannot be excluded by a normal count.']).missing.dropped_negation).toBe(true);
    expect(checkCriticalTokens('Fever is present in early appendicitis.', ['Fever is absent in early appendicitis.']).passed).toBe(false);
    // a negation glued to «و» («ولا») is a negation, not a content word
    expect(checkCriticalTokens('وهو يستبعد التشخيص.', ['ولا يستبعد التشخيص.']).missing.dropped_negation).toBe(true);
  });

  it('a dropped exception fails; keeping the exception or speaking about the excepted item passes', () => {
    const r = checkCriticalTokens('All are risk factors.', ['All are risk factors except obesity.']);
    expect(r.passed).toBe(false);
    expect(r.missing.dropped_exception).toBe(true);
    expect(r.reasons_ar.join(' ')).toContain('استثناء');
    expect(checkCriticalTokens('All are risk factors except obesity.', ['All are risk factors except obesity.']).passed).toBe(true);
    expect(checkCriticalTokens('جميعها عوامل خطر.', ['جميعها عوامل خطر باستثناء السمنة.']).missing.dropped_exception).toBe(true);
  });
});

describe('checkContainment', () => {
  const Q = 'Ultrasound is the first-line imaging test in children and in pregnant women.';
  it('original quotes must be verbatim (whitespace and quote marks aside)', () => {
    expect(checkContainment('«Ultrasound is the first-line imaging test in children»', [Q], 'original_quote').passed).toBe(true);
    expect(checkContainment('Ultrasound is the preferred imaging test in children', [Q], 'original_quote').passed).toBe(false);
  });
  it('directly stated claims must be substantially contained (same language)', () => {
    expect(checkContainment('Ultrasound is the first-line imaging test in children.', [Q], 'directly_stated').passed).toBe(true);
    const r = checkContainment('Ultrasound avoids radiation and is cheap and widely available.', [Q], 'directly_stated');
    expect(r.passed).toBe(false);
    expect(r.reason_ar).toContain('مذكور نصًا');
    expect(checkContainment('الموجات فوق الصوتية هي الفحص الأول عند الأطفال.', [Q], 'directly_stated').method).toBe('skipped_cross_language');
  });
});
