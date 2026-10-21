// Educational measurement on pictures and pages (parity N1 wave 2, G08) — pure, unit-tested.
//
// The owner sets the scale from a scale bar they can see (drag along it, type its length: «50 µm», «1 cm»), then
// measures lengths and the angle between two lines (a cardiothoracic ratio, a Cobb angle — practice). Every result is
// labelled «تقدير تعليمي — ليس قياسًا سريريًا»: it depends on where the owner put the points and on the scale bar, and it
// is never saved as ink or as a value anywhere — it is shown, nothing more.
//
// On a picture the owner placed, the scale is kept in the picture's own pixels, so moving or resizing the picture keeps
// it right; on the page itself it is kept per page. The scale is remembered on this device only.
import type { ImageAnnotationData, NormBox } from '@medlevo/shared';
import { localGet, localSet } from './prefs';
import type { Vec } from './math';

export const EDUCATIONAL_LABEL_AR = 'تقدير تعليمي — ليس قياسًا سريريًا';

export const MEASURE_UNITS = ['µm', 'mm', 'cm'] as const;
export type MeasureUnit = (typeof MEASURE_UNITS)[number];
export const MEASURE_UNIT_LABELS_AR: Record<MeasureUnit, string> = { 'µm': 'ميكرومتر (µm)', mm: 'ملّيمتر (mm)', cm: 'سنتيمتر (cm)' };
const TO_UM: Record<MeasureUnit, number> = { 'µm': 1, mm: 1000, cm: 10_000 };

/** Where a scale lives: a picture (its own pixels) or a page (its width = 1). */
export type MeasureFrame = { kind: 'image'; imageKey: string; box: NormBox; rotation: number; naturalW: number } | { kind: 'page'; targetKey: string };

/** micrometres per frame unit (a picture pixel, or a page width) */
export interface Calibration {
  um_per_unit: number;
  /** the unit the owner typed (results are shown in it) */
  unit: MeasureUnit;
  at: number;
}

/** A normalized page point in the frame's units: picture pixels (before its rotation) or page-width units (iso). */
export function toFrame(p: Vec, frame: MeasureFrame, ar: number): Vec {
  if (frame.kind === 'page') return [p[0], p[1] * ar];
  const b = frame.box;
  const cx = b.x + b.w / 2;
  const cy = (b.y + b.h / 2) * ar;
  const dx = p[0] - cx;
  const dy = p[1] * ar - cy;
  const c = Math.cos(-frame.rotation);
  const s = Math.sin(-frame.rotation);
  const u = dx * c - dy * s;
  const v = dx * s + dy * c;
  const pxPerIso = frame.naturalW / (b.w || 1);
  return [u * pxPerIso, v * pxPerIso];
}

export function frameLength(a: Vec, b: Vec, frame: MeasureFrame, ar: number): number {
  const p = toFrame(a, frame, ar);
  const q = toFrame(b, frame, ar);
  return Math.hypot(q[0] - p[0], q[1] - p[1]);
}

/** The scale from a scale bar: its length in frame units and its real length. null when it cannot be one. */
export function calibrate(frameLen: number, real: number, unit: MeasureUnit, now = Date.now()): Calibration | null {
  if (!(frameLen > 0) || !(real > 0) || !Number.isFinite(real)) return null;
  return { um_per_unit: (real * TO_UM[unit]) / frameLen, unit, at: now };
}

/** A length in the calibration's unit, rounded to 3 significant figures. */
export function realLength(frameLen: number, cal: Calibration): { value: number; unit: MeasureUnit } {
  const um = frameLen * cal.um_per_unit;
  const v = um / TO_UM[cal.unit];
  return { value: Number(v.toPrecision(3)), unit: cal.unit };
}

/** The angle between two lines (degrees, 0–90 or 90–180 as drawn: the angle from the first line's direction to the second's, folded to 0..180). */
export function angleBetween(l1: [Vec, Vec], l2: [Vec, Vec], ar: number): number {
  const a1 = Math.atan2((l1[1][1] - l1[0][1]) * ar, l1[1][0] - l1[0][0]);
  const a2 = Math.atan2((l2[1][1] - l2[0][1]) * ar, l2[1][0] - l2[0][0]);
  let d = Math.abs(((a2 - a1) * 180) / Math.PI) % 360;
  if (d > 180) d = 360 - d;
  return Math.round(d * 10) / 10;
}

/** «12.5 ملّيمتر» (the number LTR-safe inside Arabic text: the caller isolates it). */
export function formatReal(v: { value: number; unit: MeasureUnit }): string {
  return `${v.value.toLocaleString('en-US', { maximumSignificantDigits: 3 })} ${v.unit}`;
}

// ── the scale, remembered on this device ──
const KEY = 'medlevo.ink.scale.v1:';

export function frameKey(frame: MeasureFrame): string {
  return frame.kind === 'image' ? `img:${frame.imageKey}` : `page:${frame.targetKey}`;
}

export function loadCalibration(frame: MeasureFrame): Calibration | null {
  try {
    const raw = localGet(KEY + frameKey(frame));
    const v = raw ? (JSON.parse(raw) as Calibration) : null;
    if (!v || !(v.um_per_unit > 0) || !(MEASURE_UNITS as readonly string[]).includes(v.unit)) return null;
    return v;
  } catch {
    return null;
  }
}

export function saveCalibration(frame: MeasureFrame, cal: Calibration | null): void {
  localSet(KEY + frameKey(frame), cal ? JSON.stringify(cal) : null);
}

/** The frame a measurement starting at `p` uses: the topmost picture under it, else the page. */
export function frameAt(p: Vec, targetKey: string, images: ReadonlyArray<{ data: ImageAnnotationData }>, ar: number): MeasureFrame {
  for (let i = images.length - 1; i >= 0; i--) {
    const d = images[i]!.data;
    const frame: MeasureFrame = { kind: 'image', imageKey: d.image_key, box: d.box, rotation: d.rotation ?? 0, naturalW: d.natural_w };
    const [u, v] = toFrame(p, frame, ar);
    const hw = d.natural_w / 2;
    const hh = (d.natural_w * ((d.box.h * ar) / (d.box.w || 1))) / 2;
    if (Math.abs(u) <= hw && Math.abs(v) <= hh) return frame;
  }
  return { kind: 'page', targetKey };
}
