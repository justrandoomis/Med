// Page layout analysis: header/footer bands, tables, figures, blocks (paragraph / heading / list item /
// caption), reading order with column detection, caption linking. Works on digital text (pdfjs) and OCR
// words alike — both arrive as positioned TextItems in page units.
import { normalizeForSearch } from '@medlevo/shared';
import { signatureKey } from '../text';
import { buildSegments, decideDir, joinLines, logicalLineText, segmentBox } from './lines';
import { detectAlignedTables, detectRuledTables, serializeTable } from './tables';
import type { Box, DiagramLabel, FigureCandidate, LayoutRegion, PageGeom, Rule, Segment, TableOut, TextItem } from './types';
import { boxOf, cx, cy, height, median, overlap1d, width } from './types';

export const BAND_FRACTION = 0.08;

export interface HeaderFooterInfo {
  /** signatures (signatureKey) of band lines repeated across pages */
  repeated: Set<string>;
}

export interface PageAnalysisInput {
  geom: PageGeom;
  items: TextItem[];
  rules: Rule[];
  figures: FigureCandidate[];
  origin: 'digital' | 'ocr';
  /** document body font size (digital) — OCR pages pass their own median line height */
  bodySize: number;
  headerFooter: HeaderFooterInfo;
  /** classify header/footer bands (off for standalone images) */
  detectBands?: boolean;
}

export const OCR_REVIEW_WORD_CONF = 60;

const PAGE_NUMBER_RE =
  /^(?:page|p\.?|pg\.?|ص|صفحه|صفحة)?\s*[-–—]?\s*([0-9]{1,4})\s*[-–—]?\s*(?:(?:\/|of|من)\s*[0-9]{1,4})?$/i;

