// Text «citations» (G2 / AC-06). Shared by every generator that publishes model text (Study Book, explanations, chat,
// generated questions): a citation is a server-made link (claim → evidence row → region → page), never text.
/**
 * G2 / AC-06: a citation is a server-made link (claim → evidence row → region → page), never text. The model has no
 * page field, so a page / slide / alias it «cites» can only be written into the TEXT — «(المحاضرة ص 99)»,
 * «Bailey & Love p. 1234», «[E9]», «الشريحة 4» — where nothing checked it: it may name a page that does not exist
 * or that says something else. Such text is never published (sentences are removed and reported; labels and free
 * notes are stripped of the reference). Figure / table numbers («Figure 1») are document structure, not citations.
 */
const DIGITS = '[0-9٠-٩۰-۹]';
// H1: unusual phrasings — ordinals, relative positions, number words, roman numerals («see the third page»,
// «on the next slide», «page three», «page xii», «slide #4», «انظر الصفحة الثالثة», «في الشريحة التالية»,
// «الصفحة رقم سبعة», «بالصفحة 4»). Only page / slide nouns take ordinals and relative words: «the next step»,
// «الخطوة التالية» or «الفقرة التالية» (the explanation's own next paragraph) are not references to a source.
const EN_ORDINAL = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|next|previous|preceding|following|last|final|facing|opposite|same';
const EN_NUMBER_WORD = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty';
const AR_PREFIX = '(?:[وفبلك]?ال|لل|[وفبلك])?';
const AR_PAGE_NOUN = '(?:صفح[ةه]|شريح[ةه])';
const AR_ORDINAL =
  '(?:[أاإ]ول[ىي]|ثاني[ةه]|ثالث[ةه]|رابع[ةه]|خامس[ةه]|سادس[ةه]|سابع[ةه]|ثامن[ةه]|تاسع[ةه]|عاشر[ةه]|حادي[ةه])(?:\\s+عشر[ةه]?)?';
const AR_RELATIVE = '(?:تالي[ةه]|سابق[ةه]|[أاإ]خير[ةه]|ماضي[ةه]|قادم[ةه]|مقبل[ةه]|[آا]تي[ةه]|مقابل[ةه]|نفسها|ذاتها)';
const AR_NUMBER_WORD =
  '(?:واحد[ةه]?|[أاإ]ثن(?:ان|ين|تان|تين)|ثلاث[ةه]?|[أاإ]ربع[ةه]?|خمس[ةه]?|ست[ةه]?|سبع[ةه]?|ثماني[ةه]?|ثمان|تسع[ةه]?|عشر[ةه]?|عشرين|عشرون)';
const PSEUDO_CITATION_PATTERNS: RegExp[] = [
  /[[(（]\s*[ER]\s*\d+(?:\s*[,،;؛-]\s*[ER]?\s*\d+)*\s*[\])）]/giu, // [E5] (E1, E2) [R2]
  new RegExp(`(?<![\\p{L}\\p{N}])ص\\s*\\.?\\s*${DIGITS}+`, 'gu'), // ص 99 · ص.99 · (ص99)
  // الصفحة 99 · صفحة ٩٩ · الشريحة 4 · بالصفحة 4 · وفي الشريحة 3
  new RegExp(`(?<![\\p{L}])${AR_PREFIX}(?:صفح[ةه]|صفحات|صفحتي|شريح[ةه]|شرائح|فقر[ةه])\\s*(?:رقم\\s*)?${DIGITS}+`, 'gu'),
  // الصفحة الثالثة · الشريحة التالية · الصفحة الحادية عشرة · الصفحة نفسها
  new RegExp(`(?<![\\p{L}])${AR_PREFIX}${AR_PAGE_NOUN}\\s+(?:رقم\\s+)?(?:ال)?(?:${AR_ORDINAL}|${AR_RELATIVE})(?![\\p{L}])`, 'gu'),
  // نفس الصفحة
  new RegExp(`(?<![\\p{L}])نفس\\s+(?:ال)?${AR_PAGE_NOUN}(?![\\p{L}])`, 'gu'),
  // الصفحة رقم سبعة (number words only after «رقم»: «صفحة واحدة» is a quantity)
  new RegExp(`(?<![\\p{L}])${AR_PREFIX}${AR_PAGE_NOUN}\\s+رقم\\s+${AR_NUMBER_WORD}(?![\\p{L}])`, 'gu'),
  /\b(?:pp?|pg)\.\s*\d+/giu, // p. 31 · pp. 3-4 · pg. 2
  /\b(?:pages?|slides?)\s+\d+/giu, // page 12 · slides 3
  /\b(?:pages?|slides?)\s*(?:#|no\.?|number|num\.?)\s*\d+/giu, // slide #4 · page no. 12 · page number 7
  new RegExp(`\\b(?:${EN_ORDINAL})\\s+(?:pages?|slides?)\\b`, 'giu'), // the third page · the next slide
  new RegExp(`\\bpages?\\s+(?:${EN_NUMBER_WORD})\\b`, 'giu'), // page three
  // slide two — the NOUN only (after a preposition / article, or at the start of a sentence or a bracket): «filaments
  // slide one over the other» is the verb (H1 review)
  // («to» only after a referral verb: «refer to slide two», not «tend to slide one over the other»)
  new RegExp(
    `(?:(?<=\\b(?:on|in|at|from|see|of|the|per|(?:refer|referring|back|go|turn|according)\\s+to)\\s+)|(?<=^\\s*)|(?<=[.!?:;([]\\s*))slides?\\s+(?:${EN_NUMBER_WORD})\\b`,
    'giu',
  ),
  /\b(?:pages?|p\.)\s+(?=[ivxlc]+\b)(?:x{0,3})(?:ix|iv|v?i{0,3})(?![a-z])/giu, // page xii · p. iv
];

/** The page / slide / alias references written in a text (the matched substrings). */
export function pseudoCitations(text: string): string[] {
  const out: string[] = [];
  for (const re of PSEUDO_CITATION_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push(m[0]);
  }
  return out;
}

export function hasPseudoCitation(text: string): boolean {
  return pseudoCitations(text).length > 0;
}

const normRef = (t: string) =>
  t
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * References in a sentence that its own cited excerpts do not contain. A verbatim / faithful quote of a source that
 * itself says «see page 14» keeps it (those are the source's words, checked against the excerpt); anything else
 * was written by the model.
 */
export function inventedCitations(text: string, quotes: string[]): string[] {
  const q = quotes.map(normRef);
  return pseudoCitations(text).filter((m) => !q.some((x) => x.includes(normRef(m))));
}

/** Remove text «citations» from a label or a free note: a bracketed group that carries one goes as a whole. */
export function stripPseudoCitations(text: string): string {
  if (!hasPseudoCitation(text)) return text;
  let t = text.replace(/[([（]([^()[\]（）]*)[)\]）]/gu, (m) => (hasPseudoCitation(m) ? '' : m));
  for (const re of PSEUDO_CITATION_PATTERNS) t = t.replace(re, '');
  return t
    .replace(/\s+([.,،؛;:!?؟])/gu, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s—–\-,،:؛]+|[\s—–\-,،:؛]+$/gu, '')
    .trim();
}

