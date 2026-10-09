// Deterministic claim ↔ evidence checks (§12, AC-07): critical tokens and quote containment.
//
// A claim may paraphrase or translate its evidence, but the tokens that change medical meaning must be
// present in the union of the cited quotes after normalization:
//   negations (EN + AR), numbers (Arabic-Indic digits, decimal commas, thousands separators), units
//   (mg, g, mmol/L, ×10⁹/L, %, °C, mmHg, IU, mL …, Arabic unit words), number+unit quantities (doses,
//   values), thresholds (>, <, ≥, ≤, more/less than, أكثر/أقل من …), age groups / populations and
//   exceptions (except, unless, باستثناء …). Latin terms inside an Arabic claim and abbreviations must
//   also appear (cross-language claims are allowed, their technical tokens must match).
// A dropped negation is caught with a clause-level polarity check: a claim without negation whose
// content words match a NEGATED evidence clause fails (e.g. evidence «does NOT exclude it», claim
// «… excludes it»). These checks never prove support — they only refuse obvious mismatches; support is
// decided by the independent entailment verifier (claims.ts).
import { detectDir, normalizeForSearch, stripBidiControls } from '@medlevo/shared';

const SUPERSCRIPTS: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };

/** Base normalization for token matching: digits, separators, superscripts, multiplication sign, case. */
export function baseNormalize(text: string): string {
  let t = stripBidiControls(text).normalize('NFC');
  t = t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  t = t.replace(/٫/g, '.').replace(/٬/g, ',');
  // superscript exponents → ^n («10⁹» → «10^9»)
  t = t.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (m) => '^' + Array.from(m, (c) => SUPERSCRIPTS[c] ?? '').join(''));
  t = t.replace(/[×✕✖]/g, ' x ').replace(/\*\s*10\s*\^/g, ' x 10^');
  t = t.replace(/[µμ]/g, 'u');
  t = t.replace(/[≧]/g, '≥').replace(/[≦]/g, '≤').replace(/=>/g, '≥').replace(/>=/g, '≥').replace(/<=/g, '≤');
  t = t.replace(/[‐‑‒–—]/g, '-');
  return t.toLowerCase();
}

/** Arabic letter-form normalization on top of baseNormalize (alef/ya/ta marbuta, harakat, tatweel). Applied to
 *  the text AND to every Arabic word list / regex below (see `arRe`), so «أعلى», «على», «مئوية» match. */
