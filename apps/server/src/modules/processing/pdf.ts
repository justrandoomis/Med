// pdfjs-dist (legacy build, Node) extraction: page count, /PageLabels, unrotated page boxes, intrinsic
// rotation, positioned text runs with font size/weight, image placements and ruling lines from the
// operator list. Fonts are never installed (disableFontFace); pdfjs v6 compiles no font code with eval.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { normalizeRotation, normToView, viewToNorm, type QuarterTurn } from '@medlevo/shared';
import type { Box, Drawing, Rule, TextItem } from './layout/types';
import { contentRotationFromText, emptyDirections, quarter, type DirectionCounts } from './orientation';
import { cleanRun } from './text';

const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'));

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function pdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

export class PdfOpenError extends Error {
  constructor(
    readonly code: 'PDF_PASSWORD' | 'PDF_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'PdfOpenError';
  }
}

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(data), // pdfjs transfers the buffer — always hand it a copy
    disableFontFace: true,
    useSystemFonts: false,
    fontExtraProperties: true, // keeps the font name (…-Bold) for heading/table-header detection
    cMapUrl: join(PDFJS_DIR, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: join(PDFJS_DIR, 'standard_fonts') + '/',
    wasmUrl: join(PDFJS_DIR, 'wasm') + '/',
    maxImageSize: 80_000_000, // pixels; larger images are skipped by pdfjs instead of exhausting memory
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    return await task.promise;
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'PasswordException') throw new PdfOpenError('PDF_PASSWORD', 'password protected');
    throw new PdfOpenError('PDF_INVALID', (e as Error).message ?? 'invalid pdf');
  }
}

export interface PdfPageInfo {
  /** unrotated view box size in pt */
  width: number;
  height: number;
  /** view box [x0, y0, x1, y1] in PDF user space */
  view: [number, number, number, number];
  rotation: number;
}

export function pageInfo(page: PDFPageProxy): PdfPageInfo {
  const v = page.view as number[];
  const view: [number, number, number, number] = [v[0]!, v[1]!, v[2]!, v[3]!];
  return { width: view[2] - view[0], height: view[3] - view[1], view, rotation: ((page.rotate % 360) + 360) % 360 };
}

/**
 * The page as the reader SEES it (intrinsic /Rotate applied), in page units (pt), top-left origin.
 * Layout analysis (rows, columns, reading order, header/footer bands, tables) runs in this display space
 * — on a page with /Rotate 90 the text runs vertically in the unrotated user space — and every box is
 * mapped back to the UNROTATED page box before it is stored (ARCHITECTURE §3.8).
 */
export interface PageView {
  rotation: QuarterTurn;
  /** display size (width/height swapped for 90/270) */
  width: number;
  height: number;
  /** unrotated page box → display box */
  toView(b: Box): Box;
  /** display box → unrotated page box */
  toPage(b: Box): Box;
  rule(r: Rule): Rule;
}

export function pageView(info: { width: number; height: number; rotation: number }): PageView {
  const rotation = normalizeRotation(info.rotation);
  const W = info.width;
  const H = info.height;
  const swapped = rotation === 90 || rotation === 270;
  const t = { pageWidth: W, pageHeight: H, scale: 1, rotation };
  const order = (ax: number, ay: number, bx: number, by: number): Box => ({
    x0: Math.min(ax, bx),
    top: Math.min(ay, by),
    x1: Math.max(ax, bx),
    bottom: Math.max(ay, by),
  });
  if (rotation === 0 || W <= 0 || H <= 0) {
    return { rotation, width: W, height: H, toView: (b) => b, toPage: (b) => b, rule: (r) => r };
  }
  const toView = (b: Box): Box => {
    const [ax, ay] = normToView(b.x0 / W, b.top / H, t);
    const [bx, by] = normToView(b.x1 / W, b.bottom / H, t);
    return order(ax, ay, bx, by);
  };
  const toPage = (b: Box): Box => {
    const [ax, ay] = viewToNorm(b.x0, b.top, t);
    const [bx, by] = viewToNorm(b.x1, b.bottom, t);
    return order(ax * W, ay * H, bx * W, by * H);
  };
  return {
    rotation,
    width: swapped ? H : W,
    height: swapped ? W : H,
    toView,
    toPage,
    rule: (r) => ({ ...toView(r), orientation: swapped ? (r.orientation === 'h' ? 'v' : 'h') : r.orientation }),
  };
}