/** Page number printed in a header/footer line ("12", "- 12 -", "Page 12", "ص ١٢", "12 / 40"). */
export function parsePageNumber(text: string): number | null {
  const m = PAGE_NUMBER_RE.exec(normalizeForSearch(text).trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n < 10000 ? n : null;
}

export function inTopBand(b: Box, geom: PageGeom): boolean {
  return b.bottom <= geom.height * BAND_FRACTION + 1;
}
export function inBottomBand(b: Box, geom: PageGeom): boolean {
  return b.top >= geom.height * (1 - BAND_FRACTION) - 1;
}

export interface BandLine {
  text: string;
  where: 'top' | 'bottom';
  box: Box;
}

/** Text lines inside the top/bottom bands (used across pages for header/footer + page-number detection). */
export function bandLines(items: TextItem[], geom: PageGeom): BandLine[] {
  const segs = buildSegments(items);
  const out: BandLine[] = [];
  for (const s of segs) {
    const where = inTopBand(s, geom) ? 'top' : inBottomBand(s, geom) ? 'bottom' : null;
    if (!where) continue;
    const dir = s.r > s.l ? 'rtl' : 'ltr';
    out.push({ text: logicalLineText(s.items, dir), where, box: segmentBox(s) });
  }
  return out;
}

/** Repeated header/footer signatures: present on ≥ 2 pages and on ≥ 40 % of the pages that have text. */
export function repeatedBandSignatures(pages: BandLine[][]): Set<string> {
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const seen = new Set<string>();
    for (const l of lines) {
      const k = `${l.where}:${signatureKey(l.text)}`;
      if (k.length > 5 && !seen.has(k)) {
        seen.add(k);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  const pagesWithText = pages.filter((p) => p.length > 0).length;
  const out = new Set<string>();
  for (const [k, n] of counts) if (n >= 2 && n >= 0.4 * pagesWithText) out.add(k);
  return out;
}

/**
 * Printed page labels detected from header/footer numbers with a cross-page consistency check:
 * the number minus the file index must agree (same offset) on at least 2 pages and on the majority of
 * pages that show a number. Only pages where the number is actually printed get a label.
 */
export function detectPrintedLabels(pages: BandLine[][]): Map<number, string> {
  const candidates = new Map<number, number[]>();
  pages.forEach((lines, idx) => {
    const nums = lines.map((l) => parsePageNumber(l.text)).filter((n): n is number => n !== null);
    if (nums.length) candidates.set(idx, nums);
  });
  const offsetVotes = new Map<number, number>();
  for (const [idx, nums] of candidates) {
    for (const n of new Set(nums)) offsetVotes.set(n - idx, (offsetVotes.get(n - idx) ?? 0) + 1);
  }
  let bestOffset: number | null = null;
  let bestVotes = 0;
  for (const [off, v] of offsetVotes) {
    if (v > bestVotes) {
      bestVotes = v;
      bestOffset = off;
    }
  }
  const out = new Map<number, string>();
  if (bestOffset === null || bestVotes < 2 || bestVotes < candidates.size * 0.5) return out;
  for (const [idx, nums] of candidates) if (nums.includes(idx + bestOffset)) out.set(idx, String(idx + bestOffset));
  return out;
}

// ───────── captions & references ─────────
const FIGURE_CAPTION_RE = /^(?:figure|fig\.?|image|diagram|chart|plate|شكل|الشكل|صورة|الصورة|رسم|مخطط)\s*\(?\s*([0-9٠-٩]+(?:[.-][0-9٠-٩]+)?)\s*\)?\s*[:.\-–—)]?/i;
const TABLE_CAPTION_RE = /^(?:table|tab\.|جدول|الجدول)\s*\(?\s*([0-9٠-٩]+(?:[.-][0-9٠-٩]+)?)\s*\)?\s*[:.\-–—)]?/i;
const FIGURE_REF_RE = /(?:\bfigure|\bfig\.?|الشكل|شكل)\s*\(?\s*([0-9٠-٩]+(?:[.-][0-9٠-٩]+)?)/gi;

function asciiDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function captionInfo(text: string): { for: 'figure' | 'table'; number: string } | null {
  const t = text.trim();
  let m = FIGURE_CAPTION_RE.exec(t);
  if (m) return { for: 'figure', number: asciiDigits(m[1]!) };
  m = TABLE_CAPTION_RE.exec(t);
  if (m) return { for: 'table', number: asciiDigits(m[1]!) };
  return null;
}

export function figureReferences(text: string, ownCaptionNumber?: string | null): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(FIGURE_REF_RE)) {
    const n = asciiDigits(m[1]!);
    if (n !== ownCaptionNumber) out.add(n);
  }
  return [...out];
}

const BULLET_RE = /^\s*(?:[•▪◦●○■□◆◇‣⁃∙·*]|[-–—](?=\s))\s*/;
const NUMBERED_RE = /^\s*(?:\(?[0-9٠-٩]{1,2}[.)-]|\(?[a-zA-Z][.)]|\(?[أبجدهـوزحطي][.)-])\s+/;

export function isListStart(text: string): boolean {
  return BULLET_RE.test(text) || NUMBERED_RE.test(text);
}

// ───────── blocks ─────────
interface Block {
  segs: Segment[];
  box: Box;
  size: number;
  bold: boolean;
  list: boolean;
}

function canJoin(block: Block, s: Segment, lineText: string): boolean {
  const last = block.segs[block.segs.length - 1]!;
  const lineGap = cy(s) - cy(last);
  // scans: the OCR row height under-estimates leading → a slightly looser line-spacing limit
  const leading = s.conf !== undefined ? 1.8 : 1.55;
  if (lineGap <= 0.3 * s.size || lineGap > leading * Math.max(s.size, last.size)) return false;
  if (Math.abs(s.size - block.size) > 0.12 * Math.max(s.size, block.size)) return false;
  if (s.bold !== block.bold) return false;
  if (isListStart(lineText)) return false;
  const ov = overlap1d(s.x0, s.x1, block.box.x0, block.box.x1);
  return ov >= 0.3 * Math.min(width(s), width(block.box));
}

