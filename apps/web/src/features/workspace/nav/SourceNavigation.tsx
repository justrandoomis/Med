// Source Jump & Back (§11) as a small context for later features (Source Inspector, citations,
// Study Book): `openSourceLocation` scrolls to the exact page, highlights the cited region and records
// a back entry; `goBack` («العودة إلى الشرح») returns to the previous position, zoom and layout.
import { createContext, useContext } from 'react';
import type { NormBox } from '@medlevo/shared';

export interface OpenSourceLocationRequest {
  sourceId: string;
  /** the version the citation was made against (kept — never silently swapped, §11) */
  versionId?: string | null;
  pageId?: string | null;
  pageIndex?: number | null;
  /** region box normalized to the unrotated page (null → highlight the whole page) */
  bbox?: NormBox | null;
  regionId?: string | null;
  /** what is being opened, for the highlight's accessible name */
  label?: string | null;
}

export type OpenSourceLocationResult = { ok: true } | { ok: false; reason_ar: string };

export interface SourceNavigationApi {
  openSourceLocation(req: OpenSourceLocationRequest): Promise<OpenSourceLocationResult>;
  /** returns false when there is nowhere to go back to */
  goBack(): boolean;
  canGoBack: boolean;
  /** where «العودة» leads, e.g. «ص 12 — محاضرة الزائدة» */
  backLabel: string | null;
  clearHighlight(): void;
}

export const SourceNavigationContext = createContext<SourceNavigationApi | null>(null);

/** Source Jump & Back from anywhere inside the workspace. */
export function useSourceNavigation(): SourceNavigationApi {
  const v = useContext(SourceNavigationContext);
  if (!v) throw new Error('useSourceNavigation must be used inside the study workspace');
  return v;
}

/** URL of a place in the reader (cross-source jumps and deep links). */
export function studyUrl(req: { sourceId: string; versionId?: string | null; pageIndex?: number | null; pageId?: string | null; bbox?: NormBox | null; regionId?: string | null; offset?: number | null }): string {
  const q = new URLSearchParams();
  if (req.versionId) q.set('v', req.versionId);
  if (req.pageIndex != null) q.set('page', String(req.pageIndex));
  if (req.pageId) q.set('page_id', req.pageId);
  if (req.bbox) q.set('bbox', [req.bbox.x, req.bbox.y, req.bbox.w, req.bbox.h].map((n) => Math.round(n * 1e5) / 1e5).join(','));
  if (req.regionId) q.set('region', req.regionId);
  if (req.offset != null && req.offset > 0) q.set('offset', String(Math.round(req.offset * 1000) / 1000));
  const qs = q.toString();
  return `/study/${encodeURIComponent(req.sourceId)}${qs ? `?${qs}` : ''}`;
}

export function parseBbox(v: string | null): NormBox | null {
  if (!v) return null;
  const parts = v.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}