/** /PageLabels as printed labels, or null when the PDF has none. */
export async function pageLabels(doc: PDFDocumentProxy): Promise<string[] | null> {
  try {
    const labels = await doc.getPageLabels();
    if (!labels || labels.length === 0) return null;
    return labels.map((l) => (typeof l === 'string' ? l : String(l ?? '')));
  } catch {
    return null;
  }
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix, n: Matrix): Matrix {
  // m × n (apply m first, then n) — PDF "cm" semantics: CTM' = m × CTM
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export interface PdfPageContent {
  info: PdfPageInfo;
  items: TextItem[];
  rules: Rule[];
  /** image placements (top-left page units) */
  images: Box[];
  /** painted vector paths that are not ruling lines (drawings, shapes) */
  vectorPaths: number;
  /** H2 item 1: every painted subpath (top-left page units) — the material of drawn figures */
  drawings: Drawing[];
  /** H2 item 9: words repaired from lam-alef ligature glyphs on this page */
  ligatureRepairs: number;
  /** H2 item 9: Arabic words whose spelling the page's glyphs settled (see ligatureWordMap) */
  verifiedWords: string[];
  /** non-whitespace characters of digital text */
  chars: number;
  /** characters per text direction (baseline angle in the unrotated top-left page space) */
  directions: DirectionCounts;
  /**
   * H2 item 5: the clockwise turn of the DISPLAY space that makes the dominant text run left → right (0 for ordinary
   * pages; 270 for a /Rotate 90 page whose content is drawn upright, i.e. shown sideways). Layout runs in the space
   * rotated by `info.rotation + textRotation`.
   */
  textRotation: number;
}

const BOLD_RE = /bold|black|heavy|semibold|demibold|demi\b|-bd\b/i;

export async function extractPage(doc: PDFDocumentProxy, pageNumber: number): Promise<PdfPageContent> {
  const lib = await pdfjs();
  const OPS = lib.OPS;
  const page = await doc.getPage(pageNumber);
  try {
    const info = pageInfo(page);
    const [vx0, , , vy1] = info.view;
    const toTop = (x: number, y: number): [number, number] => [x - vx0, vy1 - y];

    // operator list first: it also loads the fonts (names → bold detection)
    const ol = await page.getOperatorList();
    const images: Box[] = [];
    const rules: Rule[] = [];
    const drawings: Drawing[] = [];
    const glyphRuns: GlyphRun[] = [];
    let vectorPaths = 0;
    let ctm: Matrix = IDENTITY;
    const stack: Matrix[] = [];
    const pushBoxFromUnitSquare = () => {
      const pts = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)].map(([x, y]) => toTop(x, y));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      images.push({ x0: Math.min(...xs), top: Math.min(...ys), x1: Math.max(...xs), bottom: Math.max(...ys) });
    };
    const paintOps = new Set<number>([
      OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
    ]);
    const strokeOps = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
    const fillOps = new Set<number>([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i]!;
      const args = ol.argsArray[i] as unknown[] | null;
      switch (fn) {
        case OPS.save:
          stack.push(ctm);
          break;
        case OPS.restore:
          ctm = stack.pop() ?? IDENTITY;
          break;
        case OPS.transform:
          if (args && args.length >= 6) ctm = mul(args.slice(0, 6) as Matrix, ctm);
          break;
        case OPS.paintFormXObjectBegin: {
          stack.push(ctm);
          const m = args?.[0] as number[] | null | undefined;
          if (Array.isArray(m) || ArrayBuffer.isView(m)) ctm = mul(Array.from(m as ArrayLike<number>).slice(0, 6) as Matrix, ctm);
          break;
        }
        case OPS.paintFormXObjectEnd:
          ctm = stack.pop() ?? IDENTITY;
          break;
        case OPS.paintImageXObject:
        case OPS.paintInlineImageXObject:
        case OPS.paintImageMaskXObject:
          pushBoxFromUnitSquare();
          break;
        case OPS.showText:
        case OPS.showSpacedText:
        case OPS.nextLineShowText:
        case OPS.nextLineSetSpacingShowText: {
          // the glyphs as drawn (visual order), each with the text its font maps it to (H2 item 9)
          const glyphs = [...(args ?? [])].reverse().find((a) => Array.isArray(a)) as GlyphRun | undefined;
          if (glyphs && glyphRuns.length < 20_000) glyphRuns.push(glyphs);
          break;
        }
        case OPS.constructPath: {
          const op = args?.[0] as number;
          if (!paintOps.has(op)) break;
          const dataWrap = args?.[1] as unknown[] | undefined;
          const data = dataWrap?.[0] as ArrayLike<number> | undefined;
          if (!data || typeof (data as { length?: number }).length !== 'number') break;
          const found = pathRules(data, ctm, toTop, strokeOps.has(op));
          if (found.length) rules.push(...found);
          else vectorPaths++;
          if (drawings.length < 5000) drawings.push(...pathShapes(data, ctm, toTop, { stroked: strokeOps.has(op), filled: fillOps.has(op) }));
          break;
        }
        default:
          break;
      }
    }

    const tc = await page.getTextContent({ includeMarkedContent: false });
    const styles = tc.styles as Record<string, { ascent?: number; descent?: number }>;
    const boldByFont = new Map<string, boolean>();
    const fontBold = (fontName: string): boolean => {
      let b = boldByFont.get(fontName);
      if (b === undefined) {
        b = false;
        try {
          if (page.commonObjs.has(fontName)) {
            const f = page.commonObjs.get(fontName) as { name?: string; bold?: boolean; black?: boolean } | null;
            b = Boolean(f?.bold || f?.black || (f?.name && BOLD_RE.test(f.name)));
          }
        } catch {
          b = false;
        }
        boldByFont.set(fontName, b);
      }
      return b;
    };
    const items: TextItem[] = [];
    let chars = 0;
    const directions = emptyDirections();
    // H2 item 9: pdf.js reverses an RTL run character by character, which turns a lam-alef ligature glyph («لا») into
    // «ال» («العلامة» → «العالمة»); words drawn with such a glyph are rebuilt from the glyphs
    const { map: ligatureWords, verified } = ligatureWordMap(glyphRuns);
    let ligatureRepairs = 0;
    for (const raw of tc.items) {
      if (!('str' in raw)) continue;
      let str = raw.str;
      if (!str || !str.trim()) continue;
      if (ligatureWords.size) {
        str = str.replace(/[\p{L}\p{M}]+/gu, (w) => {
          const fixed = ligatureWords.get(cleanRun(w));
          if (!fixed) return w;
          ligatureRepairs++;
          return fixed;
        });
      }
      const { dir, ...box } = textItemBox(raw, styles, toTop);
      items.push({ text: str, ...box, bold: fontBold(raw.fontName) });
      const n = str.replace(/\s+/g, '').length;
      chars += n;
      if (dir !== null) directions[dir] += n;
    }
    return {
      info,
      items,
      rules,
      images,
      vectorPaths,
      drawings,
      ligatureRepairs,
      verifiedWords: [...verified],
      chars,
      directions,
      textRotation: contentRotationFromText(directions, info.rotation),
    };
  } finally {
    page.cleanup();
  }
}

