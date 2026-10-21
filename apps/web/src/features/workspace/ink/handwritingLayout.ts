// Handwriting layout tools (parity N1 wave 2, G10 and G11) — pure, unit-tested.
//
//  * «أفسح مكانًا» (insert space): everything the owner wrote after a line — below it, or beside it — moves by the
//    distance dragged, in ONE undo step. Only the owner's items move: printed content (and the reader's highlights on it,
//    which belong to the printed text) never moves.
//  * «استقم» (straighten): each written line of the selection is turned about its centre so its fitted baseline is level.
//    The strokes are moved as a whole (rotation only): the shapes of the letters — and the dots of Arabic letters, which
//    are separate strokes — keep exactly their place in the word.
//  * word reflow (phase 2): re-wraps the words of the selection to a new width, right to left for Arabic. Words are found
//    from the gaps in the writing, and only when handwriting recognition read the SAME number of words (so a gap inside a
//    word is never taken for a space). Words move as a whole (translation only); never available without recognition.
//  * the neat copy (G11) uses the same lines: a DERIVED view, never stored.
import type { InkData, NormBox } from '@medlevo/shared';
import type { ItemChange } from './history';
import { bboxOf, rotateAbout, type Mat, type Vec } from './math';
import { isInkStroke, itemBBox, transformItem, type InkItem, type InkItemOf } from './model';

type Stroke = InkItemOf<InkData>;

// ─── insert space ─────────────────────────────────────────────────────────────────────────────
export interface SpacePlan {
  changes: ItemChange[];
  /** items left in place because they cross the line */
  crossing: number;
  /** the distance actually made (normalized, signed like the request) */
  delta: number;
  /**
   * (review of N1 wave 2) the room made is less than asked — or none: the writing after the line reached the page's
   * edge. Nothing is ever pushed past the page (it would be drawn nowhere and no tool could reach it again).
   */
  limited: boolean;
}

/**
 * Moves every movable item after a line by `delta` (normalized). `axis: 'y'`: items whose top is below `at` move down
 * by `delta` (> 0). `axis: 'x'`: on the line pressed only (`band`: its top and bottom; items whose middle lies in it),
 * with `delta` < 0 the items left of `at` move left (Arabic: inserting space between words pushes the rest of the line
 * on to the left); with `delta` > 0 the items right of `at` move right. The distance is cut to what the page has left, so
 * no item leaves the page (`limited`).
 */
export function insertSpacePlan(items: readonly InkItem[], opts: { axis: 'x' | 'y'; at: number; delta: number; targetKey: string; ar: number; now: number; movable: (it: InkItem) => boolean; band?: readonly [number, number] }): SpacePlan {
  const { axis, at, targetKey, ar, now, band } = opts;
  const out: SpacePlan = { changes: [], crossing: 0, delta: 0, limited: false };
  const asked = opts.delta;
  if (!Number.isFinite(asked) || Math.abs(asked) < 1e-4 || (axis === 'y' && asked < 0)) return out;
  const moving: Array<{ it: InkItem; b: NormBox }> = [];
  for (const it of items) {
    if (!opts.movable(it)) continue;
    const b = itemBBox(it, ar);
    // (review of N1 wave 2) sideways = on this line only: the writing of the other lines stays where it is
    if (axis === 'x' && band) {
      const cy = b.y + b.h / 2;
      if (cy < band[0] || cy > band[1]) continue;
    }
    const lo = axis === 'y' ? b.y : b.x;
    const hi = axis === 'y' ? b.y + b.h : b.x + b.w;
    const after = axis === 'y' ? lo >= at : asked < 0 ? hi <= at : lo >= at;
    if (!after) {
      if (lo < at && hi > at) out.crossing++;
      continue;
    }
    moving.push({ it, b });
  }
  if (moving.length === 0) return out;
  // the room the page has left in that direction (never negative: writing already past the edge moves nowhere further)
  const room =
    axis === 'y'
      ? Math.max(0, 1 - Math.max(...moving.map((m) => m.b.y + m.b.h)))
      : asked < 0
        ? Math.max(0, Math.min(...moving.map((m) => m.b.x)))
        : Math.max(0, 1 - Math.max(...moving.map((m) => m.b.x + m.b.w)));
  const delta = Math.sign(asked) * Math.min(Math.abs(asked), room);
  out.limited = Math.abs(delta) < Math.abs(asked) - 1e-9;
  if (Math.abs(delta) < 1e-4) return out;
  out.delta = delta;
  const m: Mat = axis === 'y' ? [1, 0, 0, 1, 0, delta * ar] : [1, 0, 0, 1, delta, 0];
  for (const { it } of moving) out.changes.push({ id: it.id, targetKey, before: it, after: transformItem(it, m, ar, now) });
  return out;
}

