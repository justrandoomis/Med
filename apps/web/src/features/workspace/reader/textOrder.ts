// Logical reading order for the pdf.js text layer (§21, AC-20).
//
// pdf.js returns a page's text items in CONTENT-STREAM order and the TextLayer appends one span per item in that order,
// so the DOM order of the selectable text is whatever order the PDF producer drew the pieces in. For a line that mixes
// Arabic and English that order is often neither logical nor visual: the Golden Set lecture draws «حول … عند نقطة»,
// then «يبدأ الألم عاد», then «McBurney», then «.». Selecting the whole line from its start to its end then copies
// «يبدأ األلم عادMcBurney» — the middle of the sentence is lost (a DOM range between the first and the last span) —
// and the in-document search never finds «نقطة McBurney».
//
// `logicalTextContent` reorders the items of such a line into logical order (the same rule the server's layout uses,
// processing/layout/lines.ts): items are ordered by their visual position in the line's base direction, and a run of
// opposite-direction items (an English term inside Arabic, an Arabic phrase inside English) is read in its own
// direction. Where two items sit apart with no space character between them, a space item is placed in the gap
// (pdf.js only inserts spaces between items it emitted one after the other). Nothing else changes: item strings are
// never rewritten, positions are untouched (spans are absolutely positioned), lines that are already in a valid order
// and lines without right-to-left text keep their exact items. The reader uses the result for BOTH the text layer
// and the in-document search text, so search offsets and DOM text nodes keep agreeing.
import { detectDir } from '@medlevo/shared';

/** The parts of a pdf.js TextItem this module reads (structural, so tests can build items by hand). */
export interface PdfTextItemLike {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

export interface PdfTextContentLike<I = unknown> {
  items: I[];
  styles: Record<string, unknown>;
  lang?: string | null;
}

const RTL_STRONG = /[֐-׿؈؋؍؛-ي٭-ٯٱ-ەۥۦۮۯۺ-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻾]/;
// Latin / Greek letters (× and ÷ sit in the Latin-1 block but are neutral symbols)
const LTR_STRONG = /[A-Za-zÀ-ÖØ-öø-ɏͰ-Ͽµ]/;
const DIGIT = /[0-9²³¹⁰-⁹₀-₉]/;

/** R: right-to-left letters · L: Latin letters · D: numbers (read left to right, never decide a line's direction) · N */
type Cls = 'R' | 'L' | 'D' | 'N';

function isTextItem(x: unknown): x is PdfTextItemLike {
  return !!x && typeof (x as PdfTextItemLike).str === 'string' && Array.isArray((x as PdfTextItemLike).transform);
}

/** Upright, unrotated, unmirrored text (the only kind this module reorders). */
function upright(it: PdfTextItemLike): boolean {
  const [a, b, c, d] = it.transform as [number, number, number, number];
  return a > 0 && d > 0 && Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6;
}

function cls(it: PdfTextItemLike): Cls {
  const r = RTL_STRONG.test(it.str);
  const l = LTR_STRONG.test(it.str);
  if (r && l) return detectDir(it.str) === 'rtl' ? 'R' : 'L';
  if (r) return 'R';
  if (l) return 'L';
  if (DIGIT.test(it.str)) return 'D';
  return 'N';
}
/** reads left to right inside a right-to-left line */
const ltrish = (c: Cls) => c === 'L' || c === 'D';

const left = (it: PdfTextItemLike) => it.transform[4]!;
const right = (it: PdfTextItemLike) => it.transform[4]! + Math.max(0, it.width);
const baseline = (it: PdfTextItemLike) => it.transform[5]!;
const size = (it: PdfTextItemLike) => Math.max(it.height, Math.abs(it.transform[3]!), 1);

function sameLine(a: PdfTextItemLike, b: PdfTextItemLike): boolean {
  return Math.abs(baseline(a) - baseline(b)) <= 0.35 * Math.max(size(a), size(b));
}

/**
 * Logical order of one line's items for a base direction: visual order in that direction (right edge descending for
 * RTL, left edge ascending for LTR), then every run of opposite-direction items — neutrals inside the run included —
 * read in its own direction. A left-to-right run inside a right-to-left line that the producer emitted as one
 * contiguous stretch keeps that emitted order: Latin text and numbers are emitted in reading order, while their pieces
 * may be PLACED right to left (a Word → LibreOffice export places «11.5», «×», «10⁹», «/», «L» from the right).
 * Arabic pieces carry no such guarantee (producers emit them left to right), so they always follow their positions.
 */
function orderFor(items: PdfTextItemLike[], base: 'rtl' | 'ltr', emitted: ReadonlyMap<PdfTextItemLike, number>): Array<{ item: PdfTextItemLike; island: number }> {
  const sorted = [...items].sort((a, b) => (base === 'rtl' ? right(b) - right(a) || left(b) - left(a) : left(a) - left(b) || right(a) - right(b)));
  const isOpposite = (c: Cls) => (base === 'rtl' ? ltrish(c) : c === 'R');
  const isBase = (c: Cls) => (base === 'rtl' ? c === 'R' : ltrish(c));
  const out: Array<{ item: PdfTextItemLike; island: number }> = [];
  let i = 0;
  let island = 0;
  while (i < sorted.length) {
    if (!isOpposite(cls(sorted[i]!))) {
      out.push({ item: sorted[i]!, island: -1 });
      i++;
      continue;
    }
    // island: from this opposite item to the last opposite item before a base-direction item
    let j = i;
    let last = i;
    while (j < sorted.length && !isBase(cls(sorted[j]!))) {
      if (isOpposite(cls(sorted[j]!))) last = j;
      j++;
    }
    island++;
    let run = sorted.slice(i, last + 1).reverse();
    if (base === 'rtl') {
      const at = run.map((it) => emitted.get(it)!).sort((a, b) => a - b);
      if (at[at.length - 1]! - at[0]! === at.length - 1) run = [...run].sort((a, b) => emitted.get(a)! - emitted.get(b)!);
    }
    for (const it of run) out.push({ item: it, island });
    i = last + 1;
  }
  return out;
}

function sameOrder(a: readonly PdfTextItemLike[], b: ReadonlyArray<{ item: PdfTextItemLike }>): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]!.item);
}

