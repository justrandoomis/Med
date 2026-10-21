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

// ═══════════════════════════════ Lecture identity (Academic OS P1-T3, PRD AOS-3.2…3.5, 3.7, 3.18) ═══════════════════════════════
// Pure detection over a file name and the text of the first pages. Every result says HOW SURE it is and WHY; the
// versions module stores a `certain` lecture number / date automatically (origin 'detected', reversible) and holds
// everything else for the uploader's confirmation. Nothing here reads the database.

export const IDENTITY_ALGO = 'id1';

/** Arabic-Indic (٠–٩) and Extended Arabic-Indic (۰–۹) digits → Latin. */
export function toLatinDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** One spelling for matching: Latin digits, no harakat/tatweel, unified alef/ta-marbuta/alef-maqsura, lowercase. */
export function normalizeIdentityText(s: string): string {
  return normalizeArabic(toLatinDigits(s.normalize('NFKC')))
    .replace(/[‌-‏‪-‮⁦-⁩]/g, '')
    .toLowerCase();
}

const AR_ORDINALS: Array<[string, number]> = [
  ['اولي', 1], ['اول', 1], ['ثانيه', 2], ['ثاني', 2], ['ثالثه', 3], ['ثالث', 3], ['رابعه', 4], ['رابع', 4],
  ['خامسه', 5], ['خامس', 5], ['سادسه', 6], ['سادس', 6], ['سابعه', 7], ['سابع', 7], ['ثامنه', 8], ['ثامن', 8],
  ['تاسعه', 9], ['تاسع', 9], ['عاشره', 10], ['عاشر', 10],
];
const AR_CARDINALS: Array<[string, number]> = [
  ['واحد', 1], ['واحده', 1], ['اثنان', 2], ['اثنين', 2], ['ثلاثه', 3], ['اربعه', 4], ['خمسه', 5], ['سته', 6],
  ['سبعه', 7], ['ثمانيه', 8], ['تسعه', 9], ['عشره', 10],
];
const AR_TENS: Array<[string, number]> = [['عشرون', 20], ['عشرين', 20], ['ثلاثون', 30], ['ثلاثين', 30]];
const EN_ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
const EN_CARDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/** «الخامسة» / «الحادية عشرة» / «الحادية والعشرون» / «خمسة» → number (normalised Arabic input, «ال» optional). */
export function arabicNumberWord(words: string): number | null {
  const w = words.trim().replace(/^ال/, '');
  const unit = (t: string): number | null => {
    const s = t.replace(/^ال/, '');
    for (const [k, n] of [...AR_ORDINALS, ...AR_CARDINALS]) if (s === k) return n;
    if (s === 'حاديه' || s === 'حادي') return 1;
    return null;
  };
  // «X عشره / عشر» = 10 + X (الحادية عشرة = 11, الثانية عشرة = 12 …)
  const teen = /^(\S+)\s+(?:ال)?عشره?$/.exec(w);
  if (teen) {
    const u = unit(teen[1]!);
    if (u !== null && u < 10) return 10 + u;
  }
  // «X والعشرون» = 20 + X; «العشرون» = 20
  const compound = /^(\S+)\s+و(?:ال)?(\S+)$/.exec(w);
  if (compound) {
    const u = unit(compound[1]!);
    const tens = AR_TENS.find(([k]) => compound[2] === k)?.[1];
    if (u !== null && tens) return tens + u;
  }
  for (const [k, n] of AR_TENS) if (w === k) return n;
  return unit(w);
}

export type DetectedFrom = 'file_name' | 'first_pages';
export interface NumberCandidate {
  n: number;
  strength: 'strong' | 'weak';
  from: DetectedFrom;
  /** the matched words, for the reason shown to the owner */
  match: string;
  /** «Lecture 5 & 6», «المحاضرتان 5 و6»: one file names two lectures */
  combined?: boolean;
}

const validNo = (n: number) => Number.isInteger(n) && n >= 1 && n <= 200;

