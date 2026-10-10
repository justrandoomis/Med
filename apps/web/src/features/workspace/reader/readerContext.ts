// What every rendered page needs from the reader (kept in a context to avoid threading props through
// the canvas). Owned by ReaderPane; read by PageView.
import { createContext, useContext } from 'react';
import type { AnnotationAnchor, NormBox } from '@medlevo/shared';
import type { RenderMode } from '../data/useSourceDocument';
import type { SearchResult } from '../model/search';
import type { PdfHandle } from './pdfDoc';

export interface ActiveHighlight {
  pageId: string;
  bbox: NormBox | null;
  regionId: string | null;
  label: string | null;
}

export interface ReaderPageContextValue {
  sourceId: string;
  versionId: string;
  mode: RenderMode;
  pdf: PdfHandle | null;
  /** native text selection is possible (not while a writing tool is active, §26) */
  textInteractive: boolean;
  /** the ink layer captures input */
  inkInteractive: boolean;
  /** render ink layers at all (the ink engine is mounted) */
  inkEnabled: boolean;
  onStrokeActiveChange: (active: boolean) => void;
  highlight: ActiveHighlight | null;
  searchResults: readonly SearchResult[];
  currentResult: SearchResult | null;
  /** the page's text root (pdf text layer / OCR text / paragraphs), for selection and search mapping */
  registerTextRoot: (pageIndex: number, el: HTMLElement | null) => void;
  /** anchor stamped on new annotations of a page */
  anchorFor: (pageIndex: number) => AnnotationAnchor | null;
  /** language of the page text when the source declares one ('en' / 'ar'); mixed sources leave it unset */
  textLang: string | null;
  /** the PDF's real page box (pt) once a page is loaded — corrects stored sizes that disagree */
  reportPageSize: (pageIndex: number, size: MeasuredSize) => void;
  /** note pages (paper) take ink even where the source pages cannot (text sources) — track F1 */
  notePageInk?: boolean;
  /** the note pages' menu (rename, paper, move, trash); absent → no menu (read-only places) */
  notePageActions?: NotePageActions | null;
  /** Arabic paper: the ruled margin line on the right */
  paperRtl?: boolean;
  /** PDF internal / external link annotations (track F1); absent → links are not drawn */
  pdfLinks?: PdfLinkActions | null;
}

/** What the owner can do with a note page from the page itself. */
export interface NotePageActions {
  rename(id: string): void;
  setTemplate(id: string, template: 'blank' | 'ruled' | 'dotted' | 'grid'): void;
  move(id: string, dir: -1 | 1): void;
  trash(id: string): void;
  /** a new note page right after this one */
  insertAfter(id: string): void;
  /** can it move earlier / later in its place */
  canMove(id: string, dir: -1 | 1): boolean;
}

/** Following links inside a PDF (pdf.js link annotations). */
export interface PdfLinkActions {
  /** an internal destination resolved to a page of this version */
  goToPage(pageIndex: number, label: string): void;
  /** an external URL — the host asks for an explicit confirmation before opening it (never fetched by the server) */
  openExternal(url: string): void;
}

export interface MeasuredSize {
  w: number;
  h: number;
  /** intrinsic /Rotate */
  rotate: number;
}

export const ReaderPageContext = createContext<ReaderPageContextValue | null>(null);

export function useReaderPage(): ReaderPageContextValue {
  const v = useContext(ReaderPageContext);
  if (!v) throw new Error('PageView must be rendered inside a ReaderPane');
  return v;
}