/** One showText run as pdf.js keeps it: glyphs in drawing (visual) order with their mapped text, and spacing numbers. */
export type GlyphRun = Array<number | { unicode?: string; isSpace?: boolean } | null>;

const ARABIC_RE = /\p{Script=Arabic}/u;
const LATIN_RE = /[A-Za-z]/;

/**
 * Words drawn with multi-letter glyphs in RTL runs (H2 item 9). pdf.js builds the text of an RTL run by reversing it
 * character by character, so a glyph mapped to TWO letters — the lam-alef ligature «لا» / «لأ» … — comes out reversed
 * («العلامة» → «العالمة»). Rebuilding the word glyph by glyph gives the real spelling. Returns:
 *  * `map`: reversed form → real word, for words that contain such a glyph — except when the reversed form is ALSO a
 *    real word drawn elsewhere in the same document page (ambiguous, left alone);
 *  * `verified`: every Arabic word whose spelling the glyphs settled (drawn letter by letter or rebuilt).
 */
export function ligatureWordMap(runs: GlyphRun[]): { map: Map<string, string>; verified: Set<string> } {
  const map = new Map<string, string>();
  const verified = new Set<string>();
  for (const run of runs) {
    const chunks: string[][] = [];
    let cur: string[] = [];
    const cut = () => {
      if (cur.length) chunks.push(cur);
      cur = [];
    };
    for (const g of run) {
      if (g === null) continue;
      if (typeof g === 'number') {
        if (g <= -100) cut(); // a word gap (thousandths of an em); kerning is much smaller
        continue;
      }
      const u = cleanRun(g.unicode ?? '');
      if (!u || g.isSpace || /^\s+$/.test(u)) {
        cut();
        continue;
      }
      cur.push(u);
    }
    cut();
    for (const ch of chunks) {
      if (!ch.some((u) => ARABIC_RE.test(u)) || ch.some((u) => LATIN_RE.test(u))) continue;
      const real = [...ch].reverse().join('');
      const reversed = [...ch.join('')].reverse().join('');
      for (const m of real.matchAll(/[\p{L}\p{M}]+/gu)) {
        const word = m[0];
        const shown = reversed.slice(m.index ?? 0, (m.index ?? 0) + word.length);
        verified.add(word);
        if (shown !== word) map.set(shown, word);
      }
    }
  }
  for (const shown of [...map.keys()]) if (verified.has(shown)) map.delete(shown); // a real word too: ambiguous
  return { map, verified };
}

