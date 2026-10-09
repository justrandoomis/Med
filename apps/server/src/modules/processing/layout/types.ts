// Geometry & layout types shared by the PDF, OCR and image paths. All coordinates are in PAGE UNITS
// (PDF points or image pixels) with a TOP-LEFT origin on the UNROTATED page box; they are normalized
// to [0,1] only when regions are persisted.
import type { RegionKind } from '@medlevo/shared';
import type { Suspicion } from '../text';

export interface Box {
  x0: number;
  top: number;
  x1: number;
  bottom: number;
}

export interface PageGeom {
  width: number;
  height: number;
}

/** One positioned run of text (a pdfjs text item or an OCR word). Text is logical order within the run. */
export interface TextItem extends Box {
  text: string;
  /** font size (digital) or word height (OCR) in page units */
  size: number;
  bold: boolean;
  /** OCR word confidence 0–100 (absent for digital text) */
  conf?: number;
  /** OCR line id: words of one recognized line always form one row */
  line?: number;
}

/** A horizontal piece of one text line: items on the same baseline without a large gap. */
export interface Segment extends Box {
  id: number;
  rowId: number;
  items: TextItem[]; // visual order, left → right
  size: number;
  bold: boolean;
  chars: number;
  r: number; // strong RTL chars
  l: number; // strong LTR chars
  conf?: number; // mean OCR confidence
  minConf?: number;
}

export interface Rule {
  orientation: 'h' | 'v';
  /** for 'h': y = top = bottom; for 'v': x = x0 = x1 */
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

export interface FigureCandidate extends Box {
  /** where it came from (pdf image XObject, docx/pptx picture, whole image page) */
  source: 'pdf_image' | 'image_page' | 'office_picture';
}

export interface DiagramLabel {
  text: string;
  box: Box;
  certainty: 'read' | 'uncertain';
  conf?: number;
}

export interface TableCellOut {
  r: number;
  c: number;
  rowspan: number;
  colspan: number;
  header: boolean;
  text: string;
  box: Box;
}

export interface TableOut {
  box: Box;
  rows: number;
  cols: number;
  cells: TableCellOut[];
  /** how the grid was found */
  method: 'ruled' | 'aligned' | 'office';
}

/** A region produced by layout analysis, before ids exist. `key` is local to one page. */
export interface LayoutRegion {
  key: string;
  kind: RegionKind;
  box: Box | null;
  text: string | null;
  textOrigin: 'digital' | 'ocr' | null;
  dir?: 'rtl' | 'ltr';
  lang?: 'ar' | 'en' | 'mixed' | null;
  /** 0–1 */
  confidence?: number | null;
  minWordConf?: number | null;
  parentKey?: string | null;
  /** heading font size (digital/OCR) or explicit level (office) */
  fontSize?: number | null;
  headingLevel?: number | null;
  locator?: Record<string, unknown> | null;
  table?: TableOut;
  /** caption region linked to this table (same page) */
  tableCaptionKey?: string | null;
  /** figure: caption link + labels; filled by caption linking */
  figure?: { captionKey: string | null; labels: DiagramLabel[]; labelsOrigin: 'digital' | 'ocr' | null; imageAssetFile?: { fileId: string } | null };
  captionFor?: 'figure' | 'table' | null;
  /** caption number ("1" in "Figure 1") for cross-page linking */
  captionNumber?: string | null;
  /** figure numbers this paragraph references ("as shown in Figure 1") */
  figureRefs?: string[];
  /** diagram child of a figure: labels only, relations never invented (AC-08) */
  diagram?: { labels: DiagramLabel[]; understanding: 'labels_ocr_only' | 'not_analyzed' };
  /** OCR words below the review threshold (shown in the review reason) */
  lowConfWords?: string[];
  /** filled by text preparation */
  suspicions?: Suspicion[];
  ligatureFixes?: number;
  status?: 'extracted' | 'needs_review' | 'uncertain';
  reviewReasonAr?: string | null;
}

export function boxOf(boxes: Box[]): Box {
  let x0 = Infinity;
  let top = Infinity;
  let x1 = -Infinity;
  let bottom = -Infinity;
  for (const b of boxes) {
    if (b.x0 < x0) x0 = b.x0;
    if (b.top < top) top = b.top;
    if (b.x1 > x1) x1 = b.x1;
    if (b.bottom > bottom) bottom = b.bottom;
  }
  if (!Number.isFinite(x0)) return { x0: 0, top: 0, x1: 0, bottom: 0 };
  return { x0, top, x1, bottom };
}

export const width = (b: Box): number => b.x1 - b.x0;
export const height = (b: Box): number => b.bottom - b.top;
export const cx = (b: Box): number => (b.x0 + b.x1) / 2;
export const cy = (b: Box): number => (b.top + b.bottom) / 2;

export function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

export function contains(outer: Box, x: number, y: number, tol = 0): boolean {
  return x >= outer.x0 - tol && x <= outer.x1 + tol && y >= outer.top - tol && y <= outer.bottom + tol;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
