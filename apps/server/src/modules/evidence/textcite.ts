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
const PSEUDO_CITATION_PATTERNS: RegExp[] = [
  /[[(（]\s*[ER]\s*\d+(?:\s*[,،;؛-]\s*[ER]?\s*\d+)*\s*[\])）]/giu, // [E5] (E1, E2) [R2]
  new RegExp(`(?<![\\p{L}\\p{N}])ص\\s*\\.?\\s*${DIGITS}+`, 'gu'), // ص 99 · ص.99 · (ص99)
  new RegExp(`(?<![\\p{L}])(?:ال)?(?:صفحة|صفحات|صفحتي|شريحة|شرائح|فقرة)\\s*(?:رقم\\s*)?${DIGITS}+`, 'gu'), // الصفحة 99 · صفحة ٩٩ · الشريحة 4
  /\b(?:pp?|pg)\.\s*\d+/giu, // p. 31 · pp. 3-4 · pg. 2
  /\b(?:pages?|slides?)\s+\d+/giu, // page 12 · slides 3
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

