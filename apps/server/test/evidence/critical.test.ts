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

describe('H1 hardening — «directly stated» catches a swapped key noun / term (§12, AC-07)', () => {
  const RIF = "Pain usually begins in the periumbilical region and later migrates to the right iliac fossa (McBurney's point).";
  const US = 'Ultrasound is the first-line imaging test in children and in pregnant women.';
  const DDX = 'The differential diagnosis includes mesenteric adenitis, ectopic pregnancy and right ureteric colic.';
  const AR_ECTOPIC = 'يجب استبعاد الحمل خارج الرحم عند النساء في سن الإنجاب.';
  const AR_RIF = 'يبدأ الألم عادةً حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى عند نقطة McBurney.';
  const ds = (claim: string, quotes: string[]) => checkContainment(claim, quotes, 'directly_stated');

  it('English: one swapped eponym / laterality / technical term fails although ≥ 80 % of the words match', () => {
    const cases: Array<[string, string]> = [
      [RIF.replace("McBurney's", "Murphy's"), RIF], // capitalised term not in the quote
      [RIF.replace('right iliac', 'left iliac'), RIF], // laterality swapped
      [US.replace('Ultrasound', 'Radiography'), US], // sentence-initial key noun swapped
      [DDX.replace('ureteric', 'biliary'), DDX], // lowercase noun swapped in place
      [DDX.replace('adenitis', 'lymphoma'), DDX], // medical term swapped
    ];
    for (const [claim, quote] of cases) {
      // the existing deterministic checks did not see these swaps
      expect(checkCriticalTokens(claim, [quote]).passed, claim).toBe(true);
      const r = ds(claim, [quote]);
      expect(r.passed, claim).toBe(false);
      expect(r.coverage ?? 0, claim).toBeGreaterThanOrEqual(0.8);
      expect(r.reason_ar, claim).toContain('مذكور نصًا');
    }
    expect(ds(RIF.replace("McBurney's", "Murphy's"), [RIF]).reason_ar).toContain('Murphy');
    expect(ds(DDX.replace('ureteric', 'biliary'), [DDX]).reason_ar).toMatch(/biliary[\s\S]*ureteric/);
  });

  it('Arabic: a swapped Latin term or Arabic noun fails; laterality too', () => {
    const cases: Array<[string, string]> = [
      [AR_RIF.replace('McBurney', 'Murphy'), AR_RIF], // Latin term inside an Arabic claim, Arabic quote
      [AR_ECTOPIC.replace('الرحم', 'الكلية'), AR_ECTOPIC], // Arabic noun swapped in place
      [AR_RIF.replace('اليمنى', 'اليسرى'), AR_RIF], // laterality
    ];
    for (const [claim, quote] of cases) {
      expect(checkCriticalTokens(claim, [quote]).passed, claim).toBe(true);
      const r = ds(claim, [quote]);
      expect(r.passed, claim).toBe(false);
      expect(r.reason_ar, claim).toContain('مذكور نصًا');
    }
  });

  it('valid «directly stated» claims still pass: verbatim, subset, reordered, inflected, hedge words, β-hCG, Arabic', () => {
    const ok: Array<[string, string]> = [
      [RIF, RIF],
      ['Pain begins in the periumbilical region and later migrates to the right iliac fossa.', RIF],
      ['Pain typically begins in the periumbilical region and later migrates to the right iliac fossa.', RIF],
      ['Pain began in the periumbilical region and later migrated to the right iliac fossa.', RIF],
      ["Pain later migrates to the right iliac fossa (McBurney's point).", RIF],
      ['Ultrasound is the first-line imaging test in children.', US],
      ['In children, ultrasound is the first-line imaging test.', US],
      ['A pregnancy test (β-hCG) is required in women of reproductive age.', 'CT abdomen is preferred in adults. A pregnancy test (β-hCG) is required in women of reproductive age.'],
      [AR_ECTOPIC, AR_ECTOPIC],
      ['يجب استبعاد الحمل خارج الرحم عند النساء.', AR_ECTOPIC],
      ['ينتقل الألم إلى الحفرة الحرقفية اليمنى عند نقطة McBurney.', AR_RIF],
      ['ويبدأ الألم حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى عند نقطة McBurney.', AR_RIF],
    ];
    for (const [claim, quote] of ok) expect(ds(claim, [quote]).passed, claim).toBe(true);
    // the right quote among several cited ones is enough
    expect(ds(DDX, [US, DDX]).passed).toBe(true);
  });
});

describe('H1 review — «directly stated» does not refuse a gloss, an expanded acronym or a spelling variant', () => {
  const ds = (claim: string, quotes: string[]) => checkContainment(claim, quotes, 'directly_stated');
  const AR_APP = 'يسبب التهاب الزائدة الدودية ألمًا في الحفرة الحرقفية اليمنى.';
  const AR_CT = 'يُطلب التصوير المقطعي عند البالغين إذا بقي التشخيص غير مؤكد.';
  const AR_RIF = 'يبدأ الألم عادةً حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى عند نقطة McBurney.';
  const EN_CT = 'Computed tomography is preferred in adults when the diagnosis remains uncertain.';
  const EN_ANAEMIA = 'Iron deficiency anaemia is the commonest cause of microcytic anaemia in women of reproductive age.';
  const EN_OEDEMA = 'Pulmonary oedema causes breathlessness on lying flat in patients with heart failure.';

  it('valid: an English term glossed in parentheses after the Arabic one, the quote being Arabic only', () => {
    expect(ds('يسبب التهاب الزائدة الدودية (appendicitis) ألمًا في الحفرة الحرقفية اليمنى.', [AR_APP]).passed).toBe(true);
    expect(ds('يُطلب التصوير المقطعي (CT) عند البالغين إذا بقي التشخيص غير مؤكد.', [AR_CT]).passed).toBe(true);
    // several Latin words in one parenthesis (one span, removed once)
    expect(ds('يسبب التهاب الزائدة الدودية (acute appendicitis) ألمًا في الحفرة الحرقفية اليمنى.', [AR_APP]).passed).toBe(true);
  });

  it('valid: an acronym in parentheses right after the words it abbreviates', () => {
    expect(ds('Computed tomography (CT) is preferred in adults when the diagnosis remains uncertain.', [EN_CT]).passed).toBe(true);
  });

  it('valid: British / American spelling of the same key term (anaemia / anemia, oedema / edema)', () => {
    expect(ds('Iron deficiency anemia is the commonest cause of microcytic anemia in women of reproductive age.', [EN_ANAEMIA]).passed).toBe(true);
    expect(ds('Pulmonary edema causes breathlessness on lying flat in patients with heart failure.', [EN_OEDEMA]).passed).toBe(true);
  });

  it('still refused: a wrong acronym, a Latin term the Arabic quote itself carries swapped in a parenthesis, a real swap under a spelling variant', () => {
    expect(ds('Magnetic resonance imaging (CT) is preferred in adults when the diagnosis remains uncertain.', [EN_CT]).passed).toBe(false);
    // the quote carries Latin terms: a parenthetical Latin term is not a gloss there — «Murphy» for «McBurney» is a swap
    expect(ds('يبدأ الألم عادةً حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى عند نقطة (Murphy).', [AR_RIF]).passed).toBe(false);
    expect(ds('Iron deficiency anemia is the commonest cause of macrocytic anemia in women of reproductive age.', [EN_ANAEMIA]).passed).toBe(false);
    expect(ds('Hyperkalemia causes peaked T waves and a short QT interval.', ['Hypokalaemia causes peaked T waves and a short QT interval.']).passed).toBe(false);
  });
});
