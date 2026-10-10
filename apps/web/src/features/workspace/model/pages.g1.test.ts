// G1 / AC-04 regression: in a book whose body pages carry printed numbers (1, 2, …) after unnumbered front matter,
// the unnumbered cover must not be presented as «ص 1» — that is the printed number of another page (file page 3).
// It is named by its file position; go-to «1» still means the page printed 1.
import { describe, expect, it } from 'vitest';
import { folio, fullPageLabel, pageIndicator, resolveGoTo, type PageIdentity } from './pages';

const book: PageIdentity[] = [null, null, '1', '2', '3'].map((printed_label, page_index) => ({ page_index, printed_label, kind: 'page', numbered_version: true }));

describe('G1 AC-04 — unnumbered pages among numbered ones', () => {
  it('the cover is «الصفحة 1 في الملف» (no second «ص 1»); the page printed 1 keeps both numberings', () => {
    expect(folio(book[0]!)).toEqual({ primary: 'الصفحة 1 في الملف', secondary: null });
    expect(fullPageLabel(book[0]!)).toBe('الصفحة 1 في الملف');
    expect(pageIndicator(book[1]!, 5)).toBe('الصفحة 2 في الملف — 2 من 5');
    expect(folio(book[2]!)).toEqual({ primary: 'ص 1', secondary: 'الصفحة 3 في الملف' });
    expect(new Set(book.map((p) => fullPageLabel(p))).size).toBe(book.length);
  });

  it('go-to «1» opens the page printed 1 and offers the file reading', () => {
    expect(resolveGoTo('1', book)).toEqual({ ok: true, index: 2, matchedBy: 'printed', alternative: { index: 0, matchedBy: 'file' } });
    expect(resolveGoTo('#1', book)).toEqual({ ok: true, index: 0, matchedBy: 'file' });
  });

  it('a document with no printed numbers at all keeps «ص N»', () => {
    expect(folio({ page_index: 4, printed_label: null, kind: 'page', numbered_version: false })).toEqual({ primary: 'ص 5', secondary: null });
    expect(folio({ page_index: 4, printed_label: null, kind: 'page' })).toEqual({ primary: 'ص 5', secondary: null });
  });
});