/**
 * (review of N1 wave 2) The line a sideways «أفسح مكانًا» acts on: the written line of `strokes` at height `y` (its top
 * and bottom, the dots and marks above and below the letters included), else the items crossing that height, else a
 * thin band around it.
 */
export function lineBandAt(items: readonly InkItem[], y: number, ar: number, tol: number): [number, number] {
  const strokes = items.filter((it): it is Stroke => isInkStroke(it) && it.data.style.tool !== 'highlighter');
  const lines = writtenLines(strokes, ar);
  const hit = lines.find((l) => y >= l.box.y - tol && y <= l.box.y + l.box.h + tol);
  if (hit) return [hit.box.y - tol, hit.box.y + hit.box.h + tol];
  let lo = Infinity;
  let hi = -Infinity;
  for (const it of items) {
    const b = itemBBox(it, ar);
    if (b.y - tol <= y && b.y + b.h + tol >= y) {
      lo = Math.min(lo, b.y);
      hi = Math.max(hi, b.y + b.h);
    }
  }
  return Number.isFinite(lo) ? [lo - tol, hi + tol] : [y - tol, y + tol];
}

// ─── lines and words of handwriting ─────────────────────────────────────────────────────────────
export interface WordCluster {
  ids: string[];
  box: NormBox;
}
export interface WrittenLine {
  strokes: Stroke[];
  box: NormBox;
  /** words, ordered in the writing direction (right to left for RTL) */
  words: WordCluster[];
}

/** Written lines of a set of strokes: grouped by vertical overlap of their boxes (≥ 40 % of the smaller height). */
export function writtenLines(strokes: readonly Stroke[], ar: number, dir: 'rtl' | 'ltr' = 'rtl'): WrittenLine[] {
  const withBox = strokes.map((s) => ({ s, b: itemBBox(s, ar) })).sort((a, b) => a.b.y + a.b.h / 2 - (b.b.y + b.b.h / 2));
  const lines: Array<{ items: typeof withBox; y0: number; y1: number }> = [];
  for (const e of withBox) {
    const cy = e.b.y + e.b.h / 2;
    const line = lines.find((l) => {
      const ov = Math.min(l.y1, e.b.y + e.b.h) - Math.max(l.y0, e.b.y);
      return ov >= 0.4 * Math.min(l.y1 - l.y0, e.b.h) || (cy >= l.y0 && cy <= l.y1);
    });
    if (line) {
      line.items.push(e);
      line.y0 = Math.min(line.y0, e.b.y);
      line.y1 = Math.max(line.y1, e.b.y + e.b.h);
    } else lines.push({ items: [e], y0: e.b.y, y1: e.b.y + e.b.h });
  }
  return lines
    .sort((a, b) => a.y0 - b.y0)
    .map((l) => {
      const box = l.items.reduce<NormBox | null>((acc, e) => (acc ? union(acc, e.b) : { ...e.b }), null)!;
      return { strokes: l.items.map((e) => e.s), box, words: wordsOf(l.items, box, dir, ar) };
    });
}

/**
 * Words of one line: strokes merged while the horizontal gap between them is under 35 % of the line's height (the gaps
 * between the letter groups of one Arabic word — after ا د ذ ر ز و — are narrower than the space between words).
 */
function wordsOf(items: ReadonlyArray<{ s: Stroke; b: NormBox }>, line: NormBox, dir: 'rtl' | 'ltr', ar: number): WordCluster[] {
  const sorted = [...items].sort((a, b) => a.b.x - b.b.x);
  const gapMax = line.h * ar * 0.35; // the line's height in page-width units
  const words: Array<{ ids: string[]; box: NormBox }> = [];
  for (const e of sorted) {
    const last = words[words.length - 1];
    if (last && e.b.x - (last.box.x + last.box.w) <= gapMax) {
      last.ids.push(e.s.id);
      last.box = union(last.box, e.b);
    } else words.push({ ids: [e.s.id], box: { ...e.b } });
  }
  return dir === 'rtl' ? words.reverse() : words;
}

