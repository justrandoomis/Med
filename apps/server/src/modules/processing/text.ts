// Text hygiene for extracted (PDF text layer / OCR) content. Stored text stays in LOGICAL order, without
// bidi control characters, NFC-normalized. Known extraction defects are either repaired by narrow,
// tested rules or FLAGGED for the owner — never silently stored (fixtures/golden/expected.json
// known_extraction_defects).
import { normalizeForSearch, stripBidiControls } from '@medlevo/shared';

/** Arabic letters (hamza … yeh, plus extended letters); excludes tatweel U+0640, harakat and digits. */
const AR_LETTER = '\\u0621-\\u063A\\u0641-\\u064A\\u066E-\\u06D3\\u06FA-\\u06FF\\u0750-\\u077F\\u08A0-\\u08C9';
const AR_LETTER_RE = new RegExp(`[${AR_LETTER}]`);
const STRONG_RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;
// Latin letters (incl. Latin-1 / Extended-A/B), Greek, Cyrillic, micro sign. U+00D7 \u00AB\u00D7\u00BB and U+00F7 \u00AB\u00F7\u00BB sit inside
// the Latin-1 letter range but are math symbols (bidi class ON): counted as strong LTR they turned \u00AB11.5 \u00D710\u2079/L\u00BB
// inside an Arabic line into \u00AB11.5 L/10\u2079\u00D7\u00BB (G4 / AC-11).
const STRONG_LTR_RE = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u0370-\u03FF\u0400-\u04FF\u00B5]/;

export type CharDir = 'R' | 'L' | 'N';

export function charDir(ch: string): CharDir {
  if (/[\u0660-\u0669\u06F0-\u06F9\u064B-\u065F\u0670\u0640]/.test(ch)) return 'N'; // Arabic digits/harakat/tatweel are not strong
  if (STRONG_RTL_RE.test(ch)) return 'R';
  if (STRONG_LTR_RE.test(ch)) return 'L';
  return 'N';
}

export function countStrong(text: string): { r: number; l: number } {
  let r = 0;
  let l = 0;
  for (const ch of text) {
    const d = charDir(ch);
    if (d === 'R') r++;
    else if (d === 'L') l++;
  }
  return { r, l };
}

export function hasArabic(text: string): boolean {
  return AR_LETTER_RE.test(text);
}

const PRESENTATION_FORMS = /[\uFB50-\uFDFF\uFE70-\uFEFC]/g;
const ODD_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const ZERO_WIDTH_NOISE = /[\u200B\uFEFF\u00AD]/g; // ZWSP, BOM/ZWNBSP, soft hyphen (ZWJ/ZWNJ are meaningful, kept)
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Basic cleanup of one extracted run: bidi controls stripped, Arabic presentation forms mapped to base
 * letters (NFKC on those code points only — the lam-alef ligature U+FEFB becomes «لا» in logical order),
 * odd spaces → space, zero-width noise removed, NFC.
 */
export function cleanRun(text: string): string {
  return stripBidiControls(text)
    .replace(CONTROL_CHARS, '')
    .replace(ZERO_WIDTH_NOISE, '')
    .replace(PRESENTATION_FORMS, (c) => c.normalize('NFKC'))
    .replace(ODD_SPACES, ' ')
    .normalize('NFC');
}

