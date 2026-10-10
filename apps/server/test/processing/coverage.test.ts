// G3 / AC-08 · AC-13 regression: writing that OCR never read must be found (the pipeline re-reads the page with a
// uniform-block segmentation and marks what is still unread for review). Pure detector tests on synthetic pixels.
import { describe, expect, it } from 'vitest';
import { missedTextSegments } from '../../src/modules/processing/coverage';
import type { OcrWord } from '../../src/modules/processing/ocr';
import type { RgbaImage } from '../../src/modules/processing/png';

function canvas(w: number, h: number): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([247, 245, 239, 255], i * 4);
  return { width: w, height: h, data };
}
function fill(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, v = 20) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set([v, v, v, 255], (y * img.width + x) * 4);
}
/** a line of «glyphs»: 6×20 px strokes 4 px apart, words separated by 14 px */
function textLine(img: RgbaImage, x: number, y: number, words: number[]) {
  let cx = x;
  for (const glyphs of words) {
    for (let g = 0; g < glyphs; g++) {
      fill(img, cx, y, cx + 6, y + 20);
      cx += 10;
    }
    cx += 14;
  }
  return cx;
}
const word = (x0: number, y0: number, x1: number, y1: number, line = 1): OcrWord => ({ text: 'w', conf: 90, x0, y0, x1, y1, lineHeight: y1 - y0, line });

describe('missedTextSegments (G3 / AC-08, AC-13)', () => {
  it('finds a line of writing no OCR word covers, and nothing when every line is read', () => {
    const img = canvas(600, 300);
    const end1 = textLine(img, 40, 40, [4, 6, 3]);
    const end2 = textLine(img, 40, 120, [5, 5]);
    const read1 = [word(40, 40, end1, 60)];
    const missed = missedTextSegments(img, read1);
    expect(missed).toHaveLength(1);
    expect(missed[0]!.y0).toBeGreaterThanOrEqual(115);
    expect(missed[0]!.y1).toBeLessThanOrEqual(145);
    expect(missedTextSegments(img, [...read1, word(40, 120, end2, 140, 2)])).toEqual([]);
  });

  it('ignores what is not a line of text: a picture, a thin rule, a lone glyph, ink touching the border', () => {
    const img = canvas(600, 400);
    const end = textLine(img, 40, 40, [4, 6]);
    fill(img, 300, 150, 520, 330); // a picture block (much taller than a line)
    fill(img, 40, 100, 560, 102); // a rule
    fill(img, 60, 200, 66, 220); // one glyph
    fill(img, 0, 250, 200, 270); // ink against the left border (shadow / page edge)
    expect(missedTextSegments(img, [word(40, 40, end, 60)])).toEqual([]);
  });

  it('nothing read at all, or a flat image: no verdict here (handled as «no text found» / low quality)', () => {
    const img = canvas(400, 200);
    textLine(img, 40, 40, [4, 4]);
    expect(missedTextSegments(img, [])).toEqual([]);
    const flat = canvas(400, 200);
    fill(flat, 40, 40, 200, 60, 230);
    expect(missedTextSegments(flat, [word(10, 10, 20, 30)])).toEqual([]);
  });
});