/**
 * The subpaths of one painted path as drawing elements (H2 item 1): box, whether it is curved, closed, made only of
 * axis-aligned segments, filled / stroked. Curves count by their control points (a safe over-estimate of the box).
 */
function pathShapes(data: ArrayLike<number>, ctm: Matrix, toTop: (x: number, y: number) => [number, number], paint: { stroked: boolean; filled: boolean }): Drawing[] {
  const out: Drawing[] = [];
  let pts: Array<[number, number]> = [];
  let curved = false;
  let closed = false;
  const flush = () => {
    if (pts.length >= 2) {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const axisAligned = !curved && pts.every((p, k) => k === 0 || Math.abs(p[0] - pts[k - 1]![0]) < 0.5 || Math.abs(p[1] - pts[k - 1]![1]) < 0.5);
      out.push({ x0: Math.min(...xs), top: Math.min(...ys), x1: Math.max(...xs), bottom: Math.max(...ys), curved, closed: closed || paint.filled, axisAligned, stroked: paint.stroked, filled: paint.filled });
    }
    pts = [];
    curved = false;
    closed = false;
  };
  const at = (x: number, y: number) => toTop(...apply(ctm, x, y));
  for (let i = 0; i < data.length; ) {
    const op = data[i]!;
    if (op === 0) {
      flush();
      pts.push(at(data[i + 1]!, data[i + 2]!));
      i += 3;
    } else if (op === 1) {
      pts.push(at(data[i + 1]!, data[i + 2]!));
      i += 3;
    } else if (op === 2) {
      curved = true;
      pts.push(at(data[i + 1]!, data[i + 2]!), at(data[i + 3]!, data[i + 4]!), at(data[i + 5]!, data[i + 6]!));
      i += 7;
    } else if (op === 3) {
      curved = true;
      pts.push(at(data[i + 1]!, data[i + 2]!), at(data[i + 3]!, data[i + 4]!));
      i += 5;
    } else if (op === 4) {
      closed = true;
      if (pts.length) pts.push(pts[0]!);
      i += 1;
    } else {
      return out; // unknown encoding — do not guess
    }
  }
  flush();
  return out;
}

/** Ruling-line candidates from one painted path (axis-aligned strokes, thin filled rectangles). */
function pathRules(data: ArrayLike<number>, ctm: Matrix, toTop: (x: number, y: number) => [number, number], stroked: boolean): Rule[] {
  // DrawOPS: 0 moveTo(x,y) 1 lineTo(x,y) 2 curveTo(6) 3 quadraticCurveTo(4) 4 closePath
  const subpaths: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  let curved = false;
  for (let i = 0; i < data.length; ) {
    const op = data[i]!;
    if (op === 0) {
      if (cur.length) subpaths.push(cur);
      cur = [toTop(...apply(ctm, data[i + 1]!, data[i + 2]!))];
      i += 3;
    } else if (op === 1) {
      cur.push(toTop(...apply(ctm, data[i + 1]!, data[i + 2]!)));
      i += 3;
    } else if (op === 2) {
      curved = true;
      i += 7;
    } else if (op === 3) {
      curved = true;
      i += 5;
    } else if (op === 4) {
      if (cur.length) cur.push(cur[0]!);
      i += 1;
    } else {
      return []; // unknown encoding — do not guess
    }
  }
  if (cur.length) subpaths.push(cur);
  if (curved) return [];
  const out: Rule[] = [];
  for (const sp of subpaths) {
    if (sp.length < 2) continue;
    const xs = sp.map((p) => p[0]);
    const ys = sp.map((p) => p[1]);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    const axisAligned = sp.every((p, k) => k === 0 || Math.abs(p[0] - sp[k - 1]![0]) < 0.5 || Math.abs(p[1] - sp[k - 1]![1]) < 0.5);
    if (!axisAligned) continue;
    if (bh <= 2.5 && bw >= 10) {
      const y = (Math.max(...ys) + Math.min(...ys)) / 2;
      out.push({ orientation: 'h', x0: Math.min(...xs), x1: Math.max(...xs), top: y, bottom: y });
    } else if (bw <= 2.5 && bh >= 6) {
      const x = (Math.max(...xs) + Math.min(...xs)) / 2;
      out.push({ orientation: 'v', x0: x, x1: x, top: Math.min(...ys), bottom: Math.max(...ys) });
    } else if (stroked) {
      // a stroked rectangle/polyline: every axis-aligned edge is a rule
      for (let k = 1; k < sp.length; k++) {
        const [ax, ay] = sp[k - 1]!;
        const [bx, by] = sp[k]!;
        if (Math.abs(ay - by) < 0.5 && Math.abs(ax - bx) >= 10) out.push({ orientation: 'h', x0: Math.min(ax, bx), x1: Math.max(ax, bx), top: ay, bottom: ay });
        else if (Math.abs(ax - bx) < 0.5 && Math.abs(ay - by) >= 6) out.push({ orientation: 'v', x0: ax, x1: ax, top: Math.min(ay, by), bottom: Math.max(ay, by) });
      }
    }
  }
  return out;
}