function buildBlocks(segs: Segment[], lineTextOf: (s: Segment) => string): Block[] {
  const sorted = [...segs].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const blocks: Block[] = [];
  for (const s of sorted) {
    const text = lineTextOf(s);
    let best: Block | null = null;
    let bestGap = Infinity;
    for (const b of blocks) {
      if (!canJoin(b, s, text)) continue;
      const gap = s.top - b.box.bottom;
      if (gap < bestGap) {
        bestGap = gap;
        best = b;
      }
    }
    if (best) {
      best.segs.push(s);
      best.box = boxOf([best.box, s]);
    } else {
      blocks.push({ segs: [s], box: segmentBox(s), size: s.size, bold: s.bold, list: isListStart(text) });
    }
  }
  return blocks;
}

// ───────── reading order (column-aware XY-cut) ─────────
export interface Orderable {
  box: Box;
}

function xGroups<T extends Orderable>(els: T[], minGap: number): T[][] {
  const sorted = [...els].sort((a, b) => a.box.x0 - b.box.x0);
  const groups: T[][] = [];
  let curEnd = -Infinity;
  for (const e of sorted) {
    if (groups.length === 0 || e.box.x0 - curEnd >= minGap) {
      groups.push([e]);
      curEnd = e.box.x1;
    } else {
      groups[groups.length - 1]!.push(e);
      curEnd = Math.max(curEnd, e.box.x1);
    }
  }
  return groups;
}

function yBands<T extends Orderable>(els: T[]): T[][] {
  const sorted = [...els].sort((a, b) => a.box.top - b.box.top);
  const bands: T[][] = [];
  let curEnd = -Infinity;
  for (const e of sorted) {
    if (bands.length === 0 || e.box.top >= curEnd - 0.5) {
      bands.push([e]);
      curEnd = e.box.bottom;
    } else {
      bands[bands.length - 1]!.push(e);
      curEnd = Math.max(curEnd, e.box.bottom);
    }
  }
  return bands;
}

/**
 * Order layout elements: a vertical gutter (columns side by side, overlapping vertically) splits first,
 * columns ordered by page direction; otherwise split at horizontal gaps next to full-width elements;
 * otherwise top-to-bottom.
 */
export function orderElements<T extends Orderable>(els: T[], dir: 'rtl' | 'ltr', minGutter: number, depth = 0): T[] {
  if (els.length <= 1 || depth > 24) return [...els];
  const node = boxOf(els.map((e) => e.box));
  const cols = xGroups(els, minGutter);
  if (cols.length > 1) {
    const extents = cols.map((c) => boxOf(c.map((e) => e.box)));
    let sideBySide = true;
    for (let k = 1; k < extents.length; k++) {
      const a = extents[k - 1]!;
      const b = extents[k]!;
      if (overlap1d(a.top, a.bottom, b.top, b.bottom) < 0.3 * Math.min(height(a), height(b))) sideBySide = false;
    }
    if (sideBySide) {
      const ordered = dir === 'rtl' ? [...cols].reverse() : cols;
      return ordered.flatMap((c) => orderElements(c, dir, minGutter, depth + 1));
    }
  }
  const bands = yBands(els);
  if (bands.length > 1) {
    const nodeW = width(node);
    const isWide = (band: T[]) => band.some((e) => width(e.box) >= 0.6 * nodeW);
    const groups: T[][] = [];
    let cur: T[] = [];
    for (const band of bands) {
      if (isWide(band)) {
        if (cur.length) groups.push(cur);
        groups.push(band);
        cur = [];
      } else cur.push(...band);
    }
    if (cur.length) groups.push(cur);
    if (groups.length > 1) return groups.flatMap((g) => orderElements(g, dir, minGutter, depth + 1));
    // no wide separator: bands top → bottom
    return bands.flatMap((b) =>
      b.length === els.length
        ? [...b].sort((p, q) => p.box.top - q.box.top || (dir === 'rtl' ? q.box.x1 - p.box.x1 : p.box.x0 - q.box.x0))
        : orderElements(b, dir, minGutter, depth + 1),
    );
  }
  return [...els].sort((p, q) => p.box.top - q.box.top || (dir === 'rtl' ? q.box.x1 - p.box.x1 : p.box.x0 - q.box.x0));
}