function bbox(items: PdfTextItemLike[]): { l: number; r: number } {
  return { l: Math.min(...items.map(left)), r: Math.max(...items.map(right)) };
}

/** Horizontal distance between two boxes (negative when they overlap). */
function gapBetween(a: { l: number; r: number }, b: { l: number; r: number }): number {
  return Math.max(a.l - b.r, b.l - a.r);
}

const endsWithSpace = (s: string) => /\s$/.test(s);
const startsWithSpace = (s: string) => /^\s/.test(s);

/** Reorders one line; returns null when the line keeps its original items. */
function reorderLine(line: PdfTextItemLike[]): PdfTextItemLike[] | null {
  // letters decide a line's direction; numbers never do (a question number or a value can end an Arabic line)
  const strong = line.filter((it) => cls(it) === 'R' || cls(it) === 'L');
  if (line.filter((it) => cls(it) !== 'N').length < 2 || !strong.some((it) => cls(it) === 'R')) return null;
  const emitted = new Map(line.map((it, k) => [it, k] as const));
  const rtl = orderFor(line, 'rtl', emitted);
  const ltr = orderFor(line, 'ltr', emitted);
  // base direction: both visual ends agree → that direction; otherwise an order the producer already wrote in a valid
  // reading is kept, else the script majority decides (the server falls back to the same majority rule)
  const byX = [...strong].sort((a, b) => left(a) - left(b));
  const leftEnd = cls(byX[0]!);
  const rightEnd = cls(byX[byX.length - 1]!);
  let base: 'rtl' | 'ltr';
  if (leftEnd === 'R' && rightEnd === 'R') base = 'rtl';
  else if (leftEnd === 'L' && rightEnd === 'L') base = 'ltr';
  else {
    if (sameOrder(line, rtl) || sameOrder(line, ltr)) return null;
    base = detectDir(line.map((it) => it.str).join(' '));
  }
  const ordered = base === 'rtl' ? rtl : ltr;
  if (sameOrder(line, ordered)) return null;

  // spaces where the producer left a visual gap but no space character (only between items that were apart)
  const out: PdfTextItemLike[] = [];
  const islandBox = new Map<number, { l: number; r: number }>();
  for (const o of ordered) if (o.island >= 0) islandBox.set(o.island, bbox(ordered.filter((x) => x.island === o.island).map((x) => x.item)));
  const boxOf = (o: { item: PdfTextItemLike; island: number }, other: { island: number }) =>
    o.island >= 0 && o.island !== other.island ? islandBox.get(o.island)! : { l: left(o.item), r: right(o.item) };
  for (let k = 0; k < ordered.length; k++) {
    const cur = ordered[k]!;
    const prev = k > 0 ? ordered[k - 1]! : null;
    if (prev && prev.item.str && cur.item.str && !endsWithSpace(prev.item.str) && !startsWithSpace(cur.item.str)) {
      const a = boxOf(prev, cur);
      const b = boxOf(cur, prev);
      const gap = gapBetween(a, b);
      if (gap > 0.2 * Math.min(size(prev.item), size(cur.item))) {
        const ref = prev.item;
        const at = a.l >= b.r ? b.r : a.r; // the gap starts at the left box's right edge
        out.push({ str: ' ', dir: 'ltr', transform: [ref.transform[0]!, 0, 0, ref.transform[3]!, at, baseline(ref)], width: gap, height: ref.height, fontName: ref.fontName, hasEOL: false });
      }
    }
    out.push(cur.item);
  }
  return out;
}

/**
 * A copy of `content` whose text items are in logical reading order (see the file comment). Non-text items (marked
 * content) and rotated text are never moved. The original objects are not mutated.
 */
export function logicalTextContent<C extends PdfTextContentLike>(content: C): C {
  const items = content.items as unknown[];
  const out: unknown[] = [];
  let line: PdfTextItemLike[] = [];
  let changed = false;
  const flush = () => {
    if (line.length > 1) {
      const re = reorderLine(line);
      if (re) {
        changed = true;
        const hadEOL = line[line.length - 1]!.hasEOL;
        const copy = re.map((it) => ({ ...it, hasEOL: false }));
        if (hadEOL) copy[copy.length - 1]!.hasEOL = true;
        out.push(...copy);
        line = [];
        return;
      }
    }
    out.push(...line);
    line = [];
  };
  for (const it of items) {
    if (!isTextItem(it) || !upright(it)) {
      flush();
      out.push(it);
      continue;
    }
    if (line.length && !sameLine(line[0]!, it)) flush();
    line.push(it);
    if (it.hasEOL) flush();
  }
  flush();
  return changed ? { ...content, items: out } : content;
}
