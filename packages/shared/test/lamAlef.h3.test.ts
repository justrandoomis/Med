// Round 7 — H3 item 8: the reversed lam-alef repair is ONE shared rule (server stored text + the reader's pdf.js text
// layer). It must repair the known reversed forms, never touch real words, and never change a length (the reader maps
// offsets 1:1 between the text layer, the search text and hit rectangles).
import { describe, expect, it } from 'vitest';
import { fixReversedLamAlef, fixReversedLamAlefPieces, showsReversedLamAlef } from '../src/lamAlef';

describe('fixReversedLamAlef (shared)', () => {
  it.each([
    ['يبدأ األلم عادة', 'يبدأ الألم عادة'],
    ['اإلنجاب', 'الإنجاب'],
    ['االلتهاب الحاد', 'الالتهاب الحاد'],
    ['وااللتهاب', 'والالتهاب'],
    ['بااللم', 'بالالم'],
    ['أي مما يلي ال يعد عرضًا', 'أي مما يلي لا يعد عرضًا'],
    ['وال يحدث', 'ولا يحدث'],
    ['كل الأعراض إال الحمى', 'كل الأعراض إلا الحمى'],
    ['أال تعلم', 'ألا تعلم'],
  ])('repairs %s', (raw, fixed) => {
    const r = fixReversedLamAlef(raw);
    expect(r.text).toBe(fixed);
    expect(r.text.length).toBe(raw.length);
    expect(r.fixes).toBeGreaterThan(0);
    expect(showsReversedLamAlef(raw)).toBe(true);
  });

  it.each([
    'الألم',
    'ألم شديد',
    'إلى المستشفى',
    'الآن',
    'آلة',
    'إلا الحمى',
    'ألا تعلم',
    'الالتهاب',
    'العالج', // a reversed «لا» inside a word: not repairable (flagged by the server instead), never guessed
    'العلاج',
    'السلام',
    'الأطفال والبالغون',
    'ال', // a bare «ال» with no word after it is left alone
    'McBurney point 2-3 cm',
    'ﻻ', // a presentation-form ligature is the server cleanup's job, not this rule's
    '',
  ])('leaves %s untouched', (text) => {
    expect(fixReversedLamAlef(text)).toEqual({ text, fixes: 0 });
  });

  it('pieces: a word split over two pieces is repaired; every piece keeps its length; separators are only for the rule', () => {
    const pieces = ['يبدأ ', 'األ', 'لم', ' عادة حول السرة', 'اإل', 'نجاب'];
    const eol = new Set([3]);
    const r = fixReversedLamAlefPieces(pieces, (i) => (eol.has(i) ? '\n' : ''));
    expect(r.pieces.map((p) => p.length)).toEqual(pieces.map((p) => p.length));
    expect(r.pieces.join('')).toBe('يبدأ الألم عادة حول السرةالإنجاب');
    // without the line break the second word would follow «ة» and is (correctly) not a word start
    const glued = fixReversedLamAlefPieces(pieces);
    expect(glued.pieces.join('')).toBe('يبدأ الألم عادة حول السرةاإلنجاب');
  });

  it('pieces with nothing to repair come back unchanged', () => {
    const pieces = ['الألم ', 'إلى ', 'الآن'];
    expect(fixReversedLamAlefPieces(pieces)).toEqual({ pieces, fixes: 0 });
  });
});