/** Collapse whitespace runs to single spaces and trim. */
export function squashSpaces(text: string): string {
  return text.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

// ───────── reversed lam-alef ligature (known PDF text-layer defect) ─────────
// Some fonts map the lam-alef ligature glyphs (ل + ا/أ/إ/آ) back to Unicode in the WRONG order, so «الألم»
// is extracted as «األلم» (alef, hamza-alef, lam …), «الإنجاب» as «اإلنجاب», and — with the plain «لا»
// ligature after the article — «الالتهاب» as «االلتهاب», «الانسداد» as «االنسداد» (LibreOffice PDF export
// does this for every lam-alef). A word that starts with a bare alef immediately followed by ANOTHER alef
// (bare, hamzated or madda) does not occur in Arabic orthography, so the rule only fires there: at a word
// start, optionally after up to two one-letter proclitics (و ف ب ك). It never touches «ألم», «أل…», «إلى»,
// «الآن», «آلة», «الا…» or already-correct «الألم».
// A reversed «لا» INSIDE a word («العلاج» → «العالج», «السلام» → «السالم») cannot be repaired: «ال» is
// also correct there in many words. Documents that show the defect get those words FLAGGED instead
// (see detectSuspicious(…, { reversedLigatures: true })).
const REVERSED_LAM_ALEF = new RegExp(`(?<![${AR_LETTER}\\u0640])([وفبك]{0,2})ا([اأإآ])ل`, 'g');
const REVERSED_LAM_ALEF_TEST = new RegExp(REVERSED_LAM_ALEF.source);
// The negation words themselves (G4 / AC-11): the stand-alone «لا» is extracted as «ال» and «إلا» / «ألا» as «إال» /
// «أال» — the negation silently disappeared from the text («أي مما يلي ال يعد …»), so the NOT/EXCEPT check and the
// emphasis never saw it. A bare article «ال» never stands alone before a word, and «إال» / «أال» are not words, so
// these whole-word forms are repaired: «ال» / «وال» only when another Arabic word follows; «إال» / «أال» anywhere.
const AR_MARKS = '\\u064B-\\u0652\\u0670';
const REVERSED_LA_WORD = new RegExp(`(?<![${AR_LETTER}${AR_MARKS}\\u0640])(و?)ال(?=\\s+[${AR_MARKS}]*[${AR_LETTER}])`, 'g');
const REVERSED_ILLA_WORD = new RegExp(`(?<![${AR_LETTER}${AR_MARKS}\\u0640])([إأ])ال(?![${AR_LETTER}${AR_MARKS}\\u0640])`, 'g');

export function fixReversedLamAlef(text: string): { text: string; fixes: number } {
  let fixes = 0;
  const out = text
    .replace(REVERSED_LAM_ALEF, (_m, proclitics: string, alef: string) => {
      fixes++;
      return `${proclitics}ال${alef}`;
    })
    .replace(REVERSED_LA_WORD, (_m, waw: string) => {
      fixes++;
      return `${waw}لا`;
    })
    .replace(REVERSED_ILLA_WORD, (_m, hamza: string) => {
      fixes++;
      return `${hamza}لا`;
    });
  return { text: out, fixes };
}

/** Whether raw extracted text shows the reversed lam-alef defect (the font reverses its ligatures). */
export function hasReversedLamAlef(text: string): boolean {
  const t = cleanRun(text);
  return REVERSED_LAM_ALEF_TEST.test(t) || new RegExp(REVERSED_LA_WORD.source).test(t) || new RegExp(REVERSED_ILLA_WORD.source).test(t);
}

const AR_WORD = new RegExp(`[${AR_LETTER}]+`, 'g');
/** prefixes before «ال» that make it the definite article (و/ف/ب/ك/ل and their pairs) */
const ARTICLE_PREFIX = /^[وفبكل]{1,2}$/;

/** Words with «ال» inside them (not the article): a possible reversed «لا» when the font is known to reverse it. */
export function ambiguousLamAlefWords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(AR_WORD)) {
    const word = m[0];
    for (let k = word.indexOf('ال', 1); k > 0; k = word.indexOf('ال', k + 1)) {
      if (!ARTICLE_PREFIX.test(word.slice(0, k))) {
        out.push(word);
        break;
      }
    }
  }
  return out;
}

// ───────── suspicious extraction ─────────
export type SuspicionKind = 'lone_latin_in_arabic' | 'orphan_mark' | 'replacement_char' | 'private_use' | 'control_char' | 'ambiguous_lam_alef';

export interface Suspicion {
  kind: SuspicionKind;
  /** the offending character(s) */
  token: string;
  /** a short excerpt around it (logical order) */
  context: string;
}

// a single Latin letter glued (no space) to an Arabic letter on either side, not part of a longer Latin run
const LONE_LATIN = new RegExp(
  `(?<=[${AR_LETTER}])[A-Za-z](?![A-Za-z])|(?<![A-Za-z])[A-Za-z](?=[${AR_LETTER}])`,
  'g',
);
const PRIVATE_USE = /[\uE000-\uF8FF]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/g;
// an Arabic diacritic must follow its base letter; at a word start it was emitted in the wrong order
const ORPHAN_MARK = /(?:^|(?<=[\s\p{P}\p{S}]))[\u064B-\u0652\u0670](?=[\u0621-\u064A])/gu;

function excerpt(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 12);
  const end = Math.min(text.length, index + len + 12);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

export interface SuspicionContext {
  /** the document's text layer is known to reverse lam-alef ligatures (a word-start repair happened) */
  reversedLigatures?: boolean;
}

