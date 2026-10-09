// Source type SUGGESTION from the file name (§06: suggest automatically, the owner corrects).
// Never authoritative: the source is stored with source_type_origin = 'auto' until the owner confirms.
import type { SourceFormat, SourceType } from '@medlevo/shared';

/** Latin tokens: split on non-alphanumerics and on letter/digit boundaries; lowercase. */
function latinTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Arabic matching ignores hamza/ta-marbuta/alef-maqsura variants. */
function normalizeArabic(s: string): string {
  return s
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

interface Rule {
  type: SourceType;
  latin?: string[];
  /** consecutive Latin token pairs */
  pairs?: Array<[string, string]>;
  arabic?: string[];
  test?: (tokens: string[], arabic: string) => boolean;
}

const YEAR = /^(19|20)\d\d$/;

const RULES: Rule[] = [
  {
    type: 'previous_exam',
    latin: ['pastpaper', 'pastpapers'],
    pairs: [
      ['previous', 'exam'],
      ['past', 'exam'],
      ['old', 'exam'],
      ['past', 'paper'],
      ['past', 'papers'],
      ['previous', 'exams'],
      ['past', 'exams'],
    ],
    arabic: ['امتحان سابق', 'امتحانات سابقه', 'اسئله سابقه', 'اسئله السنوات', 'دورات سابقه'],
    test: (t) => (t.includes('exam') || t.includes('exams') || t.includes('final') || t.includes('midterm')) && t.some((x) => YEAR.test(x)),
  },
  {
    type: 'question_source',
    latin: ['question', 'questions', 'mcq', 'mcqs', 'qbank', 'quiz', 'quizzes', 'exam', 'exams', 'sba', 'emq', 'emqs', 'osce', 'midterm'],
    arabic: ['اسئله', 'سؤال', 'بنك اسئله', 'امتحان', 'اختبار'],
  },
  { type: 'image_atlas', latin: ['atlas'], arabic: ['اطلس'] },
  { type: 'guideline', latin: ['guideline', 'guidelines', 'guidance', 'consensus', 'protocol', 'protocols'], arabic: ['دليل ارشادي', 'ارشادات', 'بروتوكول'] },
  { type: 'practical_manual', latin: ['practical', 'practicals', 'lab', 'manual', 'handbook'], arabic: ['عملي', 'العملي', 'مختبر'] },
  { type: 'lecture', latin: ['lecture', 'lectures', 'lec', 'lect', 'slides', 'slide'], arabic: ['محاضره', 'محاضرات'] },
  { type: 'textbook', latin: ['textbook', 'book', 'edition', 'ed', 'chapter', 'ch'], arabic: ['كتاب', 'فصل'] },
  { type: 'course_reference', latin: ['reference', 'references', 'ref', 'refs'], arabic: ['مرجع', 'مراجع'] },
  { type: 'my_notes', latin: ['notes', 'note', 'summary', 'summaries'], arabic: ['ملاحظات', 'ملاحظاتي', 'ملخص', 'تلخيص'] },
];

export interface TypeSuggestion {
  type: SourceType;
  /** true when a rule matched; false when this is only the format default */
  matched: boolean;
}

/**
 * Suggest a source type from a file name. Audio is always lecture_audio / my_audio_note.
 * Rules are ordered: «previous exam 2024» → previous_exam before «questions» → question_source.
 */
export function suggestSourceType(fileName: string, format: SourceFormat): TypeSuggestion {
  const tokens = latinTokens(fileName);
  const arabic = normalizeArabic(fileName);
  if (format === 'audio') {
    const note = tokens.some((t) => t === 'note' || t === 'notes' || t === 'memo' || t === 'voice') || /ملاحظه|تسجيلي/.test(arabic);
    return { type: note ? 'my_audio_note' : 'lecture_audio', matched: true };
  }
  for (const rule of RULES) {
    const latinHit = rule.latin?.some((w) => tokens.includes(w)) ?? false;
    const pairHit = rule.pairs?.some(([a, b]) => tokens.some((t, i) => t === a && tokens[i + 1] === b)) ?? false;
    const arabicHit = rule.arabic?.some((w) => arabic.includes(normalizeArabic(w))) ?? false;
    const testHit = rule.test?.(tokens, arabic) ?? false;
    if (latinHit || pairHit || arabicHit || testHit) return { type: rule.type, matched: true };
  }
  return { type: 'lecture', matched: false };
}
