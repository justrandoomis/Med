// Deterministic text helpers for the Question Vault: labels, negation, numbers + units, tokens for matching
// and duplicate detection, fingerprints. Stored text is NEVER rewritten by these helpers — they only compute
// keys, flags and comparisons (§12: original stays original).
import { normalizeForSearch, segmentRuns, detectDir, stripBidiControls, type Paragraph, type RichText, type Run } from '@medlevo/shared';
import { sha256 } from '../../lib/hash';

// ───────── option labels ─────────
const LATIN = 'ABCDEFGH';
/** Arabic option letters in abjad order (أ ب ج د هـ و ز ح). */
const ARABIC = ['أ', 'ب', 'ج', 'د', 'ه', 'و', 'ز', 'ح'];

export type LabelScript = 'latin' | 'arabic' | 'digit';

export interface LabelInfo {
  script: LabelScript;
  /** 0-based position in its script's order */
  index: number;
  /** canonical form ('A', 'أ', '1') */
  canonical: string;
}

/** Parse an option / key label as printed: 'A', 'a', 'أ', 'ا' (OCR of أ), 'هـ', '1'. */
export function labelInfo(raw: string): LabelInfo | null {
  const s = stripBidiControls(raw).trim().replace(/[().\]\s:]/g, '');
  if (!s) return null;
  if (/^[A-Ha-h]$/.test(s)) {
    const i = LATIN.indexOf(s.toUpperCase());
    return { script: 'latin', index: i, canonical: LATIN[i]! };
  }
  if (/^[0-9٠-٩]{1,2}$/.test(s)) {
    const n = Number(s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)));
    if (n < 1 || n > 12) return null;
    return { script: 'digit', index: n - 1, canonical: String(n) };
  }
  const a = s === 'ا' || s === 'إ' || s === 'آ' ? 'أ' : s === 'هـ' || s === 'ة' ? 'ه' : s;
  const i = ARABIC.indexOf(a);
  if (i >= 0) return { script: 'arabic', index: i, canonical: ARABIC[i]! };
  return null;
}

export function labelAt(script: LabelScript, index: number): string {
  if (script === 'latin') return LATIN[index] ?? `#${index + 1}`;
  if (script === 'arabic') return ARABIC[index] ?? `#${index + 1}`;
  return String(index + 1);
}

/** Circled letters Ⓐ…Ⓗ / ⓐ…ⓗ → 'A'… (a printed circle glyph or an OCR reading of a hand-drawn circle). */
export function circledLetter(ch: string): string | null {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x24b6 && cp <= 0x24bd) return LATIN[cp - 0x24b6] ?? null;
  if (cp >= 0x24d0 && cp <= 0x24d7) return LATIN[cp - 0x24d0] ?? null;
  return null;
}

// ───────── negation (AC-11) ─────────
const EN_NEGATION = /\b(NOT|EXCEPT|LEAST|FALSE|INCORRECT|UNTRUE|NEVER)\b/gi;
/** normalized Arabic negation tokens: لا ليس ليست عدا ماعدا باستثناء غير إلا الخاطئة خاطئة خطأ */
const AR_NEGATION = new Set(['لا', 'ليس', 'ليست', 'عدا', 'ماعدا', 'باستثناء', 'استثناء', 'غير', 'الا', 'الخاطيه', 'خاطيه', 'خطا', 'الخطا']);

/** Negation terms as printed (order of appearance, verbatim casing). */
export function negationTerms(text: string): string[] {
  const out: string[] = [];
  const clean = stripBidiControls(text);
  for (const m of clean.matchAll(EN_NEGATION)) out.push(m[0]);
  for (const tok of clean.split(/[^\p{L}\p{M}]+/u)) {
    if (!tok) continue;
    const n = normalizeForSearch(tok);
    if (AR_NEGATION.has(n)) out.push(tok);
  }
  return out;
}

/** Case-insensitive multiset key of negation terms (for comparing raw vs structured). */
export function negationKey(terms: string[]): string[] {
  return terms.map((t) => normalizeForSearch(t)).sort();
}

// ───────── numbers & units (AC-11) ─────────
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺';
const NUM_UNIT = new RegExp(
  String.raw`(?<![\p{L}\p{N}.])(?:[<>≤≥±~]\s?)?[0-9٠-٩]+(?:[.,٫][0-9٠-٩]+)*` +
    String.raw`(?:\s*[×x]\s*10[${SUP}]+)?` +
    String.raw`(?:\s*(?:%|‰|°\s?[CF]|°|[µμ]?[a-zA-Z]{1,5}(?:\/[µμ]?[a-zA-Z0-9]{1,5})*[${SUP}²³]*|\/[µμ]?[a-zA-Z]{1,5}))?`,
  'gu',
);

/** Numeric values with their units/multipliers as printed (whitespace collapsed; comma/dot/unit kept). */
export function numberUnitTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of stripBidiControls(text).matchAll(NUM_UNIT)) {
    const t = m[0].replace(/\s+/g, '');
    if (t) out.push(t);
  }
  return out;
}

