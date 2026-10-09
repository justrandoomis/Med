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
