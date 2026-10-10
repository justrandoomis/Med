// Search normalization shared by server (FTS index + queries) and web (offline local search).
// Stored content is NEVER normalized — only the search key is. Original text, punctuation,
// diacritics and direction are preserved in regions/chunks for display, copy and export.
import { stripBidiControls } from './richtext';

const HARAKAT = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭ]/g;
const TATWEEL = /ـ/g;
const ARABIC_INDIC_DIGITS = /[٠-٩]/g;
const EXT_ARABIC_INDIC_DIGITS = /[۰-۹]/g;

/**
 * Normalize text for matching: NFKC (decomposes presentation forms incl. lam-alef ligatures),
 * strip bidi controls, tatweel and harakat, unify alef/ya/ta-marbuta/hamza carriers,
 * map Arabic-Indic digits to ASCII, lowercase Latin. Idempotent.
 */
export function normalizeForSearch(text: string): string {
  return stripBidiControls(text)
    .normalize('NFKC')
    .replace(TATWEEL, '')
    .replace(HARAKAT, '')
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ → ا
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/ؤ/g, 'و') // ؤ → و
    .replace(/ئ/g, 'ي') // ئ → ي
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXT_ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase();
}

/**
 * Build a safe FTS5 MATCH expression from free user input: every token is quoted (no operator
 * injection), tokens are AND-ed; a trailing `*` prefix query is applied to the last token when
 * `prefix` is true. Returns null when nothing searchable remains.
 */
export function toFtsQuery(input: string, opts: { prefix?: boolean; mode?: 'and' | 'or' } = {}): string | null {
  const tokens = normalizeForSearch(input)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 32);
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t, i) => {
    const q = '"' + t.replace(/"/g, '""') + '"';
    return opts.prefix && i === tokens.length - 1 ? q + '*' : q;
  });
  return quoted.join(opts.mode === 'or' ? ' OR ' : ' ');
}

function passageTokens(text: string): Set<string> {
  return new Set(normalizeForSearch(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/**
 * Is `now` still the paragraph an owner's note was written on (`then`)? (§25, AC-22.) Identical text after search
 * normalization, or a light rewording: Dice coefficient of the two word sets ≥ 0.6. A false «no» only lists the note
 * for re-anchoring; a false «yes» would show it over another paragraph, so the bar sits on the strict side.
 * `thenIsPrefix`: `then` is a quote cut from the START of the paragraph (it may end with «…»).
 */
export function samePassage(then: string, now: string, thenIsPrefix = false): boolean {
  const q = normalizeForSearch(then.replace(/…$/, '')).replace(/\s+/g, ' ').trim();
  const n = normalizeForSearch(now).replace(/\s+/g, ' ').trim();
  if (!q) return true; // nothing to compare against: the anchor key decides
  if (q === n || (thenIsPrefix && n.startsWith(q))) return true;
  const a = passageTokens(q);
  const b = passageTokens(thenIsPrefix ? n.slice(0, q.length + 40) : n);
  if (!a.size || !b.size) return false;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return (2 * common) / (a.size + b.size) >= 0.6;
}
