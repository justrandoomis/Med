// H2 item 9 — LibreOffice PDFs reverse the PLAIN lam-alef ligature in the text layer: «العلامة» is stored «العالمة»,
// «العلاج» «العالج», «السلام» «السالم». The word-start rule could not repair these (a real word may contain «ال»), so
// documents showing the defect got review flags and lecture ↔ question matching missed the words. The ligature is
// visible in the PDF itself: its glyph maps to the TWO letters «لا», and pdf.js reverses them with the rest of the RTL
// run. Words drawn with a lam-alef glyph are now rebuilt from the glyphs; a word drawn with separate alef and lam
// glyphs (a real «العالم») is never touched, and a form that is both a repaired word and a real word stays flagged.
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ligatureWordMap, type GlyphRun } from '../../src/modules/processing/pdf';
import { searchChunks } from '../../src/modules/processing/search';
import { convertToPdf, findExecutable } from '../../src/modules/processing/tools';
import type { TestApp } from '../helpers/app';
import { addSource, createProcessingApp, pages, processVersion, regions } from './helpers';

const SOFFICE = findExecutable('soffice') ?? findExecutable('libreoffice');
const SENTENCE = 'العلامة السريرية الأهم هي ألم الحفرة الحرقفية، والعالم كله يعرف العلاج والسلام، ولا يوجد إلا هذا الاختبار.';

/** Visual-order glyphs of an RTL run (what the PDF draws, left to right) from the logical word list. */
function visualRun(words: string[][]): GlyphRun {
  const glyphs: GlyphRun = [];
  words.forEach((w, i) => {
    if (i > 0) glyphs.push(-250);
    glyphs.push(...w.map((unicode) => ({ unicode })));
  });
  return glyphs.reverse();
}

describe('ligature words from the glyphs (unit)', () => {
  it('a word drawn with a «لا» glyph maps from its reversed form; words drawn letter by letter are verified, never mapped', () => {
    // «العلامة» drawn ا ل ع [لا] م ة ; «العالم» drawn ا ل ع ا ل م (no ligature)
    const run = visualRun([
      ['ا', 'ل', 'ع', 'لا', 'م', 'ة'],
      ['ا', 'ل', 'ع', 'ا', 'ل', 'م'],
      ['و', 'لا'],
      ['ا', 'ل', 'أ', 'ه', 'م'],
    ]);
    const { map, verified } = ligatureWordMap([run]);
    expect([...map.entries()].sort()).toEqual(
      [
        ['العالمة', 'العلامة'],
        ['وال', 'ولا'],
      ].sort(),
    );
    expect([...verified].sort()).toEqual(['الأهم', 'العالم', 'العلامة', 'ولا'].sort());
  });

  it('a reversed form that is ALSO a real word of the document is ambiguous: not mapped', () => {
    // «العالم» drawn with a ligature in one place (= a reversed «العلام»…) and letter by letter elsewhere
    const run = visualRun([
      ['ا', 'ل', 'ع', 'لا', 'م'],
      ['ا', 'ل', 'ع', 'ا', 'ل', 'م'],
    ]);
    const { map } = ligatureWordMap([run]);
    expect(map.has('العالم')).toBe(false);
  });

  it('only lam-alef glyphs are rebuilt: a letter + harakah drawn as one glyph keeps pdf.js text (still flagged as an orphan mark)', () => {
    // a converter drew «تُ» (ta + damma) as ONE glyph; the word may be damaged otherwise (a stray glyph next to it), so it
    // is not «fixed» silently — the orphan-mark check keeps flagging it (srv:processing/pipeline .doc test)
    const run = visualRun([['تُ', 'ص', 'ن', 'ف']]);
    expect(ligatureWordMap([run]).map.size).toBe(0);
  });

  it('presentation-form ligature glyphs (U+FEFB) and hamza forms count; Latin runs are left alone', () => {
    const run = visualRun([['ا', 'ﻷ', 'ل', 'م']]); // «الألم» = ا + [لأ] + ل + م, drawn with the presentation form
    expect([...ligatureWordMap([run]).map.entries()]).toEqual([['األلم', 'الألم']]); // «األلم», the known reversed form
    const latin: GlyphRun = [{ unicode: 'f' }, { unicode: 'i' }, { unicode: 'fi' }];
    expect(ligatureWordMap([latin]).map.size).toBe(0);
  });
});

let t: TestApp;
let versionId: string;
beforeAll(async () => {
  if (!SOFFICE) return;
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun('TEST FIXTURE - synthetic document for automated tests. Not a medical reference.')] }),
          new Paragraph({ bidirectional: true, children: [new TextRun({ text: SENTENCE, rightToLeft: true, size: 28 })] }),
        ],
      },
    ],
  });
  t = await createProcessingApp();
  const pdf = await convertToPdf({ soffice: SOFFICE, input: Buffer.from(await Packer.toBuffer(doc)), inputExt: 'docx', tmpRoot: t.ctx.config.tmpDir, timeoutMs: 170_000 });
  versionId = (await addSource(t, 'lo_arabic.pdf', 'pdf', { data: pdf, fileName: 'lo_arabic.pdf' })).versionId;
  await processVersion(t, versionId);
}, 240_000);
afterAll(async () => t?.close());

describe.skipIf(!SOFFICE)('a LibreOffice Arabic PDF (H2 item 9)', () => {
  it('words drawn with a lam-alef ligature are stored right; the real «العالم» is unchanged', () => {
    const all = regions(t, versionId)
      .map((r) => r.text ?? '')
      .join('\n');
    for (const w of ['العلامة', 'العلاج', 'والسلام', 'ولا', 'إلا', 'الاختبار', 'والعالم', 'الأهم']) expect(all, w).toContain(w);
    for (const reversed of ['العالمة', 'العالج', 'والسالم', 'وال يوجد', 'إال', 'االختبار', 'األهم']) expect(all, reversed).not.toContain(reversed);
  });

  it('no ambiguous lam-alef flag is left where the glyphs settled the spelling; the page is ready', () => {
    const rs = regions(t, versionId);
    expect(rs.filter((r) => r.status === 'needs_review').map((r) => r.text)).toEqual([]);
    expect(pages(t, versionId)[0]!.processing_status).toBe('ready');
  });

  it('search finds the repaired words (lecture ↔ question matching uses the same text)', () => {
    expect(searchChunks(t.ctx.db, { versionIds: [versionId] }, 'العلامة السريرية').length).toBeGreaterThan(0);
    expect(searchChunks(t.ctx.db, { versionIds: [versionId] }, 'العلاج').length).toBeGreaterThan(0);
  });
});
