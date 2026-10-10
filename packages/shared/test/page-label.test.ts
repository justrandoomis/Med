// G1 / AC-04: page identity labels (printed number vs file position).
import { describe, expect, it } from 'vitest';
import { pageDisplayLabel, sourceChipLabel } from '../src';

describe('pageDisplayLabel (AC-04)', () => {
  it('both numberings when the printed label differs from the file position', () => {
    expect(pageDisplayLabel({ page_index: 13, printed_label: '12', kind: 'page' })).toBe('ص 12 (الصفحة 14 في الملف)');
    expect(pageDisplayLabel({ page_index: 13, printed_label: '12', kind: 'page' }, { withFileIndex: false })).toBe('ص 12');
    expect(pageDisplayLabel({ page_index: 11, printed_label: '12', kind: 'page' })).toBe('ص 12');
  });

  it('an unnumbered page among numbered ones is named by its file position only — never «ص N»', () => {
    const cover = { page_index: 0, printed_label: null, kind: 'page' as const, numbered_version: true };
    expect(pageDisplayLabel(cover)).toBe('الصفحة 1 في الملف');
    expect(pageDisplayLabel(cover, { withFileIndex: false })).toBe('الصفحة 1 في الملف');
    expect(sourceChipLabel({ source_type: 'lecture', locator_label_ar: pageDisplayLabel(cover) })).toBe('محاضرة الصفحة 1 في الملف');
    expect(sourceChipLabel({ source_type: 'lecture', locator_label_ar: pageDisplayLabel({ page_index: 13, printed_label: '12', kind: 'page' }) })).toBe('محاضرة ص12');
  });

  it('documents without printed numbers, slides, images and sections are unchanged', () => {
    expect(pageDisplayLabel({ page_index: 2, printed_label: null, kind: 'page' })).toBe('ص 3');
    expect(pageDisplayLabel({ page_index: 2, printed_label: null, kind: 'page', numbered_version: false })).toBe('ص 3');
    expect(pageDisplayLabel({ page_index: 2, printed_label: null, kind: 'image', numbered_version: true })).toBe('صورة 3');
    expect(pageDisplayLabel({ page_index: 2, printed_label: '3', kind: 'slide', numbered_version: true })).toBe('شريحة 3');
  });
});
