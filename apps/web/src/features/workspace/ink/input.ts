// Pointer input decisions and stroke capture (no React, no rendering).
//
// Palm / finger rejection on the web is a HEURISTIC (spec §27): in pen-only mode touch never
// writes (fingers keep scrolling), very large contact areas are treated as a palm, and touches
// right after the pen lifts are ignored. A native iPad layer would use the system's palm rejection.
import type { InkPoint } from '@medlevo/shared';
import { tiltOf } from './capabilities';
import { detectPressureVariation } from './math';

export type PointerDecision =
  | 'write'
  | 'erase_with_pen_eraser' // pen's eraser end / eraser button (buttons & 32)
  | 'ignore_button' // secondary mouse button etc.
  | 'ignore_touch_pen_only' // pen-only mode: fingers scroll
  | 'ignore_palm' // large contact or touch right after the pen
  | 'ignore_secondary'; // another pointer while a stroke is in progress

export interface PointerLike {
  pointerType: string;
  button: number;
  buttons: number;
  width: number;
  height: number;
  isPrimary: boolean;
}

export interface PointerPolicyContext {
  penOnly: boolean;
  strokeActive: boolean;
  /** ms since the pen last lifted (Infinity if never) */
  sincePenUp: number;
}

/** css px: a fingertip is ≈ 8–20 px across; a resting palm is much larger. */
export const PALM_CONTACT_PX = 44;
export const PALM_AFTER_PEN_MS = 400;

export function classifyPointerDown(e: PointerLike, ctx: PointerPolicyContext): PointerDecision {
  if (ctx.strokeActive) return 'ignore_secondary';
  if (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) === 32)) return 'erase_with_pen_eraser';
  if (e.pointerType === 'mouse' && e.button !== 0) return 'ignore_button';
  if (e.pointerType === 'pen' && e.button !== 0 && e.button !== -1) return 'ignore_button'; // barrel button
  if (e.pointerType === 'touch') {
    if (ctx.penOnly) return 'ignore_touch_pen_only';
    if (Math.max(e.width || 0, e.height || 0) > PALM_CONTACT_PX) return 'ignore_palm';
    if (ctx.sincePenUp < PALM_AFTER_PEN_MS) return 'ignore_palm';
    if (!e.isPrimary) return 'ignore_secondary';
  }
  return 'write';
}

/** Minimal event shape the capture needs (real PointerEvents in the app, plain objects in tests). */
export interface InputSample {
  clientX: number;
  clientY: number;
  timeStamp: number;
  pressure: number;
  pointerType: string;
  buttons?: number;
  tiltX?: number;
  tiltY?: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
}

/** css-px client point → normalized page point. */
export type ToNorm = (clientX: number, clientY: number) => [number, number];

export const MAX_POINTS = 19_000; // server accepts 20 000 per stroke
/** drop samples closer than this to the previous kept one (page-width units, ≈ 0.25 pt on A4) */
export const MIN_STEP = 0.0004;

/**
 * Collects one stroke's points. Pressure and tilt are recorded as reported; whether they carried
 * real information is decided at the end (pressure_available / tilt_available) — never assumed.
 */
export class StrokeCapture {
  readonly points: InkPoint[] = [];
  private pressures: number[] = [];
  private tiltSeen = false;
  private t0: number;
  private lastIso: [number, number] | null = null;

  constructor(
    readonly pointerType: string,
    private readonly toNorm: ToNorm,
    private readonly ar: number,
    first: InputSample,
  ) {
    this.t0 = first.timeStamp;
    this.add(first, true);
  }

  get full(): boolean {
    return this.points.length >= MAX_POINTS;
  }

  /** Adds a sample; returns true when it was kept. */
  add(s: InputSample, force = false): boolean {
    if (this.full) return false;
    const [x, y] = this.toNorm(s.clientX, s.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const iso: [number, number] = [x, y * this.ar];
    if (!force && this.lastIso && Math.hypot(iso[0] - this.lastIso[0], iso[1] - this.lastIso[1]) < MIN_STEP) return false;
    const t = Math.max(0, s.timeStamp - this.t0);
    const [tx, ty] = tiltOf(s);
    if (Math.abs(tx) > 0.5 || Math.abs(ty) > 0.5) this.tiltSeen = true;
    this.pressures.push(s.pressure);
    this.points.push([x, y, t, s.pressure, tx, ty]);
    this.lastIso = iso;
    return true;
  }

  /** Last sample always counts (the pen lifted exactly there). */
  end(s?: InputSample): void {
    if (!s) return;
    const [x, y] = this.toNorm(s.clientX, s.clientY);
    const last = this.points[this.points.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) return;
    this.add(s, true);
  }

  get pressureAvailable(): boolean {
    return detectPressureVariation(this.pressures, this.pointerType);
  }

  get tiltAvailable(): boolean {
    return this.pointerType === 'pen' && this.tiltSeen;
  }

  /**
   * Final points in the stored format: [x, y, t] when neither pressure nor tilt carried
   * information; [x, y, t, p] with pressure; [x, y, t, p, tiltX, tiltY] with tilt
   * (p is then the reported value even if constant — pressure_available says whether it varied).
   */
  finalPoints(): InkPoint[] {
    const withP = this.pressureAvailable;
    const withT = this.tiltAvailable;
    return this.points.map((p) => {
      if (withT) return p;
      if (withP) return [p[0], p[1], p[2], p[3]!] as InkPoint;
      return [p[0], p[1], p[2]] as InkPoint;
    });
  }
}
