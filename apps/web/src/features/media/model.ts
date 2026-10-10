// Pure helpers for the media feature: time codes, normalized geometry for overlays drawn on an image, transcript
// filtering (the shared search normalization), origin tones.
import { normalizeForSearch, type ImageOriginBadge, type OverlayShape, type TranscriptSegmentView } from '@medlevo/shared';
import type { StatusTone } from '../../design';

/** «0:42», «12:05», «1:02:03» */
export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Like `formatMs`, but keeps the milliseconds («0:12.345») so an edit form round-trips imported cue times exactly. */
export function formatMsPrecise(ms: number): string {
  const rest = Math.max(0, Math.round(ms)) % 1000;
  return rest ? `${formatMs(ms)}.${String(rest).padStart(3, '0').replace(/0+$/, '')}` : formatMs(ms);
}

/** «12:05», «1:02:03», «75» (seconds), «12:05.5» → ms; null when malformed. Arabic-Indic digits accepted. */
export function parseTimecode(input: string): number | null {
  const t = normalizeForSearch(input).trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(t);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (min > 59 || s > 59) return null;
  return ((h * 60 + min) * 60 + s) * 1000 + (m[4] ? Number(m[4].padEnd(3, '0')) : 0);
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** A rectangle from two points in normalized image space (any drag direction). */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Extract<OverlayShape, { type: 'rect' }> {
  const x1 = clamp(Math.min(a.x, b.x));
  const y1 = clamp(Math.min(a.y, b.y));
  const x2 = clamp(Math.max(a.x, b.x));
  const y2 = clamp(Math.max(a.y, b.y));
  return { type: 'rect', x: round(x1), y: round(y1), w: round(Math.max(0.005, x2 - x1)), h: round(Math.max(0.005, y2 - y1)) };
}

export function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Pointer position → normalized point on an element. */
export function toNormalized(e: { clientX: number; clientY: number }, rect: { left: number; top: number; width: number; height: number }): { x: number; y: number } {
  return { x: clamp((e.clientX - rect.left) / Math.max(1, rect.width)), y: clamp((e.clientY - rect.top) / Math.max(1, rect.height)) };
}

/** Keep a rect inside the image (after numeric edits). */
export function fitRect(r: { x: number; y: number; w: number; h: number }): Extract<OverlayShape, { type: 'rect' }> {
  const w = Math.min(1, Math.max(0.005, r.w));
  const h = Math.min(1, Math.max(0.005, r.h));
  return { type: 'rect', x: round(Math.min(1 - w, clamp(r.x))), y: round(Math.min(1 - h, clamp(r.y))), w: round(w), h: round(h) };
}

/** Segments whose displayed text matches (normalized Arabic / Latin). */
export function filterSegments(segments: TranscriptSegmentView[], query: string): TranscriptSegmentView[] {
  const q = normalizeForSearch(query).trim();
  if (!q) return segments;
  return segments.filter((s) => normalizeForSearch(s.display_text).includes(q));
}

export const ORIGIN_TONE: Record<ImageOriginBadge, StatusTone> = {
  source_photo: 'neutral',
  source_drawing: 'neutral',
  source_unknown: 'warning',
  reorganized: 'info',
  generated: 'warning',
  external: 'info',
};

export function studyUrl(sourceId: string, at: { versionId?: string | null; pageId?: string | null; regionId?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (at.versionId) q.set('v', at.versionId);
  if (at.pageId) q.set('page_id', at.pageId);
  if (at.regionId) q.set('region', at.regionId);
  const s = q.toString();
  return `/study/${encodeURIComponent(sourceId)}${s ? `?${s}` : ''}`;
}
