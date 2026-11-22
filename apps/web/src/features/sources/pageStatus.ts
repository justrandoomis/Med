// A page «needs_review» for two very different reasons. Doubtful OCR text on a page that WAS read is an optional review
// (the page is ready and studied like any other). A page whose content could not be read at all — a damaged content
// stream, a blank render that was never verified, no text found on a page that is not a picture, OCR unavailable — is
// NOT ready: calling it «جاهزة» would hide a real gap in the lecture (AC-03). Those keep the honest «تحتاج مراجعة».
import type { SourcePageView } from '@medlevo/shared';

/** server page-issue codes that mean nothing usable was read from the page (pipeline.ts pageIssue) */
const UNREADABLE_CODES = new Set(['PAGE_CONTENT_DAMAGED', 'BLANK_UNVERIFIED', 'NO_TEXT_FOUND']);

export function pageUnreadable(p: Pick<SourcePageView, 'processing_status' | 'text_status' | 'error_code' | 'picture_page'>): boolean {
  if (p.processing_status !== 'needs_review' || p.picture_page) return false;
  if (p.error_code && UNREADABLE_CODES.has(p.error_code)) return true;
  return p.text_status === 'no_text_found' || p.text_status === 'needs_ocr' || p.text_status === 'failed';
}

/** the honest label of a needs-review page that was not read («تحتاج مراجعة»), shared by the pages table and the rail */
export const UNREADABLE_PAGE_LABEL = 'تحتاج مراجعة — لم يُقرأ محتواها';
