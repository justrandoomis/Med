// P1-T4 step 1 — class-code alphabet and normalisation (review W2-step0 N9): Crockford's base32 (no I, L, O, U), and
// the look-alikes a student types are read as the digits they resemble, so «0O», «1IL» never make two codes.
import { describe, expect, it } from 'vitest';
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH, normalizeJoinCode } from '../src/academic/channels-api';

describe('class codes (Crockford base32)', () => {
  it('the alphabet has 32 symbols and none of the look-alikes I, L, O, U', () => {
    expect(JOIN_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(JOIN_CODE_ALPHABET).size).toBe(32);
    for (const c of 'ILOU') expect(JOIN_CODE_ALPHABET).not.toContain(c);
    expect(JOIN_CODE_LENGTH).toBe(8);
  });

  it('normalises case, spaces, dashes, Arabic-Indic digits and the look-alikes O→0, I→1, L→1', () => {
    expect(normalizeJoinCode('ab1o-il0z')).toBe('AB1011' + '0Z');
    expect(normalizeJoinCode(' o0o0   lI1i ')).toBe('00001111');
    expect(normalizeJoinCode('١٢٣٤-۵۶۷۸')).toBe('12345678');
    // every symbol of the alphabet is its own normal form
    for (const c of JOIN_CODE_ALPHABET) expect(normalizeJoinCode(c)).toBe(c);
  });
});
