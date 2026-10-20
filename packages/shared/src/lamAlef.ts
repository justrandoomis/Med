// Reversed lam-alef ligature repair — ONE narrow rule shared by the server (stored text: search, Study Book, export,
// processing/text.ts) and the reader (the selectable pdf.js text layer and the in-document search, Round 7 — H3 item 8).
//
// Some fonts map the lam-alef ligature glyphs (ل + ا/أ/إ/آ) back to Unicode in the WRONG order, so «الألم» is extracted
// as «األلم» (alef, hamza-alef, lam …), «الإنجاب» as «اإلنجاب», and — with the plain «لا» ligature after the article —
// «الالتهاب» as «االلتهاب», «الانسداد» as «االنسداد» (LibreOffice PDF export does this for every lam-alef). A word that
// starts with a bare alef immediately followed by ANOTHER alef (bare, hamzated or madda) does not occur in Arabic
// orthography, so the rule only fires there: at a word start, optionally after up to two one-letter proclitics
// (و ف ب ك). It never touches «ألم», «أل…», «إلى», «الآن», «آلة», «الا…» or an already-correct «الألم».
// The negation words themselves (G4 / AC-11): the stand-alone «لا» is extracted as «ال» and «إلا» / «ألا» as «إال» /
// «أال». A bare article «ال» never stands alone before a word, and «إال» / «أال» are not words, so these whole-word forms
// are repaired: «ال» / «وال» only when another Arabic word follows; «إال» / «أال» anywhere.
// A reversed «لا» INSIDE a word («العلاج» → «العالج») cannot be repaired: «ال» is also correct there in many words; the
// server FLAGS such words for review instead (processing/text.ts `ambiguousLamAlefWords`).
//
// Every replacement has the SAME LENGTH as what it replaces (letters swap places, nothing is inserted or removed), so a
// caller can map offsets 1:1 — the reader relies on that to keep its text layer, search offsets and hit rectangles
// aligned.

/** Arabic letters (hamza … yeh, plus extended letters); excludes tatweel U+0640, harakat and digits. */
export const AR_LETTER_CLASS = '\\u0621-\\u063A\\u0641-\\u064A\\u066E-\\u06D3\\u06FA-\\u06FF\\u0750-\\u077F\\u08A0-\\u08C9';
const AR_MARKS = '\\u064B-\\u0652\\u0670';

const REVERSED_LAM_ALEF_SRC = `(?<![${AR_LETTER_CLASS}\\u0640])([وفبك]{0,2})ا([اأإآ])ل`;
const REVERSED_LA_WORD_SRC = `(?<![${AR_MARKS}${AR_LETTER_CLASS}\\u0640])(و?)ال(?=\\s+[${AR_MARKS}]*[${AR_LETTER_CLASS}])`;
const REVERSED_ILLA_WORD_SRC = `(?<![${AR_MARKS}${AR_LETTER_CLASS}\\u0640])([إأ])ال(?![${AR_MARKS}${AR_LETTER_CLASS}\\u0640])`;

/**
 * Repairs the reversed lam-alef forms described above. Length-preserving: `out.text.length === text.length` and every
 * character outside a repaired word stays at its offset. `fixes` counts the repaired words.
 */
export function fixReversedLamAlef(text: string): { text: string; fixes: number } {
  let fixes = 0;
  const out = text
    .replace(new RegExp(REVERSED_LAM_ALEF_SRC, 'g'), (_m, proclitics: string, alef: string) => {
      fixes++;
      return `${proclitics}ال${alef}`;
    })
    .replace(new RegExp(REVERSED_LA_WORD_SRC, 'g'), (_m, waw: string) => {
      fixes++;
      return `${waw}لا`;
    })
    .replace(new RegExp(REVERSED_ILLA_WORD_SRC, 'g'), (_m, hamza: string) => {
      fixes++;
      return `${hamza}لا`;
    });
  return { text: out, fixes };
}

/** Whether text shows one of the reversed lam-alef forms the repair fixes (a sign the font reverses its ligatures). */
export function showsReversedLamAlef(text: string): boolean {
  return new RegExp(REVERSED_LAM_ALEF_SRC).test(text) || new RegExp(REVERSED_LA_WORD_SRC).test(text) || new RegExp(REVERSED_ILLA_WORD_SRC).test(text);
}

/**
 * Repairs a sequence of text pieces that are shown one after the other (pdf.js text items): the pieces are read as one
 * text — `joinAfter[i]` is put between piece i and i+1 for the rule only (e.g. '\n' after a line end, so the first word
 * of a line is a word start) — and cut back into pieces of exactly their original lengths. A word split across two
 * pieces is repaired too; each piece keeps its length, so its position and the offsets around it do not move.
 */
export function fixReversedLamAlefPieces(pieces: readonly string[], joinAfter?: (index: number) => string): { pieces: string[]; fixes: number } {
  const seps = pieces.map((_, i) => (i < pieces.length - 1 ? (joinAfter?.(i) ?? '') : ''));
  let joined = '';
  for (let i = 0; i < pieces.length; i++) joined += pieces[i]! + seps[i]!;
  const { text, fixes } = fixReversedLamAlef(joined);
  if (fixes === 0) return { pieces: [...pieces], fixes: 0 };
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < pieces.length; i++) {
    out.push(text.slice(at, at + pieces[i]!.length));
    at += pieces[i]!.length + seps[i]!.length;
  }
  return { pieces: out, fixes };
}
