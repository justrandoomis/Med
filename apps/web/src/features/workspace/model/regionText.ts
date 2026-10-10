// Page text that comes from the processed REGIONS instead of a pdf.js text layer (AC-02): page images, and PDF
// pages the server had to read by OCR (a scan inside a PDF has no PDF text layer, so pdf.js finds nothing there —
// the page is not empty). The reader's selectable text layer and the in-document search text of such a page are
// built from the same runs, in the same order, so search offsets land on the right characters.
import type { SourcePageView, SourceRegionView } from '@medlevo/shared';

/** A PDF page whose readable text is the server's OCR (fully or partly scanned), not the PDF text layer. */
export function pdfPageUsesRegionText(page: Pick<SourcePageView, 'text_status'>): boolean {
  return page.text_status === 'ocr' || page.text_status === 'mixed';
}

/** The runs of a positioned page's text layer: regions with a box and text (not the figure itself), in reading order. */
export function regionTextRuns<R extends Pick<SourceRegionView, 'bbox' | 'text' | 'kind' | 'reading_order'>>(regions: readonly R[]): R[] {
  return regions.filter((r) => r.bbox && r.text && r.kind !== 'figure').sort((a, b) => a.reading_order - b.reading_order);
}

/** The searchable text of a positioned page: the runs concatenated exactly as the text layer renders them. */
export function regionPageText(regions: ReadonlyArray<Pick<SourceRegionView, 'bbox' | 'text' | 'kind' | 'reading_order'>>): string {
  return regionTextRuns(regions)
    .map((r) => r.text ?? '')
    .join('');
}
