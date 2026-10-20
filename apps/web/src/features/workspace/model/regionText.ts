// Page text that comes from the processed REGIONS instead of a pdf.js text layer (AC-02): page images, and PDF
// pages the server had to read by OCR (a scan inside a PDF has no PDF text layer, so pdf.js finds nothing there —
// the page is not empty). The reader's selectable text layer and the in-document search text of such a page are
// built from the same runs, in the same order, so search offsets land on the right characters.
import { regionWords, type NormBox, type SourcePageView, type SourceRegionView } from '@medlevo/shared';

/** A PDF page whose readable text is the server's OCR (fully or partly scanned), not the PDF text layer. */
export function pdfPageUsesRegionText(page: Pick<SourcePageView, 'text_status'>): boolean {
  return page.text_status === 'ocr' || page.text_status === 'mixed';
}

/**
 * The runs of a positioned page's text layer: regions with a box and text, in reading order — not the figure itself,
 * and not a table's serialized summary («Header: value | …», which is not what the page shows): its cells carry the
 * table's text at their own places (H2 item 2: tables are now found on scanned pages too).
 */
export function regionTextRuns<R extends Pick<SourceRegionView, 'bbox' | 'text' | 'kind' | 'reading_order'>>(regions: readonly R[]): R[] {
  return regions.filter((r) => r.bbox && r.text && r.kind !== 'figure' && r.kind !== 'table').sort((a, b) => a.reading_order - b.reading_order);
}

/** The searchable text of a positioned page: the runs concatenated exactly as the text layer renders them. */
export function regionPageText(regions: ReadonlyArray<Pick<SourceRegionView, 'bbox' | 'text' | 'kind' | 'reading_order'>>): string {
  return regionTextRuns(regions)
    .map((r) => r.text ?? '')
    .join('');
}

/** One piece of an OCR run: a word placed over its glyphs, or the text between two words (kept for copy / offsets). */
export type OcrRunSegment = { kind: 'word'; text: string; box: NormBox } | { kind: 'gap'; text: string };

/**
 * H2 item 6: the run text split at its OCR words (server `locator.words`, reading order). Every character of the run
 * text is in exactly one segment, in order — so the DOM text of the layer stays the page's search text. A word that is
 * not found where expected (text repaired after OCR) stays inside a gap. Null when the run has no usable words (then
 * the run is rendered as one block, as before).
 */
export function ocrRunSegments(r: Pick<SourceRegionView, 'text' | 'locator'>): OcrRunSegment[] | null {
  const text = r.text ?? '';
  const words = regionWords(r);
  if (!text || !words) return null;
  const out: OcrRunSegment[] = [];
  let at = 0;
  let placed = 0;
  for (const [w, x, y, ww, h] of words) {
    const k = text.indexOf(w, at);
    if (k < 0) continue;
    if (k > at) out.push({ kind: 'gap', text: text.slice(at, k) });
    out.push({ kind: 'word', text: w, box: { x, y, w: ww, h } });
    at = k + w.length;
    placed++;
  }
  if (placed < Math.ceil(words.length / 2)) return null;
  if (at < text.length) out.push({ kind: 'gap', text: text.slice(at) });
  return out;
}
