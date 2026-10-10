// OCR coverage check (G3 / AC-08, AC-13): writing on a page that OCR never read must not pass silently.
//
// tesseract's automatic page segmentation (PSM 3) can skip whole lines — on an Arabic question photo it read the
// stem and silently dropped all four options «أ. … ب. … ج. … د. …», and the page was stored as fully read. This module
// finds text-like ink that no OCR word covers: rows of ink are grouped into line bands, each band is split into ink
// segments at large gaps, and a segment that looks like a line of text (about one OCR line high, wider than a couple of
// glyphs, plausible ink density, not touching the image border) but overlaps no OCR word box is «missed».
// The pipeline then re-reads the page with a uniform-block segmentation (PSM 6) and, if writing is still missed, marks
// the page for review with the places — an unreadable region is shown as uncertain, never as read.
// Heuristics only: multi-line ink blocks, pictures and thin rules are ignored on purpose (no false alarm on figures).
import type { OcrWord } from './ocr';
import type { RgbaImage } from './png';

export interface MissedText {
  /** pixel box in the OCR'd image */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const MAX_SAMPLES = 3_000_000;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Text-like ink segments of `img` that none of `words` (pixel boxes in the same image) covers. */
export function missedTextSegments(img: RgbaImage, words: OcrWord[]): MissedText[] {
  if (words.length === 0) return []; // nothing read at all is handled as «no text found» / a figure
  const { width, height, data } = img;
  const s = Math.max(1, Math.floor(Math.sqrt((width * height) / MAX_SAMPLES)));
  const sw = Math.floor(width / s);
  const sh = Math.floor(height / s);
  if (sw < 20 || sh < 20) return [];
  const lum = new Uint8Array(sw * sh);
  const hist = new Uint32Array(256);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const o = (y * s * width + x * s) * 4;
      const a = data[o + 3]! / 255;
      const v = Math.round((0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!) * a + 255 * (1 - a));
      lum[y * sw + x] = v;
      hist[v]!++;
    }
  }
  const total = sw * sh;
  const pct = (p: number) => {
    let acc = 0;
    const target = total * p;
    for (let i = 0; i < 256; i++) {
      acc += hist[i]!;
      if (acc >= target) return i;
    }
    return 255;
  };
  const dark = pct(0.002);
  const paper = pct(0.5);
  const contrast = pct(0.99) - dark;
  if (contrast < 60) return []; // too flat to tell ink from paper (low-quality scans are flagged elsewhere)
  const threshold = paper - Math.max(40, contrast * 0.4);
  const ink = (x: number, y: number) => lum[y * sw + x]! < threshold;

  // reference text heights from what OCR did read (a page often mixes small print with large text: the upper bound
  // uses the larger text so a big line, or one with a hand-drawn circle around its label, is not taken for a picture)
  const heights = words.map((w) => (w.y1 - w.y0) / s).filter((h) => h > 0).sort((a, b) => a - b);
  const lineH = median(heights);
  const tallH = heights[Math.floor(heights.length * 0.75)] ?? lineH;
  if (lineH < 4) return [];

  // 1) line bands: runs of rows holding ink (small gaps bridged)
  const rowInk = new Uint32Array(sh);
  for (let y = 0; y < sh; y++) {
    let n = 0;
    for (let x = 0; x < sw; x++) if (ink(x, y)) n++;
    rowInk[y] = n;
  }
  const bands: Array<[number, number]> = [];
  const bridge = Math.max(1, Math.round(lineH * 0.15));
  let start = -1;
  let last = -1;
  for (let y = 0; y < sh; y++) {
    if (rowInk[y]! >= 2) {
      if (start < 0) start = y;
      else if (y - last > bridge + 1) {
        bands.push([start, last]);
        start = y;
      }
      last = y;
    }
  }
  if (start >= 0) bands.push([start, last]);

  const boxes = words.map((w) => ({ x0: w.x0 / s, y0: w.y0 / s, x1: w.x1 / s, y1: w.y1 / s }));
  const missed: MissedText[] = [];
  const edge = Math.max(2, Math.round(Math.min(sw, sh) * 0.01));
  for (const [top, bottom] of bands) {
    const h = bottom - top + 1;
    if (h < lineH * 0.5 || h > tallH * 3.5) continue; // a rule / speck, or a picture / a block of lines run together
    // 2) ink segments inside the band, split at gaps wider than a word space
    const colInk = new Uint32Array(sw);
    for (let x = 0; x < sw; x++) {
      let n = 0;
      for (let y = top; y <= bottom; y++) if (ink(x, y)) n++;
      colInk[x] = n;
    }
    const gap = Math.max(2, Math.round(lineH * 1.2));
    let s0 = -1;
    let s1 = -1;
    const segments: Array<[number, number]> = [];
    for (let x = 0; x < sw; x++) {
      if (colInk[x]! > 0) {
        if (s0 < 0) s0 = x;
        else if (x - s1 > gap) {
          segments.push([s0, s1]);
          s0 = x;
        }
        s1 = x;
      }
    }
    if (s0 >= 0) segments.push([s0, s1]);
    for (const [x0, x1] of segments) {
      const w = x1 - x0 + 1;
      if (w < lineH * 1.5) continue; // one glyph, a bullet, an icon
      if (x0 <= edge || x1 >= sw - 1 - edge || top <= edge || bottom >= sh - 1 - edge) continue; // page border / shadow
      let n = 0;
      for (let x = x0; x <= x1; x++) n += colInk[x]!;
      const density = n / (w * h);
      if (density < 0.04 || density > 0.6) continue; // not text-like (sparse noise, a filled shape)
      // 3) covered when any OCR word box overlaps it (a third of the band's height at least)
      const covered = boxes.some((b) => b.x1 >= x0 && b.x0 <= x1 && Math.min(b.y1, bottom + 1) - Math.max(b.y0, top) >= h * 0.3);
      if (!covered) missed.push({ x0: x0 * s, y0: top * s, x1: (x1 + 1) * s, y1: (bottom + 1) * s });
    }
  }
  return missed;
}