// ───────── page analysis ─────────
interface Element {
  box: Box;
  region: LayoutRegion;
  children?: LayoutRegion[];
}

function langOf(r: number, l: number): 'ar' | 'en' | 'mixed' | null {
  if (r === 0 && l === 0) return null;
  if (l === 0) return 'ar';
  if (r === 0) return 'en';
  return 'mixed';
}

export function analyzePage(input: PageAnalysisInput): LayoutRegion[] {
  const { geom, origin } = input;
  const vRules = input.rules.filter((r) => r.orientation === 'v');
  const segments = buildSegments(input.items, vRules);
  let keySeq = 0;
  const nextKey = (p: string) => `${p}${++keySeq}`;

  // text margins of the page body (for direction decisions)
  const bodySegs = segments.filter((s) => !inTopBand(s, geom) && !inBottomBand(s, geom));
  const marginL = bodySegs.length ? Math.min(...bodySegs.map((s) => s.x0)) : 0;
  const marginR = bodySegs.length ? Math.max(...bodySegs.map((s) => s.x1)) : geom.width;
  const alignTol = Math.max(3, geom.width * 0.02);
  const lineDir = (s: Segment) => decideDir([s], marginL, marginR, alignTol);
  const lineTextCache = new Map<number, string>();
  const lineTextOf = (s: Segment) => {
    let t = lineTextCache.get(s.id);
    if (t === undefined) {
      t = logicalLineText(s.items, lineDir(s));
      lineTextCache.set(s.id, t);
    }
    return t;
  };

  const used = new Set<number>();
  const headerRegions: LayoutRegion[] = [];
  const footerRegions: LayoutRegion[] = [];

  const segOrigin = (segs: Segment[]): 'digital' | 'ocr' => (segs.some((s) => s.conf !== undefined) ? 'ocr' : 'digital');
  const lowConf = (segs: Segment[]): string[] =>
    segs.flatMap((s) => s.items.filter((i) => typeof i.conf === 'number' && i.conf < OCR_REVIEW_WORD_CONF).map((i) => i.text));

  // 1) header / footer
  for (const s of segments) {
    if (input.detectBands === false) break;
    const top = inTopBand(s, geom);
    const bottom = !top && inBottomBand(s, geom);
    if (!top && !bottom) continue;
    const text = lineTextOf(s);
    const sig = `${top ? 'top' : 'bottom'}:${signatureKey(text)}`;
    const isPageNo = parsePageNumber(text) !== null;
    if (input.headerFooter.repeated.has(sig) || isPageNo) {
      used.add(s.id);
      const region: LayoutRegion = {
        key: nextKey('hf'),
        kind: top ? 'header' : 'footer',
        box: segmentBox(s),
        text,
        textOrigin: segOrigin([s]),
        lang: langOf(s.r, s.l),
        dir: lineDir(s),
      };
      if (s.conf !== undefined) {
        region.confidence = s.conf / 100;
        region.minWordConf = s.minConf ?? null;
      }
      (top ? headerRegions : footerRegions).push(region);
    }
  }

  // 2) figures (image areas); text painted inside a figure is its label set
  const elements: Element[] = [];
  const figureEls: Element[] = [];
  for (const f of input.figures) {
    const inside = segments.filter((s) => !used.has(s.id) && cx(s) >= f.x0 && cx(s) <= f.x1 && cy(s) >= f.top && cy(s) <= f.bottom);
    const labels: DiagramLabel[] = inside.map((s) => {
      const label: DiagramLabel = { text: lineTextOf(s), box: segmentBox(s), certainty: s.conf !== undefined ? 'uncertain' : 'read' };
      if (s.conf !== undefined) label.conf = s.conf;
      return label;
    });
    for (const s of inside) used.add(s.id);
    const region: LayoutRegion = {
      key: nextKey('fig'),
      kind: 'figure',
      box: { x0: f.x0, top: f.top, x1: f.x1, bottom: f.bottom },
      text: null,
      textOrigin: null,
      figure: { captionKey: null, labels, labelsOrigin: labels.length ? segOrigin(inside) : null },
    };
    const el = { box: region.box!, region };
    figureEls.push(el);
    elements.push(el);
  }

  // 3) tables (ruled, then aligned)
  const remaining = () => segments.filter((s) => !used.has(s.id));
  const ruled = detectRuledTables(input.rules, remaining(), { pageWidth: geom.width });
  for (const id of ruled.used) used.add(id);
  const aligned = detectAlignedTables(
    remaining().filter((s) => !inTopBand(s, geom) && !inBottomBand(s, geom)),
    { pageWidth: geom.width },
  );
  for (const id of aligned.used) used.add(id);
  const tableEls: Element[] = [];
  for (const t of [...ruled.tables, ...aligned.tables]) {
    const region = tableRegion(t, nextKey, origin === 'ocr' || t.cells.length === 0 ? origin : 'digital');
    const el: Element = { box: t.box, region: region.table, children: region.cells };
    tableEls.push(el);
    elements.push(el);
  }

  // 4) text blocks
  const textSegs = remaining();
  const blocks = buildBlocks(textSegs, lineTextOf);
  const bodySize = input.bodySize > 0 ? input.bodySize : median(textSegs.map((s) => s.size)) || 10;
  for (const b of blocks) {
    const dir = decideDir(b.segs, marginL, marginR, alignTol);
    const lines = [...b.segs].sort((p, q) => p.top - q.top || p.x0 - q.x0);
    // segments on the same row inside a block (rare) are merged into one line
    const rowsMap = new Map<number, Segment[]>();
    for (const s of lines) rowsMap.set(s.rowId, [...(rowsMap.get(s.rowId) ?? []), s]);
    const lineTexts = [...rowsMap.values()]
      .sort((p, q) => p[0]!.top - q[0]!.top)
      .map((row) => (row.length === 1 ? logicalLineText(row[0]!.items, dir) : logicalLineText(row.flatMap((s) => s.items).sort((p, q) => p.x0 - q.x0), dir)));
    const text = joinLines(lineTexts);
    if (!text) continue;
    const r = b.segs.reduce((n, s) => n + s.r, 0);
    const l = b.segs.reduce((n, s) => n + s.l, 0);
    const cap = captionInfo(text);
    const blockOrigin = segOrigin(b.segs);
    let kind: LayoutRegion['kind'] = 'paragraph';
    const headingFactor = blockOrigin === 'ocr' ? 1.3 : 1.15;
    const shortText = text.length <= 160 && lineTexts.length <= 3;
    if (cap) kind = 'caption';
    else if (b.list) kind = 'list_item';
    else if (shortText && b.size >= bodySize * headingFactor && (blockOrigin === 'digital' || (b.segs.every((s) => (s.conf ?? 0) >= 70) && text.length <= 100)))
      kind = 'heading'; // OCR noise (a circled option, a stamp) is never promoted to a heading
    else if (shortText && b.bold && blockOrigin === 'digital' && lineTexts.length <= 2 && text.length <= 100 && !/[.!?؟:،؛]$/.test(text) && b.size >= bodySize * 0.95)
      kind = 'heading';
    const region: LayoutRegion = {
      key: nextKey(kind === 'heading' ? 'h' : 'p'),
      kind,
      box: b.box,
      text,
      textOrigin: blockOrigin,
      dir,
      lang: langOf(r, l),
      fontSize: Math.round(b.size * 10) / 10,
    };
    if (cap) {
      region.captionFor = cap.for;
      region.captionNumber = cap.number;
    }
    if (kind !== 'caption') {
      const refs = figureReferences(text);
      if (refs.length) region.figureRefs = refs;
    }
    if (blockOrigin === 'ocr') {
      const weak = lowConf(b.segs);
      if (weak.length) region.lowConfWords = weak;
      const confs = b.segs.map((s) => s.conf).filter((c): c is number => typeof c === 'number');
      const mins = b.segs.map((s) => s.minConf).filter((c): c is number => typeof c === 'number');
      if (confs.length) region.confidence = confs.reduce((s, c) => s + c, 0) / confs.length / 100;
      if (mins.length) region.minWordConf = Math.min(...mins);
    }
    elements.push({ box: b.box, region });
  }

  // 5) caption linking on this page (figure captions below/above, table captions above/below)
  linkCaptions(figureEls, tableEls, elements, geom);

  // 6) reading order
  const textRegions = elements.map((e) => e.region).filter((r) => r.text);
  const rr = textRegions.reduce((n, r) => n + (r.lang === 'ar' ? 2 : r.lang === 'mixed' ? 1 : 0), 0);
  const ll = textRegions.reduce((n, r) => n + (r.lang === 'en' ? 2 : r.lang === 'mixed' ? 1 : 0), 0);
  const pageDir: 'rtl' | 'ltr' = rr > ll ? 'rtl' : 'ltr';
  const ordered = orderElements(elements, pageDir, Math.max(8, geom.width * 0.02));
  const out: LayoutRegion[] = [...headerRegions.sort((a, b) => a.box!.top - b.box!.top)];
  for (const el of ordered) {
    out.push(el.region);
    if (el.children) out.push(...el.children);
  }
  out.push(...footerRegions.sort((a, b) => a.box!.top - b.box!.top));
  return out;
}