interface RawTextItem {
  str: string;
  transform: unknown;
  width: number;
  height: number;
  fontName: string;
}

/**
 * Box of one pdfjs text item from its text matrix (any direction), in top-left unrotated page units, with the
 * baseline direction as a clockwise quarter turn (null when the text is not axis-aligned).
 */
function textItemBox(
  raw: RawTextItem,
  styles: Record<string, { ascent?: number; descent?: number }>,
  toTop: (x: number, y: number) => [number, number],
): Box & { size: number; dir: 0 | 90 | 180 | 270 | null } {
  const t = raw.transform as number[];
  const [a, b, c, d, e, f] = [t[0]!, t[1]!, t[2]!, t[3]!, t[4]!, t[5]!];
  const size = Math.hypot(c, d) || Math.hypot(a, b) || raw.height || 10;
  const style = styles[raw.fontName] ?? {};
  const ascent = typeof style.ascent === 'number' && style.ascent > 0 ? style.ascent : 0.8;
  const descent = typeof style.descent === 'number' && style.descent < 0 ? style.descent : -0.2;
  const len = Math.hypot(a, b) || 1;
  const ux = a / len;
  const uy = b / len;
  // perpendicular "up" vector
  const vx = -uy;
  const vy = ux;
  const w = raw.width;
  const corners: Array<[number, number]> = [
    [e + vx * descent * size, f + vy * descent * size],
    [e + ux * w + vx * descent * size, f + uy * w + vy * descent * size],
    [e + vx * ascent * size, f + vy * ascent * size],
    [e + ux * w + vx * ascent * size, f + uy * w + vy * ascent * size],
  ];
  const pts = corners.map(([x, y]) => toTop(x, y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  // baseline direction in the top-left space (y down): (ux, -uy); clockwise angle from +x
  const angle = (Math.atan2(-uy, ux) * 180) / Math.PI;
  const q = quarter(angle);
  const off = Math.abs((((angle - q) % 360) + 540) % 360 - 180);
  return { x0: Math.min(...xs), x1: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), size, dir: off <= 20 ? q : null };
}

/**
 * Quick per-page text runs for the inspect stage (header/footer bands, printed page numbers, body size),
 * in DISPLAY space (see pageView) so bands are the top/bottom the reader sees on a rotated page.
 */
export async function pageTextItems(doc: PDFDocumentProxy, pageNumber: number): Promise<{ info: PdfPageInfo; view: PageView; items: TextItem[] }> {
  const page = await doc.getPage(pageNumber);
  try {
    const info = pageInfo(page);
    const [vx0, , , vy1] = info.view;
    const toTop = (x: number, y: number): [number, number] => [x - vx0, vy1 - y];
    const tc = await page.getTextContent({ includeMarkedContent: false });
    const styles = tc.styles as Record<string, { ascent?: number; descent?: number }>;
    const boxes: Array<{ text: string; box: ReturnType<typeof textItemBox> }> = [];
    const directions = emptyDirections();
    for (const raw of tc.items) {
      if (!('str' in raw) || !raw.str.trim()) continue;
      const box = textItemBox(raw, styles, toTop);
      boxes.push({ text: raw.str, box });
      if (box.dir !== null) directions[box.dir] += raw.str.replace(/\s+/g, '').length;
    }
    // the layout space of the page (H2 item 5): display space, turned further when the text runs sideways in it
    const view = pageView({ ...info, rotation: info.rotation + contentRotationFromText(directions, info.rotation) });
    const items: TextItem[] = boxes.map(({ text, box }) => ({ text, ...view.toView(box), size: box.size, bold: false }));
    return { info, view, items };
  } finally {
    page.cleanup();
  }
}

/** Release the document and its worker-side resources. */
export async function closePdf(doc: PDFDocumentProxy): Promise<void> {
  try {
    await doc.loadingTask.destroy();
  } catch {
    // already destroyed
  }
}
