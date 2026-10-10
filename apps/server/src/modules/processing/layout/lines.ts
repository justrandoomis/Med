// Items → rows → segments, and bidi-aware LOGICAL text of a segment.
//
// PDF text layers (and OCR engines) give runs in VISUAL positions. Each run's own text is already in
// logical order (pdfjs applies the bidi algorithm per run), but the ORDER of runs on a mixed line is
// visual. For an RTL line the runs are read right → left, except that consecutive LTR runs (an English
// term, "H. pylori", a unit) form an island read left → right. Neutral runs (punctuation, digits,
// spaces) join an island only when they sit between two LTR runs — at the edge they follow the line
// direction (so the final «.» of «… نقطة McBurney.» stays at the end). LTR lines mirror the rule.
import { cleanRun, countStrong } from '../text';
import type { Box, Rule, Segment, TextItem } from './types';
import { median, overlap1d } from './types';

export function itemClass(text: string): 'R' | 'L' | 'N' {
  const { r, l } = countStrong(text);
  if (r === 0 && l === 0) return 'N';
  return r >= l ? 'R' : 'L';
}

/** Group items into rows (same text line) by vertical overlap. */
export function groupRows(items: TextItem[]): TextItem[][] {
  // OCR words carry their recognized line: trust the engine's line segmentation (skewed scans, dashes)
  const byLine = new Map<number, TextItem[]>();
  const loose: TextItem[] = [];
  for (const it of items) {
    if (!it.text.trim()) continue;
    if (typeof it.line === 'number') byLine.set(it.line, [...(byLine.get(it.line) ?? []), it]);
    else loose.push(it);
  }
  const lineRows = [...byLine.values()].map((r) => r.sort((a, b) => a.x0 - b.x0));
  return [...lineRows, ...groupRowsGeometric(attachScripts(loose))];
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '–': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ',
};
const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋', '–': '₋', '=': '₌', '(': '₍', ')': '₎',
};

/**
 * Superscripts and subscripts typed with a font effect (Word / LibreOffice «10<sup>9</sup>», «PaCO<sub>2</sub>»,
 * «Ca<sup>2+</sup>») are separate, smaller, raised / lowered text runs in the PDF. Read as plain runs they changed the
 * VALUE («11.5 × 10⁹/L» became «11.5 × 109/L») or fell off their line («PaCO 52 mmHg» + a stray «2» paragraph)
 * (G4 / AC-11). A short run that is clearly smaller than the run it touches and sits on a raised / lowered baseline
 * is written with the Unicode super/subscript characters when every character has one, and joins its host's line.
 */
export function attachScripts(items: TextItem[]): TextItem[] {
  if (items.length < 2) return items;
  const maxSize = Math.max(...items.map((i) => (i.size > 0 ? i.size : 0)));
  // a host overlaps the run vertically: only the items whose top lies within one tall line above it are scanned
  // (dense pages stay linear-ish), found by binary search on the items sorted by top
  const byTop = items.filter((h) => h.size > 0 && h.text.trim().length > 0).sort((a, b) => a.top - b.top);
  const maxH = Math.max(0, ...byTop.map((h) => h.bottom - h.top));
  const firstAtOrAfter = (y: number) => {
    let lo = 0;
    let hi = byTop.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byTop[mid]!.top < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const out = items.slice();
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const t = it.text.trim();
    if (!t || [...t].length > 4 || !(it.size > 0) || it.size > 0.85 * maxSize) continue;
    let host: TextItem | null = null;
    let hostGap = Infinity;
    for (let k = firstAtOrAfter(it.top - maxH); k < byTop.length && byTop[k]!.top < it.bottom; k++) {
      const h = byTop[k]!;
      if (h === it || it.size > 0.85 * h.size) continue;
      const gap = Math.min(Math.abs(it.x0 - h.x1), Math.abs(h.x0 - it.x1));
      if (gap > 0.3 * h.size || overlap1d(it.top, it.bottom, h.top, h.bottom) <= 0) continue;
      if (gap < hostGap) {
        host = h;
        hostGap = gap;
      }
    }
    if (!host) continue;
    // raised: it ends well above the host's bottom; lowered: it starts well below the host's top. Producers differ
    // (reportlab moves the baseline by ~40 %, LibreOffice keeps a superscript's top / a subscript's bottom on the
    // host's line), both pass; a smaller run on the SAME baseline (small caps, a smaller word) passes neither.
    const raised = host.bottom - it.bottom > 0.3 * host.size;
    const lowered = !raised && it.top - host.top > 0.4 * host.size && it.bottom >= host.bottom - 0.1 * host.size;
    if (!raised && !lowered) continue;
    const map = raised ? SUPERSCRIPT : SUBSCRIPT;
    const chars = [...t];
    const text = chars.every((c) => map[c] !== undefined) ? chars.map((c) => map[c]).join('') : t;
    out[i] = { ...it, text, top: host.top, bottom: host.bottom, size: host.size };
  }
  return out;
}