function tableRegion(t: TableOut, nextKey: (p: string) => string, origin: 'digital' | 'ocr'): { table: LayoutRegion; cells: LayoutRegion[] } {
  const key = nextKey('tbl');
  const table: LayoutRegion = {
    key,
    kind: 'table',
    box: t.box,
    text: serializeTable(t),
    textOrigin: origin,
    table: t,
  };
  const cells: LayoutRegion[] = t.cells
    .filter((c) => c.text.trim())
    .map((c) => ({
      key: nextKey('cell'),
      kind: 'table_cell' as const,
      box: c.box,
      text: c.text,
      textOrigin: origin,
      parentKey: key,
      locator: { r: c.r, c: c.c, rowspan: c.rowspan, colspan: c.colspan, header: c.header },
    }));
  return { table, cells };
}

function linkCaptions(figures: Element[], tables: Element[], all: Element[], geom: PageGeom): void {
  const captions = all.filter((e) => e.region.kind === 'caption');
  const taken = new Set<string>();
  const maxDist = geom.height * 0.12;
  const link = (targets: Element[], kind: 'figure' | 'table', preferBelow: boolean) => {
    for (const t of targets) {
      let best: Element | null = null;
      let bestScore = Infinity;
      for (const c of captions) {
        if (taken.has(c.region.key) || c.region.captionFor !== kind) continue;
        if (overlap1d(c.box.x0, c.box.x1, t.box.x0, t.box.x1) <= 0) continue;
        const below = c.box.top - t.box.bottom;
        const above = t.box.top - c.box.bottom;
        const dist = below >= -4 ? below : above >= -4 ? above : Infinity;
        if (dist > maxDist) continue;
        const isBelow = below >= -4;
        const score = Math.max(0, dist) + (isBelow === preferBelow ? 0 : 6);
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (best) {
        taken.add(best.region.key);
        if (kind === 'figure' && t.region.figure) t.region.figure.captionKey = best.region.key;
        if (kind === 'table' && t.region.table) {
          t.region.table = { ...t.region.table };
          t.region.text = serializeTable(t.region.table, best.region.text);
          t.region.tableCaptionKey = best.region.key;
        }
      }
    }
  };
  link(figures, 'figure', true);
  link(tables, 'table', false);
}
