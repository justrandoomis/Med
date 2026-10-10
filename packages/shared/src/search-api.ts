// Universal Search contract (/api/search, §46) + bidi-safe highlight helpers shared by the server and the
// web (offline local search). Added by track C1 (docs/modules/evidence-search.md).
//
// Highlights are UTF-16 ranges on the ORIGINAL text (logical order, never normalized). They are computed by
// matching the normalized search key and mapping every normalized character back to the original index, so
// «الالم» highlights «الألم» exactly where it is printed.
import type { SourceType } from './enums';
import { normalizeForSearch } from './search';

export const SEARCH_MODES = ['exact', 'keyword', 'semantic'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const SEARCH_MODE_LABELS_AR: Record<SearchMode, string> = {
  exact: 'مطابقة حرفية',
  keyword: 'كلمات',
  semantic: 'دلالي',
};

export const SEARCH_RESULT_TYPES = ['chunks', 'questions', 'notes', 'generated', 'transcripts'] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

export const SEARCH_RESULT_TYPE_LABELS_AR: Record<SearchResultType, string> = {
  chunks: 'المصادر',
  questions: 'الأسئلة',
  notes: 'ملاحظاتي',
  generated: 'محتوى مولَّد',
  transcripts: 'التفريغ الصوتي',
};

/**
 * Where the text of a hit comes from. Transcript segments carry their real origin: typed by the owner (or corrected
 * by the owner — the shown text is then the owner's), imported from a subtitle file, or machine-recognized.
 */
export type SearchOrigin = 'source' | 'owner_note' | 'generated' | 'recognized' | 'imported' | 'owner_typed';

export const SEARCH_ORIGIN_LABELS_AR: Record<SearchOrigin, string> = {
  source: 'من المصدر',
  owner_note: 'ملاحظتي',
  generated: 'مولَّد — ليس دليلًا',
  recognized: 'مقروء آليًا',
  imported: 'مستورد من ملف ترجمة',
  owner_typed: 'كتبته بنفسك',
};

export interface SearchHighlight {
  start: number;
  end: number;
}

export interface SearchLocation {
  source_id: string;
  version_id: string | null;
  page_id: string | null;
  page_index: number | null;
  /** «ص 12 (الصفحة 14 في الملف)», «شريحة 3», «فقرة 7» */
  page_label_ar: string | null;
  region_id: string | null;
}

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  snippet: { text: string; highlights: SearchHighlight[] };
  location: SearchLocation | null;
  origin: SearchOrigin;
  source_type: SourceType | null;
  source_title: string | null;
  /** generated content is never evidence; the UI labels it */
  is_evidence: false;
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  results: SearchResult[];
  next_cursor: string | null;
  /** results whose FTS match failed the exact-phrase check on the original text */
  exact_rejected?: number;
  /** owner-dictionary expansions applied (never seeded) */
  expansions: Array<{ from: string; to: string[] }>;
  searched_types: SearchResultType[];
  /** e.g. «لا توجد أسئلة مفهرسة بعد» */
  notices_ar: string[];
}

// ───────── normalization with an index map ─────────
const LATIN_COMBINING = /[\u0300-\u036f]/g;

/** normalizeForSearch for one code point, plus Latin diacritic removal (as the FTS tokenizer does). */
function normChar(ch: string): string {
  return normalizeForSearch(ch).normalize('NFD').replace(LATIN_COMBINING, '');
}

/** Normalized search key of `text` + map[i] = UTF-16 index in `text` of normalized char i. */
export function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    const n = normChar(ch);
    for (let k = 0; k < n.length; k++) map.push(i);
    norm += n;
    i += ch.length;
  }
  return { norm, map };
}