/** Multiset difference a − b. */
export function multisetMinus(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const c = counts.get(x) ?? 0;
    if (c > 0) counts.set(x, c - 1);
    else out.push(x);
  }
  return out;
}

// ───────── tokens for matching / duplicates ─────────
const EN_STOP = new Set(
  (
    'a an the of in on at to for from by with and or but if then than as is are was were be been being do does did has have had ' +
    'it its this that these those which what who whom whose when where why how most more less least very all any each every ' +
    'following true correct best likely statement statements regarding about into over under after before between during ' +
    'can could should would may might must will shall not no nor except false incorrect usually typically classically often ' +
    'i ii iii iv v one two three four five patient presents presenting year years old shown above below'
  ).split(/\s+/),
);
const AR_STOP = new Set(
  [
    'من', 'في', 'على', 'الي', 'الى', 'عن', 'ما', 'ماذا', 'هو', 'هي', 'هل', 'اي', 'التالي', 'التاليه', 'يلي', 'مما', 'الذي', 'التي', 'الذين', 'عند', 'مع',
    'او', 'و', 'ثم', 'كل', 'بعد', 'قبل', 'هذا', 'هذه', 'ذلك', 'تلك', 'كان', 'كانت', 'يكون', 'تكون', 'لا', 'ليس', 'غير', 'الا', 'عدا', 'ان', 'انه',
    'قد', 'لقد', 'بين', 'حول', 'اكثر', 'اقل', 'الاكثر', 'الاقل', 'جميع', 'بعض', 'فقط', 'ايضا', 'لدي', 'لدى', 'به', 'بها', 'له', 'لها', 'فيه', 'فيها',
  ].map((w) => normalizeForSearch(w)),
);
/** Generic clinical words: they match almost every lecture, so they only weakly support a topic link. */
const GENERIC = new Set(
  (
    'diagnosis diagnose diagnostic investigation investigate test tests testing treatment treat management manage sign symptom pain ' +
    'acute chronic disease condition patient first line preferred common cause feature finding associated important performed ' +
    'required risk factor value normal level range count type types clinical presentation exclude excluded suspected suspect ' +
    'initial next step choice useful used use method finding confirm confirms woman women man men child children adult adults age ' +
    'part score cell right left reference within usual value values range'
  ).split(/\s+/),
);
const AR_GENERIC = new Set(
  ['الفحص', 'فحص', 'الفحوصات', 'العلاج', 'علاج', 'التشخيص', 'تشخيص', 'المريض', 'مريض', 'الالم', 'الم', 'الاولي', 'المفضل', 'الشك', 'الحاد', 'حاد', 'علامه', 'اعراض', 'سبب', 'اسباب'].map((w) =>
    normalizeForSearch(w),
  ),
);

/** Light English stemming (possessive, plurals, -ness) and Arabic article stripping — for matching keys only. */
export function stemToken(tok: string): string {
  let t = tok.replace(/['’]s$/u, '').replace(/['’]/gu, '');
  if (/^[a-z]+$/.test(t)) {
    if (t.length > 6 && t.endsWith('ness')) t = t.slice(0, -4);
    if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
    else if (t.length > 4 && /(ches|shes|sses|xes)$/.test(t)) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
    return t;
  }
  // Arabic: strip the article and common proclitics (وال، بال، كال، فال، لل، ال) when ≥ 2 letters remain
  const m = /^(?:وال|بال|كال|فال|لل|ال)(.{2,})$/u.exec(t);
  if (m) t = m[1]!;
  return t;
}

export interface Token {
  /** normalized (search key) form */
  norm: string;
  /** stemmed matching key */
  stem: string;
  /** as printed */
  surface: string;
  generic: boolean;
}

