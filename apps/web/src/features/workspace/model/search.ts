// Search inside the open document (§26). Matching uses the shared Arabic/Latin search key
// (normalizeForSearch: harakat, tatweel, alef/ya/ta-marbuta forms, Arabic-Indic digits, case) while the
// results point at offsets in the ORIGINAL page text, so highlights land on the exact characters.
import { normalizeForSearch } from '@medlevo/shared';

export interface SearchIndex {
  /** normalized text (whitespace collapsed) */
  norm: string;
  /** norm index → original index */
  map: number[];
}

/**
 * @param softBreaks offsets where a line ended without a space character (pdf.js `hasEOL`): matching treats
 * them as a space, so a phrase broken across lines is still found.
 */
export function buildSearchIndex(text: string, softBreaks: readonly number[] = []): SearchIndex {
  let norm = '';
  const map: number[] = [];
  let lastSpace = true;
  let i = 0;
  const breaks = new Set(softBreaks);
  for (const ch of text) {
    if (breaks.has(i) && !lastSpace) {
      norm += ' ';
      map.push(i);
      lastSpace = true;
    }
    const n = /\s/.test(ch) ? ' ' : normalizeForSearch(ch);
    if (n === ' ') {
      if (!lastSpace) {
        norm += ' ';
        map.push(i);
        lastSpace = true;
      }
    } else if (n.length > 0) {
      for (const c of n) {
        norm += c;
        map.push(i);
      }
      lastSpace = false;
    }
    i += ch.length;
  }
  return { norm, map };
}

export function normalizeQuery(q: string): string {
  return buildSearchIndex(q).norm.trim();
}

export interface Match {
  /** offsets in the original text */
  start: number;
  end: number;
}

export function findMatches(text: string, query: string, max = 200, index: SearchIndex = buildSearchIndex(text)): Match[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const out: Match[] = [];
  let from = 0;
  while (out.length < max) {
    const at = index.norm.indexOf(q, from);
    if (at < 0) break;
    const start = index.map[at]!;
    const lastNorm = at + q.length - 1;
    const lastOrig = index.map[lastNorm]!;
    // include the full original character (surrogate pairs / expanded ligatures)
    const cp = text.codePointAt(lastOrig) ?? 0;
    out.push({ start, end: lastOrig + (cp > 0xffff ? 2 : 1) });
    from = at + q.length;
  }
  return out;
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

export function snippetFor(text: string, m: Match, radius = 36, softBreaks: readonly number[] = []): Snippet {
  // line ends without a space character read as a space (never glue two lines' words together)
  const slice = (from: number, to: number) => {
    let out = '';
    for (let i = from; i < to; i++) {
      if (i > from && softBreaks.includes(i) && !/\s/.test(text[i - 1]!) && !/\s/.test(text[i]!)) out += ' ';
      out += text[i];
    }
    return out.replace(/\s+/g, ' ');
  };
  const b = Math.max(0, m.start - radius);
  const a = Math.min(text.length, m.end + radius);
  const sep = (i: number) => (softBreaks.includes(i) ? ' ' : '');
  return {
    before: (b > 0 ? '…' : '') + slice(b, m.start) + sep(m.start),
    match: slice(m.start, m.end),
    after: sep(m.end) + slice(m.end, a) + (a < text.length ? '…' : ''),
  };
}

export interface SearchResult extends Match {
  pageIndex: number;
  /** n-th match on its page */
  ordinal: number;
  snippet: Snippet;
}

/** Search page texts in order; stops after `limit` results (the UI says when it stopped). */
export function searchPages(pages: ReadonlyArray<{ pageIndex: number; text: string; breaks?: readonly number[] }>, query: string, limit = 300): { results: SearchResult[]; truncated: boolean } {
  const results: SearchResult[] = [];
  for (const p of pages) {
    const remaining = limit - results.length;
    if (remaining <= 0) return { results, truncated: true };
    const matches = findMatches(p.text, query, remaining + 1, buildSearchIndex(p.text, p.breaks));
    matches.slice(0, remaining).forEach((m, ordinal) => results.push({ ...m, pageIndex: p.pageIndex, ordinal, snippet: snippetFor(p.text, m, 36, p.breaks) }));
    if (matches.length > remaining) return { results, truncated: true };
  }
  return { results, truncated: false };
}