/** All lecture-number mentions in one text (a file name or page text). */
export function lectureNumberCandidates(raw: string, from: DetectedFrom): NumberCandidate[] {
  const out: NumberCandidate[] = [];
  // Latin: split letters from digits so «lec5» / «Lecture05» read as «lec 5»
  const t = normalizeIdentityText(raw).replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2').replace(/[_]+/g, ' ');
  const push = (n: number, strength: NumberCandidate['strength'], match: string, combined = false) => {
    if (validNo(n)) out.push({ n, strength, from, match: match.trim().slice(0, 80), ...(combined ? { combined } : {}) });
  };
  // a second number joined to the first names a second lecture: «5 & 6», «5 and 6», «5, 6», «5-6», «5 + 6», «5 to 7»,
  // «5 و 6», «5 الى 7» (review fix: «Lecture 5-6» was stored as a CERTAIN 5)
  const JOIN = String.raw`\s*(?:&|and|to|,|،|\+|-|–|—|/|و|الي|حتي)\s*`;
  // …unless that «second number» is the start of a date: «Lecture 5 - 12.10.2026», «محاضرة 5 - 12-10-2026»
  const joinedIsDate = (m: RegExpExecArray) => /^\s*[./-]\s*\d/.test(t.slice(m.index + m[0].length));
  /** the words shown as the reason: without a joined date */
  const shown = (m: RegExpExecArray, joined: string | undefined) => (joined && joinedIsDate(m) ? m[0].slice(0, m[0].length - joined.length) : m[0]);
  let m: RegExpExecArray | null;
  // «lecture 5», «lec. 05», «lect #5», «lecture no. 5», «lectures 5 & 6»
  const latinStrong = new RegExp(String.raw`\b(lectures?|lect|lec)\b\.?\s*(?:no\.?|number|#|:|-)?\s*0*(\d{1,3})(?!\d)(${JOIN}0*(\d{1,3})(?!\d))?`, 'g');
  while ((m = latinStrong.exec(t))) push(Number(m[2]), 'strong', shown(m, m[3]), !!m[3] && !joinedIsDate(m));
  // «5th lecture»
  const latinOrd = /\b0*(\d{1,3})\s*(?:st|nd|rd|th)\s+lecture\b/g;
  while ((m = latinOrd.exec(t))) push(Number(m[1]), 'strong', m[0]);
  // «lecture five», «fifth lecture»
  const enWord = new RegExp(String.raw`\blecture\s+(${EN_CARDINALS.join('|')})\b|\b(${EN_ORDINALS.join('|')})\s+lecture\b`, 'g');
  while ((m = enWord.exec(t))) push(m[1] ? EN_CARDINALS.indexOf(m[1]) + 1 : EN_ORDINALS.indexOf(m[2]!) + 1, 'strong', m[0]);
  // Arabic digits (already Latin): «محاضرة ٥», «المحاضرة رقم 5», «محاضرة (5)», «المحاضرتان 5 و6»
  const arDigits = new RegExp(String.raw`(?:ال)?محاضر(?:ه|تان|تين|ات)\s*(?:رقم)?\s*[:#\-(]?\s*0*(\d{1,3})(?!\d)\)?(${JOIN}0*(\d{1,3})(?!\d))?`, 'g');
  while ((m = arDigits.exec(t))) push(Number(m[1]), 'strong', shown(m, m[2]), !!m[2] && !joinedIsDate(m));
  // Arabic words: «المحاضرة الخامسة», «المحاضرة الحادية عشرة», «المحاضرة الحادية والعشرون», «محاضرة خمسة»;
  // «المحاضرة الأولى والثانية» / «المحاضرتان الأولى والثانية» name TWO lectures (review fix)
  const arWords = /(?:ال)?محاضر(ه|تان|تين)\s+((?:ال)?[ء-ي]+(?:\s+(?:و?ال|و)?[ء-ي]+)?)/g;
  while ((m = arWords.exec(t))) {
    const dual = m[1] !== 'ه';
    const phrase = m[2]!;
    const words = phrase.split(/\s+/);
    const two = arabicNumberWord(phrase);
    const one = arabicNumberWord(words[0]!);
    const n = two ?? one;
    // a second number word joined with «و» that is not a compound (the twenty-first is ONE number)
    const second = two === null && words[1] ? arabicNumberWord(words[1].replace(/^و/, '')) : null;
    if (n !== null) push(n, 'strong', two !== null ? m[0] : `محاضر${m[1]} ${words[0]}`, dual || (second !== null && words[1]!.startsWith('و')));
  }
  // weak: «L5», «L 05», «session 5»; a leading «05 - …» in a file name
  const weak = /\b(?:l|session)\s*0*(\d{1,2})\b(?!\s*(?:mm|cm|kg|mg|ml|%))/g;
  while ((m = weak.exec(t))) push(Number(m[1]), 'weak', m[0]);
  if (from === 'file_name') {
    const lead = /^\s*0*(\d{1,2})\s*[-_.)]\s*\S/.exec(t);
    if (lead) push(Number(lead[1]), 'weak', lead[0]);
  }
  return out;
}

export interface IdentityDetection<T> {
  value: T;
  certainty: 'certain' | 'uncertain';
  reasons_ar: string[];
}

const fromAr = (f: DetectedFrom) => (f === 'file_name' ? 'في اسم الملف' : 'في الصفحات الأولى');

