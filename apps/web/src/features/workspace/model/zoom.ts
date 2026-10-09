// Zoom model. `zoom` is the owner-facing factor (1 = 100 %): PDF pages render at 96/72 css px per pt
// (the size printed on paper), images at 1 css px per image px.
import type { QuarterTurn } from '@medlevo/shared';

export const PT_TO_CSS = 96 / 72;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 5;
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 1000) / 1000));
}

export function zoomIn(z: number): number {
  return clampZoom(ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_MAX);
}

export function zoomOut(z: number): number {
  return clampZoom([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_MIN);
}

/** css px per page unit */
export function cssScale(zoom: number, unit: 'pt' | 'px' | null | undefined): number {
  return unit === 'px' ? zoom : zoom * PT_TO_CSS;
}

export interface FitInput {
  /** available inner width of the canvas (css px) */
  containerWidth: number;
  pageWidth: number;
  pageHeight: number;
  unit: 'pt' | 'px' | null | undefined;
  rotation: QuarterTurn;
  /** pages side by side (2 for a spread) */
  columns?: number;
  /** horizontal gap between columns + side padding (css px) */
  gap?: number;
  padding?: number;
}

/** Zoom at which `columns` pages fit the container width (rotation-aware). */
export function fitWidthZoom(i: FitInput): number {
  const columns = i.columns ?? 1;
  const gap = i.gap ?? 16;
  const padding = i.padding ?? 24;
  const sideways = i.rotation === 90 || i.rotation === 270;
  const w = sideways ? i.pageHeight : i.pageWidth;
  const perUnit = i.unit === 'px' ? 1 : PT_TO_CSS;
  const available = i.containerWidth - padding * 2 - gap * (columns - 1);
  if (w <= 0 || available <= 0) return 1;
  return clampZoom(available / columns / (w * perUnit));
}

export function zoomPercent(z: number): string {
  return `${Math.round(z * 100)}%`;
}