function arabicNormalize(t: string): string {
  return t
    .replace(/ـ/g, '')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

export function matchNormalize(text: string): string {
  return arabicNormalize(baseNormalize(text));
}

/**
 * A regex written with natural Arabic spellings, rewritten to the normalized letter forms the text is matched
 * in (ى→ي, ة→ه, ئ→ي, أ/إ/آ→ا). Without this, patterns such as «أعلى من», «على الأقل», «بالمئة» or «درجة
 * مئوية» could never match the normalized text (an inverted Arabic threshold passed the check). Regex syntax
 * is ASCII and is not touched.
 */
function arRe(re: RegExp): RegExp {
  return new RegExp(arabicNormalize(re.source), re.flags);
}

// ───────── units ─────────
// [canonical, regex source (lowercase, after baseNormalize)] — longest first; matched right after a number.
const UNIT_TABLE: Array<[string, string]> = [
  ['x10^12/l', 'x\\s*10\\s*\\^\\s*12\\s*/\\s*l'],
  ['x10^9/l', 'x\\s*10\\s*\\^\\s*9\\s*/\\s*l'],
  ['x10^3/ul', 'x\\s*10\\s*\\^\\s*3\\s*/\\s*(?:ul|mm\\^?3)'],
  ['x10^n', 'x\\s*10\\s*\\^\\s*-?\\d+'],
  ['mmol/l', 'mmol\\s*/\\s*l'],
  ['umol/l', 'umol\\s*/\\s*l'],
  ['meq/l', 'meq\\s*/\\s*l'],
  ['mg/dl', 'mg\\s*/\\s*dl'],
  ['g/dl', 'g\\s*/\\s*dl'],
  ['mg/l', 'mg\\s*/\\s*l'],
  ['g/l', 'g\\s*/\\s*l'],
  ['ng/ml', 'ng\\s*/\\s*ml'],
  ['pg/ml', 'pg\\s*/\\s*ml'],
  ['iu/l', 'iu\\s*/\\s*l'],
  ['iu/ml', 'iu\\s*/\\s*ml'],
  ['u/l', 'u\\s*/\\s*l'],
  ['mg/kg', 'mg\\s*/\\s*kg'],
  ['mcg/kg', '(?:mcg|ug)\\s*/\\s*kg'],
  ['ml/kg/h', 'ml\\s*/\\s*kg\\s*/\\s*(?:h|hr|hour)'],
  ['ml/kg', 'ml\\s*/\\s*kg'],
  ['ml/h', 'ml\\s*/\\s*(?:h|hr|hour)'],
  ['ml/min', 'ml\\s*/\\s*min'],
  ['l/min', 'l\\s*/\\s*min'],
  ['mg/day', 'mg\\s*/\\s*(?:day|d)(?![\\p{L}\\p{N}])'],
  ['kg/m2', 'kg\\s*/\\s*m\\s*\\^?\\s*2'],
  ['/min', '(?:/\\s*min|bpm|breaths\\s*/\\s*min|beats\\s*/\\s*min)'],
  ['mmhg', 'mm\\s*hg'],
  ['cmh2o', 'cm\\s*h2o'],
  ['kpa', 'kpa'],
  ['°c', '°\\s*c(?![\\p{L}\\p{N}])|degrees?\\s+c(?:elsius)?(?![\\p{L}\\p{N}])|درجه\\s+مئويه'],
  ['°f', '°\\s*f(?![\\p{L}\\p{N}])'],
  ['%', '%|٪|percent(?![\\p{L}\\p{N}])|بالمئه|بالمائه|في\\s+المئه|في\\s+المائه'],
  ['mcg', '(?:mcg|ug|micrograms?)(?![\\p{L}\\p{N}])|ميكروغرام'],
  ['mg', '(?:mg|milligrams?)(?![\\p{L}\\p{N}])|ملغم?(?![\\p{L}\\p{N}])|مغ(?![\\p{L}\\p{N}])|ملليغرام|مليغرام'],
  ['kg', '(?:kg|kilograms?)(?![\\p{L}\\p{N}])|كغم?(?![\\p{L}\\p{N}])|كيلوغرام'],
  ['g', '(?:g|grams?|gm)(?![\\p{L}\\p{N}])|غم(?![\\p{L}\\p{N}])|غرام'],
  ['mmol', 'mmol(?![\\p{L}\\p{N}])'],
  ['meq', 'meq(?![\\p{L}\\p{N}])'],
  ['iu', '(?:iu|units?)(?![\\p{L}\\p{N}])|وحده\\s+دوليه|وحدات\\s+دوليه'],
  ['ml', '(?:ml|millilit(?:re|er)s?)(?![\\p{L}\\p{N}])|مل(?![\\p{L}\\p{N}])|ملليلتر|مليلتر'],
  ['dl', 'dl(?![\\p{L}\\p{N}])'],
  ['l', '(?:l|lit(?:re|er)s?)(?![\\p{L}\\p{N}])|لتر'],
  ['cm', '(?:cm|centimet(?:re|er)s?)(?![\\p{L}\\p{N}])|سم(?![\\p{L}\\p{N}])'],
  ['mm', '(?:mm|millimet(?:re|er)s?)(?![\\p{L}\\p{N}])|ملم(?![\\p{L}\\p{N}])'],
  ['h', '(?:h|hrs?|hours?)(?![\\p{L}\\p{N}])|ساعه|ساعات'],
  ['min', '(?:min|mins|minutes?)(?![\\p{L}\\p{N}])|دقيقه|دقائق'],
  ['s', '(?:sec|secs|seconds?)(?![\\p{L}\\p{N}])|ثانيه|ثوان'],
  ['day', '(?:days?|d)(?![\\p{L}\\p{N}])|يوم|ايام'],
  ['week', '(?:weeks?|wks?)(?![\\p{L}\\p{N}])|اسبوع|اسابيع'],
  ['month', 'months?(?![\\p{L}\\p{N}])|شهر|اشهر|شهور'],
  ['year', '(?:years?|yrs?|y)(?![\\p{L}\\p{N}])|سنه|سنوات|سنين|عام|اعوام'],
];
const UNIT_RES: Array<[string, RegExp]> = UNIT_TABLE.map(([c, src]) => [c, new RegExp(`^\\s*(?:${arabicNormalize(src)})`, 'u')]);

// a number: digits with optional . or , groups (no leading sign)
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

export function canonicalNumber(raw: string): string {
  let s = raw;
  if (s.includes(',')) {
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(/,/g, '.');
  }
  // more than one dot (e.g. a version «1.2.3»): keep verbatim
  if ((s.match(/\./g) ?? []).length > 1) return s;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
}

// ───────── comparators (thresholds) ─────────
type Comparator = 'gt' | 'lt' | 'ge' | 'le';
const COMPARATOR_WORDS: Array<[Comparator, RegExp]> = (
  [
    ['ge', /(?:≥|\bat\s+least|\bno\s+(?:less|fewer)\s+than|\bminimum\s+of|على\s+الأقل|لا\s+يقل\s+عن|لا\s+تقل\s+عن)\s*$/u],
    ['le', /(?:≤|\bat\s+most|\bno\s+more\s+than|\bnot\s+(?:more\s+than|exceeding)|\bup\s+to|\bmaximum\s+of|على\s+الأكثر|لا\s+يزيد\s+عن|لا\s+تزيد\s+عن|لا\s+يزيد\s+على|لا\s+تزيد\s+على)\s*$/u],
    ['gt', /(?:>|\bmore\s+than|\bgreater\s+than|\bhigher\s+than|\babove|\bover|\bexceed(?:s|ing)?|\bin\s+excess\s+of|أكثر\s+من|أكبر\s+من|أعلى\s+من|فوق|يتجاوز|تتجاوز|يزيد\s+عن|تزيد\s+عن|يزيد\s+على|تزيد\s+على)\s*$/u],
    ['lt', /(?:<|\bless\s+than|\bfewer\s+than|\blower\s+than|\bbelow|\bunder|أقل\s+من|أصغر\s+من|أدنى\s+من|تحت|(?<!من\s)(?<![\p{L}])دون)\s*$/u],
  ] as Array<[Comparator, RegExp]>
).map(([c, re]) => [c, arRe(re)]);
const TRAILING_COMPARATORS: Array<[Comparator, RegExp]> = (
  [
    ['ge', /^\s*(?:or\s+more|or\s+above|or\s+greater|or\s+higher|or\s+over|and\s+above|and\s+over|أو\s+أكثر|فأكثر|فما\s+فوق)/u],
    ['le', /^\s*(?:or\s+less|or\s+below|or\s+fewer|or\s+lower|or\s+under|and\s+below|and\s+under|أو\s+أقل|فأقل|فما\s+دون)/u],
  ] as Array<[Comparator, RegExp]>
).map(([c, re]) => [c, arRe(re)]);

// ───────── negations / exceptions / populations ─────────
const EN_NEGATIONS = new Set(['not', 'no', 'never', 'without', 'none', 'neither', 'nor', 'cannot', 'absent', 'non']);
const EN_NEG_CONTRACTION = /\b[a-z]+n['’]t\b/;
const AR_NEGATIONS = new Set(['لا', 'ليس', 'ليست', 'ليسوا', 'لم', 'لن', 'غير', 'بدون', 'بلا', 'عدم', 'ابدا', 'مطلقا', 'لايستبعد']);
const EN_EXCEPTIONS = /\b(?:except|excepting|unless|apart\s+from|other\s+than|excluding|with\s+the\s+exception\s+of|but\s+not)\b/;
const AR_EXCEPTIONS = arRe(/(?<![\p{L}\p{N}])(?:باستثناء|ماعدا|ما\s+عدا|عدا|إلا|سوى|خلا|فيما\s+عدا)(?![\p{L}\p{N}])/u);

const POPULATIONS: Array<[string, RegExp]> = (
  [
  ['neonate', /\b(?:neonat\w*|newborns?|new-born)\b|حديثي\s+الولاده|حديث\s+الولاده|الولدان|الخدج/u],
  ['infant', /\binfants?\b|(?<![\p{L}\p{N}])(?:وال|فال|بال|كال|لل|ال|و|ف|ب|ل)?(?:رضع|رضيع)(?![\p{L}\p{N}])/u],
  ['child', /\b(?:child(?:ren|hood)?|paediatric|pediatric|kids?)\b|(?<![\p{L}\p{N}])(?:وال|فال|بال|كال|لل|ال|و|ف|ب|ل)?(?:اطفال|طفل|طفوله)(?![\p{L}\p{N}])/u],
  ['adolescent', /\b(?:adolescen\w*|teenagers?)\b|مراهق/u],
  ['adult', /\badults?\b|(?<![\p{L}\p{N}])(?:وال|فال|بال|كال|لل|ال|و|ف|ب|ل)?(?:بالغين|بالغ|كبار)(?!\s+السن)(?![\p{L}\p{N}])/u],
  ['elderly', /\b(?:elderly|geriatric|older\s+(?:adults|patients|people))\b|كبار\s+السن|(?:وال|فال|بال|كال|لل|ال|و|ف|ب|ل)?مسنين|مسن(?![\p{L}\p{N}])/u],
  ['pregnant', /\bpregnan\w*\b|(?<![\p{L}\p{N}])(?:وال|فال|بال|كال|لل|ال|و|ف|ب|ل)?(?:حامل|حوامل|حمل)(?![\p{L}\p{N}])/u],
  ['reproductive_age', /\breproductive\s+age\b|سن\s+الانجاب/u],
  ['male', /\b(?:men|males?)\b|(?<![\p{L}\p{N}])(?:وال|فال|بال|كال|لل|ال|و|ف|ب|ل)?(?:رجال|ذكور)(?![\p{L}\p{N}])/u],
  ['female', /\b(?:women|females?)\b|(?<![\p{L}\p{N}])(?:وال|فال|بال|كال|لل|ال|و|ف|ب|ل)?(?:نساء|اناث)(?![\p{L}\p{N}])/u],
] as Array<[string, RegExp]>
).map(([k, re]) => [k, arRe(re)]);

const EN_STOP = new Set(
  'the a an is are was were be been being of in on at to for and or with by from as that this these those it its does do did has have had which who whom when where after before but than then usually often may might can could should would will shall also into onto about such there their they them he she his her we our you your i me my so if because while during per via each any all some most more less very only just both either other others'.split(' '),
);
const AR_STOP = new Set(['في', 'من', 'علي', 'على', 'الي', 'إلى', 'عن', 'ثم', 'او', 'و', 'ان', 'هو', 'هي', 'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'الذين', 'عند', 'مع', 'كما', 'قد', 'لكن', 'بعد', 'قبل', 'كل', 'بين', 'حول', 'عاده', 'ما', 'ماذا', 'هل', 'كان', 'كانت', 'يكون', 'تكون', 'به', 'بها', 'له', 'لها', 'فيه', 'فيها']);

export interface CriticalTokens {
  negation: boolean;
  negation_forms: string[];
  numbers: string[];
  units: string[];
  quantities: string[];
  comparators: Comparator[];
  /** comparator + its number («gt 11»): a threshold is the PAIR, so swapped thresholds are caught */
  thresholds: string[];
  populations: string[];
  exception: boolean;
  /** Latin words (lower-case, light-stemmed) — enforced for Arabic claims (cross-language) */
  latin_terms: string[];
  /** abbreviations as written (≥ 2 capitals), enforced for every claim */
  abbreviations: string[];
}

function lightStemEn(w: string): string {
  let s = w.replace(/['’]s$/, '').replace(/['’]$/, '');
  if (s.length > 5 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 5 && /(?:ss|x|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('is') && !s.endsWith('us')) s = s.slice(0, -1);
  if (s.length > 6 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 5 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 5 && s.endsWith('es')) s = s.slice(0, -1);
  // «exclude / excludes / excluded / excluding» → one stem (otherwise a dropped NOT in «cannot be excluded» vs
  // «excludes» was not recognised as the same verb)
  if (s.length > 4 && s.endsWith('e') && !s.endsWith('ee')) s = s.slice(0, -1);
  return s;
}

function lightStemAr(w: string): string {
  let s = w;
  for (const p of ['وال', 'فال', 'بال', 'كال', 'لل', 'ال']) {
    if (s.startsWith(p) && s.length - p.length >= 2) {
      s = s.slice(p.length);
      break;
    }
  }
  if (s.length > 3 && /^[وفبكل]/.test(s) && !/^(?:ال)/.test(s)) {
    const rest = s.slice(1);
    if (rest.startsWith('ال') && rest.length > 3) s = rest.slice(2);
  }
  return s;
}

/** «ولا», «فلم», «وهو», «فهي»: a conjunction glued to a negation / stop word is not a content word. */
function isPrefixedArFunctionWord(w: string): boolean {
  if (w.length < 3 || !/^[وف]/.test(w)) return false;
  const rest = w.slice(1);
  return AR_NEGATIONS.has(rest) || AR_STOP.has(rest);
}

/** Words for overlap comparisons: normalized, stop words / negations removed, light-stemmed. */
export function contentWords(text: string): Set<string> {
  const norm = normalizeForSearch(baseNormalize(text));
  const out = new Set<string>();
  for (const raw of norm.split(/[^\p{L}\p{N}'’]+/u)) {
    const w = raw.replace(/^['’]+|['’]+$/g, '');
    if (!w) continue;
    if (/^\d+$/.test(w)) continue;
    if (/[a-z]/.test(w)) {
      if (w.length < 3 || EN_STOP.has(w) || EN_NEGATIONS.has(w) || EN_NEG_CONTRACTION.test(w)) continue;
      out.add(lightStemEn(w));
    } else {
      if (w.length < 2 || AR_STOP.has(w) || AR_NEGATIONS.has(w) || isPrefixedArFunctionWord(w)) continue;
      out.add(lightStemAr(w));
    }
  }
  return out;
}

function hasNegation(norm: string): { negation: boolean; forms: string[] } {
  const forms: string[] = [];
  const words = norm.split(/[^\p{L}\p{N}'’]+/u).filter(Boolean);
  for (const w of words) {
    if (EN_NEGATIONS.has(w) || EN_NEG_CONTRACTION.test(w)) forms.push(w);
    else {
      const bare = AR_NEGATIONS.has(w) ? w : /^[وف]/.test(w) && AR_NEGATIONS.has(w.slice(1)) ? w.slice(1) : null;
      if (bare) forms.push(bare);
    }
  }
  return { negation: forms.length > 0, forms };
}

/** Extract the meaning-critical tokens of a sentence or quote. */
export function extractCriticalTokens(text: string): CriticalTokens {
  const original = stripBidiControls(text);
  const norm = matchNormalize(original);
  const numbers: string[] = [];
  const units: string[] = [];
  const quantities: string[] = [];
  const comparators: Comparator[] = [];
  const thresholds: string[] = [];

  // numbers with attached unit / comparator (scan the normalized text)
  let masked = norm;
  const unitSpans: Array<[number, number]> = [];
  for (const m of norm.matchAll(NUMBER_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    // part of an exponent («10^9») or of a unit already consumed
    if (norm[start - 1] === '^' || unitSpans.some(([s, e]) => start >= s && start < e)) continue;
    // a letter glued before the number belongs to a word/code (e.g. «h2o», «b12») — keep as number anyway
    const num = canonicalNumber(m[0]);
    numbers.push(num);
    const after = norm.slice(end);
    for (const [canon, re] of UNIT_RES) {
      const um = re.exec(after);
      if (um) {
        units.push(canon);
        quantities.push(`${num} ${canon}`);
        unitSpans.push([end, end + um[0].length]);
        break;
      }
    }
    const before = norm.slice(Math.max(0, start - 40), start);
    for (const [cmp, re] of COMPARATOR_WORDS) {
      if (re.test(before)) {
        comparators.push(cmp);
        thresholds.push(`${cmp} ${num}`);
        break;
      }
    }
    for (const [cmp, re] of TRAILING_COMPARATORS) {
      const unitEnd = unitSpans.length && unitSpans[unitSpans.length - 1]![0] === end ? unitSpans[unitSpans.length - 1]![1] : end;
      if (re.test(norm.slice(unitEnd, unitEnd + 30))) {
        comparators.push(cmp);
        thresholds.push(`${cmp} ${num}`);
      }
    }
  }
  for (const [s, e] of unitSpans) masked = masked.slice(0, s) + ' '.repeat(e - s) + masked.slice(e);

  const neg = hasNegation(norm);
  const exception = EN_EXCEPTIONS.test(norm) || AR_EXCEPTIONS.test(norm);
  const populations = POPULATIONS.filter(([, re]) => re.test(norm)).map(([k]) => k);

  // Latin words / abbreviations (from the original casing for abbreviations)
  const latin = new Set<string>();
  for (const w of masked.match(/[a-z][a-z0-9'’-]*/g) ?? []) {
    const clean = w.replace(/['’-]+$/, '');
    if (clean.length < 3 || EN_STOP.has(clean) || EN_NEGATIONS.has(clean) || EN_NEG_CONTRACTION.test(clean)) continue;
    latin.add(lightStemEn(clean));
  }
  const abbreviations = new Set<string>();
  for (const w of original.match(/\b[A-Z][A-Z0-9]{1,9}\b/g) ?? []) {
    const lw = w.toLowerCase();
    if (EN_NEGATIONS.has(lw) || /^\d+$/.test(w)) continue;
    abbreviations.add(w);
  }

  return {
    negation: neg.negation,
    negation_forms: neg.forms,
    numbers: uniq(numbers),
    units: uniq(units),
    quantities: uniq(quantities),
    comparators: uniq(comparators),
    thresholds: uniq(thresholds),
    populations,
    exception,
    latin_terms: [...latin],
    abbreviations: [...abbreviations],
  };
}

function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}

/** Split a quote into clauses (sentence / «but» / semicolon boundaries) for the polarity check. */
export function clauses(text: string): string[] {
  return stripBidiControls(text)
    .split(/(?<=[.!?؟])\s+|[;؛]\s*|\n+|,?\s+(?:but|however|whereas|although|though|yet)\s+|،?\s*(?:لكن|ولكن|بينما|غير\s+[أاإ]ن|[إا]لا\s+[أاإ]ن)\s+/iu)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface CriticalCheckResult {
  passed: boolean;
  /** Arabic, specific reasons (one per failed token family) */
  reasons_ar: string[];
  missing: {
    numbers: string[];
    units: string[];
    quantities: string[];
    comparators: string[];
    /** comparator + number pairs («gt 11») absent from the evidence although both parts occur there */
    thresholds: string[];
    populations: string[];
    latin_terms: string[];
    abbreviations: string[];
    negation: boolean;
    dropped_negation: boolean;
    exception: boolean;
    /** the evidence states an exception («except obesity») that the claim leaves out */
    dropped_exception: boolean;
  };
  claim_tokens: CriticalTokens;
  cross_language: boolean;
}

const CMP_LABEL_AR: Record<Comparator, string> = { gt: 'أكبر من (>)', lt: 'أقل من (<)', ge: 'لا يقل عن (≥)', le: 'لا يزيد عن (≤)' };
const POP_LABEL_AR: Record<string, string> = {
  neonate: 'حديثو الولادة',
  infant: 'الرضّع',
  child: 'الأطفال',
  adolescent: 'المراهقون',
  adult: 'البالغون',
  elderly: 'كبار السن',
  pregnant: 'الحمل/الحوامل',
  reproductive_age: 'سن الإنجاب',
  male: 'الذكور',
  female: 'الإناث',
};

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

function isArabicDominant(text: string): boolean {
  return detectDir(text) === 'rtl';
}

// ───────── marker scopes (what a NOT / an EXCEPT governs) ─────────
const SCOPE_TOKEN_RE = /[\p{L}\p{N}'’]+|[,،;؛:.!?؟()[\]{}«»"“”]/gu;
const EN_EXCEPTION_WORDS = new Set(['except', 'excepting', 'unless', 'excluding']);
const AR_EXCEPTION_WORDS = new Set(['باستثناء', 'ماعدا', 'عدا', 'الا', 'سوي', 'خلا']);
const SCOPE_WIDTH = 3;

/** One normalized, stemmed token for scope comparisons (no length filter: «CT» counts); null = function word. */
function scopeWord(raw: string): string | null {
  const w = raw.replace(/^['’]+|['’]+$/g, '');
  if (!w) return null;
  if (/^\d+$/.test(w)) return w;
  if (/[a-z]/.test(w)) {
    if (EN_STOP.has(w) || EN_NEGATIONS.has(w) || EN_NEG_CONTRACTION.test(w) || EN_EXCEPTION_WORDS.has(w)) return null;
    return lightStemEn(w);
  }
  if (AR_STOP.has(w) || AR_NEGATIONS.has(w) || isPrefixedArFunctionWord(w) || AR_EXCEPTION_WORDS.has(w)) return null;
  return lightStemAr(w);
}

function scopeTokens(text: string): string[] {
  return normalizeForSearch(baseNormalize(text))
    .replace(/\b(?:apart\s+from|other\s+than|with\s+the\s+exception\s+of)\b/g, ' except ')
    .match(SCOPE_TOKEN_RE) ?? [];
}

function isNegationToken(w: string): boolean {
  return EN_NEGATIONS.has(w) || EN_NEG_CONTRACTION.test(w) || AR_NEGATIONS.has(w) || (/^[وف]/.test(w) && AR_NEGATIONS.has(w.slice(1)));
}

function isExceptionToken(w: string): boolean {
  return EN_EXCEPTION_WORDS.has(w) || AR_EXCEPTION_WORDS.has(w) || (/^[وف]/.test(w) && AR_EXCEPTION_WORDS.has(w.slice(1)));
}

/**
 * For each marker in a clause, the words it governs: up to 3 content words after it, stopping at punctuation
 * («Ultrasound, NOT CT, is first-line» → {ct}); a postfix marker («fever is absent») takes the words before it.
 */
function markerScopes(clause: string, isMarker: (w: string) => boolean): Array<Set<string>> {
  const toks = scopeTokens(clause);
  const isPunct = (t: string) => !/[\p{L}\p{N}]/u.test(t);
  const out: Array<Set<string>> = [];
  toks.forEach((t, i) => {
    if (isPunct(t) || !isMarker(t)) return;
    const collect = (step: 1 | -1): Set<string> => {
      const got = new Set<string>();
      for (let j = i + step; j >= 0 && j < toks.length && got.size < SCOPE_WIDTH; j += step) {
        if (isPunct(toks[j]!)) break;
        if (isMarker(toks[j]!)) break;
        const w = scopeWord(toks[j]!);
        if (w) got.add(w);
      }
      return got;
    };
    const after = collect(1);
    out.push(after.size > 0 ? after : collect(-1));
  });
  return out;
}

function mentionsAny(scope: Set<string>, tokens: Set<string>): boolean {
  for (const w of scope) if (tokens.has(w)) return true;
  return false;
}

const CMP_SYMBOL: Record<Comparator, string> = { gt: '>', lt: '<', ge: '≥', le: '≤' };

/**
 * Every critical token of the claim must occur in the union of the cited quotes. Returns specific Arabic
 * reasons (e.g. «القيمة 11 غير موجودة في الدليل المستشهد به»).
 */
export function checkCriticalTokens(claim: string, quotes: string[]): CriticalCheckResult {
  const c = extractCriticalTokens(claim);
  const ev = quotes.map((q) => extractCriticalTokens(q));
  const union = {
    numbers: new Set(ev.flatMap((e) => e.numbers)),
    units: new Set(ev.flatMap((e) => e.units)),
    quantities: new Set(ev.flatMap((e) => e.quantities)),
    comparators: new Set(ev.flatMap((e) => e.comparators)),
    populations: new Set(ev.flatMap((e) => e.populations)),
    latin: new Set(ev.flatMap((e) => e.latin_terms)),
    negation: ev.some((e) => e.negation),
    exception: ev.some((e) => e.exception),
  };
  const quoteNorm = quotes.map((q) => matchNormalize(q)).join('\n');
  const claimArabic = isArabicDominant(claim);
  const quotesArabic = quotes.length > 0 && quotes.every((q) => isArabicDominant(q));
  const crossLanguage = quotes.some((q) => isArabicDominant(q) !== claimArabic);

  const missing: CriticalCheckResult['missing'] = {
    numbers: c.numbers.filter((n) => !union.numbers.has(n)),
    units: c.units.filter((u) => !union.units.has(u)),
    quantities: [],
    comparators: c.comparators.filter((x) => !union.comparators.has(x)),
    thresholds: [],
    populations: c.populations.filter((p) => !union.populations.has(p)),
    latin_terms: [],
    abbreviations: [],
    negation: false,
    dropped_negation: false,
    exception: c.exception && !union.exception,
    dropped_exception: false,
  };
  // a threshold is the comparator WITH its value: «WBC > 11, CRP < 10» must not pass on «WBC < 11, CRP > 10»
  // (checked only when the comparator and the number exist separately — otherwise already reported)
  const unionThresholds = new Set(ev.flatMap((e) => e.thresholds));
  missing.thresholds = c.thresholds.filter((t) => {
    const [cmp, n] = t.split(' ') as [Comparator, string];
    return !missing.comparators.includes(cmp) && !missing.numbers.includes(n) && !unionThresholds.has(t);
  });
  // a quantity is only checked when both its number and unit exist separately (otherwise already reported)
  missing.quantities = c.quantities.filter((q) => {
    const [n, u] = q.split(' ');
    return !missing.numbers.includes(n!) && !missing.units.includes(u!) && !union.quantities.has(q);
  });
  if (claimArabic && !quotesArabic) {
    missing.latin_terms = c.latin_terms.filter((w) => !union.latin.has(w) && !quoteNorm.includes(w));
  }
  if (!quotesArabic) {
    missing.abbreviations = c.abbreviations.filter((a) => !new RegExp(`(^|[^a-z0-9])${escapeRe(a.toLowerCase())}([^a-z0-9]|$)`).test(quoteNorm));
  }

  // negation: present in the claim → a negated evidence clause about the same thing must exist
  const claimWords = contentWords(claim);
  const claimTokens = new Set(scopeTokens(claim).map(scopeWord).filter((w): w is string => !!w));
  const clauseInfo = quotes
    .flatMap((q) => clauses(q))
    .map((cl) => {
      const n = matchNormalize(cl);
      const exc = EN_EXCEPTIONS.test(n) || AR_EXCEPTIONS.test(n);
      return {
        neg: hasNegation(n).negation,
        exc,
        words: contentWords(cl),
        arabic: isArabicDominant(cl),
        negScopes: markerScopes(cl, isNegationToken),
        excScopes: exc ? markerScopes(cl, isExceptionToken) : [],
      };
    });
  if (c.negation) {
    const same = clauseInfo.filter((x) => x.arabic === claimArabic);
    if (!union.negation) missing.negation = true;
    else if (same.length > 0 && !crossLanguage) {
      const ok = same.some((x) => x.neg && overlap(claimWords, x.words) >= 0.5);
      if (!ok) missing.negation = true;
    }
  } else if (!crossLanguage) {
    // dropped negation: the claim matches a negated clause — and asserts what the NOT governs — while no
    // affirmative clause matches equally well. «Ultrasound, not CT, is first-line» does not negate
    // «Ultrasound is first-line»; «a normal count does NOT exclude it» does negate «… excludes it».
    const governs = (scopes: Array<Set<string>>) => scopes.length === 0 || scopes.some((sc) => sc.size === 0 || mentionsAny(sc, claimTokens));
    const negHit = clauseInfo.some((x) => x.neg && x.words.size >= 2 && overlap(claimWords, x.words) >= 0.75 && governs(x.negScopes));
    const posHit = clauseInfo.some((x) => !x.neg && x.words.size >= 2 && overlap(claimWords, x.words) >= 0.75);
    if (negHit && !posHit) missing.dropped_negation = true;
  }
  if (!c.exception && !crossLanguage) {
    // dropped exception: the claim restates a clause that carries an exception («all … except obesity») without
    // the exception and without mentioning what is excepted
    const excHit = clauseInfo.some(
      (x) => x.exc && x.words.size >= 2 && overlap(claimWords, x.words) >= 0.75 && x.excScopes.length > 0 && x.excScopes.every((sc) => sc.size > 0 && !mentionsAny(sc, claimTokens)),
    );
    const plainHit = clauseInfo.some((x) => !x.exc && x.words.size >= 2 && overlap(claimWords, x.words) >= 0.75);
    if (excHit && !plainHit) missing.dropped_exception = true;
  }

  const reasons: string[] = [];
  if (missing.numbers.length) reasons.push(`القيم العددية ${missing.numbers.join('، ')} غير موجودة في الدليل المستشهد به.`);
  if (missing.units.length) reasons.push(`الوحدات ${missing.units.join('، ')} غير موجودة في الدليل (تغيير الوحدة يغيّر المعنى).`);
  if (missing.quantities.length) reasons.push(`القيمة مع وحدتها (${missing.quantities.join('، ')}) لا تطابق ما في الدليل.`);
  if (missing.comparators.length) reasons.push(`الحدّ ${missing.comparators.map((x) => CMP_LABEL_AR[x as Comparator]).join('، ')} غير مذكور في الدليل.`);
  if (missing.thresholds.length) {
    const shown = missing.thresholds.map((t) => {
      const [cmp, n] = t.split(' ') as [Comparator, string];
      return `${CMP_SYMBOL[cmp]} ${n}`;
    });
    reasons.push(`الحدّ مع قيمته (${shown.join('، ')}) لا يطابق ما في الدليل (اتجاه الحدّ تغيّر).`);
  }
  if (missing.populations.length) reasons.push(`الفئة (${missing.populations.map((p) => POP_LABEL_AR[p] ?? p).join('، ')}) غير مذكورة في الدليل.`);
  if (missing.exception) reasons.push('الجملة تذكر استثناءً غير موجود في الدليل.');
  if (missing.negation) reasons.push('الجملة تحمل نفيًا (NOT / لا) لا يوجد في الدليل بالمعنى نفسه.');
  if (missing.dropped_negation) reasons.push('الدليل ينفي هذه المعلومة (NOT / لا) بينما الجملة تثبتها.');
  if (missing.dropped_exception) reasons.push('الدليل يذكر استثناءً (except / باستثناء) أسقطته الجملة، فصارت أعمّ مما في الدليل.');
  if (missing.latin_terms.length) reasons.push(`المصطلحات ${missing.latin_terms.join('، ')} غير موجودة في الدليل.`);
  if (missing.abbreviations.length) reasons.push(`الاختصارات ${missing.abbreviations.join('، ')} غير موجودة في الدليل.`);

  return { passed: reasons.length === 0, reasons_ar: reasons, missing, claim_tokens: c, cross_language: crossLanguage };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whitespace/quote-insensitive form for verbatim comparisons (no letter normalization). */
export function verbatimForm(text: string): string {
  return stripBidiControls(text)
    .normalize('NFC')
    .replace(/[«»“”"„‟'‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。؛;:،,]+$/u, '')
    .trim();
}

export interface ContainmentResult {
  passed: boolean;
  reason_ar: string | null;
  /** 'exact' for original quotes; 'coverage' for directly-stated paraphrase checks; 'skipped' cross-language */
  method: 'exact' | 'coverage' | 'skipped_cross_language';
  coverage?: number;
}

/**
 * original_quote → the sentence must be a verbatim excerpt of ONE cited quote (whitespace/quotes aside).
 * directly_stated → ≥ 80 % of its content words must be inside one cited quote (same language); a
 * cross-language directly-stated claim (translation) cannot be checked verbatim → left to the verifier.
 */
export function checkContainment(claim: string, quotes: string[], mode: 'original_quote' | 'directly_stated'): ContainmentResult {
  if (mode === 'original_quote') {
    const v = verbatimForm(claim);
    const ok = v.length > 0 && quotes.some((q) => verbatimForm(q).includes(v));
    return ok
      ? { passed: true, reason_ar: null, method: 'exact' }
      : { passed: false, reason_ar: 'النص معروض كاقتباس أصلي لكنه لا يطابق نص المصدر حرفيًا.', method: 'exact' };
  }
  const claimArabic = isArabicDominant(claim);
  const sameLang = quotes.filter((q) => isArabicDominant(q) === claimArabic);
  if (sameLang.length === 0) return { passed: true, reason_ar: null, method: 'skipped_cross_language' };
  const words = contentWords(claim);
  if (words.size === 0) return { passed: true, reason_ar: null, method: 'coverage', coverage: 1 };
  let best = 0;
  for (const q of sameLang) {
    const qw = contentWords(q);
    let n = 0;
    for (const w of words) if (qw.has(w)) n++;
    best = Math.max(best, n / words.size);
  }
  return best >= 0.8
    ? { passed: true, reason_ar: null, method: 'coverage', coverage: best }
    : {
        passed: false,
        reason_ar: 'الجملة موسومة «مذكور نصًا» لكن معظم كلماتها غير موجودة في المقتطف المستشهد به؛ هذا استنتاج وليس نقلًا مباشرًا.',
        method: 'coverage',
        coverage: best,
      };
}

/** True when a sentence looks medical even without a claim: a value with a unit, a dose or a threshold. */
export function looksLikeUnsupportedValue(text: string): boolean {
  const t = extractCriticalTokens(text);
  return t.quantities.length > 0 || t.comparators.length > 0;
}