/**
 * The lecture number of a file. Certain only when every strong mention (file name and first pages) names the SAME
 * number and no mention names two lectures; a weak hint alone, or disagreeing mentions, are proposed as uncertain.
 */
export function detectLectureNumber(fileName: string, firstPagesText: string): IdentityDetection<number> | null {
  const all = [...lectureNumberCandidates(fileName.replace(/\.[A-Za-z0-9]{1,8}$/, ''), 'file_name'), ...lectureNumberCandidates(firstPagesText, 'first_pages')];
  if (all.length === 0) return null;
  const strong = all.filter((c) => c.strength === 'strong');
  const pool = strong.length ? strong : all;
  const distinct = [...new Set(pool.map((c) => c.n))];
  // the most frequent number wins the proposal; the file name breaks ties (it is what the owner typed or kept)
  const freq = (n: number) => pool.filter((c) => c.n === n).length + (pool.some((c) => c.n === n && c.from === 'file_name') ? 0.5 : 0);
  const best = [...distinct].sort((a, b) => freq(b) - freq(a) || a - b)[0]!;
  const reasons = pool.filter((c) => c.n === best).map((c) => `«${c.match}» ${fromAr(c.from)}`);
  const uniq = [...new Set(reasons)].slice(0, 4);
  const combined = pool.some((c) => c.combined);
  if (strong.length === 0) return { value: best, certainty: 'uncertain', reasons_ar: [...uniq, 'إشارة ضعيفة فقط (ليست «محاضرة N» صريحة).'] };
  if (distinct.length > 1) return { value: best, certainty: 'uncertain', reasons_ar: [...uniq, `وُجدت أرقام مختلفة: ${distinct.join('، ')}.`] };
  if (combined) return { value: best, certainty: 'uncertain', reasons_ar: [...uniq, 'يبدو أن الملف يضم أكثر من محاضرة.'] };
  return { value: best, certainty: 'certain', reasons_ar: uniq };
}

const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// normalised Arabic spellings (Levantine/Iraqi and Egyptian/Gulf month names)
const AR_MONTHS: Array<[string, number]> = [
  ['كانون الثاني', 1], ['شباط', 2], ['اذار', 3], ['نيسان', 4], ['ايار', 5], ['حزيران', 6], ['تموز', 7], ['اب', 8],
  ['ايلول', 9], ['تشرين الاول', 10], ['تشرين الثاني', 11], ['كانون الاول', 12],
  ['يناير', 1], ['فبراير', 2], ['مارس', 3], ['ابريل', 4], ['مايو', 5], ['يونيو', 6], ['يوليو', 7], ['اغسطس', 8],
  ['سبتمبر', 9], ['اكتوبر', 10], ['نوفمبر', 11], ['ديسمبر', 12],
];

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

interface DateCandidate {
  iso: string;
  ambiguous: boolean;
  match: string;
  from: DetectedFrom;
}

export function dateCandidates(raw: string, from: DetectedFrom): DateCandidate[] {
  const t = normalizeIdentityText(raw);
  const out: DateCandidate[] = [];
  const push = (iso: string | null, match: string, ambiguous = false) => {
    if (iso) out.push({ iso, ambiguous, match: match.trim(), from });
  };
  let m: RegExpExecArray | null;
  const iso = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  while ((m = iso.exec(t))) push(isoDate(+m[1]!, +m[2]!, +m[3]!), m[0]);
  // day-first (the convention of Arabic-speaking universities); both parts ≤ 12 and different → ambiguous
  const dmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g;
  while ((m = dmy.exec(t))) {
    const a = +m[1]!;
    const b = +m[2]!;
    const y = +m[3]!;
    if (b > 12 && a <= 12) push(isoDate(y, a, b), m[0]);
    else push(isoDate(y, b, a), m[0], a <= 12 && b <= 12 && a !== b);
  }
  const enMonth = EN_MONTHS.map((x) => `${x.slice(0, 3)}(?:${x.slice(3)})?`).join('|');
  const dMonY = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${enMonth})\.?,?\s+(\d{4})\b`, 'g');
  while ((m = dMonY.exec(t))) push(isoDate(+m[3]!, EN_MONTHS.findIndex((x) => m![2]!.startsWith(x.slice(0, 3))) + 1, +m[1]!), m[0]);
  const monDY = new RegExp(String.raw`\b(${enMonth})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, 'g');
  while ((m = monDY.exec(t))) push(isoDate(+m[3]!, EN_MONTHS.findIndex((x) => m![1]!.startsWith(x.slice(0, 3))) + 1, +m[2]!), m[0]);
  const arMonth = AR_MONTHS.map(([k]) => k).sort((a, b) => b.length - a.length).join('|');
  const arDate = new RegExp(String.raw`(\d{1,2})\s+(?:من\s+)?(?:شهر\s+)?(${arMonth})\s*(?:عام|سنه)?\s*(\d{4})`, 'g');
  while ((m = arDate.exec(t))) push(isoDate(+m[3]!, AR_MONTHS.find(([k]) => k === m![2])![1], +m[1]!), m[0]);
  return out;
}

