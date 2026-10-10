// Image-occlusion geometry (§43): masks are NON-DESTRUCTIVE boxes normalized to the ORIGINAL image
// ({x, y, w, h} ∈ [0,1], origin top-left, physical axes — the image is never mirrored in RTL), so they stay right
// at any display size or zoom. Pure helpers for drawing / moving / resizing with a pointer and for the keyboard
// alternative (arrows move, Shift = bigger steps, Alt/Option + arrows resize).
import type { NormBox } from '@medlevo/shared';

export const MIN_MASK = 0.02;
export const KEY_STEP = 0.01;
export const KEY_STEP_BIG = 0.05;

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** Rounded to 4 decimals and kept inside the image with a minimum size. */
export function normalizeBox(b: NormBox): NormBox {
  let w = Math.min(1, Math.max(MIN_MASK, b.w));
  let h = Math.min(1, Math.max(MIN_MASK, b.h));
  const x = Math.min(clamp01(b.x), 1 - w);
  const y = Math.min(clamp01(b.y), 1 - h);
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  return { x: r4(x), y: r4(y), w: r4(w), h: r4(h) };
}

export function isValidBox(b: NormBox): boolean {
  const ok = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
  return ok(b.x) && ok(b.y) && ok(b.w) && ok(b.h) && b.w > 0 && b.h > 0 && b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001;
}

/** A client point → normalized image coordinates (the rect is the displayed image's bounding box). */
export function toImagePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): { x: number; y: number } {
  if (!(rect.width > 0 && rect.height > 0)) return { x: 0, y: 0 };
  return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height) };
}

/** The box spanned by a drag from `a` to `b` (any direction). Null when it is too small to be meant. */
export function boxFromDrag(a: { x: number; y: number }, b: { x: number; y: number }): NormBox | null {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  if (w < MIN_MASK / 2 && h < MIN_MASK / 2) return null;
  return normalizeBox({ x, y, w, h });
}

/** Move by a delta, staying inside the image (size unchanged). */
export function moveBox(b: NormBox, dx: number, dy: number): NormBox {
  return normalizeBox({ x: Math.min(Math.max(0, b.x + dx), 1 - b.w), y: Math.min(Math.max(0, b.y + dy), 1 - b.h), w: b.w, h: b.h });
}

/** Resize from a handle by a delta (the opposite edge stays put); never smaller than MIN_MASK, never outside. */
export function resizeBox(b: NormBox, handle: Handle, dx: number, dy: number): NormBox {
  let left = b.x;
  let top = b.y;
  let right = b.x + b.w;
  let bottom = b.y + b.h;
  if (handle.includes('w')) left = Math.min(clamp01(left + dx), right - MIN_MASK);
  if (handle.includes('e')) right = Math.max(clamp01(right + dx), left + MIN_MASK);
  if (handle.includes('n')) top = Math.min(clamp01(top + dy), bottom - MIN_MASK);
  if (handle.includes('s')) bottom = Math.max(clamp01(bottom + dy), top + MIN_MASK);
  return normalizeBox({ x: left, y: top, w: right - left, h: bottom - top });
}

/** A new mask for the keyboard path: centred, offset from existing masks so it never hides one exactly. */
export function newCenteredBox(existing: readonly NormBox[]): NormBox {
  const w = 0.24;
  const h = 0.1;
  let x = 0.5 - w / 2;
  let y = 0.5 - h / 2;
  for (let i = 0; i < 20 && existing.some((e) => Math.abs(e.x - x) < 0.01 && Math.abs(e.y - y) < 0.01); i++) {
    x = Math.min(1 - w, x + 0.04);
    y = Math.min(1 - h, y + 0.04);
  }
  return normalizeBox({ x, y, w, h });
}

export type KeyAction = { kind: 'move'; dx: number; dy: number } | { kind: 'resize'; dw: number; dh: number } | null;

/** Keyboard alternative: arrows move (physical directions — the image is not mirrored), Shift = ×5, Alt = resize. */
export function keyAction(key: string, mods: { shift?: boolean; alt?: boolean }): KeyAction {
  const step = mods.shift ? KEY_STEP_BIG : KEY_STEP;
  const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const v = d[key];
  if (!v) return null;
  return mods.alt ? { kind: 'resize', dw: v[0], dh: v[1] } : { kind: 'move', dx: v[0], dy: v[1] };
}

export function applyKey(b: NormBox, a: KeyAction): NormBox {
  if (!a) return b;
  if (a.kind === 'move') return moveBox(b, a.dx, a.dy);
  return resizeBox(b, 'se', a.dw, a.dh);
}

/** «المنطقة 2: من اليسار 10٪، من الأعلى 20٪، العرض 30٪، الارتفاع 8٪» — the mask in words (screen readers). */
export function boxDescriptionAr(b: NormBox): string {
  const p = (v: number) => `${Math.round(v * 100)}٪`;
  return `من اليسار ${p(b.x)}، من الأعلى ${p(b.y)}، العرض ${p(b.w)}، الارتفاع ${p(b.h)}`;
}