/** Content tokens of a text: normalized, stopwords and bare numbers removed. */
export function contentTokens(text: string): Token[] {
  const out: Token[] = [];
  const seen = new Set<string>();
  for (const surface of stripBidiControls(text).split(/[^\p{L}\p{N}'’\-βαγ]+/u)) {
    for (const part of surface.split(/-/)) {
      const raw = part.replace(/^['’]+|['’]+$/g, '');
      if (!raw) continue;
      const norm = normalizeForSearch(raw);
      if (norm.length < 2 && !/^[β-ω]$/u.test(norm)) continue;
      if (/^[0-9.,]+$/.test(norm)) continue;
      const bare = norm.replace(/['’]s$/u, '').replace(/['’]/gu, '');
      if (EN_STOP.has(bare) || AR_STOP.has(bare)) continue;
      const stem = stemToken(norm);
      if (!stem || seen.has(stem)) continue;
      seen.add(stem);
      out.push({ norm: bare, stem, surface: raw, generic: GENERIC.has(stem) || GENERIC.has(bare) || AR_GENERIC.has(bare) || AR_GENERIC.has(stem) });
    }
  }
  return out;
}

/** Every token (incl. stopwords) — used for near-duplicate similarity where «not» matters. */
export function allTokens(text: string): string[] {
  return normalizeForSearch(stripBidiControls(text))
    .split(/[^\p{L}\p{N}.,%/×]+/u)
    .filter((t) => t.length > 0)
    .map((t) => stemToken(t));
}

export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Normalized form used for phrase containment and exact-duplicate fingerprints. Comparison operators and
 * direction arrows are KEPT: «Na < 120» and «Na > 120» are different questions and must never share a
 * fingerprint (they would be merged as exact duplicates, §36).
 */
export function normPhrase(text: string): string {
  return normalizeForSearch(stripBidiControls(text))
    .replace(/[^\p{L}\p{N}.,%/×⁰-⁹+\-'<>≤≥≦≧≮≯±=≠≈↑↓⇧⇩]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Exact duplicate identity: normalized stem + the SET of normalized options (order-insensitive, AC-17). */
export function fingerprint(stem: string, options: string[]): string {
  const opts = options.map(normPhrase).sort();
  return sha256(`${normPhrase(stem)}\u0001${opts.join('\u0002')}`);
}

// ───────── rich text with emphasized negation ─────────
/** RichText from plain text; negation terms become their own runs marked 'em' + 'b' (kept verbatim). */
export function richTextWithNegation(text: string): RichText {
  const paragraphs: Paragraph[] = stripBidiControls(text)
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const dir = detectDir(p);
      return { dir, runs: emphasizeNegation(segmentRuns(p, dir)) };
    });
  return { v: 1, paragraphs };
}

function emphasizeNegation(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const terms = negationTerms(r.t);
    if (terms.length === 0) {
      out.push(r);
      continue;
    }
    // split the run around each negation term occurrence (whole words only)
    const pattern = new RegExp(`(?<![\\p{L}\\p{M}])(${terms.map(escapeRe).join('|')})(?![\\p{L}\\p{M}])`, 'gu');
    let last = 0;
    for (const m of r.t.matchAll(pattern)) {
      const i = m.index ?? 0;
      if (i > last) out.push({ ...r, t: r.t.slice(last, i) });
      out.push({ ...r, t: m[0], marks: [...new Set([...(r.marks ?? []), 'b', 'em'])] as Run['marks'] });
      last = i + m[0].length;
    }
    if (last < r.t.length) out.push({ ...r, t: r.t.slice(last) });
  }
  return out.filter((r) => r.t.length > 0);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Words that, when the stem ends with them, show the text was cut (AC-10 truncation). */
const DANGLING = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'with', 'to', 'in', 'for', 'by', 'is', 'are', 'من', 'في', 'على', 'إلى', 'الى', 'و', 'أو', 'او', 'عن', 'مع']);
/** The text stops mid-phrase («… 3.5 to», «… and», «… ,»): the next line is its continuation. */
export function endsMidPhrase(text: string): boolean {
  const s = stripBidiControls(text).trim();
  const last = s.split(/\s+/).pop() ?? '';
  return DANGLING.has(last.toLowerCase()) || /[,،\-–(/]$/.test(s);
}

export function looksTruncated(stem: string): boolean {
  const s = stripBidiControls(stem).trim();
  if (s.length < 8) return true;
  const last = s.split(/\s+/).pop() ?? '';
  return DANGLING.has(last.toLowerCase()) || /[,،\-–(]$/.test(s);
}

/** The stem refers to a picture / figure / table that must be attached. */
export function refersToImage(stem: string): boolean {
  // a picture is named («image», «figure», «this ECG») or pointed at («shown below»); a bare «below» / «shown»
  // («the values below», «has been shown to …») does not make a question depend on an image
  return (
    /\b(?:image|picture|photo(?:graph)?|figure|fig\.|diagram|illustrat(?:ed|ion)|labell?ed\s+(?:structure|area|part))\b/i.test(stem) ||
    /\b(?:shown|seen|depicted|displayed)\s+(?:below|above|here|in\s+the)\b/i.test(stem) ||
    /\b(?:ecg|ekg|radiograph|x-?ray|ct|mri|scan|slide|smear|specimen|film|trace|tracing)\s+(?:below|above|shown|provided|attached)\b/i.test(stem) ||
    /\b(?:this|the\s+following)\s+(?:ecg|ekg|radiograph|x-?ray|scan|slide|smear|film|tracing)\b/i.test(stem) ||
    /(الصورة|الشكل|المبين|الموضح|المرفق)/u.test(stem)
  );
}

/** Rough item type for later Exam DNA (§40) — an ESTIMATE from the stem's wording, never shown as fact. */
export function itemTypeOf(stem: string): string | null {
  const s = stem.toLowerCase();
  if (/(investigation|test|imaging|scan|first-line|first line|الفحص|فحص)/.test(s)) return 'investigation';
  if (/(diagnos|التشخيص)/.test(s)) return 'diagnosis';
  if (/(manage|treat|therapy|drug of choice|العلاج|علاج)/.test(s)) return 'management';
  if (/(complication|مضاعف)/.test(s)) return 'complications';
  if (/(mechanism|pathophysiolog|آلية|الية)/.test(s)) return 'mechanism';
  if (/(next step|الخطوة التالية)/.test(s)) return 'next_step';
  if (/(sign|symptom|tender|feature|علامة|عرض)/.test(s)) return 'clinical_feature';
  if (/(risk factor|عوامل الخطر)/.test(s)) return 'risk_factors';
  return 'recall';
}