/** The session date: certain when exactly one unambiguous date is found (file name and first pages). */
export function detectLectureDate(fileName: string, firstPagesText: string): IdentityDetection<string> | null {
  const all = [...dateCandidates(fileName.replace(/\.[A-Za-z0-9]{1,8}$/, ''), 'file_name'), ...dateCandidates(firstPagesText, 'first_pages')];
  if (all.length === 0) return null;
  const distinct = [...new Set(all.map((c) => c.iso))];
  const best = all[0]!;
  const reasons = [...new Set(all.filter((c) => c.iso === best.iso).map((c) => `«${c.match}» ${fromAr(c.from)}`))].slice(0, 3);
  if (distinct.length > 1) return { value: best.iso, certainty: 'uncertain', reasons_ar: [...reasons, `وُجدت تواريخ مختلفة: ${distinct.join('، ')}.`] };
  if (all.some((c) => c.ambiguous)) return { value: best.iso, certainty: 'uncertain', reasons_ar: [...reasons, 'قد يكون اليوم والشهر متبادلين.'] };
  return { value: best.iso, certainty: 'certain', reasons_ar: reasons };
}

// «final (1)», «- Copy», «copy of …», «v2», «نهائي», «نسخة» — noise that file managers and chat apps add to names
const TRAILING_NOISE = /(?:[\s_\-–]*(?:\(\s*\d{1,3}\s*\)|\[\s*\d{1,3}\s*\]|copy(?:\s*\d{1,2})?|final|finale|last|updated?|edited|revised|new|v\s?\d{1,2}|ver\s?\d{1,2}|version\s?\d{1,2}|نهائي[ةه]?|نسخ[ةه](?:\s*\d{1,2})?|معدل[ةه]?|جديد[ةه]?|محدث[ةه]?|اخير[ةه]?|أخير[ةه]?))+$/i;

/** A clean title from a file name; the original name is kept elsewhere. */
export function cleanTitleFromFileName(fileName: string): string {
  let t = fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:copy of|نسخ[ةه] من)\s+/i, '');
  for (let i = 0; i < 4; i++) {
    const next = t.replace(TRAILING_NOISE, '').trim();
    if (next === t) break;
    t = next;
  }
  t = t.replace(/[\s\-–_.]+$/, '').trim();
  return (t || fileName).slice(0, 300);
}

const NOT_A_TITLE = /^(?:contents|table of contents|index|فهرس|الفهرس|المحتويات|test fixture\b.*)$/i;

/**
 * A title proposal: the first heading of the first page when it reads like a title, else the cleaned file name.
 * Returns null when it would not change the current title.
 */
export function proposeTitle(fileName: string, firstHeading: string | null, currentTitle: string): IdentityDetection<string> | null {
  const same = (a: string, b: string) => normalizeIdentityText(a).replace(/\s+/g, ' ').trim() === normalizeIdentityText(b).replace(/\s+/g, ' ').trim();
  const heading = firstHeading?.replace(/\s+/g, ' ').trim() ?? '';
  if (heading.length >= 4 && heading.length <= 160 && !NOT_A_TITLE.test(heading) && /[\p{L}]{3}/u.test(heading)) {
    if (same(heading, currentTitle)) return null;
    return { value: heading, certainty: 'uncertain', reasons_ar: ['أول عنوان في الصفحة الأولى من الملف.'] };
  }
  const cleaned = cleanTitleFromFileName(fileName);
  if (same(cleaned, currentTitle)) return null;
  return { value: cleaned, certainty: 'uncertain', reasons_ar: ['اسم الملف بعد حذف الزوائد مثل «final (1)» و«copy».'] };
}

