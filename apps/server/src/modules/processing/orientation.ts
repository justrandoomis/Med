// Orientation of a page's TEXT (H2 items 3, 5) — deterministic, no OSD model is bundled:
//  * scans / photos: tesseract reads the page as given; when its own reading shows the text runs vertically (word boxes
//    taller than wide → the picture is sideways) or reads poorly (possibly upside down), the picture is read again in
//    rotated trials and the orientation with the best reading is kept (`chooseOrientation`). A trial is only accepted
//    with a clear margin, so a poor but upright scan is never turned;
//  * digital PDF text: the direction of the text matrices (`textDirection`) says whether a page's /Rotate turns upright
//    text sideways; layout then runs in the orientation where the text is horizontal (`contentRotationFromText`).
// Every rotation here is a CLOCKWISE quarter turn applied to the page as displayed.
import type { OcrWord } from './ocr';

export type QuarterTurn = 0 | 90 | 180 | 270;

export function quarter(deg: number): QuarterTurn {
  return ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as QuarterTurn;
}

const ALNUM2 = /[\p{L}\p{N}].*[\p{L}\p{N}]/u;

/** Reading quality: confidence summed over words that look like words (≥ 2 letters / digits, conf ≥ 60). */
export function readingScore(words: OcrWord[]): number {
  let s = 0;
  for (const w of words) if (w.conf >= 60 && ALNUM2.test(w.text)) s += w.conf;
  return s;
}

/** Mean confidence of the word-like words (null when there are fewer than 3). */
function wordConfidence(words: OcrWord[]): number | null {
  const ws = words.filter((w) => ALNUM2.test(w.text));
  if (ws.length < 3) return null;
  return ws.reduce((n, w) => n + w.conf, 0) / ws.length;
}

/**
 * The words of the reading run vertically: tesseract read a sideways page as vertical lines — boxes of words of
 * ≥ 3 characters are much taller than wide (a horizontal word of n letters is ≈ n/2 × as wide as tall).
 */
export function textRunsVertically(words: OcrWord[]): boolean {
  const ws = words.filter((w) => [...w.text].length >= 3);
  if (ws.length < 3) return false;
  let vertical = 0;
  for (const w of ws) if (w.y1 - w.y0 > 1.3 * (w.x1 - w.x0)) vertical++;
  return vertical >= 0.6 * ws.length;
}

/** Which rotated trials a first reading calls for: sideways text → 90 / 270; a poor reading → 180; else none. */
export function orientationTrials(words: OcrWord[]): QuarterTurn[] {
  if (textRunsVertically(words)) return [90, 270];
  const conf = wordConfidence(words);
  if (conf !== null && conf < 70) return [180];
  return [];
}

export interface OrientationTrial {
  rotation: QuarterTurn;
  score: number;
}

/**
 * Pick the orientation to keep. Sideways text is never kept at 0 when a quarter turn reads (its layout would run
 * across the lines); otherwise a trial must read clearly better (≥ 1.3 × and + 60) than the page as given.
 */
export function chooseOrientation(first: OcrWord[], trials: OrientationTrial[]): QuarterTurn {
  const base = readingScore(first);
  if (trials.length === 0) return 0;
  const best = trials.reduce((a, b) => (b.score > a.score ? b : a));
  if (textRunsVertically(first)) return best.score >= 0.5 * base && best.score > 0 ? best.rotation : 0;
  return best.score >= 1.3 * base + 60 ? best.rotation : 0;
}

// ───────── digital text direction (PDF) ─────────

/** Characters per text direction (clockwise angle of the baseline in the unrotated top-left page space). */
export type DirectionCounts = Record<QuarterTurn, number>;

export function emptyDirections(): DirectionCounts {
  return { 0: 0, 90: 0, 180: 0, 270: 0 };
}

/**
 * The clockwise turn of the DISPLAY space that makes the page's dominant text run left → right. 0 for ordinary pages
 * (including pages whose /Rotate shows sideways-drawn text upright); 270 for a /Rotate 90 page holding upright text.
 * Needs a clear majority (≥ 60 % of the characters) and some text, else 0.
 */
export function contentRotationFromText(dirs: DirectionCounts, intrinsic: number, minChars = 25): QuarterTurn {
  const total = dirs[0] + dirs[90] + dirs[180] + dirs[270];
  if (total < minChars) return 0;
  let best: QuarterTurn = 0;
  for (const d of [90, 180, 270] as const) if (dirs[d] > dirs[best]) best = d;
  if (dirs[best] < 0.6 * total) return 0;
  const shown = quarter(best + intrinsic);
  return quarter(360 - shown);
}