function union(a: NormBox, b: NormBox): NormBox {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

/** The slant of a line of writing (radians, iso space): least-squares fit of all its points (y on x). */
export function baselineAngle(strokes: readonly Stroke[], ar: number): number {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const s of strokes) {
    for (const p of s.data.points) {
      const x = p[0];
      const y = p[1] * ar;
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
  }
  const den = n * sxx - sx * sx;
  if (n < 2 || Math.abs(den) < 1e-12) return 0;
  return Math.atan((n * sxy - sx * sy) / den);
}

/** Lines tilted less than this are left alone (already level), more than MAX are a drawing, not a line of text. */
const MIN_TILT = (0.6 * Math.PI) / 180;
const MAX_TILT = (25 * Math.PI) / 180;

/**
 * «استقم»: each line of the selected strokes turned about its centre to a level baseline (rotation only). Returns the
 * changes (one undo step for the caller) and how many lines were straightened.
 */
export function straightenPlan(items: readonly InkItem[], opts: { targetKey: string; ar: number; now: number; movable: (it: InkItem) => boolean }): { changes: ItemChange[]; lines: number } {
  const { ar, now, targetKey } = opts;
  const strokes = items.filter((it): it is Stroke => isInkStroke(it) && opts.movable(it) && it.data.style.tool !== 'highlighter');
  const changes: ItemChange[] = [];
  let lines = 0;
  for (const line of writtenLines(strokes, ar)) {
    const angle = line.strokes.length === 1 && line.strokes[0]!.data.points.length < 4 ? 0 : baselineAngle(line.strokes, ar);
    if (Math.abs(angle) < MIN_TILT || Math.abs(angle) > MAX_TILT) continue;
    const c: Vec = [line.box.x + line.box.w / 2, (line.box.y + line.box.h / 2) * ar];
    const m = rotateAbout(-angle, c[0], c[1]);
    for (const s of line.strokes) changes.push({ id: s.id, targetKey, before: s, after: transformItem(s, m, ar, now) });
    lines++;
  }
  return { changes, lines };
}

// ─── word reflow (phase 2: only with a handwriting recognition) ─────────────────────────────────
export interface RecognizedLineLike {
  words: Array<{ text: string }>;
}

export type ReflowPlan = { ok: true; changes: ItemChange[]; lines: number; words: number } | { ok: false; reason_ar: string };

/**
 * Re-wraps the selection's words into lines of `width` (normalized) starting at the selection's start corner (top
 * right for RTL). Needs the recognition of the same strokes: the number of words it read must equal the words found in
 * the writing, else nothing moves (the reason says why).
 */
export function reflowPlan(items: readonly InkItem[], recognized: readonly RecognizedLineLike[], opts: { width: number; dir: 'rtl' | 'ltr'; targetKey: string; ar: number; now: number; movable: (it: InkItem) => boolean }): ReflowPlan {
  const { ar, now, dir, targetKey } = opts;
  const strokes = items.filter((it): it is Stroke => isInkStroke(it) && opts.movable(it) && it.data.style.tool !== 'highlighter');
  if (strokes.length === 0) return { ok: false, reason_ar: 'لا توجد كتابة بالقلم في التحديد لإعادة ترتيبها.' };
  const lines = writtenLines(strokes, ar, dir);
  const words = lines.flatMap((l) => l.words);
  const readCount = recognized.reduce((n, l) => n + l.words.filter((w) => w.text.trim() !== '').length, 0);
  if (readCount === 0) return { ok: false, reason_ar: 'لم تُقرأ كلمات من هذه الكتابة؛ لم يُعَد ترتيب شيء.' };
  if (readCount !== words.length) {
    return { ok: false, reason_ar: `قرأ التعرف ${readCount} كلمة، وميّز التطبيق ${words.length} كلمة من الفراغات في الخط؛ لا يُعاد الترتيب حين يختلفان (قد تُقسم كلمة أو تُدمج كلمتان). لم يتغير شيء.` };
  }
  const area = bboxOf(strokes.flatMap((s) => s.data.points.map((p) => [p[0], p[1]] as Vec)));
  const lineH = Math.max(...lines.map((l) => l.box.h));
  const gaps: number[] = [];
  for (const l of lines) for (let i = 1; i < l.words.length; i++) gaps.push(Math.abs((dir === 'rtl' ? l.words[i - 1]!.box.x - (l.words[i]!.box.x + l.words[i]!.box.w) : l.words[i]!.box.x - (l.words[i - 1]!.box.x + l.words[i - 1]!.box.w))));
  const gap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! : lineH * 0.8;
  const width = Math.max(opts.width, Math.max(...words.map((w) => w.box.w)));
  const start = dir === 'rtl' ? area.x + area.w : area.x;
  const changes: ItemChange[] = [];
  const byId = new Map(strokes.map((s) => [s.id, s]));
  let cursor = 0; // distance used on the current line
  let row = 0;
  let outLines = 1;
  for (const w of words) {
    if (cursor > 0 && cursor + w.box.w > width + 1e-9) {
      row++;
      outLines++;
      cursor = 0;
    }
    const targetX = dir === 'rtl' ? start - cursor - w.box.w : start + cursor;
    const targetY = area.y + row * lineH * 1.35;
    const dx = targetX - w.box.x;
    const dy = (targetY - w.box.y) * ar;
    cursor += w.box.w + gap;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) continue;
    for (const id of w.ids) {
      const s = byId.get(id)!;
      changes.push({ id, targetKey, before: s, after: transformItem(s, [1, 0, 0, 1, dx, dy], ar, now) });
    }
  }
  return { ok: true, changes, lines: outLines, words: words.length };
}
