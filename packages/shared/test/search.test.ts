import { describe, expect, it } from 'vitest';
import { normalizeForSearch, toFtsQuery } from '../src/search';

describe('normalizeForSearch', () => {
  it('unifies Arabic orthographic variants and strips harakat/tatweel', () => {
    expect(normalizeForSearch('الأَلَم')).toBe(normalizeForSearch('الالم'));
    expect(normalizeForSearch('إلتهاب')).toBe('التهاب');
    expect(normalizeForSearch('الزائدة')).toBe(normalizeForSearch('الزايده'));
    expect(normalizeForSearch('عـــادةً')).toBe('عاده');
    expect(normalizeForSearch('مستشفى')).toBe('مستشفي');
  });
  it('maps Arabic-Indic digits and lowercases Latin', () => {
    expect(normalizeForSearch('Na+ ١٣٥ mmol/L')).toBe('na+ 135 mmol/l');
  });
  it('decomposes lam-alef presentation forms', () => {
    expect(normalizeForSearch('ﻻ')).toBe('لا');
  });
  it('is idempotent', () => {
    const s = 'التهاب الزائدة الدودية Appendicitis ٥ mg';
    expect(normalizeForSearch(normalizeForSearch(s))).toBe(normalizeForSearch(s));
  });
});

describe('toFtsQuery', () => {
  it('quotes tokens so user input cannot inject FTS operators', () => {
    expect(toFtsQuery('pain OR NEAR(x) "drop')).toBe('"pain" "or" "near" "x" "drop"');
  });
  it('supports prefix on the last token and returns null for empty input', () => {
    expect(toFtsQuery('McBurn', { prefix: true })).toBe('"mcburn"*');
    expect(toFtsQuery('  ،،  ')).toBeNull();
  });
});