/** Normalized search tokens (same splitting as toFtsQuery). */
export function searchTokens(input: string): string[] {
  return Array.from(normalizeWithMap(input).norm.split(/[^\p{L}\p{N}]+/u))
    .filter((t) => t.length > 0)
    .slice(0, 32);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function mergeRanges(ranges: SearchHighlight[]): SearchHighlight[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: SearchHighlight[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Highlight ranges (on the original text) of query tokens that start a word. `prefix` also highlights the
 * rest of a word that begins with the token (keyword search with a trailing prefix).
 */
export function findHighlights(text: string, tokens: string[], opts: { prefix?: boolean } = {}): SearchHighlight[] {
  if (!text || tokens.length === 0) return [];
  const { norm, map } = normalizeWithMap(text);
  const ranges: SearchHighlight[] = [];
  for (const tok of new Set(tokens)) {
    if (!tok) continue;
    let from = 0;
    for (;;) {
      const at = norm.indexOf(tok, from);
      if (at < 0) break;
      from = at + 1;
      if (at > 0 && WORD_CHAR.test(norm[at - 1]!)) continue; // must start a word
      let endNorm = at + tok.length;
      const nextIsWord = endNorm < norm.length && WORD_CHAR.test(norm[endNorm]!);
      if (nextIsWord && !opts.prefix) {
        // whole-token match only (FTS tokens are whole words)
        continue;
      }
      if (opts.prefix) while (endNorm < norm.length && WORD_CHAR.test(norm[endNorm]!)) endNorm++;
      const start = map[at]!;
      const lastOrig = map[endNorm - 1]!;
      // extend to the end of the original code point (and any marks the normalization dropped)
      let end = lastOrig + (text.codePointAt(lastOrig)! > 0xffff ? 2 : 1);
      while (end < text.length && normChar(text[end]!) === '' && !/\s/.test(text[end]!)) end++;
      ranges.push({ start, end });
    }
  }
  return mergeRanges(ranges);
}

/** Case-insensitive, whitespace-tolerant exact phrase ranges on the original text (no letter normalization). */
export function findExactPhrase(text: string, phrase: string): SearchHighlight[] {
  const p = phrase.trim().replace(/\s+/g, ' ');
  if (!p || !text) return [];
  const escaped = p
    .split(' ')
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const re = new RegExp(escaped, 'giu');
  const out: SearchHighlight[] = [];
  for (const m of text.matchAll(re)) {
    if (m.index === undefined || m[0].length === 0) continue;
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * A snippet window around the first highlight (cut at whitespace), with highlights re-based to the
 * snippet. The snippet is a substring of the original text — logical order, nothing inserted.
 */
export function makeSnippet(text: string, highlights: SearchHighlight[], maxLen = 220): { text: string; highlights: SearchHighlight[] } {
  const clean = text;
  if (clean.length <= maxLen) return { text: clean, highlights };
  const first = highlights[0];
  let start = 0;
  if (first) start = Math.max(0, first.start - Math.floor(maxLen / 3));
  let end = Math.min(clean.length, start + maxLen);
  if (end - start < maxLen) start = Math.max(0, end - maxLen);
  // cut at whitespace so words are not split
  if (start > 0) {
    const ws = clean.slice(start, start + 30).search(/\s/);
    if (ws >= 0) start += ws + 1;
  }
  if (end < clean.length) {
    const tail = clean.slice(Math.max(start, end - 30), end);
    const ws = tail.lastIndexOf(' ');
    if (ws >= 0) end = Math.max(start, end - 30) + ws;
  }
  // never split a surrogate pair
  if (start > 0 && /[\uDC00-\uDFFF]/.test(clean[start] ?? '')) start--;
  if (end < clean.length && /[\uDC00-\uDFFF]/.test(clean[end] ?? '')) end++;
  const prefix = start > 0 ? '… ' : '';
  const suffix = end < clean.length ? ' …' : '';
  const body = clean.slice(start, end);
  const hs = highlights
    .filter((h) => h.end > start && h.start < end)
    .map((h) => ({ start: Math.max(h.start, start) - start + prefix.length, end: Math.min(h.end, end) - start + prefix.length }));
  return { text: prefix + body + suffix, highlights: hs };
}

/** Split text into plain / marked segments for rendering (bidi isolation is the renderer's job). */
export function highlightSegments(text: string, highlights: SearchHighlight[]): Array<{ text: string; mark: boolean }> {
  const out: Array<{ text: string; mark: boolean }> = [];
  let cursor = 0;
  for (const h of mergeRanges(highlights)) {
    const s = Math.max(cursor, Math.min(h.start, text.length));
    const e = Math.max(s, Math.min(h.end, text.length));
    if (s > cursor) out.push({ text: text.slice(cursor, s), mark: false });
    if (e > s) out.push({ text: text.slice(s, e), mark: true });
    cursor = e;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), mark: false });
  return out;
}