// ───────── subject placement (AOS-3.2, 3.7) ─────────
/** Bilingual names of common subjects → one key, so «Anatomy» (folder) matches «تشريح» (file name) and back. */
const SUBJECT_SYNONYMS: Record<string, string[]> = {
  anatomy: ['anatomy', 'anat', 'تشريح'],
  physiology: ['physiology', 'physio', 'فسلجه', 'فسيولوجي', 'وظائف'],
  biochemistry: ['biochemistry', 'biochem', 'كيمياء'],
  histology: ['histology', 'histo', 'انسجه'],
  pathology: ['pathology', 'patho', 'امراض'],
  pharmacology: ['pharmacology', 'pharma', 'ادويه', 'دوائيات'],
  microbiology: ['microbiology', 'micro', 'احياء'],
  surgery: ['surgery', 'surgical', 'جراحه'],
  medicine: ['medicine', 'internal', 'باطنيه'],
  pediatrics: ['pediatrics', 'paediatrics', 'peds', 'اطفال'],
  obstetrics: ['obstetrics', 'gynecology', 'gynaecology', 'obgyn', 'نسائيه', 'توليد'],
  community: ['community', 'مجتمع'],
  embryology: ['embryology', 'embryo', 'اجنه'],
  immunology: ['immunology', 'مناعه'],
};
const SYN_INDEX = new Map<string, string>(Object.entries(SUBJECT_SYNONYMS).flatMap(([k, words]) => words.map((w) => [w, k] as [string, string])));

const STOPWORDS = new Set([
  'lecture', 'lectures', 'lec', 'lect', 'notes', 'note', 'final', 'copy', 'part', 'the', 'and', 'for', 'with', 'from', 'pdf',
  'slides', 'slide', 'chapter', 'doc', 'version', 'new', 'updated', 'test', 'fixture', 'course', 'department', 'page',
  'محاضره', 'محاضرات', 'الدكتور', 'دكتور', 'ملخص', 'نهائي', 'نسخه', 'قسم', 'مادة', 'ماده', 'الى', 'على', 'عن', 'من', 'في',
]);

/** Significant tokens of a text: Latin words ≥ 3 letters, Arabic words ≥ 3 letters without «ال», no stopwords. */
export function subjectTokens(raw: string): string[] {
  const t = normalizeIdentityText(raw).replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2');
  const words = t.split(/[^a-zء-ي]+/).filter(Boolean);
  const out: string[] = [];
  for (let w of words) {
    if (/^[ء-ي]+$/.test(w) && w.startsWith('ال') && w.length > 4) w = w.slice(2);
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.push(SYN_INDEX.get(w) ? `#${SYN_INDEX.get(w)}` : w);
  }
  return [...new Set(out)];
}

export interface SubjectNode {
  id: string;
  title: string;
  kind: string;
  /** titles from the root to this node */
  path: string[];
}

export interface SubjectSuggestion {
  node: SubjectNode;
  certainty: 'certain' | 'uncertain';
  score: number;
  reasons_ar: string[];
}

/**
 * Placement suggestions for an upload: subject/course folders whose names appear in the file name (strong) or the
 * cover/header text of the first page. Never applied automatically (AOS-3.7); the caller drops folders that already
 * contain the source. Returns the candidates best-first (at most 3).
 */
export function suggestSubjects(fileName: string, coverText: string, nodes: readonly SubjectNode[]): SubjectSuggestion[] {
  const nameTokens = new Set(subjectTokens(fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '')));
  const coverTokens = new Set(subjectTokens(coverText.slice(0, 2000)));
  const scored: SubjectSuggestion[] = [];
  for (const node of nodes) {
    const tokens = subjectTokens(node.title);
    if (tokens.length === 0) continue;
    const inName = tokens.filter((x) => nameTokens.has(x));
    const inCover = tokens.filter((x) => !nameTokens.has(x) && coverTokens.has(x));
    const covered = (inName.length + inCover.length) / tokens.length;
    if (covered < 0.5 || inName.length + inCover.length === 0) continue;
    const score = covered * (inName.length ? 2 : 1) + (node.kind === 'course' ? 0.1 : 0);
    const shown = (x: string) => (x.startsWith('#') ? SUBJECT_SYNONYMS[x.slice(1)]!.slice(0, 2).join(' / ') : x);
    const reasons_ar = [
      ...(inName.length ? [`كلمات من اسم المجلد في اسم الملف: ${inName.map(shown).join('، ')}`] : []),
      ...(inCover.length ? [`كلمات من اسم المجلد في الصفحة الأولى: ${inCover.map(shown).join('، ')}`] : []),
    ];
    scored.push({ node, certainty: 'uncertain', score, reasons_ar });
  }
  scored.sort((a, b) => b.score - a.score || a.node.title.localeCompare(b.node.title));
  const top = scored.slice(0, 3);
  // «certain» (still held for confirmation): one clear winner named fully in the file name
  if (top.length && top[0]!.score >= 2 && (top.length === 1 || top[0]!.score - top[1]!.score >= 1)) top[0] = { ...top[0]!, certainty: 'certain' };
  return top;
}
