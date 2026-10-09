// pdfjs-dist (legacy build, Node) extraction: page count, /PageLabels, unrotated page boxes, intrinsic
// rotation, positioned text runs with font size/weight, image placements and ruling lines from the
// operator list. Fonts are never installed (disableFontFace); pdfjs v6 compiles no font code with eval.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { normalizeRotation, normToView, viewToNorm, type QuarterTurn } from '@medlevo/shared';
import type { Box, Rule, TextItem } from './layout/types';

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
  /** non-whitespace characters of digital text */
  chars: number;
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
        case OPS.constructPath: {
          const op = args?.[0] as number;
          if (!paintOps.has(op)) break;
          const dataWrap = args?.[1] as unknown[] | undefined;
          const data = dataWrap?.[0] as ArrayLike<number> | undefined;
          if (!data || typeof (data as { length?: number }).length !== 'number') break;
          const found = pathRules(data, ctm, toTop, strokeOps.has(op));
          if (found.length) rules.push(...found);
          else vectorPaths++;
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
    for (const raw of tc.items) {
      if (!('str' in raw)) continue;
      const str = raw.str;
      if (!str || !str.trim()) continue;
      items.push({ text: str, ...textItemBox(raw, styles, toTop), bold: fontBold(raw.fontName) });
      chars += str.replace(/\s+/g, '').length;
    }
    return { info, items, rules, images, vectorPaths, chars };
  } finally {
    page.cleanup();
  }
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

/** Box of one pdfjs text item from its text matrix (any direction), in top-left unrotated page units. */
function textItemBox(
  raw: RawTextItem,
  styles: Record<string, { ascent?: number; descent?: number }>,
  toTop: (x: number, y: number) => [number, number],
): Box & { size: number } {
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
  return { x0: Math.min(...xs), x1: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), size };
}

/**
 * Quick per-page text runs for the inspect stage (header/footer bands, printed page numbers, body size),
 * in DISPLAY space (see pageView) so bands are the top/bottom the reader sees on a rotated page.
 */
export async function pageTextItems(doc: PDFDocumentProxy, pageNumber: number): Promise<{ info: PdfPageInfo; view: PageView; items: TextItem[] }> {
  const page = await doc.getPage(pageNumber);
  try {
    const info = pageInfo(page);
    const view = pageView(info);
    const [vx0, , , vy1] = info.view;
    const toTop = (x: number, y: number): [number, number] => [x - vx0, vy1 - y];
    const tc = await page.getTextContent({ includeMarkedContent: false });
    const styles = tc.styles as Record<string, { ascent?: number; descent?: number }>;
    const items: TextItem[] = [];
    for (const raw of tc.items) {
      if (!('str' in raw) || !raw.str.trim()) continue;
      const box = textItemBox(raw, styles, toTop);
      items.push({ text: raw.str, ...view.toView(box), size: box.size, bold: false });
    }
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
