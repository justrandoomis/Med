// The zoom writing window's geometry (parity N1 wave 2, G09) — pure, unit-tested.
//
// A target box on the page (normalized, unrotated page space) is shown magnified in a docked strip; what the owner writes
// in the strip is mapped into the box, so the ink is stored in PAGE space like every other stroke (AC-21). After a stroke
// near the far side of the strip the box advances in the writing direction — to the LEFT for Arabic (right to left, the
// default), to the right for English — and at the end of a line it returns to the start of the next line, inside the
// margins the owner set.
import type { InkSettings, NormBox } from '@medlevo/shared';

export type WritingDirection = 'rtl' | 'ltr';
export type ZoomSettings = InkSettings['zoom'];

/** The writing direction for a page: the owner's choice, or (auto) right to left unless the page's text is English. */
export function zoomDirection(setting: ZoomSettings['direction'], pageLang: string | null | undefined): WritingDirection {
  if (setting === 'rtl' || setting === 'ltr') return setting;
  return pageLang === 'en' ? 'ltr' : 'rtl';
}

/**
 * Box size for a strip of css aspect `stripAspect` (width / height): one written line tall, at most `maxW` wide. The box
 * ALWAYS has the strip's proportions (review of N1 wave 2): the strip draws the box at one scale across and down and
 * maps the pen with the same scale, so a box of other proportions would save the ink away from where the pen wrote. When
 * the line would be wider than `maxW` (a wide strip, a tall line, narrow margins) the line is made less tall instead.
 */
export function boxSize(lineHeightIso: number, stripAspect: number, ar: number, maxW = 0.9): { w: number; h: number } {
  const aspect = Number.isFinite(stripAspect) && stripAspect > 0 ? Math.max(0.5, Math.min(60, stripAspect)) : 4;
  const w = Math.min(maxW, lineHeightIso * aspect);
  return { w, h: w / aspect / ar };
}

/** The same proportions, at most `maxW` wide. */
function fitWidth(size: { w: number; h: number }, maxW: number): { w: number; h: number } {
  if (size.w <= maxW || size.w <= 0) return size;
  const k = maxW / size.w;
  return { w: maxW, h: size.h * k };
}

/** The usable band of a line in the writing direction: [left edge, right edge] (normalized x). */
export function lineBand(dir: WritingDirection, z: Pick<ZoomSettings, 'margin_start' | 'margin_end'>): [number, number] {
  return dir === 'rtl' ? [z.margin_end, 1 - z.margin_start] : [z.margin_start, 1 - z.margin_end];
}

/** The first box of a line at `y`: at the line's start (right side for RTL). */
export function lineStartBox(y: number, size: { w: number; h: number }, dir: WritingDirection, z: Pick<ZoomSettings, 'margin_start' | 'margin_end'>): NormBox {
  const [l, r] = lineBand(dir, z);
  const { w, h } = fitWidth(size, Math.max(0.05, r - l));
  return { x: dir === 'rtl' ? r - w : l, y: clamp(y, 0, 1 - h), w, h };
}

/** A box placed where the owner tapped (the tap is where writing starts: the box's start side), kept inside the band. */
export function boxAt(at: [number, number], size: { w: number; h: number }, dir: WritingDirection, z: Pick<ZoomSettings, 'margin_start' | 'margin_end'>): NormBox {
  const [l, r] = lineBand(dir, z);
  const { w, h } = fitWidth(size, Math.max(0.05, r - l));
  const x = dir === 'rtl' ? at[0] - w : at[0];
  return { x: clamp(x, l, r - w), y: clamp(at[1] - h / 2, 0, 1 - h), w, h };
}

/** strip fraction (0..1 across, 0..1 down) → normalized page point */
export function stripToPage(p: [number, number], box: NormBox): [number, number] {
  return [box.x + p[0] * box.w, box.y + p[1] * box.h];
}

/** normalized page point → strip fraction */
export function pageToStrip(p: [number, number], box: NormBox): [number, number] {
  return [(p[0] - box.x) / (box.w || 1), (p[1] - box.y) / (box.h || 1)];
}

/**
 * Should the box move on after a stroke? When the stroke reached the far part of the strip in the writing direction
 * (the left third for RTL, the right third for LTR). `strokeBox` is in strip fractions.
 */
export function shouldAdvance(strokeBox: { x0: number; x1: number }, dir: WritingDirection): boolean {
  return dir === 'rtl' ? strokeBox.x0 < 0.34 : strokeBox.x1 > 0.66;
}

/**
 * The next box in the writing direction: by 60 % of its width (what was written stays in view at the strip's start
 * side); past the line's end it returns to the start of the next line (`wrapped`). On the last line of the page it
 * stays where it is (`end`): wrapping would put the box back on that same line, over what was just written.
 */
export function advanceBox(box: NormBox, dir: WritingDirection, z: Pick<ZoomSettings, 'margin_start' | 'margin_end' | 'line_gap'>): { box: NormBox; wrapped: boolean; end?: boolean } {
  const [l, r] = lineBand(dir, z);
  const step = box.w * 0.6;
  if (dir === 'rtl') {
    if (box.x - step >= l - 1e-9) return { box: { ...box, x: box.x - step }, wrapped: false };
    if (box.x > l + 1e-9) return { box: { ...box, x: l }, wrapped: false };
  } else {
    if (box.x + box.w + step <= r + 1e-9) return { box: { ...box, x: box.x + step }, wrapped: false };
    if (box.x + box.w < r - 1e-9) return { box: { ...box, x: r - box.w }, wrapped: false };
  }
  if (!lineBelowFits(box, z)) return { box, wrapped: false, end: true };
  return { box: nextLineBox(box, dir, z), wrapped: true };
}

/** (review of N1 wave 2) Is there a whole line left below this one on the page? */
export function lineBelowFits(box: NormBox, z: Pick<ZoomSettings, 'line_gap'>): boolean {
  return box.y + box.h + z.line_gap + box.h <= 1 + 1e-9;
}

/** The start of the next line (the line gap below this one). */
export function nextLineBox(box: NormBox, dir: WritingDirection, z: Pick<ZoomSettings, 'margin_start' | 'margin_end' | 'line_gap'>): NormBox {
  return lineStartBox(box.y + box.h + z.line_gap, { w: box.w, h: box.h }, dir, z);
}

/** Moved by a normalized offset (keyboard), kept on the page. */
export function moveBox(box: NormBox, dx: number, dy: number): NormBox {
  return { ...box, x: clamp(box.x + dx, 0, 1 - box.w), y: clamp(box.y + dy, 0, 1 - box.h) };
}

/** css px of the strip per css px of the page at scale 1 — the magnification shown to the owner. */
export function magnification(box: NormBox, stripHeightPx: number, pageHeightPx: number): number {
  return stripHeightPx / Math.max(1e-6, box.h * pageHeightPx);
}

function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? lo : v < lo ? lo : v > hi ? hi : v;
}
