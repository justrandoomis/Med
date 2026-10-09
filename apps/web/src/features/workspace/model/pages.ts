// Page identity (§07, AC-04): the printed label is what the book shows; the file position is where the
// page sits in the file. Both are shown when they differ, and "go to page" understands either.
import { pageDisplayLabel, type SourcePageView } from '@medlevo/shared';

export type PageIdentity = Pick<SourcePageView, 'page_index' | 'printed_label' | 'kind'>;

/** Folio under a page: «ص 12» + «الصفحة 14 في الملف» (only when it differs). */
export function folio(page: PageIdentity): { primary: string; secondary: string | null } {
  const fileNo = page.page_index + 1;
  const primary = pageDisplayLabel(page, { withFileIndex: false });
  const differs = page.kind === 'page' && !!page.printed_label && page.printed_label !== String(fileNo);
  const slideDiffers = page.kind === 'slide' && !!page.printed_label && page.printed_label !== String(fileNo);
  return { primary, secondary: differs || slideDiffers ? `الصفحة ${fileNo} في الملف` : null };
}

/** Full label (accessible names, status lines): «ص 12 (الصفحة 14 في الملف)». */
export function fullPageLabel(page: PageIdentity): string {
  const f = folio(page);
  return f.secondary ? `${f.primary} (${f.secondary})` : f.primary;
}

/** «ص 12 من 40» style indicator; the count is file pages (the only honest total). */
export function pageIndicator(page: PageIdentity, total: number): string {
  return `${fullPageLabel(page)} — ${page.page_index + 1} من ${total}`;
}

const ARABIC_DIGITS = /[٠-٩]/g;
const EXT_DIGITS = /[۰-۹]/g;

/** Normalize what the owner typed: Arabic-Indic digits → ASCII, trim, collapse spaces, lower-case Latin. */
export function normalizePageInput(input: string): string {
  return input
    .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXT_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export type GoToResult =
  | { ok: true; index: number; matchedBy: 'printed' | 'file'; /** another page the same input could mean */ alternative?: { index: number; matchedBy: 'printed' | 'file' } }
  | { ok: false; error: string };

/** Explicit file-position syntax: «#14», «ملف 14», «الصفحة 14 في الملف», «f14», «file 14». */
const FILE_SYNTAX = /^(?:#|f\s*|file\s*|ملف\s*|الملف\s*|الصفحة\s+)(\d+)(?:\s+في\s+الملف)?$/;
/** Printed-label prefixes the owner may type: «ص 12», «ص12», «صفحة 12», «p 12», «p.12», «شريحة 3». */
const PRINTED_PREFIX = /^(?:الصفحة\s*|صفحة\s*|ص\.?\s*|page\s*|p\.?\s*|شريحة\s*|slide\s*)/;

/**
 * Resolve a go-to-page request. Printed labels win (a citation «ص12» means the page printed 12, AC-04);
 * a plain number that is not a printed label is a file position. When both readings exist the other one
 * is returned as `alternative` so the UI can offer it.
 */
export function resolveGoTo(input: string, pages: ReadonlyArray<PageIdentity>): GoToResult {
  const q = normalizePageInput(input);
  if (!q) return { ok: false, error: 'اكتب رقم الصفحة كما هو مطبوع في الكتاب، أو #رقمها في الملف.' };
  if (pages.length === 0) return { ok: false, error: 'لا توجد صفحات في هذا الإصدار.' };

  const fileMatch = FILE_SYNTAX.exec(q);
  if (fileMatch && !/^الصفحة\s+\d+$/.test(q)) {
    const n = Number(fileMatch[1]);
    if (n >= 1 && n <= pages.length) return { ok: true, index: n - 1, matchedBy: 'file' };
    return { ok: false, error: `الملف فيه ${pages.length} صفحة فقط.` };
  }

  // a label typed exactly as printed wins before any prefix is stripped («preface» is not «p» + «reface»)
  const exactIdx = pages.findIndex((p) => p.printed_label != null && normalizePageInput(p.printed_label) === q);
  const label = exactIdx >= 0 ? q : q.replace(PRINTED_PREFIX, '').trim();
  if (!label) return { ok: false, error: 'اكتب رقم الصفحة.' };
  const printedIdx = exactIdx >= 0 ? exactIdx : pages.findIndex((p) => p.printed_label != null && normalizePageInput(p.printed_label) === label);
  const asNumber = /^\d+$/.test(label) ? Number(label) : null;
  const fileIdx = asNumber !== null && asNumber >= 1 && asNumber <= pages.length ? asNumber - 1 : -1;

  if (printedIdx >= 0) {
    const page = pages[printedIdx]!;
    const result: GoToResult = { ok: true, index: page.page_index, matchedBy: 'printed' };
    if (fileIdx >= 0 && fileIdx !== page.page_index) result.alternative = { index: fileIdx, matchedBy: 'file' };
    return result;
  }
  if (fileIdx >= 0) return { ok: true, index: fileIdx, matchedBy: 'file' };
  if (asNumber !== null) return { ok: false, error: `لا توجد صفحة مطبوع عليها ${label}، والملف فيه ${pages.length} صفحة.` };
  return { ok: false, error: `لا توجد صفحة مطبوع عليها «${label}».` };
}
