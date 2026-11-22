// Picture pages («صورة»): a slide or page that IS a picture (a pathology / histology photo, a gross specimen, an X-ray)
// with at most a short caption. OCR on such a page reads photo texture as "words" with very low confidence, finds
// "unread writing" in the tissue and calls the photo a low-quality scan — none of which is a reading problem the owner
// can or should fix. A picture page is therefore READY: its image is the content (described by the AI figure
// descriptions when the owner enabled them, modules/processing/figures.ts), the readable words of its caption are kept
// as an uncertain OCR reading, and OCR noise is not stored as text. A page with a real amount of text — even read
// poorly — is never a picture page: its doubts stay honest review items (pipeline.ts / finalizeRegions).
import type { OcrWord } from './ocr';
import type { Box } from './layout/types';
import type { RgbaImage } from './png';

/** pictures must cover at least this share of the page (PDF pages; an image page is a picture by itself) */
export const PICTURE_MIN_COVERAGE = 0.3;
/** at most this many characters of plausible text (the same bound as an «image-only» page in figures.ts) */
export const PICTURE_MAX_TEXT_CHARS = 80;
/** OCR words at or above this confidence are readable text (= OCR_REVIEW_WORD_CONF) */
export const PICTURE_READABLE_CONF = 60;
/** below this confidence a plausible word counts as weak (between NOISE and READABLE) or as texture (below NOISE) */
export const PICTURE_NOISE_CONF = 40;
/** a page that is mostly picture (≥ this share) whose weak "words" average below NOISE_MEAN_CONF is texture */
export const PICTURE_DOMINANT_COVERAGE = 0.6;
export const PICTURE_NOISE_MEAN_CONF = 45;
/**
 * At or above this pixelNoise the render is noise (neighbouring pixels as unrelated as distant ones): a damaged image
 * stream, a broken decode, static. A real photo — even fine histology — is smooth at the pixel scale (≈ 0.1–0.5).
 */
export const PICTURE_MAX_NOISE = 0.8;

