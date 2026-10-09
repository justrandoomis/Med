// Text-quote anchors from a selection (§25): the selected text with a little context before/after
// (TextQuote) plus the visual rects normalized to the unrotated page box (zoom/rotation independent).
import { clampBox, viewToNorm, type NormBox, type PageViewTransform, type TextQuote } from '@medlevo/shared';

export const QUOTE_CONTEXT = 32;

/** Build {exact, prefix, suffix} from the page text and the selection's character offsets. */
export function quoteFromText(text: string, start: number, end: number, context = QUOTE_CONTEXT): TextQuote | null {
  let s = Math.max(0, Math.min(start, end));
  let e = Math.min(text.length, Math.max(start, end));
  // trim surrounding whitespace off the exact quote (selections often include it)
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  if (e <= s) return null;
  const quote: TextQuote = { exact: text.slice(s, e) };
  const prefix = text.slice(Math.max(0, s - context), s);
  const suffix = text.slice(e, Math.min(text.length, e + context));
  if (prefix) quote.prefix = prefix;
  if (suffix) quote.suffix = suffix;
  return quote;
}

/** Character offsets of a DOM range inside `root`, counted over root's text nodes in document order. */
export function rangeOffsetsWithin(root: Node, range: Pick<Range, 'startContainer' | 'startOffset' | 'endContainer' | 'endOffset'>): { start: number; end: number } | null {
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let start: number | null = null;
  let end: number | null = null;
  const pos = (container: Node, off: number, node: Text): number | null => {
    if (container === node) return off;
    return null;
  };
  let n = walker.nextNode() as Text | null;
  while (n) {
    const len = n.data.length;
    if (start === null) {
      const p = pos(range.startContainer, range.startOffset, n);
      if (p !== null) start = offset + Math.min(p, len);
    }
    if (end === null) {
      const p = pos(range.endContainer, range.endOffset, n);
      if (p !== null) end = offset + Math.min(p, len);
    }
    offset += len;
    n = walker.nextNode() as Text | null;
  }
  // element boundaries (e.g. selection ends at a span edge): resolve via child index
  if (start === null) start = elementBoundaryOffset(root, range.startContainer, range.startOffset);
  if (end === null) end = elementBoundaryOffset(root, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

function elementBoundaryOffset(root: Node, container: Node, offset: number): number | null {
  if (!root.contains(container)) {
    // the boundary lies outside this page: clamp to the page start/end
    const cmp = root.compareDocumentPosition(container);
    if (cmp & Node.DOCUMENT_POSITION_PRECEDING) return 0;
    if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) return (root.textContent ?? '').length;
    return null;
  }
  if (container.nodeType === Node.TEXT_NODE) return null;
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  // the boundary sits before childNodes[offset], or at the very end of `container` when there is none
  const boundary = container.childNodes[offset] ?? null;
  let total = 0;
  let n = walker.nextNode() as Text | null;
  while (n) {
    if (boundary) {
      if (boundary === n || boundary.contains(n) || boundary.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) return total;
    } else if (!container.contains(n) && container.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) {
      return total;
    }
    total += n.data.length;
    n = walker.nextNode() as Text | null;
  }
  return total;
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Selection client rects → normalized boxes on the unrotated page. `box` is the rendered (rotated) page
 * view box in the same coordinate space as the rects; `view` its transform. Rects on the same line are merged.
 */
export function clientRectsToNorm(rects: readonly RectLike[], box: RectLike, view: PageViewTransform): NormBox[] {
  const out: NormBox[] = [];
  for (const r of rects) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    const x1 = r.left - box.left;
    const y1 = r.top - box.top;
    const x2 = x1 + r.width;
    const y2 = y1 + r.height;
    // outside the page box entirely
    if (x2 <= 0 || y2 <= 0 || x1 >= box.width || y1 >= box.height) continue;
    const [ax, ay] = viewToNorm(x1, y1, view);
    const [bx, by] = viewToNorm(x2, y2, view);
    const b = clampBox({ x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });
    if (b.w < 0.0005 || b.h < 0.0005) continue;
    out.push(b);
  }
  return mergeLineBoxes(out);
}

/** Merge boxes that overlap on the same text line (pdf.js emits one rect per text run). */
export function mergeLineBoxes(boxes: readonly NormBox[]): NormBox[] {
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: NormBox[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const overlapY = Math.min(last.y + last.h, b.y + b.h) - Math.max(last.y, b.y);
      const sameLine = overlapY > 0.6 * Math.min(last.h, b.h);
      const touching = b.x <= last.x + last.w + 0.01 && b.x + b.w >= last.x - 0.01;
      if (sameLine && touching) {
        const x = Math.min(last.x, b.x);
        const y = Math.min(last.y, b.y);
        last.w = Math.max(last.x + last.w, b.x + b.w) - x;
        last.h = Math.max(last.y + last.h, b.y + b.h) - y;
        last.x = x;
        last.y = y;
        continue;
      }
    }
    out.push({ ...b });
  }
  return out;
}

/** Round to 5 decimals: compact payloads, still far below a pixel at any zoom. */
export function roundBox(b: NormBox): NormBox {
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  return { x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h) };
}

/** DOM Range covering character offsets [start, end) of `root`'s text (inverse of rangeOffsetsWithin). */
export function rangeFromOffsets(root: Node, start: number, end: number): Range | null {
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let offset = 0;
  let startSet = false;
  let n = walker.nextNode() as Text | null;
  while (n) {
    const len = n.data.length;
    if (!startSet && start <= offset + len) {
      range.setStart(n, Math.max(0, start - offset));
      startSet = true;
    }
    if (startSet && end <= offset + len) {
      range.setEnd(n, Math.max(0, end - offset));
      return range;
    }
    offset += len;
    n = walker.nextNode() as Text | null;
  }
  return null;
}
