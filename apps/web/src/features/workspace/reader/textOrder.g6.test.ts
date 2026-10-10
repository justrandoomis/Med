// G6 / AC-20 regression: the pdf.js text layer must hold a mixed Arabic/English line in LOGICAL order, so a selection
// from the start of the line to its end copies the whole sentence and the in-document search finds «نقطة McBurney».
// The items of the first line are the real pdf.js 6 text items of fixtures/golden/lecture_appendicitis.pdf page 1
// (content-stream order, positions in PDF units), captured with getTextContent().
import { describe, expect, it } from 'vitest';
import { logicalTextContent, type PdfTextItemLike } from './textOrder';

const item = (str: string, x: number, w: number, y = 599, dir = /[؀-ۿ]/.test(str) ? 'rtl' : 'ltr', hasEOL = false, size = 11): PdfTextItemLike => ({
  str,
  dir,
  transform: [size, 0, 0, size, x, y],
  width: w,
  height: size,
  fontName: 'g_d0_f1',
  hasEOL,
});
const join = (items: unknown[]) => (items as PdfTextItemLike[]).map((i) => i.str).join('');

/** «(McBurney's point).» then the Arabic sentence with «McBurney» — exactly as pdf.js returns them */
const GOLDEN_LINE = [
  item("(McBurney's point).", 72, 120, 618),
  item('', 219.6, 0, 599, 'ltr', true),
  item('حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى عند نقطة', 219.6, 243.2),
  item(' ', 462.8, 3.2),
  item('S', 466, 0, 598),
  item(' ', 462.8, 3.5),
  item('ة', 466.3, 5.2),
  item('يبدأ األلم عاد', 471.6, 51.8),
  item('McBurney', 166.4, 49.8),
  item('.', 163.4, 3.2),
  item('Anorexia and nausea are common.', 72, 300, 579),
];

describe('logicalTextContent (AC-20)', () => {
  it('puts the Golden Set mixed line in reading order, with the space pdf.js did not emit between «نقطة» and «McBurney»', () => {
    const before = join(GOLDEN_LINE);
    expect(before).toContain('عند نقطة S'); // content order: the middle of the sentence comes first
    const out = logicalTextContent({ items: GOLDEN_LINE, styles: {} });
    const text = join(out.items);
    expect(text).toContain('يبدأ األلم عادة S حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى عند نقطة McBurney.');
    // the line comes after the previous line's end marker and before the next line
    expect(text.indexOf("(McBurney's point).")).toBe(0);
    expect(text.endsWith('Anorexia and nausea are common.')).toBe(true);
    // the inserted space sits in the visual gap between the two words (PDF units), on the same baseline
    const space = (out.items as PdfTextItemLike[]).find((i, k, all) => i.str === ' ' && all[k + 1]?.str === 'McBurney')!;
    expect(space.transform[4]).toBeCloseTo(216.2, 1);
    expect(space.width).toBeCloseTo(3.4, 1);
    expect(space.transform[5]).toBe(599);
    expect(space.fontName).toBe('g_d0_f1'); // a font the text layer knows
    // every original item is still there exactly once (nothing dropped, nothing rewritten)
    for (const it of GOLDEN_LINE) expect((out.items as PdfTextItemLike[]).filter((x) => x.str === it.str && x.transform[4] === it.transform[4] && x.width === it.width).length).toBe(1);
    // the input objects were not mutated
    expect(GOLDEN_LINE[1]!.hasEOL).toBe(true);
    expect(join(GOLDEN_LINE)).toBe(before);
  });

  it('keeps a line the producer already wrote in a valid reading order (the bilingual title) — same object back', () => {
    const title = [item('Acute Appendicitis —', 72, 173), item(' ', 245, 3), item('التهاب الزائدة الدودية الحاد', 248, 150, 755 - 156)];
    const sameY = title.map((t) => ({ ...t, transform: [11, 0, 0, 11, t.transform[4]!, 755] }));
    const content = { items: sameY, styles: {} };
    expect(logicalTextContent(content)).toBe(content);
  });

  it('never touches text without right-to-left script', () => {
    const content = { items: [item('Leukocytosis', 72, 60, 500), item('2', 300, 6, 500), item('> 10 ×10⁹/L', 400, 60, 500)], styles: {} };
    expect(logicalTextContent(content)).toBe(content);
  });

  it('reads an RTL line drawn in visual (left-to-right) order logically, an English run inside it left to right', () => {
    // «الصوديوم Na+ 135 mmol/L طبيعي» drawn piece by piece from the left
    const visual = [item('طبيعي', 100, 30), item('Na+', 134, 20), item('135', 158, 18), item('mmol/L', 180, 36), item('الصوديوم', 220, 50, 599, 'rtl', true)];
    const out = logicalTextContent({ items: visual, styles: {} });
    expect(join(out.items)).toBe('الصوديوم Na+ 135 mmol/L طبيعي');
    // the end-of-line flag moves to the item that now ends the line (the text layer puts its <br> after it)
    const items = out.items as PdfTextItemLike[];
    expect(items.at(-1)!.str).toBe('طبيعي');
    expect(items.at(-1)!.hasEOL).toBe(true);
    expect(items.filter((i) => i.hasEOL)).toHaveLength(1);
  });

  it('leaves rotated text and marked-content items where they are', () => {
    const rotated = { ...item('عمودي', 50, 40), transform: [0, 11, -11, 0, 50, 300] };
    const marker = { type: 'beginMarkedContent', tag: 'P' };
    const content = { items: [marker, rotated, item('B', 10, 5, 100), item('أ', 30, 5, 100)], styles: {} };
    const out = logicalTextContent(content);
    expect(out.items[0]).toBe(marker);
    expect(out.items[1]).toBe(rotated);
  });
});