function groupRowsGeometric(items: TextItem[]): TextItem[][] {
  const sorted = items
    .filter((it) => it.text.trim().length > 0)
    .sort((a, b) => (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2 || a.x0 - b.x0);
  const rows: Array<{ top: number; bottom: number; items: TextItem[] }> = [];
  for (const it of sorted) {
    const h = Math.max(0.1, it.bottom - it.top);
    const icy = (it.top + it.bottom) / 2;
    let best: (typeof rows)[number] | null = null;
    let bestScore = 0;
    // only the last few rows can match (sorted by center)
    for (let k = rows.length - 1; k >= 0 && k >= rows.length - 4; k--) {
      const row = rows[k]!;
      const rh = Math.max(0.1, row.bottom - row.top);
      const ov = overlap1d(it.top, it.bottom, row.top, row.bottom);
      const rcy = (row.top + row.bottom) / 2;
      if (ov >= 0.5 * Math.min(h, rh) && Math.abs(icy - rcy) <= 0.6 * Math.min(h, rh) + 0.5) {
        const score = ov / Math.min(h, rh);
        if (score > bestScore) {
          bestScore = score;
          best = row;
        }
      }
    }
    if (best) {
      // the row band is NOT grown: a tall run (drop cap, superscript) must not swallow the next line
      best.items.push(it);
    } else {
      rows.push({ top: it.top, bottom: it.bottom, items: [it] });
    }
  }
  return rows.map((r) => r.items.sort((a, b) => a.x0 - b.x0));
}

/**
 * Split a row into segments at large horizontal gaps or where a vertical ruling line separates items
 * (table cells, column gutters).
 */
export function splitRow(rowItems: TextItem[], vRules: Rule[], gapFactor = 1.6): TextItem[][] {
  if (rowItems.length === 0) return [];
  const size = median(rowItems.map((i) => i.size)) || 10;
  const top = Math.min(...rowItems.map((i) => i.top));
  const bottom = Math.max(...rowItems.map((i) => i.bottom));
  const out: TextItem[][] = [[rowItems[0]!]];
  for (let i = 1; i < rowItems.length; i++) {
    const prev = out[out.length - 1]!;
    const a = prev[prev.length - 1]!;
    const b = rowItems[i]!;
    const gap = b.x0 - Math.max(...prev.map((p) => p.x1));
    const ruleBetween = vRules.some(
      (r) => r.x0 > Math.max(...prev.map((p) => p.x1)) - 1 && r.x0 < b.x0 + 1 && overlap1d(r.top, r.bottom, top, bottom) > 0.5 * (bottom - top),
    );
    const sizeJump = Math.abs(a.size - b.size) > 0.45 * Math.max(a.size, b.size);
    if (gap > gapFactor * size || ruleBetween || (sizeJump && gap > 0.5 * size)) out.push([b]);
    else prev.push(b);
  }
  return out;
}

let segmentSeq = 0;

export function makeSegment(items: TextItem[], rowId: number): Segment {
  const x0 = Math.min(...items.map((i) => i.x0));
  const x1 = Math.max(...items.map((i) => i.x1));
  const top = Math.min(...items.map((i) => i.top));
  const bottom = Math.max(...items.map((i) => i.bottom));
  let chars = 0;
  let boldChars = 0;
  let r = 0;
  let l = 0;
  const confs: number[] = [];
  for (const it of items) {
    const n = it.text.replace(/\s+/g, '').length;
    chars += n;
    if (it.bold) boldChars += n;
    const s = countStrong(it.text);
    r += s.r;
    l += s.l;
    if (typeof it.conf === 'number') confs.push(it.conf);
  }
  // font size: weighted by characters (a single large drop-cap must not dominate)
  const sizes = items.flatMap((it) => Array(Math.max(1, Math.min(40, it.text.length))).fill(it.size) as number[]);
  const seg: Segment = {
    id: ++segmentSeq,
    rowId,
    items,
    x0,
    x1,
    top,
    bottom,
    size: median(sizes),
    bold: chars > 0 && boldChars / chars >= 0.6,
    chars,
    r,
    l,
  };
  if (confs.length) {
    seg.conf = confs.reduce((s, c) => s + c, 0) / confs.length;
    seg.minConf = Math.min(...confs);
  }
  return seg;
}

export function buildSegments(items: TextItem[], vRules: Rule[] = []): Segment[] {
  const rows = groupRows(items);
  const segs: Segment[] = [];
  rows.forEach((row, rowId) => {
    for (const part of splitRow(row, vRules)) segs.push(makeSegment(part, rowId));
  });
  return segs;
}

/**
 * Logical text of a set of runs laid out on one visual line, for a given paragraph direction.
 * Runs are joined with a space only when there is a visible gap between them.
 */
export function logicalLineText(itemsVisual: TextItem[], dir: 'rtl' | 'ltr'): string {
  const items = itemsVisual.filter((i) => i.text.trim().length > 0);
  if (items.length === 0) return '';
  const cls = items.map((i) => itemClass(i.text));
  const islandClass = dir === 'rtl' ? 'L' : 'R';
  const opposite = dir === 'rtl' ? 'R' : 'L';
  type Unit = { items: TextItem[]; key: number };
  const units: Unit[] = [];
  let i = 0;
  while (i < items.length) {
    if (cls[i] === islandClass) {
      let last = i;
      let j = i;
      while (j + 1 < items.length && cls[j + 1] !== opposite) {
        j++;
        if (cls[j] === islandClass) last = j;
      }
      const island = items.slice(i, last + 1);
      // island internal order: LTR islands ascending x (already), RTL islands descending x
      units.push({ items: dir === 'rtl' ? island : [...island].reverse(), key: (island[0]!.x0 + island[island.length - 1]!.x1) / 2 });
      i = last + 1;
    } else {
      units.push({ items: [items[i]!], key: (items[i]!.x0 + items[i]!.x1) / 2 });
      i++;
    }
  }
  units.sort((a, b) => (dir === 'rtl' ? b.key - a.key : a.key - b.key));
  const ordered = units.flatMap((u) => u.items);
  let out = '';
  let prev: TextItem | null = null;
  for (const it of ordered) {
    const t = cleanRun(it.text);
    if (prev) {
      const gap = Math.max(it.x0 - prev.x1, prev.x0 - it.x1);
      const size = Math.min(prev.size, it.size) || 10;
      const needsSpace = gap > 0.18 * size && !/\s$/.test(out) && !/^\s/.test(t);
      if (needsSpace) out += ' ';
    }
    out += t;
    prev = it;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Paragraph direction from strong characters plus ALIGNMENT for mixed lines: a mixed line flush with
 * the left margin (and not the right) is an LTR paragraph with an embedded Arabic run; flush right
 * (and not left) is an RTL paragraph with an embedded English term.
 */
export function decideDir(segs: Segment[], marginLeft: number, marginRight: number, tol: number): 'rtl' | 'ltr' {
  let r = 0;
  let l = 0;
  let alignRtl = 0;
  let alignLtr = 0;
  for (const s of segs) {
    r += s.r;
    l += s.l;
    if (s.r > 0 && s.l > 0) {
      const leftFlush = Math.abs(s.x0 - marginLeft) <= tol;
      const rightFlush = Math.abs(marginRight - s.x1) <= tol;
      if (leftFlush && !rightFlush) alignLtr += s.chars;
      else if (rightFlush && !leftFlush) alignRtl += s.chars;
    }
  }
  if (r === 0) return 'ltr'; // includes neutral-only text (numbers, symbols)
  if (l === 0) return 'rtl';
  if (alignRtl !== alignLtr) return alignRtl > alignLtr ? 'rtl' : 'ltr';
  return r >= l ? 'rtl' : 'ltr';
}

/** Join the lines of a block (top → bottom). Hyphenated line ends keep the hyphen, without a space. */
export function joinLines(lines: string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) out = line;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(line)) out += line;
    else out += ' ' + line;
  }
  return out;
}

export function segmentBox(s: Segment): Box {
  return { x0: s.x0, top: s.top, x1: s.x1, bottom: s.bottom };
}