const letters = (t: string) => (t.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** A word that could be writing: two or more letters / digits (texture reads as «|», «~», «i», «'»). */
export function plausibleWord(w: Pick<OcrWord, 'text'>): boolean {
  return letters(w.text) >= 2;
}

/**
 * Whether an OCR word on a picture page is kept (a readable caption / label word) or dropped as texture. Only readable
 * words are stored: the caption of a picture page is then exactly what made it a picture page (< 80 letters), and the
 * picture itself is described by the figure descriptions, never by tissue read as letters.
 */
export function keepOnPicture(w: Pick<OcrWord, 'text' | 'conf'>): boolean {
  return w.conf >= PICTURE_READABLE_CONF && plausibleWord(w);
}

export interface PictureInput {
  /** share of the page covered by pictures (0–1); 1 for an image page */
  coverage: number;
  /** OCR words of the page (all of them) */
  words: Array<Pick<OcrWord, 'text' | 'conf'>>;
  /** characters of digital (text-layer) body text on the page */
  digitalChars: number;
  /** the render is blank (png.ts measureImageQuality): nothing is drawn, so there is no picture to be the content */
  blank?: boolean;
  /** pixelNoise of the render (absent = not measured): a damaged / garbage render is noise, not a photo */
  noise?: number;
}

export interface PictureVerdict {
  picture: boolean;
  /** characters of words read with good confidence */
  readableChars: number;
  /** characters of plausible words read with weak confidence (a poor scan of a text page has many) */
  weakChars: number;
  /** mean confidence of the plausible words read below PICTURE_READABLE_CONF (null: none) */
  weakMeanConf: number | null;
}

/**
 * A picture page: pictures cover a large part of it and the readable text stays below a caption's length. The weak
 * "words" decide the rest: few of them → a picture; many of them → a picture only when the page is mostly picture AND
 * they read like texture (very low mean confidence). A blurred scan of a TEXT page (many weak words read at a
 * middling confidence, mostly paper) is therefore never a picture page: its doubts are real and stay in review.
 */
export function classifyPicturePage(input: PictureInput): PictureVerdict {
  // no real picture content (a blank render, a damaged one that decodes to noise): never «ready» as a picture — the
  // page keeps its honest issue (no text found / damaged) and stays in review
  const noContent = input.blank === true || (input.noise ?? 0) >= PICTURE_MAX_NOISE;
  let readableChars = input.digitalChars;
  let weakChars = 0;
  let weakConf = 0;
  let weakN = 0;
  for (const w of input.words) {
    if (!plausibleWord(w)) continue;
    if (w.conf >= PICTURE_READABLE_CONF) readableChars += letters(w.text);
    else {
      weakConf += w.conf;
      weakN++;
      if (w.conf >= PICTURE_NOISE_CONF) weakChars += letters(w.text);
    }
  }
  const weakMeanConf = weakN ? weakConf / weakN : null;
  const texture = weakChars < PICTURE_MAX_TEXT_CHARS || (input.coverage >= PICTURE_DOMINANT_COVERAGE && (weakMeanConf ?? 0) < PICTURE_NOISE_MEAN_CONF);
  const picture = !noContent && input.coverage >= PICTURE_MIN_COVERAGE && readableChars < PICTURE_MAX_TEXT_CHARS && texture;
  return { picture, readableChars, weakChars, weakMeanConf };
}

/** a sample differs from the page background by more than this (luma, or colour spread) */
const BUSY_DELTA = 40;

/**
 * Share of a raster that is picture content: samples (a 96×96 grid) that are clearly coloured (stain, skin, mucosa) or
 * differ clearly from the page's background colour (the most frequent quantised colour). A photo / histology slide is busy almost everywhere; a scan of a TEXT
 * page — even a blurred one with little text — is mostly paper (its ink is a small share), so it is never a picture.
 */
export function busyShare(img: RgbaImage): number {
  if (img.width < 2 || img.height < 2) return 0;
  const N = 96;
  const samples: Array<[number, number, number]> = [];
  const hist = new Map<number, number>();
  for (let gy = 0; gy < N; gy++) {
    const y = Math.min(img.height - 1, Math.floor(((gy + 0.5) / N) * img.height));
    for (let gx = 0; gx < N; gx++) {
      const x = Math.min(img.width - 1, Math.floor(((gx + 0.5) / N) * img.width));
      const o = (y * img.width + x) * 4;
      const px: [number, number, number] = [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
      samples.push(px);
      const key = ((px[0] >> 4) << 8) | ((px[1] >> 4) << 4) | (px[2] >> 4);
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
  }
  let mode = 0;
  let best = -1;
  for (const [k, n] of hist) if (n > best) [mode, best] = [k, n];
  const bg = [((mode >> 8) & 15) * 16 + 8, ((mode >> 4) & 15) * 16 + 8, (mode & 15) * 16 + 8];
  let busy = 0;
  for (const [r, g, b] of samples) {
    // stained tissue / clinical colour is picture even where it is the most frequent colour; paper is near-neutral
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma > BUSY_DELTA || Math.max(Math.abs(r - bg[0]!), Math.abs(g - bg[1]!), Math.abs(b - bg[2]!)) > BUSY_DELTA) busy++;
  }
  return busy / samples.length;
}

/**
 * How much a raster looks like noise (0 = smooth, ≈ 1 = static): the mean luma difference between horizontally
 * ADJACENT pixels over the mean difference between pixels far apart. Every real image is correlated at the pixel scale
 * (a photo, a stained slide, a scan: adjacent pixels are alike), so the ratio stays well below 1; a render of a damaged
 * stream or a garbage decode is not. A flat image (no difference anywhere) is 0 — `blank` covers it.
 */
export function pixelNoise(img: RgbaImage): number {
  const { width: w, height: h, data } = img;
  if (w < 4 || h < 4) return 0;
  const luma = (x: number, y: number) => {
    const o = (y * w + x) * 4;
    return 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
  };
  const N = 128;
  let near = 0;
  let far = 0;
  for (let gy = 0; gy < N; gy++) {
    const y = Math.min(h - 1, Math.floor(((gy + 0.5) / N) * h));
    const yFar = (y + Math.floor(h / 2)) % h;
    for (let gx = 0; gx < N; gx++) {
      const x = Math.min(w - 2, Math.floor(((gx + 0.5) / N) * w));
      const xFar = (x + Math.floor(w / 2)) % w;
      const v = luma(x, y);
      near += Math.abs(v - luma(x + 1, y));
      far += Math.abs(v - luma(xFar, yFar));
    }
  }
  // far differences below ≈ 4 luma levels on average: a flat page (blank), not a measure of noise
  if (far / (N * N) < 4) return 0;
  return near / far;
}

/** Share of a page covered by the union of picture boxes (overlaps counted once; a coarse 64×64 grid). */
export function pictureCoverage(boxes: Box[], geom: { width: number; height: number }): number {
  if (!boxes.length || geom.width <= 0 || geom.height <= 0) return 0;
  const N = 64;
  let covered = 0;
  for (let gy = 0; gy < N; gy++) {
    const y = ((gy + 0.5) / N) * geom.height;
    for (let gx = 0; gx < N; gx++) {
      const x = ((gx + 0.5) / N) * geom.width;
      if (boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.top && y <= b.bottom)) covered++;
    }
  }
  return covered / (N * N);
}
