import { describe, expect, it } from 'vitest';
import { buildSearchIndex, findMatches, searchPages, snippetFor } from './search';

describe('in-document search', () => {
  it('matches Arabic without harakat / with alef variants and maps back to original offsets', () => {
    const text = 'يبدأ الألمُ عادةً حول السُّرة';
    const m = findMatches(text, 'السره');
    expect(m).toHaveLength(1);
    expect(text.slice(m[0]!.start, m[0]!.end)).toBe('السُّرة');
    expect(findMatches(text, 'الالم').map((x) => text.slice(x.start, x.end))).toEqual(['الألمُ'.slice(0, 5)]);
  });

  it('is case-insensitive for Latin, finds every occurrence, and collapses whitespace', () => {
    const text = 'CT abdomen is preferred.\nct   ABDOMEN again';
    expect(findMatches(text, 'ct abdomen')).toHaveLength(2);
  });

  it('treats a pdf.js line end (hasEOL) as a space', () => {
    const text = 'first-lineimaging'; // two text items, the first ended a line
    expect(findMatches(text, 'first-line imaging')).toHaveLength(0);
    const index = buildSearchIndex(text, [10]);
    const m = findMatches(text, 'first-line imaging', 10, index);
    expect(m).toEqual([{ start: 0, end: 17 }]);
    expect(snippetFor(text, m[0]!, 36, [10]).match).toBe('first-line imaging');
  });

  it('returns results in page order with snippets, and says when it stopped', () => {
    const pages = [
      { pageIndex: 0, text: 'Acute appendicitis — overview' },
      { pageIndex: 1, text: 'no match here' },
      { pageIndex: 2, text: 'appendicitis appendicitis' },
    ];
    const r = searchPages(pages, 'Appendicitis');
    expect(r.truncated).toBe(false);
    expect(r.results.map((x) => [x.pageIndex, x.ordinal])).toEqual([
      [0, 0],
      [2, 0],
      [2, 1],
    ]);
    expect(r.results[0]!.snippet).toEqual({ before: 'Acute ', match: 'appendicitis', after: ' — overview' });
    expect(searchPages(pages, 'appendicitis', 2)).toMatchObject({ truncated: true });
    expect(searchPages(pages, '   ').results).toEqual([]);
  });
});
