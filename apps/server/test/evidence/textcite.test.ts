// H1: the text-«citation» detector (G2 / AC-06) also catches page / slide references written with ordinals,
// number words and relative words, in English and Arabic — without flagging ordinary medical text.
import { describe, expect, it } from 'vitest';
import { hasPseudoCitation, inventedCitations, pseudoCitations, stripPseudoCitations } from '../../src/modules/evidence/textcite';

describe('pseudo citations — unusual phrasings (H1)', () => {
  const flagged = [
    // English: ordinals, relative positions, number words, roman numerals, «#» / «no.»
    'See the third page for the full pathway.',
    'As shown on the next page, CT is preferred.',
    'This is summarised on the previous slide.',
    'Refer to the following slide.',
    'see the last page',
    'on page three',
    'Slide two lists the causes.',
    'page xii',
    'see slide #4',
    'page no. 12',
    'page number 7',
    // Arabic: ordinal adjectives, relative words, number words, prefixed forms
    'انظر الصفحة الثالثة.',
    'في الشريحة التالية نرى المسار.',
    'كما في الصفحة السابقة.',
    'راجع الشريحة الأخيرة.',
    'في الصفحة الأولى من المحاضرة',
    'انظر الصفحه الثانيه',
    'الصفحة رقم سبعة',
    'بالصفحة 4',
    'وفي الشريحة الخامسة',
    'انظر الصفحة الحادية عشرة',
  ];
  it.each(flagged)('flags «%s»', (t) => {
    expect(hasPseudoCitation(t)).toBe(true);
  });

  const clean = [
    // the existing AC-06 control list
    'Figure 1 shows the pathway.',
    'Table 2: Alvarado score',
    'pH 7.4 and p < 0.05',
    'Give 5 mg p.o. twice daily.',
    'A white cell count above 11 ×10⁹/L supports the diagnosis.',
    'يُعطى الدواء الساعة 8 ص ثم 8 م.',
    'فحص 3 مرات يوميًا',
    'Vitamin E deficiency',
    'Na+ 135 mmol/L',
    // ordinals / relative words that are not page references
    "Paget's disease of bone is the second most common bone disease.",
    'The first-line test is ultrasound; the next step is CT.',
    'The third cranial nerve is affected.',
    'The following signs are typical.',
    'الخطوة التالية هي التصوير المقطعي.',
    'الجرعة الأولى تُعطى في المستشفى.',
    'كما سنرى في الفقرة التالية من الشرح.',
    'المرحلة الثالثة من الولادة',
    'The page layout of the textbook is irrelevant here.',
  ];
  it.each(clean)('does not flag «%s»', (t) => {
    expect(hasPseudoCitation(t)).toBe(false);
  });

  it('strips the new forms from a label and keeps the rest', () => {
    expect(stripPseudoCitations('Imaging pathway (see the third page)')).toBe('Imaging pathway');
    expect(stripPseudoCitations('مسار التصوير (انظر الصفحة الثالثة)')).toBe('مسار التصوير');
    expect(pseudoCitations('في الشريحة التالية نرى المسار.')).toEqual(expect.arrayContaining([expect.stringContaining('الشريحة التالية')]));
  });

  it('a faithful quote of a source that itself says «see the next page» keeps it (it is checked against the excerpt)', () => {
    const quote = 'The scoring system is explained on the next page.';
    expect(inventedCitations(quote, [quote])).toEqual([]);
    expect(inventedCitations('The scoring system is explained on the next page.', ['The scoring system is explained below.'])).toHaveLength(1);
  });
});