export function detectSuspicious(text: string, ctx: SuspicionContext = {}): Suspicion[] {
  const out: Suspicion[] = [];
  if (ctx.reversedLigatures) {
    for (const w of new Set(ambiguousLamAlefWords(text))) out.push({ kind: 'ambiguous_lam_alef', token: w, context: w });
  }
  for (const m of text.matchAll(LONE_LATIN)) {
    out.push({ kind: 'lone_latin_in_arabic', token: m[0], context: excerpt(text, m.index ?? 0, m[0].length) });
  }
  for (const m of text.matchAll(ORPHAN_MARK)) {
    out.push({ kind: 'orphan_mark', token: `U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`, context: excerpt(text, m.index ?? 0, 2) });
  }
  for (const m of text.matchAll(/\uFFFD/g)) {
    out.push({ kind: 'replacement_char', token: m[0], context: excerpt(text, m.index ?? 0, 1) });
  }
  for (const m of text.matchAll(PRIVATE_USE)) {
    out.push({
      kind: 'private_use',
      token: `U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`,
      context: excerpt(text, m.index ?? 0, m[0].length),
    });
  }
  for (const m of text.matchAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g)) {
    out.push({ kind: 'control_char', token: `U+${m[0].charCodeAt(0).toString(16).padStart(4, '0')}`, context: '' });
  }
  return out;
}

/** Specific Arabic reason for the review queue (one sentence per issue kind, with the evidence). */
export function suspicionReasonAr(issues: Suspicion[]): string {
  const parts: string[] = [];
  const lone = issues.filter((i) => i.kind === 'lone_latin_in_arabic');
  if (lone.length) {
    const sample = lone
      .slice(0, 3)
      .map((i) => `«${i.token}» في «${i.context}»`)
      .join('، ');
    parts.push(
      `حرف لاتيني منفرد ملتصق بكلمة عربية (${sample}). غالبًا هو تشكيل (تنوين أو ضمة) حوّله جدول ترميز الخط في PDF إلى حرف خاطئ؛ قارن النص بالصفحة الأصلية وصحّحه.`,
    );
  }
  const orphan = issues.filter((i) => i.kind === 'orphan_mark');
  if (orphan.length) {
    parts.push(
      `علامة تشكيل في بداية كلمة قبل حرفها (${orphan
        .slice(0, 3)
        .map((i) => `«${i.context}»`)
        .join('، ')}): رُتّبت الحركة بشكل خاطئ عند استخراج النص من PDF؛ راجع الكلمة مقابل الصفحة الأصلية.`,
    );
  }
  if (issues.some((i) => i.kind === 'replacement_char')) {
    parts.push('يحتوي النص على رمز غير مقروء (�): تعذّر تحويل بعض حروف الخط إلى نص.');
  }
  const pua = issues.filter((i) => i.kind === 'private_use');
  if (pua.length) {
    parts.push(`يحتوي النص على رموز غير معيارية من منطقة الاستخدام الخاص في الخط (${pua.slice(0, 3).map((i) => i.token).join('، ')}) قد تكون حروفًا لم تُستخرج بشكل صحيح.`);
  }
  if (issues.some((i) => i.kind === 'control_char')) {
    parts.push('يحتوي النص على محارف تحكم غير مرئية من طبقة النص.');
  }
  const lamAlef = issues.filter((i) => i.kind === 'ambiguous_lam_alef');
  if (lamAlef.length) {
    parts.push(
      `خط هذا الملف يعكس ترتيب حرفي «لا» عند استخراج النص (صُحّح ذلك تلقائيًا في بداية الكلمات)، لكن داخل الكلمات لا يمكن التمييز آليًا بين «ال» الصحيحة و«لا» المعكوسة: ${lamAlef
        .slice(0, 6)
        .map((i) => `«${i.token}»`)
        .join('، ')}. قارن هذه الكلمات بالصفحة الأصلية وصحّحها (مثلًا «العالج» ← «العلاج»).`,
    );
  }
  return parts.join(' ');
}

export interface PreparedText {
  text: string;
  ligatureFixes: number;
  suspicions: Suspicion[];
}

/** Final per-region text preparation: cleanup, lam-alef repair, whitespace, then suspicion scan. */
export function prepareRegionText(raw: string, ctx: SuspicionContext = {}): PreparedText {
  const cleaned = squashSpaces(cleanRun(raw));
  const { text, fixes } = fixReversedLamAlef(cleaned);
  return { text, ligatureFixes: fixes, suspicions: detectSuspicious(text, ctx) };
}

/** Normalized comparison key used for header/footer signatures (digits collapsed to '#'). */
export function signatureKey(text: string): string {
  return normalizeForSearch(text).replace(/[0-9]+/g, '#').replace(/\s+/g, ' ').trim();
}

/** Rough token estimate (≈4 chars per token for Latin, ≈3 for Arabic). */
export function estimateTokens(text: string): number {
  const { r, l } = countStrong(text);
  const total = text.length;
  const arabicShare = r + l > 0 ? r / (r + l) : 0;
  return Math.max(1, Math.round(total / (4 - arabicShare)));
}
