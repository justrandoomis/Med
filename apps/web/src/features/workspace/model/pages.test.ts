import { describe, expect, it } from 'vitest';
import type { SourcePageView } from '@medlevo/shared';
import { folio, fullPageLabel, normalizePageInput, pageIndicator, resolveGoTo, type PageIdentity } from './pages';

// labels 11..14 from /PageLabels (Golden Set lecture_appendicitis.pdf, AC-04)
const book: PageIdentity[] = [0, 1, 2, 3].map((i) => ({ page_index: i, printed_label: String(11 + i), kind: 'page' as SourcePageView['kind'] }));

describe('page identity (AC-04)', () => {
  it('shows the printed label and the file position when they differ', () => {
    expect(folio(book[2]!)).toEqual({ primary: 'ص 13', secondary: 'الصفحة 3 في الملف' });
    expect(fullPageLabel(book[2]!)).toBe('ص 13 (الصفحة 3 في الملف)');
    expect(pageIndicator(book[2]!, 4)).toBe('ص 13 (الصفحة 3 في الملف) — 3 من 4');
  });
  it('shows one number when they agree or no label exists', () => {
    expect(folio({ page_index: 4, printed_label: '5', kind: 'page' })).toEqual({ primary: 'ص 5', secondary: null });
    expect(folio({ page_index: 4, printed_label: null, kind: 'page' })).toEqual({ primary: 'ص 5', secondary: null });
  });
  it('names slides, images and DOCX sections without inventing page numbers', () => {
    expect(folio({ page_index: 2, printed_label: '3', kind: 'slide' }).primary).toBe('شريحة 3');
    expect(folio({ page_index: 2, printed_label: null, kind: 'image' }).primary).toBe('صورة 3');
    expect(folio({ page_index: 0, printed_label: null, kind: 'docx_section' })).toEqual({ primary: 'قسم 1', secondary: null });
  });
});

describe('go to page', () => {
  it('prefers the printed label and offers the file position as the alternative', () => {
    const r = resolveGoTo('12', [...book, ...Array.from({ length: 10 }, (_, i) => ({ page_index: 4 + i, printed_label: String(15 + i), kind: 'page' as const }))]);
    expect(r).toEqual({ ok: true, index: 1, matchedBy: 'printed', alternative: { index: 11, matchedBy: 'file' } });
  });
  it('accepts printed-label prefixes and Arabic-Indic digits', () => {
    expect(resolveGoTo('ص 13', book)).toMatchObject({ ok: true, index: 2, matchedBy: 'printed' });
    expect(resolveGoTo('ص١٤', book)).toMatchObject({ ok: true, index: 3, matchedBy: 'printed' });
    expect(resolveGoTo('صفحة ۱۱', book)).toMatchObject({ ok: true, index: 0 });
    expect(resolveGoTo('الصفحة 12', book)).toMatchObject({ ok: true, index: 1, matchedBy: 'printed' });
    expect(normalizePageInput('  ص  ١٢ ')).toBe('ص 12');
  });
  it('treats #n / «ملف n» / «الصفحة n في الملف» as file positions', () => {
    expect(resolveGoTo('#2', book)).toEqual({ ok: true, index: 1, matchedBy: 'file' });
    expect(resolveGoTo('ملف 4', book)).toEqual({ ok: true, index: 3, matchedBy: 'file' });
    expect(resolveGoTo('الصفحة 3 في الملف', book)).toEqual({ ok: true, index: 2, matchedBy: 'file' });
    expect(resolveGoTo('#9', book)).toMatchObject({ ok: false });
  });
  it('falls back to the file position when no page carries that label', () => {
    expect(resolveGoTo('2', book)).toEqual({ ok: true, index: 1, matchedBy: 'file' });
  });
  it('matches non-numeric labels (roman numerals) and explains failures in Arabic', () => {
    const front: PageIdentity[] = [
      { page_index: 0, printed_label: 'i', kind: 'page' },
      { page_index: 1, printed_label: 'ii', kind: 'page' },
      { page_index: 2, printed_label: '1', kind: 'page' },
    ];
    expect(resolveGoTo('II', front)).toMatchObject({ ok: true, index: 1, matchedBy: 'printed' });
    const miss = resolveGoTo('xx', front);
    expect(miss.ok).toBe(false);
    expect(!miss.ok && miss.error).toMatch(/xx/);
    expect(resolveGoTo('99', front)).toMatchObject({ ok: false });
    expect(resolveGoTo('', front)).toMatchObject({ ok: false });
  });
});

// Regression (independent review of track B1): printed labels that start like a prefix («p», «ص») were
// stripped before matching, so «preface» was looked up as «reface» and never found.
describe('go to page — labels that look like prefixes', () => {
  const front: PageIdentity[] = [
    { page_index: 0, printed_label: 'preface', kind: 'page' },
    { page_index: 1, printed_label: 'ص1', kind: 'page' },
    { page_index: 2, printed_label: '1', kind: 'page' },
  ];
  it('matches the label exactly as printed first', () => {
    expect(resolveGoTo('Preface', front)).toMatchObject({ ok: true, index: 0, matchedBy: 'printed' });
    expect(resolveGoTo('ص1', front)).toMatchObject({ ok: true, index: 1, matchedBy: 'printed' });
    // a prefix still works for ordinary labels
    expect(resolveGoTo('p 1', front)).toMatchObject({ ok: true, index: 2, matchedBy: 'printed' });
  });
});

